const store = require('./platform-store');
const queues = require('./queue-service');
const apiKeys = require('./api-key-service');
const { auditRequest } = require('./audit');

function requireWorker(user, scope = 'workers:write') {
  if (user.role === 'admin') return;
  apiKeys.requireScope(user, scope);
}

function error(status, message) {
  return Object.assign(new Error(message), { status });
}

function assertWorkerOwnership(user, record, workerId) {
  if (user.role === 'admin') return;
  if (!user.serviceAccount) throw error(403, 'Service API key required.');
  if (record.workerApiKeyId && record.workerApiKeyId !== user.apiKeyId) throw error(403, 'Worker lease belongs to another service account.');
  if (record.workerId && record.workerId !== String(workerId || record.workerId)) throw error(409, 'Worker ID does not match the active lease.');
}

function workerRecord(state, user, input = {}) {
  const id = String(input.workerId || user.apiKeyId || user.id).slice(0, 160);
  let worker = state.workers.find((item) => item.id === id);
  if (!worker) {
    worker = {
      id,
      apiKeyId: user.apiKeyId || null,
      organizationId: user.organizationId || null,
      platform: String(input.platform || 'android').slice(0, 40),
      runtime: String(input.runtime || 'generic').slice(0, 80),
      profiles: Array.isArray(input.profiles) ? input.profiles.map(String).slice(0, 100) : [],
      capacity: Math.max(1, Math.min(100, Number(input.capacity || 1))),
      activeLeases: 0,
      status: 'ready',
      registeredAt: store.now(),
      lastHeartbeatAt: store.now(),
      metadata: input.metadata || {}
    };
    state.workers.push(worker);
  } else {
    if (worker.apiKeyId && user.apiKeyId && worker.apiKeyId !== user.apiKeyId && user.role !== 'admin') throw error(403, 'Worker ID belongs to another API key.');
    worker.platform = String(input.platform || worker.platform).slice(0, 40);
    worker.runtime = String(input.runtime || worker.runtime).slice(0, 80);
    worker.capacity = Math.max(1, Math.min(100, Number(input.capacity || worker.capacity || 1)));
    worker.profiles = Array.isArray(input.profiles) ? input.profiles.map(String).slice(0, 100) : worker.profiles;
    worker.metadata = { ...(worker.metadata || {}), ...(input.metadata || {}) };
    worker.status = worker.activeLeases >= worker.capacity ? 'busy' : 'ready';
    worker.lastHeartbeatAt = store.now();
  }
  return worker;
}

