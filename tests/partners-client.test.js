import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The owner API on, a commission and a Creem sign-up link configured, and the
// browser pieces the client modules touch.
globalThis.__DAILY_PLANNER_CONFIG__ = { PLANNER_API_URL: '/api/', AFFILIATE_URL: ' https://affiliates.example.com/daily-planner ', AFFILIATE_COMMISSION: ' 30%<b> ' };
const stored = new Map();
const storage = { getItem: key => (stored.has(key) ? stored.get(key) : null), setItem: (key, value) => stored.set(key, String(value)), removeItem: key => stored.delete(key) };
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
const requests = [];
globalThis.fetch = async (url, options = {}) => {
  requests.push({ url, body: JSON.parse(options.body || '{}') });
  return { ok: true, status: 201, json: async () => ({ url: 'https://checkout.creem.io/ch_1' }) };
};

const api = await import('../src/lib/planner-api.js');
const config = await import('../src/config.js');
const plus = await import('../src/lib/plus.js');
const { giftLabel, partnerEarnText } = await import('../src/features/plus-dialog.js');
const model = await import('../welcome/partners/partners-model.js');
const { memberPriceNotice, memberPriceShown, PERSONAL_GIFTS } = await import('../src/lib/pricing.js');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => readFile(join(root, rel), 'utf8');

test('a gift checkout carries the licence only for a personal gift, with the partner code when there is one', async () => {
  stored.clear();
  requests.length = 0;
  await api.startCheckout({ item: 'gift', plan: 'gift-1', currency: 'EUR', license: ' DP1.a.b ' });
  await api.startCheckout({ item: 'gift', plan: 'family-5', currency: 'USD', license: 'DP1.a.b' });
  await api.startCheckout({ item: 'gift', plan: 'up-to-50', currency: 'EUR', license: 'DP1.a.b' });
  await api.startCheckout({ item: 'plus', currency: 'EUR', license: 'DP1.a.b' });
  await api.startCheckout({ item: 'gift', plan: 'gift-1', currency: 'EUR' });
  api.rememberReferral('?ref=CAMILLE');
  await api.startCheckout({ item: 'gift', plan: 'gift-1', currency: 'EUR', license: 'DP1.a.b' });
  assert.deepEqual(requests.map(entry => entry.body), [
    { item: 'gift', plan: 'gift-1', currency: 'EUR', license: 'DP1.a.b' },
    { item: 'gift', plan: 'family-5', currency: 'USD', license: 'DP1.a.b' },
    { item: 'gift', plan: 'up-to-50', currency: 'EUR' },
    { item: 'plus', plan: '', currency: 'EUR' },
    { item: 'gift', plan: 'gift-1', currency: 'EUR' },
    { item: 'gift', plan: 'gift-1', currency: 'EUR', ref: 'CAMILLE', license: 'DP1.a.b' }
  ]);
  assert.ok(requests.every(entry => entry.url === '/api/checkout'));
});

test('partner hints: shown with the API on until dismissed (or followed), place by place, outside backups and sync', () => {
  stored.clear();
  assert.ok(api.PARTNER_HINTS_KEY.startsWith('daily-planner-ui:'), 'never synced or backed up');
  assert.deepEqual(api.dismissedPartnerHints(), []);
  for (const place of api.PARTNER_HINT_PLACES) assert.equal(api.partnerHintShown(place), true, place);
  assert.equal(api.partnerHintShown('elsewhere'), false);
  assert.deepEqual(api.dismissPartnerHint('share'), ['share']);
  assert.deepEqual(api.dismissPartnerHint('share'), ['share'], 'once');
  assert.deepEqual(api.dismissPartnerHint('nope'), ['share']);
  assert.equal(api.partnerHintShown('share'), false);
  assert.equal(api.partnerHintShown('plus'), true);
  api.dismissPartnerHint('plus');
  assert.deepEqual(JSON.parse(stored.get(api.PARTNER_HINTS_KEY)), ['share', 'plus']);
  stored.set(api.PARTNER_HINTS_KEY, '{broken');
  assert.deepEqual(api.dismissedPartnerHints(), [], 'unreadable: shown again rather than failing');
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.doesNotThrow(() => api.dismissPartnerHint('gift', broken));
  assert.deepEqual(api.dismissedPartnerHints(broken), []);
});

