/* Shared helpers for index.html, book.html, unsubscribe.html and 404.html */
(function () {
  const root = document.documentElement;

  // theme (storage key "theme")
  try { const t = localStorage.getItem('theme'); if (t) root.dataset.theme = t; } catch (e) {}
  const btn = document.getElementById('theme');
  if (btn) btn.addEventListener('click', () => {
    const isDark = root.dataset.theme === 'dark' ||
      (!root.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    root.dataset.theme = isDark ? 'light' : 'dark';
    try { localStorage.setItem('theme', root.dataset.theme); } catch (e) {}
  });

  const y = document.getElementById('year');
  if (y) y.textContent = new Date().getFullYear();

  const cfg = window.SITE_CONFIG || {};
  const cal = cfg.cal || {};

  // A config value counts as "set" only if it is non-empty and not a REPLACE placeholder.
  const isSet = v => typeof v === 'string' && v.trim() !== '' && !/REPLACE/i.test(v);

  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (k === 'text') n.textContent = v;
      else if (k === 'class') n.className = v;
      else n.setAttribute(k, v);
    });
    (children || []).forEach(c => n.appendChild(c));
    return n;
  }

  // Subscribe links: every [data-subscribe] element points at cfg.newsletter.subscribeUrl
  // (a Stripe Payment Link or your newsletter tool's subscribe page).
  // Not set yet: the element is greyed out and not clickable.
  function initSubscribe() {
    const url = (cfg.newsletter || {}).subscribeUrl;
    document.querySelectorAll('[data-subscribe]').forEach(a => {
      if (/^https:\/\//i.test(url || '') && isSet(url)) { a.href = url; a.rel = 'noopener'; }
      else { a.removeAttribute('href'); a.classList.add('disabled'); a.setAttribute('aria-disabled', 'true'); }
    });
  }

  // Cal.com popup: every [data-cal-book] element opens cfg.cal.bookLink in a popup.
  // Call again after adding such elements dynamically (book.html does this).
  let calLoaded = false;
  function initCal() {
    if (!isSet(cal.bookLink)) return;
    const origin = /^https:\/\//i.test(cal.origin || '') ? cal.origin.replace(/\/$/, '') : 'https://app.cal.com';
    const nodes = document.querySelectorAll('[data-cal-book]');
    if (!nodes.length) return;
    nodes.forEach(n => {
      n.setAttribute('data-cal-link', cal.bookLink.trim().replace(/^\/+/, ''));
      n.setAttribute('data-cal-origin', origin);
      n.setAttribute('data-cal-config', JSON.stringify({ layout: 'month_view', theme: 'auto' }));
    });
    if (calLoaded) return;
    calLoaded = true;
    // Standard Cal.com loader snippet (loads embed.js once, queues calls until it is ready)
    (function (C, A, L) {
      const p = function (a, ar) { a.q.push(ar); };
      const d = C.document;
      C.Cal = C.Cal || function () {
        const c = C.Cal; const ar = arguments;
        if (!c.loaded) { c.ns = {}; c.q = c.q || []; d.head.appendChild(d.createElement('script')).src = A; c.loaded = true; }
        if (ar[0] === L) {
          const api = function () { p(api, arguments); };
          const ns = ar[1]; api.q = api.q || [];
          if (typeof ns === 'string') { c.ns[ns] = c.ns[ns] || api; p(c.ns[ns], ar); p(c, ['initNamespace', ns]); }
          else p(c, ar);
          return;
        }
        p(c, ar);
      };
    })(window, origin + '/embed/embed.js', 'init');
    window.Cal('init', { origin: origin });
    window.Cal('ui', { theme: 'auto', layout: 'month_view' });
  }

  // Consultation cards from cfg.consultations (index.html #advisory and book.html).
  // The first card is featured. Returns true if booking is not set up ("Coming soon").
  function renderOffers(container) {
    const ready = isSet(cal.bookLink);
    (cfg.consultations || []).forEach((c, i) => {
      const featured = i === 0;
      const btnClass = featured ? 'btn primary' : 'btn';
      const card = el('article', { class: featured ? 'offer featured' : 'offer' });
      card.appendChild(el('span', { class: 'meta', text: [c.duration, c.price].filter(Boolean).join(' · ') }));
      card.appendChild(el('p', { text: c.description || '' }));
      const actions = el('div', { class: 'actions' });
      actions.appendChild(ready
        ? el('button', { class: btnClass, type: 'button', 'data-cal-book': '', text: 'Pick a time →' })
        : el('span', { class: btnClass + ' disabled', text: 'Coming soon' }));
      card.appendChild(actions);
      container.appendChild(card);
    });
    initCal();
    return !ready;
  }

  initSubscribe();
  initCal();
  window.Site = { cfg, renderOffers };
})();
