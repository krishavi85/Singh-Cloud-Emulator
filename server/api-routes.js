function registerApiRoutes(options) {
  const deviceRoutes = require('./device-routes');
  const apkRoutes = require('./apk-routes');
  const platformRoutes = require('./platform-routes');
  deviceRoutes.registerDeviceRoutes(options.app);
  apkRoutes.registerApkRoutes(options.app, options.upload);
  platformRoutes.registerPlatformRoutes(options.app);
}

module.exports.registerApiRoutes = registerApiRoutes;
