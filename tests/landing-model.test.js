import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LANDING_EVENTS } from '../src/lib/planner-api.js';
import { PERSONAL_GIFTS, PLUS_FEATURES, PLUS_UPCOMING, TEAM_QUOTE, TEAM_TIERS } from '../src/lib/pricing.js';
import {
  PERSONAL_SEATS_MAX, TEAM_ROWS, buyState, checkoutUrl, currencyLine, defaultPlan, giftAudience, giftPageParams, isDefaultCompany,
  lowestPerPerson, pageCurrency, perPerson, personalOffer, planForPeople, planRow, readCheckoutOptions, statusTone, tierLabel, tierPrice, upcomingSentence
} from '../welcome/landing-model.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

test('prices show in the server’s currency for the visitor’s country, else a guess from the languages', () => {
  assert.equal(pageCurrency({ currency: 'EUR' }, ['en-US']), 'EUR', 'the server knows the country: no guessing');
  assert.equal(pageCurrency({ currency: 'USD' }, ['fr-FR']), 'USD');
  assert.equal(pageCurrency({ currency: '' }, ['fr-FR']), 'EUR', 'unknown country (local dev): the languages decide');
  assert.equal(pageCurrency(null, ['en-US']), 'USD');
  assert.equal(pageCurrency({ currency: 'GBP' }, ['de-DE']), 'EUR', 'an unknown currency is ignored');
  assert.equal(currencyLine('EUR'), 'Prices in euros, taxes included.');
  assert.equal(currencyLine('USD'), 'Prices in US dollars, taxes included.');
});

test('what is on sale: GET /api/checkout answers, read defensively', () => {
  assert.deepEqual(readCheckoutOptions({ ok: true, plus: ['EUR', 'USD'], gift: ['USD', 'GBP'], currency: 'EUR', test: true }), { known: true, plus: ['EUR', 'USD'], gift: ['USD'], currency: 'EUR', test: true });
  assert.deepEqual(readCheckoutOptions({ ok: true }), { known: true, plus: [], gift: [], currency: '', test: false });
  assert.equal(readCheckoutOptions({ ok: true, plus: [], currency: 'GBP' }).currency, '');
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
  for (const next of PLUS_UPCOMING) assert.notEqual(statusTone(next.status), 'other', `${next.id}: ${next.status}`);
  assert.equal(statusTone('Planned'), 'planned');
  assert.equal(statusTone(' exploring '), 'exploring');
  assert.equal(statusTone('Someday'), 'other');
});

