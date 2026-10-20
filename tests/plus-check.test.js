import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

// A key pair for this run: the planner checks licences with the public key.
const subtle = webcrypto.subtle;
const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const PUBLIC_KEY = Buffer.from(await subtle.exportKey('spki', pair.publicKey)).toString('base64');
globalThis.__DAILY_PLANNER_CONFIG__ = { PLUS_PUBLIC_KEY: PUBLIC_KEY, PLANNER_API_URL: '' };
const stored = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  writable: true,
  value: { getItem: key => (stored.has(key) ? stored.get(key) : null), setItem: (key, value) => stored.set(key, String(value)), removeItem: key => stored.delete(key) }
});

const plus = await import('../src/lib/plus.js');
const { checkOutcome, createPlusCheck, PLUS_CHECK_INTERVAL_MS, PLUS_RECHECK_EVENT, plusCheckDue, plusNotice, requestPlusCheck } = await import('../src/features/plus-check.js');

const DAY = 86400000;
const NOW = Date.parse('2026-10-19T09:00:00Z');
const b64url = bytes => Buffer.from(bytes).toString('base64url');
async function mint(payload) {
  const head = `DP1.${b64url(Buffer.from(JSON.stringify(payload)))}`;
  const signature = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(head));
  return `${head}.${b64url(new Uint8Array(signature))}`;
}
const PURCHASE = { v: 1, p: 'plus', id: 'fedcba9876543210', src: 'purchase', iat: '2026-10-09' };
const GIFT = { v: 1, p: 'plus', id: '0123456789abcdef', src: 'gift', gift: 'aaaaaaaaaaaaaaaa', org: 'Acme', iat: '2026-10-09' };

/** A planner with Plus from `payload`, connected as app.js connects its settings. */
async function planner(payload = PURCHASE, extra = {}) {
  stored.clear();
  const token = await mint(payload);
  const settings = { categories: [], plus: { token, activatedAt: '2026-10-09T10:00:00.000Z' }, ...extra };
  const writes = [];
  await plus.connectPlus({ read: () => settings, write: fields => { writes.push(fields); Object.assign(settings, fields); }, key: PUBLIC_KEY });
  return { token, settings, writes };
}

/** Timers that never fire on their own. */
const timers = () => {
  const pending = [];
  return { pending, setTimeout: (fn, ms) => pending.push({ fn, ms }), clearTimeout: () => {}, setInterval: (fn, ms) => pending.push({ fn, ms, every: true }) };
};

function checker({ answer = { ok: true, revoked: false }, apiOn = true, online = true, now = NOW, ...options } = {}) {
  const calls = [];
  const clock = { now };
  const check = createPlusCheck({
    check: async token => { calls.push(token); if (answer instanceof Error) throw answer; return typeof answer === 'function' ? answer(token) : answer; },
    apiOn: () => apiOn, online: () => online, now: () => clock.now, timers: timers(), doc: null, ...options
  });
  return { check, calls, clock };
}

test('a check is due at most once every 7 days, only with the API, online and with Plus', () => {
  const base = { now: NOW, apiOn: true, online: true, active: true };
  assert.equal(plusCheckDue({ ...base, lastAt: 0 }), true, 'never checked on this device');
  assert.equal(plusCheckDue({ ...base, lastAt: NOW - DAY }), false);
  assert.equal(plusCheckDue({ ...base, lastAt: NOW - PLUS_CHECK_INTERVAL_MS + 1 }), false);
  assert.equal(plusCheckDue({ ...base, lastAt: NOW - PLUS_CHECK_INTERVAL_MS }), true, 'seven days later');
  assert.equal(plusCheckDue({ ...base, lastAt: NOW + DAY }), true, 'the clock moved back');
  assert.equal(plusCheckDue({ ...base, lastAt: 0, apiOn: false }), false, 'no owner API: nothing is sent');
  assert.equal(plusCheckDue({ ...base, lastAt: 0, online: false }), false, 'offline');
  assert.equal(plusCheckDue({ ...base, lastAt: 0, active: false }), false, 'no Plus, nothing to check');
  assert.equal(PLUS_CHECK_INTERVAL_MS, 7 * DAY);
});

