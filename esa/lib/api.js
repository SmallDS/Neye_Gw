import {
  AppError,
  amountToFen,
  assertMethod,
  KvStore,
  isAppError,
  localDateString,
  MAX_RANGE_DAYS,
  parseDateBoundary,
  parseJsonBody,
  paymentHealth,
  readConfig,
  requestId as createRequestId,
  requirePaymentConfig,
  RUNTIME_VERSION,
  sanitizeText,
  sha256,
  SUCCESS_TRADE_STATUSES,
} from './core.js';
import {
  checkAuthRuntime,
  clearSessionCookies,
  getAuthState,
  login,
  requireAdminSession,
  verifySensitivePassword,
} from './auth.js';
import {
  buildPaymentFields,
  classifyNotify,
  closeTrade,
  expectedSellerMatches,
  getBillDownload,
  parseFormBody,
  queryRefund,
  queryTrade,
  refundTrade,
  verifyNotifyParams,
} from './alipay.js';
import {
  adminOrder,
  adminSubscriber,
  adjustSubscriberExpiry,
  applyRefundQuery,
  applyRefundResponse,
  applyTradeQuery,
  closeLocalOrder,
  createOrder,
  createRefund,
  dashboardStats,
  listAudit,
  listOrders,
  listSubscribers,
  markOrderPaid,
  publicOrder,
  readSubscriber,
  recordAudit,
  requireOrder,
  requireSubscriber,
  saveOrder,
} from './domain.js';
import {
  getPlanConfig,
  publicPlanConfig,
  updatePlanConfig,
} from './plans.js';
import {
  emitSubscriptionEvent,
  listWebhooks,
  retryWebhook,
} from './webhook.js';
import {
  getPaymentConfigState,
  resolvePaymentConfig,
  savePaymentConfig,
} from './payment-config.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const TEMPORARY_RUNTIME_CHECK_PATH = '/api/system/runtime-check-20260813';

function responseHeaders(request, config, requestId, contentType, extra = {}) {
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Request-Id': requestId,
    'X-Neye-Runtime-Version': RUNTIME_VERSION,
  });
  const pathname = new URL(request.url).pathname;
  if (pathname.startsWith('/api/admin/') || pathname.startsWith('/api/payment/')) {
    headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  }
  const origin = request.headers.get('origin');
  if (origin && origin === config.baseUrl) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');
    headers.set('Access-Control-Allow-Credentials', 'true');
    headers.set('Vary', 'Origin');
  }
  for (const [name, value] of Object.entries(extra)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined && value !== null) {
      headers.set(name, String(value));
    }
  }
  return headers;
}

function jsonSuccess(request, config, requestId, data = {}, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(Object.assign({ ok: true, requestId }, data)), {
    status,
    headers: responseHeaders(request, config, requestId, 'application/json; charset=utf-8', extraHeaders),
  });
}

function plainResponse(request, config, requestId, value, status = 200, extraHeaders = {}) {
  return new Response(value, {
    status,
    headers: responseHeaders(request, config, requestId, 'text/plain; charset=utf-8', extraHeaders),
  });
}

export function errorResponse(request, config, requestId, error) {
  if (new URL(request.url).pathname === '/api/payment/notify') {
    return plainResponse(request, config, requestId, 'fail', error instanceof AppError ? error.status : 500);
  }
  const isStructuredError = isAppError(error);
  const status = isStructuredError ? error.status : 500;
  const code = isStructuredError ? error.code : 'INTERNAL_ERROR';
  const message = isStructuredError ? error.publicMessage : '服务暂时不可用，请稍后重试。';
  const payload = {
    ok: false,
    requestId,
    error: {
      code,
      message,
    },
  };
  if (isStructuredError && error.details) payload.error.details = error.details;
  return new Response(JSON.stringify(payload), {
    status,
    headers: responseHeaders(request, config, requestId, 'application/json; charset=utf-8'),
  });
}

function redirectToPayment(config, status, orderId = '') {
  const target = new URL('/payment.html', config.baseUrl + '/');
  target.searchParams.set('payment', status);
  if (orderId) target.searchParams.set('out_trade_no', orderId);
  return target.toString();
}

