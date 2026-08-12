import {
  addCalendarPeriod,
  amountToFen,
  AppError,
  clampPageSize,
  dateKey,
  decryptJson,
  encryptJson,
  INDEX_SHARDS,
  maskContact,
  monthKey,
  monthsForRange,
  normalizeContact,
  parseCursor,
  randomId,
  sanitizeText,
  safeMeta,
  shardFor,
  subscriberIdFor,
  SUCCESS_TRADE_STATUSES,
} from './core.js';
import { getPlanConfig, planSnapshot } from './plans.js';

function orderKey(id) {
  return 'v2_order_' + id;
}

function subscriberKey(id) {
  return 'v2_subscriber_' + id;
}

function auditKey(id) {
  return 'v2_audit_' + id;
}

function orderIndexKey(month, shard) {
  return 'v2_idx_orders_' + month + '_' + shard.toString(16);
}

function subscriberIndexKey(shard) {
  return 'v2_idx_subscribers_' + shard.toString(16);
}

function auditIndexKey(month, shard) {
  return 'v2_idx_audit_' + month + '_' + shard.toString(16);
}

function newOrderId() {
  const now = new Date();
  const compact = now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return randomId('NEYE' + compact, 6);
}

export async function createOrder(store, config, input) {
  const planConfig = await getPlanConfig(store);
  if (!planConfig.salesEnabled) {
    throw new AppError(503, 'SUBSCRIPTION_SALES_DISABLED', '订阅服务当前暂停销售。');
  }
  const plan = planConfig.plans[String(input.plan || '')];
  if (!plan || !plan.enabled) {
    throw new AppError(400, 'PLAN_UNAVAILABLE', '所选订阅套餐当前不可用。');
  }
  const contactName = sanitizeText(input.contactName, 100);
  const normalizedContact = normalizeContact(input.contactMethod);
  const note = sanitizeText(input.note, 500);
  if (!contactName) throw new AppError(400, 'CONTACT_NAME_REQUIRED', '请填写联系人。');
  if (input.consent !== true) {
    throw new AppError(400, 'CONSENT_REQUIRED', '请确认订阅方案及价格。');
  }

  const id = newOrderId();
  const createdAt = new Date().toISOString();
  const snapshot = planSnapshot(plan);
  const order = {
    schemaVersion: 2,
    id,
    planId: plan.id,
    planSnapshot: snapshot,
    amountFen: snapshot.priceFen,
    expectedSellerId: config.sellerId || '',
    expectedSellerEmail: config.sellerEmail || '',
    subscriberId: subscriberIdFor(config, normalizedContact),
    privateCipher: encryptJson({
      contactName,
      contact: normalizedContact,
      note,
    }, config.adminDataKey, 'order:' + id),
    createdAt,
    expiresAt: new Date(Date.now() + snapshot.timeoutMinutes * 60 * 1000).toISOString(),
    updatedAt: createdAt,
    paymentStatus: 'pending',
    paidAt: null,
    grantId: null,
    alipay: {
      tradeNo: '',
      tradeStatus: '',
      lastSyncedAt: null,
    },
    refunds: [],
  };
  await store.putJson(orderKey(id), order);
  await store.appendIndex(orderIndexKey(monthKey(createdAt), shardFor(id)), id);
  return order;
}

export async function readOrder(store, id) {
  if (!/^NEYE[A-Z0-9]{16,40}$/.test(String(id || ''))) {
    throw new AppError(400, 'INVALID_ORDER_ID', '订单号无效。');
  }
  return store.getJson(orderKey(id));
}

export async function requireOrder(store, id) {
  const order = await readOrder(store, id);
  if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', '订单不存在或已过期。');
  return order;
}

export async function saveOrder(store, order) {
  order.updatedAt = new Date().toISOString();
  await store.putJson(orderKey(order.id), order);
}

export function publicOrder(order, subscription = null) {
  return {
    id: order.id,
    plan: order.planId,
    planName: order.planSnapshot.name,
    amount: (order.amountFen / 100).toFixed(2),
    amountFen: order.amountFen,
    createdAt: order.createdAt,
    expiresAt: order.expiresAt,
    paymentStatus: order.paymentStatus,
    paidAt: order.paidAt || null,
    subscriptionExpiresAt: subscription?.expiresAt || null,
  };
}

