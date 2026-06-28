const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

function adbPath() {
  return process.env.ADB_PATH || 'adb';
}

function serialArgs(serial) {
  return serial ? ['-s', serial] : [];
}

async function runAdb(args, options = {}) {
  const serial = options.serial || process.env.ANDROID_SERIAL || '';
  const timeout = options.timeout ?? 30_000;
  const maxBuffer = options.maxBuffer ?? 20 * 1024 * 1024;

  return execFileAsync(adbPath(), [...serialArgs(serial), ...args], {
    timeout,
    maxBuffer,
    encoding: options.encoding ?? 'utf8',
    windowsHide: true
  });
}

async function listDevices() {
  const { stdout } = await runAdb(['devices', '-l'], { serial: '' });
  return stdout
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [serial, state, ...details] = line.split(/\s+/);
      const metadata = Object.fromEntries(
        details
          .filter((item) => item.includes(':'))
          .map((item) => {
            const index = item.indexOf(':');
            return [item.slice(0, index), item.slice(index + 1)];
          })
      );
      return { serial, state, metadata };
    });
}

async function getDeviceSize(serial) {
  const { stdout } = await runAdb(['shell', 'wm', 'size'], { serial });
  const match = stdout.match(/(?:Physical size|Override size):\s*(\d+)x(\d+)/i);
  if (!match) throw new Error('Unable to determine Android display size.');
  return { width: Number(match[1]), height: Number(match[2]) };
}

async function screenshot(serial) {
  const { stdout } = await runAdb(['exec-out', 'screencap', '-p'], {
    serial,
    encoding: 'buffer',
    timeout: 15_000,
    maxBuffer: 40 * 1024 * 1024
  });
  return stdout;
}

async function tap(serial, x, y) {
  return runAdb(['shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))], { serial });
}

async function swipe(serial, x1, y1, x2, y2, duration = 300) {
  return runAdb([
    'shell', 'input', 'swipe',
    String(Math.round(x1)), String(Math.round(y1)),
    String(Math.round(x2)), String(Math.round(y2)),
    String(Math.max(50, Math.round(duration)))
  ], { serial });
}

async function text(serial, value) {
  const encoded = String(value)
    .replace(/%/g, '%25')
    .replace(/\s/g, '%s')
    .replace(/'/g, "\\'")
    .replace(/&/g, '\\&')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
  return runAdb(['shell', 'input', 'text', encoded], { serial });
}

async function keyevent(serial, key) {
  return runAdb(['shell', 'input', 'keyevent', String(key)], { serial });
}

async function rotate(serial, orientation) {
  const value = Number(orientation);
  if (![0, 1, 2, 3].includes(value)) throw new Error('Orientation must be 0, 1, 2, or 3.');
  await runAdb(['shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0'], { serial });
  return runAdb(['shell', 'settings', 'put', 'system', 'user_rotation', String(value)], { serial });
}

async function installApk(serial, filePath) {
  return runAdb(['install', '-r', '-t', filePath], {
    serial,
    timeout: 5 * 60_000,
    maxBuffer: 50 * 1024 * 1024
  });
}

async function getForegroundPackage(serial) {
  const { stdout } = await runAdb(['shell', 'dumpsys', 'window', 'windows'], { serial, timeout: 20_000 });
  const match = stdout.match(/mCurrentFocus=.*?\s([\w.]+)\//) || stdout.match(/mFocusedApp=.*?\s([\w.]+)\//);
  return match ? match[1] : null;
}

async function launchPackage(serial, packageName) {
  if (!/^[A-Za-z0-9_.]+$/.test(packageName)) throw new Error('Invalid package name.');
  return runAdb(['shell', 'monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1'], {
    serial,
    timeout: 30_000
  });
}

module.exports = {
  getDeviceSize,
  getForegroundPackage,
  installApk,
  keyevent,
  launchPackage,
  listDevices,
  rotate,
  screenshot,
  swipe,
  tap,
  text
};
