import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMemoryStore, createPlannerApi } from '../server/planner-api.js';
import { createD1Store } from '../server/d1-store.js';
import { generatePlusKeyPair, giftRef, signLicense } from '../server/licenses.js';
import { checkoutSeal, checkoutSealValid, memberFlag, parseCreemProducts, readCheckout, webhookSignature } from '../server/creem.js';
import { isTestMode, normalizePartnerSale, PARTNER_RECENT, PARTNER_SALES_LISTED, partialRefunds, partnerSaleRow, partnerSummary, saleStates } from '../server/partners.js';
import { giftPlan, hasMemberPrice, LAUNCH, MEMBER_GIFT_DISCOUNT, MEMBER_PRICE_FLOOR, memberGiftPrice, PERSONAL_GIFTS, PLUS_PRICE, priceCents, TEAM_TIERS } from '../src/lib/pricing.js';

const START = Date.parse('2026-10-20T08:00:00Z');
const KEYS = await generatePlusKeyPair();
const OTHER_KEYS = await generatePlusKeyPair();
const PRODUCTS = Object.freeze({ plus: { EUR: 'prod_plus_eur', USD: 'prod_plus_usd' }, gift: { EUR: 'prod_gift_eur', USD: 'prod_gift_usd' } });
const WEBHOOK_SECRET = 'whsec_test_partners';
const ALL_MIGRATIONS = ['0001_planner_api.sql', '0002_team_requests.sql', '0003_plus.sql', '0004_creem_reviews.sql', '0005_refunds.sql', '0006_partners.sql'];

const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const request = (method, path, body, token) => new Request(`https://planner.test/api/${path}`, {
  method,
  headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}), 'cf-ipcountry': 'FR' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) })
});
const get = (path, token) => request('GET', path, undefined, token);
const post = (path, body = {}, token) => request('POST', path, body, token);
const asJson = async response => ({ status: response.status, body: await response.json() });

/**
 * Stand-in for Creem: POST /v1/checkouts records what the API opens and keeps
 * it as a pending checkout; `pay(id)` completes it, as paying does; GET reads it
 * back with what it was opened with (metadata, custom_price), as Creem does.
 */
function fakeCreem({ refuseCode = '', mode = 'test', prefix = 'partner' } = {}) {
  const calls = [];
  const checkouts = new Map();
  const transactions = new Map();
  let count = 0;
  const fetch = async (url, init = {}) => {
    const target = new URL(url);
    if (target.pathname === '/v1/transactions') {
      const found = transactions.get(target.searchParams.get('transaction_id'));
      return found ? jsonResponse(200, found) : jsonResponse(404, { message: ['Transaction not found'] });
    }
    if (init.method === 'POST') {
      const body = JSON.parse(init.body);
      calls.push(body);
      if (refuseCode && body.affiliate_code === refuseCode) return jsonResponse(400, { statusCode: 400, message: ['Affiliate code not found'] });
      count += 1;
      const id = `ch_${prefix}${String(count).padStart(4, '0')}`;
      const [kind, currency] = body.product_id === PRODUCTS.plus.EUR ? ['plus', 'EUR'] : body.product_id === PRODUCTS.plus.USD ? ['plus', 'USD'] : body.product_id === PRODUCTS.gift.EUR ? ['gift', 'EUR'] : ['gift', 'USD'];
      const amount = body.custom_price ?? priceCents(kind, body.metadata?.plan, currency);
      checkouts.set(id, { id, object: 'checkout', mode, status: 'pending', units: 1, request_id: body.request_id, product: body.product_id, metadata: body.metadata, amount, currency });
      return jsonResponse(200, { id, object: 'checkout', status: 'pending', checkout_url: `https://checkout.creem.io/${id}` });
    }
    const found = checkouts.get(target.searchParams.get('checkout_id'));
    if (!found) return jsonResponse(404, { message: ['Checkout not found'] });
    const { amount, currency, ...entity } = found;
    return jsonResponse(200, {
      ...entity,
      ...(found.status === 'completed' ? { order: { id: `ord_${found.id}`, object: 'order', status: 'paid', type: 'onetime', amount, amount_paid: amount, currency } } : {}),
      customer: { id: 'cust_1', object: 'customer', email: 'buyer@example.com', country: 'FR' },
      custom_fields: []
    });
  };
  const pay = id => { checkouts.get(id).status = 'completed'; };
  const paid = async id => (await fetch(`https://test-api.creem.io/v1/checkouts?checkout_id=${id}`, { method: 'GET' })).json();
  return { fetch, calls, checkouts, transactions, pay, paid };
}

function setup({ store = createMemoryStore(), creem = fakeCreem(), ...options } = {}) {
  const warnings = [];
  const api = createPlannerApi({
    store, adminToken: 'secret', now: () => new Date(START), authFailureDelayMs: 0,
    plusSigningKey: KEYS.signingKey, creemApiKey: 'creem_test_abc', creemWebhookSecret: WEBHOOK_SECRET, creemProducts: PRODUCTS, creemFetch: creem.fetch,
    warn: message => warnings.push(message),
    ...options
  });
  return { api, store, creem, warnings };
}

