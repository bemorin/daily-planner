import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createMemoryStore, createPlannerApi } from '../server/planner-api.js';
import { createD1Store } from '../server/d1-store.js';
import { generatePlusKeyPair } from '../server/licenses.js';
import { checkoutSeal } from '../server/creem.js';
import { priceCents } from '../src/lib/pricing.js';
import { FUNNELS, funnelSteps, metricById, metricTrend, normalizeSeries, saleCurrencies, testSalesIn } from '../admin/trends.js';

// Purchases made in Creem's test mode (the Test mode note, or an order in test
// mode) are never sales (1.34.1): they stay out of every revenue and sales
// figure of the dashboard — the Plus and gift counts, Trends and its charts,
// the funnels — once payments are live, and are shown apart while testing.
// Partner figures already counted them apart (server/partners.js isTestMode).

const START = Date.parse('2026-10-23T08:00:00Z');
const KEYS = await generatePlusKeyPair();
const PRODUCTS = Object.freeze({ plus: { EUR: 'prod_plus_eur', USD: 'prod_plus_usd' }, gift: { EUR: 'prod_gift_eur', USD: 'prod_gift_usd' } });
const PRODUCTION = 'https://planner.test';
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const at = (method, path, body, token) => new Request(`${PRODUCTION}/api/${path}`, {
  method,
  headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) })
});
const get = (path, token) => at('GET', path, undefined, token);
const post = (path, body = {}, token) => at('POST', path, body, token);
const patch = (path, body, token) => at('PATCH', path, body, token);
const asJson = async response => ({ status: response.status, body: await response.json() });
const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A paid Creem checkout, sealed as POST /api/checkout seals it, in Creem's `mode`. */
async function checkout(id, { item = 'plus', plan = 'up-to-10', currency = 'EUR', mode = 'test' } = {}) {
  const rid = `dp_${id.slice(-16).padStart(16, '0')}`;
  const cents = priceCents(item, item === 'gift' ? plan : '', currency);
  const kindPlan = item === 'gift' ? { kind: 'gift', plan } : { kind: 'plus', plan: '' };
  const seal = await checkoutSeal(KEYS.signingKey, { ...kindPlan, currency, rid });
  return {
    id, object: 'checkout', mode, status: 'completed', units: 1, request_id: rid, product: PRODUCTS[item][currency],
    order: { id: `ord_${id}`, object: 'order', status: 'paid', type: 'onetime', amount: cents, amount_paid: cents, currency },
    customer: { id: 'cust_1', object: 'customer', email: 'buyer@example.com', country: 'FR' },
    custom_fields: item === 'gift' ? [{ type: 'text', key: 'company', label: 'Company name, shown to your team', optional: true, text: { max_length: 80, value: 'Acme' } }] : [],
    metadata: item === 'gift' ? { kind: 'gift', plan, seats: '10', currency, rid, seal } : { kind: 'plus', currency, rid, seal }
  };
}

const fakeCreem = checkouts => async url => {
  const id = new URL(url).searchParams.get('checkout_id');
  return Object.hasOwn(checkouts, id) ? jsonResponse(200, checkouts[id]) : jsonResponse(404, { message: ['Checkout not found'] });
};

/** The API on `store` with Creem's test key (review mode on the production address) or its live key. */
function apiFor(store, checkouts, { live = false, clock = { now: START } } = {}) {
  return createPlannerApi({
    store, adminToken: 'secret', now: () => new Date(clock.now), authFailureDelayMs: 0, publicBaseUrl: PRODUCTION,
    plusSigningKey: KEYS.signingKey, creemApiKey: live ? 'creem_live_sales' : 'creem_test_sales', creemTestOnProduction: live ? '' : '1', creemProducts: PRODUCTS, creemFetch: fakeCreem(checkouts),
    defer: () => {}, warn: () => {}
  });
}

