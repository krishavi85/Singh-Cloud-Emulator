const store = require('./platform-store');

function organizationFor(state, userId, explicit) {
  if (explicit) return explicit;
  return state.memberships.find((item) => item.userId === userId && !item.revokedAt)?.organizationId || null;
}

function addOnce(state, key, record) {
  const existing = state.usage.find((item) => item.idempotencyKey === key);
  if (existing) return existing;
  const event = { id: store.id('usage'), idempotencyKey: key, at: store.now(), ...record };
  state.usage.push(event);
  return event;
}

function recordSession(state, session) {
  const started = Date.parse(session.startedAt || session.createdAt || store.now());
  const ended = Date.parse(session.endedAt || store.now());
  const minutes = Math.max(1, Math.ceil(Math.max(0, ended - started) / 60000));
  return addOnce(state, `session-minutes:${session.id}`, {
    organizationId: organizationFor(state, session.userId, session.organizationId),
    userId: session.userId,
    sessionId: session.id,
    type: 'session.minutes',
    quantity: minutes,
    metadata: { profileId: session.profileId, platform: session.platform || null, status: session.status }
  });
}

function recordBuild(state, build) {
  const started = Date.parse(build.startedAt || build.createdAt || store.now());
  const ended = Date.parse(build.completedAt || store.now());
  const minutes = Math.max(1, Math.ceil(Math.max(0, ended - started) / 60000));
  const organizationId = organizationFor(state, build.userId, build.organizationId);
  addOnce(state, `build-minutes:${build.id}`, {
    organizationId,
    userId: build.userId,
    buildId: build.id,
    type: 'build.minutes',
    quantity: minutes,
    metadata: { format: build.format, variant: build.variant, status: build.status }
  });
  return addOnce(state, `build-count:${build.id}`, {
    organizationId,
    userId: build.userId,
    buildId: build.id,
    type: 'build.completed',
    quantity: 1,
    metadata: { format: build.format, variant: build.variant, status: build.status }
  });
}

module.exports = { addOnce, organizationFor, recordBuild, recordSession };
