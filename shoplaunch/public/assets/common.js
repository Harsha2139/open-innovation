/* Shared helpers: safe DOM builder, API client, formatting, modal, toast. */
(function () {
  'use strict';
  const App = (window.App = {});

  // Builds DOM nodes without ever parsing HTML strings, so user data can't inject markup.
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    let deferredValue;
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === false || v === null || v === undefined) continue;
        if (k === 'class') n.className = v;
        else if (k === 'style' && typeof v === 'object') {
          for (const [sk, sv] of Object.entries(v)) {
            if (sk.startsWith('--')) n.style.setProperty(sk, sv);
            else n.style[sk] = sv;
          }
        } else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
        else if (k === 'value' && tag === 'select') deferredValue = v;
        else if (k in n && k !== 'list' && k !== 'form') n[k] = v;
        else n.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    if (deferredValue !== undefined) n.value = deferredValue;
    return n;
  }
  App.el = el;

  App.api = async function (method, url, body) {
    const opts = { method, credentials: 'same-origin', headers: {} };
    if (method !== 'GET') {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body || {});
    }
    let res;
    try { res = await fetch(url, opts); } catch { throw new Error('Network error — check your connection.'); }
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  };

  App.money = function (cents, currency) {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD' }).format(cents / 100);
    } catch { return (cents / 100).toFixed(2); }
  };
  App.date = (sec) => new Date(sec * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  App.dateShort = (sec) => new Date(sec * 1000).toLocaleDateString(undefined, { dateStyle: 'medium' });
  App.cents = (v) => Math.round(parseFloat(v) * 100);

  // Pick black/white text for a given accent colour.
  App.ink = function (hex) {
    const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return '#fff';
    const n = parseInt(m[1], 16);
    const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    return lum > 0.62 ? '#111' : '#fff';
  };
  App.applyAccent = function (hex) {
    document.documentElement.style.setProperty('--accent', hex);
    document.documentElement.style.setProperty('--accent-ink', App.ink(hex));
  };

  // Product image, or a soft generated placeholder when there is none.
  App.productImage = function (p, cls) {
    if (p.image) return el('img', { class: 'pimg ' + (cls || ''), src: p.image, alt: p.title, loading: 'lazy' });
    let h = 0;
    for (const ch of p.title) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return el('div', { class: 'pimg ph ' + (cls || ''), style: { '--h': String(h) }, 'aria-hidden': 'true' },
      el('span', null, (p.title[0] || '?').toUpperCase()));
  };

  App.badge = (status) => el('span', { class: 'badge cap b-' + status }, status);
  App.field = (label, input, hint) =>
    el('label', { class: 'field' }, el('span', { class: 'label' }, label), input, hint ? el('small', { class: 'hint' }, hint) : null);

  let toastBox;
  App.toast = function (msg, kind) {
    if (!toastBox) { toastBox = el('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(toastBox); }
    const t = el('div', { class: 'toast ' + (kind || '') }, msg);
    toastBox.append(t);
    setTimeout(() => t.remove(), kind === 'error' ? 5000 : 2600);
  };

  App.modal = function (title, body, opts) {
    opts = opts || {};
    const overlay = el('div', { class: 'overlay' });
    function onKey(e) { if (e.key === 'Escape') close(); }
    function close() {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      if (opts.onClose) opts.onClose();
    }
    const box = el('div', { class: 'modal' + (opts.wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      el('div', { class: 'modal-head' }, el('h3', null, title),
        el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: close }, '×')),
      el('div', { class: 'modal-body' }, body));
    overlay.append(box);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onKey);
    document.body.append(overlay);
    const first = box.querySelector('input:not([type=file]),select,textarea');
    if (first) first.focus();
    return { close, box };
  };

  App.confirm = function (message, okLabel) {
    return new Promise((resolve) => {
      let answered = false;
      const answer = (v) => { answered = true; m.close(); resolve(v); };
      const m = App.modal('Please confirm', el('div', null,
        el('p', null, message),
        el('div', { class: 'row end' },
          el('button', { class: 'btn', type: 'button', onclick: () => answer(false) }, 'Cancel'),
          el('button', { class: 'btn btn-danger', type: 'button', onclick: () => answer(true) }, okLabel || 'Delete'))),
        { onClose: () => { if (!answered) resolve(false); } });
    });
  };
})();
