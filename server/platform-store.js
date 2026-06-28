const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const dataFile = path.resolve(process.env.PLATFORM_DATA_FILE || path.join(__dirname, '..', 'data', 'platform.json'));
let queue = Promise.resolve();

function defaultProfiles() {
  return [
    { id: 'pixel-8-api-35', name: 'Pixel 8', platform: 'android', apiLevel: 35, width: 1080, height: 2400, density: 420, orientation: 'portrait', enabled: true },
    { id: 'pixel-tablet-api-35', name: 'Pixel Tablet', platform: 'android', apiLevel: 35, width: 1600, height: 2560, density: 320, orientation: 'landscape', enabled: true },
    { id: 'android-tv-api-35', name: 'Android TV', platform: 'android-tv', apiLevel: 35, width: 1920, height: 1080, density: 320, orientation: 'landscape', enabled: true },
    { id: 'wear-os-api-35', name: 'Wear OS', platform: 'wear-os', apiLevel: 35, width: 454, height: 454, density: 326, orientation: 'portrait', enabled: true },
    { id: 'iphone-16-ios', name: 'iPhone 16 Simulator', platform: 'ios', apiLevel: null, width: 1179, height: 2556, density: 460, orientation: 'portrait', enabled: true, requiresMacWorker: true },
    { id: 'ipad-pro-ios', name: 'iPad Pro Simulator', platform: 'ipados', apiLevel: null, width: 2048, height: 2732, density: 264, orientation: 'portrait', enabled: true, requiresMacWorker: true }
  ];
}

function emptyState() {
  return {
    schemaVersion: 2,
    profiles: defaultProfiles(),
    sessions: [],
    shares: [],
    recordings: [],
    workspaces: [],
    builds: [],
    artifacts: [],
    apps: [],
    usage: [],
    organizations: [],
    appiumSessions: [],
    networkCaptures: [],
    plans: [
      { id: 'free', name: 'Free', monthlyMinutes: 60, concurrentSessions: 1 },
      { id: 'pro', name: 'Pro', monthlyMinutes: 2000, concurrentSessions: 3 },
      { id: 'team', name: 'Team', monthlyMinutes: 10000, concurrentSessions: 10 }
    ]
  };
}

function normalizeState(state) {
  const normalized = state && typeof state === 'object' ? state : {};
  const arrayKeys = ['profiles', 'sessions', 'shares', 'recordings', 'workspaces', 'builds', 'artifacts', 'apps', 'usage', 'organizations', 'appiumSessions', 'networkCaptures', 'plans'];
  for (const key of arrayKeys) if (!Array.isArray(normalized[key])) normalized[key] = [];

  const existingProfiles = new Set(normalized.profiles.map((profile) => profile.id));
  for (const profile of defaultProfiles()) {
    if (!existingProfiles.has(profile.id)) normalized.profiles.push(profile);
  }
  if (!normalized.plans.length) normalized.plans = emptyState().plans;
  normalized.schemaVersion = 2;
  return normalized;
}

async function ensureFile() {
  await fs.mkdir(path.dirname(dataFile), { recursive: true, mode: 0o700 });
  try {
    await fs.access(dataFile);
  } catch {
    await fs.writeFile(dataFile, `${JSON.stringify(emptyState(), null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
}

async function readState() {
  await ensureFile();
  const raw = await fs.readFile(dataFile, 'utf8');
  return normalizeState(JSON.parse(raw));
}

async function writeState(state) {
  const temp = `${dataFile}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(normalizeState(state), null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temp, dataFile);
}

function transact(mutator) {
  const operation = queue.then(async () => {
    const state = await readState();
    const result = await mutator(state);
    await writeState(state);
    return result;
  });
  queue = operation.catch(() => {});
  return operation;
}

function id(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

function now() {
  return new Date().toISOString();
}

function owned(record, user) {
  return user.role === 'admin' || record.userId === user.id;
}

module.exports = { dataFile, emptyState, id, normalizeState, now, owned, readState, transact };
