import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMemoryStore, createPlannerApi } from '../server/planner-api.js';
import { createD1Store } from '../server/d1-store.js';
import { generatePlusKeyPair, verifyLicense } from '../server/licenses.js';
import { checkoutSeal, freeOrder, freeOrderPaid, ORDER_NOT_PAID_RE, parseCreemProducts, readCheckout, webhookSignature } from '../server/creem.js';
import { moneyText, refundScope } from '../server/refunds.js';
import { priceCents } from '../src/lib/pricing.js';

/* Free orders (1.33.2): a one-time 100% discount code on Creem's hosted
   checkout makes a completed checkout whose order is 0. Creem documents an
   order's status as 'pending' or 'paid' only, so a free order counts as paid
   unless its status says it is waiting or failed; it is delivered like any
   other, recorded at 0, and earns a partner nothing. */

const START = Date.parse('2026-10-23T08:00:00Z');
const KEYS = await generatePlusKeyPair();
const PRODUCTS = Object.freeze({ plus: { EUR: 'prod_plus_eur', USD: 'prod_plus_usd' }, gift: { EUR: 'prod_gift_eur', USD: 'prod_gift_usd' } });
const WEBHOOK_SECRET = 'whsec_test_free_orders';
const MIGRATIONS = ['0001_planner_api.sql', '0002_team_requests.sql', '0003_plus.sql', '0004_creem_reviews.sql', '0005_refunds.sql', '0006_partners.sql', '0007_partner_commissions.sql', '0008_partner_profiles.sql'];
const { byId } = parseCreemProducts(PRODUCTS);

const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const request = (method, path, body, token) => new Request(`https://planner.test/api/${path}`, {
  method,
  headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) })
});
const get = (path, token) => request('GET', path, undefined, token);
const post = (path, body = {}) => request('POST', path, body);
const asJson = async response => ({ status: response.status, body: await response.json() });

/**
 * A completed Creem checkout opened by our API (sealed), paid with a one-time
 * 100% code: the order's amounts are 0 unless `amount` says otherwise, and
 * its status is `orderStatus` (null: none at all).
 */
async function checkout(id, { item = 'plus', plan = 'up-to-10', currency = 'EUR', status = 'completed', orderStatus = 'paid', amount = 0, order = {}, ref = '', payout = '', company = 'Acme' } = {}) {
  const rid = `dp_${id.slice(-16).padStart(16, '0')}`;
  const price = priceCents(item, item === 'gift' ? plan : '', currency);
  const kindPlan = item === 'gift' ? { kind: 'gift', plan } : { kind: 'plus', plan: '' };
  const seal = await checkoutSeal(KEYS.signingKey, { ...kindPlan, currency, rid, ref, payout });
  return {
    id, object: 'checkout', mode: 'test', status, units: 1, request_id: rid, product: PRODUCTS[item][currency],
    order: {
      id: `ord_${id}`, object: 'order', ...(orderStatus === null ? {} : { status: orderStatus }), type: 'onetime',
      sub_total: price, discount_amount: price - amount, tax_amount: 0, amount, amount_due: 0, amount_paid: amount, currency, discount: 'dis_free100', ...order
    },
    discount: { id: 'dis_free100', discountCode: 'REVIEW100', name: 'Review', type: 'percentage', amount: 100, duration: 'once' },
    customer: { id: 'cust_1', object: 'customer', email: 'Reviewer@Example.com', country: 'FR' },
    custom_fields: item === 'gift' ? [{ type: 'text', key: 'company', label: 'Company name, shown to your team', optional: true, text: { max_length: 80, value: company } }] : [],
    metadata: { ...kindPlan.kind === 'gift' ? { kind: 'gift', plan, seats: '10' } : { kind: 'plus' }, currency, rid, seal, ...(ref ? { ref } : {}), ...(payout ? { payout } : {}) }
  };
}

function fakeCreem({ checkouts = {}, transactions = {} } = {}) {
  const calls = [];
  const fetch = async url => {
    const target = new URL(url);
    calls.push(target.pathname);
    if (target.pathname === '/v1/transactions') {
      const id = target.searchParams.get('transaction_id');
      return Object.hasOwn(transactions, id) ? jsonResponse(200, transactions[id]) : jsonResponse(404, { message: ['Transaction not found'] });
    }
    const id = target.searchParams.get('checkout_id');
    return Object.hasOwn(checkouts, id) ? jsonResponse(200, checkouts[id]) : jsonResponse(404, { message: ['Checkout not found'] });
  };
  return { fetch, calls, checkouts };
}

function fakeResend() {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    return jsonResponse(200, { id: 'x' });
  };
  return { fetch, calls };
}

