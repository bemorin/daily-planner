// Zero-dependency local server for Daily Planner.
//
//   node scripts/serve.mjs            serve the source tree on http://localhost:8080
//   node scripts/serve.mjs --dist     serve the production build in dist/
//   node scripts/serve.mjs --open     also open the default browser
//   node scripts/serve.mjs --port 9000 --lan
//   node scripts/serve.mjs --api      also run the owner API (waitlist, feedback, team requests, counts)
//   node scripts/serve.mjs --api --data /tmp/api.json   keep the API data in another file
//   node scripts/serve.mjs --api --fake-email            print emails instead of sending them
//   node scripts/serve.mjs --api --fake-creem            pretend Creem checkouts (below)
//   node scripts/serve.mjs --api --country FR            pretend every visitor is in France (prices in EUR)
//
// The local API is off by default, so everyday local use never collects
// anything. With --api it mirrors the production Cloudflare Function
// (server/planner-api.js), stores data in .planner-dev/api.json, and the owner
// dashboard is at /admin/ with the token printed below (set ADMIN_TOKEN to
// choose your own; on --lan a random token is generated instead of "dev").
// Set ADMIN_TOTP_SECRET (base32, see scripts/admin-secret.mjs) to also require
// an authenticator code at sign-in, exactly as in production.
// Email is off unless RESEND_API_KEY and EMAIL_FROM are set (plus OWNER_EMAIL,
// EMAIL_DAILY_LIMIT and PUBLIC_BASE_URL, as in production). With --fake-email,
// nothing is sent: each email is printed here instead, so the dashboard's
// announcement can be tried safely (it still deletes the local waitlist
// entries it "sent").
//
// Daily Planner Plus: with --api and no PLUS_SIGNING_KEY, a throwaway key pair
// is made at startup (new on every start, so licences from an earlier run stop
// working). Its public key is put into the served runtime-config.js, and
// POST /api/dev/license answers { license } signed with it. With
// PLUS_SIGNING_KEY set, its public key is served instead and there is no
// /api/dev/license.
//
// Payments: --fake-creem stands in for Creem, the payment provider. POST
// /api/checkout then answers a local page, /__fake-creem/pay?checkout=<id>,
// that sends the browser straight back to the return address with
// ?checkout_id=<id>&order_id=ord_fake&signature=fake, as Creem does after a
// payment; reading that checkout answers "completed" with what it was opened
// for (company "Acme Studio" for team gifts, from "Camille" for personal
// gifts), with the tax included in a euro order (20% VAT, as in France; none
// in US dollars) so commissions show before tax. A partner code (affiliate_code,
// never sent for a team gift) or the checkout's own `ref` is printed; the code
// BADCODE is refused with HTTP 400, as Creem refuses an unknown code, so the
// API's retry without it can be tried. Two shortcuts need no checkout:
// /?checkout_id=fake_plus unlocks Plus and /welcome/thanks/?checkout_id=fake_gift50
// makes a 50-seat gift for "Acme Studio". Set CREEM_WEBHOOK_SECRET to try
// POST /api/creem/webhook too (with --fake-creem it defaults to a fake secret).
// Refunds: POST /__fake-creem/refund?checkout=<id> posts a signed refund.created
// webhook for that paid checkout, as Creem does (add &amount=<cents> for a
// partial refund, &dispute=1 for a dispute.created instead); GET
// /v1/transactions?transaction_id=… answers from the same pretend data.
// A product link opened by hand: POST /__fake-creem/link?item=plus|gift
// [&plan=gift-1][&currency=EUR][&ref=CODE][&member=1] makes a paid checkout
// whose metadata is only what was given — no seal, no request id — and answers
// its id, to see that the API never takes its partner code or member flag.
// The setup assistant (admin, Configuration) reads and creates products and
// webhooks in a pretend store: FAKE_CREEM_CATALOG=partial (default: Plus in EUR
// and USD only), empty, differs (Plus USD at $25, tax added on top) or full. Its
// webhook needs a public https PUBLIC_BASE_URL, as with Creem.
// Without --fake-creem the CREEM_* variables are used, as in production.
// Review mode: CREEM_TEST_ON_PRODUCTION=1 works here as in production (a test
// key sells on the production address too, the pages say payments are in test
// mode). A local address is never production: to see it, set PUBLIC_BASE_URL
// to another host name that points at this computer and open the server
// there, e.g. PUBLIC_BASE_URL=http://planner.test:8080 with planner.test
// mapped to 127.0.0.1 (the browser must treat that http address as secure for
// WebCrypto: Chromium's --unsafely-treat-insecure-origin-as-secure does).
// Links in emails and checkout returns point at this server unless
// PUBLIC_BASE_URL is set.
//
// Build variables: the served runtime-config.js takes the legal pages' and the
// partners page's from this environment, as scripts/build.mjs does, so their
// states can be previewed (legal pages, welcome footer, partners page,
// dashboard Setup): DAILY_PLANNER_SUPPORT_EMAIL, DAILY_PLANNER_PRIVACY_EMAIL,
// DAILY_PLANNER_LEGAL_PHONE, DAILY_PLANNER_LEGAL_ADDRESS,
// DAILY_PLANNER_LEGAL_REGISTRATION, DAILY_PLANNER_AFFILIATE_URL and the footer's
// social links DAILY_PLANNER_GITHUB_URL, DAILY_PLANNER_X_URL and
// DAILY_PLANNER_LINKEDIN_URL, e.g.
//   DAILY_PLANNER_SUPPORT_EMAIL=support@example.com DAILY_PLANNER_LEGAL_PHONE=+33199001234 node scripts/serve.mjs --api
// Unset, they stay blank. (PLANNER_API_URL and PLUS_PUBLIC_KEY come from --api,
// above.) With --dist, runtime-config.js is served as the build wrote it.
//
// Currency: in production the buyer's country (from Cloudflare) decides it.
// Locally the country is unknown, so the page's own guess is used, unless a
// request carries a CF-IPCountry header or the server runs with --country FR
// (or US, DE …), which sets that header on every API request without one.
//
// Redirects: _redirects is applied as Cloudflare Pages applies it
// (scripts/redirects.mjs): /privacy → /legal/privacy/, /welcome/teams/… →
// /teams/…, the query string kept and the #hash left to the browser.
//
// Browsers keep planner data per address (host + port), so the server always
// prefers the same port. If that port already runs Daily Planner, it simply
// opens the existing instance instead of starting a second copy elsewhere.

