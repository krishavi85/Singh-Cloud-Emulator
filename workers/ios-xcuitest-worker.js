const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const os = require('node:os');
const { api, sleep } = require('./agent-http');

const execFileAsync = promisify(execFile);
const workerId = process.env.SCE_WORKER_ID || `ios-${os.hostname()}-${process.pid}`;
const pollMs = Math.max(1000, Number(process.env.SCE_POLL_MS || 3000));
const appiumBase = String(process.env.IOS_APPIUM_BASE_URL || 'http://127.0.0.1:4723').replace(/\/$/, '');
const publicHost = process.env.IOS_MJPEG_PUBLIC_HOST || os.hostname();
const firstMjpegPort = Math.max(1024, Number(process.env.IOS_MJPEG_PORT_START || 9100));

async function simctl(args, timeout = 300_000) {
  const { stdout } = await execFileAsync('xcrun', ['simctl', ...args], {
    timeout,
    maxBuffer: 20 * 1024 * 1024,
    encoding: 'utf8'
  });
  return stdout.trim();
}

function deviceType(profile) {
  if (profile?.id === 'ipad-pro-ios' || profile?.platform === 'ipados') {
    return process.env.IOS_IPAD_DEVICE_TYPE || 'com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M4-8GB';
  }
  return process.env.IOS_IPHONE_DEVICE_TYPE || 'com.apple.CoreSimulator.SimDeviceType.iPhone-16';
}

function runtime() {
  const value = process.env.IOS_RUNTIME;
  if (!value) throw new Error('IOS_RUNTIME must identify an installed CoreSimulator runtime.');
  return value;
}

function mjpegPort(sessionId) {
  let hash = 0;
  for (const character of sessionId) hash = (hash * 31 + character.charCodeAt(0)) % 800;
  return firstMjpegPort + hash;
}

async function appium(path, options = {}) {
  const response = await fetch(`${appiumBase}${path}`, {
    ...options,
    headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.value?.error) throw new Error(body.value?.message || body.message || `Appium failed (${response.status}).`);
  return body;
}

async function createAppiumSession(udid, port, session) {
  const capabilities = {
    platformName: 'iOS',
    'appium:automationName': 'XCUITest',
    'appium:udid': udid,
    'appium:deviceName': session.profile?.name || 'iOS Simulator',
    'appium:noReset': false,
    'appium:newCommandTimeout': 300,
    'appium:mjpegServerPort': port,
    'appium:wdaLocalPort': port + 1000,
    'appium:useNewWDA': true,
    'appium:shouldUseSingletonTestManager': false,
    'appium:reduceMotion': true
  };
  if (process.env.IOS_APP_PATH) capabilities['appium:app'] = process.env.IOS_APP_PATH;
  if (process.env.IOS_BUNDLE_ID) capabilities['appium:bundleId'] = process.env.IOS_BUNDLE_ID;
  const body = await appium('/session', {
    method: 'POST',
    body: JSON.stringify({ capabilities: { alwaysMatch: capabilities, firstMatch: [{}] } })
  });
  const id = body.value?.sessionId || body.sessionId;
  if (!id) throw new Error('Appium did not return an XCUITest session ID.');
  return { id, capabilities: body.value?.capabilities || {} };
}

async function cleanup(context) {
  if (context.appiumSessionId) await appium(`/session/${encodeURIComponent(context.appiumSessionId)}`, { method: 'DELETE' }).catch(() => {});
  if (context.udid) {
    await simctl(['shutdown', context.udid]).catch(() => {});
    await simctl(['delete', context.udid]).catch(() => {});
  }
}

async function serve(session) {
  const context = { udid: '', appiumSessionId: '' };
  const port = mjpegPort(session.id);
  try {
    context.udid = await simctl(['create', `Singh-${session.id.slice(0, 18)}`, deviceType(session.profile), runtime()]);
    await simctl(['boot', context.udid]);
    await simctl(['bootstatus', context.udid, '-b']);
    const appiumSession = await createAppiumSession(context.udid, port, session);
    context.appiumSessionId = appiumSession.id;
    const streamUrl = process.env.IOS_MJPEG_URL_TEMPLATE
      ? process.env.IOS_MJPEG_URL_TEMPLATE
        .replace(/\{host\}/g, encodeURIComponent(publicHost))
        .replace(/\{port\}/g, encodeURIComponent(String(port)))
        .replace(/\{sessionId\}/g, encodeURIComponent(session.id))
      : `http://${publicHost}:${port}`;

    const attached = await api(`/api/platform/workers/sessions/${encodeURIComponent(session.id)}/attach`, {
      method: 'POST',
      json: {
        workerId,
        serial: context.udid,
        transport: 'mjpeg',
        metadata: {
          platform: session.profile?.platform || 'ios',
          runtime: 'xcode-simulator',
          appiumSessionId: context.appiumSessionId,
          streamUrl,
          mjpegPort: port,
          capabilities: appiumSession.capabilities,
          host: os.hostname()
        }
      }
    });

    const expiresAt = Date.parse(attached.session.expiresAt);
    while (Date.now() < expiresAt) {
      await sleep(15_000);
      const heartbeat = await api(`/api/platform/workers/sessions/${encodeURIComponent(session.id)}/heartbeat`, {
        method: 'POST',
        json: {
          workerId,
          leaseSeconds: 300,
          metadata: { streamUrl, appiumSessionId: context.appiumSessionId, udid: context.udid, at: new Date().toISOString() }
        }
      });
      if (heartbeat.stopRequested || Date.parse(heartbeat.expiresAt) <= Date.now()) break;
      await appium(`/session/${encodeURIComponent(context.appiumSessionId)}/source`).catch((error) => {
        throw new Error(`XCUITest session became unhealthy: ${error.message}`);
      });
    }

    await api(`/api/platform/workers/sessions/${encodeURIComponent(session.id)}/finish`, {
      method: 'POST',
      json: { workerId, reason: 'ios-session-ended' }
    });
  } catch (error) {
    await api(`/api/platform/workers/sessions/${encodeURIComponent(session.id)}/finish`, {
      method: 'POST',
      json: { workerId, failed: true, reason: error.message.slice(0, 250) }
    }).catch(() => {});
    throw error;
  } finally {
    await cleanup(context);
  }
}

async function main() {
  for (;;) {
    try {
      const body = await api('/api/platform/workers/sessions/claim', {
        method: 'POST',
        json: {
          workerId,
          platform: 'ios',
          runtime: 'xcode-xcuitest',
          profiles: ['iphone-16-ios', 'ipad-pro-ios'],
          capacity: 1,
          leaseSeconds: 300,
          metadata: { host: os.hostname(), appiumBase }
        }
      });
      if (!body.session) {
        await sleep(pollMs);
        continue;
      }
      await serve(body.session);
    } catch (error) {
      console.error('iOS worker:', error.message);
      await sleep(pollMs);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
