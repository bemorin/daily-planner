import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMemoryStore, createPlannerApi, TEST_PURCHASES_SOURCE, TEST_SWITCH_OFF_BATCH } from '../server/planner-api.js';
import { createD1Store } from '../server/d1-store.js';
import { generatePlusKeyPair } from '../server/licenses.js';
import { checkoutSeal, webhookSignature } from '../server/creem.js';
import { buildAttention, setupChecks } from '../admin/attention.js';
import { confirmMatches, dialogHtml, doneText, panelShown, purchaseWords, readStatus, RESTORE_WORD, SWITCH_OFF_WORDS, testPurchasesHtml } from '../admin/test-purchases.js';
import { testModeLine } from '../src/lib/planner-api.js';
import { priceCents } from '../src/lib/pricing.js';

// Review mode (1.34): while Creem reviews the store, CREEM_TEST_ON_PRODUCTION lets a test key sell on the
// production address; once payments are live, the dashboard switches every test-mode purchase off at once
// (and can restore them all), and “Needs your attention” reminds the owner until it is done.

const START = Date.parse('2026-10-23T08:00:00Z');
const KEYS = await generatePlusKeyPair();
const PRODUCTS = Object.freeze({ plus: { EUR: 'prod_plus_eur', USD: 'prod_plus_usd' }, gift: { EUR: 'prod_gift_eur', USD: 'prod_gift_usd' } });
const WEBHOOK_SECRET = 'whsec_test_review';
const PRODUCTION = 'https://planner.test';
const MIGRATIONS = ['0001_planner_api.sql', '0002_team_requests.sql', '0003_plus.sql', '0004_creem_reviews.sql', '0005_refunds.sql'];
const SWITCHED_OFF = 'This purchase was switched off, so it can’t be activated any more. If this is a mistake, reply to your receipt email.';
const TEST_PURCHASE = 'This was a test purchase, made before payments went live.';

const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const at = (origin, method, path, body, token) => new Request(`${origin}/api/${path}`, {
  method,
  headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) })
});
const get = (path, token) => at(PRODUCTION, 'GET', path, undefined, token);
const post = (path, body = {}, token) => at(PRODUCTION, 'POST', path, body, token);
const patch = (path, body, token) => at(PRODUCTION, 'PATCH', path, body, token);
const asJson = async response => ({ status: response.status, body: await response.json() });

/** A paid Creem checkout, sealed as POST /api/checkout seals it. */
async function checkout(id, { item = 'plus', plan = 'up-to-10', currency = 'EUR', mode = 'test' } = {}) {
  const rid = `dp_${id.slice(-16).padStart(16, '0')}`;
  const cents = priceCents(item, item === 'gift' ? plan : '', currency);
  const kindPlan = item === 'gift' ? { kind: 'gift', plan } : { kind: 'plus', plan: '' };
  const seal = await checkoutSeal(KEYS.signingKey, { ...kindPlan, currency, rid });
  return {
    id, object: 'checkout', mode, status: 'completed', units: 1, request_id: rid, product: PRODUCTS[item][currency],
    order: { id: `ord_${id}`, object: 'order', status: 'paid', type: 'onetime', amount: cents, amount_paid: cents, currency },
    customer: { id: 'cust_1', object: 'customer', email: 'reviewer@creem.example', country: 'FR' },
    custom_fields: item === 'gift' ? [{ type: 'text', key: 'company', label: 'Company name, shown to your team', optional: true, text: { max_length: 80, value: 'Creem review' } }] : [],
    metadata: item === 'gift' ? { kind: 'gift', plan, seats: '10', currency, rid, seal } : { kind: 'plus', currency, rid, seal }
  };
}

/** Stand-in for Creem: reads the checkouts it knows, opens new ones (recorded in `opened`). */
function fakeCreem(checkouts = {}) {
  const opened = [];
  const fetch = async (url, init = {}) => {
    if (init.method === 'POST') {
      opened.push(String(url));
      return jsonResponse(200, { id: `ch_opened${opened.length}`, object: 'checkout', status: 'pending', checkout_url: `https://checkout.creem.io/ch_opened${opened.length}` });
    }
    const id = new URL(url).searchParams.get('checkout_id');
    return Object.hasOwn(checkouts, id) ? jsonResponse(200, checkouts[id]) : jsonResponse(404, { message: ['Checkout not found'] });
  };
  return { fetch, opened, checkouts };
}

function fakeResend() {
  const calls = [];
  return { calls, fetch: async (url, init) => { calls.push(JSON.parse(init.body)); return jsonResponse(200, { id: 'x' }); } };
}

