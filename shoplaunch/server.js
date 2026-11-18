'use strict';
/*
 * ShopLaunch — a small Shopify-style commerce platform.
 * Multi-store, zero dependencies. Requires Node 22.5+ (uses the built-in node:sqlite).
 *
 *   node --disable-warning=ExperimentalWarning server.js
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const CURRENCIES = ['USD', 'EUR', 'GBP', 'INR', 'AUD', 'CAD', 'SGD', 'AED'];
const ORDER_STATUSES = ['pending', 'paid', 'shipped', 'delivered', 'cancelled'];

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ───────────────────────────── database ─────────────────────────────
const db = new DatabaseSync(process.env.DB_FILE || path.join(ROOT, 'shop.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS stores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  tagline TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL DEFAULT 'USD',
  color TEXT NOT NULL DEFAULT '#5b5bd6',
  tax_rate REAL NOT NULL DEFAULT 0,
  shipping_flat INTEGER NOT NULL DEFAULT 0,
  free_shipping_over INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price INTEGER NOT NULL,
  compare_at INTEGER,
  inventory INTEGER NOT NULL DEFAULT 0,
  category TEXT NOT NULL DEFAULT '',
  image TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_products_store ON products(store_id, active);
CREATE TABLE IF NOT EXISTS discounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('percent','fixed')),
  value INTEGER NOT NULL,
  max_uses INTEGER NOT NULL DEFAULT 0,
  uses INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  UNIQUE (store_id, code)
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  payment TEXT NOT NULL,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL,
  city TEXT NOT NULL,
  zip TEXT NOT NULL,
  country TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  discount_code TEXT,
  subtotal INTEGER NOT NULL,
  discount INTEGER NOT NULL,
  shipping INTEGER NOT NULL,
  tax INTEGER NOT NULL,
  total INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (store_id, number)
);
CREATE INDEX IF NOT EXISTS idx_orders_store ON orders(store_id, created_at);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  price INTEGER NOT NULL,
  qty INTEGER NOT NULL
);
`);
db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());

const now = () => Math.floor(Date.now() / 1000);

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

// ───────────────────────────── helpers ─────────────────────────────
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);

function str(v, name, { min = 0, max = 200 } = {}) {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string') throw bad(`${name} must be text`);
  v = v.trim();
  if (v.length < min) throw bad(min <= 1 ? `${name} is required` : `${name} must be at least ${min} characters`);
  if (v.length > max) throw bad(`${name} is too long (max ${max} characters)`);
  return v;
}
function int(v, name, { min = 0, max = 1e9 } = {}) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (!Number.isInteger(n)) throw bad(`${name} must be a whole number`);
  if (n < min || n > max) throw bad(`${name} must be between ${min} and ${max}`);
  return n;
}
function readEmail(v) {
  const e = str(v, 'Email', { min: 1, max: 254 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) throw bad('Enter a valid email address');
  return e;
}
function slugify(s) {
  return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'store';
}
function uniqueSlug(base) {
  let slug = base, i = 1;
  while (db.prepare('SELECT 1 FROM stores WHERE slug = ?').get(slug)) slug = `${base}-${++i}`;
  return slug;
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `${salt.toString('hex')}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
const DUMMY_HASH = hashPassword('dummy-password-for-timing');
function verifyPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  const got = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64);
  const want = Buffer.from(hash, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

const attempts = new Map();
function throttle(key, max, windowMs) {
  const t = Date.now();
  const list = (attempts.get(key) || []).filter((x) => t - x < windowMs);
  if (list.length >= max) throw new HttpError(429, 'Too many attempts. Please try again later.');
  list.push(t);
  attempts.set(key, list);
}
setInterval(() => {
  const t = Date.now();
  for (const [k, v] of attempts) if (!v.some((x) => t - x < 3600e3)) attempts.delete(k);
}, 600e3).unref();

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
function clientIp(req) {
  if (TRUST_PROXY) {
    const xf = req.headers['x-forwarded-for'];
    if (xf) return String(xf).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}
function setSessionCookie(req, res, token, maxAge) {
  const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`);
}
function createSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const maxAge = 30 * 24 * 3600;
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(sha(token), userId, Date.now() + maxAge * 1000);
  setSessionCookie(req, res, token, maxAge);
}
function getAuth(req) {
  const token = parseCookies(req.headers.cookie).sid;
  if (!token) return {};
  const user = db.prepare(
    `SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha(token), Date.now());
  if (!user) return {};
  const store = db.prepare('SELECT * FROM stores WHERE user_id = ?').get(user.id);
  return { user, store };
}

const publicStore = (s) => ({
  name: s.name, slug: s.slug, tagline: s.tagline, currency: s.currency, color: s.color,
  tax_rate: s.tax_rate, shipping_flat: s.shipping_flat, free_shipping_over: s.free_shipping_over,
});

function readImage(v) {
  if (v === undefined || v === null || v === '') return '';
  v = str(v, 'Image', { max: 500 });
  if (/^\/uploads\/[a-f0-9]{32}\.(png|jpg|webp|gif)$/.test(v) || /^\/assets\/products\/[a-z-]+\.svg$/.test(v) || /^https:\/\/[^\s"'<>]+$/.test(v)) return v;
  throw bad('Image must be an uploaded file or an https:// URL');
}
function readProduct(b) {
  const compare = b.compare_at === null || b.compare_at === undefined || b.compare_at === ''
    ? null : int(b.compare_at, 'Compare-at price', { min: 0, max: 1e8 });
  return {
    title: str(b.title, 'Title', { min: 1, max: 150 }),
    description: str(b.description, 'Description', { max: 5000 }),
    price: int(b.price, 'Price', { min: 0, max: 1e8 }),
    compare_at: compare,
    inventory: int(b.inventory, 'Inventory', { min: 0, max: 1e6 }),
    category: str(b.category, 'Category', { max: 60 }),
    image: readImage(b.image),
    active: b.active ? 1 : 0,
  };
}
const productCols = 'id, title, description, price, compare_at, inventory, category, image';

// ───────────────────────────── cart pricing ─────────────────────────────
/**
 * Prices are always computed on the server from the database — the client only
 * sends product ids, quantities and a discount code.
 * strict=false → adjusts the cart (clamps quantities, drops unavailable items) and reports notes.
 * strict=true  → used at checkout; any problem is an error.
 */
