import { randomBytes } from 'node:crypto';
import {
  ADMIN_SESSION_SECONDS,
  AppError,
  clientFingerprint,
  constantTimeTextEqual,
  decodeSignedPayload,
  encodeSignedPayload,
  hmacHex,
  parseCookies,
  randomId,
  requireAdminConfig,
} from './core.js';

const SESSION_COOKIE = '__Host-neye_admin_session';
const CSRF_COOKIE = '__Host-neye_admin_csrf';
const AUTH_RATE_LIMIT_ENABLED = true;

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function credentialsConfigured(config) {
  const username = String(config.adminUsername || '').trim();
  const password = String(config.adminPassword || '');
  return /^[A-Za-z0-9._-]{3,64}$/.test(username)
    && password.length >= 12
    && password.length <= 256
    && Boolean(config.adminDataKey && config.adminSessionSecret);
}

function configurationChecks(config) {
  const username = String(config.adminUsername || '').trim();
  const password = String(config.adminPassword || '');
  return {
    username: /^[A-Za-z0-9._-]{3,64}$/.test(username),
    password: password.length >= 12 && password.length <= 256,
    dataKey: Boolean(config.adminDataKey),
    sessionSecret: Boolean(config.adminSessionSecret),
  };
}

function credentialVersion(config) {
  return hmacHex(
    config.adminSessionSecret,
    'password-auth:' + normalizeUsername(config.adminUsername) + '\u0000' + String(config.adminPassword || '')
  ).slice(0, 32);
}

function rateKey(action, fingerprint) {
  return 'v2_rate_' + action.replace(/[^a-z0-9_]/gi, '') + '_' + fingerprint;
}

function runSessionStage(stage, action) {
  try {
    return action();
  } catch {
    throw new AppError(503, 'ADMIN_LOGIN_STAGE_FAILED', '管理员登录服务暂时不可用。', {
      stage,
    });
  }
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

function issueSession(config) {
  const now = Math.floor(Date.now() / 1000);
  const csrfToken = runSessionStage('csrf_random', function () {
    return randomBytes(24).toString('hex');
  });
  const session = {
    version: runSessionStage('credential_version', function () {
      return credentialVersion(config);
    }),
    username: normalizeUsername(config.adminUsername),
    issuedAt: now,
    expiresAt: now + ADMIN_SESSION_SECONDS,
    csrf: csrfToken,
    nonce: runSessionStage('nonce_random', function () {
      return randomId('', 10);
    }),
  };
  const encoded = runSessionStage('token_encode', function () {
    return encodeSignedPayload(session, config.adminSessionSecret);
  });
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

export async function getAuthState(_store, config) {
  const configured = credentialsConfigured(config);
  return {
    mode: 'password',
    configured,
    loginAvailable: configured,
    configurationSource: config.runtimeConfigSource || 'environment',
    checks: configurationChecks(config),
  };
}

export async function login(store, config, request, input) {
  requireAdminConfig(config);
  const rate = await consumeRate(store, config, request, 'login', {
    limit: 5,
    windowMs: 60 * 1000,
    lockMs: 10 * 60 * 1000,
  });
  const providedUsername = normalizeUsername(input.username);
  const providedPassword = typeof input.password === 'string' ? input.password : '';
  const usernameMatches = constantTimeTextEqual(providedUsername, normalizeUsername(config.adminUsername));
  const passwordMatches = constantTimeTextEqual(providedPassword, config.adminPassword);
  const inputShapeValid = /^[a-z0-9._-]{3,64}$/.test(providedUsername)
    && providedPassword.length <= 256;
  if (!inputShapeValid || !usernameMatches || !passwordMatches) {
    throw new AppError(401, 'ADMIN_CREDENTIALS_INVALID', '账号或密码不正确。');
  }
  if (rate) {
    try {
      await store.putJson(rate, { windowStartedAt: Date.now(), count: 0, lockedUntil: 0 });
    } catch {
      // 正确凭据已经通过校验，限流计数清理失败不应阻断登录。
    }
  }
  return issueSession(config);
}

export async function verifySensitivePassword(store, config, request, password) {
  requireAdminConfig(config);
  const rate = await consumeRate(store, config, request, 'sensitive_password', {
    limit: 5,
    windowMs: 10 * 60 * 1000,
    lockMs: 10 * 60 * 1000,
  });
  const providedPassword = typeof password === 'string' ? password : '';
  if (providedPassword.length > 256 || !constantTimeTextEqual(providedPassword, config.adminPassword)) {
    throw new AppError(401, 'ADMIN_PASSWORD_INVALID', '管理员密码不正确。');
  }
  if (rate) {
    try {
      await store.putJson(rate, { windowStartedAt: Date.now(), count: 0, lockedUntil: 0 });
    } catch {
      // 正确密码已经通过校验，限流计数清理失败不应阻断敏感操作。
    }
  }
  return true;
}

export async function requireAdminSession(_store, config, request, options = {}) {
  requireAdminConfig(config);
  const cookies = parseCookies(request);
  const session = decodeSignedPayload(cookies[SESSION_COOKIE], config.adminSessionSecret);
  const now = Math.floor(Date.now() / 1000);
  if (!session
    || !Number.isInteger(session.expiresAt)
    || session.expiresAt <= now
    || !constantTimeTextEqual(session.version, credentialVersion(config))) {
    throw new AppError(401, 'ADMIN_AUTH_REQUIRED', '管理员会话已失效，请重新登录。');
  }
  if (options.csrf === true) {
    const headerToken = request.headers.get('x-csrf-token') || '';
    const cookieToken = cookies[CSRF_COOKIE] || '';
    if (!headerToken
      || !constantTimeTextEqual(headerToken, cookieToken)
      || !constantTimeTextEqual(headerToken, session.csrf)) {
      throw new AppError(403, 'CSRF_INVALID', '安全校验失败，请刷新页面后重试。');
    }
    const origin = request.headers.get('origin') || '';
    if (origin !== config.baseUrl) {
      throw new AppError(403, 'ORIGIN_INVALID', '请求来源不受信任。');
    }
  }
  return {
    username: session.username,
    version: session.version,
    expiresAt: new Date(session.expiresAt * 1000).toISOString(),
    csrfToken: session.csrf,
  };
}
