'use strict';

const state = {
  csrfToken: '',
  activeView: 'dashboard',
  setup: null,
  reset: null,
  orderCursor: null,
  subscriberCursor: null,
  orderRows: [],
  subscriberRows: [],
  paymentConfig: null,
  toastTimer: null,
};

const statusText = {
  pending: '待支付',
  paid: '已支付',
  partially_refunded: '部分退款',
  refunded: '已退款',
  closed: '已关闭',
  active: '有效',
  expiring: '即将到期',
  expired: '已过期',
  delivered: '已送达',
  succeeded: '成功',
  failed: '失败',
};

const checkText = {
  appId: '支付宝 APP ID',
  applicationPrivateKey: '应用私钥',
  alipayPublicKey: '支付宝公钥',
  sellerIdentity: '商户身份',
  returnUrl: '同步返回地址',
  notifyUrl: '异步通知地址',
  edgeKv: 'ESA Edge KV',
};

const viewTitles = {
  dashboard: '概览',
  orders: '订单',
  subscribers: '订阅用户',
  plans: '套餐设置',
  reconciliation: '对账与导出',
  health: '支付配置',
  webhooks: 'Webhook',
  audit: '审计日志',
};

function one(selector, root) {
  return (root || document).querySelector(selector);
}

function all(selector, root) {
  return Array.from((root || document).querySelectorAll(selector));
}

function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatMoney(fen) {
  const value = Number(fen);
  return Number.isFinite(value) ? '¥' + (value / 100).toFixed(2) : '—';
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date).replace(/\//g, '-');
}

function dateInputValue(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = {};
  parts.forEach(function (part) { values[part.type] = part.value; });
  return values.year + '-' + values.month + '-' + values.day;
}

function statusBadge(status) {
  const safe = String(status || 'unknown').replace(/[^a-z_]/g, '');
  return '<span class="status-badge ' + safe + '">' + escapeHtml(statusText[status] || status || '未知') + '</span>';
}

function shortId(value, start, end) {
  const text = String(value || '');
  const left = start || 10;
  const right = end || 6;
  return text.length > left + right + 3 ? text.slice(0, left) + '…' + text.slice(-right) : text;
}

function setMessage(element, message, error) {
  if (!element) return;
  element.textContent = message || '';
  element.classList.toggle('is-error', Boolean(error));
}

function toast(message, error) {
  const region = one('[data-toast]');
  clearTimeout(state.toastTimer);
  region.textContent = message;
  region.classList.toggle('is-error', Boolean(error));
  region.classList.add('is-visible');
  state.toastTimer = setTimeout(function () { region.classList.remove('is-visible'); }, 3600);
}

function errorMessage(error) {
  return error && error.message ? error.message : '操作未完成，请稍后重试。';
}

async function api(path, options) {
  const input = options || {};
  const method = input.method || 'GET';
  const headers = new Headers(input.headers || {});
  headers.set('Accept', 'application/json');
  if (method !== 'GET' && method !== 'HEAD' && state.csrfToken) {
    headers.set('X-CSRF-Token', state.csrfToken);
  }
  let body = input.body;
  if (body && typeof body !== 'string' && !(body instanceof FormData)) {
    headers.set('Content-Type', 'application/json; charset=utf-8');
    body = JSON.stringify(body);
  }
  const response = await fetch(path, {
    method: method,
    headers: headers,
    body: body,
    credentials: 'same-origin',
    cache: 'no-store',
  });
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json')
    ? await response.json().catch(function () { return null; })
    : null;
  if (!response.ok) {
    const details = payload && payload.error ? payload.error : {};
    const error = new Error(details.message || '请求失败。');
    error.code = details.code || 'REQUEST_FAILED';
    error.details = details.details || null;
    error.requestId = payload && payload.requestId ? payload.requestId : response.headers.get('x-request-id');
    error.status = response.status;
    if (response.status === 401 && input.allowAuthFailure !== true && !path.includes('/auth/')) {
      enterAuth('login');
      setMessage(one('[data-auth-message]'), '会话已失效，请重新验证。', true);
    }
    throw error;
  }
  return payload || {};
}

function buttonBusy(button, busy, label) {
  if (!button) return;
  if (busy) {
    button.dataset.originalLabel = button.textContent;
    button.textContent = label || '处理中…';
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalLabel || button.textContent;
    button.disabled = false;
    delete button.dataset.originalLabel;
  }
}

function showDialog(dialog) {
  if (dialog.open) return;
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

function closeDialog(dialog) {
  if (typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
}

function confirmAction(title, message, actionLabel) {
  const dialog = one('[data-confirm-dialog]');
  one('[data-confirm-title]', dialog).textContent = title;
  one('[data-confirm-message]', dialog).textContent = message;
  one('[data-confirm-action]', dialog).textContent = actionLabel || '确认';
  dialog.returnValue = '';
  showDialog(dialog);
  return new Promise(function (resolve) {
    dialog.addEventListener('close', function handleClose() {
      dialog.removeEventListener('close', handleClose);
      resolve(dialog.returnValue === 'confirm');
    });
  });
}

function enterAuth(view) {
  one('[data-admin-shell]').hidden = true;
  one('[data-auth-shell]').hidden = false;
  one('[data-auth-loading]').hidden = true;
  all('[data-auth-view]').forEach(function (panel) {
    panel.hidden = panel.dataset.authView !== view;
  });
  setMessage(one('[data-auth-message]'), '');
}

function enterAdmin(session) {
  if (session && session.csrfToken) state.csrfToken = session.csrfToken;
  one('[data-auth-shell]').hidden = true;
  one('[data-admin-shell]').hidden = false;
  switchView('dashboard');
}

function renderQr(target, uri) {
  target.replaceChildren();
  if (typeof window.qrcode !== 'function') {
    target.textContent = '二维码组件加载失败，请使用手动密钥绑定。';
    return;
  }
  const code = window.qrcode(0, 'M');
  code.addData(uri);
  code.make();
  target.innerHTML = code.createSvgTag(5, 0, 'TOTP 绑定二维码');
  const svg = target.querySelector('svg');
  if (svg) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'TOTP 绑定二维码');
  }
}

