import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.PREVIEW_PORT || 4173);
const now = new Date();
const orderId = 'NEYE20260812103000A1B2C3D4E5F6';
const subscriberId = 'a'.repeat(64);
const health = {
  source: 'admin',
  version: 3,
  updatedAt: now.toISOString(),
  environment: 'sandbox',
  appIdMasked: '9021****7838',
  gatewayHost: 'openapi-sandbox.dl.alipaydev.com',
  returnUrl: 'https://www.smallds.icu/api/payment/return',
  notifyUrl: 'https://www.smallds.icu/api/payment/notify',
  ready: true,
  webhook: { enabled: true, endpoint: 'https://example.com/subscription' },
  checks: {
    appId: true,
    applicationPrivateKey: true,
    alipayPublicKey: true,
    sellerIdentity: true,
    returnUrl: true,
    notifyUrl: true,
    edgeKv: true,
  },
};
const paymentConfig = {
  source: 'admin',
  version: 3,
  updatedAt: now.toISOString(),
  environment: 'sandbox',
  appId: '9021000000000000',
  appIdMasked: '9021****7838',
  sellerId: '2088000000000000',
  sellerEmail: '',
  baseUrl: 'https://www.smallds.icu',
  returnUrl: 'https://www.smallds.icu/api/payment/return',
  notifyUrl: 'https://www.smallds.icu/api/payment/notify',
  gatewayHost: 'openapi-sandbox.dl.alipaydev.com',
  webhookEnabled: true,
  webhookUrl: 'https://example.com/subscription',
  secrets: {
    applicationPrivateKey: { configured: true, fingerprint: 'A1B2C3D4E5F6' },
    alipayPublicKey: { configured: true, fingerprint: 'F6E5D4C3B2A1' },
    webhookSecret: { configured: true, fingerprint: '0A1B2C3D4E5F' },
  },
};
const order = {
  id: orderId,
  planId: 'annual',
  planSnapshot: {
    id: 'annual',
    name: '年付订阅',
    description: '一个自然年的 NEye 订阅服务',
    priceFen: 9999,
    periodUnit: 'year',
    periodCount: 1,
    timeoutMinutes: 30,
    version: 3,
  },
  amountFen: 9999,
  createdAt: new Date(now.getTime() - 7200000).toISOString(),
  expiresAt: new Date(now.getTime() + 1200000).toISOString(),
  updatedAt: new Date(now.getTime() - 3600000).toISOString(),
  paymentStatus: 'paid',
  paidAt: new Date(now.getTime() - 3600000).toISOString(),
  contactName: '示例订阅用户',
  contact: { type: 'email', value: 'demo@example.com' },
  contactMasked: 'de***@example.com',
  note: '用于本地界面验收的合成数据',
  subscriberId: subscriberId,
  grantId: 'GRANT_' + orderId,
  alipayTradeNo: '2026081222001000000000000001',
  alipayTradeStatus: 'TRADE_SUCCESS',
  lastSyncedAt: new Date(now.getTime() - 300000).toISOString(),
  refunds: [],
};
const subscriber = {
  id: subscriberId,
  contactName: '示例订阅用户',
  contact: { type: 'email', value: 'demo@example.com' },
  contactMasked: 'de***@example.com',
  createdAt: new Date(now.getTime() - 86400000).toISOString(),
  updatedAt: now.toISOString(),
  expiresAt: new Date(now.getTime() + 28 * 86400000).toISOString(),
  status: 'active',
  grants: [{
    id: 'GRANT_' + orderId,
    orderId: orderId,
    planId: 'annual',
    planVersion: 3,
    paidAt: order.paidAt,
    periodUnit: 'year',
    periodCount: 1,
    revokedAt: null,
    revokedReason: null,
  }],
  adjustments: [],
  orders: [order],
};
const planConfig = {
  configVersion: 4,
  salesEnabled: true,
  updatedAt: now.toISOString(),
  plans: {
    monthly: {
      id: 'monthly',
      name: '月付订阅',
      description: '一个自然月的 NEye 订阅服务',
      subject: 'NEye 月付订阅',
      priceFen: 990,
      periodUnit: 'month',
      periodCount: 1,
      enabled: true,
      recommended: false,
      timeoutMinutes: 30,
      version: 2,
    },
    annual: {
      id: 'annual',
      name: '年付订阅',
      description: '一个自然年的 NEye 订阅服务',
      subject: 'NEye 年付订阅',
      priceFen: 9999,
      periodUnit: 'year',
      periodCount: 1,
      enabled: true,
      recommended: true,
      timeoutMinutes: 30,
      version: 3,
    },
  },
};

function json(response, status = 200) {
  return {
    status: status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
    body: JSON.stringify(Object.assign({ ok: true, requestId: 'REQ_LOCAL_PREVIEW' }, response)),
  };
}