async function openSqlite(t, migrations = ALL_MIGRATIONS) {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { t.skip('node:sqlite is not available in this Node version'); return null; }
  const sqlite = new DatabaseSync(':memory:');
  for (const migration of migrations) sqlite.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
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

async function sendWebhook(api, event) {
  const raw = JSON.stringify(event);
  return api(new Request('https://planner.test/api/creem/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'creem-signature': await webhookSignature(raw, WEBHOOK_SECRET) }, body: raw }));
}

/** Opens a checkout through the API, then pays it in the pretend Creem. Returns { id, sent, answer }. */
async function buy(api, creem, body) {
  const answer = await asJson(await api(post('checkout', body)));
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  const sent = creem.calls.at(-1);
  const id = answer.body.url.split('/').at(-1);
  creem.pay(id);
  return { id, sent, answer };
}

// ---- Prices ------------------------------------------------------------------

test('the launch price is on, with a badge, one line and what comes after it', () => {
  assert.equal(LAUNCH.active, true);
  assert.equal(LAUNCH.label, 'Launch price');
  assert.match(LAUNCH.line, /^Pay once during the launch and Plus is yours for life\. After the launch, Plus becomes a yearly subscription for new members\.$/);
  assert.ok(LAUNCH.line.endsWith(LAUNCH.after));
  assert.doesNotMatch(`${LAUNCH.line} ${LAUNCH.label}`, /\d{4}|days? left|hurry|only|!/i, 'no dates, no countdown, no hype');
});

test('members pay €5 less for Give Plus and €20 less for Plus Family, in both currencies; team packs never change', () => {
  assert.deepEqual(MEMBER_GIFT_DISCOUNT, { 'gift-1': { EUR: 5, USD: 5 }, 'family-5': { EUR: 20, USD: 20 } });
  for (const currency of ['EUR', 'USD']) {
    assert.equal(memberGiftPrice('gift-1', currency), 24);
    assert.equal(memberGiftPrice('family-5', currency), 79);
    assert.equal(priceCents('gift', 'gift-1', currency, { member: true }), 2400);
    assert.equal(priceCents('gift', 'family-5', currency, { member: true }), 7900);
    assert.equal(priceCents('gift', 'gift-1', currency), 2900, 'not a member: the usual price');
    assert.equal(priceCents('gift', 'family-5', currency, { member: false }), 9900);
    assert.equal(priceCents('plus', '', currency, { member: true }), PLUS_PRICE[currency] * 100, 'Plus itself has no member price');
    for (const tier of TEAM_TIERS) {
      assert.equal(hasMemberPrice(tier.plan, currency), false, tier.plan);
      assert.equal(memberGiftPrice(tier.plan, currency), null, tier.plan);
      assert.equal(priceCents('gift', tier.plan, currency, { member: true }), tier.price[currency] * 100, tier.plan);
    }
  }
  assert.equal(memberGiftPrice('gift-1', 'GBP'), null);
  assert.equal(priceCents('gift', 'gift-1', 'GBP', { member: true }), 0);
  assert.equal(memberGiftPrice('nope', 'EUR'), null);
});

test('member prices stay above their floor: whole, positive, below the usual price, never under half of it', () => {
  for (const gift of PERSONAL_GIFTS) {
    for (const currency of ['EUR', 'USD']) {
      const price = gift.price[currency];
      const member = memberGiftPrice(gift.plan, currency);
      assert.ok(Number.isInteger(member) && member > 0, `${gift.plan} ${currency}`);
      assert.ok(member < price, `${gift.plan} ${currency}: cheaper than ${price}`);
      assert.ok(member >= Math.ceil(price * MEMBER_PRICE_FLOOR), `${gift.plan} ${currency}: not under the floor`);
    }
  }
  // Give Plus at the member price still costs more than a seat of the smallest team pack.
  const smallest = TEAM_TIERS[0];
  assert.ok(memberGiftPrice('gift-1', 'EUR') > smallest.price.EUR / smallest.seats);
  // A discount too large for the price stops at the floor; one larger than the price never makes it free.
  assert.equal(giftPlan('family-5').price.EUR - MEMBER_GIFT_DISCOUNT['family-5'].EUR, memberGiftPrice('family-5', 'EUR'), 'the floor is not reached today');
});

// ---- Pure helpers ---------------------------------------------------------------

test('a partner sale keeps the code, what was bought, the amount, the member price and the mode — nothing about the buyer', () => {
  const paid = { ref: 'CAMILLE', item: { kind: 'gift', plan: 'gift-1', seats: 1 }, amount: 2400, currency: 'EUR', member: true, mode: 'test', email: 'buyer@example.com', country: 'FR', sealed: true };
  const row = partnerSaleRow('ch_1', paid, '2026-10-20T08:00:00.000Z');
  assert.deepEqual(row, { checkoutId: 'ch_1', code: 'CAMILLE', kind: 'gift', plan: 'gift-1', amount: 2400, currency: 'EUR', member: true, mode: 'test', createdAt: '2026-10-20T08:00:00.000Z' });
  assert.ok(!JSON.stringify(row).includes('buyer@example.com') && !JSON.stringify(row).includes('FR'));
  assert.equal(partnerSaleRow('ch_1', { ...paid, ref: '' }, 'x'), null, 'no partner: nothing to keep');
  assert.equal(partnerSaleRow('ch_1', { ...paid, item: null }, 'x'), null);
  // Not opened by our API (no valid seal): the code is only someone's metadata.
  assert.equal(partnerSaleRow('ch_1', { ...paid, sealed: false }, 'x'), null);
  const { sealed: _sealed, ...unsealed } = paid;
  assert.equal(partnerSaleRow('ch_1', unsealed, 'x'), null);
  // The member price belongs to gifts: never on Plus.
  assert.equal(partnerSaleRow('ch_1', { ...paid, item: { kind: 'plus', plan: '', seats: 1 } }, 'x').member, false);
  assert.deepEqual(normalizePartnerSale({ checkoutId: 'ch_1', code: 'A', kind: 'plus', plan: null, amount: '2900', currency: 'EUR', member: 0, mode: null, createdAt: 'x' }), { checkoutId: 'ch_1', code: 'A', kind: 'plus', plan: '', amount: 2900, currency: 'EUR', member: false, mode: '', createdAt: 'x' });
});

test('the Partners card: by code, most sales first, revenue per currency after refunds, the latest sales with their state', () => {
  const rows = [
    { checkoutId: 'ch_a', code: 'CAMILLE', kind: 'plus', plan: '', amount: 2900, currency: 'EUR', member: false, createdAt: '2026-10-01T10:00:00Z' },
    { checkoutId: 'ch_b', code: 'CAMILLE', kind: 'gift', plan: 'gift-1', amount: 2400, currency: 'EUR', member: true, createdAt: '2026-10-05T10:00:00Z' },
    { checkoutId: 'ch_c', code: 'CAMILLE', kind: 'gift', plan: 'family-5', amount: 9900, currency: 'USD', member: false, createdAt: '2026-10-03T10:00:00Z' },
    { checkoutId: 'ch_d', code: 'CAMILLE', kind: 'plus', plan: '', amount: 2900, currency: 'EUR', member: false, createdAt: '2026-10-04T10:00:00Z' },
    { checkoutId: 'ch_e', code: 'NEWSLETTER', kind: 'gift', plan: 'up-to-10', amount: 19500, currency: 'EUR', member: false, createdAt: '2026-10-06T10:00:00Z' },
    { checkoutId: 'ch_f', code: 'NEWSLETTER', kind: 'plus', plan: '', amount: 2900, currency: 'USD', member: false, createdAt: '2026-10-02T10:00:00Z' }
  ];
  const states = saleStates([{ checkoutId: 'ch_d', reason: 'refund' }, { checkoutId: 'ch_d', reason: 'owner' }, { checkoutId: 'ch_f', reason: 'owner' }, { checkoutId: 'ch_x', reason: 'dispute' }]);
  assert.deepEqual([...states], [['ch_d', 'refunded'], ['ch_f', 'revoked'], ['ch_x', 'refunded']], 'a refund or a dispute wins over a revocation by hand');
  const summary = partnerSummary(rows, states);
  assert.deepEqual(summary.codes, [
    { code: 'CAMILLE', sales: 4, refunded: 1, partial: 0, revoked: 0, members: 1, revenue: { EUR: 5300, USD: 9900 }, test: 0, lastAt: '2026-10-05T10:00:00Z' },
    { code: 'NEWSLETTER', sales: 2, refunded: 0, partial: 0, revoked: 1, members: 0, revenue: { EUR: 19500 }, test: 0, lastAt: '2026-10-06T10:00:00Z' }
  ]);
  assert.deepEqual(summary.totals, { sales: 6, partners: 2, refunded: 2, partial: 0, revenue: { EUR: 24800, USD: 9900 }, test: { sales: 0, revenue: {} }, listed: 6, capped: false });
  assert.deepEqual(summary.recent.map(sale => [sale.checkoutId, sale.state]), [['ch_e', ''], ['ch_b', ''], ['ch_d', 'refunded'], ['ch_c', ''], ['ch_f', 'revoked'], ['ch_a', '']]);
  // The states can be given as the rows the store answers, too.
  assert.deepEqual(partnerSummary(rows, [{ checkoutId: 'ch_d', reason: 'dispute' }]).totals.refunded, 1);
  const many = Array.from({ length: PARTNER_RECENT + 5 }, (_, index) => ({ checkoutId: `ch_${index}`, code: 'X', kind: 'plus', amount: 2900, currency: 'EUR', createdAt: `2026-10-${String(1 + (index % 28)).padStart(2, '0')}T00:00:00Z` }));
  assert.equal(partnerSummary(many).recent.length, PARTNER_RECENT);
  assert.deepEqual(partnerSummary([]), { codes: [], recent: [], totals: { sales: 0, partners: 0, refunded: 0, partial: 0, revenue: {}, test: { sales: 0, revenue: {} }, listed: 0, capped: false } });
});

test('the Partners card counts test-mode sales apart, takes partial refunds off by their amount and says when it shows only the latest sales', () => {
  assert.deepEqual(['test', 'sandbox', 'TEST', 'prod', 'live', '', null].map(isTestMode), [true, true, true, false, false, false, false]);
  const rows = [
    { checkoutId: 'ch_live1', code: 'CAMILLE', kind: 'plus', amount: 2900, currency: 'EUR', mode: 'prod', createdAt: '2026-10-01T10:00:00Z' },
    { checkoutId: 'ch_live2', code: 'CAMILLE', kind: 'gift', plan: 'family-5', amount: 7900, currency: 'EUR', member: true, mode: 'prod', createdAt: '2026-10-02T10:00:00Z' },
    { checkoutId: 'ch_live3', code: 'CAMILLE', kind: 'plus', amount: 2900, currency: 'USD', mode: '', createdAt: '2026-10-03T10:00:00Z' },
    { checkoutId: 'ch_test1', code: 'CAMILLE', kind: 'plus', amount: 2900, currency: 'EUR', mode: 'test', createdAt: '2026-10-04T10:00:00Z' },
    { checkoutId: 'ch_test2', code: 'TRYOUT', kind: 'gift', plan: 'gift-1', amount: 2400, currency: 'EUR', member: true, mode: 'test', createdAt: '2026-10-05T10:00:00Z' }
  ];
  const refunds = [
    { checkoutId: 'ch_live2', amount: 2000, currency: 'EUR', fullRefund: false },
    { checkoutId: 'ch_live2', amount: 900, currency: 'EUR', fullRefund: 0 },
    // A partial refund whose amount isn't known: marked, the sale counted in full.
    { checkoutId: 'ch_live3', amount: null, currency: 'USD', fullRefund: false },
    // A full refund switches the sale off instead (saleStates); taking it off again would count it twice.
    { checkoutId: 'ch_live1', amount: 2900, currency: 'EUR', fullRefund: true },
    { checkoutId: 'ch_test1', amount: 500, currency: 'EUR', fullRefund: false }
  ];
  const taken = partialRefunds(refunds, rows.map(normalizePartnerSale));
  assert.deepEqual([...taken], [['ch_live2', { amount: 2900, unknown: 0 }], ['ch_live3', { amount: 0, unknown: 1 }], ['ch_test1', { amount: 500, unknown: 0 }]]);
  const summary = partnerSummary(rows, [{ checkoutId: 'ch_live1', reason: 'refund' }], refunds);
  assert.deepEqual(summary.totals, { sales: 3, partners: 1, refunded: 1, partial: 2, revenue: { EUR: 5000, USD: 2900 }, test: { sales: 2, revenue: { EUR: 4800 } }, listed: 5, capped: false });
  assert.deepEqual(summary.codes, [
    { code: 'CAMILLE', sales: 3, refunded: 1, partial: 2, revoked: 0, members: 1, revenue: { EUR: 5000, USD: 2900 }, test: 1, lastAt: '2026-10-04T10:00:00Z' },
    { code: 'TRYOUT', sales: 0, refunded: 0, partial: 0, revoked: 0, members: 0, revenue: {}, test: 1, lastAt: '2026-10-05T10:00:00Z' }
  ]);
  assert.deepEqual(summary.recent.map(sale => [sale.checkoutId, sale.test, sale.state, sale.partial, sale.refundedAmount, sale.refundUnknown]), [
    ['ch_test2', true, '', false, 0, false],
    ['ch_test1', true, '', true, 500, false],
    ['ch_live3', false, '', true, 0, true],
    ['ch_live2', false, '', true, 2900, false],
    ['ch_live1', false, 'refunded', false, 0, false]
  ]);
  // A partial refund never takes off more than the sale brought in.
  assert.deepEqual(partnerSummary([rows[0]], [], [{ checkoutId: 'ch_live1', amount: 9999, currency: 'EUR', fullRefund: false }]).totals.revenue, {});
  // Refunds in another currency than the sale can't be taken off: marked as unknown.
  assert.deepEqual([...partialRefunds([{ checkoutId: 'ch_live1', amount: 500, currency: 'USD', fullRefund: false }], [normalizePartnerSale(rows[0])])], [['ch_live1', { amount: 0, unknown: 1 }]]);
  // The store gave as many sales as it was asked for: there may be older ones.
  assert.equal(partnerSummary(rows, [], [], { limit: 5 }).totals.capped, true);
  assert.equal(partnerSummary(rows, [], [], { limit: 6 }).totals.capped, false);
  assert.equal(PARTNER_SALES_LISTED, 2000);
});

test('the dashboard’s Partners card says what it leaves out: test-mode sales, partial refunds, older sales past the cap', async () => {
  const admin = readFileSync(new URL('../admin/admin.js', import.meta.url), 'utf8');
  assert.match(admin, /in test mode\$\{.*?\$\{Number\(test\.sales\) === 1 \? 'is' : 'are'\} not counted\./);
  assert.match(admin, /The figures cover the latest \$\{number\(totals\.listed\)\} sales\./);
  assert.match(admin, /const latest = totals\.capped \? `Latest \$\{number\(totals\.listed\)\} sales · ` : '';/);
  assert.match(admin, /row\.test \? ' <span class="owner-pill">Test · not counted<\/span>'/);
  assert.match(admin, /−\$\{money\(row\.refundedAmount, row\.currency\)\} refunded/);
});

// ---- The member price at checkout ------------------------------------------------

test('a Plus member’s gift is opened at the member price, sealed as such; the licence itself never reaches Creem', async () => {
  const { api, creem } = setup();
  const license = await signLicense(KEYS.signingKey, { src: 'purchase' });
  for (const [plan, cents] of [['gift-1', 2400], ['family-5', 7900]]) {
    const answer = await asJson(await api(post('checkout', { item: 'gift', plan, currency: 'EUR', license })));
    assert.equal(answer.status, 201);
    assert.equal(answer.body.member, true);
    const sent = creem.calls.at(-1);
    assert.equal(sent.custom_price, cents, plan);
    assert.equal(sent.metadata.member, '1', plan);
    assert.equal(sent.metadata.seal, await checkoutSeal(KEYS.signingKey, { kind: 'gift', plan, currency: 'EUR', rid: sent.request_id, member: true }), 'the member price is sealed');
    assert.notEqual(sent.metadata.seal, await checkoutSeal(KEYS.signingKey, { kind: 'gift', plan, currency: 'EUR', rid: sent.request_id }));
    assert.ok(!JSON.stringify(sent).includes(license.split('.')[1]), 'no licence sent to Creem');
  }
  // A licence from a gift and one made in the dashboard count too.
  for (const src of ['gift', 'manual', 'dev']) {
    const other = await signLicense(KEYS.signingKey, { src, ...(src === 'gift' ? { gift: 'a1b2c3d4e5f60718' } : {}) });
    await api(post('checkout', { item: 'gift', plan: 'gift-1', currency: 'EUR', license: other }));
    assert.equal(creem.calls.at(-1).custom_price, 2400, src);
  }
});

test('no licence, a forged, malformed or revoked one, Plus itself or a team pack: the usual price', async () => {
  const { api, creem, store } = setup();
  const normal = async (body, label) => {
    const answer = await asJson(await api(post('checkout', body)));
    assert.equal(answer.status, 201, label);
    assert.equal('member' in answer.body, false, label);
    const sent = creem.calls.at(-1);
    assert.equal('member' in sent.metadata, false, label);
    return sent;
  };
  const forged = await signLicense(OTHER_KEYS.signingKey, { src: 'purchase' });
  const valid = await signLicense(KEYS.signingKey, { src: 'purchase' });
  for (const license of ['', forged, `${valid.slice(0, -4)}AAAA`, 'DP1.x.y', 'x'.repeat(5000), 42, null, { token: valid }]) {
    assert.equal((await normal({ item: 'gift', plan: 'gift-1', currency: 'EUR', license }, String(license).slice(0, 20))).custom_price, 2900);
  }
  // Plus has no member price; team packs neither.
  assert.equal('custom_price' in await normal({ item: 'plus', currency: 'EUR', license: valid }, 'plus'), false);
  assert.equal((await normal({ item: 'gift', plan: 'up-to-10', currency: 'EUR', license: valid }, 'team')).custom_price, 19500);
  // Refunded (revoked by id) or from a refunded gift (revoked by gift ref): the usual price.
  const revoked = await signLicense(KEYS.signingKey, { src: 'purchase', id: '0123456789abcdef' });
  await store.addRevocations([{ target: 'license:0123456789abcdef', source: 'ref_1', kind: 'license', label: '0123456789abcdef', reason: 'refund', createdAt: new Date(START).toISOString() }]);
  assert.equal((await normal({ item: 'gift', plan: 'family-5', currency: 'EUR', license: revoked }, 'revoked')).custom_price, 9900);
  const ref = await giftRef(KEYS.signingKey, 'ABCDEFGHJKMN');
  const fromGift = await signLicense(KEYS.signingKey, { src: 'gift', gift: ref });
  await store.addRevocations([{ target: `gift:${ref}`, source: 'ref_2', kind: 'gift', label: 'ABCD-EFGH-JKMN', reason: 'dispute', createdAt: new Date(START).toISOString() }]);
  assert.equal((await normal({ item: 'gift', plan: 'gift-1', currency: 'EUR', license: fromGift }, 'gift refunded')).custom_price, 2900);
});

test('a member flag added to, or taken off, a sealed gift checkout is never honoured', async () => {
  const products = parseCreemProducts(PRODUCTS).byId;
  const rid = 'dp_0123456789abcdef';
  const entity = metadata => ({ id: 'ch_tamper0001', status: 'completed', request_id: rid, product: PRODUCTS.gift.EUR, order: { id: 'ord_1', status: 'paid', amount_paid: 2400, currency: 'EUR' }, metadata });
  const plain = { kind: 'gift', plan: 'gift-1', seats: '1', currency: 'EUR', rid, seal: await checkoutSeal(KEYS.signingKey, { kind: 'gift', plan: 'gift-1', currency: 'EUR', rid }) };
  const member = { ...plain, member: '1', seal: await checkoutSeal(KEYS.signingKey, { kind: 'gift', plan: 'gift-1', currency: 'EUR', rid, member: true }) };
  assert.equal(await checkoutSealValid(KEYS.signingKey, readCheckout(entity(plain), products)), true);
  assert.equal(await checkoutSealValid(KEYS.signingKey, readCheckout(entity(member), products)), true);
  assert.equal(await checkoutSealValid(KEYS.signingKey, readCheckout(entity({ ...plain, member: '1' }), products)), false, 'flag added');
  const { member: _flag, ...withoutFlag } = member;
  assert.equal(await checkoutSealValid(KEYS.signingKey, readCheckout(entity(withoutFlag), products)), false, 'flag taken off');
  assert.equal(readCheckout(entity(member), products).member, true);
  assert.equal(readCheckout(entity({ ...plain, member: 'yes' }), products).member, false);
  // Creem may give the flag back typed differently: 1, true and 'true' read like '1', and the seal still holds.
  assert.deepEqual(['1', 1, true, 'true', ' TRUE ', 'yes', 0, '0', '', null, undefined, {}].map(memberFlag), [true, true, true, true, true, false, false, false, false, false, false, false]);
  for (const flag of [1, 'true', true]) assert.equal(await checkoutSealValid(KEYS.signingKey, readCheckout(entity({ ...member, member: flag }), products)), true, String(flag));
  // A partner code is sealed too: added, changed or taken off, the seal fails.
  const partner = { ...plain, ref: 'CAMILLE', seal: await checkoutSeal(KEYS.signingKey, { kind: 'gift', plan: 'gift-1', currency: 'EUR', rid, ref: 'CAMILLE' }) };
  assert.equal(await checkoutSealValid(KEYS.signingKey, readCheckout(entity(partner), products)), true);
  assert.equal(await checkoutSealValid(KEYS.signingKey, readCheckout(entity({ ...partner, ref: 'MALLORY' }), products)), false, 'code changed');
  assert.equal(await checkoutSealValid(KEYS.signingKey, readCheckout(entity({ ...plain, ref: 'MALLORY' }), products)), false, 'code added');
  const { ref: _ref, ...noCode } = partner;
  assert.equal(await checkoutSealValid(KEYS.signingKey, readCheckout(entity(noCode), products)), false, 'code taken off');
});

test('a paid member gift is delivered when Creem gives the member flag back as 1 or "true"', async () => {
  for (const flag of [1, 'true']) {
    const { api, creem, store } = setup();
    const license = await signLicense(KEYS.signingKey, { src: 'purchase' });
    const { id } = await buy(api, creem, { item: 'gift', plan: 'gift-1', currency: 'EUR', license, ref: 'CAMILLE' });
    creem.checkouts.get(id).metadata = { ...creem.checkouts.get(id).metadata, member: flag };
    const answer = await asJson(await api(post('purchases/claim', { checkout: id, expect: 'gift' })));
    assert.equal(answer.status, 200, `${typeof flag} ${flag}: ${JSON.stringify(answer.body)}`);
    assert.equal(answer.body.seats, 1);
    const [row] = await store.listPartnerSales();
    assert.deepEqual([row.code, row.member, row.amount], ['CAMILLE', true, 2400], String(flag));
  }
});

test('a product link opened by hand with a partner code and the member flag in its metadata is never a partner sale', async t => {
  await bothStores(t, async (label, store) => {
    const { api, creem } = setup({ store });
    // Plus has no seal requirement to be delivered (it was paid in full), but its code and flag count for nothing.
    creem.checkouts.set('ch_byhand0001', { id: 'ch_byhand0001', object: 'checkout', mode: 'prod', status: 'completed', request_id: '', product: PRODUCTS.plus.EUR, metadata: { kind: 'plus', ref: 'ANYCODE', member: '1' }, amount: 2900, currency: 'EUR' });
    assert.equal((await api(post('purchases/claim', { checkout: 'ch_byhand0001' }))).status, 200, label);
    // The same by webhook, with a seal copied from another checkout of ours.
    const ours = await buy(api, creem, { item: 'plus', currency: 'EUR' });
    const copied = { ...creem.checkouts.get(ours.id).metadata, ref: 'ANYCODE' };
    creem.checkouts.set('ch_byhand0002', { id: 'ch_byhand0002', object: 'checkout', mode: 'prod', status: 'completed', request_id: '', product: PRODUCTS.plus.EUR, metadata: copied, amount: 2900, currency: 'EUR' });
    const event = { id: 'evt_byhand0002', eventType: 'checkout.completed', created_at: START, object: await creem.paid('ch_byhand0002') };
    assert.equal((await sendWebhook(api, event)).status, 200, label);
    // A gift link opened by hand is not delivered at all (no seal), and not listed either.
    creem.checkouts.set('ch_byhand0003', { id: 'ch_byhand0003', object: 'checkout', mode: 'prod', status: 'completed', request_id: '', product: PRODUCTS.gift.EUR, metadata: { kind: 'gift', plan: 'gift-1', ref: 'ANYCODE', member: '1' }, amount: 2400, currency: 'EUR' });
    assert.equal((await api(post('purchases/claim', { checkout: 'ch_byhand0003', expect: 'gift' }))).status, 404, label);
    assert.deepEqual(await store.listPartnerSales(), [], label);
  });
});

// ---- Partner sales -----------------------------------------------------------------

test('a paid sale through a partner’s link is recorded once, by claim or webhook, and listed in the dashboard (memory and D1)', async t => {
  await bothStores(t, async (label, store) => {
    const { api, creem } = setup({ store, creem: fakeCreem({ mode: 'prod' }) });
    const license = await signLicense(KEYS.signingKey, { src: 'purchase' });
    // A member's Give Plus through CAMILLE's link, delivered by the gift page's claim.
    const gift = await buy(api, creem, { item: 'gift', plan: 'gift-1', currency: 'EUR', license, ref: 'CAMILLE' });
    assert.equal(gift.sent.metadata.ref, 'CAMILLE', label);
    assert.equal((await api(post('purchases/claim', { checkout: gift.id, expect: 'gift' }))).status, 200, label);
    // Plus through the same link, delivered by the webhook, then claimed too: one row.
    const plus = await buy(api, creem, { item: 'plus', currency: 'EUR', ref: 'CAMILLE' });
    const event = { id: `evt_${plus.id}`, eventType: 'checkout.completed', created_at: START, object: await creem.paid(plus.id) };
    assert.equal((await sendWebhook(api, event)).status, 200, label);
    assert.equal((await sendWebhook(api, event)).status, 200, label);
    assert.equal((await api(post('purchases/claim', { checkout: plus.id }))).status, 200, label);
    // A team pack through another partner, and a sale without a partner.
    const team = await buy(api, creem, { item: 'gift', plan: 'up-to-10', currency: 'EUR', ref: 'COACH_ANNA' });
    assert.equal((await api(post('purchases/claim', { checkout: team.id, expect: 'gift' }))).status, 200, label);
    const direct = await buy(api, creem, { item: 'plus', currency: 'EUR' });
    assert.equal((await api(post('purchases/claim', { checkout: direct.id }))).status, 200, label);

    const rows = await store.listPartnerSales();
    assert.deepEqual(rows.map(row => [row.checkoutId, row.code, row.kind, row.plan, row.amount, row.currency, row.member, row.mode]).sort(), [
      [gift.id, 'CAMILLE', 'gift', 'gift-1', 2400, 'EUR', true, 'prod'],
      [plus.id, 'CAMILLE', 'plus', '', 2900, 'EUR', false, 'prod'],
      [team.id, 'COACH_ANNA', 'gift', 'up-to-10', 19500, 'EUR', false, 'prod']
    ].sort(), label);
    const { partners, partnersUnavailable } = (await asJson(await api(get('admin/summary', 'secret')))).body;
    assert.equal(partnersUnavailable, false, label);
    assert.deepEqual(partners.codes.map(row => [row.code, row.sales, row.members, row.revenue]), [['CAMILLE', 2, 1, { EUR: 5300 }], ['COACH_ANNA', 1, 0, { EUR: 19500 }]], label);
    assert.equal(partners.recent.length, 3, label);
    // A sale made in Creem's test mode is listed, never counted.
    const testing = setup({ store, creem: fakeCreem({ mode: 'test', prefix: 'testmode' }) });
    const tried = await buy(testing.api, testing.creem, { item: 'plus', currency: 'EUR', ref: 'CAMILLE' });
    assert.equal((await testing.api(post('purchases/claim', { checkout: tried.id }))).status, 200, label);
    const after = (await asJson(await api(get('admin/summary', 'secret')))).body.partners;
    assert.deepEqual([after.totals.sales, after.totals.revenue, after.totals.test], [3, { EUR: 24800 }, { sales: 1, revenue: { EUR: 2900 } }], label);
    assert.deepEqual(after.codes[0].test, 1, label);
  });
});

test('a refunded partner sale is marked, and left out of the revenue (memory and D1)', async t => {
  await bothStores(t, async (label, store) => {
    const { api, creem } = setup({ store, creem: fakeCreem({ mode: 'prod' }) });
    const sale = await buy(api, creem, { item: 'plus', currency: 'EUR', ref: 'CAMILLE' });
    assert.equal((await api(post('purchases/claim', { checkout: sale.id }))).status, 200, label);
    creem.transactions.set('tran_1', { id: 'tran_1', object: 'transaction', order: `ord_${sale.id}`, status: 'refunded', amount: 2900, amount_paid: 2900, refunded_amount: 2900, currency: 'EUR', mode: 'prod' });
    const refund = { id: 'evt_ref_1', eventType: 'refund.created', created_at: START, object: { id: 'ref_1', object: 'refund', refund_amount: 2900, refund_currency: 'EUR', transaction: { id: 'tran_1', status: 'refunded' }, created_at: START } };
    assert.equal((await sendWebhook(api, refund)).status, 200, label);
    const { partners } = (await asJson(await api(get('admin/summary', 'secret')))).body;
    assert.deepEqual(partners.codes, [{ code: 'CAMILLE', sales: 1, refunded: 1, partial: 0, revoked: 0, members: 0, revenue: {}, test: 0, lastAt: new Date(START).toISOString() }], label);
    assert.equal(partners.recent[0].state, 'refunded', label);
    // Restored in the dashboard: counted again, in full (a full refund is a state, never taken off as an amount).
    assert.equal((await api(request('DELETE', 'admin/revocations/ref_1', undefined, 'secret'))).status, 200, label);
    assert.deepEqual((await asJson(await api(get('admin/summary', 'secret')))).body.partners.codes[0].revenue, { EUR: 2900 }, label);
    // A partial refund of another sale switches nothing off: its amount comes off the revenue.
    const other = await buy(api, creem, { item: 'gift', plan: 'family-5', currency: 'EUR', ref: 'CAMILLE' });
    assert.equal((await api(post('purchases/claim', { checkout: other.id, expect: 'gift' }))).status, 200, label);
    creem.transactions.set('tran_2', { id: 'tran_2', object: 'transaction', order: `ord_${other.id}`, status: 'partialRefund', amount: 9900, amount_paid: 9900, refunded_amount: 1500, currency: 'EUR', mode: 'prod' });
    const partial = { id: 'evt_ref_2', eventType: 'refund.created', created_at: START, object: { id: 'ref_2', object: 'refund', refund_amount: 1500, refund_currency: 'EUR', transaction: { id: 'tran_2', status: 'partialRefund' }, created_at: START } };
    assert.equal((await sendWebhook(api, partial)).status, 200, label);
    const later = (await asJson(await api(get('admin/summary', 'secret')))).body.partners;
    assert.deepEqual([later.totals.revenue, later.totals.partial, later.totals.refunded], [{ EUR: 2900 + 9900 - 1500 }, 1, 0], label);
    assert.deepEqual(later.recent.find(row => row.checkoutId === other.id).refundedAmount, 1500, label);
  });
});

test('a code Creem refuses is not recorded; without migration 0006 sales still go through and the card says so', async t => {
  const creem = fakeCreem({ refuseCode: 'OLDCODE' });
  const { api, store, warnings } = setup({ creem });
  const sale = await buy(api, creem, { item: 'plus', currency: 'EUR', ref: 'OLDCODE' });
  assert.equal(creem.calls.length, 2, 'opened again without the code');
  assert.equal('ref' in sale.sent.metadata, false);
  assert.equal((await api(post('purchases/claim', { checkout: sale.id }))).status, 200);
  assert.deepEqual(store.data.partnerSales, []);
  assert.equal(warnings.length, 1);

  const d1 = await openSqlite(t, ALL_MIGRATIONS.filter(file => file !== '0006_partners.sql'));
  if (!d1) return;
  const older = setup({ store: createD1Store(d1) });
  const paid = await buy(older.api, older.creem, { item: 'gift', plan: 'family-5', currency: 'EUR', ref: 'CAMILLE' });
  assert.equal((await older.api(post('purchases/claim', { checkout: paid.id, expect: 'gift' }))).status, 200, 'the gift is delivered all the same');
  assert.deepEqual(older.warnings, [], 'a missing table is not a warning on every sale: the Setup card says it');
  const summary = (await asJson(await older.api(get('admin/summary', 'secret')))).body;
  assert.equal(summary.partnersUnavailable, true);
  assert.deepEqual(summary.partners.codes, []);
});

test('the partner events are allow-listed counts', async () => {
  const { api, store } = setup();
  for (const name of ['partners_viewed', 'partner_cta_clicked']) assert.equal((await api(post('events', { name, version: '1.27.0' }))).status, 204, name);
  assert.deepEqual(store.data.events.map(row => row.name), ['partners_viewed', 'partner_cta_clicked']);
});
