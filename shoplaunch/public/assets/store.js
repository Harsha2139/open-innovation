(function () {
  'use strict';
  const { el, api, money, date, toast, productImage, applyAccent, badge, field } = App;
  const root = document.getElementById('app');
  const slug = decodeURIComponent(location.pathname.split('/')[2] || '');
  const base = '/api/shop/' + encodeURIComponent(slug);
  let store = null;

  // ───────────── cart (localStorage, with in-memory fallback) ─────────────
  const cartKey = 'shoplaunch:cart:' + slug;
  const codeKey = 'shoplaunch:code:' + slug;
  let memCart = [], memCode = '';
  const cart = {
    get() {
      try {
        const a = JSON.parse(localStorage.getItem(cartKey) || '[]');
        return Array.isArray(a) ? a.filter((x) => x && Number.isInteger(x.id) && Number.isInteger(x.qty) && x.qty > 0) : [];
      } catch { return memCart; }
    },
    set(a) { memCart = a; try { localStorage.setItem(cartKey, JSON.stringify(a)); } catch { /* storage unavailable */ } updateBadge(); },
    add(id, qty) {
      const a = this.get(); const it = a.find((x) => x.id === id);
      if (it) it.qty = Math.min(99, it.qty + qty); else a.push({ id, qty });
      this.set(a);
    },
    count() { return this.get().reduce((n, x) => n + x.qty, 0); },
    clear() { this.set([]); },
  };
  const code = {
    get() { try { return sessionStorage.getItem(codeKey) || ''; } catch { return memCode; } },
    set(v) { memCode = v; try { v ? sessionStorage.setItem(codeKey, v) : sessionStorage.removeItem(codeKey); } catch { /* ignore */ } },
  };
  let badgeEl, searchInput;
  function updateBadge() { if (badgeEl) badgeEl.textContent = String(cart.count()); }

  const fmt = (c) => money(c, store.currency);
  let main;
  let renderId = 0;

  // ───────────── layout ─────────────
  function layout() {
    applyAccent(store.color);
    document.title = store.name;
    badgeEl = el('span', { class: 'count' }, String(cart.count()));
    const q = (searchInput = el('input', { type: 'search', placeholder: 'Search products…', 'aria-label': 'Search products' }));
    main = el('main', { class: 'sf-main' });
    root.replaceChildren(
      el('div', { class: 'sf-announce' }, '🚚 ', el('b', null, 'Fast delivery'), ' · Use code ', el('b', null, 'WELCOME10'), ' for 10% off your first order'),
      el('header', { class: 'sf-header' }, el('div', { class: 'in' },
        el('a', { class: 'sf-brand', href: '#/' }, store.name),
        el('form', { class: 'sf-search', onsubmit: (e) => { e.preventDefault(); location.hash = '#/?q=' + encodeURIComponent(q.value.trim()); } }, q),
        el('a', { class: 'cart-link', href: '#/cart' }, 'Cart ', badgeEl))),
      main,
      el('footer', { class: 'sf-footer' }, `© ${new Date().getFullYear()} ${store.name} · Powered by `, el('a', { href: '/' }, 'ShopLaunch')));
    window.addEventListener('hashchange', render);
    render();
  }

  function parseHash() {
    const raw = location.hash.replace(/^#/, '') || '/';
    const [p, qs] = raw.split('?');
    return { parts: p.split('/').filter(Boolean), query: new URLSearchParams(qs || '') };
  }

  async function render() {
    const { parts, query } = parseHash();
    const id = ++renderId;
    window.scrollTo(0, 0);
    if (searchInput) searchInput.value = parts.length === 0 ? (query.get('q') || '') : '';
    main.replaceChildren(el('p', { class: 'muted' }, 'Loading…'));
    try {
      let node;
      if (parts[0] === 'product' && parts[1]) node = await productPage(parts[1]);
      else if (parts[0] === 'cart') node = await cartPage();
      else if (parts[0] === 'checkout') node = await checkoutPage();
      else if (parts[0] === 'order' && parts[1]) node = await orderPage(parts[1]);
      else node = await home(query);
      if (id === renderId) main.replaceChildren(node);
    } catch (e) {
      if (id === renderId) main.replaceChildren(el('div', { class: 'card center' },
        el('h3', null, e.status === 404 ? 'Not found' : 'Something went wrong'), el('p', { class: 'muted' }, e.message),
        el('a', { class: 'btn', href: '#/' }, '← Back to shop')));
    }
  }

  // ───────────── product card ─────────────
  function productCard(p) {
    const out = p.inventory <= 0;
    const sale = p.compare_at && p.compare_at > p.price;
    const addBtn = el('button', { class: 'btn btn-primary', type: 'button', disabled: out, onclick: () => {
      const inCart = (cart.get().find((x) => x.id === p.id) || { qty: 0 }).qty;
      if (inCart >= p.inventory) { toast(`Only ${p.inventory} available`, 'error'); return; }
      cart.add(p.id, 1); toast(`Added “${p.title}” to cart`);
    } }, out ? 'Sold out' : 'Add to cart');
    return el('div', { class: 'pcard' },
      el('a', { class: 'media', href: '#/product/' + p.id },
        productImage(p),
        out ? el('span', { class: 'tag' }, 'Sold out') : sale ? el('span', { class: 'tag sale' }, 'Sale') : null),
      el('a', { class: 't', href: '#/product/' + p.id, style: { color: 'inherit' } }, p.title),
      el('div', { class: 'pr' }, el('span', { class: 'price' }, fmt(p.price)), sale ? el('span', { class: 'was' }, fmt(p.compare_at)) : null),
      addBtn);
  }

  // ───────────── home ─────────────
  async function home(query) {
    const q = query.get('q') || '', category = query.get('category') || '', sort = query.get('sort') || 'newest';
    const LIMIT = 24;
    const mk = (offset) => `${base}/products?limit=${LIMIT}&offset=${offset}&sort=${encodeURIComponent(sort)}` +
      (q ? '&q=' + encodeURIComponent(q) : '') + (category ? '&category=' + encodeURIComponent(category) : '');
    const first = await api('GET', mk(0));
    const link = (over) => {
      const n = new URLSearchParams();
      const v = { q, category, sort, ...over };
      for (const [k, val] of Object.entries(v)) if (val && !(k === 'sort' && val === 'newest')) n.set(k, val);
      const s = n.toString();
      return '#/' + (s ? '?' + s : '');
    };
    const grid = el('div', { class: 'pgrid' }, first.products.map(productCard));
    let loaded = first.products.length;
    const more = el('button', { class: 'btn', type: 'button', onclick: async () => {
      more.disabled = true;
      try {
        const next = await api('GET', mk(loaded));
        grid.append(...next.products.map(productCard)); loaded += next.products.length;
        if (loaded >= first.total) more.remove(); else more.disabled = false;
      } catch (e) { toast(e.message, 'error'); more.disabled = false; }
    } }, 'Load more');
    const sortSel = el('select', { 'aria-label': 'Sort', value: sort, onchange: (e) => { location.hash = link({ sort: e.target.value }); } },
      [['newest', 'Newest'], ['price_asc', 'Price: low to high'], ['price_desc', 'Price: high to low'], ['title', 'Name A–Z']].map(([v, l]) => el('option', { value: v }, l)));
    return el('div', null,
      !q && !category ? el('section', { class: 'sf-hero' }, el('span', { class: 'eyebrow' }, 'New arrivals'), el('h1', null, store.name), el('p', null, store.tagline || 'Quality products, delivered to your door.')) : null,
      !q && !category ? el('div', { class: 'sf-perks' }, el('div', null, '🚚 Quick shipping'), el('div', null, '🔒 Secure checkout'), el('div', null, '↩️ Easy returns'), el('div', null, '⭐ Quality guaranteed')) : null,
      q ? el('h2', null, `Results for “${q}”`) : null,
      el('div', { class: 'filters' },
        el('a', { class: 'chip' + (!category ? ' on' : ''), href: link({ category: '' }), style: { color: !category ? '#fff' : 'inherit' } }, 'All'),
        first.categories.map((c) => el('a', { class: 'chip' + (c === category ? ' on' : ''), href: link({ category: c }), style: { color: c === category ? '#fff' : 'inherit' } }, c)),
        sortSel),
      first.products.length ? grid : el('div', { class: 'empty card' }, el('p', null, q || category ? 'No products match your search.' : 'This store has no products yet.'),
        q || category ? el('a', { class: 'btn', href: '#/' }, 'Clear filters') : null),
      first.total > loaded ? el('div', { class: 'center', style: { marginTop: '26px' } }, more) : null);
  }

  // ───────────── product page ─────────────
  async function productPage(id) {
    const { product: p } = await api('GET', `${base}/products/${encodeURIComponent(id)}`);
    document.title = `${p.title} — ${store.name}`;
    const out = p.inventory <= 0;
    const sale = p.compare_at && p.compare_at > p.price;
    let qty = 1;
    const qtyEl = el('span', null, '1');
    const minus = el('button', { type: 'button', 'aria-label': 'Decrease', disabled: true, onclick: () => set(qty - 1) }, '−');
    const plus = el('button', { type: 'button', 'aria-label': 'Increase', disabled: p.inventory <= 1, onclick: () => set(qty + 1) }, '+');
    function set(n) {
      qty = Math.max(1, Math.min(Math.min(99, p.inventory), n));
      qtyEl.textContent = String(qty); minus.disabled = qty <= 1; plus.disabled = qty >= Math.min(99, p.inventory);
    }
    const add = el('button', { class: 'btn btn-primary', type: 'button', disabled: out, style: { padding: '12px 26px' }, onclick: () => {
      const inCart = (cart.get().find((x) => x.id === p.id) || { qty: 0 }).qty;
      if (inCart + qty > p.inventory) { toast(`Only ${p.inventory} in stock (you have ${inCart} in your cart)`, 'error'); return; }
      cart.add(p.id, qty); toast('Added to cart');
    } }, out ? 'Sold out' : 'Add to cart');
    return el('div', null,
      el('div', { class: 'crumbs' }, el('a', { href: '#/' }, '← All products')),
      el('div', { class: 'pdetail' },
        productImage(p),
        el('div', null,
          p.category ? el('div', { class: 'muted' }, p.category) : null,
          el('h1', null, p.title),
          el('span', { class: 'price big' }, fmt(p.price), sale ? el('span', { class: 'was' }, fmt(p.compare_at)) : null),
          el('div', { class: 'stockline ' + (out ? 'out' : p.inventory <= 5 ? 'low' : 'in') }, out ? 'Out of stock' : p.inventory <= 5 ? `Only ${p.inventory} left` : 'In stock'),
          out ? null : el('div', { class: 'row', style: { marginBottom: '22px' } }, el('div', { class: 'qty' }, minus, qtyEl, plus), add),
          out ? add : null,
          p.description ? el('div', { class: 'desc' }, p.description) : null)));
  }

  // ───────────── cart ─────────────
  async function quote() {
    const q = await api('POST', `${base}/quote`, { items: cart.get(), code: code.get() });
    // keep the stored cart in sync with what's actually purchasable
    const synced = q.lines.map((l) => ({ id: l.id, qty: l.qty }));
    if (JSON.stringify(synced) !== JSON.stringify(cart.get())) cart.set(synced);
    if (q.discountError) code.set('');
    return q;
  }

  function totalsBlock(q) {
    const row = (l, v, cls) => el('div', { class: cls || '' }, el('span', null, l), el('span', null, v));
    return el('div', { class: 'totals' },
      row('Subtotal', fmt(q.subtotal)),
      q.discount ? row(`Discount (${q.discountCode})`, '−' + fmt(q.discount)) : null,
      row('Shipping', q.shipping === 0 ? 'Free' : fmt(q.shipping)),
      store.tax_rate > 0 ? row(`Tax (${store.tax_rate}%)`, fmt(q.tax)) : null,
      row('Total', fmt(q.total), 'grand'));
  }

  async function cartPage() {
    document.title = `Cart — ${store.name}`;
    if (!cart.get().length) {
      return el('div', { class: 'card center' }, el('h2', null, 'Your cart is empty'), el('p', { class: 'muted' }, 'Looks like you haven’t added anything yet.'), el('a', { class: 'btn btn-primary', href: '#/' }, 'Continue shopping'));
    }
    const q = await quote();
    if (!q.lines.length) { render(); return el('div'); }
    const setQty = (id, n) => {
      const a = cart.get().map((x) => (x.id === id ? { id, qty: n } : x)).filter((x) => x.qty > 0);
      cart.set(a); render();
    };
    const codeInput = el('input', { type: 'text', placeholder: 'Discount code', value: code.get(), maxLength: 30, 'aria-label': 'Discount code' });
    const apply = async () => {
      code.set(codeInput.value.trim().toUpperCase());
      render();
    };
    return el('div', null, el('h2', null, 'Your cart'),
      q.notes.length ? q.notes.map((n) => el('div', { class: 'alert' }, n.message)) : null,
      q.discountError ? el('div', { class: 'alert error' }, q.discountError) : null,
      el('div', { class: 'cart-grid' },
        el('div', { class: 'card' }, q.lines.map((l) => el('div', { class: 'cart-line' },
          el('a', { href: '#/product/' + l.id }, productImage(l)),
          el('div', null, el('a', { href: '#/product/' + l.id, style: { color: 'inherit', fontWeight: '600' } }, l.title),
            el('div', { class: 'muted' }, fmt(l.price)),
            el('div', { class: 'row', style: { marginTop: '8px' } },
              el('div', { class: 'qty' },
                el('button', { type: 'button', 'aria-label': 'Decrease quantity', onclick: () => setQty(l.id, l.qty - 1) }, '−'), el('span', null, String(l.qty)),
                el('button', { type: 'button', 'aria-label': 'Increase quantity', disabled: l.qty >= l.inventory, onclick: () => setQty(l.id, l.qty + 1) }, '+')),
              el('button', { class: 'btn-link danger', type: 'button', onclick: () => setQty(l.id, 0) }, 'Remove'))),
          el('strong', null, fmt(l.total))))),
        el('div', { class: 'card summary' }, el('h3', null, 'Order summary'),
          el('div', { class: 'code-row' }, codeInput, el('button', { class: 'btn', type: 'button', onclick: apply }, 'Apply')),
          totalsBlock(q),
          el('a', { class: 'btn btn-primary btn-block', href: '#/checkout', style: { marginTop: '16px' } }, 'Checkout'),
          el('p', { class: 'muted center', style: { margin: '12px 0 0', fontSize: '13px' } }, q.shipping === 0 || !store.free_shipping_over ? '' : `Free shipping on orders over ${fmt(store.free_shipping_over)}`))));
  }

  // ───────────── checkout ─────────────
  async function checkoutPage() {
    document.title = `Checkout — ${store.name}`;
    if (!cart.get().length) { location.hash = '#/cart'; return el('div'); }
    const q = await quote();
    if (!q.lines.length) { location.hash = '#/cart'; return el('div'); }
    const f = {
      name: el('input', { type: 'text', required: true, autocomplete: 'name', maxLength: 100 }),
      email: el('input', { type: 'email', required: true, autocomplete: 'email' }),
      phone: el('input', { type: 'text', autocomplete: 'tel', maxLength: 30 }),
      address: el('input', { type: 'text', required: true, autocomplete: 'street-address', maxLength: 200 }),
      city: el('input', { type: 'text', required: true, autocomplete: 'address-level2', maxLength: 100 }),
      zip: el('input', { type: 'text', required: true, autocomplete: 'postal-code', maxLength: 20 }),
      country: el('input', { type: 'text', required: true, autocomplete: 'country-name', maxLength: 80, value: store.currency === 'INR' ? 'India' : '' }),
      notes: el('textarea', { rows: 2, maxLength: 500, placeholder: 'Delivery instructions (optional)' }),
    };
    const pay = (val, title, sub, checked) => el('label', { class: 'pay-opt' },
      el('input', { type: 'radio', name: 'pay', value: val, checked }), el('div', null, el('strong', null, title), el('div', { class: 'muted' }, sub)));
    const err = el('div');
    const submit = el('button', { class: 'btn btn-primary btn-block', type: 'submit' }, `Place order · ${fmt(q.total)}`);
    const form = el('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        submit.disabled = true; err.replaceChildren();
        const payment = form.querySelector('input[name=pay]:checked').value;
        try {
          const r = await api('POST', `${base}/checkout`, {
            items: cart.get(), code: code.get(), payment,
            name: f.name.value, email: f.email.value, phone: f.phone.value, address: f.address.value,
            city: f.city.value, zip: f.zip.value, country: f.country.value, notes: f.notes.value,
          });
          cart.clear(); code.set('');
          location.hash = '#/order/' + r.token;
        } catch (ex) {
          if (ex.status === 409) { toast(ex.message, 'error'); location.hash = '#/cart'; return; }
          err.replaceChildren(el('div', { class: 'alert error' }, ex.message));
          submit.disabled = false;
        }
      },
    },
      el('div', { class: 'checkout-grid' },
        el('div', { class: 'stack' },
          el('div', { class: 'card' }, el('h3', null, 'Contact & delivery'),
            el('div', { class: 'form-grid' },
              field('Full name', f.name), field('Email', f.email), field('Phone', f.phone), field('Country', f.country),
              el('div', { class: 'full' }, field('Address', f.address)),
              field('City', f.city), field('Postal code', f.zip),
              el('div', { class: 'full' }, field('Order notes', f.notes)))),
          el('div', { class: 'card' }, el('h3', null, 'Payment'),
            pay('demo', 'Pay now (demo gateway)', 'No real charge is made — this simulates a successful online payment.', true),
            pay('cod', 'Cash on delivery', 'Pay when your order arrives.', false))),
        el('div', { class: 'card summary' }, el('h3', null, 'Order summary'),
          q.lines.map((l) => el('div', { class: 'row between', style: { padding: '4px 0', flexWrap: 'nowrap' } },
            el('span', null, `${l.title} × ${l.qty}`), el('span', null, fmt(l.total)))),
          totalsBlock(q), err, el('div', { style: { marginTop: '14px' } }, submit),
          el('p', { class: 'center', style: { margin: '10px 0 0' } }, el('a', { href: '#/cart' }, '← Back to cart')))));
    return el('div', null, el('h2', null, 'Checkout'), form);
  }

  // ───────────── order confirmation ─────────────
  async function orderPage(token) {
    const { order: o, items } = await api('GET', `${base}/orders/${encodeURIComponent(token)}`);
    document.title = `Order #${o.number} — ${store.name}`;
    const row = (l, v, cls) => el('div', { class: cls || '' }, el('span', null, l), el('span', null, v));
    return el('div', { class: 'card', style: { maxWidth: '680px', margin: '0 auto' } },
      el('div', { class: 'success' }, el('div', { class: 'tick' }, '✓'), el('h2', null, 'Thank you for your order!'),
        el('p', { class: 'muted' }, `Order #${o.number} · ${date(o.created_at)}`), badge(o.status)),
      el('div', { class: 'table-wrap' }, el('table', null, el('tbody', null, items.map((i) =>
        el('tr', null, el('td', null, i.title), el('td', null, '× ' + i.qty), el('td', { class: 'right' }, fmt(i.price * i.qty))))))),
      el('div', { class: 'totals' },
        row('Subtotal', fmt(o.subtotal)), o.discount ? row(`Discount (${o.discount_code})`, '−' + fmt(o.discount)) : null,
        row('Shipping', o.shipping === 0 ? 'Free' : fmt(o.shipping)), o.tax ? row('Tax', fmt(o.tax)) : null, row('Total', fmt(o.total), 'grand')),
      el('dl', { class: 'kv', style: { marginTop: '20px' } },
        el('dt', null, 'Ship to'), el('dd', null, `${o.name}, ${o.address}, ${o.city} ${o.zip}, ${o.country}`),
        el('dt', null, 'Email'), el('dd', null, o.email),
        el('dt', null, 'Payment'), el('dd', null, o.payment === 'cod' ? 'Cash on delivery' : 'Paid online')),
      el('p', { class: 'muted', style: { marginTop: '16px', fontSize: '13px' } }, 'Bookmark this page to check your order status later.'),
      el('div', { class: 'center' }, el('a', { class: 'btn btn-primary', href: '#/' }, 'Continue shopping')));
  }

  // ───────────── boot ─────────────
  api('GET', base).then((r) => { store = r.store; layout(); }).catch((e) => {
    root.replaceChildren(el('div', { class: 'auth-wrap' }, el('div', { class: 'card center' },
      el('h2', null, e.status === 404 ? 'Store not found' : 'Something went wrong'), el('p', { class: 'muted' }, e.message),
      el('a', { class: 'btn btn-primary', href: '/' }, 'Go to ShopLaunch'))));
  });
})();
