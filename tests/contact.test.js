import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { TEAM_SOURCES, validateTeamRequest } from '../server/planner-api.js';
import { CONTACT_SOURCE, CONTACT_TOPICS, KINDS, cardFollows, contactAddress, contactTopic, movedAddress, requestPayload } from '../welcome/teams-model.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFile(join(root, file), 'utf8');

/**
 * Runs the inline <head> script of a page against an address: where it sent
 * the page ('' when it stayed) and the classes it put on <html>.
 */
async function runHead(file, address, { reduce = false } = {}) {
  const page = await read(file);
  const code = /<script>\s*([\s\S]*?)<\/script>/.exec(page)[1];
  const url = new URL(address, 'https://planner.bemorin.com');
  let target = '';
  const location = { pathname: url.pathname, search: url.search, hash: url.hash, replace: to => { target = to; } };
  const classes = new Set();
  const documentElement = { classList: { add: (...names) => names.forEach(name => classes.add(name)), remove: (...names) => names.forEach(name => classes.delete(name)), contains: name => classes.has(name) } };
  vm.runInNewContext(code, {
    window: { location, matchMedia: () => ({ matches: reduce }), IntersectionObserver: class {}, setTimeout: () => 0 },
    document: { documentElement },
    URLSearchParams
  });
  return { target, classes: [...classes].sort() };
}

test('the Contact page: its own address, the welcome pages’ head, header and footer', async () => {
  const page = await read('contact/index.html');
  assert.match(page, /<title>Contact — Daily Planner<\/title>/);
  assert.match(page, /<link rel="canonical" href="https:\/\/planner\.bemorin\.com\/contact\/">/);
  assert.match(page, /<meta property="og:url" content="https:\/\/planner\.bemorin\.com\/contact\/">/);
  for (const meta of ['description', 'og:title', 'og:description', 'og:image', 'twitter:card', 'twitter:title', 'twitter:image']) assert.match(page, new RegExp(`(?:property|name)="${meta}" content="[^"]+"`), meta);
  assert.match(page, /<meta name="color-scheme" content="light dark">/);
  assert.match(page, /<link rel="stylesheet" href="\.\.\/welcome\/landing\.css">\n {2}<link rel="stylesheet" href="\.\/contact\.css">/, 'its own styles, after the landing page’s');
  assert.ok(page.indexOf("classList.add('js-anim')") < page.indexOf('../welcome/landing.css'), 'motion armed before the styles');
  assert.ok(page.indexOf('<script src="../runtime-config.js">') > 0 && page.indexOf('../runtime-config.js') < page.indexOf('./contact.js'), 'the runtime config first');
  assert.match(page, /<script type="module" src="\.\/contact\.js"><\/script>/);
  assert.match(page, /<body class="contact-page">/);
  const data = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(page)[1]);
  assert.equal(data['@type'], 'ContactPage');
  assert.equal(data.url, 'https://planner.bemorin.com/contact/');
  assert.equal(data.isPartOf.url, 'https://planner.bemorin.com/');
  const nav = /<nav class="top__nav"[\s\S]*?<\/nav>/.exec(page)[0];
  assert.deepEqual([...nav.matchAll(/<a href="([^"]+)"/g)].map(match => match[1]), ['../welcome/#how', '../welcome/#year', '../welcome/#plus', '../teams/', '../welcome/#pricing', '../welcome/#faq', '../partners/']);
  assert.match(page, /<a class="brand" href="\.\.\/welcome\/"/);
  assert.match(page, /<a class="btn btn--primary btn--sm" href="\.\.\/" data-cta="app">Open the planner<\/a>/);
  // The footer repeats nothing from the top bar (1.32): the brand, the social links once set, the legal pages and Contact (this page).
  const foot = /<footer class="foot">[\s\S]*?<\/footer>/.exec(page)[0];
  assert.match(foot, /<nav class="foot__links" aria-label="Social links" hidden>\s*<span class="foot__social" data-social hidden><\/span>\s*<\/nav>/);
  assert.deepEqual([...foot.matchAll(/<a [^>]*>([^<]+)<\/a>/g)].map(match => match[1]), ['Ben Morin', 'Privacy', 'Terms', 'Cookies', 'Legal notice', 'Contact']);
  assert.match(foot, /<\/nav>\n {8}<a href="\.\/" aria-current="page">Contact<\/a>\n {6}<\/div>/, 'Contact after the legal pages, marked as this page');
  assert.doesNotMatch(foot, /data-support|Open the planner|Ask a question/);
  const legal = /<nav class="foot__legal"[\s\S]*?<\/nav>/.exec(page)[0];
  assert.deepEqual([...legal.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)].map(match => [match[1], match[2]]), [['../legal/privacy/', 'Privacy'], ['../legal/terms/', 'Terms'], ['../legal/cookies/', 'Cookies'], ['../legal/', 'Legal notice']]);
  assert.match(page, /<a class="foot__counts" href="\.\.\/welcome\/#privacy" data-counts-link hidden>/);
  // Every icon it uses is in its sprite, every in-page link has its target.
  const ids = new Set([...page.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]));
  for (const [, target] of page.matchAll(/<use href="#([^"]+)"/g)) assert.ok(ids.has(target), `icon ${target}`);
  for (const [, target] of page.matchAll(/<a [^>]*href="#([^"]+)"/g)) assert.ok(ids.has(target), `#${target}`);
});

