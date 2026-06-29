const store = require('./platform-store');
const postgres = require('./postgres-state');
const queues = require('./queue-service');
const storage = require('./object-storage');
const billing = require('./billing-service');
const notifications = require('./notification-service');
const integrations = require('./equivalence-services');

function online(worker) {
  if (worker.status === 'offline') return false;
  const heartbeat = Date.parse(worker.lastHeartbeatAt || worker.registeredAt || 0);
  const staleMs = Math.max(30_000, Number(process.env.WORKER_STALE_MS || 90_000));
  return Boolean(heartbeat && Date.now() - heartbeat <= staleMs);
}

function stateOf(available, configured = true) {
  if (available) return 'available';
  return configured ? 'configured-but-offline' : 'not-configured';
}

function registerStatusRoutes(app) {
  app.get('/api/platform/capabilities', async (req, res, next) => {
    try {
      const state = await store.readState();
      const workers = state.workers.filter(online);
      const serviceReport = await integrations.healthReport();
      const [database, queue, objectStorage, billingStatus, notificationStatus] = await Promise.all([
        postgres.health(),
        queues.health(),
        storage.health(),
        billing.health(),
        notifications.health()
      ]);

      const androidWorkers = workers.filter((worker) => ['android', 'any'].includes(worker.platform));
      const appleWorkers = workers.filter((worker) => ['ios', 'ipados', 'any'].includes(worker.platform));
      const activeCaptures = state.networkCaptures.filter((capture) => ['starting', 'running', 'stopping'].includes(capture.status));
      const activeBuilds = state.builds.filter((build) => build.status === 'building');

      res.json({
        platform: 'Singh Cloud Emulator',
        version: process.env.npm_package_version || '0.5.0',
        checkedAt: new Date().toISOString(),
        capabilities: {
          localAndroidControl: {
            codeAvailable: true,
            assignedDevices: req.user.devices?.length || 0,
            status: req.user.devices?.length ? 'configured' : 'not-configured'
          },
          androidCloudRuntime: {
            codeAvailable: true,
            onlineWorkers: androidWorkers.length,
            status: stateOf(androidWorkers.length > 0, Boolean(process.env.CUTTLEFISH_WEBRTC_BASE_URL))
          },
          appleSimulatorRuntime: {
            codeAvailable: true,
            onlineWorkers: appleWorkers.length,
            requiresAppleHardware: true,
            status: stateOf(appleWorkers.length > 0, Boolean(process.env.IOS_SIMULATOR_BASE_URL))
          },
          gradleBuilds: {
            codeAvailable: true,
            activeBuilds: activeBuilds.length,
            queuedBuilds: state.builds.filter((build) => build.status === 'queued').length,
            androidSdkConfigured: Boolean(process.env.ANDROID_COMMANDLINE_TOOLS_URL || process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT),
            status: activeBuilds.length ? 'available' : 'worker-required'
          },
          trafficCapture: {
            codeAvailable: true,
            activeCaptures: activeCaptures.length,
            status: activeCaptures.length ? 'available' : 'worker-required'
          },
          automation: {
            recorderAvailable: true,
            appium: serviceReport.appium
          },
          cloudIde: serviceReport.ide,
          profilerUi: serviceReport.profiler,
          debugAdapter: serviceReport.debugger,
          persistence: {
            backend: store.backend(),
            database,
            queue
          },
          artifactStorage: objectStorage,
          billing: billingStatus,
          notifications: notificationStatus,
          organizations: { codeAvailable: true },
          scopedServiceKeys: { codeAvailable: true },
          auditLogging: { codeAvailable: true }
        }
      });
    } catch (error) {
      next(error);
    }
  });
}

module.exports = { registerStatusRoutes };
