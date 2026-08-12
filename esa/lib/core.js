import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createSign,
  createVerify,
  randomBytes,
} from 'node:crypto';

export const DEFAULT_BASE_URL = 'https://www.smallds.icu';
export const SANDBOX_GATEWAY = 'https://openapi-sandbox.dl.alipaydev.com/gateway.do';
export const PRODUCTION_GATEWAY = 'https://openapi.alipay.com/gateway.do';
export const SUCCESS_TRADE_STATUSES = Object.freeze(['TRADE_SUCCESS', 'TRADE_FINISHED']);
export const INDEX_SHARDS = 16;
export const ADMIN_SESSION_SECONDS = 8 * 60 * 60;
export const MAX_RANGE_DAYS = 93;
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

export class AppError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.publicMessage = message;
    this.details = details;
  }
}

function readRuntimeEnv(name) {
  if (typeof process === 'undefined' || !process.env) return '';
  switch (name) {
    case 'AIPAY_ENV': return process.env.AIPAY_ENV;
    case 'AIPAY_PUBLIC_BASE_URL': return process.env.AIPAY_PUBLIC_BASE_URL;
    case 'AIPAY_APP_ID': return process.env.AIPAY_APP_ID;
    case 'AIPAY_PRIVATE_PKCS_KEY': return process.env.AIPAY_PRIVATE_PKCS_KEY;
    case 'AIPAY_PRIVATE_KEY': return process.env.AIPAY_PRIVATE_KEY;
    case 'AIPAY_ALIPAY_PUBLIC_KEY': return process.env.AIPAY_ALIPAY_PUBLIC_KEY;
    case 'AIPAY_SELLER_ID': return process.env.AIPAY_SELLER_ID;
    case 'AIPAY_SELLER_EMAIL': return process.env.AIPAY_SELLER_EMAIL;
    case 'AIPAY_GATEWAY': return process.env.AIPAY_GATEWAY;
    case 'AIPAY_RETURN_URL': return process.env.AIPAY_RETURN_URL;
    case 'AIPAY_NOTIFY_URL': return process.env.AIPAY_NOTIFY_URL;
    case 'ESA_KV_NAMESPACE': return process.env.ESA_KV_NAMESPACE;
    case 'ADMIN_SETUP_TOKEN': return process.env.ADMIN_SETUP_TOKEN;
    case 'ADMIN_RESET_TOKEN': return process.env.ADMIN_RESET_TOKEN;
    case 'ADMIN_DATA_KEY': return process.env.ADMIN_DATA_KEY;
    case 'ADMIN_SESSION_SECRET': return process.env.ADMIN_SESSION_SECRET;
    case 'SUBSCRIPTION_WEBHOOK_URL': return process.env.SUBSCRIPTION_WEBHOOK_URL;
    case 'SUBSCRIPTION_WEBHOOK_SECRET': return process.env.SUBSCRIPTION_WEBHOOK_SECRET;
    default: return process.env[name];
  }
}