function setup({ store = createMemoryStore(), creem = fakeCreem(), resend = fakeResend(), ...options } = {}) {
  const api = createPlannerApi({
    store, adminToken: 'secret', now: () => new Date(START), authFailureDelayMs: 0, publicBaseUrl: PRODUCTION,
    plusSigningKey: KEYS.signingKey, creemApiKey: 'creem_test_review', creemTestOnProduction: '1', creemWebhookSecret: WEBHOOK_SECRET, creemProducts: PRODUCTS, creemFetch: creem.fetch,
    resendApiKey: 're_test_key', emailFrom: 'Ben Morin <hello@bemorin.example>', ownerEmail: 'owner@bemorin.example', emailFetch: resend.fetch, emailIntervalMs: 0,
    defer: () => {}, warn: () => {},
    ...options
  });
  return { api, store, creem, resend };
}

async function openSqlite(t, migrations = MIGRATIONS) {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { t.skip('node:sqlite is not available in this Node version'); return null; }
  const sqlite = new DatabaseSync(':memory:');
  for (const migration of migrations) sqlite.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
  const db = {
    statements: 0,
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      let params = [];
      const api = {
        bind(...values) { assert.ok(values.length <= 100, `D1 takes at most 100 values a statement (${values.length})`); params = values; return api; },
        async run() { db.statements += 1; return { meta: { changes: Number(statement.run(...params).changes) } }; },
        async all() { db.statements += 1; return { results: statement.all(...params) }; }
      };
      return api;
    }
  };
  return db;
}

/** The body once with the memory store, once with D1 over node:sqlite. */
async function bothStores(t, body) {
  await body('memory', createMemoryStore(), null);
  const d1 = await openSqlite(t);
  if (d1) await body('D1', createD1Store(d1), d1);
}

