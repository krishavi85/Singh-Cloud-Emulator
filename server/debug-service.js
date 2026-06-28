const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const store = require('./platform-store');

const execFileAsync = promisify(execFile);

function adbPath() {
  return process.env.ADB_PATH || 'adb';
}

function safeSerial(value) {
  const serial = String(value || '');
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(serial)) throw Object.assign(new Error('Invalid Android serial.'), { status: 400 });
  return serial;
}

function safePackage(value) {
  const packageName = String(value || '');
  if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(packageName)) {
    throw Object.assign(new Error('Invalid Android package name.'), { status: 400 });
  }
  return packageName;
}

async function adb(serial, args, options = {}) {
  return execFileAsync(adbPath(), ['-s', safeSerial(serial), ...args], {
    timeout: options.timeout || 30_000,
    maxBuffer: options.maxBuffer || 10 * 1024 * 1024,
    encoding: 'utf8',
    windowsHide: true
  });
}

async function processId(serial, packageName) {
  const { stdout } = await adb(serial, ['shell', 'pidof', safePackage(packageName)]);
  const pid = String(stdout || '').trim().split(/\s+/)[0];
  if (!/^\d+$/.test(pid)) throw Object.assign(new Error('Application process is not running.'), { status: 409 });
  return pid;
}

function sessionUrl(record) {
  const template = process.env.DEBUG_ADAPTER_SESSION_URL_TEMPLATE || '';
  if (!template) return null;
  return template
    .replace(/\{debugSessionId\}/g, encodeURIComponent(record.id))
    .replace(/\{host\}/g, encodeURIComponent(record.host))
    .replace(/\{port\}/g, encodeURIComponent(String(record.port)))
    .replace(/\{packageName\}/g, encodeURIComponent(record.packageName))
    .replace(/\{serial\}/g, encodeURIComponent(record.serial));
}

async function create(user, serialValue, packageValue) {
  const serial = safeSerial(serialValue);
  const packageName = safePackage(packageValue);
  const pid = await processId(serial, packageName);
  const { stdout } = await adb(serial, ['forward', 'tcp:0', `jdwp:${pid}`]);
  const port = Number(String(stdout || '').trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Object.assign(new Error('ADB did not allocate a JDWP port.'), { status: 502 });
  const record = {
    id: store.id('debug'),
    userId: user.id,
    organizationId: user.organizationId || null,
    serial,
    packageName,
    pid,
    host: process.env.DEBUG_FORWARD_HOST || '127.0.0.1',
    port,
    protocol: 'jdwp',
    status: 'ready',
    createdAt: store.now(),
    expiresAt: new Date(Date.now() + Math.max(5, Number(process.env.DEBUG_SESSION_TTL_MINUTES || 60)) * 60_000).toISOString(),
    closedAt: null
  };
  record.debuggerUrl = sessionUrl(record);
  await store.transact((state) => {
    state.debugSessions ||= [];
    state.debugSessions.push(record);
    return record;
  });
  return record;
}

async function list(user) {
  const state = await store.readState();
  return (state.debugSessions || []).filter((item) => user.role === 'admin' || item.userId === user.id);
}

async function close(user, id) {
  const state = await store.readState();
  const record = (state.debugSessions || []).find((item) => item.id === id && (user.role === 'admin' || item.userId === user.id));
  if (!record) throw Object.assign(new Error('Debug session not found.'), { status: 404 });
  if (record.status !== 'closed') await adb(record.serial, ['forward', '--remove', `tcp:${record.port}`]).catch(() => {});
  return store.transact((next) => {
    const current = (next.debugSessions || []).find((item) => item.id === record.id);
    current.status = 'closed';
    current.closedAt = store.now();
    return { ...current };
  });
}

async function cleanupExpired() {
  const state = await store.readState();
  const expired = (state.debugSessions || []).filter((item) => item.status !== 'closed' && Date.parse(item.expiresAt) <= Date.now());
  for (const item of expired) await close({ id: item.userId, role: 'admin' }, item.id).catch(() => {});
  return expired.length;
}

module.exports = { cleanupExpired, close, create, list };