import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { createMemoryStore, createPlannerApi } from '../server/planner-api.js';
import { generatePlusKeyPair, importSigningKey, publicKeyFromSigningKey, signLicense } from '../server/licenses.js';
import { checkoutSeal, creemMode, creemProductsFromEnv, webhookSignature } from '../server/creem.js';
import { CONFIG_VARIABLES } from '../server/config-inventory.js';
import { expectedProduct } from '../server/creem-setup.js';
import { beforeTaxCents, priceCents } from '../src/lib/pricing.js';
import { parseRedirects, redirectFor } from './redirects.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const useDist = flag('dist');
const shouldOpen = flag('open');
const lan = flag('lan');
const preferredPort = Number(option('port', process.env.PORT || 8080)) || 8080;
const host = lan ? '0.0.0.0' : '127.0.0.1';
const root = useDist ? resolve(projectRoot, 'dist') : projectRoot;
const MARKER = 'x-daily-planner';
const withApi = flag('api');
// Never expose the well-known "dev" token to other devices on the network.
const adminToken = process.env.ADMIN_TOKEN || (lan ? randomBytes(12).toString('base64url') : 'dev');
const adminTotpSecret = process.env.ADMIN_TOTP_SECRET || '';
const devDataFile = option('data', '') ? resolve(option('data', '')) : resolve(projectRoot, '.planner-dev', 'api.json');
const fakeEmail = flag('fake-email');
const fakeCreem = flag('fake-creem');
const devCountry = /^[A-Za-z]{2}$/.test(option('country', '')) ? option('country', '').toUpperCase() : '';
let plannerApi = null;
let emailMode = 'off';
let plusMode = 'off';
let creemLabel = 'off';
let plusSigningKey = '';
let plusPublicKey = '';
let devLicenses = false;

// Stands in for Resend: prints what would be sent and accepts it.
async function printEmail(url, init) {
  const body = JSON.parse(init.body);
  const messages = Array.isArray(body) ? body : [body];
  const recipients = messages.flatMap(message => message.to);
  console.log(`  [fake email] "${messages[0]?.subject}" → ${recipients.length} ${recipients.length === 1 ? 'recipient' : 'recipients'}: ${recipients.slice(0, 3).join(', ')}${recipients.length > 3 ? ', …' : ''}`);
  // A single email (notification, test, gift link) is printed in full.
  if (!Array.isArray(body)) console.log(String(body.text || '').trimEnd().split('\n').map(line => (line ? `      ${line}` : '')).join('\n'));
  const answer = String(url).endsWith('/batch') ? { data: messages.map((_, index) => ({ id: `fake-${index}` })) } : { id: 'fake-0' };
  return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
}

function emailOptions() {
  const env = process.env;
  const options = {
    resendApiKey: env.RESEND_API_KEY || '',
    emailFrom: env.EMAIL_FROM || '',
    ownerEmail: env.OWNER_EMAIL || '',
    emailDailyLimit: env.EMAIL_DAILY_LIMIT || ''
  };
  if (fakeEmail) {
    emailMode = 'fake, printed here';
    return { ...options, resendApiKey: 'fake', emailFrom: options.emailFrom || 'Daily Planner <planner@example.com>', ownerEmail: options.ownerEmail || 'owner@example.com', emailFetch: printEmail, emailIntervalMs: 0 };
  }
  if (options.resendApiKey && options.emailFrom) emailMode = 'Resend';
  return options;
}

// Links in emails and checkout returns point at this server (the port is known once it listens).
const devBaseUrl = () => (process.env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/+$/, '');

