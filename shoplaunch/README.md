# ShopLaunch — a Shopify-style store platform

A working multi-store e-commerce platform. Merchants sign up, get their own storefront at `/store/<name>`, and manage products, orders, customers and discounts from an admin dashboard. **Zero dependencies** — just Node.js 22.5+ (it uses Node's built-in SQLite).

## Run it

```bash
npm start            # or: node --disable-warning=ExperimentalWarning server.js
```

Open **http://localhost:3000**

1. Click **Start free** → create your account + store
2. On the dashboard click **Load sample products** (or add your own under *Products*)
3. Click **View storefront**, add items to the cart, check out
4. Back in the admin, open **Orders** and mark the order as shipped

Config via environment variables: `PORT` (default 3000), `DB_FILE` (default `./shop.db`), `TRUST_PROXY=1` (when behind a reverse proxy).

Run the automated tests: `npm test` (26 end-to-end API checks).

## What's included

**Storefront** (`/store/<slug>`): product grid, search, category filter, sorting, pagination, product pages with sale prices & stock levels, cart (persists in the browser), discount codes, checkout, order confirmation page, mobile responsive, per-store brand colour.

**Admin** (`/admin`): sign up / log in, dashboard (sales, orders, 7-day chart, low-stock alerts), product CRUD with image upload, order management with status workflow (pending → paid → shipped → delivered / cancelled), customers (grouped by email, with lifetime spend), discount codes (percentage or fixed, usage limits, pause/resume), store settings (name, currency, colour, tax rate, shipping, free-shipping threshold).

**Business logic that matters (all server-side):**
- Prices, discounts, shipping and tax are always recalculated on the server — the browser can't tamper with them.
- Checkout runs in a database transaction: stock is decremented atomically, so two buyers can't oversell the last item.
- Cancelling an order restocks the items; re-opening it re-deducts (and refuses if stock is gone).
- Deleting a product keeps past orders intact (order lines store a snapshot of title and price).
- Every admin query is scoped to the logged-in merchant's store.

**Security:** scrypt password hashing, HttpOnly SameSite session cookies (stored hashed), login/signup/checkout rate limiting, CSRF protection (JSON-only + Origin check), strict Content-Security-Policy, parameterised SQL everywhere, XSS-safe rendering (the UI never uses `innerHTML`), upload validation (type, size, magic bytes), path-traversal protection.

## Project layout

```
server.js            API + static server + SQLite schema (single file)
test.js              end-to-end API tests
public/
  index.html         landing page + store directory
  admin.html         merchant dashboard (SPA)
  store.html         storefront (SPA)
  assets/
    common.js        DOM helper, API client, modal, toast
    admin.js  store.js  landing.js  style.css
```

## Before you go live (honest list)

This is a solid, working foundation — but a real business needs a few more things:

1. **Real payments.** The "Pay now" option is a *demo gateway* that marks the order paid without charging anyone (no card data is ever collected). To take real money, integrate Stripe Checkout or Razorpay (popular in India): create a payment session in `POST /api/shop/:slug/checkout`, and only mark the order `paid` from the provider's webhook.
2. **HTTPS.** Put it behind Caddy / nginx / a platform like Render or Fly.io, and set `TRUST_PROXY=1`. Session cookies automatically become `Secure` over HTTPS.
3. **Email.** Order confirmations, password reset and shipping notifications aren't implemented — add a provider such as Resend, SendGrid or SES.
4. **Backups.** All data is in `shop.db` (plus `uploads/`). Back both up regularly.
5. **Scale.** SQLite comfortably handles a small-to-mid store on a single server. For multiple servers or heavy traffic, move to PostgreSQL and store images in S3/Cloudflare R2.
6. **Nice-to-haves:** product variants (size/colour), custom domains per store, customer accounts, refunds, shipping-carrier rates, GST/VAT invoices.
