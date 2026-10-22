import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { PARTNER_PROGRAM, PLUS_FEATURES, TEAM_TIERS } from '../src/lib/pricing.js';
import { TEAM_ROWS, partnerInvitation } from '../welcome/landing-model.js';
import { CONTACT_TOPICS, EMAIL_FIELD, KINDS, TIMING_LABELS, emailField, invoiceAnswer, isTeamKind, managerMessage, movedAddress, requestCopy, requestEmail, requestFromAddress, requestPayload } from '../welcome/teams-model.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFile(join(root, file), 'utf8');

/** Runs the inline <head> script of welcome/index.html against an address; returns where it sent the page ('' when it stayed). */
async function headScriptTarget(address) {
  const page = await read('welcome/index.html');
  const code = /<script>\s*([\s\S]*?)<\/script>/.exec(page)[1];
  const url = new URL(address, 'https://planner.bemorin.com');
  let target = '';
  const location = { pathname: url.pathname, search: url.search, hash: url.hash, replace: to => { target = to; } };
  const classes = new Set();
  const documentElement = { classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) } };
  vm.runInNewContext(code, {
    window: { location, matchMedia: () => ({ matches: false }), IntersectionObserver: class {}, setTimeout: () => 0 },
    document: { documentElement },
    URLSearchParams
  });
  return { target, armed: classes.has('js-anim') };
}

test('old /welcome/ addresses: a question leads to the Contact page, the team gift to the Teams page, query and hash kept', async () => {
  const cases = [
    ['/welcome/?ask=question#request', '/contact/'],
    ['/welcome/?ask=question&topic=partners#request', '/contact/?topic=partners'],
    ['/welcome/?ref=CAMILLE&ask=question&plan=up-to-50#request', '/contact/?ref=CAMILLE'],
    ['/welcome/index.html?ask=question', '/contact/'],
    ['/welcome/?ask=quote&plan=over-1000', '/teams/?ask=quote&plan=over-1000'],
    ['/welcome/?ref=CAMILLE&ask=invoice#request', '/teams/?ref=CAMILLE&ask=invoice#request'],
    ['/welcome/#teams', '/teams/'],
    ['/welcome/?ref=CAMILLE#teams', '/teams/?ref=CAMILLE'],
    ['/welcome/#team-prices', '/teams/#team-prices'],
    ['/welcome/#seats', '/teams/#seats'],
    ['/welcome/index.html#request', '/teams/#request'],
    ['/welcome#request', '/teams/#request'],
    ['/welcome/', ''],
    ['/welcome/?ref=CAMILLE', ''],
    ['/welcome/#plus', ''],
    ['/welcome/#gifts', ''],
    ['/welcome/#privacy', ''],
    ['/welcome/#requests', '']
  ];
  for (const [from, to] of cases) {
    const url = new URL(from, 'https://planner.bemorin.com');
    assert.equal(movedAddress({ path: url.pathname, search: url.search, hash: url.hash }), to, from);
    // The inline script in <head> does the same before first paint, and only then arms the entrances.
    const head = await headScriptTarget(from);
    assert.equal(head.target, to, `head script: ${from}`);
    assert.equal(head.armed, !to, `head script arms the entrances only when the page stays: ${from}`);
  }
  assert.equal(movedAddress(), '');
  const script = await read('welcome/landing.js');
  assert.match(script, /movedAddress\(\{ path: location\.pathname, search: location\.search, hash: location\.hash \}\)/, 'landing.js checks again');
});