async function initializeAuth() {
  try {
    const payload = await api('/api/admin/auth/state', { allowAuthFailure: true });
    if (!payload.auth.configured) {
      enterAuth('setup');
      if (!payload.auth.setupAvailable) {
        setMessage(one('[data-auth-message]'), '请先在 ESA 配置后台安全环境变量。', true);
        one('[data-setup-start-form] button').disabled = true;
      }
      return;
    }
    try {
      const session = await api('/api/admin/session', { allowAuthFailure: true });
      enterAdmin(session.session);
    } catch {
      enterAuth('login');
    }
  } catch (error) {
    enterAuth('login');
    setMessage(one('[data-auth-message]'), errorMessage(error), true);
  }
}

function bindAuth() {
  one('[data-setup-start-form]').addEventListener('submit', async function (event) {
    event.preventDefault();
    const form = event.currentTarget;
    const button = one('button[type="submit"]', form);
    const token = new FormData(form).get('token');
    buttonBusy(button, true, '验证中…');
    try {
      const payload = await api('/api/admin/auth/setup/start', { method: 'POST', body: { token: token } });
      state.setup = { token: token, challengeId: payload.challenge.challengeId };
      one('[data-setup-secret]').textContent = payload.challenge.secret;
      renderQr(one('[data-setup-qr]'), payload.challenge.otpauthUri);
      one('[data-setup-confirm]').hidden = false;
      form.hidden = true;
      setMessage(one('[data-auth-message]'), '绑定信息将在 10 分钟后失效。');
      one('[data-setup-confirm-form] input[name="code"]').focus();
    } catch (error) {
      setMessage(one('[data-auth-message]'), errorMessage(error), true);
    } finally {
      buttonBusy(button, false);
    }
  });

  one('[data-setup-confirm-form]').addEventListener('submit', async function (event) {
    event.preventDefault();
    const form = event.currentTarget;
    const button = one('button[type="submit"]', form);
    if (!state.setup) return;
    buttonBusy(button, true, '确认中…');
    try {
      const payload = await api('/api/admin/auth/setup/confirm', {
        method: 'POST',
        body: {
          token: state.setup.token,
          challengeId: state.setup.challengeId,
          code: new FormData(form).get('code'),
        },
      });
      state.setup = null;
      form.reset();
      one('[data-setup-secret]').textContent = '';
      one('[data-setup-qr]').replaceChildren();
      one('[data-setup-confirm]').hidden = true;
      one('[data-setup-start-form]').reset();
      one('[data-setup-start-form]').hidden = false;
      enterAdmin(payload.session);
      toast('管理员验证器已绑定。');
    } catch (error) {
      setMessage(one('[data-auth-message]'), errorMessage(error), true);
    } finally {
      buttonBusy(button, false);
    }
  });

  one('[data-login-form]').addEventListener('submit', async function (event) {
    event.preventDefault();
    const form = event.currentTarget;
    const button = one('button[type="submit"]', form);
    buttonBusy(button, true, '验证中…');
    try {
      const payload = await api('/api/admin/auth/login', {
        method: 'POST',
        body: { code: new FormData(form).get('code') },
      });
      form.reset();
      enterAdmin(payload.session);
    } catch (error) {
      setMessage(one('[data-auth-message]'), errorMessage(error), true);
      one('input[name="code"]', form).select();
    } finally {
      buttonBusy(button, false);
    }
  });

  one('[data-reset-start-form]').addEventListener('submit', async function (event) {
    event.preventDefault();
    const form = event.currentTarget;
    const button = one('button[type="submit"]', form);
    const token = new FormData(form).get('token');
    buttonBusy(button, true, '验证中…');
    try {
      const payload = await api('/api/admin/auth/reset/start', { method: 'POST', body: { token: token } });
      state.reset = { token: token, challengeId: payload.challenge.challengeId };
      one('[data-reset-secret]').textContent = payload.challenge.secret;
      renderQr(one('[data-reset-qr]'), payload.challenge.otpauthUri);
      one('[data-reset-confirm]').hidden = false;
      form.hidden = true;
      setMessage(one('[data-auth-message]'), '请使用新验证器完成首次校验。');
    } catch (error) {
      setMessage(one('[data-auth-message]'), errorMessage(error), true);
    } finally {
      buttonBusy(button, false);
    }
  });

  one('[data-reset-confirm-form]').addEventListener('submit', async function (event) {
    event.preventDefault();
    const form = event.currentTarget;
    const button = one('button[type="submit"]', form);
    if (!state.reset) return;
    buttonBusy(button, true, '确认中…');
    try {
      const payload = await api('/api/admin/auth/reset/confirm', {
        method: 'POST',
        body: {
          token: state.reset.token,
          challengeId: state.reset.challengeId,
          code: new FormData(form).get('code'),
        },
      });
      state.reset = null;
      form.reset();
      one('[data-reset-secret]').textContent = '';
      one('[data-reset-qr]').replaceChildren();
      one('[data-reset-confirm]').hidden = true;
      one('[data-reset-start-form]').reset();
      one('[data-reset-start-form]').hidden = false;
      enterAdmin(payload.session);
      toast('验证器已重新绑定，旧会话已失效。');
    } catch (error) {
      setMessage(one('[data-auth-message]'), errorMessage(error), true);
    } finally {
      buttonBusy(button, false);
    }
  });

  one('[data-show-reset]').addEventListener('click', function () { enterAuth('reset'); });
  one('[data-show-login]').addEventListener('click', function () { enterAuth('login'); });
  one('[data-copy-secret]').addEventListener('click', async function () {
    try {
      await navigator.clipboard.writeText(one('[data-setup-secret]').textContent);
      setMessage(one('[data-auth-message]'), '密钥已复制。');
    } catch {
      setMessage(one('[data-auth-message]'), '无法自动复制，请手动选择密钥。', true);
    }
  });
}

async function logout() {
  try {
    await api('/api/admin/auth/logout', { method: 'POST', body: {} });
  } catch {
    // 页面仍会清除本地会话状态。
  }
  state.csrfToken = '';
  enterAuth('login');
}
function switchView(view) {
  state.activeView = view;
  all('[data-view-target]').forEach(function (button) {
    button.classList.toggle('is-active', button.dataset.viewTarget === view);
  });
  all('[data-view]').forEach(function (panel) {
    const active = panel.dataset.view === view;
    panel.hidden = !active;
    panel.classList.toggle('is-active', active);
  });
  one('[data-view-title]').textContent = viewTitles[view] || view;
  const loader = viewLoaders[view];
  if (loader) loader().catch(function (error) { toast(errorMessage(error), true); });
}