test('the landing page finds the planner’s licence on this site, unless this device found it revoked', () => {
  stored.clear();
  assert.equal(plus.savedPlusToken(), '');
  const payload = Buffer.from(JSON.stringify({ v: 1, p: 'plus', id: '0123456789abcdef', src: 'purchase', iat: '2026-10-20' })).toString('base64url');
  const token = `DP1.${payload}.${Buffer.alloc(64, 1).toString('base64url')}`;
  stored.set(plus.PLANNER_SETTINGS_KEY, JSON.stringify({ weekStartsOn: 1, plus: { token, activatedAt: '2026-10-20' } }));
  assert.equal(plus.savedPlusToken(), token);
  plus.writePlusCheck({ revoked: ['0123456789abcdef'] });
  assert.equal(plus.savedPlusToken(), '', 'refunded on this device: no member price shown');
  stored.set(plus.PLANNER_SETTINGS_KEY, '{nope');
  assert.equal(plus.savedPlusToken(), '');
  stored.set(plus.PLANNER_SETTINGS_KEY, JSON.stringify({ plus: { token: 'DP1.not-a-licence' } }));
  assert.equal(plus.savedPlusToken(), '');
});

test('config: the partner link must be https and the commission one short plain line; the runtime defaults stay blank', async () => {
  assert.equal(config.AFFILIATE_URL, 'https://affiliates.example.com/daily-planner');
  assert.equal(config.AFFILIATE_COMMISSION, '30%b');
  const runtime = await read('runtime-config.js');
  for (const key of ['AFFILIATE_URL', 'AFFILIATE_COMMISSION']) assert.match(runtime, new RegExp(`\\n  ${key}: ''[,\\n]`), key);
  const build = await read('scripts/build.mjs');
  assert.match(build, /AFFILIATE_URL: process\.env\.DAILY_PLANNER_AFFILIATE_URL \|\| ''/);
  assert.match(build, /AFFILIATE_COMMISSION: process\.env\.DAILY_PLANNER_AFFILIATE_COMMISSION \|\| ''/);
  assert.match(await read('scripts/check.mjs'), /'AFFILIATE_URL', 'AFFILIATE_COMMISSION'\]/);
});

test('the partners page: Become a partner goes to Creem, or to the question form while no link is set', () => {
  const set = model.partnerPage({ url: 'https://affiliates.example.com/x', commission: ' 30% ' });
  assert.deepEqual(set, { href: 'https://affiliates.example.com/x', external: true, commission: '30%', earn: '30% of what they pay', short: '30%', figure: '30%', big: '30%', of: 'on every purchase made through your link' });
  const blank = model.partnerPage({});
  assert.equal(blank.href, model.PARTNER_QUESTION_HREF);
  assert.equal(blank.href, '../?ask=question&topic=partners#request');
  assert.equal(blank.external, false);
  assert.equal(blank.earn, 'a commission');
  assert.equal(blank.figure, 'A commission');
  for (const url of ['http://affiliates.example.com', 'javascript:alert(1)', 'https://a b', ' ', null]) assert.equal(model.partnerPage({ url }).external, false, String(url));
  assert.equal(model.cleanCommission('  25%\n for a year <script> '), '25% for a year script');
  assert.equal(model.cleanCommission('x'.repeat(40)).length, 24);
});

