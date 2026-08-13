import {
  AppError,
  decryptJson,
  encryptJson,
  maskIdentifier,
  PRODUCTION_GATEWAY,
  SANDBOX_GATEWAY,
  sha256,
} from './core.js';

const PAYMENT_CONFIG_KEY = 'v2_payment_config';
const PAYMENT_CONFIG_SCHEMA = 1;
const PRIVATE_KEY_MAX_LENGTH = 12000;
const PUBLIC_KEY_MAX_LENGTH = 8000;

function cleanText(value, maxLength) {
  const text = String(value ?? '').trim();
  if (text.length > maxLength) {
    throw new AppError(400, 'PAYMENT_CONFIG_VALUE_TOO_LONG', '支付配置内容过长。');
  }
  if (/[\u0000-\u001f\u007f]/.test(text)) {
    throw new AppError(400, 'PAYMENT_CONFIG_VALUE_INVALID', '支付配置内容包含无效字符。');
  }
  return text;
}

function rawBase64Key(value, maxLength, label) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (text.length > maxLength
    || /\s/.test(text)
    || /-----BEGIN|-----END/i.test(text)
    || !/^[A-Za-z0-9+/=]+$/.test(text)) {
    throw new AppError(
      400,
      'PAYMENT_KEY_FORMAT_INVALID',
      label + '应为不含 PEM 头尾和空白的原始 Base64 内容。'
    );
  }
  return text;
}

function decodeBase64Der(value) {
  const unpadded = String(value || '').replace(/=+$/g, '');
  const padded = unpadded + '='.repeat((4 - (unpadded.length % 4)) % 4);
  const binary = atob(padded);
  if (btoa(binary).replace(/=+$/g, '') !== unpadded) throw new Error('invalid_base64');
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function readDerElement(bytes, offset) {
  if (!Number.isInteger(offset) || offset < 0 || offset >= bytes.length) throw new Error('invalid_der_offset');
  const tag = bytes[offset];
  let cursor = offset + 1;
  if (cursor >= bytes.length) throw new Error('invalid_der_length');
  const firstLength = bytes[cursor];
  cursor += 1;
  let length = firstLength;
  if ((firstLength & 0x80) !== 0) {
    const lengthBytes = firstLength & 0x7f;
    if (lengthBytes === 0 || lengthBytes > 4 || cursor + lengthBytes > bytes.length || bytes[cursor] === 0) {
      throw new Error('invalid_der_length');
    }
    length = 0;
    for (let index = 0; index < lengthBytes; index += 1) length = (length * 256) + bytes[cursor + index];
    if (length < 128) throw new Error('non_canonical_der_length');
    cursor += lengthBytes;
  }
  const end = cursor + length;
  if (end > bytes.length) throw new Error('truncated_der');
  return { tag, start: cursor, end, next: end };
}

function derChildren(bytes, sequence) {
  if (sequence.tag !== 0x30) throw new Error('expected_der_sequence');
  const children = [];
  let cursor = sequence.start;
  while (cursor < sequence.end) {
    const child = readDerElement(bytes, cursor);
    if (child.end > sequence.end) throw new Error('child_outside_sequence');
    children.push(child);
    cursor = child.next;
  }
  if (cursor !== sequence.end) throw new Error('invalid_sequence_length');
  return children;
}

function positiveIntegerInfo(bytes, element) {
  if (element.tag !== 0x02 || element.start >= element.end) throw new Error('expected_positive_integer');
  const first = bytes[element.start];
  if ((first & 0x80) !== 0) throw new Error('negative_integer');
  if (element.end - element.start > 1 && first === 0 && (bytes[element.start + 1] & 0x80) === 0) {
    throw new Error('non_canonical_integer');
  }
  let cursor = element.start;
  while (cursor < element.end && bytes[cursor] === 0) cursor += 1;
  if (cursor === element.end) throw new Error('zero_integer');
  const significantLength = element.end - cursor;
  let leadingZeroBits = 0;
  for (let mask = 0x80; mask > 0 && (bytes[cursor] & mask) === 0; mask >>= 1) leadingZeroBits += 1;
  let numericValue = null;
  if (significantLength <= 6) {
    numericValue = 0;
    for (let index = cursor; index < element.end; index += 1) numericValue = (numericValue * 256) + bytes[index];
  }
  return {
    bitLength: (significantLength * 8) - leadingZeroBits,
    numericValue,
  };
}

function assertRsaParameters(bytes, modulusElement, exponentElement) {
  const modulus = positiveIntegerInfo(bytes, modulusElement);
  const exponent = positiveIntegerInfo(bytes, exponentElement);
  if (modulus.bitLength < 2048 || modulus.bitLength > 16384) throw new Error('unsupported_modulus_length');
  if (exponent.numericValue === null || exponent.numericValue < 3 || exponent.numericValue % 2 === 0) {
    throw new Error('invalid_public_exponent');
  }
}

// ESA's Node crypto shim does not reliably expose createPrivateKey/createPublicKey, so validate the standard DER envelopes directly.
function assertPkcs1PrivateKey(value) {
  const bytes = decodeBase64Der(value);
  const root = readDerElement(bytes, 0);
  if (root.tag !== 0x30 || root.next !== bytes.length) throw new Error('invalid_private_key_envelope');
  const parts = derChildren(bytes, root);
  if (parts.length !== 9) throw new Error('invalid_private_key_fields');
  if (parts[0].tag !== 0x02 || parts[0].end - parts[0].start !== 1 || bytes[parts[0].start] !== 0) {
    throw new Error('unsupported_private_key_version');
  }
  assertRsaParameters(bytes, parts[1], parts[2]);
  for (let index = 3; index < parts.length; index += 1) positiveIntegerInfo(bytes, parts[index]);
}

function assertSpkiPublicKey(value) {
  const bytes = decodeBase64Der(value);
  const root = readDerElement(bytes, 0);
  if (root.tag !== 0x30 || root.next !== bytes.length) throw new Error('invalid_public_key_envelope');
  const rootParts = derChildren(bytes, root);
  if (rootParts.length !== 2) throw new Error('invalid_spki_fields');
  const algorithmParts = derChildren(bytes, rootParts[0]);
  const rsaOid = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];
  if (algorithmParts.length !== 2
    || algorithmParts[0].tag !== 0x06
    || algorithmParts[0].end - algorithmParts[0].start !== rsaOid.length
    || algorithmParts[1].tag !== 0x05
    || algorithmParts[1].start !== algorithmParts[1].end) {
    throw new Error('unsupported_public_key_algorithm');
  }
  for (let index = 0; index < rsaOid.length; index += 1) {
    if (bytes[algorithmParts[0].start + index] !== rsaOid[index]) throw new Error('unsupported_public_key_oid');
  }
  const bitString = rootParts[1];
  if (bitString.tag !== 0x03 || bitString.end - bitString.start < 2 || bytes[bitString.start] !== 0) {
    throw new Error('invalid_public_key_bit_string');
  }
  const rsaSequence = readDerElement(bytes, bitString.start + 1);
  if (rsaSequence.tag !== 0x30 || rsaSequence.next !== bitString.end) throw new Error('invalid_rsa_public_key');
  const rsaParts = derChildren(bytes, rsaSequence);
  if (rsaParts.length !== 2) throw new Error('invalid_rsa_public_key_fields');
  assertRsaParameters(bytes, rsaParts[0], rsaParts[1]);
}

