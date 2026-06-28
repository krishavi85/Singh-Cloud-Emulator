const store = require('./platform-store');
const apiKeys = require('./api-key-service');
const notifications = require('./notification-service');
const { auditRequest } = require('./audit');

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function error(status, message) {
  return Object.assign(new Error(message), { status });
}

function organizationAccess(state, user, organizationId, roles = []) {
  const organization = state.organizations.find((item) => item.id === organizationId);
  if (!organization) throw error(404, 'Organization not found.');
  if (user.role === 'admin') return { organization, membership: { role: 'owner' } };
  const membership = state.memberships.find((item) => item.organizationId === organizationId && item.userId === user.id && !item.revokedAt);
  if (!membership) throw error(403, 'Organization access denied.');
  if (roles.length && !roles.includes(membership.role)) throw error(403, 'Insufficient organization role.');
  return { organization, membership };
}

function registerManagementRoutes(app) {
  app.get('/api/platform/organizations', asyncRoute(async (req, res) => {
    const state = await store.readState();
    const organizations = req.user.role === 'admin'
      ? state.organizations
      : state.organizations.filter((organization) => state.memberships.some((membership) => membership.organizationId === organization.id && membership.userId === req.user.id && !membership.revokedAt));
    res.json({ organizations });
  }));

  app.post('/api/platform/organizations', asyncRoute(async (req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 160);
    if (!name) throw error(400, 'Organization name is required.');
    const organization = {
      id: store.id('org'),
      name,
      slug: String(req.body.slug || name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 100),
      ownerUserId: req.user.id,
      ownerEmail: req.user.email,
      billingEmail: String(req.body.billingEmail || req.user.email).slice(0, 320),
      country: String(req.body.country || '').slice(0, 2).toUpperCase() || null,
      currency: String(req.body.currency || 'USD').slice(0, 3).toUpperCase(),
      planId: String(req.body.planId || 'free'),
      createdAt: store.now(),
      updatedAt: store.now(),
      disabledAt: null
    };
    await store.transact((state) => {
      if (!organization.slug || state.organizations.some((item) => item.slug === organization.slug)) throw error(409, 'Organization slug is unavailable.');
      if (!state.plans.some((plan) => plan.id === organization.planId)) throw error(400, 'Unknown plan.');
      state.organizations.push(organization);
      state.memberships.push({
        id: store.id('membership'),
        organizationId: organization.id,
        userId: req.user.id,
        email: req.user.email,
        role: 'owner',
        createdAt: store.now(),
        revokedAt: null
      });
      return organization;
    });
    await auditRequest(req, 'organization.create', 'success', { organizationId: organization.id });
    res.status(201).json({ organization });
  }));

  app.get('/api/platform/organizations/:id/members', asyncRoute(async (req, res) => {
    const state = await store.readState();
    organizationAccess(state, req.user, req.params.id);
    res.json({ members: state.memberships.filter((item) => item.organizationId === req.params.id && !item.revokedAt) });
  }));

  app.post('/api/platform/organizations/:id/members', asyncRoute(async (req, res) => {
    const member = await store.transact((state) => {
      organizationAccess(state, req.user, req.params.id, ['owner', 'admin']);
      const userId = String(req.body.userId || '').trim();
      const email = String(req.body.email || '').trim().toLowerCase();
      const role = ['admin', 'developer', 'viewer', 'billing'].includes(req.body.role) ? req.body.role : 'developer';
      if (!userId || !email.includes('@')) throw error(400, 'Valid userId and email are required.');
      const existing = state.memberships.find((item) => item.organizationId === req.params.id && item.userId === userId && !item.revokedAt);
      if (existing) {
        existing.role = role;
        existing.email = email;
        return existing;
      }
      const record = { id: store.id('membership'), organizationId: req.params.id, userId, email, role, createdAt: store.now(), revokedAt: null };
      state.memberships.push(record);
      return record;
    });
    await auditRequest(req, 'organization.member.upsert', 'success', { organizationId: req.params.id, memberUserId: member.userId, role: member.role });
    res.status(201).json({ member });
  }));

  app.delete('/api/platform/organizations/:id/members/:membershipId', asyncRoute(async (req, res) => {
    const member = await store.transact((state) => {
      organizationAccess(state, req.user, req.params.id, ['owner', 'admin']);
      const record = state.memberships.find((item) => item.id === req.params.membershipId && item.organizationId === req.params.id);
      if (!record) throw error(404, 'Membership not found.');
      if (record.role === 'owner') throw error(409, 'The organization owner cannot be removed.');
      record.revokedAt = store.now();
      return record;
    });
    await auditRequest(req, 'organization.member.remove', 'success', { organizationId: req.params.id, memberUserId: member.userId });
    res.json({ member });
  }));

  app.get('/api/platform/api-keys', asyncRoute(async (req, res) => {
    res.json({ apiKeys: await apiKeys.listApiKeys(req.user) });
  }));

  app.post('/api/platform/api-keys', asyncRoute(async (req, res) => {
    if (req.user.serviceAccount) throw error(403, 'Service accounts cannot create more API keys.');
    const created = await apiKeys.createApiKey(req.user, req.body || {});
    await auditRequest(req, 'api-key.create', 'success', { apiKeyId: created.record.id, scopes: created.record.scopes });
    res.status(201).json({ apiKey: { ...created.record, tokenHash: undefined }, token: created.token });
  }));

  app.delete('/api/platform/api-keys/:id', asyncRoute(async (req, res) => {
    const record = await apiKeys.revokeApiKey(req.user, req.params.id);
    await auditRequest(req, 'api-key.revoke', 'success', { apiKeyId: record.id });
    res.json({ apiKey: record });
  }));

  app.get('/api/platform/notifications', asyncRoute(async (req, res) => {
    res.json({ notifications: await notifications.listNotifications(req.user, req.query.limit) });
  }));

  app.post('/api/platform/notifications/test-email', asyncRoute(async (req, res) => {
    if (req.user.role !== 'admin') throw error(403, 'Administrator access required.');
    const record = await notifications.sendEmail({
      userId: req.user.id,
      organizationId: req.user.organizationId || null,
      type: 'test',
      recipient: String(req.body.recipient || req.user.email),
      subject: 'Singh Cloud Emulator notification test',
      body: 'Your Singh Cloud Emulator SMTP notification service is working.'
    });
    await auditRequest(req, 'notification.email.test', record.status === 'sent' ? 'success' : 'failure', { notificationId: record.id, status: record.status });
    res.json({ notification: record });
  }));
}

module.exports = { registerManagementRoutes };
