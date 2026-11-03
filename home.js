/* Behaviour for index.html only. Needs config.js and site.js loaded first. */
(function () {
  const { cfg } = window.Site;
  const nl = cfg.newsletter || {};

  // Price comes from config.js; the HTML holds the same copy as a fallback.
  function fillLetter() {
    if (nl.price) document.querySelectorAll('.nl-price').forEach(n => { n.textContent = nl.price; });
  }

  // The consultation pane shows the first consultation from config.js.
  function fillConsultation() {
    const c0 = (cfg.consultations || [])[0];
    if (!c0) return;
    const set = (id, text) => { if (text) document.getElementById(id).textContent = text; };
    set('consult-desc', c0.description);
    set('consult-price', c0.price);
    set('consult-duration', c0.duration);
  }

  // Fade sections in as they scroll into view.
  function revealOnScroll() {
    const io = new IntersectionObserver(es => es.forEach(e => {
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    }), { threshold: .12 });
    document.querySelectorAll('.reveal').forEach(el => io.observe(el));
  }

  fillLetter();
  fillConsultation();
  revealOnScroll();
})();