test('the request form reads what an address asks: kind and plan', () => {
  assert.deepEqual(requestFromAddress('?ask=question'), { kind: 'question', plan: '' });
  assert.deepEqual(requestFromAddress('?ask=quote&plan=over-1000'), { kind: 'quote', plan: 'over-1000' });
  assert.deepEqual(requestFromAddress('?ask=invoice&plan=up-to-100'), { kind: 'invoice', plan: 'up-to-100' });
  assert.deepEqual(requestFromAddress('?ask=invoice&topic=partners'), { kind: 'invoice', plan: '' }, 'the program is the Contact page’s');
  assert.deepEqual(requestFromAddress('?ask=talk'), { kind: '', plan: '' }, 'no talk while it is not offered');
  assert.deepEqual(requestFromAddress('?ask=talk', { talk: true }).kind, 'talk');
  assert.deepEqual(requestFromAddress('?ask=toString&plan=nope'), { kind: '', plan: '' }, 'unknown values are dropped');
  assert.deepEqual(requestFromAddress(''), { kind: '', plan: '' });
  assert.deepEqual(requestFromAddress(undefined), { kind: '', plan: '' });
  assert.deepEqual(Object.keys(KINDS), ['invoice', 'quote', 'question', 'talk']);
  assert.equal(CONTACT_TOPICS.partners.title, 'Ask about the partner program');
  assert.deepEqual(Object.keys(TIMING_LABELS), ['december-2026', 'january-2027', 'q1-2027', 'later']);
});

test('a question is the plain form: email, name and the question; an invoice, a quote or a talk is about a team', () => {
  assert.deepEqual(Object.keys(KINDS).filter(isTeamKind), ['invoice', 'quote', 'talk']);
  assert.equal(isTeamKind('question'), false);
  assert.equal(isTeamKind(''), true, 'the form starts as an invoice');
  // Who can ask: anyone, with any address.
  assert.equal(emailField('question'), EMAIL_FIELD.question);
  assert.deepEqual([EMAIL_FIELD.question.label, EMAIL_FIELD.question.placeholder, EMAIL_FIELD.question.missing], ['Email', 'you@example.com', 'Enter your email.']);
  for (const kind of ['invoice', 'quote', 'talk']) assert.equal(emailField(kind).label, 'Work email', kind);
  // On the Teams page, a question is about the team gift: anyone's other questions are the Contact page's.
  const question = requestCopy('question');
  assert.deepEqual([question.kicker, question.title, question.intro], ['Invoice, quote or question', 'Ask about the team gift', 'Paying, seats, privacy or timing: anything about the team gift.']);
  for (const topic of ['the planner', 'Plus', 'a purchase', 'the partner program']) assert.ok(CONTACT_TOPICS.general.intro.includes(topic), topic);
  // The team requests read exactly as before, under the same kicker.
  for (const kind of Object.keys(KINDS)) assert.equal(requestCopy(kind).kicker, 'Invoice, quote or question', kind);
  assert.deepEqual([KINDS.invoice.title, KINDS.invoice.intro], ['Get it by invoice', 'Tell us where to send the invoice. You’ll get it by email, then the gift link once it’s paid.']);
  assert.deepEqual([KINDS.quote.title, KINDS.quote.intro], ['Ask for a quote', 'Tell us about your organisation, and you’ll get a quote by email.']);
  assert.equal(requestCopy('nope'), KINDS.invoice);
  assert.deepEqual([KINDS.question.again, KINDS.invoice.again], ['Ask another question', 'Send another request']);
});

test('a question is sent without the team’s fields, and an address never gives it a plan', () => {
  const values = { email: 'ann@example.com', name: 'Ann', company: 'ignored', plan: 'up-to-50', teamSize: '50', timing: 'december-2026', message: 'Partner program: who can join?', website: '', kind: 'question' };
  assert.deepEqual(requestPayload(values, { currency: 'EUR', version: '1.29.1', locale: 'fr-FR', ref: 'COACH_ANNA' }), { email: 'ann@example.com', name: 'Ann', message: 'Partner program: who can join?', website: '', version: '1.29.1', locale: 'fr-FR', source: 'teams', kind: 'question', ref: 'COACH_ANNA' });
  const invoice = requestPayload({ ...values, kind: 'invoice' }, { currency: 'EUR' });
  assert.deepEqual([invoice.company, invoice.teamSize, invoice.timing, invoice.plan, invoice.currency], ['ignored', 50, 'december-2026', 'up-to-50', 'EUR'], 'an invoice: as today');
  assert.deepEqual(requestFromAddress('?ask=question&plan=up-to-100'), { kind: 'question', plan: '' });
  assert.deepEqual(requestFromAddress('?plan=up-to-100'), { kind: '', plan: 'up-to-100' }, 'no kind: the invoice keeps its plan');
  // Without the API, the email says the same.
  assert.deepEqual(requestEmail(values, { plan: 'Team gift, up to 50 people (€595)', timing: 'Before the holidays', ref: 'COACH_ANNA' }), {
    subject: 'Daily Planner — Question from Ann',
    lines: ['Request: Question', 'Name: Ann', 'Email: ann@example.com', 'Partner code: COACH_ANNA', '', 'Partner program: who can join?']
  });
  assert.deepEqual(requestEmail({ ...values, kind: 'invoice', company: 'Acme', message: '' }, { plan: 'Team gift, up to 50 people (€595)', timing: 'Before the holidays' }), {
    subject: 'Daily Planner team gift — Invoice: Acme',
    lines: ['Request: Invoice', 'Plan: Team gift, up to 50 people (€595)', 'Number of people: 50', 'Timing: Before the holidays', 'Company: Acme', 'Name: Ann', 'Email: ann@example.com']
  });
});