function computeCart(store, items, code, strict) {
  if (!Array.isArray(items)) throw bad('Cart must be a list');
  if (items.length > 50) throw bad('Too many items in cart');
  const merged = new Map();
  for (const it of items) {
    const id = it && Number.isInteger(it.id) ? it.id : null;
    const qty = it && Number.isInteger(it.qty) ? it.qty : null;
    if (id === null || qty === null || id < 1 || qty < 1) {
      if (strict) throw bad('Cart contains an invalid item');
      continue;
    }
    merged.set(id, Math.min(99, (merged.get(id) || 0) + qty));
  }
  const find = db.prepare('SELECT * FROM products WHERE id = ? AND store_id = ? AND active = 1');
  const lines = [], notes = [];
  let subtotal = 0;
  for (const [id, want] of merged) {
    const p = find.get(id, store.id);
    if (!p) { notes.push({ id, message: 'An item in your cart is no longer available and was removed.' }); continue; }
    if (p.inventory <= 0) { notes.push({ id, message: `${p.title} is out of stock and was removed.` }); continue; }
    let qty = want;
    if (qty > p.inventory) {
      qty = p.inventory;
      notes.push({ id, message: `Only ${p.inventory} of ${p.title} ${p.inventory === 1 ? 'is' : 'are'} available.` });
    }
    lines.push({ id: p.id, title: p.title, price: p.price, image: p.image, qty, inventory: p.inventory, total: p.price * qty });
    subtotal += p.price * qty;
  }
  if (strict && notes.length) throw new HttpError(409, `${notes[0].message} Please review your cart.`);
  if (strict && lines.length === 0) throw bad('Your cart is empty');

  let discount = 0, discountCode = null, discountError = null;
  const raw = typeof code === 'string' ? code.trim().toUpperCase() : '';
  if (raw) {
    const d = db.prepare('SELECT * FROM discounts WHERE store_id = ? AND code = ? AND active = 1').get(store.id, raw);
    if (!d) discountError = 'That discount code is not valid.';
    else if (d.max_uses > 0 && d.uses >= d.max_uses) discountError = 'That discount code has been fully redeemed.';
    else {
      discount = d.type === 'percent' ? Math.floor((subtotal * d.value) / 100) : Math.min(d.value, subtotal);
      discountCode = d.code;
    }
  }
  if (strict && discountError) throw bad(discountError);

  const net = subtotal - discount;
  const shipping = lines.length === 0 ? 0
    : (store.free_shipping_over > 0 && net >= store.free_shipping_over ? 0 : store.shipping_flat);
  const tax = Math.round((net * store.tax_rate) / 100);
  return { lines, notes, subtotal, discount, discountCode, discountError, shipping, tax, total: net + shipping + tax };
}

