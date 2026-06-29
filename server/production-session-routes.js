const store = require('./platform-store');
const queues = require('./queue-service');
const { auditRequest } = require('./audit');
const { recordSession } = require('./session-meter');

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function error(status, message) {
  return Object.assign(new Error(message), { status });
}

function organizationFor(state, user) {
  if (user.organizationId) return state.organizations.find((item) => item.id === user.organizationId) || null;
  const membership = state.memberships.find((item) => item.userId === user.id && !item.revokedAt);
  return membership ? state.organizations.find((item) => item.id === membership.organizationId) || null : null;
}

function planFor(state, organization) {
  return state.plans.find((item) => item.id === (organization?.planId || 'free')) || state.plans[0];
}

function usedMinutes(state, user, organizationId) {
  const now = new Date();
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  return state.usage
    .filter((item) => item.type === 'session.minutes' && Date.parse(item.at || 0) >= start)
    .filter((item) => organizationId ? item.organizationId === organizationId : item.userId === user.id)
    .reduce((total, item) => total + Number(item.quantity || 0), 0);
}

function registerProductionSessionRoutes(app) {
  app.post('/api/platform/sessions', asyncRoute(async (req, res) => {
    const session = await store.transact((state) => {
      const profile = state.profiles.find((item) => item.id === req.body.profileId && item.enabled);
      if (!profile) throw error(404, 'Device profile not found.');
      const organization = organizationFor(state, req.user);
      const plan = planFor(state, organization);
      const organizationId = organization?.id || null;
      const active = state.sessions.filter((item) =>
        ['queued', 'starting', 'running'].includes(item.status) &&
        (organizationId ? item.organizationId === organizationId : item.userId === req.user.id)
      );
      if (req.user.role !== 'admin' && active.length >= Number(plan.concurrentSessions || 1)) throw error(429, 'Concurrent session limit reached.');
      const used = usedMinutes(state, req.user, organizationId);
      const monthlyLimit = Number(plan.monthlyMinutes || 0);
      if (req.user.role !== 'admin' && monthlyLimit > 0 && used >= monthlyLimit) throw error(402, 'Monthly session allowance exhausted.');
      const requested = Math.max(5, Math.min(480, Number(req.body.durationMinutes || 30)));
      const durationMinutes = req.user.role === 'admin' || monthlyLimit <= 0 ? requested : Math.min(requested, Math.max(5, monthlyLimit - used));
      const serial = req.body.serial ? String(req.body.serial) : '';
      if (serial && !req.user.devices.includes(serial)) throw error(403, 'Requested device is not assigned to this account.');
      const created = {
        id: store.id('session'), userId: req.user.id, userEmail: req.user.email, organizationId,
        profileId: profile.id, platform: profile.platform, appId: req.body.appId ? String(req.body.appId) : null,
        workspaceId: req.body.workspaceId ? String(req.body.workspaceId) : null, serial,
        status: serial ? 'running' : 'queued',
        transport: ['webrtc', 'mjpeg'].includes(req.body.transport) ? req.body.transport : (serial ? 'png' : 'webrtc'),
        createdAt: store.now(), startedAt: serial ? store.now() : null,
        expiresAt: new Date(Date.now() + durationMinutes * 60000).toISOString(), endedAt: null,
        stopRequested: false,
        metadata: { locale: req.body.locale || 'en-US', orientation: profile.orientation, deviceFamily: profile.deviceFamily || null }
      };
      state.sessions.push(created);
      state.usage.push({ id: store.id('usage'), idempotencyKey: `session-created:${created.id}`, organizationId, userId: req.user.id, type: 'session.created', quantity: 1, sessionId: created.id, at: store.now() });
      return { ...created };
    });
    if (session.status === 'queued') await queues.enqueue('session', session.id, { profileId: session.profileId, platform: session.platform });
    await auditRequest(req, 'session.create', 'success', { sessionId: session.id, profileId: session.profileId, organizationId: session.organizationId });
    res.status(201).json({ session });
  }));

  app.post('/api/platform/sessions/:id/stop', asyncRoute(async (req, res) => {
    const session = await store.transact((state) => {
      const record = state.sessions.find((item) => item.id === req.params.id && store.owned(item, req.user));
      if (!record) throw error(404, 'Session not found.');
      if (['stopped', 'expired', 'failed'].includes(record.status)) return { ...record };
      record.stopRequested = true;
      if (!record.workerId || record.status === 'queued') {
        record.status = 'stopped'; record.endedAt = store.now(); record.finishReason = 'stopped-by-user';
        recordSession(state, record);
      }
      return { ...record };
    });
    if (session.status === 'stopped') await queues.ack('session', session.id);
    await auditRequest(req, 'session.stop', 'success', { sessionId: session.id, graceful: Boolean(session.workerId) });
    res.json({ session });
  }));
}

module.exports = { registerProductionSessionRoutes };
