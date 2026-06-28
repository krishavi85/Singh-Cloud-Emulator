const path = require('node:path');
const store = require('./platform-store');

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function activeShare(state, token) {
  const share = state.shares.find((item) => item.token === token);
  if (!share || share.revokedAt || Date.parse(share.expiresAt) <= Date.now()) {
    const error = new Error('Share link is invalid or expired.');
    error.status = 404;
    throw error;
  }
  return share;
}

function safeResource(state, share) {
  const collection = share.resourceType === 'session'
    ? state.sessions
    : share.resourceType === 'app'
      ? state.apps
      : state.workspaces;
  const record = collection.find((item) => item.id === share.resourceId && item.userId === share.userId);
  if (!record) {
    const error = new Error('Shared resource no longer exists.');
    error.status = 404;
    throw error;
  }
  if (share.resourceType === 'session') {
    return { id: record.id, profileId: record.profileId, status: record.status, expiresAt: record.expiresAt };
  }
  return { id: record.id, name: record.name, description: record.description || '', updatedAt: record.updatedAt || record.createdAt };
}

function registerPublicLinks(app, publicDir) {
  app.get('/api/public/share/:token', asyncRoute(async (req, res) => {
    const state = await store.readState();
    const share = activeShare(state, req.params.token);
    if (share.requireAuthentication) return res.status(401).json({ ok: false, error: 'Authentication required.' });
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      share: { resourceType: share.resourceType, allowEmbed: share.allowEmbed, expiresAt: share.expiresAt },
      resource: safeResource(state, share)
    });
  }));

  app.get('/share/:token', (_req, res) => res.sendFile(path.join(publicDir, 'share.html')));
  app.get('/embed/:token', asyncRoute(async (req, res) => {
    const state = await store.readState();
    const share = activeShare(state, req.params.token);
    if (!share.allowEmbed) {
      const error = new Error('Embedding is disabled for this share.');
      error.status = 403;
      throw error;
    }
    res.sendFile(path.join(publicDir, 'embed.html'));
  }));
}

module.exports = { registerPublicLinks };
