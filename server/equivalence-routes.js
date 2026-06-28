const path = require('node:path');
const store = require('./platform-store');
const services = require('./equivalence-services');
const appium = require('./appium-service');
const profiler = require('./profiling-service');
const captures = require('./network-capture-service');
const { auditRequest } = require('./audit');
const { resolveSerial } = require('./device-routes');

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function ownedSession(state, user, id) {
  const session = state.sessions.find((item) => item.id === id && (user.role === 'admin' || item.userId === user.id));
  if (!session) throw Object.assign(new Error('Session not found.'), { status: 404 });
  return session;
}

function registerEquivalenceRoutes(app) {
  app.get('/api/equivalence/services', asyncRoute(async (req, res) => {
    const report = await services.healthReport();
    await auditRequest(req, 'equivalence.services.inspect', 'success', { configured: Object.values(report).filter((item) => item.configured).length });
    res.json({ services: report });
  }));

  app.get('/api/equivalence/sessions/:id/links', asyncRoute(async (req, res) => {
    const state = await store.readState();
    const session = ownedSession(state, req.user, req.params.id);
    const profile = state.profiles.find((item) => item.id === session.profileId) || {};
    res.json({ sessionId: session.id, platform: profile.platform || null, links: services.sessionLinks(session, profile) });
  }));

  app.post('/api/equivalence/appium/sessions', asyncRoute(async (req, res) => {
    const serial = await resolveSerial(req.user, req.body.serial);
    const record = await appium.createSession(req.user, serial, req.body);
    await auditRequest(req, 'appium.session.create', 'success', { appiumSessionId: record.id, serial });
    res.status(201).json({ session: record });
  }));

  app.delete('/api/equivalence/appium/sessions/:id', asyncRoute(async (req, res) => {
    const record = await appium.closeSession(req.user, req.params.id);
    await auditRequest(req, 'appium.session.close', 'success', { appiumSessionId: record.id, serial: record.serial });
    res.json({ session: record });
  }));

  app.get('/api/equivalence/appium/sessions/:id/source', asyncRoute(async (req, res) => {
    res.json(await appium.source(req.user, req.params.id));
  }));

  app.get('/api/equivalence/appium/sessions/:id/screenshot', asyncRoute(async (req, res) => {
    const body = await appium.screenshot(req.user, req.params.id);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    res.send(Buffer.from(body.value || '', 'base64'));
  }));

  app.get('/api/equivalence/network-captures', asyncRoute(async (req, res) => {
    res.json({ captures: await captures.listCaptures(req.user) });
  }));

  app.post('/api/equivalence/network-captures', asyncRoute(async (req, res) => {
    const serial = await resolveSerial(req.user, req.body.serial);
    const record = await captures.startCapture(req.user, serial, req.body.sessionId);
    await auditRequest(req, 'network.capture.start', 'success', { captureId: record.id, serial, sessionId: record.sessionId });
    res.status(201).json({ capture: record });
  }));

  app.post('/api/equivalence/network-captures/:id/stop', asyncRoute(async (req, res) => {
    const record = await captures.stopCapture(req.user, req.params.id);
    await auditRequest(req, 'network.capture.stop', 'success', { captureId: record.id, serial: record.serial });
    res.json({ capture: record });
  }));

  app.post('/api/equivalence/profiles/perfetto', asyncRoute(async (req, res) => {
    const serial = await resolveSerial(req.user, req.body.serial);
    const artifact = await profiler.collectPerfetto(req.user.id, serial, req.body.durationSeconds);
    await auditRequest(req, 'profile.perfetto.collect', 'success', { serial, artifact: artifact.filename, sizeBytes: artifact.sizeBytes });
    res.status(201).json({ artifact, downloadPath: `/api/equivalence/profiles/artifacts/${encodeURIComponent(artifact.filename)}` });
  }));

  app.post('/api/equivalence/profiles/simpleperf', asyncRoute(async (req, res) => {
    const serial = await resolveSerial(req.user, req.body.serial);
    const artifact = await profiler.collectSimpleperf(req.user.id, serial, req.body.packageName, req.body.durationSeconds);
    await auditRequest(req, 'profile.simpleperf.collect', 'success', { serial, packageName: artifact.packageName, artifact: artifact.filename });
    res.status(201).json({ artifact, downloadPath: `/api/equivalence/profiles/artifacts/${encodeURIComponent(artifact.filename)}` });
  }));

  app.post('/api/equivalence/profiles/heap', asyncRoute(async (req, res) => {
    const serial = await resolveSerial(req.user, req.body.serial);
    const artifact = await profiler.collectHeapDump(req.user.id, serial, req.body.packageName);
    await auditRequest(req, 'profile.heap.collect', 'success', { serial, packageName: artifact.packageName, artifact: artifact.filename });
    res.status(201).json({ artifact, downloadPath: `/api/equivalence/profiles/artifacts/${encodeURIComponent(artifact.filename)}` });
  }));

  app.get('/api/equivalence/layout', asyncRoute(async (req, res) => {
    const serial = await resolveSerial(req.user, req.query.serial);
    const xml = await profiler.dumpUiHierarchy(serial);
    await auditRequest(req, 'layout.hierarchy.dump', 'success', { serial, bytes: Buffer.byteLength(xml) });
    res.type('application/xml').send(xml);
  }));

  app.get('/api/equivalence/profiles/artifacts/:filename', asyncRoute(async (req, res) => {
    const data = await profiler.readArtifact(req.user.id, req.params.filename);
    const extension = path.extname(req.params.filename);
    const contentType = extension === '.perfetto-trace'
      ? 'application/vnd.google.perfetto.trace'
      : 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(req.params.filename)}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(data);
  }));
}

module.exports = { registerEquivalenceRoutes };
