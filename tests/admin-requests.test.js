import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { KIND_LABELS, isPlainQuestion, teamRequestRowHtml, teamRequestsTableHtml } from '../admin/requests-view.js';

const cells = html => [...html.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(match => match[1].replace(/<[^>]+>/g, ''));
const when = iso => `on ${iso.slice(0, 10)}`;
const question = { id: 7, createdAt: '2026-10-21T09:00:00Z', company: '', teamSize: 0, plan: '', currency: '', kind: 'question', timing: '', name: 'Ann', email: 'ann@example.com', message: 'Can I pay by invoice?', source: 'teams', ref: '' };
const invoice = { id: 8, createdAt: '2026-10-21T10:00:00Z', company: 'Acme <b>', teamSize: 40, plan: 'up-to-50', currency: 'EUR', kind: 'invoice', timing: 'january-2027', name: 'Jane', email: 'jane@acme.example', message: '', source: 'teams', ref: 'COACH_ANNA' };

test('a question reads as one: “Question”, who asked and the question, with a dash for every team detail', () => {
  assert.equal(isPlainQuestion(question), true);
  assert.deepEqual(cells(teamRequestRowHtml(question, { when })), ['on 2026-10-21', '—', '—', '—', '—', 'Question', '—', 'Ann', 'ann@example.com', 'Can I pay by invoice?', 'Teams page', 'Delete']);
  const html = teamRequestRowHtml(question, { when });
  assert.doesNotMatch(html, />0</, 'never “0 people”');
  assert.doesNotMatch(html, /<b><\/b>/, 'never an empty company');
  assert.match(html, /<td><b>Question<\/b><\/td>/);
  assert.match(html, /<a href="mailto:ann@example\.com">ann@example\.com<\/a>/);
  assert.match(html, /data-owner-attn="team:7"/);
  assert.match(html, /data-owner-delete-team="7"/);
});

test('an invoice, a quote or a talk shows its team as before, escaped, with its partner code', () => {
  const row = teamRequestRowHtml(invoice, { when, number: value => `n${value}`, teamRate: 10 });
  assert.deepEqual(cells(row).slice(0, 9), ['on 2026-10-21', 'Acme &lt;b&gt;', 'n40', 'Up to 50 people', 'EUR', 'Invoice', 'January 2027', 'Jane', 'jane@acme.example']);
  assert.match(row, /Partner: <code>COACH_ANNA<\/code> — 10% if this becomes an order/);
  // A question from before 1.29.1 that named a team still reads like a request.
  const older = { ...question, company: 'Globex', teamSize: 12, timing: 'later' };
  assert.equal(isPlainQuestion(older), false);
  assert.deepEqual(cells(teamRequestRowHtml(older, { when, number: String })).slice(1, 7), ['Globex', '12', '—', '—', 'Question', 'Later']);
  assert.equal(KIND_LABELS.question, 'Question');
});

test('the table has one header and a row per request; nothing to list is empty', () => {
  const html = teamRequestsTableHtml([question, invoice], { when });
  assert.equal((html.match(/<tr data-owner-attn=/g) || []).length, 2);
  assert.deepEqual([...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map(match => match[1]), ['Date', 'Company', 'Team size', 'Plan', 'Currency', 'Request', 'Timing', 'Name', 'Email', 'Message', 'Source', '']);
  assert.equal(teamRequestsTableHtml([]), '');
  assert.equal(teamRequestsTableHtml(undefined), '');
  // The dashboard renders it, reloads it with the other files, and names the card for both.
  const admin = readFileSync(new URL('../admin/admin.js', import.meta.url), 'utf8');
  assert.match(admin, /import \{ teamRequestsTableHtml \} from '\.\/requests-view\.js';/);
  assert.match(admin, /DASHBOARD_FILES = \[[^\]]*'\.\/requests-view\.js'/);
  const index = readFileSync(new URL('../admin/index.html', import.meta.url), 'utf8');
  assert.match(index, /<h2 id="owner-teams-title">Requests and questions<\/h2>/);
});
