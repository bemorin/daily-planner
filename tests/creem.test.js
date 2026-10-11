import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createMemoryStore, createPlannerApi, EMAIL_SENDS_EVENT, PLUS_CLAIMS_MAX, REVIEWS_LATEST, seriesRange } from '../server/planner-api.js';
import { createD1Store } from '../server/d1-store.js';
import { generatePlusKeyPair, giftManageKey, verifyLicense } from '../server/licenses.js';
import { CHECKOUT_ID_RE, creemApiBase, creemMode, creemProductsFromEnv, parseCreemProducts, readCheckout, verifyWebhookSignature, webhookSignature } from '../server/creem.js';
import { priceCents, TEAM_TIERS } from '../src/lib/pricing.js';

const START = Date.parse('2026-10-09T08:00:00Z');
const KEYS = await generatePlusKeyPair();
const PRODUCTS = Object.freeze({ plus: { EUR: 'prod_plus_eur', USD: 'prod_plus_usd' }, gift: { EUR: 'prod_gift_eur', USD: 'prod_gift_usd' } });
const API_KEY = 'creem_test_abc123';
const WEBHOOK_SECRET = 'whsec_test_0123456789';
const MIGRATIONS = ['0001_planner_api.sql', '0002_team_requests.sql', '0003_plus.sql', '0004_creem_reviews.sql'];
const PAYMENT_UNKNOWN = 'We could not find this payment.';
const NOT_PLUS_PAYMENT = 'This payment is not for Daily Planner Plus.';

const request = (method, path, body, token) => new Request(`https://planner.test/api/${path}`, {
  method,
  headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
  ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) })
});
const get = (path, token) => request('GET', path, undefined, token);
const post = (path, body = {}, token) => request('POST', path, body, token);
const del = (path, token) => request('DELETE', path, undefined, token);
const asJson = async response => ({ status: response.status, body: await response.json() });
const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A Creem CheckoutEntity as GET /v1/checkouts answers it. */
function checkout(id, { item = 'plus', currency = 'EUR', plan = 'up-to-50', status = 'completed', orderStatus = 'paid', company = '', email = 'Buyer@Example.com', country = 'fr', amount, product, metadata, expanded = false } = {}) {
  const productId = product ?? PRODUCTS[item][currency];
  const cents = amount ?? priceCents(item, plan, currency);
  return {
    id, object: 'checkout', mode: 'test', status, units: 1, request_id: 'dp_0123456789abcdef',
    product: expanded ? { id: productId, object: 'product', price: cents, currency } : productId,
    ...(status === 'completed' || orderStatus === 'pending' ? { order: { id: 'ord_1', object: 'order', status: orderStatus, type: 'onetime', amount: cents, amount_paid: cents, currency: currency.toLowerCase() } } : {}),
    customer: { id: 'cust_1', object: 'customer', email, name: 'Ada Buyer', country },
    custom_fields: company ? [{ type: 'text', key: 'company', label: 'Company name, shown to your team', optional: true, text: { max_length: 80, value: company } }] : [],
    metadata: metadata ?? sealed(item === 'plus' ? { kind: 'plus' } : { kind: 'gift', plan, seats: '50' }, currency)
  };
}

const RID = 'dp_0123456789abcdef';
/** The seal POST /api/checkout puts in the metadata (HMAC with the Plus signing key). */
const sealOf = ({ kind, plan = '' }, currency, rid = RID) => createHmac('sha256', KEYS.signingKey).update(`checkout-seal:${kind}|${plan}|${currency}|${rid}`).digest('hex').slice(0, 32);
const sealed = (metadata, currency, rid = RID) => ({ ...metadata, currency, rid, seal: sealOf(metadata, currency, rid) });
const pick = (value, keys) => Object.fromEntries(keys.map(key => [key, value[key]]));
const READ_KEYS = ['completed', 'paid', 'productId', 'item', 'email', 'country', 'org', 'amount', 'currency'];

/** Stand-in for Creem: POST /v1/checkouts makes a pending checkout, GET reads `checkouts`. */
function fakeCreem(checkouts = {}, { status = 0, createStatus = 0, checkoutUrl } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    if (init.method === 'POST') {
      if (createStatus) return jsonResponse(createStatus, { statusCode: createStatus, message: ['product_id must be a string'] });
      const id = `ch_created${calls.length}x`;
      return jsonResponse(200, { id, object: 'checkout', status: 'pending', checkout_url: checkoutUrl === undefined ? `https://checkout.creem.io/${id}` : checkoutUrl });
    }
    if (status) return jsonResponse(status, { message: 'Something broke' });
    const id = new URL(url).searchParams.get('checkout_id');
    return Object.hasOwn(checkouts, id) ? jsonResponse(200, checkouts[id]) : jsonResponse(404, { message: ['Checkout not found'] });
  };
  return { fetch, calls, checkouts, reads: () => calls.filter(call => call.method === 'GET').length };
}

function fakeResend({ fail = () => 0 } = {}) {
  const calls = [];
  const delivered = new Set();
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    // Like Resend: a repeated Idempotency-Key after a success is answered without sending again.
    const key = init.headers?.['idempotency-key'];
    if (key && delivered.has(key)) return jsonResponse(200, { id: 'x' });
    calls.push({ url, body, headers: init.headers });
    const status = fail(calls.length);
    if (status) return jsonResponse(status, { statusCode: status, message: `Refused (${status})` });
    if (key) delivered.add(key);
    return jsonResponse(200, Array.isArray(body) ? { data: [] } : { id: 'x' });
  };
  return { fetch, calls };
}

function setup({ store = createMemoryStore(), clock = { now: START }, creem = fakeCreem(), resend = fakeResend(), ...options } = {}) {
  const deferred = [];
  const warnings = [];
  const api = createPlannerApi({
    store, adminToken: 'secret', now: () => new Date(clock.now), authFailureDelayMs: 0,
    plusSigningKey: KEYS.signingKey, creemApiKey: API_KEY, creemWebhookSecret: WEBHOOK_SECRET, creemProducts: PRODUCTS, creemFetch: creem.fetch,
    resendApiKey: 're_test_key', emailFrom: 'Ben Morin <hello@bemorin.example>', ownerEmail: 'owner@bemorin.example', emailFetch: resend.fetch, emailIntervalMs: 0,
    defer: promise => deferred.push(promise), warn: message => warnings.push(message),
    ...options
  });
  const settle = () => Promise.all(deferred.splice(0));
  return { api, store, clock, creem, resend, deferred, warnings, settle };
}

async function openSqlite(t, migrations = MIGRATIONS) {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { t.skip('node:sqlite is not available in this Node version'); return null; }
  const sqlite = new DatabaseSync(':memory:');
  for (const migration of migrations) sqlite.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
  return {
    sqlite,
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      let params = [];
      const api = {
        bind(...values) { params = values; return api; },
        async run() { return { meta: { changes: Number(statement.run(...params).changes) } }; },
        async all() { return { results: statement.all(...params) }; }
      };
      return api;
    }
  };
}

/** Run a test body once with the memory store and once with D1 over node:sqlite. */
async function bothStores(t, body) {
  await body('memory', createMemoryStore());
  const d1 = await openSqlite(t);
  if (d1) await body('D1', createD1Store(d1), d1);
}

/** POST a webhook event, signed with `secret` unless a `signature` (null: none) is given. */
async function sendWebhook(api, event, { secret = WEBHOOK_SECRET, signature, raw } = {}) {
  const body = raw ?? JSON.stringify(event);
  const value = signature === undefined ? await webhookSignature(body, secret) : signature;
  return api(new Request('https://planner.test/api/creem/webhook', { method: 'POST', headers: { 'content-type': 'application/json', ...(value === null ? {} : { 'creem-signature': value }) }, body }));
}
const completedEvent = object => ({ id: `evt_${object.id}`, eventType: 'checkout.completed', created_at: START, object });

