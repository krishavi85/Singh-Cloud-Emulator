const crypto = require('node:crypto');
const store = require('./platform-store');

function configured() {
  return Boolean(process.env.LAGO_API_URL && process.env.LAGO_API_KEY);
}

function baseUrl() {
  const value = String(process.env.LAGO_API_URL || '').replace(/\/$/, '');
  if (!value) throw Object.assign(new Error('Lago billing is not configured.'), { status: 503 });
  return value;
}

async function lago(path, options = {}) {
  if (!configured()) throw Object.assign(new Error('Lago billing is not configured.'), { status: 503 });
  const response = await fetch(`${baseUrl()}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.LAGO_API_KEY}`,
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body.error || body.message || `Lago request failed (${response.status}).`;
    throw Object.assign(new Error(message), { status: response.status >= 400 && response.status < 500 ? response.status : 502 });
  }
  return body;
}

async function upsertCustomer(organization) {
  const externalId = organization.id;
  const payload = {
    customer: {
      external_id: externalId,
      name: organization.name,
      email: organization.billingEmail || organization.ownerEmail || undefined,
      currency: organization.currency || process.env.BILLING_CURRENCY || 'USD',
      country: organization.country || undefined,
      metadata: [{ key: 'singh_organization_id', value: organization.id }]
    }
  };
  const result = await lago('/api/v1/customers', { method: 'POST', body: JSON.stringify(payload) });
  await store.transact((state) => {
    const current = state.organizations.find((item) => item.id === organization.id);
    if (current) {
      current.billingProvider = 'lago';
      current.billingCustomerId = result.customer?.lago_id || null;
      current.billingSyncedAt = store.now();
    }
  });
  return result.customer;
}

async function assignPlan(organization, planCode, options = {}) {
  await upsertCustomer(organization);
  const externalId = options.externalId || `sub_${organization.id}`;
  const result = await lago('/api/v1/subscriptions', {
    method: 'POST',
    body: JSON.stringify({
      subscription: {
        external_customer_id: organization.id,
        external_id: externalId,
        plan_code: String(planCode),
        billing_time: options.billingTime === 'calendar' ? 'calendar' : 'anniversary',
        subscription_at: options.subscriptionAt || undefined
      }
    })
  });
  const subscription = {
    id: externalId,
    organizationId: organization.id,
    provider: 'lago',
    providerId: result.subscription?.lago_id || null,
    planId: String(planCode),
    status: result.subscription?.status || 'active',
    createdAt: store.now(),
    updatedAt: store.now(),
    raw: result.subscription || {}
  };
  await store.transact((state) => {
    const index = state.subscriptions.findIndex((item) => item.id === subscription.id);
    if (index >= 0) state.subscriptions[index] = subscription;
    else state.subscriptions.push(subscription);
    const org = state.organizations.find((item) => item.id === organization.id);
    if (org) org.planId = subscription.planId;
  });
  return subscription;
}

async function terminateSubscription(organizationId, externalId) {
  const result = await lago(`/api/v1/subscriptions/${encodeURIComponent(externalId)}`, { method: 'DELETE' });
  await store.transact((state) => {
    const current = state.subscriptions.find((item) => item.id === externalId && item.organizationId === organizationId);
    if (current) {
      current.status = 'terminated';
      current.updatedAt = store.now();
      current.raw = result.subscription || current.raw;
    }
  });
  return result.subscription;
}

async function sendUsageEvent({ organizationId, transactionId, code, timestamp, properties = {} }) {
  if (!configured()) return { skipped: true, reason: 'Lago is not configured.' };
  const payload = {
    event: {
      transaction_id: transactionId || crypto.randomUUID(),
      external_customer_id: organizationId,
      code: String(code),
      timestamp: timestamp || Math.floor(Date.now() / 1000),
      properties
    }
  };
  return lago('/api/v1/events', { method: 'POST', body: JSON.stringify(payload) });
}

function verifyWebhook(rawBody, signature) {
  const secret = process.env.LAGO_WEBHOOK_HMAC_KEY || '';
  if (secret.length < 16) throw new Error('LAGO_WEBHOOK_HMAC_KEY is not configured.');
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  const received = String(signature || '');
  if (received.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

async function processWebhook(rawBody, headers) {
  if (!verifyWebhook(rawBody, headers['x-lago-signature'])) {
    throw Object.assign(new Error('Invalid Lago webhook signature.'), { status: 401 });
  }
  const uniqueKey = String(headers['x-lago-unique-key'] || '');
  const event = JSON.parse(rawBody.toString('utf8'));
  return store.transact((state) => {
    state.billingWebhookKeys ||= [];
    if (uniqueKey && state.billingWebhookKeys.includes(uniqueKey)) return { duplicate: true, event };
    if (uniqueKey) {
      state.billingWebhookKeys.push(uniqueKey);
      state.billingWebhookKeys = state.billingWebhookKeys.slice(-10_000);
    }

    const type = event.webhook_type || 'unknown';
    const subscriptionData = event.subscription;
    if (subscriptionData?.external_id) {
      const existing = state.subscriptions.find((item) => item.id === subscriptionData.external_id);
      const record = {
        id: subscriptionData.external_id,
        organizationId: subscriptionData.external_customer_id || existing?.organizationId || null,
        provider: 'lago',
        providerId: subscriptionData.lago_id || existing?.providerId || null,
        planId: subscriptionData.plan_code || existing?.planId || null,
        status: subscriptionData.status || type,
        createdAt: existing?.createdAt || store.now(),
        updatedAt: store.now(),
        raw: subscriptionData
      };
      if (existing) Object.assign(existing, record);
      else state.subscriptions.push(record);
    }

    const invoiceData = event.invoice;
    if (invoiceData?.lago_id) {
      const existing = state.invoices.find((item) => item.providerId === invoiceData.lago_id);
      const invoice = {
        id: existing?.id || store.id('invoice'),
        organizationId: invoiceData.external_customer_id || existing?.organizationId || null,
        provider: 'lago',
        providerId: invoiceData.lago_id,
        status: invoiceData.status || type,
        amountCents: Number(invoiceData.total_amount_cents || 0),
        currency: invoiceData.currency || 'USD',
        createdAt: existing?.createdAt || store.now(),
        updatedAt: store.now(),
        raw: invoiceData
      };
      if (existing) Object.assign(existing, invoice);
      else state.invoices.push(invoice);
    }
    return { duplicate: false, type, event };
  });
}

async function health() {
  if (!configured()) return { configured: false, healthy: true, backend: 'disabled' };
  try {
    await lago('/api/v1/plans?per_page=1');
    return { configured: true, healthy: true, backend: 'lago' };
  } catch (error) {
    return { configured: true, healthy: false, backend: 'lago', error: error.message };
  }
}

module.exports = { assignPlan, configured, health, processWebhook, sendUsageEvent, terminateSubscription, upsertCustomer };