async function openSqlite(t) {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { t.skip('node:sqlite is not available in this Node version'); return null; }
  const sqlite = new DatabaseSync(':memory:');
  for (const file of readdirSync(new URL('../migrations/', import.meta.url)).filter(name => name.endsWith('.sql')).sort()) sqlite.exec(read(`migrations/${file}`));
  return {
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

async function bothStores(t, body) {
  await body('memory', createMemoryStore());
  const d1 = await openSqlite(t);
  if (d1) await body('D1', createD1Store(d1));
}

const gift = (code, fields = {}) => ({ code, org: 'Acme', message: '', seats: 10, redeemed: 0, active: true, currency: 'EUR', amount: 19500, source: 'creem', checkoutRef: `ch_${code.toLowerCase()}`, buyerEmail: '', note: '', createdAt: '2026-10-20T08:00:00.000Z', expiresAt: '2027-10-20T08:00:00.000Z', emailedAt: null, ...fields });

test('the stores count test-mode gifts and Plus purchases apart, and list the test-mode checkouts alike (memory and D1)', async t => {
  await bothStores(t, async (label, store) => {
    await store.addGift(gift('AAAAAAAAAAAA', { note: 'Test mode · Creem · Up to 10 people', redeemed: 3 }));
    await store.addGift(gift('BBBBBBBBBBBB', { note: 'Creem · Up to 10 people', seats: 50, redeemed: 5 }));
    // Made in the dashboard, whose note happens to start the same way: an invoice, never a test purchase.
    await store.addGift(gift('CCCCCCCCCCCC', { source: 'manual', checkoutRef: null, note: 'Test mode of invoicing', seats: 5, redeemed: 1 }));
    await store.addPurchase({ checkoutRef: 'ch_testplus01', kind: 'plus', licenseId: 'aaaaaaaaaaaaaaaa', claims: 1, email: '', note: 'Test mode', createdAt: '2026-10-20T08:00:00.000Z' });
    await store.addPurchase({ checkoutRef: 'ch_liveplus01', kind: 'plus', licenseId: 'bbbbbbbbbbbbbbbb', claims: 1, email: '', note: '', createdAt: '2026-10-21T08:00:00.000Z' });
    await store.addPurchase({ checkoutRef: 'lic_manual01', kind: 'manual', licenseId: 'cccccccccccccccc', claims: 0, email: '', note: 'Test mode giveaway', createdAt: '2026-10-21T08:00:00.000Z' });
    // A gift bought in test mode whose note the owner edited: its order still says so.
    await store.addGift(gift('DDDDDDDDDDDD', { note: 'Renamed' }));
    await store.addOrder({ orderId: 'ord_d', checkoutId: 'ch_dddddddddddd', kind: 'gift', mode: 'test', createdAt: '2026-10-20T08:00:00.000Z' });
    await store.addOrder({ orderId: 'ord_live', checkoutId: 'ch_liveplus01', kind: 'plus', mode: 'live', createdAt: '2026-10-21T08:00:00.000Z' });

    assert.deepEqual(await store.giftTotals({ testNote: 'Test mode' }), { count: 3, seats: 65, redeemed: 6, paid: 2, test: { count: 1, seats: 10, redeemed: 3 } }, label);
    assert.deepEqual(await store.giftTotals(), { count: 4, seats: 75, redeemed: 9, paid: 3, test: { count: 0, seats: 0, redeemed: 0 } }, `${label}: without the note, as before`);
    assert.deepEqual(await store.purchaseTotals({ testNote: 'Test mode' }), { plus: 1, manual: 1, test: 1 }, label);
    assert.deepEqual(await store.purchaseTotals(), { plus: 2, manual: 1, test: 0 }, label);
    assert.deepEqual(await store.listTestCheckouts({ note: 'Test mode' }), ['ch_aaaaaaaaaaaa', 'ch_dddddddddddd', 'ch_testplus01'], label);
  });
});

test('once the key is live, test-mode purchases stay out of the Plus and gift counts, the sales and the revenue (memory and D1)', async t => {
  await bothStores(t, async (label, store) => {
    const checkouts = {
      ch_reviewplus001: await checkout('ch_reviewplus001'),
      ch_reviewgift001: await checkout('ch_reviewgift001', { item: 'gift' }),
      ch_liveplus00001: await checkout('ch_liveplus00001', { mode: 'live' }),
      ch_livegift00001: await checkout('ch_livegift00001', { item: 'gift', plan: 'up-to-50', mode: 'live' })
    };
    // While Creem reviews the store: bought with the test key.
    const testing = apiFor(store, checkouts);
    for (const id of ['ch_reviewplus001', 'ch_reviewgift001']) assert.equal((await testing(post('purchases/claim', { checkout: id }))).status, 200, `${label} ${id}`);
    // While testing, they are shown apart: never a sale, never revenue.
    const before = (await asJson(await testing(get('admin/series?from=2026-10-01&to=2026-10-31', 'secret')))).body;
    assert.deepEqual([before.sales.length, before.testSales.map(row => [row.kind, row.amount, row.test])], [0, [['gift', 19500, true], ['plus', 2900, true]]], label);
    // Live: the owner's live key is in, and real purchases come.
    const clock = { now: START + 86400000 };
    const live = apiFor(store, checkouts, { live: true, clock });
    for (const id of ['ch_liveplus00001', 'ch_livegift00001']) assert.equal((await live(post('purchases/claim', { checkout: id }))).status, 200, `${label} ${id}`);
    assert.equal((await live(post('admin/gifts', { org: 'Initech', seats: 20, currency: 'EUR', amount: 29000 }, 'secret'))).status, 201, label);

    const summary = (await asJson(await live(get('admin/summary', 'secret')))).body;
    assert.deepEqual(summary.plus.purchases, 1, `${label}: the live purchase only`);
    assert.deepEqual(summary.plus.testPurchases, 1, `${label}: the test one apart`);
    assert.deepEqual(summary.giftTotals, { count: 2, seats: 70, redeemed: 0, paid: 1, test: { count: 1, seats: 10, redeemed: 0 } }, label);
    assert.deepEqual(summary.gifts.map(row => [row.org, row.test]).sort(), [['Acme', false], ['Acme', true], ['Initech', false]], label);

    const series = (await asJson(await live(get('admin/series?from=2026-10-01&to=2026-10-31', 'secret')))).body;
    assert.deepEqual(series.sales.map(row => [row.day, row.kind, row.source, row.amount]), [['2026-10-24', 'gift', 'creem', 59500], ['2026-10-24', 'plus', 'creem', 2900], ['2026-10-24', 'gift', 'manual', 29000]], label);
    assert.deepEqual(series.testSales.map(row => [row.day, row.kind, row.amount]), [['2026-10-23', 'gift', 19500], ['2026-10-23', 'plus', 2900]], label);
    // A test gift whose note the owner edited stays apart: its order was in test mode.
    const code = summary.gifts.find(row => row.test).code;
    assert.equal((await live(patch(`admin/gifts/${code.replace(/-/g, '')}`, { note: 'Demo for Creem' }, 'secret'))).status, 200, label);
    const edited = (await asJson(await live(get('admin/series?from=2026-10-01&to=2026-10-31', 'secret')))).body;
    assert.deepEqual([edited.sales.length, edited.testSales.length], [3, 2], label);

    // The dashboard's Trends: revenue, gifts sold and the team gift funnel count the live sales only.
    const normalized = normalizeSeries(series);
    const week = { from: '2026-10-19', to: '2026-10-25' };
    assert.deepEqual(metricTrend(normalized, metricById('revenue'), 'week', '2026-10-24').current, { EUR: 59500 + 29000 + 2900 }, label);
    assert.equal(metricTrend(normalized, metricById('gifts-sold'), 'week', '2026-10-24').current, 2, label);
    assert.equal(funnelSteps(normalized, FUNNELS.find(funnel => funnel.id === 'team-gift'), week)[3].value, 1, `${label}: one team gift bought online, the live one`);
    assert.deepEqual(testSalesIn(normalized, week), { count: 2, revenue: { EUR: 19500 + 2900 } }, `${label}: said apart`);
    assert.deepEqual(testSalesIn(normalized, week, { kind: 'gift' }), { count: 1, revenue: { EUR: 19500 } }, label);
  });
});

test('the series keeps test-mode sales apart even from an API that flags them among the sales', () => {
  const series = normalizeSeries({
    from: '2026-10-01', to: '2026-10-24', events: {},
    sales: [{ day: '2026-10-23', kind: 'plus', source: 'creem', amount: 2900, currency: 'USD', test: true }, { day: '2026-10-24', kind: 'gift', source: 'creem', amount: 19500, currency: 'EUR' }, { day: 'bad' }],
    testSales: [{ day: '2026-10-22', kind: 'gift', source: 'creem', amount: 59500, currency: 'EUR' }, null]
  });
  assert.deepEqual(series.sales, [{ day: '2026-10-24', kind: 'gift', source: 'creem', amount: 19500, currency: 'EUR' }]);
  assert.deepEqual(series.testSales.map(row => [row.day, row.amount, row.test]), [['2026-10-22', 59500, true], ['2026-10-23', 2900, true]]);
  assert.deepEqual(saleCurrencies(series.sales), ['EUR'], 'a currency seen only in test mode adds no revenue column');
  assert.deepEqual(testSalesIn(series, { from: '2026-10-23', to: '2026-10-24' }), { count: 1, revenue: { USD: 2900 } });
  assert.deepEqual(testSalesIn({ from: '2026-10-01', to: '2026-10-24', events: {}, sales: [] }, { from: '2026-10-01', to: '2026-10-24' }), { count: 0, revenue: {} }, 'an older answer, without testSales');
});

test('the dashboard says what it left out: Trends tiles and charts, the Plus card, the gifts', () => {
  const view = read('admin/trends-view.js');
  assert.match(view, /return `\$\{number\(found\.count\)\} test-mode \$\{found\.count === 1 \? 'sale' : 'sales'\}\$\{amounts \? ` \(\$\{amounts\}\)` : ''\} not counted`;/);
  assert.match(view, /const testText = testSalesText\(metric, trend\.ranges\.current\);/, 'each sales tile, for the period so far');
  assert.match(view, /const testText = testSalesText\(metric, \{ from: shown\.from, to: series\.to \}\);/, 'the chart, for the periods it shows');
  assert.match(view, /Purchases made in Creem’s test mode are left out\./);
  const admin = read('admin/admin.js');
  assert.match(admin, /\['Individual purchases', value\(plus\.purchases\), testPlus \? `Bought online · \$\{number\(testPlus\)\} in test mode, not counted` : 'Bought online'\]/);
  assert.match(admin, /\$\{number\(tests\)\} bought in test mode, not counted/);
  assert.match(admin, /const test = row\.test \? ' <span class="owner-pill">Test mode<\/span>' : '';/);
});
