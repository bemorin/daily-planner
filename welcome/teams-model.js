import { planRow } from './landing-model.js';

/**
 * Pure helpers for the Teams page (/teams/) and the links that lead
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

// The panel's kicker for a team request (an invoice, a quote, a talk).
const TEAM_KICKER = 'Invoice, quote or question';

/**
 * What the form can be for. `team`: an invoice, a quote or a talk is about a
 * team gift, and asks for the company, the plan, the number of people and
 * when to send it; a question is anyone's (about the planner, Plus, a
 * purchase, the partner program or the team gift), and asks only for an
 * email, a name and the question. `kicker`, `title` and `intro` head the
 * panel; `again` is the button after sending.
 */
export const KINDS = Object.freeze({
  invoice: Object.freeze({ label: 'Invoice', team: true, kicker: TEAM_KICKER, title: 'Get it by invoice', intro: 'Tell us where to send the invoice. You’ll get it by email, then the gift link once it’s paid.', submit: 'Request the invoice', done: 'Thanks, your request is in. The invoice will follow by email', again: 'Send another request' }),
  quote: Object.freeze({ label: 'Quote', team: true, kicker: TEAM_KICKER, title: 'Ask for a quote', intro: 'Tell us about your organisation, and you’ll get a quote by email.', submit: 'Ask for a quote', done: 'Thanks, your request is in. The quote will follow by email', again: 'Send another request' }),
  question: Object.freeze({ label: 'Question', team: false, kicker: 'Contact', title: 'Ask a question', intro: 'Anything about the planner, Plus, a purchase, the partner program or the team gift.', submit: 'Send the question', done: 'Thanks, your question is in. You’ll get a reply by email', again: 'Ask another question' }),
  talk: Object.freeze({ label: 'Remote talk', team: true, kicker: TEAM_KICKER, title: 'Ask about the talk', intro: 'Tell us about your team and when a remote talk would help. You’ll get a reply by email.', submit: 'Send the request', done: 'Thanks, your message is in. You’ll get a reply by email', again: 'Send another request' })
});

/** Whether a kind of request is about a team gift (and asks for its fields): every kind but a question. */
export const isTeamKind = kind => KINDS[kind]?.team !== false;

/**
 * The email field: a work address for a team request, any address for a
 * question (`label`, `placeholder`, and what to say when it is empty).
 */
export const EMAIL_FIELD = Object.freeze({
  team: Object.freeze({ label: 'Work email', placeholder: 'you@company.com', missing: 'Enter your work email.', consent: 'You may email me about this request.' }),
  question: Object.freeze({ label: 'Email', placeholder: 'you@example.com', missing: 'Enter your email.', consent: 'You may email me about this question.' })
});

/** The email field's words for a kind of request. */
export const emailField = kind => (isTeamKind(kind) ? EMAIL_FIELD.team : EMAIL_FIELD.question);

/**
 * A question about the partner program (?ask=question&topic=partners, from the
 * partners page while its Creem sign-up link isn't set): the same question
 * form, its own title and a first line.
 */
export const PARTNER_QUESTION = Object.freeze({ title: 'Ask about the partner program', intro: 'Tell us who you are and who you’d recommend Daily Planner to. You’ll get a reply by email.', message: 'Partner program: ' });

/** What heads the panel for a kind (and topic): its kicker, title and intro; the partner program's own title and intro. */
export const requestCopy = (kind, topic = '') => {
  const copy = KINDS[kind] || KINDS.invoice;
  return kind === 'question' && topic === 'partners' ? { ...copy, title: PARTNER_QUESTION.title, intro: PARTNER_QUESTION.intro } : copy;
};

const params = search => {
  try { return new URLSearchParams(search || ''); } catch (_) { return new URLSearchParams(); }
};

/**
 * What an address asks the request form for: ?ask=invoice|quote|question
 * (|talk while the talk is offered), ?plan=<a team tier> and ?topic=partners
 * (a question about the program). Anything unknown is dropped: `kind` and
 * `plan` are '' when nothing valid was asked; a question has no plan.
 */
export function requestFromAddress(search, { talk = false } = {}) {
  const query = params(search);
  const ask = query.get('ask') || '';
  const kind = Object.keys(KINDS).includes(ask) && (ask !== 'talk' || talk) ? ask : '';
  const plan = kind !== 'question' && planRow(query.get('plan') || '') ? query.get('plan') : '';
  const topic = kind === 'question' && query.get('topic') === 'partners' ? 'partners' : '';
  return { kind, plan, topic };
}

const partnerCode = ref => (typeof ref === 'string' && /^[A-Za-z0-9_-]{2,64}$/.test(ref) ? ref : '');

/**
 * The body sent to POST /api/teams: the form's values, and the remembered
 * partner code (`ref`) when there is one. A question sends no team fields
 * (company, number of people, timing, plan, currency).
 */
export function requestPayload(values, { currency = '', version = '', locale = '', ref = '' } = {}) {
  const code = partnerCode(ref);
  const team = isTeamKind(values.kind)
    ? { company: values.company, teamSize: Number.parseInt(values.teamSize, 10), timing: values.timing }
    : {};
  return {
    email: values.email,
    name: values.name,
    ...team,
    message: values.message,
    consent: true,
    website: values.website,
    version,
    locale,
    source: 'teams',
    ...(isTeamKind(values.kind) ? { plan: values.plan, currency } : {}),
    kind: values.kind,
    ...(code ? { ref: code } : {})
  };
}

/**
 * The request as an email, when the site has no API but a contact address
 * (LANDING.contactEmail): its subject and its lines. `plan` is the plan as
 * the form shows it (“Team gift, up to 50 people (€595)”), `timing` the
 * timing's words; a question has neither, only who asks and the question.
 */
export function requestEmail(values, { plan = '', timing = '', ref = '' } = {}) {
  const label = KINDS[values.kind]?.label || values.kind;
  const code = partnerCode(ref);
  const team = isTeamKind(values.kind);
  const lines = [
    `Request: ${label}`,
    ...(team ? [`Plan: ${plan}`, `Number of people: ${values.teamSize}`, `Timing: ${timing}`, `Company: ${values.company}`] : []),
    `Name: ${values.name}`,
    `Email: ${values.email}`,
    ...(code ? [`Partner code: ${code}`] : []),
    ...(values.message ? ['', values.message] : [])
  ];
  const subject = team ? `Daily Planner team gift — ${label}: ${values.company}` : `Daily Planner — Question from ${values.name}`;
  return { subject, lines };
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
 * welcome page's own path (/welcome/, /welcome/index.html or /welcome); the
 * Teams page is its neighbour, /teams/ (1.30; /welcome/teams/ before).
 * '' when the address is the landing page's own.
 */
export function teamsAddress({ path = '/welcome/', search = '', hash = '' } = {}) {
  if (!params(search).has('ask') && !TEAM_HASHES.has(hash)) return '';
  const site = String(path).replace(/\/(?:index\.html)?$/, '').replace(/\/[^/]*$/, '');
  return `${site}/teams/${search}${hash}`;
}
