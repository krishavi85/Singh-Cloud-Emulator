const serviceGrid = document.querySelector('#serviceGrid');
const toast = document.querySelector('#toast');
let currentAppiumId = '';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json', ...(options.headers || {}) } : options.headers
  });
  const type = response.headers.get('content-type') || '';
  const body = type.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(body.error || body || `Request failed (${response.status}).`);
  return body;
}

function notify(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => { toast.hidden = true; }, 3500);
}

async function loadServices() {
  const body = await request('/api/equivalence/services');
  serviceGrid.innerHTML = Object.values(body.services).map((service) => `
    <div class="metric">
      <span class="muted">${escapeHtml(service.label)}</span>
      <strong>${escapeHtml(service.configured ? service.status : 'Not configured')}</strong>
      <span class="badge ${service.healthy ? 'good' : 'warn'}">${service.healthy ? 'Healthy' : 'Unavailable'}</span>
    </div>`).join('');
}

async function loadCaptures() {
  const body = await request('/api/equivalence/network-captures');
  document.querySelector('#captureList').innerHTML = body.captures.map((capture) => `
    <article class="item-card">
      <header><strong>${escapeHtml(capture.id)}</strong><span class="badge">${escapeHtml(capture.status)}</span></header>
      <p>${escapeHtml(capture.serial)} · ${escapeHtml(capture.proxy)}</p>
      <div class="item-actions">
        ${capture.status === 'running' ? `<button data-stop-capture="${escapeHtml(capture.id)}">Stop</button>` : ''}
        ${capture.harPath ? `<a href="${escapeHtml(capture.harPath)}" target="_blank" rel="noopener">Open HAR</a>` : ''}
      </div>
    </article>`).join('') || '<p class="muted">No captures.</p>';
}

document.querySelector('#refreshServices').addEventListener('click', () => loadServices().catch((error) => notify(error.message)));

document.querySelector('#loadLinks').addEventListener('click', async () => {
  try {
    const id = document.querySelector('#sessionId').value.trim();
    const body = await request(`/api/equivalence/sessions/${encodeURIComponent(id)}/links`);
    document.querySelector('#sessionLinks').innerHTML = Object.entries(body.links).map(([name, url]) => `
      <article class="item-card"><header><strong>${escapeHtml(name)}</strong><span class="badge">${url ? 'Ready' : 'Not configured'}</span></header>
      ${url ? `<div class="item-actions"><a href="${escapeHtml(url)}" target="_blank" rel="noopener">Open service</a></div>` : ''}</article>`).join('');
  } catch (error) {
    notify(error.message);
  }
});

document.querySelector('#createAppium').addEventListener('click', async () => {
  try {
    const body = await request('/api/equivalence/appium/sessions', {
      method: 'POST',
      body: JSON.stringify({
        serial: document.querySelector('#appiumSerial').value.trim(),
        appPackage: document.querySelector('#appiumPackage').value.trim(),
        noReset: true
      })
    });
    currentAppiumId = body.session.id;
    document.querySelector('#appiumResult').textContent = JSON.stringify(body.session, null, 2);
    notify('Appium session created.');
  } catch (error) {
    notify(error.message);
  }
});

document.querySelector('#startCapture').addEventListener('click', async () => {
  try {
    await request('/api/equivalence/network-captures', {
      method: 'POST',
      body: JSON.stringify({
        serial: document.querySelector('#captureSerial').value.trim(),
        sessionId: document.querySelector('#captureSession').value.trim() || null
      })
    });
    await loadCaptures();
    notify('Network capture started. Install or trust the session CA only on test devices.');
  } catch (error) {
    notify(error.message);
  }
});

document.querySelector('#captureList').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-stop-capture]');
  if (!button) return;
  try {
    await request(`/api/equivalence/network-captures/${encodeURIComponent(button.dataset.stopCapture)}/stop`, { method: 'POST', body: '{}' });
    await loadCaptures();
    notify('Network capture stopped.');
  } catch (error) {
    notify(error.message);
  }
});

async function collect(endpoint, payload) {
  document.querySelectorAll('[data-profile-download]').forEach((element) => element.remove());
  const body = await request(endpoint, { method: 'POST', body: JSON.stringify(payload) });
  document.querySelector('#inspectionOutput').textContent = JSON.stringify(body, null, 2);
  if (body.downloadPath) {
    const link = document.createElement('a');
    link.dataset.profileDownload = 'true';
    link.href = body.downloadPath;
    link.textContent = `Download ${body.artifact.filename}`;
    link.style.display = 'inline-block';
    link.style.marginTop = '10px';
    document.querySelector('#inspectionOutput').after(link);
  }
}

function profileInput() {
  return {
    serial: document.querySelector('#profileSerial').value.trim(),
    packageName: document.querySelector('#profilePackage').value.trim(),
    durationSeconds: document.querySelector('#profileDuration').value
  };
}

document.querySelector('#collectPerfetto').addEventListener('click', () => collect('/api/equivalence/profiles/perfetto', profileInput()).catch((error) => notify(error.message)));

document.querySelector('#collectSimpleperf').addEventListener('click', () => collect('/api/equivalence/profiles/simpleperf', profileInput()).catch((error) => notify(error.message)));

document.querySelector('#collectHeap').addEventListener('click', () => collect('/api/equivalence/profiles/heap', profileInput()).catch((error) => notify(error.message)));

document.querySelector('#loadHierarchy').addEventListener('click', async () => {
  try {
    document.querySelectorAll('[data-profile-download]').forEach((element) => element.remove());
    const serial = document.querySelector('#profileSerial').value.trim();
    const xml = await request(`/api/equivalence/layout?serial=${encodeURIComponent(serial)}`);
    document.querySelector('#inspectionOutput').textContent = xml;
  } catch (error) {
    notify(error.message);
  }
});

loadServices().catch((error) => notify(error.message));
loadCaptures().catch((error) => notify(error.message));
