import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMemoryStore, createPlannerApi, EMAIL_SENDS_EVENT, PLUS_CLAIMS_MAX } from '../server/planner-api.js';
import { createD1Store } from '../server/d1-store.js';
import { formatGiftCode, GIFT_CODE_ALPHABET, giftForwardMessage, giftLimit, newGiftCode, normalizeGiftCode, validateGiftFields } from '../server/gifts.js';
import { generatePlusKeyPair, giftManageKey, verifyLicense } from '../server/licenses.js';
import { parseStripePrices, readCheckoutSession, stripeMode } from '../server/stripe.js';

const START = Date.parse('2026-10-09T08:00:00Z');
const KEYS = await generatePlusKeyPair();
const PRICES = { price_plus: { kind: 'plus' }, price_pack50: { kind: 'gift', seats: 50, plan: 'up-to-50' }, price_pack10: { kind: 'gift', seats: 10, plan: 'up-to-10' } };
const request = (method, path, body, token) => new Request(`https://planner.test/api/${path}`, {
  method,
  headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) })
});
const get = (path, token) => request('GET', path, undefined, token);
const post = (path, body = {}, token) => request('POST', path, body, token);
const patch = (path, body, token) => request('PATCH', path, body, token);
const del = (path, token) => request('DELETE', path, undefined, token);
const asJson = async response => ({ status: response.status, body: await response.json() });

function checkoutSession(id, { price = 'price_plus', paid = true, status = 'complete', company = '', name = 'Ada Buyer', email = 'Buyer@Example.com', quantity = 1, currency = 'eur', amount = 2900 } = {}) {
  return {
    id, object: 'checkout.session', status, payment_status: paid ? 'paid' : 'unpaid', currency, amount_total: amount,
    customer_details: { email, name },
    custom_fields: company ? [{ key: 'company', type: 'text', text: { value: company } }] : [],
    line_items: { object: 'list', data: [{ object: 'item', price: { id: price }, quantity }] }
  };
}

/** Stand-in for Stripe: GET /v1/checkout/sessions/:id from a dictionary; `status` forces an error. */
function fakeStripe(sessions = {}, { status = 0 } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, headers: init.headers, method: init.method });
    if (status) return new Response(JSON.stringify({ error: { message: 'Something broke' } }), { status, headers: { 'content-type': 'application/json' } });
    const id = decodeURIComponent(new URL(url).pathname.split('/').pop());
    const found = Object.hasOwn(sessions, id) ? sessions[id] : null;
    return found
      ? new Response(JSON.stringify(found), { status: 200, headers: { 'content-type': 'application/json' } })
      : new Response(JSON.stringify({ error: { message: `No such checkout.session: '${id}'` } }), { status: 404, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, calls, sessions };
}

