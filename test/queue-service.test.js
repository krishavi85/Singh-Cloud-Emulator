const test = require('node:test');
const assert = require('node:assert/strict');

delete process.env.REDIS_URL;
const queue = require('../server/queue-service');

test('memory queue deduplicates jobs and enforces leases', async () => {
  const first = await queue.enqueue('test', 'job-1', { value: 1 });
  const duplicate = await queue.enqueue('test', 'job-1', { value: 2 });
  assert.equal(first.id, 'job-1');
  assert.equal(duplicate, null);
  assert.equal(await queue.depth('test'), 1);

  const lease = await queue.claim('test', 'worker-1', 60);
  assert.equal(lease.id, 'job-1');
  assert.equal(lease.workerId, 'worker-1');
  assert.equal(await queue.depth('test'), 0);
  assert.equal(await queue.renew('test', 'job-1', 'worker-2', 60), false);
  assert.equal(await queue.renew('test', 'job-1', 'worker-1', 60), true);
  assert.equal(await queue.ack('test', 'job-1', 'worker-1'), true);
});

test('memory queue can requeue a failed lease', async () => {
  await queue.enqueue('retry', 'job-2', { attempt: 1 });
  const lease = await queue.claim('retry', 'worker-1', 60);
  await queue.requeue('retry', lease, 'temporary-failure');
  const retried = await queue.claim('retry', 'worker-2', 60);
  assert.equal(retried.id, 'job-2');
  assert.equal(retried.payload.retryReason, 'temporary-failure');
  await queue.ack('retry', retried.id, 'worker-2');
});