function queryFromForm(form, allowed) {
  const params = new URLSearchParams();
  const data = new FormData(form);
  allowed.forEach(function (key) {
    const value = String(data.get(key) || '').trim();
    if (value) params.set(key, value);
  });
  return params;
}

function renderHealthList(target, checks) {
  target.innerHTML = Object.keys(checks).map(function (key) {
    return '<div><span>' + escapeHtml(checkText[key] || key) + '</span>'
      + '<strong class="' + (checks[key] ? 'check-ready' : 'check-error') + '">'
      + (checks[key] ? '已配置' : '未配置') + '</strong></div>';
  }).join('');
}

async function loadDashboard() {
  const payload = await api('/api/admin/dashboard');
  const dashboard = payload.dashboard;
  Object.keys(dashboard.metrics).forEach(function (key) {
    const element = one('[data-metric="' + key + '"]');
    if (element) element.textContent = key.endsWith('Fen') ? formatMoney(dashboard.metrics[key]) : String(dashboard.metrics[key]);
  });
  const today = new Date();
  one('[data-dashboard-range]').textContent = dateInputValue(new Date(today.getTime() - 29 * 86400000))
    + ' — ' + dateInputValue(today);
  one('[data-dashboard-orders]').innerHTML = dashboard.recentOrders.map(function (order) {
    return '<tr>'
      + '<td><span class="mono">' + escapeHtml(shortId(order.id, 12, 5)) + '</span></td>'
      + '<td>' + escapeHtml(order.planSnapshot.name) + '</td>'
      + '<td>' + formatMoney(order.amountFen) + '</td>'
      + '<td>' + statusBadge(order.paymentStatus) + '</td>'
      + '<td>' + escapeHtml(formatDate(order.createdAt)) + '</td>'
      + '</tr>';
  }).join('');
  one('[data-dashboard-empty]').hidden = dashboard.recentOrders.length > 0;
  renderHealthList(one('[data-dashboard-health]'), payload.health.checks);
  one('[data-sidebar-environment]').textContent = payload.health.environment === 'production' ? '正式环境' : '沙箱环境';
}

function orderFilterParams() {
  const form = one('[data-order-filter]');
  const params = queryFromForm(form, ['from', 'to', 'status', 'plan']);
  const data = new FormData(form);
  const search = String(data.get('search') || '').trim();
  if (search) params.set(String(data.get('searchType') || 'orderId'), search);
  params.set('limit', '30');
  return params;
}

async function loadOrders(append) {
  const params = orderFilterParams();
  if (append && state.orderCursor) params.set('cursor', state.orderCursor);
  const payload = await api('/api/admin/orders?' + params.toString());
  const result = payload.orders;
  state.orderRows = append ? state.orderRows.concat(result.items) : result.items;
  state.orderCursor = result.nextCursor;
  one('[data-orders-body]').innerHTML = state.orderRows.map(function (order) {
    const contact = order.contact && order.contact.value ? order.contact.value : order.contactMasked;
    return '<tr>'
      + '<td><span class="mono">' + escapeHtml(order.id) + '</span><span class="cell-secondary">'
      + escapeHtml(order.alipayTradeNo || '暂无交易号') + '</span></td>'
      + '<td>' + escapeHtml(order.contactName) + '<span class="cell-secondary">' + escapeHtml(contact) + '</span></td>'
      + '<td>' + escapeHtml(order.planSnapshot.name) + '<span class="cell-secondary">v'
      + escapeHtml(order.planSnapshot.version) + '</span></td>'
      + '<td>' + formatMoney(order.amountFen) + '</td>'
      + '<td>' + statusBadge(order.paymentStatus) + '</td>'
      + '<td>' + escapeHtml(formatDate(order.createdAt)) + '</td>'
      + '<td><button class="row-action" type="button" data-open-order="' + escapeHtml(order.id) + '">详情</button></td>'
      + '</tr>';
  }).join('');
  one('[data-orders-empty]').hidden = state.orderRows.length > 0;
  one('[data-orders-total]').textContent = result.total + ' 条记录';
  one('[data-orders-more]').hidden = !state.orderCursor;
  one('[data-orders-more]').disabled = false;
}

function subscriberFilterParams() {
  const params = queryFromForm(one('[data-subscriber-filter]'), ['status', 'contact']);
  params.set('limit', '30');
  return params;
}

async function loadSubscribers(append) {
  const params = subscriberFilterParams();
  if (append && state.subscriberCursor) params.set('cursor', state.subscriberCursor);
  const payload = await api('/api/admin/subscribers?' + params.toString());
  const result = payload.subscribers;
  state.subscriberRows = append ? state.subscriberRows.concat(result.items) : result.items;
  state.subscriberCursor = result.nextCursor;
  one('[data-subscribers-body]').innerHTML = state.subscriberRows.map(function (subscriber) {
    const contact = subscriber.contact && subscriber.contact.value ? subscriber.contact.value : subscriber.contactMasked;
    return '<tr>'
      + '<td>' + escapeHtml(subscriber.contactName) + '<span class="cell-secondary mono">'
      + escapeHtml(shortId(subscriber.id, 10, 6)) + '</span></td>'
      + '<td>' + escapeHtml(contact) + '</td>'
      + '<td>' + statusBadge(subscriber.status) + '</td>'
      + '<td>' + escapeHtml(formatDate(subscriber.expiresAt)) + '</td>'
      + '<td>' + Number(subscriber.grants.length) + ' 笔购买 / ' + Number(subscriber.adjustments.length) + ' 次调整</td>'
      + '<td><button class="row-action" type="button" data-open-subscriber="' + escapeHtml(subscriber.id) + '">详情</button></td>'
      + '</tr>';
  }).join('');
  one('[data-subscribers-empty]').hidden = state.subscriberRows.length > 0;
  one('[data-subscribers-total]').textContent = result.total + ' 条记录';
  one('[data-subscribers-more]').hidden = !state.subscriberCursor;
  one('[data-subscribers-more]').disabled = false;
}

function planEditor(id) {
  return one('[data-plan-editor="' + id + '"]');
}