async function sendWebhook(api, event) {
  const raw = JSON.stringify(event);
  return api(new Request(`${PRODUCTION}/api/creem/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'creem-signature': await webhookSignature(raw, WEBHOOK_SECRET) }, body: raw }));
}
const checkLicense = async (api, license) => (await asJson(await api(post('plus/check', { license })))).body.revoked;

test('review mode: a test key sells on the production address only with CREEM_TEST_ON_PRODUCTION; a live key, a preview and localhost are unchanged', async () => {
  const LISTED = { plus: ['EUR', 'USD'], gift: ['EUR', 'USD'], currency: '' };
  const OFF = { plus: [], gift: [], currency: '', test: false };
  const cases = [
    ['test key, production, review off', { creemTestOnProduction: '' }, PRODUCTION, OFF, 503, ''],
    ['test key, production, review on', {}, PRODUCTION, { ...LISTED, test: true, review: true }, 201, 'https://test-api.creem.io/v1/checkouts'],
    ['test key, production, review “true”', { creemTestOnProduction: ' true ' }, PRODUCTION, { ...LISTED, test: true, review: true }, 201, 'https://test-api.creem.io/v1/checkouts'],
    ['test key, production, review “0”', { creemTestOnProduction: '0' }, PRODUCTION, OFF, 503, ''],
    ['live key, production, review off', { creemApiKey: 'creem_live_review', creemTestOnProduction: '' }, PRODUCTION, { ...LISTED, test: false }, 201, 'https://api.creem.io/v1/checkouts'],
    ['live key, production, review on: no effect', { creemApiKey: 'creem_live_review' }, PRODUCTION, { ...LISTED, test: false }, 201, 'https://api.creem.io/v1/checkouts'],
    ['test key, preview, review off', { creemTestOnProduction: '' }, 'https://abc123.daily-planner.pages.dev', { ...LISTED, test: true }, 201, 'https://test-api.creem.io/v1/checkouts'],
    ['test key, preview, review on', {}, 'https://abc123.daily-planner.pages.dev', { ...LISTED, test: true }, 201, 'https://test-api.creem.io/v1/checkouts'],
    ['test key, localhost, review on', { publicBaseUrl: 'http://localhost:8471' }, 'http://localhost:8471', { ...LISTED, test: true }, 201, 'https://test-api.creem.io/v1/checkouts'],
    ['test key, localhost, review off', { publicBaseUrl: 'http://localhost:8471', creemTestOnProduction: '' }, 'http://localhost:8471', { ...LISTED, test: true }, 201, 'https://test-api.creem.io/v1/checkouts']
  ];
  for (const [label, options, origin, answer, status, called] of cases) {
    const { api, creem } = setup(options);
    assert.deepEqual((await asJson(await api(at(origin, 'GET', 'checkout')))).body, answer, label);
    assert.equal((await api(at(origin, 'POST', 'checkout', { item: 'plus', currency: 'EUR' }))).status, status, label);
    assert.equal((await api(at(origin, 'POST', 'checkout', { item: 'gift', plan: 'gift-1', currency: 'EUR' }))).status, status, `${label}: a gift too`);
    assert.deepEqual(creem.opened, called ? [called, called] : [], label);
  }
  // The dashboard's Setup says whether the variable is on and whether it opens anything.
  const payments = async options => (await asJson(await setup(options).api(get('admin/summary', 'secret')))).body.setup.payments;
  assert.deepEqual([(await payments({})).reviewMode, (await payments({})).reviewOpen], [true, true]);
  assert.deepEqual([(await payments({ creemApiKey: 'creem_live_review' })).reviewMode, (await payments({ creemApiKey: 'creem_live_review' })).reviewOpen], [true, false]);
  assert.deepEqual([(await payments({ creemTestOnProduction: '' })).reviewMode, (await payments({ creemTestOnProduction: '' })).reviewOpen], [false, false]);
});

test('in review mode a purchase and a gift are delivered and emailed as usual, marked Test mode', async () => {
  const creem = fakeCreem({ ch_reviewplus01: await checkout('ch_reviewplus01'), ch_reviewgift01: await checkout('ch_reviewgift01', { item: 'gift' }) });
  const { api, store, resend } = setup({ creem });
  const claimed = await asJson(await api(post('purchases/claim', { checkout: 'ch_reviewplus01' })));
  assert.equal(claimed.status, 200);
  assert.equal(await checkLicense(api, claimed.body.license), false);
  assert.equal((await store.getPurchase('ch_reviewplus01')).note, 'Test mode');
  assert.equal((await sendWebhook(api, { id: 'evt_g', eventType: 'checkout.completed', created_at: START, object: await checkout('ch_reviewgift01', { item: 'gift' }) })).status, 200);
  const gift = await store.getGiftByCheckout('ch_reviewgift01');
  assert.equal(gift.note, 'Test mode · Creem · Up to 10 people');
  assert.equal(gift.org, 'Creem review');
  assert.ok(resend.calls.some(call => call.to?.[0] === 'reviewer@creem.example'), 'the buyer is emailed the gift link');
  // The pages know: the line every buy button shows.
  const options = (await asJson(await api(get('checkout')))).body;
  assert.equal(testModeLine(options), 'Payments are in test mode while our payment provider reviews the store: no real card is charged.');
});

test('the checkout options’ test flag gives the pages their one line', () => {
  assert.equal(testModeLine({ test: true, review: true }), 'Payments are in test mode while our payment provider reviews the store: no real card is charged.');
  assert.equal(testModeLine({ test: true }), 'Payments are in test mode: no real card is charged.');
  assert.equal(testModeLine({ test: false, review: true }), '', 'review alone is nothing');
  for (const answer of [null, undefined, {}, { test: 'true' }]) assert.equal(testModeLine(answer), '');
});

test('switching test-mode purchases off: counts, typed confirmation, idempotent, restore all (memory and D1)', async t => {
  await bothStores(t, async (label, store) => {
    const ids = { plus: ['ch_tplus0000001', 'ch_tplus0000002', 'ch_tplus0000003'], gifts: ['ch_tgift0000001', 'ch_tgift0000002'] };
    const creem = fakeCreem(Object.fromEntries(await Promise.all([...ids.plus.map(async id => [id, await checkout(id)]), ...ids.gifts.map(async id => [id, await checkout(id, { item: 'gift' })])])));
    const { api } = setup({ store, creem });
    const licences = [];
    for (const id of ids.plus) licences.push((await asJson(await api(post('purchases/claim', { checkout: id })))).body.license);
    const gifts = [];
    for (const id of ids.gifts) gifts.push((await asJson(await api(post('purchases/claim', { checkout: id })))).body);
    const giftLicense = (await asJson(await api(post(`gifts/${gifts[0].code}/redeem`)))).body.license;
    // Not test-mode purchases: a live purchase, a gift made in the dashboard whose note happens to start the same way.
    await store.addPurchase({ checkoutRef: 'ch_livepurchase1', kind: 'plus', licenseId: '0123456789abcdef', claims: 1, email: '', note: '', createdAt: '2026-11-01T08:00:00.000Z' });
    const manual = (await asJson(await api(post('admin/gifts', { org: 'Invoice Co', seats: 5, note: 'Test mode of invoicing' }, 'secret')))).body.gift;
    // Before the switch-off: one purchase revoked by hand, one gift link switched off by hand.
    const byHand = (await asJson(await api(post('admin/revocations', { target: ids.plus[2], note: 'Asked to' }, 'secret')))).body.source;
    assert.equal((await api(patch(`admin/gifts/${gifts[1].code}`, { active: false }, 'secret'))).status, 200, label);

    const status = async () => (await asJson(await api(get('admin/test-purchases', 'secret')))).body.status;
    const before = await status();
    assert.deepEqual(before, { plus: 3, gifts: 2, plusOff: 1, giftsOff: 0, active: 4, switchedOff: 0, pending: 5, latestAt: '2026-10-23T08:00:00.000Z', mode: 'test', reviewMode: true, reviewOpen: true }, label);
    assert.deepEqual((await asJson(await api(get('admin/summary', 'secret')))).body.testPurchases, before, `${label}: the summary carries the counts`);

    // Owner only, and confirmed on the server too.
    assert.equal((await api(get('admin/test-purchases'))).status, 401, label);
    assert.equal((await api(post('admin/test-purchases/switch-off', { confirm: SWITCH_OFF_WORDS }))).status, 401, label);
    assert.equal((await api(post('admin/test-purchases/switch-off', { confirm: SWITCH_OFF_WORDS }, 'wrong'))).status, 401, label);
    for (const body of [{}, { confirm: 'switch off' }, { confirm: true }, { confirm: 'SWITCH OFF ' }, { confirm: RESTORE_WORD }]) {
      const refused = await asJson(await api(post('admin/test-purchases/switch-off', body, 'secret')));
      assert.deepEqual(refused, { status: 400, body: { error: 'Type SWITCH OFF to confirm.' } }, `${label}: ${JSON.stringify(body)}`);
    }
    assert.equal((await api(get('admin/test-purchases/switch-off', 'secret'))).status, 405, label);
    assert.equal((await api(post('admin/test-purchases', {}, 'secret'))).status, 405, label);
    assert.deepEqual(await status(), before, `${label}: nothing changed`);

    const done = await asJson(await api(post('admin/test-purchases/switch-off', { confirm: SWITCH_OFF_WORDS }, 'secret')));
    assert.equal(done.status, 200, label);
    assert.deepEqual(done.body.added, { plus: 3, gifts: 2 }, label);
    assert.equal(done.body.more, 0, label);
    assert.deepEqual([done.body.status.active, done.body.status.plusOff, done.body.status.giftsOff, done.body.status.switchedOff, done.body.status.pending], [0, 3, 2, 5, 0], label);
    // Planners lose Plus at their next check, gift links and activation links stop now.
    for (const license of [...licences, giftLicense]) assert.equal(await checkLicense(api, license), true, label);
    assert.deepEqual(await asJson(await api(post('purchases/claim', { checkout: ids.plus[0] }))), { status: 410, body: { error: TEST_PURCHASE, test: true } }, `${label}: said to be a test purchase`);
    assert.deepEqual(await asJson(await api(post('purchases/claim', { checkout: ids.plus[2] }))), { status: 410, body: { error: SWITCHED_OFF, revoked: true } }, `${label}: also revoked by hand`);
    assert.equal((await asJson(await api(post(`gifts/${gifts[0].code}/redeem`)))).status, 410, label);
    assert.equal((await asJson(await api(get(`gifts/${gifts[0].code}`)))).body.revoked, true, label);
    assert.equal((await store.getGift(gifts[0].code.replace(/-/g, ''))).active, false, label);
    // Nothing else.
    assert.equal(await store.isRevoked(['checkout:ch_livepurchase1', 'license:0123456789abcdef']), false, label);
    assert.equal((await store.getGift(manual.code.replace(/-/g, ''))).active, true, label);
    // Recorded like the owner's other revocations, under one source.
    const rows = await store.listRevocationsBySource(TEST_PURCHASES_SOURCE);
    assert.equal(rows.length, 3 * 2 + 2 * 2, label);
    assert.ok(rows.every(row => row.reason === 'owner' && row.note === 'Bought in test mode, switched off together' && row.createdAt === '2026-10-23T08:00:00.000Z'), label);
    assert.deepEqual(rows.filter(row => row.kind === 'gift').map(row => [row.label, row.wasActive]).sort(), [[gifts[0].code, true], [gifts[1].code, false]].sort(), label);

    // Idempotent: nothing more to add.
    const again = await asJson(await api(post('admin/test-purchases/switch-off', { confirm: SWITCH_OFF_WORDS }, 'secret')));
    assert.deepEqual([again.status, again.body.added, again.body.more], [200, { plus: 0, gifts: 0 }, 0], label);
    assert.equal((await store.listRevocationsBySource(TEST_PURCHASES_SOURCE)).length, 10, label);

    // Restore all: confirmed too; each gift link back as it was; what the owner revoked by hand stays revoked.
    assert.deepEqual(await asJson(await api(post('admin/test-purchases/restore', {}, 'secret'))), { status: 400, body: { error: 'Confirm with RESTORE to restore them.' } }, label);
    assert.equal((await api(post('admin/test-purchases/restore', { confirm: RESTORE_WORD }))).status, 401, label);
    const restored = await asJson(await api(post('admin/test-purchases/restore', { confirm: RESTORE_WORD }, 'secret')));
    assert.equal(restored.status, 200, label);
    assert.deepEqual(restored.body.restored, { plus: 3, gifts: 2 }, label);
    assert.deepEqual([restored.body.status.active, restored.body.status.plusOff, restored.body.status.switchedOff], [4, 1, 0], label);
    assert.deepEqual(await Promise.all([...licences, giftLicense].map(license => checkLicense(api, license))), [false, false, true, false], label);
    assert.equal((await store.getGift(gifts[0].code.replace(/-/g, ''))).active, true, `${label}: back on`);
    assert.equal((await store.getGift(gifts[1].code.replace(/-/g, ''))).active, false, `${label}: switched off by hand before, so still off`);
    assert.equal((await store.listRevocationsBySource(byHand)).length, 2, label);
    const twice = await asJson(await api(post('admin/test-purchases/restore', { confirm: RESTORE_WORD }, 'secret')));
    assert.deepEqual([twice.status, twice.body.restored], [200, { plus: 0, gifts: 0 }], `${label}: nothing left to restore`);

    // A switch-off after new test purchases only adds them.
    await api(post('admin/test-purchases/switch-off', { confirm: SWITCH_OFF_WORDS }, 'secret'));
    creem.checkouts.ch_tplus0000004 = await checkout('ch_tplus0000004');
    const late = (await asJson(await api(post('purchases/claim', { checkout: 'ch_tplus0000004' })))).body.license;
    assert.deepEqual([(await status()).active, (await status()).pending], [1, 1], label);
    const more = await asJson(await api(post('admin/test-purchases/switch-off', { confirm: SWITCH_OFF_WORDS }, 'secret')));
    assert.deepEqual(more.body.added, { plus: 1, gifts: 0 }, label);
    assert.equal(await checkLicense(api, late), true, label);
  });
});

test('a large switch-off goes in batches, a few rows to a D1 statement, within a request’s queries (memory and D1)', async t => {
  await bothStores(t, async (label, store, db) => {
    const { api } = setup({ store });
    const count = TEST_SWITCH_OFF_BATCH + 5;
    for (let index = 0; index < count; index += 1) {
      await store.addPurchase({ checkoutRef: `ch_bulk${String(index).padStart(8, '0')}`, kind: 'plus', licenseId: index.toString(16).padStart(16, '0'), claims: 1, email: '', note: 'Test mode', createdAt: new Date(START - index * 60000).toISOString() });
    }
    const queries = db ? db.statements : 0;
    const first = await asJson(await api(post('admin/test-purchases/switch-off', { confirm: SWITCH_OFF_WORDS }, 'secret')));
    assert.deepEqual([first.status, first.body.added, first.body.more, first.body.status.active], [200, { plus: TEST_SWITCH_OFF_BATCH, gifts: 0 }, 5, 5], label);
    if (db) assert.ok(db.statements - queries < 40, `${label}: ${db.statements - queries} queries, under the free plan's 50`);
    const second = await asJson(await api(post('admin/test-purchases/switch-off', { confirm: SWITCH_OFF_WORDS }, 'secret')));
    assert.deepEqual([second.body.added, second.body.more, second.body.status.active, second.body.status.switchedOff], [{ plus: 5, gifts: 0 }, 0, 0, count], label);
    assert.equal((await store.listRevocationsBySource(TEST_PURCHASES_SOURCE)).length, count * 2, label);
  });
});