// ───────────────────────────── routing ─────────────────────────────
const routes = [];
function route(method, pattern, opts, handler) {
  if (typeof opts === 'function') { handler = opts; opts = {}; }
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:([a-z]+)/gi, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  routes.push({ method, re, keys, opts, handler });
}

// ── auth ──
route('POST', '/api/auth/register', (ctx) => {
  const b = ctx.body;
  throttle('reg:' + ctx.ip, 20, 3600e3);
  const name = str(b.name, 'Your name', { min: 1, max: 80 });
  const email = readEmail(b.email);
  if (typeof b.password !== 'string' || b.password.length < 8 || b.password.length > 200) {
    throw bad('Password must be at least 8 characters');
  }
  const storeName = str(b.storeName, 'Store name', { min: 2, max: 60 });
  const result = tx(() => {
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
      throw new HttpError(409, 'An account with that email already exists.');
    }
    const u = db.prepare('INSERT INTO users (email, name, pass_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(email, name, hashPassword(b.password), now());
    const slug = uniqueSlug(slugify(storeName));
    db.prepare('INSERT INTO stores (user_id, slug, name, created_at) VALUES (?, ?, ?, ?)')
      .run(u.lastInsertRowid, slug, storeName, now());
    return { id: Number(u.lastInsertRowid), slug };
  });
  createSession(ctx.req, ctx.res, result.id);
  return { ok: true };
});

route('POST', '/api/auth/login', (ctx) => {
  const email = typeof ctx.body.email === 'string' ? ctx.body.email.trim().toLowerCase() : '';
  const password = typeof ctx.body.password === 'string' ? ctx.body.password : '';
  const key = `login:${ctx.ip}:${email}`;
  throttle(key, 10, 15 * 60e3);
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  const ok = verifyPassword(password, u ? u.pass_hash : DUMMY_HASH) && u;
  if (!ok) throw new HttpError(401, 'Incorrect email or password.');
  attempts.delete(key);
  createSession(ctx.req, ctx.res, u.id);
  return { ok: true };
});

route('POST', '/api/auth/logout', (ctx) => {
  const token = parseCookies(ctx.req.headers.cookie).sid;
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
  setSessionCookie(ctx.req, ctx.res, '', 0);
  return { ok: true };
});

// ── admin: account & store ──
route('GET', '/api/admin/me', { auth: true }, ({ user, store }) => ({
  user: { name: user.name, email: user.email }, store: publicStore(store),
}));

route('PUT', '/api/admin/store', { auth: true }, ({ body: b, store }) => {
  const name = str(b.name, 'Store name', { min: 2, max: 60 });
  const tagline = str(b.tagline, 'Tagline', { max: 140 });
  const currency = String(b.currency || '');
  if (!CURRENCIES.includes(currency)) throw bad('Unsupported currency');
  const color = String(b.color || '');
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw bad('Color must look like #5b5bd6');
  const tax = Number(b.tax_rate);
  if (!Number.isFinite(tax) || tax < 0 || tax > 50) throw bad('Tax rate must be between 0 and 50');
  const shipping = int(b.shipping_flat, 'Shipping', { min: 0, max: 1e7 });
  const free = int(b.free_shipping_over, 'Free shipping threshold', { min: 0, max: 1e8 });
  db.prepare(`UPDATE stores SET name=?, tagline=?, currency=?, color=?, tax_rate=?, shipping_flat=?, free_shipping_over=? WHERE id=?`)
    .run(name, tagline, currency, color, tax, shipping, free, store.id);
  return { store: publicStore(db.prepare('SELECT * FROM stores WHERE id = ?').get(store.id)) };
});

