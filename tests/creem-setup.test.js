import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore, createPlannerApi } from '../server/planner-api.js';
import {
  applyCreemSetup, createCreemSetupRoute, envBlock, expectedProduct, markerOf, needsTestModeLine, planCreemSetup, productIdempotencyKey, productMarker, SETUP_LIMITS, SETUP_SLOTS, setupTarget, TAX_CATEGORY, WEBHOOK_EVENTS, webhookUrlProblem
} from '../server/creem-setup.js';
import { createAdminLimits, createRateLimiter } from '../server/admin-limits.js';
import { PLUS_PRICE, TEAM_TIERS } from '../src/lib/pricing.js';

const API_KEY = 'creem_test_setupkey0123456789abcdef';
const LIVE_KEY = 'creem_live0123456789abcdefghijkl';
const WEBHOOK_SECRET = 'whsec_configured_0123456789abcdef';
const HOOK_SECRET = 'whsec_fromcreem_9876543210fedcba';
const NEW_SECRET = 'whsec_brandnew_aaaabbbbccccdddd';
const URL_OK = 'https://planner.bemorin.com/api/creem/webhook';
const START = Date.parse('2026-10-21T08:00:00Z');
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A product as Creem's API answers it, by default exactly what the assistant would create for `slot`. */
function product(id, slot, extra = {}) {
  const [item, currency] = slot.split('-');
  return { id, object: 'product', mode: 'test', status: 'active', billing_period: 'once', created_at: '2026-10-01T09:00:00.000Z', ...expectedProduct(item, currency.toUpperCase()), ...extra };
}

/**
 * Stand-in for Creem's products and webhooks API. `fail`: (call) => status to answer instead
 * (0: answer normally). Every call is kept in `calls`.
 */
function fakeCreem({ products = [], webhooks = [], fail = () => 0, pageSize = 50 } = {}) {
  const calls = [];
  const keys = new Map();
  let counter = 0;
  const list = (items, url) => {
    const page = Number(url.searchParams.get('page_number')) || 1;
    const size = Math.min(pageSize, Number(url.searchParams.get('page_size')) || 10);
    const pages = Math.max(1, Math.ceil(items.length / size));
    return json(200, { items: items.slice((page - 1) * size, page * size), pagination: { total_records: items.length, total_pages: pages, current_page: page, next_page: page < pages ? page + 1 : null, prev_page: page > 1 ? page - 1 : null } });
  };
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    const call = { method: init.method || 'GET', url: String(input), path: url.pathname, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const refused = fail(call);
    if (refused) return json(refused, { status: refused, error: 'Forbidden', message: [`Invalid API key ${init.headers?.['x-api-key']}`] });
    const productId = /^\/v1\/products\/([^/]+)$/.exec(url.pathname)?.[1];
    const secretOf = /^\/v1\/webhooks\/([^/]+)\/secret$/.exec(url.pathname)?.[1];
    if (call.method === 'GET' && url.pathname === '/v1/products/search') return list(products, url);
    if (call.method === 'GET' && productId) {
      const found = products.find(entry => entry.id === decodeURIComponent(productId));
      return found ? json(200, found) : json(404, { message: ['Product not found'] });
    }
    if (call.method === 'POST' && url.pathname === '/v1/products') {
      const key = call.headers['Idempotency-Key'];
      if (key && keys.has(key)) return json(200, keys.get(key));
      counter += 1;
      const made = { object: 'product', mode: 'test', status: 'active', billing_period: 'once', ...call.body, id: `prod_new${counter}`, created_at: new Date(START + counter).toISOString() };
      products.push(made);
      if (key) keys.set(key, made);
      return json(200, made);
    }
    if (call.method === 'GET' && url.pathname === '/v1/webhooks') return list(webhooks.map(({ secret: _secret, ...hook }) => hook), url);
    if (call.method === 'POST' && url.pathname === '/v1/webhooks') {
      const hook = { object: 'webhook', mode: 'test', store_id: 'sto_1', status: 'enabled', ...call.body, id: `wh_new${webhooks.length + 1}`, secret: NEW_SECRET };
      webhooks.push(hook);
      return json(200, hook);
    }
    if (call.method === 'GET' && secretOf) {
      const hook = webhooks.find(entry => entry.id === secretOf);
      return hook ? json(200, { secret: hook.secret }) : json(404, { message: ['Not found'] });
    }
    return json(404, { message: ['Not found'] });
  };
  return { fetch, calls, products, webhooks, posts: () => calls.filter(call => call.method === 'POST') };
}

