import { LEGAL_ADDRESS, LEGAL_REGISTRATION, SUPPORT_EMAIL } from '../src/config.js';
import { COUNTED_EVENTS, LANDING_EVENTS, plannerApiEnabled, setUsageCountsEnabled, usageCountsEnabled } from '../src/lib/planner-api.js';
import { CURRENCIES, PERSONAL_GIFTS, PLUS_FEATURES, PLUS_PRICE, TEAM_TIERS, formatMoney } from '../src/lib/pricing.js';

/**
 * Legal pages (legal/, legal/privacy/, legal/terms/, legal/cookies/).
 *
 * The pages are plain HTML that reads well without JavaScript. This module
 * fills in what depends on the deployment or on the code, so it can never
 * drift: the publisher's details (SUPPORT_EMAIL, LEGAL_ADDRESS,
 * LEGAL_REGISTRATION from runtime-config.js, each left out when blank), the
 * moments the site counts (COUNTED_EVENTS and LANDING_EVENTS), the prices and
 * the Plus features (src/lib/pricing.js). It makes no network request.
 *
 * The pure helpers below are unit-tested (tests/legal.test.js).
 */

export const PUBLISHER = 'Ben Morin, an individual based in France';
// Plain addresses only: nothing that could add ?subject= or ?bcc= to a mailto: link.
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"?&=%/#]{1,64}@[a-z0-9](?:[a-z0-9.-]{0,188}[a-z0-9])?\.[a-z]{2,24}$/i;
const ASK_PATH = 'welcome/?ask=question#request';

export const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const oneLine = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();

/** The publisher's details from a runtime configuration; blank or invalid values become ''. */
export function legalDetails(config = {}) {
  const text = key => (typeof config?.[key] === 'string' ? config[key].trim() : '');
  const email = text('SUPPORT_EMAIL');
  return {
    email: EMAIL_RE.test(email) ? email : '',
    address: oneLine(text('LEGAL_ADDRESS')),
    registration: oneLine(text('LEGAL_REGISTRATION'))
  };
}

/** Where to write without a support address: the “Ask a question” form of the welcome page. */
export const askHref = (root = '../') => `${root}${ASK_PATH}`;

/** How to reach us, as the value of a “Contact” row: the address, or the question form. */
export function contactHtml(details, root = '../') {
  return details.email
    ? `<a href="mailto:${esc(details.email)}">${esc(details.email)}</a>`
    : `the <a href="${esc(askHref(root))}">“Ask a question” form</a> on the welcome page`;
}

/** How to reach us inside a sentence (“To use these rights, …”): “email …” or “use the … form”. */
export function contactPhrase(details, root = '../') {
  return details.email
    ? `email <a href="mailto:${esc(details.email)}">${esc(details.email)}</a>`
    : `use the <a href="${esc(askHref(root))}">“Ask a question” form</a>`;
}

/** The publisher block: name, then address and registration only when they are set, then the contact. */
export function detailRows(details, root = '../') {
  return [
    ['Publisher', esc(PUBLISHER)],
    details.address ? ['Address', esc(details.address)] : null,
    details.registration ? ['Registration', esc(details.registration)] : null,
    ['Contact', contactHtml(details, root)]
  ].filter(Boolean);
}

export const detailsHtml = rows => rows.map(([label, value]) => `<div class="lg-dl__row"><dt>${esc(label)}</dt><dd>${value}</dd></div>`).join('');

/** One list item per counted moment, in the words the planner’s Privacy notice uses. */
export const eventsHtml = (events = COUNTED_EVENTS) => events.map(([, words]) => `<li>${esc(words)}</li>`).join('');

const bothCurrencies = price => CURRENCIES.map(currency => formatMoney(price[currency], currency)).join(' / ');
const people = count => `${Number(count).toLocaleString('en-US')} ${Number(count) === 1 ? 'person' : 'people'}`;

/** Today’s prices (taxes included), from src/lib/pricing.js. */
export function priceItems() {
  const items = [`Daily Planner Plus: ${bothCurrencies(PLUS_PRICE)}`];
  PERSONAL_GIFTS.forEach(gift => items.push(`${gift.label}: ${bothCurrencies(gift.price)} (${gift.seats === 1 ? 'one person' : `up to ${people(gift.seats)} in one household`})`));
  const smallest = TEAM_TIERS[0];
  if (smallest) items.push(`Team gifts: from ${bothCurrencies(smallest.price)} for up to ${people(smallest.seats)}`);
  return items;
}

export const pricesHtml = () => priceItems().map(item => `<li>${esc(item)}</li>`).join('');

/** “Plan your year”, “Your year in review” and “…”: the Plus features today. */
export function featuresText(features = PLUS_FEATURES) {
  const names = features.map(feature => `“${feature.title}”`);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names.join('');
}

const countsNote = on => (on
  ? 'On for this browser, for the planner and the welcome page.'
  : 'Off for this browser: nothing is counted from here.');

/* Page ---------------------------------------------------------------------- */

function fill(doc, selector, html) {
  doc.querySelectorAll(selector).forEach(node => { node.innerHTML = html; });
}

function setupCountsSwitch(doc) {
  const box = doc.querySelector('[data-legal-counts]');
  const toggle = box?.querySelector('[data-legal-counts-toggle]');
  if (!box || !toggle || !plannerApiEnabled()) return;
  const note = box.querySelector('[data-legal-counts-note]');
  const show = () => {
    const on = usageCountsEnabled();
    toggle.checked = on;
    if (note) note.textContent = countsNote(on);
  };
  toggle.addEventListener('change', () => {
    setUsageCountsEnabled(toggle.checked);
    show();
  });
  show();
  box.hidden = false;
}

/** Fills the page from the configuration. `root` is the site root, relative to the page. */
export function applyLegal(doc, { config = { SUPPORT_EMAIL, LEGAL_ADDRESS, LEGAL_REGISTRATION }, root = doc.body?.dataset.root || '../' } = {}) {
  const details = legalDetails(config);
  fill(doc, '[data-legal-details]', detailsHtml(detailRows(details, root)));
  fill(doc, '[data-legal-contact]', contactPhrase(details, root));
  fill(doc, '[data-legal-events="planner"]', eventsHtml(COUNTED_EVENTS));
  fill(doc, '[data-legal-events="landing"]', eventsHtml(LANDING_EVENTS));
  fill(doc, '[data-legal-prices]', pricesHtml());
  doc.querySelectorAll('[data-legal-features]').forEach(node => { node.textContent = featuresText(); });
  doc.querySelectorAll('[data-legal-js]').forEach(node => { node.hidden = false; });
  doc.querySelectorAll('[data-legal-nojs]').forEach(node => { node.hidden = true; });
  setupCountsSwitch(doc);
}

if (typeof document !== 'undefined') applyLegal(document);