function assertRsaPrivateKey(value) {
  try {
    assertPkcs1PrivateKey(value);
  } catch {
    throw new AppError(400, 'PAYMENT_PRIVATE_KEY_INVALID', '应用私钥不是有效的 2048 位或更高强度 RSA PKCS#1 私钥。');
  }
}

function assertRsaPublicKey(value) {
  try {
    assertSpkiPublicKey(value);
  } catch {
    throw new AppError(400, 'PAYMENT_PUBLIC_KEY_INVALID', '支付宝公钥不是有效的 2048 位或更高强度 RSA 公钥。');
  }
}

function normalizeBaseUrl(value) {
  const text = cleanText(value, 500);
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('unsafe');
    if (url.pathname !== '/' && url.pathname !== '') throw new Error('not_origin');
    return url.origin;
  } catch {
    throw new AppError(400, 'PAYMENT_BASE_URL_INVALID', '官网地址必须是 HTTPS 域名，不包含路径、参数或账号信息。');
  }
}

function isPrivateHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '::1'
    || /^(?:fc|fd)[0-9a-f]*:/i.test(host)
    || /^fe[89ab][0-9a-f]*:/i.test(host)
    || host.startsWith('::ffff:127.')) return true;
  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => part < 0 || part > 255)) return true;
  return parts[0] === 0
    || parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

function normalizeWebhookUrl(value) {
  const text = cleanText(value, 1000);
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || isPrivateHostname(url.hostname)) {
      throw new Error('unsafe');
    }
    return url.toString();
  } catch {
    throw new AppError(400, 'WEBHOOK_URL_INVALID', 'Webhook 地址必须是可公开访问的 HTTPS 地址。');
  }
}

function normalizeWebhookSecret(value) {
  const text = cleanText(value, 512);
  if (!text) return '';
  if (text.length < 32) {
    throw new AppError(400, 'WEBHOOK_SECRET_WEAK', 'Webhook 签名密钥至少需要 32 个字符。');
  }
  return text;
}

function fingerprint(value) {
  const text = String(value || '').replace(/\s+/g, '');
  return text ? sha256(text).slice(0, 12).toUpperCase() : '';
}

