(() => {
  const plans = {
    monthly: { label: '月付订阅', cycle: '每月', price: '9.9', unit: '元 / 月' },
    annual: { label: '年付订阅', cycle: '每年', price: '99.99', unit: '元 / 年' },
  };
  const storageKey = 'neye-subscription-orders';
  const planButtons = [...document.querySelectorAll('[data-plan]')];
  const orderForm = document.querySelector('#order-form');
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
  const resetButton = document.querySelector('[data-reset-order]');
  const stepIndicators = [...document.querySelectorAll('[data-step-indicator]')];
  let currentPlanId = new URLSearchParams(window.location.search).get('plan');
  let latestOrder = null;

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

  const setPlan = (planId) => {
    if (!plans[planId]) return;
    currentPlanId = planId;
    const plan = plans[planId];
    planButtons.forEach((button) => {
      const selected = button.dataset.plan === planId;
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    if (summaryPlan) summaryPlan.textContent = plan.label;
    if (summaryCycle) summaryCycle.textContent = plan.cycle;
    if (summaryPrice) summaryPrice.textContent = `¥ ${plan.price}`;
    updateUrl();
  };

  const createOrderId = () => {
    const now = new Date();
    const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('');
    const suffix = Math.floor(100000 + Math.random() * 900000);
    return `NE-${date}-${suffix}`;
  };

  const saveOrder = (order) => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(storageKey) || '[]');
      const orders = Array.isArray(saved) ? saved : [];
      orders.unshift(order);
      window.localStorage.setItem(storageKey, JSON.stringify(orders.slice(0, 10)));
    } catch {
      // 本地存储不可用时，保留当前页状态。
    }
  };

  const formatTime = (date) => new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);

  const updateSteps = (submitted) => {
    stepIndicators.forEach((step) => {
      const number = Number(step.dataset.stepIndicator);
      const marker = step.querySelector('[data-step-number]');
      const isDone = submitted ? number <= 2 : number === 1;
      const isCurrent = submitted ? number === 3 : number === 2;
      step.classList.toggle('is-done', isDone);
      step.classList.toggle('is-current', isCurrent);
      if (marker) marker.textContent = isDone ? '✓' : String(number);
    });
  };

  const showOrderResult = (order) => {
    const plan = plans[order.plan];
    latestOrder = order;
    if (orderId) orderId.textContent = order.id;
    if (orderPlan) orderPlan.textContent = `${plan.label} · ${plan.price} ${plan.unit}`;
    if (orderTime) orderTime.textContent = formatTime(new Date(order.createdAt));
    if (orderState) orderState.textContent = '订单已创建';
    if (summaryState) summaryState.textContent = '已创建';
    if (summaryPayment) summaryPayment.textContent = '待配置';
    updateSteps(true);
    if (orderForm) orderForm.hidden = true;
    if (orderResult) {
      orderResult.hidden = false;
      orderResult.classList.add('is-visible');
      orderResult.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  planButtons.forEach((button) => button.addEventListener('click', () => {
    setPlan(button.dataset.plan);
    setFeedback(formFeedback, '');
  }));

  orderForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    setFeedback(formFeedback, '');
    setFeedback(paymentFeedback, '');
    if (!orderForm.reportValidity()) {
      setFeedback(formFeedback, '订单信息不完整。', 'is-error');
      return;
    }

    const plan = plans[currentPlanId];
    const order = {
      id: createOrderId(),
      plan: currentPlanId,
      contactName: contactName.value.trim(),
      contactMethod: contactMethod.value.trim(),
      note: orderNote.value.trim(),
      amount: plan.price,
      createdAt: new Date().toISOString(),
      paymentStatus: 'pending',
    };
    saveOrder(order);
    showOrderResult(order);
  });

  payButton?.addEventListener('click', () => {
    if (!latestOrder) return;
    if (summaryState) summaryState.textContent = '待支付';
    if (summaryPayment) summaryPayment.textContent = '未配置';
    setFeedback(paymentFeedback, '未配置支付方式。', 'is-error');
    paymentFeedback?.focus();
  });

  resetButton?.addEventListener('click', () => {
    latestOrder = null;
    orderForm?.reset();
    if (orderForm) orderForm.hidden = false;
    if (orderResult) {
      orderResult.hidden = true;
      orderResult.classList.remove('is-visible');
    }
    if (orderState) orderState.textContent = '订单待创建';
    if (summaryState) summaryState.textContent = '待提交';
    if (summaryPayment) summaryPayment.textContent = '待配置';
    setFeedback(formFeedback, '');
    setFeedback(paymentFeedback, '');
    updateSteps(false);
    orderForm?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  [contactName, contactMethod, orderNote, consent].forEach((field) => field?.addEventListener('input', () => setFeedback(formFeedback, '')));
  consent?.addEventListener('change', () => setFeedback(formFeedback, ''));
  setPlan(currentPlanId);
  updateSteps(false);
})();