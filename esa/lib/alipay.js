import {
  AppError,
  alipayPublicKeyPem,
  amountToFen,
  buildSignContent,
  fenToAmount,
  formatAlipayTimestamp,
  privateKeyPem,
  requirePaymentConfig,
  rsaSign,
  rsaVerify,
  SUCCESS_TRADE_STATUSES,
} from './core.js';

const RESPONSE_KEYS = Object.freeze({
  'alipay.trade.query': 'alipay_trade_query_response',
  'alipay.trade.refund': 'alipay_trade_refund_response',
  'alipay.trade.fastpay.refund.query': 'alipay_trade_fastpay_refund_query_response',
  'alipay.trade.close': 'alipay_trade_close_response',
  'alipay.data.dataservice.bill.downloadurl.query': 'alipay_data_dataservice_bill_downloadurl_query_response',
});

export function extractRawResponseObject(raw, responseKey) {
  const marker = '"' + responseKey + '"';
  const markerIndex = raw.indexOf(marker);
  if (markerIndex < 0) throw new AppError(502, 'ALIPAY_RESPONSE_INVALID', '支付宝返回内容格式不正确。');
  let cursor = markerIndex + marker.length;
  while (/\s/.test(raw[cursor] || '')) cursor += 1;
  if (raw[cursor] !== ':') throw new AppError(502, 'ALIPAY_RESPONSE_INVALID', '支付宝返回内容格式不正确。');
  cursor += 1;
  while (/\s/.test(raw[cursor] || '')) cursor += 1;
  if (raw[cursor] !== '{') throw new AppError(502, 'ALIPAY_RESPONSE_INVALID', '支付宝返回内容格式不正确。');

  const start = cursor;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (; cursor < raw.length; cursor += 1) {
    const character = raw[cursor];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) return raw.slice(start, cursor + 1);
    }
  }
  throw new AppError(502, 'ALIPAY_RESPONSE_INVALID', '支付宝返回内容格式不正确。');
}

export function verifyAlipayResponse(raw, config, responseKey) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new AppError(502, 'ALIPAY_RESPONSE_INVALID', '支付宝返回内容格式不正确。');
  }
  const result = payload[responseKey];
  if (!result || typeof result !== 'object' || !payload.sign) {
    throw new AppError(502, 'ALIPAY_RESPONSE_UNSIGNED', '支付宝返回内容未通过签名校验。');
  }
  const signContent = extractRawResponseObject(raw, responseKey);
  if (!rsaVerify(signContent, payload.sign, alipayPublicKeyPem(config))) {
    throw new AppError(502, 'ALIPAY_RESPONSE_SIGNATURE_INVALID', '支付宝返回内容未通过签名校验。');
  }
  return result;
}

function apiParams(config, method, bizContent) {
  const params = {
    app_id: config.appId,
    method,
    format: 'JSON',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: formatAlipayTimestamp(),
    version: '1.0',
    biz_content: JSON.stringify(bizContent),
  };
  return Object.assign({}, params, {
    sign: rsaSign(buildSignContent(params), privateKeyPem(config)),
  });
}

export async function callAlipay(config, method, bizContent, options = {}) {
  requirePaymentConfig(config);
  const responseKey = RESPONSE_KEYS[method];
  if (!responseKey) throw new AppError(500, 'ALIPAY_METHOD_UNSUPPORTED', '支付接口尚未实现。');
  const response = await fetch(config.gateway, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: new URLSearchParams(apiParams(config, method, bizContent)).toString(),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new AppError(502, 'ALIPAY_HTTP_ERROR', '支付宝接口暂时不可用。');
  }
  const result = verifyAlipayResponse(raw, config, responseKey);
  if (result.code !== '10000' && options.allowBusinessFailure !== true) {
    throw new AppError(502, 'ALIPAY_BUSINESS_ERROR', '支付宝未能完成本次操作。', {
      subCode: String(result.sub_code || result.code || 'UNKNOWN').slice(0, 80),
    });
  }
  return result;
}

function cleanSubject(value) {
  const cleaned = String(value || 'NEye 订阅服务')
    .replace(/[\/,=&]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 128);
  return cleaned || 'NEye 订阅服务';
}

export function buildPaymentFields(config, order) {
  requirePaymentConfig(config);
  const params = {
    app_id: config.appId,
    method: 'alipay.trade.page.pay',
    format: 'JSON',
    return_url: config.returnUrl,
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: formatAlipayTimestamp(),
    version: '1.0',
    notify_url: config.notifyUrl,
    biz_content: JSON.stringify({
      out_trade_no: order.id,
      product_code: 'FAST_INSTANT_TRADE_PAY',
      total_amount: fenToAmount(order.amountFen),
      subject: cleanSubject(order.planSnapshot.subject || order.planSnapshot.name),
      body: 'NEye 订阅服务',
      time_expire: formatAlipayTimestamp(new Date(order.expiresAt)),
    }),
  };
  if (!config.notifyUrl) delete params.notify_url;
  if (!config.returnUrl) delete params.return_url;
  return Object.assign({}, params, {
    sign: rsaSign(buildSignContent(params), privateKeyPem(config)),
  });
}