function fillPlan(editor, plan) {
  one('[name="name"]', editor).value = plan.name;
  one('[name="description"]', editor).value = plan.description;
  one('[name="price"]', editor).value = (plan.priceFen / 100).toFixed(2);
  one('[name="timeoutMinutes"]', editor).value = plan.timeoutMinutes;
  one('[name="enabled"]', editor).checked = plan.enabled;
  one('[name="recommended"]', editor).checked = plan.recommended;
  one('[data-plan-editor-version]', editor).textContent = 'v' + plan.version;
}

async function loadPlans() {
  const payload = await api('/api/admin/plans');
  const config = payload.planConfig;
  one('[data-plan-form] [name="salesEnabled"]').checked = config.salesEnabled;
  fillPlan(planEditor('monthly'), config.plans.monthly);
  fillPlan(planEditor('annual'), config.plans.annual);
  one('[data-plan-version]').textContent = '版本 ' + config.configVersion;
  one('[data-plan-updated]').textContent = config.updatedAt ? '更新于 ' + formatDate(config.updatedAt) : '使用默认配置';
}

function planPayload(id) {
  const editor = planEditor(id);
  const price = one('[name="price"]', editor).value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(price)) throw new Error('套餐价格最多保留两位小数。');
  const parts = price.split('.');
  return {
    id: id,
    name: one('[name="name"]', editor).value,
    description: one('[name="description"]', editor).value,
    priceFen: Number(parts[0]) * 100 + Number((parts[1] || '').padEnd(2, '0')),
    timeoutMinutes: Number(one('[name="timeoutMinutes"]', editor).value),
    enabled: one('[name="enabled"]', editor).checked,
    recommended: one('[name="recommended"]', editor).checked,
  };
}

function setSecretIndicator(stateSelector, fingerprintSelector, secret) {
  const status = one(stateSelector);
  status.textContent = secret && secret.configured ? '已配置' : '未配置';
  status.classList.toggle('is-ready', Boolean(secret && secret.configured));
  one(fingerprintSelector).textContent = secret && secret.fingerprint
    ? '指纹 ' + secret.fingerprint
    : '保存后仅显示指纹';
}

function updateWebhookFields() {
  const enabled = one('[data-webhook-enabled]').checked;
  const fields = one('[data-webhook-fields]');
  fields.classList.toggle('is-disabled', !enabled);
  all('input', fields).forEach(function (input) { input.disabled = !enabled; });
}

function updateCallbackPreview() {
  const input = one('[data-payment-config-form] [name="baseUrl"]');
  let base = String(input.value || '').trim().replace(/\/+$/, '');
  try {
    const url = new URL(base);
    if (url.protocol !== 'https:') throw new Error('invalid');
    base = url.origin;
  } catch {
    base = '';
  }
  one('[data-health-return]').textContent = base ? base + '/api/payment/return' : '等待填写官网地址';
  one('[data-health-notify]').textContent = base ? base + '/api/payment/notify' : '等待填写官网地址';
}

function renderPaymentConfig(payload) {
  const health = payload.health;
  const config = payload.paymentConfig;
  state.paymentConfig = config;
  const ready = one('[data-health-state]');
  ready.textContent = health.ready ? '配置完整' : '需要处理';
  ready.className = 'health-state ' + (health.ready ? 'is-ready' : 'is-error');
  one('[data-health-environment]').textContent = health.environment === 'production' ? '正式环境' : '沙箱环境';
  one('[data-health-app]').textContent = health.appIdMasked;
  one('[data-health-gateway]').textContent = health.gatewayHost || '未配置';
  one('[data-health-kv]').textContent = payload.storage.namespace;
  one('[data-health-return]').textContent = health.returnUrl || '未配置';
  one('[data-health-notify]').textContent = health.notifyUrl || '未配置';
  renderHealthList(one('[data-health-checks]'), health.checks);
  one('[data-sidebar-environment]').textContent = health.environment === 'production' ? '正式环境' : '沙箱环境';

  const form = one('[data-payment-config-form]');
  one('[name="paymentEnvironment"]', form).value = config.environment;
  one('[name="appId"]', form).value = config.appId || '';
  one('[name="sellerId"]', form).value = config.sellerId || '';
  one('[name="sellerEmail"]', form).value = config.sellerEmail || '';
  one('[name="baseUrl"]', form).value = config.baseUrl || '';
  one('[name="privatePkcsKey"]', form).value = '';
  one('[name="alipayPublicKey"]', form).value = '';
  one('[name="totpCode"]', form).value = '';
  one('[name="webhookEnabled"]', form).checked = config.webhookEnabled;
  one('[name="webhookUrl"]', form).value = config.webhookUrl || '';
  one('[name="webhookSecret"]', form).value = '';
  one('[data-payment-config-source]').textContent = config.source === 'admin'
    ? '后台加密配置'
    : 'ESA 环境变量';
  one('[data-payment-config-version]').textContent = config.version
    ? '版本 ' + config.version + ' · ' + formatDate(config.updatedAt)
    : '尚未保存到后台';
  setSecretIndicator(
    '[data-private-key-state]',
    '[data-private-key-fingerprint]',
    config.secrets.applicationPrivateKey
  );
  setSecretIndicator(
    '[data-public-key-state]',
    '[data-public-key-fingerprint]',
    config.secrets.alipayPublicKey
  );
  const webhookSecret = config.secrets.webhookSecret;
  one('[data-webhook-secret-state]').textContent = webhookSecret.configured
    ? '签名密钥已配置 · 指纹 ' + webhookSecret.fingerprint
    : '签名密钥未配置';
  updateWebhookFields();
  updateCallbackPreview();
}

async function loadHealth() {
  renderPaymentConfig(await api('/api/admin/payment-config'));
}

async function loadWebhooks() {
  const payload = await api('/api/admin/webhooks');
  const indicator = one('[data-webhook-state]');
  indicator.textContent = payload.enabled ? '已启用' : '未启用';
  indicator.className = 'health-state ' + (payload.enabled ? 'is-ready' : '');
  one('[data-webhooks-body]').innerHTML = payload.webhooks.items.map(function (event) {
    const retry = event.status === 'failed'
      ? '<button class="row-action" type="button" data-retry-webhook="' + escapeHtml(event.id) + '">重试</button>'
      : '';
    return '<tr>'
      + '<td><span class="mono">' + escapeHtml(event.id) + '</span><span class="cell-secondary">'
      + escapeHtml(event.lastError || '') + '</span></td>'
      + '<td>' + escapeHtml(event.type) + '</td>'
      + '<td><span class="mono">' + escapeHtml(event.orderId || '—') + '</span></td>'
      + '<td>' + statusBadge(event.status) + '</td>'
      + '<td>' + Number(event.attempts) + '</td>'
      + '<td>' + escapeHtml(formatDate(event.updatedAt)) + '</td>'
      + '<td>' + retry + '</td></tr>';
  }).join('');
  one('[data-webhooks-empty]').hidden = payload.webhooks.items.length > 0;
}