function dateRange(url, defaultDays = 30) {
  const defaultTo = localDateString();
  const defaultFrom = localDateString(new Date(Date.now() - (defaultDays - 1) * DAY_MS));
  const from = parseDateBoundary(url.searchParams.get('from') || defaultFrom);
  const to = parseDateBoundary(url.searchParams.get('to') || defaultTo, true);
  const duration = to.getTime() - from.getTime();
  if (duration <= 0) throw new AppError(400, 'INVALID_DATE_RANGE', '结束日期必须晚于开始日期。');
  if (duration > MAX_RANGE_DAYS * DAY_MS) {
    throw new AppError(400, 'DATE_RANGE_TOO_LARGE', '单次最多查询 3 个月。');
  }
  return { from, to };
}

async function auditAction(store, requestId, entry, action) {
  try {
    const result = await action();
    await recordAudit(store, Object.assign({}, entry, { result: 'succeeded', requestId }));
    return result;
  } catch (error) {
    try {
      await recordAudit(store, Object.assign({}, entry, { result: 'failed', requestId }));
    } catch {
      // 审计写入失败不掩盖原始业务错误。
    }
    throw error;
  }
}

async function maybeEmitWebhook(store, config, outcome, extra = {}) {
  if (!outcome?.eventType || !outcome.subscriber) return;
  await emitSubscriptionEvent(store, config, {
    type: outcome.eventType,
    order: outcome.order,
    subscriber: outcome.subscriber,
    extra,
  });
}

async function runRuntimeCheckStage(checks, name, action) {
  try {
    const value = await action();
    checks[name] = { ok: true, value: value === undefined ? null : value };
    return value;
  } catch (error) {
    checks[name] = {
      ok: false,
      code: isAppError(error) ? error.code : 'UNSTRUCTURED_RUNTIME_ERROR',
    };
    return null;
  }
}

async function handleTemporaryRuntimeCheck(request, store, rootConfig, requestId) {
  assertMethod(request, 'GET');
  const checks = {};
  await runRuntimeCheckStage(checks, 'authSession', async () => checkAuthRuntime(rootConfig));
  await runRuntimeCheckStage(checks, 'kvRead', async () => {
    await store.getJson('v2_runtime_config');
    return true;
  });
  let config = rootConfig;
  await runRuntimeCheckStage(checks, 'paymentConfig', async () => {
    config = await resolvePaymentConfig(store, rootConfig);
    return true;
  });
  await runRuntimeCheckStage(checks, 'plans', async () => {
    const result = await getPlanConfig(store);
    return Boolean(result?.plans?.monthly && result?.plans?.annual);
  });
  const url = new URL(request.url);
  const range = dateRange(url, 30);
  await runRuntimeCheckStage(checks, 'dashboard', async () => {
    const result = await dashboardStats(store, config, range.from, range.to);
    return Boolean(result?.metrics && Array.isArray(result?.recentOrders));
  });
  await runRuntimeCheckStage(checks, 'orders', async () => {
    const result = await listOrders(store, config, { from: range.from, to: range.to, limit: 1, cursor: 0 });
    return Number.isInteger(result?.total);
  });
  await runRuntimeCheckStage(checks, 'subscribers', async () => {
    const result = await listSubscribers(store, config, { limit: 1, cursor: 0 });
    return Number.isInteger(result?.total);
  });
  await runRuntimeCheckStage(checks, 'audit', async () => {
    const result = await listAudit(store, { from: range.from, to: range.to, limit: 1, cursor: 0 });
    return Number.isInteger(result?.total);
  });
  await runRuntimeCheckStage(checks, 'webhooks', async () => {
    const result = await listWebhooks(store, { from: range.from, to: range.to, limit: 1, cursor: 0 });
    return Number.isInteger(result?.total);
  });
  const ready = Object.values(checks).every((check) => check.ok === true && check.value !== false);
  return jsonSuccess(request, rootConfig, requestId, { ready, checks }, ready ? 200 : 503);
}

async function handlePublicPlans(request, store) {
  assertMethod(request, 'GET');
  return { plans: publicPlanConfig(await getPlanConfig(store)) };
}

async function handlePaymentCreate(request, store, config) {
  assertMethod(request, 'POST');
  requirePaymentConfig(config);
  const input = await parseJsonBody(request, 20000);
  const order = await createOrder(store, config, input);
  return {
    order: publicOrder(order),
    payment: {
      method: 'POST',
      action: config.gateway,
      fields: buildPaymentFields(config, order),
    },
  };
}

