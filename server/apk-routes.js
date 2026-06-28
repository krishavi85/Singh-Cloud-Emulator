const fs = require('node:fs');
const path = require('node:path');
const adb = require('./adb');
const { auditRequest } = require('./audit');
const { scanApk } = require('./apk-scanner');
const { uploadLimiter } = require('./rate-limits');
const { resolveSerial } = require('./device-routes');
const { sendToUser } = require('./websocket-auth');

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function registerApkRoutes(app, upload) {
  app.post('/api/apk/install', uploadLimiter, upload.single('apk'), async (req, res, next) => {
    try {
      if (!req.file) throw httpError(400, 'Choose an APK file first.');
      const serial = await resolveSerial(req.user, req.body.serial);
      const originalName = path.basename(req.file.originalname);
      sendToUser(req.user.id, { type: 'install', status: 'scanning', file: originalName });

      try {
        const scan = await scanApk(req.file.path);
        await auditRequest(req, 'apk.scan', scan.clean ? 'success' : 'denied', {
          serial,
          file: originalName,
          sha256: scan.sha256,
          engine: scan.engine,
          result: scan.result
        });
        if (!scan.clean) throw httpError(422, 'APK failed security scanning and was rejected.');

        sendToUser(req.user.id, { type: 'install', status: 'installing', file: originalName });
        const result = await adb.installApk(serial, req.file.path);
        await auditRequest(req, 'apk.install', 'success', {
          serial,
          file: originalName,
          sha256: scan.sha256
        });
        sendToUser(req.user.id, { type: 'install', status: 'completed', file: originalName });
        res.json({
          ok: true,
          sha256: scan.sha256,
          output: `${result.stdout || ''}${result.stderr || ''}`.trim()
        });
      } finally {
        fs.rm(req.file.path, { force: true }, () => {});
      }
    } catch (error) {
      if (req.file?.path) fs.rm(req.file.path, { force: true }, () => {});
      next(error);
    }
  });
}

module.exports = { registerApkRoutes };
