const crypto = require('node:crypto');
const express = require('express');
const path = require('node:path');
const store = require('./platform-store');
const storage = require('./object-storage');
const queues = require('./queue-service');
const apiKeys = require('./api-key-service');
const { auditRequest } = require('./audit');
const metrics = require('./metrics');

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function error(status, message) {
  return Object.assign(new Error(message), { status });
}

function buildForWorker(state, user, id) {
  if (user.role !== 'admin') apiKeys.requireScope(user, 'builds:write');
  const build = state.builds.find((item) => item.id === id);
  if (!build) throw error(404, 'Build not found.');
  if (build.status !== 'building' && build.status !== 'queued') throw error(409, 'Build is not accepting artifacts.');
  if (user.serviceAccount && build.workerApiKeyId && build.workerApiKeyId !== user.apiKeyId) {
    throw error(403, 'Build is leased by another service account.');
  }
  return build;
}

function artifactKey(build, filename) {
  const safe = path.basename(String(filename || `app-${build.variant}.${build.format}`)).replace(/[^A-Za-z0-9_.-]/g, '_');
  const owner = build.organizationId || build.userId;
  return `builds/${owner}/${build.id}/${crypto.randomBytes(8).toString('hex')}-${safe}`;
}

async function finalize(buildId, input) {
  return store.transact((state) => {
    const build = state.builds.find((item) => item.id === buildId);
    if (!build) throw error(404, 'Build not found.');
    const existing = state.artifacts.find((item) => item.buildId === build.id && item.storageKey === input.storageKey);
    const artifact = existing || {
      id: store.id('artifact'),
      userId: build.userId,
      organizationId: build.organizationId || null,
      buildId: build.id,
      workspaceId: build.workspaceId,
      name: path.basename(input.name),
      format: build.format,
      storageKey: input.storageKey,
      sha256: input.sha256,
      sizeBytes: input.sizeBytes,
      contentType: input.contentType || 'application/octet-stream',
      createdAt: store.now()
    };
    if (!existing) state.artifacts.push(artifact);
    build.status = 'completed';
    build.progress = 100;
    build.artifactId = artifact.id;
    build.completedAt = store.now();
    build.log = String(input.log || build.log || '').slice(-1_000_000);
    return { build: { ...build }, artifact: { ...artifact } };
  });
}

async function completeLease(result) {
  await queues.ack('build', result.build.id, result.build.workerId || null);
  metrics.recordBuild('completed', result.build.format);
}

function registerArtifactRoutes(app) {
  app.post('/api/platform/builds/:id/artifact-upload-url', asyncRoute(async (req, res) => {
    const state = await store.readState();
    const build = buildForWorker(state, req.user, req.params.id);
    const key = artifactKey(build, req.body.name);
    const upload = await storage.presignUpload(key, req.body.contentType || 'application/octet-stream', req.body.expiresSeconds);
    await auditRequest(req, 'artifact.upload-url.create', 'success', { buildId: build.id, key });
    res.json({ upload });
  }));

  app.put(
    '/api/platform/builds/:id/artifact',
    express.raw({ type: ['application/octet-stream', 'application/vnd.android.package-archive'], limit: process.env.MAX_ARTIFACT_SIZE || '2gb' }),
    asyncRoute(async (req, res) => {
      const state = await store.readState();
      const build = buildForWorker(state, req.user, req.params.id);
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw error(400, 'Artifact body is empty.');
      const name = path.basename(String(req.query.name || `app-${build.variant}.${build.format}`));
      const key = artifactKey(build, name);
      const saved = await storage.putBuffer(key, req.body, req.get('content-type') || 'application/octet-stream', { buildid: build.id });
      const suppliedDigest = String(req.get('x-artifact-sha256') || '').toLowerCase();
      if (suppliedDigest && suppliedDigest !== saved.sha256) {
        await storage.remove(saved.key);
        throw error(400, 'Artifact SHA-256 does not match the uploaded content.');
      }
      const result = await finalize(build.id, { ...saved, storageKey: saved.key, name });
      await completeLease(result);
      await auditRequest(req, 'artifact.upload.complete', 'success', { buildId: build.id, artifactId: result.artifact.id, sizeBytes: result.artifact.sizeBytes });
      res.status(201).json(result);
    })
  );

  app.post('/api/platform/builds/:id/artifact-complete', asyncRoute(async (req, res) => {
    const state = await store.readState();
    const build = buildForWorker(state, req.user, req.params.id);
    const object = await storage.stat(req.body.storageKey);
    const sha256 = String(req.body.sha256 || object.metadata?.sha256 || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw error(400, 'A valid SHA-256 digest is required.');
    const result = await finalize(build.id, {
      storageKey: object.key,
      name: path.basename(String(req.body.name || `app-${build.variant}.${build.format}`)),
      sha256,
      sizeBytes: object.sizeBytes,
      contentType: object.contentType,
      log: req.body.log
    });
    await completeLease(result);
    await auditRequest(req, 'artifact.presigned.complete', 'success', { buildId: build.id, artifactId: result.artifact.id });
    res.status(201).json(result);
  }));

  app.get('/api/platform/artifacts/:id/download', asyncRoute(async (req, res) => {
    const state = await store.readState();
    const artifact = state.artifacts.find((item) => item.id === req.params.id && store.owned(item, req.user));
    if (!artifact) throw error(404, 'Artifact not found.');
    const download = await storage.presignDownload(artifact.storageKey, artifact.name, req.query.expiresSeconds);
    await auditRequest(req, 'artifact.download', 'success', { artifactId: artifact.id });
    if (!download.local) return res.redirect(302, download.url);
    const data = await storage.readLocal(artifact.storageKey);
    res.setHeader('Content-Type', artifact.contentType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(artifact.name)}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    return res.send(data);
  }));

  app.delete('/api/platform/artifacts/:id', asyncRoute(async (req, res) => {
    const artifact = await store.transact((state) => {
      const index = state.artifacts.findIndex((item) => item.id === req.params.id && store.owned(item, req.user));
      if (index < 0) throw error(404, 'Artifact not found.');
      const [removed] = state.artifacts.splice(index, 1);
      const build = state.builds.find((item) => item.artifactId === removed.id);
      if (build) build.artifactId = null;
      return removed;
    });
    await storage.remove(artifact.storageKey);
    await auditRequest(req, 'artifact.delete', 'success', { artifactId: artifact.id });
    res.json({ ok: true });
  }));
}

module.exports = { registerArtifactRoutes };
