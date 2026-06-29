const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const root = path.join(os.tmpdir(), `sce-workspace-test-${process.pid}`);
process.env.WORKSPACE_ROOT = root;
const workspace = require('../server/workspace-service');

test.after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

test('workspace paths cannot escape the sandbox', () => {
  assert.throws(() => workspace.resolveFile('user-1', 'workspace-1', '../secret.txt'), /Invalid workspace path/);
  assert.throws(() => workspace.resolveFile('user-1', 'workspace-1', '/../../secret.txt'), /Invalid workspace path/);
});

test('workspace files can be created, listed, read and updated', async () => {
  await workspace.createWorkspaceFiles('user-1', 'workspace-1');
  const files = await workspace.listFiles('user-1', 'workspace-1');
  assert.ok(files.includes('app/src/main/AndroidManifest.xml'));
  assert.ok(files.includes('app/src/main/java/com/singh/cloudapp/MainActivity.kt'));

  await workspace.writeFile('user-1', 'workspace-1', 'app/src/main/java/Test.kt', 'class Test');
  assert.equal(await workspace.readFile('user-1', 'workspace-1', 'app/src/main/java/Test.kt'), 'class Test');
});
