const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const store = require('./platform-store');

const execFileAsync = promisify(execFile);

function adbPath() {
  return process.env.ADB_PATH || 'adb';
}

function proxyAddress() {
  const host = process.env.MITMPROXY_DEVICE_HOST;
  const port = Number(process.env.MITMPROXY_DEVICE_PORT || 8080);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw Object.assign(new Error('MITMPROXY_DEVICE_HOST and a valid MITMPROXY_DEVICE_PORT are required.'), { status: 503 });
  }
  return { host, port, value: `${host}:${port}` };
}

async function adb(serial, args) {
  const value = String(serial || '');
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw Object.assign(new Error('Invalid Android serial.'), { status: 400 });
  return execFileAsync(adbPath(), ['-s', value, ...args], { timeout: 30_000, maxBuffer: 10 * 1024 * 1024, windowsHide: true });
}

async function startCapture(user, serial, sessionId = null) {
  const proxy = proxyAddress();
  await adb(serial, ['shell', 'settings', 'put', 'global', 'http_proxy', proxy.value]);
  const record = {
    id: store.id('capture'),
    userId: user.id,
    sessionId: sessionId ? String(sessionId) : null,
    serial,
    proxy: proxy.value,
    status: 'running',
    createdAt: store.now(),
    stoppedAt: null,
    webUrl: process.env.MITMPROXY_WEB_URL || null,
    certificateUrl: process.env.MITMPROXY_CERTIFICATE_URL || 'http://mitm.it',
    harPath: null
  };
  await store.transact((state) => {
    state.networkCaptures ||= [];
    state.networkCaptures.push(record);
    return record;
  });
  return record;
}

async function stopCapture(user, id) {
  const state = await store.readState();
  const record = (state.networkCaptures || []).find((item) => item.id === id && (user.role === 'admin' || item.userId === user.id));
  if (!record) throw Object.assign(new Error('Network capture not found.'), { status: 404 });
  await adb(record.serial, ['shell', 'settings', 'put', 'global', 'http_proxy', ':0']);
  return store.transact((next) => {
    const current = (next.networkCaptures || []).find((item) => item.id === id);
    current.status = 'stopped';
    current.stoppedAt = store.now();
    const template = process.env.MITMPROXY_HAR_URL_TEMPLATE || '';
    current.harPath = template
      ? template.replace(/\{captureId\}/g, encodeURIComponent(current.id)).replace(/\{sessionId\}/g, encodeURIComponent(current.sessionId || ''))
      : null;
    return current;
  });
}

async function listCaptures(user) {
  const state = await store.readState();
  return (state.networkCaptures || []).filter((item) => user.role === 'admin' || item.userId === user.id);
}

module.exports = { listCaptures, startCapture, stopCapture };
