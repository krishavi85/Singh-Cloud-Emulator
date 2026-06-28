function registerApiRoutes(options) {
  const deviceRoutes = require('./device-routes');
  const apkRoutes = require('./apk-routes');
  deviceRoutes.registerDeviceRoutes(options.app);
  apkRoutes.registerApkRoutes(options.app, options.upload);
}

module.exports.registerApiRoutes = registerApiRoutes;
