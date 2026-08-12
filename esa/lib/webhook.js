import { createHmac } from 'node:crypto';
import {
  AppError,
  decryptJson,
  encryptJson,
  INDEX_SHARDS,
  monthKey,
  monthsForRange,
  parseCursor,
  randomId,
  shardFor,
  sha256,
  clampPageSize,
} from './core.js';

function eventKey(id) {
  return 'v2_webhook_' + id;
}

function eventIndexKey(month, shard) {
  return 'v2_idx_webhooks_' + month + '_' + shard.toString(16);
}

function eventIdFor(type, order, extra) {
  const anchor = extra?.adjustmentId || extra?.refundId || order?.id || randomId('', 8);
  return 'WH_' + sha256(type + ':' + anchor).slice(0, 24).toUpperCase();
}

function publicEvent(record) {
  return {
    id: record.id,
    type: record.type,
    orderId: record.orderId,
    subscriberId: record.subscriberId,
    status: record.status,
    attempts: record.attempts,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    deliveredAt: record.deliveredAt,
    lastError: record.lastError,
  };
}

async function sendRecord(store, config, record) {
  if (!config.webhookUrl || !config.webhookSecret) return record;
  const payload = decryptJson(record.payloadCipher, config.adminDataKey, 'webhook:' + record.id);
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', config.webhookSecret)
    .update(timestamp + '.' + body, 'utf8')
    .digest('hex');

  record.attempts += 1;
  record.updatedAt = new Date().toISOString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(config.webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'x-neye-event-id': record.id,
        'x-neye-timestamp': timestamp,
        'x-neye-signature': 'sha256=' + signature,
      },
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      record.status = 'failed';
      record.lastError = 'HTTP_' + response.status;
    } else {
      record.status = 'delivered';
      record.lastError = '';
      record.deliveredAt = new Date().toISOString();
    }
  } catch (error) {
    record.status = 'failed';
    record.lastError = error?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR';
  } finally {
    clearTimeout(timeout);
  }
  await store.putJson(eventKey(record.id), record);
  return record;
}

export async function emitSubscriptionEvent(store, config, input) {
  if (!config.webhookUrl || !config.webhookSecret) return { enabled: false };
  const id = eventIdFor(input.type, input.order, input.extra);
  const existing = await store.getJson(eventKey(id));
  if (existing) return { enabled: true, event: publicEvent(existing), duplicate: true };

  const privateData = decryptJson(
    input.subscriber.privateCipher,
    config.adminDataKey,
    'subscriber:' + input.subscriber.id,
  );
  const payload = {
    eventId: id,
    type: input.type,
    occurredAt: new Date().toISOString(),
    subscriber: {
      id: input.subscriber.id,
      contactName: privateData.contactName,
      contact: privateData.contact,
      expiresAt: input.subscriber.expiresAt,
      status: input.subscriber.status,
    },
    order: input.order ? {
      id: input.order.id,
      amountFen: input.order.amountFen,
      paidAt: input.order.paidAt,
    } : null,
    plan: input.order ? input.order.planSnapshot : null,
    context: input.extra || {},
  };
  const createdAt = payload.occurredAt;
  const record = {
    id,
    type: input.type,
    orderId: input.order?.id || '',
    subscriberId: input.subscriber.id,
    status: 'pending',
    attempts: 0,
    createdAt,
    updatedAt: createdAt,
    deliveredAt: null,
    lastError: '',
    payloadCipher: encryptJson(payload, config.adminDataKey, 'webhook:' + id),
  };
  await store.putJson(eventKey(id), record);
  await store.appendIndex(eventIndexKey(monthKey(createdAt), shardFor(id)), id);
  const delivered = await sendRecord(store, config, record);
  return { enabled: true, event: publicEvent(delivered), duplicate: false };
}

export async function retryWebhook(store, config, id) {
  if (!config.webhookUrl || !config.webhookSecret) {
    throw new AppError(409, 'WEBHOOK_DISABLED', '订阅 Webhook 尚未配置。');
  }
  if (!/^WH_[A-F0-9]{24}$/.test(String(id || ''))) {
    throw new AppError(400, 'INVALID_WEBHOOK_ID', 'Webhook 事件标识无效。');
  }
  const record = await store.getJson(eventKey(id));
  if (!record) throw new AppError(404, 'WEBHOOK_NOT_FOUND', 'Webhook 事件不存在。');
  if (record.status === 'delivered') return publicEvent(record);
  return publicEvent(await sendRecord(store, config, record));
}

export async function listWebhooks(store, options) {
  const keys = monthsForRange(options.from, options.to).flatMap((month) => (
    Array.from({ length: INDEX_SHARDS }, (_, shard) => eventIndexKey(month, shard))
  ));
  const ids = await store.readIndex(keys);
  const records = (await store.getMany(ids.map(eventKey))).filter(Boolean)
    .filter((record) => {
      const created = Date.parse(record.createdAt);
      if (created < options.from.getTime() || created >= options.to.getTime()) return false;
      if (options.status && record.status !== options.status) return false;
      return true;
    })
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  const cursor = parseCursor(options.cursor);
  const pageSize = clampPageSize(options.limit, 50);
  return {
    items: records.slice(cursor, cursor + pageSize).map(publicEvent),
    total: records.length,
    nextCursor: cursor + pageSize < records.length ? String(cursor + pageSize) : null,
  };
}