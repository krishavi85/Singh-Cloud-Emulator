const nav = document.querySelector('#workbenchNav');
const root = document.querySelector('#workbenchContent');
const toast = document.querySelector('#toast');

const sections = [
  ['overview', 'Overview'], ['sessions', 'Sessions'], ['devices', 'Device Lab'],
  ['automation', 'Automation'], ['diagnostics', 'Diagnostics'], ['workspaces', 'Code Workspaces'],
  ['builds', 'Builds & Artifacts'], ['shares', 'Shares'], ['admin', 'Administration']
];

const state = { active: 'overview', capabilities: {}, profiles: [], sessions: [], recordings: [], workspaces: [], builds: [], artifacts: [], shares: [], usage: {}, admin: null };
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json', ...(options.headers || {}) } : options.headers
  });
  const type = response.headers.get('content-type') || '';
  const body = type.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(body.error || body || `Request failed (${response.status})`);
  return body;
}

function notify(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => { toast.hidden = true; }, 3500);
}

function metric(label, value) {
  return `<div class="metric"><span class="muted">${esc(label)}</span><strong>${esc(value)}</strong></div>`;
}

function item(title, status, actions = '') {
  return `<article class="item-card"><header><strong>${esc(title)}</strong><span class="badge">${esc(status || '')}</span></header><div class="item-actions">${actions}</div></article>`;
}

function button(action, label, data = {}) {
  const attrs = Object.entries(data).map(([key, value]) => `data-${key}="${esc(value)}"`).join(' ');
  return `<button data-action="${action}" ${attrs}>${esc(label)}</button>`;
}

function currentSerial() {
  return prompt('Android serial', state.sessions.find((entry) => entry.status === 'running')?.serial || 'emulator-5554');
}

function render() {
  nav.innerHTML = sections.map(([id, label]) => `<button data-section="${id}" class="${state.active === id ? 'active' : ''}">${label}</button>`).join('');
  const body = {
    overview: renderOverview(), sessions: renderSessions(), devices: renderDevices(), automation: renderAutomation(),
    diagnostics: renderDiagnostics(), workspaces: renderWorkspaces(), builds: renderBuilds(), shares: renderShares(), admin: renderAdmin()
  }[state.active];
  root.innerHTML = `<div class="view-heading"><div><p class="eyebrow">SINGH CLOUD</p><h2>${esc(sections.find(([id]) => id === state.active)[1])}</h2></div>${button('refresh', 'Refresh')}</div>${body}`;
}

function renderOverview() {
  const capabilities = Object.entries(state.capabilities).map(([key, value]) => metric(key.replace(/([A-Z])/g, ' $1'), value)).join('');
  const usage = Object.entries(state.usage).map(([key, value]) => metric(key, value)).join('') || metric('Usage', 'No records');
  return `<div class="metric-grid">${capabilities}</div><div class="panel section-card"><h3>Usage</h3><div class="metric-grid">${usage}</div></div>`;
}

function renderSessions() {
  const rows = state.sessions.map((entry) => item(`${entry.profileId} · ${entry.id}`, entry.status, `${entry.status !== 'stopped' ? button('stop-session', 'Stop', { id: entry.id }) : ''}${button('copy', 'Copy ID', { value: entry.id })}`)).join('') || '<p class="muted">No sessions.</p>';
  return `<div class="panel section-card">${button('create-session', 'Create session')}</div><div class="card-list">${rows}</div>`;
}

function renderDevices() {
  const tools = [
    ['gps', 'Mock GPS'], ['locale', 'Locale'], ['dark-mode', 'Dark mode'], ['font-scale', 'Font size'],
    ['battery', 'Battery'], ['connectivity', 'Connectivity'], ['biometric', 'Biometric'], ['deep-link', 'Deep link'], ['permission', 'Permission']
  ].map(([action, label]) => `<div class="tool-card"><h3>${label}</h3>${button(`device-${action}`, 'Configure')}</div>`).join('');
  return `<div class="tool-grid">${tools}</div>`;
}

function renderAutomation() {
  const rows = state.recordings.map((entry) => item(`${entry.name} · ${entry.actions.length} actions`, entry.status, button('replay', 'Replay', { id: entry.id, serial: entry.serial }))).join('') || '<p class="muted">No recordings.</p>';
  return `<div class="panel section-card">${button('start-recording', 'Start recording')}${button('stop-recording', 'Stop active recording')}</div><div class="card-list">${rows}</div>`;
}

function renderDiagnostics() {
  return `<div class="panel section-card">${button('logcat', 'Load logcat')}${button('package-diagnostics', 'Package diagnostics')}${button('network-diagnostics', 'Network diagnostics')}</div><pre id="diagnosticOutput" class="diagnostic-output panel">Choose a diagnostic action.</pre>`;
}

