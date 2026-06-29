function registerPriorityRoutes(app) {
  require('./production-session-routes').registerProductionSessionRoutes(app);
  require('./production-build-routes').registerProductionBuildRoutes(app);
}

module.exports = { registerPriorityRoutes };