function auditParams() {
  const params = queryFromForm(one('[data-audit-filter]'), ['from', 'to', 'action']);
  params.set('limit', '50');
  return params;
}

async function loadAudit() {
  const payload = await api('/api/admin/audit?' + auditParams().toString());
  one('[data-audit-body]').innerHTML = payload.audit.items.map(function (entry) {
    return '<tr>'
      + '<td>' + escapeHtml(formatDate(entry.createdAt)) + '</td>'
      + '<td>' + escapeHtml(entry.actor) + '</td>'
      + '<td><span class="mono">' + escapeHtml(entry.action) + '</span></td>'
      + '<td>' + escapeHtml(entry.targetType) + '<span class="cell-secondary mono">'
      + escapeHtml(shortId(entry.targetId, 12, 6)) + '</span></td>'
      + '<td>' + statusBadge(entry.result) + '</td>'
      + '<td><span class="mono">' + escapeHtml(entry.requestId || '—') + '</span></td></tr>';
  }).join('');
  one('[data-audit-empty]').hidden = payload.audit.items.length > 0;
}
function orderDetailMarkup(order) {
  const contact = order.contact && order.contact.value ? order.contact.value : order.contactMasked;
  const succeeded = order.refunds.filter(function (refund) { return refund.status === 'succeeded'; })
    .reduce(function (sum, refund) { return sum + refund.amountFen; }, 0);
  const reserved = order.refunds.filter(function (refund) { return refund.status === 'pending'; })
    .reduce(function (sum, refund) { return sum + refund.amountFen; }, 0);
  const available = Math.max(0, order.amountFen - succeeded - reserved);
  const refunds = order.refunds.length ? order.refunds.map(function (refund) {
    const sync = refund.status === 'pending'
      ? '<button class="row-action" type="button" data-refund-sync="' + escapeHtml(refund.id) + '">查询结果</button>'
        + '<button class="row-action" type="button" data-refund-retry="' + escapeHtml(refund.id)
        + '" data-refund-amount="' + escapeHtml(refund.amountFen) + '" data-refund-reason="'
        + escapeHtml(refund.reason) + '">同单号重试</button>'
      : '';
    return '<article><div><strong>' + formatMoney(refund.amountFen) + ' · ' + escapeHtml(refund.reason) + '</strong>'
      + '<small>' + escapeHtml(refund.id) + ' · ' + escapeHtml(formatDate(refund.createdAt)) + '</small></div>'
      + '<div>' + statusBadge(refund.status) + sync + '</div></article>';
  }).join('') : '<article><div><strong>暂无退款记录</strong><small>退款提交后会显示在这里。</small></div></article>';

  let actions = '<button class="secondary-button" type="button" data-order-sync>同步支付宝状态</button>';
  if (order.paymentStatus === 'pending') {
    actions += '<button class="danger-button" type="button" data-order-close>关闭订单</button>';
  }
  let refundForm = '';
  if (['paid', 'partially_refunded'].includes(order.paymentStatus) && available > 0) {
    refundForm = '<form class="refund-form" data-refund-form>'
      + '<label><span>退款金额（元）</span><input name="amount" type="number" min="0.01" max="'
      + (available / 100).toFixed(2) + '" step="0.01" value="' + (available / 100).toFixed(2) + '" required /></label>'
      + '<label><span>退款原因</span><input name="reason" maxlength="200" required /></label>'
      + '<button class="danger-button compact" type="submit">提交退款</button></form>';
  }

  return '<dl class="detail-grid">'
    + '<div><dt>订单号</dt><dd class="mono">' + escapeHtml(order.id) + '</dd></div>'
    + '<div><dt>状态</dt><dd>' + statusBadge(order.paymentStatus) + '</dd></div>'
    + '<div><dt>套餐</dt><dd>' + escapeHtml(order.planSnapshot.name) + ' · v' + escapeHtml(order.planSnapshot.version) + '</dd></div>'
    + '<div><dt>订单金额</dt><dd>' + formatMoney(order.amountFen) + '</dd></div>'
    + '<div><dt>联系人</dt><dd>' + escapeHtml(order.contactName) + '</dd></div>'
    + '<div><dt>联系方式</dt><dd>' + escapeHtml(contact) + '</dd></div>'
    + '<div><dt>支付宝交易号</dt><dd class="mono">' + escapeHtml(order.alipayTradeNo || '—') + '</dd></div>'
    + '<div><dt>支付宝状态</dt><dd>' + escapeHtml(order.alipayTradeStatus || '—') + '</dd></div>'
    + '<div><dt>创建时间</dt><dd>' + escapeHtml(formatDate(order.createdAt)) + '</dd></div>'
    + '<div><dt>支付时间</dt><dd>' + escapeHtml(formatDate(order.paidAt)) + '</dd></div>'
    + '<div><dt>订单失效时间</dt><dd>' + escapeHtml(formatDate(order.expiresAt)) + '</dd></div>'
    + '<div><dt>最近同步</dt><dd>' + escapeHtml(formatDate(order.lastSyncedAt)) + '</dd></div>'
    + '<div><dt>备注</dt><dd>' + escapeHtml(order.note || '—') + '</dd></div>'
    + '<div><dt>订阅用户标识</dt><dd class="mono">' + escapeHtml(shortId(order.subscriberId, 14, 8)) + '</dd></div>'
    + '</dl><div class="detail-actions">' + actions + '</div>'
    + '<section class="detail-section"><h3>退款记录</h3>' + refundForm
    + '<div class="timeline-list">' + refunds + '</div></section>';
}

async function openOrder(id) {
  const payload = await api('/api/admin/orders/' + encodeURIComponent(id));
  const dialog = one('[data-order-dialog]');
  dialog.dataset.orderId = id;
  one('[data-order-dialog-title]').textContent = '订单 ' + shortId(id, 16, 6);
  one('[data-order-detail]').innerHTML = orderDetailMarkup(payload.order);
  showDialog(dialog);
}

