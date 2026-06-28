const store = require('./platform-store');
const queues = require('./queue-service');
const notifications = require('./notification-service');
const debugSessions = require('./debug-service');
const billingMeter = require('./billing-meter-service');
const { recordBuild, recordSession } = require('./session-meter');
const { recordArtifact, recordCapture } = require('./resource-meter');

let timer = null;
let running = false;

async function sweep() {
  if (running) return;
  running = true;
  const requeueSessions = [];
  const requeueBuilds = [];
  const requeueCaptures = [];
  const expiredSessions = [];
  try {
    await store.transact((state) => {
      const now = Date.now();
      const staleWorkerMs = Math.max(30_000, Number(process.env.WORKER_STALE_MS || 90_000));
      const staleBuildMs = Math.max(120_000, Number(process.env.BUILD_STALE_MS || 30 * 60_000));
      const staleCaptureMs = Math.max(60_000, Number(process.env.CAPTURE_STALE_MS || 120_000));
      const queueRefreshMs = Math.max(5_000, Number(process.env.QUEUE_REFRESH_MS || 15_000));

      for (const worker of state.workers) {
        const heartbeat = Date.parse(worker.lastHeartbeatAt || worker.registeredAt || 0);
        if (worker.status !== 'offline' && heartbeat && now - heartbeat > staleWorkerMs) {
          worker.status = 'offline';
          worker.offlineAt = store.now();
          worker.activeLeases = 0;
        }
      }

      for (const session of state.sessions) {
        if (['stopped', 'expired', 'failed'].includes(session.status)) {
          recordSession(state, session);
          continue;
        }
        if (Date.parse(session.expiresAt) <= now) {
          session.status = 'expired';
          session.endedAt = store.now();
          session.finishReason = 'ttl-expired';
          recordSession(state, session);
          expiredSessions.push({ ...session });
          continue;
        }
        if (session.status === 'queued') {
          if (!session.lastQueuedAt || now - Date.parse(session.lastQueuedAt) > queueRefreshMs) {
            session.lastQueuedAt = store.now();
            requeueSessions.push({ ...session });
          }
          continue;
        }
        const heartbeat = Date.parse(session.lastHeartbeatAt || session.claimedAt || session.startedAt || 0);
        if (heartbeat && now - heartbeat > staleWorkerMs) {
          session.status = 'queued';
          session.workerId = null;
          session.workerApiKeyId = null;
          session.serial = '';
          session.claimedAt = null;
          session.startedAt = null;
          session.lastHeartbeatAt = null;
          session.recoveryCount = Number(session.recoveryCount || 0) + 1;
          session.lastQueuedAt = store.now();
          requeueSessions.push({ ...session });
        }
      }

      for (const build of state.builds) {
        if (['completed', 'failed', 'cancelled'].includes(build.status)) {
          recordBuild(state, build);
          continue;
        }
        if (build.status === 'queued') {
          if (!build.lastQueuedAt || now - Date.parse(build.lastQueuedAt) > queueRefreshMs) {
            build.lastQueuedAt = store.now();
            requeueBuilds.push({ ...build });
          }
          continue;
        }
        if (build.status !== 'building') continue;
        const heartbeat = Date.parse(build.lastHeartbeatAt || build.startedAt || 0);
        if (heartbeat && now - heartbeat > staleBuildMs) {
          build.status = 'queued';
          build.workerId = null;
          build.workerApiKeyId = null;
          build.startedAt = null;
          build.lastHeartbeatAt = null;
          build.retryCount = Number(build.retryCount || 0) + 1;
          build.lastQueuedAt = store.now();
          requeueBuilds.push({ ...build });
        }
      }

      for (const capture of state.networkCaptures) {
        if (['stopped', 'failed', 'cancelled'].includes(capture.status)) {
          recordCapture(state, capture);
          continue;
        }
        if (capture.status === 'queued') {
          if (!capture.lastQueuedAt || now - Date.parse(capture.lastQueuedAt) > queueRefreshMs) {
            capture.lastQueuedAt = store.now();
            requeueCaptures.push({ ...capture });
          }
          continue;
        }
        if (!['starting', 'running', 'stopping'].includes(capture.status)) continue;
        const heartbeat = Date.parse(capture.lastHeartbeatAt || capture.claimedAt || capture.startedAt || 0);
        if (heartbeat && now - heartbeat > staleCaptureMs) {
          capture.status = capture.stopRequested ? 'failed' : 'queued';
          capture.error = 'capture-worker-heartbeat-lost';
          capture.workerId = null;
          capture.workerApiKeyId = null;
          capture.claimedAt = null;
          capture.startedAt = null;
          capture.lastHeartbeatAt = null;
          capture.recoveryCount = Number(capture.recoveryCount || 0) + 1;
          if (!capture.stopRequested) {
            capture.lastQueuedAt = store.now();
            requeueCaptures.push({ ...capture });
          }
        }
      }

      for (const artifact of state.artifacts) recordArtifact(state, artifact);
    });

    await Promise.all(requeueSessions.map((session) => queues.enqueue('session', session.id, { profileId: session.profileId, platform: session.platform || null })));
    await Promise.all(requeueBuilds.map((build) => queues.enqueue('build', build.id, { workspaceId: build.workspaceId, format: build.format })));
    await Promise.all(requeueCaptures.map((capture) => queues.enqueue('capture', capture.id, { serial: capture.serial, sessionId: capture.sessionId })));
    await debugSessions.cleanupExpired();
    await billingMeter.flushUsage(Number(process.env.BILLING_BATCH_SIZE || 100));

    for (const session of expiredSessions) {
      if (session.userEmail) {
        notifications.sendEmail({
          userId: session.userId,
          organizationId: session.organizationId || null,
          type: 'session.expired',
          recipient: session.userEmail,
          subject: 'Your Singh Cloud Emulator session ended',
          body: `Session ${session.id} reached its configured time limit and was stopped.`
        }).catch(() => {});
      }
    }
  } finally {
    running = false;
  }
}

function startScheduler() {
  if (timer) return timer;
  const interval = Math.max(5_000, Number(process.env.SCHEDULER_SWEEP_MS || 10_000));
  timer = setInterval(() => sweep().catch((error) => console.error('Scheduler sweep failed:', error)), interval);
  timer.unref();
  sweep().catch((error) => console.error('Initial scheduler sweep failed:', error));
  return timer;
}

module.exports = { startScheduler, sweep };
