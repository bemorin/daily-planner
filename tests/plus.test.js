import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

// A key pair made for this test run, exactly as the server would hold one:
// PKCS#8 private key to sign, SPKI public key (base64) in the runtime config.
const subtle = webcrypto.subtle;
const algorithm = { name: 'ECDSA', namedCurve: 'P-256' };
const pair = await subtle.generateKey(algorithm, true, ['sign', 'verify']);
const other = await subtle.generateKey(algorithm, true, ['sign', 'verify']);
const spki = async key => Buffer.from(await subtle.exportKey('spki', key)).toString('base64');
const PUBLIC_KEY = await spki(pair.publicKey);
const OTHER_KEY = await spki(other.publicKey);

globalThis.__DAILY_PLANNER_CONFIG__ = { PLUS_PUBLIC_KEY: PUBLIC_KEY, PLANNER_API_URL: '' };
const stored = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  writable: true,
  value: { getItem: key => (stored.has(key) ? stored.get(key) : null), setItem: (key, value) => stored.set(key, String(value)), removeItem: key => stored.delete(key) }
});

const plus = await import('../src/lib/plus.js');
const { currencyNote, giftLabel, giverName, plusFeatureId, plusProblem, PLUS_FEATURES } = await import('../src/features/plus-dialog.js');
const { PERSONAL_GIFTS } = await import('../src/lib/pricing.js');

const b64url = bytes => Buffer.from(bytes).toString('base64url');
async function mint(payload, key = pair.privateKey) {
  const head = `DP1.${b64url(Buffer.from(JSON.stringify(payload)))}`;
  const signature = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(head));
  return `${head}.${b64url(new Uint8Array(signature))}`;
}
// Changes one character in the middle of the signature (its last character carries padding bits).
const tamper = token => { const at = token.length - 20; return `${token.slice(0, at)}${token[at] === 'A' ? 'B' : 'A'}${token.slice(at + 1)}`; };
const giftPayload = { v: 1, p: 'plus', id: '0123456789abcdef', src: 'gift', org: 'Acme Studio', iat: '2026-10-09T10:00:00.000Z' };
const purchasePayload = { v: 1, p: 'plus', id: 'fedcba9876543210', src: 'purchase', iat: '2026-10-09T10:00:00.000Z' };

function settingsSource(initial = {}) {
  const settings = { categories: [], ...initial };
  return { settings, read: () => settings, write: fields => Object.assign(settings, fields) };
}

test('a licence signed with the configured key verifies; anything else does not', async () => {
  const token = await mint(giftPayload);
  assert.deepEqual(await plus.verifyPlusToken(token), giftPayload);
  assert.deepEqual(await plus.verifyPlusToken(token, PUBLIC_KEY, subtle), giftPayload);

  const [, body, signature] = token.split('.');
  const forged = `DP1.${b64url(Buffer.from(JSON.stringify({ ...giftPayload, org: 'Someone else' })))}.${signature}`;
  assert.equal(await plus.verifyPlusToken(forged), null, 'tampered payload');
  assert.equal(await plus.verifyPlusToken(tamper(token)), null, 'tampered signature');
  assert.equal(await plus.verifyPlusToken(token, OTHER_KEY), null, 'another key');
  assert.equal(await plus.verifyPlusToken(token, ''), null, 'no key configured');
  assert.equal(await plus.verifyPlusToken(await mint(giftPayload, other.privateKey)), null, 'signed by another key');
  for (const bad of ['', 'DP1', 'DP2.abc.def', `DP1.${body}`, `DP1.${body}.c2hvcnQ`, 'not a token']) assert.equal(await plus.verifyPlusToken(bad), null, bad);
  assert.equal(await plus.verifyPlusToken(await mint({ ...giftPayload, p: 'pro' })), null, 'only Plus licences');
  assert.equal(await plus.verifyPlusToken(await mint({ ...giftPayload, id: 'xyz' })), null, 'id must be 16 hex');
});