test('the Contact page’s form is the question form alone: no kinds, no team fields', async () => {
  const page = await read('contact/index.html');
  const form = /<form class="team-form ct-form"[\s\S]*?<\/form>/.exec(page)?.[0] || '';
  assert.ok(form, 'the request form’s markup, on a light card');
  assert.match(form, /data-team-form data-kind="question" novalidate aria-labelledby="contact-title" aria-describedby="contact-intro"/);
  assert.doesNotMatch(form, /data-kind-group|data-team-field|data-listbox|name="(?:kind|company|plan|teamSize|timing)"/);
  assert.deepEqual([...form.matchAll(/\sname="([a-zA-Z]+)"/g)].map(match => match[1]), ['email', 'name', 'message', 'website'], 'no consent box (1.32): replying is what the form is for');
  assert.match(form, /<textarea name="message" rows="6" maxlength="1000" required/);
  assert.match(form, /<span data-email-label>Email<\/span><input type="email" name="email" autocomplete="email" required maxlength="254" placeholder="you@example\.com"/);
  assert.doesNotMatch(form, /consent|type="checkbox"/);
  // Instead, one short line: what is kept, why, for how long, and where to read more.
  assert.match(form, /<p class="form-privacy" data-privacy-line hidden>What you send is stored only to reply to you, and deleted on request\. <a href="\.\.\/legal\/privacy\/#requests">How questions are handled<\/a><\/p>/);
  assert.match(form, /data-mailto-line hidden>/);
  assert.match(form, /<button class="btn btn--light btn--send" type="submit" data-form-submit disabled>Send the question<\/button>/);
  assert.match(page, /<div class="wrap ct__grid" data-form-panel>/);
  assert.match(page, /data-form-done hidden tabindex="-1"[\s\S]*?data-form-again>Ask another question</);
  // The page's head is the form's: the general topic, written in, so it reads the same without JavaScript.
  const general = CONTACT_TOPICS.general;
  assert.match(page, new RegExp(`<span data-form-kicker>${general.kicker}</span>`));
  assert.match(page, new RegExp(`<h1 id="contact-title" data-form-title>${general.title}</h1>`));
  assert.ok(page.includes(`<p class="lead" id="contact-intro" data-form-intro>${general.intro}</p>`));
  assert.equal(general.message, '');
  assert.deepEqual([CONTACT_TOPICS.partners.title, CONTACT_TOPICS.partners.message], ['Ask about the partner program', 'Partner program: ']);
  assert.match(CONTACT_TOPICS.partners.intro, /who you’d recommend Daily Planner to/);
});

