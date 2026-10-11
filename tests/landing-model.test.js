import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LANDING_EVENTS } from '../src/lib/planner-api.js';
import { PLUS_UPCOMING, TEAM_QUOTE, TEAM_TIERS } from '../src/lib/pricing.js';
import {
  CURRENCY_KEY, TEAM_ROWS, buyState, checkoutUrl, defaultPlan, giftPageParams, isDefaultCompany, lowestPerPerson,
  perPerson, planForPeople, planRow, readCheckoutOptions, rememberCurrency, statusTone, storedCurrency, tierLabel, tierPrice
} from '../welcome/landing-model.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const memory = () => {
  const values = new Map();
  return { getItem: key => (values.has(key) ? values.get(key) : null), setItem: (key, value) => values.set(key, String(value)) };
};

test('the team table lists every priced tier, then the quote', () => {
  assert.deepEqual(TEAM_ROWS.map(row => row.plan), [...TEAM_TIERS.map(tier => tier.plan), TEAM_QUOTE.plan]);
  assert.equal(planRow('up-to-50').seats, 50);
  assert.equal(planRow('nope'), null);
  assert.equal(defaultPlan(), 'up-to-50', 'the highlighted tier is the default');
  assert.equal(tierLabel(planRow('up-to-1000')), 'Up to 1,000 people');
  assert.equal(tierLabel(TEAM_QUOTE), TEAM_QUOTE.label);
});

test('prices per person come from src/lib/pricing.js', () => {
  assert.equal(tierPrice(planRow('up-to-50'), 'EUR'), 595);
  assert.equal(tierPrice(TEAM_QUOTE, 'EUR'), null, 'the quote has no price');
  assert.equal(tierPrice(planRow('up-to-50'), 'GBP'), null);
  assert.equal(perPerson(planRow('up-to-50'), 'EUR'), '€11.90');
  assert.equal(perPerson(planRow('up-to-10'), 'USD'), '$19.50');
  assert.equal(perPerson(TEAM_QUOTE, 'USD'), '');
  assert.equal(lowestPerPerson('EUR'), '€5');
});

test('a number of people picks the smallest tier that fits, or the quote', () => {
  assert.equal(planForPeople(8), 'up-to-10');
  assert.equal(planForPeople(10), 'up-to-10');
  assert.equal(planForPeople(11), 'up-to-50');
  assert.equal(planForPeople(1000), 'up-to-1000');
  assert.equal(planForPeople(1001), TEAM_QUOTE.plan);
  assert.equal(planForPeople('abc'), '');
});

test('the currency choice is remembered, and only EUR or USD', () => {
  const storage = memory();
  assert.equal(storedCurrency(storage), '');
  rememberCurrency('USD', storage);
  assert.equal(storage.getItem(CURRENCY_KEY), 'USD');
  assert.equal(storedCurrency(storage), 'USD');
  rememberCurrency('GBP', storage);
  assert.equal(storedCurrency(storage), 'USD', 'an unknown currency is never stored');
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(storedCurrency(broken), '');
  assert.doesNotThrow(() => rememberCurrency('EUR', broken));
});

test('what is on sale: GET /api/checkout answers, read defensively', () => {
  assert.deepEqual(readCheckoutOptions({ ok: true, plus: ['EUR', 'USD'], gift: ['USD', 'GBP'], test: true }), { known: true, plus: ['EUR', 'USD'], gift: ['USD'], test: true });
  assert.deepEqual(readCheckoutOptions({ ok: true }), { known: true, plus: [], gift: [], test: false });
  assert.equal(readCheckoutOptions({ ok: false, status: 0 }).known, false, 'unreachable: not known yet');
  assert.equal(readCheckoutOptions(null).known, false);
});