test('activating stores the licence in the settings, notifies once and survives a reload', async () => {
  stored.clear();
  const source = settingsSource();
  await plus.connectPlus({ read: source.read, write: source.write, key: PUBLIC_KEY });
  assert.equal(plus.hasPlus(), false);
  assert.equal(plus.plusAvailable(), true);
  const seen = [];
  const stop = plus.onPlusChange(active => seen.push(active));
  const token = await mint(giftPayload);
  const result = await plus.activatePlusToken(token, { gift: { code: 'abcd efgh jkmn', org: 'Acme Studio' } });
  assert.equal(result.ok, true);
  assert.equal(result.already, false);
  assert.equal(plus.hasPlus(), true);
  assert.deepEqual(seen, [true]);
  assert.equal(source.settings.plus.token, token);
  assert.match(source.settings.plus.activatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(source.settings.plusGift, { code: 'ABCD-EFGH-JKMN', org: 'Acme Studio' });
  assert.equal(plus.plusLicense().org, 'Acme Studio');

  const again = await plus.activatePlusToken(token);
  assert.equal(again.already, true);
  assert.deepEqual(seen, [true], 'the same licence twice is not a change');
  stop();

  // A new page load: the verified licence is active before the async check finishes.
  const reloaded = settingsSource(JSON.parse(JSON.stringify(source.settings)));
  const check = plus.connectPlus({ read: reloaded.read, write: reloaded.write, key: PUBLIC_KEY });
  assert.equal(plus.hasPlus(), true, 'on from the first paint');
  assert.equal(await check, true);
});

test('a tampered stored licence, or one from another key, is not active', async () => {
  stored.clear();
  const token = await mint(purchasePayload);
  const tampered = settingsSource({ plus: { token: tamper(token), activatedAt: '' } });
  assert.equal(await plus.connectPlus({ read: tampered.read, write: tampered.write, key: PUBLIC_KEY }), false);
  assert.equal(plus.hasPlus(), false);
  const foreign = settingsSource({ plus: { token: await mint(purchasePayload, other.privateKey), activatedAt: '' } });
  assert.equal(await plus.connectPlus({ read: foreign.read, write: foreign.write, key: PUBLIC_KEY }), false);
  const rejected = await plus.activatePlusToken(await mint(purchasePayload, other.privateKey));
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'invalid');
  assert.equal(foreign.settings.plus.token.startsWith('DP1.'), true, 'a failed activation leaves the settings alone');
});

test('without a public key Plus cannot be activated in this copy', async () => {
  stored.clear();
  const source = settingsSource({ plus: { token: await mint(giftPayload), activatedAt: '' } });
  assert.equal(await plus.connectPlus({ read: source.read, write: source.write, key: '' }), false);
  assert.equal(plus.plusAvailable(), false);
  assert.equal(plus.hasPlus(), false);
  const result = await plus.activatePlusToken(await mint(giftPayload));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unavailable');
  assert.match(result.error, /isn’t available in this copy/);
});

test('the licence is kept through imports, resets, sync and other tabs', async () => {
  const token = await mint(giftPayload);
  assert.deepEqual(plus.plusSettingsFrom({ plus: { token, activatedAt: 'x' }, plusGift: { code: 'abcdefghjkmn', org: 'Acme' } }), { plus: { token, activatedAt: 'x' }, plusGift: { code: 'ABCD-EFGH-JKMN', org: 'Acme' } });
  assert.deepEqual(plus.plusSettingsFrom({ plus: { token: 'nope' } }), {});
  assert.deepEqual(plus.plusSettingsFrom(null), {});

  const next = { categories: [] };
  assert.equal(plus.keepPlus(next, { plus: { token, activatedAt: 'x' } }), true);
  assert.equal(next.plus.token, token);
  assert.equal(plus.keepPlus(next, { plus: { token: 'other' } }), false, 'a licence already there wins');
  assert.equal(plus.keepPlus({}, {}), false);

  const tab = { categories: [] };
  assert.equal(plus.adoptPlus(tab, JSON.stringify({ plus: { token, activatedAt: 'x' } })), true);
  assert.equal(tab.plus.token, token);
  assert.equal(plus.adoptPlus(tab, JSON.stringify({ plus: { token, activatedAt: 'x' } })), false, 'nothing new');
  assert.equal(plus.adoptPlus(tab, '{broken'), false);
});

test('gift codes are read however they are typed', () => {
  assert.equal(plus.normalizeGiftCode('abcd-efgh-jkmn'), 'ABCD-EFGH-JKMN');
  assert.equal(plus.normalizeGiftCode('ABCDEFGHJKMN'), 'ABCD-EFGH-JKMN');
  assert.equal(plus.normalizeGiftCode(' abcd efgh jkmn '), 'ABCD-EFGH-JKMN');
  assert.equal(plus.normalizeGiftCode('ABCD–EFGH–JKMN'), 'ABCD-EFGH-JKMN', 'typographic dashes');
  assert.equal(plus.normalizeGiftCode('ABCD-EFGH-JKM0'), '', 'no zero');
  assert.equal(plus.normalizeGiftCode('ABCD-EFGH-JKMI'), '', 'no I');
  assert.equal(plus.normalizeGiftCode('ABCD-EFGH-JKM'), '');
  assert.equal(plus.normalizeGiftCode(''), '');
});