route('GET', '/api/admin/stats', { auth: true }, ({ store }) => {
  const since = now() - 7 * 86400;
  const sums = db.prepare(
    `SELECT COUNT(*) AS orders, COALESCE(SUM(total), 0) AS revenue
     FROM orders WHERE store_id = ? AND status != 'cancelled'`).get(store.id);
  const open = db.prepare(
    `SELECT COUNT(*) AS n FROM orders WHERE store_id = ? AND status IN ('pending','paid')`).get(store.id).n;
  const products = db.prepare('SELECT COUNT(*) AS n FROM products WHERE store_id = ?').get(store.id).n;
  const lowStock = db.prepare(
    `SELECT id, title, inventory FROM products WHERE store_id = ? AND active = 1 AND inventory <= 5
     ORDER BY inventory ASC, title LIMIT 8`).all(store.id);
  const recent = db.prepare(
    `SELECT created_at, total FROM orders WHERE store_id = ? AND status != 'cancelled' AND created_at >= ?
     ORDER BY created_at DESC LIMIT 2000`).all(store.id, since);
  const latest = db.prepare(
    `SELECT id, number, name, total, status, created_at FROM orders WHERE store_id = ?
     ORDER BY created_at DESC, id DESC LIMIT 6`).all(store.id);
  return { revenue: sums.revenue, orders: sums.orders, open, products, lowStock, recent, latest };
});

// ── admin: products ──
route('GET', '/api/admin/products', { auth: true }, ({ store }) => ({
  products: db.prepare(`SELECT ${productCols}, active, created_at FROM products WHERE store_id = ? ORDER BY id DESC`).all(store.id),
}));

