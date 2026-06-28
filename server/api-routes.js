function registerApiRoutes(options) {
  const deviceRoutes = require('./device-routes');
  const apkRoutes = require('./apk-routes');
  const platformRoutes = require('./platform-routes');
  const automationRoutes = require('./automation-routes');
  const shareRoutes = require('./share-routes');
  deviceRoutes.registerDeviceRoutes(options.app);
  apkRoutes.registerApkRoutes(options.app, options.upload);
  platformRoutes.registerPlatformRoutes(options.app);
  automationRoutes.registerAutomationRoutes(options.app);
  shareRoutes.registerShareRoutes(options.app);
}

module.exports.registerApiRoutes = registerApiRoutes;