export function readEnv(name, fallback = '') {
  const value = readRuntimeEnv(name);
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

export function readConfig() {
  const paymentEnvironment = readEnv('AIPAY_ENV', 'sandbox').toLowerCase() === 'production' ? 'production' : 'sandbox';
  const baseUrl = readEnv('AIPAY_PUBLIC_BASE_URL', DEFAULT_BASE_URL).replace(/\/+$/, '');
  const defaultGateway = paymentEnvironment === 'production' ? PRODUCTION_GATEWAY : SANDBOX_GATEWAY;
  return {
    appId: readEnv('AIPAY_APP_ID'),
    privatePkcsKey: readEnv('AIPAY_PRIVATE_PKCS_KEY'),
    privateKey: readEnv('AIPAY_PRIVATE_KEY'),
    alipayPublicKey: readEnv('AIPAY_ALIPAY_PUBLIC_KEY'),
    sellerId: readEnv('AIPAY_SELLER_ID'),
    sellerEmail: readEnv('AIPAY_SELLER_EMAIL'),
    paymentEnvironment,
    gateway: readEnv('AIPAY_GATEWAY', defaultGateway),
    baseUrl,
    returnUrl: readEnv('AIPAY_RETURN_URL', baseUrl + '/api/payment/return'),
    notifyUrl: readEnv('AIPAY_NOTIFY_URL', baseUrl + '/api/payment/notify'),
    kvNamespace: readEnv('ESA_KV_NAMESPACE', 'neye-orders'),
    adminSetupToken: readEnv('ADMIN_SETUP_TOKEN'),
    adminResetToken: readEnv('ADMIN_RESET_TOKEN'),
    adminDataKey: readEnv('ADMIN_DATA_KEY'),
    adminSessionSecret: readEnv('ADMIN_SESSION_SECRET'),
    webhookUrl: readEnv('SUBSCRIPTION_WEBHOOK_URL'),
    webhookSecret: readEnv('SUBSCRIPTION_WEBHOOK_SECRET'),
  };
}

export const RUNTIME_CONFIG_KEY = 'v2_runtime_config';

function runtimeConfigValue(record, key) {
  const value = record && typeof record === 'object' ? record[key] : '';
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

export async function loadRuntimeConfig(config) {
  const requiredFields = [
    ['adminSetupToken', 'ADMIN_SETUP_TOKEN'],
    ['adminResetToken', 'ADMIN_RESET_TOKEN'],
    ['adminDataKey', 'ADMIN_DATA_KEY'],
    ['adminSessionSecret', 'ADMIN_SESSION_SECRET'],
  ];
  if (requiredFields.every(function (pair) { return config[pair[0]]; })) return config;
  if (typeof globalThis.EdgeKV !== 'function') return config;

  try {
    const client = new globalThis.EdgeKV({ namespace: config.kvNamespace || 'neye-orders' });
    const raw = await client.get(RUNTIME_CONFIG_KEY, { type: 'text' });
    if (!raw) return config;
    const record = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const resolved = Object.assign({}, config);
    for (const [field, key] of requiredFields) {
      if (!resolved[field]) resolved[field] = runtimeConfigValue(record, key);
    }
    return Object.assign(resolved, { runtimeConfigSource: 'edge-kv' });
  } catch {
    return config;
  }
}

export function requirePaymentConfig(config) {
  const missing = [];
  if (!config.appId) missing.push('AIPAY_APP_ID');
  if (!config.privatePkcsKey && !config.privateKey) missing.push('AIPAY_PRIVATE_PKCS_KEY');
  if (!config.alipayPublicKey) missing.push('AIPAY_ALIPAY_PUBLIC_KEY');
  if (!config.sellerId && !config.sellerEmail) missing.push('AIPAY_SELLER_ID');
  if (!config.gateway) missing.push('AIPAY_GATEWAY');
  if (!config.returnUrl) missing.push('AIPAY_RETURN_URL');
  if (!config.notifyUrl) missing.push('AIPAY_NOTIFY_URL');
  if (missing.length) {
    throw new AppError(503, 'PAYMENT_CONFIG_MISSING', '支付服务尚未配置。');
  }
}

export function requireAdminConfig(config, mode = 'login') {
  const ready = Boolean(config.adminDataKey && config.adminSessionSecret);
  const tokenReady = mode === 'setup'
    ? Boolean(config.adminSetupToken)
    : mode === 'reset'
      ? Boolean(config.adminResetToken)
      : true;
  if (!ready || !tokenReady) {
    throw new AppError(503, 'ADMIN_CONFIG_MISSING', '管理后台尚未完成安全配置。');
  }
}

export function paymentHealth(config) {
  const edgeKvReady = typeof config.edgeKvAvailable === 'boolean'
    ? config.edgeKvAvailable
    : typeof globalThis.EdgeKV === 'function';
  const checks = {
    appId: Boolean(config.appId),
    applicationPrivateKey: Boolean(config.privatePkcsKey || config.privateKey),
    alipayPublicKey: Boolean(config.alipayPublicKey),
    sellerIdentity: Boolean(config.sellerId || config.sellerEmail),
    returnUrl: Boolean(config.returnUrl),
    notifyUrl: Boolean(config.notifyUrl),
    edgeKv: edgeKvReady,
  };
  return {
    source: config.paymentConfigSource || 'environment',
    version: Number(config.paymentConfigVersion || 0),
    updatedAt: config.paymentConfigUpdatedAt || '',
    environment: config.paymentEnvironment,
    appIdMasked: maskIdentifier(config.appId),
    gatewayHost: safeHost(config.gateway),
    returnUrl: config.returnUrl,
    notifyUrl: config.notifyUrl,
    checks,
    ready: Object.values(checks).every(Boolean),
    webhook: {
      enabled: Boolean(config.webhookUrl && config.webhookSecret),
      endpoint: config.webhookUrl ? safeEndpoint(config.webhookUrl) : '',
    },
  };
}

function safeHost(value) {
  try {
    return new URL(value).host;
  } catch {
    return '';
  }
}

function safeEndpoint(value) {
  try {
    const url = new URL(value);
    return url.origin + url.pathname;
  } catch {
    return '';
  }
}

export function maskIdentifier(value) {
  const text = String(value || '');
  if (!text) return '未配置';
  if (text.length <= 6) return text.slice(0, 1) + '***' + text.slice(-1);
  return text.slice(0, 4) + '****' + text.slice(-4);
}

export function randomId(prefix = '', bytes = 12) {
  return prefix + randomBytes(bytes).toString('hex').toUpperCase();
}

export function requestId() {
  return randomId('REQ_', 8);
}

export function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

export function hmacHex(secret, value) {
  return createHmac('sha256', String(secret)).update(String(value), 'utf8').digest('hex');
}

export function constantTimeTextEqual(left, right) {
  const leftDigest = createHash('sha256').update(String(left)).digest();
  const rightDigest = createHash('sha256').update(String(right)).digest();
  let difference = 0;
  for (let index = 0; index < leftDigest.length; index += 1) {
    difference |= leftDigest[index] ^ rightDigest[index];
  }
  return difference === 0;
}

function deriveKey(secret, label) {
  if (!secret) throw new AppError(503, 'DATA_KEY_MISSING', '安全数据密钥尚未配置。');
  return createHash('sha256').update(String(secret) + ':' + label, 'utf8').digest();
}

function toBase64Url(value) {
  return Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value) {
  const text = String(value).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(text + '='.repeat((4 - (text.length % 4)) % 4), 'base64');
}

function compatMac(secret, context, iv, ciphertext) {
  return createHmac('sha256', deriveKey(secret, 'mac:' + context))
    .update(String(context), 'utf8')
    .update(iv)
    .update(ciphertext)
    .digest();
}

function encryptJsonCompat(value, secret, context) {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', deriveKey(secret, 'aes-cbc'), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final(),
  ]);
  const mac = compatMac(secret, context, iv, ciphertext);
  return ['v2', toBase64Url(iv), toBase64Url(mac), toBase64Url(ciphertext)].join('.');
}

