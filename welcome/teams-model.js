import { planRow } from './landing-model.js';

/**
 * Pure helpers for the Teams page (/teams/), the Contact page (/contact/)
 * and the links that lead to them: the request form's kinds and what an
 * address asks of it, the body sent to POST /api/teams, the manager email
 * and the old addresses of the team gift and of the question form. No DOM
 * here, so tests can import it directly.
 */

export const TIMING_LABELS = Object.freeze({
  'december-2026': 'Before the holidays (December 2026)',
  'january-2027': 'January 2027',
  'q1-2027': 'Later in Q1 2027',
  later: 'Later'
});

/** Number of people a request may name (the server's own range). */
export const PEOPLE_RANGE = Object.freeze({ min: 2, max: 100000 });

// The panel's kicker on the Teams page, whatever the kind.
const TEAM_KICKER = 'Invoice, quote or question';

/**
 * What the Teams page's form can be for. `team`: an invoice, a quote or a
 * talk is about a team gift, and asks for the company, the plan, the number
 * of people and when to send it; a question (about the team gift, there)
 * asks only for an email, a name and the question. `kicker`, `title` and
 * `intro` head the panel; `again` is the button after sending. Anyone's
 * question, about anything, is the Contact page's (CONTACT_TOPICS).
 */
export const KINDS = Object.freeze({
  invoice: Object.freeze({ label: 'Invoice', team: true, kicker: TEAM_KICKER, title: 'Get it by invoice', intro: 'Tell us where to send the invoice. You’ll get it by email, then the gift link once it’s paid.', submit: 'Request the invoice', done: 'Thanks, your request is in. The invoice will follow by email', again: 'Send another request' }),
  quote: Object.freeze({ label: 'Quote', team: true, kicker: TEAM_KICKER, title: 'Ask for a quote', intro: 'Tell us about your organisation, and you’ll get a quote by email.', submit: 'Ask for a quote', done: 'Thanks, your request is in. The quote will follow by email', again: 'Send another request' }),
  question: Object.freeze({ label: 'Question', team: false, kicker: TEAM_KICKER, title: 'Ask about the team gift', intro: 'Paying, seats, privacy or timing: anything about the team gift.', submit: 'Send the question', done: 'Thanks, your question is in. You’ll get a reply by email', again: 'Ask another question' }),
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

/** What heads the Teams page's panel for a kind: its kicker, title and intro. */
export const requestCopy = kind => KINDS[kind] || KINDS.invoice;

/**
 * The Contact page (/contact/): the question form alone, anyone's. Its head
 * (kicker, the page's title and intro) follows the topic: `general`, about
 * anything; `partners` (/contact/?topic=partners, behind “Become a partner”
 * while the Creem sign-up link isn't set, and “Ask a question” on the
 * partners page), about the partner program, the question starting with
 * `message`.
 */
export const CONTACT_TOPICS = Object.freeze({
  general: Object.freeze({ kicker: 'Contact', title: 'Ask a question', intro: 'Anything about the planner, Plus, a purchase or the partner program. You’ll get a reply by email.', message: '' }),
  partners: Object.freeze({ kicker: 'Partner program', title: 'Ask about the partner program', intro: 'Tell us who you are and who you’d recommend Daily Planner to. You’ll get a reply by email.', message: 'Partner program: ' })
});

/**
 * Where the Contact page's questions say they come from (`source`, POST
 * /api/teams). The server keeps 'landing', 'teams' and 'app'
 * (TEAM_SOURCES in server/planner-api.js) and stores anything else as
 * 'landing': until it accepts 'contact', a question from the Contact page is
 * sent as the Teams page's, which is where the question form was.
 */
export const CONTACT_SOURCE = 'teams';

const params = search => {
  try { return new URLSearchParams(search || ''); } catch (_) { return new URLSearchParams(); }
};

/** The Contact page's topic for an address: `partners` for ?topic=partners, else `general`. */
export const contactTopic = search => (params(search).get('topic') === 'partners' ? 'partners' : 'general');

/**
 * What an address asks the Teams page's form for: ?ask=invoice|quote|question
 * (|talk while the talk is offered) and ?plan=<a team tier>. Anything unknown
 * is dropped: `kind` and `plan` are '' when nothing valid was asked; a
 * question has no plan. (An address asking a question goes to the Contact
 * page before the form reads it: contactAddress.)
 */
export function requestFromAddress(search, { talk = false } = {}) {
  const query = params(search);
  const ask = query.get('ask') || '';
  const kind = Object.keys(KINDS).includes(ask) && (ask !== 'talk' || talk) ? ask : '';
  const plan = kind !== 'question' && planRow(query.get('plan') || '') ? query.get('plan') : '';
  return { kind, plan };
}

const partnerCode = ref => (typeof ref === 'string' && /^[A-Za-z0-9_-]{2,64}$/.test(ref) ? ref : '');

/**
 * The body sent to POST /api/teams: the form's values, and the remembered
 * partner code (`ref`) when there is one. A question sends no team fields
 * (company, number of people, timing, plan, currency). `source`: the page
 * it was sent from, the Teams page unless said otherwise (CONTACT_SOURCE).
 */
export function requestPayload(values, { currency = '', version = '', locale = '', ref = '', source = 'teams' } = {}) {
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
    source,
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

/** The site's root as seen from a page one folder down: '' for /welcome/, /teams/ or /teams/index.html. */
const siteOf = path => String(path).replace(/\/(?:index\.html)?$/, '').replace(/\/[^/]*$/, '');

/**
 * Where an address asking for the question form (?ask=question) now leads:
 * the Contact page (1.31), next to the page's own folder (/teams/ or
 * /welcome/ → /contact/), with the rest of the query (?topic=partners, a
 * partner's ?ref=) but not ?ask or ?plan, and no #hash (#request was the
 * form on the Teams page). Until 1.31 every “Ask a question” link of the
 * site went to the Teams page's form (/teams/?ask=question#request, with
 * &topic=partners from the partners page; /welcome/teams/… and
 * /welcome/?ask=question before). '' for any other address. The inline
 * script in the <head> of /teams/ and /welcome/ does the same before first
 * paint.
 */
export function contactAddress({ path = '/teams/', search = '' } = {}) {
  const query = params(search);
  if (query.get('ask') !== 'question') return '';
  query.delete('ask');
  query.delete('plan');
  const rest = query.toString();
  return `${siteOf(path)}/contact/${rest ? `?${rest}` : ''}`;
}

/**
 * Where an old /welcome/ address now lives: a question (?ask=question) on
 * the Contact page (contactAddress); another request (?ask=…) or one of the
 * team gift's parts (#request, #teams, #team-prices, #seats) on the Teams
 * page, with the same query and hash; #teams was the whole team gift, which
 * is the Teams page itself, so it opens at the top (no hash: the page has no
 * #teams). `path` is the welcome page's own path (/welcome/,
 * /welcome/index.html or /welcome); the Teams page is its neighbour, /teams/
 * (1.30; /welcome/teams/ before), and so is the Contact page.
 * '' when the address is the landing page's own.
 */
export function movedAddress({ path = '/welcome/', search = '', hash = '' } = {}) {
  const contact = contactAddress({ path, search });
  if (contact) return contact;
  if (!params(search).has('ask') && !TEAM_HASHES.has(hash)) return '';
  return `${siteOf(path)}/teams/${search}${hash === '#teams' ? '' : hash}`;
}
