const state = {
  serial: '',
  width: 0,
  height: 0,
  orientation: 0,
  pointerStart: null,
  streamUrl: ''
};

const elements = {
  activityLog: document.querySelector('#activityLog'),
  apkFile: document.querySelector('#apkFile'),
  avdName: document.querySelector('#avdName'),
  clearLog: document.querySelector('#clearLog'),
  connectionDot: document.querySelector('#connectionDot'),
  connectionText: document.querySelector('#connectionText'),
  deviceDetails: document.querySelector('#deviceDetails'),
  deviceScreen: document.querySelector('#deviceScreen'),
  deviceSelect: document.querySelector('#deviceSelect'),
  emptyScreen: document.querySelector('#emptyScreen'),
  installApk: document.querySelector('#installApk'),
  launchPackage: document.querySelector('#launchPackage'),
  packageName: document.querySelector('#packageName'),
  phoneFrame: document.querySelector('#phoneFrame'),
  refreshDevices: document.querySelector('#refreshDevices'),
  resolutionLabel: document.querySelector('#resolutionLabel'),
  rotateLeft: document.querySelector('#rotateLeft'),
  rotateRight: document.querySelector('#rotateRight'),
  startEmulator: document.querySelector('#startEmulator'),
  stopEmulator: document.querySelector('#stopEmulator'),
  takeScreenshot: document.querySelector('#takeScreenshot'),
  textForm: document.querySelector('#textForm'),
  textInput: document.querySelector('#textInput'),
  uploadProgress: document.querySelector('#uploadProgress')
};

