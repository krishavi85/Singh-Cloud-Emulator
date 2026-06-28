const SERVICE_DEFINITIONS = {
  cuttlefish: {
    label: 'Cuttlefish WebRTC',
    baseUrlEnv: 'CUTTLEFISH_WEBRTC_BASE_URL',
    healthPathEnv: 'CUTTLEFISH_HEALTH_PATH',
    defaultHealthPath: '/'
  },
  ios: {
    label: 'Apple Simulator Worker',
    baseUrlEnv: 'IOS_SIMULATOR_BASE_URL',
    healthPathEnv: 'IOS_SIMULATOR_HEALTH_PATH',
    defaultHealthPath: '/health'
  },
  ide: {
    label: 'Cloud IDE',
    baseUrlEnv: 'CODE_SERVER_BASE_URL',
    healthPathEnv: 'CODE_SERVER_HEALTH_PATH',
    defaultHealthPath: '/healthz'
  },
  appium: {
    label: 'Appium UiAutomator2',
    baseUrlEnv: 'APPIUM_BASE_URL',
    healthPathEnv: 'APPIUM_HEALTH_PATH',
    defaultHealthPath: '/status'
  },
  proxy: {
    label: 'mitmproxy',
    baseUrlEnv: 'MITMPROXY_WEB_URL',
    healthPathEnv: 'MITMPROXY_HEALTH_PATH',
    defaultHealthPath: '/'
  },
  profiler: {
    label: 'Perfetto UI',
    baseUrlEnv: 'PERFETTO_UI_URL',
    healthPathEnv: 'PERFETTO_HEALTH_PATH',
    defaultHealthPath: '/'
  },
  debugger: {
    label: 'Debug Adapter',
    baseUrlEnv: 'DEBUG_ADAPTER_BASE_URL',
    healthPathEnv: 'DEBUG_ADAPTER_HEALTH_PATH',
    defaultHealthPath: '/health'
  }
};

function cleanBaseUrl(value) {
  if (!value) return '';
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Integration URLs must use HTTP or HTTPS.');
  return parsed.toString().replace(/\/$/, '');
}

function configuration() {
  return Object.fromEntries(Object.entries(SERVICE_DEFINITIONS).map(([id, definition]) => {
    const raw = process.env[definition.baseUrlEnv] || '';
    return [id, {
      id,
      label: definition.label,
      configured: Boolean(raw),
      baseUrl: raw ? cleanBaseUrl(raw) : '',
      healthPath: process.env[definition.healthPathEnv] || definition.defaultHealthPath
    }];
  }));
}

async function health(service, timeoutMs = 3000) {
  if (!service.configured) return { ...service, healthy: false, status: 'not-configured' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${service.baseUrl}${service.healthPath}`, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'manual',
      headers: { Accept: 'application/json,text/plain,*/*' }
    });
    return {
      ...service,
      healthy: response.status >= 200 && response.status < 500,
      status: response.status,
      checkedAt: new Date().toISOString()
    };
  } catch (error) {
    return { ...service, healthy: false, status: error.name === 'AbortError' ? 'timeout' : 'unreachable', checkedAt: new Date().toISOString() };
  } finally {
    clearTimeout(timer);
  }
}

async function healthReport() {
  const services = configuration();
  const results = await Promise.all(Object.values(services).map((service) => health(service)));
  return Object.fromEntries(results.map((result) => [result.id, result]));
}

function renderTemplate(template, values) {
  if (!template) return null;
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (_match, key) => encodeURIComponent(values[key] ?? ''));
}

function sessionLinks(session, profile = {}) {
  const values = {
    sessionId: session.id,
    workerId: session.workerId || '',
    serial: session.serial || '',
    workspaceId: session.workspaceId || '',
    profileId: session.profileId || '',
    platform: profile.platform || ''
  };
  const isApple = ['ios', 'ipados', 'tvos', 'watchos', 'visionos'].includes(profile.platform);
  return {
    stream: renderTemplate(isApple ? process.env.IOS_SIMULATOR_SESSION_URL_TEMPLATE : process.env.CUTTLEFISH_SESSION_URL_TEMPLATE, values),
    ide: renderTemplate(process.env.CODE_SERVER_SESSION_URL_TEMPLATE, values),
    proxy: renderTemplate(process.env.MITMPROXY_SESSION_URL_TEMPLATE, values),
    profiler: renderTemplate(isApple ? process.env.IOS_PROFILER_SESSION_URL_TEMPLATE : process.env.PERFETTO_SESSION_URL_TEMPLATE, values),
    debugger: renderTemplate(process.env.DEBUG_ADAPTER_SESSION_URL_TEMPLATE, values)
  };
}

module.exports = { configuration, healthReport, sessionLinks };