test('the request form hides the team’s fields for a question, and keeps its head the height of the tallest version', async () => {
  const page = await read('teams/index.html');
  const form = /<form class="team-form"[\s\S]*?<\/form>/.exec(page)[0];
  // The four team fields carry the hook; the email, the name and the message never do.
  const hooked = [...form.matchAll(/<(?:label|div) class="field"[^>]*data-team-field[^>]*>[\s\S]*?(?:name|id)="([a-zA-Z-]+)"/g)].map(match => match[1]);
  assert.deepEqual(hooked, ['company', 'plan-label', 'team-size', 'timing-label']);
  assert.equal((form.match(/data-team-field/g) || []).length, 4);
  assert.match(form, /<div class="team-form__head" data-form-head>\s*<p class="band__kicker"><svg class="i"><use href="#i-mail"\/><\/svg><span data-form-kicker>Invoice, quote or question<\/span><\/p>/);
  assert.match(form, /<span data-email-label>Work email<\/span>/);
  // No consent box (1.32): an invoice, a quote or a question is sent to be answered. One line says what is kept and why.
  assert.doesNotMatch(form, /consent|type="checkbox"/);
  assert.match(form, /<p class="form-privacy" data-privacy-line hidden>What you send is stored only to reply to you, and deleted on request\. <a href="#privacy" data-privacy-open="requests">How requests are handled<\/a><\/p>/);
  const script = await read('welcome/request-form.js');
  assert.doesNotMatch(script, /consent/i, 'nothing to tick, read or check');
  assert.match(script, /qs\('\[data-privacy-line\]', form\)\.hidden = requestMode !== 'api';/);
  assert.doesNotMatch(await read('welcome/teams-model.js'), /consent: /);
  assert.match(script, /teamFields\.forEach\(node => \{ node\.hidden = !team; \}\);/);
  assert.match(script, /\['company', !team \? '' :/, 'a question never asks for a company');
  assert.match(script, /sizeHead\(\);/);
  assert.match(script, /ghost\.setAttribute\('aria-hidden', 'true'\);/);
  // Arriving from “Ask a question” elsewhere: the title takes the focus, even after the browser moves it to the link's target.
  assert.match(script, /panel\.tabIndex = -1;\n {4}panel\.addEventListener\('focus', event => \{ if \(event\.target === panel\) title\.focus\(\{ preventScroll: true \}\); \}\);/);
  assert.match(await read('teams/teams.js'), /if \(arrived\.matches\('\[data-form-panel\]'\)\) form\?\.arrive\(\);/);
  const css = await read('welcome/landing.css');
  assert.match(css, /\.team-form__heads > \.team-form__head \{ grid-area: 1 \/ 1; align-self: start; \}/);
  assert.match(css, /\.team-form__ghost \{ visibility: hidden; \}/);
  assert.match(css, /:root \[hidden\] \{ display: none; \}/, 'a hidden field never shows, whatever its display');
});

test('a request carries the remembered partner code as `ref`, and nothing when there is none', () => {
  const values = { email: 'ann@example.com', name: 'Ann', company: 'Acme', plan: 'up-to-50', teamSize: '40', timing: 'january-2027', message: 'Hi', website: '', kind: 'invoice' };
  const sent = requestPayload(values, { currency: 'EUR', version: '1.27.0', locale: 'fr-FR', ref: 'CAMILLE_2' });
  assert.deepEqual(sent, { email: 'ann@example.com', name: 'Ann', company: 'Acme', teamSize: 40, timing: 'january-2027', message: 'Hi', website: '', version: '1.27.0', locale: 'fr-FR', source: 'teams', plan: 'up-to-50', currency: 'EUR', kind: 'invoice', ref: 'CAMILLE_2' });
  assert.equal('ref' in requestPayload(values, { currency: 'EUR', ref: '' }), false, 'omitted when no code is remembered');
  assert.equal('ref' in requestPayload(values, { currency: 'EUR' }), false);
  assert.equal('ref' in requestPayload(values, { currency: 'EUR', ref: 'a b<script>' }), false, 'only a valid code goes along');
  assert.equal('ref' in requestPayload(values, { currency: 'EUR', ref: 'x'.repeat(65) }), false);
});

test('the request form sends the code from referralCode(), and the Teams page remembers a partner’s link', async () => {
  const form = await read('welcome/request-form.js');
  assert.match(form, /requestPayload\(values, \{ currency, version: APP_VERSION, locale: navigator\.language \|\| '', ref: referralCode\(\), source \}\)/);
  assert.match(form, /import \{ plannerApiEnabled, referralCode \} from '\.\.\/src\/lib\/planner-api\.js';/);
  const teams = await read('teams/teams.js');
  assert.match(teams, /if \(apiOn\) rememberReferral\(\);/);
});

test('“Send this to my manager” links to the Teams page, with the lowest price per person', async () => {
  const { LANDING } = await import('../welcome/landing-settings.js');
  assert.equal(LANDING.teamsUrl, 'https://planner.bemorin.com/teams/');
  const body = managerMessage(LANDING.managerEmail.body, { url: LANDING.teamsUrl, perPerson: '€5' });
  assert.match(body, /from about €5 per person/);
  assert.match(body, /Details and prices: https:\/\/planner\.bemorin\.com\/teams\//);
  assert.doesNotMatch(body, /\{url\}|\{perPerson\}/);
  assert.equal(LANDING.supportEmail, '', 'blank in the source');
  assert.equal(LANDING.contactEmail, '');
});

test('paying by invoice: the answer follows what is on sale', () => {
  assert.match(invoiceAnswer(true), /^Yes, or by card\./);
  assert.match(invoiceAnswer(false), /^Yes\. Choose a team size and send the request/);
  for (const answer of [invoiceAnswer(true), invoiceAnswer(false)]) assert.match(answer, /one payment, with no subscription\.$/);
});

test('the gift page’s partner invitation names the program’s rate', async () => {
  assert.equal(partnerInvitation(PARTNER_PROGRAM.rate), `Become a partner: share your own link to Daily Planner, and earn a ${PARTNER_PROGRAM.rate}% commission on every Plus, Give Plus and Plus Family bought through it.`);
  assert.match(partnerInvitation(undefined), /earn a commission on every Plus/);
  const thanks = await read('welcome/thanks/thanks.js');
  assert.match(thanks, /partnerInvitation\(PARTNER_PROGRAM\.rate\)/);
  assert.doesNotMatch(thanks, /AFFILIATE_COMMISSION/);
});

test('the Teams page: its own address, the landing page’s head, header and footer', async () => {
  const page = await read('teams/index.html');
  const landing = await read('welcome/index.html');
  assert.match(page, /<title>Team gift — Daily Planner<\/title>/);
  assert.match(page, /<link rel="canonical" href="https:\/\/planner\.bemorin\.com\/teams\/">/);
  assert.match(page, /<meta property="og:url" content="https:\/\/planner\.bemorin\.com\/teams\/">/);
  for (const meta of ['og:title', 'og:description', 'og:image', 'twitter:card', 'twitter:title', 'twitter:image']) assert.match(page, new RegExp(`(?:property|name)="${meta}" content="[^"]+"`), meta);
  // At the site root (/teams/, 1.30): the site's files one folder up, the welcome page's styles in ../welcome/.
  assert.match(page, /<link rel="icon" href="\.\.\/favicon\.svg" type="image\/svg\+xml">/);
  assert.match(page, /<link rel="stylesheet" href="\.\.\/welcome\/landing\.css">/);
  assert.ok(page.indexOf('<script src="../runtime-config.js">') > 0 && page.indexOf('../runtime-config.js') < page.indexOf('./teams.js'), 'the runtime config first');
  assert.match(page, /<script type="module" src="\.\/teams\.js"><\/script>/);
  // The same entrance script as the landing page (without its redirect).
  const arm = source => /var root = document\.documentElement;[\s\S]*?\}, 4000\);/.exec(source)?.[0];
  assert.ok(arm(page) && arm(page) === arm(landing), 'js-anim armed before first paint, as on /welcome/');
  assert.match(page, /<a href="\.\/" aria-current="page">Teams<\/a>/);
  assert.match(page, /<a class="btn btn--primary btn--sm" href="\.\.\/" data-cta="app">Open the planner<\/a>/);
  assert.match(page, /<a class="brand" href="\.\.\/welcome\/"/, 'the brand leads to the welcome page');
  const nav = /<nav class="top__nav"[\s\S]*?<\/nav>/.exec(page)[0];
  assert.deepEqual([...nav.matchAll(/<a href="([^"]+)"/g)].map(match => match[1]), ['../welcome/#how', '../welcome/#year', '../welcome/#plus', './', '../welcome/#pricing', '#faq', '../partners/']);
  const legal = /<nav class="foot__legal"[\s\S]*?<\/nav>/.exec(page)[0];
  assert.deepEqual([...legal.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)].map(match => [match[1], match[2]]), [['../legal/privacy/', 'Privacy'], ['../legal/terms/', 'Terms'], ['../legal/cookies/', 'Cookies'], ['../legal/', 'Legal notice']]);
  assert.match(page, /<body class="teams-page">/);
});

