const express = require('express');
const path = require('node:path');
const store = require('./platform-store');
const queues = require('./queue-service');
const storage = require('./object-storage');
const apiKeys = require('./api-key-service');
const { auditRequest } = require('./audit');

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function error(status, message) {
  return Object.assign(new Error(message), { status });
}

function requireCaptureWorker(user) {
  if (user.role !== 'admin') apiKeys.requireScope(user, 'captures:write');
}

function assertLease(user, record, workerId) {
  if (user.role === 'admin') return;
  if (record.workerApiKeyId && record.workerApiKeyId !== user.apiKeyId) throw error(403, 'Capture lease belongs to another service account.');
  if (record.workerId && workerId && record.workerId !== String(workerId)) throw error(409, 'Worker ID does not match the capture lease.');
}

async function seedQueue() {
  if (await queues.depth('capture')) return;
  const state = await store.readState();
  await Promise.all(state.networkCaptures.filter((item) => item.status === 'queued').slice(0, 100).map((item) => queues.enqueue('capture', item.id, { serial: item.serial, sessionId: item.sessionId })));
}

function captureKey(record, suffix) {
  const owner = record.organizationId || record.userId;
  return `captures/${owner}/${record.id}/${path.basename(suffix)}`;
}

function registerCaptureWorkerRoutes(app) {
  app.post('/api/platform/workers/captures/claim', asyncRoute(async (req, res) => {
    requireCaptureWorker(req.user);
    const workerId = String(req.body.workerId || req.user.apiKeyId || req.user.id).slice(0, 160);
    await seedQueue();
    let claimed = null;
    for (let attempt = 0; attempt < 20 && !claimed; attempt += 1) {
      const lease = await queues.claim('capture', workerId, req.body.leaseSeconds || 300);
      if (!lease) break;
      claimed = await store.transact((state) => {
        const record = state.networkCaptures.find((item) => item.id === lease.id);
        if (!record || record.status !== 'queued' || record.stopRequested) return null;
        record.status = 'starting';
        record.workerId = workerId;
        record.workerApiKeyId = req.user.apiKeyId || null;
        record.claimedAt = store.now();
        record.lastHeartbeatAt = store.now();
        return { ...record };
      });
      if (!claimed) await queues.ack('capture', lease.id, workerId);
    }
    if (claimed) await auditRequest(req, 'worker.capture.claim', 'success', { captureId: claimed.id, workerId });
    res.json({ capture: claimed });
  }));

  app.post('/api/platform/workers/captures/:id/attach', asyncRoute(async (req, res) => {
    requireCaptureWorker(req.user);
    const record = await store.transact((state) => {
      const current = state.networkCaptures.find((item) => item.id === req.params.id);
      if (!current) throw error(404, 'Network capture not found.');
      assertLease(req.user, current, req.body.workerId);
      current.status = 'running';
      current.proxy = String(req.body.proxy || '').slice(0, 320);
      current.webUrl = req.body.webUrl ? String(req.body.webUrl).slice(0, 1000) : null;
      current.startedAt = store.now();
      current.lastHeartbeatAt = store.now();
      return { ...current };
    });
    res.json({ capture: record });
  }));

  app.post('/api/platform/workers/captures/:id/heartbeat', asyncRoute(async (req, res) => {
    requireCaptureWorker(req.user);
    const record = await store.transact((state) => {
      const current = state.networkCaptures.find((item) => item.id === req.params.id);
      if (!current) throw error(404, 'Network capture not found.');
      assertLease(req.user, current, req.body.workerId);
      current.lastHeartbeatAt = store.now();
      return { ...current };
    });
    await queues.renew('capture', record.id, record.workerId, req.body.leaseSeconds || 300);
    res.json({ ok: true, stopRequested: record.stopRequested === true });
  }));

  app.put(
    '/api/platform/workers/captures/:id/har',
    express.raw({ type: ['application/json', 'application/octet-stream'], limit: process.env.MAX_HAR_SIZE || '1gb' }),
    asyncRoute(async (req, res) => {
      requireCaptureWorker(req.user);
      const state = await store.readState();
      const record = state.networkCaptures.find((item) => item.id === req.params.id);
      if (!record) throw error(404, 'Network capture not found.');
      assertLease(req.user, record, req.get('x-worker-id'));
      if (!Buffer.isBuffer(req.body) || !req.body.length) throw error(400, 'HAR body is empty.');
      const saved = await storage.putBuffer(captureKey(record, 'capture.har'), req.body, 'application/json', { captureid: record.id });
      const updated = await store.transact((next) => {
        const current = next.networkCaptures.find((item) => item.id === record.id);
        current.harStorageKey = saved.key;
        current.harSha256 = saved.sha256;
        current.harSizeBytes = saved.sizeBytes;
        current.harPath = `/api/platform/network-captures/${current.id}/har`;
        return { ...current };
      });
      res.status(201).json({ capture: updated });
    })
  );

  app.post('/api/platform/workers/captures/:id/finish', asyncRoute(async (req, res) => {
    requireCaptureWorker(req.user);
    const record = await store.transact((state) => {
      const current = state.networkCaptures.find((item) => item.id === req.params.id);
      if (!current) throw error(404, 'Network capture not found.');
      assertLease(req.user, current, req.body.workerId);
      current.status = req.body.failed ? 'failed' : 'stopped';
      current.error = req.body.failed ? String(req.body.error || 'capture-failed').slice(0, 2000) : null;
      current.stoppedAt = store.now();
      return { ...current };
    });
    await queues.ack('capture', record.id, record.workerId);
    await auditRequest(req, 'worker.capture.finish', record.status === 'failed' ? 'failure' : 'success', { captureId: record.id, workerId: record.workerId });
    res.json({ capture: record });
  }));

  app.get('/api/platform/network-captures/:id/har', asyncRoute(async (req, res) => {
    const state = await store.readState();
    const record = state.networkCaptures.find((item) => item.id === req.params.id && store.owned(item, req.user));
    if (!record || !record.harStorageKey) throw error(404, 'HAR artifact not found.');
    const download = await storage.presignDownload(record.harStorageKey, `${record.id}.har`, req.query.expiresSeconds);
    if (!download.local) return res.redirect(302, download.url);
    const data = await storage.readLocal(record.harStorageKey);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${record.id}.har"`);
    res.setHeader('Cache-Control', 'private, no-store');
    return res.send(data);
  }));
}

module.exports = { registerCaptureWorkerRoutes };
