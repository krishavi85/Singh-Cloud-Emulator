function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

const apiBase = required('SCE_API_BASE').replace(/\/$/, '');
const apiKey = process.env.SCE_API_KEY || '';
const email = process.env.SCE_WORKER_EMAIL || '';
const password = process.env.SCE_WORKER_PASSWORD || '';
let cookie = '';

async function login() {
  if (apiKey) return;
  if (!email || !password) throw new Error('SCE_API_KEY or worker email/password credentials are required.');
  const response = await fetch(`${apiBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: apiBase },
    body: JSON.stringify({ email, password })
  });
  if (!response.ok) throw new Error(`Worker login failed (${response.status}).`);
  const cookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  cookie = cookies.map((value) => value.split(';')[0]).join('; ');
  if (!cookie) throw new Error('Worker login did not return a session cookie.');
}

function authHeaders() {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : { Cookie: cookie };
}

async function request(path, options = {}) {
  if (!apiKey && !cookie) await login();
  const headers = {
    Accept: options.accept || 'application/json',
    Origin: apiBase,
    ...authHeaders(),
    ...(options.headers || {})
  };
  if (options.json !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers,
    body: options.json !== undefined ? JSON.stringify(options.json) : options.body
  });
  if (response.status === 401 && !apiKey && !options.noRetry) {
    cookie = '';
    await login();
    return request(path, { ...options, noRetry: true });
  }
  return response;
}

async function api(path, options = {}) {
  const response = await request(path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `API request failed (${response.status}).`);
  return body;
}

async function download(path, destination) {
  const fs = require('node:fs');
  const { pipeline } = require('node:stream/promises');
  const response = await request(path, { accept: 'application/octet-stream,application/gzip' });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(body || `Download failed (${response.status}).`);
  }
  await pipeline(response.body, fs.createWriteStream(destination, { mode: 0o600 }));
  return destination;
}

async function upload(path, filePath, contentType = 'application/octet-stream', headers = {}) {
  const fs = require('node:fs');
  const stat = fs.statSync(filePath);
  const response = await request(path, {
    method: 'PUT',
    body: fs.createReadStream(filePath),
    duplex: 'half',
    headers: { 'Content-Type': contentType, 'Content-Length': String(stat.size), ...headers },
    accept: 'application/json'
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Upload failed (${response.status}).`);
  return body;
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

module.exports = { api, apiBase, download, login, request, required, sleep, upload };
