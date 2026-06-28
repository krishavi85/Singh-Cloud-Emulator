const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const execFileAsync = promisify(execFile);
const root = path.resolve(process.env.PROFILE_ARTIFACT_DIR || path.join(__dirname, '..', 'data', 'profiles'));

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
    throw Object.assign(new Error('Invalid package name.'), { status: 400 });
  }
  return packageName;
}

async function adb(serial, args, options = {}) {
  return execFileAsync(adbPath(), ['-s', safeSerial(serial), ...args], {
    timeout: options.timeout || 120_000,
    maxBuffer: options.maxBuffer || 30 * 1024 * 1024,
    encoding: options.encoding || 'utf8',
    windowsHide: true
  });
}

async function userDir(userId) {
  const directory = path.join(root, String(userId).replace(/[^A-Za-z0-9_-]/g, '_'));
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}

async function collectPerfetto(userId, serial, durationSeconds = 10) {
  const duration = Math.min(120, Math.max(1, Math.round(Number(durationSeconds || 10))));
  const id = `perfetto-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const remote = `/data/misc/perfetto-traces/${id}.perfetto-trace`;
  const directory = await userDir(userId);
  const local = path.join(directory, `${id}.perfetto-trace`);

  await adb(serial, [
    'shell', 'perfetto', '-o', remote, '-t', `${duration}s`, '-b', '32mb',
    'sched', 'freq', 'idle', 'am', 'wm', 'gfx', 'view', 'binder_driver', 'hal', 'dalvik', 'input', 'res', 'memory'
  ], { timeout: (duration + 30) * 1000 });
  await adb(serial, ['pull', remote, local], { timeout: 120_000 });
  await adb(serial, ['shell', 'rm', '-f', remote]).catch(() => {});
  const stat = await fs.stat(local);
  return { id, type: 'perfetto', filename: path.basename(local), sizeBytes: stat.size, createdAt: new Date().toISOString() };
}

async function collectHeapDump(userId, serial, packageValue) {
  const packageName = safePackage(packageValue);
  const id = `heap-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const remote = `/data/local/tmp/${id}.hprof`;
  const directory = await userDir(userId);
  const local = path.join(directory, `${id}.hprof`);

  await adb(serial, ['shell', 'am', 'dumpheap', packageName, remote], { timeout: 120_000 });
  await new Promise((resolve) => setTimeout(resolve, 2000));
  await adb(serial, ['pull', remote, local], { timeout: 120_000 });
  await adb(serial, ['shell', 'rm', '-f', remote]).catch(() => {});
  const stat = await fs.stat(local);
  return { id, type: 'heap', packageName, filename: path.basename(local), sizeBytes: stat.size, createdAt: new Date().toISOString() };
}

async function dumpUiHierarchy(serial) {
  const remote = '/data/local/tmp/sce-window.xml';
  await adb(serial, ['shell', 'uiautomator', 'dump', remote], { timeout: 30_000 });
  const { stdout } = await adb(serial, ['exec-out', 'cat', remote], { timeout: 30_000, maxBuffer: 20 * 1024 * 1024 });
  await adb(serial, ['shell', 'rm', '-f', remote]).catch(() => {});
  return stdout;
}

async function readArtifact(userId, filename) {
  const safe = path.basename(String(filename || ''));
  if (!/^[A-Za-z0-9_.-]{1,200}$/.test(safe)) throw Object.assign(new Error('Invalid artifact name.'), { status: 400 });
  const directory = await userDir(userId);
  const target = path.join(directory, safe);
  return fs.readFile(target);
}

module.exports = { collectHeapDump, collectPerfetto, dumpUiHierarchy, readArtifact };
