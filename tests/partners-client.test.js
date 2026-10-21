import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The owner API on, a Creem sign-up link configured (and an old commission
// variable that is no longer read), and the browser pieces the client modules touch.
globalThis.__DAILY_PLANNER_CONFIG__ = { PLANNER_API_URL: '/api/', AFFILIATE_URL: ' https://affiliates.example.com/daily-planner ', AFFILIATE_COMMISSION: ' 30% ' };
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
const { giftLabel } = await import('../src/features/plus-dialog.js');
const model = await import('../welcome/partners/partners-model.js');
const { formatMoney, memberPriceNotice, memberPriceShown, PARTNER_PROGRAM, PERSONAL_GIFTS, TEAM_TIERS } = await import('../src/lib/pricing.js');

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

test('config: the partner link must be https; the commission is no longer a build variable; the runtime defaults stay blank', async () => {
  assert.equal(config.AFFILIATE_URL, 'https://affiliates.example.com/daily-planner');
  assert.equal('AFFILIATE_COMMISSION' in config, false, 'the rates are PARTNER_PROGRAM, not a variable');
  const runtime = await read('runtime-config.js');
  assert.match(runtime, /\n {2}AFFILIATE_URL: ''\n/);
  assert.doesNotMatch(runtime, /AFFILIATE_COMMISSION/);
  const build = await read('scripts/build.mjs');
  assert.match(build, /AFFILIATE_URL: process\.env\.DAILY_PLANNER_AFFILIATE_URL \|\| ''/);
  assert.doesNotMatch(build, /AFFILIATE_COMMISSION/);
  const check = await read('scripts/check.mjs');
  assert.match(check, /'LEGAL_REGISTRATION', 'AFFILIATE_URL'\]/);
  assert.doesNotMatch(check, /AFFILIATE_COMMISSION/);
  for (const file of ['src/config.js', 'admin/admin.js', 'admin/attention.js', 'admin/partners-view.js', 'welcome/partners/partners.js', 'welcome/partners/partners-model.js']) assert.doesNotMatch(await read(file), /AFFILIATE_COMMISSION/, file);
  // The owner is told the variable is gone, nowhere asked to set it.
  // OWNER_NOTES.md is the owner's private copy (git-ignored): checked only where it exists.
  for (const file of ['docs/FEEDBACK_AND_WAITLIST.md', 'OWNER_NOTES.md']) {
    const doc = await read(file).catch(error => (file === 'OWNER_NOTES.md' && error?.code === 'ENOENT' ? null : Promise.reject(error)));
    if (doc === null) continue;
    assert.match(doc, /`DAILY_PLANNER_AFFILIATE_COMMISSION` is gone/, file);
    assert.doesNotMatch(doc, /\| `DAILY_PLANNER_AFFILIATE_COMMISSION` \||into `DAILY_PLANNER_AFFILIATE_COMMISSION`/, file);
  }
});

test('the partners page: Become a partner goes to Creem, or to the question form on the Teams page while no link is set', () => {
  assert.deepEqual(model.partnerPage({ url: 'https://affiliates.example.com/x' }), { href: 'https://affiliates.example.com/x', external: true });
  const blank = model.partnerPage({});
  assert.equal(blank.href, model.PARTNER_QUESTION_HREF);
  assert.equal(blank.href, '../teams/?ask=question&topic=partners#request');
  assert.equal(blank.external, false);
  assert.equal(model.TEAMS_HREF, '../teams/');
  for (const url of ['http://affiliates.example.com', 'javascript:alert(1)', 'https://a b', ' ', null]) assert.equal(model.partnerPage({ url }).external, false, String(url));
});

