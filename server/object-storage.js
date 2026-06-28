const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const localRoot = path.resolve(process.env.ARTIFACT_LOCAL_DIR || path.join(__dirname, '..', 'data', 'artifacts'));
let client = null;
let bucketReady = false;

function configured() {
  return Boolean(process.env.S3_ENDPOINT && process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY);
}

function bucket() {
  return process.env.S3_BUCKET || 'singh-cloud-artifacts';
}

function getClient() {
  if (!configured()) return null;
  if (!client) {
    client = new S3Client({
      region: process.env.S3_REGION || 'us-east-1',
      endpoint: process.env.S3_ENDPOINT,
      forcePathStyle: String(process.env.S3_FORCE_PATH_STYLE || 'true').toLowerCase() === 'true',
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY
      },
      tls: String(process.env.S3_TLS || 'false').toLowerCase() === 'true'
    });
  }
  return client;
}

function safeKey(value) {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('..') || !/^[A-Za-z0-9_./-]{1,900}$/.test(normalized)) {
    throw Object.assign(new Error('Invalid object storage key.'), { status: 400 });
  }
  return normalized;
}

async function ensureBucket() {
  if (!configured() || bucketReady) return;
  const s3 = getClient();
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket() }));
  } catch {
    if (String(process.env.S3_CREATE_BUCKET || 'true').toLowerCase() !== 'true') throw new Error(`S3 bucket ${bucket()} is unavailable.`);
    await s3.send(new CreateBucketCommand({ Bucket: bucket() }));
  }
  bucketReady = true;
}

async function putBuffer(keyValue, buffer, contentType = 'application/octet-stream', metadata = {}) {
  const key = safeKey(keyValue);
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const sha256 = crypto.createHash('sha256').update(data).digest('hex');
  if (configured()) {
    await ensureBucket();
    await getClient().send(new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      Body: data,
      ContentType: contentType,
      Metadata: { ...metadata, sha256 }
    }));
  } else {
    const target = path.join(localRoot, key);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, data, { mode: 0o600 });
  }
  return { key, sha256, sizeBytes: data.length, contentType };
}

async function putFile(keyValue, filePath, contentType = 'application/octet-stream', metadata = {}) {
  const data = await fs.readFile(filePath);
  return putBuffer(keyValue, data, contentType, metadata);
}

async function presignUpload(keyValue, contentType = 'application/octet-stream', expiresSeconds = 900) {
  if (!configured()) throw Object.assign(new Error('Presigned uploads require S3-compatible storage.'), { status: 503 });
  await ensureBucket();
  const key = safeKey(keyValue);
  const expiresIn = Math.max(60, Math.min(3600, Number(expiresSeconds || 900)));
  const url = await getSignedUrl(getClient(), new PutObjectCommand({ Bucket: bucket(), Key: key, ContentType: contentType }), { expiresIn });
  return { key, url, expiresIn };
}

async function presignDownload(keyValue, filename = '', expiresSeconds = 300) {
  const key = safeKey(keyValue);
  if (!configured()) return { key, local: true, path: path.join(localRoot, key) };
  await ensureBucket();
  const expiresIn = Math.max(30, Math.min(3600, Number(expiresSeconds || 300)));
  const command = new GetObjectCommand({
    Bucket: bucket(),
    Key: key,
    ResponseContentDisposition: filename ? `attachment; filename="${path.basename(filename)}"` : undefined
  });
  const url = await getSignedUrl(getClient(), command, { expiresIn });
  return { key, url, expiresIn, local: false };
}

async function stat(keyValue) {
  const key = safeKey(keyValue);
  if (configured()) {
    await ensureBucket();
    const result = await getClient().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
    return { key, sizeBytes: Number(result.ContentLength || 0), contentType: result.ContentType || 'application/octet-stream', metadata: result.Metadata || {} };
  }
  const result = await fs.stat(path.join(localRoot, key));
  return { key, sizeBytes: result.size, contentType: 'application/octet-stream', metadata: {} };
}

async function readLocal(keyValue) {
  if (configured()) throw Object.assign(new Error('Object is stored remotely.'), { status: 409 });
  return fs.readFile(path.join(localRoot, safeKey(keyValue)));
}

async function remove(keyValue) {
  const key = safeKey(keyValue);
  if (configured()) {
    await ensureBucket();
    await getClient().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
  } else {
    await fs.rm(path.join(localRoot, key), { force: true });
  }
}

async function health() {
  if (!configured()) {
    try {
      await fs.mkdir(localRoot, { recursive: true, mode: 0o700 });
      return { configured: false, healthy: true, backend: 'local', root: localRoot };
    } catch (error) {
      return { configured: false, healthy: false, backend: 'local', error: error.message };
    }
  }
  try {
    await ensureBucket();
    return { configured: true, healthy: true, backend: 's3', bucket: bucket() };
  } catch (error) {
    return { configured: true, healthy: false, backend: 's3', bucket: bucket(), error: error.message };
  }
}

module.exports = { configured, health, presignDownload, presignUpload, putBuffer, putFile, readLocal, remove, stat };