route('POST', '/api/admin/products', { auth: true }, ({ body, store }) => {
  const p = readProduct(body);
  const count = db.prepare('SELECT COUNT(*) AS n FROM products WHERE store_id = ?').get(store.id).n;
  if (count >= 5000) throw bad('Product limit reached');
  const r = db.prepare(
    `INSERT INTO products (store_id, title, description, price, compare_at, inventory, category, image, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(store.id, p.title, p.description, p.price, p.compare_at, p.inventory, p.category, p.image, p.active, now());
  return { id: Number(r.lastInsertRowid) };
});

route('PUT', '/api/admin/products/:id', { auth: true }, ({ params, body, store }) => {
  const p = readProduct(body);
  const r = db.prepare(
    `UPDATE products SET title=?, description=?, price=?, compare_at=?, inventory=?, category=?, image=?, active=?
     WHERE id = ? AND store_id = ?`)
    .run(p.title, p.description, p.price, p.compare_at, p.inventory, p.category, p.image, p.active, Number(params.id), store.id);
  if (r.changes !== 1) throw new HttpError(404, 'Product not found');
  return { ok: true };
});

route('DELETE', '/api/admin/products/:id', { auth: true }, ({ params, store }) => {
  const r = db.prepare('DELETE FROM products WHERE id = ? AND store_id = ?').run(Number(params.id), store.id);
  if (r.changes !== 1) throw new HttpError(404, 'Product not found');
  return { ok: true };
});

route('POST', '/api/admin/upload', { auth: true, limit: 4 * 1024 * 1024 }, ({ body }) => {
  const m = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(typeof body.dataUrl === 'string' ? body.dataUrl : '');
  if (!m) throw bad('Upload a PNG, JPEG, WebP or GIF image');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 2.5 * 1024 * 1024) throw bad('Image must be under 2 MB');
  const magic = {
    png: buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
    jpeg: buf[0] === 0xff && buf[1] === 0xd8,
    gif: buf.subarray(0, 3).toString('latin1') === 'GIF',
    webp: buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP',
  };
  if (!magic[m[1]]) throw bad('That file does not look like a valid image');
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const name = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  return { url: `/uploads/${name}` };
});

const SAMPLE = [
  ['Classic Cotton Tee', 'Soft, breathable 100% cotton t-shirt with a relaxed fit. Pre-washed so it feels broken-in from day one.', 2400, 3000, 40, 'Apparel', '/assets/products/tee.svg'],
  ['Everyday Hoodie', 'Heavyweight fleece hoodie with a roomy kangaroo pocket and ribbed cuffs.', 5900, null, 25, 'Apparel', '/assets/products/hoodie.svg'],
  ['Canvas Tote Bag', 'Sturdy 12oz canvas tote with reinforced handles. Holds groceries, books, or a laptop.', 1800, null, 60, 'Accessories', '/assets/products/tote.svg'],
  ['Ceramic Mug', 'Hand-glazed 350ml stoneware mug. Dishwasher and microwave safe.', 1500, 1900, 3, 'Home', '/assets/products/mug.svg'],
  ['Soy Wax Candle', 'Slow-burning candle with notes of cedar and vanilla. Around 45 hours of burn time.', 2200, null, 30, 'Home', '/assets/products/candle.svg'],
  ['Leather Cardholder', 'Slim full-grain leather cardholder that fits six cards and folded notes.', 3200, null, 12, 'Accessories', '/assets/products/cardholder.svg'],
  ['Stainless Water Bottle', 'Double-walled insulated bottle that keeps drinks cold for 24 hours or hot for 12.', 2800, 3400, 0, 'Outdoors', '/assets/products/bottle.svg'],
  ['Wool Beanie', 'Merino wool blend beanie, warm without the itch.', 2000, null, 18, 'Apparel', '/assets/products/beanie.svg'],
];
route('POST', '/api/admin/seed', { auth: true }, ({ store }) => {
  const ins = db.prepare(
    `INSERT INTO products (store_id, title, description, price, compare_at, inventory, category, image, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`);
  tx(() => { for (const s of SAMPLE) ins.run(store.id, ...s, now()); });
  db.prepare(`INSERT OR IGNORE INTO discounts (store_id, code, type, value, created_at) VALUES (?, 'WELCOME10', 'percent', 10, ?)`)
    .run(store.id, now());
  return { added: SAMPLE.length };
});

// ── admin: discounts ──
route('GET', '/api/admin/discounts', { auth: true }, ({ store }) => ({
  discounts: db.prepare('SELECT id, code, type, value, max_uses, uses, active FROM discounts WHERE store_id = ? ORDER BY id DESC').all(store.id),
}));
route('POST', '/api/admin/discounts', { auth: true }, ({ body: b, store }) => {
  const code = str(b.code, 'Code', { min: 3, max: 30 }).toUpperCase();
  if (!/^[A-Z0-9_-]+$/.test(code)) throw bad('Code may only contain letters, numbers, - and _');
  if (b.type !== 'percent' && b.type !== 'fixed') throw bad('Type must be percent or fixed');
  const value = b.type === 'percent' ? int(b.value, 'Percentage', { min: 1, max: 100 }) : int(b.value, 'Amount', { min: 1, max: 1e8 });
  const maxUses = int(b.max_uses ?? 0, 'Max uses', { min: 0, max: 1e6 });
  try {
    db.prepare('INSERT INTO discounts (store_id, code, type, value, max_uses, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(store.id, code, b.type, value, maxUses, now());
  } catch (e) {
    if (/UNIQUE/.test(String(e.message))) throw new HttpError(409, 'You already have a discount with that code.');
    throw e;
  }
  return { ok: true };
});
route('PUT', '/api/admin/discounts/:id', { auth: true }, ({ params, body, store }) => {
  const r = db.prepare('UPDATE discounts SET active = ? WHERE id = ? AND store_id = ?')
    .run(body.active ? 1 : 0, Number(params.id), store.id);
  if (r.changes !== 1) throw new HttpError(404, 'Discount not found');
  return { ok: true };
});
route('DELETE', '/api/admin/discounts/:id', { auth: true }, ({ params, store }) => {
  const r = db.prepare('DELETE FROM discounts WHERE id = ? AND store_id = ?').run(Number(params.id), store.id);
  if (r.changes !== 1) throw new HttpError(404, 'Discount not found');
  return { ok: true };
});

// ── admin: orders & customers ──
route('GET', '/api/admin/orders', { auth: true }, ({ query, store }) => {
  const status = query.get('status');
  const where = ['o.store_id = ?'];
  const args = [store.id];
  if (status && ORDER_STATUSES.includes(status)) { where.push('o.status = ?'); args.push(status); }
  const orders = db.prepare(
    `SELECT o.id, o.number, o.name, o.email, o.status, o.payment, o.total, o.created_at,
            (SELECT COALESCE(SUM(qty), 0) FROM order_items WHERE order_id = o.id) AS items
     FROM orders o WHERE ${where.join(' AND ')} ORDER BY o.created_at DESC, o.id DESC LIMIT 300`).all(...args);
  return { orders };
});
route('GET', '/api/admin/orders/:id', { auth: true }, ({ params, store }) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND store_id = ?').get(Number(params.id), store.id);
  if (!order) throw new HttpError(404, 'Order not found');
  const items = db.prepare('SELECT title, price, qty FROM order_items WHERE order_id = ?').all(order.id);
  return { order, items };
});
route('PUT', '/api/admin/orders/:id', { auth: true }, ({ params, body, store }) => {
  if (!ORDER_STATUSES.includes(body.status)) throw bad('Invalid status');
  tx(() => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ? AND store_id = ?').get(Number(params.id), store.id);
    if (!order) throw new HttpError(404, 'Order not found');
    if (order.status === body.status) return;
    const items = db.prepare('SELECT product_id, title, qty FROM order_items WHERE order_id = ?').all(order.id);
    if (body.status === 'cancelled') {
      for (const it of items) {
        if (it.product_id) db.prepare('UPDATE products SET inventory = inventory + ? WHERE id = ? AND store_id = ?').run(it.qty, it.product_id, store.id);
      }
    } else if (order.status === 'cancelled') {
      for (const it of items) {
        if (!it.product_id) continue;
        const r = db.prepare('UPDATE products SET inventory = inventory - ? WHERE id = ? AND store_id = ? AND inventory >= ?')
          .run(it.qty, it.product_id, store.id, it.qty);
        if (r.changes !== 1) throw new HttpError(409, `Not enough stock of "${it.title}" to reopen this order.`);
      }
    }
    db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(body.status, order.id);
  });
  return { ok: true };
});
route('GET', '/api/admin/customers', { auth: true }, ({ store }) => ({
  customers: db.prepare(
    `SELECT LOWER(email) AS email, MAX(name) AS name, COUNT(*) AS orders, SUM(total) AS spent, MAX(created_at) AS last_order
     FROM orders WHERE store_id = ? AND status != 'cancelled' GROUP BY LOWER(email) ORDER BY spent DESC LIMIT 500`).all(store.id),
}));

// ── public: directory & storefront ──
route('GET', '/api/stores', () => ({
  stores: db.prepare(
    `SELECT s.name, s.slug, s.tagline, s.color FROM stores s
     WHERE EXISTS (SELECT 1 FROM products p WHERE p.store_id = s.id AND p.active = 1)
     ORDER BY s.created_at DESC LIMIT 60`).all(),
}));

route('GET', '/api/shop/:slug', { shop: true }, ({ store }) => ({ store: publicStore(store) }));

route('GET', '/api/shop/:slug/products', { shop: true }, ({ store, query }) => {
  const where = ['store_id = ?', 'active = 1'];
  const args = [store.id];
  const q = (query.get('q') || '').trim().slice(0, 80);
  if (q) {
    where.push("(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR category LIKE ? ESCAPE '\\')");
    const like = '%' + q.replace(/[\\%_]/g, '\\$&') + '%';
    args.push(like, like, like);
  }
  const cat = (query.get('category') || '').trim();
  if (cat) { where.push('category = ?'); args.push(cat); }
  const sorts = {
    newest: 'created_at DESC, id DESC', price_asc: 'price ASC, id ASC',
    price_desc: 'price DESC, id ASC', title: 'title COLLATE NOCASE ASC',
  };
  const order = sorts[query.get('sort')] || sorts.newest;
  const limit = Math.min(60, Math.max(1, parseInt(query.get('limit'), 10) || 24));
  const offset = Math.max(0, parseInt(query.get('offset'), 10) || 0);
  const w = where.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) AS n FROM products WHERE ${w}`).get(...args).n;
  const products = db.prepare(`SELECT ${productCols} FROM products WHERE ${w} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, limit, offset);
  const categories = db.prepare(
    `SELECT DISTINCT category FROM products WHERE store_id = ? AND active = 1 AND category != '' ORDER BY category`)
    .all(store.id).map((r) => r.category);
  return { products, total, categories };
});

route('GET', '/api/shop/:slug/products/:id', { shop: true }, ({ store, params }) => {
  const p = db.prepare(`SELECT ${productCols} FROM products WHERE id = ? AND store_id = ? AND active = 1`).get(Number(params.id), store.id);
  if (!p) throw new HttpError(404, 'Product not found');
  return { product: p };
});

route('POST', '/api/shop/:slug/quote', { shop: true }, ({ store, body }) => {
  const q = computeCart(store, body.items, body.code, false);
  return q;
});

route('POST', '/api/shop/:slug/checkout', { shop: true }, ({ store, body: b, ip }) => {
  throttle('checkout:' + ip, 30, 3600e3);
  const customer = {
    name: str(b.name, 'Name', { min: 1, max: 100 }),
    email: readEmail(b.email),
    phone: str(b.phone, 'Phone', { max: 30 }),
    address: str(b.address, 'Address', { min: 3, max: 200 }),
    city: str(b.city, 'City', { min: 1, max: 100 }),
    zip: str(b.zip, 'Postal code', { min: 1, max: 20 }),
    country: str(b.country, 'Country', { min: 2, max: 80 }),
    notes: str(b.notes, 'Notes', { max: 500 }),
  };
  const payment = b.payment === 'cod' ? 'cod' : 'demo';
  if (b.payment !== undefined && b.payment !== 'cod' && b.payment !== 'demo') throw bad('Unknown payment method');

  const token = crypto.randomBytes(16).toString('hex');
  const order = tx(() => {
    const q = computeCart(store, b.items, b.code, true);
    const dec = db.prepare('UPDATE products SET inventory = inventory - ? WHERE id = ? AND store_id = ? AND inventory >= ?');
    for (const l of q.lines) {
      if (dec.run(l.qty, l.id, store.id, l.qty).changes !== 1) throw new HttpError(409, `${l.title} just went out of stock.`);
    }
    const number = db.prepare('SELECT COALESCE(MAX(number), 1000) + 1 AS n FROM orders WHERE store_id = ?').get(store.id).n;
    const r = db.prepare(
      `INSERT INTO orders (store_id, number, token, status, payment, email, name, phone, address, city, zip, country, notes,
                           discount_code, subtotal, discount, shipping, tax, total, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(store.id, number, token, payment === 'cod' ? 'pending' : 'paid', payment, customer.email, customer.name,
        customer.phone, customer.address, customer.city, customer.zip, customer.country, customer.notes,
        q.discountCode, q.subtotal, q.discount, q.shipping, q.tax, q.total, now());
    const insItem = db.prepare('INSERT INTO order_items (order_id, product_id, title, price, qty) VALUES (?, ?, ?, ?, ?)');
    for (const l of q.lines) insItem.run(r.lastInsertRowid, l.id, l.title, l.price, l.qty);
    if (q.discountCode) db.prepare('UPDATE discounts SET uses = uses + 1 WHERE store_id = ? AND code = ?').run(store.id, q.discountCode);
    return { number, total: q.total };
  });
  return { token, number: order.number, total: order.total };
});

route('GET', '/api/shop/:slug/orders/:token', { shop: true }, ({ store, params }) => {
  const o = db.prepare('SELECT * FROM orders WHERE token = ? AND store_id = ?').get(params.token, store.id);
  if (!o) throw new HttpError(404, 'Order not found');
  const items = db.prepare('SELECT title, price, qty FROM order_items WHERE order_id = ?').all(o.id);
  delete o.id; delete o.token; delete o.store_id;
  return { order: o, items };
});

// ───────────────────────────── http plumbing ─────────────────────────────
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
};
const CSP = "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; " +
  "connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS,
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, finished = false;
    req.on('data', (c) => {
      if (finished) return;
      size += c.length;
      if (size > limit) { finished = true; reject(new HttpError(413, 'Request is too large')); req.resume(); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!finished) { finished = true; resolve(Buffer.concat(chunks).toString('utf8')); } });
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  const method = req.method;
  let matched = null, params = {}, pathMatched = false;
  for (const r of routes) {
    const m = r.re.exec(url.pathname);
    if (!m) continue;
    pathMatched = true;
    if (r.method !== method) continue;
    matched = r;
    r.keys.forEach((k, i) => {
      try { params[k] = decodeURIComponent(m[i + 1]); } catch { throw bad('Bad URL'); }
    });
    break;
  }
  if (!matched) throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'Method not allowed' : 'Not found');

  let body = {};
  if (method !== 'GET' && method !== 'HEAD') {
    const origin = req.headers.origin;
    if (origin) {
      let host = '';
      try { host = new URL(origin).host; } catch { /* invalid origin */ }
      if (host !== req.headers.host) throw new HttpError(403, 'Cross-origin request blocked');
    }
    if (!String(req.headers['content-type'] || '').toLowerCase().includes('application/json')) {
      throw new HttpError(415, 'Content-Type must be application/json');
    }
    const text = await readBody(req, matched.opts.limit || 100 * 1024);
    if (text.trim()) {
      try { body = JSON.parse(text); } catch { throw bad('Invalid JSON'); }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) throw bad('JSON body must be an object');
    }
  }

  const ctx = { req, res, params, query: url.searchParams, body, ip: clientIp(req) };
  if (matched.opts.auth) {
    const { user, store } = getAuth(req);
    if (!user || !store) throw new HttpError(401, 'Please sign in');
    ctx.user = user; ctx.store = store;
  }
  if (matched.opts.shop) {
    const store = db.prepare('SELECT * FROM stores WHERE slug = ?').get(params.slug);
    if (!store) throw new HttpError(404, 'Store not found');
    ctx.store = store;
  }
  sendJson(res, 200, matched.handler(ctx));
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
};