test('without migration 0005 the counts wait for it: the summary has none, the actions say what is missing', async t => {
  const d1 = await openSqlite(t, MIGRATIONS.slice(0, 4));
  if (!d1) return;
  const { api } = setup({ store: createD1Store(d1) });
  const summary = await asJson(await api(get('admin/summary', 'secret')));
  assert.equal(summary.status, 200);
  assert.equal(summary.body.testPurchases, null);
  for (const request of [get('admin/test-purchases', 'secret'), post('admin/test-purchases/switch-off', { confirm: SWITCH_OFF_WORDS }, 'secret'), post('admin/test-purchases/restore', { confirm: RESTORE_WORD }, 'secret')]) {
    const answer = await asJson(await api(request));
    assert.equal(answer.status, 503);
    assert.match(answer.body.error, /A database table is missing/);
  }
});

// ---- Needs your attention and Setup ------------------------------------------------

const NOW = Date.parse('2026-10-30T12:00:00Z');
function calm({ payments = {}, testPurchases } = {}) {
  return {
    version: '1.34.0', generatedAt: new Date(NOW).toISOString(),
    setup: {
      email: { configured: true, ownerEmail: 'owner@example.com' },
      payments: { configured: true, mode: 'live', reviewMode: false, reviewOpen: false, webhookSecretSet: true, error: '', products: { plus: { EUR: 'p1', USD: 'p2' }, gift: { EUR: 'g1', USD: 'g2' } }, ...payments },
      plus: { configured: true, publicKey: 'pub' },
      twoFactor: true
    },
    refunds: [], revocations: [], teamRequests: [], gifts: [], reviews: [],
    ...(testPurchases === undefined ? {} : { testPurchases })
  };
}
const CONFIG = { SUPPORT_EMAIL: 'hello@example.com', LEGAL_ADDRESS: '1 rue de la Paix, Paris', PLUS_PUBLIC_KEY: 'pub', AFFILIATE_URL: 'https://affiliates.example.com/x' };
const build = summary => buildAttention(summary, { now: NOW, config: CONFIG, pageVersion: '1.34.0', number: String });
const counts = (fields = {}) => ({ plus: 3, gifts: 1, plusOff: 0, giftsOff: 0, active: 4, switchedOff: 0, pending: 4, latestAt: '2026-10-22T09:00:00.000Z', mode: 'live', reviewMode: false, reviewOpen: false, ...fields });

