const nodemailer = require('nodemailer');
const store = require('./platform-store');

let transporter = null;

function configured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM);
}

function getTransporter() {
  if (!configured()) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD || '' }
        : undefined,
      tls: {
        rejectUnauthorized: String(process.env.SMTP_TLS_REJECT_UNAUTHORIZED || 'true').toLowerCase() === 'true'
      },
      pool: true,
      maxConnections: Math.max(1, Number(process.env.SMTP_MAX_CONNECTIONS || 3))
    });
  }
  return transporter;
}

async function queueNotification(input) {
  const record = {
    id: store.id('notification'),
    userId: input.userId || null,
    organizationId: input.organizationId || null,
    type: String(input.type || 'system').slice(0, 80),
    channel: input.channel === 'email' ? 'email' : 'in-app',
    recipient: input.recipient ? String(input.recipient).slice(0, 320) : null,
    subject: String(input.subject || '').slice(0, 240),
    body: String(input.body || '').slice(0, 50_000),
    metadata: input.metadata || {},
    status: 'queued',
    createdAt: store.now(),
    sentAt: null,
    error: null
  };
  await store.transact((state) => {
    state.notifications.push(record);
    return record;
  });
  return record;
}

async function mark(id, status, error = null) {
  return store.transact((state) => {
    const record = state.notifications.find((item) => item.id === id);
    if (!record) return null;
    record.status = status;
    record.error = error ? String(error).slice(0, 2000) : null;
    if (status === 'sent') record.sentAt = store.now();
    return record;
  });
}

async function sendEmail(input) {
  const record = await queueNotification({ ...input, channel: 'email' });
  if (!configured()) {
    await mark(record.id, 'skipped', 'SMTP is not configured.');
    return { ...record, status: 'skipped' };
  }
  try {
    const result = await getTransporter().sendMail({
      from: process.env.SMTP_FROM,
      to: record.recipient,
      subject: record.subject,
      text: record.body,
      headers: { 'X-Singh-Notification-ID': record.id }
    });
    await mark(record.id, 'sent');
    return { ...record, status: 'sent', messageId: result.messageId };
  } catch (error) {
    await mark(record.id, 'failed', error.message);
    throw error;
  }
}

async function listNotifications(user, limit = 100) {
  const state = await store.readState();
  return state.notifications
    .filter((item) => user.role === 'admin' || item.userId === user.id || (user.organizationId && item.organizationId === user.organizationId))
    .slice(-Math.max(1, Math.min(1000, Number(limit || 100))))
    .reverse();
}

async function health() {
  if (!configured()) return { configured: false, healthy: true, backend: 'disabled' };
  try {
    await getTransporter().verify();
    return { configured: true, healthy: true, backend: 'smtp' };
  } catch (error) {
    return { configured: true, healthy: false, backend: 'smtp', error: error.message };
  }
}

module.exports = { configured, health, listNotifications, queueNotification, sendEmail };