// Stands in for Creem: checkouts opened here (and two shortcuts) are always paid.
const FAKE_PRODUCTS = { plus: { EUR: 'prod_fake_plus_eur', USD: 'prod_fake_plus_usd' }, gift: { EUR: 'prod_fake_gift_eur', USD: 'prod_fake_gift_usd' } };
// What the pretend buyer types in the checkout's field: the company (team gift) or their name (personal gift).
const FAKE_FIELD_ANSWERS = { company: { label: 'Company name, shown to your team', value: 'Acme Studio' }, from: { label: 'Your name, shown with the gift', value: 'Camille' } };
const FAKE_REFUSED_AFFILIATE = 'BADCODE';
// Without CREEM_WEBHOOK_SECRET, pretend refunds are signed with this one.
const FAKE_WEBHOOK_SECRET = 'whsec_fake_dev_only';
// Checkouts made by /__fake-creem/link: opened by hand, so never given the seal the shortcuts get.
const fakeByHand = new Set();
const fakeCheckouts = new Map([
  ['fake_plus', { product: FAKE_PRODUCTS.plus.EUR, metadata: { kind: 'plus' }, amount: priceCents('plus', '', 'EUR'), currency: 'EUR', successUrl: '/', orderId: 'ord_fake_plus' }],
  ['fake_gift50', { product: FAKE_PRODUCTS.gift.EUR, metadata: { kind: 'gift', plan: 'up-to-50', seats: '50' }, amount: priceCents('gift', 'up-to-50', 'EUR'), currency: 'EUR', successUrl: '/welcome/thanks/', orderId: 'ord_fake_gift50' }]
]);
// Pretend transactions, one per refunded checkout: { id, order, amount_paid, refunded_amount, status, currency }.
const fakeTransactions = new Map();
const fakeJson = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// The tax Creem reports in an order (prices include it): 20% VAT for a euro buyer (France), none in US dollars.
function fakeTax(fake) {
  const sub = fake.currency === 'EUR' ? beforeTaxCents(fake.amount, 20) : fake.amount;
  return { sub_total: sub, tax_amount: fake.amount - sub };
}

function fakeCheckoutEntity(id, fake, status = 'completed') {
  const gift = fake.metadata?.kind === 'gift';
  const fields = gift ? fake.fields || ['company'] : [];
  const buyer = !gift ? { email: 'buyer@example.com', name: 'Sam Buyer' } : fields.includes('from') ? { email: 'camille@example.com', name: 'Camille Martin' } : { email: 'buyer@acme.example', name: 'Ada Lovelace' };
  return {
    id, object: 'checkout', mode: 'test', status, request_id: fake.requestId || null, units: 1, product: fake.product,
    ...(status === 'completed' ? { order: { id: fake.orderId, object: 'order', status: 'paid', type: 'onetime', amount: fake.amount, amount_paid: fake.amount, ...fakeTax(fake), currency: fake.currency } } : {}),
    customer: { id: 'cust_fake', object: 'customer', ...buyer, country: 'FR' },
    custom_fields: fields.filter(key => FAKE_FIELD_ANSWERS[key]).map(key => ({ type: 'text', key, label: FAKE_FIELD_ANSWERS[key].label, optional: true, text: { max_length: 80, ...(status === 'completed' ? { value: FAKE_FIELD_ANSWERS[key].value } : {}) } })),
    metadata: fake.metadata || {},
    success_url: new URL(fake.successUrl, `${devBaseUrl()}/`).href,
    checkout_url: `${devBaseUrl()}/__fake-creem/pay?checkout=${encodeURIComponent(id)}`
  };
}

// The pretend store the setup assistant reads and adds to (FAKE_CREEM_CATALOG, see the header).
const fakeStore = { products: [], webhooks: [], keys: new Map(), ready: false };
const fakeProduct = (id, item, currency, extra = {}) => ({ object: 'product', mode: 'test', status: 'active', billing_period: 'once', created_at: '2026-10-01T09:00:00.000Z', ...expectedProduct(item, currency), ...extra, id });
const fakeHookSecret = () => (process.env.CREEM_WEBHOOK_SECRET || FAKE_WEBHOOK_SECRET).trim();