function log(message, type = '') {
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`.trim();
  const time = document.createElement('time');
  time.textContent = new Date().toLocaleTimeString();
  entry.append(time, document.createTextNode(message));
  elements.activityLog.append(entry);
  elements.activityLog.scrollTop = elements.activityLog.scrollHeight;
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: options.body instanceof FormData
      ? options.headers
      : { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function setConnected(connected) {
  elements.connectionDot.classList.toggle('online', connected);
  elements.connectionText.textContent = connected ? 'Server connected' : 'Connection lost';
}

function selectedSerial() {
  return elements.deviceSelect.value || state.serial;
}

async function loadDevices() {
  elements.refreshDevices.disabled = true;
  try {
    const result = await request('/api/devices');
    const previous = selectedSerial();
    elements.deviceSelect.replaceChildren();

    if (!result.devices.length) {
      elements.deviceSelect.add(new Option('No online devices', ''));
      state.serial = '';
      showEmpty();
      log('No ADB devices found. Start an Android emulator or connect a device.');
      return;
    }

    for (const device of result.devices) {
      const model = device.metadata.model ? ` — ${device.metadata.model}` : '';
      const option = new Option(`${device.serial} (${device.state})${model}`, device.serial);
      option.disabled = device.state !== 'device';
      elements.deviceSelect.add(option);
    }

    const usable = result.devices.find((device) => device.state === 'device' && device.serial === previous)
      || result.devices.find((device) => device.state === 'device');
    if (usable) {
      elements.deviceSelect.value = usable.serial;
      await selectDevice(usable.serial);
    }
  } catch (error) {
    log(error.message, 'error');
  } finally {
    elements.refreshDevices.disabled = false;
  }
}

async function selectDevice(serial) {
  if (!serial) return showEmpty();
  try {
    const device = await request(`/api/device?serial=${encodeURIComponent(serial)}`);
    state.serial = serial;
    state.width = device.size.width;
    state.height = device.size.height;
    elements.deviceDetails.textContent = `${serial} · ${device.size.width}×${device.size.height}${device.foregroundPackage ? ` · ${device.foregroundPackage}` : ''}`;
    elements.resolutionLabel.textContent = `${device.size.width}×${device.size.height}`;
    startStream();
    log(`Connected to ${serial}.`, 'success');
  } catch (error) {
    showEmpty();
    log(error.message, 'error');
  }
}

function startStream() {
  if (!state.serial) return;
  state.streamUrl = `/api/stream?serial=${encodeURIComponent(state.serial)}&t=${Date.now()}`;
  elements.deviceScreen.src = state.streamUrl;
  elements.deviceScreen.style.display = 'block';
  elements.emptyScreen.hidden = true;
}

function showEmpty() {
  state.serial = '';
  state.width = 0;
  state.height = 0;
  elements.deviceScreen.removeAttribute('src');
  elements.deviceScreen.style.display = 'none';
  elements.emptyScreen.hidden = false;
  elements.deviceDetails.textContent = 'No device selected.';
  elements.resolutionLabel.textContent = '—';
}

function imageCoordinates(event) {
  const rect = elements.deviceScreen.getBoundingClientRect();
  if (!state.width || !state.height || rect.width === 0 || rect.height === 0) return null;

  const imageRatio = state.width / state.height;
  const boxRatio = rect.width / rect.height;
  let renderWidth = rect.width;
  let renderHeight = rect.height;
  let offsetX = 0;
  let offsetY = 0;

  if (imageRatio > boxRatio) {
    renderHeight = renderWidth / imageRatio;
    offsetY = (rect.height - renderHeight) / 2;
  } else {
    renderWidth = renderHeight * imageRatio;
    offsetX = (rect.width - renderWidth) / 2;
  }

  const localX = event.clientX - rect.left - offsetX;
  const localY = event.clientY - rect.top - offsetY;
  if (localX < 0 || localY < 0 || localX > renderWidth || localY > renderHeight) return null;

  return {
    x: (localX / renderWidth) * state.width,
    y: (localY / renderHeight) * state.height
  };
}

async function sendJson(url, payload) {
  return request(url, { method: 'POST', body: JSON.stringify(payload) });
}

elements.phoneFrame.addEventListener('pointerdown', (event) => {
  if (!state.serial) return;
  const point = imageCoordinates(event);
  if (!point) return;
  elements.phoneFrame.setPointerCapture(event.pointerId);
  elements.phoneFrame.focus();
  state.pointerStart = { ...point, time: performance.now() };
});

elements.phoneFrame.addEventListener('pointerup', async (event) => {
  if (!state.pointerStart || !state.serial) return;
  const end = imageCoordinates(event);
  const start = state.pointerStart;
  state.pointerStart = null;
  if (!end) return;

  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  try {
    if (distance < 14) {
      await sendJson('/api/input/tap', { serial: state.serial, x: end.x, y: end.y });
    } else {
      await sendJson('/api/input/swipe', {
        serial: state.serial,
        x1: start.x,
        y1: start.y,
        x2: end.x,
        y2: end.y,
        duration: Math.max(100, performance.now() - start.time)
      });
    }
  } catch (error) {
    log(error.message, 'error');
  }
});

elements.phoneFrame.addEventListener('pointercancel', () => { state.pointerStart = null; });
elements.deviceSelect.addEventListener('change', () => selectDevice(elements.deviceSelect.value));
elements.refreshDevices.addEventListener('click', loadDevices);

document.querySelectorAll('[data-key]').forEach((button) => {
  button.addEventListener('click', async () => {
    if (!state.serial) return;
    try {
      await sendJson('/api/input/key', { serial: state.serial, key: button.dataset.key });
    } catch (error) {
      log(error.message, 'error');
    }
  });
});

async function applyRotation(delta) {
  if (!state.serial) return;
  state.orientation = (state.orientation + delta + 4) % 4;
  try {
    await sendJson('/api/device/rotate', { serial: state.serial, orientation: state.orientation });
    setTimeout(() => selectDevice(state.serial), 700);
  } catch (error) {
    log(error.message, 'error');
  }
}

elements.rotateLeft.addEventListener('click', () => applyRotation(-1));
elements.rotateRight.addEventListener('click', () => applyRotation(1));

elements.textForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = elements.textInput.value;
  if (!state.serial || !text) return;
  try {
    await sendJson('/api/input/text', { serial: state.serial, text });
    elements.textInput.value = '';
  } catch (error) {
    log(error.message, 'error');
  }
});

elements.startEmulator.addEventListener('click', async () => {
  const avd = elements.avdName.value.trim();
  if (!avd) return log('Enter an Android Virtual Device name.', 'error');
  try {
    await sendJson('/api/emulator/start', { avd });
  } catch (error) {
    log(error.message, 'error');
  }
});

elements.stopEmulator.addEventListener('click', async () => {
  if (!state.serial) return log('Select an emulator first.', 'error');
  try {
    await sendJson('/api/emulator/stop', { serial: state.serial });
    log(`Stop request sent for ${state.serial}.`, 'success');
  } catch (error) {
    log(error.message, 'error');
  }
});

elements.installApk.addEventListener('click', async () => {
  const file = elements.apkFile.files[0];
  if (!file) return log('Choose an APK file first.', 'error');
  if (!state.serial) return log('Select an Android device first.', 'error');

  const form = new FormData();
  form.append('apk', file);
  form.append('serial', state.serial);
  elements.uploadProgress.hidden = false;
  elements.installApk.disabled = true;

  try {
    const result = await request('/api/apk/install', { method: 'POST', body: form });
    log(result.output || `${file.name} installed.`, 'success');
  } catch (error) {
    log(error.message, 'error');
  } finally {
    elements.uploadProgress.hidden = true;
    elements.installApk.disabled = false;
  }
});

elements.launchPackage.addEventListener('click', async () => {
  const packageName = elements.packageName.value.trim();
  if (!state.serial || !packageName) return log('Select a device and enter a package name.', 'error');
  try {
    await sendJson('/api/app/launch', { serial: state.serial, packageName });
    log(`Launched ${packageName}.`, 'success');
  } catch (error) {
    log(error.message, 'error');
  }
});

elements.takeScreenshot.addEventListener('click', () => {
  if (!state.serial) return;
  window.open(`/api/screenshot?serial=${encodeURIComponent(state.serial)}&t=${Date.now()}`, '_blank', 'noopener');
});

elements.clearLog.addEventListener('click', () => elements.activityLog.replaceChildren());

function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${location.host}/ws`);

  socket.addEventListener('open', () => setConnected(true));
  socket.addEventListener('close', () => {
    setConnected(false);
    setTimeout(connectWebSocket, 2000);
  });
  socket.addEventListener('message', (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'connected') return;
      const message = data.message || `${data.type}: ${data.status || ''}`;
      log(message.trim(), data.type === 'error' ? 'error' : '');
    } catch {
      log(String(event.data));
    }
  });
}

connectWebSocket();
loadDevices();
