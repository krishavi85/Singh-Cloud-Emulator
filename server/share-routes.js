const path = require('node:path');
const store = require('./platform-store');

function registerShareRoutes(app) {
  app.get('/share/:token', (_req, res) => res.sendFile(path.resolve(__dirname, '..', 'public', 'share.html')));
  app.get('/embed/:token', (_req, res) => res.sendFile(path.resolve(__dirname, '..', 'public', 'share.html')));

  app.get('/api/platform/share/:token', async (req, res, next) => {
    try {
      const state = await store.readState();
      const share = state.shares.find((item) => item.token === req.params.token);
      if (!share || share.revokedAt || Date.parse(share.expiresAt) <= Date.now()) {
        return res.status(404).json({ ok: false, error: 'Share link is invalid or expired.' });
      }
      const collection = share.resourceType === 'session'
        ? state.sessions
        : share.resourceType === 'app'
          ? state.apps
          : state.workspaces;
      const resource = collection.find((item) => item.id === share.resourceId && item.userId === share.userId);
      if (!resource) return res.status(404).json({ ok: false, error: 'Shared resource was removed.' });
      const safe = share.resourceType === 'session'
        ? { id: resource.id, profileId: resource.profileId, status: resource.status, expiresAt: resource.expiresAt }
        : { id: resource.id, name: resource.name, description: resource.description || '', updatedAt: resource.updatedAt || resource.createdAt };
      res.setHeader('Cache-Control', 'no-store');
      res.json({ share: { resourceType: share.resourceType, allowEmbed: share.allowEmbed, expiresAt: share.expiresAt }, resource: safe });
    } catch (error) {
      next(error);
    }
  });
}

module.exports = { registerShareRoutes };