test('a member price the server didn’t confirm asks for a check now, whatever the last one', async () => {
  const base = { now: NOW, apiOn: true, online: true, active: true, lastAt: NOW - DAY };
  assert.equal(plusCheckDue({ ...base, force: true }), true);
  for (const off of [{ apiOn: false }, { online: false }, { active: false }]) assert.equal(plusCheckDue({ ...base, force: true, ...off }), false, JSON.stringify(off));
  const { token } = await planner();
  plus.writePlusCheck({ at: NOW - DAY });
  const { check, calls } = checker({ answer: { ok: true, revoked: true } });
  assert.equal(await check.run(), 'skipped', 'checked yesterday');
  assert.equal(await check.run({ force: true }), 'revoked');
  assert.deepEqual(calls, [token]);
  assert.equal(plus.hasPlus(), false, 'the dialog follows: no member price any more');
  // The Plus dialog asks through an event, which start() listens for.
  const target = new EventTarget();
  let heard = 0;
  target.addEventListener(PLUS_RECHECK_EVENT, () => { heard += 1; });
  requestPlusCheck(target);
  assert.equal(heard, 1);
  assert.doesNotThrow(() => requestPlusCheck(null));
});

test('only a clear answer counts; anything else never removes Plus', () => {
  assert.equal(checkOutcome({ ok: true, revoked: true }), 'revoked');
  assert.equal(checkOutcome({ ok: true, revoked: false }), 'valid');
  for (const answer of [null, undefined, {}, { ok: false, status: 0 }, { ok: false, status: 500, revoked: true }, { ok: true }, { ok: true, revoked: 'yes' }]) assert.equal(checkOutcome(answer), 'error', JSON.stringify(answer));
  // True whether Creem refunded it or the owner switched it off by hand.
  assert.equal(plusNotice('purchase').text, 'Plus was switched off on this planner: its purchase was refunded or cancelled. If this is a mistake, reply to your receipt email.');
  assert.equal(plusNotice('gift').text, 'Plus was switched off on this planner: the gift that activated it was refunded or cancelled. If this is a mistake, ask the person who gave it to you.');
  assert.match(plusNotice('manual').text, /its licence was withdrawn/);
  assert.equal(plusNotice('dev').text, plusNotice('purchase').text);
  assert.equal(plusNotice('purchase').title, 'Plus is no longer active on this planner');
  assert.equal(plusNotice('restored').title, 'Plus is back on this planner');
  assert.match(plusNotice('restored').text, /valid again/);
});

test('the licence is checked right after launch when the last check is older, then not for 7 days', async () => {
  const { token } = await planner();
  const { check, calls, clock } = checker();
  assert.equal(await check.run(), 'valid');
  assert.deepEqual(calls, [token], 'only the licence is sent');
  assert.equal(plus.readPlusCheck().at, NOW);
  assert.equal(JSON.parse(stored.get(plus.PLUS_CHECK_KEY)).at, NOW, 'kept under daily-planner-ui:plus-checked');
  clock.now = NOW + 6 * DAY;
  assert.equal(await check.run(), 'skipped');
  clock.now = NOW + 7 * DAY;
  assert.equal(await check.run(), 'valid');
  assert.equal(calls.length, 2);
  assert.equal(plus.hasPlus(), true);
  assert.ok(plus.PLUS_CHECK_KEY.startsWith('daily-planner-ui:'), 'never synced or backed up');
});

test('API off, offline or without Plus: nothing is sent', async () => {
  await planner();
  for (const options of [{ apiOn: false }, { online: false }]) {
    const { check, calls } = checker(options);
    assert.equal(await check.run(), 'skipped', JSON.stringify(options));
    assert.equal(calls.length, 0);
  }
  stored.clear();
  const settings = { categories: [] };
  await plus.connectPlus({ read: () => settings, write: fields => Object.assign(settings, fields), key: PUBLIC_KEY });
  const { check, calls } = checker();
  assert.equal(await check.run(), 'skipped');
  assert.equal(calls.length, 0);
});

test('a network or server error keeps Plus and tries again next time', async () => {
  const { settings, token } = await planner();
  for (const answer of [{ ok: false, status: 0, offline: false, error: 'Could not reach the server.' }, { ok: false, status: 503 }, { ok: false, status: 400, error: 'This licence is not valid.' }, new Error('network down')]) {
    const { check, calls } = checker({ answer });
    assert.equal(await check.run(), 'error');
    assert.equal(calls.length, 1);
    assert.equal(plus.hasPlus(), true);
    assert.equal(settings.plus.token, token);
    assert.equal(plus.readPlusCheck().at, 0, 'not marked as checked: asked again at the next launch');
  }
});