test('the Teams page: every part of the team gift, with the ids old links use', async () => {
  const page = await read('teams/index.html');
  for (const id of ['top', 'seats', 'team-prices', 'request', 'faq', 'privacy']) assert.equal((page.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, id);
  assert.match(page, /<h1 id="teams-title">The year-end gift your team will use all year\.<\/h1>/);
  assert.match(page, /data-scene="gift" data-final="s-open s-on s-seat"/, 'the gift replica');
  assert.match(page, /<div class="tiers" data-tiers>/);
  assert.match(page, /<section class="prices" id="team-prices"/);
  assert.match(page, /data-manager-mail[\s\S]*?data-manager-copy[\s\S]*?data-request="question"/, 'manager email, copy, question');
  assert.match(page, /data-teams-partner>[\s\S]*?Coach or consultant\?[\s\S]*?href="\.\.\/partners\/"/);
  assert.match(page, /<div class="band request" id="request" data-form-panel data-reveal>/);
  assert.match(page, /<form class="team-form" data-team-form novalidate/);
  for (const kind of ['invoice', 'quote', 'question']) assert.match(page, new RegExp(`<input type="radio" name="kind" value="${kind}"`), kind);
  assert.match(page, /data-listbox="plan"[\s\S]*?data-listbox="timing"/);
  assert.match(page, /name="teamSize"/);
  assert.match(page, /data-privacy-open="requests"/);
  // Without JavaScript, the prices still say what they are.
  assert.match(page, /<noscript><p class="tiers__fallback">From €195 for up to 10 people to €4,995 for up to 1,000 people/);
  assert.equal(TEAM_TIERS[0].price.EUR, 195);
  assert.equal(TEAM_TIERS.at(-1).price.EUR, 4995);
  // Sections rise in, as on /welcome/.
  assert.ok((page.match(/data-reveal(?:-each)?[\s>]/g) || []).length >= 8, 'reveal attributes');
  assert.match(page, /class="section__intro" data-reveal-each/);
  assert.match(page, /<section class="final"[^>]*data-final-cta>\s*<div class="wrap final__inner" data-reveal-each>/);
});

test('the Teams page’s structured data describes the team gift with today’s prices', async () => {
  const page = await read('teams/index.html');
  const data = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(page)[1]);
  assert.equal(data['@type'], 'Product');
  assert.equal(data.url, 'https://planner.bemorin.com/teams/');
  assert.equal(data.offers['@type'], 'AggregateOffer');
  assert.equal(data.offers.priceCurrency, 'EUR');
  assert.equal(Number(data.offers.lowPrice), Math.min(...TEAM_TIERS.map(tier => tier.price.EUR)));
  assert.equal(Number(data.offers.highPrice), Math.max(...TEAM_TIERS.map(tier => tier.price.EUR)));
  assert.equal(Number(data.offers.offerCount), TEAM_TIERS.length);
  // The landing page's own structured data stays valid: the planner and Plus.
  const landing = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(await read('welcome/index.html'))[1]);
  assert.deepEqual(landing.offers.map(offer => offer.name), ['Daily Planner', 'Daily Planner Plus']);
});

