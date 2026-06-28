const crypto = require('node:crypto');
const { createClient } = require('redis');

let client = null;
let connecting = null;
const memory = new Map();
const memoryLeases = new Map();
const memoryPending = new Set();

function configured() {
  return Boolean(process.env.REDIS_URL);
}

function prefix() {
  return process.env.REDIS_PREFIX || 'sce';
}

async function getClient() {
  if (!configured()) return null;
  if (client?.isReady) return client;
  if (!client) {
    client = createClient({ url: process.env.REDIS_URL });
    client.on('error', (error) => console.error('Redis error:', error));
  }
  if (!connecting) connecting = client.connect().finally(() => { connecting = null; });
  await connecting;
  return client;
}

function queueKey(kind) {
  return `${prefix()}:queue:${kind}`;
}

function leaseKey(kind, id) {
  return `${prefix()}:lease:${kind}:${id}`;
}

function pendingKey(kind, id) {
  return `${prefix()}:pending:${kind}:${id}`;
}

function memoryQueue(kind) {
  if (!memory.has(kind)) memory.set(kind, []);
  return memory.get(kind);
}

async function enqueue(kind, id, payload = {}) {
  const job = {
    id: String(id),
    kind: String(kind),
    payload,
    enqueuedAt: new Date().toISOString(),
    nonce: crypto.randomBytes(8).toString('hex')
  };
  const redis = await getClient();
  if (redis) {
    const acquired = await redis.set(pendingKey(kind, job.id), job.nonce, { NX: true, EX: 86_400 });
    if (!acquired) return null;
    try {
      await redis.rPush(queueKey(kind), JSON.stringify(job));
      return job;
    } catch (error) {
      await redis.del(pendingKey(kind, job.id));
      throw error;
    }
  }
  const pending = `${kind}:${job.id}`;
  if (memoryPending.has(pending)) return null;
  memoryPending.add(pending);
  memoryQueue(kind).push(job);
  return job;
}

async function claim(kind, workerId, leaseSeconds = 120) {
  const redis = await getClient();
  const ttl = Math.max(30, Math.min(7200, Number(leaseSeconds || 120)));
  if (redis) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const raw = await redis.lPop(queueKey(kind));
      if (!raw) return null;
      const job = JSON.parse(raw);
      await redis.del(pendingKey(kind, job.id));
      const lease = {
        ...job,
        workerId: String(workerId),
        claimedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + ttl * 1000).toISOString()
      };
      const acquired = await redis.set(leaseKey(kind, job.id), JSON.stringify(lease), { NX: true, EX: ttl });
      if (acquired) return lease;
    }
    return null;
  }

  const queue = memoryQueue(kind);
  while (queue.length) {
    const job = queue.shift();
    memoryPending.delete(`${kind}:${job.id}`);
    const key = `${kind}:${job.id}`;
    const existing = memoryLeases.get(key);
    if (existing && existing.expiresAt > Date.now()) continue;
    const lease = {
      ...job,
      workerId: String(workerId),
      claimedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString()
    };
    memoryLeases.set(key, { lease, expiresAt: Date.now() + ttl * 1000 });
    return lease;
  }
  return null;
}

async function renew(kind, id, workerId, leaseSeconds = 120) {
  const redis = await getClient();
  const ttl = Math.max(30, Math.min(7200, Number(leaseSeconds || 120)));
  if (redis) {
    const key = leaseKey(kind, id);
    const raw = await redis.get(key);
    if (!raw) return false;
    const lease = JSON.parse(raw);
    if (lease.workerId !== String(workerId)) return false;
    lease.expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    await redis.set(key, JSON.stringify(lease), { XX: true, EX: ttl });
    return true;
  }
  const key = `${kind}:${id}`;
  const entry = memoryLeases.get(key);
  if (!entry || entry.lease.workerId !== String(workerId)) return false;
  entry.expiresAt = Date.now() + ttl * 1000;
  entry.lease.expiresAt = new Date(entry.expiresAt).toISOString();
  return true;
}

async function ack(kind, id, workerId = null) {
  const redis = await getClient();
  if (redis) {
    const key = leaseKey(kind, id);
    if (workerId) {
      const raw = await redis.get(key);
      if (raw && JSON.parse(raw).workerId !== String(workerId)) return false;
    }
    await redis.del(key, pendingKey(kind, id));
    return true;
  }
  const key = `${kind}:${id}`;
  const entry = memoryLeases.get(key);
  if (workerId && entry && entry.lease.workerId !== String(workerId)) return false;
  memoryLeases.delete(key);
  memoryPending.delete(key);
  return true;
}

async function requeue(kind, job, reason = 'retry') {
  await ack(kind, job.id, job.workerId || null);
  return enqueue(kind, job.id, { ...(job.payload || {}), retryReason: reason });
}

async function depth(kind) {
  const redis = await getClient();
  if (redis) return redis.lLen(queueKey(kind));
  return memoryQueue(kind).length;
}

async function health() {
  if (!configured()) return { configured: false, healthy: true, backend: 'memory' };
  try {
    const redis = await getClient();
    const pong = await redis.ping();
    return { configured: true, healthy: pong === 'PONG', backend: 'redis' };
  } catch (error) {
    return { configured: true, healthy: false, backend: 'redis', error: error.message };
  }
}

async function close() {
  if (client?.isOpen) await client.quit();
  client = null;
}

module.exports = { ack, claim, close, configured, depth, enqueue, health, renew, requeue };