export function adminOrder(order, config) {
  const privateData = decryptJson(order.privateCipher, config.adminDataKey, 'order:' + order.id);
  return {
    id: order.id,
    planId: order.planId,
    planSnapshot: order.planSnapshot,
    amountFen: order.amountFen,
    createdAt: order.createdAt,
    expiresAt: order.expiresAt,
    updatedAt: order.updatedAt,
    paymentStatus: order.paymentStatus,
    paidAt: order.paidAt,
    contactName: privateData.contactName,
    contact: privateData.contact,
    contactMasked: maskContact(privateData.contact),
    note: privateData.note,
    subscriberId: order.subscriberId,
    grantId: order.grantId,
    alipayTradeNo: order.alipay?.tradeNo || '',
    alipayTradeStatus: order.alipay?.tradeStatus || '',
    lastSyncedAt: order.alipay?.lastSyncedAt || null,
    refunds: Array.isArray(order.refunds) ? order.refunds : [],
  };
}

function subscriberStatus(expiresAt, now = Date.now()) {
  if (!expiresAt || Date.parse(expiresAt) <= now) return 'expired';
  if (Date.parse(expiresAt) - now <= 7 * 24 * 60 * 60 * 1000) return 'expiring';
  return 'active';
}

export function recomputeSubscriber(subscriber) {
  const events = [];
  const seenOrders = new Set();
  for (const grant of subscriber.grants || []) {
    if (!grant.revokedAt && !seenOrders.has(grant.orderId)) {
      seenOrders.add(grant.orderId);
      events.push({ type: 'grant', at: grant.paidAt, value: grant });
    }
  }
  for (const adjustment of subscriber.adjustments || []) {
    events.push({ type: 'adjustment', at: adjustment.effectiveAt, value: adjustment });
  }
  events.sort((left, right) => {
    const difference = Date.parse(left.at) - Date.parse(right.at);
    if (difference !== 0) return difference;
    return left.type === 'grant' ? -1 : 1;
  });
  let expiresAt = null;
  for (const event of events) {
    if (event.type === 'adjustment') {
      expiresAt = event.value.targetExpiresAt;
      continue;
    }
    const start = expiresAt && Date.parse(expiresAt) > Date.parse(event.value.paidAt)
      ? expiresAt
      : event.value.paidAt;
    expiresAt = addCalendarPeriod(start, event.value.periodUnit, event.value.periodCount);
  }
  subscriber.expiresAt = expiresAt;
  subscriber.status = subscriberStatus(expiresAt);
  subscriber.updatedAt = new Date().toISOString();
  return subscriber;
}

export async function readSubscriber(store, id) {
  if (!/^[a-f0-9]{64}$/.test(String(id || ''))) {
    throw new AppError(400, 'INVALID_SUBSCRIBER_ID', '订阅用户标识无效。');
  }
  return store.getJson(subscriberKey(id));
}

export async function requireSubscriber(store, id) {
  const subscriber = await readSubscriber(store, id);
  if (!subscriber) throw new AppError(404, 'SUBSCRIBER_NOT_FOUND', '订阅用户不存在。');
  return subscriber;
}

export function adminSubscriber(subscriber, config) {
  const privateData = decryptJson(subscriber.privateCipher, config.adminDataKey, 'subscriber:' + subscriber.id);
  const dynamicStatus = subscriberStatus(subscriber.expiresAt);
  return {
    id: subscriber.id,
    contactName: privateData.contactName,
    contact: privateData.contact,
    contactMasked: maskContact(privateData.contact),
    createdAt: subscriber.createdAt,
    updatedAt: subscriber.updatedAt,
    expiresAt: subscriber.expiresAt,
    status: dynamicStatus,
    grants: (subscriber.grants || []).map((grant) => ({ ...grant })),
    adjustments: (subscriber.adjustments || []).map((adjustment) => ({ ...adjustment })),
  };
}