test('the team questions moved to the Teams page FAQ, in the welcome FAQ’s style', async () => {
  const page = await read('teams/index.html');
  const landing = await read('welcome/index.html');
  const faq = /<div class="faq__groups" data-faq data-reveal-each>[\s\S]*?\n {8}<\/div>\n {6}<\/div>\n {4}<\/section>/.exec(page)?.[0] || '';
  assert.ok(faq, 'one [data-faq] container');
  const questions = [...faq.matchAll(/<details class="qa" name="faq">\s*<summary>([^<]+)<\/summary>\s*<div class="qa__a">/g)].map(match => match[1]);
  const moved = ['How do seats work?', 'Does the company see what people plan?', 'Can we pay by invoice?', 'How long does the gift link work?'];
  for (const question of moved) {
    assert.ok(questions.includes(question), `${question} is on the Teams page`);
    assert.ok(!landing.includes(`<summary>${question}</summary>`), `${question} left the landing page`);
  }
  for (const question of ['Are taxes included, and what does the invoice show?', 'When do we get the gift link?', 'What does each person get?', 'What if someone joins or leaves?', 'Do you collect our people’s names or emails?']) {
    assert.ok(questions.includes(question), question);
  }
  assert.equal((faq.match(/<details class="qa"/g) || []).length, questions.length, 'every answer in a .qa__a panel');
  assert.deepEqual([...faq.matchAll(/<h3 class="faq__label">([^<]+)<\/h3>/g)].map(match => match[1]), ['Buying', 'Seats and people', 'Privacy']);
  assert.match(faq, /<p data-faq-pay>/, 'the invoice answer follows what is on sale');
  assert.match(faq, /<span data-largest-tier>1,000<\/span>/);
  const gets = /<summary>What does each person get\?<\/summary>\s*<div class="qa__a">([\s\S]*?)<\/div>/.exec(faq)[1];
  for (const feature of PLUS_FEATURES) assert.ok(gets.includes(`<b>${feature.title}.</b>`), feature.title);
  // The landing page keeps one pointer for companies.
  assert.match(landing, /<summary>Can my company give Plus to its people\?<\/summary>[\s\S]*?href="\.\.\/teams\/">See the team gift<\/a>/);
  assert.doesNotMatch(landing, /<h3 class="faq__label">Team gift<\/h3>/);
});