async function handlePaymentStatus(request, store, config) {
  assertMethod(request, 'GET');
  const url = new URL(request.url);
  const order = await requireOrder(store, url.searchParams.get('out_trade_no') || '');
  let syncPending = false;
  const lastSync = Date.parse(order.alipay?.lastSyncedAt || '');
  const shouldSync = order.paymentStatus === 'pending'
    && (!Number.isFinite(lastSync) || Date.now() - lastSync >= 10000);
  if (shouldSync) {
    try {
      const queried = await queryTrade(config, order);
      if (queried.found) {
        const outcome = await applyTradeQuery(store, config, order, queried.result, 'public_status');
        await maybeEmitWebhook(store, config, outcome);
      }
    } catch {
      syncPending = true;
    }
  }
  const subscriber = await readSubscriber(store, order.subscriberId);
  return {
    order: publicOrder(order, subscriber),
    syncPending,
  };
}

async function handlePaymentReturn(request, store, config) {
  if (request.method !== 'GET') {
    return new Response(null, {
      status: 302,
      headers: { Location: redirectToPayment(config, 'checking'), 'Cache-Control': 'no-store' },
    });
  }
  const params = {};
  for (const [key, value] of new URL(request.url).searchParams) params[key] = value;
  let state = 'checking';
  let orderId = '';
  try {
    requirePaymentConfig(config);
    if (params.sign && verifyNotifyParams(params, config) && params.app_id === config.appId) {
      const order = await requireOrder(store, params.out_trade_no || '');
      if (!params.total_amount || amountToFen(params.total_amount) === order.amountFen) {
        orderId = order.id;
        state = 'returned';
      }
    }
  } catch {
    state = 'checking';
  }
  return new Response(null, {
    status: 302,
    headers: {
      Location: redirectToPayment(config, state, orderId),
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
    },
  });
}

async function handlePaymentNotify(request, store, config, requestId) {
  requirePaymentConfig(config);
  assertMethod(request, 'POST');
  const body = await request.text();
  if (body.length > 100000) throw new AppError(413, 'NOTIFY_TOO_LARGE', '异步通知内容过长。');
  const params = parseFormBody(body);
  if (!params.notify_id || !params.out_trade_no || !params.trade_no || params.notify_type !== 'trade_status_sync') {
    throw new AppError(400, 'NOTIFY_FIELDS_MISSING', '异步通知关键字段或事件类型无效。');
  }
  if (!verifyNotifyParams(params, config)) {
    throw new AppError(400, 'NOTIFY_SIGNATURE_INVALID', '异步通知验签失败。');
  }
  if (params.app_id !== config.appId || !expectedSellerMatches(config, params)) {
    throw new AppError(400, 'NOTIFY_OWNER_MISMATCH', '异步通知商户信息不一致。');
  }
  const order = await requireOrder(store, params.out_trade_no);
  if (String(params.total_amount || '') && amountToFen(params.total_amount) !== order.amountFen) {
    throw new AppError(400, 'NOTIFY_AMOUNT_MISMATCH', '异步通知订单金额不一致。');
  }

  const eventType = classifyNotify(params);
  if (eventType === 'other') {
    throw new AppError(400, 'NOTIFY_EVENT_UNSUPPORTED', '异步通知事件类型不受支持。');
  }
  const idempotencyKey = 'v2_notify_' + sha256(
    params.notify_id + ':' + params.trade_no + ':' + eventType + ':' + (params.out_biz_no || ''),
  );
  if (await store.getJson(idempotencyKey)) {
    return plainResponse(request, config, requestId, 'success');
  }

  let webhookOutcome = null;
  if (eventType === 'payment') {
    const queried = await queryTrade(config, order);
    if (!queried.found || !SUCCESS_TRADE_STATUSES.includes(queried.result.trade_status)) {
      throw new AppError(409, 'PAYMENT_NOT_CONFIRMED', '支付宝交易尚未确认。');
    }
    webhookOutcome = await applyTradeQuery(store, config, order, queried.result, 'notify');
  } else if (eventType === 'refund') {
    const refund = (order.refunds || []).find((item) => item.id === params.out_biz_no);
    if (!refund) {
      throw new AppError(404, 'REFUND_NOT_FOUND', '退款请求不存在。');
    }
    const result = await queryRefund(config, order, refund);
    webhookOutcome = await applyRefundQuery(store, config, order, refund, result);
  } else if (eventType === 'close' && order.paymentStatus === 'pending') {
    order.paymentStatus = 'closed';
    order.alipay = Object.assign({}, order.alipay, {
      tradeNo: params.trade_no,
      tradeStatus: 'TRADE_CLOSED',
      lastSyncedAt: new Date().toISOString(),
      source: 'notify',
    });
    await saveOrder(store, order);
  }

  await store.putJson(idempotencyKey, {
    notifyId: params.notify_id,
    tradeNo: params.trade_no,
    outTradeNo: order.id,
    eventType,
    outBizNo: params.out_biz_no || '',
    processedAt: new Date().toISOString(),
  });
  await recordAudit(store, {
    actor: 'alipay',
    action: 'payment.notify.' + eventType,
    targetType: 'order',
    targetId: order.id,
    result: 'succeeded',
    requestId,
    meta: { tradeStatus: params.trade_status || '' },
    allowedMeta: ['tradeStatus'],
  });
  await maybeEmitWebhook(store, config, webhookOutcome, {
    refundId: params.out_biz_no || undefined,
  });
  return plainResponse(request, config, requestId, 'success');
}