test('once payments are live, test-mode purchases still active are one line to act on', () => {
  const [item, ...rest] = build(calm({ testPurchases: counts() }));
  assert.equal(rest.length, 0);
  assert.deepEqual([item.text, item.detail, item.tone, item.section, item.rows, item.kind], ['4 test-mode purchases still active — switch them off', 'Bought in Creem’s test mode, never paid for: 3 Plus licences and 1 gift link still give Plus.', 'warn', 'refunds', ['test-purchases'], 'test-purchases']);
  assert.equal(build(calm({ testPurchases: counts({ plus: 1, gifts: 1, giftsOff: 1, active: 1 }) }))[0].text, '1 test-mode purchase still active — switch it off');
  assert.equal(build(calm({ testPurchases: counts({ plus: 1, gifts: 1, giftsOff: 1, active: 1 }) }))[0].detail, 'Bought in Creem’s test mode, never paid for: 1 Plus licence still gives Plus.');
  // Nothing while review mode is still on (or merely set), while in test mode, once all are off, or with an older API.
  assert.deepEqual(build(calm({ testPurchases: counts({ active: 0, plusOff: 3, giftsOff: 1 }) })), []);
  assert.deepEqual(build(calm({ testPurchases: null })), []);
  assert.deepEqual(build(calm()), []);
  const reviewing = build(calm({ payments: { mode: 'test', reviewMode: true, reviewOpen: true }, testPurchases: counts({ mode: 'test', reviewMode: true, reviewOpen: true }) }));
  assert.deepEqual(reviewing.map(entry => entry.text), ['Review mode is on: test purchases are open on the production address. Turn it off once your live key is in']);
  const leftOn = build(calm({ payments: { reviewMode: true }, testPurchases: counts({ reviewMode: true }) }));
  assert.deepEqual(leftOn.map(entry => entry.text), ['CREEM_TEST_ON_PRODUCTION has no effect with a live key: remove it']);
  // It comes after refunds to decide, before team requests.
  const busy = build({ ...calm({ testPurchases: counts() }), teamRequests: [{ id: 1, kind: 'quote', company: 'Acme', teamSize: 20, email: 'a@acme.example', createdAt: '2026-10-29T12:00:00.000Z' }] });
  assert.deepEqual(busy.map(entry => entry.kind), ['test-purchases', 'team']);
});

