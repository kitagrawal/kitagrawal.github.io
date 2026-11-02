/* Shared helpers for book.html, subscribe.html, thanks.html */
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

  window.Site = { cfg, isSet, el, embed };
})();
