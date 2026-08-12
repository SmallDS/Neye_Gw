import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import {
  addCalendarPeriod,
  amountToFen,
  buildSignContent,
  decryptJson,
  encodeSignedPayload,
  encryptJson,
  fenToAmount,
  normalizeContact,
  rsaSign,
  rsaVerify,
} from '../esa/lib/core.js';
import { totpCode } from '../esa/lib/auth.js';
import {
  expectedSellerMatches,
  extractRawResponseObject,
  verifyAlipayResponse,
} from '../esa/lib/alipay.js';
import { routeRequest } from '../esa/lib/api.js';
import { readOrder, readSubscriber } from '../esa/lib/domain.js';
import {
  PAYMENT_CONFIG_STORAGE_KEY,
  resolvePaymentConfig,
} from '../esa/lib/payment-config.js';
import { updatePlanConfig } from '../esa/lib/plans.js';
import {
  emitSubscriptionEvent,
  retryWebhook,
} from '../esa/lib/webhook.js';

class MemoryStore {
  constructor() {
    this.values = new Map();
    this.staleReadPrefixes = new Set();
  }

  staleOnce(prefix) {
    this.staleReadPrefixes.add(prefix);
  }

  clone(value) {
    return value === null || value === undefined ? value : structuredClone(value);
  }

  async getText(key) {
    const value = this.values.get(key);
    if (value === undefined) return null;
    return typeof value === 'string' ? value : JSON.stringify(value);
  }

  async getJson(key) {
    for (const prefix of this.staleReadPrefixes) {
      if (key.startsWith(prefix)) {
        this.staleReadPrefixes.delete(prefix);
        return null;
      }
    }
    const value = this.values.get(key);
    if (value === undefined) return null;
    if (typeof value === 'string') return JSON.parse(value);
    return this.clone(value);
  }

  async putJson(key, value) {
    this.values.set(key, this.clone(value));
  }

  async putText(key, value) {
    this.values.set(key, String(value));
  }

  async delete(key) {
    this.values.delete(key);
  }

  async appendIndex(key, id, maxItems = 5000) {
    const current = await this.getJson(key);
    const list = Array.isArray(current) ? current : [];
    await this.putJson(key, [id].concat(list.filter(function (item) { return item !== id; })).slice(0, maxItems));
  }

  async readIndex(keys) {
    const result = [];
    const seen = new Set();
    for (const key of keys) {
      const list = await this.getJson(key);
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (!seen.has(item)) {
          seen.add(item);
          result.push(item);
        }
      }
    }
    return result;
  }

  async getMany(keys) {
    return Promise.all(keys.map((key) => this.getJson(key)));
  }

  rawText() {
    return Array.from(this.values.entries()).map(function (entry) {
      return entry[0] + '=' + JSON.stringify(entry[1]);
    }).join('\n');
  }
}

