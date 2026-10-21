import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// config.js reads the runtime configuration when it loads: give it sample
// legal details (with stray spaces) before anything imports it.
globalThis.__DAILY_PLANNER_CONFIG__ = { SUPPORT_EMAIL: '  hello@example.com ', PRIVACY_EMAIL: ' privacy@example.com ', LEGAL_PHONE: ' +33 1 99 00 12 34 ', LEGAL_ADDRESS: ' 1 rue Exemple, 75000 Paris ', LEGAL_REGISTRATION: 'SIRET 000 000 000 00000' };

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
    assert.match(html, /Last updated: <time datetime="2026-10-21">21 October 2026<\/time>/, `${file} shows the date`);
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

// The ranges kept for fiction (ARCEP 01 99 00, NANP 555-01xx, Ofcom 020 7946 0xxx): the only phone numbers examples may use.
const FICTION = /^(?:3319900\d{4}|1\d{3}55501\d{2}|442079460\d{3})$/;
const FORM_PHRASE = root => `use the <a href="${root}teams/?ask=question#request">“Ask a question” form</a>`;
const labels = (details, page) => legal.detailRows(details, '../', page).map(([label]) => label);

test('blank details are left out and every contact falls back to the “Ask a question” form', () => {
  const blank = legal.legalDetails({});
  assert.deepEqual(blank, { email: '', privacyEmail: '', phone: '', address: '', registration: '' });
  assert.deepEqual(labels(blank, 'notice'), ['Publisher', 'Contact', 'Director of publication'], 'the director of publication is a row of the table');
  assert.deepEqual(labels(blank, 'privacy'), ['Data controller', 'Contact']);
  const html = legal.detailsHtml(legal.detailRows(blank, '../../'));
  assert.match(html, /href="\.\.\/\.\.\/teams\/\?ask=question#request"/);
  assert.doesNotMatch(html, /on the welcome page/, 'the form lives on the Teams page now');
  assert.doesNotMatch(html, /Address|Registration|Phone|mailto:|tel:/);
  assert.match(html, /<dt>Director of publication<\/dt><dd>Ben Morin<\/dd>/);
  for (const topic of ['support', 'privacy']) {
    assert.equal(legal.contactEmail(blank, topic), '');
    assert.equal(legal.contactPhrase(blank, '../', topic), FORM_PHRASE('../'), topic);
  }
  assert.equal(legal.askHref('../'), '../teams/?ask=question#request');
  for (const bad of ['not-an-email', 'a@b', 'me@example.com?bcc=x@evil.com', 'a b@example.com']) {
    assert.equal(legal.legalDetails({ SUPPORT_EMAIL: bad }).email, '', `${bad} is not used in a mailto: link`);
    assert.equal(legal.legalDetails({ PRIVACY_EMAIL: bad }).privacyEmail, '', `${bad} is not used as the privacy address`);
  }
});

test('set details appear, trimmed and escaped, with the support address as the email', () => {
  const details = legal.legalDetails({ SUPPORT_EMAIL: ' hello@example.com ', LEGAL_ADDRESS: '1 rue <Exemple>\n75000 Paris', LEGAL_REGISTRATION: ' SIRET 000 000 000 00000 ' });
  assert.deepEqual(details, { email: 'hello@example.com', privacyEmail: '', phone: '', address: '1 rue <Exemple> 75000 Paris', registration: 'SIRET 000 000 000 00000' });
  assert.deepEqual(labels(details, 'notice'), ['Publisher', 'Address', 'Registration', 'Email', 'Director of publication']);
  assert.deepEqual(labels(details, 'privacy'), ['Data controller', 'Address', 'Registration', 'Email']);
  const html = legal.detailsHtml(legal.detailRows(details));
  assert.match(html, /1 rue &lt;Exemple&gt; 75000 Paris/);
  assert.match(html, /<dt>Email<\/dt><dd><a href="mailto:hello@example\.com">hello@example\.com<\/a><\/dd>/);
  assert.equal(legal.contactPhrase(details), 'email <a href="mailto:hello@example.com">hello@example.com</a>');
});

