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
    assert.match(html, /Last updated: <time datetime="2026-10-19">19 October 2026<\/time>/, `${file} shows the date`);
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
  assert.match(html, /href="\.\.\/\.\.\/welcome\/\?ask=question#request"/);
  assert.doesNotMatch(html, /Address|Registration|mailto:/);
  assert.equal(legal.contactPhrase(blank, '../'), 'use the <a href="../welcome/?ask=question#request">“Ask a question” form</a>');
  assert.equal(legal.askHref('../'), '../welcome/?ask=question#request');
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
  assert.match(nodes['[data-legal-details]'][0].innerHTML, /welcome\/\?ask=question#request/);
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
  for (const line of lines.filter(entry => entry && !entry.startsWith('#'))) {
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

test('the 60 days in the privacy and cookies pages match how long a partner code is used', async () => {
  for (const file of ['legal/privacy/index.html', 'legal/cookies/index.html']) assert.match(text(await read(file)), /60 days/, file);
  const stored = new Map();
  const storage = { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, String(value)) };
  const now = Date.UTC(2026, 9, 19);
  api.rememberReferral('?ref=PARTNER', { storage, now });
  assert.equal(api.referralCode({ storage, now: now + 59 * 86400000 }), 'PARTNER');
  assert.equal(api.referralCode({ storage, now: now + 61 * 86400000 }), '');
});

test('prices and Plus features in the terms come from src/lib/pricing.js', () => {
  const items = legal.priceItems();
  const money = (price, currency) => pricing.formatMoney(price[currency], currency);
  assert.equal(items[0], `Daily Planner Plus: ${money(pricing.PLUS_PRICE, 'EUR')} / ${money(pricing.PLUS_PRICE, 'USD')}`);
  for (const gift of pricing.PERSONAL_GIFTS) assert.ok(items.some(item => item.startsWith(`${gift.label}: ${money(gift.price, 'EUR')} / ${money(gift.price, 'USD')}`)), gift.label);
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
  const sources = ['src/lib/planner-api.js', 'src/lib/plus.js', 'src/features/plus-check.js', 'src/features/plus-dialog.js', 'src/features/feedback.js', 'src/features/sync-guide.js', 'src/features/progress-view.js', 'src/features/paint-palettes.js', 'src/ui/theme.js', 'src/sync/ledger.js'];
  const keys = new Set();
  for (const file of sources) for (const match of (await read(file)).matchAll(/'(daily-planner-(?:ui|sync):[a-z-]+)'/g)) keys.add(match[1]);
  assert.ok(keys.size >= 12, `found ${keys.size} keys`);
  for (const key of keys) assert.ok(cookies.includes(`<code>${key}</code>`), `${key} is listed`);
  assert.match(cookies, /<code>daily-planner-recovery<\/code>/, 'the recovery snapshots (IndexedDB)');
  assert.match(cookies, /<code>daily-planner:<\/code>/, 'the planner itself');
});