function rsaPair() {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

function pemBody(value) {
  return String(value).replace(/-----BEGIN [^-]+-----|-----END [^-]+-----|\s+/g, '');
}

const applicationKeys = rsaPair();
const alipayKeys = rsaPair();

function testConfig(overrides) {
  return Object.assign({
    appId: '2026000000000000',
    privatePkcsKey: '',
    privateKey: applicationKeys.privateKey,
    alipayPublicKey: alipayKeys.publicKey,
    sellerId: '2088000000000000',
    sellerEmail: '',
    paymentEnvironment: 'sandbox',
    gateway: 'https://openapi-sandbox.dl.alipaydev.com/gateway.do',
    baseUrl: 'https://www.smallds.icu',
    returnUrl: 'https://www.smallds.icu/api/payment/return',
    notifyUrl: 'https://www.smallds.icu/api/payment/notify',
    kvNamespace: 'test-neye',
    adminSetupToken: 'setup-token-for-tests',
    adminResetToken: 'reset-token-for-tests',
    adminDataKey: 'test-data-key-that-is-long-and-random',
    adminSessionSecret: 'test-session-key-that-is-long-and-random',
    webhookUrl: '',
    webhookSecret: '',
  }, overrides || {});
}

function request(path, options) {
  const input = options || {};
  const headers = new Headers(input.headers || {});
  if (input.json !== undefined) headers.set('content-type', 'application/json');
  return new Request('https://www.smallds.icu' + path, {
    method: input.method || 'GET',
    headers: headers,
    body: input.json === undefined ? input.body : JSON.stringify(input.json),
  });
}

async function payload(response) {
  return response.json();
}

function cookiesFrom(response) {
  const raw = response.headers.get('set-cookie') || '';
  const session = raw.match(/neye_admin_session=([^;,\s]+)/);
  const csrf = raw.match(/neye_admin_csrf=([^;,\s]+)/);
  assert.ok(session, 'session cookie should be present');
  assert.ok(csrf, 'csrf cookie should be present');
  return {
    header: 'neye_admin_session=' + session[1] + '; neye_admin_csrf=' + csrf[1],
    raw: raw,
  };
}

async function setupAdmin(store, config, ip, codeOffsetMs = 0) {
  const commonHeaders = { 'x-forwarded-for': ip || '198.51.100.10' };
  const started = await routeRequest(request('/api/admin/auth/setup/start', {
    method: 'POST',
    headers: commonHeaders,
    json: { token: config.adminSetupToken },
  }), { store: store, config: config, requestId: 'REQ_SETUP_START' });
  assert.equal(started.status, 201);
  const startBody = await payload(started);
  const code = totpCode(startBody.challenge.secret, Date.now() + codeOffsetMs);
  const confirmed = await routeRequest(request('/api/admin/auth/setup/confirm', {
    method: 'POST',
    headers: commonHeaders,
    json: {
      token: config.adminSetupToken,
      challengeId: startBody.challenge.challengeId,
      code: code,
    },
  }), { store: store, config: config, requestId: 'REQ_SETUP_CONFIRM' });
  const confirmBody = await payload(confirmed);
  const cookies = cookiesFrom(confirmed);
  assert.match(cookies.raw, /HttpOnly/);
  assert.match(cookies.raw, /Secure/);
  assert.match(cookies.raw, /SameSite=Strict/);
  return {
    secret: startBody.challenge.secret,
    cookie: cookies.header,
    csrfToken: confirmBody.session.csrfToken,
  };
}

function adminRequest(path, session, options) {
  const input = options || {};
  const headers = Object.assign({
    cookie: session.cookie,
    origin: 'https://www.smallds.icu',
  }, input.headers || {});
  if (input.csrf !== false && (input.method || 'GET') !== 'GET') {
    headers['x-csrf-token'] = session.csrfToken;
  }
  return request(path, Object.assign({}, input, { headers: headers }));
}

test('金额、联系方式、北京时间自然周期和加密信封保持精确', function () {
  assert.equal(amountToFen('9.9'), 990);
  assert.equal(amountToFen('99.99'), 9999);
  assert.equal(fenToAmount(990), '9.90');
  assert.throws(function () { amountToFen('9.999'); }, /金额格式无效/);
  assert.deepEqual(normalizeContact('+86 138-0013-8000'), { type: 'phone', value: '13800138000' });
  assert.deepEqual(normalizeContact('User@Example.COM'), { type: 'email', value: 'user@example.com' });
  assert.throws(function () { normalizeContact('1234'); }, /手机号或邮箱/);
  assert.equal(
    addCalendarPeriod('2026-01-31T04:00:00.000Z', 'month', 1),
    '2026-02-28T04:00:00.000Z'
  );
  assert.equal(
    addCalendarPeriod('2024-02-29T04:00:00.000Z', 'year', 1),
    '2025-02-28T04:00:00.000Z'
  );
  const encrypted = encryptJson({ phone: '13800138000' }, 'encryption-test-key', 'context');
  assert.equal(encrypted.includes('13800138000'), false);
  assert.deepEqual(decryptJson(encrypted, 'encryption-test-key', 'context'), { phone: '13800138000' });
  assert.throws(function () { decryptJson(encrypted, 'wrong-key', 'context'); }, /加密数据/);
});

test('支付宝请求签名包含 sign_type，响应验签覆盖原始 JSON', function () {
  const params = {
    app_id: '2026000000000000',
    method: 'alipay.trade.query',
    sign_type: 'RSA2',
    charset: 'utf-8',
    biz_content: '{"out_trade_no":"NEYE123"}',
  };
  const content = buildSignContent(params);
  assert.match(content, /sign_type=RSA2/);
  const signature = rsaSign(content, applicationKeys.privateKey);
  assert.equal(rsaVerify(content, signature, applicationKeys.publicKey), true);

  const responseKey = 'alipay_trade_query_response';
  const responseObject = '{"code":"10000","msg":"Success","out_trade_no":"NEYE123","nested":{"value":"} escaped \\" value"}}';
  const responseSign = rsaSign(responseObject, alipayKeys.privateKey);
  const raw = '{"' + responseKey + '":' + responseObject + ',"sign":' + JSON.stringify(responseSign) + '}';
  assert.equal(extractRawResponseObject(raw, responseKey), responseObject);
  assert.equal(verifyAlipayResponse(raw, testConfig(), responseKey).code, '10000');
  assert.equal(expectedSellerMatches(
    testConfig({ sellerEmail: 'merchant@example.com' }),
    { seller_id: '2088999999999999', seller_email: 'merchant@example.com' }
  ), false);
  assert.equal(expectedSellerMatches(
    testConfig({ sellerId: '', sellerEmail: 'merchant@example.com' }),
    { seller_email: 'merchant@example.com' }
  ), true);
  const tampered = raw.replace('"Success"', '"Changed"');
  assert.throws(function () { verifyAlipayResponse(tampered, testConfig(), responseKey); }, /签名校验/);
});

test('TOTP 首次绑定、重放保护、CSRF、重置和旧会话失效', async function () {
  const store = new MemoryStore();
  const config = testConfig();
  const session = await setupAdmin(store, config, '198.51.100.20');

  const checked = await routeRequest(adminRequest('/api/admin/session', session), {
    store: store,
    config: config,
    requestId: 'REQ_SESSION',
  });
  assert.equal((await payload(checked)).session.csrfToken, session.csrfToken);

  await assert.rejects(
    routeRequest(adminRequest('/api/admin/plans', session, {
      method: 'PUT',
      csrf: false,
      json: { salesEnabled: true, plans: [] },
    }), { store: store, config: config, requestId: 'REQ_NO_CSRF' }),
    function (error) { return error.code === 'CSRF_INVALID'; }
  );

  await assert.rejects(
    routeRequest(request('/api/admin/auth/login', {
      method: 'POST',
      headers: { 'x-forwarded-for': '198.51.100.20' },
      json: { code: totpCode(session.secret) },
    }), { store: store, config: config, requestId: 'REQ_REPLAY' }),
    function (error) { return error.code === 'TOTP_INVALID'; }
  );

  const futureCode = totpCode(session.secret, Date.now() + 30000);
  const login = await routeRequest(request('/api/admin/auth/login', {
    method: 'POST',
    headers: { 'x-forwarded-for': '198.51.100.20' },
    json: { code: futureCode },
  }), { store: store, config: config, requestId: 'REQ_LOGIN' });
  assert.equal(login.status, 200);

  const resetStarted = await routeRequest(request('/api/admin/auth/reset/start', {
    method: 'POST',
    headers: { 'x-forwarded-for': '198.51.100.20' },
    json: { token: config.adminResetToken },
  }), { store: store, config: config, requestId: 'REQ_RESET_START' });
  const reset = await payload(resetStarted);
  const resetConfirmed = await routeRequest(request('/api/admin/auth/reset/confirm', {
    method: 'POST',
    headers: { 'x-forwarded-for': '198.51.100.20' },
    json: {
      token: config.adminResetToken,
      challengeId: reset.challenge.challengeId,
      code: totpCode(reset.challenge.secret),
    },
  }), { store: store, config: config, requestId: 'REQ_RESET_CONFIRM' });
  assert.equal(resetConfirmed.status, 200);

  await assert.rejects(
    routeRequest(adminRequest('/api/admin/session', session), {
      store: store,
      config: config,
      requestId: 'REQ_OLD_SESSION',
    }),
    function (error) { return error.code === 'ADMIN_AUTH_REQUIRED'; }
  );
});

test('支付配置经 TOTP 加密保存，密钥不回显且环境变量仍可作为兜底', async function () {
  const fallback = await resolvePaymentConfig(new MemoryStore(), testConfig());
  assert.equal(fallback.paymentConfigSource, 'environment');
  assert.equal(fallback.appId, '2026000000000000');
  const store = new MemoryStore();
  const rootConfig = testConfig({
    appId: '',
    privatePkcsKey: '',
    privateKey: '',
    alipayPublicKey: '',
    sellerId: '',
    sellerEmail: '',
    webhookUrl: '',
    webhookSecret: '',
  });
  const session = await setupAdmin(store, rootConfig, '198.51.100.25', -30000);
  const managedApplicationKeys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  const privatePkcsKey = pemBody(managedApplicationKeys.privateKey);
  const alipayPublicKey = pemBody(alipayKeys.publicKey);
  const firstCode = totpCode(session.secret);
  const baseInput = {
    paymentEnvironment: 'sandbox',
    appId: '9021000000000001',
    sellerId: '2088000000000001',
    sellerEmail: '',
    baseUrl: 'https://www.smallds.icu',
    webhookEnabled: false,
    alipayPublicKey,
    totpCode: firstCode,
  };

  await assert.rejects(
    routeRequest(adminRequest('/api/admin/payment-config', session, {
      method: 'PUT',
      json: Object.assign({}, baseInput, { privatePkcsKey: 'not-a-key' }),
    }), { store, config: rootConfig, requestId: 'REQ_CONFIG_INVALID' }),
    function (error) { return error.code === 'PAYMENT_KEY_FORMAT_INVALID'; }
  );

  const saved = await routeRequest(adminRequest('/api/admin/payment-config', session, {
    method: 'PUT',
    json: Object.assign({}, baseInput, { privatePkcsKey }),
  }), { store, config: rootConfig, requestId: 'REQ_CONFIG_SAVE' });
  assert.equal(saved.status, 200);
  const savedBody = await payload(saved);
  assert.equal(savedBody.paymentConfig.source, 'admin');
  assert.equal(savedBody.paymentConfig.version, 1);
  assert.equal(savedBody.paymentConfig.secrets.applicationPrivateKey.configured, true);
  assert.equal(savedBody.paymentConfig.secrets.alipayPublicKey.configured, true);
  assert.equal(JSON.stringify(savedBody).includes(privatePkcsKey), false);
  assert.equal(JSON.stringify(savedBody).includes(alipayPublicKey), false);

  const record = await store.getJson(PAYMENT_CONFIG_STORAGE_KEY);
  assert.match(record.configCipher, /^v1\./);
  assert.equal(Object.hasOwn(record, 'appId'), false);
  assert.equal(store.rawText().includes(privatePkcsKey), false);
  assert.equal(store.rawText().includes(alipayPublicKey), false);

  const effective = await resolvePaymentConfig(store, rootConfig);
  assert.equal(effective.appId, baseInput.appId);
  assert.equal(effective.paymentConfigSource, 'admin');
  assert.equal(effective.gateway, 'https://openapi-sandbox.dl.alipaydev.com/gateway.do');

  const created = await createPublicOrder(store, rootConfig, 'monthly', 'secure@example.com', '安全配置测试');
  assert.equal(created.payment.action, effective.gateway);
  assert.equal(rsaVerify(
    buildSignContent(created.payment.fields),
    created.payment.fields.sign,
    managedApplicationKeys.publicKey
  ), true);

  const settingsResponse = await routeRequest(adminRequest('/api/admin/payment-config', session), {
    store,
    config: rootConfig,
    requestId: 'REQ_CONFIG_GET',
  });
  const settingsText = await settingsResponse.text();
  assert.equal(settingsText.includes(privatePkcsKey), false);
  assert.equal(settingsText.includes(alipayPublicKey), false);

  await assert.rejects(
    routeRequest(adminRequest('/api/admin/payment-config', session, {
      method: 'PUT',
      json: Object.assign({}, baseInput, { privatePkcsKey }),
    }), { store, config: rootConfig, requestId: 'REQ_CONFIG_REPLAY' }),
    function (error) { return error.code === 'TOTP_INVALID'; }
  );

  const retained = await routeRequest(adminRequest('/api/admin/payment-config', session, {
    method: 'PUT',
    json: {
      paymentEnvironment: 'sandbox',
      appId: baseInput.appId,
      sellerId: baseInput.sellerId,
      sellerEmail: 'merchant@example.com',
      baseUrl: baseInput.baseUrl,
      webhookEnabled: false,
      totpCode: totpCode(session.secret, Date.now() + 30000),
    },
  }), { store, config: rootConfig, requestId: 'REQ_CONFIG_RETAIN' });
  const retainedBody = await payload(retained);
  assert.equal(retainedBody.paymentConfig.version, 2);
  assert.equal(
    retainedBody.paymentConfig.secrets.applicationPrivateKey.fingerprint,
    savedBody.paymentConfig.secrets.applicationPrivateKey.fingerprint
  );
  assert.equal(store.rawText().includes(privatePkcsKey), false);
});

const responseKeys = {
  'alipay.trade.query': 'alipay_trade_query_response',
  'alipay.trade.refund': 'alipay_trade_refund_response',
  'alipay.trade.fastpay.refund.query': 'alipay_trade_fastpay_refund_query_response',
  'alipay.trade.close': 'alipay_trade_close_response',
  'alipay.data.dataservice.bill.downloadurl.query': 'alipay_data_dataservice_bill_downloadurl_query_response',
};

function signedGatewayResponse(method, result) {
  const responseKey = responseKeys[method];
  const objectText = JSON.stringify(result);
  const sign = rsaSign(objectText, alipayKeys.privateKey);
  const raw = '{"' + responseKey + '":' + objectText + ',"sign":' + JSON.stringify(sign) + '}';
  return new Response(raw, {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function installGatewayMock(config) {
  const originalFetch = globalThis.fetch;
  const gateway = {
    trades: new Map(),
    refunds: new Map(),
    requests: [],
    nextRefundPending: false,
    billBytes: new TextEncoder().encode('mock-alipay-bill'),
    restore: function () { globalThis.fetch = originalFetch; },
  };

  globalThis.fetch = async function (url, options) {
    const target = String(url);
    if (target === config.gateway) {
      const params = Object.fromEntries(new URLSearchParams(options.body));
      const sign = params.sign;
      assert.equal(params.sign_type, 'RSA2');
      assert.equal(rsaVerify(buildSignContent(params), sign, applicationKeys.publicKey), true);
      gateway.requests.push({
        method: params.method,
        biz: JSON.parse(params.biz_content || '{}'),
      });
      const biz = JSON.parse(params.biz_content || '{}');
      if (params.method === 'alipay.trade.query') {
        const trade = gateway.trades.get(biz.out_trade_no);
        if (!trade) {
          return signedGatewayResponse(params.method, {
            code: '40004',
            msg: 'Business Failed',
            sub_code: 'ACQ.TRADE_NOT_EXIST',
            sub_msg: 'Trade not exist',
          });
        }
        return signedGatewayResponse(params.method, Object.assign({
          code: '10000',
          msg: 'Success',
          out_trade_no: biz.out_trade_no,
          trade_no: trade.trade_no,
          trade_status: trade.trade_status,
          total_amount: trade.total_amount,
          seller_user_id: config.sellerId,
          send_pay_date: trade.send_pay_date,
        }, trade.extra || {}));
      }
      if (params.method === 'alipay.trade.refund') {
        const key = biz.out_trade_no + ':' + biz.out_request_no;
        const pending = gateway.nextRefundPending;
        gateway.nextRefundPending = false;
        gateway.refunds.set(key, {
          out_trade_no: biz.out_trade_no,
          out_request_no: biz.out_request_no,
          refund_amount: biz.refund_amount,
          refund_status: pending ? 'REFUND_PROCESSING' : 'REFUND_SUCCESS',
        });
        return signedGatewayResponse(params.method, {
          code: '10000',
          msg: 'Success',
          out_trade_no: biz.out_trade_no,
          trade_no: gateway.trades.get(biz.out_trade_no).trade_no,
          fund_change: pending ? 'N' : 'Y',
          refund_fee: biz.refund_amount,
        });
      }
      if (params.method === 'alipay.trade.fastpay.refund.query') {
        const key = biz.out_trade_no + ':' + biz.out_request_no;
        const refund = gateway.refunds.get(key);
        if (!refund) {
          return signedGatewayResponse(params.method, {
            code: '40004',
            msg: 'Business Failed',
            sub_code: 'ACQ.REFUND_NOT_EXIST',
          });
        }
        refund.refund_status = 'REFUND_SUCCESS';
        return signedGatewayResponse(params.method, Object.assign({
          code: '10000',
          msg: 'Success',
        }, refund));
      }
      if (params.method === 'alipay.trade.close') {
        const trade = gateway.trades.get(biz.out_trade_no);
        if (trade) trade.trade_status = 'TRADE_CLOSED';
        return signedGatewayResponse(params.method, {
          code: '10000',
          msg: 'Success',
          out_trade_no: biz.out_trade_no,
          trade_no: trade ? trade.trade_no : '',
        });
      }
      if (params.method === 'alipay.data.dataservice.bill.downloadurl.query') {
        return signedGatewayResponse(params.method, {
          code: '10000',
          msg: 'Success',
          bill_download_url: 'https://download.alipay.com/mock-bill.zip',
          bill_file_code: 'MOCK_BILL',
        });
      }
      throw new Error('Unexpected Alipay method: ' + params.method);
    }
    if (target === 'https://download.alipay.com/mock-bill.zip') {
      assert.equal(options.redirect, 'error');
      return new Response(gateway.billBytes, {
        status: 200,
        headers: { 'content-type': 'application/zip' },
      });
    }
    throw new Error('Unexpected fetch target: ' + target);
  };
  return gateway;
}

async function createPublicOrder(store, config, plan, contact, name) {
  const response = await routeRequest(request('/api/payment/create', {
    method: 'POST',
    json: {
      plan: plan,
      contactName: name || '测试用户',
      contactMethod: contact,
      note: '官网订阅测试',
      consent: true,
    },
  }), { store: store, config: config, requestId: 'REQ_CREATE_' + plan });
  assert.equal(response.status, 201);
  return payload(response);
}

async function notifyPaid(store, config, gateway, order, options) {
  const input = options || {};
  const tradeNo = input.tradeNo || '202608120000' + order.id.slice(-8);
  gateway.trades.set(order.id, {
    trade_no: tradeNo,
    trade_status: 'TRADE_SUCCESS',
    total_amount: order.amount,
    send_pay_date: input.paidAt || new Date().toISOString(),
  });
  const params = {
    notify_type: 'trade_status_sync',
    notify_id: input.notifyId || 'NOTIFY_' + order.id,
    app_id: config.appId,
    sign_type: 'RSA2',
    trade_no: tradeNo,
    out_trade_no: order.id,
    trade_status: 'TRADE_SUCCESS',
    total_amount: order.amount,
    seller_id: config.sellerId,
    gmt_payment: input.paidAt || new Date().toISOString(),
  };
  params.sign = rsaSign(buildSignContent(params), alipayKeys.privateKey);
  const response = await routeRequest(request('/api/payment/notify', {
    method: 'POST',
    body: new URLSearchParams(params).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  }), { store: store, config: config, requestId: 'REQ_NOTIFY_' + order.id.slice(-8) });
  assert.equal(await response.text(), 'success');
  return params;
}
test('套餐快照、支付确认、通知幂等、续期、退款、退款查询、关单和账单形成完整闭环', async function () {
  const store = new MemoryStore();
  const config = testConfig();
  const gateway = installGatewayMock(config);
  try {
    const admin = await setupAdmin(store, config, '198.51.100.30');

    const plansResponse = await routeRequest(request('/api/subscription/plans'), {
      store: store,
      config: config,
      requestId: 'REQ_PUBLIC_PLANS',
    });
    const plansBody = await payload(plansResponse);
    assert.equal(plansBody.plans.plans.find(function (plan) { return plan.id === 'monthly'; }).priceFen, 990);
    assert.equal(plansBody.plans.plans.find(function (plan) { return plan.id === 'annual'; }).priceFen, 9999);

    const monthlyCreated = await createPublicOrder(
      store,
      config,
      'monthly',
      'alice@example.com',
      'Alice'
    );
    assert.equal(monthlyCreated.order.amountFen, 990);
    assert.equal(monthlyCreated.payment.method, 'POST');
    assert.equal(monthlyCreated.payment.action, config.gateway);
    assert.equal(monthlyCreated.payment.fields.sign_type, 'RSA2');
    assert.equal(
      rsaVerify(
        buildSignContent(monthlyCreated.payment.fields),
        monthlyCreated.payment.fields.sign,
        applicationKeys.publicKey
      ),
      true
    );
    const monthlyBiz = JSON.parse(monthlyCreated.payment.fields.biz_content);
    assert.equal(monthlyBiz.total_amount, '9.90');
    assert.equal(monthlyBiz.out_trade_no, monthlyCreated.order.id);
    assert.match(monthlyBiz.time_expire, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.equal(store.rawText().includes('alice@example.com'), false);
    assert.equal(store.rawText().includes('Alice'), false);

    const planUpdate = await routeRequest(adminRequest('/api/admin/plans', admin, {
      method: 'PUT',
      json: {
        salesEnabled: true,
        plans: [
          {
            id: 'monthly',
            name: '月付订阅',
            description: '一个自然月的 NEye 订阅服务',
            priceFen: 1290,
            timeoutMinutes: 30,
            enabled: true,
            recommended: false,
          },
          {
            id: 'annual',
            name: '年付订阅',
            description: '一个自然年的 NEye 订阅服务',
            priceFen: 9999,
            timeoutMinutes: 30,
            enabled: true,
            recommended: true,
          },
        ],
      },
    }), { store: store, config: config, requestId: 'REQ_PLAN_UPDATE' });
    assert.equal((await payload(planUpdate)).planConfig.plans.monthly.version, 2);
    assert.equal((await readOrder(store, monthlyCreated.order.id)).amountFen, 990);

    const newMonthly = await createPublicOrder(store, config, 'monthly', 'bob@example.com', 'Bob');
    assert.equal(newMonthly.order.amountFen, 1290);

    const firstNotify = await notifyPaid(store, config, gateway, monthlyCreated.order, {
      paidAt: '2026-01-31T04:00:00.000Z',
      notifyId: 'NOTIFY_MONTHLY_FIRST',
      tradeNo: '202608120000000001',
    });
    store.staleOnce('v2_notify_');
    const duplicate = await routeRequest(request('/api/payment/notify', {
      method: 'POST',
      body: new URLSearchParams(firstNotify).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    }), { store: store, config: config, requestId: 'REQ_NOTIFY_DUPLICATE' });
    assert.equal(await duplicate.text(), 'success');

    const monthlyRecord = await readOrder(store, monthlyCreated.order.id);
    const subscriberAfterMonthly = await readSubscriber(store, monthlyRecord.subscriberId);
    assert.equal(monthlyRecord.paymentStatus, 'paid');
    assert.equal(subscriberAfterMonthly.grants.length, 1);
    assert.equal(subscriberAfterMonthly.expiresAt, '2026-02-28T04:00:00.000Z');

    const publicStatus = await routeRequest(request(
      '/api/payment/status?out_trade_no=' + encodeURIComponent(monthlyCreated.order.id)
    ), { store: store, config: config, requestId: 'REQ_STATUS' });
    assert.equal((await payload(publicStatus)).order.paymentStatus, 'paid');

    const annualCreated = await createPublicOrder(store, config, 'annual', 'alice@example.com', 'Alice');
    await notifyPaid(store, config, gateway, annualCreated.order, {
      paidAt: '2026-02-01T04:00:00.000Z',
      notifyId: 'NOTIFY_ANNUAL_FIRST',
      tradeNo: '202608120000000002',
    });
    let subscriber = await readSubscriber(store, monthlyRecord.subscriberId);
    assert.equal(subscriber.grants.length, 2);
    assert.equal(subscriber.expiresAt, '2027-02-28T04:00:00.000Z');

    const duplicateGrantSubscriber = await readSubscriber(store, monthlyRecord.subscriberId);
    const annualGrant = duplicateGrantSubscriber.grants.find(function (grant) {
      return grant.orderId === annualCreated.order.id;
    });
    duplicateGrantSubscriber.grants.push(Object.assign({}, annualGrant, { id: annualGrant.id + '_DUPLICATE' }));
    await store.putJson('v2_subscriber_' + duplicateGrantSubscriber.id, duplicateGrantSubscriber);

    const partialRefund = await routeRequest(adminRequest(
      '/api/admin/orders/' + annualCreated.order.id + '/refunds',
      admin,
      {
        method: 'POST',
        json: { amountFen: 1000, reason: '部分服务退款' },
      }
    ), { store: store, config: config, requestId: 'REQ_REFUND_PARTIAL' });
    const partialBody = await payload(partialRefund);
    assert.equal(partialBody.order.paymentStatus, 'partially_refunded');
    assert.equal(partialBody.refund.status, 'succeeded');
    subscriber = await readSubscriber(store, monthlyRecord.subscriberId);
    assert.equal(subscriber.expiresAt, '2027-02-28T04:00:00.000Z');

    const fullRemainder = await routeRequest(adminRequest(
      '/api/admin/orders/' + annualCreated.order.id + '/refunds',
      admin,
      {
        method: 'POST',
        json: { amountFen: 8999, reason: '取消剩余订阅' },
      }
    ), { store: store, config: config, requestId: 'REQ_REFUND_FULL' });
    const fullBody = await payload(fullRemainder);
    assert.equal(fullBody.order.paymentStatus, 'refunded');
    subscriber = await readSubscriber(store, monthlyRecord.subscriberId);
    assert.equal(subscriber.expiresAt, '2026-02-28T04:00:00.000Z');
    assert.ok(subscriber.grants
      .filter(function (grant) { return grant.orderId === annualCreated.order.id; })
      .every(function (grant) { return Boolean(grant.revokedAt); }));

    await notifyPaid(store, config, gateway, newMonthly.order, {
      paidAt: '2026-03-01T04:00:00.000Z',
      notifyId: 'NOTIFY_BOB_MONTHLY',
      tradeNo: '202608120000000003',
    });
    gateway.nextRefundPending = true;
    const pendingRefundResponse = await routeRequest(adminRequest(
      '/api/admin/orders/' + newMonthly.order.id + '/refunds',
      admin,
      {
        method: 'POST',
        json: { amountFen: 100, reason: '退款查询测试' },
      }
    ), { store: store, config: config, requestId: 'REQ_REFUND_PENDING' });
    const pendingRefund = (await payload(pendingRefundResponse)).refund;
    assert.equal(pendingRefund.status, 'pending');

    const bobOrder = await store.getJson('v2_order_' + newMonthly.order.id);
    bobOrder.refunds.find(function (refund) { return refund.id === pendingRefund.id; }).lastAttemptAt =
      new Date(Date.now() - 11000).toISOString();
    await store.putJson('v2_order_' + newMonthly.order.id, bobOrder);
    const refundSync = await routeRequest(adminRequest(
      '/api/admin/orders/' + newMonthly.order.id + '/refunds/' + pendingRefund.id + '/sync',
      admin,
      { method: 'POST', json: {} }
    ), { store: store, config: config, requestId: 'REQ_REFUND_SYNC' });
    assert.equal((await payload(refundSync)).refund.status, 'succeeded');

    const closeCreated = await createPublicOrder(store, config, 'annual', 'carol@example.com', 'Carol');
    gateway.trades.set(closeCreated.order.id, {
      trade_no: '202608120000000004',
      trade_status: 'WAIT_BUYER_PAY',
      total_amount: closeCreated.order.amount,
      send_pay_date: '',
    });
    const closed = await routeRequest(adminRequest(
      '/api/admin/orders/' + closeCreated.order.id + '/close',
      admin,
      { method: 'POST', json: {} }
    ), { store: store, config: config, requestId: 'REQ_CLOSE' });
    assert.equal((await payload(closed)).order.paymentStatus, 'closed');
    assert.ok(gateway.requests.some(function (item) { return item.method === 'alipay.trade.close'; }));

    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const bill = await routeRequest(adminRequest(
      '/api/admin/bills/download?date=' + yesterday,
      admin
    ), { store: store, config: config, requestId: 'REQ_BILL' });
    assert.equal(bill.status, 200);
    assert.equal(bill.headers.get('content-type'), 'application/zip');
    assert.deepEqual(new Uint8Array(await bill.arrayBuffer()), gateway.billBytes);

    const dashboard = await routeRequest(adminRequest('/api/admin/dashboard', admin), {
      store: store,
      config: config,
      requestId: 'REQ_DASHBOARD',
    });
    const dashboardBody = await payload(dashboard);
    assert.ok(dashboardBody.dashboard.metrics.orders >= 4);
    assert.equal(dashboardBody.dashboard.metrics.grossFen, 2180);
    assert.equal(dashboardBody.dashboard.metrics.refundedFen, 10099);
    assert.equal(dashboardBody.dataSync.eventual, true);
  } finally {
    gateway.restore();
  }
});

test('不支持的通知事件和金额不一致不会更新订单', async function () {
  const store = new MemoryStore();
  const config = testConfig();
  const gateway = installGatewayMock(config);
  try {
    const created = await createPublicOrder(store, config, 'monthly', 'guard@example.com', 'Guard');
    const original = await readOrder(store, created.order.id);
    const params = {
      notify_type: 'trade_status_sync',
      notify_id: 'NOTIFY_UNSUPPORTED',
      app_id: config.appId,
      sign_type: 'RSA2',
      trade_no: '202608120000000099',
      out_trade_no: created.order.id,
      trade_status: 'WAIT_BUYER_PAY',
      total_amount: '9.90',
      seller_id: config.sellerId,
    };
    params.sign = rsaSign(buildSignContent(params), alipayKeys.privateKey);
    await assert.rejects(
      routeRequest(request('/api/payment/notify', {
        method: 'POST',
        body: new URLSearchParams(params).toString(),
      }), { store: store, config: config, requestId: 'REQ_BAD_EVENT' }),
      function (error) { return error.code === 'NOTIFY_EVENT_UNSUPPORTED'; }
    );
    assert.equal((await readOrder(store, original.id)).paymentStatus, 'pending');

    params.trade_status = 'TRADE_SUCCESS';
    params.total_amount = '10.00';
    params.sign = rsaSign(buildSignContent(params), alipayKeys.privateKey);
    await assert.rejects(
      routeRequest(request('/api/payment/notify', {
        method: 'POST',
        body: new URLSearchParams(params).toString(),
      }), { store: store, config: config, requestId: 'REQ_BAD_AMOUNT' }),
      function (error) { return error.code === 'NOTIFY_AMOUNT_MISMATCH'; }
    );
    assert.equal((await readOrder(store, original.id)).paymentStatus, 'pending');
  } finally {
    gateway.restore();
  }
});
test('管理员初始化限流和过期会话均由服务端拒绝', async function () {
  const store = new MemoryStore();
  const config = testConfig();
  for (let index = 0; index < 3; index += 1) {
    await assert.rejects(
      routeRequest(request('/api/admin/auth/setup/start', {
        method: 'POST',
        headers: { 'x-forwarded-for': '198.51.100.40' },
        json: { token: 'wrong-token' },
      }), { store: store, config: config, requestId: 'REQ_RATE_' + index }),
      function (error) { return error.code === 'ADMIN_TOKEN_INVALID'; }
    );
  }
  await assert.rejects(
    routeRequest(request('/api/admin/auth/setup/start', {
      method: 'POST',
      headers: { 'x-forwarded-for': '198.51.100.40' },
      json: { token: 'wrong-token' },
    }), { store: store, config: config, requestId: 'REQ_RATE_LOCK' }),
    function (error) { return error.code === 'RATE_LIMITED'; }
  );

  const sessionStore = new MemoryStore();
  await setupAdmin(sessionStore, config, '198.51.100.41');
  const expired = encodeSignedPayload({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000) - 100,
    expiresAt: Math.floor(Date.now() / 1000) - 1,
    csrf: 'expired-csrf',
    nonce: 'expired',
  }, config.adminSessionSecret);
  await assert.rejects(
    routeRequest(request('/api/admin/session', {
      headers: { cookie: 'neye_admin_session=' + encodeURIComponent(expired) },
    }), { store: sessionStore, config: config, requestId: 'REQ_EXPIRED' }),
    function (error) { return error.code === 'ADMIN_AUTH_REQUIRED'; }
  );
});

test('订阅 Webhook 使用时间戳 HMAC 签名，失败可在后台重试且不泄露联系人', async function () {
  const store = new MemoryStore();
  const config = testConfig({
    webhookUrl: 'https://hooks.example.com/subscription',
    webhookSecret: 'webhook-secret-for-tests',
  });
  const subscriberId = 'a'.repeat(64);
  const subscriber = {
    id: subscriberId,
    privateCipher: encryptJson({
      contactName: 'Webhook User',
      contact: { type: 'email', value: 'webhook@example.com' },
    }, config.adminDataKey, 'subscriber:' + subscriberId),
    expiresAt: '2027-08-12T04:00:00.000Z',
    status: 'active',
  };
  const order = {
    id: 'NEYE20260812120000ABCDEF123456',
    amountFen: 990,
    paidAt: '2026-08-12T04:00:00.000Z',
    planSnapshot: {
      id: 'monthly',
      name: '月付订阅',
      priceFen: 990,
      periodUnit: 'month',
      periodCount: 1,
      version: 1,
    },
  };
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  const captured = [];
  globalThis.fetch = async function (url, options) {
    assert.equal(String(url), config.webhookUrl);
    attempts += 1;
    const body = String(options.body);
    const timestamp = options.headers['x-neye-timestamp'];
    const expected = createHmac('sha256', config.webhookSecret)
      .update(timestamp + '.' + body, 'utf8')
      .digest('hex');
    assert.equal(options.headers['x-neye-signature'], 'sha256=' + expected);
    captured.push(JSON.parse(body));
    return new Response(null, { status: attempts === 1 ? 500 : 204 });
  };
  try {
    const first = await emitSubscriptionEvent(store, config, {
      type: 'subscription.activated',
      order: order,
      subscriber: subscriber,
      extra: {},
    });
    assert.equal(first.event.status, 'failed');
    assert.equal(first.event.attempts, 1);
    assert.equal(captured[0].subscriber.contact.value, 'webhook@example.com');
    assert.equal(store.rawText().includes('webhook@example.com'), false);

    const retried = await retryWebhook(store, config, first.event.id);
    assert.equal(retried.status, 'delivered');
    assert.equal(retried.attempts, 2);
    assert.equal(retried.lastError, '');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