const ALL_IDS = { plus: { EUR: 'prod_plus_eur', USD: 'prod_plus_usd' }, gift: { EUR: 'prod_gift_eur', USD: 'prod_gift_usd' } };
const fullStore = () => [product('prod_plus_eur', 'plus-eur'), product('prod_plus_usd', 'plus-usd'), product('prod_gift_eur', 'gift-eur'), product('prod_gift_usd', 'gift-usd')];
const hook = (extra = {}) => ({ id: 'wh_1', object: 'webhook', mode: 'test', name: 'Daily Planner', url: URL_OK, delivery_mode: 'http', status: 'enabled', events: [...WEBHOOK_EVENTS], secret: HOOK_SECRET, ...extra });
const options = (creem, extra = {}) => ({ apiKey: API_KEY, mode: 'test', fetch: creem.fetch, products: {}, webhookUrl: URL_OK, webhookSecret: '', now: () => START, ...extra });
const ALL = [...SETUP_SLOTS.map(slot => slot.slot), 'webhook'];
const slotOf = (plan, slot) => plan.products.find(entry => entry.slot === slot);

test('each product is what pricing.js sells: one-time, tax included, with the marker in its description', () => {
  assert.deepEqual(SETUP_SLOTS.map(slot => [slot.slot, slot.env]), [['plus-eur', 'CREEM_PLUS_EUR'], ['plus-usd', 'CREEM_PLUS_USD'], ['gift-eur', 'CREEM_GIFT_EUR'], ['gift-usd', 'CREEM_GIFT_USD']]);
  const plus = expectedProduct('plus', 'USD');
  assert.deepEqual({ ...plus, description: undefined }, { name: 'Daily Planner Plus', description: undefined, price: PLUS_PRICE.USD * 100, currency: 'USD', billing_type: 'onetime', tax_mode: 'inclusive', tax_category: TAX_CATEGORY });
  assert.equal(expectedProduct('gift', 'EUR').price, TEAM_TIERS[0].price.EUR * 100);
  assert.equal(expectedProduct('gift', 'EUR').name, 'Daily Planner Plus gift');
  assert.equal(markerOf(plus.description), 'plus-usd');
  assert.equal(markerOf('Edited by hand. Ref. DP-SETUP:Gift-EUR, thanks'), 'gift-eur');
  assert.equal(markerOf('Daily Planner Plus'), '');
  assert.equal(productMarker('gift-usd'), 'dp-setup:gift-usd');
  assert.equal(webhookUrlProblem(URL_OK), '');
  assert.equal(webhookUrlProblem('http://planner.bemorin.com/api/creem/webhook'), 'https');
  assert.equal(webhookUrlProblem('https://localhost:8383/api/creem/webhook'), 'local');
});

test('plan with nothing in Creem: four products and the webhook to create, read-only calls only', async () => {
  const creem = fakeCreem();
  const plan = await planCreemSetup(options(creem));
  assert.equal(plan.mode, 'test');
  assert.deepEqual(plan.products.map(slot => slot.state), ['create', 'create', 'create', 'create']);
  assert.equal(plan.webhook.state, 'create');
  assert.deepEqual(plan.create, ALL);
  assert.equal(plan.envComplete, false);
  assert.equal(plan.env, '', 'a creem_test_ key needs no CREEM_TEST_MODE line');
  assert.equal(plan.testModeLine, false);
  assert.equal(creem.posts().length, 0, 'planning never creates anything');
  assert.ok(creem.calls.every(call => call.url.startsWith('https://test-api.creem.io/v1/')), 'a test key uses the test API');
  assert.ok(creem.calls.every(call => call.headers['x-api-key'] === API_KEY));
});

test('plan with everything in place: nothing to create, the webhook secret only compared', async () => {
  const creem = fakeCreem({ products: fullStore(), webhooks: [hook()] });
  const plan = await planCreemSetup(options(creem, { products: ALL_IDS, webhookSecret: HOOK_SECRET }));
  assert.deepEqual(plan.products.map(slot => [slot.state, slot.id, slot.differences.length]), [['ok', 'prod_plus_eur', 0], ['ok', 'prod_plus_usd', 0], ['ok', 'prod_gift_eur', 0], ['ok', 'prod_gift_usd', 0]]);
  assert.equal(plan.webhook.state, 'ok');
  assert.deepEqual(plan.webhook.secret, { set: true, matches: true });
  assert.deepEqual(plan.create, []);
  assert.deepEqual(plan.envChanges, []);
  assert.equal(plan.env, 'CREEM_PLUS_EUR=prod_plus_eur\nCREEM_PLUS_USD=prod_plus_usd\nCREEM_GIFT_EUR=prod_gift_eur\nCREEM_GIFT_USD=prod_gift_usd\n');
  assert.ok(!JSON.stringify(plan).includes(HOOK_SECRET));
  const wrong = await planCreemSetup(options(creem, { products: ALL_IDS, webhookSecret: 'whsec_another_one_0000' }));
  assert.equal(wrong.webhook.secret.matches, false);
  const unset = await planCreemSetup(options(creem, { products: ALL_IDS }));
  assert.deepEqual(unset.webhook.secret, { set: false, matches: null });
  assert.equal(creem.posts().length, 0);
});

