const fs = require('node:fs/promises');
const path = require('node:path');

async function removeExpiredFiles(root, maxAgeMs) {
  let removed = 0;
  async function walk(directory) {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }

    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        const remaining = await fs.readdir(fullPath).catch(() => []);
        if (remaining.length === 0) await fs.rmdir(fullPath).catch(() => {});
        continue;
      }
      if (entry.name === '.gitkeep') continue;
      const stat = await fs.stat(fullPath);
      if (Date.now() - stat.mtimeMs > maxAgeMs) {
        await fs.rm(fullPath, { force: true });
        removed += 1;
      }
    }
  }

  await walk(root);
  return removed;
}

function startRetention({ uploadsDir, auditDir, onCleanup = () => {} }) {
  const uploadMinutes = Math.max(1, Number(process.env.UPLOAD_RETENTION_MINUTES || 30));
  const auditDays = Math.max(1, Number(process.env.AUDIT_RETENTION_DAYS || 90));
  const intervalMinutes = Math.max(1, Number(process.env.RETENTION_SWEEP_MINUTES || 15));

  async function sweep() {
    const uploadsRemoved = await removeExpiredFiles(uploadsDir, uploadMinutes * 60 * 1000);
    const auditRemoved = await removeExpiredFiles(auditDir, auditDays * 24 * 60 * 60 * 1000);
    if (uploadsRemoved || auditRemoved) onCleanup({ uploadsRemoved, auditRemoved });
  }

  const timer = setInterval(() => sweep().catch((error) => console.error('Retention cleanup failed:', error)), intervalMinutes * 60 * 1000);
  timer.unref();
  sweep().catch((error) => console.error('Initial retention cleanup failed:', error));
  return () => clearInterval(timer);
}

module.exports = { removeExpiredFiles, startRetention };
