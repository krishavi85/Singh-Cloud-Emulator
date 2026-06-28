const adb = require('./adb');
const store = require('./platform-store');

const activeByUser = new Map();

async function startRecording(user, name, serial) {
  const recording = {
    id: store.id('rec'),
    userId: user.id,
    name: String(name || 'Untitled recording').slice(0, 120),
    serial: String(serial || ''),
    status: 'recording',
    actions: [],
    createdAt: store.now(),
    updatedAt: store.now()
  };
  await store.transact((state) => {
    state.recordings.push(recording);
    return recording;
  });
  activeByUser.set(user.id, recording.id);
  return recording;
}

async function stopRecording(user) {
  const id = activeByUser.get(user.id);
  if (!id) return null;
  activeByUser.delete(user.id);
  return store.transact((state) => {
    const recording = state.recordings.find((item) => item.id === id && item.userId === user.id);
    if (!recording) return null;
    recording.status = 'ready';
    recording.updatedAt = store.now();
    return recording;
  });
}

async function recordAction(userId, serial, type, payload) {
  const id = activeByUser.get(userId);
  if (!id) return;
  await store.transact((state) => {
    const recording = state.recordings.find((item) => item.id === id && item.userId === userId);
    if (!recording || recording.status !== 'recording') return null;
    const previous = recording.actions.at(-1);
    const at = Date.now();
    recording.actions.push({
      type,
      payload,
      serial,
      delayMs: previous ? Math.min(30_000, Math.max(0, at - previous.at)) : 0,
      at
    });
    recording.updatedAt = store.now();
    return recording;
  });
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function executeAction(serial, action) {
  const payload = action.payload || {};
  switch (action.type) {
    case 'tap': return adb.tap(serial, payload.x, payload.y);
    case 'swipe': return adb.swipe(serial, payload.x1, payload.y1, payload.x2, payload.y2, payload.duration);
    case 'text': return adb.text(serial, payload.text || '');
    case 'key': return adb.keyevent(serial, payload.key);
    case 'rotate': return adb.rotate(serial, payload.orientation);
    case 'launch': return adb.launchPackage(serial, payload.packageName);
    default: throw Object.assign(new Error(`Unsupported automation action: ${action.type}`), { status: 400 });
  }
}

async function replayRecording(user, recordingId, serial, options = {}) {
  const state = await store.readState();
  const recording = state.recordings.find((item) => item.id === recordingId && store.owned(item, user));
  if (!recording) throw Object.assign(new Error('Recording not found.'), { status: 404 });
  if (!recording.actions.length) throw Object.assign(new Error('Recording has no actions.'), { status: 409 });
  const speed = Math.min(10, Math.max(0.1, Number(options.speed || 1)));
  const results = [];
  for (const action of recording.actions) {
    await sleep(Math.round((action.delayMs || 0) / speed));
    await executeAction(serial, action);
    results.push({ type: action.type, ok: true });
  }
  return { recordingId, serial, actionCount: results.length, speed, results };
}

module.exports = { recordAction, replayRecording, startRecording, stopRecording };
