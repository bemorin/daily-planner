import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// config.js reads the runtime configuration when it loads: give it sample
// legal details (with stray spaces) before anything imports it.
globalThis.__DAILY_PLANNER_CONFIG__ = { SUPPORT_EMAIL: '  hello@example.com ', LEGAL_ADDRESS: ' 1 rue Exemple, 75000 Paris ', LEGAL_REGISTRATION: 'SIRET 000 000 000 00000' };

const config = await import('../src/config.js');
const api = await import('../src/lib/planner-api.js');
const pricing = await import('../src/lib/pricing.js');
const legal = await import('../legal/legal.js');
const server = await import('../server/planner-api.js');
const gifts = await import('../server/gifts.js');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => readFile(join(root, rel), 'utf8');
const PAGES = { 'legal/': 'legal/index.html', 'legal/privacy/': 'legal/privacy/index.html', 'legal/terms/': 'legal/terms/index.html', 'legal/cookies/': 'legal/cookies/index.html' };
const hrefs = html => [...html.matchAll(/href="([^"]+)"/g)].map(match => match[1].replace(/&amp;/g, '&'));
/** A relative href from a page folder ('legal/privacy/') to a site path ('legal/terms/'). */
const resolveHref = (folder, href) => posix.normalize(posix.join(folder, href.split(/[?#]/)[0])).replace(/^\.\//, '');
const footerOf = html => /<footer class="lg-foot">([\s\S]*?)<\/footer>/.exec(html)?.[1] || '';
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

async function walk(rel) {
  const files = [];
  for (const entry of await readdir(join(root, rel), { withFileTypes: true })) {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await walk(child));
    else files.push(child);
  }
  return files;
}

test('the four legal pages exist, and each footer links all four in order', async () => {
  for (const [folder, file] of Object.entries(PAGES)) {
    const html = await read(file);
    assert.match(html, /^<!doctype html>/i, file);
    assert.match(html, /Last updated: <time datetime="2026-10-20">20 October 2026<\/time>/, `${file} shows the date`);
    const legalLinks = hrefs(footerOf(html)).map(href => resolveHref(folder, href)).filter(path => path.startsWith('legal'));
    assert.deepEqual(legalLinks, ['legal/privacy/', 'legal/terms/', 'legal/cookies/', 'legal/'], `${file} footer: Privacy · Terms · Cookies · Legal notice`);
    assert.match(footerOf(html), /aria-current="page"/, `${file} marks itself in the footer`);
    const self = /<a href="([^"]+)" aria-current="page"/.exec(footerOf(html))[1];
    assert.equal(resolveHref(folder, self), folder, `${file} marks the right page as current`);
  }
});

test('each page loads its runtime config, then the shared module and stylesheet, at the right depth', async () => {
  for (const [folder, file] of Object.entries(PAGES)) {
    const html = await read(file);
    const up = folder === 'legal/' ? '../' : '../../';
    const own = folder === 'legal/' ? './' : '../';
    const config = html.indexOf(`<script src="${up}runtime-config.js"></script>`);
    const module = html.indexOf(`<script type="module" src="${own}legal.js"></script>`);
    assert.ok(config > 0 && module > config, `${file}: runtime-config.js before legal.js`);
    assert.ok(html.includes(`<link rel="stylesheet" href="${own}legal.css">`), file);
    assert.ok(html.includes(`<body data-root="${up}">`), `${file}: data-root points at the site root`);
    assert.ok(html.includes(`<img src="${up}favicon.svg"`), `${file}: the Daily Planner mark`);
    assert.ok(html.includes(`<a class="lg-btn" href="${up}">Open the planner</a>`), file);
    assert.doesNotMatch(html, /https?:\/\/[^"]*\.(?:js|css)"|fonts\.googleapis|landing\.css/, `${file}: no external scripts, fonts or the landing stylesheet`);
  }
});

test('the privacy page renders every counted moment from the code, in both lists', async () => {
  const html = await read('legal/privacy/index.html');
  assert.match(html, /data-legal-events="planner"/);
  assert.match(html, /data-legal-events="landing"/);
  const planner = legal.eventsHtml(api.COUNTED_EVENTS);
  const landing = legal.eventsHtml(api.LANDING_EVENTS);
  for (const [, words] of api.COUNTED_EVENTS) assert.ok(planner.includes(`<li>${legal.esc(words)}</li>`), words);
  for (const [, words] of api.LANDING_EVENTS) assert.ok(landing.includes(`<li>${legal.esc(words)}</li>`), words);
  assert.equal((planner.match(/<li>/g) || []).length, api.COUNTED_EVENTS.length);
  assert.equal((landing.match(/<li>/g) || []).length, api.LANDING_EVENTS.length);
  assert.equal(legal.eventsHtml([['x', 'clicked <b>“Go”</b> & left']]), '<li>clicked &lt;b&gt;“Go”&lt;/b&gt; &amp; left</li>', 'descriptions are escaped');
});

test('blank details are left out and contact falls back to the “Ask a question” form', () => {
  const blank = legal.legalDetails({});
  assert.deepEqual(blank, { email: '', address: '', registration: '' });
  assert.deepEqual(legal.detailRows(blank).map(([label]) => label), ['Publisher', 'Contact']);
  const html = legal.detailsHtml(legal.detailRows(blank, '../../'));
  assert.match(html, /href="\.\.\/\.\.\/welcome\/teams\/\?ask=question#request"/);
  assert.doesNotMatch(html, /on the welcome page/, 'the form lives on the Teams page now');
  assert.doesNotMatch(html, /Address|Registration|mailto:/);
  assert.equal(legal.contactPhrase(blank, '../'), 'use the <a href="../welcome/teams/?ask=question#request">“Ask a question” form</a>');
  assert.equal(legal.askHref('../'), '../welcome/teams/?ask=question#request');
  for (const bad of ['not-an-email', 'a@b', 'me@example.com?bcc=x@evil.com', 'a b@example.com']) {
    assert.equal(legal.legalDetails({ SUPPORT_EMAIL: bad }).email, '', `${bad} is not used in a mailto: link`);
  }
});

test('set details appear, trimmed and escaped, with the email as the contact', () => {
  const details = legal.legalDetails({ SUPPORT_EMAIL: ' hello@example.com ', LEGAL_ADDRESS: '1 rue <Exemple>\n75000 Paris', LEGAL_REGISTRATION: ' SIRET 000 000 000 00000 ' });
  assert.deepEqual(details, { email: 'hello@example.com', address: '1 rue <Exemple> 75000 Paris', registration: 'SIRET 000 000 000 00000' });
  const rows = legal.detailRows(details);
  assert.deepEqual(rows.map(([label]) => label), ['Publisher', 'Address', 'Registration', 'Contact']);
  const html = legal.detailsHtml(rows);
  assert.match(html, /1 rue &lt;Exemple&gt; 75000 Paris/);
  assert.match(html, /<a href="mailto:hello@example\.com">hello@example\.com<\/a>/);
  assert.equal(legal.contactPhrase(details), 'email <a href="mailto:hello@example.com">hello@example.com</a>');
});

test('applyLegal fills every placeholder from the configuration', () => {
  const nodes = {};
  const node = () => ({ innerHTML: '', textContent: '', hidden: undefined, dataset: {} });
  const selectors = ['[data-legal-details]', '[data-legal-contact]', '[data-legal-events="planner"]', '[data-legal-events="landing"]', '[data-legal-prices]', '[data-legal-features]', '[data-legal-js]', '[data-legal-nojs]'];
  selectors.forEach(selector => { nodes[selector] = [node()]; });
  const doc = { body: { dataset: { root: '../../' } }, querySelectorAll: selector => nodes[selector] || [], querySelector: () => null };
  legal.applyLegal(doc, { config: {} });
  assert.match(nodes['[data-legal-details]'][0].innerHTML, /welcome\/teams\/\?ask=question#request/);
  assert.doesNotMatch(nodes['[data-legal-details]'][0].innerHTML, /Address/);
  assert.match(nodes['[data-legal-contact]'][0].innerHTML, /^use the /);
  assert.equal(nodes['[data-legal-events="planner"]'][0].innerHTML, legal.eventsHtml(api.COUNTED_EVENTS));
  assert.equal(nodes['[data-legal-events="landing"]'][0].innerHTML, legal.eventsHtml(api.LANDING_EVENTS));
  assert.equal(nodes['[data-legal-js]'][0].hidden, false);
  assert.equal(nodes['[data-legal-nojs]'][0].hidden, true);
  // The default configuration is the runtime one, read through src/config.js.
  legal.applyLegal(doc);
  assert.match(nodes['[data-legal-details]'][0].innerHTML, /1 rue Exemple, 75000 Paris/);
  assert.match(nodes['[data-legal-contact]'][0].innerHTML, /mailto:hello@example\.com/);
});

test('src/config.js exports the legal details, trimmed, and runtime-config.js keeps them blank', async () => {
  assert.equal(config.SUPPORT_EMAIL, 'hello@example.com');
  assert.equal(config.LEGAL_ADDRESS, '1 rue Exemple, 75000 Paris');
  assert.equal(config.LEGAL_REGISTRATION, 'SIRET 000 000 000 00000');
  const runtime = await read('runtime-config.js');
  for (const key of ['SUPPORT_EMAIL', 'LEGAL_ADDRESS', 'LEGAL_REGISTRATION']) assert.match(runtime, new RegExp(`\\n  ${key}: ''[,\\n]`), `${key} stays blank in the public source`);
});

test('no personal email address or phone number is written in legal/', async () => {
  for (const file of await walk('legal')) {
    const source = await read(file);
    assert.doesNotMatch(source, /[A-Za-z0-9._%+-]+@(?!example\.com)[A-Za-z0-9-]+\.[A-Za-z.]{2,}/, `${file} contains an email address`);
    assert.doesNotMatch(source, /@gmail\.com|@bemorin\.com/i, file);
    // The only phone number is Cloudflare’s, the host’s public switchboard.
    const phones = [...source.matchAll(/\+\d[\d ()-]{7,}\d/g)].map(match => match[0]);
    assert.ok(phones.every(phone => phone.replace(/\D/g, '') === '16503198930'), `${file}: ${phones}`);
  }
});

test('the build copies legal/ and _redirects, and reads the three legal build variables', async () => {
  const build = await read('scripts/build.mjs');
  assert.match(build, /await copyTree\('legal'\);/);
  assert.match(build, /await copyFile\('_redirects'\);/);
  assert.match(build, /SUPPORT_EMAIL: process\.env\.DAILY_PLANNER_SUPPORT_EMAIL \|\| ''/);
  assert.match(build, /LEGAL_ADDRESS: process\.env\.DAILY_PLANNER_LEGAL_ADDRESS \|\| ''/);
  assert.match(build, /LEGAL_REGISTRATION: process\.env\.DAILY_PLANNER_LEGAL_REGISTRATION \|\| ''/);
});

test('_redirects sends the short links to the legal pages', async () => {
  const lines = (await read('_redirects')).split('\n').map(line => line.trim());
  for (const line of ['/privacy /legal/privacy/ 301', '/terms /legal/terms/ 301', '/cookies /legal/cookies/ 301']) assert.ok(lines.includes(line), line);
  // Only the legal short links are checked here (the file also sends /teams and /partners to their pages).
  const legalLines = lines.filter(entry => /^\/(?:privacy|terms|cookies)\/?\s/.test(entry));
  assert.equal(legalLines.length, 6);
  for (const line of legalLines) {
    const [, to] = line.split(/\s+/);
    assert.ok(Object.keys(PAGES).includes(to.replace(/^\//, '')), `${line} points at a legal page`);
  }
});

test('the planner footer links the legal pages in a new tab, in the agreed order', async () => {
  const html = await read('index.html');
  const block = /<div class="bemorin-footer__links">([\s\S]*?)<\/div>/.exec(html)?.[1] || '';
  const links = [...block.matchAll(/<a href="([^"]+)" target="_blank" rel="noopener">([^<]+)<\/a>/g)].map(match => [match[1], match[2]]);
  assert.deepEqual(links, [['legal/privacy/', 'Privacy'], ['legal/terms/', 'Terms'], ['legal/cookies/', 'Cookies'], ['legal/', 'Legal notice']]);
  assert.doesNotMatch(html, /bemorin\.com\/(?:privacy|terms|cookies)/);
});

test('the numbers written in the terms match the code', async () => {
  const terms = text(await read('legal/terms/index.html'));
  assert.match(terms, new RegExp(`activated up to ${server.PLUS_CLAIMS_MAX} times in all`), 'Plus activations');
  assert.match(terms, new RegExp(`activated for ${gifts.GIFT_VALID_MONTHS} months`), 'gift links');
  assert.match(terms, new RegExp(`margin from ${gifts.TEAM_MARGIN_FROM} seats: 10% more activations \\(at least one\\)`));
  assert.equal(gifts.giftLimit(gifts.TEAM_MARGIN_FROM), gifts.TEAM_MARGIN_FROM + 1);
  assert.equal(gifts.giftLimit(gifts.TEAM_MARGIN_FROM - 1), gifts.TEAM_MARGIN_FROM - 1, 'smaller gifts: exactly the places bought');
  assert.equal(gifts.giftLimit(100), 110);
  const family = pricing.PERSONAL_GIFTS.find(gift => gift.plan === 'family-5');
  assert.match(terms, new RegExp(`up to ${family.seats} people who live in the same household`));
  assert.match(terms, /Ask within 14 days of purchase and you are refunded, no questions asked\./);
});

test('the legal pages say a refund switches Plus off and that the licence is checked about once a week', async () => {
  const terms = text(await read('legal/terms/index.html'));
  assert.match(terms, /If you are refunded, Plus is switched off on the planners it was activated on, and a gift link stops working\./);
  assert.match(terms, /Disputes are handled the same way/);
  const privacy = text(await read('legal/privacy/index.html'));
  assert.doesNotMatch(privacy, /never contacts us/, 'Plus does contact the server once a week now');
  assert.match(privacy, /About once a week, when you are online, the planner sends us only the licence \(with its random id\) to ask whether it is still valid, nothing else/);
  assert.doesNotMatch(privacy, /licence alone|still valid — no identifier/, 'the licence carries a random id');
  assert.match(privacy, /so Plus comes back if that is undone/);
  assert.match(privacy, /Creem’s order reference/);
  assert.match(privacy, /is not stored in our database: it only appears in the notification email we send ourselves about the refund, through Resend/);
  assert.doesNotMatch(privacy, /used only to tell us about the refund, and is not kept/);
  assert.match(privacy, /Refunds, disputes and revoked licences/);
  const cookies = await read('legal/cookies/index.html');
  assert.match(cookies, /<code>daily-planner-ui:plus-checked<\/code>/);
  assert.doesNotMatch(text(cookies), /None of it is sent to us\. /, 'the licence check is the one exception');
});

test('after the launch: the marketing says it short, the terms say it with care, the FAQ uses the terms’ words', async () => {
  const after = 'After the launch, Plus becomes a yearly subscription for new members.';
  assert.equal(pricing.LAUNCH.after, after);
  const landing = await read('welcome/index.html');
  assert.ok(landing.includes(after), 'landing');
  const terms = text(await read('legal/terms/index.html'));
  assert.match(terms, /If you buy Plus during the launch, or activate a gift bought during the launch, Plus is yours for life\. After the launch, Plus is planned to be sold to new buyers as a yearly subscription; licences bought or gifts bought during the launch stay valid for life\./);
  const forLife = /<summary>What does “for life” mean\?<\/summary>\s*<div class="qa__a"><p>([\s\S]*?)<\/p>/.exec(landing)?.[1] || '';
  assert.match(forLife, /activate a gift bought during the launch/);
  assert.doesNotMatch(forLife, /received as a gift/);
});

test('a partner code is said to be kept with the sale’s record; partners’ own purchases earn nothing', async () => {
  const privacy = text(await read('legal/privacy/index.html'));
  assert.doesNotMatch(privacy, /nothing else about you is kept with/);
  assert.match(privacy, /kept with the sale’s record/);
  assert.match(privacy, /the partner’s code goes with your request, so a team order by invoice can earn that partner their commission/);
  const notice = await read('src/features/privacy.js');
  assert.doesNotMatch(notice, /Nothing else goes with it/);
  assert.match(notice, /the code is kept with the sale’s record/);
  assert.match(text(await read('legal/terms/index.html')), /Your own purchases don’t count: what you buy through your own link, for yourself or as a gift\./);
  assert.match(await read('welcome/partners/index.html'), /Purchases you make yourself, for you or as a gift, don’t count\./);
});

test('the terms’ partner program: the rates, the days and the minimum come from PARTNER_PROGRAM, and say every rule', async () => {
  const program = pricing.PARTNER_PROGRAM;
  const html = await read('legal/terms/index.html');
  assert.match(html, /<li><a href="#partners">Partner program<\/a><\/li>/);
  const section = /<section id="partners"[\s\S]*?<\/section>/.exec(html)[0];
  // Tags out without a space: “<b>…introduced</b>, on” reads as one sentence.
  const words = section.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
  const terms = legal.partnerTerms();
  assert.deepEqual(terms, { rate: `${program.rate}%`, teamRate: `${program.teamRate}%`, days: String(program.cookieDays), refundDays: String(program.refundDays), minimum: '€50 or $50' });
  // Without JavaScript the page already says what the script writes.
  for (const [hook, value] of [['rate', terms.rate], ['team-rate', terms.teamRate], ['days', terms.days], ['refund-days', terms.refundDays], ['minimum', terms.minimum]]) {
    const found = [...section.matchAll(new RegExp(`data-partner-${hook}>([^<]*)<`, 'g'))].map(match => match[1]);
    assert.ok(found.length && found.every(value_ => value_ === value), `${hook}: ${found}`);
  }
  assert.match(words, /you don’t need Plus/);
  assert.match(words, /25% of Daily Planner Plus, Give Plus and Plus Family bought through your link, on the price before tax/);
  assert.match(words, /Creem tracks these sales and pays this commission, under its affiliate terms/);
  assert.match(words, /10% of a team gift you introduced, on its price before tax: bought online through your link, or ordered by invoice or quote when the company’s request carries your code\. We pay this commission ourselves\./);
  assert.match(words, /A link counts for 30 days\./);
  assert.match(words, /A sale earns once its 14-day refund period has passed with no refund and no dispute\. A refunded or disputed sale earns nothing/);
  assert.match(words, /on the 1st and the 15th of each month, once your balance reaches €50 or \$50/);
  assert.match(words, /We pay team commissions by bank transfer within 30 days of being earned/);
  assert.match(words, /spam/);
  assert.match(words, /bid on “Daily Planner” or similar names in search ads/);
  assert.match(words, /promise discounts, features or results we don’t offer/);
  assert.match(words, /We may refuse an application or end a partnership/);
  assert.match(words, /end the program with 30 days’ notice/);
  // The page fills the same figures.
  const nodes = new Map();
  const doc = { body: { dataset: { root: '../../' } }, querySelectorAll: selector => { if (!nodes.has(selector)) nodes.set(selector, [{ innerHTML: '', textContent: '', dataset: {} }]); return nodes.get(selector); }, querySelector: () => null };
  legal.applyLegal(doc, { config: {} });
  assert.equal(nodes.get('[data-partner-rate]')[0].textContent, '25%');
  assert.equal(nodes.get('[data-partner-days]')[0].textContent, '30');
  assert.equal(nodes.get('[data-partner-minimum]')[0].textContent, '€50 or $50');
});

test('the 30 days in the privacy and cookies pages match how long a partner code is used', async () => {
  for (const file of ['legal/privacy/index.html', 'legal/cookies/index.html']) {
    const page = await read(file);
    assert.match(page, /<span data-partner-days>30<\/span> days/, file);
    assert.doesNotMatch(text(page), /60 days/, file);
  }
  assert.equal(pricing.PARTNER_PROGRAM.cookieDays, 30);
  const stored = new Map();
  const storage = { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, String(value)) };
  const now = Date.UTC(2026, 9, 19);
  api.rememberReferral('?ref=PARTNER', { storage, now });
  assert.equal(api.referralCode({ storage, now: now + 29 * 86400000 }), 'PARTNER');
  assert.equal(api.referralCode({ storage, now: now + 31 * 86400000 }), '');
});

test('every “Ask a question” link in legal/ goes to the Teams page’s form', async () => {
  for (const [folder, file] of Object.entries(PAGES)) {
    const html = await read(file);
    const asks = hrefs(html).filter(href => href.includes('ask='));
    if (file !== 'legal/cookies/index.html') assert.ok(asks.length > 0, file);
    for (const href of asks) assert.equal(resolveHref(folder, href) + href.slice(href.indexOf('?')), 'welcome/teams/?ask=question#request', `${file}: ${href}`);
  }
  assert.doesNotMatch(await read('legal/legal.js'), /'welcome\/\?ask=/);
});

test('prices and Plus features in the terms come from src/lib/pricing.js', () => {
  const items = legal.priceItems();
  const money = (price, currency) => pricing.formatMoney(price[currency], currency);
  assert.equal(items[0], `Daily Planner Plus${pricing.LAUNCH.active ? ', at its launch price' : ''}: ${money(pricing.PLUS_PRICE, 'EUR')} / ${money(pricing.PLUS_PRICE, 'USD')}`);
  for (const gift of pricing.PERSONAL_GIFTS) assert.ok(items.some(item => item.startsWith(`${gift.label}: ${money(gift.price, 'EUR')} / ${money(gift.price, 'USD')}`)), gift.label);
  // The member price, for someone who already has Plus.
  const member = plan => ['EUR', 'USD'].map(currency => pricing.formatMoney(pricing.memberGiftPrice(plan, currency), currency)).join(' / ');
  assert.ok(items[1].endsWith(`; ${member('gift-1')} for someone who already has Plus)`), items[1]);
  assert.ok(items[2].endsWith(`; ${member('family-5')} for someone who already has Plus)`), items[2]);
  const smallest = pricing.TEAM_TIERS[0];
  assert.ok(items.some(item => item.includes(`from ${money(smallest.price, 'EUR')} / ${money(smallest.price, 'USD')} for up to ${smallest.seats} people`)));
  const features = legal.featuresText();
  for (const feature of pricing.PLUS_FEATURES) assert.ok(features.includes(`“${feature.title}”`), feature.title);
  assert.equal(legal.featuresText([{ title: 'A' }, { title: 'B' }, { title: 'C' }]), '“A”, “B” and “C”');
  assert.equal(legal.featuresText([{ title: 'A' }]), '“A”');
});

test('without JavaScript, the terms and the landing’s descriptions still list every Plus feature', async () => {
  const terms = await read('legal/terms/index.html');
  assert.equal(/<span data-legal-features>([^<]*)<\/span>/.exec(terms)?.[1], legal.featuresText(), 'the fallback is what the script writes');
  const landing = await read('welcome/index.html');
  const meta = /<meta name="description" content="([^"]*)"/.exec(landing)?.[1] || '';
  const offer = /"name": "Daily Planner Plus", "description": "([^"]*)"/.exec(landing)?.[1] || '';
  for (const [where, value] of [['meta description', meta], ['structured-data offer', offer]]) {
    for (const name of ['year plan|Plan your year', 'quarterly check-ins', 'Insights', 'year in review']) assert.match(value, new RegExp(name, 'i'), `${where}: ${name}`);
  }
});

test('the cookies page lists every storage key the code uses', async () => {
  const cookies = await read('legal/cookies/index.html');
  // Every script of the planner, the welcome pages and the admin, so a new key can't be missed.
  const sources = ['app.js', 'index.html', ...(await walk('src')), ...(await walk('welcome')), ...(await walk('admin'))].filter(file => /\.(?:js|mjs|html)$/.test(file));
  assert.ok(sources.includes('src/features/tour-model.js') && sources.includes('src/features/first-use-model.js') && sources.includes('src/features/pip-window.js'), 'nested modules are read');
  const keys = new Set();
  for (const file of sources) for (const match of (await read(file)).matchAll(/['"`](daily-planner-(?:ui|sync):[a-z0-9-]+)['"`]/g)) keys.add(match[1]);
  assert.ok(keys.size >= 21, `found ${keys.size} keys`);
  for (const key of ['daily-planner-ui:tips', 'daily-planner-ui:tour', 'daily-planner-ui:share', 'daily-planner-ui:pip-view', 'daily-planner-ui:pip-size', 'daily-planner-ui:pip-unresolved', 'daily-planner-ui:partner-hints']) assert.ok(keys.has(key), `${key} found in the code`);
  for (const key of keys) assert.ok(cookies.includes(`<code>${key}</code>`), `${key} is listed`);
  assert.match(cookies, /<code>daily-planner-recovery<\/code>/, 'the recovery snapshots (IndexedDB)');
  assert.match(cookies, /<code>daily-planner:<\/code>/, 'the planner itself');
});
