const operationsToast = document.querySelector('#toast');

async function operationsRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json', ...(options.headers || {}) } : options.headers
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
  return body;
}

function operationsEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

function operationsNotify(message) {
  operationsToast.textContent = message;
  operationsToast.hidden = false;
  clearTimeout(operationsNotify.timer);
  operationsNotify.timer = setTimeout(() => { operationsToast.hidden = true; }, 3500);
}

function operationsMetric(name, value, state = 'healthy') {
  const labels = { healthy: 'Healthy', attention: 'Attention', disabled: 'Disabled', informational: 'Information' };
  const badgeClass = state === 'healthy' ? 'good' : state === 'attention' ? 'warn' : '';
  return `<div class="metric"><span class="muted">${operationsEscape(name)}</span><strong>${operationsEscape(value)}</strong><span class="badge ${badgeClass}">${labels[state] || labels.informational}</span></div>`;
}

function dependencyState(dependency, optional = false) {
  if (optional && dependency?.configured === false) return 'disabled';
  return dependency?.healthy === false ? 'attention' : 'healthy';
}

function operationsCard(title, status, details, actions = '') {
  return `<article class="item-card"><header><strong>${operationsEscape(title)}</strong><span class="badge">${operationsEscape(status || '')}</span></header><p>${operationsEscape(details || '')}</p><div class="item-actions">${actions}</div></article>`;
}

async function loadOperationsHealth() {
  try {
    const body = await operationsRequest('/api/platform/system/health');
    const dependencies = body.dependencies || {};
    document.querySelector('#healthGrid').innerHTML = [
      operationsMetric('Platform', body.ready ? 'Ready' : 'Degraded', body.ready ? 'healthy' : 'attention'),
      operationsMetric('State', body.stateBackend, dependencyState(dependencies.database)),
      operationsMetric('Queue', dependencies.redis?.backend || 'unknown', dependencyState(dependencies.redis)),
      operationsMetric('Storage', dependencies.objectStorage?.backend || 'unknown', dependencyState(dependencies.objectStorage)),
      operationsMetric('Scanner', dependencies.clamav?.engine || 'unknown', dependencyState(dependencies.clamav)),
      operationsMetric('Email', dependencies.smtp?.backend || 'disabled', dependencyState(dependencies.smtp, true)),
      operationsMetric('Billing', dependencies.lago?.backend || 'disabled', dependencyState(dependencies.lago, true)),
      operationsMetric('Active sessions', body.counts?.activeSessions || 0, 'informational'),
      operationsMetric('Queued builds', body.counts?.queuedBuilds || 0, 'informational')
    ].join('');
  } catch (error) {
    document.querySelector('#healthGrid').innerHTML = operationsMetric('System health', error.message, 'attention');
  }
}

async function loadOperationsWorkers() {
  try {
    const body = await operationsRequest('/api/platform/workers');
    document.querySelector('#workerList').innerHTML = body.workers.map((worker) => operationsCard(
      worker.id,
      worker.status,
      `${worker.platform}/${worker.runtime} · ${worker.activeLeases || 0}/${worker.capacity || 1} leases · ${worker.lastHeartbeatAt || 'no heartbeat'}`
    )).join('') || '<p class="muted">No workers registered.</p>';
  } catch (error) {
    document.querySelector('#workerList').textContent = error.message;
  }
}

window.operationsRequest = operationsRequest;
window.operationsEscape = operationsEscape;
window.operationsNotify = operationsNotify;
window.operationsCard = operationsCard;
window.refreshOperationsConsole = async () => Promise.allSettled([loadOperationsHealth(), loadOperationsWorkers()]);

document.querySelector('#refreshOperations').addEventListener('click', () => window.refreshOperationsConsole());
window.refreshOperationsConsole();