test('a revoked licence removes Plus from this planner, leaves a notice and stays off after sync', async () => {
  const { settings, token, writes } = await planner(GIFT, { plusGift: { code: 'ABCD-EFGH-JKMN', org: 'Acme' } });
  const changes = [];
  const stop = plus.onPlusChange(active => changes.push(active));
  const { check } = checker({ answer: { ok: true, revoked: true } });
  assert.equal(await check.run(), 'revoked');
  stop();
  assert.equal(plus.hasPlus(), false);
  assert.deepEqual(changes, [false]);
  assert.deepEqual(writes.at(-1), { plus: null, plusGift: null }, 'removed from the settings, as a reset would');
  assert.deepEqual(plus.readPlusCheck(), { at: NOW, revoked: [GIFT.id], held: { token, activatedAt: '2026-10-09T10:00:00.000Z', gift: { code: 'ABCD-EFGH-JKMN', org: 'Acme' } }, notice: 'gift' });
  assert.equal(stored.get('daily-planner-ui:plus-verified'), undefined, 'no longer on from the first paint');

  // Google Drive sync, a backup or another tab brings the same licence back: it stays off.
  settings.plus = { token, activatedAt: 'x' };
  assert.equal(await plus.refreshPlus(), false);
  assert.equal(plus.hasPlus(), false);
  const reloaded = { categories: [], plus: { token, activatedAt: 'x' } };
  assert.equal(await plus.connectPlus({ read: () => reloaded, write: fields => Object.assign(reloaded, fields), key: PUBLIC_KEY }), false);

  // Opened again by hand (after a Restore, say): active, and checked again at once.
  const activated = await plus.activatePlusToken(token);
  assert.equal(activated.ok, true);
  assert.equal(plus.hasPlus(), true);
  assert.deepEqual(plus.readPlusCheck().revoked, []);
  assert.equal(plus.readPlusCheck().held, null, 'no longer kept aside');
  assert.equal(plus.readPlusCheck().at, 0);
});

test('a revoked licence is asked about each week while Plus is off; once it is valid again, Plus comes back with a notice', async () => {
  const { settings, token } = await planner(GIFT, { plusGift: { code: 'ABCD-EFGH-JKMN', org: 'Acme' } });
  let answer = { ok: true, revoked: true };
  const { check, calls, clock } = checker({ answer: () => answer });
  assert.equal(await check.run(), 'revoked');
  assert.equal(plus.hasPlus(), false);
  assert.equal(settings.plus, null);
  plus.writePlusCheck({ notice: '' });

  // Still revoked a week later: asked again (the licence alone), nothing changes.
  clock.now = NOW + 3 * DAY;
  assert.equal(await check.run(), 'skipped', 'at most once a week while revoked too');
  clock.now = NOW + 7 * DAY;
  assert.equal(await check.run(), 'revoked');
  assert.deepEqual(calls, [token, token], 'the licence kept aside, and nothing else');
  assert.equal(plus.hasPlus(), false);
  assert.equal(plus.readPlusCheck().notice, '', 'no second notice');

  // The owner restored it: the next weekly check brings Plus back, as it was.
  answer = { ok: true, revoked: false };
  const changes = [];
  const stop = plus.onPlusChange(active => changes.push(active));
  clock.now = NOW + 14 * DAY;
  assert.equal(await check.run(), 'restored');
  stop();
  assert.equal(plus.hasPlus(), true);
  assert.deepEqual(changes, [true]);
  assert.deepEqual(settings.plus, { token, activatedAt: '2026-10-09T10:00:00.000Z' });
  assert.deepEqual(settings.plusGift, { code: 'ABCD-EFGH-JKMN', org: 'Acme' });
  assert.deepEqual(plus.readPlusCheck(), { at: NOW + 14 * DAY, revoked: [], held: null, notice: 'restored' });
  assert.equal(stored.get('daily-planner-ui:plus-verified'), token, 'on from the first paint again');
  // From now on it is the active licence, checked weekly as before.
  clock.now = NOW + 21 * DAY;
  assert.equal(await check.run(), 'valid');
});