test('a buy button is offered only when the item is on sale in the chosen currency', () => {
  const options = readCheckoutOptions({ ok: true, plus: ['EUR'], gift: [] });
  assert.deepEqual(buyState({ apiOn: false, options, item: 'plus', currency: 'EUR' }), { buyable: false, reason: 'off', other: '' });
  assert.deepEqual(buyState({ apiOn: true, options, item: 'plus', currency: 'EUR' }), { buyable: true, reason: '', other: '' });
  assert.deepEqual(buyState({ apiOn: true, options, item: 'plus', currency: 'USD' }), { buyable: false, reason: 'currency', other: 'EUR' });
  assert.deepEqual(buyState({ apiOn: true, options, item: 'gift', currency: 'EUR' }), { buyable: false, reason: 'off', other: '' });
  assert.deepEqual(buyState({ apiOn: true, options: readCheckoutOptions(null), item: 'gift', currency: 'EUR' }), { buyable: true, reason: 'unknown', other: '' }, 'not asked yet: checked on click');
});

test('only a web address is opened as the checkout', () => {
  assert.equal(checkoutUrl('https://checkout.creem.io/ch_123'), 'https://checkout.creem.io/ch_123');
  assert.equal(checkoutUrl(' http://localhost:8093/__fake-creem/pay?checkout=ch_1 '), 'http://localhost:8093/__fake-creem/pay?checkout=ch_1');
  assert.equal(checkoutUrl('javascript:alert(1)'), '');
  assert.equal(checkoutUrl('/relative'), '');
  assert.equal(checkoutUrl(undefined), '');
});

test('every promised Plus feature has a status the page can style', () => {
  assert.ok(PLUS_UPCOMING.length > 0);
  for (const next of PLUS_UPCOMING) assert.notEqual(statusTone(next.status), 'other', `${next.id}: ${next.status}`);
  assert.equal(statusTone('Planned'), 'planned');
  assert.equal(statusTone(' exploring '), 'exploring');
  assert.equal(statusTone('Someday'), 'other');
});

test('the gift page knows when no company name was typed at checkout', () => {
  assert.equal(isDefaultCompany('Your company'), true);
  assert.equal(isDefaultCompany(' your company '), true);
  assert.equal(isDefaultCompany(''), true);
  assert.equal(isDefaultCompany(undefined), true);
  assert.equal(isDefaultCompany('Acme Studio'), false);
});

test('the gift page reads a Creem return, an older confirmation link or a gift page link', () => {
  assert.deepEqual(giftPageParams('?checkout_id=ch_4Kx9z&order_id=ord_1&signature=abc'), { kind: 'checkout', checkout: 'ch_4Kx9z' });
  assert.deepEqual(giftPageParams('?session=cs_test_a1b2c3'), { kind: 'checkout', checkout: 'cs_test_a1b2c3' });
  assert.deepEqual(giftPageParams('?checkout_id=<script>'), { kind: 'checkout', checkout: '' }, 'a malformed reference is refused');
  assert.deepEqual(giftPageParams('?gift=K7QM-4T9X-PZ2R&key=abc'), { kind: 'gift', gift: 'K7QM-4T9X-PZ2R', key: 'abc' });
  assert.deepEqual(giftPageParams(''), { kind: '' });
});

test('every count the landing page sends is in its notice, and every listed count is sent', async () => {
  const sources = await Promise.all(['welcome/landing.js', 'welcome/thanks/thanks.js'].map(file => readFile(join(root, file), 'utf8')));
  const listed = new Set(LANDING_EVENTS.map(([name]) => name));
  const used = new Set();
  for (const source of sources) {
    for (const match of source.matchAll(/\b(?:trackEvent|track)\(\s*'([a-z0-9_]+)'\s*\)/g)) used.add(match[1]);
    // Section views are counted from a map of section id → event name.
    for (const match of source.matchAll(/\['[a-z]+', '([a-z]+_viewed)'\]/g)) used.add(match[1]);
  }
  for (const name of used) assert.ok(listed.has(name), `${name} is counted but not in LANDING_EVENTS`);
  for (const name of listed) assert.ok(used.has(name), `${name} is listed but the landing page never counts it`);
});

test('no Stripe left on the public pages', async () => {
  for (const file of ['welcome/index.html', 'welcome/landing.js', 'welcome/landing.css', 'welcome/landing-model.js', 'welcome/thanks/index.html', 'welcome/thanks/thanks.js']) {
    assert.doesNotMatch(await readFile(join(root, file), 'utf8'), /stripe/i, file);
  }
});