test('the Plus dialog: member prices in the gift buttons, and the partner card’s words follow the commission', () => {
  const [one, family] = PERSONAL_GIFTS;
  assert.match(giftLabel(one, 'EUR', { member: true }), /^Give Plus — member price (€\s?24|24\s?€), was (€\s?29|29\s?€)$/);
  assert.equal(giftLabel(family, 'USD', { member: true }), 'Plus Family — up to 5 people — member price $79, was $99');
  assert.equal(giftLabel(family, 'USD'), 'Plus Family — up to 5 people — $99');
  assert.equal(partnerEarnText('30%'), '30% of every purchase made through your link');
  assert.equal(partnerEarnText(''), 'a commission on every purchase made through your link');
});

test('a member price the checkout doesn’t confirm is said before paying, with the usual price; the page and the planner follow', async () => {
  // Shown: a member, a personal gift with a member price lower than the usual one.
  assert.equal(memberPriceShown('gift-1', 'EUR', true), true);
  assert.equal(memberPriceShown('family-5', 'USD', true), true);
  assert.equal(memberPriceShown('gift-1', 'EUR', false), false, 'not a member');
  assert.equal(memberPriceShown('up-to-50', 'EUR', true), false, 'team packs have no member price');
  assert.equal(memberPriceShown('gift-1', 'GBP', true), false);
  // Shown but not confirmed by the server's answer: the calm line, with the usual price.
  assert.equal(memberPriceNotice('gift-1', 'EUR', { shown: true }), 'Your member price couldn’t be confirmed — the usual price applies (€29).');
  assert.equal(memberPriceNotice('family-5', 'USD', { shown: true, confirmed: false }), 'Your member price couldn’t be confirmed — the usual price applies ($99).');
  assert.equal(memberPriceNotice('gift-1', 'EUR', { shown: true, confirmed: true }), '', 'confirmed: straight to the checkout');
  assert.equal(memberPriceNotice('gift-1', 'EUR', { shown: false }), '', 'never shown: nothing to say');
  assert.equal(memberPriceNotice('up-to-50', 'EUR', { shown: true }), '');
  // Both places ask before redirecting, and ask for the licence state again.
  const dialog = await read('src/features/plus-dialog.js');
  assert.match(dialog, /memberPriceNotice\(plan, currency, \{ shown, confirmed: result\.member === true \}\)/);
  assert.match(dialog, /data-plus-member-continue[\s\S]*data-plus-member-cancel|data-plus-member-cancel[\s\S]*data-plus-member-continue/);
  assert.match(dialog, /requestPlusCheck\(\);/);
  const landing = await read('welcome/landing.js');
  assert.match(landing, /memberPriceNotice\(plan, currency, \{ shown, confirmed: result\.member === true \}\)/);
  assert.match(landing, /member\.active = false;\s*writePlusCheck\(\{ at: 0 \}\);\s*renderGifts\(\);/);
});

