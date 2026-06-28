const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const port = 18080 + (process.pid % 1000);
const origin = `http://127.0.0.1:${port}`;
const tempRoot = path.join(os.tmpdir(), `sce-smoke-${process.pid}`);
const users = [{
  id: 'smoke-admin',
  email: 'smoke@example.com',
  passwordHash: '$2y$12$M31gquiczBUNb.qQ5sKBe.lA/03dHQDP9mhyDtalFg9TpvLKcONQa',
  role: 'admin',
  devices: ['emulator-5554']
}];

let output = '';
let child;

function fail(message) {
  throw new Error(`${message}\n--- server output ---\n${output.slice(-12000)}`);
}

async function request(urlPath, options = {}) {
  const response = await fetch(`${origin}${urlPath}`, options);
  return response;
}

async function json(urlPath, options = {}, expected = [200]) {
  const response = await request(urlPath, options);
  const body = await response.json().catch(() => ({}));
  if (!expected.includes(response.status)) fail(`${options.method || 'GET'} ${urlPath} returned ${response.status}: ${JSON.stringify(body)}`);
  return { response, body };
}

async function waitForServer() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) fail(`Server exited early with code ${child.exitCode}.`);
    try {
      const response = await request('/api/health');
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  fail('Server did not become healthy within 30 seconds.');
}

async function main() {
  await fs.mkdir(tempRoot, { recursive: true });
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    HOST: '127.0.0.1',
    PORT: String(port),
    TRUST_PROXY: '0',
    PUBLIC_ORIGIN: origin,
    REQUIRE_HTTPS: 'false',
    COOKIE_SECURE: 'false',
    JWT_SECRET: 'smoke-test-session-secret-with-at-least-32-characters',
    AUDIT_HMAC_KEY: 'smoke-test-audit-secret-with-at-least-32-characters',
    USERS_JSON: JSON.stringify(users),
    CLAMAV_REQUIRED: 'false',
    CLAMAV_HOST: '127.0.0.1',
    CLAMAV_PORT: '39999',
    PLATFORM_DATA_FILE: path.join(tempRoot, 'platform.json'),
    WORKSPACE_ROOT: path.join(tempRoot, 'workspaces'),
    ARTIFACT_LOCAL_DIR: path.join(tempRoot, 'artifacts'),
    UPLOAD_DIR: path.join(tempRoot, 'uploads'),
    AUDIT_LOG_DIR: path.join(tempRoot, 'audit'),
    PROFILE_ARTIFACT_DIR: path.join(tempRoot, 'profiles'),
    SCHEDULER_SWEEP_MS: '60000'
  };
  delete env.DATABASE_URL;
  delete env.REDIS_URL;
  delete env.S3_ENDPOINT;
  delete env.AUTH_USERS_FILE;

  child = spawn(process.execPath, ['server/index.js'], {
    cwd: path.resolve(__dirname, '..'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });

  try {
    await waitForServer();

    for (const page of ['/', '/workbench.html', '/equivalence.html', '/operations.html']) {
      const response = await request(page);
      if (!response.ok) fail(`${page} did not load (${response.status}).`);
      const text = await response.text();
      if (!text.toLowerCase().includes('<!doctype html>')) fail(`${page} did not return an HTML document.`);
    }

    const login = await json('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ email: 'smoke@example.com', password: 'change-this-local-password' })
    });
    const setCookie = login.response.headers.get('set-cookie') || '';
    const cookie = setCookie.split(';')[0];
    if (!cookie.includes('sce_session=')) fail('Login did not return the session cookie.');
    const headers = { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' };

    const me = await json('/api/auth/me', { headers: { Cookie: cookie } });
    if (me.body.user?.email !== 'smoke@example.com') fail('Authenticated identity did not match the login user.');

    const profiles = await json('/api/platform/profiles', { headers: { Cookie: cookie } });
    const profile = profiles.body.profiles?.find((item) => item.id === 'pixel-8-api-35');
    if (!profile) fail('Default Android profile is missing.');

    const workspace = await json('/api/platform/workspaces', {
      method: 'POST', headers, body: JSON.stringify({ name: 'Smoke Project' })
    }, [201]);
    const workspaceId = workspace.body.workspace?.id;
    if (!workspaceId) fail('Workspace creation did not return an ID.');

    const files = await json(`/api/platform/workspaces/${encodeURIComponent(workspaceId)}/files`, { headers: { Cookie: cookie } });
    if (!files.body.files?.includes('app/src/main/AndroidManifest.xml')) fail('Workspace starter files were not created.');

    const session = await json('/api/platform/sessions', {
      method: 'POST', headers, body: JSON.stringify({ profileId: profile.id, durationMinutes: 5 })
    }, [201]);
    const sessionId = session.body.session?.id;
    if (!sessionId || session.body.session.status !== 'queued') fail('Cloud session was not queued correctly.');

    await json(`/api/platform/sessions/${encodeURIComponent(sessionId)}/stop`, {
      method: 'POST', headers, body: '{}'
    });

    const build = await json('/api/platform/builds', {
      method: 'POST', headers, body: JSON.stringify({ workspaceId, format: 'apk', variant: 'debug' })
    }, [202]);
    const buildId = build.body.build?.id;
    if (!buildId) fail('Build queue did not return an ID.');

    await json(`/api/platform/builds/${encodeURIComponent(buildId)}/cancel`, {
      method: 'POST', headers, body: '{}'
    });

    const capabilities = await json('/api/platform/capabilities', { headers: { Cookie: cookie } });
    if (!capabilities.body.capabilities) fail('Capabilities endpoint returned no capability data.');

    await json('/api/auth/logout', { method: 'POST', headers, body: '{}' });
    console.log('Application smoke test passed: startup, pages, authentication, workspaces, sessions and builds are functional.');
  } finally {
    if (child && child.exitCode === null) child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (child && child.exitCode === null) child.kill('SIGKILL');
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