test('the gift field accepts links, codes, licences and purchase links', async () => {
  const token = await mint(giftPayload);
  assert.deepEqual(plus.parsePlusInput('https://planner.bemorin.com/?gift=abcd-efgh-jkmn'), { kind: 'gift', code: 'ABCD-EFGH-JKMN' });
  assert.deepEqual(plus.parsePlusInput('planner.bemorin.com/?gift=ABCDEFGHJKMN&utm=x'), { kind: 'gift', code: 'ABCD-EFGH-JKMN' });
  assert.deepEqual(plus.parsePlusInput('abcd-efgh-jkmn'), { kind: 'gift', code: 'ABCD-EFGH-JKMN' });
  assert.deepEqual(plus.parsePlusInput(` ${token} `), { kind: 'license', token });
  assert.deepEqual(plus.parsePlusInput(`https://planner.bemorin.com/?license=${token}`), { kind: 'license', token });
  assert.deepEqual(plus.parsePlusInput('https://planner.bemorin.com/?purchase=cs_test_a1B2c3'), { kind: 'purchase', checkout: 'cs_test_a1B2c3' }, 'older receipt links');
  assert.deepEqual(plus.parsePlusInput('https://planner.bemorin.com/?purchase=ch_4bXk2Lm9QrT'), { kind: 'purchase', checkout: 'ch_4bXk2Lm9QrT' }, 'the receipt email');
  assert.deepEqual(plus.parsePlusInput('https://planner.bemorin.com/?checkout_id=ch_4bXk2Lm9QrT&order_id=ord_1&signature=abc'), { kind: 'purchase', checkout: 'ch_4bXk2Lm9QrT' }, 'back from the payment page');
  assert.deepEqual(plus.parsePlusInput('ch_4bXk2Lm9QrT'), { kind: 'purchase', checkout: 'ch_4bXk2Lm9QrT' }, 'a checkout reference on its own');
  assert.deepEqual(plus.parsePlusInput('https://planner.bemorin.com/?purchase=x'), { kind: 'invalid' });
  assert.equal(plus.isCheckoutReference('ch_4bXk2Lm9QrT'), true);
  assert.equal(plus.isCheckoutReference('fake_plus'), true, 'dev shortcut');
  assert.equal(plus.isCheckoutReference('<script>'), false);
  assert.equal(plus.isCheckoutReference(''), false);
  assert.deepEqual(plus.parsePlusInput('https://planner.bemorin.com/?gift=short'), { kind: 'invalid' });
  assert.deepEqual(plus.parsePlusInput('hello there'), { kind: 'invalid' });
  assert.deepEqual(plus.parsePlusInput('   '), { kind: 'empty' });
});

test('the price is shown in euros in the euro area and in dollars elsewhere', () => {
  for (const locale of ['fr-FR', 'de', 'de-AT', 'en-IE', 'nl-BE', 'el', 'hr', 'bg', 'ca-AD', 'it-SM', 'sr-Latn-ME', 'sq-XK', 'fr-MC']) assert.equal(plus.plusCurrency(locale), 'EUR', locale);
  for (const locale of ['en-US', 'en', 'en-GB', 'fr-CA', 'de-CH', 'es-MX', 'pt-BR', 'ja', '', 'not a locale']) assert.equal(plus.plusCurrency(locale), 'USD', locale);
  assert.equal(plus.formatPlusPrice('en-US'), '$29');
  assert.match(plus.formatPlusPrice('fr-FR'), /^29\s€$/);
  assert.equal(plus.formatPlusPrice('en-IE'), '€29');
  assert.doesNotMatch(plus.formatPlusPrice('de-DE'), /[.,]00/, 'no decimals');
});

test('the status line says where Plus came from', () => {
  assert.equal(plus.plusStatusLine(null), '');
  assert.equal(plus.plusStatusLine(giftPayload), 'Plus is active · from Acme Studio');
  assert.equal(plus.plusStatusLine({ ...giftPayload, org: undefined }, { gift: { org: 'Studio B' } }), 'Plus is active · from Studio B');
  assert.match(plus.plusStatusLine(purchasePayload, { locale: 'en-GB' }), /^Plus is active · purchased on 9 Oct 2026$/);
  assert.match(plus.plusStatusLine({ ...purchasePayload, src: 'manual' }, { activatedAt: '2026-10-10T08:00:00Z', locale: 'en-GB' }), /since 10 Oct 2026$/);
});

