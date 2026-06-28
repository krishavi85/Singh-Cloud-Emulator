const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { api, sleep } = require('./agent-http');

const execFileAsync = promisify(execFile);
const workerId = process.env.SCE_WORKER_ID || `cuttlefish-${os.hostname()}-${process.pid}`;
const pollMs = Math.max(1000, Number(process.env.SCE_POLL_MS || 3000));
const launchPath = process.env.CUTTLEFISH_LAUNCHER || 'launch_cvd';
const stopPath = process.env.CUTTLEFISH_STOPPER || 'stop_cvd';
const workRoot = path.resolve(process.env.CUTTLEFISH_WORK_ROOT || path.join(os.tmpdir(), 'singh-cuttlefish'));
const webrtcHost = process.env.CUTTLEFISH_PUBLIC_HOST || os.hostname();
const webrtcPort = Number(process.env.CUTTLEFISH_WEBRTC_PORT || 8443);

function instanceNumber(sessionId) {
  let value = 0;
  for (const character of sessionId) value = (value * 31 + character.charCodeAt(0)) % 90;
  return value + 1;
}

async function adbDevices() {
  const adb = process.env.ADB_PATH || 'adb';
  const { stdout } = await execFileAsync(adb, ['devices'], { timeout: 15_000, windowsHide: true });
  return new Set(stdout.split(/\r?\n/).slice(1).filter((line) => /\tdevice$/.test(line)).map((line) => line.split(/\s+/)[0]));
}

async function discoverNewSerial(before, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const after = await adbDevices().catch(() => new Set());
    for (const serial of after) if (!before.has(serial)) return serial;
    await sleep(2000);
  }
  const configured = process.env.CUTTLEFISH_ANDROID_SERIAL;
  if (configured) return configured;
  throw new Error('Cuttlefish started but no new ADB serial appeared.');
}

async function launch(session) {
  const number = instanceNumber(session.id);
  const home = path.join(workRoot, session.id);
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  const before = await adbDevices().catch(() => new Set());
  const extra = String(process.env.CUTTLEFISH_EXTRA_ARGS || '').split(/\s+/).filter(Boolean);
  const args = [
    '--daemon=true',
    '--start_webrtc=true',
    `--instance_num=${number}`,
    '--report_anonymous_usage_stats=n',
    ...extra
  ];
  const logPath = path.join(home, 'launcher.log');
  const logHandle = await fs.open(logPath, 'a', 0o600);
  const child = spawn(launchPath, args, {
    cwd: home,
    env: { ...process.env, HOME: home, CUTTLEFISH_INSTANCE: String(number) },
    stdio: ['ignore', logHandle.fd, logHandle.fd],
    windowsHide: true,
    detached: false
  });
  const exit = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  const early = await Promise.race([exit, sleep(10_000).then(() => null)]);
  await logHandle.close();
  if (early && early.code !== 0) throw new Error(`launch_cvd exited with code ${early.code}${early.signal ? ` (${early.signal})` : ''}.`);
  const serial = await discoverNewSerial(before);
  const streamUrl = process.env.CUTTLEFISH_SESSION_URL_TEMPLATE
    ? process.env.CUTTLEFISH_SESSION_URL_TEMPLATE
      .replace(/\{sessionId\}/g, encodeURIComponent(session.id))
      .replace(/\{workerId\}/g, encodeURIComponent(workerId))
      .replace(/\{instance\}/g, encodeURIComponent(String(number)))
      .replace(/\{serial\}/g, encodeURIComponent(serial))
    : `https://${webrtcHost}:${webrtcPort}`;
  return { number, home, serial, streamUrl, logPath };
}

async function stop(instance) {
  try {
    await execFileAsync(stopPath, [], {
      cwd: instance.home,
      env: { ...process.env, HOME: instance.home, CUTTLEFISH_INSTANCE: String(instance.number) },
      timeout: 120_000,
      windowsHide: true
    });
  } catch (error) {
    console.error('stop_cvd failed:', error.message);
  }
  await fs.rm(instance.home, { recursive: true, force: true });
}

async function serve(session) {
  const instance = await launch(session);
  try {
    const attached = await api(`/api/platform/workers/sessions/${encodeURIComponent(session.id)}/attach`, {
      method: 'POST',
      json: {
        serial: instance.serial,
        workerId,
        transport: 'webrtc',
        metadata: {
          platform: 'android',
          runtime: 'cuttlefish',
          instanceNumber: instance.number,
          streamUrl: instance.streamUrl,
          host: os.hostname()
        }
      }
    });
    const expiresAt = Date.parse(attached.session.expiresAt);
    while (Date.now() < expiresAt) {
      await sleep(15_000);
      const heartbeat = await api(`/api/platform/workers/sessions/${encodeURIComponent(session.id)}/heartbeat`, {
        method: 'POST',
        json: { workerId, metadata: { streamUrl: instance.streamUrl, serial: instance.serial, at: new Date().toISOString() } }
      });
      if (heartbeat.stopRequested || Date.parse(heartbeat.expiresAt) <= Date.now()) break;
    }
    await api(`/api/platform/workers/sessions/${encodeURIComponent(session.id)}/finish`, {
      method: 'POST',
      json: { workerId, reason: 'session-ended' }
    });
  } catch (error) {
    await api(`/api/platform/workers/sessions/${encodeURIComponent(session.id)}/finish`, {
      method: 'POST',
      json: { workerId, failed: true, reason: error.message.slice(0, 250) }
    }).catch(() => {});
    throw error;
  } finally {
    await stop(instance);
  }
}

async function main() {
  await fs.mkdir(workRoot, { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      const body = await api('/api/platform/workers/sessions/claim', {
        method: 'POST',
        json: { workerId, platform: 'android', runtime: 'cuttlefish', capacity: 1, leaseSeconds: 300 }
      });
      if (!body.session) {
        await sleep(pollMs);
        continue;
      }
      await serve(body.session);
    } catch (error) {
      console.error('Cuttlefish worker:', error.message);
      await sleep(pollMs);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
