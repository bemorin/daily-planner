import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMemoryStore, createPlannerApi } from '../server/planner-api.js';
import { createD1Store } from '../server/d1-store.js';
import { formatGiftCode, GIFT_CODE_ALPHABET, giftBuyerEmail, giftForwardMessage, giftLimit, newGiftCode, normalizeGiftCode, validateGiftFields } from '../server/gifts.js';
import { generatePlusKeyPair, giftManageKey, verifyLicense } from '../server/licenses.js';

const START = Date.parse('2026-10-09T08:00:00Z');
const KEYS = await generatePlusKeyPair();
// Paid checkouts, the webhook and the setup summary are covered in tests/creem.test.js.
const PRODUCTS = { plus: { EUR: 'prod_plus_eur', USD: 'prod_plus_usd' }, gift: { EUR: 'prod_gift_eur', USD: 'prod_gift_usd' } };
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

/** Stand-in for Creem: every checkout is unknown. */
function fakeCreem() {
  const calls = [];
  const fetch = async url => {
    calls.push(String(url));
    return new Response(JSON.stringify({ message: ['Checkout not found'] }), { status: 404, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, calls };
}

function setup({ store = createMemoryStore(), clock = { now: START }, creem = fakeCreem(), resend = fakeResend(), ...options } = {}) {
  const deferred = [];
  const warnings = [];
  const api = createPlannerApi({
    store, adminToken: 'secret', now: () => new Date(clock.now), authFailureDelayMs: 0,
    plusSigningKey: KEYS.signingKey, creemApiKey: 'creem_test_abc', creemProducts: PRODUCTS, creemFetch: creem.fetch,
    resendApiKey: 're_test_key', emailFrom: 'Ben Morin <hello@bemorin.example>', ownerEmail: 'owner@bemorin.example', emailFetch: resend.fetch, emailIntervalMs: 0,
    defer: promise => deferred.push(promise), warn: message => warnings.push(message),
    ...options
  });
  const settle = () => Promise.all(deferred.splice(0));
  return { api, store, clock, creem, resend, deferred, warnings, settle };
}

async function openSqlite(t, migrations = ['0001_planner_api.sql', '0002_team_requests.sql', '0003_plus.sql', '0004_creem_reviews.sql']) {
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
  assert.deepEqual([1, 9, 10, 50, 100, 1000, 100000].map(giftLimit), [1, 9, 11, 55, 110, 1100, 110000]);
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
    assert.equal(gift.limit, 3, label, 'below 10 seats: exactly the seats');
    assert.equal(gift.source, 'manual', label);
    assert.equal(gift.expiresAt, '2027-10-09T08:00:00.000Z', label);
    assert.equal('emailed' in created, false, 'no email unless asked');

    const lower = gift.code.replace(/-/g, '').toLowerCase();
    const info = await asJson(await api(get(`gifts/${lower}`)));
    assert.equal(info.status, 200, label);
    assert.deepEqual(info.body, { org: 'Acme', message: 'Enjoy planning 2027!', seats: 3, redeemed: 0, available: true, expiresAt: '2027-10-09T08:00:00.000Z', status: 'available', plan: '' }, label);

    const ids = new Set();
    for (let index = 0; index < 3; index += 1) {
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
    assert.equal(ids.size, 3, 'one licence id per activation');
    // Below 10 seats there is no margin: 3 activations; the fourth is refused.
    const full = await asJson(await api(post(`gifts/${gift.code}/redeem`)));
    assert.deepEqual(full, { status: 409, body: { error: 'This gift has been fully claimed.' } }, label);
    const after = (await asJson(await api(get(`gifts/${gift.code}`)))).body;
    assert.deepEqual([after.redeemed, after.available, after.status], [3, false, 'claimed'], label);
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
    await store.addGift({ code: 'ABCDEFGHJKMN', org: 'Acme', message: '', seats: 5, redeemed: 0, active: true, currency: '', amount: null, source: 'manual', checkoutRef: null, buyerEmail: '', note: '', createdAt: '2026-10-09T08:00:00.000Z', expiresAt: '2027-10-09T08:00:00.000Z', emailedAt: null });
    assert.equal((await api(get('gifts/ABCD-EFGH-JKMN'))).status, 200, 'the gift can still be shown');
    const off = await asJson(await api(post('gifts/ABCD-EFGH-JKMN/redeem')));
    assert.equal(off.status, 503);
    assert.match(off.body.error, /not set up/);
    assert.equal((await store.getGift('ABCDEFGHJKMN')).redeemed, 0, 'no seat used');
    assert.equal((await api(patch('gifts/ABCD-EFGH-JKMN', { key: 'f'.repeat(64) }))).status, 503);
    assert.equal((await api(post('purchases/claim', { checkout: 'ch_abcdefgh123' }))).status, 503);
    const create = await asJson(await api(post('admin/gifts', { org: 'Acme', seats: 3 }, 'secret')));
    assert.equal(create.status, 503);
    assert.match(create.body.error, /PLUS_SIGNING_KEY/);
    assert.equal((await api(post('admin/licenses', {}, 'secret'))).status, 503);
    const { setup: info } = (await asJson(await api(get('admin/summary', 'secret')))).body;
    assert.deepEqual(info.plus, { configured: false, keySet: !!plusSigningKey, publicKey: '' });
  }
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

test('without the 0003 migration the dashboard still loads and Plus routes explain what is missing', async t => {
  const d1 = await openSqlite(t, ['0001_planner_api.sql', '0002_team_requests.sql']);
  if (!d1) return;
  const { api, creem } = setup({ store: createD1Store(d1) });
  const summary = await asJson(await api(get('admin/summary', 'secret')));
  assert.equal(summary.status, 200);
  assert.equal(summary.body.plusUnavailable, true);
  assert.deepEqual(summary.body.gifts, []);
  for (const call of [get('gifts/ABCD-EFGH-JKMN'), post('gifts/ABCD-EFGH-JKMN/redeem'), post('purchases/claim', { checkout: 'ch_plus1234567' }), post('admin/gifts', { org: 'Acme', seats: 3 }, 'secret')]) {
    const answer = await asJson(await api(call));
    assert.equal(answer.status, 503);
    assert.match(answer.body.error, /migrations/);
  }
  assert.equal(creem.calls.length, 0, 'a claim stops at the missing table, before Creem');
  // Applying 0003 later (or twice) is safe.
  for (let round = 0; round < 2; round += 1) d1.sqlite.exec(readFileSync(new URL('../migrations/0003_plus.sql', import.meta.url), 'utf8'));
  assert.equal((await asJson(await api(get('admin/summary', 'secret')))).body.plusUnavailable, false);
});

test('migration 0003: columns, one gift per checkout, several invoiced gifts', async t => {
  const d1 = await openSqlite(t);
  if (!d1) return;
  const columns = table => d1.sqlite.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
  assert.deepEqual(columns('gifts'), ['code', 'org', 'message', 'seats', 'redeemed', 'active', 'currency', 'amount', 'source', 'stripe_session', 'buyer_email', 'note', 'created_at', 'expires_at', 'emailed_at']);
  assert.deepEqual(columns('purchases'), ['stripe_session', 'kind', 'license_id', 'claims', 'email', 'note', 'created_at']);
  const store = createD1Store(d1);
  const gift = (code, checkoutRef) => ({ code, org: 'Acme', message: '', seats: 5, redeemed: 0, active: true, currency: '', amount: null, source: checkoutRef ? 'creem' : 'manual', checkoutRef, buyerEmail: '', note: '', createdAt: '2026-10-09T08:00:00.000Z', expiresAt: '2027-10-09T08:00:00.000Z', emailedAt: null });
  assert.equal(await store.addGift(gift('AAAAAAAAAAAA', null)), true);
  assert.equal(await store.addGift(gift('BBBBBBBBBBBB', null)), true, 'NULL checkouts do not collide');
  assert.equal(await store.addGift(gift('CCCCCCCCCCCC', 'ch_test_1')), true);
  assert.equal(await store.addGift(gift('DDDDDDDDDDDD', 'ch_test_1')), false, 'one gift per checkout');
  assert.equal(await store.addGift(gift('AAAAAAAAAAAA', 'ch_test_2')), false, 'codes are unique');
  assert.equal((await store.getGiftByCheckout('ch_test_1')).code, 'CCCCCCCCCCCC');
  assert.equal(d1.sqlite.prepare('SELECT stripe_session AS ref FROM gifts WHERE code = ?').get('CCCCCCCCCCCC').ref, 'ch_test_1', 'the column keeps its name');
  assert.deepEqual(await store.giftTotals(), { count: 3, seats: 15, redeemed: 0, paid: 1, test: { count: 0, seats: 0, redeemed: 0 } });
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

test('personal gifts get a message from the giver, to one person or to a family', () => {
  const url = 'https://planner.bemorin.com/?gift=ABCD-EFGH-JKMN';
  const one = giftForwardMessage({ org: 'A friend', message: 'Happy birthday!', url, expiresAt: '2027-10-09T08:00:00.000Z', seats: 1, personal: true });
  assert.equal(one.subject, 'A gift for you: Daily Planner Plus');
  assert.ok(one.text.startsWith('Hi,\n\nI’m giving you Daily Planner Plus'));
  for (const part of [url, 'Happy birthday!', 'until 9 October 2027', 'nothing about you is collected']) assert.ok(one.text.includes(part), part);
  assert.ok(!one.text.includes('A friend'), 'written by the giver, not about them');
  const family = giftForwardMessage({ org: 'Your family', message: '', url, expiresAt: '2027-10-09T08:00:00.000Z', seats: 5, personal: true });
  assert.equal(family.subject, 'A gift for the family: Daily Planner Plus');
  assert.ok(family.text.includes('Each of you opens this link once, on the device where you plan (it works for up to 5 people)'));
  for (const message of [one, family]) assert.doesNotMatch(`${message.subject}\n${message.text}`, /team|company/i);
});

test('the buyer email follows what was bought: personal words for a personal gift, the company for a team', () => {
  const gift = { code: 'ABCDEFGHJKMN', org: 'Camille & co', message: '', seats: 5, expiresAt: '2027-10-09T08:00:00.000Z' };
  const links = { url: 'https://planner.bemorin.com/?gift=ABCD-EFGH-JKMN', manageUrl: 'https://planner.bemorin.com/welcome/thanks/?gift=ABCD-EFGH-JKMN&key=abc' };
  const family = giftBuyerEmail({ gift, ...links, plan: 'family-5' });
  assert.equal(family.subject, 'Your Daily Planner Plus gift is ready');
  for (const content of [family.text, family.html]) assert.doesNotMatch(content, /team|company/i);
  for (const part of [links.url, links.manageUrl, 'for up to 5 people', 'Send this link to your family.', 'Each person opens it once']) assert.ok(family.text.includes(part), part);
  assert.ok(family.html.includes('key=abc') && family.html.includes('&amp;key=abc'), 'links escaped in HTML');
  const one = giftBuyerEmail({ gift: { ...gift, seats: 1 }, ...links, plan: 'gift-1' });
  assert.ok(one.text.includes('Your gift link, for one person') && one.text.includes('They open it once'));
  // A team tier, or a gift made in the dashboard (no plan), keeps the team email.
  for (const plan of ['up-to-50', '', undefined]) {
    const team = giftBuyerEmail({ gift, ...links, plan });
    assert.equal(team.subject, 'Your Daily Planner Plus gift link for Camille & co', String(plan));
    assert.ok(team.text.includes('A message you can forward to your team:') && team.text.includes('Camille & co is giving you Daily Planner Plus'), String(plan));
    assert.ok(team.html.includes('Camille &amp; co'), String(plan));
  }
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
