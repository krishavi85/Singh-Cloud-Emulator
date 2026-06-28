const crypto = require('node:crypto');
const store = require('./platform-store');

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function mask(prefix, token) {
  return `${prefix}_${token.slice(0, 6)}…${token.slice(-4)}`;
}

async function createApiKey(owner, input = {}) {
  const environment = input.environment === 'test' ? 'test' : 'live';
  const prefix = environment === 'test' ? 'sce_test' : 'sce_live';
  const secret = crypto.randomBytes(32).toString('base64url');
  const token = `${prefix}_${secret}`;
  const scopes = Array.isArray(input.scopes) && input.scopes.length
    ? [...new Set(input.scopes.map(String))].slice(0, 50)
    : ['workers:read', 'workers:write'];
  const record = {
    id: store.id('key'),
    userId: owner.id,
    organizationId: owner.organizationId || null,
    name: String(input.name || 'API key').slice(0, 120),
    environment,
    tokenHash: hashToken(token),
    tokenHint: mask(prefix, secret),
    scopes,
    role: input.role === 'admin' && owner.role === 'admin' ? 'admin' : 'service',
    createdAt: store.now(),
    lastUsedAt: null,
    expiresAt: input.expiresAt || null,
    revokedAt: null
  };
  await store.transact((state) => {
    state.apiKeys.push(record);
    return record;
  });
  return { record, token };
}

async function authenticateApiKey(token) {
  if (!/^sce_(?:live|test)_[A-Za-z0-9_-]{20,}$/.test(String(token || ''))) return null;
  const tokenHash = hashToken(token);
  const record = await store.transact((state) => {
    const found = state.apiKeys.find((item) => item.tokenHash === tokenHash && !item.revokedAt);
    if (!found) return null;
    if (found.expiresAt && Date.parse(found.expiresAt) <= Date.now()) return null;
    found.lastUsedAt = store.now();
    return { ...found };
  });
  if (!record) return null;
  return {
    id: record.userId || record.id,
    email: `service+${record.id}@singh-cloud.local`,
    role: record.role === 'admin' ? 'admin' : 'service',
    devices: ['*'],
    organizationId: record.organizationId || null,
    apiKeyId: record.id,
    scopes: record.scopes || [],
    serviceAccount: true
  };
}

function requireScope(user, scope) {
  if (user.role === 'admin') return true;
  if (!user.serviceAccount || !Array.isArray(user.scopes) || !user.scopes.includes(scope)) {
    const error = new Error(`API key scope required: ${scope}`);
    error.status = 403;
    throw error;
  }
  return true;
}

async function revokeApiKey(user, id) {
  return store.transact((state) => {
    const key = state.apiKeys.find((item) => item.id === id && (user.role === 'admin' || item.userId === user.id));
    if (!key) throw Object.assign(new Error('API key not found.'), { status: 404 });
    key.revokedAt = store.now();
    return { ...key };
  });
}

async function listApiKeys(user) {
  const state = await store.readState();
  return state.apiKeys
    .filter((item) => user.role === 'admin' || item.userId === user.id)
    .map(({ tokenHash, ...safe }) => safe);
}

module.exports = { authenticateApiKey, createApiKey, listApiKeys, requireScope, revokeApiKey };
