const { rateLimit } = require('express-rate-limit');

function numberFromEnv(name, fallback, minimum, maximum) {
  const value = Number(process.env[name] || fallback);
  return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : fallback));
}

function buildLimiter({ windowMs, limit, message, skipSuccessfulRequests = false, perUser = false }) {
  const options = {
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests,
    handler: (_req, res) => res.status(429).json({ ok: false, error: message })
  };
  if (perUser) options.keyGenerator = (req) => `user:${req.user.id}`;
  return rateLimit(options);
}

const apiLimiter = buildLimiter({
  windowMs: 15 * 60 * 1000,
  limit: numberFromEnv('API_RATE_LIMIT', 600, 30, 10_000),
  message: 'Too many API requests. Try again later.',
  perUser: true
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
  message: 'APK upload limit reached. Try again later.',
  perUser: true
});

const controlLimiter = buildLimiter({
  windowMs: 60 * 1000,
  limit: numberFromEnv('CONTROL_RATE_LIMIT', 300, 30, 3000),
  message: 'Device control rate limit reached.',
  perUser: true
});

module.exports = { apiLimiter, controlLimiter, loginLimiter, uploadLimiter };
