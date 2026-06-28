const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'sce_session';
let cachedUsers = null;

function parseUsers() {
  if (cachedUsers) return cachedUsers;

  let raw = process.env.USERS_JSON;
  if (!raw && process.env.AUTH_USERS_FILE) {
    raw = fs.readFileSync(path.resolve(process.env.AUTH_USERS_FILE), 'utf8');
  }
  if (!raw) throw new Error('USERS_JSON or AUTH_USERS_FILE must be configured.');

  const users = JSON.parse(raw);
  if (!Array.isArray(users) || users.length === 0) throw new Error('At least one user must be configured.');

  cachedUsers = users.map((user) => {
    const normalized = {
      id: String(user.id || '').trim(),
      email: String(user.email || '').trim().toLowerCase(),
      passwordHash: String(user.passwordHash || ''),
      role: user.role === 'admin' ? 'admin' : 'user',
      devices: Array.isArray(user.devices) ? user.devices.map(String) : []
    };
    if (!/^[A-Za-z0-9_-]{2,64}$/.test(normalized.id)) throw new Error(`Invalid user id: ${normalized.id}`);
    if (!normalized.email.includes('@')) throw new Error(`Invalid user email: ${normalized.email}`);
    if (!/^\$2[aby]\$/.test(normalized.passwordHash)) throw new Error(`User ${normalized.email} must use a bcrypt password hash.`);
    if (process.env.NODE_ENV === 'production' && normalized.devices.length === 0) {
      throw new Error(`Production user ${normalized.email} must have at least one assigned device.`);
    }
    return normalized;
  });

  return cachedUsers;
}

function jwtSecret() {
  const secret = process.env.JWT_SECRET || '';
  if (secret.length < 32) throw new Error('JWT_SECRET must contain at least 32 characters.');
  return secret;
}

function assertAuthConfiguration() {
  jwtSecret();
  parseUsers();
  if (process.env.NODE_ENV === 'production' && String(process.env.COOKIE_SECURE).toLowerCase() !== 'true') {
    throw new Error('COOKIE_SECURE=true is required in production.');
  }
}

function cookieOptions() {
  const ttlMinutes = Math.min(1440, Math.max(15, Number(process.env.JWT_TTL_MINUTES || 480)));
  return {
    httpOnly: true,
    secure: String(process.env.COOKIE_SECURE).toLowerCase() === 'true',
    sameSite: 'strict',
    path: '/',
    maxAge: ttlMinutes * 60 * 1000
  };
}

function publicUser(user) {
  return { id: user.id, email: user.email, role: user.role, devices: user.devices };
}

async function authenticateCredentials(email, password) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const user = parseUsers().find((candidate) => candidate.email === normalizedEmail);
  if (!user) return null;
  const valid = await bcrypt.compare(String(password || ''), user.passwordHash);
  return valid ? user : null;
}

function issueSession(res, user) {
  const ttlMinutes = Math.min(1440, Math.max(15, Number(process.env.JWT_TTL_MINUTES || 480)));
  const token = jwt.sign(
    { sub: user.id, email: user.email, role: user.role, devices: user.devices },
    jwtSecret(),
    {
      algorithm: 'HS256',
      expiresIn: `${ttlMinutes}m`,
      issuer: 'singh-cloud-emulator',
      audience: 'singh-cloud-emulator-web'
    }
  );
  res.cookie(COOKIE_NAME, token, cookieOptions());
}

function clearSession(res) {
  res.clearCookie(COOKIE_NAME, { ...cookieOptions(), maxAge: undefined });
}

function parseCookieHeader(header = '') {
  return Object.fromEntries(
    header.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
      const index = part.indexOf('=');
      return [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))];
    })
  );
}

function verifyToken(token) {
  const payload = jwt.verify(token, jwtSecret(), {
    algorithms: ['HS256'],
    issuer: 'singh-cloud-emulator',
    audience: 'singh-cloud-emulator-web'
  });
  const user = parseUsers().find((candidate) => candidate.id === payload.sub && candidate.email === payload.email);
  if (!user) throw new Error('Session user no longer exists.');
  return user;
}

function unauthorized(req, res, message) {
  const isPage = req.method === 'GET' && !req.originalUrl.startsWith('/api/') && req.accepts('html');
  if (isPage) return res.redirect('/login');
  return res.status(401).json({ ok: false, error: message });
}

function requireAuth(req, res, next) {
  try {
    const token = req.cookies?.[COOKIE_NAME];
    if (!token) return unauthorized(req, res, 'Authentication required.');
    req.user = verifyToken(token);
    next();
  } catch {
    clearSession(res);
    unauthorized(req, res, 'Session expired or invalid.');
  }
}

function authenticateUpgrade(request) {
  const cookies = parseCookieHeader(request.headers.cookie || '');
  const token = cookies[COOKIE_NAME];
  if (!token) throw new Error('Authentication required.');
  return verifyToken(token);
}

module.exports = {
  assertAuthConfiguration,
  authenticateCredentials,
  authenticateUpgrade,
  clearSession,
  issueSession,
  publicUser,
  requireAuth
};