function decryptJsonCompat(parts, secret, context) {
  const iv = fromBase64Url(parts[1]);
  const ciphertext = fromBase64Url(parts[3]);
  const expectedMac = compatMac(secret, context, iv, ciphertext);
  if (!constantTimeTextEqual(toBase64Url(expectedMac), parts[2])) throw new Error('invalid_mac');
  const decipher = createDecipheriv('aes-256-cbc', deriveKey(secret, 'aes-cbc'), iv);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString('utf8');
  return JSON.parse(plaintext);
}

export function encryptJson(value, secret, context) {
  if (!secret) throw new AppError(503, 'DATA_KEY_MISSING', '安全数据密钥尚未配置。');
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', deriveKey(secret, 'aes-gcm'), iv);
    cipher.setAAD(Buffer.from(String(context), 'utf8'));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(value), 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return ['v1', toBase64Url(iv), toBase64Url(tag), toBase64Url(ciphertext)].join('.');
  } catch {
    return encryptJsonCompat(value, secret, context);
  }
}

export function decryptJson(payload, secret, context) {
  try {
    const parts = String(payload || '').split('.');
    if (parts.length !== 4) throw new Error('invalid_envelope');
    if (parts[0] === 'v2') return decryptJsonCompat(parts, secret, context);
    if (parts[0] !== 'v1') throw new Error('invalid_envelope');
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(secret, 'aes-gcm'), fromBase64Url(parts[1]));
    decipher.setAAD(Buffer.from(String(context), 'utf8'));
    decipher.setAuthTag(fromBase64Url(parts[2]));
    const plaintext = Buffer.concat([
      decipher.update(fromBase64Url(parts[3])),
      decipher.final(),
    ]).toString('utf8');
    return JSON.parse(plaintext);
  } catch {
    throw new AppError(503, 'ENCRYPTED_DATA_INVALID', '加密数据暂时无法读取。');
  }
}

