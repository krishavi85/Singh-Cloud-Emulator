const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

function adbPath() {
  return process.env.ADB_PATH || 'adb';
}

function safeSerial(serial) {
  const value = String(serial || '');
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw Object.assign(new Error('Invalid Android serial.'), { status: 400 });
  return value;
}

function packageName(value) {
  const text = String(value || '');
  if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(text)) {
    throw Object.assign(new Error('Invalid Android package name.'), { status: 400 });
  }
  return text;
}

async function run(serial, args, options = {}) {
  return execFileAsync(adbPath(), ['-s', safeSerial(serial), ...args], {
    timeout: options.timeout || 30_000,
    maxBuffer: options.maxBuffer || 10 * 1024 * 1024,
    encoding: options.encoding || 'utf8',
    windowsHide: true
  });
}

async function logcat(serial, { lines = 500, level = 'V', tag = '*' } = {}) {
  const count = Math.min(5000, Math.max(1, Number(lines || 500)));
  const validLevel = ['V', 'D', 'I', 'W', 'E', 'F', 'S'].includes(level) ? level : 'V';
  const validTag = /^[A-Za-z0-9_.:-]{1,100}$/.test(tag) ? tag : '*';
  const { stdout } = await run(serial, ['logcat', '-d', '-t', String(count), `${validTag}:${validLevel}`], { timeout: 45_000, maxBuffer: 30 * 1024 * 1024 });
  return stdout;
}

async function clearLogcat(serial) {
  await run(serial, ['logcat', '-c']);
}

async function packageDiagnostics(serial, packageValue) {
  const pkg = packageName(packageValue);
  const [packageResult, memoryResult, activityResult] = await Promise.all([
    run(serial, ['shell', 'dumpsys', 'package', pkg], { maxBuffer: 20 * 1024 * 1024 }),
    run(serial, ['shell', 'dumpsys', 'meminfo', pkg], { maxBuffer: 10 * 1024 * 1024 }).catch(() => ({ stdout: '' })),
    run(serial, ['shell', 'dumpsys', 'activity', 'processes'], { maxBuffer: 10 * 1024 * 1024 }).catch(() => ({ stdout: '' }))
  ]);
  return { package: packageResult.stdout, memory: memoryResult.stdout, activity: activityResult.stdout };
}

async function networkDiagnostics(serial) {
  const [connectivity, wifi, netstats] = await Promise.all([
    run(serial, ['shell', 'dumpsys', 'connectivity'], { maxBuffer: 15 * 1024 * 1024 }),
    run(serial, ['shell', 'dumpsys', 'wifi'], { maxBuffer: 15 * 1024 * 1024 }),
    run(serial, ['shell', 'dumpsys', 'netstats'], { maxBuffer: 20 * 1024 * 1024 })
  ]);
  return { connectivity: connectivity.stdout, wifi: wifi.stdout, netstats: netstats.stdout };
}

async function openDeepLink(serial, url, pkg = '') {
  const value = String(url || '');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.length > 2048) {
    throw Object.assign(new Error('Invalid deep link URL.'), { status: 400 });
  }
  const args = ['shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', value];
  if (pkg) args.push(packageName(pkg));
  const { stdout, stderr } = await run(serial, args);
  return `${stdout || ''}${stderr || ''}`.trim();
}

async function setLocation(serial, latitude, longitude, altitude = 0) {
  const lat = Number(latitude);
  const lon = Number(longitude);
  const alt = Number(altitude || 0);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180 || !Number.isFinite(alt)) {
    throw Object.assign(new Error('Invalid coordinates.'), { status: 400 });
  }
  await run(serial, ['emu', 'geo', 'fix', String(lon), String(lat), String(alt)]);
}

async function setLocale(serial, locale) {
  const value = String(locale || '').replace('_', '-');
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z]{2}|-[A-Za-z]{4})?$/.test(value)) {
    throw Object.assign(new Error('Invalid locale.'), { status: 400 });
  }
  await run(serial, ['shell', 'settings', 'put', 'system', 'system_locales', value]);
  await run(serial, ['shell', 'am', 'broadcast', '-a', 'android.intent.action.LOCALE_CHANGED']).catch(() => {});
}