function gatewayFor(environment) {
  return environment === 'production' ? PRODUCTION_GATEWAY : SANDBOX_GATEWAY;
}

async function readStoredConfig(store, rootConfig) {
  const record = await store.getJson(PAYMENT_CONFIG_KEY);
  if (!record) return null;
  if (record.schemaVersion !== PAYMENT_CONFIG_SCHEMA
    || !Number.isInteger(record.version)
    || !record.configCipher) {
    throw new AppError(503, 'PAYMENT_CONFIG_INVALID', '加密支付配置暂时无法读取。');
  }
  let data;
  try {
    data = decryptJson(record.configCipher, rootConfig.adminDataKey, PAYMENT_CONFIG_KEY);
  } catch {
    throw new AppError(503, 'PAYMENT_CONFIG_UNREADABLE', '加密支付配置暂时无法读取，请检查后台根密钥。');
  }
  if (!data || typeof data !== 'object' || data.schemaVersion !== PAYMENT_CONFIG_SCHEMA) {
    throw new AppError(503, 'PAYMENT_CONFIG_INVALID', '加密支付配置暂时无法读取。');
  }
  return { record, data };
}

function effectiveFrom(rootConfig, stored) {
  const data = stored?.data;
  const effective = Object.assign({}, rootConfig);
  if (data) {
    Object.assign(effective, {
      appId: data.appId || '',
      privatePkcsKey: data.privatePkcsKey || '',
      privateKey: '',
      alipayPublicKey: data.alipayPublicKey || '',
      sellerId: data.sellerId || '',
      sellerEmail: data.sellerEmail || '',
      paymentEnvironment: data.paymentEnvironment === 'production' ? 'production' : 'sandbox',
      baseUrl: data.baseUrl || rootConfig.baseUrl,
      returnUrl: data.returnUrl || '',
      notifyUrl: data.notifyUrl || '',
      webhookUrl: data.webhookUrl || '',
      webhookSecret: data.webhookSecret || '',
    });
  }
  effective.gateway = gatewayFor(effective.paymentEnvironment);
  effective.paymentConfigSource = stored ? 'admin' : 'environment';
  effective.paymentConfigVersion = stored?.record.version || 0;
  effective.paymentConfigUpdatedAt = stored?.record.updatedAt || '';
  effective.edgeKvAvailable = true;
  return effective;
}

function safeView(config) {
  let gatewayHost = '';
  try {
    gatewayHost = new URL(config.gateway).host;
  } catch {
    gatewayHost = '';
  }
  return {
    source: config.paymentConfigSource || 'environment',
    version: Number(config.paymentConfigVersion || 0),
    updatedAt: config.paymentConfigUpdatedAt || '',
    environment: config.paymentEnvironment,
    appId: config.appId || '',
    appIdMasked: maskIdentifier(config.appId),
    sellerId: config.sellerId || '',
    sellerEmail: config.sellerEmail || '',
    baseUrl: config.baseUrl || '',
    returnUrl: config.returnUrl || '',
    notifyUrl: config.notifyUrl || '',
    gatewayHost,
    webhookEnabled: Boolean(config.webhookUrl && config.webhookSecret),
    webhookUrl: config.webhookUrl || '',
    secrets: {
      applicationPrivateKey: {
        configured: Boolean(config.privatePkcsKey || config.privateKey),
        fingerprint: fingerprint(config.privatePkcsKey || config.privateKey),
      },
      alipayPublicKey: {
        configured: Boolean(config.alipayPublicKey),
        fingerprint: fingerprint(config.alipayPublicKey),
      },
      webhookSecret: {
        configured: Boolean(config.webhookSecret),
        fingerprint: fingerprint(config.webhookSecret),
      },
    },
  };
}

export async function resolvePaymentConfig(store, rootConfig) {
  return effectiveFrom(rootConfig, await readStoredConfig(store, rootConfig));
}

export async function getPaymentConfigView(store, rootConfig) {
  return safeView(await resolvePaymentConfig(store, rootConfig));
}

export async function getPaymentConfigState(store, rootConfig) {
  const effectiveConfig = await resolvePaymentConfig(store, rootConfig);
  return {
    paymentConfig: safeView(effectiveConfig),
    effectiveConfig,
  };
}

