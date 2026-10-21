// The dashboard's “Requests and questions” card, from the summary's team
// requests (POST /api/teams). An invoice, a quote or a talk names its company,
// team size, plan, currency and timing; a question (the “Ask a question”
// form) has none of them, and reads as one: “Question”, who asked and the
// question, with a dash where a team's details would be — never “0 people”
// or an empty company. Questions from before 1.29.1 that named a team still
// read like a request. Pure: it returns HTML (every value escaped) and is
// unit-tested (tests/admin-requests.test.js); admin.js wires Delete.

import { requestPartnerHtml } from './partners-view.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
// A reply link only for plain addresses: nothing that could add ?bcc= or a body to the draft.
const mailLink = email => (/^[^\s?&=%/#@]+@[a-z0-9.-]+$/i.test(String(email || '')) ? `<a href="mailto:${esc(email)}">${esc(email)}</a>` : `<span>${esc(email)}</span>`);
const defaultNumber = value => new Intl.NumberFormat('en-US').format(Number(value) || 0);
const DASH = '—';

export const TIMING_LABELS = Object.freeze({ 'december-2026': 'December 2026', 'january-2027': 'January 2027', 'q1-2027': 'Q1 2027', later: 'Later' });
export const PLAN_LABELS = Object.freeze({ 'up-to-10': 'Up to 10 people', 'up-to-50': 'Up to 50 people', 'up-to-100': 'Up to 100 people', 'up-to-500': 'Up to 500 people', 'up-to-1000': 'Up to 1,000 people', 'over-1000': 'Over 1,000 people' });
export const KIND_LABELS = Object.freeze({ invoice: 'Invoice', quote: 'Quote', talk: 'Talk', question: 'Question' });
export const REQUEST_SOURCES = Object.freeze({ landing: 'Welcome page', teams: 'Teams page', app: 'Planner' });

/** A question with no team: no company, no number of people (as server/planner-api.js stores one). */
export const isPlainQuestion = row => row?.kind === 'question' && !String(row.company || '').trim() && !(Number(row.teamSize) > 0);

const COLUMNS = ['Date', 'Company', 'Team size', 'Plan', 'Currency', 'Request', 'Timing', 'Name', 'Email', 'Message', 'Source', ''];

/**
 * One row of the table. `codeChecks` says which partner codes are confirmed
 * or rejected (summary.partners.codeChecks), `teamRate` is the team share;
 * `when` and `number` format a date and a count.
 */
export function teamRequestRowHtml(row, { codeChecks = {}, teamRate, when = iso => String(iso || ''), number = defaultNumber } = {}) {
  const question = isPlainQuestion(row);
  const team = (html, cls = '') => `<td${cls ? ` class="${cls}"` : ''}>${question ? DASH : html}</td>`;
  return `<tr data-owner-attn="team:${Number(row.id)}">${[
    `<td class="owner-nowrap">${esc(when(row.createdAt))}</td>`,
    team(`<b>${esc(row.company)}</b>`),
    team(number(row.teamSize), 'num'),
    team(esc(PLAN_LABELS[row.plan] || row.plan || DASH), 'owner-nowrap'),
    team(esc(row.currency || DASH)),
    `<td>${question ? `<b>${esc(KIND_LABELS.question)}</b>` : esc(KIND_LABELS[row.kind] || row.kind || DASH)}</td>`,
    team(esc(TIMING_LABELS[row.timing] || row.timing || DASH), 'owner-nowrap'),
    `<td>${esc(row.name || DASH)}</td>`,
    `<td>${mailLink(row.email)}</td>`,
    `<td class="owner-message">${requestPartnerHtml(row.ref, codeChecks[row.ref] || '', teamRate)}${esc(row.message || '')}</td>`,
    `<td>${esc(REQUEST_SOURCES[row.source] || row.source || '')}</td>`,
    `<td><button class="text-button text-button--danger" type="button" data-owner-delete-team="${Number(row.id)}">Delete</button></td>`
  ].join('')}</tr>`;
}

/** The whole table, or '' when there is nothing to list. */
export function teamRequestsTableHtml(rows, options = {}) {
  if (!Array.isArray(rows) || !rows.length) return '';
  const head = COLUMNS.map(label => `<th${label === 'Team size' ? ' class="num"' : ''}>${esc(label)}</th>`).join('');
  return `<div class="owner-scroll"><table class="owner-table"><thead><tr>${head}</tr></thead><tbody>${rows.map(row => teamRequestRowHtml(row, options)).join('')}</tbody></table></div>`;
}