function apiResponse(request) {
  const url = new URL(request.url, 'http://127.0.0.1:' + port);
  const path = url.pathname;
  const previewSetup = String(request.headers.cookie || '').includes('preview_auth=setup');
  if (path === '/api/admin/auth/state') {
    return json({
      auth: previewSetup
        ? { configured: false, setupAvailable: true, resetAvailable: true }
        : { configured: true, setupAvailable: true, resetAvailable: true },
    });
  }
  if (path === '/api/admin/auth/setup/start') {
    return json({
      challenge: {
        challengeId: 'ABCDEF1234567890ABCDEF12',
        secret: 'JBSWY3DPEHPK3PXP',
        otpauthUri: 'otpauth://totp/NEye%20%E5%AE%98%E7%BD%91%3Aadmin%40smallds.icu?secret=JBSWY3DPEHPK3PXP&issuer=NEye%20%E5%AE%98%E7%BD%91&algorithm=SHA1&digits=6&period=30',
        expiresAt: new Date(now.getTime() + 600000).toISOString(),
      },
    }, 201);
  }  if (path === '/api/admin/session') {
    return json({ session: { version: 1, expiresAt: new Date(now.getTime() + 28800000).toISOString(), csrfToken: 'preview-csrf' } });
  }
  if (path === '/api/admin/dashboard') {
    return json({
      dashboard: {
        metrics: {
          orders: 42,
          grossFen: 186930,
          refundedFen: 1998,
          pending: 5,
          activeSubscriptions: 31,
          expiringSubscriptions: 4,
        },
        recentOrders: [order],
      },
      health: health,
      dataSync: { eventual: true, message: '边缘数据可能仍在同步，最多延迟 300 秒。' },
    });
  }
  if (path === '/api/admin/health') {
    return json({
      health: health,
      storage: { namespace: 'neye-orders', eventualConsistency: true, maximumDocumentedDelaySeconds: 300 },
    });
  }
  if (path === '/api/admin/payment-config') {
    return json({
      paymentConfig: paymentConfig,
      health: health,
      changedFields: request.method === 'PUT' ? ['paymentEnvironment'] : [],
      storage: { namespace: 'neye-orders', eventualConsistency: true, maximumDocumentedDelaySeconds: 300 },
    });
  }
  if (path === '/api/admin/plans') return json({ planConfig: planConfig });
  if (path === '/api/admin/orders') {
    return json({ orders: { items: [order], total: 1, nextCursor: null }, dataSync: { eventual: true } });
  }
  if (path === '/api/admin/orders/' + orderId) return json({ order: order });
  if (path === '/api/admin/subscribers') {
    return json({ subscribers: { items: [subscriber], total: 1, nextCursor: null }, dataSync: { eventual: true } });
  }
  if (path === '/api/admin/subscribers/' + subscriberId) return json({ subscriber: subscriber });
  if (path === '/api/admin/webhooks') {
    return json({
      enabled: true,
      webhooks: {
        items: [{
          id: 'WH_1234567890ABCDEF12345678',
          type: 'subscription.activated',
          orderId: orderId,
          subscriberId: subscriberId,
          status: 'delivered',
          attempts: 1,
          createdAt: order.paidAt,
          updatedAt: order.paidAt,
          deliveredAt: order.paidAt,
          lastError: '',
        }],
        total: 1,
        nextCursor: null,
      },
    });
  }
  if (path === '/api/admin/audit') {
    return json({
      audit: {
        items: [{
          id: 'AUD_LOCAL',
          createdAt: now.toISOString(),
          actor: 'admin',
          action: 'plans.update',
          targetType: 'plan_config',
          targetId: 'current',
          result: 'succeeded',
          requestId: 'REQ_LOCAL_PREVIEW',
        }],
        total: 1,
        nextCursor: null,
      },
    });
  }
  if (path === '/api/payment/status') {
    return json({
      order: {
        id: orderId,
        plan: 'annual',
        planName: '年付订阅',
        amount: '99.99',
        amountFen: 9999,
        createdAt: order.createdAt,
        expiresAt: order.expiresAt,
        paymentStatus: 'pending',
        paidAt: null,
        subscriptionExpiresAt: null,
      },
      syncPending: false,
    });
  }  if (path === '/api/subscription/plans') {
    return json({
      plans: {
        salesEnabled: planConfig.salesEnabled,
        configVersion: planConfig.configVersion,
        updatedAt: planConfig.updatedAt,
        plans: Object.values(planConfig.plans),
      },
    });
  }
  return null;
}

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

createServer(async function (request, response) {
  const mocked = apiResponse(request);
  if (mocked) {
    response.writeHead(mocked.status, mocked.headers);
    response.end(mocked.body);
    return;
  }
  try {
    const url = new URL(request.url, 'http://127.0.0.1:' + port);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';
    const relative = normalize(pathname).replace(/^([/\\])+/, '');
    const target = join(root, relative);
    if (!target.startsWith(root)) throw new Error('outside root');
    const info = await stat(target);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(target);
    const headers = {
      'content-type': contentTypes[extname(target).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    };
    if (url.pathname === '/admin/' || url.pathname === '/admin/index.html') {
      headers['set-cookie'] = url.searchParams.get('auth') === 'setup'
        ? 'preview_auth=setup; Path=/; SameSite=Strict'
        : 'preview_auth=; Path=/; Max-Age=0; SameSite=Strict';
    }
    response.writeHead(200, headers);
    response.end(body);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
}).listen(port, '127.0.0.1', function () {
  console.log('NEye preview: http://127.0.0.1:' + port);
});