test('the Contact page points to Help, the team gift and the partner program; the addresses only when they are set', async () => {
  const page = await read('contact/index.html');
  const more = /<aside class="ct__more"[\s\S]*?<\/aside>/.exec(page)[0];
  assert.match(more, /<h2 id="ct-more-title">Before you write<\/h2>/);
  assert.deepEqual([...more.matchAll(/<a class="ct-link"([^>]*)>[\s\S]*?<b>([^<]+)<\/b>/g)].map(match => [/href="([^"]*)"/.exec(match[1])?.[1] || '', match[2]]), [
    ['../?help', 'Help in the planner'],
    ['../teams/', 'The team gift'],
    ['../partners/', 'The partner program'],
    ['', 'Your data']
  ]);
  assert.match(more, /<li data-privacy-contact hidden>/, 'the privacy address waits for PRIVACY_EMAIL');
  assert.match(page, /<p class="ct__alt" data-support-alt hidden>[\s\S]*?Prefer email\? Write to <a data-support-link><\/a>\.<\/span><\/p>/, 'the plain address waits for SUPPORT_EMAIL');
  assert.doesNotMatch(page.replace('placeholder="you@example.com"', ''), /mailto:|@[a-z0-9-]+\.[a-z]/i, 'no address written into the page');
  const script = await read('contact/contact.js');
  assert.match(script, /configEmail\(LANDING\.supportEmail, configText\('SUPPORT_EMAIL'\)\)/, 'the setting first, then the build variable');
  assert.match(script, /configEmail\(configText\('PRIVACY_EMAIL'\)\)/);
  assert.match(script, /return EMAIL_RE\.test\(email\) \? email : '';/, 'a plain address, or nothing');
  assert.match(script, /link\.textContent = support;/);
  assert.match(script, /textContent = privacy;/);
  assert.doesNotMatch(script, /innerHTML/);
});

