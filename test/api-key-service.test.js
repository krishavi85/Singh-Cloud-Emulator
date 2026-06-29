const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const dataRoot = path.join(os.tmpdir(), `sce-key-test-${process.pid}`);
process.env.PLATFORM_DATA_FILE = path.join(dataRoot, 'platform.json');
delete process.env.DATABASE_URL;

const apiKeys = require('../server/api-key-service');

test.after(async () => {
  await fs.rm(dataRoot, { recursive: true, force: true });
});

test('service keys are hashed, scoped and revocable', async () => {
  const owner = { id: 'admin-1', role: 'admin', organizationId: 'org-1' };
  const created = await apiKeys.createApiKey(owner, { name: 'Worker', scopes: ['workers:read', 'workers:write'] });
  assert.match(created.token, /^sce_live_/);
  assert.notEqual(created.record.tokenHash, created.token);

  const service = await apiKeys.authenticateApiKey(created.token);
  assert.equal(service.serviceAccount, true);
  assert.deepEqual(service.scopes, ['workers:read', 'workers:write']);
  assert.equal(apiKeys.requireScope(service, 'workers:write'), true);
  assert.throws(() => apiKeys.requireScope(service, 'builds:write'));

  await apiKeys.revokeApiKey(owner, created.record.id);
  assert.equal(await apiKeys.authenticateApiKey(created.token), null);
});
