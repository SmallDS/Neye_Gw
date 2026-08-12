import { createHmac, randomBytes } from 'node:crypto';
import {
  ADMIN_SESSION_SECONDS,
  AppError,
  clientFingerprint,
  constantTimeTextEqual,
  decodeSignedPayload,
  encodeSignedPayload,
  encryptJson,
  decryptJsonAsync,
  encryptJsonAsync,
  parseCookies,
  randomId,
  requireAdminConfig,
} from './core.js';

const ADMIN_AUTH_KEY = 'v2_admin_auth';
const SESSION_COOKIE = 'neye_admin_session';
const CSRF_COOKIE = 'neye_admin_csrf';
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const AUTH_RATE_LIMIT_ENABLED = false;

function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(value) {
  const clean = String(value || '').toUpperCase().replace(/=+$/g, '').replace(/\s+/g, '');
  let bits = 0;
  let accumulator = 0;
  const bytes = [];
  for (const character of clean) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) throw new AppError(400, 'TOTP_SECRET_INVALID', '动态验证码密钥无效。');
    accumulator = (accumulator << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((accumulator >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function totpCode(secret, timestampMs = Date.now(), stepSeconds = 30) {
  const step = Math.floor(timestampMs / 1000 / stepSeconds);
  const counter = Buffer.alloc(8);
  let remaining = BigInt(step);
  for (let index = 7; index >= 0; index -= 1) {
    counter[index] = Number(remaining & 255n);
    remaining >>= 8n;
  }
  const digest = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  const value = ((digest[offset] & 127) << 24)
    | ((digest[offset + 1] & 255) << 16)
    | ((digest[offset + 2] & 255) << 8)
    | (digest[offset + 3] & 255);
  return String(value % 1000000).padStart(6, '0');
}

export function verifyTotp(secret, code, options = {}) {
  const now = options.now ?? Date.now();
  const window = options.window ?? 1;
  const lastAcceptedStep = Number.isInteger(options.lastAcceptedStep) ? options.lastAcceptedStep : -1;
  const normalized = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(normalized)) return null;
  const currentStep = Math.floor(now / 1000 / 30);
  for (let offset = -window; offset <= window; offset += 1) {
    const step = currentStep + offset;
    if (step <= lastAcceptedStep || step < 0) continue;
    if (constantTimeTextEqual(totpCode(secret, step * 30000), normalized)) return step;
  }
  return null;
}

function challengeKey(id) {
  return 'v2_admin_challenge_' + id;
}

function rateKey(action, fingerprint) {
  return 'v2_rate_' + action.replace(/[^a-z0-9_]/gi, '') + '_' + fingerprint;
}

async function consumeRate(store, config, request, action, options) {
  if (!AUTH_RATE_LIMIT_ENABLED) return null;
  const now = Date.now();
  const key = rateKey(action, clientFingerprint(request, config));
  const current = await store.getJson(key) || { windowStartedAt: now, count: 0, lockedUntil: 0 };
  if (current.lockedUntil > now) {
    throw new AppError(429, 'RATE_LIMITED', '尝试次数过多，请稍后再试。', {
      retryAfterSeconds: Math.ceil((current.lockedUntil - now) / 1000),
    });
  }
  if (now - current.windowStartedAt >= options.windowMs) {
    current.windowStartedAt = now;
    current.count = 0;
  }
  current.count += 1;
  if (current.count > options.limit) {
    current.lockedUntil = now + options.lockMs;
    await store.putJson(key, current);
    throw new AppError(429, 'RATE_LIMITED', '尝试次数过多，请稍后再试。', {
      retryAfterSeconds: Math.ceil(options.lockMs / 1000),
    });
  }
  await store.putJson(key, current);
  return key;
}

function createSecret() {
  return base32Encode(randomBytes(20));
}

function otpauthUri(secret) {
  const issuer = 'NEye 官网';
  const account = 'admin@smallds.icu';
  return 'otpauth://totp/' + encodeURIComponent(issuer + ':' + account)
    + '?secret=' + encodeURIComponent(secret)
    + '&issuer=' + encodeURIComponent(issuer)
    + '&algorithm=SHA1&digits=6&period=30';
}

function verifyToken(provided, expected) {
  if (!provided || !expected || !constantTimeTextEqual(provided, expected)) {
    throw new AppError(401, 'ADMIN_TOKEN_INVALID', '管理员安全令牌无效。');
  }
}

function issueSession(config, credential) {
  const now = Math.floor(Date.now() / 1000);
  const csrfToken = randomBytes(24).toString('hex');
  const session = {
    version: credential.version,
    issuedAt: now,
    expiresAt: now + ADMIN_SESSION_SECONDS,
    csrf: csrfToken,
    nonce: randomId('', 10),
  };
  const encoded = encodeSignedPayload(session, config.adminSessionSecret);
  return {
    csrfToken,
    session,
    cookies: [
      SESSION_COOKIE + '=' + encodeURIComponent(encoded)
        + '; Path=/; Max-Age=' + ADMIN_SESSION_SECONDS
        + '; HttpOnly; Secure; SameSite=Strict',
      CSRF_COOKIE + '=' + encodeURIComponent(csrfToken)
        + '; Path=/; Max-Age=' + ADMIN_SESSION_SECONDS
        + '; Secure; SameSite=Strict',
    ],
  };
}

export function clearSessionCookies() {
  return [
    SESSION_COOKIE + '=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict',
    CSRF_COOKIE + '=; Path=/; Max-Age=0; Secure; SameSite=Strict',
  ];
}

async function readCredential(store, config) {
  const record = await store.getJson(ADMIN_AUTH_KEY);
  if (!record) return null;
  const secret = await decryptJsonAsync(record.secretCipher, config.adminDataKey, ADMIN_AUTH_KEY);
  return Object.assign({}, record, { secret: secret.value });
}

async function saveCredential(store, config, credential) {
  const stored = Object.assign({}, credential, {
    secretCipher: await encryptJsonAsync({ value: credential.secret }, config.adminDataKey, ADMIN_AUTH_KEY),
  });
  delete stored.secret;
  await store.putJson(ADMIN_AUTH_KEY, stored);
}

export async function getAuthState(store, config) {
  const configured = Boolean(await store.getJson(ADMIN_AUTH_KEY));
  return {
    configured,
    setupAvailable: Boolean(config.adminSetupToken && config.adminDataKey && config.adminSessionSecret),
    resetAvailable: Boolean(config.adminResetToken && config.adminDataKey && config.adminSessionSecret),
  };
}

async function startChallenge(store, config, request, input, mode) {
  requireAdminConfig(config, mode);
  const rate = await consumeRate(store, config, request, mode + '_start', {
    limit: 3,
    windowMs: 10 * 60 * 1000,
    lockMs: 20 * 60 * 1000,
  });
  const existing = await store.getJson(ADMIN_AUTH_KEY);
  if (mode === 'setup' && existing) {
    throw new AppError(409, 'ADMIN_ALREADY_CONFIGURED', '管理员动态验证已经绑定。');
  }
  if (mode === 'reset' && !existing) {
    throw new AppError(409, 'ADMIN_NOT_CONFIGURED', '管理员动态验证尚未绑定。');
  }
  verifyToken(input.token, mode === 'setup' ? config.adminSetupToken : config.adminResetToken);

  const id = randomId('', 12);
  const secret = createSecret();
  const challenge = {
    id,
    mode,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    secretCipher: await encryptJsonAsync({ value: secret }, config.adminDataKey, challengeKey(id)),
    fingerprint: clientFingerprint(request, config),
  };
  await store.putJson(challengeKey(id), challenge);
  if (rate) await store.delete(rate);
  return {
    challengeId: id,
    secret,
    otpauthUri: otpauthUri(secret),
    expiresAt: challenge.expiresAt,
  };
}

async function confirmChallenge(store, config, request, input, mode) {
  requireAdminConfig(config, mode);
  const rate = await consumeRate(store, config, request, mode + '_confirm', {
    limit: 5,
    windowMs: 10 * 60 * 1000,
    lockMs: 20 * 60 * 1000,
  });
  verifyToken(input.token, mode === 'setup' ? config.adminSetupToken : config.adminResetToken);
  if (!/^[A-F0-9]{24}$/.test(String(input.challengeId || ''))) {
    throw new AppError(400, 'ADMIN_CHALLENGE_INVALID', '绑定请求无效或已过期。');
  }
  const key = challengeKey(input.challengeId);
  const challenge = await store.getJson(key);
  if (!challenge || challenge.mode !== mode || Date.parse(challenge.expiresAt) <= Date.now()) {
    throw new AppError(410, 'ADMIN_CHALLENGE_EXPIRED', '绑定请求无效或已过期。');
  }
  if (challenge.fingerprint !== clientFingerprint(request, config)) {
    throw new AppError(401, 'ADMIN_CHALLENGE_MISMATCH', '绑定请求与当前访问不匹配。');
  }
  const secret = (await decryptJsonAsync(challenge.secretCipher, config.adminDataKey, key)).value;
  const acceptedStep = verifyTotp(secret, input.code);
  if (acceptedStep === null) {
    throw new AppError(401, 'TOTP_INVALID', '动态验证码不正确或已使用。');
  }
  const existing = await store.getJson(ADMIN_AUTH_KEY);
  if (mode === 'setup' && existing) {
    throw new AppError(409, 'ADMIN_ALREADY_CONFIGURED', '管理员动态验证已经绑定。');
  }
  const credential = {
    version: mode === 'reset' ? Number(existing?.version || 0) + 1 : 1,
    secret,
    lastAcceptedStep: acceptedStep,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await saveCredential(store, config, credential);
  await store.delete(key);
  if (rate) await store.delete(rate);
  return issueSession(config, credential);
}

export async function startSetup(store, config, request, input) {
  return startChallenge(store, config, request, input, 'setup');
}

export async function confirmSetup(store, config, request, input) {
  return confirmChallenge(store, config, request, input, 'setup');
}

export async function startReset(store, config, request, input) {
  return startChallenge(store, config, request, input, 'reset');
}

export async function confirmReset(store, config, request, input) {
  return confirmChallenge(store, config, request, input, 'reset');
}

export async function login(store, config, request, input) {
  requireAdminConfig(config, 'login');
  const rate = await consumeRate(store, config, request, 'login', {
    limit: 5,
    windowMs: 60 * 1000,
    lockMs: 10 * 60 * 1000,
  });
  const credential = await readCredential(store, config);
  if (!credential) throw new AppError(409, 'ADMIN_NOT_CONFIGURED', '管理员动态验证尚未绑定。');
  const acceptedStep = verifyTotp(credential.secret, input.code, {
    lastAcceptedStep: credential.lastAcceptedStep,
  });
  if (acceptedStep === null) {
    throw new AppError(401, 'TOTP_INVALID', '动态验证码不正确或已使用。');
  }
  credential.lastAcceptedStep = acceptedStep;
  credential.updatedAt = new Date().toISOString();
  await saveCredential(store, config, credential);
  if (rate) await store.delete(rate);
  return issueSession(config, credential);
}

export async function verifySensitiveTotp(store, config, request, code) {
  requireAdminConfig(config, 'login');
  const rate = await consumeRate(store, config, request, 'sensitive_totp', {
    limit: 5,
    windowMs: 10 * 60 * 1000,
    lockMs: 10 * 60 * 1000,
  });
  const credential = await readCredential(store, config);
  if (!credential) throw new AppError(409, 'ADMIN_NOT_CONFIGURED', '管理员动态验证尚未绑定。');
  const acceptedStep = verifyTotp(credential.secret, code, {
    lastAcceptedStep: credential.lastAcceptedStep,
  });
  if (acceptedStep === null) {
    throw new AppError(401, 'TOTP_INVALID', '动态验证码不正确或已使用。');
  }
  credential.lastAcceptedStep = acceptedStep;
  credential.updatedAt = new Date().toISOString();
  await saveCredential(store, config, credential);
  if (rate) await store.delete(rate);
  return acceptedStep;
}

export async function requireAdminSession(store, config, request, options = {}) {
  requireAdminConfig(config, 'login');
  const cookies = parseCookies(request);
  const session = decodeSignedPayload(cookies[SESSION_COOKIE], config.adminSessionSecret);
  const now = Math.floor(Date.now() / 1000);
  if (!session || !Number.isInteger(session.expiresAt) || session.expiresAt <= now) {
    throw new AppError(401, 'ADMIN_AUTH_REQUIRED', '管理员会话已失效，请重新验证。');
  }
  const credential = await store.getJson(ADMIN_AUTH_KEY);
  if (!credential || credential.version !== session.version) {
    throw new AppError(401, 'ADMIN_AUTH_REQUIRED', '管理员会话已失效，请重新验证。');
  }
  if (options.csrf === true) {
    const headerToken = request.headers.get('x-csrf-token') || '';
    const cookieToken = cookies[CSRF_COOKIE] || '';
    if (!headerToken || !constantTimeTextEqual(headerToken, cookieToken) || !constantTimeTextEqual(headerToken, session.csrf)) {
      throw new AppError(403, 'CSRF_INVALID', '安全校验失败，请刷新页面后重试。');
    }
    const origin = request.headers.get('origin');
    if (origin && origin !== config.baseUrl) {
      throw new AppError(403, 'ORIGIN_INVALID', '请求来源不受信任。');
    }
  }
  return {
    version: session.version,
    expiresAt: new Date(session.expiresAt * 1000).toISOString(),
    csrfToken: session.csrf,
  };
}