export async function encryptJsonAsync(value, secret, context) {
  return encryptJson(value, secret, context);
}

export async function decryptJsonAsync(payload, secret, context) {
  return decryptJson(payload, secret, context);
}
export function encodeSignedPayload(value, secret) {
  const encoded = toBase64Url(Buffer.from(JSON.stringify(value), 'utf8'));
  return encoded + '.' + toBase64Url(createHmac('sha256', deriveKey(secret, 'session')).update(encoded).digest());
}

export function decodeSignedPayload(value, secret) {
  try {
    const [encoded, signature, extra] = String(value || '').split('.');
    if (!encoded || !signature || extra) return null;
    const expected = toBase64Url(createHmac('sha256', deriveKey(secret, 'session')).update(encoded).digest());
    if (!constantTimeTextEqual(signature, expected)) return null;
    return JSON.parse(fromBase64Url(encoded).toString('utf8'));
  } catch {
    return null;
  }
}

export function buildSignContent(params, options = {}) {
  return Object.keys(params)
    .filter((key) => (
      key !== 'sign'
      && !(options.excludeSignType === true && key === 'sign_type')
      && params[key] !== undefined
      && params[key] !== null
      && params[key] !== ''
    ))
    .sort()
    .map((key) => key + '=' + String(params[key]))
    .join('&');
}

export function pemFromValue(value, label) {
  const text = String(value || '').trim();
  if (!text) throw new AppError(503, 'KEY_MISSING', '支付服务尚未配置。');
  if (text.includes('BEGIN')) return text.replace(/\r\n/g, '\n');
  const clean = text.replace(/\s+/g, '');
  const chunks = clean.match(/.{1,64}/g) || [];
  return '-----BEGIN ' + label + '-----\n' + chunks.join('\n') + '\n-----END ' + label + '-----';
}

export function privateKeyPem(config) {
  if (config.privatePkcsKey) return pemFromValue(config.privatePkcsKey, 'RSA PRIVATE KEY');
  return pemFromValue(config.privateKey, 'PRIVATE KEY');
}

export function alipayPublicKeyPem(config) {
  return pemFromValue(config.alipayPublicKey, 'PUBLIC KEY');
}

export function rsaSign(content, privateKey) {
  const signer = createSign('RSA-SHA256');
  signer.update(content, 'utf8');
  signer.end();
  return signer.sign(privateKey, 'base64');
}

export function rsaVerify(content, signature, publicKey) {
  try {
    const verifier = createVerify('RSA-SHA256');
    verifier.update(content, 'utf8');
    verifier.end();
    return verifier.verify(publicKey, String(signature || ''), 'base64');
  } catch {
    return false;
  }
}

export function formatAlipayTimestamp(date = new Date()) {
  const shifted = new Date(date.getTime() + BEIJING_OFFSET_MS);
  const pad = (value) => String(value).padStart(2, '0');
  return [
    shifted.getUTCFullYear(),
    pad(shifted.getUTCMonth() + 1),
    pad(shifted.getUTCDate()),
  ].join('-') + ' ' + [
    pad(shifted.getUTCHours()),
    pad(shifted.getUTCMinutes()),
    pad(shifted.getUTCSeconds()),
  ].join(':');
}

export function dateKey(value = new Date()) {
  const shifted = new Date(new Date(value).getTime() + BEIJING_OFFSET_MS);
  const pad = (part) => String(part).padStart(2, '0');
  return String(shifted.getUTCFullYear()) + pad(shifted.getUTCMonth() + 1) + pad(shifted.getUTCDate());
}

