(() => {
  const header = document.querySelector('[data-header]');
  const menuToggle = document.querySelector('[data-menu-toggle]');
  const menuLabel = document.querySelector('[data-menu-label]');
  const nav = document.querySelector('[data-nav]');

  const closeMenu = () => {
    if (!menuToggle || !nav) return;
    menuToggle.setAttribute('aria-expanded', 'false');
    if (menuLabel) menuLabel.textContent = '打开导航';
    nav.classList.remove('is-open');
  };

  menuToggle?.addEventListener('click', () => {
    const isOpen = menuToggle.getAttribute('aria-expanded') === 'true';
    menuToggle.setAttribute('aria-expanded', String(!isOpen));
    if (menuLabel) menuLabel.textContent = isOpen ? '打开导航' : '关闭导航';
    nav?.classList.toggle('is-open', !isOpen);
  });

  nav?.querySelectorAll('a').forEach((link) => link.addEventListener('click', closeMenu));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMenu();
  });

  const updateHeader = () => header?.classList.toggle('is-scrolled', window.scrollY > 12);
  updateHeader();
  window.addEventListener('scroll', updateHeader, { passive: true });

  const sections = [...document.querySelectorAll('main section[id]')];
  const navLinks = [...document.querySelectorAll('.site-nav > a[href^="#"]')];
  const activeSections = new Map();
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => activeSections.set(entry.target.id, entry.isIntersecting));
      const current = sections.find((section) => activeSections.get(section.id));
      navLinks.forEach((link) => link.classList.toggle('is-active', current ? link.getAttribute('href') === `#${current.id}` : false));
    },
    { rootMargin: '-32% 0px -58% 0px', threshold: 0 },
  );
  sections.forEach((section) => observer.observe(section));

  const formatPlanPrice = (fen) => {
    const fixed = (Number(fen) / 100).toFixed(2);
    return fixed.replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
  };

  const loadSubscriptionPlans = async () => {
    try {
      const response = await fetch('/api/subscription/plans', { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok || payload.ok === false || !payload.plans?.plans) return;
      const config = payload.plans;
      config.plans.forEach((plan) => {
        const card = document.querySelector('[data-subscription-card="' + plan.id + '"]');
        if (!card) return;
        const unit = plan.periodUnit === 'year' ? '元 / 年' : '元 / 月';
        const available = config.salesEnabled && plan.enabled;
        card.querySelector('[data-plan-name]').textContent = plan.name;
        card.querySelector('[data-plan-price]').textContent = formatPlanPrice(plan.priceFen);
        card.querySelector('[data-plan-unit]').textContent = unit;
        card.querySelector('[data-plan-description]').textContent = plan.description;
        card.querySelector('[data-plan-status]').textContent = available ? '可订阅' : '暂不可用';
        card.classList.toggle('price-card-featured', Boolean(plan.recommended && plan.enabled));
        const link = card.querySelector('.subscription-button');
        link.setAttribute('aria-disabled', String(!available));
        link.tabIndex = available ? 0 : -1;
      });
      const visible = config.plans.filter((plan) => plan.enabled);
      const summary = document.querySelector('[data-subscription-summary]');
      if (summary && visible.length) {
        summary.textContent = visible.map((plan) => (
          plan.name + ' ' + formatPlanPrice(plan.priceFen) + ' 元'
        )).join('，') + '。';
      }
    } catch {
      // 保留页面中的静态默认套餐。
    }
  };

  void loadSubscriptionPlans();
  document.querySelectorAll('.product-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.product-tab').forEach((item) => {
        item.classList.remove('is-active');
        item.setAttribute('aria-selected', 'false');
      });
      tab.classList.add('is-active');
      tab.setAttribute('aria-selected', 'true');
    });
  });
})();