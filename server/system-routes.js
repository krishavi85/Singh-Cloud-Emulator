const os = require('node:os');
const fs = require('node:fs/promises');
const path = require('node:path');
const postgres = require('./postgres-state');
const queue = require('./queue-service');
const storage = require('./object-storage');
const notifications = require('./notification-service');
const billing = require('./billing-service');
const scanner = require('./apk-scanner');
const equivalence = require('./equivalence-services');
const store = require('./platform-store');

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

async function diskHealth() {
  const target = path.resolve(process.env.DATA_ROOT || path.join(__dirname, '..', 'data'));
  try {
    await fs.mkdir(target, { recursive: true, mode: 0o700 });
    const probe = path.join(target, `.health-${process.pid}-${Date.now()}`);
    await fs.writeFile(probe, 'ok', { mode: 0o600 });
    await fs.rm(probe, { force: true });
    return { healthy: true, target };
  } catch (error) {
    return { healthy: false, target, error: error.message };
  }
}

async function report() {
  const [database, redis, objectStorage, smtp, lago, clamav, services, disk] = await Promise.all([
    postgres.health(),
    queue.health(),
    storage.health(),
    notifications.health(),
    billing.health(),
    scanner.health(),
    equivalence.healthReport(),
    diskHealth()
  ]);
  const state = await store.readState();
  const required = {
    database: process.env.NODE_ENV !== 'production' || database.healthy,
    redis: process.env.NODE_ENV !== 'production' || redis.healthy,
    objectStorage: objectStorage.healthy,
    clamav: process.env.NODE_ENV !== 'production' || clamav.healthy,
    disk: disk.healthy
  };
  const ready = Object.values(required).every(Boolean);
  return {
    ok: ready,
    ready,
    version: process.env.npm_package_version || '0.5.0',
    stateBackend: store.backend(),
    uptimeSeconds: Math.floor(process.uptime()),
    host: {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      loadAverage: os.loadavg(),
      freeMemoryBytes: os.freemem(),
      totalMemoryBytes: os.totalmem()
    },
    counts: {
      sessions: state.sessions.length,
      activeSessions: state.sessions.filter((item) => ['queued', 'starting', 'running'].includes(item.status)).length,
      workers: state.workers.length,
      builds: state.builds.length,
      queuedBuilds: state.builds.filter((item) => item.status === 'queued').length,
      artifacts: state.artifacts.length,
      organizations: state.organizations.length
    },
    dependencies: { database, redis, objectStorage, smtp, lago, clamav, disk, services },
    checkedAt: new Date().toISOString()
  };
}

function registerSystemRoutes(app) {
  app.get('/api/platform/system/health', asyncRoute(async (req, res) => {
    if (req.user.role !== 'admin' && !req.user.serviceAccount) return res.status(403).json({ ok: false, error: 'Administrator access required.' });
    const body = await report();
    res.status(body.ready ? 200 : 503).json(body);
  }));

  app.get('/api/platform/system/readiness', asyncRoute(async (_req, res) => {
    const body = await report();
    res.status(body.ready ? 200 : 503).json({ ok: body.ready, checkedAt: body.checkedAt });
  }));
}

module.exports = { registerSystemRoutes, report };