test('Creem helpers read products, modes and checkouts defensively', () => {
  assert.deepEqual(creemProductsFromEnv({ CREEM_PLUS_EUR: ' prod_a ', CREEM_PLUS_USD: 'prod_b', CREEM_GIFT_EUR: '', STRIPE_SECRET_KEY: 'x' }), { plus: { EUR: 'prod_a', USD: 'prod_b' }, gift: { EUR: '', USD: '' } });
  const parsed = parseCreemProducts({ plus: { EUR: 'prod_a', USD: 'not a product' }, gift: { EUR: 'prod_a', USD: 'prod_g' } });
  assert.deepEqual(parsed.ids, { plus: { EUR: 'prod_a', USD: '' }, gift: { EUR: '', USD: 'prod_g' } });
  assert.deepEqual([...parsed.byId], [['prod_a', { kind: 'plus', currency: 'EUR' }], ['prod_g', { kind: 'gift', currency: 'USD' }]]);
  assert.match(parsed.error, /CREEM_PLUS_USD is not a product id/);
  assert.match(parsed.error, /CREEM_GIFT_EUR repeats another product id/);
  assert.equal(parseCreemProducts().error, '');
  assert.deepEqual([['', ''], ['creem_test_x', ''], ['creem_abc', ''], ['creem_abc', '1'], ['creem_abc', 'true'], ['creem_abc', '0']].map(([key, flag]) => creemMode(key, flag)), ['', 'test', 'live', 'test', 'test', 'live']);
  assert.deepEqual([creemApiBase('test'), creemApiBase('live'), creemApiBase('')], ['https://test-api.creem.io', 'https://api.creem.io', 'https://api.creem.io']);
  for (const id of ['ch_1QyIQDw9cbFWdA1ry5Qc6I', 'fake_plus', 'cs_test_a1B2c3d4']) assert.ok(CHECKOUT_ID_RE.test(id), id);
  for (const id of ['', 'ch_', 'ch_ab/../x', 'ch abcdef', '_leading', 'x'.repeat(201), 'ch_abcd?x=1']) assert.ok(!CHECKOUT_ID_RE.test(id), id);

  const { byId } = parseCreemProducts(PRODUCTS);
  assert.deepEqual(pick(readCheckout(checkout('ch_plus1', { country: 'fr' }), byId), READ_KEYS), { completed: true, paid: true, productId: 'prod_plus_eur', item: { kind: 'plus', plan: '', seats: 1 }, email: 'buyer@example.com', country: 'FR', org: '', amount: 2900, currency: 'EUR' });
  // Seats always come from the plan, never from the metadata alone; expanded objects work too.
  const gift = readCheckout(checkout('ch_gift1', { item: 'gift', currency: 'USD', plan: 'up-to-100', company: ' Acme ', metadata: { kind: 'gift', plan: 'up-to-100', seats: '100000' }, expanded: true }), byId);
  assert.deepEqual([gift.item, gift.org, gift.amount, gift.currency], [{ kind: 'gift', plan: 'up-to-100', seats: 100 }, 'Acme', 99500, 'USD']);
  assert.equal(readCheckout({ ...checkout('ch_x'), custom_fields: [{ key: 'company', value: 'Flat' }] }, byId).org, 'Flat');
  assert.equal(readCheckout({ ...checkout('ch_x'), customer: 'cust_1', customer_email: 'Someone@Example.com' }, byId).email, 'someone@example.com');
  assert.equal(readCheckout({ ...checkout('ch_x'), customer: 'cust_1' }, byId).email, '');
  assert.equal(readCheckout({ ...checkout('ch_x'), order: { ...checkout('ch_x').order, amount_paid: 2400 } }, byId).amount, 2400, 'what was paid (a discount)');
  // Not complete, not ours, not matching.
  assert.deepEqual(Object.values(readCheckout(checkout('ch_x', { status: 'pending' }), byId)).slice(0, 2), [false, false]);
  assert.deepEqual(Object.values(readCheckout(checkout('ch_x', { orderStatus: 'pending' }), byId)).slice(0, 2), [true, false]);
  assert.equal(readCheckout(checkout('ch_x', { status: 'expired' }), byId).paid, false);
  assert.equal(readCheckout(checkout('ch_x', { product: 'prod_tshirt' }), byId).item, null);
  assert.equal(readCheckout(checkout('ch_x', { item: 'gift', metadata: { kind: 'gift', plan: 'up-to-20', seats: '20' } }), byId).item, null, 'a plan that is not a tier');
  assert.equal(readCheckout(checkout('ch_x', { item: 'gift', metadata: { kind: 'gift', plan: 'over-1000' } }), byId).item, null, 'quotes are never sold online');
  assert.equal(readCheckout(checkout('ch_x', { item: 'gift', metadata: {} }), byId).item, null, 'a gift needs its plan');
  assert.equal(readCheckout(checkout('ch_x', { metadata: { kind: 'gift', plan: 'up-to-50' } }), byId).item, null, 'metadata must match the product');
  assert.deepEqual(readCheckout(checkout('ch_x', { metadata: {} }), byId).item, { kind: 'plus', plan: '', seats: 1 }, 'a Plus product needs no metadata');
  assert.deepEqual(pick(readCheckout(null, byId), READ_KEYS), { completed: false, paid: false, productId: '', item: null, email: '', country: '', org: '', amount: null, currency: '' });
});

test('webhook signatures: hex HMAC-SHA256 of the raw body, compared in constant time', async () => {
  const raw = JSON.stringify(completedEvent(checkout('ch_sig123456')));
  const expected = createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');
  assert.equal(await webhookSignature(raw, WEBHOOK_SECRET), expected);
  assert.equal(await webhookSignature(new TextEncoder().encode(raw), WEBHOOK_SECRET), expected, 'bytes or text');
  assert.equal(await verifyWebhookSignature(raw, expected, WEBHOOK_SECRET), true);
  assert.equal(await verifyWebhookSignature(raw, ` ${expected.toUpperCase()} `, WEBHOOK_SECRET), true);
  assert.equal(await verifyWebhookSignature(`${raw} `, expected, WEBHOOK_SECRET), false, 'one byte more');
  assert.equal(await verifyWebhookSignature(raw, expected, 'whsec_other'), false);
  assert.equal(await verifyWebhookSignature(raw, expected, ''), false, 'never valid without a secret');
  for (const bad of ['', null, expected.slice(1), `${expected}0`, 'z'.repeat(64)]) assert.equal(await verifyWebhookSignature(raw, bad, WEBHOOK_SECRET), false, String(bad));
});

test('GET /api/checkout lists what can be bought, and nothing while payments are off', async () => {
  const creem = fakeCreem();
  const answer = async options => (await asJson(await setup({ creem, ...options }).api(get('checkout')))).body;
  assert.deepEqual(await answer({}), { plus: ['EUR', 'USD'], gift: ['EUR', 'USD'], test: true });
  assert.deepEqual(await answer({ creemApiKey: 'creem_live_key' }), { plus: ['EUR', 'USD'], gift: ['EUR', 'USD'], test: false });
  assert.deepEqual(await answer({ creemApiKey: 'creem_live_key', creemTestMode: '1' }), { plus: ['EUR', 'USD'], gift: ['EUR', 'USD'], test: true });
  assert.deepEqual(await answer({ creemProducts: { plus: { EUR: 'prod_plus_eur' } } }), { plus: ['EUR'], gift: [], test: true });
  for (const off of [{ creemApiKey: '' }, { creemProducts: {} }, { plusSigningKey: '' }, { plusSigningKey: 'bm90IGEga2V5' }]) {
    assert.deepEqual(await answer(off), { plus: [], gift: [], test: false }, JSON.stringify(off));
  }
  assert.equal(creem.calls.length, 0, 'answered without asking Creem');
  assert.equal((await setup().api(request('PATCH', 'checkout', {}))).status, 405);
});