export async function markOrderPaid(store, config, order, trade, source) {
  if (trade.out_trade_no && trade.out_trade_no !== order.id) {
    throw new AppError(502, 'ALIPAY_ORDER_MISMATCH', '支付宝订单信息不一致。');
  }
  if (trade.total_amount && amountToFen(trade.total_amount) !== order.amountFen) {
    throw new AppError(502, 'ALIPAY_AMOUNT_MISMATCH', '支付宝订单金额不一致。');
  }
  if (!SUCCESS_TRADE_STATUSES.includes(trade.trade_status)) {
    return { order, subscriber: await readSubscriber(store, order.subscriberId), eventType: null };
  }

  const privateData = decryptJson(order.privateCipher, config.adminDataKey, 'order:' + order.id);
  const existingSubscriber = await store.getJson(subscriberKey(order.subscriberId));
  const subscriber = existingSubscriber || {
    schemaVersion: 2,
    id: order.subscriberId,
    privateCipher: encryptJson({
      contactName: privateData.contactName,
      contact: privateData.contact,
    }, config.adminDataKey, 'subscriber:' + order.subscriberId),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: null,
    status: 'expired',
    grants: [],
    adjustments: [],
  };
  const previousExpiry = subscriber.expiresAt;
  const paidAt = order.paidAt || trade.send_pay_date || new Date().toISOString();
  let grant = (subscriber.grants || []).find((item) => item.orderId === order.id);
  const grantWasCreated = !grant;
  if (!grant) {
    grant = {
      id: 'GRANT_' + order.id,
      orderId: order.id,
      planId: order.planId,
      planVersion: order.planSnapshot.version,
      paidAt,
      periodUnit: order.planSnapshot.periodUnit,
      periodCount: order.planSnapshot.periodCount,
      revokedAt: null,
      revokedReason: null,
    };
    subscriber.grants.push(grant);
  }

  recomputeSubscriber(subscriber);
  await store.putJson(subscriberKey(subscriber.id), subscriber);
  if (!existingSubscriber) {
    await store.appendIndex(subscriberIndexKey(shardFor(subscriber.id)), subscriber.id);
  }

  order.paymentStatus = order.paymentStatus === 'refunded'
    ? 'refunded'
    : order.paymentStatus === 'partially_refunded'
      ? 'partially_refunded'
      : 'paid';
  order.paidAt = paidAt;
  order.grantId = grant.id;
  order.alipay = {
    tradeNo: String(trade.trade_no || order.alipay?.tradeNo || ''),
    tradeStatus: String(trade.trade_status || order.alipay?.tradeStatus || ''),
    lastSyncedAt: new Date().toISOString(),
    source,
  };
  await saveOrder(store, order);
  if (order.alipay.tradeNo) await store.putJson('v2_trade_' + order.alipay.tradeNo, { orderId: order.id });

  const wasActive = previousExpiry && Date.parse(previousExpiry) > Date.parse(paidAt);
  return {
    order,
    subscriber,
    eventType: grantWasCreated ? (existingSubscriber && wasActive ? 'subscription.extended' : 'subscription.activated') : null,
  };
}

export async function applyTradeQuery(store, config, order, queryResult, source = 'query') {
  order.alipay = Object.assign({}, order.alipay, {
    tradeNo: String(queryResult.trade_no || order.alipay?.tradeNo || ''),
    tradeStatus: String(queryResult.trade_status || ''),
    lastSyncedAt: new Date().toISOString(),
    source,
  });
  if (SUCCESS_TRADE_STATUSES.includes(queryResult.trade_status)) {
    return markOrderPaid(store, config, order, queryResult, source);
  }
  if (queryResult.trade_status === 'TRADE_CLOSED' && order.paymentStatus === 'pending') {
    order.paymentStatus = 'closed';
  }
  await saveOrder(store, order);
  return { order, subscriber: await readSubscriber(store, order.subscriberId), eventType: null };
}