test('a Plus product at another price differs and is never replaced; a gift’s own price is only a note', async () => {
  const products = fullStore();
  products[0].price = 2500;
  products[2].price = 9900;
  products[2].name = 'Daily Planner Plus team gift';
  const creem = fakeCreem({ products, webhooks: [hook()] });
  const plan = await planCreemSetup(options(creem, { products: ALL_IDS }));
  const plus = slotOf(plan, 'plus-eur');
  assert.equal(plus.state, 'differs');
  assert.deepEqual(plus.differences, [{ field: 'price', label: 'Price', expected: '€29', actual: '€25', critical: true }]);
  const gift = slotOf(plan, 'gift-eur');
  assert.equal(gift.state, 'ok');
  assert.deepEqual(gift.differences.map(entry => [entry.field, entry.critical]), [['price', false], ['name', false]]);
  assert.deepEqual(plan.create, [], 'nothing is created for a product that differs');
  const after = await applyCreemSetup(options(creem, { products: ALL_IDS }), { create: ALL });
  assert.equal(creem.posts().length, 0);
  assert.deepEqual(after.created, []);
});

test('a product in the wrong currency, tax mode or billing differs; an unknown env id is replaced', async () => {
  const products = fullStore();
  products[1] = product('prod_plus_usd', 'plus-usd', { currency: 'EUR', tax_mode: 'exclusive' });
  products[3] = product('prod_gift_usd', 'gift-usd', { billing_type: 'recurring', billing_period: 'every-month' });
  const creem = fakeCreem({ products, webhooks: [hook()] });
  const plan = await planCreemSetup(options(creem, { products: { ...ALL_IDS, gift: { EUR: 'prod_from_live', USD: 'prod_gift_usd' } } }));
  assert.deepEqual(slotOf(plan, 'plus-usd').differences.filter(entry => entry.critical).map(entry => [entry.field, entry.actual]), [['currency', 'EUR'], ['tax', 'Tax added on top']]);
  assert.equal(slotOf(plan, 'plus-usd').state, 'differs');
  assert.equal(slotOf(plan, 'gift-usd').state, 'differs');
  assert.equal(slotOf(plan, 'gift-usd').differences[0].actual, 'Subscription (every-month)');
  // prod_from_live isn't in this test store, but the assistant's gift-eur product is: it is found, not created.
  const giftEur = slotOf(plan, 'gift-eur');
  assert.deepEqual([giftEur.state, giftEur.envNote, giftEur.source, giftEur.id], ['found', 'unknown', 'marker', 'prod_gift_eur']);
  assert.deepEqual(plan.envChanges, ['CREEM_GIFT_EUR']);
  assert.match(plan.env, /^CREEM_GIFT_EUR=prod_gift_eur$/m);
  const bare = await planCreemSetup(options(fakeCreem(), { products: { plus: { EUR: 'not an id!' }, gift: { EUR: 'prod_dup', USD: 'prod_dup' } } }));
  assert.deepEqual(bare.products.map(slot => [slot.state, slot.envNote]), [['create', 'invalid'], ['create', ''], ['create', 'unknown'], ['create', 'repeated']]);
});

test('apply creates only what is missing and asked for, then a second apply creates nothing (marker)', async () => {
  const creem = fakeCreem({ products: [product('prod_plus_eur', 'plus-eur'), product('prod_plus_usd', 'plus-usd')] });
  const env = { plus: { EUR: 'prod_plus_eur', USD: 'prod_plus_usd' } };
  const first = await applyCreemSetup(options(creem, { products: env }), { create: ['gift-eur', 'gift-usd', 'webhook', 'plus-eur'] });
  const posts = creem.posts();
  assert.deepEqual(posts.map(call => call.path), ['/v1/products', '/v1/products', '/v1/webhooks']);
  assert.deepEqual(posts[0].body, expectedProduct('gift', 'EUR'));
  assert.match(posts[0].body.description, /Ref\. dp-setup:gift-eur$/);
  assert.match(posts[0].headers['Idempotency-Key'], /^dp-setup-test-gift-eur-19500-20261021-0$/);
  assert.deepEqual(posts[2].body, { url: URL_OK, name: 'Daily Planner · dp-setup', events: [...WEBHOOK_EVENTS], delivery_mode: 'http' });
  assert.deepEqual(first.created, [{ slot: 'gift-eur', id: 'prod_new1' }, { slot: 'gift-usd', id: 'prod_new2' }, { slot: 'webhook', id: 'wh_new1' }]);
  assert.deepEqual(first.already, ['plus-eur']);
  assert.deepEqual(first.failures, []);
  assert.deepEqual(first.products.map(slot => slot.state), ['ok', 'ok', 'created', 'created']);
  assert.equal(first.webhook.state, 'created');
  assert.equal(first.webhookSecret, NEW_SECRET);
  assert.equal(first.env, 'CREEM_PLUS_EUR=prod_plus_eur\nCREEM_PLUS_USD=prod_plus_usd\nCREEM_GIFT_EUR=prod_new1\nCREEM_GIFT_USD=prod_new2\n');
  assert.deepEqual(first.envChanges, ['CREEM_GIFT_EUR', 'CREEM_GIFT_USD']);
  // The owner hasn't pasted the new ids yet: the products are found by their marker, the webhook by its URL.
  const second = await applyCreemSetup(options(creem, { products: env }), { create: ALL });
  assert.equal(creem.posts().length, 3, 'a second click creates nothing');
  assert.deepEqual(second.created, []);
  assert.deepEqual(second.products.map(slot => [slot.state, slot.id]), [['ok', 'prod_plus_eur'], ['ok', 'prod_plus_usd'], ['found', 'prod_new1'], ['found', 'prod_new2']]);
  assert.equal(second.webhook.state, 'ok');
  assert.equal('webhookSecret' in second, false);
  assert.equal(second.env, first.env);
  // Nothing asked for, nothing made.
  const none = await applyCreemSetup(options(fakeCreem(), {}), { create: [] });
  assert.deepEqual(none.created, []);
});