async function collectAllOrders(store, config, options) {
  const items = [];
  let cursor = '0';
  do {
    const page = await listOrders(store, config, Object.assign({}, options, { cursor, limit: 100 }));
    items.push(...page.items);
    cursor = page.nextCursor;
    if (items.length > 5000) {
      throw new AppError(413, 'EXPORT_TOO_LARGE', '导出订单过多，请缩小日期范围。');
    }
  } while (cursor);
  return items;
}

function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

function ordersCsv(orders) {
  const rows = [[
    '订单号', '创建时间', '支付时间', '状态', '套餐', '套餐版本', '金额（分）',
    '联系人', '联系方式', '支付宝交易号', '退款成功金额（分）', '备注',
  ]];
  for (const order of orders) {
    const refunded = (order.refunds || [])
      .filter((refund) => refund.status === 'succeeded')
      .reduce((sum, refund) => sum + refund.amountFen, 0);
    rows.push([
      order.id,
      order.createdAt,
      order.paidAt || '',
      order.paymentStatus,
      order.planSnapshot.name,
      order.planSnapshot.version,
      order.amountFen,
      order.contactName,
      order.contact.value,
      order.alipayTradeNo,
      refunded,
      order.note,
    ]);
  }
  return '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}

async function handleAdminRoute(request, store, rootConfig, requestId) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/api/admin/auth/state') {
    assertMethod(request, 'GET');
    return jsonSuccess(request, rootConfig, requestId, { auth: await getAuthState(store, rootConfig) });
  }
  if (path === '/api/admin/auth/login') {
    assertMethod(request, 'POST');
    const session = await login(store, rootConfig, request, await parseJsonBody(request));
    try {
      await recordAudit(store, {
        action: 'admin.login',
        targetType: 'admin',
        targetId: 'primary',
        result: 'succeeded',
        requestId,
      });
    } catch {
      // 登录审计不可用时保留服务端错误日志，但不阻断已通过校验的管理员。
      console.log('neye_admin_login_audit_failed', requestId);
    }
    try {
      return jsonSuccess(request, rootConfig, requestId, {
        session: { expiresAt: session.session.expiresAt * 1000, csrfToken: session.csrfToken },
      }, 200, { 'Set-Cookie': session.cookies });
    } catch {
      throw new AppError(503, 'ADMIN_LOGIN_STAGE_FAILED', '管理员登录服务暂时不可用。', {
        stage: 'response_create',
      });
    }
  }
  if (path === '/api/admin/session') {
    assertMethod(request, 'GET');
    const session = await requireAdminSession(store, rootConfig, request);
    return jsonSuccess(request, rootConfig, requestId, { session });
  }
  if (path === '/api/admin/auth/logout') {
    assertMethod(request, 'POST');
    await requireAdminSession(store, rootConfig, request, { csrf: true });
    await recordAudit(store, {
      action: 'admin.logout',
      targetType: 'admin',
      targetId: 'primary',
      result: 'succeeded',
      requestId,
    });
    return jsonSuccess(request, rootConfig, requestId, {}, 200, { 'Set-Cookie': clearSessionCookies() });
  }

  const writeRequest = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method);
  await requireAdminSession(store, rootConfig, request, { csrf: writeRequest });

  if (path === '/api/admin/payment-config' && request.method === 'GET') {
    const result = await getPaymentConfigState(store, rootConfig);
    return jsonSuccess(request, result.effectiveConfig, requestId, {
      paymentConfig: result.paymentConfig,
      health: paymentHealth(result.effectiveConfig),
      storage: {
        namespace: rootConfig.kvNamespace,
        eventualConsistency: true,
        maximumDocumentedDelaySeconds: 300,
      },
    });
  }
  if (path === '/api/admin/payment-config' && request.method === 'PUT') {
    const input = await parseJsonBody(request, 50000);
    const result = await auditAction(store, requestId, {
      action: 'payment.config.update',
      targetType: 'payment_config',
      targetId: 'current',
      meta: {
        environment: String(input.paymentEnvironment || '').slice(0, 20),
        applicationPrivateKeyReplaced: Boolean(input.privatePkcsKey),
        alipayPublicKeyReplaced: Boolean(input.alipayPublicKey),
        webhookSecretReplaced: Boolean(input.webhookSecret),
      },
      allowedMeta: [
        'environment',
        'applicationPrivateKeyReplaced',
        'alipayPublicKeyReplaced',
        'webhookSecretReplaced',
      ],
    }, () => savePaymentConfig(
      store,
      rootConfig,
      input,
      () => verifySensitivePassword(store, rootConfig, request, input.adminPassword)
    ));
    return jsonSuccess(request, result.effectiveConfig, requestId, {
      paymentConfig: result.paymentConfig,
      health: paymentHealth(result.effectiveConfig),
      changedFields: result.changedFields,
      storage: {
        namespace: rootConfig.kvNamespace,
        eventualConsistency: true,
        maximumDocumentedDelaySeconds: 300,
      },
      dataSync: { eventual: true, message: '支付配置已保存，边缘节点同步可能需要数秒。' },
    });
  }

  const config = await resolvePaymentConfig(store, rootConfig);

  if (path === '/api/admin/dashboard') {
    assertMethod(request, 'GET');
    const range = dateRange(url, 30);
    return jsonSuccess(request, config, requestId, {
      dashboard: await dashboardStats(store, config, range.from, range.to),
      health: paymentHealth(config),
      dataSync: { eventual: true, message: '边缘数据可能仍在同步，最多延迟 300 秒。' },
    });
  }
  if (path === '/api/admin/health') {
    assertMethod(request, 'GET');
    return jsonSuccess(request, config, requestId, {
      health: paymentHealth(config),
      storage: {
        namespace: config.kvNamespace,
        eventualConsistency: true,
        maximumDocumentedDelaySeconds: 300,
      },
    });
  }
  if (path === '/api/admin/plans' && request.method === 'GET') {
    return jsonSuccess(request, config, requestId, { planConfig: await getPlanConfig(store) });
  }
  if (path === '/api/admin/plans' && request.method === 'PUT') {
    const input = await parseJsonBody(request);
    const updated = await auditAction(store, requestId, {
      action: 'plans.update',
      targetType: 'plan_config',
      targetId: 'current',
      meta: { salesEnabled: Boolean(input.salesEnabled) },
      allowedMeta: ['salesEnabled'],
    }, () => updatePlanConfig(store, input));
    return jsonSuccess(request, config, requestId, { planConfig: updated });
  }
  if (path === '/api/admin/orders') {
    assertMethod(request, 'GET');
    const range = dateRange(url, 30);
    const result = await listOrders(store, config, {
      ...range,
      cursor: url.searchParams.get('cursor'),
      limit: url.searchParams.get('limit'),
      status: sanitizeText(url.searchParams.get('status'), 30),
      planId: sanitizeText(url.searchParams.get('plan'), 30),
      orderId: sanitizeText(url.searchParams.get('orderId'), 50),
      tradeNo: sanitizeText(url.searchParams.get('tradeNo'), 80),
      contact: sanitizeText(url.searchParams.get('contact'), 120),
    });
    return jsonSuccess(request, config, requestId, {
      orders: result,
      dataSync: { eventual: true, message: '数据可能仍在同步。' },
    });
  }
  if (path === '/api/admin/orders/export') {
    assertMethod(request, 'GET');
    const range = dateRange(url, 30);
    const orders = await collectAllOrders(store, config, {
      ...range,
      status: sanitizeText(url.searchParams.get('status'), 30),
      planId: sanitizeText(url.searchParams.get('plan'), 30),
      contact: sanitizeText(url.searchParams.get('contact'), 120),
    });
    await recordAudit(store, {
      action: 'orders.export',
      targetType: 'order_range',
      targetId: localDateString(range.from) + '_' + localDateString(new Date(range.to.getTime() - DAY_MS)),
      result: 'succeeded',
      requestId,
      meta: { count: orders.length },
      allowedMeta: ['count'],
    });
    return new Response(ordersCsv(orders), {
      status: 200,
      headers: responseHeaders(request, config, requestId, 'text/csv; charset=utf-8', {
        'Content-Disposition': 'attachment; filename="neye-orders.csv"',
      }),
    });
  }

  const orderDetailMatch = path.match(/^\/api\/admin\/orders\/(NEYE[A-Z0-9]{16,40})$/);
  if (orderDetailMatch) {
    assertMethod(request, 'GET');
    const order = await requireOrder(store, orderDetailMatch[1]);
    return jsonSuccess(request, config, requestId, { order: adminOrder(order, config) });
  }
  const orderSyncMatch = path.match(/^\/api\/admin\/orders\/(NEYE[A-Z0-9]{16,40})\/sync$/);
  if (orderSyncMatch) {
    assertMethod(request, 'POST');
    const order = await requireOrder(store, orderSyncMatch[1]);
    const outcome = await auditAction(store, requestId, {
      action: 'order.sync',
      targetType: 'order',
      targetId: order.id,
    }, async () => {
      const queried = await queryTrade(config, order);
      if (!queried.found) {
        order.alipay.lastSyncedAt = new Date().toISOString();
        await saveOrder(store, order);
        return { order, subscriber: await readSubscriber(store, order.subscriberId), eventType: null };
      }
      return applyTradeQuery(store, config, order, queried.result, 'admin_sync');
    });
    await maybeEmitWebhook(store, config, outcome);
    return jsonSuccess(request, config, requestId, { order: adminOrder(outcome.order, config) });
  }
  const orderCloseMatch = path.match(/^\/api\/admin\/orders\/(NEYE[A-Z0-9]{16,40})\/close$/);
  if (orderCloseMatch) {
    assertMethod(request, 'POST');
    const order = await requireOrder(store, orderCloseMatch[1]);
    const closed = await auditAction(store, requestId, {
      action: 'order.close',
      targetType: 'order',
      targetId: order.id,
    }, async () => {
      if (order.paymentStatus === 'closed') return order;
      if (order.paymentStatus !== 'pending') {
        throw new AppError(409, 'ORDER_NOT_CLOSABLE', '只有待支付订单可以关单。');
      }
      const queried = await queryTrade(config, order);
      if (queried.found) {
        const synced = await applyTradeQuery(store, config, order, queried.result, 'pre_close');
        if (SUCCESS_TRADE_STATUSES.includes(queried.result.trade_status)) {
          await maybeEmitWebhook(store, config, synced);
          throw new AppError(409, 'ORDER_ALREADY_PAID', '订单已经支付，不能关单。');
        }
        if (queried.result.trade_status === 'TRADE_CLOSED') return synced.order;
        const result = await closeTrade(config, order);
        return closeLocalOrder(store, order, result);
      }
      return closeLocalOrder(store, order, {});
    });
    return jsonSuccess(request, config, requestId, { order: adminOrder(closed, config) });
  }
  const orderRefundMatch = path.match(/^\/api\/admin\/orders\/(NEYE[A-Z0-9]{16,40})\/refunds$/);
  if (orderRefundMatch) {
    assertMethod(request, 'POST');
    const input = await parseJsonBody(request);
    const order = await requireOrder(store, orderRefundMatch[1]);
    const outcome = await auditAction(store, requestId, {
      action: 'order.refund',
      targetType: 'order',
      targetId: order.id,
      meta: { amountFen: Number(input.amountFen) || 0 },
      allowedMeta: ['amountFen'],
    }, async () => {
      if (!['paid', 'partially_refunded'].includes(order.paymentStatus)) {
        throw new AppError(409, 'ORDER_NOT_REFUNDABLE', '当前订单状态不能退款。');
      }
      const queried = await queryTrade(config, order);
      if (!queried.found || !SUCCESS_TRADE_STATUSES.includes(queried.result.trade_status)) {
        throw new AppError(409, 'ORDER_PAYMENT_UNCONFIRMED', '支付宝交易尚未确认，暂不能退款。');
      }
      await applyTradeQuery(store, config, order, queried.result, 'pre_refund');
      const refund = createRefund(order, input);
      if (refund.status === 'succeeded') return { order, refund, subscriber: null, eventType: null };
      await saveOrder(store, order);
      let result;
      try {
        result = await refundTrade(config, order, refund);
      } catch (error) {
        throw new AppError(502, 'REFUND_STATUS_UNKNOWN', '退款请求结果暂未确认，请使用同一退款单号重试或查询。', {
          refundRequestNo: refund.id,
        });
      }
      return applyRefundResponse(store, config, order, refund, result);
    });
    await maybeEmitWebhook(store, config, outcome, { refundId: outcome.refund.id });
    return jsonSuccess(request, config, requestId, {
      order: adminOrder(outcome.order, config),
      refund: outcome.refund,
    });
  }
  const refundSyncMatch = path.match(/^\/api\/admin\/orders\/(NEYE[A-Z0-9]{16,40})\/refunds\/([A-Z0-9_]{8,64})\/sync$/);
  if (refundSyncMatch) {
    assertMethod(request, 'POST');
    const order = await requireOrder(store, refundSyncMatch[1]);
    const refund = (order.refunds || []).find((item) => item.id === refundSyncMatch[2]);
    if (!refund) throw new AppError(404, 'REFUND_NOT_FOUND', '退款请求不存在。');
    if (Date.now() - Date.parse(refund.lastAttemptAt || refund.createdAt) < 10000) {
      throw new AppError(409, 'REFUND_QUERY_TOO_EARLY', '退款提交后至少等待 10 秒再查询。', {
        retryAfterSeconds: 10,
      });
    }
    const outcome = await auditAction(store, requestId, {
      action: 'refund.sync',
      targetType: 'refund',
      targetId: refund.id,
    }, async () => {
      const result = await queryRefund(config, order, refund);
      return applyRefundQuery(store, config, order, refund, result);
    });
    await maybeEmitWebhook(store, config, outcome, { refundId: refund.id });
    return jsonSuccess(request, config, requestId, {
      order: adminOrder(outcome.order, config),
      refund: outcome.refund,
    });
  }

  if (path === '/api/admin/subscribers') {
    assertMethod(request, 'GET');
    const result = await listSubscribers(store, config, {
      cursor: url.searchParams.get('cursor'),
      limit: url.searchParams.get('limit'),
      status: sanitizeText(url.searchParams.get('status'), 30),
      contact: sanitizeText(url.searchParams.get('contact'), 120),
    });
    return jsonSuccess(request, config, requestId, {
      subscribers: result,
      dataSync: { eventual: true, message: '数据可能仍在同步。' },
    });
  }
  const subscriberDetailMatch = path.match(/^\/api\/admin\/subscribers\/([a-f0-9]{64})$/);
  if (subscriberDetailMatch) {
    assertMethod(request, 'GET');
    const subscriber = await requireSubscriber(store, subscriberDetailMatch[1]);
    const view = adminSubscriber(subscriber, config);
    const orderRecords = [];
    for (const grant of subscriber.grants || []) {
      try {
        const order = await requireOrder(store, grant.orderId);
        orderRecords.push(adminOrder(order, config));
      } catch {
        // 最终一致性期间允许单条订单详情暂不可见。
      }
    }
    view.orders = orderRecords;
    return jsonSuccess(request, config, requestId, { subscriber: view });
  }
  const subscriberAdjustMatch = path.match(/^\/api\/admin\/subscribers\/([a-f0-9]{64})\/adjust$/);
  if (subscriberAdjustMatch) {
    assertMethod(request, 'POST');
    const input = await parseJsonBody(request);
    const subscriber = await requireSubscriber(store, subscriberAdjustMatch[1]);
    const outcome = await auditAction(store, requestId, {
      action: 'subscription.adjust',
      targetType: 'subscriber',
      targetId: subscriber.id,
    }, () => adjustSubscriberExpiry(store, config, subscriber, input));
    await emitSubscriptionEvent(store, config, {
      type: outcome.eventType,
      order: null,
      subscriber: outcome.subscriber,
      extra: { adjustmentId: outcome.adjustment.id },
    });
    return jsonSuccess(request, config, requestId, {
      subscriber: adminSubscriber(outcome.subscriber, config),
      adjustment: outcome.adjustment,
    });
  }

  if (path === '/api/admin/bills/download') {
    assertMethod(request, 'GET');
    const date = url.searchParams.get('date') || '';
    const billStart = parseDateBoundary(date);
    const todayStart = parseDateBoundary(localDateString());
    if (billStart.getTime() >= todayStart.getTime()) {
      throw new AppError(400, 'BILL_DATE_NOT_READY', '只能下载昨日或更早日期的账单。');
    }
    const oldest = new Date(todayStart);
    oldest.setUTCFullYear(oldest.getUTCFullYear() - 6);
    if (billStart.getTime() < oldest.getTime()) {
      throw new AppError(400, 'BILL_DATE_TOO_OLD', '支付宝接口仅支持近 6 年账单。');
    }
    const bill = await auditAction(store, requestId, {
      action: 'bill.download',
      targetType: 'bill',
      targetId: date,
    }, async () => {
      const descriptor = await getBillDownload(config, date);
      const response = await fetch(descriptor.url, { redirect: 'error' });
      if (!response.ok || !response.body) {
        throw new AppError(502, 'BILL_DOWNLOAD_FAILED', '支付宝账单文件下载失败。');
      }
      return response;
    });
    return new Response(bill.body, {
      status: 200,
      headers: responseHeaders(request, config, requestId, bill.headers.get('content-type') || 'application/zip', {
        'Content-Disposition': 'attachment; filename="alipay-trade-' + date + '.zip"',
      }),
    });
  }

  if (path === '/api/admin/audit') {
    assertMethod(request, 'GET');
    const range = dateRange(url, 30);
    const result = await listAudit(store, {
      ...range,
      cursor: url.searchParams.get('cursor'),
      limit: url.searchParams.get('limit'),
      action: sanitizeText(url.searchParams.get('action'), 80),
    });
    return jsonSuccess(request, config, requestId, { audit: result });
  }
  if (path === '/api/admin/webhooks') {
    assertMethod(request, 'GET');
    const range = dateRange(url, 30);
    const result = await listWebhooks(store, {
      ...range,
      cursor: url.searchParams.get('cursor'),
      limit: url.searchParams.get('limit'),
      status: sanitizeText(url.searchParams.get('status'), 30),
    });
    return jsonSuccess(request, config, requestId, {
      webhooks: result,
      enabled: Boolean(config.webhookUrl && config.webhookSecret),
    });
  }
  const webhookRetryMatch = path.match(/^\/api\/admin\/webhooks\/(WH_[A-F0-9]{24})\/retry$/);
  if (webhookRetryMatch) {
    assertMethod(request, 'POST');
    const event = await auditAction(store, requestId, {
      action: 'webhook.retry',
      targetType: 'webhook',
      targetId: webhookRetryMatch[1],
    }, () => retryWebhook(store, config, webhookRetryMatch[1]));
    return jsonSuccess(request, config, requestId, { event });
  }

  throw new AppError(404, 'NOT_FOUND', '接口不存在。');
}

