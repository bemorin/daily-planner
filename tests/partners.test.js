import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMemoryStore, createPlannerApi, EVENT_NAMES, teamRequestEmail, teamRequestPartnerLine, validateTeamRequest } from '../server/planner-api.js';
import { createD1Store } from '../server/d1-store.js';
import { generatePlusKeyPair, giftRef, signLicense } from '../server/licenses.js';
import { checkoutSeal, checkoutSealValid, memberFlag, parseCreemProducts, readCheckout, webhookSignature } from '../server/creem.js';
import { codeChecks, COMMISSION_STATUSES, commissionStatus, describeSale, earnedAt, isTestMode, normalizeCodeRejection, normalizePartnerSale, normalizePayout, PARTNER_RECENT, PARTNER_SALES_LISTED, partialRefunds, partnerSaleRow, partnerSummary, payoutCheck, payoutChecksText, saleCommission, saleRate, saleStates, storedSaleKind } from '../server/partners.js';
import { giftPlan, hasMemberPrice, LAUNCH, MEMBER_GIFT_DISCOUNT, MEMBER_PRICE_FLOOR, memberGiftPrice, PERSONAL_GIFTS, PLUS_PRICE, priceCents, TEAM_TIERS } from '../src/lib/pricing.js';

const START = Date.parse('2026-10-20T08:00:00Z');
const KEYS = await generatePlusKeyPair();
const OTHER_KEYS = await generatePlusKeyPair();
const PRODUCTS = Object.freeze({ plus: { EUR: 'prod_plus_eur', USD: 'prod_plus_usd' }, gift: { EUR: 'prod_gift_eur', USD: 'prod_gift_usd' } });
const WEBHOOK_SECRET = 'whsec_test_partners';
const ALL_MIGRATIONS = ['0001_planner_api.sql', '0002_team_requests.sql', '0003_plus.sql', '0004_creem_reviews.sql', '0005_refunds.sql', '0006_partners.sql', '0007_partner_commissions.sql', '0008_partner_profiles.sql'];

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
function fakeCreem({ refuseCode = '', mode = 'test', prefix = 'partner', vat = 0 } = {}) {
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
      ...(found.status === 'completed' ? { order: { id: `ord_${found.id}`, object: 'order', status: 'paid', type: 'onetime', amount, amount_paid: amount, currency, ...(vat ? { tax_amount: amount - Math.round(amount * 100 / (100 + vat)) } : {}) } } : {}),
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

const DAY = 86400000;
const iso = ms => new Date(ms).toISOString();
/** A sale's row as the store gives it, `daysAgo` days before START. */
const saleAt = (checkoutId, daysAgo, fields = {}) => ({ checkoutId, code: 'CAMILLE', kind: 'plus', plan: '', amount: 2900, tax: null, currency: 'EUR', member: false, mode: 'prod', createdAt: iso(START - daysAgo * DAY), ...fields });

test('a partner sale keeps the code, what was bought, the amount and its tax, the member price and the mode — nothing about the buyer', () => {
  const paid = { ref: 'CAMILLE', item: { kind: 'gift', plan: 'gift-1', seats: 1 }, amount: 2400, tax: 400, currency: 'EUR', member: true, mode: 'test', email: 'buyer@example.com', country: 'FR', sealed: true };
  const row = partnerSaleRow('ch_1', paid, '2026-10-20T08:00:00.000Z');
  assert.deepEqual(row, { checkoutId: 'ch_1', code: 'CAMILLE', kind: 'gift', plan: 'gift-1', payer: 'creem', amount: 2400, tax: 400, currency: 'EUR', member: true, mode: 'test', createdAt: '2026-10-20T08:00:00.000Z' });
  assert.ok(!JSON.stringify(row).includes('buyer@example.com') && !JSON.stringify(row).includes('FR'));
  assert.equal(partnerSaleRow('ch_1', { ...paid, ref: '' }, 'x'), null, 'no partner: nothing to keep');
  assert.equal(partnerSaleRow('ch_1', { ...paid, item: null }, 'x'), null);
  // Not opened by our API (no valid seal): the code is only someone's metadata.
  assert.equal(partnerSaleRow('ch_1', { ...paid, sealed: false }, 'x'), null);
  const { sealed: _sealed, ...unsealed } = paid;
  assert.equal(partnerSaleRow('ch_1', unsealed, 'x'), null);
  // The member price belongs to gifts: never on Plus.
  assert.equal(partnerSaleRow('ch_1', { ...paid, item: { kind: 'plus', plan: '', seats: 1 } }, 'x').member, false);
  // A tax Creem didn't give, or one larger than the amount, is unknown.
  for (const tax of [undefined, null, -1, 1.5, '400', 9999]) assert.equal(partnerSaleRow('ch_1', { ...paid, tax }, 'x').tax, tax === '400' ? 400 : null, String(tax));
  assert.deepEqual(normalizePartnerSale({ checkoutId: 'ch_1', code: 'A', kind: 'plus', plan: null, amount: '2900', currency: 'EUR', member: 0, mode: null, createdAt: 'x' }), { checkoutId: 'ch_1', code: 'A', kind: 'plus', plan: '', payer: 'creem', amount: 2900, tax: null, currency: 'EUR', member: false, mode: '', createdAt: 'x' });
});

test('who pays a team gift’s partner is recorded with the sale: the owner since 1.28, Creem for one opened before (sent with affiliate_code)', () => {
  const team = { ref: 'COACH_ANNA', item: { kind: 'gift', plan: 'up-to-10', seats: 10 }, amount: 19500, tax: 3250, currency: 'EUR', mode: 'prod', sealed: true };
  // 1.28 opens a team checkout without affiliate_code and seals payout: 'owner' in its metadata.
  const now = partnerSaleRow('ch_new', { ...team, payout: 'owner' }, 'x');
  assert.equal(now.payer, 'owner');
  // 1.27 sent the code to Creem with every item: no marker, so Creem credited the partner.
  assert.equal(partnerSaleRow('ch_old', team, 'x').payer, 'creem');
  // The marker means nothing on what Creem credits anyway.
  assert.equal(partnerSaleRow('ch_plus', { ...team, item: { kind: 'plus', plan: '', seats: 1 }, payout: 'owner' }, 'x').payer, 'creem');
  // Kept in partner_sales.kind (migration 0006), so it holds while 0007 is missing: 'team' reads back as a gift the owner pays.
  assert.equal(storedSaleKind(now), 'team');
  assert.equal(storedSaleKind(partnerSaleRow('ch_old', team, 'x')), 'gift');
  assert.equal(storedSaleKind({ kind: 'plus', payer: 'owner' }), 'plus', 'only a team gift');
  assert.deepEqual([normalizePartnerSale({ ...now, payer: undefined, kind: 'team' })].map(row => [row.kind, row.plan, row.payer]), [['gift', 'up-to-10', 'owner']]);
  assert.deepEqual([normalizePartnerSale(now)].map(row => [row.kind, row.payer]), [['gift', 'owner']], 'the memory store keeps the model as is');
  assert.deepEqual([normalizePartnerSale({ kind: 'team', plan: 'gift-1' })].map(row => [row.kind, row.payer]), [['gift', 'creem']], 'never on a personal gift');
  // The rate follows who pays: 10% for the owner, Creem's 25% for a team gift Creem credited.
  assert.equal(saleRate(normalizePartnerSale(now)), 10);
  assert.equal(saleRate(normalizePartnerSale(partnerSaleRow('ch_old', team, 'x'))), 25);
  assert.equal(saleRate({ kind: 'gift', plan: 'over-1000', payer: 'owner' }), 0);
});

test('Creem’s order gives the tax included in the amount paid', () => {
  const products = parseCreemProducts(PRODUCTS).byId;
  const entity = order => ({ id: 'ch_tax0001', status: 'completed', product: PRODUCTS.plus.EUR, order: { id: 'ord_1', status: 'paid', currency: 'EUR', ...order }, metadata: { kind: 'plus' } });
  assert.deepEqual([readCheckout(entity({ amount_paid: 2900, tax_amount: 483 }), products).amount, readCheckout(entity({ amount_paid: 2900, tax_amount: 483 }), products).tax], [2900, 483]);
  assert.equal(readCheckout(entity({ amount_paid: 2900 }), products).tax, null, 'not given');
  assert.equal(readCheckout(entity({ amount_paid: 2900, tax_amount: 3000 }), products).tax, null, 'more than was paid');
  assert.equal(readCheckout(entity({ amount_paid: 2900, tax_amount: '483' }), products).tax, null, 'not a whole number of cents');
});

test('a sale’s states: refunded or disputed (by Creem) win over switched off (by the owner)', () => {
  const states = saleStates([{ checkoutId: 'ch_d', reason: 'owner' }, { checkoutId: 'ch_d', reason: 'refund' }, { checkoutId: 'ch_f', reason: 'owner' }, { checkoutId: 'ch_x', reason: 'dispute' }, { checkoutId: 'ch_x', reason: 'refund' }, { checkoutId: '', reason: 'refund' }]);
  assert.deepEqual([...states], [['ch_d', 'refunded'], ['ch_f', 'revoked'], ['ch_x', 'disputed']]);
  assert.deepEqual(COMMISSION_STATUSES, ['pending', 'earned', 'held', 'paid', 'refunded', 'disputed', 'revoked', 'not-partner']);
});

test('a commission is a share of the price before tax, partial refunds taken off in proportion; without the tax, of the amount paid', () => {
  // Plus in France: €29 with €4.83 VAT → €24.17 before tax → 25% = €6.04.
  assert.deepEqual(saleCommission({ kind: 'plus', amount: 2900, tax: 483 }), { rate: 25, base: 2417, basis: 'before-tax', commission: 604, exact: true });
  assert.deepEqual(saleCommission({ kind: 'gift', plan: 'family-5', amount: 9900, tax: 1650 }), { rate: 25, base: 8250, basis: 'before-tax', commission: 2063, exact: true });
  assert.deepEqual(saleCommission({ kind: 'gift', plan: 'gift-1', amount: 2400, tax: 400 }), { rate: 25, base: 2000, basis: 'before-tax', commission: 500, exact: true }, 'a member-price gift earns on what was paid');
  // A team gift the owner pays: 10%.
  assert.deepEqual(saleCommission({ kind: 'gift', plan: 'up-to-50', payer: 'owner', amount: 59500, tax: 9917 }), { rate: 10, base: 49583, basis: 'before-tax', commission: 4958, exact: true });
  // Tax unknown (recorded before migration 0007, or Creem gave none): on the amount paid, tax included — an upper bound only.
  assert.deepEqual(saleCommission({ kind: 'plus', amount: 2900, tax: null }), { rate: 25, base: 2900, basis: 'paid', commission: 725, exact: false });
  // A partial refund of €9.90 (tax included) on a €99 Family: what was kept, before tax.
  assert.deepEqual(saleCommission({ kind: 'gift', plan: 'family-5', amount: 9900, tax: 1650 }, { refunded: 990 }), { rate: 25, base: 7425, basis: 'before-tax', commission: 1856, exact: true });
  // A partial refund whose amount isn't known: the figure is before it, so an upper bound only.
  assert.deepEqual(saleCommission({ kind: 'gift', plan: 'up-to-50', payer: 'owner', amount: 59500, tax: 9917 }, { refundUnknown: true }), { rate: 10, base: 49583, basis: 'before-tax', commission: 4958, exact: false });
  assert.deepEqual(saleCommission({ kind: 'plus', amount: 2900, tax: null }, { refunded: 5000 }), { rate: 25, base: 0, basis: 'paid', commission: 0, exact: false }, 'never below nothing');
  // No amount, or nothing that earns: no figure.
  assert.deepEqual(saleCommission({ kind: 'plus', amount: null }), { rate: 25, base: null, basis: '', commission: null, exact: false });
  assert.deepEqual(saleCommission({ kind: 'gift', plan: 'over-1000', amount: 100 }), { rate: 0, base: null, basis: '', commission: null, exact: false });
  assert.equal(earnedAt('2026-10-01T10:00:00.000Z'), '2026-10-15T10:00:00.000Z', '14 days later');
  assert.equal(earnedAt('nope'), '');
});

test('where a commission stands: pending for 14 days, then earned; refunded, disputed and switched-off sales earn nothing; team ones are paid by hand', () => {
  const now = START;
  const status = (row, options = {}) => describeSale(row, { now, ...options }).status;
  assert.equal(status(saleAt('ch_1', 3)), 'pending');
  assert.equal(status(saleAt('ch_1', 14) ), 'earned', 'exactly 14 days');
  assert.equal(status(saleAt('ch_1', 13.9)), 'pending');
  assert.equal(status(saleAt('ch_1', 40), { state: 'refunded' }), 'refunded');
  assert.equal(status(saleAt('ch_1', 2), { state: 'disputed' }), 'disputed');
  assert.equal(status(saleAt('ch_1', 30), { state: 'revoked' }), 'revoked');
  const team = saleAt('ch_t', 20, { kind: 'gift', plan: 'up-to-10', payer: 'owner', amount: 19500, tax: 3250 });
  const payout = { checkoutId: 'ch_t', code: 'CAMILLE', amount: 1625, currency: 'EUR', note: 'SEPA 0042', paidAt: iso(START - DAY) };
  assert.equal(status(team), 'earned');
  const paid = describeSale(team, { now, payout });
  assert.deepEqual([paid.status, paid.program, paid.paidAt, paid.paidAmount, paid.paidNote, paid.commission], ['paid', 'team', payout.paidAt, 1625, 'SEPA 0042', 1625]);
  // Refunded or disputed after being paid: still paid (the money went out), and the state says what happened.
  const disputed = describeSale(team, { now, payout, state: 'disputed' });
  assert.deepEqual([disputed.status, disputed.state, disputed.paidAt, disputed.paidAmount], ['paid', 'disputed', payout.paidAt, 1625]);
  assert.equal(status(team, { state: 'disputed' }), 'disputed', 'not paid yet: it earns nothing');
  // A code the owner found no partner for: nothing to pay; once paid, it stays paid.
  assert.equal(status(team, { check: 'rejected' }), 'not-partner');
  assert.equal(describeSale(team, { now, payout, check: 'rejected' }).status, 'paid');
  assert.equal(status(team, { check: 'rejected', state: 'refunded' }), 'refunded');
  // A team gift sold before 1.28 was sent to Creem with the code: Creem's to pay, at its rate.
  const legacy = describeSale(saleAt('ch_l', 20, { kind: 'gift', plan: 'up-to-10', amount: 19500, tax: 3250 }), { now, payout: { ...payout, checkoutId: 'ch_l' } });
  assert.deepEqual([legacy.program, legacy.status, legacy.rate, legacy.commission, legacy.checks], ['creem', 'earned', 25, 4063, []]);
  // A payout row on a Creem sale means nothing: Creem pays those.
  assert.deepEqual([describeSale(saleAt('ch_p', 20), { now, payout: { ...payout, checkoutId: 'ch_p' } }).status, describeSale(saleAt('ch_p', 20), { now }).program], ['earned', 'creem']);
  assert.equal(commissionStatus({ earned: '' }, now), 'pending', 'no date: never earned by mistake');
});

test('a team commission’s code is confirmed by a sale Creem credited or a commission already paid; until then, and with a refund or a tax unknown, it is to check', () => {
  const now = START;
  const team = (id, fields = {}) => saleAt(id, 20, { code: 'NEWCODE', kind: 'gift', plan: 'up-to-10', payer: 'owner', amount: 19500, tax: 3250, ...fields });
  const rows = [
    saleAt('ch_plus', 30, { code: 'KNOWN' }),
    saleAt('ch_try', 30, { code: 'TRIED', mode: 'test' }),
    saleAt('ch_gone', 30, { code: 'REFUNDED_ONE' }),
    saleAt('ch_old_team', 30, { code: 'OLDTEAM', kind: 'gift', plan: 'up-to-10', amount: 19500 }),
    team('ch_owner', { code: 'PAIDBEFORE' })
  ].map(normalizePartnerSale);
  const checks = codeChecks(rows, [{ code: 'PAIDBEFORE', checkoutId: 'ch_x' }], [{ code: 'BADCODE' }, { code: 'KNOWN2' }]);
  // Creem accepted these codes (it refuses unknown ones) — refunded or not; a test-mode sale proves nothing about live; a team sale the owner pays proves nothing.
  assert.deepEqual([...checks], [['KNOWN', 'creem'], ['REFUNDED_ONE', 'creem'], ['OLDTEAM', 'creem'], ['PAIDBEFORE', 'paid'], ['BADCODE', 'rejected'], ['KNOWN2', 'rejected']]);
  assert.deepEqual(normalizeCodeRejection({ code: 'BADCODE', createdAt: null }), { code: 'BADCODE', createdAt: '' });
  // What a team commission still open asks to check before paying it.
  assert.deepEqual(describeSale(team('ch_1'), { now }).checks, ['code']);
  assert.deepEqual(describeSale(team('ch_1'), { now, check: 'creem' }).checks, []);
  assert.deepEqual(describeSale(team('ch_1'), { now, check: 'paid' }).checks, []);
  assert.deepEqual(describeSale(team('ch_1', { tax: null }), { now, check: 'creem' }).checks, ['tax']);
  const unknownRefund = describeSale(team('ch_1'), { now, check: 'creem', taken: { amount: 0, unknown: 1 } });
  assert.deepEqual([unknownRefund.checks, unknownRefund.refundUnknown, unknownRefund.exact, unknownRefund.commission], [['refund'], true, false, 1625]);
  assert.deepEqual(describeSale(team('ch_1', { tax: null }), { now, taken: { amount: 1000, unknown: 1 } }).checks, ['code', 'refund', 'tax']);
  assert.deepEqual(describeSale(team('ch_1'), { now, check: 'rejected' }).checks, [], 'not a partner: nothing to pay, nothing to check');
  assert.deepEqual(describeSale(saleAt('ch_2', 20, { code: 'NEWCODE' }), { now }).checks, [], 'Creem credits Plus: nothing to check');
  assert.equal(describeSale(saleAt('ch_2', 20, { code: 'NEWCODE' }), { now }).codeCheck, 'creem');
  // The words the API answers with.
  const all = describeSale(team('ch_1', { tax: null }), { now, taken: { amount: 1000, unknown: 1 } });
  assert.equal(payoutChecksText(all), 'NEWCODE isn’t confirmed: no sale credited by Creem has used this code yet. Check that NEWCODE is a partner in Creem → Affiliate Hub before paying. Part of this sale was refunded and Creem didn’t give the amount: check the refund in Creem before paying. The tax on this sale isn’t recorded: check it in Creem, and pay 10% of the price before tax.');
  assert.equal(payoutChecksText({ checks: [] }), '');
});

test('the Partners card: per partner, Creem’s commissions for information and the team commissions to pay, with totals per currency', () => {
  const rows = [
    saleAt('ch_a', 30, { tax: 483 }),
    saleAt('ch_b', 20, { kind: 'gift', plan: 'gift-1', amount: 2400, tax: 400, member: true }),
    saleAt('ch_c', 5, { kind: 'gift', plan: 'family-5', amount: 9900, currency: 'USD' }),
    saleAt('ch_d', 25, { tax: 483 }),
    saleAt('ch_e', 18, { code: 'NEWSLETTER', kind: 'gift', plan: 'up-to-10', payer: 'owner', amount: 19500, tax: 3250 }),
    saleAt('ch_f', 40, { code: 'NEWSLETTER', currency: 'USD' }),
    saleAt('ch_g', 2, { code: 'NEWSLETTER', kind: 'gift', plan: 'up-to-50', payer: 'owner', amount: 59500, tax: 9917 }),
    saleAt('ch_h', 60, { code: 'NEWSLETTER', kind: 'gift', plan: 'up-to-100', payer: 'owner', amount: 99500, tax: 16583 }),
    saleAt('ch_i', 1, { code: 'TRYOUT', mode: 'test', kind: 'gift', plan: 'up-to-10', payer: 'owner', amount: 19500, tax: 3250 })
  ];
  const states = saleStates([{ checkoutId: 'ch_d', reason: 'refund' }, { checkoutId: 'ch_f', reason: 'owner' }]);
  const payouts = [{ checkoutId: 'ch_h', code: 'NEWSLETTER', amount: 8292, currency: 'EUR', note: '', paidAt: iso(START - 30 * DAY) }];
  const summary = partnerSummary(rows, states, [], { payouts, now: START });
  // Most sales first; at equal sales, the latest sale first.
  assert.deepEqual(summary.codes.map(row => row.code), ['NEWSLETTER', 'CAMILLE', 'TRYOUT']);
  const [newsletter, camille, tryout] = summary.codes;
  assert.deepEqual([camille.code, camille.sales, camille.refunded, camille.members, camille.revenue], ['CAMILLE', 4, 1, 1, { EUR: 5300, USD: 9900 }]);
  // Creem: Plus 604 and Give Plus 500 earned (EUR); Family pending (USD, tax unknown: 25% of 99.00); the refunded Plus earns nothing.
  assert.deepEqual(camille.creem, { sales: 4, pending: { USD: 2475 }, earned: { EUR: 1104 } });
  assert.deepEqual(camille.team, { sales: 0, pending: {}, toPay: {}, held: {}, paid: {} });
  assert.deepEqual([newsletter.code, newsletter.sales, newsletter.revoked], ['NEWSLETTER', 4, 1]);
  assert.deepEqual(newsletter.creem, { sales: 1, pending: {}, earned: {} }, 'switched off: nothing');
  assert.deepEqual(newsletter.team, { sales: 3, pending: { EUR: 4958 }, toPay: { EUR: 1625 }, held: {}, paid: { EUR: 8292 } });
  assert.deepEqual([tryout.code, tryout.sales, tryout.test], ['TRYOUT', 0, 1]);
  assert.deepEqual(summary.totals.creem, { pending: { USD: 2475 }, earned: { EUR: 1104 } });
  assert.deepEqual(summary.totals.team, { pending: { EUR: 4958 }, toPay: { EUR: 1625 }, held: {}, paid: { EUR: 8292 }, toPayCount: 1, toCheck: 0, heldCount: 0 });
  assert.deepEqual([summary.totals.sales, summary.totals.partners, summary.totals.refunded, summary.totals.test.sales], [8, 2, 2, 1]);
  // Only the USD Family (tax unknown) is an upper bound among the commissions still open.
  assert.equal(summary.totals.inexact, 1);
  // Both live codes were accepted by Creem on a sale it credits; TRYOUT only in test mode.
  assert.deepEqual(summary.codeChecks, { CAMILLE: 'creem', NEWSLETTER: 'creem' });
  // The team commissions one by one (live only), newest first, and the one to pay with when it was earned.
  assert.deepEqual(summary.team.map(sale => [sale.checkoutId, sale.status, sale.commission]), [['ch_g', 'pending', 4958], ['ch_e', 'earned', 1625], ['ch_h', 'paid', 8292]]);
  assert.deepEqual(summary.toPay, [{ checkoutId: 'ch_e', code: 'NEWSLETTER', plan: 'up-to-10', amount: 19500, refundedAmount: 0, refundUnknown: false, rate: 10, base: 16250, basis: 'before-tax', commission: 1625, exact: true, currency: 'EUR', checks: [], earnedAt: iso(START - 4 * DAY), createdAt: iso(START - 18 * DAY), paidAmount: null, rest: 1625, payable: 1625, held: 0, partner: 'individual', cap: { year: 2026, limit: 30000, paid: 8292 } }]);
  // Every sale in `recent` says what it earns and where it stands.
  assert.deepEqual(summary.recent.map(sale => [sale.checkoutId, sale.program, sale.status]), [
    ['ch_i', 'team', 'pending'], ['ch_g', 'team', 'pending'], ['ch_c', 'creem', 'pending'], ['ch_e', 'team', 'earned'],
    ['ch_b', 'creem', 'earned'], ['ch_d', 'creem', 'refunded'], ['ch_a', 'creem', 'earned'], ['ch_f', 'creem', 'revoked'], ['ch_h', 'team', 'paid']
  ]);
  const many = Array.from({ length: PARTNER_RECENT + 5 }, (_, index) => saleAt(`ch_${index}`, index % 28));
  assert.equal(partnerSummary(many, [], [], { now: START }).recent.length, PARTNER_RECENT);
  const empty = partnerSummary([], [], [], { now: START });
  assert.deepEqual([empty.codes, empty.recent, empty.team, empty.toPay], [[], [], [], []]);
  assert.deepEqual(empty.totals, { sales: 0, partners: 0, refunded: 0, partial: 0, revenue: {}, test: { sales: 0, revenue: {} }, creem: { pending: {}, earned: {} }, team: { pending: {}, toPay: {}, held: {}, paid: {}, toPayCount: 0, toCheck: 0, heldCount: 0 }, inexact: 0, listed: 0, capped: false });
  assert.deepEqual(empty.codeChecks, {});
  // Paid, then disputed: still counted as paid (the money went out).
  const disputedAfter = partnerSummary(rows, saleStates([{ checkoutId: 'ch_h', reason: 'dispute' }]), [], { payouts, now: START });
  assert.deepEqual([disputedAfter.totals.team.paid, disputedAfter.team.find(sale => sale.checkoutId === 'ch_h').state], [{ EUR: 8292 }, 'disputed']);
  // A code found to be no partner: its open team commissions earn nothing, what was paid stays paid.
  const rejected = partnerSummary(rows, states, [], { payouts, rejections: [{ code: 'NEWSLETTER', createdAt: iso(START) }], now: START });
  assert.deepEqual(rejected.team.map(sale => [sale.checkoutId, sale.status]), [['ch_g', 'not-partner'], ['ch_e', 'not-partner'], ['ch_h', 'paid']]);
  assert.deepEqual([rejected.totals.team, rejected.toPay], [{ pending: {}, toPay: {}, held: {}, paid: { EUR: 8292 }, toPayCount: 0, toCheck: 0, heldCount: 0 }, []]);
  assert.equal(rejected.codeChecks.NEWSLETTER, 'rejected');
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
  const summary = partnerSummary(rows, [{ checkoutId: 'ch_live1', reason: 'refund' }], refunds, { now: START });
  const { creem, team, ...totals } = summary.totals;
  // The Family (tax unknown) and the USD Plus (tax and a refund unknown) are only upper bounds.
  assert.deepEqual(totals, { sales: 3, partners: 1, refunded: 1, partial: 2, revenue: { EUR: 5000, USD: 2900 }, test: { sales: 2, revenue: { EUR: 4800 } }, inexact: 2, listed: 5, capped: false });
  // Earned on what was kept: the Family's €79 less €29 refunded, 25% of €50 (tax unknown) — and the Plus refunded in full earns nothing.
  assert.deepEqual(creem, { pending: {}, earned: { EUR: 1250, USD: 725 } });
  const [camille, tryout] = summary.codes;
  assert.deepEqual([camille.code, camille.sales, camille.refunded, camille.partial, camille.revoked, camille.members, camille.revenue, camille.test, camille.lastAt], ['CAMILLE', 3, 1, 2, 0, 1, { EUR: 5000, USD: 2900 }, 1, '2026-10-04T10:00:00Z']);
  assert.deepEqual([tryout.code, tryout.sales, tryout.test, tryout.revenue], ['TRYOUT', 0, 1, {}]);
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

test('a team commission can be marked as paid only once it is earned, and only once', () => {
  const team = { kind: 'gift', plan: 'up-to-10', payer: 'owner', amount: 19500, tax: 3250 };
  const rows = [
    saleAt('ch_due', 20, team),
    saleAt('ch_wait', 3, team),
    saleAt('ch_back', 20, team),
    saleAt('ch_plus', 20),
    saleAt('ch_none', 20, { ...team, amount: null }),
    saleAt('ch_try', 20, { ...team, mode: 'test' }),
    saleAt('ch_legacy', 20, { kind: 'gift', plan: 'up-to-10', amount: 19500, tax: 3250 })
  ];
  const summary = partnerSummary(rows, [{ checkoutId: 'ch_back', reason: 'dispute' }], [], { now: START, payouts: [] });
  assert.deepEqual(payoutCheck(summary, 'ch_due').amount, 1625);
  assert.equal(payoutCheck(summary, 'ch_due').sale.commission, 1625);
  assert.equal(payoutCheck(summary, 'ch_legacy').status, 404, 'sent to Creem with the code before 1.28: Creem pays it, never twice');
  assert.equal(payoutCheck(summary, 'ch_wait').status, 409);
  assert.match(payoutCheck(summary, 'ch_wait').error, /still within its 14-day refund period/);
  assert.match(payoutCheck(summary, 'ch_back').error, /earns nothing/);
  assert.equal(payoutCheck(summary, 'ch_plus').status, 404, 'Creem pays the Plus commission');
  assert.equal(payoutCheck(summary, 'ch_try').status, 404, 'test mode: never paid');
  assert.match(payoutCheck(summary, 'ch_none').error, /no amount/);
  assert.equal(payoutCheck(summary, 'ch_nope').status, 404);
  const paid = partnerSummary(rows, [], [], { now: START, payouts: [{ checkoutId: 'ch_due', code: 'CAMILLE', amount: 1625, currency: 'EUR', paidAt: iso(START) }] });
  assert.match(payoutCheck(paid, 'ch_due').error, /already marked as paid/);
  assert.deepEqual(normalizePayout({ checkoutId: 'ch_due', code: 'CAMILLE', amount: '1625', currency: 'EUR', note: null, paidAt: 'x' }), { checkoutId: 'ch_due', code: 'CAMILLE', amount: 1625, currency: 'EUR', note: '', paidAt: 'x' });
});

test('a commission to check is marked as paid only once the owner says they checked; an upper bound needs the amount actually paid', () => {
  const team = { code: 'NEWCODE', kind: 'gift', plan: 'up-to-10', payer: 'owner', amount: 19500, tax: 3250 };
  const rows = [
    saleAt('ch_code', 20, team),
    saleAt('ch_tax', 20, { ...team, code: 'CAMILLE', tax: null }),
    saleAt('ch_refund', 20, { ...team, code: 'CAMILLE' }),
    saleAt('ch_known', 30, { code: 'CAMILLE' })
  ];
  const refunds = [{ checkoutId: 'ch_refund', amount: null, currency: 'EUR', fullRefund: false }];
  const summary = partnerSummary(rows, [], refunds, { now: START });
  // A code nothing confirmed: the owner is told to check it in Creem first.
  const unchecked = payoutCheck(summary, 'ch_code');
  assert.deepEqual([unchecked.status, unchecked.checks], [409, ['code']]);
  assert.match(unchecked.error, /^NEWCODE isn’t confirmed: .* Check that NEWCODE is a partner in Creem → Affiliate Hub before paying\. Then mark it as paid again\.$/);
  assert.deepEqual([payoutCheck(summary, 'ch_code', { confirmed: true }).amount], [1625]);
  assert.equal(payoutCheck(summary, 'ch_code', { confirmed: true, amount: 1000 }).status, 400, 'an exact commission takes no other amount');
  assert.equal(payoutCheck(summary, 'ch_code', { confirmed: true, amount: 1625 }).amount, 1625);
  // The tax isn't recorded: €19.50 is only an upper bound (10% of the amount paid, tax included).
  assert.deepEqual([payoutCheck(summary, 'ch_tax').status, payoutCheck(summary, 'ch_tax').checks], [409, ['tax']]);
  assert.match(payoutCheck(summary, 'ch_tax', { confirmed: true }).error, /^Give the amount you paid: more than nothing and at most €19\.50 \(10% of the amount paid, tax included\)\.$/);
  for (const amount of [0, -1, 1951, 16.25, '1625']) assert.equal(payoutCheck(summary, 'ch_tax', { confirmed: true, amount }).status, 400, String(amount));
  assert.deepEqual([payoutCheck(summary, 'ch_tax', { confirmed: true, amount: 1625 }).amount], [1625]);
  // Part refunded, amount unknown: the same.
  const refunded = payoutCheck(summary, 'ch_refund');
  assert.deepEqual([refunded.status, refunded.checks], [409, ['refund']]);
  assert.match(refunded.error, /^Part of this sale was refunded and Creem didn’t give the amount: check the refund in Creem before paying\./);
  assert.equal(payoutCheck(summary, 'ch_refund', { confirmed: true, amount: 1200 }).amount, 1200);
  // A code found to be no partner: nothing to pay.
  const rejected = partnerSummary(rows, [], refunds, { now: START, rejections: [{ code: 'NEWCODE' }] });
  assert.deepEqual([payoutCheck(rejected, 'ch_code', { confirmed: true }).status], [409]);
  assert.match(payoutCheck(rejected, 'ch_code', { confirmed: true }).error, /^You marked NEWCODE as not a partner/);
});

test('the dashboard’s Partners card says what it leaves out: test-mode sales, older sales past the cap, a missing 0007', async () => {
  const view = readFileSync(new URL('../admin/partners-view.js', import.meta.url), 'utf8');
  assert.match(view, /in test mode\$\{.*?\$\{Number\(test\.sales\) === 1 \? 'is' : 'are'\} not counted\./);
  assert.match(view, /The figures cover the latest \$\{number\(totals\.listed\)\} sales\./);
  assert.match(view, /Run <code>migrations\/0007_partner_commissions\.sql<\/code> on the D1 database to track team commissions\./);
  assert.match(view, /label: 'Test · not counted'/);
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
    assert.deepEqual(partners.codes, [{ code: 'CAMILLE', sales: 1, refunded: 1, partial: 0, revoked: 0, members: 0, revenue: {}, test: 0, lastAt: new Date(START).toISOString(), creem: { sales: 1, pending: {}, earned: {} }, team: { sales: 0, pending: {}, toPay: {}, held: {}, paid: {} }, key: 'CAMILLE', sameAs: [], partner: 'individual', cap: null, visits: 0 }], label);
    assert.deepEqual([partners.recent[0].state, partners.recent[0].status], ['refunded', 'refunded'], label);
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

// ---- Team gifts and team commissions (1.28) -------------------------------------------

test('a team gift is never sent to Creem with the partner’s code; Plus and personal gifts are, and every sale is still listed under its partner', async t => {
  await bothStores(t, async (label, store) => {
    const { api, creem } = setup({ store, creem: fakeCreem({ mode: 'prod', vat: 20 }) });
    const plus = await buy(api, creem, { item: 'plus', currency: 'EUR', ref: 'COACH_ANNA' });
    const family = await buy(api, creem, { item: 'gift', plan: 'family-5', currency: 'EUR', ref: 'COACH_ANNA' });
    const team = await buy(api, creem, { item: 'gift', plan: 'up-to-50', currency: 'EUR', ref: 'COACH_ANNA' });
    assert.equal(plus.sent.affiliate_code, 'COACH_ANNA', label);
    assert.equal(family.sent.affiliate_code, 'COACH_ANNA', label);
    assert.equal('affiliate_code' in team.sent, false, `${label}: Creem would pay 25% on it`);
    assert.equal(team.sent.metadata.ref, 'COACH_ANNA', `${label}: the code stays in the metadata`);
    assert.equal(team.sent.metadata.payout, 'owner', `${label}: with who pays it`);
    assert.equal('payout' in plus.sent.metadata || 'payout' in family.sent.metadata, false, `${label}: Creem pays those`);
    assert.equal(team.sent.metadata.seal, await checkoutSeal(KEYS.signingKey, { kind: 'gift', plan: 'up-to-50', currency: 'EUR', rid: team.sent.request_id, ref: 'COACH_ANNA', payout: 'owner' }), `${label}: both sealed`);
    for (const sale of [plus, family]) assert.equal((await api(post('purchases/claim', { checkout: sale.id, expect: sale === plus ? '' : 'gift' }))).status, 200, label);
    assert.equal((await api(post('purchases/claim', { checkout: team.id, expect: 'gift' }))).status, 200, label);
    // Recorded with who pays it and the tax Creem reports, so the commission is on the price before tax.
    const rows = (await store.listPartnerSales()).map(row => [row.kind, row.plan, row.payer, row.amount, row.tax]).sort();
    assert.deepEqual(rows, [['gift', 'family-5', 'creem', 9900, 1650], ['gift', 'up-to-50', 'owner', 59500, 9917], ['plus', '', 'creem', 2900, 483]], label);
    const { partners } = (await asJson(await api(get('admin/summary', 'secret')))).body;
    assert.deepEqual(partners.team.map(sale => [sale.checkoutId, sale.status, sale.commission, sale.basis, sale.checks]), [[team.id, 'pending', 4958, 'before-tax', []]], `${label}: COACH_ANNA’s code was accepted by Creem on the Plus sale`);
    assert.deepEqual(partners.totals.creem, { pending: { EUR: 604 + 2063 }, earned: {} }, label);
    // A code Creem refuses never concerns a team gift: it isn't sent, so the checkout opens at once.
    const refusing = setup({ store, creem: fakeCreem({ refuseCode: 'OLDCODE', prefix: 'refuse' }) });
    const old = await buy(refusing.api, refusing.creem, { item: 'gift', plan: 'up-to-10', currency: 'EUR', ref: 'OLDCODE' });
    assert.equal(refusing.creem.calls.length, 1, label);
    assert.equal(old.sent.metadata.ref, 'OLDCODE', label);
  });
});

test('a team sale opened by 1.27 (sent to Creem with the code) stays Creem’s to pay, whenever it is paid; one opened since is the owner’s, even without migration 0007', async t => {
  const stores = [['memory', createMemoryStore()]];
  const d1 = await openSqlite(t);
  if (d1) stores.push(['D1', createD1Store(d1)]);
  const older = await openSqlite(t, ALL_MIGRATIONS.filter(file => file !== '0007_partner_commissions.sql'));
  if (older) stores.push(['D1 without 0007', createD1Store(older)]);
  for (const [label, store] of stores) {
    const { api, creem } = setup({ store, creem: fakeCreem({ mode: 'prod', vat: 20 }) });
    // A checkout 1.27 opened: affiliate_code sent, no payout marker, sealed without it — paid after 1.28 is deployed.
    const rid = 'dp_0123456789abcdef';
    creem.checkouts.set('ch_from127', { id: 'ch_from127', object: 'checkout', mode: 'prod', status: 'completed', request_id: rid, product: PRODUCTS.gift.EUR, amount: 19500, currency: 'EUR',
      metadata: { kind: 'gift', plan: 'up-to-10', seats: '10', currency: 'EUR', rid, ref: 'COACH_ANNA', seal: await checkoutSeal(KEYS.signingKey, { kind: 'gift', plan: 'up-to-10', currency: 'EUR', rid, ref: 'COACH_ANNA' }) } });
    assert.equal((await api(post('purchases/claim', { checkout: 'ch_from127', expect: 'gift' }))).status, 200, label);
    // One 1.28 opens: no affiliate_code, payout: 'owner'.
    const now = await buy(api, creem, { item: 'gift', plan: 'up-to-10', currency: 'EUR', ref: 'COACH_ANNA' });
    assert.equal((await api(post('purchases/claim', { checkout: now.id, expect: 'gift' }))).status, 200, label);
    // Someone can't take the marker off (or add it): the seal covers it, and nothing is delivered or recorded.
    creem.checkouts.set('ch_tampered', { ...creem.checkouts.get(now.id), id: 'ch_tampered', metadata: { ...creem.checkouts.get(now.id).metadata, payout: '' } });
    assert.equal((await api(post('purchases/claim', { checkout: 'ch_tampered', expect: 'gift' }))).status, 404, label);
    const { partners } = (await asJson(await api(get('admin/summary', 'secret')))).body;
    const byId = new Map(partners.recent.map(sale => [sale.checkoutId, sale]));
    assert.deepEqual(['ch_from127', now.id].map(id => [byId.get(id).program, byId.get(id).rate]), [['creem', 25], ['team', 10]], label);
    assert.deepEqual(partners.team.map(sale => sale.checkoutId), [now.id], `${label}: only the owner’s to pay`);
    // Creem accepted COACH_ANNA on the 1.27 checkout: the code is confirmed.
    assert.deepEqual(partners.team[0].checks.filter(check => check === 'code'), [], label);
    assert.equal(partners.codeChecks.COACH_ANNA, 'creem', label);
  }
});

test('the owner marks an earned team commission as paid, and can undo it (memory and D1)', async t => {
  await bothStores(t, async (label, store) => {
    const { api, creem } = setup({ store, creem: fakeCreem({ mode: 'prod', vat: 20 }) });
    const team = await buy(api, creem, { item: 'gift', plan: 'up-to-10', currency: 'EUR', ref: 'COACH_ANNA' });
    assert.equal((await api(post('purchases/claim', { checkout: team.id, expect: 'gift' }))).status, 200, label);
    const payout = (handle, body, token = 'secret') => handle(request('POST', 'admin/partners/payouts', body, token));
    const reject = (handle, body, token = 'secret') => handle(request('POST', 'admin/partners/rejections', body, token));
    // Owner only.
    assert.equal((await payout(api, { checkout: team.id }, '')).status, 401, label);
    assert.equal((await payout(api, { checkout: team.id }, 'wrong')).status, 401, label);
    // Still within its refund period: not earned yet.
    const early = await asJson(await payout(api, { checkout: team.id }));
    assert.equal(early.status, 409, label);
    assert.match(early.body.error, /14-day refund period/, label);
    // Fifteen days later it is earned, listed to pay, and can be marked as paid.
    const later = createPlannerApi({ store, adminToken: 'secret', now: () => new Date(START + 15 * DAY), authFailureDelayMs: 0 });
    const before = (await asJson(await later(get('admin/summary', 'secret')))).body;
    assert.equal(before.partnerCommissionsUnavailable, false, label);
    // Nothing confirmed COACH_ANNA (no sale credited by Creem yet): to check in Creem before paying.
    assert.deepEqual(before.partners.toPay.map(row => [row.checkoutId, row.code, row.commission, row.currency, row.checks]), [[team.id, 'COACH_ANNA', 1625, 'EUR', ['code']]], label);
    assert.equal(before.partners.totals.team.toCheck, 1, label);
    assert.deepEqual(before.partnerProgram, { rate: 25, teamRate: 10, refundDays: 14, cookieDays: 30, minimumPayout: { EUR: 50, USD: 50 }, individualYearlyCap: { EUR: 300, USD: 300 } }, label);
    assert.equal((await payout(later, { checkout: 'not a checkout' })).status, 400, label);
    assert.equal((await payout(later, { checkout: team.id, note: 'n'.repeat(201) })).status, 400, label);
    assert.equal((await payout(later, { checkout: team.id, amount: '16.25', confirmed: true })).status, 400, `${label}: cents only`);
    const unchecked = await asJson(await payout(later, { checkout: team.id }));
    assert.deepEqual([unchecked.status, unchecked.body.checks], [409, ['code']], label);
    assert.match(unchecked.body.error, /Check that COACH_ANNA is a partner in Creem → Affiliate Hub before paying/, label);
    const paid = await asJson(await payout(later, { checkout: team.id, note: ' SEPA  0042 ', confirmed: true }));
    assert.equal(paid.status, 201, `${label}: ${JSON.stringify(paid.body)}`);
    assert.deepEqual(paid.body.payout, { checkoutId: team.id, code: 'COACH_ANNA', amount: 1625, currency: 'EUR', note: 'SEPA 0042', paidAt: new Date(START + 15 * DAY).toISOString() }, label);
    assert.equal((await payout(later, { checkout: team.id })).status, 409, `${label}: once`);
    const after = (await asJson(await later(get('admin/summary', 'secret')))).body.partners;
    assert.deepEqual([after.toPay, after.team[0].status, after.team[0].paidNote, after.totals.team.paid], [[], 'paid', 'SEPA 0042', { EUR: 1625 }], label);
    assert.equal(after.codeChecks.COACH_ANNA, 'paid', `${label}: paid once, so checked`);
    // Undo: earned and to pay again.
    const undo = path => later(request('DELETE', `admin/partners/payouts/${path}`, undefined, 'secret'));
    assert.equal((await undo(team.id)).status, 200, label);
    assert.equal((await undo(team.id)).status, 404, label);
    assert.equal((await undo('x')).status, 404, label);
    assert.equal((await asJson(await later(get('admin/summary', 'secret')))).body.partners.toPay.length, 1, label);
    assert.equal((await later(request('DELETE', `admin/partners/payouts/${team.id}`, undefined, ''))).status, 401, label);
    // Checked in Creem: no such partner. Its commission earns nothing, and Undo brings it back.
    assert.equal((await reject(later, { code: 'COACH_ANNA' }, '')).status, 401, label);
    assert.equal((await reject(later, { code: 'not a code!' })).status, 400, label);
    const rejected = await asJson(await reject(later, { code: ' COACH_ANNA ' }));
    assert.deepEqual([rejected.status, rejected.body.rejection], [201, { code: 'COACH_ANNA', createdAt: new Date(START + 15 * DAY).toISOString() }], label);
    assert.equal((await reject(later, { code: 'COACH_ANNA' })).status, 409, `${label}: once`);
    const off = (await asJson(await later(get('admin/summary', 'secret')))).body.partners;
    assert.deepEqual([off.toPay, off.team[0].status, off.codeChecks.COACH_ANNA], [[], 'not-partner', 'rejected'], label);
    assert.equal((await payout(later, { checkout: team.id, confirmed: true })).status, 409, label);
    const unreject = path => later(request('DELETE', `admin/partners/rejections/${path}`, undefined, 'secret'));
    assert.equal((await unreject('COACH_ANNA')).status, 200, label);
    assert.equal((await unreject('COACH_ANNA')).status, 404, label);
    assert.equal((await unreject('%E0%A4%A')).status, 404, `${label}: never throws`);
    assert.equal((await asJson(await later(get('admin/summary', 'secret')))).body.partners.toPay.length, 1, label);
  });
});

test('a team commission whose tax or refund isn’t known is marked as paid with what the owner paid (memory and D1)', async t => {
  await bothStores(t, async (label, store) => {
    const { api, creem } = setup({ store, creem: fakeCreem({ mode: 'prod' }) });
    // No VAT in the fake order: Creem gave no tax_amount, so 10% of $195 paid is only an upper bound.
    const team = await buy(api, creem, { item: 'gift', plan: 'up-to-10', currency: 'EUR', ref: 'COACH_ANNA' });
    assert.equal((await api(post('purchases/claim', { checkout: team.id, expect: 'gift' }))).status, 200, label);
    const later = createPlannerApi({ store, adminToken: 'secret', now: () => new Date(START + 15 * DAY), authFailureDelayMs: 0 });
    const toPay = (await asJson(await later(get('admin/summary', 'secret')))).body.partners.toPay;
    assert.deepEqual(toPay.map(row => [row.commission, row.exact, row.basis, row.checks]), [[1950, false, 'paid', ['code', 'tax']]], label);
    const payout = body => later(request('POST', 'admin/partners/payouts', { checkout: team.id, confirmed: true, ...body }, 'secret'));
    const missing = await asJson(await payout({}));
    assert.deepEqual([missing.status, /at most €19\.50/.test(missing.body.error)], [400, true], label);
    assert.equal((await payout({ amount: 1951 })).status, 400, label);
    const paid = await asJson(await payout({ amount: 1625, note: 'SEPA 7' }));
    assert.deepEqual([paid.status, paid.body.payout.amount], [201, 1625], label);
    const after = (await asJson(await later(get('admin/summary', 'secret')))).body.partners;
    assert.deepEqual([after.team[0].status, after.team[0].paidAmount, after.totals.team.paid], ['paid', 1625, { EUR: 1625 }], label);
  });
});

test('without migration 0007, sales are still recorded and listed (on the amount paid), and the card says so', async t => {
  const d1 = await openSqlite(t, ALL_MIGRATIONS.filter(file => file !== '0007_partner_commissions.sql'));
  if (!d1) return;
  const { api, creem, warnings } = setup({ store: createD1Store(d1), creem: fakeCreem({ mode: 'prod', vat: 20 }) });
  const team = await buy(api, creem, { item: 'gift', plan: 'up-to-10', currency: 'EUR', ref: 'COACH_ANNA' });
  assert.equal((await api(post('purchases/claim', { checkout: team.id, expect: 'gift' }))).status, 200);
  assert.deepEqual(warnings, []);
  const summary = (await asJson(await api(get('admin/summary', 'secret')))).body;
  assert.equal(summary.partnersUnavailable, false);
  assert.equal(summary.partnerCommissionsUnavailable, true);
  assert.deepEqual(summary.partners.team.map(sale => [sale.commission, sale.basis]), [[1950, 'paid']]);
  const marked = await asJson(await api(request('POST', 'admin/partners/payouts', { checkout: team.id }, 'secret')));
  assert.equal(marked.status, 503, 'nowhere to keep it');
  assert.match(marked.body.error, /Apply every file in migrations\//);
  // A team request with a partner code is stored all the same, without the code.
  assert.equal((await api(post('teams', teamBody({ ref: 'COACH_ANNA' })))).status, 201);
  assert.deepEqual((await asJson(await api(get('admin/teams', 'secret')))).body.rows.map(row => [row.company, row.ref]), [['Acme', '']]);
});

/** A team request as the Teams page sends it. */
const teamBody = (extra = {}) => ({ email: 'lead@acme.example', name: 'Ada', company: 'Acme', teamSize: 25, timing: 'q1-2027', plan: 'up-to-50', currency: 'EUR', kind: 'invoice', message: '', consent: true, version: '1.27.0', source: 'landing', ...extra });

test('a team request keeps the partner code it came with, and the owner sees it (memory and D1)', async t => {
  const now = new Date(START);
  assert.equal(validateTeamRequest(teamBody({ ref: 'COACH_ANNA' }), now).entry.ref, 'COACH_ANNA');
  for (const ref of ['', ' ', 'a', 'x'.repeat(65), 'bad code', '<b>', 42, null, { code: 'X' }]) {
    const { entry, error } = validateTeamRequest(teamBody({ ref }), now);
    assert.equal(error, undefined, `${String(ref)}: never refused`);
    assert.equal('ref' in entry, false, `${String(ref)}: left out`);
  }
  assert.equal(validateTeamRequest(teamBody({ ref: ' CAMILLE ' }), now).entry.ref, 'CAMILLE');
  // The Teams and Contact pages say where a request comes from; anything else reads as the welcome page.
  assert.deepEqual(['teams', 'app', 'contact', 'landing', 'elsewhere', undefined].map(source => validateTeamRequest(teamBody({ source }), now).entry.source), ['teams', 'app', 'contact', 'landing', 'landing', 'landing']);
  // Nothing checks the code (anyone can type one in a link): the owner is told to check it before paying.
  assert.equal(teamRequestPartnerLine('COACH_ANNA'), 'COACH_ANNA — 10% if this becomes an order. Check that COACH_ANNA is a partner in Creem → Affiliate Hub before paying.');
  assert.equal(teamRequestPartnerLine(''), '');
  const email = teamRequestEmail(validateTeamRequest(teamBody({ ref: 'COACH_ANNA' }), now).entry, 'https://planner.test/admin/');
  assert.match(email.text, /\nPartner: COACH_ANNA — 10% if this becomes an order\. Check that COACH_ANNA is a partner in Creem → Affiliate Hub before paying\.\n/);
  assert.match(email.html, /<td[^>]*>Partner<\/td><td[^>]*><b>COACH_ANNA — 10% if this becomes an order\. Check that COACH_ANNA is a partner in Creem → Affiliate Hub before paying\.<\/b><\/td>/);
  assert.doesNotMatch(teamRequestEmail(validateTeamRequest(teamBody(), now).entry).text, /Partner/);
  await bothStores(t, async (label, store) => {
    const { api } = setup({ store });
    assert.equal((await api(post('teams', teamBody({ ref: 'COACH_ANNA' })))).status, 201, label);
    assert.equal((await api(post('teams', teamBody({ company: 'Globex', ref: 'not valid!' })))).status, 201, label);
    const rows = (await asJson(await api(get('admin/teams', 'secret')))).body.rows.map(row => [row.company, row.ref]).sort();
    assert.deepEqual(rows, [['Acme', 'COACH_ANNA'], ['Globex', '']], label);
    const summary = (await asJson(await api(get('admin/summary', 'secret')))).body;
    assert.deepEqual(summary.teamRequests.map(row => row.ref).sort(), ['', 'COACH_ANNA'], label);
    const csv = await (await api(get('admin/teams?format=csv', 'secret'))).text();
    assert.match(csv, /,source,ref\n/, label);
    assert.ok(csv.includes(',landing,COACH_ANNA\n'), label);
    // Deleting the request deletes its code too.
    const acme = (await asJson(await api(get('admin/teams', 'secret')))).body.rows.find(row => row.company === 'Acme');
    assert.equal((await api(request('DELETE', `admin/teams/${acme.id}`, undefined, 'secret'))).status, 200, label);
    if (label === 'D1') assert.equal((await store.listTeamRequests()).length, 1);
  });
});

test('the Teams page view and the landing’s way to it are allow-listed counts', async () => {
  for (const name of ['teams_viewed', 'landing_cta_teams', 'partners_viewed', 'partner_cta_clicked']) assert.ok(EVENT_NAMES.has(name), name);
  const { api, store } = setup();
  assert.equal((await api(post('events', { name: 'teams_viewed', version: '1.27.0' }))).status, 204);
  assert.deepEqual(store.data.events.map(row => row.name), ['teams_viewed']);
});