function subscriberDetailMarkup(subscriber) {
  const contact = subscriber.contact && subscriber.contact.value ? subscriber.contact.value : subscriber.contactMasked;
  const grants = subscriber.grants.length ? subscriber.grants.map(function (grant) {
    const revoked = grant.revokedAt ? ' · 已撤销' : '';
    return '<article><div><strong>' + escapeHtml(grant.planId) + ' · ' + escapeHtml(grant.orderId) + '</strong>'
      + '<small>支付于 ' + escapeHtml(formatDate(grant.paidAt)) + revoked + '</small></div><div>'
      + (grant.revokedAt ? statusBadge('refunded') : statusBadge('succeeded')) + '</div></article>';
  }).join('') : '<article><div><strong>暂无购买权益</strong></div></article>';
  const adjustments = subscriber.adjustments.length ? subscriber.adjustments.map(function (adjustment) {
    return '<article><div><strong>到期时间调整为 ' + escapeHtml(formatDate(adjustment.targetExpiresAt)) + '</strong>'
      + '<small>' + escapeHtml(adjustment.reason) + ' · ' + escapeHtml(formatDate(adjustment.effectiveAt))
      + '</small></div></article>';
  }).join('') : '<article><div><strong>暂无人工调整</strong></div></article>';
  const orders = (subscriber.orders || []).map(function (order) {
    return '<button class="row-action" type="button" data-open-order="' + escapeHtml(order.id) + '">'
      + escapeHtml(shortId(order.id, 14, 6)) + '</button>';
  }).join(' ');

  return '<dl class="detail-grid">'
    + '<div><dt>订阅用户</dt><dd>' + escapeHtml(subscriber.contactName) + '</dd></div>'
    + '<div><dt>状态</dt><dd>' + statusBadge(subscriber.status) + '</dd></div>'
    + '<div><dt>联系方式</dt><dd>' + escapeHtml(contact) + '</dd></div>'
    + '<div><dt>到期时间</dt><dd>' + escapeHtml(formatDate(subscriber.expiresAt)) + '</dd></div>'
    + '<div><dt>用户标识</dt><dd class="mono">' + escapeHtml(subscriber.id) + '</dd></div>'
    + '<div><dt>最近更新</dt><dd>' + escapeHtml(formatDate(subscriber.updatedAt)) + '</dd></div>'
    + '</dl><section class="detail-section"><h3>调整到期时间</h3>'
    + '<form class="adjust-form" data-adjust-form>'
    + '<label><span>新的到期时间</span><input name="expiresAt" type="datetime-local" required /></label>'
    + '<label><span>调整原因</span><input name="reason" maxlength="200" required /></label>'
    + '<button class="danger-button compact" type="submit">确认调整</button></form></section>'
    + '<section class="detail-section"><h3>购买权益</h3><div class="timeline-list">' + grants + '</div></section>'
    + '<section class="detail-section"><h3>人工调整</h3><div class="timeline-list">' + adjustments + '</div></section>'
    + '<section class="detail-section"><h3>相关订单</h3><div class="detail-actions">'
    + (orders || '暂无相关订单') + '</div></section>';
}

async function openSubscriber(id) {
  const payload = await api('/api/admin/subscribers/' + encodeURIComponent(id));
  const dialog = one('[data-subscriber-dialog]');
  dialog.dataset.subscriberId = id;
  one('[data-subscriber-dialog-title]').textContent = payload.subscriber.contactName;
  one('[data-subscriber-detail]').innerHTML = subscriberDetailMarkup(payload.subscriber);
  showDialog(dialog);
}

async function refreshAfterOrder() {
  await Promise.all([loadOrders(false), loadDashboard()]);
}

async function downloadFile(path, fallbackName) {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) {
    let message = '文件下载失败。';
    try {
      const payload = await response.json();
      if (payload.error && payload.error.message) message = payload.error.message;
    } catch {
      // 保留通用错误。
    }
    throw new Error(message);
  }
  const blob = await response.blob();
  const disposition = response.headers.get('content-disposition') || '';
  const match = disposition.match(/filename="?([^";]+)"?/i);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = match ? match[1] : fallbackName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}

