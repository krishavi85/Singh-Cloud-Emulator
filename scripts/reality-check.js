const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const sourceRoots = ['server', 'workers', 'public', 'scripts'];
const failures = [];
const files = [];

function walk(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else files.push(full);
  }
}

for (const directory of sourceRoots) walk(path.join(root, directory));

function relativeName(file) {
  return path.relative(root, file).replace(/\\/g, '/');
}

function resolveModule(fromFile, request) {
  const base = path.resolve(path.dirname(fromFile), request);
  const candidates = [base, `${base}.js`, path.join(base, 'index.js')];
  return candidates.some((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
}

for (const file of files.filter((item) => item.endsWith('.js'))) {
  const source = fs.readFileSync(file, 'utf8');
  const compact = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').trim();
  if (compact === 'module.exports = {};' || compact === 'export {};') {
    failures.push(`${relativeName(file)} is an empty placeholder module.`);
  }
  if (/\b(?:DUMMY_IMPLEMENTATION|FAKE_IMPLEMENTATION|PLACEHOLDER_ONLY)\b/i.test(source)) {
    failures.push(`${relativeName(file)} contains a forbidden dummy marker.`);
  }
  if (/throw\s+new\s+Error\s*\(\s*['"](?:not implemented|todo|placeholder)/i.test(source)) {
    failures.push(`${relativeName(file)} throws a placeholder implementation error.`);
  }

  for (const match of source.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
    if (!resolveModule(file, match[1])) failures.push(`${relativeName(file)} requires missing module ${match[1]}.`);
  }
}

for (const file of files.filter((item) => item.endsWith('.html'))) {
  const html = fs.readFileSync(file, 'utf8');
  for (const match of html.matchAll(/<(?:script|link)\b[^>]+?(?:src|href)=['"]([^'"]+)['"]/gi)) {
    const reference = match[1];
    if (!reference.startsWith('/') || reference.startsWith('//')) continue;
    const clean = reference.split(/[?#]/)[0];
    if (clean === '/') continue;
    const target = path.join(root, 'public', clean.replace(/^\//, ''));
    if (!fs.existsSync(target)) failures.push(`${relativeName(file)} references missing public asset ${clean}.`);
  }
}

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
for (const [name, command] of Object.entries(packageJson.scripts || {})) {
  for (const match of String(command).matchAll(/\bnode\s+([^\s;&|]+)/g)) {
    const target = path.resolve(root, match[1]);
    if (!fs.existsSync(target)) failures.push(`package script ${name} references missing file ${match[1]}.`);
  }
}

if (failures.length) {
  for (const failure of failures) console.error(`REALITY CHECK FAILED: ${failure}`);
  process.exit(1);
}

console.log(`Reality check passed for ${files.length} source and public files.`);
