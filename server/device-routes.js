const adb = require('./adb');
const emulator = require('./emulator');
const { auditRequest } = require('./audit');
const { assertDeviceAllowed, filterDevicesForUser } = require('./device-access');
const { controlLimiter } = require('./rate-limits');
const { sendToUser } = require('./websocket-auth');

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function finiteNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw httpError(400, `${name} must be a finite number.`);
  return number;
}

async function resolveSerial(user, requestedSerial) {
  const devices = filterDevicesForUser(user, await adb.listDevices()).filter((device) => device.state === 'device');
  if (requestedSerial) {
    assertDeviceAllowed(user, requestedSerial);
    if (!devices.some((device) => device.serial === requestedSerial)) throw httpError(409, 'Assigned Android device is offline.');
    return requestedSerial;
  }
  if (!devices.length) throw httpError(409, 'No assigned Android device is online.');
  return devices[0].serial;
}

function registerDeviceRoutes(app) {
  app.get('/api/devices', asyncRoute(async (req, res) => {
    const devices = filterDevicesForUser(req.user, await adb.listDevices());
    await auditRequest(req, 'device.list', 'success', { count: devices.length });
    res.json({ devices, managedEmulator: emulator.managedStatus() });
  }));

  app.get('/api/device', asyncRoute(async (req, res) => {
    const serial = await resolveSerial(req.user, req.query.serial);
    const [size, foregroundPackage] = await Promise.all([
      adb.getDeviceSize(serial),
      adb.getForegroundPackage(serial).catch(() => null)
    ]);
    await auditRequest(req, 'device.inspect', 'success', { serial });
    res.json({ serial, size, foregroundPackage });
  }));

  app.get('/api/screenshot', asyncRoute(async (req, res) => {
    const serial = await resolveSerial(req.user, req.query.serial);
    const image = await adb.screenshot(serial);
    await auditRequest(req, 'device.screenshot', 'success', { serial });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.send(image);
  }));

  app.get('/api/stream', asyncRoute(async (req, res) => {
    const serial = await resolveSerial(req.user, req.query.serial);
    const boundary = 'singhframe';
    let closed = false;
    let busy = false;

    await auditRequest(req, 'stream.open', 'success', { serial });
    res.writeHead(200, {
      'Content-Type': `multipart/x-mixed-replace; boundary=${boundary}`,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Connection: 'close',
      Pragma: 'no-cache'
    });

    req.on('close', () => { closed = true; });
    const timer = setInterval(async () => {
      if (closed || busy) return;
      busy = true;
      try {
        const image = await adb.screenshot(serial);
        res.write(`--${boundary}\r\n`);
        res.write('Content-Type: image/png\r\n');
        res.write(`Content-Length: ${image.length}\r\n\r\n`);
        res.write(image);
        res.write('\r\n');
      } catch {
        sendToUser(req.user.id, { type: 'error', message: 'Screen stream interrupted.' });
        clearInterval(timer);
      } finally {
        busy = false;
      }
    }, Math.round(1000 / Math.min(10, Math.max(1, Number(process.env.STREAM_FPS || 4)))));

    req.on('close', () => {
      clearInterval(timer);
      auditRequest(req, 'stream.close', 'success', { serial }).catch(() => {});
    });
  }));

  app.post('/api/input/tap', controlLimiter, asyncRoute(async (req, res) => {
    const serial = await resolveSerial(req.user, req.body.serial);
    await adb.tap(serial, finiteNumber(req.body.x, 'x'), finiteNumber(req.body.y, 'y'));
    await auditRequest(req, 'device.tap', 'success', { serial });
    res.json({ ok: true });
  }));

  app.post('/api/input/swipe', controlLimiter, asyncRoute(async (req, res) => {
    const serial = await resolveSerial(req.user, req.body.serial);
    await adb.swipe(
      serial,
      finiteNumber(req.body.x1, 'x1'), finiteNumber(req.body.y1, 'y1'),
      finiteNumber(req.body.x2, 'x2'), finiteNumber(req.body.y2, 'y2'),
      finiteNumber(req.body.duration || 300, 'duration')
    );
    await auditRequest(req, 'device.swipe', 'success', { serial });
    res.json({ ok: true });
  }));

  app.post('/api/input/text', controlLimiter, asyncRoute(async (req, res) => {
    const serial = await resolveSerial(req.user, req.body.serial);
    const text = String(req.body.text || '');
    if (text.length > 500) throw httpError(400, 'Text input is too long.');
    await adb.text(serial, text);
    await auditRequest(req, 'device.text', 'success', { serial, length: text.length });
    res.json({ ok: true });
  }));

  app.post('/api/input/key', controlLimiter, asyncRoute(async (req, res) => {
    const serial = await resolveSerial(req.user, req.body.serial);
    const key = Math.round(finiteNumber(req.body.key, 'key'));
    if (key < 0 || key > 1000) throw httpError(400, 'Key code is out of range.');
    await adb.keyevent(serial, key);
    await auditRequest(req, 'device.key', 'success', { serial, key });
    res.json({ ok: true });
  }));

  app.post('/api/device/rotate', controlLimiter, asyncRoute(async (req, res) => {
    const serial = await resolveSerial(req.user, req.body.serial);
    await adb.rotate(serial, req.body.orientation);
    await auditRequest(req, 'device.rotate', 'success', { serial, orientation: req.body.orientation });
    res.json({ ok: true });
  }));

  app.post('/api/app/launch', controlLimiter, asyncRoute(async (req, res) => {
    const serial = await resolveSerial(req.user, req.body.serial);
    const packageName = String(req.body.packageName || '');
    if (!packageName) throw httpError(400, 'packageName is required.');
    const result = await adb.launchPackage(serial, packageName);
    await auditRequest(req, 'app.launch', 'success', { serial, packageName });
    res.json({ ok: true, output: `${result.stdout || ''}${result.stderr || ''}`.trim() });
  }));

  app.post('/api/emulator/start', asyncRoute(async (req, _res) => {
    await auditRequest(req, 'emulator.start', 'denied', { reason: 'external-orchestrator-required' });
    throw httpError(501, 'Public mode requires an external isolated worker orchestrator.');
  }));

  app.post('/api/emulator/stop', asyncRoute(async (req, _res) => {
    await auditRequest(req, 'emulator.stop', 'denied', { reason: 'external-orchestrator-required' });
    throw httpError(501, 'Public mode requires an external isolated worker orchestrator.');
  }));
}

module.exports = { registerDeviceRoutes, resolveSerial };
