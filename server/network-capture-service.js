const store = require('./platform-store');
const queues = require('./queue-service');

async function startCapture(user, serial, sessionId = null) {
  const record = {
    id: store.id('capture'),
    userId: user.id,
    organizationId: user.organizationId || null,
    sessionId: sessionId ? String(sessionId) : null,
    serial: String(serial),
    proxy: null,
    status: 'queued',
    workerId: null,
    workerApiKeyId: null,
    createdAt: store.now(),
    claimedAt: null,
    startedAt: null,
    lastHeartbeatAt: null,
    stopRequested: false,
    stoppedAt: null,
    webUrl: null,
    certificateUrl: process.env.MITMPROXY_CERTIFICATE_URL || 'http://mitm.it',
    harStorageKey: null,
    harPath: null,
    flowStorageKey: null,
    error: null
  };
  await store.transact((state) => {
    state.networkCaptures.push(record);
    return record;
  });
  await queues.enqueue('capture', record.id, { sessionId: record.sessionId, serial: record.serial });
  return record;
}

async function stopCapture(user, id) {
  return store.transact((state) => {
    const current = state.networkCaptures.find((item) => item.id === id && (user.role === 'admin' || item.userId === user.id));
    if (!current) throw Object.assign(new Error('Network capture not found.'), { status: 404 });
    current.stopRequested = true;
    if (current.status === 'queued') {
      current.status = 'cancelled';
      current.stoppedAt = store.now();
    } else if (current.status === 'running') {
      current.status = 'stopping';
    }
    return { ...current };
  });
}

async function listCaptures(user) {
  const state = await store.readState();
  return state.networkCaptures.filter((item) => user.role === 'admin' || item.userId === user.id || (user.organizationId && item.organizationId === user.organizationId));
}

module.exports = { listCaptures, startCapture, stopCapture };
