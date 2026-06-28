const store = require('./platform-store');
const queues = require('./queue-service');
const { auditRequest } = require('./audit');

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function failure(status, message) {
  return Object.assign(new Error(message), { status });
}

function organizationFor(state, user, workspace) {
  if (user.organizationId) return state.organizations.find((item) => item.id === user.organizationId) || null;
  if (workspace.organizationId) return state.organizations.find((item) => item.id === workspace.organizationId) || null;
  const membership = state.memberships.find((item) => item.userId === user.id && !item.revokedAt);
  return membership ? state.organizations.find((item) => item.id === membership.organizationId) || null : null;
}

function monthlyBuildMinutes(state, user, organizationId) {
  const now = new Date();
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  return state.usage
    .filter((item) => item.type === 'build.minutes' && Date.parse(item.at || 0) >= start)
    .filter((item) => organizationId ? item.organizationId === organizationId : item.userId === user.id)
    .reduce((total, item) => total + Number(item.quantity || 0), 0);
}

function registerProductionBuildRoutes(app) {
  app.post('/api/platform/builds', asyncRoute(async (req, res) => {
    const build = await store.transact((state) => {
      const workspace = state.workspaces.find((item) => item.id === req.body.workspaceId && store.owned(item, req.user));
      if (!workspace) throw failure(404, 'Workspace not found.');
      const organization = organizationFor(state, req.user, workspace);
      const plan = state.plans.find((item) => item.id === (organization?.planId || 'free')) || state.plans[0];
      const organizationId = organization?.id || workspace.organizationId || null;
      const used = monthlyBuildMinutes(state, req.user, organizationId);
      if (req.user.role !== 'admin' && Number(plan.monthlyBuildMinutes || 0) > 0 && used >= Number(plan.monthlyBuildMinutes)) {
        throw failure(402, 'Monthly build allowance exhausted.');
      }
      const variant = String(req.body.variant || 'debug').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);
      if (!variant) throw failure(400, 'Invalid build variant.');
      const record = {
        id: store.id('build'),
        userId: req.user.id,
        organizationId,
        workspaceId: workspace.id,
        variant,
        format: req.body.format === 'aab' ? 'aab' : 'apk',
        status: 'queued',
        workerId: null,
        workerApiKeyId: null,
        log: '',
        progress: 0,
        artifactId: null,
        createdAt: store.now(),
        startedAt: null,
        completedAt: null,
        lastQueuedAt: store.now(),
        cancelRequested: false,
        retryCount: 0
      };
      state.builds.push(record);
      return { ...record };
    });
    await queues.enqueue('build', build.id, { workspaceId: build.workspaceId, format: build.format });
    await auditRequest(req, 'build.queue', 'success', { buildId: build.id, workspaceId: build.workspaceId, organizationId: build.organizationId });
    res.status(202).json({ build });
  }));
}

module.exports = { registerProductionBuildRoutes };
