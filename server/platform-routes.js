const crypto = require('node:crypto');
const path = require('node:path');
const store = require('./platform-store');
const workspace = require('./workspace-service');
const automation = require('./automation-recorder');
const adbFeatures = require('./adb-features');
const { auditRequest } = require('./audit');
const { resolveSerial } = require('./device-routes');

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function assertAdmin(user) {
  if (user.role !== 'admin') throw httpError(403, 'Administrator access required.');
}

function findOwned(collection, id, user, label) {
  const record = collection.find((item) => item.id === id && store.owned(item, user));
  if (!record) throw httpError(404, `${label} not found.`);
  return record;
}

function activeSessions(state, userId) {
  return state.sessions.filter((session) => session.userId === userId && ['queued', 'starting', 'running'].includes(session.status));
}

function registerPlatformRoutes(app) {
  app.get('/api/platform/capabilities', (_req, res) => {
    res.json({
      platform: 'Singh Cloud Emulator',
      version: '0.3.0',
      capabilities: {
        androidStreaming: 'implemented-png',
        webRtcStreaming: 'worker-adapter-required',
        deviceProfiles: 'implemented',
        cloudSessions: 'implemented-control-plane',
        shareLinks: 'implemented',
        iframeEmbedding: 'implemented',
        uiAutomation: 'implemented',
        logcat: 'implemented',
        diagnostics: 'implemented',
        mockLocation: 'implemented-emulator',
        mockLocale: 'implemented',
        darkMode: 'implemented',
        fontScale: 'implemented',
        batterySimulation: 'implemented-emulator',
        connectivitySimulation: 'implemented',
        biometricSimulation: 'implemented-emulator',
        permissionControls: 'implemented',
        deepLinks: 'implemented',
        networkHarCapture: 'proxy-worker-required',
        iosSimulation: 'not-supported',
        codeWorkspaces: 'implemented',
        kotlinGradleBuilds: 'external-build-worker-required',
        apkAabArtifacts: 'implemented-control-plane',
        sourceDebugger: 'debug-adapter-required',
        layoutInspector: 'worker-adapter-required',
        profiling: 'diagnostics-foundation',
        organizationsPlansUsage: 'implemented-foundation'
      }
    });
  });

  app.get('/api/platform/profiles', asyncRoute(async (req, res) => {
    const state = await store.readState();
    res.json({ profiles: state.profiles.filter((profile) => profile.enabled || req.user.role === 'admin') });
  }));

  app.post('/api/platform/profiles', asyncRoute(async (req, res) => {
    assertAdmin(req.user);
    const input = req.body || {};
    const profile = {
      id: String(input.id || store.id('profile')).replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 100),
      name: String(input.name || 'Android device').slice(0, 120),
      platform: String(input.platform || 'android').slice(0, 40),
      apiLevel: Math.max(21, Math.min(99, Number(input.apiLevel || 35))),
      width: Math.max(240, Math.min(8192, Number(input.width || 1080))),
      height: Math.max(240, Math.min(8192, Number(input.height || 2400))),
      density: Math.max(80, Math.min(1000, Number(input.density || 420))),
      orientation: input.orientation === 'landscape' ? 'landscape' : 'portrait',
      workerImage: String(input.workerImage || '').slice(0, 300),
      enabled: input.enabled !== false
    };
    await store.transact((state) => {
      if (state.profiles.some((item) => item.id === profile.id)) throw httpError(409, 'Profile ID already exists.');
      state.profiles.push(profile);
      return profile;
    });
    await auditRequest(req, 'profile.create', 'success', { profileId: profile.id });
    res.status(201).json({ profile });
  }));

  app.get('/api/platform/sessions', asyncRoute(async (req, res) => {
    const state = await store.readState();
    const sessions = state.sessions.filter((session) => store.owned(session, req.user));
    res.json({ sessions });
  }));

  app.post('/api/platform/sessions', asyncRoute(async (req, res) => {
    const input = req.body || {};
    const created = await store.transact((state) => {
      const profile = state.profiles.find((item) => item.id === input.profileId && item.enabled);
      if (!profile) throw httpError(404, 'Device profile not found.');
      const plan = state.plans.find((item) => item.id === String(input.planId || 'free')) || state.plans[0];
      if (activeSessions(state, req.user.id).length >= plan.concurrentSessions) throw httpError(429, 'Concurrent session limit reached.');
      const durationMinutes = Math.max(5, Math.min(480, Number(input.durationMinutes || 30)));
      const serial = input.serial ? String(input.serial) : (req.user.devices?.[0] || '');
      if (serial && !req.user.devices.includes(serial)) throw httpError(403, 'Requested device is not assigned to this account.');
      const session = {
        id: store.id('session'),
        userId: req.user.id,
        profileId: profile.id,
        appId: input.appId ? String(input.appId) : null,
        workspaceId: input.workspaceId ? String(input.workspaceId) : null,
        serial,
        status: serial ? 'running' : 'queued',
        transport: String(input.transport || 'png'),
        createdAt: store.now(),
        startedAt: serial ? store.now() : null,
        expiresAt: new Date(Date.now() + durationMinutes * 60_000).toISOString(),
        endedAt: null,
        metadata: { locale: input.locale || 'en-US', orientation: profile.orientation }
      };
      state.sessions.push(session);
      state.usage.push({ id: store.id('usage'), userId: req.user.id, type: 'session.created', quantity: 1, sessionId: session.id, at: store.now() });
      return session;
    });
    await auditRequest(req, 'session.create', 'success', { sessionId: created.id, profileId: created.profileId });
    res.status(201).json({ session: created });
  }));

  app.post('/api/platform/sessions/:id/stop', asyncRoute(async (req, res) => {
    const session = await store.transact((state) => {
      const record = findOwned(state.sessions, req.params.id, req.user, 'Session');
      if (record.status === 'stopped') return record;
      record.status = 'stopped';
      record.endedAt = store.now();
      const started = Date.parse(record.startedAt || record.createdAt);
      const minutes = Math.max(1, Math.ceil((Date.now() - started) / 60_000));
      state.usage.push({ id: store.id('usage'), userId: record.userId, type: 'session.minutes', quantity: minutes, sessionId: record.id, at: store.now() });
      return record;
    });
    await auditRequest(req, 'session.stop', 'success', { sessionId: session.id });
    res.json({ session });
  }));

  app.get('/api/platform/shares', asyncRoute(async (req, res) => {
    const state = await store.readState();
    res.json({ shares: state.shares.filter((share) => store.owned(share, req.user)) });
  }));

  app.post('/api/platform/shares', asyncRoute(async (req, res) => {
    const input = req.body || {};
    const resourceType = ['session', 'app', 'workspace'].includes(input.resourceType) ? input.resourceType : 'session';
    const durationMinutes = Math.max(5, Math.min(43_200, Number(input.durationMinutes || 60)));
    const share = {
      id: store.id('share'),
      token: crypto.randomBytes(24).toString('base64url'),
      userId: req.user.id,
      resourceType,
      resourceId: String(input.resourceId || ''),
      allowEmbed: input.allowEmbed === true,
      allowControl: input.allowControl === true,
      requireAuthentication: input.requireAuthentication === true,
      createdAt: store.now(),
      expiresAt: new Date(Date.now() + durationMinutes * 60_000).toISOString(),
      revokedAt: null
    };
    if (!share.resourceId) throw httpError(400, 'resourceId is required.');
    await store.transact((state) => {
      const collection = resourceType === 'session' ? state.sessions : resourceType === 'app' ? state.apps : state.workspaces;
      findOwned(collection, share.resourceId, req.user, resourceType);
      state.shares.push(share);
      return share;
    });
    await auditRequest(req, 'share.create', 'success', { shareId: share.id, resourceType });
    res.status(201).json({ share, publicPath: `/share/${share.token}`, embedPath: share.allowEmbed ? `/embed/${share.token}` : null });
  }));

  app.delete('/api/platform/shares/:id', asyncRoute(async (req, res) => {
    const share = await store.transact((state) => {
      const record = findOwned(state.shares, req.params.id, req.user, 'Share');
      record.revokedAt = store.now();
      return record;
    });
    await auditRequest(req, 'share.revoke', 'success', { shareId: share.id });
    res.json({ share });
  }));

  app.get('/api/platform/recordings', asyncRoute(async (req, res) => {
    const state = await store.readState();
    res.json({ recordings: state.recordings.filter((recording) => store.owned(recording, req.user)) });
  }));

  app.post('/api/platform/recordings/start', asyncRoute(async (req, res) => {
    const serial = await resolveSerial(req.user, req.body.serial);
    const recording = await automation.startRecording(req.user, req.body.name, serial);
    await auditRequest(req, 'automation.record.start', 'success', { recordingId: recording.id, serial });
    res.status(201).json({ recording });
  }));

  app.post('/api/platform/recordings/stop', asyncRoute(async (req, res) => {
    const recording = await automation.stopRecording(req.user);
    if (!recording) throw httpError(409, 'No active recording.');
    await auditRequest(req, 'automation.record.stop', 'success', { recordingId: recording.id });
    res.json({ recording });
  }));

  app.post('/api/platform/recordings/:id/replay', asyncRoute(async (req, res) => {
    const serial = await resolveSerial(req.user, req.body.serial);
    const result = await automation.replayRecording(req.user, req.params.id, serial, { speed: req.body.speed });
    await auditRequest(req, 'automation.replay', 'success', { recordingId: req.params.id, serial, actions: result.actionCount });
    res.json({ result });
  }));

  app.get('/api/platform/workspaces', asyncRoute(async (req, res) => {
    const state = await store.readState();
    res.json({ workspaces: state.workspaces.filter((item) => store.owned(item, req.user)) });
  }));

  app.post('/api/platform/workspaces', asyncRoute(async (req, res) => {
    const record = {
      id: store.id('workspace'),
      userId: req.user.id,
      name: String(req.body.name || 'Android Project').slice(0, 120),
      description: String(req.body.description || '').slice(0, 1000),
      repositoryUrl: String(req.body.repositoryUrl || '').slice(0, 500),
      branch: String(req.body.branch || 'main').slice(0, 120),
      template: String(req.body.template || 'android-kotlin'),
      createdAt: store.now(),
      updatedAt: store.now()
    };
    await workspace.createWorkspaceFiles(req.user.id, record.id);
    await store.transact((state) => { state.workspaces.push(record); return record; });
    await auditRequest(req, 'workspace.create', 'success', { workspaceId: record.id });
    res.status(201).json({ workspace: record });
  }));

  app.get('/api/platform/workspaces/:id/files', asyncRoute(async (req, res) => {
    const state = await store.readState();
    const record = findOwned(state.workspaces, req.params.id, req.user, 'Workspace');
    const files = await workspace.listFiles(record.userId, record.id);
    res.json({ files });
  }));

  app.get('/api/platform/workspaces/:id/file', asyncRoute(async (req, res) => {
    const state = await store.readState();
    const record = findOwned(state.workspaces, req.params.id, req.user, 'Workspace');
    const content = await workspace.readFile(record.userId, record.id, req.query.path);
    res.json({ path: req.query.path, content });
  }));

  app.put('/api/platform/workspaces/:id/file', asyncRoute(async (req, res) => {
    const state = await store.readState();
    const record = findOwned(state.workspaces, req.params.id, req.user, 'Workspace');
    await workspace.writeFile(record.userId, record.id, req.body.path, req.body.content);
    await store.transact((next) => {
      const current = next.workspaces.find((item) => item.id === record.id);
      if (current) current.updatedAt = store.now();
    });
    await auditRequest(req, 'workspace.file.write', 'success', { workspaceId: record.id, path: req.body.path });
    res.json({ ok: true });
  }));

  app.delete('/api/platform/workspaces/:id', asyncRoute(async (req, res) => {
    const record = await store.transact((state) => {
      const current = findOwned(state.workspaces, req.params.id, req.user, 'Workspace');
      state.workspaces = state.workspaces.filter((item) => item.id !== current.id);
      return current;
    });
    await workspace.deleteWorkspace(record.userId, record.id);
    await auditRequest(req, 'workspace.delete', 'success', { workspaceId: record.id });
    res.json({ ok: true });
  }));

  app.get('/api/platform/builds', asyncRoute(async (req, res) => {
    const state = await store.readState();
    res.json({ builds: state.builds.filter((item) => store.owned(item, req.user)) });
  }));

  app.post('/api/platform/builds', asyncRoute(async (req, res) => {
    const build = await store.transact((state) => {
      const workspaceRecord = findOwned(state.workspaces, req.body.workspaceId, req.user, 'Workspace');
      const format = req.body.format === 'aab' ? 'aab' : 'apk';
      const record = {
        id: store.id('build'),
        userId: req.user.id,
        workspaceId: workspaceRecord.id,
        variant: String(req.body.variant || 'debug').slice(0, 80),
        format,
        status: 'queued',
        workerId: null,
        log: '',
        artifactId: null,
        createdAt: store.now(),
        startedAt: null,
        completedAt: null
      };
      state.builds.push(record);
      return record;
    });
    await auditRequest(req, 'build.queue', 'success', { buildId: build.id, workspaceId: build.workspaceId });
    res.status(202).json({ build });
  }));

  app.post('/api/platform/builds/claim', asyncRoute(async (req, res) => {
    assertAdmin(req.user);
    const build = await store.transact((state) => {
      const queued = state.builds.find((item) => item.status === 'queued');
      if (!queued) return null;
      queued.status = 'building';
      queued.workerId = String(req.body.workerId || 'build-worker').slice(0, 120);
      queued.startedAt = store.now();
      return queued;
    });
    res.json({ build });
  }));

  app.post('/api/platform/builds/:id/complete', asyncRoute(async (req, res) => {
    assertAdmin(req.user);
    const build = await store.transact((state) => {
      const record = state.builds.find((item) => item.id === req.params.id);
      if (!record) throw httpError(404, 'Build not found.');
      record.status = req.body.success === false ? 'failed' : 'completed';
      record.log = String(req.body.log || '').slice(-200_000);
      record.completedAt = store.now();
      if (record.status === 'completed') {
        const artifact = {
          id: store.id('artifact'),
          userId: record.userId,
          buildId: record.id,
          workspaceId: record.workspaceId,
          name: path.basename(String(req.body.name || `app-${record.variant}.${record.format}`)),
          format: record.format,
          storageKey: String(req.body.storageKey || '').slice(0, 500),
          sha256: String(req.body.sha256 || '').slice(0, 64),
          sizeBytes: Math.max(0, Number(req.body.sizeBytes || 0)),
          createdAt: store.now()
        };
        state.artifacts.push(artifact);
        record.artifactId = artifact.id;
      }
      return record;
    });
    await auditRequest(req, 'build.complete', build.status === 'completed' ? 'success' : 'failure', { buildId: build.id });
    res.json({ build });
  }));

  app.get('/api/platform/artifacts', asyncRoute(async (req, res) => {
    const state = await store.readState();
    res.json({ artifacts: state.artifacts.filter((item) => store.owned(item, req.user)) });
  }));

  app.get('/api/platform/apps', asyncRoute(async (req, res) => {
    const state = await store.readState();
    res.json({ apps: state.apps.filter((item) => store.owned(item, req.user)) });
  }));

  app.post('/api/platform/apps', asyncRoute(async (req, res) => {
    const appRecord = {
      id: store.id('app'),
      userId: req.user.id,
      name: String(req.body.name || 'Android App').slice(0, 120),
      packageName: String(req.body.packageName || '').slice(0, 200),
      artifactId: req.body.artifactId ? String(req.body.artifactId) : null,
      iconUrl: String(req.body.iconUrl || '').slice(0, 500),
      createdAt: store.now(),
      updatedAt: store.now()
    };
    await store.transact((state) => { state.apps.push(appRecord); return appRecord; });
    res.status(201).json({ app: appRecord });
  }));

  app.get('/api/platform/plans', asyncRoute(async (_req, res) => {
    const state = await store.readState();
    res.json({ plans: state.plans });
  }));

  app.get('/api/platform/usage', asyncRoute(async (req, res) => {
    const state = await store.readState();
    const records = state.usage.filter((item) => req.user.role === 'admin' || item.userId === req.user.id);
    const summary = records.reduce((acc, item) => {
      acc[item.type] = (acc[item.type] || 0) + Number(item.quantity || 0);
      return acc;
    }, {});
    res.json({ summary, records: records.slice(-1000) });
  }));

  app.get('/api/platform/admin/overview', asyncRoute(async (req, res) => {
    assertAdmin(req.user);
    const state = await store.readState();
    res.json({
      counts: {
        profiles: state.profiles.length,
        sessions: state.sessions.length,
        activeSessions: state.sessions.filter((item) => ['queued', 'starting', 'running'].includes(item.status)).length,
        workspaces: state.workspaces.length,
        builds: state.builds.length,
        queuedBuilds: state.builds.filter((item) => item.status === 'queued').length,
        artifacts: state.artifacts.length,
        apps: state.apps.length,
        shares: state.shares.filter((item) => !item.revokedAt && Date.parse(item.expiresAt) > Date.now()).length
      },
      recentSessions: state.sessions.slice(-25).reverse(),
      recentBuilds: state.builds.slice(-25).reverse()
    });
  }));

  app.get('/api/platform/diagnostics/logcat', asyncRoute(async (req, res) => {
    const serial = await resolveSerial(req.user, req.query.serial);
    const output = await adbFeatures.logcat(serial, { lines: req.query.lines, level: req.query.level, tag: req.query.tag });
    await auditRequest(req, 'diagnostics.logcat', 'success', { serial, lines: req.query.lines });
    res.type('text/plain').send(output);
  }));

  app.delete('/api/platform/diagnostics/logcat', asyncRoute(async (req, res) => {
    const serial = await resolveSerial(req.user, req.body.serial);
    await adbFeatures.clearLogcat(serial);
    await auditRequest(req, 'diagnostics.logcat.clear', 'success', { serial });
    res.json({ ok: true });
  }));

  app.get('/api/platform/diagnostics/package', asyncRoute(async (req, res) => {
    const serial = await resolveSerial(req.user, req.query.serial);
    const diagnostics = await adbFeatures.packageDiagnostics(serial, req.query.packageName);
    res.json({ diagnostics });
  }));

  app.get('/api/platform/diagnostics/network', asyncRoute(async (req, res) => {
    const serial = await resolveSerial(req.user, req.query.serial);
    const diagnostics = await adbFeatures.networkDiagnostics(serial);
    res.json({ diagnostics });
  }));

  app.post('/api/platform/device/deep-link', asyncRoute(async (req, res) => {
    const serial = await resolveSerial(req.user, req.body.serial);
    const output = await adbFeatures.openDeepLink(serial, req.body.url, req.body.packageName);
    await auditRequest(req, 'device.deep-link', 'success', { serial, url: req.body.url, packageName: req.body.packageName });
    res.json({ ok: true, output });
  }));

  app.post('/api/platform/device/location', asyncRoute(async (req, res) => {
    const serial = await resolveSerial(req.user, req.body.serial);
    await adbFeatures.setLocation(serial, req.body.latitude, req.body.longitude, req.body.altitude);
    await auditRequest(req, 'device.mock.location', 'success', { serial, latitude: req.body.latitude, longitude: req.body.longitude });
    res.json({ ok: true });
  }));

  app.post('/api/platform/device/locale', asyncRoute(async (req, res) => {
    const serial = await resolveSerial(req.user, req.body.serial);
    await adbFeatures.setLocale(serial, req.body.locale);
    res.json({ ok: true });
  }));

  app.post('/api/platform/device/dark-mode', asyncRoute(async (req, res) => {
    const serial = await resolveSerial(req.user, req.body.serial);
    await adbFeatures.setDarkMode(serial, req.body.enabled === true);
    res.json({ ok: true });
  }));

  app.post('/api/platform/device/font-scale', asyncRoute(async (req, res) => {
    const serial = await resolveSerial(req.user, req.body.serial);
    await adbFeatures.setFontScale(serial, req.body.scale);
    res.json({ ok: true });
  }));

  app.post('/api/platform/device/battery', asyncRoute(async (req, res) => {
    const serial = await resolveSerial(req.user, req.body.serial);
    await adbFeatures.setBattery(serial, req.body);
    res.json({ ok: true });
  }));

  app.post('/api/platform/device/connectivity', asyncRoute(async (req, res) => {
    const serial = await resolveSerial(req.user, req.body.serial);
    await adbFeatures.setConnectivity(serial, req.body);
    res.json({ ok: true });
  }));

  app.post('/api/platform/device/biometric', asyncRoute(async (req, res) => {
    const serial = await resolveSerial(req.user, req.body.serial);
    await adbFeatures.simulateBiometric(serial, req.body.fingerId);
    res.json({ ok: true });
  }));

  app.post('/api/platform/device/permission', asyncRoute(async (req, res) => {
    const serial = await resolveSerial(req.user, req.body.serial);
    await adbFeatures.setPermission(serial, req.body.packageName, req.body.permission, req.body.grant === true);
    res.json({ ok: true });
  }));

  app.post('/api/platform/device/app-op', asyncRoute(async (req, res) => {
    const serial = await resolveSerial(req.user, req.body.serial);
    await adbFeatures.setAppOps(serial, req.body.packageName, req.body.operation, req.body.mode);
    res.json({ ok: true });
  }));
}

module.exports = { registerPlatformRoutes };