test('the landing page: Partners in the menu and the footer, the launch price where Plus has a price, member-price hooks, a line for coaches', async () => {
  const page = await read('welcome/index.html');
  const nav = /<nav class="top__nav"[\s\S]*?<\/nav>/.exec(page)[0];
  const foot = /<nav class="foot__links"[\s\S]*?<\/nav>/.exec(page)[0];
  for (const part of [nav, foot]) assert.match(part, /<a href="\.\/partners\/">Partners<\/a>/);
  const offer = /<div class="plus-buy__offer">[\s\S]*?<\/div>\n {10}<\/div>/.exec(page)?.[0] || /<div class="plus-buy__offer">[\s\S]*?plus-buy__trust[\s\S]*?<\/p>/.exec(page)[0];
  assert.match(offer, /data-launch-label>Launch price</);
  assert.match(offer, /data-launch-line>Pay once during the launch and Plus is yours for life\. After the launch, Plus becomes a yearly subscription for new members\.</);
  assert.match(page, /id="plan-plus"[^>]*>[\s\S]*?data-launch-label>Launch price</, 'the pricing card');
  assert.doesNotMatch(page, /No subscription, no account/, 'no “no subscription” promise next to the launch price');
  assert.match(page, /<summary>Is Plus a subscription\?<\/summary>\s*<div class="qa__a"><p>Not if you get it now\./);
  assert.match(page, /<summary>What does “for life” mean\?<\/summary>/);
  for (const hook of ['data-gift-offer="gift-1"', 'data-gift-offer="family-5"', 'data-member-price="gift-1"', 'data-member-price="family-5"', 'data-member-badge', 'data-gifts-note']) assert.ok(page.includes(hook), hook);
  assert.match(page, /data-teams-partner>[\s\S]*?Coach or consultant\?[\s\S]*?href="\.\/partners\/"/);
  const script = await read('welcome/landing.js');
  assert.match(script, /savedPlusToken\(\)/, 'the licence is read from the planner’s settings');
  assert.match(script, /license: personal && member\.active \? member\.token : ''/, 'and sent with a personal gift only');
  assert.match(script, /topic'\) === 'partners'/, 'the question form knows the partner program');
});

test('the partners page: landing style, header and footer like the gift page, every section, and the counts it may send', async () => {
  const page = await read('welcome/partners/index.html');
  assert.match(page, /<link rel="stylesheet" href="\.\.\/landing\.css">/);
  assert.ok(page.indexOf('../../runtime-config.js') < page.indexOf('./partners.js'), 'the runtime config first');
  assert.match(page, /<title>Partners — Daily Planner<\/title>/);
  for (const id of ['who', 'how', 'commission', 'faq']) assert.match(page, new RegExp(`id="${id}"`), id);
  for (const who of ['Coaches', 'Creators', 'Newsletters', 'Consultants', 'Teams', 'Plus members']) assert.match(page, new RegExp(`<h3>${who}</h3>`), who);
  assert.match(page, /https:\/\/planner\.bemorin\.com\/welcome\/\?ref=<b>CODE<\/b>/);
  assert.match(page, /1st and the 15th/);
  assert.equal((page.match(/data-partner-cta/g) || []).length, 2);
  assert.match(page, /href="\.\.\/\?ask=question&amp;topic=partners#request" data-partner-cta>Become a partner</, 'works without JavaScript too');
  const legal = /<nav class="foot__legal"[\s\S]*?<\/nav>/.exec(page)[0];
  assert.deepEqual([...legal.matchAll(/href="([^"]+)"/g)].map(match => match[1]), ['../../legal/privacy/', '../../legal/terms/', '../../legal/cookies/', '../../legal/']);
  const script = await read('welcome/partners/partners.js');
  assert.match(script, /track\('partners_viewed'\)/);
  assert.match(script, /track\('partner_cta_clicked'\)/);
  const landing = new Map(api.LANDING_EVENTS);
  assert.equal(landing.get('partners_viewed'), 'visited the partners page');
  assert.equal(landing.get('partner_cta_clicked'), 'went to become a partner');
  assert.match(await read('_headers'), /\n\/welcome\/partners\/\n {2}Cache-Control: no-cache\n/);
});

test('the planner mentions the program in three quiet places, each dismissible', async () => {
  const dialog = await read('src/features/plus-dialog.js');
  assert.match(dialog, /partnerHintShown\('plus'\)/);
  assert.match(dialog, /dismissPartnerHint\('plus'\)/);
  assert.match(dialog, /href="\.\/welcome\/partners\/"/);
  const share = await read('src/features/share-dialog.js');
  assert.match(share, /partnerHintShown\('share'\)/);
  assert.match(share, /dismissPartnerHint\('share'\)/);
  assert.match(share, /Earn a commission when people buy through your link\./);
  const thanks = await read('welcome/thanks/thanks.js');
  assert.match(thanks, /partnerHintShown\('gift'\)/);
  assert.match(thanks, /dismissPartnerHint\('gift'\)/);
  assert.match(await read('welcome/thanks/index.html'), /Know someone who’d love it\?[\s\S]*?href="\.\.\/partners\/" data-partner-go>Become a partner</);
});
