import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMemoryStore, createPlannerApi } from '../server/planner-api.js';
import { createD1Store } from '../server/d1-store.js';
import { generatePlusKeyPair, giftRef, signLicense, verifyLicense } from '../server/licenses.js';
import { checkoutSeal, readCheckout, parseCreemProducts, webhookSignature } from '../server/creem.js';
import { isoTime, readRefundEvent, readTransaction, refundNoticeEmail, refundScope, refundWaitingEmail, revocationTarget, shownScope } from '../server/refunds.js';
import { priceCents } from '../src/lib/pricing.js';

const START = Date.parse('2026-10-19T08:00:00Z');
const KEYS = await generatePlusKeyPair();
const OTHER_KEYS = await generatePlusKeyPair();
const PRODUCTS = Object.freeze({ plus: { EUR: 'prod_plus_eur', USD: 'prod_plus_usd' }, gift: { EUR: 'prod_gift_eur', USD: 'prod_gift_usd' } });
const WEBHOOK_SECRET = 'whsec_test_refunds';
const ALL_MIGRATIONS = ['0001_planner_api.sql', '0002_team_requests.sql', '0003_plus.sql', '0004_creem_reviews.sql', '0005_refunds.sql'];
const REFUNDED = 'This purchase was refunded, so it can’t be activated any more. If this is a mistake, reply to your receipt email.';
const SWITCHED_OFF = 'This purchase was switched off, so it can’t be activated any more. If this is a mistake, reply to your receipt email.';
/** A refund row as stored, with the defaults of a processed one. */
const refundRow = fields => ({ orderId: '', transactionId: '', checkoutId: '', item: '', amount: null, currency: '', fullRefund: false, scope: '', reason: '', revoked: '', status: '', note: '', attempts: 0, ...fields });

const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const request = (method, path, body, token) => new Request(`https://planner.test/api/${path}`, {
  method,
  headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) })
});
const get = (path, token) => request('GET', path, undefined, token);
const post = (path, body = {}, token) => request('POST', path, body, token);
const del = (path, token) => request('DELETE', path, undefined, token);
const asJson = async response => ({ status: response.status, body: await response.json() });

/** A paid Creem checkout, sealed as POST /api/checkout seals it, with its own order. */
async function checkout(id, { item = 'plus', plan = 'up-to-10', currency = 'EUR', order = `ord_${id}`, company = 'Acme', mode = 'test' } = {}) {
  const rid = `dp_${id.slice(-16).padStart(16, '0')}`;
  const cents = priceCents(item, item === 'gift' ? plan : '', currency);
  const kindPlan = item === 'gift' ? { kind: 'gift', plan } : { kind: 'plus', plan: '' };
  const seal = await checkoutSeal(KEYS.signingKey, { ...kindPlan, currency, rid });
  return {
    id, object: 'checkout', mode, status: 'completed', units: 1, request_id: rid, product: PRODUCTS[item][currency],
    order: { id: order, object: 'order', status: 'paid', type: 'onetime', amount: cents, amount_paid: cents, currency },
    customer: { id: 'cust_1', object: 'customer', email: 'buyer@example.com', country: 'FR' },
    custom_fields: item === 'gift' ? [{ type: 'text', key: 'company', label: 'Company name, shown to your team', optional: true, text: { max_length: 80, value: company } }] : [],
    metadata: item === 'gift' ? { kind: 'gift', plan, seats: '10', currency, rid, seal } : { kind: 'plus', currency, rid, seal }
  };
}

const transaction = (id, order, { status = 'refunded', paid = 2900, refunded = paid, mode = 'test' } = {}) => ({ id, object: 'transaction', order, status, amount: paid, amount_paid: paid, refunded_amount: refunded, currency: 'EUR', mode });
const refundEvent = ({ id = 'ref_1', tran = 'tran_1', amount = 2900, paid = 2900, status = 'refunded', extra = {} } = {}) => ({
  id: `evt_${id}`, eventType: 'refund.created', created_at: START,
  object: { id, object: 'refund', status: 'succeeded', refund_amount: amount, refund_currency: 'EUR', reason: 'requested_by_customer', transaction: { id: tran, amount: paid, amount_paid: paid, status }, customer: { id: 'cust_1', email: 'Buyer@Example.com' }, created_at: START + 60000, ...extra }
});
const disputeEvent = ({ id = 'disp_1', tran = 'tran_1', amount = 2900 } = {}) => ({
  id: `evt_${id}`, eventType: 'dispute.created', created_at: START,
  object: { id, object: 'dispute', amount, currency: 'EUR', transaction: { id: tran, status: 'chargeback' }, customer: { id: 'cust_1', email: 'buyer@example.com' }, created_at: START + 60000 }
});

/** Stand-in for Creem: checkouts and transactions by id; `down` makes transaction reads fail. */
function fakeCreem({ checkouts = {}, transactions = {} } = {}) {
  const calls = [];
  const state = { down: false };
  const fetch = async url => {
    const target = new URL(url);
    calls.push(target.pathname);
    if (target.pathname === '/v1/transactions') {
      if (state.down) return jsonResponse(500, { message: 'Something broke' });
      const id = target.searchParams.get('transaction_id');
      return Object.hasOwn(transactions, id) ? jsonResponse(200, transactions[id]) : jsonResponse(404, { message: ['Transaction not found'] });
    }
    const id = target.searchParams.get('checkout_id');
    return Object.hasOwn(checkouts, id) ? jsonResponse(200, checkouts[id]) : jsonResponse(404, { message: ['Checkout not found'] });
  };
  return { fetch, calls, checkouts, transactions, state, reads: path => calls.filter(item => item === path).length };
}

function fakeResend() {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    return jsonResponse(200, { id: 'x' });
  };
  return { fetch, calls };
}

