'use strict';
// End-to-end API test. Starts the server on a temp database and walks through the real flow.
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const assert = require('node:assert/strict');

const PORT = 3999;
const BASE = `http://localhost:${PORT}`;
const dbFile = path.join(os.tmpdir(), `shoplaunch-test-${Date.now()}.db`);
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, 'server.js')], {
  env: { ...process.env, PORT: String(PORT), DB_FILE: dbFile }, stdio: ['ignore', 'pipe', 'inherit'],
});

let cookie = '';
async function call(method, url, body, { auth = true, headers = {} } = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(auth && cookie ? { Cookie: cookie } : {}), ...headers },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const sc = res.headers.get('set-cookie');
  if (sc && auth) cookie = sc.split(';')[0];
  let data = null;
  try { data = await res.json(); } catch { /* not json */ }
  return { status: res.status, data };
}

let passed = 0;
async function step(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); }
  catch (e) { console.log('  ✗', name, '\n    ', e.message); process.exitCode = 1; throw e; }
}

(async () => {
  await new Promise((r) => server.stdout.once('data', r));
  const slugRes = {};
  try {
    console.log('API tests');
    await step('rejects unauthenticated admin access', async () => {
      assert.equal((await call('GET', '/api/admin/me', null, { auth: false })).status, 401);
    });
    await step('register creates account + store', async () => {
      const r = await call('POST', '/api/auth/register', { name: 'Asha', email: 'asha@example.com', password: 'supersecret1', storeName: 'Chennai Goods' });
      assert.equal(r.status, 200);
      const me = await call('GET', '/api/admin/me');
      assert.equal(me.data.store.slug, 'chennai-goods');
      slugRes.slug = me.data.store.slug;
    });
    await step('duplicate email rejected', async () => {
      const r = await call('POST', '/api/auth/register', { name: 'X', email: 'asha@example.com', password: 'supersecret1', storeName: 'Other' }, { auth: false });
      assert.equal(r.status, 409);
    });
    await step('weak password rejected', async () => {
      const r = await call('POST', '/api/auth/register', { name: 'X', email: 'x@example.com', password: 'short', storeName: 'Other' }, { auth: false });
      assert.equal(r.status, 400);
    });
    await step('CSRF: non-JSON content type rejected', async () => {
      const res = await fetch(BASE + '/api/admin/store', { method: 'PUT', headers: { 'Content-Type': 'text/plain', Cookie: cookie }, body: '{}' });
      assert.equal(res.status, 415);
    });
    await step('CSRF: foreign Origin rejected', async () => {
      const r = await call('POST', '/api/auth/logout', {}, { headers: { Origin: 'http://evil.example' } });
      assert.equal(r.status, 403);
    });
    await step('update store settings (tax 10%, ship 5.00, free over 50)', async () => {
      const r = await call('PUT', '/api/admin/store', { name: 'Chennai Goods', tagline: 'Made here', currency: 'INR', color: '#0a7d5a', tax_rate: 10, shipping_flat: 500, free_shipping_over: 5000 });
      assert.equal(r.status, 200);
      assert.equal(r.data.store.currency, 'INR');
    });
    let tee, mug;
    await step('create products + validation', async () => {
      assert.equal((await call('POST', '/api/admin/products', { title: '', price: 100, inventory: 1 })).status, 400);
      assert.equal((await call('POST', '/api/admin/products', { title: 'X', price: -1, inventory: 1 })).status, 400);
      assert.equal((await call('POST', '/api/admin/products', { title: 'X', price: 1, inventory: 1, image: 'javascript:alert(1)' })).status, 400);
      tee = (await call('POST', '/api/admin/products', { title: 'Tee', description: 'Soft', price: 2000, inventory: 5, category: 'Apparel', active: true })).data.id;
      mug = (await call('POST', '/api/admin/products', { title: 'Mug', price: 1500, compare_at: 2000, inventory: 2, category: 'Home', active: true })).data.id;
      await call('POST', '/api/admin/products', { title: 'Hidden', price: 100, inventory: 9, active: false });
      assert.ok(tee && mug);
    });
    await step('seed endpoint adds sample products + WELCOME10', async () => {
      assert.equal((await call('POST', '/api/admin/seed', {})).data.added, 8);
    });
    await step('create discount codes (SAVE5 fixed, TEN percent)', async () => {
      assert.equal((await call('POST', '/api/admin/discounts', { code: 'save5', type: 'fixed', value: 500, max_uses: 1 })).status, 200);
      assert.equal((await call('POST', '/api/admin/discounts', { code: 'save5', type: 'fixed', value: 500 })).status, 409);
      assert.equal((await call('POST', '/api/admin/discounts', { code: 'bad code!', type: 'fixed', value: 1 })).status, 400);
    });
    await step('storefront lists only active products; search/filter/sort work', async () => {
      const all = (await call('GET', `/api/shop/${slugRes.slug}/products?limit=60`, null, { auth: false })).data;
      assert.equal(all.total, 10);
      assert.ok(!all.products.some((p) => p.title === 'Hidden'));
      assert.ok(all.categories.includes('Apparel'));
      const s = (await call('GET', `/api/shop/${slugRes.slug}/products?q=mug`, null, { auth: false })).data;
      assert.ok(s.products.every((p) => /mug/i.test(p.title + p.description)));
      const pct = (await call('GET', `/api/shop/${slugRes.slug}/products?q=${encodeURIComponent('100%')}`, null, { auth: false })).data;
      assert.equal(pct.total, 1); // only "100% cotton" tee — % is escaped, not a wildcard
      const asc = (await call('GET', `/api/shop/${slugRes.slug}/products?sort=price_asc`, null, { auth: false })).data.products;
      for (let i = 1; i < asc.length; i++) assert.ok(asc[i - 1].price <= asc[i].price);
    });
    await step('quote computes totals server-side (ignores client prices)', async () => {
      const q = (await call('POST', `/api/shop/${slugRes.slug}/quote`, { items: [{ id: tee, qty: 2, price: 1 }] }, { auth: false })).data;
      assert.equal(q.subtotal, 4000);
      assert.equal(q.shipping, 500);       // below free-shipping threshold
      assert.equal(q.tax, 400);            // 10%
      assert.equal(q.total, 4900);
    });
    await step('quote clamps to stock and reports notes', async () => {
      const q = (await call('POST', `/api/shop/${slugRes.slug}/quote`, { items: [{ id: mug, qty: 9 }] }, { auth: false })).data;
      assert.equal(q.lines[0].qty, 2);
      assert.equal(q.notes.length, 1);
    });
    await step('free shipping + percent discount', async () => {
      const q = (await call('POST', `/api/shop/${slugRes.slug}/quote`, { items: [{ id: tee, qty: 3 }], code: 'welcome10' }, { auth: false })).data;
      assert.equal(q.subtotal, 6000);
      assert.equal(q.discount, 600);
      assert.equal(q.shipping, 0);         // 5400 >= 5000
      assert.equal(q.tax, 540);
      assert.equal(q.total, 5940);
    });
    await step('checkout validates customer details', async () => {
      const r = await call('POST', `/api/shop/${slugRes.slug}/checkout`, { items: [{ id: tee, qty: 1 }], name: 'B', email: 'nope' }, { auth: false });
      assert.equal(r.status, 400);
    });
    let token;
    const cust = { name: 'Ravi Kumar', email: 'Ravi@Example.com', phone: '9999999999', address: '12 Main Road', city: 'Chennai', zip: '600001', country: 'India' };
    await step('checkout creates order, decrements stock, uses discount', async () => {
      const r = await call('POST', `/api/shop/${slugRes.slug}/checkout`, { ...cust, items: [{ id: tee, qty: 2 }], code: 'save5', payment: 'demo' }, { auth: false });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      token = r.data.token;
      assert.equal(r.data.number, 1001);
      // subtotal 4000 - 500 = 3500; shipping 500; tax 350 → 4350
      assert.equal(r.data.total, 4350);
      const p = (await call('GET', `/api/shop/${slugRes.slug}/products/${tee}`, null, { auth: false })).data.product;
      assert.equal(p.inventory, 3);
    });
    await step('single-use discount cannot be reused', async () => {
      const r = await call('POST', `/api/shop/${slugRes.slug}/checkout`, { ...cust, items: [{ id: tee, qty: 1 }], code: 'save5' }, { auth: false });
      assert.equal(r.status, 400);
    });
    await step('cannot oversell: checkout beyond stock → 409, stock unchanged', async () => {
      const r = await call('POST', `/api/shop/${slugRes.slug}/checkout`, { ...cust, items: [{ id: mug, qty: 3 }] }, { auth: false });
      assert.equal(r.status, 409);
      const p = (await call('GET', `/api/shop/${slugRes.slug}/products/${mug}`, null, { auth: false })).data.product;
      assert.equal(p.inventory, 2);
    });
    await step('order lookup by secret token only', async () => {
      const r = await call('GET', `/api/shop/${slugRes.slug}/orders/${token}`, null, { auth: false });
      assert.equal(r.data.order.status, 'paid');
      assert.equal(r.data.items[0].qty, 2);
      assert.equal((await call('GET', `/api/shop/${slugRes.slug}/orders/${'0'.repeat(32)}`, null, { auth: false })).status, 404);
    });
    let cod;
    await step('cash-on-delivery order starts as pending', async () => {
      const r = await call('POST', `/api/shop/${slugRes.slug}/checkout`, { ...cust, items: [{ id: mug, qty: 2 }], payment: 'cod' }, { auth: false });
      cod = r.data;
      const o = (await call('GET', `/api/shop/${slugRes.slug}/orders/${cod.token}`, null, { auth: false })).data.order;
      assert.equal(o.status, 'pending');
    });
    await step('admin sees orders, stats and customers', async () => {
      const orders = (await call('GET', '/api/admin/orders')).data.orders;
      assert.equal(orders.length, 2);
      const stats = (await call('GET', '/api/admin/stats')).data;
      assert.equal(stats.orders, 2);
      assert.equal(stats.open, 2);
      assert.ok(stats.lowStock.some((p) => p.title === 'Mug'));
      const customers = (await call('GET', '/api/admin/customers')).data.customers;
      assert.equal(customers.length, 1);        // same email, different case → one customer
      assert.equal(customers[0].orders, 2);
    });
    await step('cancelling an order restocks; reopening re-deducts', async () => {
      const id = (await call('GET', '/api/admin/orders')).data.orders.find((o) => o.payment === 'cod').id;
      assert.equal((await call('PUT', `/api/admin/orders/${id}`, { status: 'cancelled' })).status, 200);
      let p = (await call('GET', `/api/shop/${slugRes.slug}/products/${mug}`, null, { auth: false })).data.product;
      assert.equal(p.inventory, 2);
      assert.equal((await call('PUT', `/api/admin/orders/${id}`, { status: 'shipped' })).status, 200);
      p = (await call('GET', `/api/shop/${slugRes.slug}/products/${mug}`, null, { auth: false })).data.product;
      assert.equal(p.inventory, 0);
      assert.equal((await call('PUT', `/api/admin/orders/${id}`, { status: 'bogus' })).status, 400);
    });
    await step('deleting a product keeps order history', async () => {
      assert.equal((await call('DELETE', `/api/admin/products/${tee}`, {})).status, 200);
      const orders = (await call('GET', '/api/admin/orders')).data.orders;
      const id = orders.find((o) => o.payment === 'demo').id;
      const d = (await call('GET', `/api/admin/orders/${id}`)).data;
      assert.equal(d.items[0].title, 'Tee');
    });
    await step('tenant isolation: another merchant cannot touch these products/orders', async () => {
      const saved = cookie; cookie = '';
      await call('POST', '/api/auth/register', { name: 'Eve', email: 'eve@example.com', password: 'supersecret2', storeName: 'Eve Shop' });
      assert.equal((await call('DELETE', `/api/admin/products/${mug}`, {})).status, 404);
      assert.equal((await call('PUT', `/api/admin/products/${mug}`, { title: 'pwned', price: 1, inventory: 1 })).status, 404);
      const o = (await call('GET', '/api/admin/orders')).data.orders;
      assert.equal(o.length, 0);
      assert.equal((await call('GET', '/api/admin/orders/1')).status, 404);
      cookie = saved;
    });
    await step('login works, wrong password fails, logout invalidates session', async () => {
      assert.equal((await call('POST', '/api/auth/login', { email: 'asha@example.com', password: 'wrong-pass' }, { auth: false })).status, 401);
      const r = await call('POST', '/api/auth/login', { email: 'ASHA@example.com', password: 'supersecret1' });
      assert.equal(r.status, 200);
      await call('POST', '/api/auth/logout', {});
      assert.equal((await call('GET', '/api/admin/me')).status, 401);
    });
    await step('static pages and path traversal protection', async () => {
      for (const p of ['/', '/admin', `/store/${slugRes.slug}`, '/assets/common.js']) {
        const res = await fetch(BASE + p);
        assert.equal(res.status, 200, p);
      }
      for (const p of ['/assets/../server.js', '/assets/%2e%2e/server.js', '/uploads/../shop.db', '/server.js']) {
        const res = await fetch(BASE + p);
        assert.ok([403, 404].includes(res.status), `${p} → ${res.status}`);
      }
    });
    console.log(`\nAll ${passed} checks passed.`);
  } catch (e) {
    console.log('\nFAILED:', e.message);
    process.exitCode = 1;
  } finally {
    server.kill();
    for (const f of [dbFile, dbFile + '-wal', dbFile + '-shm']) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
  }
})();