export function createRefund(order, input) {
  const requestedId = sanitizeText(input.refundRequestNo, 64);
  if (requestedId) {
    const existing = (order.refunds || []).find((refund) => refund.id === requestedId);
    if (!existing) throw new AppError(404, 'REFUND_NOT_FOUND', '退款请求不存在。');
    const amountFen = Number(input.amountFen);
    const reason = sanitizeText(input.reason, 200);
    if (amountFen !== existing.amountFen || reason !== existing.reason) {
      throw new AppError(409, 'REFUND_RETRY_MISMATCH', '重试退款必须保持退款单号、金额和原因一致。');
    }
    if (existing.status === 'succeeded') return existing;
    existing.status = 'pending';
    existing.lastAttemptAt = new Date().toISOString();
    return existing;
  }

  const amountFen = Number(input.amountFen);
  const reason = sanitizeText(input.reason, 200);
  if (!Number.isSafeInteger(amountFen) || amountFen < 1) {
    throw new AppError(400, 'INVALID_REFUND_AMOUNT', '退款金额无效。');
  }
  if (!reason) throw new AppError(400, 'REFUND_REASON_REQUIRED', '请填写退款原因。');
  const reservedFen = (order.refunds || [])
    .filter((refund) => ['pending', 'succeeded'].includes(refund.status))
    .reduce((sum, refund) => sum + refund.amountFen, 0);
  if (reservedFen + amountFen > order.amountFen) {
    throw new AppError(409, 'REFUND_AMOUNT_EXCEEDED', '累计退款金额不能超过订单实付金额。');
  }
  const refund = {
    id: randomId('NERF' + dateKey(), 7),
    amountFen,
    reason,
    status: 'pending',
    createdAt: new Date().toISOString(),
    lastAttemptAt: new Date().toISOString(),
    completedAt: null,
    alipayStatus: '',
  };
  order.refunds = Array.isArray(order.refunds) ? order.refunds : [];
  order.refunds.push(refund);
  return refund;
}

async function finalizeRefund(store, config, order, refund) {
  const succeededFen = (order.refunds || [])
    .filter((item) => item.status === 'succeeded')
    .reduce((sum, item) => sum + item.amountFen, 0);
  let revokedSubscriber = null;
  if (succeededFen >= order.amountFen) {
    order.paymentStatus = 'refunded';
    const subscriber = await readSubscriber(store, order.subscriberId);
    if (subscriber) {
      const matchingGrants = (subscriber.grants || []).filter((item) => item.orderId === order.id);
      const revokedAt = refund.completedAt || new Date().toISOString();
      let changed = false;
      for (const grant of matchingGrants) {
        if (grant.revokedAt) continue;
        grant.revokedAt = revokedAt;
        grant.revokedReason = 'full_refund';
        changed = true;
      }
      if (changed) {
        recomputeSubscriber(subscriber);
        await store.putJson(subscriberKey(subscriber.id), subscriber);
        revokedSubscriber = subscriber;
      }
    }
  } else if (succeededFen > 0) {
    order.paymentStatus = 'partially_refunded';
  }
  await saveOrder(store, order);
  return revokedSubscriber;
}

export async function applyRefundResponse(store, config, order, refund, result) {
  refund.alipayStatus = result.fund_change === 'Y' ? 'FUND_CHANGED' : 'PENDING_CONFIRMATION';
  refund.lastSyncedAt = new Date().toISOString();
  if (result.fund_change === 'Y') {
    refund.status = 'succeeded';
    refund.completedAt = new Date().toISOString();
  } else {
    refund.status = 'pending';
  }
  const subscriber = await finalizeRefund(store, config, order, refund);
  return {
    order,
    refund,
    subscriber,
    eventType: subscriber ? 'subscription.revoked' : null,
  };
}

export async function applyRefundQuery(store, config, order, refund, result) {
  refund.alipayStatus = String(result.refund_status || '');
  refund.lastSyncedAt = new Date().toISOString();
  if (result.refund_status === 'REFUND_SUCCESS') {
    refund.status = 'succeeded';
    refund.completedAt = refund.completedAt || new Date().toISOString();
  } else {
    refund.status = 'pending';
  }
  const subscriber = await finalizeRefund(store, config, order, refund);
  return {
    order,
    refund,
    subscriber,
    eventType: subscriber ? 'subscription.revoked' : null,
  };
}