test('the same product on the same day carries the same Idempotency-Key, so a retry answers it again', async () => {
  const creem = fakeCreem();
  await applyCreemSetup(options(creem), { create: ['plus-eur'] });
  creem.products.length = 0; // as if the list hadn't caught up yet
  const again = await applyCreemSetup(options(creem), { create: ['plus-eur'] });
  const keys = creem.posts().map(call => call.headers['Idempotency-Key']);
  assert.equal(keys[0], keys[1]);
  assert.deepEqual(again.created, [{ slot: 'plus-eur', id: 'prod_new1' }]);
});

test('an archived copy is ignored and a marked product that differs is never duplicated', async () => {
  const creem = fakeCreem({ products: [product('prod_old', 'plus-eur', { status: 'archived' }), product('prod_cheap', 'plus-usd', { price: 1900 })] });
  const plan = await planCreemSetup(options(creem));
  assert.equal(slotOf(plan, 'plus-eur').state, 'create');
  assert.deepEqual([slotOf(plan, 'plus-usd').state, slotOf(plan, 'plus-usd').source, slotOf(plan, 'plus-usd').id], ['differs', 'marker', 'prod_cheap']);
  await applyCreemSetup(options(creem), { create: ['plus-eur', 'plus-usd'] });
  assert.deepEqual(creem.posts().map(call => [call.body.currency, call.headers['Idempotency-Key']]), [['EUR', 'dp-setup-test-plus-eur-2900-20261021-1']]);
});

test('a product made by hand is found by its exact name, currency and billing', async () => {
  const hand = { ...product('prod_hand', 'plus-eur'), description: 'My product' };
  const other = { ...product('prod_other', 'plus-usd'), description: '', name: 'Something else' };
  const plan = await planCreemSetup(options(fakeCreem({ products: [hand, other] })));
  assert.deepEqual([slotOf(plan, 'plus-eur').state, slotOf(plan, 'plus-eur').source, slotOf(plan, 'plus-eur').id], ['found', 'name', 'prod_hand']);
  assert.equal(slotOf(plan, 'plus-usd').state, 'create');
});

test('lists are read page by page', async () => {
  const filler = Array.from({ length: 120 }, (_, index) => ({ ...product(`prod_x${index}`, 'plus-eur'), description: 'Other', name: `Other ${index}` }));
  const creem = fakeCreem({ products: [...filler, product('prod_late', 'gift-usd')] });
  const plan = await planCreemSetup(options(creem));
  assert.equal(slotOf(plan, 'gift-usd').id, 'prod_late');
  assert.deepEqual(creem.calls.filter(call => call.path === '/v1/products/search').map(call => new URL(call.url).searchParams.get('page_number')), ['1', '2', '3']);
});

test('the webhook: missing events and a disabled endpoint differ; no scope or no https means by hand', async () => {
  const partial = await planCreemSetup(options(fakeCreem({ webhooks: [hook({ events: ['checkout.completed'] })] })));
  assert.equal(partial.webhook.state, 'differs');
  assert.deepEqual(partial.webhook.differences[0].missing, ['refund.created', 'dispute.created']);
  assert.ok(!partial.create.includes('webhook'));
  const every = await planCreemSetup(options(fakeCreem({ webhooks: [hook({ events: [] })] })));
  assert.equal(every.webhook.state, 'ok', 'an empty list means every event');
  const off = await planCreemSetup(options(fakeCreem({ webhooks: [hook({ status: 'disabled' })] })));
  assert.equal(off.webhook.differences[0].field, 'status');
  const twice = await planCreemSetup(options(fakeCreem({ webhooks: [hook(), hook({ id: 'wh_2', url: `${URL_OK}/` })] })));
  assert.equal(twice.webhook.duplicates, 1);
  const scope = await planCreemSetup(options(fakeCreem({ fail: call => (call.path === '/v1/webhooks' ? 403 : 0) })));
  assert.deepEqual([scope.webhook.state, scope.webhook.reason], ['manual', 'scope']);
  assert.match(scope.webhook.message, /webhooks:read and webhooks:write/);
  assert.deepEqual(scope.create, ['plus-eur', 'plus-usd', 'gift-eur', 'gift-usd'], 'the products are still planned');
  const local = fakeCreem();
  const blocked = await planCreemSetup(options(local, { webhookUrl: 'http://localhost:8383/api/creem/webhook' }));
  assert.deepEqual([blocked.webhook.state, blocked.webhook.reason], ['blocked', 'url']);
  assert.ok(!local.calls.some(call => call.path === '/v1/webhooks'));
});

