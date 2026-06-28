const store = require('./platform-store');

function requireAdmin(user) {
  if (user.role !== 'admin') {
    const error = new Error('Administrator access required.');
    error.status = 403;
    throw error;
  }
}

function registerWorkerRoutes(app) {
  app.get('/api/platform/workers/session-queue', async (req, res, next) => {
    try {
      requireAdmin(req.user);
      const state = await store.readState();
      res.json({ sessions: state.sessions.filter((item) => item.status === 'queued').slice(0, 100) });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/platform/workers/sessions/:id/attach', async (req, res, next) => {
    try {
      requireAdmin(req.user);
      const session = await store.transact((state) => {
        const record = state.sessions.find((item) => item.id === req.params.id);
        if (!record) throw Object.assign(new Error('Session not found.'), { status: 404 });
        record.serial = String(req.body.serial || '');
        record.workerId = String(req.body.workerId || 'android-worker').slice(0, 120);
        record.status = 'running';
        record.startedAt = record.startedAt || store.now();
        record.lastHeartbeatAt = store.now();
        return record;
      });
      res.json({ session });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/platform/workers/sessions/:id/heartbeat', async (req, res, next) => {
    try {
      requireAdmin(req.user);
      const session = await store.transact((state) => {
        const record = state.sessions.find((item) => item.id === req.params.id);
        if (!record) throw Object.assign(new Error('Session not found.'), { status: 404 });
        record.lastHeartbeatAt = store.now();
        record.workerMetadata = req.body.metadata || {};
        return record;
      });
      res.json({ ok: true, expiresAt: session.expiresAt });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/platform/workers/sessions/:id/finish', async (req, res, next) => {
    try {
      requireAdmin(req.user);
      const session = await store.transact((state) => {
        const record = state.sessions.find((item) => item.id === req.params.id);
        if (!record) throw Object.assign(new Error('Session not found.'), { status: 404 });
        record.status = req.body.failed ? 'failed' : 'stopped';
        record.endedAt = store.now();
        record.finishReason = String(req.body.reason || 'worker-finished').slice(0, 300);
        return record;
      });
      res.json({ session });
    } catch (error) {
      next(error);
    }
  });
}

module.exports = { registerWorkerRoutes };
