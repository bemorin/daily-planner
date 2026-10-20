import { planRow } from './landing-model.js';

/**
 * Pure helpers for the Teams page (/welcome/teams/) and the links that lead
 * to it: the request form's kinds and what an address asks of it, the body
 * sent to POST /api/teams, the manager email and the old /welcome/ addresses
 * of the team gift. No DOM here, so tests can import it directly.
 */

export const TIMING_LABELS = Object.freeze({
  'december-2026': 'Before the holidays (December 2026)',
  'january-2027': 'January 2027',
  'q1-2027': 'Later in Q1 2027',
  later: 'Later'
});

/** Number of people a request may name (the server's own range). */
export const PEOPLE_RANGE = Object.freeze({ min: 2, max: 100000 });

export const KINDS = Object.freeze({
  invoice: Object.freeze({ label: 'Invoice', title: 'Get it by invoice', intro: 'Tell us where to send the invoice. You’ll get it by email, then the gift link once it’s paid.', submit: 'Request the invoice', done: 'Thanks, your request is in. The invoice will follow by email' }),
  quote: Object.freeze({ label: 'Quote', title: 'Ask for a quote', intro: 'Tell us about your organisation, and you’ll get a quote by email.', submit: 'Ask for a quote', done: 'Thanks, your request is in. The quote will follow by email' }),
  question: Object.freeze({ label: 'Question', title: 'Ask a question', intro: 'Ask anything about the planner, Plus or the team gift. You’ll get a reply by email.', submit: 'Send the question', done: 'Thanks, your question is in. You’ll get a reply by email' }),
  talk: Object.freeze({ label: 'Remote talk', title: 'Ask about the talk', intro: 'Tell us about your team and when a remote talk would help. You’ll get a reply by email.', submit: 'Send the request', done: 'Thanks, your message is in. You’ll get a reply by email' })
});

/**
 * A question about the partner program (?ask=question&topic=partners, from the
 * partners page while its Creem sign-up link isn't set): the same form, its
 * own title and a first line.
 */
export const PARTNER_QUESTION = Object.freeze({ title: 'Ask about the partner program', intro: 'Tell us who you are and who you’d recommend Daily Planner to. You’ll get a reply by email.', message: 'Partner program: ' });

const params = search => {
  try { return new URLSearchParams(search || ''); } catch (_) { return new URLSearchParams(); }
};

/**
 * What an address asks the request form for: ?ask=invoice|quote|question
 * (|talk while the talk is offered), ?plan=<a team tier> and ?topic=partners
 * (a question about the program). Anything unknown is dropped: `kind` and
 * `plan` are '' when nothing valid was asked.
 */
export function requestFromAddress(search, { talk = false } = {}) {
  const query = params(search);
  const ask = query.get('ask') || '';
  const kind = Object.keys(KINDS).includes(ask) && (ask !== 'talk' || talk) ? ask : '';
  const plan = planRow(query.get('plan') || '') ? query.get('plan') : '';
  const topic = kind === 'question' && query.get('topic') === 'partners' ? 'partners' : '';
  return { kind, plan, topic };
}

/** The body sent to POST /api/teams: the form's values, and the remembered partner code (`ref`) when there is one. */
export function requestPayload(values, { currency = '', version = '', locale = '', ref = '' } = {}) {
  const code = typeof ref === 'string' && /^[A-Za-z0-9_-]{2,64}$/.test(ref) ? ref : '';
  return {
    email: values.email,
    name: values.name,
    company: values.company,
    teamSize: Number.parseInt(values.teamSize, 10),
    timing: values.timing,
    message: values.message,
    consent: true,
    website: values.website,
    version,
    locale,
    source: 'landing',
    plan: values.plan,
    currency,
    kind: values.kind,
    ...(code ? { ref: code } : {})
  };
}

/** “Send this to my manager”: the email's body, with the Teams page's address and the lowest price per person. */
export const managerMessage = (template, { url, perPerson }) => String(template || '').replaceAll('{url}', url).replaceAll('{perPerson}', perPerson);

/** The FAQ's “Can we pay by invoice?”, as the team gift is sold here: online too, or by invoice only. */
export const invoiceAnswer = buyable => (buyable
  ? 'Yes, or by card. “Buy” opens a secure checkout run by Creem, our payment partner; you land on your gift page as soon as it’s paid, and its link arrives by email. “Invoice” sends a request instead: you receive an invoice to pay by bank transfer, then the gift link once it’s paid. Either way it’s one payment, with no subscription.'
  : 'Yes. Choose a team size and send the request: you’ll receive an invoice to pay by bank transfer, then the gift link once it’s paid. It’s one payment, with no subscription.');

// The team gift's old addresses on /welcome/ (before the Teams page).
const TEAM_HASHES = new Set(['#request', '#teams', '#team-prices', '#seats']);

/**
 * Where an old /welcome/ address about the team gift now lives: a request
 * (?ask=…) or one of the team gift's parts (#request, #teams, #team-prices,
 * #seats) goes to the Teams page, with the same query and hash. `path` is the
 * welcome page's own path (/welcome/, /welcome/index.html or /welcome).
 * '' when the address is the landing page's own.
 */
export function teamsAddress({ path = '/welcome/', search = '', hash = '' } = {}) {
  if (!params(search).has('ask') && !TEAM_HASHES.has(hash)) return '';
  return `${String(path).replace(/\/(?:index\.html)?$/, '')}/teams/${search}${hash}`;
}
