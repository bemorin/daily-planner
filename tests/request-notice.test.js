import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMemoryStore, createPlannerApi, validateTeamRequest } from '../server/planner-api.js';
import { KINDS, requestPayload } from '../welcome/teams-model.js';

/*
 * 1.33.1: no box to tick on the Contact and Teams forms, whatever the kind
 * (invoice, quote, question, talk), as in 1.32. For a form people send to be
 * answered, an information notice is what is owed, not consent (1.33.0 had put
 * a required box back). Under each form, one short notice says what is kept,
 * why, for how long and that it is deleted on request, and links the privacy
 * policy's requests section. The server no longer asks for `consent` (and
 * ignores it from a cached 1.33.0 page); the privacy policy and the privacy
 * dialogs name the basis again: replying to what was asked.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFile(join(root, file), 'utf8');
const text = html => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

const NOTICE = 'What you send is kept only to reply to you and follow up, and deleted whenever you ask.';
const FORMS = {
  'contact/index.html': { form: /<form class="team-form ct-form"[\s\S]*?<\/form>/, link: '<a href="../legal/privacy/#requests">How questions are handled</a>' },
  'teams/index.html': { form: /<form class="team-form"[\s\S]*?<\/form>/, link: '<a href="../legal/privacy/#requests" data-privacy-open="requests">How requests are handled</a>' }
};

test('neither form has a box to tick, in any mode', async () => {
  for (const [file, { form: pattern }] of Object.entries(FORMS)) {
    const page = await read(file);
    const form = pattern.exec(page)?.[0] || '';
    assert.ok(form, file);
    assert.doesNotMatch(form, /consent|type="checkbox"|I agree/i, `${file}: no box, no label, no error line for it`);
    assert.doesNotMatch(page, /data-consent|err-consent/, file);
  }
  assert.doesNotMatch(await read('welcome/request-form.js'), /consent/i, 'nothing to tick, read or check');
  assert.doesNotMatch(await read('welcome/teams-model.js'), /consent:|\.consent|CONSENT/, 'nothing to send or say about a box');
});

test('under each form, one information notice: what is kept, why, for how long, deleted on request, and the policy’s requests section', async () => {
  for (const [file, { form: pattern, link }] of Object.entries(FORMS)) {
    const form = pattern.exec(await read(file))[0];
    const notices = [...form.matchAll(/<p class="form-privacy" data-privacy-line hidden>([\s\S]*?)<\/p>/g)].map(match => match[1]);
    assert.equal(notices.length, 1, `${file}: one notice`);
    assert.equal(notices[0], `${NOTICE} ${link}`, file);
    // It reads on its own: no reference to a box, an agreement or a label above it.
    assert.doesNotMatch(text(notices[0]), /box|tick|agree|consent|above/i, file);
  }
  // Shown when the form goes to the API (as an email, the visitor sends it themselves, and the mailto line says so).
  const script = await read('welcome/request-form.js');
  assert.match(script, /qs\('\[data-privacy-line\]', form\)\.hidden = requestMode !== 'api';/);
  assert.match(script, /if \(mailtoLine\) mailtoLine\.hidden = requestMode !== 'mailto';/);
  // On the Teams page, the link opens the Requests part of the page's own privacy dialog (welcome/privacy-dialog.js), so a
  // half-filled form stays where it is; without it, it goes to the policy's requests section.
  assert.match(await read('welcome/privacy-dialog.js'), /event\.target\.closest\('\[data-privacy-open\], a\[href="#privacy"\]'\)/);
  assert.match(await read('legal/privacy/index.html'), /<section id="requests" aria-labelledby="requests-title">/);
  // The Contact page's link keeps to one line.
  assert.match(await read('contact/contact.css'), /\.ct-form \.form-privacy a \{ color: var\(--ink\); white-space: nowrap; \}/);
});

test('a request never carries `consent`, whatever the kind', () => {
  const values = { email: 'ann@example.com', name: 'Ann', company: 'Acme', plan: 'up-to-50', teamSize: '40', timing: 'later', message: 'Hello?', website: '' };
  for (const kind of Object.keys(KINDS)) {
    assert.equal('consent' in requestPayload({ ...values, kind }), false, kind);
    assert.equal('consent' in requestPayload({ ...values, kind, consent: true }), false, `${kind}: even if something set it`);
  }
});

test('the server takes every kind without `consent`, ignores it from a cached 1.33.0 page, and never stores it', async () => {
  const now = new Date('2026-10-22T09:00:00Z');
  const team = { email: 'lead@acme.example', name: 'Ada', company: 'Acme', teamSize: 25, timing: 'later', message: '', website: '' };
  const bodies = {
    invoice: { ...team, kind: 'invoice', plan: 'up-to-50', currency: 'EUR' },
    quote: { ...team, kind: 'quote' },
    talk: { ...team, kind: 'talk' },
    question: { email: 'ann@example.com', name: 'Ann', message: 'Hello?', kind: 'question', source: 'contact' }
  };
  for (const [kind, body] of Object.entries(bodies)) {
    const { entry, error } = validateTeamRequest(body, now);
    assert.equal(error, undefined, kind);
    assert.equal(entry.kind, kind);
    assert.equal('consent' in entry, false, `${kind}: never stored`);
    for (const consent of [true, false, 'on', 1]) assert.deepEqual(validateTeamRequest({ ...body, consent }, now).entry, entry, `${kind}: consent ${String(consent)} is ignored`);
  }
  assert.equal(validateTeamRequest({ ...bodies.question, website: 'bot' }, now).spam, true, 'a bot is still dropped quietly');
  // The 1.33.0 refusal is gone entirely: no code path asks for the box.
  const server = await read('server/planner-api.js');
  assert.doesNotMatch(server, /tick the box so we can use your details/i);
  assert.doesNotMatch(server, /don’t see the box/);

  // Through the route: sent, listed for the owner, without a consent field.
  const api = createPlannerApi({ store: createMemoryStore(), adminToken: 'secret', now: () => now });
  const post = body => new Request('https://planner.test/api/teams', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  for (const body of Object.values(bodies)) assert.equal((await api(post(body))).status, 201, body.kind);
  assert.equal((await api(post({ ...bodies.question, email: 'old@example.com', consent: true }))).status, 201, 'a cached 1.33.0 page');
  const { rows } = await (await api(new Request('https://planner.test/api/admin/teams', { headers: { authorization: 'Bearer secret' } }))).json();
  assert.equal(rows.length, 5);
  for (const row of rows) assert.equal('consent' in row, false, row.kind);
});

test('no checkbox style is left for the forms', async () => {
  const css = await read('welcome/landing.css');
  assert.doesNotMatch(css, /\.consent\b|field__err--consent/);
  assert.doesNotMatch(await read('contact/contact.css'), /consent/);
  assert.match(css, /\.team-form__fine \{ display: grid; align-content: center; justify-items: start; gap: 8px; min-width: 0; \}/);
  assert.match(css, /\.form-privacy \{ max-width: 54em; color: var\(--band-muted\); font-size: \.88rem; line-height: 1\.5; text-wrap: balance; \}/);
  // The notice's link never breaks in two (the Teams page's band; the Contact page's card says the same in contact.css).
  assert.match(css, /\.form-privacy a \{ color: var\(--band-ink\); text-underline-offset: 3px; white-space: nowrap; \}/);
});

test('the privacy policy: requests are answered on the basis of what was asked, with no box, and deleted on request', async () => {
  const page = await read('legal/privacy/index.html');
  const requests = /<section id="requests"[\s\S]*?<\/section>/.exec(page)[0];
  assert.ok(text(requests).includes('We use it only to answer your request, never to send you anything else, so there is no box to tick. We receive an email notification with your request, and keep it to reply and follow up. Ask, and we delete it.'));
  assert.doesNotMatch(page, /you tick a box|box you tick|withdraw your agreement/);
  const row = /<tr><th scope="row">Team requests and questions<\/th>[\s\S]*?<\/tr>/.exec(page)[0];
  assert.match(row, /<td data-label="Why we may use it">Replying to what you asked: steps you ask us to take before an order \(an invoice, a quote\), and our legitimate interest in answering a question\.<\/td>/);
  assert.match(row, /<td data-label="How long">Kept to reply and follow up; deleted on request\.<\/td>/);
  assert.match(page, /<li>stop using it where you gave your consent \(the waitlist, a quoted review\), at any time\.<\/li>/);
  // What 1.33 added about partner links stays.
  assert.match(page, /<tr><th scope="row">Visits through partner links<\/th>/);
  assert.match(page, /Your browser also tells us when you arrive through a partner’s link, at most once a day for each code/);
  assert.match(page, /Last updated: <time datetime="2026-10-22">22 October 2026<\/time>/);
});

test('the privacy dialogs say the same about requests, on the welcome and Teams pages', async () => {
  const parts = [];
  for (const file of ['welcome/index.html', 'teams/index.html']) {
    const part = /<section class="pv__sec" data-privacy-section="requests"[\s\S]*?<\/section>/.exec(await read(file))[0];
    assert.ok(text(part).includes('It’s stored only to reply to you and follow up, with your browser’s language, the page version and where the form was opened, and deleted whenever you ask.'), file);
    assert.doesNotMatch(part, /tick|agree/, file);
    parts.push(/<p>The Teams page’s request form[\s\S]*?<\/p>/.exec(part)[0]);
  }
  assert.equal(parts[0], parts[1]);
});