test('support address only: the terms, the legal notice and privacy questions all use it', () => {
  const details = legal.legalDetails({ SUPPORT_EMAIL: 'support@example.com' });
  const mail = 'email <a href="mailto:support@example.com">support@example.com</a>';
  assert.equal(legal.contactPhrase(details, '../', 'support'), mail);
  assert.equal(legal.contactPhrase(details, '../', 'privacy'), mail, 'no privacy address: the support one');
  assert.match(legal.detailsHtml(legal.detailRows(details, '../', 'privacy')), /<dt>Email<\/dt><dd><a href="mailto:support@example\.com">/);
});

test('support and privacy addresses: privacy questions go to the privacy one, the rest to support', () => {
  const details = legal.legalDetails({ SUPPORT_EMAIL: 'support@example.com', PRIVACY_EMAIL: ' privacy@example.com ' });
  assert.equal(details.privacyEmail, 'privacy@example.com');
  assert.equal(legal.contactEmail(details, 'support'), 'support@example.com');
  assert.equal(legal.contactEmail(details, 'privacy'), 'privacy@example.com');
  assert.equal(legal.contactPhrase(details, '../', 'privacy'), 'email <a href="mailto:privacy@example.com">privacy@example.com</a>');
  const notice = legal.detailsHtml(legal.detailRows(details, '../', 'notice'));
  const privacy = legal.detailsHtml(legal.detailRows(details, '../', 'privacy'));
  assert.match(notice, /mailto:support@example\.com/);
  assert.doesNotMatch(notice, /privacy@/, 'the legal notice shows the support address');
  assert.match(privacy, /mailto:privacy@example\.com/);
  assert.doesNotMatch(privacy, /support@/, 'the controller’s contact is the privacy address');
  // A privacy address alone: privacy questions go to it, everything else to the form.
  const only = legal.legalDetails({ PRIVACY_EMAIL: 'privacy@example.com' });
  assert.equal(legal.contactPhrase(only, '../', 'support'), FORM_PHRASE('../'));
  assert.deepEqual(labels(only, 'notice'), ['Publisher', 'Contact', 'Director of publication']);
  assert.equal(legal.contactEmail(only, 'privacy'), 'privacy@example.com');
});

// Phone numbers in tests are from the ranges kept for fiction (ARCEP: 01 99 00 xx xx;
// the US and Canada: 555-0100 to 555-0199; Ofcom: 020 7946 0xxx, 0121 496 0xxx, 07700 900xxx …),
// or made of zeros, never a real line.
test('a phone number becomes a Phone row of the legal notice, as a tel: link; anything else is left out', () => {
  const details = legal.legalDetails({ SUPPORT_EMAIL: 'support@example.com', LEGAL_PHONE: ' +33 (0)1 99-00.12.34 ', LEGAL_ADDRESS: '1 rue Exemple', LEGAL_REGISTRATION: 'SIRET 1' });
  assert.equal(details.phone, '+33 1 99 00 12 34', 'written the French way, whatever the typing');
  assert.deepEqual(labels(details, 'notice'), ['Publisher', 'Address', 'Registration', 'Email', 'Phone', 'Director of publication'], 'the order the legal notice reads');
  assert.deepEqual(labels(details, 'privacy'), ['Data controller', 'Address', 'Registration', 'Email'], 'the privacy policy shows no phone');
  assert.match(legal.detailsHtml(legal.detailRows(details)), /<dt>Phone<\/dt><dd><a href="tel:\+33199001234">\+33 1 99 00 12 34<\/a><\/dd>/);
  assert.equal(legal.telHref('01 99 00 12 34'), 'tel:0199001234');
  assert.equal(legal.telHref('+1 (650) 319-8930'), 'tel:+16503198930');
  for (const bad of ['12345', 'call me', '+33 1 99 00 12 34 ext. 2', '+33 1 99 00 12 34 (office)', '01 99 00 12 34<script>', '+33 1+99 00 12 34', '1'.repeat(21), '01 99 00\n12 34 <b>']) {
    assert.equal(legal.legalPhone(bad), '', JSON.stringify(bad));
  }
  assert.equal(legal.legalPhone('01 99 00\n12 34'), '01 99 00 12 34', 'one line');
  assert.deepEqual(labels(legal.legalDetails({ LEGAL_PHONE: 'call me' }), 'notice'), ['Publisher', 'Contact', 'Director of publication']);
});