test('Horizon features open the dialog on themselves, and problems are explained calmly', () => {
  assert.deepEqual(PLUS_FEATURES.map(feature => feature.id), ['year-plan', 'year-review', 'paint-palettes']);
  assert.equal(plusFeatureId('year-plan'), 'year-plan');
  assert.equal(plusFeatureId('Year-Review'), 'year-review');
  assert.equal(plusFeatureId('palettes'), 'paint-palettes');
  assert.equal(plusFeatureId('unknown'), '');

  assert.match(plusProblem('gift', { status: 409 }, { org: 'Acme' }).title, /fully claimed/);
  assert.match(plusProblem('gift', { status: 409 }, { org: 'Acme' }).text, /Ask Acme/);
  assert.match(plusProblem('gift', { status: 410 }).title, /expired/);
  assert.match(plusProblem('gift', { status: 404 }).title, /couldn’t find this gift/);
  assert.equal(plusProblem('gift', { status: 0, offline: true }).title, 'You’re offline');
  assert.equal(plusProblem('gift', { status: 0 }).retry, true);
  assert.equal(plusProblem('gift', { unavailable: true }).site, true);
  assert.equal(plusProblem('purchase', { status: 402 }).keep, true, 'an unfinished payment is tried again later');
  assert.equal(plusProblem('purchase', { status: 404 }).keep, undefined, 'an unknown session is forgotten');
  assert.match(plusProblem('purchase', { status: 0 }).text, /payment is safe/);
});

test('a refunded purchase link is explained once, not retried and not kept pending', () => {
  const refunded = plusProblem('purchase', { status: 410, refunded: true, error: 'This purchase was refunded on 3 October.' });
  assert.equal(refunded.title, 'This purchase was refunded');
  assert.equal(refunded.text, 'This purchase was refunded on 3 October.', 'the server’s words when it gives them');
  assert.equal(refunded.icon, 'notice');
  assert.equal(refunded.retry, undefined, 'no Try again');
  assert.equal(refunded.keep, undefined, 'the pending purchase is cleared');
  assert.equal(plusProblem('purchase', { status: 410, refunded: true }).text, 'Its Plus was switched off. If this is a mistake, reply to your receipt email.');
  assert.equal(plusProblem('purchase', { refunded: true, error: '  ' }).title, 'This purchase was refunded');
  assert.match(plusProblem('gift', { status: 410 }).title, /expired/, 'gifts keep their own 410 cases');
});

test('every other 410 of a purchase link says what it is, in the server’s words, once', () => {
  const cases = [
    [{ status: 410, test: true, error: 'This was a test purchase, made before payments went live.' }, 'This was a test purchase'],
    [{ status: 410, error: 'This was a test purchase, made before payments went live.' }, 'This was a test purchase'],
    [{ status: 410, expired: true, error: 'This checkout expired before it was paid.' }, 'This checkout expired'],
    [{ status: 410, error: 'This checkout expired before it was paid.' }, 'This checkout expired'],
    [{ status: 410, revoked: true, error: 'This purchase was switched off, so it can’t be activated any more.' }, 'This purchase was switched off'],
    [{ status: 410, error: 'Gone.' }, 'This purchase can’t be activated']
  ];
  for (const [result, title] of cases) {
    const problem = plusProblem('purchase', result);
    assert.equal(problem.title, title, JSON.stringify(result));
    assert.notEqual(problem.title, 'This purchase was refunded', 'refunded only when the server says so');
    assert.equal(problem.text, result.error, 'the server’s own words');
    assert.equal(problem.retry, undefined, 'no Try again');
    assert.equal(problem.keep, undefined, 'the pending purchase is cleared');
  }
  assert.match(plusProblem('purchase', { status: 410 }).text, /reply to your receipt email/);
});

test('the Plus dialog names the currency once and labels the personal gifts', () => {
  assert.equal(currencyNote('EUR'), 'Prices in euros, taxes included.');
  assert.equal(currencyNote('USD'), 'Prices in US dollars, taxes included.');
  const [one, family] = PERSONAL_GIFTS;
  assert.match(giftLabel(one, 'EUR'), /^Give Plus — (€\s?29|29\s?€)$/);
  assert.match(giftLabel(family, 'USD'), /^Plus Family — up to 5 people — \$99$/);
});

test('a gift from no one in particular reads as a sentence', () => {
  assert.equal(giverName('A friend'), 'a friend');
  assert.equal(giverName('Your family'), 'your family');
  assert.equal(giverName('Claire'), 'Claire');
  assert.equal(giverName(''), '');
  assert.match(plusProblem('gift', { status: 409 }, { org: 'A friend' }).text, /Ask the person who sent it/);
  assert.match(plusProblem('gift', { status: 409 }, { org: 'Claire' }).text, /Ask Claire/);
});
