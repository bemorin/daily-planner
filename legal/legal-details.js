/**
 * The publisher's details on the legal pages (SUPPORT_EMAIL, PRIVACY_EMAIL,
 * LEGAL_PHONE, LEGAL_ADDRESS, LEGAL_REGISTRATION, build variables
 * DAILY_PLANNER_…), checked and written the same way everywhere:
 *   - legal/legal.js fills the pages with them in the browser;
 *   - scripts/build.mjs writes them into the pages of dist/ (staticLegalHtml),
 *     so they show without JavaScript too;
 *   - the owner dashboard's Setup card (admin/admin.js, admin/attention.js)
 *     says when a value is set but not used (legalValueProblem).
 * Pure, no imports: Node (the build, the tests) and the browser load it as is.
 */

export const PUBLISHER = 'Ben Morin, an individual based in France';
// The legal notice's director of publication (LCEN art. 6 III): the publisher himself.
export const DIRECTOR = 'Ben Morin';
// Plain addresses only: nothing that could add ?subject= or ?bcc= to a mailto: link.
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"?&=%/#]{1,64}@[a-z0-9](?:[a-z0-9.-]{0,188}[a-z0-9])?\.[a-z]{2,24}$/i;
// A phone number as people write it: digits, spaces and + ( ) - . only, with 6 to 20 digits.
const PHONE_RE = /^\+?[\d ().-]{6,32}$/;
// The question form lives on the Teams page (1.28).
const ASK_PATH = 'welcome/teams/?ask=question#request';
// The configuration keys that hold an email address.
const EMAIL_KEYS = ['SUPPORT_EMAIL', 'PRIVACY_EMAIL'];

export const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const oneLine = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
const configText = (config, key) => (typeof config?.[key] === 'string' ? config[key].trim() : '');

/** An email address from the configuration, or '' when it isn't a plain one. */
export function legalEmail(value) {
  const email = typeof value === 'string' ? value.trim() : '';
  return EMAIL_RE.test(email) ? email : '';
}

/** A phone number from the configuration, on one line, or '' when it isn't one. */
export function legalPhone(value) {
  const phone = oneLine(value);
  const digits = phone.replace(/\D/g, '').length;
  return PHONE_RE.test(phone) && digits >= 6 && digits <= 20 ? phone : '';
}

/** The publisher's details from a runtime configuration; blank or invalid values become ''. */
export function legalDetails(config = {}) {
  const text = key => configText(config, key);
  return {
    email: legalEmail(text('SUPPORT_EMAIL')),
    privacyEmail: legalEmail(text('PRIVACY_EMAIL')),
    phone: legalPhone(text('LEGAL_PHONE')),
    address: oneLine(text('LEGAL_ADDRESS')),
    registration: oneLine(text('LEGAL_REGISTRATION'))
  };
}

/**
 * Why a configured value is left out of the pages, in a few words (“not a
 * plain email address”, “not a phone number”); '' when it is used or blank.
 */
export function legalValueProblem(key, value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '';
  if (EMAIL_KEYS.includes(key)) return legalEmail(text) ? '' : 'not a plain email address';
  if (key === 'LEGAL_PHONE') return legalPhone(text) ? '' : 'not a phone number';
  return '';
}

/**
 * The address that answers a topic: 'privacy' (the privacy policy, the
 * cookies page) goes to PRIVACY_EMAIL, else SUPPORT_EMAIL; anything else
 * (the terms, the legal notice) to SUPPORT_EMAIL. '' means the question form.
 */
export function contactEmail(details, topic = 'support') {
  return (topic === 'privacy' && details?.privacyEmail) || details?.email || '';
}

/** Where to write without an address: the “Ask a question” form, on the Teams page. */
export const askHref = (root = '../') => `${root}${ASK_PATH}`;

const mailLink = email => `<a href="mailto:${esc(email)}">${esc(email)}</a>`;
const formLink = root => `<a href="${esc(askHref(root))}">“Ask a question” form</a>`;

/** How to reach us about a topic, as the value of a row: the address, or the question form. */
export function contactHtml(details, root = '../', topic = 'support') {
  const email = contactEmail(details, topic);
  return email ? mailLink(email) : `the ${formLink(root)}`;
}

/** How to reach us inside a sentence (“To use these rights, …”): “email …” or “use the … form”. */
export function contactPhrase(details, root = '../', topic = 'support') {
  const email = contactEmail(details, topic);
  return email ? `email ${mailLink(email)}` : `use the ${formLink(root)}`;
}

/**
 * A phone number as a tel: link: the digits, with the leading + of an
 * international number, which also drops the national “(0)” of
 * “+33 (0)6 …”. A national number keeps its 0, even written “(0)6 …”.
 */
export function telHref(phone) {
  const text = String(phone ?? '').trim();
  const number = text.startsWith('+') ? text.replace(/\(0\)/g, '') : text;
  return `tel:${number.replace(/(?!^\+)\D/g, '')}`;
}

export const phoneHtml = phone => `<a href="${esc(telHref(phone))}">${esc(phone)}</a>`;

/**
 * The publisher block. The legal notice (`page` 'notice'): Publisher,
 * Address and Registration when set, Email (SUPPORT_EMAIL, or Contact: the
 * form), Phone when set, Director of publication. The privacy policy
 * ('privacy'): the data controller, Address and Registration when set, and
 * where to write about privacy (PRIVACY_EMAIL, else SUPPORT_EMAIL, else the form).
 */
export function detailRows(details, root = '../', page = 'notice') {
  const privacy = page === 'privacy';
  const topic = privacy ? 'privacy' : 'support';
  return [
    [privacy ? 'Data controller' : 'Publisher', esc(PUBLISHER)],
    details.address ? ['Address', esc(details.address)] : null,
    details.registration ? ['Registration', esc(details.registration)] : null,
    [contactEmail(details, topic) ? 'Email' : 'Contact', contactHtml(details, root, topic)],
    !privacy && details.phone ? ['Phone', phoneHtml(details.phone)] : null,
    privacy ? null : ['Director of publication', esc(DIRECTOR)]
  ].filter(Boolean);
}

export const detailsHtml = rows => rows.map(([label, value]) => `<div class="lg-dl__row"><dt>${esc(label)}</dt><dd>${value}</dd></div>`).join('');

/**
 * A legal page's HTML with the publisher's details written in, as legal.js
 * writes them in the browser: each `<dl … data-legal-details="notice|privacy">`
 * gets its rows and each `<span data-legal-contact="support|privacy">` its
 * phrase, for the page's `data-root`. The build applies it to dist/ only:
 * the source pages keep the blank fallback (the question form).
 */
export function staticLegalHtml(html, config = {}) {
  const details = legalDetails(config);
  const root = /<body[^>]*\sdata-root="([./]*)"/.exec(html)?.[1] || '../';
  return String(html)
    .replace(/(<dl\b[^>]*\sdata-legal-details="(notice|privacy)"[^>]*>)[\s\S]*?(<\/dl>)/g, (_, open, page, close) => `${open}${detailsHtml(detailRows(details, root, page))}${close}`)
    .replace(/(<span\b[^>]*\sdata-legal-contact="(support|privacy)"[^>]*>)[\s\S]*?(<\/span>)/g, (_, open, topic, close) => `${open}${contactPhrase(details, root, topic)}${close}`);
}