test('Creem refusing the key, timing out or failing gives a clear error', async () => {
  await assert.rejects(planCreemSetup(options(fakeCreem({ fail: () => 403 }))), error => error.reason === 'key' && /CREEM_API_KEY/.test(error.message) && !error.message.includes(API_KEY));
  await assert.rejects(planCreemSetup(options(fakeCreem({ fail: () => 500 }))), error => error.reason === 'creem');
  const slow = { fetch: (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))) };
  await assert.rejects(planCreemSetup(options(slow, { timeoutMs: 20 })), error => error.reason === 'timeout');
  await assert.rejects(planCreemSetup(options({ fetch: async () => { throw new TypeError('fetch failed'); } })), error => error.reason === 'network');
  await assert.rejects(planCreemSetup(options(fakeCreem(), { apiKey: '' })), error => error.reason === 'no-key');
  // One product refused: the others are still made, and the failure is named.
  const creem = fakeCreem({ fail: call => (call.method === 'POST' && call.body.currency === 'USD' && call.path === '/v1/products' ? 400 : 0) });
  const result = await applyCreemSetup(options(creem), { create: ALL });
  assert.deepEqual(result.created.map(entry => entry.slot), ['plus-eur', 'gift-eur', 'webhook']);
  assert.deepEqual(result.failures.map(entry => entry.slot), ['plus-usd', 'gift-usd']);
  assert.ok(result.failures.every(entry => !entry.error.includes(API_KEY)), 'an echoed key is hidden');
});

test('envBlock lists the ids it has, and CREEM_TEST_MODE=1 only when it is what makes the key a test key', () => {
  const slots = [{ env: 'CREEM_PLUS_EUR', id: 'prod_a' }, { env: 'CREEM_PLUS_USD', id: '' }];
  assert.equal(envBlock(slots, 'live', LIVE_KEY), 'CREEM_PLUS_EUR=prod_a\n');
  assert.equal(envBlock(slots, 'test', API_KEY), 'CREEM_PLUS_EUR=prod_a\n', 'a creem_test_ key is in test mode by itself');
  assert.equal(envBlock(slots, 'test', 'creem_0123456789abcdef'), 'CREEM_PLUS_EUR=prod_a\nCREEM_TEST_MODE=1\n', 'another key is in test mode only through CREEM_TEST_MODE');
  assert.equal(envBlock([], 'live', LIVE_KEY), '');
  assert.deepEqual([needsTestModeLine('test', API_KEY), needsTestModeLine('test', 'creem_x'), needsTestModeLine('live', 'creem_x')], [false, true, false]);
});

test('the rate limiter answers the seconds to wait', () => {
  let time = 0;
  const limit = createRateLimiter({ limit: 2, windowMs: 60000, now: () => time });
  assert.deepEqual([limit(), limit(), limit()], [0, 0, 60]);
  time = 30000;
  assert.equal(limit(), 30);
  time = 60001;
  assert.equal(limit(), 0);
});

// ---- Routes ------------------------------------------------------------------