function setup({ store = createMemoryStore(), creem = fakeCreem(), resend = fakeResend(), ...options } = {}) {
  const deferred = [];
  const warnings = [];
  const api = createPlannerApi({
    store, adminToken: 'secret', now: () => new Date(START), authFailureDelayMs: 0,
    plusSigningKey: KEYS.signingKey, creemApiKey: 'creem_test_abc', creemWebhookSecret: WEBHOOK_SECRET, creemProducts: PRODUCTS, creemFetch: creem.fetch,
    resendApiKey: 're_test_key', emailFrom: 'Ben Morin <hello@bemorin.example>', ownerEmail: 'owner@bemorin.example', emailFetch: resend.fetch, emailIntervalMs: 0,
    defer: promise => deferred.push(promise), warn: message => warnings.push(message),
    ...options
  });
  const settle = () => Promise.all(deferred.splice(0));
  return { api, store, creem, resend, warnings, settle };
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
const completed = object => ({ id: `evt_${object.id}`, eventType: 'checkout.completed', created_at: START, object });
const checkLicense = async (api, license) => asJson(await api(post('plus/check', { license })));
const ownerEmails = resend => resend.calls.filter(call => call.body.to?.[0] === 'owner@bemorin.example');

test('the order of every paid checkout is remembered, from the claim and from the webhook (memory and D1)', async t => {
  await bothStores(t, async (label, store) => {
    const plus = await checkout('ch_ordclaim0001');
    const gift = await checkout('ch_ordhook00001', { item: 'gift' });
    const creem = fakeCreem({ checkouts: { ch_ordclaim0001: plus } });
    const { api } = setup({ store, creem });
    assert.equal((await api(post('purchases/claim', { checkout: 'ch_ordclaim0001' }))).status, 200, label);
    assert.equal((await sendWebhook(api, completed(gift))).status, 200, label);
    assert.deepEqual(await store.getOrder('ord_ch_ordclaim0001'), { orderId: 'ord_ch_ordclaim0001', checkoutId: 'ch_ordclaim0001', kind: 'plus', mode: 'test', createdAt: '2026-10-19T08:00:00.000Z' }, label);
    assert.equal((await store.getOrderByCheckout('ch_ordhook00001')).orderId, 'ord_ch_ordhook00001', label);
    assert.equal((await store.getOrder('ord_ch_ordhook00001')).kind, 'gift', label);
    assert.equal(await store.addOrder({ orderId: 'ord_ch_ordhook00001', checkoutId: 'ch_other', kind: 'plus', createdAt: 'x' }), false, `${label}: one row per order`);
    assert.equal(await store.getOrder('ord_unknown'), null, label);
  });
  // readCheckout reads the order as an expanded object or as an id.
  const { byId } = parseCreemProducts(PRODUCTS);
  assert.equal(readCheckout({ ...await checkout('ch_x00000001'), order: 'ord_plain' }, byId).orderId, 'ord_plain');
  assert.equal(readCheckout({ ...await checkout('ch_x00000001'), order: { id: 'bad id!' } }, byId).orderId, '');
  assert.deepEqual([readCheckout(await checkout('ch_x00000001', { mode: 'LIVE' }), byId).mode, readCheckout({ ...await checkout('ch_x00000001'), mode: 'no way!' }, byId).mode], ['live', '']);
});

test('a purchase made before 1.24 records its order the next time its link is opened', async () => {
  const store = createMemoryStore({ purchases: [{ checkoutRef: 'ch_old00000001', kind: 'plus', licenseId: '0123456789abcdef', claims: 1, email: '', note: '', createdAt: '2026-10-01T08:00:00.000Z' }] });
  const creem = fakeCreem({ checkouts: { ch_old00000001: await checkout('ch_old00000001') } });
  const { api, settle } = setup({ store, creem });
  assert.equal((await api(post('purchases/claim', { checkout: 'ch_old00000001' }))).status, 200);
  await settle();
  assert.deepEqual([(await store.getOrderByCheckout('ch_old00000001')).orderId, (await store.getOrderByCheckout('ch_old00000001')).mode], ['ord_ch_old00000001', 'test']);
  assert.equal((await api(post('purchases/claim', { checkout: 'ch_old00000001' }))).status, 200);
  await settle();
  assert.equal(creem.reads('/v1/checkouts'), 1, 'read once');
});

test('a full refund of Plus refuses the link, revokes the licence and emails the owner; Restore undoes it (memory and D1)', async t => {
  await bothStores(t, async (label, store) => {
    const creem = fakeCreem({ checkouts: { ch_plusrefund01: await checkout('ch_plusrefund01') }, transactions: { tran_plus01: transaction('tran_plus01', 'ord_ch_plusrefund01') } });
    const { api, resend, settle } = setup({ store, creem });
    const claimed = await asJson(await api(post('purchases/claim', { checkout: 'ch_plusrefund01' })));
    assert.equal(claimed.status, 200, label);
    const license = claimed.body.license;
    assert.deepEqual(await checkLicense(api, license), { status: 200, body: { ok: true, revoked: false } }, label);

    assert.deepEqual(await asJson(await sendWebhook(api, refundEvent({ id: 'ref_plus01', tran: 'tran_plus01' }))), { status: 200, body: { received: true } }, label);
    assert.deepEqual(await checkLicense(api, license), { status: 200, body: { ok: true, revoked: true } }, label);
    assert.deepEqual(await asJson(await api(post('purchases/claim', { checkout: 'ch_plusrefund01' }))), { status: 410, body: { error: REFUNDED, refunded: true } }, label);
    const row = await store.getRefund('ref_plus01');
    const { licenseId } = await store.getPurchase('ch_plusrefund01');
    assert.deepEqual(row, refundRow({
      id: 'ref_plus01', kind: 'refund', orderId: 'ord_ch_plusrefund01', transactionId: 'tran_plus01', checkoutId: 'ch_plusrefund01', item: 'plus', amount: 2900, currency: 'EUR',
      fullRefund: true, scope: 'full', reason: 'requested_by_customer', revoked: `checkout:ch_plusrefund01 order:ord_ch_plusrefund01 license:${licenseId}`, createdAt: '2026-10-19T08:01:00.000Z'
    }), label);
    await settle();
    const [notice] = ownerEmails(resend);
    assert.equal(notice.body.subject, 'Refund: Daily Planner Plus (29.00 EUR)', label);
    assert.match(notice.body.text, /Plus was switched off: the activation link no longer works/);
    assert.match(notice.body.text, /Buyer: buyer@example\.com/);
    assert.match(notice.headers['idempotency-key'], /^[0-9a-f]{64}$/);

    // Creem sends the same event again: nothing new, not even a Creem call or an email.
    const reads = creem.reads('/v1/transactions');
    assert.equal((await sendWebhook(api, refundEvent({ id: 'ref_plus01', tran: 'tran_plus01' }))).status, 200, label);
    await settle();
    assert.equal(creem.reads('/v1/transactions'), reads, label);
    assert.equal(ownerEmails(resend).length, 1, `${label}: one email per refund`);
    assert.equal((await store.listRefunds()).length, 1, label);

    const summary = (await asJson(await api(get('admin/summary', 'secret')))).body;
    assert.equal(summary.refundsUnavailable, false, label);
    assert.deepEqual(summary.refunds.map(item => [item.id, item.inForce]), [['ref_plus01', true]], label);
    assert.deepEqual(summary.revocations.map(item => [item.kind, item.label, item.source, item.reason]).sort(), [['checkout', 'ch_plusrefund01', 'ref_plus01', 'refund'], ['license', licenseId, 'ref_plus01', 'refund'], ['order', 'ord_ch_plusrefund01', 'ref_plus01', 'refund']], label);

    assert.deepEqual(await asJson(await api(del('admin/revocations/ref_plus01', 'secret'))), { status: 200, body: { restored: 3 } }, label);
    assert.equal((await store.listRefunds())[0].inForce, false, `${label}: listed as restored`);
    assert.deepEqual((await checkLicense(api, license)).body, { ok: true, revoked: false }, label);
    assert.equal((await api(post('purchases/claim', { checkout: 'ch_plusrefund01' }))).status, 200, `${label}: the link works again`);
    assert.deepEqual(await asJson(await api(del('admin/revocations/ref_plus01', 'secret'))), { status: 404, body: { restored: 0 } }, label);
  });
});

test('a refunded gift is switched off with every licence activated from it, and comes back on with Restore (memory and D1)', async t => {
  await bothStores(t, async (label, store) => {
    const creem = fakeCreem({ checkouts: { ch_giftrefund1: await checkout('ch_giftrefund1', { item: 'gift' }) }, transactions: { tran_gift01: transaction('tran_gift01', 'ord_ch_giftrefund1', { paid: 19500 }) } });
    const { api, resend, settle } = setup({ store, creem });
    const gift = (await asJson(await api(post('purchases/claim', { checkout: 'ch_giftrefund1' })))).body;
    await settle();
    const first = (await asJson(await api(post(`gifts/${gift.code}/redeem`)))).body.license;
    const second = (await asJson(await api(post(`gifts/${gift.code}/redeem`)))).body.license;
    const payload = await verifyLicense(KEYS.publicKey, first);
    assert.equal(payload.gift, await giftRef(KEYS.signingKey, gift.code), `${label}: the licence names its gift by ref`);
    assert.ok(!first.includes(gift.code.replace(/-/g, '')), `${label}: never by its code`);

    assert.equal((await sendWebhook(api, refundEvent({ id: 'ref_gift01', tran: 'tran_gift01', amount: 19500, paid: 19500 }))).status, 200, label);
    for (const license of [first, second]) assert.equal((await checkLicense(api, license)).body.revoked, true, label);
    assert.deepEqual(await asJson(await api(post(`gifts/${gift.code}/redeem`))), { status: 410, body: { error: 'This gift link is no longer active.', revoked: true } }, label);
    const shown = (await asJson(await api(get(`gifts/${gift.code}`)))).body;
    assert.deepEqual([shown.status, shown.available, shown.revoked], ['inactive', false, true], label);
    assert.equal((await api(post('purchases/claim', { checkout: 'ch_giftrefund1', expect: 'gift' }))).status, 410, `${label}: the gift page is refused too`);
    assert.equal((await store.getGift(gift.code.replace(/-/g, ''))).active, false, label);
    // Switching the link back on by hand is not enough while the refund stands.
    assert.equal((await api(request('PATCH', `admin/gifts/${gift.code}`, { active: true }, 'secret'))).status, 200, label);
    assert.equal((await api(post(`gifts/${gift.code}/redeem`))).status, 410, label);
    await settle();
    assert.match(ownerEmails(resend).at(-1).body.text, /The gift link was switched off\. The 2 planners that activated it lose Plus/, label);

    assert.deepEqual(await asJson(await api(del('admin/revocations/ref_gift01', 'secret'))), { status: 200, body: { restored: 3 } }, `${label}: the checkout, its order and the gift`);
    assert.equal((await store.getGift(gift.code.replace(/-/g, ''))).active, true, label);
    assert.equal((await checkLicense(api, first)).body.revoked, false, label);
    assert.equal((await api(post(`gifts/${gift.code}/redeem`))).status, 200, `${label}: activations work again`);
    assert.equal((await asJson(await api(get(`gifts/${gift.code}`)))).body.revoked, undefined, label);
  });
});

test('a partial refund revokes nothing and asks the owner; the refund that completes it does (memory and D1)', async t => {
  await bothStores(t, async (label, store) => {
    const creem = fakeCreem({ checkouts: { ch_partial0001: await checkout('ch_partial0001') }, transactions: { tran_part01: transaction('tran_part01', 'ord_ch_partial0001', { status: 'partialRefund', refunded: 1000 }) } });
    const { api, resend, settle } = setup({ store, creem });
    const license = (await asJson(await api(post('purchases/claim', { checkout: 'ch_partial0001' })))).body.license;
    assert.equal((await sendWebhook(api, refundEvent({ id: 'ref_part01', tran: 'tran_part01', amount: 1000, status: 'partialRefund' }))).status, 200, label);
    assert.equal((await checkLicense(api, license)).body.revoked, false, label);
    assert.equal((await api(post('purchases/claim', { checkout: 'ch_partial0001' }))).status, 200, label);
    const row = await store.getRefund('ref_part01');
    assert.deepEqual([row.fullRefund, row.item, row.revoked, row.amount], [false, 'plus', '', 1000], label);
    await settle();
    assert.equal(ownerEmails(resend).at(-1).body.subject, 'Partial refund to check: Daily Planner Plus (10.00 EUR of 29.00 EUR)', label);
    assert.match(ownerEmails(resend).at(-1).body.text, /Nothing was switched off/);
    // The rest is refunded later: Creem now reports the transaction as refunded.
    creem.transactions.tran_part01 = transaction('tran_part01', 'ord_ch_partial0001', { status: 'refunded', refunded: 2900 });
    assert.equal((await sendWebhook(api, refundEvent({ id: 'ref_part02', tran: 'tran_part01', amount: 1900, status: 'partialRefund' }))).status, 200, label);
    assert.equal((await checkLicense(api, license)).body.revoked, true, label);
    assert.equal((await store.getRefund('ref_part02')).fullRefund, true, label);
  });
});

test('a dispute revokes like a full refund (memory and D1)', async t => {
  await bothStores(t, async (label, store) => {
    const creem = fakeCreem({ checkouts: { ch_dispute0001: await checkout('ch_dispute0001') }, transactions: { tran_disp01: transaction('tran_disp01', 'ord_ch_dispute0001', { status: 'chargedBack', refunded: 0 }) } });
    const { api, resend, settle } = setup({ store, creem });
    const license = (await asJson(await api(post('purchases/claim', { checkout: 'ch_dispute0001' })))).body.license;
    assert.equal((await sendWebhook(api, disputeEvent({ id: 'disp_01', tran: 'tran_disp01' }))).status, 200, label);
    assert.equal((await checkLicense(api, license)).body.revoked, true, label);
    const row = await store.getRefund('disp_01');
    assert.deepEqual([row.kind, row.fullRefund, row.item], ['dispute', true, 'plus'], label);
    await settle();
    assert.equal(ownerEmails(resend).at(-1).body.subject, 'Dispute: Daily Planner Plus (29.00 EUR)', label);
    assert.match(ownerEmails(resend).at(-1).body.text, /Answer the dispute in Creem/);
  });
});

test('a refund that matches no purchase is recorded, answered 200 and shown, with nothing switched off', async () => {
  const creem = fakeCreem({ transactions: { tran_foreign: transaction('tran_foreign', 'ord_not_ours') } });
  const { api, store, resend, warnings, settle } = setup({ creem });
  assert.deepEqual(await asJson(await sendWebhook(api, refundEvent({ id: 'ref_unknown1', tran: 'tran_unknown' }))), { status: 200, body: { received: true } });
  assert.equal((await sendWebhook(api, refundEvent({ id: 'ref_foreign1', tran: 'tran_foreign' }))).status, 200);
  assert.deepEqual((await store.getRefund('ref_unknown1')), refundRow({ id: 'ref_unknown1', kind: 'refund', transactionId: 'tran_unknown', amount: 2900, currency: 'EUR', fullRefund: true, scope: 'full', reason: 'requested_by_customer', createdAt: '2026-10-19T08:01:00.000Z' }));
  const foreign = await store.getRefund('ref_foreign1');
  assert.deepEqual([foreign.orderId, foreign.item, foreign.checkoutId], ['ord_not_ours', '', '']);
  assert.match(warnings.join('\n'), /ref_unknown1 \(transaction tran_unknown, order unknown\) matches no purchase/);
  // Nothing is switched off; only the order is held back, should it ever be delivered here.
  assert.deepEqual(store.data.revocations.map(row => [row.target, row.source]), [['order:ord_not_ours', 'ref_foreign1']]);
  assert.equal(foreign.revoked, 'order:ord_not_ours');
  await settle();
  assert.equal(ownerEmails(resend)[0].body.subject, 'Refund not matched (29.00 EUR)');
  assert.match(ownerEmails(resend)[0].body.text, /paste its checkout id \(ch_…\), the gift code or the licence id/);
  assert.doesNotMatch(ownerEmails(resend)[0].body.text, /will not be delivered/, 'no order known: nothing held back');
  assert.match(ownerEmails(resend)[1].body.text, /If it paid for a purchase that has not been delivered yet, it will not be delivered/);
  // No id at all: acknowledged, nothing recorded. Not a refund event: ignored as before.
  const blank = refundEvent();
  delete blank.id;
  delete blank.object.id;
  assert.equal((await sendWebhook(api, blank)).status, 200);
  assert.match(warnings.at(-1), /refund without an id/);
  assert.equal(store.data.refunds.length, 2);
  // Without a Creem key the transaction can't be read: recorded as not matched.
  const offline = setup({ creemApiKey: '', creem: fakeCreem() });
  assert.equal((await sendWebhook(offline.api, refundEvent({ id: 'ref_nokey01' }))).status, 200);
  assert.equal(offline.creem.calls.length, 0);
  assert.equal((await offline.store.getRefund('ref_nokey01')).item, '');
});

test('a refund whose transaction Creem can’t read is kept as waiting, answered 502 and emailed once if Creem’s next try fails too (memory and D1)', async t => {
  await bothStores(t, async (label, store) => {
    const creem = fakeCreem({ checkouts: { ch_retry000001: await checkout('ch_retry000001') }, transactions: { tran_retry: transaction('tran_retry', 'ord_ch_retry000001') } });
    const { api, resend, warnings, settle } = setup({ store, creem });
    const license = (await asJson(await api(post('purchases/claim', { checkout: 'ch_retry000001' })))).body.license;
    creem.state.down = true;
    assert.equal((await sendWebhook(api, refundEvent({ id: 'ref_retry1', tran: 'tran_retry' }))).status, 502, label);
    assert.match(warnings.at(-1), /tran_retry not read: Creem answered HTTP 500/);
    const waiting = await store.getRefund('ref_retry1');
    assert.deepEqual([waiting.status, waiting.attempts, waiting.revoked, waiting.item, waiting.amount], ['pending', 1, '', '', 2900], `${label}: listed as waiting`);
    assert.match(waiting.note, /^Creem’s transaction could not be read: Creem answered HTTP 500/, label);
    assert.equal((await checkLicense(api, license)).body.revoked, false, `${label}: nothing switched off yet`);
    await settle();
    assert.equal(ownerEmails(resend).length, 0, `${label}: not after the first failure`);
    const summary = (await asJson(await api(get('admin/summary', 'secret')))).body;
    assert.equal(summary.refunds[0].status, 'pending', `${label}: the dashboard shows it`);

    // Creem's next try fails too: the owner is told, once.
    assert.equal((await sendWebhook(api, refundEvent({ id: 'ref_retry1', tran: 'tran_retry' }))).status, 502, label);
    assert.equal((await sendWebhook(api, refundEvent({ id: 'ref_retry1', tran: 'tran_retry' }))).status, 502, label);
    await settle();
    assert.equal((await store.getRefund('ref_retry1')).attempts, 3, label);
    const [waitingEmail, ...more] = ownerEmails(resend);
    assert.equal(more.length, 0, `${label}: once per refund`);
    assert.equal(waitingEmail.body.subject, 'Refund waiting: Creem’s transaction could not be read (29.00 EUR)', label);
    assert.match(waitingEmail.body.text, /could not be read from Creem, twice \(Creem answered HTTP 500/);
    assert.match(waitingEmail.body.text, /Refunds and disputes → Revoke/);

    // Creem reads again: processed as usual, with the usual email.
    creem.state.down = false;
    assert.equal((await sendWebhook(api, refundEvent({ id: 'ref_retry1', tran: 'tran_retry' }))).status, 200, label);
    assert.equal((await checkLicense(api, license)).body.revoked, true, label);
    const done = await store.getRefund('ref_retry1');
    assert.deepEqual([done.status, done.note, done.item, done.fullRefund, done.attempts], ['', '', 'plus', true, 3], label);
    await settle();
    assert.deepEqual(ownerEmails(resend).map(call => call.body.subject), ['Refund waiting: Creem’s transaction could not be read (29.00 EUR)', 'Refund: Daily Planner Plus (29.00 EUR)'], label);
    assert.notEqual(ownerEmails(resend)[0].headers['idempotency-key'], ownerEmails(resend)[1].headers['idempotency-key'], label);
    assert.equal((await sendWebhook(api, refundEvent({ id: 'ref_retry1', tran: 'tran_retry' }))).status, 200, `${label}: then once only`);
    await settle();
    assert.equal(ownerEmails(resend).length, 2, label);
  });
  const waiting = refundWaitingEmail({ refund: { kind: 'dispute', id: 'disp_w', amount: 500, currency: 'USD', transactionId: 'tran_w' }, error: 'Timed out.' });
  assert.match(waiting.text, /twice \(Timed out\)\. Nothing was switched off yet\./);
  assert.equal(waiting.subject, 'Dispute waiting: Creem’s transaction could not be read (5.00 USD)');
  assert.match(waiting.text, /Dispute: disp_w/);
});

test('POST /api/plus/check reads only the licence: valid, revoked, forged or from another key', async () => {
  const { api } = setup();
  const manual = await signLicense(KEYS.signingKey, { src: 'manual', id: 'aaaaaaaaaaaaaaaa' });
  const giftLicense = await signLicense(KEYS.signingKey, { src: 'gift', id: 'bbbbbbbbbbbbbbbb', gift: 'cccccccccccccccc', org: 'Acme' });
  assert.deepEqual(await checkLicense(api, manual), { status: 200, body: { ok: true, revoked: false } });
  const [prefix, body, signature] = manual.split('.');
  const forged = `${prefix}.${Buffer.from(JSON.stringify({ v: 1, p: 'plus', id: 'dddddddddddddddd', src: 'manual', iat: '2026-10-19' })).toString('base64url')}.${signature}`;
  for (const bad of [forged, `${prefix}.${body}`, await signLicense(OTHER_KEYS.signingKey, { src: 'manual' }), 'nope', '', `${manual}${'x'.repeat(2100)}`]) {
    assert.deepEqual(await checkLicense(api, bad), { status: 400, body: { error: 'This licence is not valid.' } }, bad.slice(0, 30));
  }
  assert.equal((await api(post('plus/check', {}))).status, 400);
  assert.equal((await api(get('plus/check'))).status, 405);
  assert.equal((await setup({ plusSigningKey: '' }).api(post('plus/check', { license: manual }))).status, 503);
  // Revoked by licence id, or through the gift ref it carries.
  const { store } = setup();
  const shared = setup({ store });
  await store.addRevocations([{ target: revocationTarget('gift', 'cccccccccccccccc'), source: 'ref_x', kind: 'gift', label: 'ABCD-EFGH-JKMN', reason: 'refund', createdAt: 'x' }]);
  assert.equal((await checkLicense(shared.api, giftLicense)).body.revoked, true);
  assert.equal((await checkLicense(shared.api, manual)).body.revoked, false);
  // CORS like the other public routes.
  const cors = setup({ allowedOrigins: 'https://landing.example' });
  const preflight = await cors.api(new Request('https://planner.test/api/plus/check', { method: 'OPTIONS', headers: { origin: 'https://landing.example' } }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://landing.example');
});

test('the owner revokes by hand — a licence, a whole licence, a purchase or a gift — and restores it', async () => {
  const creem = fakeCreem({ checkouts: { ch_byhand00001: await checkout('ch_byhand00001'), ch_byhandgift1: await checkout('ch_byhandgift1', { item: 'gift' }) } });
  const { api, store } = setup({ creem });
  const made = (await asJson(await api(post('admin/licenses', { note: 'Press' }, 'secret')))).body.license;
  const { id } = await verifyLicense(KEYS.publicKey, made);
  const revoke = async (target, note) => asJson(await api(post('admin/revocations', { target, note }, 'secret')));

  const byId = await revoke(id.toUpperCase(), 'Giveaway ended');
  assert.equal(byId.status, 201);
  assert.match(byId.body.source, /^owner_[0-9a-f]{16}$/);
  assert.equal(byId.body.revoked, 1);
  assert.equal((await checkLicense(api, made)).body.revoked, true);
  assert.deepEqual((await store.listRevocationsBySource(byId.body.source)).map(row => [row.kind, row.label, row.reason, row.note]), [['license', id, 'owner', 'Giveaway ended']]);
  assert.equal((await api(del(`admin/revocations/${byId.body.source}`, 'secret'))).status, 200);
  assert.equal((await checkLicense(api, made)).body.revoked, false);

  assert.equal((await revoke(made)).status, 201, 'a whole licence pasted');
  assert.equal((await checkLicense(api, made)).body.revoked, true);

  const purchase = (await asJson(await api(post('purchases/claim', { checkout: 'ch_byhand00001' })))).body.license;
  assert.equal((await revoke('ch_byhand00001')).body.revoked, 2);
  assert.equal((await checkLicense(api, purchase)).body.revoked, true);
  assert.equal((await api(post('purchases/claim', { checkout: 'ch_byhand00001' }))).status, 410);

  const gift = (await asJson(await api(post('purchases/claim', { checkout: 'ch_byhandgift1' })))).body;
  const giftLicense = (await asJson(await api(post(`gifts/${gift.code}/redeem`)))).body.license;
  const byCode = await revoke(gift.code.toLowerCase());
  assert.equal(byCode.body.revoked, 2, 'the gift and its checkout');
  assert.equal((await checkLicense(api, giftLicense)).body.revoked, true);
  assert.equal((await store.getGift(gift.code.replace(/-/g, ''))).active, false);
  assert.equal((await api(del(`admin/revocations/${byCode.body.source}`, 'secret'))).status, 200);
  assert.equal((await store.getGift(gift.code.replace(/-/g, ''))).active, true, 'Restore switches the link back on');

  for (const [target, status, error] of [
    ['', 400, /Paste a licence id/], ['not a thing!', 400, /Paste a licence id/], ['cs_unknown00001', 404, /No purchase or gift/], ['ABCD-EFGH-JKMN', 404, /No gift has this code/],
    [await signLicense(OTHER_KEYS.signingKey, { src: 'manual' }), 400, /could not be verified/]
  ]) {
    const answer = await revoke(target);
    assert.equal(answer.status, status, target.slice(0, 20));
    assert.match(answer.body.error, error);
  }
  assert.equal((await revoke(id, 'x'.repeat(201))).status, 400, 'note too long');
  assert.equal((await api(post('admin/revocations', { target: id }))).status, 401);
  assert.equal((await api(get('admin/revocations', 'secret'))).status, 405);
  assert.equal((await api(post('admin/revocations/owner_x', {}, 'secret'))).status, 405);
});

test('without migration 0005 everything else works, refunds wait for it and the dashboard says so', async t => {
  const d1 = await openSqlite(t, ALL_MIGRATIONS.slice(0, 4));
  if (!d1) return;
  const store = createD1Store(d1);
  const creem = fakeCreem({ checkouts: { ch_nomigration1: await checkout('ch_nomigration1'), ch_nomiggift01: await checkout('ch_nomiggift01', { item: 'gift' }) }, transactions: { tran_nm: transaction('tran_nm', 'ord_ch_nomigration1') } });
  const { api, warnings } = setup({ store, creem });
  const claimed = await asJson(await api(post('purchases/claim', { checkout: 'ch_nomigration1' })));
  assert.equal(claimed.status, 200, 'a claim still works');
  assert.match(warnings.join('\n'), /Order ord_ch_nomigration1 of ch_nomigration1 not recorded: no such table: orders/);
  assert.deepEqual((await checkLicense(api, claimed.body.license)).body, { ok: true, revoked: false });
  const gift = (await asJson(await api(post('purchases/claim', { checkout: 'ch_nomiggift01' })))).body;
  assert.equal((await api(post(`gifts/${gift.code}/redeem`))).status, 200);
  assert.equal((await asJson(await api(get(`gifts/${gift.code}`)))).body.status, 'available');
  assert.equal((await sendWebhook(api, completed(await checkout('ch_nomighook01')))).status, 200, 'checkout.completed still delivers');
  const summary = await asJson(await api(get('admin/summary', 'secret')));
  assert.equal(summary.status, 200);
  assert.deepEqual([summary.body.refundsUnavailable, summary.body.refunds, summary.body.revocations], [true, [], []]);
  // A refund is answered 503: Creem keeps sending it until the migration is applied.
  const refund = await asJson(await sendWebhook(api, refundEvent({ id: 'ref_nm1', tran: 'tran_nm' })));
  assert.equal(refund.status, 503);
  assert.match(refund.body.error, /A database table is missing/);
});

test('refund events, transactions and scopes are read defensively', () => {
  const event = refundEvent({ id: 'ref_read1', tran: 'tran_read1', amount: 1500 });
  assert.deepEqual(readRefundEvent(event, 'now'), {
    kind: 'refund', id: 'ref_read1', transactionId: 'tran_read1', orderId: '', checkoutId: '', amount: 1500, currency: 'EUR', reason: 'requested_by_customer',
    transactionStatus: 'refunded', amountPaid: 2900, customerEmail: 'buyer@example.com', mode: '', createdAt: '2026-10-19T08:01:00.000Z'
  });
  assert.equal(readRefundEvent(refundEvent({ extra: { mode: 'Live' } })).mode, 'live');
  const dispute = readRefundEvent(disputeEvent({ id: 'disp_read1' }));
  assert.deepEqual([dispute.kind, dispute.id, dispute.amount, dispute.currency, dispute.transactionStatus], ['dispute', 'disp_read1', 2900, 'EUR', 'chargeback']);
  assert.equal(readRefundEvent({ eventType: 'checkout.completed', object: {} }), null);
  assert.equal(readRefundEvent(null), null);
  // Older `type` / `data` names, an expanded order, an id-less object (the event id is used) and junk.
  const older = readRefundEvent({ id: 'evt_9', type: 'refund.created', data: { object: { transaction: 'tran_x', order: { id: 'ord_9' }, refund_amount: '12', reason: 'a\nb', created_at: 1760860800 } } }, 'fallback');
  assert.deepEqual([older.id, older.transactionId, older.orderId, older.amount, older.reason, older.createdAt], ['evt_9', 'tran_x', 'ord_9', null, 'a b', '2025-10-19T08:00:00.000Z']);
  assert.equal(readRefundEvent({ eventType: 'refund.created', object: { id: 'bad id!', created_at: 'nonsense' } }, 'fallback').createdAt, 'fallback');
  assert.equal(readRefundEvent({ eventType: 'refund.created', object: { id: 'bad id!' } }).id, '');
  assert.deepEqual(readTransaction(transaction('tran_1', 'ord_1', { status: 'partialRefund', refunded: 500 })), { orderId: 'ord_1', status: 'partialRefund', amountPaid: 2900, refundedAmount: 500, currency: 'EUR', mode: 'test' });
  assert.deepEqual(readTransaction({ order: { id: 'ord_2' } }), { orderId: 'ord_2', status: '', amountPaid: null, refundedAmount: null, currency: '', mode: '' });
  assert.equal(isoTime(START, 'x'), '2026-10-19T08:00:00.000Z');
  assert.equal(isoTime('2026-10-19T08:00:00Z', 'x'), '2026-10-19T08:00:00.000Z');
  assert.equal(isoTime(-5, 'x'), 'x');

  const refund = amount => ({ kind: 'refund', amount, amountPaid: 2900, transactionStatus: '' });
  assert.equal(refundScope({ kind: 'dispute' }), 'full');
  assert.equal(refundScope(refund(1000), { status: 'refunded' }), 'full', 'Creem’s status wins');
  assert.equal(refundScope(refund(2900), { status: 'partialRefund' }), 'partial');
  assert.equal(refundScope(refund(2900)), 'full');
  assert.equal(refundScope(refund(1000)), 'partial');
  assert.equal(refundScope(refund(1000), { refundedAmount: 2900 }), 'full', 'earlier partial refunds add up');
  assert.equal(refundScope({ kind: 'refund', amount: 1000, amountPaid: null }), 'unclear');
  assert.equal(refundScope({ kind: 'refund', transactionStatus: 'chargedBack' }), 'full');
  // What is shown: this event's own amount, even when the transaction is now refunded in full.
  assert.equal(shownScope(refund(1000), { status: 'refunded' }), 'completes');
  assert.equal(shownScope(refund(1000), { refundedAmount: 2900 }), 'completes');
  assert.equal(shownScope(refund(2900), { status: 'refunded' }), 'full');
  assert.equal(shownScope(refund(1000)), 'partial');
  assert.equal(shownScope({ kind: 'dispute', amount: 100, amountPaid: 2900 }), 'full', 'a dispute is a dispute');
  assert.equal(shownScope({ kind: 'refund', transactionStatus: 'refunded', amount: null }), 'full', 'no amount: nothing to compare');

  const unclear = refundNoticeEmail({ refund: { kind: 'refund', id: 'ref_u', amount: 1000, currency: 'EUR' }, scope: 'unclear', match: { item: 'gift', giftCode: 'ABCD-EFGH-JKMN', giftOrg: 'Acme <b>', checkoutId: 'ch_1' } });
  assert.equal(unclear.subject, 'Refund to check: gift ABCD-EFGH-JKMN (10.00 EUR)');
  assert.match(unclear.text, /could not tell whether the refund was full\. Nothing was switched off/);
  assert.match(unclear.text, /lower the seats of the gift/);
  assert.match(unclear.html, /Acme &lt;b&gt;/);
});

test('licences from a gift carry its ref; other licences keep their shape', async () => {
  const ref = await giftRef(KEYS.signingKey, 'abcd-efgh-jkmn');
  assert.match(ref, /^[0-9a-f]{16}$/);
  assert.equal(await giftRef(KEYS.signingKey, 'ABCDEFGHJKMN'), ref, 'dashes and case do not matter');
  assert.notEqual(await giftRef(OTHER_KEYS.signingKey, 'ABCDEFGHJKMN'), ref, 'it depends on the signing key');
  assert.notEqual(await giftRef(KEYS.signingKey, 'ABCDEFGHJKMP'), ref);
  assert.equal(await giftRef('', 'ABCDEFGHJKMN'), '');
  const token = await signLicense(KEYS.signingKey, { src: 'gift', id: '0123456789abcdef', gift: ref, org: 'Acme', iat: '2026-10-19' });
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  assert.deepEqual(Object.keys(payload), ['v', 'p', 'id', 'src', 'gift', 'org', 'iat']);
  assert.deepEqual(await verifyLicense(KEYS.publicKey, token), payload);
  await assert.rejects(signLicense(KEYS.signingKey, { src: 'gift', gift: 'ABCDEFGHJKMN' }), /gift ref is 16 hex/);
});

test('a refund that arrives before the purchase is delivered blocks it: no purchase, no email, the link says refunded; Restore lets it through (memory and D1)', async t => {
  await bothStores(t, async (label, store) => {
    const plus = await checkout('ch_early0000001');
    const creem = fakeCreem({ checkouts: { ch_early0000001: plus }, transactions: { tran_early: transaction('tran_early', 'ord_ch_early0000001') } });
    // PLUS_SIGNING_KEY missing for a while: checkout.completed keeps failing, and the buyer never came back.
    const broken = setup({ store, creem, plusSigningKey: '' });
    assert.equal((await sendWebhook(broken.api, completed(plus))).status, 503, label);
    assert.equal((await sendWebhook(broken.api, refundEvent({ id: 'ref_early1', tran: 'tran_early' }))).status, 200, label);
    const unmatched = await store.getRefund('ref_early1');
    assert.deepEqual([unmatched.item, unmatched.checkoutId, unmatched.revoked], ['', '', 'order:ord_ch_early0000001'], `${label}: not matched, its order held back`);

    // The key is back; Creem finally delivers checkout.completed.
    const { api, resend, warnings, settle } = setup({ store, creem });
    assert.deepEqual(await asJson(await sendWebhook(api, completed(plus))), { status: 200, body: { received: true } }, label);
    await settle();
    assert.equal(await store.getPurchase('ch_early0000001'), null, `${label}: nothing delivered`);
    assert.equal(resend.calls.length, 0, `${label}: nobody emailed`);
    assert.match(warnings.join('\n'), /Checkout ch_early0000001 was paid, but refunded before it was delivered \(ref_early1\)/);
    assert.deepEqual(await asJson(await api(post('purchases/claim', { checkout: 'ch_early0000001' }))), { status: 410, body: { error: REFUNDED, refunded: true } }, label);
    const linked = await store.getRefund('ref_early1');
    assert.deepEqual([linked.item, linked.checkoutId, linked.revoked], ['plus', 'ch_early0000001', 'order:ord_ch_early0000001 checkout:ch_early0000001'], `${label}: matched now`);

    assert.deepEqual(await asJson(await api(del('admin/revocations/ref_early1', 'secret'))), { status: 200, body: { restored: 2 } }, label);
    const claimed = await asJson(await api(post('purchases/claim', { checkout: 'ch_early0000001' })));
    assert.equal(claimed.status, 200, `${label}: delivered once restored`);
    assert.ok(claimed.body.license.startsWith('DP1.'), label);
  });
});

test('a gift refunded before it was delivered is never created; its gift page says refunded', async () => {
  const gift = await checkout('ch_earlygift001', { item: 'gift' });
  const creem = fakeCreem({ checkouts: { ch_earlygift001: gift }, transactions: { tran_eg: transaction('tran_eg', 'ord_ch_earlygift001', { paid: 19500 }) } });
  const { api, store, resend, settle } = setup({ creem });
  assert.equal((await sendWebhook(api, refundEvent({ id: 'ref_eg1', tran: 'tran_eg', amount: 19500, paid: 19500 }))).status, 200);
  assert.deepEqual(await asJson(await api(post('purchases/claim', { checkout: 'ch_earlygift001', expect: 'gift' }))), { status: 410, body: { error: REFUNDED, refunded: true } });
  assert.equal(await store.getGiftByCheckout('ch_earlygift001'), null);
  assert.equal((await sendWebhook(api, completed(gift))).status, 200);
  assert.equal(await store.getGiftByCheckout('ch_earlygift001'), null, 'the late webhook delivers nothing either');
  await settle();
  assert.deepEqual(resend.calls.map(call => call.body.to[0]), ['owner@bemorin.example'], 'only the owner’s refund notice');
});

test('the owner can revoke a Creem checkout that has not been delivered yet; it never is, until Restore', async () => {
  const plus = await checkout('ch_ownerearly01');
  const creem = fakeCreem({ checkouts: { ch_ownerearly01: plus } });
  const { api, store, resend, settle } = setup({ creem });
  const revoked = await asJson(await api(post('admin/revocations', { target: 'ch_ownerearly01', note: 'Paid twice' }, 'secret')));
  assert.equal(revoked.status, 201);
  assert.deepEqual([revoked.body.revoked, revoked.body.undelivered], [1, true]);
  assert.equal((await sendWebhook(api, completed(plus))).status, 200);
  assert.equal(await store.getPurchase('ch_ownerearly01'), null);
  await settle();
  assert.equal(resend.calls.length, 0, 'no buyer email');
  assert.deepEqual(await asJson(await api(post('purchases/claim', { checkout: 'ch_ownerearly01' }))), { status: 410, body: { error: SWITCHED_OFF, revoked: true } }, 'switched off, not “refunded”');
  assert.equal((await api(del(`admin/revocations/${revoked.body.source}`, 'secret'))).status, 200);
  assert.equal((await api(post('purchases/claim', { checkout: 'ch_ownerearly01' }))).status, 200);
  // Revoked by hand after delivery: the link says switched off, too.
  assert.equal((await api(post('admin/revocations', { target: 'ch_ownerearly01' }, 'secret'))).status, 201);
  assert.deepEqual(await asJson(await api(post('purchases/claim', { checkout: 'ch_ownerearly01' }))), { status: 410, body: { error: SWITCHED_OFF, revoked: true } });
});

test('an unmatched refund reads the orders of recent checkouts sold before 1.24, a few at a time, and matches (memory and D1)', async t => {
  await bothStores(t, async (label, store) => {
    const checkouts = {};
    for (let index = 0; index < 12; index += 1) {
      const id = `ch_pre124plus${String(index).padStart(2, '0')}`;
      checkouts[id] = await checkout(id);
      await store.addPurchase({ checkoutRef: id, kind: 'plus', licenseId: `00000000000000${String(index).padStart(2, '0')}`, claims: 1, email: '', note: '', createdAt: `2026-09-${String(index + 1).padStart(2, '0')}T08:00:00.000Z` });
    }
    // A gift bought before 1.24, whose buyer only ever used the manage link.
    checkouts.ch_pre124gift01 = await checkout('ch_pre124gift01', { item: 'gift' });
    await store.addGift({ code: 'ABCDEFGHJKMN', org: 'Acme', message: '', seats: 10, redeemed: 3, active: true, currency: 'EUR', amount: 19500, source: 'creem', checkoutRef: 'ch_pre124gift01', buyerEmail: '', note: 'Creem · Up to 10 people', createdAt: '2026-08-01T08:00:00.000Z', expiresAt: '2027-08-01T08:00:00.000Z', emailedAt: null });
    await store.addPurchase({ checkoutRef: 'cs_live_stripe0001', kind: 'plus', licenseId: 'ffffffffffffffff', claims: 1, email: '', note: '', createdAt: '2026-10-01T08:00:00.000Z' });
    const creem = fakeCreem({ checkouts, transactions: { tran_old: transaction('tran_old', 'ord_ch_pre124plus09'), tran_gift: transaction('tran_gift', 'ord_ch_pre124gift01', { paid: 19500 }) } });
    const { api } = setup({ store, creem });
    assert.equal((await sendWebhook(api, refundEvent({ id: 'ref_old1', tran: 'tran_old' }))).status, 200, label);
    const row = await store.getRefund('ref_old1');
    assert.deepEqual([row.item, row.checkoutId], ['plus', 'ch_pre124plus09'], label);
    assert.match(row.revoked, /license:0000000000000009/, label);
    // Newest first, 8 at a time: the 3rd newest is in the first batch, so the rest is not read.
    assert.equal(creem.reads('/v1/checkouts'), 8, `${label}: one batch, then it stops`);
    assert.deepEqual((await store.listCheckoutsWithoutOrder()).map(item => item.checkoutId), ['ch_pre124plus03', 'ch_pre124plus02', 'ch_pre124plus01', 'ch_pre124plus00', 'ch_pre124gift01'], `${label}: never a Stripe session`);

    assert.equal((await sendWebhook(api, refundEvent({ id: 'ref_gift1', tran: 'tran_gift', amount: 19500, paid: 19500 }))).status, 200, label);
    assert.deepEqual([(await store.getRefund('ref_gift1')).item, (await store.getGift('ABCDEFGHJKMN')).active], ['gift', false], `${label}: the old gift matched`);
    assert.equal(creem.reads('/v1/checkouts'), 13, `${label}: only the five left were read`);
    assert.equal((await store.listCheckoutsWithoutOrder()).length, 0, label);
  });
});

test('at most 40 checkouts are read for one unmatched refund', async () => {
  const store = createMemoryStore();
  for (let index = 0; index < 45; index += 1) await store.addPurchase({ checkoutRef: `ch_bulk${String(index).padStart(6, '0')}`, kind: 'plus', licenseId: String(index).padStart(16, '0'), claims: 0, email: '', note: '', createdAt: `2026-09-01T08:${String(index).padStart(2, '0')}:00.000Z` });
  const creem = fakeCreem({ transactions: { tran_none: transaction('tran_none', 'ord_elsewhere') } });
  const { api } = setup({ store, creem });
  assert.equal((await sendWebhook(api, refundEvent({ id: 'ref_none', tran: 'tran_none' }))).status, 200);
  assert.equal(creem.reads('/v1/checkouts'), 40);
  assert.equal((await store.getRefund('ref_none')).item, '');
});

test('a delayed partial refund says what it was, and one Restore undoes the whole payment (memory and D1)', async t => {
  await bothStores(t, async (label, store) => {
    const creem = fakeCreem({ checkouts: { ch_late0000001: await checkout('ch_late0000001') }, transactions: { tran_late: transaction('tran_late', 'ord_ch_late0000001', { status: 'refunded', refunded: 2900 }) } });
    const { api, resend, settle } = setup({ store, creem });
    const license = (await asJson(await api(post('purchases/claim', { checkout: 'ch_late0000001' })))).body.license;
    // 5.00 refunded first, delivered after the 24.00 that completed the refund: Creem already says "refunded".
    assert.equal((await sendWebhook(api, refundEvent({ id: 'ref_late1', tran: 'tran_late', amount: 500, status: 'partialRefund' }))).status, 200, label);
    const first = await store.getRefund('ref_late1');
    assert.deepEqual([first.fullRefund, first.scope, first.amount], [true, 'completes', 500], label);
    assert.equal((await checkLicense(api, license)).body.revoked, true, label);
    await settle();
    const notice = ownerEmails(resend).at(-1).body;
    assert.equal(notice.subject, 'Refund: Daily Planner Plus (5.00 EUR, now refunded in full)', label);
    assert.match(notice.text, /A partial refund of 5\.00 EUR completed a full refund of a Daily Planner Plus purchase \(29\.00 EUR paid\)\./);
    assert.doesNotMatch(notice.text, /refunded .* in full: 5\.00/);

    // The other refund of the same payment: already switched off, so no second decision.
    assert.equal((await sendWebhook(api, refundEvent({ id: 'ref_late2', tran: 'tran_late', amount: 2400, status: 'refunded' }))).status, 200, label);
    const second = await store.getRefund('ref_late2');
    assert.deepEqual([second.fullRefund, second.scope, second.revoked, second.note], [true, 'completes', '', 'Already switched off by an earlier refund or dispute.'], label);
    await settle();
    assert.match(ownerEmails(resend).at(-1).body.text, /already switched off by an earlier refund or dispute/);

    // One click: Plus and the link are back.
    assert.equal((await api(del('admin/revocations/ref_late1', 'secret'))).status, 200, label);
    assert.equal((await checkLicense(api, license)).body.revoked, false, `${label}: one Restore is enough`);
    assert.equal((await api(post('purchases/claim', { checkout: 'ch_late0000001' }))).status, 200, label);
  });
});

test('Restore brings a gift link back exactly as it was before it was revoked (memory and D1)', async t => {
  await bothStores(t, async (label, store) => {
    const creem = fakeCreem({
      checkouts: { ch_giftoff00001: await checkout('ch_giftoff00001', { item: 'gift' }), ch_gifton000001: await checkout('ch_gifton000001', { item: 'gift' }) },
      transactions: { tran_off: transaction('tran_off', 'ord_ch_giftoff00001', { paid: 19500 }), tran_on: transaction('tran_on', 'ord_ch_gifton000001', { paid: 19500 }) }
    });
    const { api } = setup({ store, creem });
    // Switched off by hand first, then refunded, then restored: it stays off.
    const off = (await asJson(await api(post('purchases/claim', { checkout: 'ch_giftoff00001' })))).body.code;
    assert.equal((await api(request('PATCH', `admin/gifts/${off}`, { active: false }, 'secret'))).status, 200, label);
    assert.equal((await sendWebhook(api, refundEvent({ id: 'ref_off', tran: 'tran_off', amount: 19500, paid: 19500 }))).status, 200, label);
    assert.equal((await api(del('admin/revocations/ref_off', 'secret'))).status, 200, label);
    assert.equal((await store.getGift(off.replace(/-/g, ''))).active, false, `${label}: still off, as the owner left it`);

    // On, refunded, then also revoked by hand: on again only once both are restored.
    const on = (await asJson(await api(post('purchases/claim', { checkout: 'ch_gifton000001' })))).body.code;
    assert.equal((await sendWebhook(api, refundEvent({ id: 'ref_on', tran: 'tran_on', amount: 19500, paid: 19500 }))).status, 200, label);
    const byHand = (await asJson(await api(post('admin/revocations', { target: on }, 'secret')))).body.source;
    assert.equal((await api(del('admin/revocations/ref_on', 'secret'))).status, 200, label);
    assert.equal((await store.getGift(on.replace(/-/g, ''))).active, false, `${label}: still revoked by hand`);
    assert.equal((await api(del(`admin/revocations/${byHand}`, 'secret'))).status, 200, label);
    assert.equal((await store.getGift(on.replace(/-/g, ''))).active, true, `${label}: on, as it was before the refund`);
  });
});

test('a refund from the other Creem mode than its order is ignored, recorded as not matched (memory and D1)', async t => {
  await bothStores(t, async (label, store) => {
    const creem = fakeCreem({ checkouts: { ch_modetest0001: await checkout('ch_modetest0001', { mode: 'test' }) }, transactions: { tran_mode: transaction('tran_mode', 'ord_ch_modetest0001', { mode: 'live' }) } });
    const { api, resend, warnings, settle } = setup({ store, creem });
    const license = (await asJson(await api(post('purchases/claim', { checkout: 'ch_modetest0001' })))).body.license;
    assert.equal((await sendWebhook(api, refundEvent({ id: 'ref_mode1', tran: 'tran_mode' }))).status, 200, label);
    const row = await store.getRefund('ref_mode1');
    assert.deepEqual([row.item, row.checkoutId, row.revoked, row.note], ['', '', '', 'Ignored: it is in live mode, but its order was paid in test mode.'], label);
    assert.equal((await checkLicense(api, license)).body.revoked, false, label);
    assert.match(warnings.join('\n'), /ref_mode1 is in live mode but order ord_ch_modetest0001 was paid in test mode; ignored/);
    await settle();
    assert.equal(ownerEmails(resend).at(-1).body.subject, 'Refund not matched (29.00 EUR)', label);
    assert.match(ownerEmails(resend).at(-1).body.text, /in live mode, but the order it names was paid in test mode, so it was ignored/);
  });
});

test('a gift whose checkout is revoked is never redeemed, even with its own link on', async () => {
  const creem = fakeCreem({ checkouts: { ch_giftcheck001: await checkout('ch_giftcheck001', { item: 'gift' }) } });
  const { api, store } = setup({ creem });
  const gift = (await asJson(await api(post('purchases/claim', { checkout: 'ch_giftcheck001' })))).body;
  await store.addRevocations([{ target: revocationTarget('checkout', 'ch_giftcheck001'), source: 'owner_aaaaaaaaaaaaaaaa', kind: 'checkout', label: 'ch_giftcheck001', reason: 'owner', createdAt: 'x' }]);
  assert.equal((await store.getGift(gift.code.replace(/-/g, ''))).active, true);
  assert.deepEqual(await asJson(await api(post(`gifts/${gift.code}/redeem`))), { status: 410, body: { error: 'This gift link is no longer active.', revoked: true } });
  assert.equal((await asJson(await api(get(`gifts/${gift.code}`)))).body.revoked, true);
  assert.equal((await asJson(await api(post(`gifts/ZZZZ-ZZZZ-ZZZZ/redeem`)))).status, 404);
});
