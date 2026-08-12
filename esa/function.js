import { createSign, createVerify } from 'node:crypto';

const DEFAULT_BASE_URL = 'https://www.smallds.icu';
const DEFAULT_GATEWAY = 'https://openapi-sandbox.dl.alipaydev.com/gateway.do';
const ORDER_KEY_PREFIX = 'order_';
const SUCCESS_STATUSES = ['TRADE_SUCCESS', 'TRADE_FINISHED'];

const PLANS = Object.freeze({
  monthly: Object.freeze({
    label: '月付订阅',
    amount: '9.90',
    subject: 'NEye 月付订阅',
  }),
  annual: Object.freeze({
    label: '年付订阅',
    amount: '99.99',
    subject: 'NEye 年付订阅',
  }),
});

class PaymentError extends Error {
  constructor(status, publicMessage, code) {
    super(publicMessage);
    this.status = status;
    this.publicMessage = publicMessage;
    this.code = code;
  }
}

function readEnv(name, fallback = '') {
  const env = globalThis.process && globalThis.process.env ? globalThis.process.env : {};
  const value = env[name];
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function readConfig() {
  const baseUrl = readEnv('AIPAY_PUBLIC_BASE_URL', DEFAULT_BASE_URL).replace(/\/+$/, '');
  return {
    appId: readEnv('AIPAY_APP_ID'),
    privatePkcsKey: readEnv('AIPAY_PRIVATE_PKCS_KEY'),
    privateKey: readEnv('AIPAY_PRIVATE_KEY'),
    alipayPublicKey: readEnv('AIPAY_ALIPAY_PUBLIC_KEY'),
    gateway: readEnv('AIPAY_GATEWAY', DEFAULT_GATEWAY),
    baseUrl,
    returnUrl: readEnv('AIPAY_RETURN_URL', baseUrl + '/api/payment/return'),
    notifyUrl: readEnv('AIPAY_NOTIFY_URL', baseUrl + '/api/payment/notify'),
    kvNamespace: readEnv('ESA_KV_NAMESPACE', 'neye-orders'),
  };
}

function requirePaymentConfig(config) {
  const missing = [];
  if (!config.appId) missing.push('AIPAY_APP_ID');
  if (!config.privatePkcsKey && !config.privateKey) missing.push('AIPAY_PRIVATE_PKCS_KEY 或 AIPAY_PRIVATE_KEY');
  if (!config.alipayPublicKey) missing.push('AIPAY_ALIPAY_PUBLIC_KEY');
  if (!config.gateway) missing.push('AIPAY_GATEWAY');
  if (!config.returnUrl) missing.push('AIPAY_RETURN_URL');
  if (!config.notifyUrl) missing.push('AIPAY_NOTIFY_URL');
  if (missing.length) {
    throw new PaymentError(503, '支付服务尚未配置。', 'PAYMENT_CONFIG_MISSING');
  }
}

function pemFromValue(value, label) {
  const text = String(value || '').trim();
  if (!text) throw new PaymentError(503, '支付服务尚未配置。', 'KEY_MISSING');
  if (text.includes('BEGIN')) return text.replace(/\r\n/g, '\n');
  const clean = text.replace(/\s+/g, '');
  const chunks = clean.match(/.{1,64}/g) || [];
  return '-----BEGIN ' + label + '-----\n' + chunks.join('\n') + '\n-----END ' + label + '-----';
}

function getPrivateKeyPem(config) {
  if (config.privatePkcsKey) return pemFromValue(config.privatePkcsKey, 'RSA PRIVATE KEY');
  return pemFromValue(config.privateKey, 'PRIVATE KEY');
}

function getAlipayPublicKeyPem(config) {
  return pemFromValue(config.alipayPublicKey, 'PUBLIC KEY');
}

function buildSignContent(params) {
  return Object.keys(params)
    .filter((key) => key !== 'sign' && key !== 'sign_type' && params[key] !== undefined && params[key] !== null && params[key] !== '')
    .sort()
    .map((key) => key + '=' + String(params[key]))
    .join('&');
}

function rsaSign(content, privateKeyPem) {
  const signer = createSign('RSA-SHA256');
  signer.update(content, 'utf8');
  signer.end();
  return signer.sign(privateKeyPem, 'base64');
}

function rsaVerify(content, signature, publicKeyPem) {
  const verifier = createVerify('RSA-SHA256');
  verifier.update(content, 'utf8');
  verifier.end();
  return verifier.verify(publicKeyPem, signature, 'base64');
}

function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function createOrderId() {
  const now = new Date();
  const date = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
    String(now.getUTCHours()).padStart(2, '0'),
    String(now.getUTCMinutes()).padStart(2, '0'),
    String(now.getUTCSeconds()).padStart(2, '0'),
  ].join('');
  const bytes = new Uint8Array(6);
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  const suffix = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('').toUpperCase();
  return 'NEYE' + date + suffix;
}

function amountString(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) throw new PaymentError(400, '订单金额无效。', 'INVALID_AMOUNT');
  return amount.toFixed(2);
}

