const crypto = require('node:crypto');
const store = require('./platform-store');
const billing = require('./billing-service');

let running = false;

function inferOrganization(state, event) {
  if (event.organizationId) return event.organizationId;
  if (event.sessionId) {
    const session = state.sessions.find((item) => item.id === event.sessionId);
    if (session?.organizationId) return session.organizationId;
  }
  if (event.buildId) {
    const build = state.builds.find((item) => item.id === event.buildId);
    if (build?.organizationId) return build.organizationId;
  }
  const membership = state.memberships.find((item) => item.userId === event.userId && !item.revokedAt);
  return membership?.organizationId || null;
}

function metricCode(type) {
  const codes = {
    'session.minutes': 'session_minutes',
    'session.created': 'session_count',
    'build.minutes': 'build_minutes',
    'build.completed': 'build_count',
    'artifact.bytes': 'storage_bytes',
    'capture.minutes': 'capture_minutes'
  };
  return codes[type] || String(type || '').replace(/[^A-Za-z0-9_.-]/g, '_');
}

async function reserveBatch(limit = 100) {
  return store.transact((state) => {
    const candidates = state.usage
      .filter((item) => !item.billingSentAt && !item.billingReservedAt && Number(item.quantity || 0) >= 0)
      .slice(0, Math.max(1, Math.min(1000, Number(limit || 100))));
    const now = store.now();
    const reserved = [];
    for (const event of candidates) {
      const organizationId = inferOrganization(state, event);
      if (!organizationId) continue;
      event.organizationId = organizationId;
      event.billingTransactionId ||= `usage_${event.id || crypto.randomUUID()}`;
      event.billingReservedAt = now;
      reserved.push({ ...event });
    }
    return reserved;
  });
}

async function markResult(event, error = null) {
  await store.transact((state) => {
    const current = state.usage.find((item) => item.id === event.id);
    if (!current) return;
    current.billingReservedAt = null;
    current.billingAttempts = Number(current.billingAttempts || 0) + 1;
    current.billingLastAttemptAt = store.now();
    if (error) current.billingError = String(error.message || error).slice(0, 2000);
    else {
      current.billingSentAt = store.now();
      current.billingError = null;
    }
  });
}

async function releaseStaleReservations() {
  const cutoff = Date.now() - Math.max(60_000, Number(process.env.BILLING_RESERVATION_TIMEOUT_MS || 10 * 60_000));
  await store.transact((state) => {
    for (const event of state.usage) {
      if (event.billingReservedAt && Date.parse(event.billingReservedAt) < cutoff && !event.billingSentAt) {
        event.billingReservedAt = null;
      }
    }
  });
}

async function flushUsage(limit = 100) {
  if (!billing.configured() || running) return { sent: 0, failed: 0, skipped: true };
  running = true;
  let sent = 0;
  let failed = 0;
  try {
    await releaseStaleReservations();
    const batch = await reserveBatch(limit);
    for (const event of batch) {
      try {
        await billing.sendUsageEvent({
          organizationId: event.organizationId,
          transactionId: event.billingTransactionId,
          code: metricCode(event.type),
          timestamp: Math.floor(Date.parse(event.at || event.occurredAt || store.now()) / 1000),
          properties: {
            quantity: String(event.quantity || 0),
            session_id: event.sessionId || undefined,
            build_id: event.buildId || undefined,
            artifact_id: event.artifactId || undefined,
            user_id: event.userId || undefined
          }
        });
        await markResult(event);
        sent += 1;
      } catch (error) {
        await markResult(event, error);
        failed += 1;
      }
    }
    return { sent, failed, skipped: false };
  } finally {
    running = false;
  }
}

module.exports = { flushUsage, metricCode };