function serveFile(req, res, baseDir, rel, isUpload) {
  const file = path.resolve(baseDir, rel);
  if (!file.startsWith(baseDir + path.sep)) throw new HttpError(403, 'Forbidden');
  const type = MIME[path.extname(file).toLowerCase()];
  if (!type || (isUpload && type.startsWith('text/'))) throw new HttpError(404, 'Not found');
  let data;
  try { data = fs.readFileSync(file); } catch { throw new HttpError(404, 'Not found'); }
  const headers = { 'Content-Type': type, 'Content-Length': data.length, ...SECURITY_HEADERS };
  if (type.startsWith('text/html')) headers['Content-Security-Policy'] = CSP;
  headers['Cache-Control'] = isUpload ? 'public, max-age=31536000, immutable' : 'no-cache';
  if (isUpload) headers['Content-Security-Policy'] = "default-src 'none'";
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : data);
}

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
  let p;
  try { p = decodeURIComponent(pathname); } catch { throw new HttpError(400, 'Bad URL'); }
  if (p.includes('\0')) throw new HttpError(400, 'Bad URL');
  if (p === '/') return serveFile(req, res, PUBLIC_DIR, 'index.html');
  if (p === '/admin' || p === '/admin/') return serveFile(req, res, PUBLIC_DIR, 'admin.html');
  if (/^\/store\/[^/]+\/?$/.test(p)) return serveFile(req, res, PUBLIC_DIR, 'store.html');
  if (p.startsWith('/assets/')) return serveFile(req, res, PUBLIC_DIR, p.slice(1));
  if (p.startsWith('/uploads/')) return serveFile(req, res, UPLOAD_DIR, p.slice('/uploads/'.length), true);
  throw new HttpError(404, 'Not found');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else serveStatic(req, res, url.pathname);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    const message = status === 500 ? 'Something went wrong on our side.' : err.message;
    if (url.pathname.startsWith('/api/')) sendJson(res, status, { error: message });
    else {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
      res.end(status === 404 ? 'Not found' : message);
    }
  }
});

server.listen(PORT, () => {
  console.log(`ShopLaunch running → http://localhost:${PORT}`);
  console.log(`Merchant admin     → http://localhost:${PORT}/admin`);
});