test('the national “(0)” is dropped only from an international number', () => {
  assert.equal(legal.telHref('+33 (0)1 99 00 12 34'), 'tel:+33199001234', 'after +33 the 0 is not dialled');
  assert.equal(legal.telHref('(0)1 99 00 12 34'), 'tel:0199001234', 'a national number keeps its 0');
  assert.equal(legal.telHref('(01) 99 00 12 34'), 'tel:0199001234');
  assert.equal(legal.telHref(' +44 (0)20 7946 0000 '), 'tel:+442079460000');
  assert.equal(legal.phoneHtml('(0)1 99 00 12 34'), '<a href="tel:0199001234">(0)1 99 00 12 34</a>');
});

test('an international number is shown the way its country writes it, after the country code; the tel: link is its digits', () => {
  const shown = value => legal.legalPhone(value);
  // France, as the owner types it (E.164: +33, then the number without its 0) or with spaces, dots, dashes and “(0)”.
  for (const typed of ['+33199001234', '+33 1 99 00 12 34', '+33 (0)1 99 00 12 34', '+33.1.99.00.12.34', '+33-199-001-234', ' +33 1 9900 1234 ']) {
    assert.equal(shown(typed), '+33 1 99 00 12 34', typed);
    assert.equal(legal.telHref(shown(typed)), 'tel:+33199001234', typed);
  }
  const cases = [
    // The US and Canada: area code, exchange, line.
    ['+15145550123', '+1 514 555 0123'],
    ['+1 (514) 555-0123', '+1 514 555 0123'],
    // The United Kingdom: London, a mobile, a 01x1 city, another 01 area, a freephone number.
    ['+442079460000', '+44 20 7946 0000'],
    ['+44 (0)20 7946 0000', '+44 20 7946 0000'],
    ['+447700900123', '+44 7700 900123'],
    ['+441214960000', '+44 121 496 0000'],
    ['+441632960000', '+44 1632 960000'],
    ['+448081570000', '+44 808 157 0000'],
    // Belgium: Brussels, another area, a mobile, a freephone number.
    ['+3220000000', '+32 2 000 00 00'],
    ['+3210000000', '+32 10 00 00 00'],
    ['+32470000000', '+32 470 00 00 00'],
    ['+3280000000', '+32 800 00 000'],
    // Switzerland: Zurich, a freephone number.
    ['+41440000000', '+41 44 000 00 00'],
    ['+41800000000', '+41 800 000 000'],
    // Germany: the area code, then the number in one block (Berlin, Cologne, a mobile, Heidelberg).
    ['+493023125000', '+49 30 23125000'],
    ['+492214710000', '+49 221 4710000'],
    ['+4915100000000', '+49 151 00000000'],
    ['+49 (0)6221 000000', '+49 6221 000000']
  ];
  for (const [typed, expected] of cases) {
    assert.equal(shown(typed), expected, typed);
    assert.equal(legal.telHref(shown(typed)), `tel:+${typed.replace(/\(0\)/g, '').replace(/\D/g, '')}`, `${typed}: the tel: link`);
  }
});

test('another country: groups of three and two digits, or the spaces it was typed with; a national number as typed', () => {
  assert.equal(legal.formatPhone('+351210000000'), '+351 210 000 000', 'Portugal, 9 digits');
  assert.equal(legal.formatPhone('+351 210000000'), '+351 210 000 000', 'a space after the code only');
  assert.equal(legal.formatPhone('+351 21 000 0000'), '+351 21 000 0000', 'typed with its own spaces: kept');
  assert.equal(legal.formatPhone('+3906000000000'), '+39 060 000 000 00', 'Italy keeps its 0; 11 digits: 3 3 3 2');
  assert.equal(legal.formatPhone('+31200000000'), '+31 200 000 000');
  assert.equal(legal.formatPhone('+3520000000'), '+352 000 00 00', 'never a group of one: 7 digits are 3 2 2');
  assert.equal(legal.legalPhone('+7 495 000 00 00'), '+7 495 000 00 00', 'Russia (+7): as typed');
  assert.equal(legal.telHref(legal.legalPhone('+7 495 000 00 00')), 'tel:+74950000000');
  // Without +: as typed, on one line, and dialled with its 0.
  assert.equal(legal.legalPhone('01 99 00 12 34'), '01 99 00 12 34');
  assert.equal(legal.legalPhone('0199001234'), '0199001234');
  assert.equal(legal.telHref(legal.legalPhone('01 99 00 12 34')), 'tel:0199001234');
  // The country code an international number starts with (ITU-T E.164).
  assert.deepEqual(['15145550123', '74950000000', '33199001234', '442079460000', '351210000000', '3520000000', '8613800000000', '85200000000'].map(legal.callingCode), ['1', '7', '33', '44', '351', '352', '86', '852']);
});