export function monthKey(value = new Date()) {
  return dateKey(value).slice(0, 6);
}

export function parseDateBoundary(text, endExclusive = false) {
  const match = String(text || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new AppError(400, 'INVALID_DATE', '日期格式应为 YYYY-MM-DD。');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const startUtc = Date.UTC(year, month - 1, day) - BEIJING_OFFSET_MS;
  const check = new Date(startUtc + BEIJING_OFFSET_MS);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new AppError(400, 'INVALID_DATE', '日期无效。');
  }
  return new Date(startUtc + (endExclusive ? 24 * 60 * 60 * 1000 : 0));
}

export function localDateString(value = new Date()) {
  return dateKey(value).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
}

export function monthsForRange(from, toExclusive) {
  const start = new Date(from.getTime() + BEIJING_OFFSET_MS);
  const end = new Date(toExclusive.getTime() - 1 + BEIJING_OFFSET_MS);
  let year = start.getUTCFullYear();
  let month = start.getUTCMonth();
  const endYear = end.getUTCFullYear();
  const endMonth = end.getUTCMonth();
  const keys = [];
  while (year < endYear || (year === endYear && month <= endMonth)) {
    keys.push(String(year) + String(month + 1).padStart(2, '0'));
    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
  }
  return keys;
}

export function addCalendarPeriod(value, unit, count = 1) {
  const original = new Date(value);
  if (Number.isNaN(original.getTime())) throw new AppError(400, 'INVALID_TIME', '时间无效。');
  const shifted = new Date(original.getTime() + BEIJING_OFFSET_MS);
  const originalDay = shifted.getUTCDate();
  let year = shifted.getUTCFullYear();
  let month = shifted.getUTCMonth();
  if (unit === 'month') {
    month += count;
    year += Math.floor(month / 12);
    month = ((month % 12) + 12) % 12;
  } else if (unit === 'year') {
    year += count;
  } else {
    throw new AppError(400, 'INVALID_PERIOD', '订阅周期无效。');
  }
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const target = Date.UTC(
    year,
    month,
    Math.min(originalDay, lastDay),
    shifted.getUTCHours(),
    shifted.getUTCMinutes(),
    shifted.getUTCSeconds(),
    shifted.getUTCMilliseconds(),
  ) - BEIJING_OFFSET_MS;
  return new Date(target).toISOString();
}

export function fenToAmount(fen) {
  if (!Number.isSafeInteger(fen) || fen < 1) throw new AppError(400, 'INVALID_AMOUNT', '金额无效。');
  return String(Math.floor(fen / 100)) + '.' + String(fen % 100).padStart(2, '0');
}

export function amountToFen(value) {
  const match = String(value ?? '').trim().match(/^(\d{1,9})(?:\.(\d{1,2}))?$/);
  if (!match) throw new AppError(400, 'INVALID_AMOUNT', '金额格式无效。');
  const fen = Number(BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0')));
  if (!Number.isSafeInteger(fen) || fen < 1 || fen > 10000000000) {
    throw new AppError(400, 'INVALID_AMOUNT', '金额超出允许范围。');
  }
  return fen;
}

export function normalizeContact(value) {
  const raw = String(value || '').trim();
  const email = raw.toLowerCase();
  if (email.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return { type: 'email', value: email };
  }
  let phone = raw.replace(/[\s()-]/g, '');
  if (phone.startsWith('+86')) phone = phone.slice(3);
  else if (phone.startsWith('86') && phone.length === 13) phone = phone.slice(2);
  if (/^1[3-9]\d{9}$/.test(phone)) {
    return { type: 'phone', value: phone };
  }
  throw new AppError(400, 'INVALID_CONTACT', '请输入有效的中国大陆手机号或邮箱。');
}

export function subscriberIdFor(config, normalizedContact) {
  if (!config.adminDataKey) throw new AppError(503, 'DATA_KEY_MISSING', '安全数据密钥尚未配置。');
  return hmacHex(config.adminDataKey, 'subscriber:' + normalizedContact.type + ':' + normalizedContact.value);
}

export function maskContact(contact) {
  if (!contact || !contact.value) return '—';
  if (contact.type === 'phone') return contact.value.slice(0, 3) + ' **** ' + contact.value.slice(-4);
  const [name, domain = ''] = contact.value.split('@');
  const shown = name.length <= 2 ? name.slice(0, 1) + '*' : name.slice(0, 2) + '***';
  return shown + '@' + domain;
}

export function shardFor(value) {
  return parseInt(sha256(value).slice(0, 2), 16) % INDEX_SHARDS;
}

export function sanitizeText(value, maxLength) {
  return String(value || '').trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, maxLength);
}

