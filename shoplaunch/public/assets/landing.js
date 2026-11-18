(function () {
  'use strict';
  const { el, api } = App;
  const box = document.getElementById('stores');
  api('GET', '/api/stores').then(({ stores }) => {
    if (!stores.length) {
      box.replaceChildren(el('p', { class: 'muted' }, 'No stores yet — be the first to launch one!'));
      return;
    }
    box.replaceChildren(...stores.map((s) =>
      el('a', { class: 'store-card', href: '/store/' + encodeURIComponent(s.slug) },
        el('div', { class: 'band', style: { background: s.color } }),
        el('div', { class: 'info' }, el('strong', null, s.name), el('span', { class: 'muted' }, s.tagline || 'Visit store →')))));
  }).catch(() => box.replaceChildren(el('p', { class: 'muted' }, 'Could not load stores.')));
})();
