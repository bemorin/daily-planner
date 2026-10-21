import { LEGAL_ADDRESS, LEGAL_PHONE, LEGAL_REGISTRATION, PRIVACY_EMAIL, SUPPORT_EMAIL } from '../src/config.js';
import { COUNTED_EVENTS, LANDING_EVENTS, plannerApiEnabled, setUsageCountsEnabled, usageCountsEnabled } from '../src/lib/planner-api.js';
import { CURRENCIES, LAUNCH, PARTNER_PROGRAM, PERSONAL_GIFTS, PLUS_FEATURES, PLUS_PRICE, TEAM_TIERS, formatMoney, memberGiftPrice } from '../src/lib/pricing.js';
import { contactPhrase, detailRows, detailsHtml, esc, legalDetails } from './legal-details.js';

/**
 * Legal pages (legal/, legal/privacy/, legal/terms/, legal/cookies/).
 *
 * The pages are plain HTML that reads well without JavaScript. This module
 * fills in what depends on the deployment or on the code, so it can never
 * drift: the publisher's details (SUPPORT_EMAIL, PRIVACY_EMAIL, LEGAL_PHONE,
 * LEGAL_ADDRESS, LEGAL_REGISTRATION from runtime-config.js, each left out
 * when blank or invalid, see legal-details.js; the build writes them into
 * the pages of dist/ too, for readers without JavaScript), who answers what
 * (contactEmail), the moments the site counts (COUNTED_EVENTS and LANDING_EVENTS), the prices,
 * the Plus features and the partner program's terms (src/lib/pricing.js). It makes no network request. It also
 * marks, in “On this page”, the section being read.
 *
 * The pure helpers below are unit-tested (tests/legal.test.js).
 */

// The publisher's details (checked, then written as rows and links) are
// shared with the build and the owner dashboard: legal-details.js.
export { DIRECTOR, PUBLISHER, askHref, callingCode, contactEmail, contactHtml, contactPhrase, detailRows, detailsHtml, emailAddress, esc, formatPhone, legalDetails, legalEmail, legalPhone, legalValueProblem, phoneHtml, staticLegalHtml, telHref } from './legal-details.js';

/** One list item per counted moment, in the words the planner’s Privacy notice uses. */
export const eventsHtml = (events = COUNTED_EVENTS) => events.map(([, words]) => `<li>${esc(words)}</li>`).join('');

const bothCurrencies = price => CURRENCIES.map(currency => formatMoney(price[currency], currency)).join(' / ');
const people = count => `${Number(count).toLocaleString('en-US')} ${Number(count) === 1 ? 'person' : 'people'}`;

/** Today’s prices (taxes included), from src/lib/pricing.js: the launch price of Plus, the gifts and their member price. */
export function priceItems() {
  const items = [`Daily Planner Plus${LAUNCH.active ? ', at its launch price' : ''}: ${bothCurrencies(PLUS_PRICE)}`];
  PERSONAL_GIFTS.forEach(gift => {
    const member = Object.fromEntries(CURRENCIES.map(currency => [currency, memberGiftPrice(gift.plan, currency)]));
    const memberText = CURRENCIES.every(currency => member[currency] != null) ? `; ${bothCurrencies(member)} for someone who already has Plus` : '';
    items.push(`${gift.label}: ${bothCurrencies(gift.price)} (${gift.seats === 1 ? 'one person' : `up to ${people(gift.seats)} in one household`}${memberText})`);
  });
  const smallest = TEAM_TIERS[0];
  if (smallest) items.push(`Team gifts: from ${bothCurrencies(smallest.price)} for up to ${people(smallest.seats)}`);
  return items;
}

export const pricesHtml = () => priceItems().map(item => `<li>${esc(item)}</li>`).join('');

/** The partner program's figures as the terms say them (PARTNER_PROGRAM): rates, days, the minimum payout. */
export function partnerTerms(program = PARTNER_PROGRAM) {
  const minimum = CURRENCIES.map(currency => formatMoney(program.minimumPayout[currency], currency));
  return {
    rate: `${program.rate}%`,
    teamRate: `${program.teamRate}%`,
    days: String(program.cookieDays),
    refundDays: String(program.refundDays),
    minimum: minimum.join(' or ')
  };
}

/** “Plan your year”, “Your year in review” and “…”: the Plus features today. */
export function featuresText(features = PLUS_FEATURES) {
  const names = features.map(feature => `“${feature.title}”`);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names.join('');
}

/**
 * Which section “On this page” marks: the last one whose top has reached
 * `line` (pixels from the top of the window), or the last one when the page
 * is scrolled to its end. -1 above the first section.
 */
export function activeSectionIndex(tops, line, atEnd = false) {
  if (!Array.isArray(tops) || !tops.length) return -1;
  if (atEnd) return tops.length - 1;
  let active = -1;
  tops.forEach((top, index) => { if (Number.isFinite(top) && top <= line) active = index; });
  return active;
}

/** Where a section counts as being read: a quarter of the way down, under the sticky header. */
export const readingLine = (headerHeight, windowHeight) => {
  const header = Number.isFinite(headerHeight) && headerHeight > 0 ? headerHeight : 0;
  const view = Number.isFinite(windowHeight) && windowHeight > header ? windowHeight - header : 0;
  return Math.round(header + Math.max(48, view * 0.25));
};

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

/*
 * “On this page” follows the reading: the link of the section in view gets
 * aria-current="true" and the links' hover colour (legal.css). The sections
 * are watched with an IntersectionObserver on a one-pixel line, so nothing
 * runs while scrolling inside a section. A link that was just clicked stays
 * marked until the jump has settled, even when the section is too short to
 * reach the line.
 */
