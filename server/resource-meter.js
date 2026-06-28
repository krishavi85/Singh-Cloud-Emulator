const { addOnce, organizationFor } = require('./session-meter');

function recordArtifact(state, artifact) {
  return addOnce(state, `artifact-bytes:${artifact.id}`, {
    organizationId: organizationFor(state, artifact.userId, artifact.organizationId),
    userId: artifact.userId,
    buildId: artifact.buildId || null,
    artifactId: artifact.id,
    type: 'artifact.bytes',
    quantity: Number(artifact.sizeBytes || 0),
    metadata: { format: artifact.format, contentType: artifact.contentType }
  });
}

function recordCapture(state, capture) {
  const started = Date.parse(capture.startedAt || capture.createdAt || new Date().toISOString());
  const ended = Date.parse(capture.stoppedAt || new Date().toISOString());
  const minutes = Math.max(1, Math.ceil(Math.max(0, ended - started) / 60000));
  return addOnce(state, `capture-minutes:${capture.id}`, {
    organizationId: organizationFor(state, capture.userId, capture.organizationId),
    userId: capture.userId,
    sessionId: capture.sessionId || null,
    type: 'capture.minutes',
    quantity: minutes,
    metadata: { status: capture.status, hasHar: Boolean(capture.harStorageKey) }
  });
}

module.exports = { recordArtifact, recordCapture };
