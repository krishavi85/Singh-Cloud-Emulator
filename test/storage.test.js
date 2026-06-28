const test = require('node:test');
const assert = require('node:assert/strict');

test('storage module loads', () => {
  const storage = require('../server/object-storage');
  assert.equal(typeof storage.putBuffer, 'function');
});