test('the Contact page’s script: the question form in its question-only mode, the topic from the address, motion', async () => {
  const script = await read('contact/contact.js');
  assert.match(script, /createRequestForm\(\{ settings: LANDING, questionsOnly: true, topic: contactTopic\(location\.search\), source: CONTACT_SOURCE \}\);/);
  for (const call of ['if (apiOn) rememberReferral();', 'followCard();', 'setupTopBar();', 'renderFooter();', 'setupReveal({ motionOn: motionWanted(), motionHooks });', 'followMotion(motionHooks);', "html.classList.add('js-ready');", "track('landing_cta_app')"]) assert.ok(script.includes(call), call);
  const form = await read('welcome/request-form.js');
  assert.match(form, /export function createRequestForm\(\{ sale = null, track = \(\) => \{\}, settings, questionsOnly = false, topic = 'general', source = 'teams' \}\)/);
  assert.match(form, /const plan = questionsOnly \? null : createListbox\(/, 'no plan dropdown for a question');
  assert.match(form, /const people = questionsOnly \? null : createStepper\(/, 'no number of people');
  assert.match(form, /request\.kind = questionsOnly \? 'question' :/, 'always a question');
  assert.match(form, /const copy = questionsOnly \? \{ \.\.\.KINDS\.question, \.\.\.contactCopy \} : requestCopy\(request\.kind\);/, 'the page’s own head, by topic');
  assert.match(form, /if \(contactCopy\.message && !field\('message'\)\.value\) field\('message'\)\.value = contactCopy\.message;/, '“Partner program: ” starts the question');
  assert.match(form, /sendRequest\(values, \{ currency: sale\?\.currency \|\| '', source \}\)/);
  assert.equal(KINDS.question.submit, 'Send the question');
});

test('the Contact page’s topic: the partner program for ?topic=partners, anything else otherwise', () => {
  assert.equal(contactTopic('?topic=partners'), 'partners');
  assert.equal(contactTopic('?ref=CAMILLE&topic=partners'), 'partners');
  assert.equal(contactTopic('?ask=question&topic=partners'), 'partners');
  for (const search of ['', '?topic=PARTNERS', '?topic=teams', '?topic=', undefined, '?%']) assert.equal(contactTopic(search), 'general', String(search));
});

test('its questions are sent as a source the server keeps: “contact” once server/planner-api.js accepts it', () => {
  // Until TEAM_SOURCES has 'contact', anything else is stored as 'landing': the Contact page says 'teams', where the form was.
  assert.equal(CONTACT_SOURCE, TEAM_SOURCES.has('contact') ? 'contact' : 'teams', 'switch CONTACT_SOURCE to \'contact\' when the server accepts it');
  assert.ok(TEAM_SOURCES.has(CONTACT_SOURCE));
  const values = { email: 'ann@example.com', name: 'Ann', company: '', plan: '', teamSize: '', timing: '', message: 'Partner program: who can join?', website: '', kind: 'question' };
  const body = requestPayload(values, { version: '1.31.0', locale: 'fr-FR', source: CONTACT_SOURCE });
  assert.deepEqual(body, { email: 'ann@example.com', name: 'Ann', message: 'Partner program: who can join?', website: '', version: '1.31.0', locale: 'fr-FR', source: CONTACT_SOURCE, kind: 'question' });
  const stored = validateTeamRequest(body, new Date('2026-10-21T09:00:00Z')).entry;
  assert.deepEqual([stored.kind, stored.source, stored.company, stored.teamSize], ['question', CONTACT_SOURCE, '', 0]);
  assert.equal(requestPayload(values).source, 'teams', 'the Teams page, unless said otherwise');
});

test('an old address asking for the question form leads to the Contact page, before first paint', async () => {
  const cases = [
    ['/teams/?ask=question', '/contact/'],
    ['/teams/?ask=question#request', '/contact/'],
    ['/teams/?ask=question&topic=partners#request', '/contact/?topic=partners'],
    ['/teams/index.html?ref=CAMILLE&ask=question&plan=up-to-50#request', '/contact/?ref=CAMILLE'],
    ['/teams/?topic=partners&ask=question', '/contact/?topic=partners'],
    ['/teams/', ''],
    ['/teams/#request', ''],
    ['/teams/?ask=invoice&plan=up-to-50#request', ''],
    ['/teams/?ask=quote&plan=over-1000', ''],
    ['/teams/?ref=CAMILLE', '']
  ];
  for (const [from, to] of cases) {
    const url = new URL(from, 'https://planner.bemorin.com');
    assert.equal(contactAddress({ path: url.pathname, search: url.search }), to, from);
    const head = await runHead('teams/index.html', from);
    assert.equal(head.target, to, `Teams page head script: ${from}`);
    assert.deepEqual(head.classes, to ? [] : ['js-anim'], `the entrances are armed only when the page stays: ${from}`);
  }
  // The welcome page does the same (its old ?ask=… addresses), the partners page's old links included.
  for (const [from, to] of [['/welcome/?ask=question&topic=partners#request', '/contact/?topic=partners'], ['/welcome/?ask=question', '/contact/'], ['/welcome/?ask=invoice#request', '/teams/?ask=invoice#request']]) {
    const url = new URL(from, 'https://planner.bemorin.com');
    assert.equal(movedAddress({ path: url.pathname, search: url.search, hash: url.hash }), to, from);
    assert.equal((await runHead('welcome/index.html', from)).target, to, `welcome head script: ${from}`);
  }
  // A planner served from a folder keeps it.
  assert.equal(contactAddress({ path: '/planner/teams/', search: '?ask=question' }), '/planner/contact/');
  assert.equal(contactAddress(), '');
  // The Teams page's own arming is the welcome page's.
  const arm = source => /var root = document\.documentElement;[\s\S]*?\}, 4000\);/.exec(source)?.[0];
  assert.equal(arm(await read('teams/index.html')), arm(await read('welcome/index.html')));
});

test('the Contact page’s head script: the partner program’s head waits for the script, motion as on the other pages', async () => {
  assert.deepEqual((await runHead('contact/index.html', '/contact/')).classes, ['js-anim']);
  assert.deepEqual((await runHead('contact/index.html', '/contact/?topic=partners')).classes, ['js-anim', 'js-topic']);
  assert.deepEqual((await runHead('contact/index.html', '/contact/?topic=partners', { reduce: true })).classes, ['js-topic'], 'reduced motion: no entrances, the head still waits');
  assert.deepEqual((await runHead('contact/index.html', '/contact/', { reduce: true })).classes, []);
  assert.equal((await runHead('contact/index.html', '/contact/?topic=partners')).target, '', 'the page stays');
  const page = await read('contact/index.html');
  assert.match(page, /window\.setTimeout\(function \(\) \{ if \(!root\.classList\.contains\('js-ready'\)\) root\.classList\.remove\('js-anim', 'js-topic'\); \}, 4000\);/, 'without the script, everything shows after 4 s');
  const css = await read('contact/contact.css');
  assert.match(css, /\.js-topic:not\(\.js-ready\) \.ct__intro > :is\(\.kicker, h1, \.lead\) \{ visibility: hidden; \}/);
});

