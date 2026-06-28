const fs = require('node:fs/promises');
const store = require('./platform-store');
const workspace = require('./workspace-service');
const git = require('./git-service');
const { auditRequest } = require('./audit');

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function ownedWorkspace(state, user, id) {
  const record = state.workspaces.find((item) => item.id === id && store.owned(item, user));
  if (!record) throw Object.assign(new Error('Workspace not found.'), { status: 404 });
  return record;
}

function registerGitRoutes(app) {
  app.get('/api/platform/workspaces/:id/git/status', asyncRoute(async (req, res) => {
    const state = await store.readState();
    const record = ownedWorkspace(state, req.user, req.params.id);
    res.json({ status: await git.status(record.userId, record.id) });
  }));

  app.get('/api/platform/workspaces/:id/git/log', asyncRoute(async (req, res) => {
    const state = await store.readState();
    const record = ownedWorkspace(state, req.user, req.params.id);
    res.json({ commits: await git.log(record.userId, record.id, req.query.limit) });
  }));

  app.post('/api/platform/workspaces/:id/git/clone', asyncRoute(async (req, res) => {
    const state = await store.readState();
    const record = ownedWorkspace(state, req.user, req.params.id);
    const directory = workspace.workspaceDir(record.userId, record.id);
    const entries = await fs.readdir(directory).catch(() => []);
    if (entries.length && req.body.replace !== true) {
      throw Object.assign(new Error('Workspace contains files. Pass replace=true to replace the starter project.'), { status: 409 });
    }
    if (entries.length) {
      await fs.rm(directory, { recursive: true, force: true });
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    }
    const status = await git.cloneIntoWorkspace(record.userId, record.id, req.body.repositoryUrl, req.body.branch || record.branch || 'main');
    await store.transact((next) => {
      const current = next.workspaces.find((item) => item.id === record.id);
      if (current) {
        current.repositoryUrl = git.validateRepositoryUrl(req.body.repositoryUrl);
        current.branch = status.branch;
        current.updatedAt = store.now();
      }
    });
    await auditRequest(req, 'workspace.git.clone', 'success', { workspaceId: record.id, branch: status.branch });
    res.json({ status });
  }));

  app.post('/api/platform/workspaces/:id/git/pull', asyncRoute(async (req, res) => {
    const state = await store.readState();
    const record = ownedWorkspace(state, req.user, req.params.id);
    const result = await git.pull(record.userId, record.id, req.body.branch);
    await auditRequest(req, 'workspace.git.pull', 'success', { workspaceId: record.id, branch: result.status.branch });
    res.json(result);
  }));

  app.post('/api/platform/workspaces/:id/git/commit', asyncRoute(async (req, res) => {
    const state = await store.readState();
    const record = ownedWorkspace(state, req.user, req.params.id);
    const result = await git.commit(record.userId, record.id, {
      message: req.body.message,
      authorName: req.body.authorName || req.user.displayName || req.user.email,
      authorEmail: req.body.authorEmail || req.user.email
    });
    await auditRequest(req, 'workspace.git.commit', 'success', { workspaceId: record.id, branch: result.status.branch, message: String(req.body.message || '').slice(0, 200) });
    res.json(result);
  }));

  app.post('/api/platform/workspaces/:id/git/push', asyncRoute(async (req, res) => {
    const state = await store.readState();
    const record = ownedWorkspace(state, req.user, req.params.id);
    const result = await git.push(record.userId, record.id, req.body.branch);
    await auditRequest(req, 'workspace.git.push', 'success', { workspaceId: record.id, branch: result.status.branch });
    res.json(result);
  }));
}

module.exports = { registerGitRoutes };
