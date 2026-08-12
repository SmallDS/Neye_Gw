(() => {
  const plans = {
    monthly: { label: '月付订阅', cycle: '每月', price: '9.9', priceFen: 990, unit: '元 / 月', description: '一个自然月', enabled: true },
    annual: { label: '年付订阅', cycle: '每年', price: '99.99', priceFen: 9999, unit: '元 / 年', description: '一个自然年', enabled: true },
  };
  let salesEnabled = true;
  const storageKey = 'neye-subscription-orders';
  const planButtons = [...document.querySelectorAll('[data-plan]')];
  const orderForm = document.querySelector('#order-form');
  const submitButton = orderForm?.querySelector('[type="submit"]');
  const orderResult = document.querySelector('[data-order-result]');
  const formFeedback = document.querySelector('[data-form-feedback]');
  const paymentFeedback = document.querySelector('[data-payment-feedback]');
  const contactName = document.querySelector('#contact-name');
  const contactMethod = document.querySelector('#contact-method');
  const orderNote = document.querySelector('#order-note');
  const consent = document.querySelector('#order-consent');
  const orderState = document.querySelector('[data-order-state]');
  const summaryState = document.querySelector('[data-summary-state]');
  const summaryPlan = document.querySelector('[data-summary-plan]');
  const summaryCycle = document.querySelector('[data-summary-cycle]');
  const summaryPrice = document.querySelector('[data-summary-price]');
  const summaryPayment = document.querySelector('[data-summary-payment]');
  const orderId = document.querySelector('[data-order-id]');
  const orderPlan = document.querySelector('[data-order-plan]');
  const orderTime = document.querySelector('[data-order-time]');
  const payButton = document.querySelector('[data-pay-button]');
  const refreshButton = document.querySelector('[data-refresh-payment]');
  const resetButton = document.querySelector('[data-reset-order]');
  const stepIndicators = [...document.querySelectorAll('[data-step-indicator]')];
  const submitButtonMarkup = submitButton?.innerHTML || '';
  const payButtonMarkup = payButton?.innerHTML || '';
  const refreshButtonMarkup = refreshButton?.innerHTML || '';
  let currentPlanId = new URLSearchParams(window.location.search).get('plan');
  let latestOrder = null;
  let orderInFlight = false;
  let paymentInFlight = false;

  if (!plans[currentPlanId]) currentPlanId = 'monthly';

  const setFeedback = (element, message, type = '') => {
    if (!element) return;
    element.textContent = message;
    element.className = element === formFeedback ? 'form-feedback' : 'payment-feedback';
    if (type) element.classList.add(type);
  };

  const updateUrl = () => {
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('plan', currentPlanId);
      window.history.replaceState(null, '', url);
    } catch {
      // file:// 预览环境不支持历史记录更新时，不影响订单流程。
    }
  };

  const clearReturnParams = () => {
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete('payment');
      url.searchParams.delete('out_trade_no');
      window.history.replaceState(null, '', url);
    } catch {
      // file:// 预览环境不支持历史记录更新时，不影响订单流程。
    }
  };

  const setPlan = (planId) => {
    if (!plans[planId] || !plans[planId].enabled) return;
    currentPlanId = planId;
    const plan = plans[planId];
    planButtons.forEach((button) => {
      const selected = button.dataset.plan === planId;
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    if (summaryPlan) summaryPlan.textContent = plan.label;
    if (summaryCycle) summaryCycle.textContent = plan.cycle;
    if (summaryPrice) summaryPrice.textContent = '¥ ' + plan.price;
    updateUrl();
  };

  const formatPlanPrice = (fen) => {
    const fixed = (Number(fen) / 100).toFixed(2);
    return fixed.replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
  };

  const loadPlans = async () => {
    try {
      const data = await fetchJson('/api/subscription/plans');
      const config = data.plans;
      if (!config?.plans) return;
      salesEnabled = Boolean(config.salesEnabled);
      config.plans.forEach((plan) => {
        if (!plans[plan.id]) return;
        plans[plan.id] = {
          label: plan.name,
          cycle: plan.periodUnit === 'year' ? '每年' : '每月',
          price: formatPlanPrice(plan.priceFen),
          priceFen: plan.priceFen,
          unit: plan.periodUnit === 'year' ? '元 / 年' : '元 / 月',
          description: plan.description,
          enabled: Boolean(plan.enabled),
        };
        const button = planButtons.find((item) => item.dataset.plan === plan.id);
        if (!button) return;
        button.querySelector('[data-option-name]').textContent = plan.name;
        button.querySelector('[data-option-description]').textContent = plan.description;
        button.querySelector('[data-option-price]').textContent = plans[plan.id].price;
        button.querySelector('[data-option-unit]').textContent = plans[plan.id].unit;
        button.disabled = !salesEnabled || !plan.enabled;
      });
      const available = Object.keys(plans).find((id) => plans[id].enabled && salesEnabled);
      if (available && (!plans[currentPlanId]?.enabled || !salesEnabled)) currentPlanId = available;
      const summary = document.querySelector('[data-plan-summary]');
      const visible = Object.values(plans).filter((plan) => plan.enabled);
      if (summary && visible.length) {
        summary.textContent = visible.map((plan) => plan.label + ' ' + plan.price + ' 元').join(' · ');
      }
      setPlan(currentPlanId);
      if (!salesEnabled) setFeedback(formFeedback, '订阅销售当前暂停。', 'is-pending');
    } catch {
      // 接口不可用时继续使用静态默认套餐。
    }
  };

  const saveOrder = (order) => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(storageKey) || '[]');
      const orders = Array.isArray(saved) ? saved : [];
      orders.unshift({
        id: order.id,
        plan: order.plan,
        amount: order.amount,
        createdAt: order.createdAt,
        paymentStatus: order.paymentStatus,
        paidAt: order.paidAt || null,
      });
      window.localStorage.setItem(storageKey, JSON.stringify(orders.slice(0, 10)));
    } catch {
      // 本地存储不可用时，保留当前页状态。
    }
  };

  const formatTime = (value) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  };

  const updateSteps = (submitted, paid = false) => {
    stepIndicators.forEach((step) => {
      const number = Number(step.dataset.stepIndicator);
      const isDone = paid ? number <= 3 : submitted ? number <= 2 : number === 1;
      const isCurrent = paid ? number === 3 : submitted ? number === 3 : number === 2;
      step.classList.toggle('is-done', isDone);
      step.classList.toggle('is-current', isCurrent);
      const marker = step.querySelector('[data-step-number]');
      if (marker) marker.textContent = isDone ? '✓' : String(number);
    });
  };

  const showOrderResult = (order) => {
    const plan = plans[order.plan];
    if (!plan) return;
    latestOrder = order;
    setPlan(order.plan);
    if (orderId) orderId.textContent = order.id;
    if (orderPlan) orderPlan.textContent = plan.label + ' · ' + plan.price + ' ' + plan.unit;
    if (orderTime) orderTime.textContent = formatTime(order.createdAt);
    const paid = order.paymentStatus === 'paid';
    const stateLabels = {
      pending: '待支付',
      paid: '已支付',
      partially_refunded: '部分退款',
      refunded: '已退款',
      closed: '已关闭',
    };
    const stateLabel = stateLabels[order.paymentStatus] || '确认中';
    if (orderState) orderState.textContent = stateLabel;
    if (summaryState) summaryState.textContent = stateLabel;
    if (summaryPayment) summaryPayment.textContent = paid ? '已完成' : '支付宝';
    updateSteps(true, paid);
    if (orderForm) orderForm.hidden = true;
    if (payButton) {
      payButton.hidden = paid || !order.paymentForm;
      payButton.disabled = paid || !order.paymentForm;
      payButton.innerHTML = payButtonMarkup;
    }
    if (refreshButton) {
      refreshButton.hidden = paid || Boolean(order.paymentForm);
      refreshButton.disabled = paid;
      refreshButton.innerHTML = refreshButtonMarkup;
    }
    if (orderResult) {
      orderResult.hidden = false;
      orderResult.classList.add('is-visible');
      orderResult.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  const fetchJson = async (url, options) => {
    const response = await fetch(url, Object.assign({ cache: 'no-store' }, options || {}));
    let data = {};
    try {
      data = await response.json();
    } catch {
      throw new Error('支付服务返回了无效响应。');
    }
    if (!response.ok || data.ok === false) {
      const message = typeof data.error === 'string' ? data.error : data.error?.message;
      throw new Error(message || '支付服务暂时不可用。');
    }
    return data;
  };

  const displayError = (error) => {
    if (window.location.protocol === 'file:') return '请通过 https://www.smallds.icu/ 访问支付页面。';
    if (error instanceof Error && error.message) return error.message;
    return '支付服务暂时不可用，请稍后重试。';
  };

  const setButtonBusy = (button, busy, busyLabel, idleMarkup) => {
    if (!button) return;
    button.disabled = busy;
    button.setAttribute('aria-busy', String(busy));
    button.innerHTML = busy ? busyLabel : idleMarkup;
  };

  const submitGatewayForm = (payment) => {
    if (!payment || !payment.action || !payment.fields) {
      throw new Error('支付方式尚未配置。');
    }
    const gatewayForm = document.createElement('form');
    gatewayForm.method = payment.method || 'POST';
    gatewayForm.action = payment.action;
    gatewayForm.style.display = 'none';
    Object.entries(payment.fields).forEach(([name, value]) => {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = name;
      input.value = String(value);
      gatewayForm.appendChild(input);
    });
    document.body.appendChild(gatewayForm);
    gatewayForm.submit();
  };

  const submitOrder = async () => {
    if (!salesEnabled || !plans[currentPlanId]?.enabled) {
      throw new Error('所选订阅套餐当前不可用。');
    }
    const payload = {
      plan: currentPlanId,
      contactName: contactName?.value.trim() || '',
      contactMethod: contactMethod?.value.trim() || '',
      note: orderNote?.value.trim() || '',
      consent: Boolean(consent?.checked),
    };
    const data = await fetchJson('/api/payment/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const order = Object.assign({}, data.order, { paymentForm: data.payment });
    saveOrder(order);
    showOrderResult(order);
  };

  const loadReturnState = async () => {
    const params = new URLSearchParams(window.location.search);
    const returnState = params.get('payment');
    const outTradeNo = params.get('out_trade_no');
    if (!outTradeNo || !['returned', 'checking'].includes(returnState)) return;
    try {
      const data = await fetchJson('/api/payment/status?out_trade_no=' + encodeURIComponent(outTradeNo));
      const order = data.order;
      showOrderResult(order);
      if (order.paymentStatus === 'paid') {
        setFeedback(paymentFeedback, '支付成功，订单已确认。', 'is-success');
      } else {
        setFeedback(paymentFeedback, '支付结果正在确认，请稍后刷新。', 'is-pending');
      }
    } catch {
      setFeedback(paymentFeedback, '支付结果正在确认，请稍后刷新。', 'is-pending');
    }
  };

  planButtons.forEach((button) => button.addEventListener('click', () => {
    if (button.disabled) return;
    setPlan(button.dataset.plan);
    setFeedback(formFeedback, '');
  }));

  orderForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (orderInFlight) return;
    setFeedback(formFeedback, '');
    setFeedback(paymentFeedback, '');
    if (!orderForm.reportValidity()) {
      setFeedback(formFeedback, '订单信息不完整。', 'is-error');
      return;
    }
    orderInFlight = true;
    setButtonBusy(submitButton, true, '正在创建订单…', submitButtonMarkup);
    try {
      await submitOrder();
    } catch (error) {
      setFeedback(formFeedback, displayError(error), 'is-error');
    } finally {
      orderInFlight = false;
      setButtonBusy(submitButton, false, '', submitButtonMarkup);
    }
  });

  refreshButton?.addEventListener('click', async () => {
    if (!latestOrder?.id || paymentInFlight) return;
    paymentInFlight = true;
    setFeedback(paymentFeedback, '');
    setButtonBusy(refreshButton, true, '正在查询…', refreshButtonMarkup);
    try {
      const data = await fetchJson('/api/payment/status?out_trade_no=' + encodeURIComponent(latestOrder.id));
      showOrderResult(data.order);
      if (data.order.paymentStatus === 'paid') {
        setFeedback(paymentFeedback, '支付成功，订单已确认。', 'is-success');
      } else {
        setFeedback(paymentFeedback, '暂未确认支付结果，可稍后再次刷新。', 'is-pending');
      }
    } catch (error) {
      setFeedback(paymentFeedback, displayError(error), 'is-error');
    } finally {
      paymentInFlight = false;
      setButtonBusy(refreshButton, false, '', refreshButtonMarkup);
    }
  });
  payButton?.addEventListener('click', () => {
    if (!latestOrder?.paymentForm || paymentInFlight) return;
    paymentInFlight = true;
    setFeedback(paymentFeedback, '');
    setButtonBusy(payButton, true, '正在打开支付宝…', payButtonMarkup);
    try {
      submitGatewayForm(latestOrder.paymentForm);
    } catch (error) {
      paymentInFlight = false;
      setButtonBusy(payButton, false, '', payButtonMarkup);
      setFeedback(paymentFeedback, displayError(error), 'is-error');
      paymentFeedback?.focus();
    }
  });

  resetButton?.addEventListener('click', () => {
    latestOrder = null;
    paymentInFlight = false;
    clearReturnParams();
    orderForm?.reset();
    if (orderForm) orderForm.hidden = false;
    if (orderResult) {
      orderResult.hidden = true;
      orderResult.classList.remove('is-visible');
    }
    if (orderState) orderState.textContent = '订单待创建';
    if (summaryState) summaryState.textContent = '待提交';
    if (summaryPayment) summaryPayment.textContent = '支付宝';
    setFeedback(formFeedback, '');
    setFeedback(paymentFeedback, '');
    setButtonBusy(submitButton, false, '', submitButtonMarkup);
    setButtonBusy(payButton, false, '', payButtonMarkup);
    setButtonBusy(refreshButton, false, '', refreshButtonMarkup);
    if (payButton) payButton.hidden = false;
    if (refreshButton) refreshButton.hidden = true;
    updateSteps(false);
    orderForm?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  [contactName, contactMethod, orderNote].forEach((field) => field?.addEventListener('input', () => setFeedback(formFeedback, '')));
  consent?.addEventListener('change', () => setFeedback(formFeedback, ''));
  const initialize = async () => {
    await loadPlans();
    setPlan(currentPlanId);
    updateSteps(false);
    await loadReturnState();
  };
  void initialize();
})();
