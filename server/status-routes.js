const store = require('./platform-store');

function registerStatusRoutes(app) {
  app.get('/api/platform/capabilities', (_req, res) => {
    res.json({
      platform: 'Singh Cloud Emulator',
      version: '0.5.0',
      stateBackend: store.backend(),
      capabilities: {
        androidStreaming: 'png-and-cuttlefish-webrtc',
        appleStreaming: 'xcuitest-mjpeg',
        cloudSessions: 'leased-workers-with-recovery',
        buildExecution: 'gradle-apk-aab-worker',
        artifacts: 's3-compatible',
        automation: 'recorder-appium-uiautomator2-xcuitest',
        trafficInspection: 'isolated-mitmproxy-har',
        profiling: 'perfetto-simpleperf-heap',
        developerAttach: 'jdwp-dap',
        workspaces: 'editor-git-builds',
        persistence: 'postgresql-with-local-fallback',
        queues: 'redis-with-memory-fallback',
        organizations: 'roles-memberships-plans',
        billing: 'self-hosted-lago',
        notifications: 'smtp-and-in-app',
        serviceAuthentication: 'scoped-api-keys',
        observability: 'prometheus-health-readiness-audit'
      }
    });
  });
}

module.exports = { registerStatusRoutes };
