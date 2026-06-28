const store = require('./platform-store');
const queues = require('./queue-service');
const apiKeys = require('./api-key-service');
const metrics = require('./metrics');
const { auditRequest } = require('./audit');

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function requireBuildWorker(user) {
  if (user.role !== 'admin') apiKeys.requireScope(user, 'builds:write');
}

function error(status, message) {
  return Object.assign(new Error(message), { status });
}

function assertLease(user, build, workerId) {
  if (user.role === 'admin') return;
  if (build.workerApiKeyId && build.workerApiKeyId !== user.apiKeyId) throw error(403, 'Build lease belongs to another API key.');
  if (build.workerId && workerId && build.workerId !== String(workerId)) throw error(409, 'Worker ID does not match the build lease.');
}

async function seedQueueIfNeeded() {
  if (await queues.depth('build')) return;
  const state = await store.readState();
  const queued = state.builds.filter((item) => item.status === 'queued').slice(0, 100);
  await Promise.all(queued.map((build) => queues.enqueue('build', build.id, { workspaceId: build.workspaceId, format: build.format })));
}

function registerBuildWorkerRoutes(app) {
  app.post('/api/platform/workers/builds/claim', asyncRoute(async (req, res) => {
    requireBuildWorker(req.user);
    const workerId = String(req.body.workerId || req.user.apiKeyId || req.user.id).slice(0, 160);
    await seedQueueIfNeeded();
    let claimed = null;
    for (let attempt = 0; attempt < 20 && !claimed; attempt += 1) {
      const lease = await queues.claim('build', workerId, req.body.leaseSeconds || 1800);
      if (!lease) break;
      const result = await store.transact((state) => {
        const build = state.builds.find((item) => item.id === lease.id);
        if (!build || build.status !== 'queued') return null;
        build.status = 'building';
        build.workerId = workerId;
        build.workerApiKeyId = req.user.apiKeyId || null;
        build.startedAt = store.now();
        build.lastHeartbeatAt = store.now();
        build.attempt = Number(build.attempt || 0) + 1;
        return { ...build };
      });
      if (!result) {
        await queues.ack('build', lease.id, workerId);
        continue;
      }
      claimed = result;
    }
    if (claimed) await auditRequest(req, 'worker.build.claim', 'success', { buildId: claimed.id, workerId, attempt: claimed.attempt });
    res.json({ build: claimed });
  }));

  app.post('/api/platform/workers/builds/:id/heartbeat', asyncRoute(async (req, res) => {
    requireBuildWorker(req.user);
    const build = await store.transact((state) => {
      const record = state.builds.find((item) => item.id === req.params.id);
      if (!record) throw error(404, 'Build not found.');
      assertLease(req.user, record, req.body.workerId);
      if (record.status !== 'building') throw error(409, 'Build is not running.');
      record.lastHeartbeatAt = store.now();
      if (req.body.logChunk) record.log = `${record.log || ''}${String(req.body.logChunk)}`.slice(-1_000_000);
      record.progress = Math.max(0, Math.min(100, Number(req.body.progress || record.progress || 0)));
      return { ...record };
    });
    await queues.renew('build', build.id, build.workerId, req.body.leaseSeconds || 1800);
    res.json({ ok: true, cancelled: build.cancelRequested === true });
  }));

  app.post('/api/platform/workers/builds/:id/fail', asyncRoute(async (req, res) => {
    requireBuildWorker(req.user);
    const build = await store.transact((state) => {
      const record = state.builds.find((item) => item.id === req.params.id);
      if (!record) throw error(404, 'Build not found.');
      assertLease(req.user, record, req.body.workerId);
      record.status = 'failed';
      record.completedAt = store.now();
      record.log = String(req.body.log || req.body.error || record.log || '').slice(-1_000_000);
      record.failureReason = String(req.body.error || 'build-failed').slice(0, 2000);
      return { ...record };
    });
    await queues.ack('build', build.id, build.workerId);
    metrics.recordBuild('failed', build.format);
    await auditRequest(req, 'worker.build.fail', 'failure', { buildId: build.id, workerId: build.workerId, reason: build.failureReason });
    res.json({ build });
  }));

  app.post('/api/platform/builds/:id/cancel', asyncRoute(async (req, res) => {
    const build = await store.transact((state) => {
      const record = state.builds.find((item) => item.id === req.params.id && store.owned(item, req.user));
      if (!record) throw error(404, 'Build not found.');
      if (['completed', 'failed', 'cancelled'].includes(record.status)) return record;
      record.cancelRequested = true;
      if (record.status === 'queued') {
        record.status = 'cancelled';
        record.completedAt = store.now();
      }
      return { ...record };
    });
    await auditRequest(req, 'build.cancel', 'success', { buildId: build.id });
    res.json({ build });
  }));
}

module.exports = { registerBuildWorkerRoutes };
