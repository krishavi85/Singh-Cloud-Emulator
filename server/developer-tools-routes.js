const bridge = require('./debug-service');
const { resolveSerial } = require('./device-routes');
const { auditRequest } = require('./audit');

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function registerDeveloperToolsRoutes(app) {
  app.get('/api/platform/developer-sessions', asyncRoute(async (req, res) => {
    res.json({ sessions: await bridge.list(req.user) });
  }));

  app.post('/api/platform/developer-sessions', asyncRoute(async (req, res) => {
    const serial = await resolveSerial(req.user, req.body.serial);
    const record = await bridge.create(req.user, serial, req.body.packageName);
    await auditRequest(req, 'developer.session.create', 'success', {
      sessionId: record.id,
      serial: record.serial,
      packageName: record.packageName,
      port: record.port
    });
    res.status(201).json({ session: record });
  }));

  app.delete('/api/platform/developer-sessions/:id', asyncRoute(async (req, res) => {
    const record = await bridge.close(req.user, req.params.id);
    await auditRequest(req, 'developer.session.close', 'success', { sessionId: record.id });
    res.json({ session: record });
  }));
}

module.exports = { registerDeveloperToolsRoutes };