export function parseCookies(request) {
  const cookies = {};
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

export function clientFingerprint(request, config) {
  const forwarded = request.headers.get('cf-connecting-ip')
    || request.headers.get('x-forwarded-for')
    || request.headers.get('x-real-ip')
    || 'unknown';
  const ip = forwarded.split(',')[0].trim().slice(0, 80);
  return hmacHex(config.adminSessionSecret || config.adminDataKey || 'unconfigured', 'ip:' + ip).slice(0, 24);
}

export class KvStore {
  constructor(config) {
    const EdgeKVConstructor = globalThis.EdgeKV;
    if (typeof EdgeKVConstructor !== 'function') {
      throw new AppError(503, 'ESA_KV_MISSING', '边缘存储尚未配置。');
    }
    this.client = new EdgeKVConstructor({ namespace: config.kvNamespace });
  }

  async getText(key) {
    const value = await this.client.get(key, { type: 'text' });
    if (value === undefined || value === null || value === '') return null;
    return typeof value === 'string' ? value : JSON.stringify(value);
  }

  async getJson(key) {
    const value = await this.client.get(key, { type: 'text' });
    if (value === undefined || value === null || value === '') return null;
    if (typeof value === 'object') return value;
    try {
      return JSON.parse(value);
    } catch {
      throw new AppError(503, 'KV_DATA_INVALID', '存储数据暂时无法读取。');
    }
  }

  async putJson(key, value) {
    await this.client.put(key, JSON.stringify(value));
  }

  async putText(key, value) {
    await this.client.put(key, String(value));
  }

  async delete(key) {
    if (typeof this.client.delete === 'function') await this.client.delete(key);
  }

  async appendIndex(key, id, maxItems = 5000) {
    const current = await this.getJson(key);
    const values = Array.isArray(current) ? current : [];
    const next = [id, ...values.filter((item) => item !== id)].slice(0, maxItems);
    await this.putJson(key, next);
  }

  async readIndex(keys) {
    const buckets = await Promise.all(keys.map((key) => this.getJson(key)));
    const ids = [];
    const seen = new Set();
    for (const bucket of buckets) {
      if (!Array.isArray(bucket)) continue;
      for (const id of bucket) {
        if (typeof id === 'string' && !seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
      }
    }
    return ids;
  }

  async getMany(keys, concurrency = 24) {
    const results = [];
    for (let offset = 0; offset < keys.length; offset += concurrency) {
      const chunk = keys.slice(offset, offset + concurrency);
      const values = await Promise.all(chunk.map((key) => this.getJson(key)));
      results.push(...values);
    }
    return results;
  }
}

export function clampPageSize(value, fallback = 30) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(parsed, 100));
}

export function parseCursor(value) {
  const parsed = Number.parseInt(String(value || '0'), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export function assertMethod(request, expected) {
  if (request.method !== expected) {
    throw new AppError(405, 'METHOD_NOT_ALLOWED', '请求方式不支持。');
  }
}

export async function parseJsonBody(request, maxLength = 50000) {
  const body = await request.text();
  if (body.length > maxLength) throw new AppError(413, 'BODY_TOO_LARGE', '请求内容过长。');
  try {
    const payload = JSON.parse(body || '{}');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid');
    return payload;
  } catch {
    throw new AppError(400, 'INVALID_JSON', '请求内容格式不正确。');
  }
}

export function safeMeta(input, allowedKeys) {
  const result = {};
  for (const key of allowedKeys) {
    const value = input && input[key];
    if (['string', 'number', 'boolean'].includes(typeof value)) result[key] = value;
  }
  return result;
}
