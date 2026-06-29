const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { api, sleep, upload } = require('./agent-http');
const { startTrafficProcess } = require('./traffic-process');

const execFileAsync = promisify(execFile);
const workerId = process.env.SCE_WORKER_ID || `traffic-${os.hostname()}-${process.pid}`;
const pollMs = Math.max(1000, Number(process.env.SCE_POLL_MS || 3000));
const root = path.resolve(process.env.CAPTURE_WORK_ROOT || path.join(os.tmpdir(), 'singh-captures'));
const publicHost = process.env.CAPTURE_PROXY_PUBLIC_HOST || os.hostname();
const firstPort = Math.max(1024, Number(process.env.CAPTURE_PROXY_PORT_START || 18080));

function portFor(id) {
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) % 1000;
  return firstPort + hash;
}

async function adb(serial, args) {
  const value = String(serial || '');
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(value)) throw new Error('Invalid Android serial.');
  return execFileAsync(process.env.ADB_PATH || 'adb', ['-s', value, ...args], {
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true
  });
}

async function setProxy(serial, value) {
  await adb(serial, ['shell', 'settings', 'put', 'global', 'http_proxy', value]);
}

async function serve(capture) {
  const directory = await fsp.mkdtemp(path.join(root, `${capture.id}-`));
  const harPath = path.join(directory, 'capture.har');
  const processHandle = startTrafficProcess({
    executable: process.env.MITMDUMP_PATH || 'mitmdump',
    directory,
    port: portFor(capture.id),
    harPath,
    flowPath: path.join(directory, 'capture.mitm'),
    logPath: path.join(directory, 'traffic.log')
  });
  const proxy = `${publicHost}:${portFor(capture.id)}`;
  let failure = null;

  try {
    const early = await Promise.race([
      new Promise((resolve) => processHandle.child.once('exit', (code) => resolve(code))),
      sleep(3000).then(() => null)
    ]);
    if (early !== null) throw new Error(`Traffic observer exited before startup with code ${early}.`);
    await setProxy(capture.serial, proxy);
    await api(`/api/platform/workers/captures/${encodeURIComponent(capture.id)}/attach`, {
      method: 'POST',
      json: { workerId, proxy, webUrl: null }
    });

    for (;;) {
      await sleep(10_000);
      if (processHandle.child.exitCode !== null) throw new Error(`Traffic observer exited with code ${processHandle.child.exitCode}.`);
      const heartbeat = await api(`/api/platform/workers/captures/${encodeURIComponent(capture.id)}/heartbeat`, {
        method: 'POST',
        json: { workerId, leaseSeconds: 300 }
      });
      if (heartbeat.stopRequested) break;
    }
  } catch (error) {
    failure = error;
  } finally {
    await setProxy(capture.serial, ':0').catch(() => {});
    await processHandle.stop().catch(() => {});
    processHandle.closeLog();
  }

  try {
    const stat = await fsp.stat(harPath);
    if (stat.size > 0) {
      await upload(`/api/platform/workers/captures/${encodeURIComponent(capture.id)}/har`, harPath, 'application/json', { 'X-Worker-ID': workerId });
    }
  } catch (error) {
    if (!failure) failure = error;
  }

  await api(`/api/platform/workers/captures/${encodeURIComponent(capture.id)}/finish`, {
    method: 'POST',
    json: { workerId, failed: Boolean(failure), error: failure?.message || null }
  }).catch(() => {});
  await fsp.rm(directory, { recursive: true, force: true });
  if (failure) throw failure;
}

async function main() {
  await fsp.mkdir(root, { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      const body = await api('/api/platform/workers/captures/claim', {
        method: 'POST',
        json: { workerId, leaseSeconds: 300 }
      });
      if (!body.capture) {
        await sleep(pollMs);
        continue;
      }
      await serve(body.capture);
    } catch (error) {
      console.error('Traffic observer:', error.message);
      await sleep(pollMs);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