test('the partners page’s figures come from the prices and the program: before tax, to the cent', () => {
  assert.deepEqual({ ...PARTNER_PROGRAM, minimumPayout: { ...PARTNER_PROGRAM.minimumPayout } }, { rate: 25, teamRate: 10, cookieDays: 30, minimumPayout: { EUR: 50, USD: 50 }, refundDays: 14 });
  // In France (20% VAT): a €29 Plus is €24.17 before tax, and earns €6.04 — about €6, as on Hero's page.
  assert.deepEqual(model.saleExample('plus', '', 'EUR'), { price: 2900, beforeTax: 2417, tax: 483, rate: 25, commission: 604 });
  assert.deepEqual(model.saleExample('gift', 'family-5', 'EUR'), { price: 9900, beforeTax: 8250, tax: 1650, rate: 25, commission: 2063 });
  assert.deepEqual(model.saleExample('gift', 'up-to-50', 'EUR'), { price: 59500, beforeTax: 49583, tax: 9917, rate: 10, commission: 4958 });
  // In US dollars the example has no sales tax, and says so.
  assert.deepEqual(model.saleExample('plus', '', 'USD'), { price: 2900, beforeTax: 2900, tax: 0, rate: 25, commission: 725 });
  const rows = model.rateRows('EUR');
  assert.deepEqual(rows.map(row => row.id), ['plus', 'gift-1', 'family-5', ...TEAM_TIERS.map(tier => tier.plan)]);
  assert.ok(rows.filter(row => row.team).every(row => row.rate === 10) && rows.filter(row => !row.team).every(row => row.rate === 25));
  const month = model.exampleMonth('EUR');
  assert.deepEqual(month.lines.map(line => [line.count, line.label, line.rate, line.amount]), [[8, 'Plus', 25, 4832], [1, 'Plus Family', 25, 2063], [1, 'Team gift, up to 50 people', 10, 4958]]);
  assert.deepEqual([month.total, month.byCreem, month.byTransfer], [11853, 6895, 4958]);
  assert.equal(model.exampleMonth('USD').total, 8 * 725 + 2475 + 5950);
  assert.equal(model.formatCommission(5800, 'USD'), '$58.00', 'commissions always to the cent');
  assert.equal(model.formatCommission(604, 'EUR'), '€6.04');
  const eur = model.pageFigures('EUR');
  assert.deepEqual([eur.rate, eur.teamRate, eur.cookieDays, eur.refundDays, eur.minimum, eur.plusPrice, eur.plusTax, eur.plusEarns, eur.teamEarns, eur.taxed], ['25%', '10%', '30', '14', '€50', '€29', '€4.83', '€6.04', '€49.58', true]);
  assert.match(eur.taxNote, /^An example in France, where prices include 20% VAT, worked out on the price before tax\./);
  // An example only: Creem calculates its own commission, under its affiliate terms.
  assert.match(eur.taxNote, /Creem calculates the 25% under its own affiliate terms, so what you earn may differ a little\.$/);
  const usd = model.pageFigures('USD');
  assert.deepEqual([usd.minimum, usd.plusEarns, usd.taxed, usd.taxWhere], ['$50', '$7.25', false, 'without sales tax']);
  assert.match(usd.taxNote, /^An example without sales tax\. Where the buyer pays sales tax or VAT, the price before tax is lower, and Creem calculates the 25% under its own affiliate terms/);
});

test('the partners page’s own figures, as written for a visitor without JavaScript, match what the model works out (EUR)', async () => {
  const page = await read('welcome/partners/index.html');
  const money = cents => formatMoney(cents / 100, 'EUR');
  for (const row of model.rateRows('EUR')) {
    assert.ok(page.includes(`<td class="num">${money(row.price)}<small>${money(row.beforeTax)} before tax</small></td><td class="num"><b>${model.formatCommission(row.commission, 'EUR')}</b><small>${row.rate}%</small></td>`), row.id);
  }
  const month = model.exampleMonth('EUR');
  for (const line of month.lines) assert.ok(page.includes(`<span>${line.count} × ${line.label}</span><small>${line.rate}%</small><b>${model.formatCommission(line.amount, 'EUR')}</b>`), line.id);
  assert.ok(page.includes(`data-month-total>${model.formatCommission(month.total, 'EUR')}<`));
  assert.ok(page.includes(`data-month-split>${model.formatCommission(month.byCreem, 'EUR')} paid by Creem · ${model.formatCommission(month.byTransfer, 'EUR')} by bank transfer<`));
  const figures = model.pageFigures('EUR');
  assert.ok(page.includes(`One Plus bought in France: ${figures.plusPrice}, of which ${figures.plusTax} is VAT. You earn about <b>${figures.plusEarns}</b>.`));
  assert.ok(page.includes(figures.taxNote));
  for (const [hook, value] of [['data-rate', '25%'], ['data-team-rate', '10%'], ['data-cookie-days', '30'], ['data-refund-days', '14'], ['data-minimum', '€50']]) {
    const found = [...page.matchAll(new RegExp(`${hook}>([^<]*)<`, 'g'))].map(match => match[1]);
    assert.ok(found.length > 0, hook);
    assert.ok(found.every(text => text === value), `${hook}: ${found}`);
  }
});