test('errors never restore, nor remove, a licence kept aside; another licence active meanwhile wins', async () => {
  const { settings, token } = await planner();
  await checker({ answer: { ok: true, revoked: true } }).check.run();
  for (const answer of [{ ok: false, status: 0 }, { ok: false, status: 500 }, { ok: true }, new Error('down')]) {
    const { check } = checker({ answer, now: NOW + 8 * DAY });
    assert.equal(await check.run(), 'error');
    assert.equal(plus.hasPlus(), false);
    assert.equal(plus.readPlusCheck().held.token, token, 'still kept aside');
  }
  // Offline or without the API: nothing is sent.
  for (const options of [{ online: false }, { apiOn: false }]) {
    const { check, calls } = checker({ ...options, now: NOW + 8 * DAY });
    assert.equal(await check.run(), 'skipped');
    assert.equal(calls.length, 0);
  }
  // Plus from another licence meanwhile: that one is checked; the one kept aside is left alone.
  const other = await mint({ ...PURCHASE, id: '2222222222222222' });
  assert.equal((await plus.activatePlusToken(other)).ok, true);
  const { check, calls } = checker({ answer: { ok: true, revoked: false }, now: NOW + 8 * DAY });
  assert.equal(await check.run(), 'valid');
  assert.deepEqual(calls, [other]);
  assert.equal(settings.plus.token, other);
  // Restoring by hand while another licence is active only clears the record.
  assert.equal(await plus.restorePlus(token), false);
  assert.equal(settings.plus.token, other);
  assert.deepEqual([plus.readPlusCheck().revoked, plus.readPlusCheck().held], [[], null]);
});

test('a licence replaced while the server answered is not removed', async () => {
  const { settings } = await planner();
  const other = await mint({ ...PURCHASE, id: '1111111111111111' });
  const { check } = checker({ answer: () => { settings.plus = { token: other, activatedAt: 'y' }; return { ok: true, revoked: true }; } });
  assert.equal(await check.run(), 'revoked');
  assert.equal(settings.plus.token, other);
  assert.deepEqual(plus.readPlusCheck().revoked, []);
  assert.equal(plus.readPlusCheck().notice, '');
});

test('the notice waits for other dialogs, then shows once with the app’s own dialog helpers', async () => {
  await planner();
  plus.writePlusCheck({ notice: 'purchase' });
  const opened = [];
  let active = { name: 'onboarding' };
  const element = () => {
    const children = {};
    return { hidden: false, textContent: '', className: '', innerHTML: '', setAttribute() {}, addEventListener() {}, append() {}, querySelectorAll: () => [], querySelector: selector => (children[selector] ||= element()) };
  };
  const doc = { body: element(), querySelector: () => null, createElement: () => element() };
  const clock = timers();
  const check = createPlusCheck({ openModal: (modal, focus) => opened.push({ modal, focus }), closeModal: () => {}, getActiveModal: () => active, apiOn: () => false, timers: clock, doc });
  assert.equal(check.showNotice(), false, 'never over another dialog');
  assert.equal(clock.pending.length, 1);
  assert.equal(plus.readPlusCheck().notice, 'purchase', 'still waiting');
  active = null;
  assert.equal(clock.pending[0].fn(), true);
  assert.equal(opened.length, 1);
  const { modal } = opened[0];
  assert.equal(modal.querySelector('[data-plus-revoked-title]').textContent, 'Plus is no longer active on this planner');
  assert.equal(modal.querySelector('[data-plus-revoked-text]').textContent, plusNotice('purchase').text);
  assert.ok(opened[0].focus, 'focus goes to OK');
  assert.equal(plus.readPlusCheck().notice, '', 'shown once');
  assert.equal(check.showNotice(), false);
});

test('the check record is read safely', () => {
  stored.set(plus.PLUS_CHECK_KEY, '{broken');
  assert.deepEqual(plus.readPlusCheck(), { at: 0, revoked: [], held: null, notice: '' });
  stored.set(plus.PLUS_CHECK_KEY, JSON.stringify({ at: 'x', revoked: ['nothex', 'abcdefabcdefabcd'], held: { token: 'not a licence' }, notice: 'other' }));
  assert.deepEqual(plus.readPlusCheck(), { at: 0, revoked: ['abcdefabcdefabcd'], held: null, notice: '' });
  stored.set(plus.PLUS_CHECK_KEY, JSON.stringify({ held: { token: 'DP1.abc.def', activatedAt: 5, gift: { code: 'nope' } }, notice: 'restored' }));
  assert.deepEqual(plus.readPlusCheck(), { at: 0, revoked: [], held: { token: 'DP1.abc.def', activatedAt: '', gift: null }, notice: 'restored' });
  stored.set(plus.PLUS_CHECK_KEY, JSON.stringify({ held: { token: `DP1.${'a'.repeat(3000)}.b` } }));
  assert.equal(plus.readPlusCheck().held, null, 'too long');
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.deepEqual(plus.readPlusCheck(broken), { at: 0, revoked: [], held: null, notice: '' });
  assert.doesNotThrow(() => plus.writePlusCheck({ at: 1 }, broken));
});
