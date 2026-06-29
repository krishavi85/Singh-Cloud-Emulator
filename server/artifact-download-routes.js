const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const store = require('./platform-store');
const storage = require('./object-storage');
const { auditRequest } = require('./audit');

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function registerArtifactDownloadRoutes(app) {
  app.get('/api/platform/artifacts/:id/download', asyncRoute(async (req, res) => {
    const state = await store.readState();
    const artifact = state.artifacts.find((item) => item.id === req.params.id && store.owned(item, req.user));
    if (!artifact) return res.status(404).json({ ok: false, error: 'Artifact not found.' });

    const download = await storage.presignDownload(artifact.storageKey, artifact.name, req.query.expiresSeconds);
    await auditRequest(req, 'artifact.download', 'success', { artifactId: artifact.id, proxied: download.proxy === true });
    if (!download.proxy) return res.redirect(302, download.url);

    const object = await storage.openObject(artifact.storageKey);
    res.setHeader('Content-Type', artifact.contentType || object.contentType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(artifact.name)}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    if (object.sizeBytes) res.setHeader('Content-Length', String(object.sizeBytes));
    if (Buffer.isBuffer(object.body)) return res.send(object.body);
    await pipeline(object.body, res);
    return undefined;
  }));
}

module.exports = { registerArtifactDownloadRoutes };
