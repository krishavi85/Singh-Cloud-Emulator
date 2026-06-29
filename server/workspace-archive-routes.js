const tar = require('tar');
const store = require('./platform-store');
const workspace = require('./workspace-service');
const apiKeys = require('./api-key-service');
const { auditRequest } = require('./audit');

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function error(status, message) {
  return Object.assign(new Error(message), { status });
}

function authorize(state, user, workspaceId, buildId) {
  const record = state.workspaces.find((item) => item.id === workspaceId);
  if (!record) throw error(404, 'Workspace not found.');
  if (!user.serviceAccount) {
    if (!store.owned(record, user)) throw error(403, 'Workspace access denied.');
    return record;
  }
  apiKeys.requireScope(user, 'workspaces:read');
  const build = state.builds.find((item) => item.id === buildId && item.workspaceId === workspaceId);
  if (!build) throw error(404, 'Associated build not found.');
  if (build.workerId && ![user.id, user.apiKeyId].includes(build.workerId)) throw error(403, 'Build is leased by another worker.');
  return record;
}

function registerWorkspaceArchiveRoutes(app) {
  app.get('/api/platform/workspaces/:id/archive', asyncRoute(async (req, res) => {
    const state = await store.readState();
    const record = authorize(state, req.user, req.params.id, req.query.buildId);
    const directory = workspace.workspaceDir(record.userId, record.id);
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${record.id}.tar.gz"`);
    res.setHeader('Cache-Control', 'private, no-store');
    const archive = tar.c({ cwd: directory, gzip: true, portable: true, noMtime: true }, ['.']);
    archive.on('error', (errorValue) => res.destroy(errorValue));
    archive.pipe(res);
    await auditRequest(req, 'workspace.archive.download', 'success', { workspaceId: record.id, buildId: req.query.buildId || null });
  }));
}

module.exports = { registerWorkspaceArchiveRoutes };
