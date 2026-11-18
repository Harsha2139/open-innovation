(function () {
  'use strict';
  const { el, api, money, date, dateShort, cents, toast, modal, confirm: confirmBox, badge, field, productImage, applyAccent } = App;
  const root = document.getElementById('app');
  const state = { user: null, store: null };
  const STATUSES = ['pending', 'paid', 'shipped', 'delivered', 'cancelled'];
  const fmt = (c) => money(c, state.store.currency);

  // ───────────── auth ─────────────
  function renderAuth(mode) {
    const err = el('div');
    const f = {
      name: el('input', { type: 'text', autocomplete: 'name', required: true, maxLength: 80 }),
      storeName: el('input', { type: 'text', required: true, minLength: 2, maxLength: 60, placeholder: 'e.g. Chennai Goods' }),
      email: el('input', { type: 'email', autocomplete: 'email', required: true }),
      password: el('input', { type: 'password', autocomplete: mode === 'signup' ? 'new-password' : 'current-password', required: true, minLength: mode === 'signup' ? 8 : 1 }),
    };
    const submit = el('button', { class: 'btn btn-primary btn-block', type: 'submit' }, mode === 'signup' ? 'Create store' : 'Log in');
    const form = el('form', {
      class: 'stack',
      onsubmit: async (e) => {
        e.preventDefault();
        submit.disabled = true;
        err.replaceChildren();
        try {
          if (mode === 'signup') {
            await api('POST', '/api/auth/register', { name: f.name.value, email: f.email.value, password: f.password.value, storeName: f.storeName.value });
          } else {
            await api('POST', '/api/auth/login', { email: f.email.value, password: f.password.value });
          }
          location.hash = '#/dashboard';
          await boot();
        } catch (ex) {
          err.replaceChildren(el('div', { class: 'alert error' }, ex.message));
          submit.disabled = false;
        }
      },
    },
      err,
      mode === 'signup' ? [field('Your name', f.name), field('Store name', f.storeName)] : null,
      field('Email', f.email),
      field('Password', f.password, mode === 'signup' ? 'At least 8 characters' : null),
      submit);
    const tab = (m, label) => el('button', { class: 'tab' + (m === mode ? ' on' : ''), type: 'button', onclick: () => { location.hash = m === 'signup' ? '#/signup' : '#/login'; renderAuth(m); } }, label);
    root.replaceChildren(el('div', { class: 'auth-wrap' },
      el('div', { class: 'card auth-card' },
        el('a', { class: 'logo', href: '/', style: { display: 'block', marginBottom: '14px' } }, 'Shop', el('b', null, 'Launch')),
        el('div', { class: 'tabs' }, tab('login', 'Log in'), tab('signup', 'Sign up')),
        form)));
    (mode === 'signup' ? f.name : f.email).focus();
  }

  // ───────────── shell & routing ─────────────
  const NAV = [['dashboard', 'Dashboard'], ['orders', 'Orders'], ['products', 'Products'], ['customers', 'Customers'], ['discounts', 'Discounts'], ['settings', 'Settings']];
  let content;
  let renderId = 0;

  function renderShell() {
    applyAccent(state.store.color);
    document.title = `Admin — ${state.store.name}`;
    content = el('main', { class: 'main' });
    root.replaceChildren(el('div', { class: 'shell' },
      el('aside', { class: 'sidebar' },
        el('a', { class: 'logo', href: '/' }, 'Shop', el('b', null, 'Launch')),
        el('div', { class: 'store-name' }, state.store.name),
        NAV.map(([k, label]) => el('a', { href: '#/' + k, 'data-nav': k }, label)),
        el('a', { href: '/store/' + encodeURIComponent(state.store.slug), target: '_blank', rel: 'noopener' }, 'View storefront ↗'),
        el('div', { class: 'spacer' }),
        el('button', { type: 'button', onclick: async () => { await api('POST', '/api/auth/logout'); location.hash = '#/login'; location.reload(); } }, 'Log out')),
      content));
    window.addEventListener('hashchange', render);
    render();
  }

  async function render() {
    const name = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('?')[0];
    const key = pages[name] ? name : 'dashboard';
    document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('on', a.dataset.nav === key));
    const id = ++renderId;
    content.replaceChildren(el('p', { class: 'muted' }, 'Loading…'));
    try {
      const node = await pages[key]();
      if (id === renderId) content.replaceChildren(node);
    } catch (e) {
      if (e.status === 401) { location.reload(); return; }
      if (id === renderId) content.replaceChildren(el('div', { class: 'alert error' }, e.message));
    }
  }

  const head = (title, ...actions) => el('div', { class: 'page-head' }, el('h2', null, title), el('div', { class: 'row' }, actions));
  const empty = (msg, ...extra) => el('div', { class: 'empty' }, el('p', null, msg), extra);

  async function seedDemo() {
    try {
      const r = await api('POST', '/api/admin/seed');
      toast(`Added ${r.added} sample products and a WELCOME10 code`);
      render();
    } catch (e) { toast(e.message, 'error'); }
  }

  // ───────────── dashboard ─────────────
  async function dashboard() {
    const s = await api('GET', '/api/admin/stats');
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
      days.push({ d, key: d.toDateString(), total: 0, n: 0 });
    }
    for (const o of s.recent) {
      const b = days.find((x) => x.key === new Date(o.created_at * 1000).toDateString());
      if (b) { b.total += o.total; b.n++; }
    }
    const max = Math.max(1, ...days.map((d) => d.total));
    const stat = (n, l) => el('div', { class: 'card stat' }, el('div', { class: 'n' }, n), el('div', { class: 'l' }, l));
    const storeUrl = location.origin + '/store/' + state.store.slug;
    return el('div', null,
      head('Dashboard', el('a', { class: 'btn', href: '/store/' + encodeURIComponent(state.store.slug), target: '_blank', rel: 'noopener' }, 'View storefront ↗')),
      s.products === 0 ? el('div', { class: 'card', style: { marginBottom: '18px' } },
        el('h3', null, 'Welcome! Let’s stock your shop'),
        el('p', { class: 'muted' }, 'Add your first product, or load a few sample products to see how everything works.'),
        el('div', { class: 'row' },
          el('a', { class: 'btn btn-primary', href: '#/products' }, 'Add a product'),
          el('button', { class: 'btn', type: 'button', onclick: seedDemo }, 'Load sample products'))) : null,
      el('div', { class: 'stats' },
        stat(fmt(s.revenue), 'Total sales'), stat(String(s.orders), 'Orders'),
        stat(String(s.open), 'To fulfil'), stat(String(s.products), 'Products')),
      el('div', { class: 'card' }, el('h3', null, 'Sales — last 7 days'),
        el('div', { class: 'chart' }, days.map((d) =>
          el('div', { class: 'col', title: `${d.n} order${d.n === 1 ? '' : 's'} · ${fmt(d.total)}` },
            el('div', { class: 'bar', style: { height: Math.round((d.total / max) * 100) + '%' } }),
              el('span', null, d.d.toLocaleDateString(undefined, { weekday: 'short' })))))),
      el('div', { class: 'two', style: { marginTop: '18px' } },
        el('div', { class: 'card' }, el('h3', null, 'Recent orders'),
          s.latest.length ? el('div', { class: 'table-wrap' }, el('table', null, el('tbody', null, s.latest.map((o) =>
            el('tr', { class: 'click', onclick: () => openOrder(o.id) },
              el('td', null, '#' + o.number), el('td', null, o.name), el('td', null, badge(o.status)), el('td', { class: 'right' }, fmt(o.total))))))) : el('p', { class: 'muted' }, 'No orders yet.')),
        el('div', { class: 'card' }, el('h3', null, 'Low stock'),
          s.lowStock.length ? el('table', null, el('tbody', null, s.lowStock.map((p) =>
            el('tr', null, el('td', null, p.title), el('td', { class: 'right' }, p.inventory === 0 ? el('span', { class: 'badge b-cancelled' }, 'Out of stock') : el('span', { class: 'badge b-pending' }, p.inventory + ' left')))))) : el('p', { class: 'muted' }, 'All products are well stocked.'))),
      el('p', { class: 'muted', style: { marginTop: '18px' } }, 'Your store link: ', el('a', { href: storeUrl, target: '_blank', rel: 'noopener' }, storeUrl)));
  }

  // ───────────── products ─────────────
  function productForm(p, done) {
    const isNew = !p;
    p = p || { title: '', description: '', price: 0, compare_at: null, inventory: 0, category: '', image: '', active: 1 };
    const f = {
      title: el('input', { type: 'text', value: p.title, maxLength: 150, required: true }),
      description: el('textarea', { rows: 5, maxLength: 5000, value: p.description }),
      price: el('input', { type: 'number', step: '0.01', min: '0', value: (p.price / 100).toFixed(2), required: true }),
      compare: el('input', { type: 'number', step: '0.01', min: '0', value: p.compare_at != null ? (p.compare_at / 100).toFixed(2) : '' }),
      inventory: el('input', { type: 'number', step: '1', min: '0', value: String(p.inventory), required: true }),
      category: el('input', { type: 'text', value: p.category, maxLength: 60, placeholder: 'e.g. Apparel' }),
      image: el('input', { type: 'text', value: p.image, placeholder: 'https://… or upload a file' }),
      file: el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif' }),
      active: el('input', { type: 'checkbox', checked: !!p.active }),
    };
    const preview = el('div', { class: 'preview' });
    const showPreview = () => preview.replaceChildren(f.image.value ? el('img', { src: f.image.value, alt: '' }) : '');
    showPreview();
    f.image.addEventListener('change', showPreview);
    f.file.addEventListener('change', async () => {
      const file = f.file.files[0];
      if (!file) return;
      if (file.size > 2 * 1024 * 1024) { toast('Image must be under 2 MB', 'error'); f.file.value = ''; return; }
      const dataUrl = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsDataURL(file); });
      try {
        f.image.value = (await api('POST', '/api/admin/upload', { dataUrl })).url;
        showPreview();
        toast('Image uploaded');
      } catch (e) { toast(e.message, 'error'); }
    });
    let m;
    const save = el('button', { class: 'btn btn-primary', type: 'submit' }, isNew ? 'Add product' : 'Save changes');
    const form = el('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        save.disabled = true;
        const payload = {
          title: f.title.value, description: f.description.value, price: cents(f.price.value),
          compare_at: f.compare.value === '' ? null : cents(f.compare.value),
          inventory: parseInt(f.inventory.value || '0', 10), category: f.category.value, image: f.image.value, active: f.active.checked,
        };
        try {
          await api(isNew ? 'POST' : 'PUT', isNew ? '/api/admin/products' : `/api/admin/products/${p.id}`, payload);
          m.close(); toast('Product saved'); done();
        } catch (ex) { toast(ex.message, 'error'); save.disabled = false; }
      },
    },
      el('div', { class: 'form-grid' },
        el('div', { class: 'full' }, field('Title', f.title)),
        el('div', { class: 'full' }, field('Description', f.description)),
        field(`Price (${state.store.currency})`, f.price),
        field('Compare-at price', f.compare, 'Shown struck through to display a sale'),
        field('Inventory', f.inventory), field('Category', f.category),
        el('div', { class: 'full' }, field('Image URL', f.image), el('div', { style: { marginTop: '8px' } }, f.file), preview),
        el('div', { class: 'full' }, el('label', { class: 'check' }, f.active, ' Visible on storefront'))),
      el('div', { class: 'row end', style: { marginTop: '18px' } },
        el('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancel'), save));
    m = modal(isNew ? 'Add product' : 'Edit product', form, { wide: true });
  }

  async function products() {
    const { products: list } = await api('GET', '/api/admin/products');
    const body = el('tbody');
    const draw = (q) => {
      const rows = list.filter((p) => !q || (p.title + ' ' + p.category).toLowerCase().includes(q.toLowerCase()));
      body.replaceChildren(...rows.map((p) => el('tr', null,
        el('td', { style: { width: '60px' } }, productImage(p, 'thumb')),
        el('td', null, el('strong', null, p.title), p.category ? el('div', { class: 'muted' }, p.category) : null),
        el('td', null, fmt(p.price), p.compare_at ? el('span', { class: 'was' }, fmt(p.compare_at)) : null),
        el('td', null, p.inventory === 0 ? el('span', { class: 'badge b-cancelled' }, 'Out of stock') : p.inventory <= 5 ? el('span', { class: 'badge b-pending' }, p.inventory + ' left') : String(p.inventory)),
        el('td', null, p.active ? el('span', { class: 'badge b-delivered' }, 'Active') : el('span', { class: 'badge' }, 'Hidden')),
        el('td', { class: 'right nowrap' },
          el('button', { class: 'btn-link', type: 'button', onclick: () => productForm(p, render) }, 'Edit'), ' · ',
          el('button', { class: 'btn-link danger', type: 'button', onclick: async () => {
            if (!(await confirmBox(`Delete “${p.title}”? Past orders keep their history.`))) return;
            try { await api('DELETE', `/api/admin/products/${p.id}`); toast('Product deleted'); render(); } catch (e) { toast(e.message, 'error'); }
          } }, 'Delete')))));
      if (!rows.length) body.replaceChildren(el('tr', null, el('td', { colSpan: 6, class: 'empty' }, q ? 'No products match your search.' : 'No products yet.')));
    };
    draw('');
    return el('div', null,
      head('Products',
        list.length === 0 ? el('button', { class: 'btn', type: 'button', onclick: seedDemo }, 'Load sample products') : null,
        el('button', { class: 'btn btn-primary', type: 'button', onclick: () => productForm(null, render) }, '+ Add product')),
      el('div', { class: 'card' },
        el('div', { class: 'toolbar' }, el('input', { type: 'search', placeholder: 'Search products…', oninput: (e) => draw(e.target.value) })),
        el('div', { class: 'table-wrap' }, el('table', null,
          el('thead', null, el('tr', null, ['', 'Product', 'Price', 'Stock', 'Status', ''].map((h) => el('th', null, h)))), body))));
  }

  // ───────────── orders ─────────────
  async function openOrder(id) {
    let data;
    try { data = await api('GET', `/api/admin/orders/${id}`); } catch (e) { toast(e.message, 'error'); return; }
    const { order: o, items } = data;
    const status = el('select', { value: o.status }, STATUSES.map((s) => el('option', { value: s }, s)));
    let m;
    const save = el('button', { class: 'btn btn-primary', type: 'button', onclick: async () => {
      try {
        await api('PUT', `/api/admin/orders/${o.id}`, { status: status.value });
        toast('Order updated'); m.close(); render();
      } catch (e) { toast(e.message, 'error'); }
    } }, 'Update status');
    const line = (l, v, cls) => el('div', { class: cls || '' }, el('span', null, l), el('span', null, v));
    m = modal(`Order #${o.number}`, el('div', { class: 'stack' },
      el('div', { class: 'row between' }, el('span', { class: 'muted' }, date(o.created_at)), badge(o.status)),
      el('div', { class: 'table-wrap' }, el('table', null,
        el('thead', null, el('tr', null, el('th', null, 'Item'), el('th', null, 'Qty'), el('th', { class: 'right' }, 'Total'))),
        el('tbody', null, items.map((i) => el('tr', null, el('td', null, i.title, el('div', { class: 'muted' }, fmt(i.price) + ' each')), el('td', null, String(i.qty)), el('td', { class: 'right' }, fmt(i.price * i.qty))))))),
      el('div', { class: 'totals' },
        line('Subtotal', fmt(o.subtotal)),
        o.discount ? line(`Discount (${o.discount_code})`, '−' + fmt(o.discount)) : null,
        line('Shipping', fmt(o.shipping)), line('Tax', fmt(o.tax)), line('Total', fmt(o.total), 'grand')),
      el('dl', { class: 'kv' },
        el('dt', null, 'Customer'), el('dd', null, o.name),
        el('dt', null, 'Email'), el('dd', null, el('a', { href: 'mailto:' + o.email }, o.email)),
        o.phone ? [el('dt', null, 'Phone'), el('dd', null, o.phone)] : null,
        el('dt', null, 'Ship to'), el('dd', null, `${o.address}, ${o.city} ${o.zip}, ${o.country}`),
        el('dt', null, 'Payment'), el('dd', null, o.payment === 'cod' ? 'Cash on delivery' : 'Paid online (demo gateway)'),
        o.notes ? [el('dt', null, 'Notes'), el('dd', null, o.notes)] : null),
      el('div', { class: 'row end' }, status, save)), { wide: true });
  }

  async function orders() {
    const filter = el('select', { onchange: load }, el('option', { value: '' }, 'All statuses'), STATUSES.map((s) => el('option', { value: s }, s)));
    const body = el('tbody');
    async function load() {
      const { orders: list } = await api('GET', '/api/admin/orders' + (filter.value ? '?status=' + filter.value : ''));
      body.replaceChildren(...(list.length ? list.map((o) => el('tr', { class: 'click', onclick: () => openOrder(o.id) },
        el('td', null, el('strong', null, '#' + o.number)), el('td', { class: 'nowrap' }, date(o.created_at)),
        el('td', null, o.name, el('div', { class: 'muted' }, o.email)), el('td', null, String(o.items)),
        el('td', null, badge(o.status)), el('td', { class: 'right' }, fmt(o.total)))) : [el('tr', null, el('td', { colSpan: 6, class: 'empty' }, 'No orders found.'))]));
    }
    await load();
    return el('div', null, head('Orders'),
      el('div', { class: 'card' }, el('div', { class: 'toolbar' }, filter),
        el('div', { class: 'table-wrap' }, el('table', null,
          el('thead', null, el('tr', null, ['Order', 'Date', 'Customer', 'Items', 'Status', 'Total'].map((h, i) => el('th', { class: i === 5 ? 'right' : '' }, h)))), body))));
  }

  // ───────────── customers ─────────────
  async function customers() {
    const { customers: list } = await api('GET', '/api/admin/customers');
    return el('div', null, head('Customers'), el('div', { class: 'card' },
      list.length ? el('div', { class: 'table-wrap' }, el('table', null,
        el('thead', null, el('tr', null, ['Customer', 'Orders', 'Total spent', 'Last order'].map((h) => el('th', null, h)))),
        el('tbody', null, list.map((c) => el('tr', null,
          el('td', null, el('strong', null, c.name), el('div', { class: 'muted' }, c.email)),
          el('td', null, String(c.orders)), el('td', null, fmt(c.spent)), el('td', null, dateShort(c.last_order))))))) :
        empty('Customers appear here after their first order.')));
  }

  // ───────────── discounts ─────────────
  async function discounts() {
    const { discounts: list } = await api('GET', '/api/admin/discounts');
    const f = {
      code: el('input', { type: 'text', required: true, minLength: 3, maxLength: 30, placeholder: 'SUMMER20', style: { textTransform: 'uppercase' } }),
      type: el('select', { value: 'percent' }, el('option', { value: 'percent' }, 'Percentage off'), el('option', { value: 'fixed' }, `Fixed amount (${state.store.currency})`)),
      value: el('input', { type: 'number', required: true, min: '0.01', step: '0.01', placeholder: '10' }),
      max: el('input', { type: 'number', min: '0', step: '1', value: '0' }),
    };
    const form = el('form', {
      class: 'form-grid',
      style: { gridTemplateColumns: '1.3fr 1.3fr 1fr 1fr auto', alignItems: 'end' },
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await api('POST', '/api/admin/discounts', {
            code: f.code.value, type: f.type.value,
            value: f.type.value === 'percent' ? Math.round(parseFloat(f.value.value)) : cents(f.value.value),
            max_uses: parseInt(f.max.value || '0', 10),
          });
          toast('Discount created'); render();
        } catch (ex) { toast(ex.message, 'error'); }
      },
    }, field('Code', f.code), field('Type', f.type), field('Value', f.value), field('Max uses', f.max, '0 = unlimited'),
      el('button', { class: 'btn btn-primary', type: 'submit', style: { marginBottom: '22px' } }, 'Add'));
    return el('div', null, head('Discounts'),
      el('div', { class: 'card' }, el('h3', null, 'Create discount code'), form),
      el('div', { class: 'card' }, el('h3', null, 'Your codes'),
        list.length ? el('div', { class: 'table-wrap' }, el('table', null,
          el('thead', null, el('tr', null, ['Code', 'Discount', 'Used', 'Status', ''].map((h) => el('th', null, h)))),
          el('tbody', null, list.map((d) => el('tr', null,
            el('td', null, el('strong', null, d.code)),
            el('td', null, d.type === 'percent' ? d.value + '% off' : fmt(d.value) + ' off'),
            el('td', null, d.uses + (d.max_uses ? ' / ' + d.max_uses : '')),
            el('td', null, d.active ? el('span', { class: 'badge b-delivered' }, 'Active') : el('span', { class: 'badge' }, 'Paused')),
            el('td', { class: 'right nowrap' },
              el('button', { class: 'btn-link', type: 'button', onclick: async () => { await api('PUT', `/api/admin/discounts/${d.id}`, { active: !d.active }); render(); } }, d.active ? 'Pause' : 'Resume'), ' · ',
              el('button', { class: 'btn-link danger', type: 'button', onclick: async () => { if (await confirmBox(`Delete code ${d.code}?`)) { await api('DELETE', `/api/admin/discounts/${d.id}`); render(); } } }, 'Delete'))))))) :
          empty('No discount codes yet.')));
  }

  // ───────────── settings ─────────────
  async function settings() {
    const s = state.store;
    const f = {
      name: el('input', { type: 'text', value: s.name, required: true, minLength: 2, maxLength: 60 }),
      tagline: el('input', { type: 'text', value: s.tagline, maxLength: 140, placeholder: 'A short line shown on your storefront' }),
      currency: el('select', { value: s.currency }, ['USD', 'EUR', 'GBP', 'INR', 'AUD', 'CAD', 'SGD', 'AED'].map((c) => el('option', { value: c }, c))),
      color: el('input', { type: 'color', value: s.color }),
      tax: el('input', { type: 'number', step: '0.01', min: '0', max: '50', value: String(s.tax_rate) }),
      shipping: el('input', { type: 'number', step: '0.01', min: '0', value: (s.shipping_flat / 100).toFixed(2) }),
      free: el('input', { type: 'number', step: '0.01', min: '0', value: (s.free_shipping_over / 100).toFixed(2) }),
    };
    const form = el('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          const r = await api('PUT', '/api/admin/store', {
            name: f.name.value, tagline: f.tagline.value, currency: f.currency.value, color: f.color.value,
            tax_rate: parseFloat(f.tax.value || '0'), shipping_flat: cents(f.shipping.value || '0'), free_shipping_over: cents(f.free.value || '0'),
          });
          state.store = r.store; applyAccent(state.store.color); toast('Settings saved');
          document.querySelector('.store-name').textContent = state.store.name;
        } catch (ex) { toast(ex.message, 'error'); }
      },
    },
      el('div', { class: 'form-grid' },
        field('Store name', f.name), field('Tagline', f.tagline),
        field('Currency', f.currency), field('Brand colour', f.color),
        field('Sales tax (%)', f.tax, 'Added on top of the discounted subtotal'),
        field('Flat shipping rate', f.shipping),
        field('Free shipping over', f.free, 'Set to 0 to disable free shipping')),
      el('div', { class: 'row end', style: { marginTop: '18px' } }, el('button', { class: 'btn btn-primary', type: 'submit' }, 'Save settings')));
    return el('div', null, head('Settings'),
      el('div', { class: 'card' }, el('h3', null, 'Store details'), form),
      el('div', { class: 'card' }, el('h3', null, 'Account'),
        el('p', { class: 'muted' }, `Signed in as ${state.user.name} (${state.user.email}).`),
        el('button', { class: 'btn', type: 'button', onclick: seedDemo }, 'Add sample products')));
  }

  const pages = { dashboard, orders, products, customers, discounts, settings };

  async function boot() {
    try {
      const me = await api('GET', '/api/admin/me');
      state.user = me.user; state.store = me.store;
      renderShell();
    } catch (e) {
      if (e.status === 401) renderAuth(location.hash === '#/signup' ? 'signup' : 'login');
      else root.replaceChildren(el('div', { class: 'alert error', style: { margin: '30px' } }, e.message));
    }
  }
  boot();
})();