export async function routeRequest(request, supplied = {}) {
  const rootConfig = supplied.config || readConfig();
  const requestId = supplied.requestId || createRequestId();
  const url = new URL(request.url);

  if (request.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
    return new Response(null, {
      status: 204,
      headers: responseHeaders(request, rootConfig, requestId, 'text/plain; charset=utf-8'),
    });
  }

  const store = supplied.store || new KvStore(rootConfig);
  if (url.pathname === TEMPORARY_RUNTIME_CHECK_PATH) {
    return handleTemporaryRuntimeCheck(request, store, rootConfig, requestId);
  }
  if (url.pathname === '/api/subscription/plans') {
    return jsonSuccess(request, rootConfig, requestId, await handlePublicPlans(request, store));
  }
  if (url.pathname === '/api/payment/create') {
    const config = await resolvePaymentConfig(store, rootConfig);
    return jsonSuccess(request, config, requestId, await handlePaymentCreate(request, store, config), 201);
  }
  if (url.pathname === '/api/payment/status') {
    const config = await resolvePaymentConfig(store, rootConfig);
    return jsonSuccess(request, config, requestId, await handlePaymentStatus(request, store, config));
  }
  if (url.pathname === '/api/payment/return') {
    const config = await resolvePaymentConfig(store, rootConfig);
    return handlePaymentReturn(request, store, config);
  }
  if (url.pathname === '/api/payment/notify') {
    const config = await resolvePaymentConfig(store, rootConfig);
    return handlePaymentNotify(request, store, config, requestId);
  }
  if (url.pathname.startsWith('/api/admin/')) {
    return handleAdminRoute(request, store, rootConfig, requestId);
  }
  throw new AppError(404, 'NOT_FOUND', '接口不存在。');
}