async function setDarkMode(serial, enabled) {
  await run(serial, ['shell', 'cmd', 'uimode', 'night', enabled ? 'yes' : 'no']);
}

async function setFontScale(serial, scale) {
  const value = Number(scale);
  if (!Number.isFinite(value) || value < 0.5 || value > 2.0) throw Object.assign(new Error('Font scale must be between 0.5 and 2.0.'), { status: 400 });
  await run(serial, ['shell', 'settings', 'put', 'system', 'font_scale', String(value)]);
}

async function setBattery(serial, options = {}) {
  if (options.reset) {
    await run(serial, ['shell', 'dumpsys', 'battery', 'reset']);
    return;
  }
  if (options.level !== undefined) {
    const level = Math.round(Number(options.level));
    if (!Number.isFinite(level) || level < 0 || level > 100) throw Object.assign(new Error('Battery level must be 0–100.'), { status: 400 });
    await run(serial, ['shell', 'dumpsys', 'battery', 'set', 'level', String(level)]);
  }
  if (options.status !== undefined) {
    const statusMap = { unknown: 1, charging: 2, discharging: 3, not_charging: 4, full: 5 };
    const status = statusMap[String(options.status)];
    if (!status) throw Object.assign(new Error('Invalid battery status.'), { status: 400 });
    await run(serial, ['shell', 'dumpsys', 'battery', 'set', 'status', String(status)]);
  }
  for (const source of ['ac', 'usb', 'wireless']) {
    if (options[source] !== undefined) await run(serial, ['shell', 'dumpsys', 'battery', 'set', source, options[source] ? '1' : '0']);
  }
}

async function setConnectivity(serial, { wifi, mobileData, airplaneMode } = {}) {
  if (wifi !== undefined) await run(serial, ['shell', 'svc', 'wifi', wifi ? 'enable' : 'disable']);
  if (mobileData !== undefined) await run(serial, ['shell', 'svc', 'data', mobileData ? 'enable' : 'disable']);
  if (airplaneMode !== undefined) {
    await run(serial, ['shell', 'settings', 'put', 'global', 'airplane_mode_on', airplaneMode ? '1' : '0']);
    await run(serial, ['shell', 'am', 'broadcast', '-a', 'android.intent.action.AIRPLANE_MODE', '--ez', 'state', airplaneMode ? 'true' : 'false']);
  }
}

async function simulateBiometric(serial, fingerId = 1) {
  const id = Math.round(Number(fingerId));
  if (!Number.isFinite(id) || id < 1 || id > 10) throw Object.assign(new Error('Finger ID must be 1–10.'), { status: 400 });
  await run(serial, ['emu', 'finger', 'touch', String(id)]);
}

async function setPermission(serial, packageValue, permission, grant) {
  const pkg = packageName(packageValue);
  const value = String(permission || '');
  if (!/^android\.permission\.[A-Z0-9_]+$/.test(value)) throw Object.assign(new Error('Invalid Android permission.'), { status: 400 });
  await run(serial, ['shell', 'pm', grant ? 'grant' : 'revoke', pkg, value]);
}

async function setAppOps(serial, packageValue, operation, mode) {
  const pkg = packageName(packageValue);
  const op = String(operation || '');
  const validModes = new Set(['allow', 'ignore', 'deny', 'default', 'foreground']);
  if (!/^[A-Z0-9_]{2,80}$/.test(op) || !validModes.has(mode)) throw Object.assign(new Error('Invalid app operation or mode.'), { status: 400 });
  await run(serial, ['shell', 'appops', 'set', pkg, op, mode]);
}

module.exports = {
  clearLogcat,
  logcat,
  networkDiagnostics,
  openDeepLink,
  packageDiagnostics,
  setAppOps,
  setBattery,
  setConnectivity,
  setDarkMode,
  setFontScale,
  setLocale,
  setLocation,
  setPermission,
  simulateBiometric
};
