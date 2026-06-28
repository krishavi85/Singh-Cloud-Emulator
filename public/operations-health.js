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

function operationsMetric(name, value, healthy = true) {
  return `<div class="metric"><span class="muted">${operationsEscape(name)}</span><strong>${operationsEscape(value)}</strong><span class="badge ${healthy ? 'good' : 'warn'}">${healthy ? 'Healthy' : 'Attention'}</span></div>`;
}

function operationsCard(title, status, details, actions = '') {
  return `<article class="item-card"><header><strong>${operationsEscape(title)}</strong><span class="badge">${operationsEscape(status || '')}</span></header><p>${operationsEscape(details || '')}</p><div class="item-actions">${actions}</div></article>`;
}

async function loadOperationsHealth() {
  try {
    const body = await operationsRequest('/api/platform/system/health');
    const dependencies = body.dependencies || {};
    document.querySelector('#healthGrid').innerHTML = [
      operationsMetric('Platform', body.ready ? 'Ready' : 'Degraded', body.ready),
      operationsMetric('State', body.stateBackend, dependencies.database?.healthy !== false),
      operationsMetric('Queue', dependencies.redis?.backend || 'unknown', dependencies.redis?.healthy !== false),
      operationsMetric('Storage', dependencies.objectStorage?.backend || 'unknown', dependencies.objectStorage?.healthy !== false),
      operationsMetric('Scanner', dependencies.clamav?.engine || 'unknown', dependencies.clamav?.healthy !== false),
      operationsMetric('Email', dependencies.smtp?.backend || 'disabled', dependencies.smtp?.healthy !== false),
      operationsMetric('Billing', dependencies.lago?.backend || 'disabled', dependencies.lago?.healthy !== false),
      operationsMetric('Active sessions', body.counts?.activeSessions || 0),
      operationsMetric('Queued builds', body.counts?.queuedBuilds || 0)
    ].join('');
  } catch (error) {
    document.querySelector('#healthGrid').innerHTML = operationsMetric('System health', error.message, false);
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