test('the landing page leads to the Teams page: menu, banner, footer and every request link', async () => {
  const page = await read('welcome/index.html');
  const nav = /<nav class="top__nav"[\s\S]*?<\/nav>/.exec(page)[0];
  assert.match(nav, /<a href="\.\.\/teams\/">Teams<\/a>/);
  assert.match(page, /<a class="top__teams" href="\.\.\/teams\/">Teams<\/a>/);
  const foot = /<nav class="foot__links"[\s\S]*?<\/nav>/.exec(page)[0];
  assert.match(foot, /<a href="\.\.\/teams\/">Team gift<\/a>/);
  assert.match(foot, /<a href="\.\.\/contact\/">Ask a question<\/a>/);
  assert.match(page, /Help page explains every feature and shortcut, or <a href="\.\.\/contact\/">ask a question<\/a>\./);
  assert.doesNotMatch(page, /href="#(?:teams|request|team-prices|seats)"|data-request=/, 'no link to a part that moved');
  // Every in-page link points at something on the page, on both pages.
  for (const file of ['welcome/index.html', 'teams/index.html']) {
    const source = await read(file);
    const ids = new Set([...source.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]));
    for (const [, target] of source.matchAll(/<a [^>]*href="#([^"]+)"/g)) assert.ok(ids.has(target), `${file}: #${target}`);
    for (const [, target] of source.matchAll(/<use href="#([^"]+)"/g)) assert.ok(ids.has(target), `${file}: icon ${target}`);
  }
});