function setup({ store = createMemoryStore(), creem = fakeCreem(), resend = fakeResend() } = {}) {
  const deferred = [];
  const warnings = [];
  const api = createPlannerApi({
    store, adminToken: 'secret', now: () => new Date(START), authFailureDelayMs: 0,
    plusSigningKey: KEYS.signingKey, creemApiKey: 'creem_test_abc', creemWebhookSecret: WEBHOOK_SECRET, creemProducts: PRODUCTS, creemFetch: creem.fetch,
    resendApiKey: 're_test_key', emailFrom: 'Ben Morin <hello@bemorin.example>', ownerEmail: 'owner@bemorin.example', emailFetch: resend.fetch, emailIntervalMs: 0,
    defer: promise => deferred.push(promise), warn: message => warnings.push(message)
  });
  return { api, store, creem, resend, warnings, settle: () => Promise.all(deferred.splice(0)) };
}

async function openSqlite(t) {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { t.skip('node:sqlite is not available in this Node version'); return null; }
  const sqlite = new DatabaseSync(':memory:');
  for (const migration of MIGRATIONS) sqlite.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
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
const completed = object => ({ id: `evt_${object.id}`, eventType: 'checkout.completed', created_at: START, object });
const buyerEmails = resend => resend.calls.filter(call => call.body.to?.[0] !== 'owner@bemorin.example');

test('a free order counts as paid when its status is paid or one Creem doesn’t document, never when it waits or failed', async () => {
  const read = async options => readCheckout(await checkout('ch_free0000001', options), byId);
  // Creem documents 'pending' and 'paid'; anything else it might give a free order is accepted unless it says it waits or failed.
  for (const status of ['paid', 'completed', 'complete', 'succeeded', 'free', 'PAID', ' Completed ', '', null]) {
    const paid = await read({ orderStatus: status });
    assert.deepEqual([paid.completed, paid.paid, paid.amount, paid.currency], [true, true, 0, 'EUR'], String(status));
  }
  for (const status of ['pending', 'processing', 'unpaid', 'requires_payment', 'incomplete', 'open', 'draft', 'failed', 'declined', 'canceled', 'cancelled', 'void', 'voided', 'expired', 'refunded', 'partially_refunded', 'disputed', 'chargeback', 'reversed', 'PENDING']) {
    assert.equal((await read({ orderStatus: status })).paid, false, status);
    assert.ok(ORDER_NOT_PAID_RE.test(status), status);
  }
  // Only a completed checkout, as before.
  for (const status of ['pending', 'processing', 'expired']) assert.equal((await read({ status, orderStatus: 'completed' })).paid, false, status);
  // Only a free order: something paid or due needs Creem's 'paid'.
  assert.equal((await read({ amount: 2900, orderStatus: 'completed' })).paid, false, 'a paid order Creem doesn’t mark paid');
  assert.equal((await read({ amount: 2900, orderStatus: 'paid' })).paid, true, 'a paid order, as always');
  assert.equal((await read({ orderStatus: 'completed', order: { amount_due: 2900 } })).paid, false, 'still due');
  assert.equal((await read({ orderStatus: 'completed', order: { amount_paid: 100 } })).paid, false, 'something was paid');
  assert.equal((await read({ orderStatus: 'completed', order: { amount: 2900, discount_amount: 0 } })).paid, false, 'a total the discount doesn’t cover');
  assert.equal((await read({ orderStatus: 'completed', order: { amount: 2900, discount_amount: 2900 } })).paid, true, 'Creem’s amount before a 100% discount');
  assert.equal((await read({ orderStatus: 'completed', order: { amount_paid: undefined, amount_due: undefined } })).paid, true, 'only `amount`, at 0');
  assert.equal((await read({ orderStatus: 'completed', order: { amount: undefined, amount_paid: undefined, amount_due: undefined } })).paid, false, 'no amount at all');
  assert.equal((await read({ orderStatus: 'completed', order: { amount: '0', amount_paid: '0' } })).paid, false, 'amounts that aren’t numbers');
  // An order given as an id only can't be read: never paid.
  const idOnly = { ...await checkout('ch_free0000001'), order: 'ord_ch_free0000001' };
  assert.equal(readCheckout(idOnly, byId).paid, false);
  assert.deepEqual([freeOrder(null), freeOrder('ord_x'), freeOrder([]), freeOrderPaid({ amount: 0 }), freeOrderPaid({ amount: 0, status: 'pending' })], [false, false, false, true, false]);
});

test('a free Plus order from the webhook becomes a licence and its email, recorded at 0; a pending one waits (memory and D1)', async t => {
  await bothStores(t, async (label, store) => {
    const { api, resend } = setup({ store });
    // Creem may name the free order's status 'completed': delivered like a paid one.
    assert.deepEqual(await asJson(await sendWebhook(api, completed(await checkout('ch_freeplus0001', { orderStatus: 'completed' })))), { status: 200, body: { received: true } }, label);
    const purchase = await store.getPurchase('ch_freeplus0001');
    assert.deepEqual([purchase?.kind, purchase?.email], ['plus', 'reviewer@example.com'], label);
    const payment = await store.getPayment('ch_freeplus0001');
    assert.deepEqual([payment.amount, payment.currency, payment.kind], [0, 'EUR', 'plus'], `${label}: recorded at 0, not as unknown`);
    assert.ok(payment.emailedAt, label);
    const [email] = buyerEmails(resend);
    assert.deepEqual([email.body.to, email.body.subject], [['reviewer@example.com'], 'Your Daily Planner Plus'], label);
    assert.doesNotMatch(email.body.text, /€|\$|0\.00/, `${label}: the buyer’s email names no amount (Creem’s receipt does)`);
    // The link in the email gives the licence.
    const claimed = await asJson(await api(post('purchases/claim', { checkout: 'ch_freeplus0001' })));
    assert.equal(claimed.status, 200, label);
    assert.equal((await verifyLicense(KEYS.publicKey, claimed.body.license)).id, purchase.licenseId, label);

    // Status 'paid' with 0, as Creem documents it: the same.
    assert.equal((await sendWebhook(api, completed(await checkout('ch_freeplus0002', { orderStatus: 'paid' })))).status, 200, label);
    assert.ok(await store.getPurchase('ch_freeplus0002'), label);
    // Pending: acknowledged, nothing delivered, nobody emailed.
    assert.equal((await sendWebhook(api, completed(await checkout('ch_freeplus0003', { orderStatus: 'pending' })))).status, 200, label);
    assert.equal(await store.getPurchase('ch_freeplus0003'), null, label);
    assert.equal(await store.getPayment('ch_freeplus0003'), null, label);
    assert.equal(buyerEmails(resend).length, 2, label);

    // The sales chart counts the free order, at 0 (apart here: made with a test key, so a test-mode sale).
    const series = (await asJson(await api(get('admin/series?from=2026-10-23&to=2026-10-23', 'secret')))).body;
    const sales = (series.testSales || []).filter(row => row.source === 'creem');
    assert.deepEqual(sales.map(row => [row.kind, row.amount, row.currency]), [['plus', 0, 'EUR'], ['plus', 0, 'EUR']], label);
    assert.deepEqual(series.sales, [], label);
  });
});

test('a free order is claimed from the return page too: completed gives the licence, pending says not complete yet', async () => {
  const creem = fakeCreem({ checkouts: { ch_freeclaim001: await checkout('ch_freeclaim001', { orderStatus: 'completed' }), ch_freeclaim002: await checkout('ch_freeclaim002', { orderStatus: 'pending' }) } });
  const { api, store } = setup({ creem });
  const claimed = await asJson(await api(post('purchases/claim', { checkout: 'ch_freeclaim001' })));
  assert.equal(claimed.status, 200);
  assert.equal((await verifyLicense(KEYS.publicKey, claimed.body.license)).src, 'purchase');
  assert.equal((await store.getPayment('ch_freeclaim001')).amount, 0);
  assert.deepEqual(await asJson(await api(post('purchases/claim', { checkout: 'ch_freeclaim002' }))), { status: 402, body: { error: 'This payment is not complete yet.' } });
  // Once Creem says it is done, the same checkout works.
  creem.checkouts.ch_freeclaim002 = await checkout('ch_freeclaim002', { orderStatus: 'paid' });
  assert.equal((await api(post('purchases/claim', { checkout: 'ch_freeclaim002' }))).status, 200);
});

test('a free gift (custom_price with a 100% code) becomes a working gift link and its email, at 0 (memory and D1)', async t => {
  await bothStores(t, async (label, store) => {
    const { api, resend } = setup({ store });
    assert.equal((await sendWebhook(api, completed(await checkout('ch_freegift0001', { item: 'gift', plan: 'up-to-10', orderStatus: 'completed', company: 'Review Co' })))).status, 200, label);
    const gift = await store.getGiftByCheckout('ch_freegift0001');
    assert.deepEqual([gift.org, gift.seats, gift.amount, gift.currency, gift.source], ['Review Co', 10, 0, 'EUR', 'creem'], label);
    const [email] = buyerEmails(resend);
    assert.equal(email.body.subject, 'Your Daily Planner Plus gift link for Review Co', label);
    assert.doesNotMatch(email.body.text, /€|\$|0\.00/, label);
    // The gift link works: its page answers, and someone activates it.
    const page = await asJson(await api(get(`gifts/${gift.code}`)));
    assert.deepEqual([page.status, page.body.seats, page.body.revoked], [200, 10, undefined], label);
    const redeemed = await asJson(await api(post(`gifts/${gift.code}/redeem`, {})));
    assert.equal(redeemed.status, 200, label);
    assert.equal((await verifyLicense(KEYS.publicKey, redeemed.body.license)).gift !== undefined, true, label);
    // A pending free gift is never created.
    assert.equal((await sendWebhook(api, completed(await checkout('ch_freegift0002', { item: 'gift', orderStatus: 'pending' })))).status, 200, label);
    assert.equal(await store.getGiftByCheckout('ch_freegift0002'), null, label);
  });
});

test('a free order through a partner’s link earns nothing: no partner sale, so no commission to pay (memory and D1)', async t => {
  await bothStores(t, async (label, store) => {
    const { api } = setup({ store });
    // Plus (Creem's affiliate program) and a team gift (the owner pays its partner): both free.
    assert.equal((await sendWebhook(api, completed(await checkout('ch_freeref00001', { orderStatus: 'completed', ref: 'CAMILLE' })))).status, 200, label);
    assert.equal((await sendWebhook(api, completed(await checkout('ch_freeref00002', { item: 'gift', plan: 'up-to-10', orderStatus: 'paid', ref: 'CAMILLE', payout: 'owner' })))).status, 200, label);
    assert.ok(await store.getPurchase('ch_freeref00001'), `${label}: delivered all the same`);
    assert.ok(await store.getGiftByCheckout('ch_freeref00002'), label);
    // The same team gift paid in full is still a sale with a commission.
    const paidGift = await checkout('ch_paidref00003', { item: 'gift', plan: 'up-to-10', amount: priceCents('gift', 'up-to-10', 'EUR'), ref: 'CAMILLE', payout: 'owner' });
    assert.equal((await sendWebhook(api, completed(paidGift))).status, 200, label);
    const sales = await store.listPartnerSales({ limit: 50 });
    assert.deepEqual(sales.map(row => row.checkoutId), ['ch_paidref00003'], `${label}: only the paid sale is the partner’s`);
    // On the dashboard (test mode, so among the test sales): one sale, and no commission row for the free orders.
    const partners = (await asJson(await api(get('admin/summary', 'secret')))).body.partners;
    assert.deepEqual([partners.totals.sales, partners.totals.test.sales], [0, 1], label);
    assert.deepEqual(partners.recent.map(sale => [sale.checkoutId, sale.program, sale.commission > 0]), [['ch_paidref00003', 'team', true]], label);
  });
});

test('a refund of a free order is full, switches it off and reads €0.00 in the owner’s email', async () => {
  const transaction = { id: 'tran_free01', object: 'transaction', order: 'ord_ch_freerefund01', status: 'refunded', amount: 0, amount_paid: 0, refunded_amount: 0, currency: 'EUR', mode: 'test' };
  const creem = fakeCreem({ transactions: { tran_free01: transaction } });
  const { api, store, resend, settle } = setup({ creem });
  assert.equal((await sendWebhook(api, completed(await checkout('ch_freerefund01', { orderStatus: 'completed' })))).status, 200);
  const event = {
    id: 'evt_ref_free01', eventType: 'refund.created', created_at: START,
    object: { id: 'ref_free01', object: 'refund', status: 'succeeded', refund_amount: 0, refund_currency: 'EUR', reason: 'requested_by_customer', transaction: { id: 'tran_free01', amount: 0, amount_paid: 0, status: 'refunded' }, customer: { id: 'cust_1', email: 'reviewer@example.com' }, created_at: START + 60000 }
  };
  assert.deepEqual(await asJson(await sendWebhook(api, event)), { status: 200, body: { received: true } });
  const refund = await store.getRefund('ref_free01');
  assert.deepEqual([refund.amount, refund.fullRefund, refund.scope, refund.checkoutId], [0, true, 'full', 'ch_freerefund01']);
  assert.equal((await api(post('purchases/claim', { checkout: 'ch_freerefund01' }))).status, 410, 'the link no longer works');
  await settle();
  const notice = resend.calls.find(call => call.body.to?.[0] === 'owner@bemorin.example');
  assert.equal(notice.body.subject, 'Refund: Daily Planner Plus (€0.00)');
  // Without the transaction's status, the amounts decide: 0 refunded of 0 paid is the whole of it.
  assert.equal(refundScope({ kind: 'refund', amount: 0, amountPaid: 0 }), 'full');
  assert.equal(refundScope({ kind: 'refund', amount: 0, amountPaid: 2900 }), 'partial', 'a refund of nothing on a paid order revokes nothing');
  assert.deepEqual([moneyText(0, 'EUR'), moneyText(0, 'USD')], ['€0.00', '$0.00']);
});