function candidateFromInput(input, current) {
  const paymentEnvironment = String(input.paymentEnvironment || '').toLowerCase();
  if (!['sandbox', 'production'].includes(paymentEnvironment)) {
    throw new AppError(400, 'PAYMENT_ENVIRONMENT_INVALID', '请选择有效的支付环境。');
  }

  const appId = cleanText(input.appId, 32);
  if (!/^\d{8,32}$/.test(appId)) {
    throw new AppError(400, 'PAYMENT_APP_ID_INVALID', '支付宝 APP ID 格式不正确。');
  }

  const sellerId = cleanText(input.sellerId, 32);
  const sellerEmail = cleanText(input.sellerEmail, 160).toLowerCase();
  if (sellerId && !/^\d{16,32}$/.test(sellerId)) {
    throw new AppError(400, 'PAYMENT_SELLER_ID_INVALID', '支付宝商户 UID 格式不正确。');
  }
  if (sellerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(sellerEmail)) {
    throw new AppError(400, 'PAYMENT_SELLER_EMAIL_INVALID', '支付宝商户邮箱格式不正确。');
  }
  if (!sellerId && !sellerEmail) {
    throw new AppError(400, 'PAYMENT_SELLER_MISSING', '请配置支付宝商户 UID 或商户邮箱。');
  }

  const privateInput = rawBase64Key(input.privatePkcsKey, PRIVATE_KEY_MAX_LENGTH, '应用私钥');
  const retainedPrivate = rawBase64Key(current.privatePkcsKey, PRIVATE_KEY_MAX_LENGTH, '应用私钥');
  const privatePkcsKey = privateInput || retainedPrivate;
  if (!privatePkcsKey) {
    throw new AppError(400, 'PAYMENT_PRIVATE_KEY_REQUIRED', '首次保存需要填写 Node.js 使用的 PKCS#1 应用私钥。');
  }
  assertRsaPrivateKey(privatePkcsKey);

  const publicInput = rawBase64Key(input.alipayPublicKey, PUBLIC_KEY_MAX_LENGTH, '支付宝公钥');
  const retainedPublic = rawBase64Key(current.alipayPublicKey, PUBLIC_KEY_MAX_LENGTH, '支付宝公钥');
  const alipayPublicKey = publicInput || retainedPublic;
  if (!alipayPublicKey) {
    throw new AppError(400, 'PAYMENT_PUBLIC_KEY_REQUIRED', '首次保存需要填写支付宝公钥。');
  }
  assertRsaPublicKey(alipayPublicKey);

  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const webhookEnabled = input.webhookEnabled === true;
  let webhookUrl = '';
  let webhookSecret = '';
  if (webhookEnabled) {
    webhookUrl = normalizeWebhookUrl(input.webhookUrl);
    webhookSecret = normalizeWebhookSecret(input.webhookSecret || current.webhookSecret);
    if (!webhookSecret) {
      throw new AppError(400, 'WEBHOOK_SECRET_REQUIRED', '启用 Webhook 时需要填写签名密钥。');
    }
  }

  return {
    schemaVersion: PAYMENT_CONFIG_SCHEMA,
    appId,
    privatePkcsKey,
    alipayPublicKey,
    sellerId,
    sellerEmail,
    paymentEnvironment,
    baseUrl,
    returnUrl: baseUrl + '/api/payment/return',
    notifyUrl: baseUrl + '/api/payment/notify',
    webhookUrl,
    webhookSecret,
  };
}

function changedFields(current, candidate) {
  const fields = [
    'appId',
    'sellerId',
    'sellerEmail',
    'paymentEnvironment',
    'baseUrl',
    'returnUrl',
    'notifyUrl',
    'webhookUrl',
  ];
  const changed = fields.filter((field) => String(current[field] || '') !== String(candidate[field] || ''));
  if (fingerprint(current.privatePkcsKey || current.privateKey) !== fingerprint(candidate.privatePkcsKey)) {
    changed.push('applicationPrivateKey');
  }
  if (fingerprint(current.alipayPublicKey) !== fingerprint(candidate.alipayPublicKey)) {
    changed.push('alipayPublicKey');
  }
  if (fingerprint(current.webhookSecret) !== fingerprint(candidate.webhookSecret)) {
    changed.push('webhookSecret');
  }
  return changed;
}

export async function savePaymentConfig(store, rootConfig, input, authorize) {
  const stored = await readStoredConfig(store, rootConfig);
  const current = effectiveFrom(rootConfig, stored);
  const candidate = candidateFromInput(input, current);
  const changed = changedFields(current, candidate);
  if (typeof authorize === 'function') await authorize();

  const updatedAt = new Date().toISOString();
  const version = Number(stored?.record.version || 0) + 1;
  await store.putJson(PAYMENT_CONFIG_KEY, {
    schemaVersion: PAYMENT_CONFIG_SCHEMA,
    version,
    createdAt: stored?.record.createdAt || updatedAt,
    updatedAt,
    configCipher: encryptJson(candidate, rootConfig.adminDataKey, PAYMENT_CONFIG_KEY),
  });

  const effectiveConfig = effectiveFrom(rootConfig, {
    record: { version, updatedAt },
    data: candidate,
  });
  return {
    paymentConfig: safeView(effectiveConfig),
    effectiveConfig,
    changedFields: changed,
  };
}

export const PAYMENT_CONFIG_STORAGE_KEY = PAYMENT_CONFIG_KEY;