function registerWorkerRoutes(app) {
  app.get('/api/platform/workers', async (req, res, next) => {
    try {
      requireWorker(req.user, 'workers:read');
      const state = await store.readState();
      const workers = req.user.role === 'admin'
        ? state.workers
        : state.workers.filter((item) => item.apiKeyId === req.user.apiKeyId || (req.user.organizationId && item.organizationId === req.user.organizationId));
      res.json({ workers });
    } catch (errorValue) {
      next(errorValue);
    }
  });

  app.post('/api/platform/workers/register', async (req, res, next) => {
    try {
      requireWorker(req.user);
      const worker = await store.transact((state) => workerRecord(state, req.user, req.body));
      await auditRequest(req, 'worker.register', 'success', { workerId: worker.id, platform: worker.platform, runtime: worker.runtime });
      res.status(201).json({ worker });
    } catch (errorValue) {
      next(errorValue);
    }
  });

  app.post('/api/platform/workers/heartbeat', async (req, res, next) => {
    try {
      requireWorker(req.user);
      const worker = await store.transact((state) => workerRecord(state, req.user, req.body));
      res.json({ worker, serverTime: store.now() });
    } catch (errorValue) {
      next(errorValue);
    }
  });

  app.get('/api/platform/workers/session-queue', async (req, res, next) => {
    try {
      requireWorker(req.user, 'workers:read');
      const state = await store.readState();
      res.json({ sessions: state.sessions.filter((item) => item.status === 'queued').slice(0, 100), depth: await queues.depth('session') });
    } catch (errorValue) {
      next(errorValue);
    }
  });

  app.post('/api/platform/workers/sessions/claim', async (req, res, next) => {
    try {
      requireWorker(req.user);
      const worker = await store.transact((state) => workerRecord(state, req.user, req.body));
      if (worker.activeLeases >= worker.capacity) return res.json({ session: null, reason: 'capacity-exhausted' });
      let claimed = null;
      for (let attempt = 0; attempt < 20 && !claimed; attempt += 1) {
        const lease = await queues.claim('session', worker.id, req.body.leaseSeconds || 300);
        if (!lease) break;
        const result = await store.transact((state) => {
          const session = state.sessions.find((item) => item.id === lease.id);
          if (!session || session.status !== 'queued' || Date.parse(session.expiresAt) <= Date.now()) return { action: 'discard' };
          const profile = state.profiles.find((item) => item.id === session.profileId);
          if (!profile) return { action: 'discard' };
          const supportedPlatform = worker.platform === 'any' || worker.platform === profile.platform || (worker.platform === 'android' && ['android', 'android-tv', 'wear-os'].includes(profile.platform));
          const supportedProfile = !worker.profiles.length || worker.profiles.includes(profile.id);
          if (!supportedPlatform || !supportedProfile) return { action: 'requeue', session, profile };
          session.status = 'starting';
          session.workerId = worker.id;
          session.workerApiKeyId = req.user.apiKeyId || null;
          session.claimedAt = store.now();
          session.lastHeartbeatAt = store.now();
          session.platform = profile.platform;
          const currentWorker = state.workers.find((item) => item.id === worker.id);
          currentWorker.activeLeases = Number(currentWorker.activeLeases || 0) + 1;
          currentWorker.status = currentWorker.activeLeases >= currentWorker.capacity ? 'busy' : 'ready';
          return { action: 'claimed', session: { ...session }, profile: { ...profile } };
        });
        if (result.action === 'discard') {
          await queues.ack('session', lease.id, worker.id);
          continue;
        }
        if (result.action === 'requeue') {
          await queues.requeue('session', lease, 'worker-profile-mismatch');
          continue;
        }
        claimed = { ...result.session, profile: result.profile };
      }
      if (claimed) await auditRequest(req, 'worker.session.claim', 'success', { workerId: worker.id, sessionId: claimed.id, profileId: claimed.profileId });
      res.json({ session: claimed });
    } catch (errorValue) {
      next(errorValue);
    }
  });

  app.post('/api/platform/workers/sessions/:id/attach', async (req, res, next) => {
    try {
      requireWorker(req.user);
      const session = await store.transact((state) => {
        const record = state.sessions.find((item) => item.id === req.params.id);
        if (!record) throw error(404, 'Session not found.');
        assertWorkerOwnership(req.user, record, req.body.workerId);
        if (!['starting', 'queued'].includes(record.status)) throw error(409, 'Session cannot be attached in its current state.');
        record.serial = String(req.body.serial || '').slice(0, 160);
        record.workerId = String(req.body.workerId || record.workerId || 'worker').slice(0, 160);
        record.workerApiKeyId = req.user.apiKeyId || record.workerApiKeyId || null;
        record.transport = req.body.transport === 'webrtc' ? 'webrtc' : record.transport;
        record.status = 'running';
        record.startedAt = record.startedAt || store.now();
        record.lastHeartbeatAt = store.now();
        record.workerMetadata = { ...(record.workerMetadata || {}), ...(req.body.metadata || {}) };
        return { ...record };
      });
      await auditRequest(req, 'worker.session.attach', 'success', { workerId: session.workerId, sessionId: session.id, serial: session.serial });
      res.json({ session });
    } catch (errorValue) {
      next(errorValue);
    }
  });

  app.post('/api/platform/workers/sessions/:id/heartbeat', async (req, res, next) => {
    try {
      requireWorker(req.user);
      const session = await store.transact((state) => {
        const record = state.sessions.find((item) => item.id === req.params.id);
        if (!record) throw error(404, 'Session not found.');
        assertWorkerOwnership(req.user, record, req.body.workerId);
        record.lastHeartbeatAt = store.now();
        record.workerMetadata = { ...(record.workerMetadata || {}), ...(req.body.metadata || {}) };
        const currentWorker = state.workers.find((item) => item.id === record.workerId);
        if (currentWorker) currentWorker.lastHeartbeatAt = store.now();
        return { ...record };
      });
      await queues.renew('session', session.id, session.workerId, req.body.leaseSeconds || 300);
      res.json({ ok: true, expiresAt: session.expiresAt, stopRequested: ['stopped', 'expired', 'failed'].includes(session.status) });
    } catch (errorValue) {
      next(errorValue);
    }
  });

  app.post('/api/platform/workers/sessions/:id/finish', async (req, res, next) => {
    try {
      requireWorker(req.user);
      const session = await store.transact((state) => {
        const record = state.sessions.find((item) => item.id === req.params.id);
        if (!record) throw error(404, 'Session not found.');
        assertWorkerOwnership(req.user, record, req.body.workerId);
        record.status = req.body.failed ? 'failed' : (record.status === 'expired' ? 'expired' : 'stopped');
        record.endedAt = store.now();
        record.finishReason = String(req.body.reason || 'worker-finished').slice(0, 300);
        const currentWorker = state.workers.find((item) => item.id === record.workerId);
        if (currentWorker) {
          currentWorker.activeLeases = Math.max(0, Number(currentWorker.activeLeases || 1) - 1);
          currentWorker.status = currentWorker.activeLeases >= currentWorker.capacity ? 'busy' : 'ready';
          currentWorker.lastHeartbeatAt = store.now();
        }
        return { ...record };
      });
      await queues.ack('session', session.id, session.workerId);
      await auditRequest(req, 'worker.session.finish', session.status === 'failed' ? 'failure' : 'success', { workerId: session.workerId, sessionId: session.id, reason: session.finishReason });
      res.json({ session });
    } catch (errorValue) {
      next(errorValue);
    }
  });
}

module.exports = { registerWorkerRoutes };
