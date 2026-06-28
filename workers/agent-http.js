function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

const apiBase = required('SCE_API_BASE').replace(/\/$/, '');
const email = required('SCE_WORKER_EMAIL');
const password = required('SCE_WORKER_PASSWORD');
let cookie = '';

async function login() {
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

async function api(path, options = {}) {
  if (!cookie) await login();
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      Origin: apiBase,
      Cookie: cookie,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  if (response.status === 401) {
    cookie = '';
    await login();
    return api(path, options);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `API request failed (${response.status}).`);
  return body;
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

module.exports = { api, apiBase, login, required, sleep };
