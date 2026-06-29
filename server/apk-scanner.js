const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');

async function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function clamConnection(command, timeoutMs = 5000) {
  const host = process.env.CLAMAV_HOST || '127.0.0.1';
  const port = Number(process.env.CLAMAV_PORT || 3310);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const chunks = [];
    let settled = false;
    function finish(error, value) {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    }
    socket.setTimeout(timeoutMs, () => finish(new Error('ClamAV request timed out.')));
    socket.on('error', (error) => finish(error));
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', () => finish(null, Buffer.concat(chunks).toString('utf8').replace(/\0/g, '').trim()));
    socket.on('connect', () => socket.end(command));
  });
}

async function scanWithClamAv(filePath) {
  const host = process.env.CLAMAV_HOST || '127.0.0.1';
  const port = Number(process.env.CLAMAV_PORT || 3310);
  const timeoutMs = Math.max(5000, Number(process.env.CLAMAV_TIMEOUT_MS || 120000));

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const file = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });
    const response = [];
    let settled = false;

    function finish(error, result) {
      if (settled) return;
      settled = true;
      socket.destroy();
      file.destroy();
      if (error) reject(error);
      else resolve(result);
    }

    socket.setTimeout(timeoutMs, () => finish(new Error('APK scan timed out.')));
    socket.on('error', (error) => finish(error));
    socket.on('data', (chunk) => response.push(chunk));
    socket.on('end', () => {
      const message = Buffer.concat(response).toString('utf8').replace(/\0/g, '').trim();
      if (/\bOK$/.test(message)) return finish(null, { clean: true, engine: 'clamav', result: message });
      if (/FOUND$/.test(message)) return finish(null, { clean: false, engine: 'clamav', result: message });
      finish(new Error(`Unexpected scanner response: ${message || 'empty response'}`));
    });

    socket.on('connect', () => {
      socket.write('zINSTREAM\0');
      file.on('data', (chunk) => {
        file.pause();
        const length = Buffer.alloc(4);
        length.writeUInt32BE(chunk.length, 0);
        socket.write(Buffer.concat([length, chunk]), () => file.resume());
      });
      file.on('error', (error) => finish(error));
      file.on('end', () => {
        const end = Buffer.alloc(4);
        end.writeUInt32BE(0, 0);
        socket.end(end);
      });
    });
  });
}

async function scanApk(filePath) {
  const digest = await sha256(filePath);
  const required = String(process.env.CLAMAV_REQUIRED ?? 'true').toLowerCase() === 'true';

  try {
    const scan = await scanWithClamAv(filePath);
    return { ...scan, sha256: digest };
  } catch (error) {
    if (required || process.env.NODE_ENV === 'production') {
      const failure = new Error('APK scanning is unavailable; upload rejected.');
      failure.status = 503;
      failure.cause = error;
      throw failure;
    }
    return { clean: true, engine: 'disabled-development-only', result: error.message, sha256: digest };
  }
}

async function health() {
  try {
    const response = await clamConnection('zPING\0');
    return { configured: true, healthy: response === 'PONG', engine: 'clamav', response };
  } catch (error) {
    return { configured: true, healthy: false, engine: 'clamav', error: error.message };
  }
}

module.exports = { health, scanApk, sha256 };