function setup({ creem = fakeCreem(), origin = 'https://planner.bemorin.com', ...extra } = {}) {
  const warnings = [];
  const clock = { now: START };
  const api = createPlannerApi({
    store: createMemoryStore(), adminToken: 'secret', authFailureDelayMs: 0, now: () => new Date(clock.now),
    creemApiKey: API_KEY, creemWebhookSecret: WEBHOOK_SECRET, creemProducts: {}, creemFetch: creem.fetch, publicBaseUrl: 'https://planner.bemorin.com',
    warn: message => warnings.push(message),
    // Each test its own limits (the isolate's are shared by every request: see the test of the Pages Function).
    adminLimits: createAdminLimits({ now: () => clock.now }),
    ...extra
  });
  const post = (action, body, token = 'secret') => api(new Request(`${origin}/api/admin/creem/setup/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body ?? {})
  }));
  return { api, creem, warnings, clock, post };
}
const read = async response => ({ status: response.status, body: await response.json() });

test('the setup routes need the owner’s sign-in and POST', async () => {
  const { api, post, creem } = setup();
  assert.equal((await post('plan', {}, '')).status, 401);
  assert.equal((await post('plan', {}, 'wrong')).status, 401);
  assert.equal((await post('apply', { confirm: true, mode: 'test', create: ALL }, '')).status, 401);
  assert.equal((await api(new Request('https://planner.bemorin.com/api/admin/creem/setup/plan', { headers: { authorization: 'Bearer secret' } }))).status, 405);
  assert.equal((await post('other')).status, 404);
  assert.equal(creem.calls.length, 0, 'Creem is never called without the sign-in');
  const plan = await read(await post('plan'));
  assert.equal(plan.status, 200);
  assert.equal(plan.body.webhook.url, 'https://planner.bemorin.com/api/creem/webhook');
  assert.deepEqual(plan.body.webhook.events, ['checkout.completed', 'refund.created', 'dispute.created']);
});

test('apply needs { confirm: true } and the key’s mode; live mode uses Creem’s live API', async () => {
  const live = setup({ creemApiKey: LIVE_KEY });
  assert.equal((await read(await live.post('plan'))).body.mode, 'live');
  const unconfirmed = await read(await live.post('apply', { mode: 'live', create: ALL }));
  assert.deepEqual([unconfirmed.status, unconfirmed.body.reason], [400, 'confirm']);
  const wrongMode = await read(await live.post('apply', { confirm: true, mode: 'test', create: ALL }));
  assert.deepEqual([wrongMode.status, wrongMode.body.reason, wrongMode.body.mode], [409, 'mode', 'live']);
  const truthy = await read(await live.post('apply', { confirm: 'yes', mode: 'live', create: ALL }));
  assert.equal(truthy.status, 400);
  assert.equal(live.creem.posts().length, 0, 'nothing was created without the confirmation');
  const done = await read(await live.post('apply', { confirm: true, mode: 'live', create: ALL }));
  assert.equal(done.status, 200);
  assert.equal(done.body.created.length, 5);
  assert.ok(live.creem.calls.every(call => call.url.startsWith('https://api.creem.io/v1/')));
  assert.ok(!done.body.env.includes('CREEM_TEST_MODE'));
  const noKey = await read(await setup({ creemApiKey: '' }).post('plan'));
  assert.deepEqual([noKey.status, noKey.body.reason], [409, 'no-key']);
});

test('no secret in any answer or log: only the creation answer carries the new webhook secret, once', async () => {
  const creem = fakeCreem({ webhooks: [] });
  const { post, warnings } = setup({ creem });
  const answers = [];
  const plan = await post('plan');
  answers.push(await plan.text());
  const apply = await post('apply', { confirm: true, mode: 'test', create: ALL });
  const applyText = await apply.text();
  assert.equal(JSON.parse(applyText).webhookSecret, NEW_SECRET);
  assert.equal(applyText.split(NEW_SECRET).length, 2, 'the new secret appears once, in webhookSecret');
  // The endpoint now exists with NEW_SECRET: later answers compare it, never return it.
  answers.push(await (await post('plan')).text(), await (await post('apply', { confirm: true, mode: 'test', create: ALL })).text());
  const refused = setup({ creem: fakeCreem({ fail: () => 403 }) });
  const failed = await refused.post('plan');
  assert.equal(failed.status, 502);
  answers.push(await failed.text());
  for (const text of answers) for (const secret of [API_KEY, WEBHOOK_SECRET, NEW_SECRET]) assert.ok(!text.includes(secret), `${secret} in ${text.slice(0, 80)}`);
  for (const secret of [API_KEY, WEBHOOK_SECRET, NEW_SECRET]) assert.ok(!JSON.stringify([...warnings, ...refused.warnings]).includes(secret));
  assert.match(answers.at(-1), /Creem refused CREEM_API_KEY while listing your products \(HTTP 403\)\. /);
  assert.ok(!answers.at(-1).includes('Invalid API key'), 'after a 403, nothing of Creem’s own text');
  assert.ok(!applyText.includes(API_KEY) && !applyText.includes(WEBHOOK_SECRET));
});

test('the setup routes are rate-limited, and one apply runs at a time', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const base = fakeCreem();
  const slowCreem = { ...base, fetch: async (url, init) => { if ((init.method || 'GET') === 'POST') await gate; return base.fetch(url, init); } };
  const { post, clock } = setup({ creem: slowCreem });
  const first = post('apply', { confirm: true, mode: 'test', create: ['plus-eur'] });
  await new Promise(resolve => { setTimeout(resolve, 20); });
  const second = await read(await post('apply', { confirm: true, mode: 'test', create: ['plus-eur'] }));
  assert.deepEqual([second.status, second.body.reason], [409, 'running']);
  release();
  assert.equal((await first).status, 200);
  assert.equal(base.posts().length, 1);
  for (let index = 2; index < SETUP_LIMITS.apply.limit; index += 1) assert.equal((await post('apply', { confirm: true, mode: 'test', create: [] })).status, 200);
  const limited = await post('apply', { confirm: true, mode: 'test', create: [] });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  clock.now += SETUP_LIMITS.apply.windowMs + 1;
  assert.equal((await post('apply', { confirm: true, mode: 'test', create: [] })).status, 200);
  for (let index = 0; index < SETUP_LIMITS.plan.limit; index += 1) assert.equal((await post('plan')).status, 200);
  assert.equal((await post('plan')).status, 429);
});

// ---- 1.31 review: limits across requests, overlapping Creates, the webhook's address, partial echoes ----------

test('in production the limits and the one-Create-at-a-time guard hold across requests (the Function builds an API per request)', async () => {
  const { onRequest } = await import('../functions/api/[[path]].js');
  const base = fakeCreem();
  const realFetch = globalThis.fetch;
  // Creem answers after a moment, as over the network.
  globalThis.fetch = async (url, init) => { await new Promise(resolve => { setTimeout(resolve, 15); }); return base.fetch(url, init); };
  try {
    const env = {
      DB: { prepare: () => ({ first: async () => null, all: async () => ({ results: [] }), bind() { return this; }, run: async () => ({}) }) },
      ADMIN_TOKEN: 'a-long-enough-admin-token-for-these-tests-0123456789', CREEM_API_KEY: API_KEY, PUBLIC_BASE_URL: 'https://planner.example.com',
      ASSETS: { fetch: async () => new Response('') }
    };
    const call = (action, body) => onRequest({
      request: new Request(`https://planner.example.com/api/admin/creem/setup/${action}`, { method: 'POST', headers: { authorization: `Bearer ${env.ADMIN_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }),
      env, waitUntil() {}
    });
    const create = { confirm: true, mode: 'test', create: ALL };
    const answers = await Promise.all([call('apply', create), call('apply', create)]);
    const bodies = await Promise.all(answers.map(answer => answer.json()));
    assert.deepEqual(answers.map(answer => answer.status), [200, 409]);
    assert.equal(bodies[1].reason, 'running');
    assert.match(bodies[1].error, /^Nothing was created: a setup is already running/);
    assert.equal(bodies[0].created.length, 5);
    assert.deepEqual([base.products.length, base.webhooks.length], [4, 1], 'nothing made twice');
    const plans = [];
    for (let index = 0; index <= SETUP_LIMITS.plan.limit; index += 1) plans.push((await call('plan')).status);
    assert.deepEqual(plans, [...Array(SETUP_LIMITS.plan.limit).fill(200), 429], 'one window for every request of the isolate');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('two Creates on two workers at once: Creem’s Idempotency-Key answers the same products', async () => {
  const creem = fakeCreem();
  const slow = { fetch: async (url, init) => { await new Promise(resolve => { setTimeout(resolve, 10); }); return creem.fetch(url, init); } };
  const [first, second] = await Promise.all([applyCreemSetup(options(slow), { create: ALL.filter(slot => slot !== 'webhook') }), applyCreemSetup(options(slow), { create: ALL.filter(slot => slot !== 'webhook') })]);
  assert.equal(creem.posts().length, 8, 'both asked');
  assert.equal(creem.products.length, 4, 'four products in Creem, not eight');
  assert.deepEqual(first.created.map(entry => entry.id), second.created.map(entry => entry.id));
  assert.equal(productIdempotencyKey('test', 'plus-eur', 2900, '20261021', 0), 'dp-setup-test-plus-eur-2900-20261021-0');
  assert.equal(productIdempotencyKey('live', 'gift-usd', 19900, '20261021', 2), 'dp-setup-live-gift-usd-19900-20261021-2');
});

test('the webhook list is read again right before the webhook is created: one made meanwhile is found, not made twice', async () => {
  const creem = fakeCreem();
  const racing = {
    fetch: async (url, init = {}) => {
      // Another tab's Create makes the webhook while this one creates the products.
      if ((init.method || 'GET') === 'POST' && new URL(url).pathname === '/v1/products' && !creem.webhooks.length) creem.webhooks.push(hook({ id: 'wh_other', secret: HOOK_SECRET }));
      return creem.fetch(url, init);
    }
  };
  const result = await applyCreemSetup(options(racing), { create: ALL });
  assert.equal(creem.webhooks.length, 1);
  assert.ok(!creem.posts().some(call => call.path === '/v1/webhooks'), 'no second webhook');
  assert.equal(result.webhook.state, 'ok');
  assert.equal(result.webhook.webhook.id, 'wh_other');
  assert.ok(result.already.includes('webhook'));
  assert.equal('webhookSecret' in result, false);
  assert.equal(creem.calls.filter(call => call.method === 'GET' && call.path === '/v1/webhooks').length, 2, 'listed for the plan, then again right before');
});

test('the webhook’s address: production, a local server, or a preview’s own with a test key; a live key is refused off production', async () => {
  const base = 'https://planner.bemorin.com';
  assert.deepEqual(setupTarget({ origin: base, baseUrl: base, mode: 'live' }), { url: `${base}/api/creem/webhook`, source: 'production', refused: '' });
  assert.deepEqual(setupTarget({ origin: 'http://localhost:8395', baseUrl: 'https://tunnel.example', mode: 'test' }), { url: 'https://tunnel.example/api/creem/webhook', source: 'local', refused: '' });
  assert.deepEqual(setupTarget({ origin: 'https://abc123.daily-planner.pages.dev', baseUrl: base, mode: 'test' }), { url: 'https://abc123.daily-planner.pages.dev/api/creem/webhook', source: 'preview', refused: '' });
  const live = setupTarget({ origin: 'https://abc123.daily-planner.pages.dev', baseUrl: base, mode: 'live' });
  assert.equal(live.url, `${base}/api/creem/webhook`);
  assert.match(live.refused, /^This page is open on https:\/\/abc123\.daily-planner\.pages\.dev, not on the production address https:\/\/planner\.bemorin\.com: with a live key, set Creem up from https:\/\/planner\.bemorin\.com\/admin\/configuration\/\.$/);

  // Through the API: a preview with a test key plans (and makes) its own webhook.
  const preview = setup({ origin: 'https://abc123.daily-planner.pages.dev' });
  const plan = await read(await preview.post('plan'));
  assert.deepEqual([plan.body.webhook.url, plan.body.webhook.source, plan.body.refused], ['https://abc123.daily-planner.pages.dev/api/creem/webhook', 'preview', '']);
  const made = await read(await preview.post('apply', { confirm: true, mode: 'test', create: ['webhook'] }));
  assert.equal(preview.creem.webhooks[0].url, 'https://abc123.daily-planner.pages.dev/api/creem/webhook');
  assert.equal(made.body.created[0].slot, 'webhook');
  // A live key there: the plan reads, Create is refused and nothing is made.
  const liveThere = setup({ origin: 'https://abc123.daily-planner.pages.dev', creemApiKey: LIVE_KEY });
  const livePlan = await read(await liveThere.post('plan'));
  assert.equal(livePlan.status, 200);
  assert.match(livePlan.body.refused, /not on the production address/);
  const refused = await read(await liveThere.post('apply', { confirm: true, mode: 'live', create: ALL }));
  assert.deepEqual([refused.status, refused.body.reason], [409, 'origin']);
  assert.match(refused.body.error, /^Nothing was created\. This page is open on/);
  assert.equal(liveThere.creem.posts().length, 0);
});

test('Creem’s answers never bring back a part of the key: none of its text after a 403, a scrubbed one otherwise', async () => {
  const key = 'creem_live_ABCDEFGHIJKLMNOPQRSTUV';
  const body = key.slice('creem_live_'.length);
  const echoes = {
    'ending in 4': `API key ending in ${key.slice(-4)} is invalid`,
    masked: `Invalid key ${key.slice(0, 8)}****${key.slice(-6)}`,
    'prefix only': `Invalid API key ${key.slice(0, 15)}…`,
    'middle fragment': `bad key fragment ${key.slice(14, 26)}`,
    'URL-encoded': `key=${[...key].map(character => `%${character.charCodeAt(0).toString(16)}`).join('')}`,
    'JSON-escaped': `key ${[...key].map(character => `\\u00${character.charCodeAt(0).toString(16)}`).join('')}`
  };
  const leaks = text => { const found = []; for (let start = 0; start + 4 <= body.length; start += 1) if (text.includes(body.slice(start, start + 4))) found.push(body.slice(start, start + 4)); return found; };
  for (const [name, message] of Object.entries(echoes)) {
    for (const status of [403, 422]) {
      const fetch = async (url, init = {}) => {
        const path = new URL(url).pathname;
        if (status === 403 || ((init.method || 'GET') === 'POST' && path === '/v1/products')) return json(status, { status, error: 'Refused', message: [message] });
        if (path === '/v1/products/search' || path === '/v1/webhooks') return json(200, { items: [], pagination: { total_pages: 1 } });
        return json(404, {});
      };
      const route = createCreemSetupRoute(() => ({ apiKey: key, mode: 'live', fetch, products: {}, webhookSecret: WEBHOOK_SECRET, webhookUrl: URL_OK }), { limits: createAdminLimits() });
      const answer = await route(new Request('https://planner.bemorin.com/api/admin/creem/setup/apply', { method: 'POST' }), 'admin/creem/setup/apply', async () => ({ confirm: true, mode: 'live', create: ['plus-eur'] }));
      const text = JSON.stringify(answer.body);
      assert.deepEqual(leaks(text), [], `${name}, HTTP ${status}: ${text.slice(0, 300)}`);
      if (status === 403) {
        assert.equal(answer.status, 502);
        assert.ok(!text.includes('Invalid') && !text.includes('fragment') && !text.includes('key='), `${name}: nothing of Creem’s words after a 403`);
      } else {
        assert.equal(answer.status, 200);
        assert.match(answer.body.failures[0].error, /^Creem refused creating Daily Planner Plus \(EUR\) \(HTTP 422(?:: .*)?\)\.$/, name);
      }
    }
  }
});

test('a Creem answer cut off by the timeout is a timeout, said in plain words', async () => {
  const stalled = {
    fetch: async (url, init) => ({
      status: 200, ok: true,
      json: () => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
    })
  };
  await assert.rejects(planCreemSetup(options(stalled, { timeoutMs: 1000 })), error => error.reason === 'timeout' && error.message === 'Creem didn’t answer within 1 second. Try again.');
});
