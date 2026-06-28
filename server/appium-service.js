const store = require('./platform-store');

function baseUrl() {
  const value = process.env.APPIUM_BASE_URL;
  if (!value) throw Object.assign(new Error('APPIUM_BASE_URL is not configured.'), { status: 503 });
  return value.replace(/\/$/, '');
}

async function call(path, options = {}) {
  const response = await fetch(`${baseUrl()}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.value?.error) {
    const message = body.value?.message || body.message || `Appium request failed (${response.status}).`;
    throw Object.assign(new Error(message), { status: response.status >= 400 && response.status < 500 ? response.status : 502 });
  }
  return body;
}

function safeCapabilities(serial, input = {}) {
  const capabilities = {
    platformName: 'Android',
    'appium:automationName': 'UiAutomator2',
    'appium:udid': serial,
    'appium:newCommandTimeout': Math.min(3600, Math.max(30, Number(input.newCommandTimeout || 300))),
    'appium:noReset': input.noReset === true,
    'appium:autoGrantPermissions': input.autoGrantPermissions !== false,
    'appium:disableWindowAnimation': input.disableWindowAnimation !== false
  };
  if (input.appPackage) capabilities['appium:appPackage'] = String(input.appPackage).slice(0, 200);
  if (input.appActivity) capabilities['appium:appActivity'] = String(input.appActivity).slice(0, 300);
  if (input.browserName) capabilities.browserName = String(input.browserName).slice(0, 80);
  if (input.language) capabilities['appium:language'] = String(input.language).slice(0, 12);
  if (input.locale) capabilities['appium:locale'] = String(input.locale).slice(0, 12);
  return capabilities;
}

async function createSession(user, serial, input = {}) {
  const body = await call('/session', {
    method: 'POST',
    body: JSON.stringify({ capabilities: { alwaysMatch: safeCapabilities(serial, input), firstMatch: [{}] } })
  });
  const externalId = body.value?.sessionId || body.sessionId;
  if (!externalId) throw Object.assign(new Error('Appium did not return a session ID.'), { status: 502 });
  const record = {
    id: store.id('appium'),
    externalId,
    userId: user.id,
    serial,
    status: 'running',
    createdAt: store.now(),
    endedAt: null,
    capabilities: body.value?.capabilities || {}
  };
  await store.transact((state) => {
    state.appiumSessions ||= [];
    state.appiumSessions.push(record);
    return record;
  });
  return record;
}

async function ownedSession(user, id) {
  const state = await store.readState();
  const record = (state.appiumSessions || []).find((item) => item.id === id && (user.role === 'admin' || item.userId === user.id));
  if (!record) throw Object.assign(new Error('Appium session not found.'), { status: 404 });
  return record;
}

async function closeSession(user, id) {
  const record = await ownedSession(user, id);
  if (record.status === 'running') await call(`/session/${encodeURIComponent(record.externalId)}`, { method: 'DELETE' });
  return store.transact((state) => {
    const current = (state.appiumSessions || []).find((item) => item.id === record.id);
    current.status = 'stopped';
    current.endedAt = store.now();
    return current;
  });
}

async function source(user, id) {
  const record = await ownedSession(user, id);
  return call(`/session/${encodeURIComponent(record.externalId)}/source`);
}

async function screenshot(user, id) {
  const record = await ownedSession(user, id);
  return call(`/session/${encodeURIComponent(record.externalId)}/screenshot`);
}

module.exports = { closeSession, createSession, screenshot, source };