test('Setup: review mode reads as a warning, and test mode without it as before', () => {
  const states = summary => setupChecks(summary, { config: CONFIG, pageVersion: '1.34.0' }).find(check => check.key === 'payments');
  assert.deepEqual(states(calm({ payments: { mode: 'test', reviewMode: true, reviewOpen: true } })), { key: 'payments', state: 'warn', problems: ['Review mode is on: test purchases are open on the production address. Turn it off once your live key is in'] });
  assert.deepEqual(states(calm({ payments: { mode: 'test' } })).problems, ['Creem is in test mode: no real payments']);
  assert.deepEqual(states(calm()), { key: 'payments', state: 'ok', problems: [] });
});

// ---- The dashboard's panel and dialog (admin/test-purchases.js) ---------------------

test('the panel: counts, what the mode means, and the actions it allows', () => {
  assert.equal(readStatus(null), null);
  const status = readStatus(counts({ plusOff: 1, active: 3, mode: 'live' }));
  assert.deepEqual([status.total, status.off, status.active], [4, 1, 3]);
  assert.equal(readStatus({ plus: 2, plusOff: 9 }).plusOff, 2, 'never more off than bought');
  assert.equal(panelShown(readStatus({})), false, 'nothing bought, review mode off: no panel');
  assert.equal(panelShown(readStatus({ reviewOpen: true })), true, 'review mode open: shown, with nothing to switch off');

  const html = testPurchasesHtml(status, { number: String });
  assert.match(html, /data-owner-attn="test-purchases"/);
  assert.match(html, /<dt>Plus licences<\/dt><dd><b>3<\/b><small>1 off<\/small>/);
  assert.match(html, /<dt>Gift links<\/dt><dd><b>1<\/b><small>none off<\/small>/);
  assert.match(html, /is-active"><dt>Still active<\/dt><dd><b>3<\/b><small>give Plus/);
  assert.match(html, /data-owner-tests-switch>Switch off test-mode purchases…<\/button>/);
  assert.match(html, /<h3 id="owner-tests-title"><span>Test-mode purchases<\/span><\/h3>/);
  assert.doesNotMatch(html, /data-owner-tests-restore/, 'nothing to restore yet');
  assert.match(html, /Bought before payments went live/);

  const done = testPurchasesHtml(readStatus(counts({ plusOff: 3, giftsOff: 1, active: 0, switchedOff: 4 })), { number: String, result: { text: 'Switched off: <b>' } });
  assert.doesNotMatch(done, /data-owner-tests-switch/, 'no button that can’t be used');
  assert.match(done, /<p class="owner-tests__state"><svg[^>]*>.*<\/svg>All switched off<\/p>/);
  assert.match(done, /data-owner-tests-restore>Restore all…<\/button>/);
  assert.match(done, /Switched off: &lt;b&gt;/, 'escaped');
  const reviewing = testPurchasesHtml(readStatus(counts({ mode: 'test', reviewMode: true, reviewOpen: true })), { number: String });
  assert.match(reviewing, /Review mode on<\/span>/);
  assert.match(reviewing, /While Creem reviews your store, checkouts on the production address run in Creem’s test mode/);
  assert.match(testPurchasesHtml(readStatus({ reviewOpen: true, mode: 'test' }), { number: String }), /Nothing bought in test mode yet\./);
  assert.equal(testPurchasesHtml(readStatus({}), { number: String }), '');
});

test('the dialog asks for SWITCH OFF, give or take case and spaces; restore is one button', () => {
  for (const typed of ['SWITCH OFF', 'switch off', '  Switch   Off ']) assert.equal(confirmMatches(typed), true, typed);
  for (const typed of ['', 'SWITCHOFF', 'SWITCH OFF NOW', 'yes', null]) assert.equal(confirmMatches(typed), false, String(typed));
  const status = readStatus(counts({ plus: 3, gifts: 2, plusOff: 1, active: 4, mode: 'live' }));
  const html = dialogHtml('switch-off', status, { number: String });
  assert.match(html, /3 Plus licences and 2 gift links were bought in Creem’s test mode\. 1 is already off\./);
  assert.match(html, /2 Plus licences and 2 gift links stop giving Plus: gift links at once, planners at their next weekly check/);
  assert.match(html, /Type <b>SWITCH OFF<\/b> to confirm<\/span><input name="confirm"/);
  assert.match(html, /<button class="primary-button owner-danger" type="submit" disabled>Switch off 4<\/button>/, 'disabled until it is typed');
  assert.doesNotMatch(html, /Review mode is still on/);
  assert.match(dialogHtml('switch-off', readStatus(counts({ mode: 'test', reviewOpen: true })), { number: String }), /Review mode is still on/);
  const restore = dialogHtml('restore', status, { number: String });
  assert.match(restore, /Restore the test-mode purchases\?/);
  assert.match(restore, /<button class="primary-button" type="submit">Restore all<\/button>/);
  assert.doesNotMatch(restore, /name="confirm"/);
  assert.equal(purchaseWords(1, 0), '1 Plus licence');
  assert.equal(purchaseWords(0, 2), '2 gift links');
  assert.equal(purchaseWords(0, 0), '');
});

test('what the panel says once it is done', () => {
  const before = readStatus(counts({ plus: 3, gifts: 1, plusOff: 1, active: 3 }));
  assert.equal(doneText('switch-off', before, { more: 0, status: counts({ plus: 3, gifts: 1, plusOff: 3, giftsOff: 1, active: 0 }) }, { number: String }), 'Switched off: 2 Plus licences and 1 gift link. Gift links stopped now; planners lose Plus at their next weekly check.');
  assert.equal(doneText('switch-off', before, { more: 5, status: counts({ plus: 3, gifts: 1, plusOff: 2, active: 2 }) }, { number: String }), 'Switched off: 1 Plus licence. Gift links stopped now; planners lose Plus at their next weekly check. 5 more to go: switch off again.');
  assert.equal(doneText('switch-off', before, { status: counts({ plus: 3, gifts: 1, plusOff: 1, active: 3 }) }, { number: String }), 'Nothing left to switch off.');
  const off = readStatus(counts({ plusOff: 3, giftsOff: 1, active: 0 }));
  assert.equal(doneText('restore', off, { status: counts({ active: 4 }) }, { number: String }), 'Restored: 4 test-mode purchases give Plus again. Planners get it back at their next weekly check.');
  assert.match(doneText('restore', off, { status: counts({ plusOff: 3, giftsOff: 1, active: 0 }) }, { number: String }), /^Restored\. Nothing gives Plus again/);
});

test('the dashboard loads the panel, reloads it with its other files, and the Refunds card holds it', () => {
  const source = readFileSync(new URL('../admin/admin.js', import.meta.url), 'utf8');
  assert.match(source, /from '\.\/test-purchases\.js'/);
  assert.match(source, /DASHBOARD_FILES = \[[^\]]*'\.\/test-purchases\.js'/);
  assert.match(source, /sendJson\(`admin\/test-purchases\/\$\{kind\}`, 'POST', \{ confirm: kind === 'restore' \? RESTORE_WORD : SWITCH_OFF_WORDS \}\)/, 'the confirmation is sent to the server too');
  const page = readFileSync(new URL('../admin/index.html', import.meta.url), 'utf8');
  const card = page.slice(page.indexOf('id="owner-refunds-title"'), page.indexOf('id="owner-partners-title"'));
  assert.ok(card.includes('data-owner-tests') && card.indexOf('data-owner-revoke-form') < card.indexOf('data-owner-tests'), 'after Revoke Plus by hand, in the Refunds and disputes card');
  // The revocation by hand still asks before revoking.
  assert.match(source, /if \(!window\.confirm\(`Revoke /);
});

test('every place a checkout starts shows the line: the landing, the Teams page and the planner’s Plus window', () => {
  const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const sale = read('welcome/sale.js');
  assert.match(sale, /get testLine\(\) \{ return testModeLine\(options\); \}/);
  assert.match(sale, /export function testNotice\(sale, className = ''\)/);
  const landing = read('welcome/landing.js');
  assert.match(landing, /const notice = testNotice\(sale\);\n\s+if \(notice\) children\.push\(notice\);/, 'under each Get Plus');
  assert.match(landing, /sale\.state\('gift'\)\.buyable && !sale\.state\('plus'\)\.buyable \? testNotice\(sale, 'gifts__test'\)/, 'by the gifts when Get Plus is not there');
  assert.match(read('welcome/team-offer.js'), /state\.buyable \? testNotice\(sale, 'prices__test'\)/);
  assert.match(read('teams/index.html'), /<div class="prices__test-slot" data-test-slot><\/div>/);
  const dialog = read('src/features/plus-dialog.js');
  assert.match(dialog, /\$\{buyable\(\) === 'yes' \? testLine\(\) : ''\}/, 'under Get Plus');
  assert.match(dialog, /\$\{member \|\| buyable\(\) !== 'yes' \? testLine\('gifts'\) : ''\}/, 'by the gifts when Get Plus is not offered');
  assert.match(dialog, /test: result\.test === true, review: result\.review === true/);
});