export async function closeLocalOrder(store, order, tradeResult) {
  if (order.paymentStatus === 'paid' || order.paymentStatus === 'partially_refunded' || order.paymentStatus === 'refunded') {
    throw new AppError(409, 'PAID_ORDER_CANNOT_CLOSE', '已支付订单不能关单。');
  }
  order.paymentStatus = 'closed';
  order.alipay = Object.assign({}, order.alipay, {
    tradeNo: String(tradeResult.trade_no || order.alipay?.tradeNo || ''),
    tradeStatus: 'TRADE_CLOSED',
    lastSyncedAt: new Date().toISOString(),
    source: 'admin_close',
  });
  await saveOrder(store, order);
  return order;
}

export async function adjustSubscriberExpiry(store, config, subscriber, input) {
  const target = new Date(input.expiresAt);
  if (Number.isNaN(target.getTime())) throw new AppError(400, 'INVALID_EXPIRY', '新的到期时间无效。');
  const reason = sanitizeText(input.reason, 200);
  if (!reason) throw new AppError(400, 'ADJUST_REASON_REQUIRED', '请填写调整原因。');
  const adjustment = {
    id: randomId('ADJ_', 8),
    effectiveAt: new Date().toISOString(),
    targetExpiresAt: target.toISOString(),
    reason,
  };
  subscriber.adjustments = Array.isArray(subscriber.adjustments) ? subscriber.adjustments : [];
  subscriber.adjustments.push(adjustment);
  recomputeSubscriber(subscriber);
  await store.putJson(subscriberKey(subscriber.id), subscriber);
  return { subscriber, adjustment, eventType: 'subscription.adjusted' };
}

export async function listOrders(store, config, options) {
  let ids = [];
  if (options.orderId) {
    ids = [options.orderId];
  } else if (options.tradeNo) {
    const mapping = await store.getJson('v2_trade_' + options.tradeNo);
    ids = mapping?.orderId ? [mapping.orderId] : [];
  } else if (options.contact) {
    const normalized = normalizeContact(options.contact);
    const subscriberId = subscriberIdFor(config, normalized);
    const subscriber = await store.getJson(subscriberKey(subscriberId));
    ids = (subscriber?.grants || []).map((grant) => grant.orderId);
    const rangeKeys = monthsForRange(options.from, options.to).flatMap((month) => (
      Array.from({ length: INDEX_SHARDS }, (_, shard) => orderIndexKey(month, shard))
    ));
    const pendingIds = await store.readIndex(rangeKeys);
    const pendingOrders = await store.getMany(pendingIds.map(orderKey));
    for (const order of pendingOrders) {
      if (order?.subscriberId === subscriberId) ids.push(order.id);
    }
    ids = [...new Set(ids)];
  } else {
    const keys = monthsForRange(options.from, options.to).flatMap((month) => (
      Array.from({ length: INDEX_SHARDS }, (_, shard) => orderIndexKey(month, shard))
    ));
    ids = await store.readIndex(keys);
  }

  const records = await store.getMany(ids.map(orderKey));
  const filtered = records.filter((order) => {
    if (!order) return false;
    const created = Date.parse(order.createdAt);
    if (created < options.from.getTime() || created >= options.to.getTime()) return false;
    if (options.status && order.paymentStatus !== options.status) return false;
    if (options.planId && order.planId !== options.planId) return false;
    return true;
  }).sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));

  const cursor = parseCursor(options.cursor);
  const pageSize = clampPageSize(options.limit, 30);
  const page = filtered.slice(cursor, cursor + pageSize);
  return {
    items: page.map((order) => adminOrder(order, config)),
    total: filtered.length,
    nextCursor: cursor + pageSize < filtered.length ? String(cursor + pageSize) : null,
  };
}

async function allSubscriberIds(store) {
  const keys = Array.from({ length: INDEX_SHARDS }, (_, shard) => subscriberIndexKey(shard));
  return store.readIndex(keys);
}