async function fakeSetupFetch(target, init) {
  const scenario = process.env.FAKE_CREEM_CATALOG || 'partial';
  if (!fakeStore.ready) {
    fakeStore.ready = true;
    if (scenario !== 'empty') fakeStore.products.push(fakeProduct(FAKE_PRODUCTS.plus.EUR, 'plus', 'EUR'), fakeProduct(FAKE_PRODUCTS.plus.USD, 'plus', 'USD', scenario === 'differs' ? { price: 2500, tax_mode: 'exclusive' } : {}));
    if (scenario === 'full') {
      fakeStore.products.push(fakeProduct(FAKE_PRODUCTS.gift.EUR, 'gift', 'EUR'), fakeProduct(FAKE_PRODUCTS.gift.USD, 'gift', 'USD'));
      fakeStore.webhooks.push({ id: 'wh_fake_1', object: 'webhook', mode: 'test', name: 'Daily Planner', url: `${devBaseUrl()}/api/creem/webhook`, delivery_mode: 'http', status: 'enabled', events: ['checkout.completed', 'refund.created', 'dispute.created'], secret: fakeHookSecret() });
    }
  }
  const method = String(init.method || 'GET').toUpperCase();
  const path = target.pathname;
  const list = items => fakeJson(200, { items, pagination: { total_records: items.length, total_pages: 1, current_page: 1, next_page: null, prev_page: null } });
  const productId = /^\/v1\/products\/([^/]+)$/.exec(path)?.[1];
  const secretOf = /^\/v1\/webhooks\/([^/]+)\/secret$/.exec(path)?.[1];
  if (method === 'GET' && path === '/v1/products/search') return list(fakeStore.products);
  if (method === 'GET' && productId) {
    const product = fakeStore.products.find(entry => entry.id === productId);
    return product ? fakeJson(200, product) : fakeJson(404, { message: ['Product not found'] });
  }
  if (method === 'POST' && path === '/v1/products') {
    const key = init.headers?.['Idempotency-Key'] || '';
    if (key && fakeStore.keys.has(key)) return fakeJson(200, fakeStore.keys.get(key));
    const body = JSON.parse(init.body || '{}');
    const product = { object: 'product', mode: 'test', status: 'active', billing_period: 'once', ...body, id: `prod_fake_${randomBytes(6).toString('hex')}`, created_at: new Date().toISOString() };
    fakeStore.products.push(product);
    if (key) fakeStore.keys.set(key, product);
    console.log(`  [fake creem] created product ${product.id}: ${body.name}, ${(body.price / 100).toFixed(2)} ${body.currency}`);
    return fakeJson(200, product);
  }
  if (method === 'GET' && path === '/v1/webhooks') return list(fakeStore.webhooks.map(({ secret: _secret, ...hook }) => hook));
  if (method === 'POST' && path === '/v1/webhooks') {
    const body = JSON.parse(init.body || '{}');
    const hook = { id: `wh_fake_${randomBytes(6).toString('hex')}`, object: 'webhook', mode: 'test', status: 'enabled', delivery_mode: 'http', ...body, secret: fakeHookSecret() };
    fakeStore.webhooks.push(hook);
    console.log(`  [fake creem] created webhook ${hook.id} → ${hook.url} (its secret is not printed)`);
    return fakeJson(200, hook);
  }
  if (method === 'GET' && secretOf) {
    const hook = fakeStore.webhooks.find(entry => entry.id === secretOf);
    return hook ? fakeJson(200, { secret: hook.secret }) : fakeJson(404, { message: ['Webhook not found'] });
  }
  return null;
}

async function fakeCreemFetch(url, init = {}) {
  const target = new URL(url);
  const setup = await fakeSetupFetch(target, init);
  if (setup) return setup;
  if (target.pathname === '/v1/transactions') {
    const transaction = fakeTransactions.get(target.searchParams.get('transaction_id') || '');
    console.log(`  [fake creem] read transaction ${target.searchParams.get('transaction_id')}`);
    return transaction ? fakeJson(200, { object: 'transaction', mode: 'test', ...transaction }) : fakeJson(404, { message: ['Transaction not found'] });
  }
  if (target.pathname !== '/v1/checkouts') return fakeJson(404, { message: 'Not found' });
  if (String(init.method || 'GET').toUpperCase() === 'POST') {
    const body = JSON.parse(init.body || '{}');
    const [kind, currency] = Object.entries(FAKE_PRODUCTS).flatMap(([item, ids]) => Object.entries(ids).map(([money, id]) => [item, money, id])).find(([, , id]) => id === body.product_id) || [];
    if (!kind) return fakeJson(404, { message: ['Product not found'] });
    // Like Creem, an unknown partner code refuses the whole checkout.
    if (body.affiliate_code === FAKE_REFUSED_AFFILIATE) {
      console.log(`  [fake creem] refused affiliate code ${body.affiliate_code} (HTTP 400)`);
      return fakeJson(400, { statusCode: 400, message: ['Affiliate code not found'] });
    }
    const id = `ch_fake_${randomBytes(8).toString('hex')}`;
    const fake = { product: body.product_id, metadata: body.metadata || {}, amount: body.custom_price ?? priceCents(kind, body.metadata?.plan, currency), currency, successUrl: body.success_url || '/', requestId: body.request_id, fields: (body.custom_fields || []).map(field => field?.key), orderId: `ord_fake_${randomBytes(8).toString('hex')}` };
    fakeCheckouts.set(id, fake);
    const affiliate = body.affiliate_code ? `, affiliate ${body.affiliate_code}` : body.metadata?.ref ? `, partner ${body.metadata.ref} (no affiliate_code: paid by the owner)` : '';
    console.log(`  [fake creem] opened ${id}: ${kind}${fake.metadata.plan ? ` ${fake.metadata.plan}` : ''}, ${(fake.amount / 100).toFixed(2)} ${currency}${affiliate}`);
    return fakeJson(200, fakeCheckoutEntity(id, fake, 'pending'));
  }
  const id = target.searchParams.get('checkout_id') || '';
  const fake = fakeCheckouts.get(id);
  if (!fake) return fakeJson(404, { message: [`Checkout not found: ${id}`] });
  // The two shortcuts carry the seal the API would have put on a checkout it opened.
  if (!fake.metadata.seal && plusSigningKey && !fakeByHand.has(id)) {
    const { kind, plan = '' } = fake.metadata;
    fake.metadata = { ...fake.metadata, currency: fake.currency, rid: id, seal: await checkoutSeal(plusSigningKey, { kind, plan, currency: fake.currency, rid: id }) };
  }
  console.log(`  [fake creem] read ${id}`);
  return fakeJson(200, fakeCheckoutEntity(id, fake));
}

