const { spawn } = require('node:child_process');
const fs = require('node:fs');

function startTrafficProcess(options) {
  const log = fs.openSync(options.logPath, 'a', 0o600);
  const child = spawn(options.executable || 'mitmdump', [
    '--listen-host', '0.0.0.0',
    '--listen-port', String(options.port),
    '--set', `hardump=${options.harPath}`,
    '--save-stream-file', options.flowPath,
    '--set', 'block_global=false'
  ], {
    cwd: options.directory,
    stdio: ['ignore', log, log],
    windowsHide: true,
    detached: process.platform !== 'win32'
  });

  return {
    child,
    closeLog() {
      try { fs.closeSync(log); } catch {}
    },
    async stop() {
      if (child.exitCode !== null) return;
      child.kill('SIGINT');
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 10_000))
      ]);
      if (child.exitCode === null) {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      }
    }
  };
}

module.exports = { startTrafficProcess };
