const fs = require('node:fs');

const file = process.argv[2] || 'npm-audit.json';
const report = JSON.parse(fs.readFileSync(file, 'utf8'));
const vulnerabilities = Object.entries(report.vulnerabilities || {});
const blocking = vulnerabilities.filter(([, detail]) => ['high', 'critical'].includes(detail.severity));

for (const [name, detail] of blocking) {
  const via = (detail.via || []).map((item) => typeof item === 'string' ? item : `${item.title || item.name || 'advisory'} (${item.url || 'no URL'})`).join('; ');
  const fix = detail.fixAvailable === true
    ? 'automatic fix available'
    : detail.fixAvailable && typeof detail.fixAvailable === 'object'
      ? `upgrade to ${detail.fixAvailable.name}@${detail.fixAvailable.version}${detail.fixAvailable.isSemVerMajor ? ' (major)' : ''}`
      : 'no automatic fix';
  console.error(`${detail.severity.toUpperCase()}: ${name} ${detail.range || ''} — ${via} — ${fix}`);
}

const metadata = report.metadata?.vulnerabilities || {};
console.log(`Audit totals: critical=${metadata.critical || 0}, high=${metadata.high || 0}, moderate=${metadata.moderate || 0}, low=${metadata.low || 0}`);
if (blocking.length) process.exit(1);