// The pretend payment page: straight back to the checkout's return address, as after a payment.
function fakePayPage(url, response) {
  const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', [MARKER]: '1' };
  const id = url.searchParams.get('checkout') || '';
  const fake = fakeCheckouts.get(id);
  if (!fake) { response.writeHead(404, headers).end('<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Fake Creem checkout</title></head><body><p>This pretend checkout does not exist (the dev server forgets them when it restarts).</p></body></html>\n'); return; }
  const back = new URL(fake.successUrl, `${devBaseUrl()}/`);
  back.searchParams.set('checkout_id', id);
  back.searchParams.set('order_id', 'ord_fake');
  back.searchParams.set('signature', 'fake');
  const href = back.href.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  console.log(`  [fake creem] paid ${id}`);
  response.writeHead(200, headers).end(`<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="0;url=${href}"><title>Fake Creem checkout</title></head><body><p>Pretend payment accepted. Back to <a href="${href}">Daily Planner</a>…</p></body></html>\n`);
}

/**
 * POST /__fake-creem/link?item=plus|gift[&plan=…][&currency=EUR|USD][&ref=CODE][&member=1]: someone opens a
 * product link by hand and pays it. Its metadata is only what was given (no seal, no request id). Answers { checkout }.
 */
function fakeLink(request, url, response) {
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', [MARKER]: '1' };
  request.resume();
  const item = url.searchParams.get('item') === 'gift' ? 'gift' : 'plus';
  const currency = url.searchParams.get('currency') === 'USD' ? 'USD' : 'EUR';
  const plan = item === 'gift' ? url.searchParams.get('plan') || 'gift-1' : '';
  const metadata = { kind: item, ...(plan ? { plan } : {}) };
  for (const key of ['ref', 'member']) if (url.searchParams.has(key)) metadata[key] = url.searchParams.get(key);
  const id = `ch_fake_hand_${randomBytes(6).toString('hex')}`;
  fakeCheckouts.set(id, { product: FAKE_PRODUCTS[item][currency], metadata, amount: priceCents(item, plan, currency, { member: metadata.member === '1' }), currency, successUrl: item === 'gift' ? '/welcome/thanks/' : '/', orderId: `ord_fake_${randomBytes(8).toString('hex')}`, fields: item === 'gift' ? ['from'] : [] });
  fakeByHand.add(id);
  console.log(`  [fake creem] opened by hand ${id}: ${JSON.stringify(metadata)}`);
  response.writeHead(201, headers).end(JSON.stringify({ checkout: id }));
}

/**
 * POST /__fake-creem/refund?checkout=<id>[&amount=<cents>][&dispute=1]: Creem refunds (or a buyer disputes)
 * that pretend checkout, and its signed webhook is sent to the API, as Creem does. Answers what the API said.
 */
