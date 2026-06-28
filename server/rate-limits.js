const { rateLimit } = require('express-rate-limit');

function numberFromEnv(name, fallback, minimum, maximum) {
  const value = Number(process.env[name] || fallback);
  return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : fallback));
}

function key(req) {
  return req.user?.id ? `user:${req.user.id}` : `ip:${req.ip}`;
}

function buildLimiter({ windowMs, limit, message, skipSuccessfulRequests = false }) {
  return rateLimit({
    windowMs,
    limit,
    keyGenerator: key,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests,
    handler: (_req, res) => res.status(429).json({ ok: false, error: message })
  });
}

const apiLimiter = buildLimiter({
  windowMs: 15 * 60 * 1000,
  limit: numberFromEnv('API_RATE_LIMIT', 600, 30, 10_000),
  message: 'Too many API requests. Try again later.'
});

const loginLimiter = buildLimiter({
  windowMs: 15 * 60 * 1000,
  limit: numberFromEnv('LOGIN_RATE_LIMIT', 8, 3, 100),
  message: 'Too many sign-in attempts. Try again later.',
  skipSuccessfulRequests: true
});

const uploadLimiter = buildLimiter({
  windowMs: 60 * 60 * 1000,
  limit: numberFromEnv('UPLOAD_RATE_LIMIT', 10, 1, 500),
  message: 'APK upload limit reached. Try again later.'
});

const controlLimiter = buildLimiter({
  windowMs: 60 * 1000,
  limit: numberFromEnv('CONTROL_RATE_LIMIT', 300, 30, 3000),
  message: 'Device control rate limit reached.'
});

module.exports = { apiLimiter, controlLimiter, loginLimiter, uploadLimiter };
