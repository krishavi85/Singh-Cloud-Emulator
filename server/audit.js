const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const auditDir = path.resolve(process.env.AUDIT_LOG_DIR || path.join(__dirname, '..', 'data', 'audit'));
let previousHash = 'GENESIS';
let writeQueue = Promise.resolve();

function redact(value) {
  if (!value || typeof value !== 'object') return value;
  const clone = Array.isArray(value) ? [] : {};
  for (const [key, item] of Object.entries(value)) {
    if (/password|token|secret|cookie|authorization/i.test(key)) clone[key] = '[REDACTED]';
    else if (item && typeof item === 'object') clone[key] = redact(item);
    else clone[key] = item;
  }
  return clone;
}

function key() {
  const value = process.env.AUDIT_HMAC_KEY || '';
  if (process.env.NODE_ENV === 'production' && value.length < 32) {
    throw new Error('AUDIT_HMAC_KEY must contain at least 32 characters in production.');
  }
  return value || 'development-audit-key-change-me';
}

function currentFile() {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(auditDir, `audit-${date}.jsonl`);
}

async function writeAudit(event) {
  const base = {
    timestamp: new Date().toISOString(),
    requestId: event.requestId || null,
    userId: event.userId || null,
    email: event.email || null,
    ip: event.ip || null,
    action: event.action,
    outcome: event.outcome || 'success',
    resource: event.resource || null,
    details: redact(event.details || {}),
    previousHash
  };
  const canonical = JSON.stringify(base);
  const hash = crypto.createHmac('sha256', key()).update(canonical).digest('hex');
  previousHash = hash;
  const record = JSON.stringify({ ...base, hash });
  await fs.mkdir(auditDir, { recursive: true });
  await fs.appendFile(currentFile(), `${record}\n`, { encoding: 'utf8', mode: 0o600 });
}

function audit(event) {
  writeQueue = writeQueue.then(() => writeAudit(event)).catch((error) => {
    console.error('Audit write failed:', error);
  });
  return writeQueue;
}

function requestContext(req) {
  return {
    requestId: req.requestId,
    userId: req.user?.id || null,
    email: req.user?.email || null,
    ip: req.ip
  };
}

function auditRequest(req, action, outcome = 'success', details = {}, resource = null) {
  return audit({ ...requestContext(req), action, outcome, details, resource });
}

function requestIdMiddleware(req, res, next) {
  req.requestId = req.get('x-request-id') || crypto.randomUUID();
  res.setHeader('x-request-id', req.requestId);
  next();
}

module.exports = { audit, auditRequest, requestContext, requestIdMiddleware };
