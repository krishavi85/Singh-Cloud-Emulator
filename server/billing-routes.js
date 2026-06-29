const store = require('./platform-store');
const billing = require('./billing-service');
const { audit, auditRequest } = require('./audit');

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function error(status, message) {
  return Object.assign(new Error(message), { status });
}

function organizationForUser(state, user, id) {
  const organization = state.organizations.find((item) => item.id === id);
  if (!organization) throw error(404, 'Organization not found.');
  if (user.role === 'admin') return organization;
  const membership = state.memberships.find((item) => item.organizationId === id && item.userId === user.id && !item.revokedAt);
  if (!membership || !['owner', 'admin', 'billing'].includes(membership.role)) throw error(403, 'Billing access denied.');
  return organization;
}

function registerPublicBillingWebhook(app) {
  app.post('/api/webhooks/lago', asyncRoute(async (req, res) => {
    const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
    const result = await billing.processWebhook(raw, req.headers);
    await audit({
      requestId: req.requestId,
      ip: req.ip,
      action: 'billing.lago.webhook',
      outcome: 'success',
      details: { type: result.type || null, duplicate: result.duplicate === true, uniqueKey: req.get('x-lago-unique-key') || null }
    });
    res.status(result.duplicate ? 200 : 202).json({ ok: true, duplicate: result.duplicate === true });
  }));
}

function registerBillingRoutes(app) {
  app.get('/api/platform/billing/status', asyncRoute(async (_req, res) => {
    res.json({ billing: await billing.health() });
  }));

  app.get('/api/platform/organizations/:id/subscriptions', asyncRoute(async (req, res) => {
    const state = await store.readState();
    organizationForUser(state, req.user, req.params.id);
    res.json({ subscriptions: state.subscriptions.filter((item) => item.organizationId === req.params.id) });
  }));

  app.get('/api/platform/organizations/:id/invoices', asyncRoute(async (req, res) => {
    const state = await store.readState();
    organizationForUser(state, req.user, req.params.id);
    res.json({ invoices: state.invoices.filter((item) => item.organizationId === req.params.id).slice(-500).reverse() });
  }));

  app.post('/api/platform/organizations/:id/subscription', asyncRoute(async (req, res) => {
    const state = await store.readState();
    const organization = organizationForUser(state, req.user, req.params.id);
    const plan = state.plans.find((item) => item.id === req.body.planId);
    if (!plan) throw error(400, 'Unknown plan.');
    const subscription = await billing.assignPlan(organization, plan.id, { billingTime: req.body.billingTime });
    await auditRequest(req, 'billing.subscription.assign', 'success', { organizationId: organization.id, planId: plan.id, subscriptionId: subscription.id });
    res.status(201).json({ subscription });
  }));

  app.delete('/api/platform/organizations/:id/subscription/:subscriptionId', asyncRoute(async (req, res) => {
    const state = await store.readState();
    organizationForUser(state, req.user, req.params.id);
    const subscription = await billing.terminateSubscription(req.params.id, req.params.subscriptionId);
    await auditRequest(req, 'billing.subscription.terminate', 'success', { organizationId: req.params.id, subscriptionId: req.params.subscriptionId });
    res.json({ subscription });
  }));

  app.post('/api/platform/organizations/:id/usage-event', asyncRoute(async (req, res) => {
    const state = await store.readState();
    organizationForUser(state, req.user, req.params.id);
    const code = String(req.body.code || '').trim();
    if (!/^[A-Za-z0-9_.-]{2,100}$/.test(code)) throw error(400, 'Invalid billable metric code.');
    const result = await billing.sendUsageEvent({
      organizationId: req.params.id,
      transactionId: req.body.transactionId,
      code,
      properties: req.body.properties || {}
    });
    await auditRequest(req, 'billing.usage.send', 'success', { organizationId: req.params.id, code });
    res.status(202).json({ result });
  }));
}

module.exports = { registerBillingRoutes, registerPublicBillingWebhook };