test('nothing is promised for now: the page hides “Coming to Plus” everywhere, and can show it again', async () => {
  assert.equal(PLUS_UPCOMING.length, 0, 'owner’s decision (1.25): nothing promised');
  assert.equal(upcomingSentence(PLUS_UPCOMING), '');
  assert.equal(upcomingSentence(undefined), '');
  const later = [{ title: 'A', status: 'Planned' }, { title: 'B', status: 'Exploring' }, { title: 'C', status: 'Planned' }, { title: 'D' }];
  assert.equal(upcomingSentence(later), 'Planned: “A” and “C”. Exploring: “B”. Coming: “D”.');
  const page = await readFile(join(root, 'welcome/index.html'), 'utf8');
  // Written hidden, so nothing flashes before landing.js runs; it shows them only when PLUS_UPCOMING has items.
  assert.equal((page.match(/<section class="(?:soon soon--wide|teaser)"[^>]*data-plus-soon hidden>/g) || []).length, 2);
  assert.match(page, /<tbody class="cmp__soon" data-compare-upcoming hidden>/);
  assert.match(page, /<span data-faq-upcoming hidden><\/span>/);
  assert.doesNotMatch(page, /Sync without Google|Your calendar beside your day|An evening nudge|chip--planned|chip--exploring/, 'no promise is written into the page');
  assert.doesNotMatch(page, /planned for Plus/);
  const script = await readFile(join(root, 'welcome/landing.js'), 'utf8');
  assert.match(script, /\[data-plus-soon\], \[data-compare-upcoming\], \[data-faq-upcoming\]'\)\.forEach\(node => \{ node\.hidden = !promised; \}\)/);
});

test('the landing page names every Plus feature, and sharing as free', async () => {
  const page = await readFile(join(root, 'welcome/index.html'), 'utf8');
  for (const feature of PLUS_FEATURES) assert.ok(page.includes(feature.title), feature.title);
  const ritual = page.slice(page.indexOf('<ol class="ritual__steps"'), page.indexOf('</ol>', page.indexOf('<ol class="ritual__steps"')));
  assert.deepEqual([...ritual.matchAll(/<\/span>([^<]+)<\/b>/g)].map(match => match[1]), ['Plan it', 'Print it', 'Check in', 'Look back']);
  assert.deepEqual([...page.matchAll(/<p class="ritual-tag">([^<]+)<\/p>/g)].map(match => match[1]), ['Step 1 · Plan it', 'Step 2 · Print it', 'Step 3 · Check in', 'Step 4 · Look back', 'Also with Plus']);
  const free = page.slice(page.indexOf('<tbody>', page.indexOf('Your year</th>') - 200), page.indexOf('</tbody>', page.indexOf('Your year</th>')));
  assert.match(free, /Share your week and your year as an image/);
  const plus = page.slice(page.indexOf('<tbody class="cmp__plus">'), page.indexOf('</tbody>', page.indexOf('<tbody class="cmp__plus">')));
  assert.match(plus, /Quarterly check-ins/);
  assert.match(plus, /Insights/);
  assert.match(page, /<summary>Can I share my week or my year\?<\/summary>/);
});

test('the gift page knows when no name was typed at checkout', () => {
  assert.equal(isDefaultCompany('Your company'), true);
  assert.equal(isDefaultCompany(' your company '), true);
  assert.equal(isDefaultCompany('A friend'), true, 'Give Plus without a name');
  assert.equal(isDefaultCompany('Your family'), true, 'Plus Family without a name');
  assert.equal(isDefaultCompany(''), true);
  assert.equal(isDefaultCompany(undefined), true);
  assert.equal(isDefaultCompany('Acme Studio'), false);
  assert.equal(isDefaultCompany('Ben'), false);
});

test('personal gifts: their price, and who the gift page speaks to', () => {
  assert.deepEqual(PERSONAL_GIFTS.map(gift => gift.plan), ['gift-1', 'family-5']);
  assert.equal(personalOffer('gift-1', 'EUR').amount, 29);
  assert.equal(personalOffer('family-5', 'USD').amount, 99);
  assert.equal(personalOffer('family-5', 'GBP').amount, null);
  assert.equal(personalOffer('up-to-50', 'EUR'), null, 'a team tier is not a personal gift');
  assert.equal(PERSONAL_SEATS_MAX, 5);
  // The server sends the plan: it decides.
  assert.equal(giftAudience({ plan: 'gift-1', seats: 1 }), 'one');
  assert.equal(giftAudience({ plan: 'family-5', seats: 5 }), 'family');
  assert.equal(giftAudience({ plan: 'up-to-10', seats: 10 }), 'team');
  assert.equal(giftAudience({ plan: '', seats: 3 }), 'team', 'a dashboard gift is for a company');
  // An older server without the plan: a few seats read as a personal gift.
  assert.equal(giftAudience({ seats: 1 }), 'one');
  assert.equal(giftAudience({ seats: 5 }), 'family');
  assert.equal(giftAudience({ seats: 50 }), 'team');
  assert.equal(giftAudience({}), 'team');
});

test('the gift page reads a Creem return, an older confirmation link or a gift page link', () => {
  assert.deepEqual(giftPageParams('?checkout_id=ch_4Kx9z&order_id=ord_1&signature=abc'), { kind: 'checkout', checkout: 'ch_4Kx9z' });
  assert.deepEqual(giftPageParams('?session=cs_test_a1b2c3'), { kind: 'checkout', checkout: 'cs_test_a1b2c3' });
  assert.deepEqual(giftPageParams('?checkout_id=<script>'), { kind: 'checkout', checkout: '' }, 'a malformed reference is refused');
  assert.deepEqual(giftPageParams('?gift=K7QM-4T9X-PZ2R&key=abc'), { kind: 'gift', gift: 'K7QM-4T9X-PZ2R', key: 'abc' });
  assert.deepEqual(giftPageParams(''), { kind: '' });
});

test('every count the landing page sends is in its notice, and every listed count is sent', async () => {
  const sources = await Promise.all(['welcome/landing.js', 'welcome/thanks/thanks.js', 'welcome/partners/partners.js'].map(file => readFile(join(root, file), 'utf8')));
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
  for (const file of ['welcome/index.html', 'welcome/landing.js', 'welcome/landing.css', 'welcome/landing-model.js', 'welcome/listbox.js', 'welcome/stepper.js', 'welcome/thanks/index.html', 'welcome/thanks/thanks.js', 'welcome/partners/index.html', 'welcome/partners/partners.js', 'welcome/partners/partners-model.js']) {
    assert.doesNotMatch(await readFile(join(root, file), 'utf8'), /stripe/i, file);
  }
});

test('the landing page has no native dropdowns and no currency switch', async () => {
  const page = await readFile(join(root, 'welcome/index.html'), 'utf8');
  const script = await readFile(join(root, 'welcome/landing.js'), 'utf8');
  assert.doesNotMatch(page, /<select\b/i, 'dropdowns are the app’s own (listbox.js)');
  assert.doesNotMatch(page, /data-cur(?:rency)?[\s>=]/, 'no EUR / USD switch');
  assert.doesNotMatch(script, /rememberCurrency|storedCurrency|data-cur-switch/);
  assert.match(script, /rememberReferral\(\)/, 'a partner’s link is remembered on load');
  assert.match(await readFile(join(root, 'welcome/thanks/thanks.js'), 'utf8'), /rememberReferral\(\)/);
  assert.match(script, /supportEmail: ''/, 'the support address stays blank in the source');
});

test('pricing is for one person; the team tiers live in the team section', async () => {
  const page = await readFile(join(root, 'welcome/index.html'), 'utf8');
  const section = id => {
    const start = page.indexOf(`id="${id}"`);
    return page.slice(start, page.indexOf('</section>\n\n    <section', start));
  };
  assert.match(section('teams'), /data-tiers/);
  assert.doesNotMatch(section('pricing'), /data-tiers/);
  assert.match(section('pricing'), /href="#teams"/, 'pricing points to the team gift');
  const order = [...page.matchAll(/<section class="(?:hero|section)[^"]*" id="([a-z]+)"/g)].map(match => match[1]);
  assert.deepEqual(order, ['top', 'how', 'progress', 'week', 'tools', 'year', 'yours', 'plus', 'teams', 'pricing', 'faq']);
  const tinted = [...page.matchAll(/<section class="((?:hero|section)[^"]*)" id="([a-z]+)"/g)].map(match => match[1].includes('section--tint'));
  tinted.forEach((tint, index) => assert.ok(!(tint && tinted[index + 1]), `two tinted sections touch at ${order[index]}`));
});

test('country unknown: the language guess, unless only the other currency is on sale', () => {
  assert.equal(pageCurrency({ currency: 'EUR', plus: ['USD'], gift: ['USD'] }, ['en-US']), 'EUR', 'the server’s choice always wins');
  assert.equal(pageCurrency({ currency: '', plus: ['USD'], gift: ['USD'] }, ['fr-FR']), 'USD');
  assert.equal(pageCurrency({ currency: '', plus: ['EUR', 'USD'], gift: [] }, ['fr-FR']), 'EUR');
  assert.equal(pageCurrency({ currency: '', plus: [], gift: [] }, ['fr-FR']), 'EUR', 'nothing on sale: the guess');
});