test('a number for a country the pages know must have its digits after the code; others are checked loosely', () => {
  const problem = value => legal.legalValueProblem('LEGAL_PHONE', value);
  for (const [typed, words] of [
    ['+330199001234', 'not a phone number: after +33, the 9 digits of the number, without its leading 0'],
    ['+33 01 99 00 12 34', 'not a phone number: after +33, the 9 digits of the number, without its leading 0'],
    ['+3319900123', 'not a phone number: after +33, the 9 digits of the number, without its leading 0'],
    ['+331990012345', 'not a phone number: after +33, the 9 digits of the number, without its leading 0'],
    ['+1514555012', 'not a phone number: after +1, the 10 digits of the number'],
    ['+1 1514 555 0123', 'not a phone number: after +1, the 10 digits of the number'],
    ['+4420794600', 'not a phone number: after +44, the 9 or 10 digits of the number, without its leading 0'],
    ['+44 020 7946 0000', 'not a phone number: after +44, the 9 or 10 digits of the number, without its leading 0'],
    ['+321000000', 'not a phone number: after +32, the 8 or 9 digits of the number, without its leading 0'],
    ['+4144000000', 'not a phone number: after +41, the 9 digits of the number, without its leading 0'],
    ['+49 030 23125000', 'not a phone number: after +49, the 5 to 13 digits of the number, without its leading 0'],
    ['+3512100000000000', 'not a phone number: at most 15 digits after the +'],
    ['+352 12', 'not a phone number'],
    ['+33 1 99 00 12 34 (office)', 'not a phone number']
  ]) {
    assert.equal(problem(typed), words, typed);
    assert.equal(legal.legalPhone(typed), '', `${typed} is left out`);
  }
  // Whatever it accepts, the pages show; a national number is checked as before.
  for (const typed of ['+33199001234', '+15145550123', '+442079460000', '+3220000000', '+41440000000', '+493023125000', '+351210000000', '01 99 00 12 34', '(0)1 99 00 12 34']) {
    assert.equal(problem(typed), '', typed);
    assert.notEqual(legal.legalPhone(typed), '', typed);
  }
});

test('legal.js and the build show the same formatted number', async () => {
  const config = { LEGAL_PHONE: '+33199001234' };
  const node = () => ({ innerHTML: '', textContent: '', hidden: undefined, dataset: {} });
  const notice = node();
  const doc = { body: { dataset: { root: '../' } }, querySelectorAll: selector => (selector === '[data-legal-details="notice"]' ? [notice] : []), querySelector: () => null };
  legal.applyLegal(doc, { config });
  const row = '<div class="lg-dl__row"><dt>Phone</dt><dd><a href="tel:+33199001234">+33 1 99 00 12 34</a></dd></div>';
  assert.ok(notice.innerHTML.includes(row), notice.innerHTML);
  assert.ok(legal.staticLegalHtml(await read('legal/index.html'), config).includes(row), 'the no-JavaScript page');
  assert.match(await read('legal/legal.css'), /\.lg-dl a\[href\^="tel:"\] \{ white-space: nowrap; \}/, 'never cut across two lines');
});