test('the Plus dialog: member prices in the gift buttons', () => {
  const [one, family] = PERSONAL_GIFTS;
  assert.match(giftLabel(one, 'EUR', { member: true }), /^Give Plus — member price (€\s?24|24\s?€), was (€\s?29|29\s?€)$/);
  assert.equal(giftLabel(family, 'USD', { member: true }), 'Plus Family — up to 5 people — member price $79, was $99');
  assert.equal(giftLabel(family, 'USD'), 'Plus Family — up to 5 people — $99');
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
  // The line for coaches moved to the Teams page with the team gift (1.28).
  assert.match(await read('welcome/teams/index.html'), /data-teams-partner>[\s\S]*?Coach or consultant\?[\s\S]*?href="\.\.\/partners\/"/);
  const script = await read('welcome/landing.js');
  assert.match(script, /savedPlusToken\(\)/, 'the licence is read from the planner’s settings');
  assert.match(script, /license: personal && member\.active \? member\.token : ''/, 'and sent with a personal gift only');
  assert.match(await read('welcome/teams-model.js'), /query\.get\('topic'\) === 'partners'/, 'the question form knows the partner program');
});

test('the partners page: landing style and motion, every section, the rules, the FAQ, and the counts it may send', async () => {
  const page = await read('welcome/partners/index.html');
  assert.match(page, /<link rel="stylesheet" href="\.\.\/landing\.css">\n {2}<link rel="stylesheet" href="\.\/partners\.css">/, 'its own styles, after the landing page’s');
  assert.ok(page.indexOf('../../runtime-config.js') < page.indexOf('./partners.js'), 'the runtime config first');
  assert.match(page, /<title>Partners — Daily Planner<\/title>/);
  // Motion like /welcome/: js-anim before first paint, entrances, the FAQ one answer at a time.
  assert.match(page, /root\.classList\.add\('js-anim'\);[\s\S]*?root\.classList\.contains\('js-ready'\)/);
  assert.ok(page.indexOf("classList.add('js-anim')") < page.indexOf('../landing.css'), 'before the styles');
  assert.ok((page.match(/data-reveal-each/g) || []).length >= 6 && /data-reveal(?!-)/.test(page));
  assert.match(page, /class="faq__groups" data-faq>/);
  assert.equal((page.match(/<details class="qa"/g) || []).length, 8);
  for (const question of ['How much is a sale worth?', 'Who can be a partner?', 'How are sales tracked?', 'When and how am I paid?', 'What if someone asks for a refund?', 'What is not allowed?', 'And companies?']) assert.ok(page.includes(`<summary>${question}</summary>`), question);
  const script = await read('welcome/partners/partners.js');
  assert.match(script, /import \{ motionWanted, reduceQuery, setupFaq, setupReveal \} from '\.\.\/page-motion\.js';/);
  assert.match(script, /setupReveal\(\{ motionOn: motionWanted\(\), motionHooks \}\);\nsetupFaq\(\);/);
  assert.match(script, /html\.classList\.add\('js-ready'\);/);
  for (const id of ['how', 'earn', 'rules', 'who', 'faq']) assert.match(page, new RegExp(`id="${id}"`), id);
  for (const who of ['Coaches', 'Creators', 'Newsletters', 'Consultants', 'Teams', 'People who use it']) assert.match(page, new RegExp(`<h3>${who}</h3>`), who);
  // The hero's three figures, the steps, a company, the rules.
  assert.match(page, /<ul class="pt-figures"[\s\S]*?data-rate>25%[\s\S]*?data-cookie-days>30<\/span> days[\s\S]*?data-team-rate>10%/);
  assert.match(page, /Three steps, no paperwork\./);
  assert.match(page, /<aside class="pt-company"[\s\S]*?Bringing a company\?[\s\S]*?href="\.\.\/teams\/"/);
  assert.match(page, /planner\.bemorin\.com\/welcome\/\?ref=<b>CODE<\/b>/);
  assert.match(page, /1st and the 15th/);
  for (const rule of ['of Plus and personal gifts', 'of a team gift you introduced', 'Your link counts for <span data-cookie-days>30</span> days</h3>', 'Full refunds and disputes earn nothing', 'Team gifts by bank transfer', 'Open to anyone', 'Fair play']) assert.ok(page.includes(rule), rule);
  // Only what Creem documents is said of Creem: it never sees a click (partners share our own ?ref= link), and its
  // commission is calculated under its own terms — the 14-day rule and “before tax” are ours, for team gifts.
  assert.doesNotMatch(page, /click/i);
  assert.doesNotMatch(page, /of the price before tax of Plus|25%<\/span> of the sale|Earned after/);
  assert.match(page, /calculated and paid by Creem under its affiliate terms/);
  assert.match(page, /A team commission is earned once the gift’s <span data-refund-days>14<\/span>-day refund period has passed/);
  assert.match(page, /You earn about <b>€6\.04<\/b>/, 'the example is labelled as one');
  // A company's invoice request counts when it carries the code: the page says to send them with the link.
  assert.match(page, /they ask for it on that page: having come through your link, their request carries your code\./);
  assert.doesNotMatch(page, /name you in their message/);
  assert.match(page, /without a full refund or a dispute\. If only part of a team gift is refunded, its commission is on the part kept\.<\/p>/);
  assert.match(page, /refund period is over\. If only part of a team gift is refunded, its commission is on the part kept\.<\/p>/, 'the FAQ says the same');
  assert.doesNotMatch(page, /<h3>Refunds earn nothing<\/h3>|If only part of the price is refunded|a partial refund lowers it/, 'the partial-refund rule is about team gifts only');
  assert.match(page, /don’t count/, 'own purchases');
  assert.match(page, /href="\.\.\/\.\.\/legal\/terms\/#partners"/);
  assert.doesNotMatch(page, /60 days/);
  // Every way in to a question goes to the Teams page's form, about the program.
  assert.equal((page.match(/data-partner-cta/g) || []).length, 3);
  assert.equal((page.match(/href="\.\.\/teams\/\?ask=question&amp;topic=partners#request" data-partner-cta>Become a partner</g) || []).length, 3, 'works without JavaScript too');
  assert.doesNotMatch(page, /href="\.\.\/\?ask=|href="\.\.\/#request/, 'nothing left pointing at the landing page’s old form');
  const legal = /<nav class="foot__legal"[\s\S]*?<\/nav>/.exec(page)[0];
  assert.deepEqual([...legal.matchAll(/href="([^"]+)"/g)].map(match => match[1]), ['../../legal/privacy/', '../../legal/terms/', '../../legal/cookies/', '../../legal/']);
  assert.match(script, /track\('partners_viewed'\)/);
  assert.match(script, /track\('partner_cta_clicked'\)/);
  const landing = new Map(api.LANDING_EVENTS);
  assert.equal(landing.get('partners_viewed'), 'visited the partners page');
  assert.equal(landing.get('partner_cta_clicked'), 'went to become a partner');
  assert.equal(landing.get('teams_viewed'), 'visited the Teams page');
  assert.equal(landing.get('landing_cta_teams'), 'went to the Teams page');
  assert.match(await read('_headers'), /\n\/welcome\/partners\/\n {2}Cache-Control: no-cache\n/);
  // The styles moved out of landing.css, and the quality gate reads them.
  assert.doesNotMatch(await read('welcome/landing.css'), /\.pt-[a-z]/);
  assert.match(await read('scripts/quality.mjs'), /'\.\.\/welcome\/partners\/partners\.css'/);
  assert.doesNotMatch(await read('welcome/partners/partners.css'), /!important/);
});

test('the planner mentions the program in three quiet places, each dismissible', async () => {
  const dialog = await read('src/features/plus-dialog.js');
  assert.match(dialog, /partnerHintShown\('plus'\)/);
  assert.match(dialog, /dismissPartnerHint\('plus'\)/);
  assert.match(dialog, /href="\.\/welcome\/partners\/"/);
  const share = await read('src/features/share-dialog.js');
  assert.match(share, /partnerHintShown\('share'\)/);
  assert.match(share, /dismissPartnerHint\('share'\)/);
  assert.match(share, /data-share-partner-go/);
  const thanks = await read('welcome/thanks/thanks.js');
  assert.match(thanks, /partnerHintShown\('gift'\)/);
  assert.match(thanks, /dismissPartnerHint\('gift'\)/);
  assert.match(await read('welcome/thanks/index.html'), /Know someone who’d love it\?[\s\S]*?href="\.\.\/partners\/" data-partner-go>Become a partner</);
});