test('the privacy notice is the same on both pages, with 30 days for a partner code and the Teams page’s form', async () => {
  const dialog = (source, legal) => /<dialog class="pv"[\s\S]*?<\/dialog>/.exec(source)[0].replace(legal, 'LEGAL/');
  const landing = dialog(await read('welcome/index.html'), '../legal/');
  const teams = dialog(await read('teams/index.html'), '../legal/');
  assert.equal(teams, landing);
  assert.match(landing, /kept in this browser for <span data-partner-days>30<\/span> days/);
  assert.equal(PARTNER_PROGRAM.cookieDays, 30, 'the written fallback matches the program');
  assert.match(landing, /The Teams page’s request form sends what you type — [^<]*; a question, asked there or on the Contact page, only your email, name and question\./);
  assert.match(landing, /its code goes with the request too/);
  const dialogScript = await read('welcome/privacy-dialog.js');
  assert.match(dialogScript, /\[data-partner-days\]/);
  for (const file of ['welcome/landing.js', 'teams/teams.js']) assert.match(await read(file), /partnerDays: PARTNER_PROGRAM\.cookieDays/, file);
});

test('the Teams page script: entrances, FAQ, replica, counts', async () => {
  const teams = await read('teams/teams.js');
  for (const call of ['setupReveal({ motionOn, motionHooks })', 'setupFaq()', 'setupScenes({ scripts: SCRIPTS, motionOn, motionHooks })', "html.classList.add('js-ready')", "track('teams_viewed')", 'followMotion(motionHooks)']) assert.ok(teams.includes(call), call);
  assert.match(teams, /gift: \{\s*length: 9200,\s*loop: true/, 'the gift scene plays here');
  // The landing page keeps only what it shows.
  const landing = await read('welcome/landing.js');
  for (const gone of ['renderTiers', 'setupRequest', 'managerEmail', 'TIMING_LABELS', 'createListbox', 'createStepper', 'gift: {', 'function createScene', "'teams_viewed'"]) assert.ok(!landing.includes(gone), `landing.js: ${gone}`);
  assert.match(landing, /setupScenes\(\{ scripts: SCRIPTS, motionOn, motionHooks \}\)/);
  assert.match(landing, /track\('landing_cta_teams'\)/);
  // The CSS the moved markup used is gone where nothing uses it any more.
  const css = await read('welcome/landing.css');
  for (const gone of ['.pricing__teams', '.seats__head', '.seats__grid', '.team-form__head h3', '.prices__head h3']) assert.ok(!css.includes(gone), `landing.css: ${gone}`);
});

test('the gift page sends questions to the Contact page', async () => {
  const page = await read('welcome/thanks/index.html');
  assert.doesNotMatch(page, /href="\.\.\/\?ask=|href="\.\.\/#teams"|ask=question/);
  assert.equal((page.match(/href="\.\.\/\.\.\/contact\/"/g) || []).length, 2);
  assert.equal((page.match(/href="\.\.\/\.\.\/teams\/"/g) || []).length, 2);
});

test('the Teams page is /teams/; its old address redirects there (tests/redirects.test.js)', async () => {
  const lines = (await read('_redirects')).split('\n').map(line => line.trim());
  for (const line of ['/welcome/teams /teams/ 301', '/welcome/teams/* /teams/:splat 301']) assert.ok(lines.includes(line), line);
  assert.ok(!lines.some(line => /^\/teams\/?\s/.test(line)), '/teams/ is the page itself, not a short link any more');
  assert.match(await read('_headers'), /\n\/teams\/\n {2}Cache-Control: no-cache\n/);
  assert.match(await read('_headers'), /\n\/welcome\/teams\/\*\n {2}Cache-Control: no-store\n/, 'the old address’s redirect is never kept (tests/cache-headers.test.js)');
  assert.match(await read('_headers'), /\n\/welcome\/teams\/\n {2}Clear-Site-Data: "cache"\n/, 'and the address 1.28 redirected to clears a kept one');
  assert.equal(TEAM_ROWS.length, TEAM_TIERS.length + 1);
});
