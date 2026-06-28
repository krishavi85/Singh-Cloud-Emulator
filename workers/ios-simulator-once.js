const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { api, required, sleep } = require('./agent-http');

const execFileAsync = promisify(execFile);
const sessionId = required('SCE_SESSION_ID');
const deviceType = required('IOS_DEVICE_TYPE');
const runtime = required('IOS_RUNTIME');
const workerId = process.env.SCE_WORKER_ID || `ios-${process.pid}`;
let udid = '';

async function simctl(args, timeout = 120000) {
  const { stdout } = await execFileAsync('xcrun', ['simctl', ...args], {
    timeout,
    maxBuffer: 20 * 1024 * 1024,
    encoding: 'utf8'
  });
  return stdout.trim();
}

async function cleanup() {
  if (!udid) return;
  await simctl(['shutdown', udid]).catch(() => {});
  await simctl(['delete', udid]).catch(() => {});
}

async function main() {
  const name = `Singh-${sessionId.slice(0, 20)}`;
  udid = await simctl(['create', name, deviceType, runtime]);
  await simctl(['boot', udid]);
  await simctl(['bootstatus', udid, '-b'], 300000);

  const attached = await api(`/api/platform/workers/sessions/${encodeURIComponent(sessionId)}/attach`, {
    method: 'POST',
    body: JSON.stringify({
      serial: udid,
      workerId,
      transport: 'webrtc',
      metadata: { platform: 'ios', deviceType, runtime, udid }
    })
  });

  const expiresAt = Date.parse(attached.session.expiresAt);
  while (Date.now() < expiresAt) {
    await sleep(15000);
    const heartbeat = await api(`/api/platform/workers/sessions/${encodeURIComponent(sessionId)}/heartbeat`, {
      method: 'POST',
      body: JSON.stringify({ metadata: { platform: 'ios', udid, workerId, at: new Date().toISOString() } })
    });
    if (Date.parse(heartbeat.expiresAt) <= Date.now()) break;
  }

  await api(`/api/platform/workers/sessions/${encodeURIComponent(sessionId)}/finish`, {
    method: 'POST',
    body: JSON.stringify({ reason: 'ios-session-expired' })
  });
}

main()
  .catch(async (error) => {
    console.error(error);
    if (udid) {
      await api(`/api/platform/workers/sessions/${encodeURIComponent(sessionId)}/finish`, {
        method: 'POST',
        body: JSON.stringify({ failed: true, reason: error.message.slice(0, 250) })
      }).catch(() => {});
    }
    process.exitCode = 1;
  })
  .finally(cleanup);