export async function queryTrade(config, order) {
  const result = await callAlipay(config, 'alipay.trade.query', {
    out_trade_no: order.id,
  }, { allowBusinessFailure: true });
  if (result.code !== '10000') {
    const notFound = ['ACQ.TRADE_NOT_EXIST', 'ACQ.TRADE_STATUS_ERROR'].includes(result.sub_code);
    if (notFound) return { found: false, result };
    throw new AppError(502, 'ALIPAY_QUERY_FAILED', '支付宝订单状态查询失败。', {
      subCode: String(result.sub_code || result.code || 'UNKNOWN').slice(0, 80),
    });
  }
  validateTradeResult(order, result);
  return { found: true, result };
}

export function validateTradeResult(order, result) {
  if (String(result.out_trade_no || '') !== order.id) {
    throw new AppError(502, 'ALIPAY_ORDER_MISMATCH', '支付宝订单信息不一致。');
  }
  if (amountToFen(result.total_amount) !== order.amountFen) {
    throw new AppError(502, 'ALIPAY_AMOUNT_MISMATCH', '支付宝订单金额不一致。');
  }
  const seller = String(result.seller_user_id || result.seller_id || '');
  if (seller && order.expectedSellerId && seller !== order.expectedSellerId) {
    throw new AppError(502, 'ALIPAY_SELLER_MISMATCH', '支付宝商户信息不一致。');
  }
}

export async function refundTrade(config, order, refund) {
  return callAlipay(config, 'alipay.trade.refund', {
    out_trade_no: order.id,
    refund_amount: fenToAmount(refund.amountFen),
    refund_reason: refund.reason,
    out_request_no: refund.id,
  });
}

export async function queryRefund(config, order, refund) {
  const result = await callAlipay(config, 'alipay.trade.fastpay.refund.query', {
    out_trade_no: order.id,
    out_request_no: refund.id,
  });
  if (String(result.out_trade_no || '') !== order.id || String(result.out_request_no || '') !== refund.id) {
    throw new AppError(502, 'ALIPAY_REFUND_MISMATCH', '支付宝退款信息不一致。');
  }
  if (result.refund_amount && amountToFen(result.refund_amount) !== refund.amountFen) {
    throw new AppError(502, 'ALIPAY_REFUND_AMOUNT_MISMATCH', '支付宝退款金额不一致。');
  }
  return result;
}

export async function closeTrade(config, order) {
  const result = await callAlipay(config, 'alipay.trade.close', {
    out_trade_no: order.id,
  });
  if (result.out_trade_no && String(result.out_trade_no) !== order.id) {
    throw new AppError(502, 'ALIPAY_ORDER_MISMATCH', '支付宝订单信息不一致。');
  }
  return result;
}

export async function getBillDownload(config, date) {
  const result = await callAlipay(config, 'alipay.data.dataservice.bill.downloadurl.query', {
    bill_type: 'trade',
    bill_date: date,
  });
  if (!result.bill_download_url) {
    throw new AppError(404, 'ALIPAY_BILL_EMPTY', '该日期暂无可下载的支付宝账单。');
  }
  const downloadUrl = new URL(result.bill_download_url);
  const hostname = downloadUrl.hostname.toLowerCase();
  const allowed = hostname === 'alipay.com'
    || hostname.endsWith('.alipay.com')
    || hostname.endsWith('.alipaydev.com')
    || hostname.endsWith('.alipayobjects.com');
  if (!allowed || !['http:', 'https:'].includes(downloadUrl.protocol)) {
    throw new AppError(502, 'ALIPAY_BILL_URL_INVALID', '支付宝账单下载地址不安全。');
  }
  return { url: downloadUrl.toString(), fileCode: result.bill_file_code || '' };
}

export function verifyNotifyParams(params, config) {
  if (!params.sign || params.sign_type !== 'RSA2') return false;
  const publicKey = alipayPublicKeyPem(config);
  if (rsaVerify(buildSignContent(params), params.sign, publicKey)) return true;
  return rsaVerify(
    buildSignContent(params, { excludeSignType: true }),
    params.sign,
    publicKey,
  );
}

export function expectedSellerMatches(config, params) {
  if (config.sellerId) return params.seller_id === config.sellerId;
  if (config.sellerEmail) return params.seller_email === config.sellerEmail;
  return false;
}

export function classifyNotify(params) {
  if (params.out_biz_no && (params.gmt_refund || params.refund_fee)) return 'refund';
  if (params.trade_status === 'TRADE_CLOSED' && (params.gmt_close || params.refund_fee === '0.00' || params.refund_fee === '0')) {
    return 'close';
  }
  if (SUCCESS_TRADE_STATUSES.includes(params.trade_status)
    && !params.out_biz_no
    && !params.gmt_refund
    && !params.refund_fee) {
    return 'payment';
  }
  return 'other';
}

export function parseFormBody(body) {
  const values = {};
  for (const [key, value] of new URLSearchParams(body)) values[key] = value;
  return values;
}