function textValue(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function getOrderKey(orderId) {
  return ORDER_KEY_PREFIX + orderId;
}

function getStore(config) {
  const EdgeKVConstructor = globalThis.EdgeKV;
  if (typeof EdgeKVConstructor !== 'function') {
    throw new PaymentError(503, '订单存储尚未配置。', 'ESA_KV_MISSING');
  }
  return new EdgeKVConstructor({ namespace: config.kvNamespace });
}

async function saveOrder(config, order) {
  const store = getStore(config);
  await store.put(getOrderKey(order.id), JSON.stringify(order));
}

async function readOrder(config, orderId) {
  const store = getStore(config);
  const value = await store.get(getOrderKey(orderId), { type: 'text' });
  if (value === undefined) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new PaymentError(503, '订单数据暂时不可用。', 'ORDER_DATA_INVALID');
  }
}

function publicOrder(order) {
  return {
    id: order.id,
    plan: order.plan,
    amount: order.amount,
    createdAt: order.createdAt,
    paymentStatus: order.paymentStatus,
    paidAt: order.paidAt || null,
  };
}

function buildPaymentFields(config, order) {
  const plan = PLANS[order.plan];
  const params = {
    app_id: config.appId,
    method: 'alipay.trade.page.pay',
    format: 'JSON',
    return_url: config.returnUrl,
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: timestamp(),
    version: '1.0',
    notify_url: config.notifyUrl,
    biz_content: JSON.stringify({
      out_trade_no: order.id,
      product_code: 'FAST_INSTANT_TRADE_PAY',
      total_amount: order.amount,
      subject: plan.subject,
      body: 'NEye 订阅服务',
    }),
  };
  return Object.assign({}, params, {
    sign: rsaSign(buildSignContent(params), getPrivateKeyPem(config)),
  });
}

function parseFormBody(body) {
  const values = {};
  for (const pair of new URLSearchParams(body)) {
    values[pair[0]] = pair[1];
  }
  return values;
}

function verifySignedParams(params, config) {
  if (!params.sign) return false;
  const content = buildSignContent(params);
  return rsaVerify(content, params.sign, getAlipayPublicKeyPem(config));
}

async function createAlipayQuery(config, orderId) {
  const params = {
    app_id: config.appId,
    method: 'alipay.trade.query',
    format: 'JSON',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: timestamp(),
    version: '1.0',
    biz_content: JSON.stringify({ out_trade_no: orderId }),
  };
  const signedParams = Object.assign({}, params, {
    sign: rsaSign(buildSignContent(params), getPrivateKeyPem(config)),
  });
  const response = await fetch(config.gateway, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: new URLSearchParams(signedParams).toString(),
  });
  const raw = await response.text();
  if (!response.ok) throw new PaymentError(502, '支付宝订单状态查询失败。', 'ALIPAY_QUERY_HTTP');
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new PaymentError(502, '支付宝订单状态查询失败。', 'ALIPAY_QUERY_RESPONSE');
  }
  const result = payload.alipay_trade_query_response;
  if (!result || result.code !== '10000') {
    throw new PaymentError(502, '支付宝订单状态查询失败。', 'ALIPAY_QUERY_FAILED');
  }
  return result;
}

async function parseJsonBody(request) {
  const body = await request.text();
  if (body.length > 20000) throw new PaymentError(413, '订单信息过长。', 'BODY_TOO_LARGE');
  try {
    const payload = JSON.parse(body);
    if (!payload || typeof payload !== 'object') throw new Error('not_object');
    return payload;
  } catch {
    throw new PaymentError(400, '订单信息格式不正确。', 'INVALID_JSON');
  }
}

async function handleCreate(request, config) {
  requirePaymentConfig(config);
  if (request.method !== 'POST') throw new PaymentError(405, '请求方式不支持。', 'METHOD_NOT_ALLOWED');
  const input = await parseJsonBody(request);
  const plan = PLANS[input.plan];
  const contactName = textValue(input.contactName, 100);
  const contactMethod = textValue(input.contactMethod, 120);
  const note = textValue(input.note, 500);
  if (!plan || !['monthly', 'annual'].includes(input.plan)) {
    throw new PaymentError(400, '订阅方案无效。', 'INVALID_PLAN');
  }
  if (!contactName || !contactMethod) {
    throw new PaymentError(400, '联系信息不完整。', 'CONTACT_REQUIRED');
  }
  if (input.consent !== true) {
    throw new PaymentError(400, '请确认订阅方案及价格。', 'CONSENT_REQUIRED');
  }
  const order = {
    id: createOrderId(),
    plan: input.plan,
    amount: plan.amount,
    contactName,
    contactMethod,
    note,
    createdAt: new Date().toISOString(),
    paymentStatus: 'pending',
  };
  await saveOrder(config, order);
  return {
    ok: true,
    order: publicOrder(order),
    payment: {
      method: 'POST',
      action: config.gateway,
      fields: buildPaymentFields(config, order),
    },
  };
}

