import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateTeamRequest } from '../server/planner-api.js';
import { CONSENT, KINDS, consentLabel, requestPayload } from '../welcome/teams-model.js';

/*
 * 1.33: the Contact and Teams forms ask again for a box to be ticked before a
 * request goes to the API, with a label that says what it agrees to (1.32 had
 * removed it; the old label, “You may email me about this question.”, said
 * nothing). The server requires it for every kind; the privacy policy names
 * that consent as the legal basis.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFile(join(root, file), 'utf8');
const text = html => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

test('the box says what it agrees to, by kind, and links the privacy policy', () => {
  assert.deepEqual(Object.fromEntries(Object.keys(KINDS).map(kind => [kind, consentLabel(kind)])), {
    invoice: 'I agree that my details are used to reply to me and to prepare my invoice, as explained in the privacy policy.',
    quote: 'I agree that my details are used to reply to me and to prepare my quote, as explained in the privacy policy.',
    question: 'I agree that my email address and question are used to reply to me, as explained in the privacy policy.',
    talk: 'I agree that my details are used to reply to me about the talk, as explained in the privacy policy.'
  });
  assert.equal(consentLabel('nope'), consentLabel('invoice'), 'an unknown kind reads as the invoice, like its head');
  assert.equal(CONSENT.missing, 'Tick the box so we can reply to you.');
  for (const kind of Object.keys(KINDS)) assert.doesNotMatch(consentLabel(kind), /You may email me/, kind);
});

test('the request carries the box exactly: true once ticked, false otherwise', () => {
  const values = { email: 'ann@example.com', name: 'Ann', company: 'Acme', plan: 'up-to-50', teamSize: '40', timing: 'later', message: '', website: '', kind: 'invoice' };
  assert.equal(requestPayload({ ...values, consent: true }).consent, true);
  for (const consent of [false, undefined, 'on', 1]) assert.equal(requestPayload({ ...values, consent }).consent, false, String(consent));
  for (const kind of Object.keys(KINDS)) assert.equal(requestPayload({ ...values, kind, consent: true }).consent, true, kind);
});

test('the server refuses every kind of request without the box, with words that say why', () => {
  const now = new Date('2026-10-22T09:00:00Z');
  const team = { email: 'lead@acme.example', name: 'Ada', company: 'Acme', teamSize: 25, timing: 'later', message: '', website: '' };
  const bodies = {
    invoice: { ...team, kind: 'invoice', plan: 'up-to-50', currency: 'EUR' },
    quote: { ...team, kind: 'quote' },
    talk: { ...team, kind: 'talk' },
    question: { email: 'ann@example.com', name: 'Ann', message: 'Hello?', kind: 'question', source: 'contact' }
  };
  for (const [kind, body] of Object.entries(bodies)) {
    assert.ok(validateTeamRequest({ ...body, consent: true }, now).entry, `${kind}: ticked`);
    for (const consent of [undefined, false, 'true', 'on', 1]) {
      assert.equal(validateTeamRequest({ ...body, consent }, now).error, 'Please tick the box so we can use your details to reply to you.', `${kind}: ${String(consent)}`);
    }
  }
  assert.equal(validateTeamRequest({ ...bodies.question, website: 'bot' }, now).spam, true, 'a bot is still dropped quietly');
});

test('both forms: a required box, the kind’s words, an error line it points to, shown only when it goes to the API', async () => {
  const pages = { 'contact/index.html': 'question', 'teams/index.html': 'invoice' };
  for (const [file, kind] of Object.entries(pages)) {
    const page = await read(file);
    const row = /<label class="consent"[\s\S]*?<\/label>/.exec(page)?.[0] || '';
    assert.match(row, /^<label class="consent" data-consent-row hidden><input type="checkbox" name="consent" required aria-describedby="err-consent">/, file);
    assert.ok(row.includes(`<span data-consent-use>${KINDS[kind].consent}</span>`), `${file}: the first kind’s words, as the script writes them`);
    assert.ok(row.includes(`<a href="../legal/privacy/#requests">${CONSENT.link}</a>${CONSENT.end}`), `${file}: the policy’s requests section`);
    assert.equal(text(row), consentLabel(kind), `${file}: the label as read`);
    assert.match(page, /<\/label>\n {16}<small class="field__err field__err--consent" id="err-consent"><\/small>\n {16}<p class="form-privacy" data-privacy-line hidden>/, `${file}: the error, then the note`);
    // The note says what is kept and for how long, not the box's words again.
    const note = /<p class="form-privacy" data-privacy-line hidden>([\s\S]*?)<\/p>/.exec(page)[1];
    assert.match(note, /^What you send is kept to follow up on it, and deleted whenever you ask\./, file);
    assert.doesNotMatch(text(note), /reply|agree|privacy policy/i, `${file}: no repeat of the label`);
  }
  const script = await read('welcome/request-form.js');
  assert.match(script, /consent: data\.get\('consent'\) === 'on',/);
  assert.match(script, /\['consent', requestMode !== 'api' \|\| values\.consent \? '' : CONSENT\.missing\]/, 'checked last, only when it goes to the API');
  assert.match(script, /const invalid = validate\(form, values, requestMode\);\n {4}if \(invalid\) \{ invalid\.focus\(\); return; \}/, 'the focus goes to the box when it is the first thing missing');
  assert.match(script, /consentRow\.hidden = requestMode !== 'api';\n {2}field\('consent'\)\.required = requestMode === 'api';/, 'as an email, the visitor sends it themselves: no box');
  assert.match(script, /consentUse\.textContent = copy\.consent;/, 'the words follow the kind');
  assert.match(script, /field\('consent'\)\.checked = false;/, 'another request asks again');
  assert.doesNotMatch(script, /consent[^\n]*checked = true/, 'never ticked for the visitor');
});

test('the box is the app’s own checkbox, on the form’s tokens, in both themes and in high contrast', async () => {
  const css = await read('welcome/landing.css');
  const part = css.slice(css.indexOf('.consent {'), css.indexOf('.form-privacy {'));
  assert.match(part, /\.consent \{ display: grid; grid-template-columns: 22px minmax\(0, 1fr\);/);
  assert.match(part, /\.consent input \{[^}]*width: 22px;[^}]*height: 22px;[^}]*background: var\(--band-field\);[^}]*appearance: none;/);
  assert.match(part, /\.consent input:checked \{ border-color: var\(--band-ink\); background: var\(--band-ink\); \}/);
  assert.match(part, /\.consent input:focus-visible \{ outline: 2\.5px solid var\(--band-accent\); outline-offset: 2px; \}/);
  assert.match(part, /\.consent input\[aria-invalid="true"\] \{ border-color: var\(--band-error\);/);
  assert.match(part, /@media \(prefers-reduced-motion: no-preference\) \{\n {2}\.consent input \{ transition:/, 'it only fades when motion is welcome');
  assert.match(part, /@media \(forced-colors: active\) \{\n {2}\.consent input \{ -webkit-appearance: auto; appearance: auto; \}/);
  assert.match(css, /\.consent:not\(\[hidden\]\) ~ \.form-privacy \{ padding-left: 34px; \}/, 'the note lines up with the label’s words');
  assert.doesNotMatch(part, /!important/);
  // The Contact page's card gives the band's tokens its own colours, so the box follows them.
  assert.match(await read('contact/contact.css'), /\.ct__card \{\n {2}--band-bg: var\(--surface-strong\);\n {2}--band-ink: var\(--ink\);/);
});

test('the privacy policy: requests are made with consent, given with the box, withdrawn by asking us to delete them', async () => {
  const page = await read('legal/privacy/index.html');
  const requests = /<section id="requests"[\s\S]*?<\/section>/.exec(page)[0];
  assert.ok(text(requests).includes('Before you send a request or a question, you tick a box to agree that what you send is used to reply to you and, for an invoice or a quote, to prepare it. We use it for nothing else. We receive an email notification with it, and keep it to reply and follow up. You can withdraw your agreement at any time by asking us to delete it.'));
  assert.doesNotMatch(page, /no box to tick/);
  const row = /<tr><th scope="row">Team requests and questions<\/th>[\s\S]*?<\/tr>/.exec(page)[0];
  assert.match(row, /<td data-label="Why we may use it">Your consent, given with the box you tick before sending, which you can withdraw at any time by asking us to delete your request\. For an invoice or a quote, also the steps you ask us to take before an order\.<\/td>/);
  assert.match(row, /<td data-label="How long">Kept to reply and follow up; deleted on request\.<\/td>/);
  assert.match(page, /<li>stop using it where you gave your consent \(the waitlist, a request or a question, a quoted review\), at any time\.<\/li>/);
  assert.match(page, /Last updated: <time datetime="2026-10-22">22 October 2026<\/time>/);
});

test('the privacy dialogs say the same about requests, on the welcome and Teams pages', async () => {
  const parts = [];
  for (const file of ['welcome/index.html', 'teams/index.html']) {
    const part = /<section class="pv__sec" data-privacy-section="requests"[\s\S]*?<\/section>/.exec(await read(file))[0];
    assert.ok(text(part).includes('By ticking the box before sending, you agree that it’s used to reply to you and, for an invoice or a quote, to prepare it. It’s stored with your browser’s language, the page version and where the form was opened, and deleted whenever you ask.'), file);
    assert.doesNotMatch(part, /stored only to reply to you/, file);
    parts.push(/<p>The Teams page’s request form[\s\S]*?<\/p>/.exec(part)[0]);
  }
  assert.equal(parts[0], parts[1]);
});