function renderWorkspaces() {
  const rows = state.workspaces.map((entry) => item(entry.name, entry.template, `${button('edit-workspace', 'Open editor', { id: entry.id })}${button('copy', 'Copy ID', { value: entry.id })}`)).join('') || '<p class="muted">No workspaces.</p>';
  return `<div class="panel section-card">${button('create-workspace', 'Create Kotlin project')}</div><div class="card-list">${rows}</div>`;
}

function renderBuilds() {
  const builds = state.builds.map((entry) => item(`${entry.variant} ${entry.format} · ${entry.id}`, entry.status, entry.artifactId ? button('copy', 'Copy artifact ID', { value: entry.artifactId }) : '')).join('') || '<p class="muted">No builds.</p>';
  const artifacts = state.artifacts.map((entry) => item(entry.name, entry.format, `<span class="muted">${esc(entry.sha256 || 'Hash pending')}</span>`)).join('') || '<p class="muted">No artifacts.</p>';
  return `<div class="panel section-card">${button('queue-build', 'Queue build')}</div><h3>Builds</h3><div class="card-list">${builds}</div><h3>Artifacts</h3><div class="card-list">${artifacts}</div>`;
}

function renderShares() {
  const rows = state.shares.map((entry) => item(`${entry.resourceType} · ${entry.resourceId}`, entry.revokedAt ? 'revoked' : 'active', `${button('copy-share', 'Copy URL', { token: entry.token })}${button('revoke-share', 'Revoke', { id: entry.id })}`)).join('') || '<p class="muted">No shares.</p>';
  return `<div class="panel section-card">${button('create-share', 'Create share')}</div><div class="card-list">${rows}</div>`;
}

function renderAdmin() {
  if (!state.admin) return '<div class="panel section-card"><p class="muted">Administrator access is required.</p></div>';
  return `<div class="metric-grid">${Object.entries(state.admin.counts).map(([key, value]) => metric(key, value)).join('')}</div><div class="panel section-card"><h3>Worker interfaces</h3><p class="muted">Build workers claim queued jobs. Emulator workers join authenticated session rooms for WebRTC signaling, logs and runtime events.</p></div>`;
}

async function loadAll() {
  const endpoints = [
    ['capabilities', '/api/platform/capabilities', 'capabilities'], ['profiles', '/api/platform/profiles', 'profiles'],
    ['sessions', '/api/platform/sessions', 'sessions'], ['recordings', '/api/platform/recordings', 'recordings'],
    ['workspaces', '/api/platform/workspaces', 'workspaces'], ['builds', '/api/platform/builds', 'builds'],
    ['artifacts', '/api/platform/artifacts', 'artifacts'], ['shares', '/api/platform/shares', 'shares']
  ];
  await Promise.all(endpoints.map(async ([target, url, key]) => {
    try { state[target] = (await request(url))[key]; } catch (error) { console.warn(url, error); }
  }));
  try { state.usage = (await request('/api/platform/usage')).summary; } catch { state.usage = {}; }
  try { state.admin = await request('/api/platform/admin/overview'); } catch { state.admin = null; }
  render();
}

nav.addEventListener('click', (event) => {
  const target = event.target.closest('[data-section]');
  if (!target) return;
  state.active = target.dataset.section;
  render();
});

root.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  try {
    if (action === 'refresh') return loadAll();
    if (action === 'copy') { await navigator.clipboard.writeText(target.dataset.value); return notify('Copied.'); }
    if (action === 'copy-share') { await navigator.clipboard.writeText(`${location.origin}/share/${target.dataset.token}`); return notify('Share URL copied.'); }
    if (action === 'stop-session') await request(`/api/platform/sessions/${target.dataset.id}/stop`, { method: 'POST', body: '{}' });
    if (action === 'revoke-share') await request(`/api/platform/shares/${target.dataset.id}`, { method: 'DELETE', body: '{}' });
    if (action === 'create-session') await createSession();
    if (action === 'create-workspace') await createWorkspace();
    if (action === 'edit-workspace') await editWorkspace(target.dataset.id);
    if (action === 'queue-build') await queueBuild();
    if (action === 'create-share') await createShare();
    if (action === 'start-recording') await startRecording();
    if (action === 'stop-recording') await request('/api/platform/recordings/stop', { method: 'POST', body: '{}' });
    if (action === 'replay') await request(`/api/platform/recordings/${target.dataset.id}/replay`, { method: 'POST', body: JSON.stringify({ serial: target.dataset.serial, speed: 1 }) });
    if (action === 'logcat') await diagnostics('logcat');
    if (action === 'package-diagnostics') await diagnostics('package');
    if (action === 'network-diagnostics') await diagnostics('network');
    if (action.startsWith('device-')) await deviceTool(action.slice(7));
    notify('Operation completed.');
    await loadAll();
  } catch (error) { notify(error.message); }
});