test('legalValueProblem says why a set value is left out, with the same checks as the pages', () => {
  assert.equal(legal.legalValueProblem('SUPPORT_EMAIL', 'ben at example dot com'), 'not a plain email address');
  assert.equal(legal.legalValueProblem('PRIVACY_EMAIL', 'privacy@example'), 'not a plain email address');
  assert.equal(legal.legalValueProblem('SUPPORT_EMAIL', 'me@example.com?bcc=x@example.com'), 'not a plain email address');
  assert.equal(legal.legalValueProblem('LEGAL_PHONE', '+33 1 99 00 12 34 (office)'), 'not a phone number');
  assert.equal(legal.legalValueProblem('LEGAL_PHONE', 'call me'), 'not a phone number');
  for (const [key, value] of [['SUPPORT_EMAIL', ' support@example.com '], ['PRIVACY_EMAIL', 'privacy@example.com'], ['LEGAL_PHONE', '+33 1 99 00 12 34'], ['LEGAL_ADDRESS', 'anything'], ['LEGAL_REGISTRATION', 'SIRET 1'], ['SUPPORT_EMAIL', '   '], ['LEGAL_PHONE', ''], ['LEGAL_PHONE', undefined]]) {
    assert.equal(legal.legalValueProblem(key, value), '', `${key}=${JSON.stringify(value)}`);
  }
  // Whatever it reports as usable, the pages show; whatever it rejects, they leave out.
  for (const value of ['ben at example dot com', 'privacy@example', 'support@example.com']) {
    assert.equal(legal.legalDetails({ SUPPORT_EMAIL: value }).email === '', legal.legalValueProblem('SUPPORT_EMAIL', value) !== '', value);
  }
  for (const value of ['+33 1 99 00 12 34 (office)', '+33 1 99 00 12 34']) {
    assert.equal(legal.legalDetails({ LEGAL_PHONE: value }).phone === '', legal.legalValueProblem('LEGAL_PHONE', value) !== '', value);
  }
});

