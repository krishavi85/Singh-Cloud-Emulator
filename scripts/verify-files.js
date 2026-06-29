const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const required = [
  'server/index.js',
  'server/web-application.js',
  'server/api-routes.js',
  'public/index.html',
  'public/workbench.html',
  'public/equivalence.html',
  'public/operations.html',
  'workers/cuttlefish-worker.js',
  'workers/gradle-build-worker.js',
  'workers/ios-xcuitest-worker.js',
  'workers/traffic-observer-worker.js'
];

const missing = required.filter((file) => !fs.existsSync(path.join(root, file)));
if (missing.length) {
  console.error(`Missing required files: ${missing.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log(`Verified ${required.length} required application files.`);
}
