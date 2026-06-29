const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const root = path.join(os.tmpdir(), `sce-storage-test-${process.pid}`);
process.env.ARTIFACT_LOCAL_DIR = root;
delete process.env.S3_ENDPOINT;
delete process.env.S3_ACCESS_KEY_ID;
delete process.env.S3_SECRET_ACCESS_KEY;

const storage = require('../server/object-storage');

test.after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

test('local artifact storage writes, hashes, reads, stats and removes data', async () => {
  const payload = Buffer.from('real artifact bytes');
  const saved = await storage.putBuffer('builds/user-1/build-1/app.apk', payload, 'application/vnd.android.package-archive');
  assert.equal(saved.sizeBytes, payload.length);
  assert.match(saved.sha256, /^[a-f0-9]{64}$/);

  const stat = await storage.stat(saved.key);
  assert.equal(stat.sizeBytes, payload.length);

  const object = await storage.openObject(saved.key);
  assert.equal(Buffer.isBuffer(object.body), true);
  assert.equal(object.body.toString(), payload.toString());

  const download = await storage.presignDownload(saved.key, 'app.apk');
  assert.equal(download.local, true);
  assert.equal(download.proxy, true);

  await storage.remove(saved.key);
  await assert.rejects(() => storage.openObject(saved.key));
});

test('artifact keys reject path traversal', async () => {
  await assert.rejects(() => storage.putBuffer('../outside.apk', Buffer.from('x')), /Invalid object storage key/);
  await assert.rejects(() => storage.putBuffer('builds/../../outside.apk', Buffer.from('x')), /Invalid object storage key/);
});
