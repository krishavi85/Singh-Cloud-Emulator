const store = require('./platform-store');
const { auditRequest } = require('./audit');

function registerAutomationRoutes(app) {
  app.post('/api/platform/recordings/:id/action', async (req, res, next) => {
    try {
      const allowed = new Set(['tap', 'swipe', 'text', 'key', 'rotate', 'launch']);
      const type = String(req.body.type || '');
      if (!allowed.has(type)) return res.status(400).json({ ok: false, error: 'Unsupported recorded action.' });
      const action = await store.transact((state) => {
        const recording = state.recordings.find((item) => item.id === req.params.id && (req.user.role === 'admin' || item.userId === req.user.id));
        if (!recording) throw Object.assign(new Error('Recording not found.'), { status: 404 });
        if (recording.status !== 'recording') throw Object.assign(new Error('Recording is not active.'), { status: 409 });
        const previous = recording.actions.at(-1);
        const at = Date.now();
        const record = {
          type,
          payload: req.body.payload || {},
          serial: String(req.body.serial || recording.serial || ''),
          delayMs: previous ? Math.min(30_000, Math.max(0, at - previous.at)) : 0,
          at
        };
        recording.actions.push(record);
        recording.updatedAt = store.now();
        return record;
      });
      await auditRequest(req, 'automation.action.record', 'success', { recordingId: req.params.id, type });
      res.status(201).json({ action });
    } catch (error) {
      next(error);
    }
  });
}

module.exports = { registerAutomationRoutes };