async function handleNotify(request, config) {
  requirePaymentConfig(config);
  if (request.method !== 'POST') return new Response('fail', { status: 405 });
  const params = parseFormBody(await request.text());
  if (!params.sign || !verifySignedParams(params, config)) return new Response('fail', { status: 400 });
  if (params.app_id !== config.appId) return new Response('fail', { status: 400 });
  if (!params.out_trade_no) return new Response('fail', { status: 400 });
  const order = await readOrder(config, params.out_trade_no);
  if (!order) return new Response('fail', { status: 404 });
  if (amountString(params.total_amount) !== order.amount) return new Response('fail', { status: 400 });
  if (!SUCCESS_STATUSES.includes(params.trade_status)) return new Response('success');
  if (order.paymentStatus === 'paid') return new Response('success');

  const query = await createAlipayQuery(config, order.id);
  if (query.out_trade_no !== order.id || amountString(query.total_amount) !== order.amount) {
    return new Response('fail', { status: 400 });
  }
  if (!SUCCESS_STATUSES.includes(query.trade_status)) return new Response('success');

  order.paymentStatus = 'paid';
  order.paidAt = new Date().toISOString();
  order.alipayTradeNo = query.trade_no || params.trade_no || '';
  order.alipayTradeStatus = query.trade_status;
  await saveOrder(config, order);
  return new Response('success');
}

function redirectResponse(config, status, orderId) {
  const target = new URL('/payment.html', config.baseUrl + '/');
  target.searchParams.set('payment', status);
  if (orderId) target.searchParams.set('out_trade_no', orderId);
  return new Response(null, {
    status: 302,
    headers: {
      Location: target.toString(),
      'Cache-Control': 'no-store',
    },
  });
}

async function handleReturn(request, config) {
  if (request.method !== 'GET') return redirectResponse(config, 'checking', '');
  const params = {};
  for (const pair of new URL(request.url).searchParams) {
    params[pair[0]] = pair[1];
  }
  let status = 'checking';
  try {
    requirePaymentConfig(config);
    const valid = verifySignedParams(params, config) && params.app_id === config.appId;
    if (valid && SUCCESS_STATUSES.includes(params.trade_status)) status = 'returned';
  } catch {
    status = 'checking';
  }
  return redirectResponse(config, status, params.out_trade_no || '');
}

async function handleStatus(request, config) {
  if (request.method !== 'GET') throw new PaymentError(405, '请求方式不支持。', 'METHOD_NOT_ALLOWED');
  const orderId = new URL(request.url).searchParams.get('out_trade_no') || '';
  if (!/^[A-Z0-9]{12,40}$/.test(orderId)) {
    throw new PaymentError(400, '订单号无效。', 'INVALID_ORDER_ID');
  }
  const order = await readOrder(config, orderId);
  if (!order) throw new PaymentError(404, '订单不存在或已过期。', 'ORDER_NOT_FOUND');
  return { ok: true, order: publicOrder(order) };
}

function responseHeaders(request, config, contentType) {
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'Content-Type': contentType,
  });
  const origin = request.headers.get('origin');
  if (origin && origin === config.baseUrl) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type');
    headers.set('Vary', 'Origin');
  }
  return headers;
}

function jsonResponse(request, config, payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: responseHeaders(request, config, 'application/json; charset=utf-8'),
  });
}

function textResponse(request, config, text, status = 200) {
  return new Response(text, {
    status,
    headers: responseHeaders(request, config, 'text/plain; charset=utf-8'),
  });
}

async function dispatch(request) {
  const config = readConfig();
  const url = new URL(request.url);

  if (request.method === 'OPTIONS' && url.pathname.startsWith('/api/payment/')) {
    return new Response(null, { status: 204, headers: responseHeaders(request, config, 'text/plain') });
  }
  if (url.pathname === '/api/payment/create') {
    return jsonResponse(request, config, await handleCreate(request, config));
  }
  if (url.pathname === '/api/payment/notify') {
    return await handleNotify(request, config);
  }
  if (url.pathname === '/api/payment/return') {
    return handleReturn(request, config);
  }
  if (url.pathname === '/api/payment/status') {
    return jsonResponse(request, config, await handleStatus(request, config));
  }
  throw new PaymentError(404, '接口不存在。', 'NOT_FOUND');
}

export default {
  async fetch(request) {
    try {
      return await dispatch(request);
    } catch (error) {
      const config = readConfig();
      const url = new URL(request.url);
      console.log('payment_api_error', url.pathname, error && error.code ? error.code : 'UNKNOWN');
      if (url.pathname === '/api/payment/notify') {
        return textResponse(request, config, 'fail', 500);
      }
      if (error instanceof PaymentError) {
        return jsonResponse(request, config, { ok: false, error: error.publicMessage }, error.status);
      }
      return jsonResponse(request, config, { ok: false, error: '支付服务暂时不可用。' }, 500);
    }
  },
};
