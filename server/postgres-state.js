const { Pool } = require('pg');

let pool = null;
let initialized = false;

function configured() {
  return Boolean(process.env.DATABASE_URL);
}

function getPool() {
  if (!configured()) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Math.max(2, Number(process.env.DATABASE_POOL_MAX || 10)),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ssl: String(process.env.DATABASE_SSL || 'false').toLowerCase() === 'true'
        ? { rejectUnauthorized: String(process.env.DATABASE_SSL_REJECT_UNAUTHORIZED || 'true').toLowerCase() === 'true' }
        : undefined
    });
    pool.on('error', (error) => console.error('PostgreSQL pool error:', error));
  }
  return pool;
}

async function ensureInitialized(seedState) {
  if (!configured() || initialized) return;
  const client = await getPool().connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS sce_platform_state (
        state_key text PRIMARY KEY,
        version bigint NOT NULL DEFAULT 1,
        document jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(
      `INSERT INTO sce_platform_state (state_key, document)
       VALUES ('primary', $1::jsonb)
       ON CONFLICT (state_key) DO NOTHING`,
      [JSON.stringify(seedState)]
    );
    initialized = true;
  } finally {
    client.release();
  }
}

async function readState(seedState, normalizeState) {
  await ensureInitialized(seedState);
  const result = await getPool().query(
    `SELECT document FROM sce_platform_state WHERE state_key = 'primary'`
  );
  if (!result.rows[0]) throw new Error('PostgreSQL platform state row is missing.');
  return normalizeState(result.rows[0].document);
}

async function writeState(state, seedState, normalizeState) {
  await ensureInitialized(seedState);
  const normalized = normalizeState(state);
  await getPool().query(
    `UPDATE sce_platform_state
     SET document = $1::jsonb, version = version + 1, updated_at = now()
     WHERE state_key = 'primary'`,
    [JSON.stringify(normalized)]
  );
}

async function transact(seedState, normalizeState, mutator) {
  await ensureInitialized(seedState);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT document FROM sce_platform_state
       WHERE state_key = 'primary'
       FOR UPDATE`
    );
    if (!result.rows[0]) throw new Error('PostgreSQL platform state row is missing.');
    const state = normalizeState(result.rows[0].document);
    const value = await mutator(state);
    await client.query(
      `UPDATE sce_platform_state
       SET document = $1::jsonb, version = version + 1, updated_at = now()
       WHERE state_key = 'primary'`,
      [JSON.stringify(normalizeState(state))]
    );
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function health() {
  if (!configured()) return { configured: false, healthy: false, backend: 'json' };
  try {
    const result = await getPool().query('SELECT now() AS now');
    return { configured: true, healthy: true, backend: 'postgresql', serverTime: result.rows[0].now };
  } catch (error) {
    return { configured: true, healthy: false, backend: 'postgresql', error: error.message };
  }
}

async function close() {
  if (pool) await pool.end();
  pool = null;
  initialized = false;
}

module.exports = { close, configured, health, readState, transact, writeState };