const viewLoaders = {
  dashboard: loadDashboard,
  orders: function () { return loadOrders(false); },
  subscribers: function () { return loadSubscribers(false); },
  plans: loadPlans,
  health: loadHealth,
  webhooks: loadWebhooks,
  audit: loadAudit,
};
function bindAdmin() {
  all('[data-view-target]').forEach(function (button) {
    button.addEventListener('click', function () { switchView(button.dataset.viewTarget); });
  });
  one('[data-refresh]').addEventListener('click', function (event) {
    const loader = viewLoaders[state.activeView];
    if (!loader) return;
    const button = event.currentTarget;
    buttonBusy(button, true, '刷新中…');
    loader().then(function () {
      toast('数据已刷新。');
    }).catch(function (error) {
      toast(errorMessage(error), true);
    }).finally(function () {
      buttonBusy(button, false);
    });
  });
  one('[data-logout]').addEventListener('click', logout);
  one('[data-go-orders]').addEventListener('click', function () { switchView('orders'); });
  one('[data-go-health]').addEventListener('click', function () { switchView('health'); });

  one('[data-order-filter]').addEventListener('submit', function (event) {
    event.preventDefault();
    loadOrders(false).catch(function (error) { toast(errorMessage(error), true); });
  });
  one('[data-orders-more]').addEventListener('click', function (event) {
    event.currentTarget.disabled = true;
    loadOrders(true).catch(function (error) {
      event.currentTarget.disabled = false;
      toast(errorMessage(error), true);
    });
  });
  one('[data-orders-body]').addEventListener('click', function (event) {
    const button = event.target.closest('[data-open-order]');
    if (button) openOrder(button.dataset.openOrder).catch(function (error) { toast(errorMessage(error), true); });
  });

  one('[data-subscriber-filter]').addEventListener('submit', function (event) {
    event.preventDefault();
    loadSubscribers(false).catch(function (error) { toast(errorMessage(error), true); });
  });
  one('[data-subscribers-more]').addEventListener('click', function (event) {
    event.currentTarget.disabled = true;
    loadSubscribers(true).catch(function (error) {
      event.currentTarget.disabled = false;
      toast(errorMessage(error), true);
    });
  });
  one('[data-subscribers-body]').addEventListener('click', function (event) {
    const button = event.target.closest('[data-open-subscriber]');
    if (button) openSubscriber(button.dataset.openSubscriber).catch(function (error) { toast(errorMessage(error), true); });
  });

  one('[data-plan-form]').addEventListener('submit', async function (event) {
    event.preventDefault();
    const button = one('button[type="submit"]', event.currentTarget);
    try {
      const plans = [planPayload('monthly'), planPayload('annual')];
      const proceed = await confirmAction(
        '保存套餐设置',
        '新价格只会用于之后创建的订单，历史订单仍保留原价格。',
        '保存设置'
      );
      if (!proceed) return;
      buttonBusy(button, true, '保存中…');
      await api('/api/admin/plans', {
        method: 'PUT',
        body: {
          salesEnabled: one('[name="salesEnabled"]', event.currentTarget).checked,
          plans: plans,
        },
      });
      await loadPlans();
      toast('套餐设置已保存。');
    } catch (error) {
      toast(errorMessage(error), true);
    } finally {
      buttonBusy(button, false);
    }
  });
  all('[data-plan-editor] [name="recommended"]').forEach(function (checkbox) {
    checkbox.addEventListener('change', function () {
      if (!checkbox.checked) return;
      all('[data-plan-editor] [name="recommended"]').forEach(function (other) {
        if (other !== checkbox) other.checked = false;
      });
    });
  });

  const paymentForm = one('[data-payment-config-form]');
  one('[name="baseUrl"]', paymentForm).addEventListener('input', updateCallbackPreview);
  one('[data-webhook-enabled]', paymentForm).addEventListener('change', updateWebhookFields);
  paymentForm.addEventListener('submit', async function (event) {
    event.preventDefault();
    const button = one('button[type="submit"]', paymentForm);
    const privatePkcsKey = one('[name="privatePkcsKey"]', paymentForm).value.trim();
    const alipayPublicKey = one('[name="alipayPublicKey"]', paymentForm).value.trim();
    const webhookSecret = one('[name="webhookSecret"]', paymentForm).value.trim();
    const environment = one('[name="paymentEnvironment"]', paymentForm).value;
    const replacements = [privatePkcsKey, alipayPublicKey, webhookSecret].filter(Boolean).length;
    const message = environment === 'production'
      ? '将启用正式支付宝网关。请确认 APP ID、商户身份和密钥属于同一个正式应用。'
      : replacements
        ? '将更新沙箱配置，并替换本次填写的密钥。未填写的密钥保持不变。'
        : '将更新沙箱配置，现有密钥保持不变。';
    try {
      const proceed = await confirmAction('保存支付配置', message, '确认保存');
      if (!proceed) return;
      buttonBusy(button, true, '加密保存中…');
      const body = {
        paymentEnvironment: environment,
        appId: one('[name="appId"]', paymentForm).value.trim(),
        sellerId: one('[name="sellerId"]', paymentForm).value.trim(),
        sellerEmail: one('[name="sellerEmail"]', paymentForm).value.trim(),
        baseUrl: one('[name="baseUrl"]', paymentForm).value.trim(),
        webhookEnabled: one('[name="webhookEnabled"]', paymentForm).checked,
        webhookUrl: one('[name="webhookUrl"]', paymentForm).value.trim(),
        totpCode: one('[name="totpCode"]', paymentForm).value.trim(),
      };
      if (privatePkcsKey) body.privatePkcsKey = privatePkcsKey;
      if (alipayPublicKey) body.alipayPublicKey = alipayPublicKey;
      if (webhookSecret) body.webhookSecret = webhookSecret;
      const payload = await api('/api/admin/payment-config', { method: 'PUT', body: body });
      renderPaymentConfig(payload);
      toast('支付配置已加密保存。');
    } catch (error) {
      toast(errorMessage(error), true);
      one('[name="totpCode"]', paymentForm).value = '';
      one('[name="totpCode"]', paymentForm).focus();
    } finally {
      buttonBusy(button, false);
    }
  });

  one('[data-audit-filter]').addEventListener('submit', function (event) {
    event.preventDefault();
    loadAudit().catch(function (error) { toast(errorMessage(error), true); });
  });
  one('[data-webhooks-body]').addEventListener('click', async function (event) {
    const button = event.target.closest('[data-retry-webhook]');
    if (!button) return;
    buttonBusy(button, true, '重试中…');
    try {
      await api('/api/admin/webhooks/' + encodeURIComponent(button.dataset.retryWebhook) + '/retry', {
        method: 'POST',
        body: {},
      });
      await loadWebhooks();
      toast('Webhook 已重新发送。');
    } catch (error) {
      toast(errorMessage(error), true);
    } finally {
      buttonBusy(button, false);
    }
  });

  one('[data-bill-form]').addEventListener('submit', async function (event) {
    event.preventDefault();
    const button = one('button[type="submit"]', event.currentTarget);
    buttonBusy(button, true, '获取中…');
    try {
      const date = new FormData(event.currentTarget).get('date');
      await downloadFile('/api/admin/bills/download?date=' + encodeURIComponent(date), 'alipay-trade-' + date + '.zip');
      toast('账单下载已开始。');
    } catch (error) {
      toast(errorMessage(error), true);
    } finally {
      buttonBusy(button, false);
    }
  });

  one('[data-export-form]').addEventListener('submit', async function (event) {
    event.preventDefault();
    const button = one('button[type="submit"]', event.currentTarget);
    buttonBusy(button, true, '导出中…');
    try {
      const params = queryFromForm(event.currentTarget, ['from', 'to']);
      await downloadFile('/api/admin/orders/export?' + params.toString(), 'neye-orders.csv');
      toast('订单导出已开始。');
    } catch (error) {
      toast(errorMessage(error), true);
    } finally {
      buttonBusy(button, false);
    }
  });

  one('[data-close-order-dialog]').addEventListener('click', function () {
    closeDialog(one('[data-order-dialog]'));
  });
  one('[data-close-subscriber-dialog]').addEventListener('click', function () {
    closeDialog(one('[data-subscriber-dialog]'));
  });

  one('[data-order-detail]').addEventListener('click', async function (event) {
    const dialog = one('[data-order-dialog]');
    const orderId = dialog.dataset.orderId;
    const syncButton = event.target.closest('[data-order-sync]');
    const closeButton = event.target.closest('[data-order-close]');
    const refundSyncButton = event.target.closest('[data-refund-sync]');
    const refundRetryButton = event.target.closest('[data-refund-retry]');
    try {
      if (syncButton) {
        buttonBusy(syncButton, true, '同步中…');
        await api('/api/admin/orders/' + encodeURIComponent(orderId) + '/sync', { method: 'POST', body: {} });
        await openOrder(orderId);
        await refreshAfterOrder();
        toast('订单状态已同步。');
      } else if (closeButton) {
        const proceed = await confirmAction(
          '关闭待支付订单',
          '关闭后该订单不能继续支付。操作前会再次查询支付宝交易状态。',
          '确认关单'
        );
        if (!proceed) return;
        buttonBusy(closeButton, true, '关闭中…');
        await api('/api/admin/orders/' + encodeURIComponent(orderId) + '/close', { method: 'POST', body: {} });
        await openOrder(orderId);
        await refreshAfterOrder();
        toast('订单已关闭。');
      } else if (refundSyncButton) {
        buttonBusy(refundSyncButton, true, '查询中…');
        await api(
          '/api/admin/orders/' + encodeURIComponent(orderId) + '/refunds/'
          + encodeURIComponent(refundSyncButton.dataset.refundSync) + '/sync',
          { method: 'POST', body: {} }
        );
        await openOrder(orderId);
        await refreshAfterOrder();
        toast('退款状态已同步。');
      } else if (refundRetryButton) {
        const proceed = await confirmAction(
          '重试退款请求',
          '将使用原退款单号再次提交，金额和原因保持不变。',
          '确认重试'
        );
        if (!proceed) return;
        buttonBusy(refundRetryButton, true, '重试中…');
        await api('/api/admin/orders/' + encodeURIComponent(orderId) + '/refunds', {
          method: 'POST',
          body: {
            refundRequestNo: refundRetryButton.dataset.refundRetry,
            amountFen: Number(refundRetryButton.dataset.refundAmount),
            reason: refundRetryButton.dataset.refundReason,
          },
        });
        await openOrder(orderId);
        await refreshAfterOrder();
        toast('退款请求已使用原退款单号重试。');
      }
    } catch (error) {
      toast(errorMessage(error), true);
      if (syncButton) buttonBusy(syncButton, false);
      if (closeButton) buttonBusy(closeButton, false);
      if (refundSyncButton) buttonBusy(refundSyncButton, false);
      if (refundRetryButton) buttonBusy(refundRetryButton, false);
    }
  });
  one('[data-order-detail]').addEventListener('submit', async function (event) {
    const form = event.target.closest('[data-refund-form]');
    if (!form) return;
    event.preventDefault();
    const orderId = one('[data-order-dialog]').dataset.orderId;
    const data = new FormData(form);
    const amount = String(data.get('amount') || '').trim();
    if (!/^\d+(\.\d{1,2})?$/.test(amount)) {
      toast('退款金额最多保留两位小数。', true);
      return;
    }
    const parts = amount.split('.');
    const amountFen = Number(parts[0]) * 100 + Number((parts[1] || '').padEnd(2, '0'));
    const reason = String(data.get('reason') || '').trim();
    const proceed = await confirmAction(
      '提交退款',
      '将为订单 ' + orderId + ' 退款 ' + formatMoney(amountFen) + '。全额退款会撤销该订单权益。',
      '确认退款'
    );
    if (!proceed) return;
    const button = one('button[type="submit"]', form);
    buttonBusy(button, true, '提交中…');
    try {
      await api('/api/admin/orders/' + encodeURIComponent(orderId) + '/refunds', {
        method: 'POST',
        body: { amountFen: amountFen, reason: reason },
      });
      await openOrder(orderId);
      await refreshAfterOrder();
      toast('退款请求已提交。');
    } catch (error) {
      toast(errorMessage(error), true);
      buttonBusy(button, false);
    }
  });

  one('[data-subscriber-detail]').addEventListener('click', function (event) {
    const orderButton = event.target.closest('[data-open-order]');
    if (!orderButton) return;
    closeDialog(one('[data-subscriber-dialog]'));
    openOrder(orderButton.dataset.openOrder).catch(function (error) { toast(errorMessage(error), true); });
  });

  one('[data-subscriber-detail]').addEventListener('submit', async function (event) {
    const form = event.target.closest('[data-adjust-form]');
    if (!form) return;
    event.preventDefault();
    const subscriberId = one('[data-subscriber-dialog]').dataset.subscriberId;
    const data = new FormData(form);
    const date = new Date(String(data.get('expiresAt') || ''));
    if (Number.isNaN(date.getTime())) {
      toast('请选择有效的到期时间。', true);
      return;
    }
    const reason = String(data.get('reason') || '').trim();
    const proceed = await confirmAction(
      '调整订阅到期时间',
      '新的到期时间为 ' + formatDate(date.toISOString()) + '。此操作会写入权益记录和审计日志。',
      '确认调整'
    );
    if (!proceed) return;
    const button = one('button[type="submit"]', form);
    buttonBusy(button, true, '调整中…');
    try {
      await api('/api/admin/subscribers/' + encodeURIComponent(subscriberId) + '/adjust', {
        method: 'POST',
        body: { expiresAt: date.toISOString(), reason: reason },
      });
      await openSubscriber(subscriberId);
      await Promise.all([loadSubscribers(false), loadDashboard()]);
      toast('订阅到期时间已调整。');
    } catch (error) {
      toast(errorMessage(error), true);
      buttonBusy(button, false);
    }
  });
}

function initializeDates() {
  const today = new Date();
  const from = new Date(today.getTime() - 29 * 86400000);
  const yesterday = new Date(today.getTime() - 86400000);
  all('[data-order-filter] input[name="from"], [data-audit-filter] input[name="from"], [data-export-form] input[name="from"]')
    .forEach(function (input) { input.value = dateInputValue(from); });
  all('[data-order-filter] input[name="to"], [data-audit-filter] input[name="to"], [data-export-form] input[name="to"]')
    .forEach(function (input) { input.value = dateInputValue(today); });
  one('[data-bill-form] input[name="date"]').value = dateInputValue(yesterday);
  one('[data-bill-form] input[name="date"]').max = dateInputValue(yesterday);
}

document.addEventListener('DOMContentLoaded', function () {
  initializeDates();
  bindAuth();
  bindAdmin();
  initializeAuth();
});
