const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const roots = ['server', 'public', 'workers', 'scripts'];
const files = [];

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile() && entry.name.endsWith('.js') && full !== __filename) files.push(full);
  }
}

for (const root of roots) {
  if (fs.existsSync(root)) walk(root);
}

let failed = false;
for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) failed = true;
}

if (failed) process.exit(1);
console.log(`Syntax checked ${files.length} JavaScript files.`);