test('the Contact page’s styles: the landing page’s parts, light and dark, no motion when it is not wanted', async () => {
  const css = await read('contact/contact.css');
  assert.doesNotMatch(css, /!important/);
  // The form sits on a light card: the band's tokens take the page's colours, in both themes.
  for (const token of ['--band-bg: var(--surface-strong);', '--band-ink: var(--ink);', '--band-muted: var(--muted);', '--band-field: var(--paper);', '--band-accent: var(--focus);', '--band-error: var(--danger);']) assert.ok(css.includes(token), token);
  assert.match(css, /@media \(prefers-color-scheme: dark\)/);
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, 'colours come from the tokens');
  // Every animation and transition waits for prefers-reduced-motion: no-preference.
  const outside = css.replace(/@media (?:screen and )?\(prefers-reduced-motion: no-preference\) \{[\s\S]*?\n\}/g, '');
  assert.doesNotMatch(outside, /\b(?:animation|transition):/);
  assert.match(css, /\.ct__intro > \*,\n {2}\.ct__card \{ animation: rise-in 820ms/);
  assert.match(await read('welcome/landing.css'), /@keyframes rise-in \{/);
  assert.match(css, /grid-template-areas: "intro card" "more card";/, 'side by side from 960px');
});

test('the Contact page is published and revalidated like the other pages', async () => {
  assert.match(await read('scripts/build.mjs'), /await copyTree\('contact'\);/);
  assert.match(await read('_headers'), /\n\/contact\/\n {2}Cache-Control: no-cache\n/);
  const lines = (await read('_redirects')).split('\n').map(line => line.trim());
  assert.ok(!lines.some(line => /^\/contact/.test(line)), '/contact/ is a page, not a redirect');
});

test('from 960px the card keeps to the window as the page scrolls, only when all of it fits', async () => {
  // 64px top bar, 24px from it and from the bottom of the window.
  assert.equal(cardFollows({ card: 555, viewport: 900, topBar: 64 }), true);
  assert.equal(cardFollows({ card: 555, viewport: 667, topBar: 64 }), true, 'exactly enough room');
  assert.equal(cardFollows({ card: 555, viewport: 666, topBar: 64 }), false, 'a taller card would hide its own button');
  assert.equal(cardFollows({ card: 0, viewport: 900, topBar: 64 }), false, 'nothing measured, nothing to follow');
  assert.equal(cardFollows(), false);
  const css = await read('contact/contact.css');
  const wide = css.slice(css.indexOf('/* From 960px the card keeps to the window'));
  assert.match(wide, /@media \(min-width: 960px\) \{\n {2}\.ct \{ padding-bottom: 40px; \}/, 'the card stops 40px above the footer, never on its hairline…');
  assert.match(wide, /grid-template-rows: auto 1fr max\(0px, clamp\(64px, 8vw, 112px\) - 88px\);\n {4}grid-template-areas: "intro card" "more card" "\. \.";/, '…after sliding through the row gap and a last, empty row (48px + that row + 40px: the space as before)');
  assert.match(wide, /\.ct__card\.is-following \{ position: sticky; top: calc\(var\(--top-h\) \+ 24px\); \}\n\}/, 'below the top bar, at desktop widths only');
  assert.match(css, /padding: clamp\(32px, 6vw, 88px\) 0 clamp\(64px, 8vw, 112px\);/, 'the same space as before, on phones too');
  assert.match(css, /body\.contact-page \{ padding-bottom: 0; \}/, 'no room kept under the footer for a dock this page doesn’t have');
  const script = await read('contact/contact.js');
  assert.match(script, /card\.classList\.toggle\('is-following', cardFollows\(\{ card: card\.offsetHeight, viewport: window\.innerHeight, topBar: top\?\.offsetHeight \|\| 0 \}\)\)/);
  assert.match(script, /new ResizeObserver\(check\)\.observe\(card\);\n {2}window\.addEventListener\('resize', check, \{ passive: true \}\);/, 'checked on resize, never on scroll');
  assert.doesNotMatch(script, /addEventListener\('scroll'/);
});
