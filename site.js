/* Shared helpers for index.html, book.html, subscribe.html, thanks.html */
(function () {
  const root = document.documentElement;

  // theme (same behaviour and storage key as index.html)
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

  // A value counts as "set" only if it is a real https URL and not a placeholder.
  function isSet(url) {
    return typeof url === 'string' && /^https:\/\//i.test(url) && !/REPLACE/i.test(url);
  }

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

  function embed(container, url) {
    container.textContent = '';
    const f = el('iframe', { src: url, title: 'Schedule a time', loading: 'lazy' });
    container.appendChild(f);
  }

  // Consultation cards from cfg.consultations (index.html #advisory and book.html).
  // The first card is featured: accent border and a primary button.
  // onPickTime runs when a card has no stripeLink but schedulerUrl is set.
  // Returns true if any card has neither (it shows "Coming soon").
  function renderOffers(container, onPickTime) {
    let missing = false;
    (cfg.consultations || []).forEach((c, i) => {
      const featured = i === 0;
      const btnClass = featured ? 'btn primary' : 'btn';
      const card = el('article', { class: featured ? 'offer featured' : 'offer' });
      card.appendChild(el('span', { class: 'meta', text: [c.duration, c.price].filter(Boolean).join(' · ') }));
      card.appendChild(el('p', { text: c.description || '' }));

      const actions = el('div', { class: 'actions' });
      if (isSet(c.stripeLink)) {
        // Pay first via Stripe; Stripe then redirects to thanks.html?type=consult
        const u = new URL(c.stripeLink);
        if (c.id) u.searchParams.set('client_reference_id', String(c.id).replace(/[^A-Za-z0-9_-]/g, ''));
        actions.appendChild(el('a', { class: btnClass, href: u.toString(), rel: 'noopener', text: 'Pay & book →' }));
      } else if (isSet(cfg.schedulerUrl) && onPickTime) {
        // No Stripe link: go straight to the scheduler (use with Cal.com's built-in payments)
        const b = el('button', { class: btnClass, type: 'button', text: 'Pick a time →' });
        b.addEventListener('click', onPickTime);
        actions.appendChild(b);
      } else {
        missing = true;
        actions.appendChild(el('span', { class: btnClass + ' disabled', text: 'Coming soon' }));
      }
      card.appendChild(actions);
      container.appendChild(card);
    });
    return missing;
  }

  window.Site = { cfg, isSet, el, embed, renderOffers };
})();
