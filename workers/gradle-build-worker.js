const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const tar = require('tar');
const { api, download, sleep, upload } = require('./agent-http');

const workerId = process.env.SCE_WORKER_ID || `gradle-${os.hostname()}-${process.pid}`;
const pollMs = Math.max(1000, Number(process.env.SCE_POLL_MS || 3000));
const timeoutMs = Math.max(60_000, Number(process.env.BUILD_TIMEOUT_MS || 20 * 60_000));
const root = path.resolve(process.env.BUILD_WORK_ROOT || path.join(os.tmpdir(), 'singh-builds'));
const gradleUserHome = path.resolve(process.env.GRADLE_USER_HOME || path.join(root, '.gradle-cache'));

async function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

async function findFiles(directory, extension, results = []) {
  const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) await findFiles(full, extension, results);
    else if (entry.name.toLowerCase().endsWith(extension)) results.push(full);
  }
  return results;
}

function taskFor(build) {
  const variant = String(build.variant || 'debug').replace(/[^A-Za-z0-9]/g, '');
  const capitalized = variant.charAt(0).toUpperCase() + variant.slice(1);
  return build.format === 'aab' ? `bundle${capitalized}` : `assemble${capitalized}`;
}

async function runGradle(directory, build) {
  const isWindows = process.platform === 'win32';
  const wrapper = path.join(directory, isWindows ? 'gradlew.bat' : 'gradlew');
  try {
    await fsp.access(wrapper);
  } catch {
    throw new Error('Workspace does not include a Gradle wrapper.');
  }
  if (!isWindows) await fsp.chmod(wrapper, 0o700);
  const task = taskFor(build);
  const args = [task, '--no-daemon', '--stacktrace', '--console=plain', '--warning-mode=all'];
  const logs = [];
  const maxLogBytes = Math.max(1_000_000, Number(process.env.BUILD_LOG_LIMIT_BYTES || 5_000_000));

  await new Promise((resolve, reject) => {
    const child = spawn(wrapper, args, {
      cwd: directory,
      env: {
        ...process.env,
        GRADLE_USER_HOME: gradleUserHome,
        CI: 'true',
        TERM: 'dumb'
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32'
    });
    let bytes = 0;
    const append = (chunk) => {
      const value = chunk.toString('utf8');
      bytes += Buffer.byteLength(value);
      if (bytes <= maxLogBytes) logs.push(value);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => {
      if (process.platform === 'win32') child.kill('SIGKILL');
      else process.kill(-child.pid, 'SIGKILL');
      reject(new Error(`Build exceeded ${Math.round(timeoutMs / 1000)} seconds.`));
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Gradle exited with code ${code ?? 'null'}${signal ? ` (${signal})` : ''}.`));
    });
  });
  return logs.join('').slice(-maxLogBytes);
}

async function buildOne(build) {
  await fsp.mkdir(root, { recursive: true, mode: 0o700 });
  await fsp.mkdir(gradleUserHome, { recursive: true, mode: 0o700 });
  const directory = await fsp.mkdtemp(path.join(root, `${build.id}-`));
  const archive = path.join(directory, 'workspace.tar.gz');
  const source = path.join(directory, 'source');
  await fsp.mkdir(source, { recursive: true, mode: 0o700 });

  try {
    await download(`/api/platform/workspaces/${encodeURIComponent(build.workspaceId)}/archive?buildId=${encodeURIComponent(build.id)}`, archive);
    await tar.x({ cwd: source, file: archive, gzip: true, strict: true, preservePaths: false });
    await fsp.rm(archive, { force: true });
    const log = await runGradle(source, build);
    const extension = build.format === 'aab' ? '.aab' : '.apk';
    const files = await findFiles(path.join(source, 'app', 'build', 'outputs'), extension);
    if (!files.length) throw new Error(`Gradle completed but no ${extension} artifact was found.`);
    files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    const artifact = files[0];
    const digest = await sha256(artifact);
    const result = await upload(
      `/api/platform/builds/${encodeURIComponent(build.id)}/artifact?name=${encodeURIComponent(path.basename(artifact))}`,
      artifact,
      build.format === 'apk' ? 'application/vnd.android.package-archive' : 'application/octet-stream',
      { 'X-Artifact-SHA256': digest, 'X-Build-Log': Buffer.from(log).toString('base64').slice(0, 7000) }
    );
    console.log(`Build ${build.id} completed: ${result.artifact?.id || 'artifact uploaded'}`);
  } catch (error) {
    console.error(`Build ${build.id} failed:`, error.message);
    await api(`/api/platform/builds/${encodeURIComponent(build.id)}/complete`, {
      method: 'POST',
      json: { success: false, log: error.stack || error.message, workerId }
    }).catch((reportError) => console.error('Failed to report build failure:', reportError.message));
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
}

async function main() {
  for (;;) {
    try {
      const body = await api('/api/platform/builds/claim', { method: 'POST', json: { workerId, leaseSeconds: Math.ceil(timeoutMs / 1000) + 120 } });
      if (!body.build) {
        await sleep(pollMs);
        continue;
      }
      await buildOne(body.build);
    } catch (error) {
      console.error('Build worker loop:', error.message);
      await sleep(pollMs);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
