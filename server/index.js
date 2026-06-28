require('dotenv').config();

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const cors = require('cors');
const express = require('express');
const helmet = require('helmet');
const multer = require('multer');
const { WebSocketServer } = require('ws');
const adb = require('./adb');
const emulator = require('./emulator');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 8080);
const streamFps = Math.min(10, Math.max(1, Number(process.env.STREAM_FPS || 4)));
const maxApkSizeMb = Math.max(1, Number(process.env.MAX_APK_SIZE_MB || 500));
const uploadsDir = path.resolve(__dirname, '..', 'uploads');
const publicDir = path.resolve(__dirname, '..', 'public');

fs.mkdirSync(uploadsDir, { recursive: true });

const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: maxApkSizeMb * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    const validName = file.originalname.toLowerCase().endsWith('.apk');
    const validMime = ['application/vnd.android.package-archive', 'application/octet-stream'].includes(file.mimetype);
    callback(validName || validMime ? null : new Error('Only Android APK files are accepted.'), validName || validMime);
  }
});

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(publicDir));

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

async function resolveSerial(requestedSerial) {
  if (requestedSerial) return requestedSerial;
  if (process.env.ANDROID_SERIAL) return process.env.ANDROID_SERIAL;
  const devices = await adb.listDevices();
  const ready = devices.find((device) => device.state === 'device');
  if (!ready) throw new Error('No online Android emulator or device was found.');
  return ready.serial;
}

function sendWs(payload) {
  const message = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(message);
  }
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, name: 'Singh Cloud Emulator', version: '0.1.0' });
});

app.get('/api/devices', asyncRoute(async (_req, res) => {
  const devices = await adb.listDevices();
  res.json({ devices, managedEmulator: emulator.managedStatus() });
}));

app.get('/api/device', asyncRoute(async (req, res) => {
  const serial = await resolveSerial(req.query.serial);
  const [size, foregroundPackage] = await Promise.all([
    adb.getDeviceSize(serial),
    adb.getForegroundPackage(serial).catch(() => null)
  ]);
  res.json({ serial, size, foregroundPackage });
}));

app.get('/api/screenshot', asyncRoute(async (req, res) => {
  const serial = await resolveSerial(req.query.serial);
  const image = await adb.screenshot(serial);
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.send(image);
}));

app.get('/api/stream', asyncRoute(async (req, res) => {
  const serial = await resolveSerial(req.query.serial);
  const boundary = 'singhframe';
  let closed = false;
  let busy = false;

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
    } catch (error) {
      sendWs({ type: 'error', message: error.message });
    } finally {
      busy = false;
    }
  }, Math.round(1000 / streamFps));

  req.on('close', () => clearInterval(timer));
}));

app.post('/api/input/tap', asyncRoute(async (req, res) => {
  const serial = await resolveSerial(req.body.serial);
  await adb.tap(serial, req.body.x, req.body.y);
  res.json({ ok: true });
}));

app.post('/api/input/swipe', asyncRoute(async (req, res) => {
  const serial = await resolveSerial(req.body.serial);
  await adb.swipe(serial, req.body.x1, req.body.y1, req.body.x2, req.body.y2, req.body.duration);
  res.json({ ok: true });
}));

app.post('/api/input/text', asyncRoute(async (req, res) => {
  const serial = await resolveSerial(req.body.serial);
  await adb.text(serial, req.body.text || '');
  res.json({ ok: true });
}));

app.post('/api/input/key', asyncRoute(async (req, res) => {
  const serial = await resolveSerial(req.body.serial);
  await adb.keyevent(serial, req.body.key);
  res.json({ ok: true });
}));

app.post('/api/device/rotate', asyncRoute(async (req, res) => {
  const serial = await resolveSerial(req.body.serial);
  await adb.rotate(serial, req.body.orientation);
  res.json({ ok: true });
}));

app.post('/api/apk/install', upload.single('apk'), asyncRoute(async (req, res) => {
  if (!req.file) throw new Error('Choose an APK file first.');
  const serial = await resolveSerial(req.body.serial);
  const originalName = path.basename(req.file.originalname);
  sendWs({ type: 'install', status: 'started', file: originalName });

  try {
    const result = await adb.installApk(serial, req.file.path);
    sendWs({ type: 'install', status: 'completed', file: originalName });
    res.json({ ok: true, output: `${result.stdout || ''}${result.stderr || ''}`.trim() });
  } finally {
    fs.rm(req.file.path, { force: true }, () => {});
  }
}));

app.post('/api/app/launch', asyncRoute(async (req, res) => {
  const serial = await resolveSerial(req.body.serial);
  if (!req.body.packageName) throw new Error('packageName is required.');
  const result = await adb.launchPackage(serial, req.body.packageName);
  res.json({ ok: true, output: `${result.stdout || ''}${result.stderr || ''}`.trim() });
}));

app.post('/api/emulator/start', asyncRoute(async (req, res) => {
  const avd = req.body.avd || process.env.ANDROID_AVD;
  const child = emulator.startEmulator(avd);
  child.stdout.on('data', (chunk) => sendWs({ type: 'emulator-log', stream: 'stdout', message: chunk.toString() }));
  child.stderr.on('data', (chunk) => sendWs({ type: 'emulator-log', stream: 'stderr', message: chunk.toString() }));
  sendWs({ type: 'emulator', status: 'starting', avd, pid: child.pid });
  res.status(202).json({ ok: true, status: 'starting', avd, pid: child.pid });
}));

app.post('/api/emulator/stop', asyncRoute(async (req, res) => {
  const serial = await resolveSerial(req.body.serial);
  await emulator.stopEmulator(serial);
  sendWs({ type: 'emulator', status: 'stopped', serial });
  res.json({ ok: true });
}));

wss.on('connection', (socket) => {
  socket.send(JSON.stringify({ type: 'connected', message: 'Singh Cloud Emulator WebSocket connected.' }));
});

app.use((error, _req, res, _next) => {
  console.error(error);
  sendWs({ type: 'error', message: error.message || 'Unexpected server error.' });
  res.status(error instanceof multer.MulterError ? 400 : 500).json({
    ok: false,
    error: error.message || 'Unexpected server error.'
  });
});

server.listen(port, host, async () => {
  console.log(`Singh Cloud Emulator: http://${host}:${port}`);

  if (String(process.env.AUTO_START_AVD).toLowerCase() === 'true' && process.env.ANDROID_AVD) {
    try {
      emulator.startEmulator(process.env.ANDROID_AVD);
      console.log(`Starting AVD: ${process.env.ANDROID_AVD}`);
    } catch (error) {
      console.error(`Could not auto-start AVD: ${error.message}`);
    }
  }
});