function setupContents(doc) {
  const win = doc.defaultView;
  const toc = doc.querySelector('.lg-toc');
  if (!toc || !win || typeof win.IntersectionObserver !== 'function') return;
  const items = [...toc.querySelectorAll('a[href^="#"]')]
    .map(link => ({ link, section: doc.getElementById(decodeURIComponent(link.hash.slice(1))) }))
    .filter(item => item.section);
  if (!items.length) return;
  const root = doc.documentElement;
  let current = -2;
  let pinned = false;
  let release = 0;
  let observer = null;
  let footSeen = false;

  const header = () => doc.querySelector('.lg-top')?.getBoundingClientRect().height || 0;
  // The end of the page: scrolled to the bottom (within a pixel or two: zoom rounds), and there was something to scroll.
  const atEnd = () => root.scrollHeight > win.innerHeight + 4 && (footSeen || win.scrollY + win.innerHeight >= root.scrollHeight - 2);

  // Keeps the marked link in view when the contents scroll on their own (sticky, wide screens).
  function reveal(link) {
    if (!link || toc.scrollHeight <= toc.clientHeight + 1) return;
    const box = toc.getBoundingClientRect();
    const rect = link.getBoundingClientRect();
    if (rect.top < box.top + 40) toc.scrollTop -= box.top + 40 - rect.top;
    else if (rect.bottom > box.bottom - 16) toc.scrollTop += rect.bottom - box.bottom + 16;
  }

  function mark(index) {
    if (index === current) return;
    current = index;
    items.forEach((item, position) => {
      if (position === index) item.link.setAttribute('aria-current', 'true');
      else item.link.removeAttribute('aria-current');
    });
    reveal(items[index]?.link);
  }

  function update() {
    if (pinned) return;
    const line = readingLine(header(), win.innerHeight);
    mark(activeSectionIndex(items.map(item => item.section.getBoundingClientRect().top), line, atEnd()));
  }

  function watch() {
    observer?.disconnect();
    const line = readingLine(header(), win.innerHeight);
    observer = new win.IntersectionObserver(update, { rootMargin: `-${line}px 0px -${Math.max(0, win.innerHeight - line - 1)}px 0px` });
    items.forEach(item => observer.observe(item.section));
  }

  // At the end of the page the last section is marked, even when it is too short to reach the line.
  const foot = doc.querySelector('.lg-foot');
  if (foot) {
    new win.IntersectionObserver(entries => {
      footSeen = entries[entries.length - 1].intersectionRatio > .97;
      update();
    }, { threshold: [0, .5, .97, 1] }).observe(foot);
  }

  function settle() {
    win.clearTimeout(release);
    release = win.setTimeout(() => { pinned = false; }, 120);
  }

  toc.addEventListener('click', event => {
    const link = event.target.closest('a[href^="#"]');
    const index = items.findIndex(item => item.link === link);
    if (index < 0) return;
    mark(index);
    pinned = true;
    // Released once the jump stops moving (or at once if there was nothing to scroll).
    win.clearTimeout(release);
    release = win.setTimeout(() => { pinned = false; }, 1200);
  });
  let ticking = 0;
  win.addEventListener('scroll', () => {
    if (pinned) { settle(); return; }
    // Reaching the very bottom moves no section across the reading line: check it here too.
    win.cancelAnimationFrame(ticking);
    ticking = win.requestAnimationFrame(() => { if (atEnd()) update(); });
  }, { passive: true });

  let resizing = 0;
  win.addEventListener('resize', () => {
    win.cancelAnimationFrame(resizing);
    resizing = win.requestAnimationFrame(() => { watch(); update(); });
  });
  watch();
}

/** Fills the page from the configuration. `root` is the site root, relative to the page. */
export function applyLegal(doc, { config = { SUPPORT_EMAIL, PRIVACY_EMAIL, LEGAL_PHONE, LEGAL_ADDRESS, LEGAL_REGISTRATION }, root = doc.body?.dataset.root || '../' } = {}) {
  const details = legalDetails(config);
  // data-legal-details="notice" | "privacy"; data-legal-contact="support" | "privacy" (see detailRows and contactEmail).
  ['notice', 'privacy'].forEach(page => fill(doc, `[data-legal-details="${page}"]`, detailsHtml(detailRows(details, root, page))));
  ['support', 'privacy'].forEach(topic => fill(doc, `[data-legal-contact="${topic}"]`, contactPhrase(details, root, topic)));
  fill(doc, '[data-legal-events="planner"]', eventsHtml(COUNTED_EVENTS));
  fill(doc, '[data-legal-events="landing"]', eventsHtml(LANDING_EVENTS));
  fill(doc, '[data-legal-prices]', pricesHtml());
  doc.querySelectorAll('[data-legal-features]').forEach(node => { node.textContent = featuresText(); });
  const partner = partnerTerms();
  [['rate', partner.rate], ['team-rate', partner.teamRate], ['days', partner.days], ['refund-days', partner.refundDays], ['minimum', partner.minimum]]
    .forEach(([name, text]) => doc.querySelectorAll(`[data-partner-${name}]`).forEach(node => { node.textContent = text; }));
  doc.querySelectorAll('[data-legal-js]').forEach(node => { node.hidden = false; });
  doc.querySelectorAll('[data-legal-nojs]').forEach(node => { node.hidden = true; });
  setupCountsSwitch(doc);
  setupContents(doc);
}

if (typeof document !== 'undefined') applyLegal(document);
