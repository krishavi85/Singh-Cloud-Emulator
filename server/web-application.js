const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const express = require('express');
const helmet = require('helmet');
const multer = require('multer');
const auth = require('./auth');
const metrics = require('./metrics');
const { audit, auditRequest, requestIdMiddleware } = require('./audit');
const { apiLimiter, loginLimiter } = require('./rate-limits');
const { startRetention } = require('./retention');
const { registerApiRoutes } = require('./api-routes');
const { registerPublicBillingWebhook } = require('./billing-routes');
const { report: systemReport } = require('./system-routes');

function secureTokenEqual(received, expected) {
  const left = Buffer.from(String(received || ''));
  const right = Buffer.from(String(expected || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function metricsAuthorized(req) {
  const expected = process.env.METRICS_BEARER_TOKEN || '';
  if (!expected) return process.env.NODE_ENV !== 'production' || String(process.env.METRICS_PUBLIC || 'false').toLowerCase() === 'true';
  const header = String(req.get('authorization') || '');
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return Boolean(match && secureTokenEqual(match[1].trim(), expected));
}

function frameAncestors() {
  const configured = String(process.env.EMBED_ALLOWED_ORIGINS || '').split(',').map((item) => item.trim()).filter(Boolean);
  return configured.length ? ["'self'", ...configured] : ["'none'"];
}

function parseAsJson(req) {
  const rawCapturePath = /^\/api\/platform\/workers\/captures\/[^/]+\/har$/;
  if (rawCapturePath.test(req.path)) return false;
  return Boolean(req.is('application/json'));
}

function createApplication() {
  auth.assertAuthConfiguration();

  const app = express();
  const server = http.createServer(app);
  const publicDir = path.resolve(__dirname, '..', 'public');
  const uploadsDir = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'));
  const auditDir = path.resolve(process.env.AUDIT_LOG_DIR || path.join(__dirname, '..', 'data', 'audit'));
  const maxApkSizeMb = Math.min(2048, Math.max(1, Number(process.env.MAX_APK_SIZE_MB || 500)));

  fs.mkdirSync(uploadsDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(auditDir, { recursive: true, mode: 0o700 });

  const upload = multer({
    storage: multer.diskStorage({
      destination(req, _file, callback) {
        const directory = path.join(uploadsDir, req.user.id);
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        callback(null, directory);
      },
      filename(req, _file, callback) {
        callback(null, `${req.requestId}-${crypto.randomUUID()}.apk`);
      }
    }),
    limits: { fileSize: maxApkSizeMb * 1024 * 1024, files: 1, fields: 4 },
    fileFilter(_req, file, callback) {
      const validName = file.originalname.toLowerCase().endsWith('.apk');
      const validMime = ['application/vnd.android.package-archive', 'application/octet-stream'].includes(file.mimetype);
      callback(validName && validMime ? null : new Error('Only Android APK files are accepted.'), validName && validMime);
    }
  });

  app.disable('x-powered-by');
  app.set('trust proxy', Number(process.env.TRUST_PROXY || 1));
  app.use(requestIdMiddleware);
  app.use(metrics.middleware);
  app.use(helmet({
    crossOriginEmbedderPolicy: false,
    frameguard: false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        fontSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: frameAncestors(),
        imgSrc: ["'self'", 'data:', 'blob:'],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"]
      }
    },
    hsts: process.env.NODE_ENV === 'production'
      ? { maxAge: 31536000, includeSubDomains: true, preload: true }
      : false
  }));
  app.use(cors({ origin: false }));
  app.use(express.json({
    limit: '1mb',
    type: parseAsJson,
    verify(req, _res, buffer) {
      req.rawBody = Buffer.from(buffer);
    }
  }));
  app.use(cookieParser());

  app.use((req, res, next) => {
    const required = process.env.NODE_ENV === 'production' && String(process.env.REQUIRE_HTTPS ?? 'true').toLowerCase() === 'true';
    if (!required || req.secure || req.get('x-forwarded-proto') === 'https' || req.path === '/api/health') return next();
    return res.status(426).json({ ok: false, error: 'HTTPS is required.' });
  });

  app.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.path === '/api/webhooks/lago') return next();
    if (/^Bearer\s+/i.test(String(req.get('authorization') || ''))) return next();
    const expected = process.env.PUBLIC_ORIGIN || `${req.protocol}://${req.get('host')}`;
    if (req.get('origin') !== expected) return res.status(403).json({ ok: false, error: 'Request origin rejected.' });
    return next();
  });

  app.get('/api/health', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, service: 'singh-cloud-emulator', version: process.env.npm_package_version || '0.5.0' });
  });

  app.get('/api/ready', async (_req, res) => {
    try {
      const body = await systemReport();
      res.setHeader('Cache-Control', 'no-store');
      res.status(body.ready ? 200 : 503).json({ ok: body.ready, checkedAt: body.checkedAt });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  app.get('/metrics', (req, res, next) => {
    if (!metricsAuthorized(req)) return res.status(404).end();
    return metrics.endpoint(req, res, next);
  });

  app.get('/login', (_req, res) => res.sendFile(path.join(publicDir, 'login.html')));
  app.get('/login.js', (_req, res) => res.sendFile(path.join(publicDir, 'login.js')));
  app.get('/styles.css', (_req, res) => res.sendFile(path.join(publicDir, 'styles.css')));
  registerPublicBillingWebhook(app);

  app.post('/api/auth/login', loginLimiter, async (req, res, next) => {
    try {
      const email = String(req.body.email || '').trim().toLowerCase();
      const user = await auth.authenticateCredentials(email, req.body.password);
      if (!user) {
        await audit({ requestId: req.requestId, ip: req.ip, email, action: 'auth.login', outcome: 'denied' });
        return res.status(401).json({ ok: false, error: 'Invalid email or password.' });
      }
      auth.issueSession(res, user);
      req.user = user;
      await auditRequest(req, 'auth.login');
      return res.json({ ok: true, user: auth.publicUser(user) });
    } catch (error) {
      return next(error);
    }
  });

  app.use(auth.requireAuth);
  app.use('/api', apiLimiter);

  app.get('/api/auth/me', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, user: auth.publicUser(req.user) });
  });

  app.post('/api/auth/logout', async (req, res, next) => {
    try {
      await auditRequest(req, 'auth.logout');
      auth.clearSession(res);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  registerApiRoutes({ app, upload });
  app.use(express.static(publicDir, { index: 'index.html', maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));

  app.use((error, req, res, _next) => {
    const status = error instanceof multer.MulterError ? 400 : Number(error.status || 500);
    auditRequest(req, 'request.error', 'failure', {
      method: req.method,
      path: req.path,
      status,
      message: error.message
    }).catch(() => {});
    if (status >= 500) console.error(error);
    const message = status >= 500 && process.env.NODE_ENV === 'production' ? 'Request could not be completed.' : error.message;
    res.status(status).json({ ok: false, error: message || 'Unexpected server error.', requestId: req.requestId });
  });

  startRetention({
    uploadsDir,
    auditDir,
    onCleanup: (details) => audit({ action: 'retention.cleanup', outcome: 'success', details })
  });

  return { app, server, uploadsDir, auditDir };
}

module.exports = { createApplication };