test('POST /api/checkout opens a Creem checkout with our product, price and metadata', async () => {
  const creem = fakeCreem();
  const { api } = setup({ creem });
  const plus = await asJson(await api(post('checkout', { item: 'plus', currency: 'EUR' })));
  assert.deepEqual(plus, { status: 201, body: { url: 'https://checkout.creem.io/ch_created1x' } });
  const [call] = creem.calls;
  assert.equal(call.url, 'https://test-api.creem.io/v1/checkouts');
  assert.equal(call.method, 'POST');
  assert.equal(call.headers['x-api-key'], API_KEY);
  assert.match(call.body.request_id, /^dp_[0-9a-f]{16}$/);
  const plusRid = call.body.request_id;
  assert.deepEqual({ ...call.body, request_id: 'dp' }, { product_id: 'prod_plus_eur', request_id: 'dp', success_url: 'https://planner.test/', metadata: sealed({ kind: 'plus' }, 'EUR', plusRid) }, 'Plus uses the product price and comes back to the address it was opened from');

  const gift = await asJson(await api(post('checkout', { item: 'gift', plan: 'up-to-50', currency: 'usd' })));
  assert.equal(gift.status, 201);
  const body = creem.calls[1].body;
  assert.notEqual(body.request_id, call.body.request_id);
  assert.deepEqual({ ...body, request_id: 'dp' }, {
    product_id: 'prod_gift_usd', request_id: 'dp', units: 1, custom_price: 59500,
    custom_fields: [{ type: 'text', key: 'company', label: 'Company name, shown to your team', optional: true, text: { max_length: 80 } }],
    success_url: 'https://planner.test/welcome/thanks/', metadata: sealed({ kind: 'gift', plan: 'up-to-50', seats: '50' }, 'USD', body.request_id)
  }, 'the seal binds the pack, the currency and the request');
  assert.ok(body.custom_fields[0].label.length <= 50);
  for (const tier of TEAM_TIERS) {
    for (const currency of ['EUR', 'USD']) {
      await api(post('checkout', { item: 'gift', plan: tier.plan, currency }));
      const sent = creem.calls.at(-1).body;
      assert.deepEqual([sent.custom_price, sent.metadata.seats, sent.product_id], [tier.price[currency] * 100, String(tier.seats), PRODUCTS.gift[currency]], `${tier.plan} ${currency}`);
    }
  }

  // Live mode and another public address.
  const live = setup({ creem: fakeCreem(), creemApiKey: 'creem_live_key', publicBaseUrl: 'https://staging.example/planner/' });
  const onStaging = new Request('https://staging.example/api/checkout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ item: 'plus', currency: 'USD' }) });
  assert.equal((await live.api(onStaging)).status, 201);
  assert.equal(live.creem.calls[0].url, 'https://api.creem.io/v1/checkouts');
  assert.equal(live.creem.calls[0].body.success_url, 'https://staging.example/planner/', 'the public address, path included, when opened from it');

  // Test keys never sell on the production address (anyone could pay with a test card).
  const testOnProduction = setup({ creem: fakeCreem(), publicBaseUrl: 'https://planner.test' });
  assert.deepEqual((await asJson(await testOnProduction.api(get('checkout')))).body, { plus: [], gift: [], test: false });
  assert.equal((await testOnProduction.api(post('checkout', { item: 'plus', currency: 'EUR' }))).status, 503);
  assert.equal(testOnProduction.creem.calls.length, 0);
  const localhost = new Request('http://localhost:8080/api/checkout', { method: 'GET' });
  assert.deepEqual((await asJson(await setup({ creem: fakeCreem(), publicBaseUrl: 'http://localhost:8080' }).api(localhost))).body.plus, ['EUR', 'USD'], 'local development is never production');
});

test('POST /api/checkout refuses unknown items cheaply and says when payments are off or Creem fails', async () => {
  const creem = fakeCreem();
  const { api } = setup({ creem });
  for (const body of [{ item: 'tshirt', currency: 'EUR' }, { currency: 'EUR' }, { item: 'plus', currency: 'GBP' }, { item: 'plus' }, { item: 'gift', currency: 'EUR' }, { item: 'gift', plan: 'over-1000', currency: 'EUR' }, { item: 'gift', plan: 'up-to-20', currency: 'EUR' }, { item: ['plus'], currency: 'EUR' }]) {
    const refused = await asJson(await api(post('checkout', body)));
    assert.equal(refused.status, 400, JSON.stringify(body));
    assert.ok(refused.body.error.length > 10);
  }
  assert.deepEqual(await asJson(await api(post('checkout', '{nope'))), { status: 400, body: { error: 'Invalid JSON' } });
  assert.equal(creem.calls.length, 0, 'nothing reached Creem');

  for (const off of [{ creemApiKey: '' }, { creemProducts: { plus: { EUR: 'prod_plus_eur' } } }, { plusSigningKey: '' }]) {
    const answer = await asJson(await setup({ creem, ...off }).api(post('checkout', { item: 'gift', plan: 'up-to-10', currency: 'EUR' })));
    assert.deepEqual(answer, { status: 503, body: { error: 'Payments are not set up yet.' } }, JSON.stringify(off));
  }
  assert.equal(creem.calls.length, 0);

  const failing = setup({ creem: fakeCreem({}, { createStatus: 400 }) });
  assert.deepEqual(await asJson(await failing.api(post('checkout', { item: 'plus', currency: 'EUR' }))), { status: 502, body: { error: 'The checkout could not be opened. Please try again in a minute.' } });
  assert.match(failing.warnings[0], /Creem answered HTTP 400: product_id must be a string/);
  for (const checkoutUrl of [null, '', 'javascript:alert(1)', '/relative']) {
    const odd = setup({ creem: fakeCreem({}, { checkoutUrl }) });
    assert.equal((await odd.api(post('checkout', { item: 'plus', currency: 'EUR' }))).status, 502, String(checkoutUrl));
  }
  const throwing = setup({ creem: { fetch: async () => { throw new Error('network down'); } } });
  assert.equal((await throwing.api(post('checkout', { item: 'plus', currency: 'EUR' }))).status, 502);
  assert.match(throwing.warnings[0], /network down/);
});

test('a Creem Plus purchase becomes a licence, the same one on every claim (memory and D1)', async t => {
  await bothStores(t, async (label, store) => {
    const creem = fakeCreem({ ch_plus123456: checkout('ch_plus123456') });
    const { api } = setup({ store, creem });
    const first = await asJson(await api(post('purchases/claim', { checkout: ' ch_plus123456 ' })));
    assert.equal(first.status, 200, label);
    assert.deepEqual(Object.keys(first.body), ['kind', 'license'], label);
    const payload = await verifyLicense(KEYS.publicKey, first.body.license);
    assert.deepEqual([payload.src, payload.org, payload.iat], ['purchase', undefined, '2026-10-09'], label);
    // Creem was asked exactly as documented.
    assert.equal(creem.calls.length, 1, label);
    assert.equal(creem.calls[0].url, 'https://test-api.creem.io/v1/checkouts?checkout_id=ch_plus123456');
    assert.equal(creem.calls[0].method, 'GET');
    assert.equal(creem.calls[0].headers['x-api-key'], API_KEY);
    const row = await store.getPurchase('ch_plus123456');
    assert.deepEqual([row.kind, row.claims, row.email, row.licenseId, row.checkoutRef], ['plus', 1, 'buyer@example.com', payload.id, 'ch_plus123456'], label);
    const payment = await store.getPayment('ch_plus123456');
    assert.deepEqual({ ...payment, seats: Number(payment.seats) }, { checkoutId: 'ch_plus123456', kind: 'plus', plan: '', seats: 1, amount: 2900, currency: 'EUR', country: 'FR', createdAt: '2026-10-09T08:00:00.000Z', emailedAt: null }, label);
    // Claims 2…10 answer the same licence id from the database; the older `session` field works too.
    for (let claim = 2; claim <= PLUS_CLAIMS_MAX; claim += 1) {
      const again = await asJson(await api(post('purchases/claim', claim === 2 ? { session: 'ch_plus123456' } : { checkout: 'ch_plus123456' })));
      assert.equal(again.status, 200, `${label} claim ${claim}`);
      assert.equal((await verifyLicense(KEYS.publicKey, again.body.license)).id, payload.id);
    }
    assert.equal(creem.calls.length, 1, `${label}: Creem is asked once`);
    const eleventh = await asJson(await api(post('purchases/claim', { checkout: 'ch_plus123456' })));
    assert.equal(eleventh.status, 409, label);
    assert.match(eleventh.body.error, /10 times/);
    assert.equal((await asJson(await api(get('admin/summary', 'secret')))).body.plus.purchases, 1, label);
  });
});

test('a Creem team gift becomes one gift, emailed once to the buyer (memory and D1)', async t => {
  await bothStores(t, async (label, store) => {
    const creem = fakeCreem({
      ch_gift50abcdef: checkout('ch_gift50abcdef', { item: 'gift', plan: 'up-to-50', company: 'Acme <Studio>', email: 'Boss@Acme.example' }),
      ch_gift10nocomp: checkout('ch_gift10nocomp', { item: 'gift', plan: 'up-to-10', currency: 'USD', metadata: sealed({ kind: 'gift', plan: 'up-to-10', seats: '99999' }, 'USD') })
    });
    const { api, resend, settle } = setup({ store, creem });
    const first = await asJson(await api(post('purchases/claim', { checkout: 'ch_gift50abcdef' })));
    assert.equal(first.status, 200, label);
    const answer = first.body;
    assert.deepEqual(Object.keys(answer), ['kind', 'code', 'url', 'seats', 'redeemed', 'org', 'message', 'manageKey', 'manageUrl', 'expiresAt'], label);
    assert.match(answer.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.equal(answer.url, `https://planner.bemorin.com/?gift=${answer.code}`);
    assert.deepEqual([answer.kind, answer.seats, answer.redeemed, answer.org, answer.message], ['gift', 50, 0, 'Acme <Studio>', ''], label);
    assert.equal(answer.manageKey, await giftManageKey(KEYS.signingKey, answer.code));
    await settle();
    // The buyer gets one email: the link, the manage link and a message to forward.
    assert.equal(resend.calls.length, 1, label);
    const email = resend.calls[0].body;
    assert.deepEqual(email.to, ['boss@acme.example']);
    assert.equal(email.reply_to, 'owner@bemorin.example');
    assert.equal(email.subject, 'Your Daily Planner Plus gift link for Acme <Studio>');
    for (const part of [answer.url, answer.manageUrl, 'up to 50 people', '9 October 2027']) assert.ok(email.text.includes(part), part);
    assert.ok(email.html.includes('Acme &lt;Studio&gt;') && !email.html.includes('<Studio>'), 'escaped in HTML');
    assert.equal(await store.emailSendsOn('2026-10-09', EMAIL_SENDS_EVENT), 1, label);

    // Claiming again returns the same gift, without Creem and without a second email.
    const again = await asJson(await api(post('purchases/claim', { checkout: 'ch_gift50abcdef' })));
    await settle();
    assert.equal(again.body.code, answer.code, label);
    assert.deepEqual([creem.reads(), resend.calls.length], [1, 1], label);
    const stored = await store.getGift(answer.code.replace(/-/g, ''));
    assert.deepEqual([stored.source, stored.checkoutRef, stored.currency, stored.amount, stored.buyerEmail, stored.note], ['creem', 'ch_gift50abcdef', 'EUR', 59500, 'boss@acme.example', 'Test mode · Creem · Up to 50 people'], label);
    assert.ok(stored.emailedAt, label);
    const payment = await store.getPayment('ch_gift50abcdef');
    assert.deepEqual([payment.kind, payment.plan, Number(payment.seats), payment.amount, payment.currency], ['gift', 'up-to-50', 50, 59500, 'EUR'], label);

    // Seats come from the plan; without the company field the gift says "Your company".
    const other = await asJson(await api(post('purchases/claim', { checkout: 'ch_gift10nocomp' })));
    assert.deepEqual([other.body.seats, other.body.org], [10, 'Your company'], label);
    const summary = (await asJson(await api(get('admin/summary', 'secret')))).body;
    assert.deepEqual(summary.giftTotals, { count: 2, seats: 60, redeemed: 0, paid: 2 }, label);
    assert.equal(summary.plus.purchases, 0, label);
  });
});

test('a paid gift is switched off by Delete, never erased and recreated by the next claim', async () => {
  const creem = fakeCreem({ ch_gift50keep12: checkout('ch_gift50keep12', { item: 'gift', company: 'Acme' }) });
  const { api, store } = setup({ creem });
  const first = (await asJson(await api(post('purchases/claim', { checkout: 'ch_gift50keep12' })))).body;
  const code = first.code.replace(/-/g, '');
  assert.deepEqual(await asJson(await api(del(`admin/gifts/${code}`, 'secret'))), { status: 200, body: { removed: false, deactivated: true } });
  assert.equal((await store.getGift(code)).active, false);
  const again = (await asJson(await api(post('purchases/claim', { checkout: 'ch_gift50keep12' })))).body;
  assert.equal(again.code, first.code, 'the buyer gets the same, switched-off gift back');
  assert.equal((await asJson(await api(get(`gifts/${code}`)))).body.status, 'inactive');
  assert.deepEqual(await asJson(await api(post(`gifts/${code}/redeem`))), { status: 410, body: { error: 'This gift link is no longer active.' } });
  // The webhook does not bring it back either.
  assert.equal((await sendWebhook(api, completedEvent(creem.checkouts.ch_gift50keep12))).status, 200);
  assert.equal((await store.listGifts()).length, 1);
  assert.equal(creem.reads(), 1, 'Creem was asked once');
});

test('a gift email Resend refused is tried again on the next claim', async () => {
  const creem = fakeCreem({ ch_gift50retry1: checkout('ch_gift50retry1', { item: 'gift', company: 'Acme' }) });
  const resend = fakeResend({ fail: call => (call === 1 ? 500 : 0) });
  const { api, store, settle, warnings } = setup({ creem, resend });
  const first = (await asJson(await api(post('purchases/claim', { checkout: 'ch_gift50retry1' })))).body;
  await settle();
  assert.match(warnings[0], /Gift email not sent.*500/);
  assert.equal((await store.getGift(first.code.replace(/-/g, ''))).emailedAt, null);
  await api(post('purchases/claim', { checkout: 'ch_gift50retry1' }));
  await settle();
  assert.equal(resend.calls.length, 2);
  await api(post('purchases/claim', { checkout: 'ch_gift50retry1' }));
  await settle();
  assert.equal(resend.calls.length, 2, 'sent once, never again');
  // Without email set up, the claim still works and nothing is attempted.
  const quiet = setup({ creem: fakeCreem({ ch_gift50quiet1: checkout('ch_gift50quiet1', { item: 'gift' }) }), resendApiKey: '' });
  assert.equal((await quiet.api(post('purchases/claim', { checkout: 'ch_gift50quiet1' }))).status, 200);
  assert.equal(quiet.deferred.length, 0);
});

test('claims that cannot be honoured: pending, expired, unknown, not ours, wrong plan, Creem down, not configured', async () => {
  const checkouts = {
    ch_pending12345: checkout('ch_pending12345', { status: 'pending' }),
    ch_processing12: checkout('ch_processing12', { status: 'processing' }),
    ch_orderpending: checkout('ch_orderpending', { orderStatus: 'pending' }),
    ch_expired12345: checkout('ch_expired12345', { status: 'expired' }),
    ch_tshirt123456: checkout('ch_tshirt123456', { product: 'prod_tshirt' }),
    ch_wrongplan123: checkout('ch_wrongplan123', { item: 'gift', metadata: { kind: 'gift', plan: 'up-to-20', seats: '20' } }),
    ch_mismatch1234: checkout('ch_mismatch1234', { metadata: { kind: 'gift', plan: 'up-to-50' } })
  };
  const creem = fakeCreem(checkouts);
  const { api, store, clock } = setup({ creem });
  const claim = checkoutId => api(post('purchases/claim', { checkout: checkoutId }));
  assert.deepEqual(await asJson(await claim('ch_pending12345')), { status: 402, body: { error: 'This payment is not complete yet.' } });
  assert.equal((await claim('ch_processing12')).status, 402);
  assert.equal((await claim('ch_orderpending')).status, 402);
  assert.equal(await store.getPurchase('ch_pending12345'), null, 'nothing stored before payment');
  assert.equal(await store.getPayment('ch_pending12345'), null);
  assert.deepEqual(await asJson(await claim('ch_expired12345')), { status: 410, body: { error: 'This checkout expired before it was paid.' } });
  assert.deepEqual(await asJson(await claim('ch_missing12345')), { status: 404, body: { error: PAYMENT_UNKNOWN } });
  for (const id of ['ch_tshirt123456', 'ch_wrongplan123', 'ch_mismatch1234']) assert.deepEqual(await asJson(await claim(id)), { status: 404, body: { error: NOT_PLUS_PAYMENT } }, id);
  const reads = creem.reads();
  for (const checkoutId of ['', 'ch_', 'ch_abc/../x1234', 'ch abcdefgh', 'x'.repeat(300), 42, null, { id: 'ch_plus123456' }]) {
    assert.deepEqual(await asJson(await claim(checkoutId)), { status: 404, body: { error: PAYMENT_UNKNOWN } }, JSON.stringify(checkoutId));
  }
  assert.equal(creem.reads(), reads, 'malformed ids never reach Creem');
  // Unknown, foreign and expired checkouts are remembered for ten minutes, with the same answer.
  for (let index = 0; index < 5; index += 1) {
    assert.equal((await claim('ch_missing12345')).status, 404);
    assert.deepEqual(await asJson(await claim('ch_tshirt123456')), { status: 404, body: { error: NOT_PLUS_PAYMENT } });
    assert.equal((await claim('ch_expired12345')).status, 410);
  }
  assert.equal(creem.reads(), reads, 'remembered checkouts never reach Creem again');
  // Pending checkouts are not remembered: once paid, the same checkout works.
  checkouts.ch_pending12345 = checkout('ch_pending12345');
  assert.equal((await claim('ch_pending12345')).status, 200);
  clock.now += 11 * 60 * 1000;
  assert.equal((await claim('ch_missing12345')).status, 404);
  assert.equal(creem.reads(), reads + 2, 'asked again once the memory expires');
  assert.equal((await api(get('purchases/claim'))).status, 405);

  const down = setup({ creem: fakeCreem({}, { status: 500 }) });
  assert.deepEqual(await asJson(await down.api(post('purchases/claim', { checkout: 'ch_whatever1234' }))), { status: 502, body: { error: 'The payment could not be checked right now. Please try again in a minute.' } });
  assert.match(down.warnings[0], /Creem answered HTTP 500: Something broke/);
  const unauthorised = setup({ creem: fakeCreem({}, { status: 403 }) });
  assert.equal((await unauthorised.api(post('purchases/claim', { checkout: 'ch_whatever1234' }))).status, 502, 'a refused API key is not an unknown checkout');

  for (const options of [{ creemApiKey: '' }, { creemProducts: {} }, { creemProducts: { plus: { EUR: 'not a product' } } }]) {
    const off = setup({ ...options, creem: fakeCreem() });
    assert.deepEqual(await asJson(await off.api(post('purchases/claim', { checkout: 'ch_whatever1234' }))), { status: 503, body: { error: 'Payments are not configured.' } }, JSON.stringify(options));
    assert.equal(off.creem.calls.length, 0);
  }
  // A purchase already in the database is still answered after payments are switched off.
  const later = setup({ store, creemApiKey: '' });
  assert.equal((await later.api(post('purchases/claim', { checkout: 'ch_pending12345' }))).status, 200);
});

test('the webhook checks the signature on the raw body before anything else', async () => {
  const creem = fakeCreem();
  const { api, store, resend, warnings } = setup({ creem });
  const event = completedEvent(checkout('ch_webhook12345'));
  const raw = JSON.stringify(event);
  assert.deepEqual(await asJson(await sendWebhook(api, event, { signature: null })), { status: 401, body: { error: 'Invalid signature' } });
  assert.equal((await sendWebhook(api, event, { signature: 'nope' })).status, 401);
  assert.equal((await sendWebhook(api, event, { secret: 'whsec_wrong' })).status, 401);
  assert.equal((await sendWebhook(api, event, { signature: await webhookSignature(`${raw} `, WEBHOOK_SECRET), raw })).status, 401, 'signed over other bytes');
  // The same JSON re-serialised differently is not what was signed.
  assert.equal((await sendWebhook(api, event, { signature: await webhookSignature(raw, WEBHOOK_SECRET), raw: JSON.stringify(event, null, 2) })).status, 401);
  assert.equal(await store.getPurchase('ch_webhook12345'), null);
  assert.deepEqual(await asJson(await sendWebhook(api, null, { raw: '{nope' })), { status: 400, body: { error: 'Invalid JSON' } });
  const tooBig = JSON.stringify({ eventType: 'checkout.completed', padding: 'x'.repeat(70 * 1024) });
  assert.equal((await sendWebhook(api, null, { raw: tooBig })).status, 413);
  assert.equal((await api(get('creem/webhook'))).status, 405);
  // Without a secret nothing is processed, whatever the signature.
  const noSecret = setup({ creem, creemWebhookSecret: '' });
  const off = await asJson(await sendWebhook(noSecret.api, event));
  assert.equal(off.status, 503);
  assert.match(off.body.error, /CREEM_WEBHOOK_SECRET/);
  // Other events and checkouts that are not ours are acknowledged and ignored.
  for (const other of [{ eventType: 'subscription.paid', object: {} }, { eventType: 'refund.created', object: { id: 'ref_1' } }, { type: 'checkout.completed', data: checkout('ch_tshirt123456', { product: 'prod_tshirt' }) }, { eventType: 'checkout.completed', object: { status: 'completed' } }]) {
    assert.deepEqual(await asJson(await sendWebhook(api, other)), { status: 200, body: { received: true } }, JSON.stringify(other).slice(0, 60));
  }
  assert.match(warnings.join('\n'), /not for a Daily Planner product \(prod_tshirt\)/);
  assert.deepEqual([store.data.purchases.length, store.data.gifts.length, store.data.payments.length, resend.calls.length, creem.calls.length], [0, 0, 0, 0, 0]);
});

test('a Plus webhook stores the purchase once and emails the activation link once (memory and D1)', async t => {
  await bothStores(t, async (label, store) => {
    const creem = fakeCreem();
    const { api, resend } = setup({ store, creem });
    const paid = checkout('ch_plushook1234', { email: 'Sam@Example.com', country: 'us', currency: 'USD' });
    // Creem's documented shape, and the older `type` / `data` names, are processed alike.
    assert.deepEqual(await asJson(await sendWebhook(api, completedEvent(paid))), { status: 200, body: { received: true } }, label);
    assert.equal((await sendWebhook(api, { id: 'evt_again', type: 'checkout.completed', data: paid })).status, 200, label);
    assert.equal((await sendWebhook(api, completedEvent(paid))).status, 200, label);
    const row = await store.getPurchase('ch_plushook1234');
    assert.deepEqual([row.kind, row.claims, row.email], ['plus', 0, 'sam@example.com'], `${label}: no device activated yet`);
    const payment = await store.getPayment('ch_plushook1234');
    assert.deepEqual([payment.amount, payment.currency, payment.country], [2900, 'USD', 'US'], label);
    assert.ok(payment.emailedAt, label);
    assert.equal(resend.calls.length, 1, `${label}: one email`);
    const email = resend.calls[0];
    assert.equal(email.url, 'https://api.resend.com/emails');
    assert.deepEqual(email.body.to, ['sam@example.com']);
    assert.equal(email.body.subject, 'Your Daily Planner Plus');
    assert.equal(email.body.reply_to, 'owner@bemorin.example');
    assert.ok(email.body.text.includes('https://planner.bemorin.com/?purchase=ch_plushook1234'), label);
    assert.ok(email.body.html.includes('href="https://planner.bemorin.com/?purchase=ch_plushook1234"'), label);
    assert.match(email.headers['idempotency-key'], /^[0-9a-f]{64}$/);
    assert.equal(await store.emailSendsOn('2026-10-09', EMAIL_SENDS_EVENT), 1, label);
    // The link in the email claims the same licence, from the database.
    const claimed = await asJson(await api(post('purchases/claim', { checkout: 'ch_plushook1234' })));
    assert.equal(claimed.status, 200, label);
    assert.equal((await verifyLicense(KEYS.publicKey, claimed.body.license)).id, row.licenseId, label);
    assert.equal((await store.getPurchase('ch_plushook1234')).claims, 1, label);
    assert.equal(creem.calls.length, 0, `${label}: Creem is never asked`);
    assert.equal(resend.calls.length, 1, label);
  });
});

test('a claim then the webhook, or the webhook then a claim, give one gift and one email (memory and D1)', async t => {
  await bothStores(t, async (label, store) => {
    const first = checkout('ch_giftclaim123', { item: 'gift', company: 'Acme', email: 'boss@acme.example' });
    const second = checkout('ch_gifthook1234', { item: 'gift', plan: 'up-to-100', currency: 'USD', company: 'Globex', email: 'ceo@globex.example' });
    const creem = fakeCreem({ ch_giftclaim123: first, ch_gifthook1234: second });
    const { api, resend, settle } = setup({ store, creem });
    // Claim first: the email goes out in the background; the webhook finds it sent.
    const claimed = (await asJson(await api(post('purchases/claim', { checkout: 'ch_giftclaim123' })))).body;
    await settle();
    assert.equal((await sendWebhook(api, completedEvent(first))).status, 200, label);
    assert.equal((await sendWebhook(api, completedEvent(first))).status, 200, label);
    assert.equal(resend.calls.length, 1, label);
    // Webhook first: the gift and its email are made right away; the claim answers the same gift.
    assert.equal((await sendWebhook(api, completedEvent(second))).status, 200, label);
    assert.equal(resend.calls.length, 2, label);
    assert.deepEqual(resend.calls[1].body.to, ['ceo@globex.example']);
    const answer = (await asJson(await api(post('purchases/claim', { checkout: 'ch_gifthook1234' })))).body;
    await settle();
    assert.deepEqual([answer.seats, answer.org], [100, 'Globex'], label);
    assert.equal(resend.calls.length, 2, `${label}: still one email per gift`);
    const gifts = await store.listGifts();
    assert.equal(gifts.length, 2, label);
    assert.deepEqual(gifts.map(gift => gift.code).sort(), [claimed.code, answer.code].map(code => code.replace(/-/g, '')).sort(), label);
    assert.equal(creem.reads(), 1, `${label}: only the first claim asked Creem`);
    assert.equal((await store.listPayments({ fromDay: '2026-10-09', toDay: '2026-10-09' })).length, 2, label);
  });
});

test('a webhook whose email fails answers 500 so Creem retries, then sends it once', async () => {
  const resend = fakeResend({ fail: call => (call === 1 ? 503 : 0) });
  const { api, store, warnings } = setup({ resend });
  const paid = checkout('ch_plusretry123');
  assert.equal((await sendWebhook(api, completedEvent(paid))).status, 500);
  assert.match(warnings[0], /ch_plusretry123 not sent: Resend answered HTTP 503/);
  assert.equal((await store.getPayment('ch_plusretry123')).emailedAt, null, 'released for the retry');
  assert.equal((await sendWebhook(api, completedEvent(paid))).status, 200);
  assert.equal((await sendWebhook(api, completedEvent(paid))).status, 200);
  assert.equal(resend.calls.length, 2);
  assert.equal(resend.calls[0].headers['idempotency-key'], resend.calls[1].headers['idempotency-key'], 'Resend can tell it is the same email');
  assert.equal(store.data.purchases.length, 1);
  // Without Resend, or without a usable Plus key, nothing is half done.
  const quiet = setup({ resendApiKey: '' });
  assert.equal((await sendWebhook(quiet.api, completedEvent(paid))).status, 200);
  assert.equal(quiet.store.data.purchases.length, 1);
  const noKey = setup({ plusSigningKey: '' });
  assert.equal((await sendWebhook(noKey.api, completedEvent(paid))).status, 503);
  assert.equal(noKey.store.data.purchases.length, 0);
});

test('reviews: feedback that may be quoted is kept apart, listed and deletable (memory and D1)', async t => {
  await bothStores(t, async (label, store) => {
    const { api, clock, warnings } = setup({ store });
    const feedback = body => api(post('feedback', { version: '1.21.0', ...body }));
    assert.equal((await feedback({ rating: 5, message: 'Calm and clear.', quote: true, name: '  Ada\nL.  ' })).status, 201, label);
    clock.now += 1000;
    assert.equal((await feedback({ rating: 4, message: 'Lovely Horizon.', quote: true })).status, 201, label);
    // Not quotable: no rating, no message, not asked, or not exactly true.
    assert.equal((await feedback({ message: 'Words only', quote: true })).status, 201, label);
    assert.equal((await feedback({ rating: 5, quote: true })).status, 201, label);
    assert.equal((await feedback({ rating: 5, message: 'Private', quote: false, name: 'n'.repeat(200) })).status, 201, `${label}: the name is ignored without quote`);
    assert.equal((await feedback({ rating: 5, message: 'Truthy', quote: 'yes' })).status, 201, label);
    const long = await asJson(await feedback({ rating: 5, message: 'Long name', quote: true, name: 'n'.repeat(61) }));
    assert.equal(long.status, 400, label);
    assert.match(long.body.error, /60 characters/);
    assert.equal((await feedback({ rating: 5, message: 'Sixty', quote: true, name: 'n'.repeat(60) })).status, 201, label);
    const summary = (await asJson(await api(get('admin/summary', 'secret')))).body;
    assert.equal(summary.reviewsUnavailable, false, label);
    assert.deepEqual(summary.reviews.map(({ id, ...row }) => row), [
      { appVersion: '1.21.0', rating: 5, text: 'Sixty', name: 'n'.repeat(60), createdAt: '2026-10-09T08:00:01.000Z' },
      { appVersion: '1.21.0', rating: 4, text: 'Lovely Horizon.', name: '', createdAt: '2026-10-09T08:00:01.000Z' },
      { appVersion: '1.21.0', rating: 5, text: 'Calm and clear.', name: 'Ada L.', createdAt: '2026-10-09T08:00:00.000Z' }
    ], label);
    assert.equal(summary.feedbackLatest.length, 7, `${label}: every message is still feedback`);
    const id = summary.reviews[2].id;
    assert.equal((await api(del(`admin/reviews/${id}`))).status, 401, label);
    assert.deepEqual(await asJson(await api(del(`admin/reviews/${id}`, 'secret'))), { status: 200, body: { removed: true } }, label);
    assert.deepEqual(await asJson(await api(del(`admin/reviews/${id}`, 'secret'))), { status: 404, body: { removed: false } }, label);
    assert.equal((await asJson(await api(get('admin/summary', 'secret')))).body.reviews.length, 2, label);
    assert.equal(warnings.length, 0, label);
  });
  // The summary shows the latest REVIEWS_LATEST.
  const { api } = setup();
  for (let index = 0; index < REVIEWS_LATEST + 5; index += 1) await api(post('feedback', { version: '1.21.0', rating: 5, message: `Review ${index}`, quote: true }));
  assert.equal((await asJson(await api(get('admin/summary', 'secret')))).body.reviews.length, REVIEWS_LATEST);
});

test('series: daily counts summed across versions, and sales, between two days (memory and D1)', async t => {
  await bothStores(t, async (label, store) => {
    const creem = fakeCreem({ ch_seriesplus12: checkout('ch_seriesplus12'), ch_seriesgift12: checkout('ch_seriesgift12', { item: 'gift', plan: 'up-to-10', currency: 'USD' }) });
    const { api, clock } = setup({ store, creem });
    for (const [day, name, version] of [['2026-10-01', 'app_active_day', '1.20.0'], ['2026-10-01', 'app_active_day', '1.21.0'], ['2026-10-01', 'app_active_day', '1.21.0'], ['2026-10-02', 'app_active_day', '1.21.0'], ['2026-10-02', 'pricing_viewed', '1.21.0'], ['2026-09-30', 'app_active_day', '1.21.0'], ['2026-10-10', 'app_active_day', '1.21.0']]) {
      await store.countEvent(day, name, version);
    }
    await store.addEmailSends('2026-10-02', EMAIL_SENDS_EVENT, 3);
    // Sales: two Creem payments and two manual gifts, one without an amount.
    assert.equal((await api(post('purchases/claim', { checkout: 'ch_seriesplus12' }))).status, 200, label);
    clock.now = Date.parse('2026-10-05T12:00:00Z');
    assert.equal((await api(post('purchases/claim', { checkout: 'ch_seriesgift12' }))).status, 200, label);
    assert.equal((await api(post('admin/gifts', { org: 'Initech', seats: 50, currency: 'EUR', amount: 50000 }, 'secret'))).status, 201, label);
    assert.equal((await api(post('admin/gifts', { org: 'Odd size', seats: 37, currency: 'USD', amount: 30000 }, 'secret'))).status, 201, label);
    assert.equal((await api(post('admin/gifts', { org: 'Free', seats: 5 }, 'secret'))).status, 201, label);
    assert.equal((await api(get('admin/series'))).status, 401, label);
    const series = await asJson(await api(get('admin/series?from=2026-10-01&to=2026-10-08', 'secret')));
    assert.equal(series.status, 200, label);
    assert.deepEqual(series.body, {
      from: '2026-10-01',
      to: '2026-10-08',
      events: { app_active_day: { '2026-10-01': 3, '2026-10-02': 1 }, pricing_viewed: { '2026-10-02': 1 } },
      sales: [
        { day: '2026-10-05', kind: 'gift', source: 'creem', plan: 'up-to-10', seats: 10, amount: 19500, currency: 'USD' },
        { day: '2026-10-05', kind: 'gift', source: 'manual', plan: '', seats: 37, amount: 30000, currency: 'USD' },
        { day: '2026-10-05', kind: 'gift', source: 'manual', plan: 'up-to-50', seats: 50, amount: 50000, currency: 'EUR' }
      ],
      salesUnavailable: false
    }, `${label}: the Plus sale of 9 October is after the range`);
    // Default: the last 400 days up to today (the Plus sale of 9 October is after it).
    const recent = (await asJson(await api(get('admin/series', 'secret')))).body;
    assert.deepEqual([recent.from, recent.to], ['2025-09-01', '2026-10-05'], label);
    assert.deepEqual(recent.events.app_active_day, { '2026-09-30': 1, '2026-10-01': 3, '2026-10-02': 1 }, label);
    assert.equal(recent.sales.length, 3, label);
    assert.ok(!Object.keys(recent.events).some(name => name.startsWith('internal:')), label);
  });
});

test('series ranges: defaults, swapped days and the 1,200-day cap', () => {
  assert.deepEqual(seriesRange(null, null, '2026-10-09'), { from: '2025-09-05', to: '2026-10-09' });
  assert.deepEqual(seriesRange('2026-01-01', '2026-02-01', '2026-10-09'), { from: '2026-01-01', to: '2026-02-01' });
  assert.deepEqual(seriesRange('2026-02-01', '2026-01-01', '2026-10-09'), { from: '2026-01-01', to: '2026-02-01' });
  assert.deepEqual(seriesRange('2020-01-01', '2026-10-09', '2026-10-09'), { from: '2023-06-28', to: '2026-10-09' });
  assert.deepEqual(seriesRange('2026-02-30', 'tomorrow', '2026-10-09'), { from: '2025-09-05', to: '2026-10-09' });
  assert.deepEqual(seriesRange('', '2026-03-01', '2026-10-09'), { from: '2025-01-26', to: '2026-03-01' });
  assert.deepEqual(seriesRange("2026-01-01' OR 1=1", '2026-10-09', '2026-10-09'), { from: '2025-09-05', to: '2026-10-09' });
});

test('without migration 0004 the dashboard loads, claims work and the rest explains what is missing', async t => {
  const d1 = await openSqlite(t, MIGRATIONS.slice(0, 3));
  if (!d1) return;
  const creem = fakeCreem({ ch_noplustable1: checkout('ch_noplustable1') });
  const { api, warnings } = setup({ store: createD1Store(d1), creem });
  const summary = await asJson(await api(get('admin/summary', 'secret')));
  assert.equal(summary.status, 200);
  assert.deepEqual([summary.body.reviews, summary.body.reviewsUnavailable, summary.body.plusUnavailable], [[], true, false]);
  // The buyer still gets the licence; the sales row is missing and the owner is told in the logs.
  assert.equal((await api(post('purchases/claim', { checkout: 'ch_noplustable1' }))).status, 200);
  assert.match(warnings.join('\n'), /Payment ch_noplustable1 not recorded: no such table: payments/);
  // Feedback still counts; the review waits for the table.
  assert.equal((await api(post('feedback', { version: '1.21.0', rating: 5, message: 'Great', quote: true }))).status, 201);
  assert.match(warnings.join('\n'), /Review not stored/);
  for (const call of [del('admin/reviews/1', 'secret')]) {
    const answer = await asJson(await api(call));
    assert.equal(answer.status, 503);
    assert.match(answer.body.error, /migrations/);
  }
  // The webhook waits too (Creem retries), so nothing is emailed twice later.
  const hook = await asJson(await sendWebhook(api, completedEvent(checkout('ch_hookbefore04'))));
  assert.equal(hook.status, 503);
  assert.match(hook.body.error, /migrations/);
  const series = (await asJson(await api(get('admin/series', 'secret')))).body;
  assert.deepEqual([series.salesUnavailable, series.sales], [true, []]);
  // Applying 0004 later (or twice) is safe.
  for (let round = 0; round < 2; round += 1) d1.sqlite.exec(readFileSync(new URL('../migrations/0004_creem_reviews.sql', import.meta.url), 'utf8'));
  assert.equal((await asJson(await api(get('admin/summary', 'secret')))).body.reviewsUnavailable, false);
  assert.equal((await sendWebhook(api, completedEvent(checkout('ch_hookbefore04')))).status, 200);
  assert.equal((await asJson(await api(get('admin/series', 'secret')))).body.salesUnavailable, false);
});

test('migration 0004: columns, one payment per checkout', async t => {
  const d1 = await openSqlite(t, ['0004_creem_reviews.sql']);
  if (!d1) return;
  const columns = table => d1.sqlite.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
  assert.deepEqual(columns('payments'), ['checkout_id', 'kind', 'plan', 'seats', 'amount', 'currency', 'country', 'created_at', 'emailed_at']);
  assert.deepEqual(columns('reviews'), ['id', 'app_version', 'rating', 'text', 'name', 'created_at']);
  const store = createD1Store(d1);
  const row = { checkoutId: 'ch_one12345', kind: 'plus', plan: '', seats: 1, amount: 2900, currency: 'EUR', country: 'FR', createdAt: '2026-10-09T08:00:00.000Z' };
  assert.equal(await store.addPayment(row), true);
  assert.equal(await store.addPayment({ ...row, amount: 1 }), false, 'one row per checkout');
  assert.equal((await store.getPayment('ch_one12345')).amount, 2900);
  assert.equal(await store.markPaymentEmailed('ch_one12345', '2026-10-09T09:00:00.000Z'), true);
  assert.equal(await store.markPaymentEmailed('ch_one12345', '2026-10-09T10:00:00.000Z'), false);
  await store.clearPaymentEmailed('ch_one12345');
  assert.equal((await store.getPayment('ch_one12345')).emailedAt, null);
  assert.equal(await store.markPaymentEmailed('ch_unknown123', '2026-10-09T10:00:00.000Z'), false);
  assert.deepEqual(await store.listPayments({ fromDay: '2026-10-10', toDay: '2026-10-11' }), []);
  assert.equal((await store.listPayments({ fromDay: '2026-10-09', toDay: '2026-10-09' })).length, 1, 'the last day is included');
});

test('the setup summary shows Creem, email and Plus without ever showing a secret', async () => {
  const { api } = setup();
  const { body } = await asJson(await api(get('admin/summary', 'secret')));
  assert.deepEqual(body.setup, {
    email: { configured: true, apiKeySet: true, fromSet: true, from: 'Ben Morin <hello@bemorin.example>', ownerEmail: 'owner@bemorin.example', dailyLimit: 100 },
    payments: {
      provider: 'creem', configured: true, apiKeySet: true, mode: 'test',
      products: { plus: { EUR: 'prod_plus_eur', USD: 'prod_plus_usd' }, gift: { EUR: 'prod_gift_eur', USD: 'prod_gift_usd' } },
      webhookSecretSet: true, webhookUrl: 'https://planner.bemorin.com/api/creem/webhook', error: ''
    },
    plus: { configured: true, keySet: true, publicKey: KEYS.publicKey },
    publicBaseUrl: 'https://planner.bemorin.com',
    publicBaseUrlSet: false,
    twoFactor: false
  });
  const text = JSON.stringify(body);
  for (const secret of [KEYS.signingKey, API_KEY, WEBHOOK_SECRET, 're_test_key']) assert.ok(!text.includes(secret), secret);
  assert.ok(!/stripe/i.test(text));
  assert.equal(body.plusUnavailable, false);
  const empty = setup({ resendApiKey: '', emailFrom: '', ownerEmail: '', creemApiKey: '', creemWebhookSecret: '', creemProducts: { gift: { USD: 'bad id!' } }, plusSigningKey: '', publicBaseUrl: 'https://staging.example/' });
  const off = (await asJson(await empty.api(get('admin/summary', 'secret')))).body.setup;
  assert.deepEqual([off.email.configured, off.plus.configured], [false, false]);
  assert.deepEqual(off.payments, {
    provider: 'creem', configured: false, apiKeySet: false, mode: '',
    products: { plus: { EUR: '', USD: '' }, gift: { EUR: '', USD: '' } },
    webhookSecretSet: false, webhookUrl: 'https://staging.example/api/creem/webhook', error: 'CREEM_GIFT_USD is not a product id (prod_…).'
  });
});

test('dev data files written before 1.21 keep their paid gifts and purchases', async () => {
  const store = createMemoryStore({
    gifts: [{ code: 'ABCDEFGHJKMN', org: 'Acme Studio', message: '', seats: 50, redeemed: 0, active: true, currency: 'EUR', amount: 59500, source: 'stripe', stripeSession: 'cs_test_fake_gift50', buyerEmail: '', note: '', createdAt: '2026-10-09T08:00:00.000Z', expiresAt: '2027-10-09T08:00:00.000Z', emailedAt: null }],
    purchases: [{ stripeSession: 'cs_test_fake_plus', kind: 'plus', licenseId: '0123456789abcdef', claims: 1, email: '', note: '', createdAt: '2026-10-09T08:00:00.000Z' }]
  });
  assert.equal((await store.getGiftByCheckout('cs_test_fake_gift50')).code, 'ABCDEFGHJKMN');
  assert.equal((await store.getPurchase('cs_test_fake_plus')).licenseId, '0123456789abcdef');
  assert.ok(!JSON.stringify(store.data).includes('stripeSession'));
  const { api, creem } = setup({ store });
  assert.equal((await api(post('purchases/claim', { session: 'cs_test_fake_gift50' }))).status, 200);
  assert.equal((await api(post('purchases/claim', { checkout: 'cs_test_fake_plus' }))).status, 200);
  assert.deepEqual(await asJson(await api(del('admin/gifts/ABCDEFGHJKMN', 'secret'))), { status: 200, body: { removed: false, deactivated: true } });
  assert.equal(creem.calls.length, 0);
});

test('checkout and webhook routes answer CORS preflights for allowed origins', async () => {
  const { api } = setup({ allowedOrigins: 'https://landing.example' });
  for (const path of ['checkout', 'creem/webhook', 'admin/reviews/1', 'admin/series']) {
    const preflight = await api(new Request(`https://planner.test/api/${path}`, { method: 'OPTIONS', headers: { origin: 'https://landing.example' } }));
    assert.equal(preflight.status, 204, path);
    assert.match(preflight.headers.get('access-control-allow-methods'), /GET,POST,PATCH,DELETE/);
  }
  const options = await api(new Request('https://planner.test/api/checkout', { headers: { origin: 'https://landing.example' } }));
  assert.equal(options.headers.get('access-control-allow-origin'), 'https://landing.example');
  const elsewhere = await api(new Request('https://planner.test/api/checkout', { headers: { origin: 'https://evil.example' } }));
  assert.equal(elsewhere.headers.get('access-control-allow-origin'), null);
});

test('a team gift is honoured only with the seal the API put on its checkout', async () => {
  const forged = {
    // A product link opened by hand with ?metadata[plan]=up-to-1000, paying the product's own price.
    ch_forged1000aa: checkout('ch_forged1000aa', { item: 'gift', plan: 'up-to-1000', amount: 100, metadata: { kind: 'gift', plan: 'up-to-1000', seats: '1000' } }),
    ch_wrongseal01a: checkout('ch_wrongseal01a', { item: 'gift', plan: 'up-to-1000', metadata: { ...sealed({ kind: 'gift', plan: 'up-to-10', seats: '10' }, 'EUR'), plan: 'up-to-1000' } }),
    ch_wrongcur001a: checkout('ch_wrongcur001a', { item: 'gift', plan: 'up-to-50', metadata: sealed({ kind: 'gift', plan: 'up-to-50', seats: '50' }, 'USD') }),
    ch_noorder0001a: { ...checkout('ch_noorder0001a', { item: 'gift', plan: 'up-to-50' }), order: 'ord_1' },
    ch_refunded001a: checkout('ch_refunded001a', { item: 'gift', plan: 'up-to-50', orderStatus: 'refunded' }),
    ch_goodgift001a: checkout('ch_goodgift001a', { item: 'gift', plan: 'up-to-50', company: 'Acme' })
  };
  const { api, store, warnings } = setup({ creem: fakeCreem(forged) });
  for (const id of ['ch_forged1000aa', 'ch_wrongseal01a', 'ch_wrongcur001a']) {
    assert.deepEqual(await asJson(await api(post('purchases/claim', { checkout: id }))), { status: 404, body: { error: NOT_PLUS_PAYMENT } }, id);
    assert.equal(await store.getGiftByCheckout(id), null, id);
  }
  for (const id of ['ch_noorder0001a', 'ch_refunded001a']) assert.equal((await api(post('purchases/claim', { checkout: id }))).status, 402, `${id}: only an order marked paid counts`);
  assert.equal((await asJson(await api(post('purchases/claim', { checkout: 'ch_goodgift001a' })))).body.seats, 50);
  // The same forged checkout through the webhook: acknowledged, nothing delivered, the owner warned.
  assert.equal((await sendWebhook(api, completedEvent(forged.ch_forged1000aa))).status, 200);
  assert.equal(await store.getGiftByCheckout('ch_forged1000aa'), null);
  assert.ok(warnings.some(line => /ch_forged1000aa was not opened by this site/.test(line)));
});

test('the gift page sends a Plus purchase to the planner without using an activation', async () => {
  const { api, store } = setup({ creem: fakeCreem({ ch_plusviagift1: checkout('ch_plusviagift1') }) });
  assert.deepEqual(await asJson(await api(post('purchases/claim', { checkout: 'ch_plusviagift1', expect: 'gift' }))), { status: 409, body: { kind: 'plus', error: 'This payment is for Daily Planner Plus: open it in the planner.' } });
  assert.equal(await store.getPurchase('ch_plusviagift1'), null, 'nothing claimed yet');
  assert.equal((await asJson(await api(post('purchases/claim', { checkout: 'ch_plusviagift1' })))).body.kind, 'plus');
  assert.equal((await store.getPurchase('ch_plusviagift1')).claims, 1);
  assert.equal((await api(post('purchases/claim', { checkout: 'ch_plusviagift1', expect: 'gift' }))).status, 409, 'known purchases too');
  assert.equal((await store.getPurchase('ch_plusviagift1')).claims, 1);
});

test('purchases made with test keys are refused once the live keys are in place', async () => {
  const store = createMemoryStore();
  const testing = setup({ store, creem: fakeCreem({ ch_testplus001a: checkout('ch_testplus001a'), ch_testgift001a: checkout('ch_testgift001a', { item: 'gift', plan: 'up-to-10', metadata: sealed({ kind: 'gift', plan: 'up-to-10', seats: '10' }, 'EUR') }) }) });
  assert.equal((await testing.api(post('purchases/claim', { checkout: 'ch_testplus001a' }))).status, 200);
  assert.equal((await testing.api(post('purchases/claim', { checkout: 'ch_testgift001a' }))).status, 200);
  const live = setup({ store, creemApiKey: 'creem_live_key' });
  for (const id of ['ch_testplus001a', 'ch_testgift001a']) {
    assert.deepEqual(await asJson(await live.api(post('purchases/claim', { checkout: id }))), { status: 410, body: { error: 'This was a test purchase, made before payments went live.' } }, id);
  }
});
