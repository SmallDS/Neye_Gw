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