test('applyLegal fills every placeholder from the configuration', () => {
  const nodes = {};
  const node = () => ({ innerHTML: '', textContent: '', hidden: undefined, dataset: {} });
  const selectors = ['[data-legal-details="notice"]', '[data-legal-details="privacy"]', '[data-legal-contact="support"]', '[data-legal-contact="privacy"]', '[data-legal-events="planner"]', '[data-legal-events="landing"]', '[data-legal-prices]', '[data-legal-features]', '[data-legal-js]', '[data-legal-nojs]'];
  selectors.forEach(selector => { nodes[selector] = [node()]; });
  const doc = { body: { dataset: { root: '../../' } }, querySelectorAll: selector => nodes[selector] || [], querySelector: () => null };
  legal.applyLegal(doc, { config: {} });
  assert.match(nodes['[data-legal-details="notice"]'][0].innerHTML, /\.\.\/\.\.\/teams\/\?ask=question#request/);
  assert.match(nodes['[data-legal-details="notice"]'][0].innerHTML, /Director of publication/);
  assert.doesNotMatch(nodes['[data-legal-details="notice"]'][0].innerHTML, /Address/);
  assert.match(nodes['[data-legal-details="privacy"]'][0].innerHTML, /Data controller/);
  assert.match(nodes['[data-legal-contact="support"]'][0].innerHTML, /^use the /);
  assert.match(nodes['[data-legal-contact="privacy"]'][0].innerHTML, /^use the /);
  assert.equal(nodes['[data-legal-events="planner"]'][0].innerHTML, legal.eventsHtml(api.COUNTED_EVENTS));
  assert.equal(nodes['[data-legal-events="landing"]'][0].innerHTML, legal.eventsHtml(api.LANDING_EVENTS));
  assert.equal(nodes['[data-legal-js]'][0].hidden, false);
  assert.equal(nodes['[data-legal-nojs]'][0].hidden, true);
  // The default configuration is the runtime one, read through src/config.js.
  legal.applyLegal(doc);
  assert.match(nodes['[data-legal-details="notice"]'][0].innerHTML, /1 rue Exemple, 75000 Paris/);
  assert.match(nodes['[data-legal-details="notice"]'][0].innerHTML, /mailto:hello@example\.com/);
  assert.match(nodes['[data-legal-details="notice"]'][0].innerHTML, /tel:\+33199001234/);
  assert.match(nodes['[data-legal-details="privacy"]'][0].innerHTML, /mailto:privacy@example\.com/);
  assert.match(nodes['[data-legal-contact="support"]'][0].innerHTML, /mailto:hello@example\.com/);
  assert.match(nodes['[data-legal-contact="privacy"]'][0].innerHTML, /mailto:privacy@example\.com/);
});

test('src/config.js exports the legal details, trimmed, and runtime-config.js and check.mjs keep them blank', async () => {
  assert.equal(config.SUPPORT_EMAIL, 'hello@example.com');
  assert.equal(config.PRIVACY_EMAIL, 'privacy@example.com');
  assert.equal(config.LEGAL_PHONE, '+33 1 99 00 12 34');
  assert.equal(config.LEGAL_ADDRESS, '1 rue Exemple, 75000 Paris');
  assert.equal(config.LEGAL_REGISTRATION, 'SIRET 000 000 000 00000');
  const runtime = await read('runtime-config.js');
  const check = await read('scripts/check.mjs');
  for (const key of ['SUPPORT_EMAIL', 'PRIVACY_EMAIL', 'LEGAL_PHONE', 'LEGAL_ADDRESS', 'LEGAL_REGISTRATION']) {
    assert.match(runtime, new RegExp(`\\n  ${key}: ''[,\\n]`), `${key} stays blank in the public source`);
    assert.match(check, new RegExp(`'${key}'`), `scripts/check.mjs checks ${key} stays blank`);
  }
});

test('the static pages say what the script writes with nothing configured (no JavaScript: the form)', async () => {
  const blank = legal.legalDetails({});
  const squeeze = html => html.replace(/>\s+</g, '><').trim();
  const found = { notice: 0, privacy: 0, support: 0, privacyContact: 0 };
  for (const [folder, file] of Object.entries(PAGES)) {
    const html = await read(file);
    const root = folder === 'legal/' ? '../' : '../../';
    for (const match of html.matchAll(/<dl class="lg-dl" data-legal-details="([a-z]+)">([\s\S]*?)<\/dl>/g)) {
      assert.ok(['notice', 'privacy'].includes(match[1]), `${file}: ${match[1]}`);
      assert.equal(squeeze(match[2]), legal.detailsHtml(legal.detailRows(blank, root, match[1])), `${file}: the ${match[1]} table`);
      found[match[1]] += 1;
    }
    for (const match of html.matchAll(/<span data-legal-contact="([a-z]+)">([\s\S]*?)<\/span>/g)) {
      assert.ok(['support', 'privacy'].includes(match[1]), `${file}: ${match[1]}`);
      assert.equal(match[2], legal.contactPhrase(blank, root, match[1]), `${file}: a ${match[1]} contact`);
      found[match[1] === 'privacy' ? 'privacyContact' : 'support'] += 1;
    }
    assert.doesNotMatch(html, /data-legal-(?:details|contact)(?!=")/, `${file}: every hook says which contact it is`);
  }
  assert.deepEqual(found, { notice: 1, privacy: 1, support: 2, privacyContact: 2 });
  const notice = await read('legal/index.html');
  assert.doesNotMatch(notice, /<p>Director of publication/, 'no loose paragraph under the table');
  assert.match(await read('legal/privacy/index.html'), /To use any of these rights, <span data-legal-contact="privacy">/);
  assert.match(await read('legal/cookies/index.html'), /<section id="questions"[\s\S]*data-legal-contact="privacy"/);
  assert.equal((await read('legal/terms/index.html')).match(/data-legal-contact="support"/g).length, 2);
});

test('the build writes the configured details into the static pages, as legal.js would, escaped', async () => {
  const sample = { SUPPORT_EMAIL: ' support@example.com ', PRIVACY_EMAIL: 'privacy@example.com', LEGAL_PHONE: '+33 (0)1 99 00 12 34', LEGAL_ADDRESS: '12 rue de l’Exemple <b>\n75011 Paris', LEGAL_REGISTRATION: 'SIRET 123 & co' };
  const details = legal.legalDetails(sample);
  const squeeze = html => html.replace(/>\s+</g, '><').trim();
  for (const [folder, file] of Object.entries(PAGES)) {
    const source = await read(file);
    const root = folder === 'legal/' ? '../' : '../../';
    const built = legal.staticLegalHtml(source, sample);
    // Outside the hooks, the page is unchanged.
    const strip = html => html.replace(/(data-legal-details="[a-z]+">)[\s\S]*?<\/dl>/g, '$1</dl>').replace(/(data-legal-contact="[a-z]+">)[\s\S]*?<\/span>/g, '$1</span>');
    assert.equal(strip(built), strip(source), `${file}: only the hooks change`);
    for (const match of built.matchAll(/<dl class="lg-dl" data-legal-details="([a-z]+)">([\s\S]*?)<\/dl>/g)) {
      assert.equal(match[2], legal.detailsHtml(legal.detailRows(details, root, match[1])), `${file}: the ${match[1]} table`);
    }
    for (const match of built.matchAll(/<span data-legal-contact="([a-z]+)">([\s\S]*?)<\/span>/g)) {
      assert.equal(match[2], legal.contactPhrase(details, root, match[1]), `${file}: a ${match[1]} contact`);
    }
    // With nothing configured, the build writes what the source already says.
    assert.equal(squeeze(legal.staticLegalHtml(source, {})), squeeze(source), `${file}: blank config, blank fallback`);
  }
  const notice = legal.staticLegalHtml(await read('legal/index.html'), sample);
  assert.match(notice, /<dt>Address<\/dt><dd>12 rue de l’Exemple &lt;b&gt; 75011 Paris<\/dd>/, 'escaped, on one line');
  assert.match(notice, /<dt>Registration<\/dt><dd>SIRET 123 &amp; co<\/dd>/);
  assert.match(notice, /<dt>Email<\/dt><dd><a href="mailto:support@example\.com">support@example\.com<\/a><\/dd>/);
  assert.match(notice, /<dt>Phone<\/dt><dd><a href="tel:\+33199001234">\+33 1 99 00 12 34<\/a><\/dd>/);
  assert.doesNotMatch(notice, /<b>/, 'nothing from the configuration is read as markup');
  const privacy = legal.staticLegalHtml(await read('legal/privacy/index.html'), sample);
  assert.match(privacy, /To use any of these rights, <span data-legal-contact="privacy">email <a href="mailto:privacy@example\.com">/);
  // An invalid value is left out, as in the browser.
  const invalid = legal.staticLegalHtml(await read('legal/index.html'), { SUPPORT_EMAIL: 'ben at example dot com', LEGAL_PHONE: 'call me' });
  assert.match(invalid, /<dt>Contact<\/dt><dd>the <a href="\.\.\/teams\/\?ask=question#request">/);
  assert.doesNotMatch(invalid, /mailto:|ben at example|call me/);
  // The build applies it to every legal page, from the deployment's configuration, after copying legal/.
  const build = await read('scripts/build.mjs');
  assert.match(build, /import \{ staticLegalHtml \} from '\.\.\/legal\/legal-details\.js';/);
  const listed = JSON.parse(/const LEGAL_PAGES = (\[[^\]]+\]);/.exec(build)[1].replace(/'/g, '"'));
  assert.deepEqual(listed.sort(), Object.values(PAGES).sort());
  assert.match(build, /staticLegalHtml\(await fs\.readFile\(file, 'utf8'\), deploymentConfig\)/);
  assert.ok(build.indexOf("await copyTree('legal');") < build.indexOf('staticLegalHtml(await'), 'after the copy');
  assert.ok(build.indexOf('const deploymentConfig') < build.indexOf('staticLegalHtml(await'), 'with the deployment’s values');
});

test('no personal email address or phone number is written in legal/', async () => {
  for (const file of await walk('legal')) {
    const source = await read(file);
    assert.doesNotMatch(source, /[A-Za-z0-9._%+-]+@(?!example\.com)[A-Za-z0-9-]+\.[A-Za-z.]{2,}/, `${file} contains an email address`);
    assert.doesNotMatch(source, /@gmail\.com|@bemorin\.com/i, file);
    // The only phone number is Cloudflare’s, the host’s public switchboard; examples in comments are kept for fiction.
    const phones = [...source.matchAll(/\+\d[\d ()-]{7,}\d/g)].map(match => match[0].replace(/\D/g, ''));
    assert.ok(phones.every(phone => phone === '16503198930' || FICTION.test(phone)), `${file}: ${phones}`);
  }
});

test('the build copies legal/ and _redirects, and reads the five legal build variables, documented and listed in Setup', async () => {
  const build = await read('scripts/build.mjs');
  assert.match(build, /await copyTree\('legal'\);/);
  assert.match(build, /await copyFile\('_redirects'\);/);
  const docs = await read('docs/FEEDBACK_AND_WAITLIST.md');
  const admin = await read('admin/admin.js');
  for (const [key, variable] of [['SUPPORT_EMAIL', 'SUPPORT_EMAIL'], ['PRIVACY_EMAIL', 'PRIVACY_EMAIL'], ['LEGAL_PHONE', 'LEGAL_PHONE'], ['LEGAL_ADDRESS', 'LEGAL_ADDRESS'], ['LEGAL_REGISTRATION', 'LEGAL_REGISTRATION']]) {
    assert.match(build, new RegExp(`${key}: process\\.env\\.DAILY_PLANNER_${variable} \\|\\| ''`), key);
    assert.match(docs, new RegExp(`\\| \`DAILY_PLANNER_${variable}\` \\| Text \\|`), `docs: ${variable} in the variables table`);
    assert.match(admin, new RegExp(`\\['${key}', '`), `admin Setup: ${key} in the Legal pages line`);
  }
});

test('the dev server takes the legal and partner build variables from the environment, as the build does', async () => {
  const build = await read('scripts/build.mjs');
  const serve = await read('scripts/serve.mjs');
  const fromBuild = new Map([...build.matchAll(/^ {2}([A-Z_]+): process\.env\.(DAILY_PLANNER_[A-Z_]+) \|\| ''/gm)].map(match => [match[1], match[2]]));
  const fromServe = [...(/const ENV_CONFIG = \[([\s\S]*?)\n\];/.exec(serve)?.[1] || '').matchAll(/\['([A-Z_]+)', '(DAILY_PLANNER_[A-Z_]+)'\]/g)].map(match => [match[1], match[2]]);
  assert.deepEqual(fromServe.map(([key]) => key), ['SUPPORT_EMAIL', 'PRIVACY_EMAIL', 'LEGAL_PHONE', 'LEGAL_ADDRESS', 'LEGAL_REGISTRATION', 'AFFILIATE_URL']);
  for (const [key, variable] of fromServe) {
    assert.equal(variable, fromBuild.get(key), `${key}: the same variable as the build`);
    assert.ok(serve.slice(0, serve.indexOf('import ')).includes(variable), `${variable} is in the header`);
  }
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
  assert.match(await read('partners/index.html'), /Purchases you make yourself, for you or as a gift, don’t count\./);
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
  // Creem's 25%: calculated and paid under its own terms, which don't say what it is worked out on — the terms say no more.
  assert.match(words, /25% of Daily Planner Plus, Give Plus and Plus Family bought through your link\. Creem tracks these sales, and calculates and pays this commission under its affiliate terms\./);
  assert.doesNotMatch(words, /Plus Family bought through your link, on the price before tax/);
  assert.match(words, /10% of a team gift you introduced, on its price before tax: bought online through your link, or ordered by invoice or quote when the company’s request carries your code\. We pay this commission ourselves\./);
  assert.match(words, /A link counts for 30 days\./);
  assert.match(words, /A purchase refunded in full, or disputed, earns nothing\. A team commission is earned once the gift’s 14-day refund period has passed without a full refund or a dispute\. If only part of a team gift is refunded, its commission is on the part kept: for example, half the price refunded halves the commission\./);
  assert.doesNotMatch(words, /If only part of the price is refunded/, 'a partial refund is about team gifts: Creem’s 25% follows its own terms');
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
    assert.ok(asks.length > 0, file);
    for (const href of asks) assert.equal(resolveHref(folder, href) + href.slice(href.indexOf('?')), 'teams/?ask=question#request', `${file}: ${href}`);
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
  // Every script of the planner, the welcome, Teams and partners pages and the admin, so a new key can't be missed.
  const sources = ['app.js', 'index.html', ...(await walk('src')), ...(await walk('welcome')), ...(await walk('teams')), ...(await walk('partners')), ...(await walk('admin'))].filter(file => /\.(?:js|mjs|html)$/.test(file));
  assert.ok(sources.includes('src/features/tour-model.js') && sources.includes('src/features/first-use-model.js') && sources.includes('src/features/pip-window.js'), 'nested modules are read');
  const keys = new Set();
  for (const file of sources) for (const match of (await read(file)).matchAll(/['"`](daily-planner-(?:ui|sync):[a-z0-9-]+)['"`]/g)) keys.add(match[1]);
  assert.ok(keys.size >= 21, `found ${keys.size} keys`);
  for (const key of ['daily-planner-ui:tips', 'daily-planner-ui:tour', 'daily-planner-ui:share', 'daily-planner-ui:pip-view', 'daily-planner-ui:pip-size', 'daily-planner-ui:pip-unresolved', 'daily-planner-ui:partner-hints']) assert.ok(keys.has(key), `${key} found in the code`);
  for (const key of keys) assert.ok(cookies.includes(`<code>${key}</code>`), `${key} is listed`);
  assert.match(cookies, /<code>daily-planner-recovery<\/code>/, 'the recovery snapshots (IndexedDB)');
  assert.match(cookies, /<code>daily-planner:<\/code>/, 'the planner itself');
});
