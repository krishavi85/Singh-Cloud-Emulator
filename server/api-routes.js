function registerApiRoutes(options) {
  const deviceRoutes = require('./device-routes');
  const apkRoutes = require('./apk-routes');
  const platformRoutes = require('./platform-routes');
  const automationRoutes = require('./automation-routes');
  const shareRoutes = require('./share-routes');
  const workerRoutes = require('./worker-routes');
  const buildWorkerRoutes = require('./build-worker-routes');
  const artifactRoutes = require('./artifact-routes');
  const workspaceArchiveRoutes = require('./workspace-archive-routes');
  const gitRoutes = require('./git-routes');
  const managementRoutes = require('./management-routes');
  const billingRoutes = require('./billing-routes');
  const systemRoutes = require('./system-routes');
  const developerToolsRoutes = require('./developer-tools-routes');
  const equivalenceRoutes = require('./equivalence-routes');

  deviceRoutes.registerDeviceRoutes(options.app);
  apkRoutes.registerApkRoutes(options.app, options.upload);
  platformRoutes.registerPlatformRoutes(options.app);
  automationRoutes.registerAutomationRoutes(options.app);
  shareRoutes.registerShareRoutes(options.app);
  workerRoutes.registerWorkerRoutes(options.app);
  buildWorkerRoutes.registerBuildWorkerRoutes(options.app);
  artifactRoutes.registerArtifactRoutes(options.app);
  workspaceArchiveRoutes.registerWorkspaceArchiveRoutes(options.app);
  gitRoutes.registerGitRoutes(options.app);
  managementRoutes.registerManagementRoutes(options.app);
  billingRoutes.registerBillingRoutes(options.app);
  systemRoutes.registerSystemRoutes(options.app);
  developerToolsRoutes.registerDeveloperToolsRoutes(options.app);
  equivalenceRoutes.registerEquivalenceRoutes(options.app);
}

module.exports.registerApiRoutes = registerApiRoutes;