function fakeResend({ fail = () => 0 } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    const status = fail(calls.length);
    if (status) return new Response(JSON.stringify({ statusCode: status, message: `Refused (${status})` }), { status, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify(Array.isArray(body) ? { data: [] } : { id: 'x' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, calls };
}

function setup({ store = createMemoryStore(), clock = { now: START }, stripe = fakeStripe(), resend = fakeResend(), ...options } = {}) {
  const deferred = [];
  const warnings = [];
  const api = createPlannerApi({
    store, adminToken: 'secret', now: () => new Date(clock.now), authFailureDelayMs: 0,
    plusSigningKey: KEYS.signingKey, stripeSecretKey: 'rk_test_51abc', stripePrices: JSON.stringify(PRICES), stripeFetch: stripe.fetch,
    resendApiKey: 're_test_key', emailFrom: 'Ben Morin <hello@bemorin.example>', ownerEmail: 'owner@bemorin.example', emailFetch: resend.fetch, emailIntervalMs: 0,
    defer: promise => deferred.push(promise), warn: message => warnings.push(message),
    ...options
  });
  const settle = () => Promise.all(deferred.splice(0));
  return { api, store, clock, stripe, resend, deferred, warnings, settle };
}

async function openSqlite(t, migrations = ['0001_planner_api.sql', '0002_team_requests.sql', '0003_plus.sql']) {
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

async function createGift(api, fields = {}) {
  const { status, body } = await asJson(await api(post('admin/gifts', { org: 'Acme', seats: 3, message: 'Enjoy planning 2027!', ...fields }, 'secret')));
  assert.equal(status, 201, JSON.stringify(body));
  return body;
}

test('gift codes: 12 characters without look-alikes, dashes optional, case ignored', () => {
  assert.equal(GIFT_CODE_ALPHABET, 'ABCDEFGHJKMNPQRSTUVWXYZ23456789');
  for (let index = 0; index < 200; index += 1) assert.match(newGiftCode(), /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{12}$/);
  // Bytes ≥ 248 are skipped so every character is equally likely.
  let round = 0;
  const code = newGiftCode(bytes => { bytes.fill(round++ === 0 ? 255 : 0); bytes[1] = 30; return bytes; });
  assert.equal(code, '9A9AAAAAAAAA', 'the first round was all 255 except one 30');
  assert.equal(normalizeGiftCode('abcd-efgh-jkmn'), 'ABCDEFGHJKMN');
  assert.equal(normalizeGiftCode(' ABCDEFGHJKMN '), 'ABCDEFGHJKMN');
  assert.equal(normalizeGiftCode('ABCD-EFGH-JKMN'), 'ABCDEFGHJKMN');
  for (const bad of ['ABCD-EFGH-JKMI', 'ABCD-EFGH-JKM0', 'ABCD-EFGH-JKL1', 'ABCDEFGHJKM', 'ABCDEFGHJKMNP', 'ABCD EFGH JKMN', '', null, 'A'.repeat(40)]) assert.equal(normalizeGiftCode(bad), '', String(bad));
  assert.equal(formatGiftCode('ABCDEFGHJKMN'), 'ABCD-EFGH-JKMN');
  assert.deepEqual([1, 9, 10, 50, 100, 1000, 100000].map(giftLimit), [2, 10, 11, 55, 110, 1100, 110000]);
});

test('gift fields are validated with human messages', () => {
  const ok = validateGiftFields({ org: '  Acme  ', seats: '50', message: 'Hi\r\nall', note: 'PO 42', currency: 'eur', amount: 59500, buyerEmail: ' Boss@Acme.example ' }, { create: true });
  assert.deepEqual(ok.fields, { org: 'Acme', seats: 50, message: 'Hi\nall', note: 'PO 42', currency: 'EUR', amount: 59500, buyerEmail: 'boss@acme.example' });
  const bad = {
    'no company': { org: ' ' },
    'company over 80': { org: 'x'.repeat(81) },
    'no seats': { seats: undefined },
    'zero seats': { seats: 0 },
    'too many seats': { seats: 100001 },
    'fractional seats': { seats: 2.5 },
    'text seats': { seats: 'ten' },
    'message over 280': { message: 'm'.repeat(281) },
    'message not text': { message: { text: 'x' } },
    'note over 500': { note: 'n'.repeat(501) },
    'unknown currency': { currency: 'GBP', amount: 100 },
    'amount without currency': { amount: 100 },
    'negative amount': { currency: 'EUR', amount: -1 },
    'fractional amount': { currency: 'EUR', amount: 1.5 },
    'bad buyer email': { buyerEmail: 'boss@acme' }
  };
  for (const [label, overrides] of Object.entries(bad)) {
    const result = validateGiftFields({ org: 'Acme', seats: 10, ...overrides }, { create: true });
    assert.ok(typeof result.error === 'string' && result.error.length > 10, label);
  }
  assert.ok(validateGiftFields({ org: 'x'.repeat(80), seats: 100000, message: 'm'.repeat(280) }, { create: true }).fields);
  // An edit only touches what it names.
  assert.deepEqual(validateGiftFields({ message: 'New' }, { allowed: ['org', 'message'] }).fields, { message: 'New' });
  assert.deepEqual(validateGiftFields({ seats: 5, note: 'x' }, { allowed: ['org', 'message'] }).fields, {});
  assert.ok(validateGiftFields({ active: 'yes' }, { allowed: ['active'] }).error);
});

test('an invoiced gift: anyone with the link sees it and activates Plus until the limit (memory and D1)', async t => {
  await bothStores(t, async (label, store) => {
    const { api, clock } = setup({ store });
    const created = await createGift(api, { seats: 3, note: 'Invoice 2026-118', currency: 'EUR', amount: 19500, buyerEmail: 'boss@acme.example' });
    const { gift } = created;
    assert.match(gift.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/, label);
    assert.equal(created.url, `https://planner.bemorin.com/?gift=${gift.code}`, label);
    assert.equal(gift.manageKey, await giftManageKey(KEYS.signingKey, gift.code), label);
    assert.equal(created.manageUrl, `https://planner.bemorin.com/welcome/thanks/?gift=${gift.code}&key=${gift.manageKey}`, label);
    assert.equal(gift.limit, 4, label);
    assert.equal(gift.source, 'manual', label);
    assert.equal(gift.expiresAt, '2027-10-09T08:00:00.000Z', label);
    assert.equal('emailed' in created, false, 'no email unless asked');

    const lower = gift.code.replace(/-/g, '').toLowerCase();
    const info = await asJson(await api(get(`gifts/${lower}`)));
    assert.equal(info.status, 200, label);
    assert.deepEqual(info.body, { org: 'Acme', message: 'Enjoy planning 2027!', seats: 3, redeemed: 0, available: true, expiresAt: '2027-10-09T08:00:00.000Z', status: 'available' }, label);

    const ids = new Set();
    for (let index = 0; index < 4; index += 1) {
      clock.now += 1000;
      const redeemed = await asJson(await api(post(`gifts/${gift.code}/redeem`)));
      assert.equal(redeemed.status, 200, `${label} activation ${index + 1}`);
      assert.equal(redeemed.body.org, 'Acme');
      assert.equal(redeemed.body.message, 'Enjoy planning 2027!');
      const payload = await verifyLicense(KEYS.publicKey, redeemed.body.license);
      assert.equal(payload.src, 'gift');
      assert.equal(payload.org, 'Acme');
      assert.equal(payload.iat, '2026-10-09');
      ids.add(payload.id);
    }
    assert.equal(ids.size, 4, 'one licence id per activation');
    // seats + max(1, 10%) = 4 activations; the fifth is refused.
    const full = await asJson(await api(post(`gifts/${gift.code}/redeem`)));
    assert.deepEqual(full, { status: 409, body: { error: 'This gift has been fully claimed.' } }, label);
    const after = (await asJson(await api(get(`gifts/${gift.code}`)))).body;
    assert.deepEqual([after.redeemed, after.available, after.status], [4, false, 'claimed'], label);
    // A request without any body works too.
    assert.equal((await api(new Request(`https://planner.test/api/gifts/${gift.code}/redeem`, { method: 'POST' }))).status, 409);
  });
});

test('the 10% tolerance and concurrent activations never pass the limit (memory and D1)', async t => {
  await bothStores(t, async (label, store) => {
    const { api } = setup({ store });
    const { gift } = await createGift(api, { seats: 50 });
    const code = gift.code.replace(/-/g, '');
    const answers = await Promise.all(Array.from({ length: 70 }, () => api(post(`gifts/${code}/redeem`))));
    const statuses = answers.map(answer => answer.status);
    assert.equal(statuses.filter(status => status === 200).length, 55, label);
    assert.equal(statuses.filter(status => status === 409).length, 15, label);
    assert.equal((await store.getGift(code)).redeemed, 55, label);
  });
});

test('expired and switched-off gift links say so (memory and D1)', async t => {
  await bothStores(t, async (label, store) => {
    const { api, clock } = setup({ store });
    const { gift } = await createGift(api, { seats: 10 });
    clock.now = Date.parse('2027-10-09T07:59:59Z');
    assert.equal((await api(post(`gifts/${gift.code}/redeem`))).status, 200, label);
    clock.now = Date.parse('2027-10-09T08:00:00Z');
    assert.deepEqual(await asJson(await api(post(`gifts/${gift.code}/redeem`))), { status: 410, body: { error: 'This gift link has expired.' } }, label);
    const expired = (await asJson(await api(get(`gifts/${gift.code}`)))).body;
    assert.deepEqual([expired.available, expired.status], [false, 'expired'], label);

    clock.now = START;
    assert.equal((await api(patch(`admin/gifts/${gift.code}`, { active: false }, 'secret'))).status, 200, label);
    assert.deepEqual(await asJson(await api(post(`gifts/${gift.code}/redeem`))), { status: 410, body: { error: 'This gift link is no longer active.' } }, label);
    assert.equal((await asJson(await api(get(`gifts/${gift.code}`)))).body.status, 'inactive', label);
    assert.equal((await api(patch(`admin/gifts/${gift.code}`, { active: true }, 'secret'))).status, 200, label);
    assert.equal((await api(post(`gifts/${gift.code}/redeem`))).status, 200, label);
  });
});

test('unknown or malformed codes are a cheap 404; the public answer never shows private fields', async () => {
  const calls = [];
  const base = createMemoryStore();
  const store = new Proxy(base, { get(target, name) { const value = target[name]; return typeof value === 'function' ? (...args) => { calls.push(name); return value.apply(target, args); } : value; } });
  const { api } = setup({ store });
  for (const path of ['gifts/nope', 'gifts/ABCD-EFGH-JKMI', 'gifts/%41BCDEFGHJKMN', `gifts/${'A'.repeat(30)}`]) {
    assert.equal((await api(get(path))).status, 404, path);
    assert.equal((await api(post(`${path}/redeem`))).status, 404, path);
  }
  assert.deepEqual(calls, [], 'malformed codes never reach the database');
  assert.equal((await api(get('gifts/ABCD-EFGH-JKMN'))).status, 404);
  assert.equal((await api(post('gifts/ABCD-EFGH-JKMN/redeem'))).status, 404);
  assert.equal((await api(request('DELETE', 'gifts/ABCD-EFGH-JKMN'))).status, 405);
  assert.equal((await api(get('gifts/ABCD-EFGH-JKMN/redeem'))).status, 405);
  const { gift } = await createGift(api, { buyerEmail: 'boss@acme.example', note: 'secret note', currency: 'USD', amount: 19500 });
  const text = await (await api(get(`gifts/${gift.code}`))).text();
  for (const hidden of ['boss@acme.example', 'secret note', '19500', 'USD', 'manual', gift.manageKey]) assert.ok(!text.includes(hidden), hidden);
});

test('the manage key lets the buyer change only the company name and the message (memory and D1)', async t => {
  await bothStores(t, async (label, store) => {
    const { api } = setup({ store });
    const { gift } = await createGift(api, { seats: 10 });
    const key = gift.manageKey;
    for (const bad of ['', 'f'.repeat(64), key.slice(0, -1), 42, null]) {
      assert.deepEqual(await asJson(await api(patch(`gifts/${gift.code}`, { key: bad, message: 'Hacked' }))), { status: 403, body: { error: 'This manage link is not valid.' } }, `${label} ${bad}`);
    }
    // Another gift's key does not open this one.
    const { gift: other } = await createGift(api, { org: 'Other' });
    assert.equal((await api(patch(`gifts/${gift.code}`, { key: other.manageKey, message: 'Hacked' }))).status, 403, label);
    // The key alone checks the link and returns the current text.
    assert.deepEqual(await asJson(await api(patch(`gifts/${gift.code}`, { key }))), { status: 200, body: { ok: true, org: 'Acme', message: 'Enjoy planning 2027!' } }, label);
    const edited = await asJson(await api(patch(`gifts/${gift.code.toLowerCase()}`, { key: key.toUpperCase(), org: '  Acme Studio ', message: 'Happy new year!\n— The founders', seats: 99999, active: false })));
    assert.deepEqual(edited, { status: 200, body: { ok: true, org: 'Acme Studio', message: 'Happy new year!\n— The founders' } }, label);
    const stored = await store.getGift(gift.code.replace(/-/g, ''));
    assert.deepEqual([stored.org, stored.seats, stored.active], ['Acme Studio', 10, true], `${label}: seats and active are owner-only`);
    assert.equal((await api(patch(`gifts/${gift.code}`, { key, message: 'm'.repeat(281) }))).status, 400, label);
    assert.equal((await api(patch(`gifts/${gift.code}`, { key, org: 'o'.repeat(81) }))).status, 400, label);
    assert.equal((await api(patch(`gifts/${gift.code}`, { key, org: '' }))).status, 400, label);
    // A valid key for a deleted gift.
    assert.equal((await api(del(`admin/gifts/${gift.code}`, 'secret'))).status, 200, label);
    assert.equal((await api(patch(`gifts/${gift.code}`, { key }))).status, 404, label);
  });
});

test('without a usable PLUS_SIGNING_KEY nothing can be activated and the owner is told why', async () => {
  for (const plusSigningKey of ['', 'bm90IGEga2V5']) {
    const { api, store } = setup({ plusSigningKey });
    await store.addGift({ code: 'ABCDEFGHJKMN', org: 'Acme', message: '', seats: 5, redeemed: 0, active: true, currency: '', amount: null, source: 'manual', stripeSession: null, buyerEmail: '', note: '', createdAt: '2026-10-09T08:00:00.000Z', expiresAt: '2027-10-09T08:00:00.000Z', emailedAt: null });
    assert.equal((await api(get('gifts/ABCD-EFGH-JKMN'))).status, 200, 'the gift can still be shown');
    const off = await asJson(await api(post('gifts/ABCD-EFGH-JKMN/redeem')));
    assert.equal(off.status, 503);
    assert.match(off.body.error, /not set up/);
    assert.equal((await store.getGift('ABCDEFGHJKMN')).redeemed, 0, 'no seat used');
    assert.equal((await api(patch('gifts/ABCD-EFGH-JKMN', { key: 'f'.repeat(64) }))).status, 503);
    assert.equal((await api(post('purchases/claim', { session: 'cs_test_abcdefgh123' }))).status, 503);
    const create = await asJson(await api(post('admin/gifts', { org: 'Acme', seats: 3 }, 'secret')));
    assert.equal(create.status, 503);
    assert.match(create.body.error, /PLUS_SIGNING_KEY/);
    assert.equal((await api(post('admin/licenses', {}, 'secret'))).status, 503);
    const { setup: info } = (await asJson(await api(get('admin/summary', 'secret')))).body;
    assert.deepEqual(info.plus, { configured: false, keySet: !!plusSigningKey, publicKey: '' });
  }
});

test('a Stripe Plus purchase becomes a licence, the same one on every claim (memory and D1)', async t => {
  await bothStores(t, async (label, store) => {
    const stripe = fakeStripe({ cs_live_plus123456: checkoutSession('cs_live_plus123456') });
    const { api } = setup({ store, stripe });
    const first = await asJson(await api(post('purchases/claim', { session: ' cs_live_plus123456 ' })));
    assert.equal(first.status, 200, label);
    assert.deepEqual(Object.keys(first.body), ['kind', 'license'], label);
    assert.equal(first.body.kind, 'plus');
    const payload = await verifyLicense(KEYS.publicKey, first.body.license);
    assert.equal(payload.src, 'purchase');
    assert.equal(payload.org, undefined);
    // Stripe was asked exactly as documented.
    assert.equal(stripe.calls.length, 1, label);
    assert.equal(stripe.calls[0].url, 'https://api.stripe.com/v1/checkout/sessions/cs_live_plus123456?expand[]=line_items');
    assert.equal(stripe.calls[0].method, 'GET');
    assert.equal(stripe.calls[0].headers.authorization, 'Bearer rk_test_51abc');
    const row = await store.getPurchase('cs_live_plus123456');
    assert.deepEqual([row.kind, row.claims, row.email, row.licenseId], ['plus', 1, 'buyer@example.com', payload.id], label);
    // Claims 2…10 answer the same licence id from the database; Stripe is not asked again.
    for (let claim = 2; claim <= PLUS_CLAIMS_MAX; claim += 1) {
      const again = await asJson(await api(post('purchases/claim', { session: 'cs_live_plus123456' })));
      assert.equal(again.status, 200, `${label} claim ${claim}`);
      assert.equal((await verifyLicense(KEYS.publicKey, again.body.license)).id, payload.id);
    }
    assert.equal(stripe.calls.length, 1, label);
    const eleventh = await asJson(await api(post('purchases/claim', { session: 'cs_live_plus123456' })));
    assert.equal(eleventh.status, 409, label);
    assert.match(eleventh.body.error, /10 times/);
    const summary = (await asJson(await api(get('admin/summary', 'secret')))).body;
    assert.equal(summary.plus.purchases, 1, label);
  });
});

test('a Stripe team pack becomes one gift, emailed once to the buyer (memory and D1)', async t => {
  await bothStores(t, async (label, store) => {
    const stripe = fakeStripe({
      cs_test_pack50abcdef: checkoutSession('cs_test_pack50abcdef', { price: 'price_pack50', company: 'Acme <Studio>', email: 'Boss@Acme.example', amount: 59500 }),
      cs_test_pack10x2abcd: checkoutSession('cs_test_pack10x2abcd', { price: 'price_pack10', quantity: 2, name: 'Globex Ltd', currency: 'usd', amount: 39000 })
    });
    const { api, resend, settle } = setup({ store, stripe });
    const first = await asJson(await api(post('purchases/claim', { session: 'cs_test_pack50abcdef' })));
    assert.equal(first.status, 200, label);
    const answer = first.body;
    assert.deepEqual(Object.keys(answer), ['kind', 'code', 'url', 'seats', 'redeemed', 'org', 'message', 'manageKey', 'manageUrl', 'expiresAt'], label);
    assert.equal(answer.kind, 'gift');
    assert.match(answer.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.equal(answer.url, `https://planner.bemorin.com/?gift=${answer.code}`);
    assert.deepEqual([answer.seats, answer.redeemed, answer.org, answer.message], [50, 0, 'Acme <Studio>', ''], label);
    assert.equal(answer.manageKey, await giftManageKey(KEYS.signingKey, answer.code));
    await settle();
    // The buyer gets one email: the link, the manage link and a message to forward.
    assert.equal(resend.calls.length, 1, label);
    const email = resend.calls[0].body;
    assert.equal(resend.calls[0].url, 'https://api.resend.com/emails');
    assert.deepEqual(email.to, ['boss@acme.example']);
    assert.equal(email.reply_to, 'owner@bemorin.example');
    assert.equal(email.subject, 'Your Daily Planner Plus gift link for Acme <Studio>');
    for (const part of [answer.url, answer.manageUrl, 'Subject: A gift from Acme <Studio>: Daily Planner Plus', 'up to 50 people', '9 October 2027']) assert.ok(email.text.includes(part), part);
    assert.ok(email.html.includes('Acme &lt;Studio&gt;') && !email.html.includes('<Studio>'), 'escaped in HTML');
    assert.equal(await store.emailSendsOn('2026-10-09', EMAIL_SENDS_EVENT), 1, label);

    // Claiming again returns the same gift, without Stripe and without a second email.
    const again = await asJson(await api(post('purchases/claim', { session: 'cs_test_pack50abcdef' })));
    await settle();
    assert.equal(again.body.code, answer.code, label);
    assert.equal(stripe.calls.length, 1, label);
    assert.equal(resend.calls.length, 1, label);
    const stored = await store.getGift(answer.code.replace(/-/g, ''));
    assert.deepEqual([stored.source, stored.stripeSession, stored.currency, stored.amount, stored.buyerEmail, stored.note], ['stripe', 'cs_test_pack50abcdef', 'EUR', 59500, 'boss@acme.example', 'Stripe · Up to 50 people'], label);
    assert.ok(stored.emailedAt, label);

    // Quantity multiplies the seats; without the company field, the Stripe name is used.
    const globex = await asJson(await api(post('purchases/claim', { session: 'cs_test_pack10x2abcd' })));
    assert.deepEqual([globex.body.seats, globex.body.org], [20, 'Globex Ltd'], label);
    const summary = (await asJson(await api(get('admin/summary', 'secret')))).body;
    assert.deepEqual(summary.giftTotals, { count: 2, seats: 70, redeemed: 0, stripe: 2 }, label);
    assert.equal(summary.plus.purchases, 0, label);
  });
});

test('a paid Stripe gift is switched off by Delete, never erased and recreated by the next claim', async () => {
  const stripe = fakeStripe({ cs_test_pack50keep12: checkoutSession('cs_test_pack50keep12', { price: 'price_pack50', company: 'Acme' }) });
  const { api, store } = setup({ stripe });
  const first = (await asJson(await api(post('purchases/claim', { session: 'cs_test_pack50keep12' })))).body;
  const code = first.code.replace(/-/g, '');
  assert.deepEqual(await asJson(await api(del(`admin/gifts/${code}`, 'secret'))), { status: 200, body: { removed: false, deactivated: true } });
  assert.equal((await store.getGift(code)).active, false);
  const again = (await asJson(await api(post('purchases/claim', { session: 'cs_test_pack50keep12' })))).body;
  assert.equal(again.code, first.code, 'the buyer gets the same, switched-off gift back');
  assert.equal((await asJson(await api(get(`gifts/${code}`)))).body.status, 'inactive');
  assert.deepEqual(await asJson(await api(post(`gifts/${code}/redeem`))), { status: 410, body: { error: 'This gift link is no longer active.' } });
  assert.equal(stripe.calls.length, 1, 'Stripe was asked once');
});

test('a gift email Resend refused is tried again on the next claim', async () => {
  const stripe = fakeStripe({ cs_test_pack50retry1: checkoutSession('cs_test_pack50retry1', { price: 'price_pack50', company: 'Acme' }) });
  const resend = fakeResend({ fail: call => (call === 1 ? 500 : 0) });
  const { api, store, settle, warnings } = setup({ stripe, resend });
  const first = (await asJson(await api(post('purchases/claim', { session: 'cs_test_pack50retry1' })))).body;
  await settle();
  assert.match(warnings[0], /Gift email not sent.*500/);
  assert.equal((await store.getGift(first.code.replace(/-/g, ''))).emailedAt, null);
  await api(post('purchases/claim', { session: 'cs_test_pack50retry1' }));
  await settle();
  assert.equal(resend.calls.length, 2);
  await api(post('purchases/claim', { session: 'cs_test_pack50retry1' }));
  await settle();
  assert.equal(resend.calls.length, 2, 'sent once, never again');
  // Without email set up, the claim still works and nothing is attempted.
  const quiet = setup({ stripe: fakeStripe({ cs_test_pack50quiet1: checkoutSession('cs_test_pack50quiet1', { price: 'price_pack50' }) }), resendApiKey: '' });
  assert.equal((await quiet.api(post('purchases/claim', { session: 'cs_test_pack50quiet1' }))).status, 200);
  assert.equal(quiet.deferred.length, 0);
});

test('claims that cannot be honoured: unpaid, unknown, not ours, Stripe down, not configured', async () => {
  const sessions = {
    cs_test_unpaid12345: checkoutSession('cs_test_unpaid12345', { paid: false }),
    cs_test_open1234567: checkoutSession('cs_test_open1234567', { status: 'open' }),
    cs_test_other123456: checkoutSession('cs_test_other123456', { price: 'price_tshirt' }),
    cs_test_free1234567: { ...checkoutSession('cs_test_free1234567'), payment_status: 'no_payment_required' }
  };
  const stripe = fakeStripe(sessions);
  const { api, store, clock } = setup({ stripe });
  assert.deepEqual(await asJson(await api(post('purchases/claim', { session: 'cs_test_unpaid12345' }))), { status: 402, body: { error: 'This payment is not complete yet.' } });
  assert.equal((await api(post('purchases/claim', { session: 'cs_test_open1234567' }))).status, 402);
  assert.equal(await store.getPurchase('cs_test_unpaid12345'), null, 'nothing stored before payment');
  assert.deepEqual(await asJson(await api(post('purchases/claim', { session: 'cs_test_missing1234' }))), { status: 404, body: { error: 'We could not find this payment.' } });
  assert.equal((await api(post('purchases/claim', { session: 'cs_test_other123456' }))).status, 404);
  assert.equal((await api(post('purchases/claim', { session: 'cs_test_free1234567' }))).status, 200, 'a 100% coupon counts as paid');
  const calls = stripe.calls.length;
  for (const session of ['', 'cs_test_', 'pi_test_abcdefgh123', 'cs_prod_abcdefgh123', 'cs_test_abc/../x1234', 42, null]) {
    assert.equal((await api(post('purchases/claim', { session }))).status, 404, String(session));
  }
  assert.equal(stripe.calls.length, calls, 'malformed ids never reach Stripe');
  // Unknown ids and other products are remembered for ten minutes: repeats cost no Stripe call.
  for (let index = 0; index < 5; index += 1) {
    assert.equal((await api(post('purchases/claim', { session: 'cs_test_missing1234' }))).status, 404);
    assert.equal((await api(post('purchases/claim', { session: 'cs_test_other123456' }))).status, 404);
  }
  assert.equal(stripe.calls.length, calls, 'remembered unknown ids never reach Stripe again');
  clock.now += 11 * 60 * 1000;
  assert.equal((await api(post('purchases/claim', { session: 'cs_test_missing1234' }))).status, 404);
  assert.equal(stripe.calls.length, calls + 1, 'asked again once the memory expires');
  // Paid later (bank transfer): the same session then works.
  sessions.cs_test_unpaid12345.payment_status = 'paid';
  assert.equal((await api(post('purchases/claim', { session: 'cs_test_unpaid12345' }))).status, 200);
  assert.equal((await api(get('purchases/claim'))).status, 405);

  const down = setup({ stripe: fakeStripe({}, { status: 500 }) });
  const failed = await asJson(await down.api(post('purchases/claim', { session: 'cs_test_whatever1234' })));
  assert.equal(failed.status, 502);
  assert.match(down.warnings[0], /Stripe answered HTTP 500: Something broke/);

  for (const options of [{ stripeSecretKey: '' }, { stripePrices: '' }, { stripePrices: '{nope' }, { stripePrices: '{"price_x":{"kind":"tshirt"}}' }]) {
    const off = setup(options);
    assert.deepEqual(await asJson(await off.api(post('purchases/claim', { session: 'cs_test_whatever1234' }))), { status: 503, body: { error: 'Payments are not configured.' } }, JSON.stringify(options));
    assert.equal(off.stripe.calls.length, 0);
  }
});

test('Stripe helpers read prices, modes and sessions defensively', () => {
  const parsed = parseStripePrices(JSON.stringify({ ...PRICES, bad: { kind: 'gift', seats: 0 }, 'x y': { kind: 'plus' } }));
  assert.equal(parsed.prices.size, 3);
  assert.match(parsed.error, /skipped 2 entries/);
  assert.match(parseStripePrices('[1]').error, /JSON object/);
  assert.equal(parseStripePrices('').error, '');
  assert.deepEqual(['sk_live_x', 'rk_test_y', 'pk_live_z', ''].map(stripeMode), ['live', 'test', '', '']);
  const read = readCheckoutSession(checkoutSession('cs_test_x', { price: 'price_pack50', quantity: 3000, company: '' }), parsed.prices);
  assert.deepEqual(read, { paid: true, item: { kind: 'gift', seats: 100000, plan: 'up-to-50' }, org: 'Ada Buyer', email: 'buyer@example.com', currency: 'EUR', amount: 2900 });
  assert.equal(readCheckoutSession({}, parsed.prices).item, null);
  assert.equal(readCheckoutSession(null, parsed.prices).paid, false);
});

test('owner gift management: list, edit, switch off, delete, and the buyer email on request (memory and D1)', async t => {
  await bothStores(t, async (label, store) => {
    const { api, resend } = setup({ store, publicBaseUrl: 'https://staging.example/planner/' });
    assert.equal((await api(get('admin/gifts'))).status, 401);
    assert.equal((await api(post('admin/gifts', { org: 'Acme', seats: 3 }))).status, 401);
    assert.equal((await api(post('admin/licenses', {}))).status, 401);
    for (const body of [{ org: '', seats: 3 }, { org: 'Acme', seats: 0 }, { org: 'Acme', seats: 3, amount: 100 }, { org: 'Acme', seats: 3, sendEmail: true }]) {
      const refused = await asJson(await api(post('admin/gifts', body, 'secret')));
      assert.equal(refused.status, 400, `${label} ${JSON.stringify(body)}`);
      assert.ok(refused.body.error.length > 10);
    }
    const created = await createGift(api, { org: 'Initech', seats: 25, buyerEmail: 'Lumbergh@Initech.example', sendEmail: true, currency: 'USD', amount: 59500 });
    assert.equal(created.emailed, true, label);
    assert.ok(created.gift.emailedAt, label);
    assert.equal(created.url, `https://staging.example/planner/?gift=${created.gift.code}`);
    assert.equal(resend.calls.length, 1);
    assert.deepEqual(resend.calls[0].body.to, ['lumbergh@initech.example']);
    assert.ok(resend.calls[0].body.text.includes(created.manageUrl));

    const { rows } = (await asJson(await api(get('admin/gifts', 'secret')))).body;
    assert.equal(rows.length, 1, label);
    assert.deepEqual([rows[0].code, rows[0].org, rows[0].seats, rows[0].limit, rows[0].amount, rows[0].currency, rows[0].status, rows[0].manageUrl], [created.gift.code, 'Initech', 25, 27, 59500, 'USD', 'available', created.manageUrl], label);

    const edited = await asJson(await api(patch(`admin/gifts/${created.gift.code}`, { seats: 30, org: 'Initech Corp', message: 'Enjoy', note: 'Paid by wire', active: false }, 'secret')));
    assert.equal(edited.status, 200, label);
    assert.deepEqual([edited.body.gift.seats, edited.body.gift.org, edited.body.gift.message, edited.body.gift.note, edited.body.gift.active, edited.body.gift.status], [30, 'Initech Corp', 'Enjoy', 'Paid by wire', false, 'inactive'], label);
    assert.equal((await api(patch(`admin/gifts/${created.gift.code}`, { seats: 100001 }, 'secret'))).status, 400, label);
    assert.equal((await api(patch(`admin/gifts/${created.gift.code}`, { active: 'no' }, 'secret'))).status, 400, label);
    assert.equal((await api(patch('admin/gifts/ABCD-EFGH-JKMN', { seats: 3 }, 'secret'))).status, 404, label);
    assert.equal((await api(get(`admin/gifts/${created.gift.code}`, 'secret'))).status, 405, label);
    // Bound parameters only: a hostile value is stored verbatim.
    assert.equal((await api(patch(`admin/gifts/${created.gift.code}`, { org: "x'); DROP TABLE gifts; --" }, 'secret'))).status, 200, label);
    assert.equal((await store.getGift(created.gift.code.replace(/-/g, ''))).org, "x'); DROP TABLE gifts; --", label);

    assert.deepEqual(await asJson(await api(del(`admin/gifts/${created.gift.code}`, 'secret'))), { status: 200, body: { removed: true } }, label);
    assert.equal((await api(del(`admin/gifts/${created.gift.code}`, 'secret'))).status, 404, label);
    assert.equal((await api(get(`gifts/${created.gift.code}`))).status, 404, label);

    // Emailing without Resend set up is refused before anything is created.
    const noEmail = setup({ store, resendApiKey: '' });
    const refused = await asJson(await noEmail.api(post('admin/gifts', { org: 'Acme', seats: 3, buyerEmail: 'a@b.co', sendEmail: true }, 'secret')));
    assert.equal(refused.status, 400, label);
    assert.match(refused.body.error, /RESEND_API_KEY/);
    assert.equal((await store.listGifts()).length, 0, label);
  });
});

test('licences for support and giveaways (memory and D1)', async t => {
  await bothStores(t, async (label, store) => {
    const { api } = setup({ store });
    const made = await asJson(await api(post('admin/licenses', { note: 'Giveaway — newsletter' }, 'secret')));
    assert.equal(made.status, 201, label);
    const payload = await verifyLicense(KEYS.publicKey, made.body.license);
    assert.equal(payload.src, 'manual');
    assert.equal(made.body.url, `https://planner.bemorin.com/?license=${made.body.license}`);
    assert.equal((await api(post('admin/licenses', { note: 'n'.repeat(201) }, 'secret'))).status, 400, label);
    assert.equal((await api(get('admin/licenses', 'secret'))).status, 405, label);
    const summary = (await asJson(await api(get('admin/summary', 'secret')))).body;
    assert.equal(summary.plus.manualLicenses, 1, label);
    assert.deepEqual(summary.plus.recentLicenses, [{ id: payload.id, note: 'Giveaway — newsletter', createdAt: '2026-10-09T08:00:00.000Z' }], label);
  });
});

test('the setup summary says what is configured without ever showing a secret', async () => {
  const { api } = setup({ adminTotpSecret: '' });
  const { body } = await asJson(await api(get('admin/summary', 'secret')));
  assert.deepEqual(body.setup, {
    email: { configured: true, apiKeySet: true, fromSet: true, from: 'Ben Morin <hello@bemorin.example>', ownerEmail: 'owner@bemorin.example', dailyLimit: 100 },
    stripe: { configured: true, keySet: true, mode: 'test', plusPrices: 1, giftPrices: 2, error: '' },
    plus: { configured: true, keySet: true, publicKey: KEYS.publicKey },
    publicBaseUrl: 'https://planner.bemorin.com',
    publicBaseUrlSet: false,
    twoFactor: false
  });
  const text = JSON.stringify(body);
  for (const secret of [KEYS.signingKey, 'rk_test_51abc', 're_test_key']) assert.ok(!text.includes(secret));
  assert.equal(body.plusUnavailable, false);
  const empty = setup({ resendApiKey: '', emailFrom: '', ownerEmail: '', stripeSecretKey: '', stripePrices: '{bad', plusSigningKey: '' });
  const off = (await asJson(await empty.api(get('admin/summary', 'secret')))).body.setup;
  assert.deepEqual([off.email.configured, off.stripe.configured, off.stripe.error, off.plus.configured], [false, false, 'STRIPE_PRICES is not valid JSON.', false]);
});

test('without the 0003 migration the dashboard still loads and Plus routes explain what is missing', async t => {
  const d1 = await openSqlite(t, ['0001_planner_api.sql', '0002_team_requests.sql']);
  if (!d1) return;
  const { api } = setup({ store: createD1Store(d1), stripe: fakeStripe({ cs_test_plus1234567: checkoutSession('cs_test_plus1234567') }) });
  const summary = await asJson(await api(get('admin/summary', 'secret')));
  assert.equal(summary.status, 200);
  assert.equal(summary.body.plusUnavailable, true);
  assert.deepEqual(summary.body.gifts, []);
  for (const call of [get('gifts/ABCD-EFGH-JKMN'), post('gifts/ABCD-EFGH-JKMN/redeem'), post('purchases/claim', { session: 'cs_test_plus1234567' }), post('admin/gifts', { org: 'Acme', seats: 3 }, 'secret')]) {
    const answer = await asJson(await api(call));
    assert.equal(answer.status, 503);
    assert.match(answer.body.error, /migrations/);
  }
  // Applying 0003 later (or twice) is safe.
  for (let round = 0; round < 2; round += 1) d1.sqlite.exec(readFileSync(new URL('../migrations/0003_plus.sql', import.meta.url), 'utf8'));
  assert.equal((await asJson(await api(get('admin/summary', 'secret')))).body.plusUnavailable, false);
});

test('migration 0003: columns, one gift per Stripe session, several invoiced gifts', async t => {
  const d1 = await openSqlite(t);
  if (!d1) return;
  const columns = table => d1.sqlite.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
  assert.deepEqual(columns('gifts'), ['code', 'org', 'message', 'seats', 'redeemed', 'active', 'currency', 'amount', 'source', 'stripe_session', 'buyer_email', 'note', 'created_at', 'expires_at', 'emailed_at']);
  assert.deepEqual(columns('purchases'), ['stripe_session', 'kind', 'license_id', 'claims', 'email', 'note', 'created_at']);
  const store = createD1Store(d1);
  const gift = (code, stripeSession) => ({ code, org: 'Acme', message: '', seats: 5, redeemed: 0, active: true, currency: '', amount: null, source: stripeSession ? 'stripe' : 'manual', stripeSession, buyerEmail: '', note: '', createdAt: '2026-10-09T08:00:00.000Z', expiresAt: '2027-10-09T08:00:00.000Z', emailedAt: null });
  assert.equal(await store.addGift(gift('AAAAAAAAAAAA', null)), true);
  assert.equal(await store.addGift(gift('BBBBBBBBBBBB', null)), true, 'NULL sessions do not collide');
  assert.equal(await store.addGift(gift('CCCCCCCCCCCC', 'cs_test_1')), true);
  assert.equal(await store.addGift(gift('DDDDDDDDDDDD', 'cs_test_1')), false, 'one gift per session');
  assert.equal(await store.addGift(gift('AAAAAAAAAAAA', 'cs_test_2')), false, 'codes are unique');
  assert.equal((await store.getGiftBySession('cs_test_1')).code, 'CCCCCCCCCCCC');
  assert.equal(await store.markGiftEmailed('CCCCCCCCCCCC', '2026-10-09T09:00:00.000Z'), true);
  assert.equal(await store.markGiftEmailed('CCCCCCCCCCCC', '2026-10-09T10:00:00.000Z'), false);
  await store.clearGiftEmailed('CCCCCCCCCCCC');
  assert.equal((await store.getGift('CCCCCCCCCCCC')).emailedAt, null);
  assert.equal(await store.unredeemGift('AAAAAAAAAAAA'), false, 'never below zero');
});

test('the forwardable message names the company and the link', () => {
  const message = giftForwardMessage({ org: 'Acme', message: 'Happy 2027!', url: 'https://planner.bemorin.com/?gift=ABCD-EFGH-JKMN', expiresAt: '2027-10-09T08:00:00.000Z' });
  assert.equal(message.subject, 'A gift from Acme: Daily Planner Plus');
  assert.ok(message.text.includes('https://planner.bemorin.com/?gift=ABCD-EFGH-JKMN'));
  assert.ok(message.text.includes('Happy 2027!'));
  assert.ok(message.text.includes('until 9 October 2027'));
  assert.ok(message.text.includes('nothing about you is collected'));
});

test('gift routes answer CORS preflights with PATCH for allowed origins', async () => {
  const { api } = setup({ allowedOrigins: 'https://landing.example' });
  const preflight = await api(new Request('https://planner.test/api/gifts/ABCD-EFGH-JKMN', { method: 'OPTIONS', headers: { origin: 'https://landing.example' } }));
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-methods'), /PATCH/);
  const missing = await api(new Request('https://planner.test/api/gifts/ABCD-EFGH-JKMN', { headers: { origin: 'https://landing.example' } }));
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('access-control-allow-origin'), 'https://landing.example');
  const claim = await api(new Request('https://planner.test/api/purchases/claim', { method: 'POST', headers: { origin: 'https://evil.example' }, body: '{}' }));
  assert.equal(claim.headers.get('access-control-allow-origin'), null);
});