async function createSession() {
  const profileId = prompt('Profile ID', state.profiles[0]?.id || 'pixel-8-api-35');
  if (!profileId) return;
  const serial = prompt('Assigned Android serial', currentSerial() || '');
  const durationMinutes = prompt('Duration in minutes', '30');
  await request('/api/platform/sessions', { method: 'POST', body: JSON.stringify({ profileId, serial, durationMinutes, transport: 'png' }) });
}

async function createWorkspace() {
  const name = prompt('Project name', 'My Android App');
  if (name) await request('/api/platform/workspaces', { method: 'POST', body: JSON.stringify({ name, template: 'android-kotlin' }) });
}

async function editWorkspace(id) {
  const files = (await request(`/api/platform/workspaces/${id}/files`)).files;
  const file = prompt(`File to open:\n${files.join('\n')}`, files[0] || '');
  if (!file) return;
  const opened = await request(`/api/platform/workspaces/${id}/file?path=${encodeURIComponent(file)}`);
  const content = prompt(`Edit ${file}`, opened.content);
  if (content !== null) await request(`/api/platform/workspaces/${id}/file`, { method: 'PUT', body: JSON.stringify({ path: file, content }) });
}

async function queueBuild() {
  const workspaceId = prompt('Workspace ID', state.workspaces[0]?.id || '');
  if (workspaceId) await request('/api/platform/builds', { method: 'POST', body: JSON.stringify({ workspaceId, variant: 'debug', format: 'apk' }) });
}

async function createShare() {
  const resourceType = prompt('Resource type: session, app, or workspace', 'session');
  const resourceId = prompt('Resource ID', state.sessions[0]?.id || state.workspaces[0]?.id || '');
  if (resourceType && resourceId) await request('/api/platform/shares', { method: 'POST', body: JSON.stringify({ resourceType, resourceId, durationMinutes: 60, allowEmbed: true }) });
}

async function startRecording() {
  const serial = currentSerial();
  if (serial) await request('/api/platform/recordings/start', { method: 'POST', body: JSON.stringify({ name: prompt('Recording name', 'Test flow'), serial }) });
}

async function diagnostics(type) {
  const serial = currentSerial();
  if (!serial) return;
  let output;
  if (type === 'logcat') output = await request(`/api/platform/diagnostics/logcat?serial=${encodeURIComponent(serial)}&lines=500&level=V`);
  if (type === 'package') output = JSON.stringify((await request(`/api/platform/diagnostics/package?serial=${encodeURIComponent(serial)}&packageName=${encodeURIComponent(prompt('Package name', 'com.example.app'))}`)).diagnostics, null, 2);
  if (type === 'network') output = JSON.stringify((await request(`/api/platform/diagnostics/network?serial=${encodeURIComponent(serial)}`)).diagnostics, null, 2);
  document.querySelector('#diagnosticOutput').textContent = output;
}

async function deviceTool(tool) {
  const serial = currentSerial();
  if (!serial) return;
  let endpoint = tool;
  let payload = { serial };
  if (tool === 'gps') { endpoint = 'location'; payload.latitude = prompt('Latitude', '5.852'); payload.longitude = prompt('Longitude', '-55.2038'); }
  if (tool === 'locale') payload.locale = prompt('Locale', 'en-US');
  if (tool === 'dark-mode') payload.enabled = confirm('Enable dark mode?');
  if (tool === 'font-scale') payload.scale = prompt('Font scale 0.5–2.0', '1');
  if (tool === 'battery') { payload.level = prompt('Battery level', '80'); payload.status = prompt('Status: charging, discharging, full', 'charging'); }
  if (tool === 'connectivity') { payload.wifi = confirm('Enable Wi-Fi?'); payload.mobileData = confirm('Enable mobile data?'); payload.airplaneMode = confirm('Enable airplane mode?'); }
  if (tool === 'biometric') payload.fingerId = prompt('Fingerprint ID 1–10', '1');
  if (tool === 'deep-link') { payload.url = prompt('Deep link URL', 'myapp://screen'); payload.packageName = prompt('Optional package name', ''); }
  if (tool === 'permission') { payload.packageName = prompt('Package name', 'com.example.app'); payload.permission = prompt('Permission', 'android.permission.CAMERA'); payload.grant = confirm('Grant this permission?'); }
  await request(`/api/platform/device/${endpoint}`, { method: 'POST', body: JSON.stringify(payload) });
}

loadAll().catch((error) => notify(error.message));