async function fakeRefund(request, url, response) {
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', [MARKER]: '1' };
  const answer = (status, body) => response.writeHead(status, headers).end(JSON.stringify(body));
  request.resume();
  if (request.method !== 'POST') { answer(405, { error: 'POST /__fake-creem/refund?checkout=<id>[&amount=<cents>][&dispute=1]' }); return; }
  const id = url.searchParams.get('checkout') || '';
  const fake = fakeCheckouts.get(id);
  if (!fake) { answer(404, { error: `No pretend checkout ${id} (the dev server forgets them when it restarts).` }); return; }
  const transactionId = `tran_fake_${id.replace(/[^A-Za-z0-9]/g, '').slice(-24)}`;
  const transaction = fakeTransactions.get(transactionId) || { id: transactionId, order: fake.orderId, amount: fake.amount, amount_paid: fake.amount, refunded_amount: 0, status: 'paid', currency: fake.currency };
  const dispute = url.searchParams.get('dispute') === '1';
  // Refunded in full already (an earlier try, since restored): start again from a paid transaction.
  if (!dispute && transaction.refunded_amount >= transaction.amount_paid) Object.assign(transaction, { refunded_amount: 0, status: 'paid' });
  const left = transaction.amount_paid - transaction.refunded_amount;
  const amount = dispute ? fake.amount : Math.max(0, Math.min(left, Number(url.searchParams.get('amount')) || left));
  if (dispute) transaction.status = 'chargedBack';
  else {
    transaction.refunded_amount += amount;
    transaction.status = transaction.refunded_amount >= transaction.amount_paid ? 'refunded' : 'partialRefund';
  }
  fakeTransactions.set(transactionId, transaction);
  const created = Date.now();
  const customer = { id: 'cust_fake', email: fake.metadata?.kind === 'gift' ? 'buyer@acme.example' : 'buyer@example.com' };
  const object = dispute
    ? { id: `disp_fake_${randomBytes(6).toString('hex')}`, object: 'dispute', amount, currency: fake.currency, transaction: { id: transactionId, status: 'chargeback' }, customer, created_at: created }
    : { id: `ref_fake_${randomBytes(6).toString('hex')}`, object: 'refund', status: 'succeeded', refund_amount: amount, refund_currency: fake.currency, reason: 'requested_by_customer', transaction: { id: transactionId, amount: transaction.amount, amount_paid: transaction.amount_paid, status: transaction.status }, customer, created_at: created };
  const raw = JSON.stringify({ id: `evt_fake_${randomBytes(6).toString('hex')}`, eventType: dispute ? 'dispute.created' : 'refund.created', created_at: created, object });
  const secret = (process.env.CREEM_WEBHOOK_SECRET || FAKE_WEBHOOK_SECRET).trim();
  const result = await plannerApi(new Request(`${devBaseUrl()}/api/creem/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'creem-signature': await webhookSignature(raw, secret) }, body: raw }));
  console.log(`  [fake creem] ${dispute ? 'disputed' : 'refunded'} ${id}: ${(amount / 100).toFixed(2)} ${fake.currency} (${object.id}) → webhook HTTP ${result.status}`);
  answer(200, { refund: object.id, kind: dispute ? 'dispute' : 'refund', amount, currency: fake.currency, transaction: transactionId, webhook: { status: result.status, body: await result.json().catch(() => null) } });
}

function creemOptions() {
  const env = process.env;
  const options = { creemApiKey: env.CREEM_API_KEY || '', creemWebhookSecret: env.CREEM_WEBHOOK_SECRET || '', creemTestMode: env.CREEM_TEST_MODE || '', creemTestOnProduction: env.CREEM_TEST_ON_PRODUCTION || '', creemProducts: creemProductsFromEnv(env) };
  const webhook = `${options.creemWebhookSecret ? ', webhook on' : ''}${/^(?:1|true|yes|on)$/i.test(options.creemTestOnProduction.trim()) ? ', review mode on' : ''}`;
  if (fakeCreem) {
    creemLabel = `fake (/?checkout_id=fake_plus, /welcome/thanks/?checkout_id=fake_gift50, POST /__fake-creem/refund?checkout=…${webhook})`;
    return { ...options, creemApiKey: 'creem_test_fake', creemTestMode: '1', creemProducts: FAKE_PRODUCTS, creemFetch: fakeCreemFetch, creemWebhookSecret: options.creemWebhookSecret || FAKE_WEBHOOK_SECRET };
  }
  if (options.creemApiKey) creemLabel = `CREEM_API_KEY (${creemMode(options.creemApiKey, options.creemTestMode)} mode${webhook})`;
  return options;
}

async function plusOptions() {
  const fromEnv = (process.env.PLUS_SIGNING_KEY || '').trim();
  if (fromEnv) {
    plusSigningKey = fromEnv;
    plusPublicKey = await publicKeyFromSigningKey(fromEnv);
    plusMode = plusPublicKey ? 'PLUS_SIGNING_KEY' : 'PLUS_SIGNING_KEY is not a valid P-256 key, Plus is off';
  } else {
    ({ signingKey: plusSigningKey, publicKey: plusPublicKey } = await generatePlusKeyPair());
    devLicenses = true;
    plusMode = 'dev keys (new on every start; POST /api/dev/license)';
  }
  return { plusSigningKey };
}

// Build variables the served runtime-config.js takes from this environment,
// as scripts/build.mjs does (see the header).
const ENV_CONFIG = [
  ['SUPPORT_EMAIL', 'DAILY_PLANNER_SUPPORT_EMAIL'],
  ['PRIVACY_EMAIL', 'DAILY_PLANNER_PRIVACY_EMAIL'],
  ['LEGAL_PHONE', 'DAILY_PLANNER_LEGAL_PHONE'],
  ['LEGAL_ADDRESS', 'DAILY_PLANNER_LEGAL_ADDRESS'],
  ['LEGAL_REGISTRATION', 'DAILY_PLANNER_LEGAL_REGISTRATION'],
  ['AFFILIATE_URL', 'DAILY_PLANNER_AFFILIATE_URL'],
  ['PROJECT_GITHUB_URL', 'DAILY_PLANNER_GITHUB_URL'],
  ['SOCIAL_X_URL', 'DAILY_PLANNER_X_URL'],
  ['SOCIAL_LINKEDIN_URL', 'DAILY_PLANNER_LINKEDIN_URL']
];

// Served runtime-config.js: the build variables set in this environment; with
// --api, the local API and the public key licences are checked with.
function devRuntimeConfig(source) {
  let text = source;
  for (const [key, variable] of ENV_CONFIG) {
    const value = String(process.env[variable] || '').trim();
    // A function, so a “$” in the value is written as it is.
    if (value) text = text.replace(`${key}: ''`, () => `${key}: ${JSON.stringify(value)}`);
  }
  if (!plannerApi) return text;
  text = text.replace("PLANNER_API_URL: ''", "PLANNER_API_URL: '/api'");
  if (plusPublicKey) {
    if (/PLUS_PUBLIC_KEY:\s*''/.test(text)) text = text.replace(/PLUS_PUBLIC_KEY:\s*''/, `PLUS_PUBLIC_KEY: '${plusPublicKey}'`);
    else if (!/PLUS_PUBLIC_KEY\s*:/.test(text)) text = text.replace('Object.freeze({', `Object.freeze({\n  PLUS_PUBLIC_KEY: '${plusPublicKey}',`);
  }
  return text;
}

if (withApi) {
  const saved = await fs.readFile(devDataFile, 'utf8').then(JSON.parse).catch(() => ({}));
  let writeTimer = null;
  const store = createMemoryStore(saved, {
    onChange: data => {
      clearTimeout(writeTimer);
      writeTimer = setTimeout(async () => {
        await fs.mkdir(dirname(devDataFile), { recursive: true });
        await fs.writeFile(devDataFile, JSON.stringify(data, null, 2));
      }, 120);
    }
  });
  const options = { ...emailOptions(), ...creemOptions(), ...await plusOptions() };
  plannerApi = createPlannerApi({ store, adminToken, adminTotpSecret, ...options, publicBaseUrl: devBaseUrl, ...configCheckOptions(options) });
}

// The configuration page (/admin/configuration/, POST /api/admin/config/check) checks what this server really
// uses, under the production names: the secrets in effect (the pretend ones with --fake-email and
// --fake-creem, whose stand-ins answer its read-only calls), the build variables of the served
// runtime-config.js, and that file itself (ASSETS, as on Cloudflare). There is no D1 here: the page says so.
function configCheckOptions(options) {
  const products = options.creemProducts || {};
  const env = {
    ...Object.fromEntries(CONFIG_VARIABLES.map(def => [def.name, process.env[def.name] || ''])),
    ADMIN_TOKEN: adminToken, ADMIN_TOTP_SECRET: adminTotpSecret,
    RESEND_API_KEY: options.resendApiKey, EMAIL_FROM: options.emailFrom, OWNER_EMAIL: options.ownerEmail, EMAIL_DAILY_LIMIT: options.emailDailyLimit,
    CREEM_API_KEY: options.creemApiKey, CREEM_WEBHOOK_SECRET: options.creemWebhookSecret, CREEM_TEST_MODE: options.creemTestMode, CREEM_TEST_ON_PRODUCTION: options.creemTestOnProduction,
    CREEM_PLUS_EUR: products.plus?.EUR || '', CREEM_PLUS_USD: products.plus?.USD || '', CREEM_GIFT_EUR: products.gift?.EUR || '', CREEM_GIFT_USD: products.gift?.USD || '',
    PLUS_SIGNING_KEY: options.plusSigningKey, DAILY_PLANNER_PLUS_PUBLIC_KEY: plusPublicKey, DAILY_PLANNER_API_URL: '/api',
    ASSETS: { fetch: async () => new Response(devRuntimeConfig(await fs.readFile(join(root, 'runtime-config.js'), 'utf8')), { headers: { 'content-type': 'text/javascript; charset=utf-8' } }) }
  };
  const senderDomain = (/@([A-Za-z0-9.-]+)>?\s*$/.exec(options.emailFrom || '')?.[1] || '').toLowerCase();
  async function configFetch(url, init = {}) {
    const target = new URL(url);
    if (fakeCreem && /(?:^|\.)creem\.io$/.test(target.hostname)) return fakeCreemFetch(url, init);
    // The pretend Resend has one domain, verified: the sender's.
    if (fakeEmail && target.hostname === 'api.resend.com' && target.pathname === '/domains') {
      return fakeJson(200, { object: 'list', has_more: false, data: [{ id: 'fake-domain', name: senderDomain, status: 'verified', region: 'eu-west-1', capabilities: { sending: 'enabled', receiving: 'disabled' } }] });
    }
    return fetch(url, init);
  }
  return { configEnv: env, configFetch };
}

async function devLicense(request, response) {
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', [MARKER]: '1' };
  if (request.method !== 'POST') { response.writeHead(405, headers).end(JSON.stringify({ error: 'Method not allowed' })); return; }
  request.resume();
  const license = await signLicense(await importSigningKey(plusSigningKey), { src: 'dev' });
  response.writeHead(200, headers).end(JSON.stringify({ license }));
}

async function handleApi(request, response) {
  const headers = new Headers();
  Object.entries(request.headers).forEach(([key, value]) => { if (value != null) headers.set(key, Array.isArray(value) ? value.join(', ') : value); });
  // Stands in for Cloudflare's country header, which decides the currency in production.
  if (devCountry && !headers.has('cf-ipcountry')) headers.set('cf-ipcountry', devCountry);
  const hasBody = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
  const webRequest = new Request(new URL(request.url, `http://${/^[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(request.headers.host || '') ? request.headers.host : `localhost:${port}`}`), { method: request.method, headers, body: hasBody ? Readable.toWeb(request) : undefined, duplex: 'half' });
  const result = await plannerApi(webRequest);
  response.writeHead(result.status, Object.fromEntries([...result.headers.entries(), [MARKER, '1']]));
  response.end(Buffer.from(await result.arrayBuffer()));
}

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2'
};

try {
  await fs.access(join(root, 'index.html'));
} catch {
  console.error(useDist
    ? 'No production build found. Run "npm run build" first, or start without --dist.'
    : `index.html not found in ${root}.`);
  process.exit(1);
}

// Redirects from _redirects (“/privacy /legal/privacy/ 301”, “/welcome/teams/* /teams/:splat 301”), as
// Cloudflare Pages applies them: the first matching line, the query string kept (scripts/redirects.mjs).
const redirects = parseRedirects(await fs.readFile(join(root, '_redirects'), 'utf8').catch(() => ''));

async function handle(request, response) {
  try {
    const url = new URL(request.url, 'http://localhost');
    const redirect = redirectFor(redirects, url.pathname, url.search);
    if (redirect) { response.writeHead(redirect.status, { location: redirect.location, 'cache-control': 'no-store', [MARKER]: '1' }).end(); return; }
    if (devLicenses && url.pathname === '/api/dev/license') { await devLicense(request, response); return; }
    if (plannerApi && fakeCreem && url.pathname === '/__fake-creem/pay') { fakePayPage(url, response); return; }
    if (plannerApi && fakeCreem && url.pathname === '/__fake-creem/refund') { await fakeRefund(request, url, response); return; }
    if (plannerApi && fakeCreem && url.pathname === '/__fake-creem/link' && request.method === 'POST') { fakeLink(request, url, response); return; }
    if (plannerApi && url.pathname.startsWith('/api/')) { await handleApi(request, response); return; }
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = resolve(root, `.${pathname}`);
    // Never serve paths outside the root, dotfiles (.git, .github) or dependencies.
    // Segments come from the resolved path so "\" separators on Windows are covered too.
    const segments = relative(root, file).split(sep);
    if ((file !== root && !file.startsWith(root + sep)) || segments.some(part => part.startsWith('.') || part === 'node_modules')) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    let target = file;
    const stat = await fs.stat(target).catch(() => null);
    if (stat?.isDirectory()) {
      target = join(target, 'index.html');
      // "/admin" must become "/admin/" so the page's relative links
      // (./admin.css, ./admin.js) resolve inside the folder.
      if (!url.pathname.endsWith('/') && await fs.stat(target).then(found => found.isFile(), () => false)) {
        // One leading slash only: "//host/" would be read as another site.
        response.writeHead(301, { location: `/${url.pathname.replace(/^\/+/, '')}/${url.search}`, 'cache-control': 'no-store', [MARKER]: '1' }).end();
        return;
      }
    }
    let body = await fs.readFile(target);
    // The served runtime config: the build variables of this environment, and with --api the local API and its
    // Plus public key, unless a build already set them (dist/ writes its values another way, so it is left as built).
    if (relative(root, target) === 'runtime-config.js') body = Buffer.from(devRuntimeConfig(body.toString('utf8')));
    response.writeHead(200, {
      'content-type': types[extname(target).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
      [MARKER]: '1'
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', [MARKER]: '1' }).end('Not found');
  }
}

async function isPlannerRunning(port) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1200);
    const result = await fetch(`http://127.0.0.1:${port}/manifest.webmanifest`, { signal: controller.signal });
    clearTimeout(timer);
    if (result.headers.get(MARKER)) return true;
    return (await result.text()).includes('Daily Planner');
  } catch {
    return false;
  }
}

function openBrowser(url) {
  const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const commandArgs = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(command, commandArgs, { stdio: 'ignore', detached: true, windowsHide: true }).unref();
  } catch {
    console.log(`Open ${url} in your browser.`);
  }
}

function listen(port) {
  return new Promise((resolveListen, rejectListen) => {
    const server = createServer(handle);
    server.once('error', rejectListen);
    server.listen(port, host, () => resolveListen(server));
  });
}

function lanAddresses(port) {
  return Object.values(networkInterfaces()).flat()
    .filter(address => address && address.family === 'IPv4' && !address.internal)
    .map(address => `http://${address.address}:${port}`);
}

let port = preferredPort;
let server = null;
for (let attempt = 0; attempt < 15 && !server; attempt += 1) {
  try {
    server = await listen(port);
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    if (port === preferredPort && await isPlannerRunning(port)) {
      const url = `http://localhost:${port}`;
      console.log(`Daily Planner is already running at ${url}`);
      if (shouldOpen) openBrowser(url);
      process.exit(0);
    }
    if (port === preferredPort) {
      console.warn(`Port ${preferredPort} is used by another program.`);
      console.warn('Heads-up: browsers keep planner data per address, so plans saved on');
      console.warn(`http://localhost:${preferredPort} will not appear on a different port. Free port ${preferredPort} to keep the same data.`);
    }
    port += 1;
  }
}

if (!server) {
  console.error('Could not find a free port. Try: node scripts/serve.mjs --port 9000');
  process.exit(1);
}

const url = `http://localhost:${port}`;
console.log('');
console.log(`  Daily Planner ${useDist ? '(production build)' : '(source)'} is running`);
console.log(`  → ${url}`);
if (lan) lanAddresses(port).forEach(address => console.log(`  → ${address}  (other devices on this network)`));
console.log('');
if (plannerApi) {
  console.log(`  Owner dashboard → ${url}/admin/   (token: ${process.env.ADMIN_TOKEN ? 'from ADMIN_TOKEN' : `${adminToken} — set ADMIN_TOKEN to choose your own`}${adminTotpSecret ? ' · 2FA on' : ''})`);
  console.log(`  Email: ${emailMode} · Plus: ${plusMode} · Creem: ${creemLabel}`);
  if (devCountry) console.log(`  Visitors are treated as in ${devCountry} (currency from the country, as in production)`);
}
console.log('  Your plans stay in this browser. Press Ctrl+C to stop the server.');
console.log('');
if (shouldOpen) openBrowser(url);

const stop = () => server.close(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
