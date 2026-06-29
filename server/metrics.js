const client = require('prom-client');
const store = require('./platform-store');
const queues = require('./queue-service');

const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: 'sce_' });

const httpRequests = new client.Counter({
  name: 'sce_http_requests_total',
  help: 'HTTP requests processed by the control plane.',
  labelNames: ['method', 'route', 'status'],
  registers: [registry]
});

const httpDuration = new client.Histogram({
  name: 'sce_http_request_duration_seconds',
  help: 'HTTP request latency in seconds.',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry]
});

const activeSessions = new client.Gauge({
  name: 'sce_active_sessions',
  help: 'Number of sessions that are queued, starting or running.',
  registers: [registry]
});

const workers = new client.Gauge({
  name: 'sce_workers',
  help: 'Number of registered workers by state and platform.',
  labelNames: ['status', 'platform'],
  registers: [registry]
});

const queueDepth = new client.Gauge({
  name: 'sce_queue_depth',
  help: 'Current job queue depth.',
  labelNames: ['kind'],
  registers: [registry]
});

const builds = new client.Counter({
  name: 'sce_builds_total',
  help: 'Build completions by outcome and format.',
  labelNames: ['outcome', 'format'],
  registers: [registry]
});

const apkScans = new client.Counter({
  name: 'sce_apk_scans_total',
  help: 'APK scans by result.',
  labelNames: ['result'],
  registers: [registry]
});

function routeLabel(req) {
  return req.route?.path || req.baseUrl || req.path || 'unknown';
}

function middleware(req, res, next) {
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const elapsed = Number(process.hrtime.bigint() - started) / 1e9;
    const labels = { method: req.method, route: routeLabel(req), status: String(res.statusCode) };
    httpRequests.inc(labels);
    httpDuration.observe(labels, elapsed);
  });
  next();
}

async function refreshPlatformMetrics() {
  const state = await store.readState();
  activeSessions.set(state.sessions.filter((item) => ['queued', 'starting', 'running'].includes(item.status)).length);
  workers.reset();
  for (const record of state.workers || []) {
    workers.inc({ status: record.status || 'unknown', platform: record.platform || 'unknown' });
  }
  for (const kind of ['session', 'build']) {
    queueDepth.set({ kind }, await queues.depth(kind));
  }
}

async function endpoint(_req, res, next) {
  try {
    await refreshPlatformMetrics();
    res.setHeader('Content-Type', registry.contentType);
    res.send(await registry.metrics());
  } catch (error) {
    next(error);
  }
}

function recordBuild(outcome, format) {
  builds.inc({ outcome: String(outcome), format: String(format || 'unknown') });
}

function recordApkScan(result) {
  apkScans.inc({ result: String(result || 'unknown') });
}

module.exports = { endpoint, middleware, recordApkScan, recordBuild, registry };