export async function listSubscribers(store, config, options = {}) {
  let ids;
  if (options.contact) {
    const normalized = normalizeContact(options.contact);
    ids = [subscriberIdFor(config, normalized)];
  } else {
    ids = await allSubscriberIds(store);
  }
  const records = await store.getMany(ids.map(subscriberKey));
  const views = records.filter(Boolean).map((record) => adminSubscriber(record, config))
    .filter((subscriber) => !options.status || subscriber.status === options.status)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const cursor = parseCursor(options.cursor);
  const pageSize = clampPageSize(options.limit, 30);
  return {
    items: views.slice(cursor, cursor + pageSize),
    total: views.length,
    nextCursor: cursor + pageSize < views.length ? String(cursor + pageSize) : null,
  };
}

export async function recordAudit(store, entry) {
  const createdAt = new Date().toISOString();
  const id = randomId('AUD_', 10);
  const record = {
    id,
    createdAt,
    actor: sanitizeText(entry.actor || 'admin', 40),
    action: sanitizeText(entry.action, 80),
    targetType: sanitizeText(entry.targetType, 40),
    targetId: sanitizeText(entry.targetId, 100),
    result: entry.result === 'failed' ? 'failed' : 'succeeded',
    requestId: sanitizeText(entry.requestId, 40),
    meta: safeMeta(entry.meta, entry.allowedMeta || []),
  };
  await store.putJson(auditKey(id), record);
  await store.appendIndex(auditIndexKey(monthKey(createdAt), shardFor(id)), id);
  return record;
}

export async function listAudit(store, options) {
  const keys = monthsForRange(options.from, options.to).flatMap((month) => (
    Array.from({ length: INDEX_SHARDS }, (_, shard) => auditIndexKey(month, shard))
  ));
  const ids = await store.readIndex(keys);
  const records = (await store.getMany(ids.map(auditKey))).filter(Boolean)
    .filter((record) => {
      const created = Date.parse(record.createdAt);
      if (created < options.from.getTime() || created >= options.to.getTime()) return false;
      if (options.action && record.action !== options.action) return false;
      return true;
    })
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  const cursor = parseCursor(options.cursor);
  const pageSize = clampPageSize(options.limit, 50);
  return {
    items: records.slice(cursor, cursor + pageSize),
    total: records.length,
    nextCursor: cursor + pageSize < records.length ? String(cursor + pageSize) : null,
  };
}

export async function dashboardStats(store, config, from, to) {
  const orderResult = await listOrders(store, config, { from, to, limit: 100, cursor: 0 });
  const keys = monthsForRange(from, to).flatMap((month) => (
    Array.from({ length: INDEX_SHARDS }, (_, shard) => orderIndexKey(month, shard))
  ));
  const allIds = await store.readIndex(keys);
  const allOrders = (await store.getMany(allIds.map(orderKey))).filter(Boolean)
    .filter((order) => Date.parse(order.createdAt) >= from.getTime() && Date.parse(order.createdAt) < to.getTime());
  const subscriberIds = await allSubscriberIds(store);
  const subscribers = (await store.getMany(subscriberIds.map(subscriberKey))).filter(Boolean);
  const active = subscribers.filter((item) => subscriberStatus(item.expiresAt) === 'active').length;
  const expiring = subscribers.filter((item) => subscriberStatus(item.expiresAt) === 'expiring').length;
  const paid = allOrders.filter((order) => ['paid', 'partially_refunded', 'refunded'].includes(order.paymentStatus));
  const paidFen = paid.reduce((sum, order) => sum + order.amountFen, 0);
  const refundedFen = allOrders.reduce((sum, order) => sum + (order.refunds || [])
    .filter((refund) => refund.status === 'succeeded')
    .reduce((subtotal, refund) => subtotal + refund.amountFen, 0), 0);
  return {
    metrics: {
      orders: allOrders.length,
      grossFen: Math.max(0, paidFen - refundedFen),
      refundedFen,
      pending: allOrders.filter((order) => order.paymentStatus === 'pending').length,
      activeSubscriptions: active + expiring,
      expiringSubscriptions: expiring,
    },
    recentOrders: orderResult.items.slice(0, 8),
  };
}