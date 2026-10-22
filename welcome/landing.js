import { LANDING_EVENTS, plannerApiEnabled, rememberReferral, setUsageCountsEnabled, trackEvent, usageCountsEnabled } from '../src/lib/planner-api.js';
import { LAUNCH, PARTNER_PROGRAM, PERSONAL_GIFTS, PLUS_FEATURES, PLUS_PRICE, PLUS_UPCOMING, isPersonalGift, memberGiftPrice, memberPriceNotice } from '../src/lib/pricing.js';
import { savedPlusToken, verifyPlusToken, writePlusCheck } from '../src/lib/plus.js';
import { animate } from '../src/vendor/motion.js';
import { HERO_SCRIPTS, setupHeroViews } from './hero-views.js';
import { countedMoments, monthWeeks, personalOffer, ritualYear, statusTone, upcomingSentence } from './landing-model.js';
import { LANDING } from './landing-settings.js';
import { CHECK_ICON, el, qs, qsa, renderFooter, setupTopBar } from './page-kit.js';
import { EASE_OUT, followMotion, motionWanted, reduceQuery, setupFaq, setupReveal } from './page-motion.js';
import { createPaletteCard } from './palette-card.js';
import { createPrivacyDialog } from './privacy-dialog.js';
import { checkout, createSale, renderPriceLines, setupBuyButtons } from './sale.js';
import { playCues, setupScenes } from './scenes.js';
import { movedAddress } from './teams-model.js';

/* ============================================================================
   LANDING (/welcome/): the planner, Plus and its prices for one person, and a
   banner that leads to the Teams page (/teams/), where the team gift,
   its prices and the request form live. Copy the owner may change without
   touching markup is in welcome/landing-settings.js (LANDING); prices, what
   Plus adds and what it promises next in src/lib/pricing.js (shared with the
   planner and the server, which charges exactly those amounts).
   The launch price (LAUNCH) shows wherever Plus has a price ([data-launch]).
   A visitor whose planner (same site) has Plus sees the member price of the
   personal gifts; the licence goes with a gift checkout, and the server
   checks it before charging that price.
   ============================================================================ */

const html = document.documentElement;
const apiOn = plannerApiEnabled();
const track = name => { if (apiOn) trackEvent(name); };

const okMark = () => el('span', { class: 'ok', 'aria-hidden': 'true', html: CHECK_ICON });

/* Currency and what can be bought online: asked once, on load -------------- */

const sale = createSale({ onLoad: () => renderOffers() });
const money = value => sale.money(value);

/* Members: Plus in this browser's planner (the same site) -------------------- */

// The licence is read from the planner's settings and its signature checked
// here, only to show the member price; the server checks it again (and that
// it wasn't refunded) before charging that price. Nothing is sent until a
// gift checkout.
const member = { token: '', active: false };

async function checkMember() {
  const token = savedPlusToken();
  if (!token || !apiOn) return;
  const license = await verifyPlusToken(token).catch(() => null);
  if (!license) return;
  member.token = token;
  member.active = true;
  renderGifts();
}

/** A personal gift's price for this visitor: { amount, was } — `was` is the usual price when the member price applies. */
function giftPriceFor(plan) {
  const offer = personalOffer(plan, sale.currency);
  if (!offer || offer.amount == null) return { amount: null, was: null };
  const reduced = member.active ? memberGiftPrice(plan, sale.currency) : null;
  return reduced != null && reduced < offer.amount ? { amount: reduced, was: offer.amount } : { amount: offer.amount, was: null };
}

/* Offer: Plus and personal gifts ------------------------------------------ */

function renderPlusLists() {
  // The lines of the Plus card: everything in Free, then what Plus adds.
  qsa('[data-plus-lines]').forEach(list => {
    // “Everything in Free” stands apart: the app's colour, then what Plus adds in ink.
    const free = el('li', { class: 'is-free' }, el('span', { class: 'ok ok--accent', 'aria-hidden': 'true', html: CHECK_ICON }), 'Everything in Free');
    list.replaceChildren(free, ...PLUS_FEATURES.map(feature => el('li', {}, okMark(), feature.title)));
  });
  // The promise: what Plus gets next, at no extra cost, with its status. Four
  // columns with headings in the Plus section; titles and chips only in the
  // Plus card of the prices. While nothing is promised (PLUS_UPCOMING is
  // empty), every part of it stays hidden, as the page is written.
  const promised = PLUS_UPCOMING.length > 0;
  qsa('[data-plus-soon], [data-compare-upcoming], [data-faq-upcoming]').forEach(node => { node.hidden = !promised; });
  if (!promised) return;
  const chip = next => el('span', { class: `chip chip--${statusTone(next.status)}` }, el('span', { class: 'sr-only' }, 'Status: '), next.status);
  qsa('[data-plus-upcoming]').forEach(list => {
    if (list.hasAttribute('data-compact')) {
      list.replaceChildren(...PLUS_UPCOMING.map(next => el('li', {}, el('span', { class: 'teaser__name' }, next.title), chip(next))));
      return;
    }
    const detailed = list.hasAttribute('data-detailed');
    list.replaceChildren(...PLUS_UPCOMING.map(next => el('li', { class: 'soon__item' },
      el('span', { class: 'soon__mark', 'aria-hidden': 'true' }),
      el('div', { class: 'soon__body' },
        el('div', { class: 'soon__top' },
          el(detailed ? 'h4' : 'b', { class: 'soon__name' }, next.title),
          chip(next)),
        el('span', { class: 'soon__text' }, next.text)))));
  });
  // The comparison: each promised feature, included in Plus when it ships.
  qsa('[data-compare-upcoming]').forEach(body => {
    const head = body.querySelector('.cmp__group');
    body.replaceChildren(...(head ? [head] : []), ...PLUS_UPCOMING.map(next => el('tr', {},
      el('th', { scope: 'row' }, el('span', { class: 'cmp__name' }, next.title), chip(next)),
      el('td', {}, el('span', { class: 'no', 'aria-hidden': 'true' }), el('span', { class: 'sr-only' }, 'Not included')),
      el('td', {}, el('span', { class: 'soon-ok' }, el('span', { class: 'soon-ok__mark', 'aria-hidden': 'true' }), el('span', { class: 'soon-ok__text' }, 'Included when it ships'))))));
  });
  qsa('[data-faq-upcoming]').forEach(node => { node.textContent = ` ${upcomingSentence(PLUS_UPCOMING)}`; });
}

function plusCta(box) {
  const state = sale.state('plus');
  const price = PLUS_PRICE[sale.currency];
  const children = [];
  if (state.buyable) {
    // The button names the price, so it reads the same wherever it is.
    const label = Number.isFinite(price) ? `Get Plus — ${money(price)}` : 'Get Plus';
    children.push(el('button', { class: 'btn btn--primary btn--buy', type: 'button', 'data-buy': 'plus' }, label));
  } else {
    const id = `plus-note-${box.dataset.plusCta || 'x'}`;
    children.push(el('button', { class: 'btn btn--primary btn--buy', type: 'button', disabled: true, 'aria-describedby': id }, 'Coming soon'));
    children.push(state.reason === 'currency'
      ? el('p', { class: 'buy__note', id }, `Plus isn’t on sale in ${sale.currencyName()} yet. Everything else is free: `, el('a', { href: '../', 'data-cta': 'app' }, 'open the planner'), '.')
      : el('p', { class: 'buy__note', id }, 'Plus isn’t on sale here yet. Everything else is free: ', el('a', { href: '../', 'data-cta': 'app' }, 'open the planner'), '.'));
  }
  children.push(el('p', { class: 'buy__error', role: 'alert', 'data-buy-error': true, hidden: true }));
  box.replaceChildren(...children);
}

/* The launch price: a badge and one line wherever Plus has a price (LAUNCH in pricing.js). */
function renderLaunch() {
  qsa('[data-launch]').forEach(node => { node.hidden = !LAUNCH.active; });
  qsa('[data-launch-label]').forEach(node => { node.textContent = LAUNCH.label; });
  qsa('[data-launch-line]').forEach(node => { node.textContent = LAUNCH.line; });
}

function renderPlus() {
  const price = PLUS_PRICE[sale.currency];
  qsa('[data-plus-price]').forEach(node => { node.textContent = Number.isFinite(price) ? money(price) : ''; });
  qsa('[data-free-price]').forEach(node => { node.textContent = money(0); });
  qsa('[data-plus-cta]').forEach(plusCta);
}

/*
 * Give Plus and Plus Family: a gift link bought online, sent by the buyer. A
 * member sees the member price first and the usual one after it: “Member
 * price €24 · was €29”.
 */
function renderGifts() {
  const list = qs('[data-gift-list]');
  if (list) {
    const state = sale.state('gift');
    list.replaceChildren(...PERSONAL_GIFTS.map(gift => {
      const { amount, was } = giftPriceFor(gift.plan);
      const price = amount == null ? '' : money(amount);
      const buyable = state.buyable && amount != null;
      return el('button', {
        class: `gift-btn${was != null ? ' gift-btn--member' : ''}`,
        type: 'button',
        'data-buy': buyable ? 'gift' : null,
        'data-plan': gift.plan,
        disabled: !buyable,
        'aria-label': `${gift.label}, ${gift.note.toLowerCase()}, ${was != null ? `member price ${price}, was ${money(was)}` : price}`
      }, el('span', { class: 'gift-btn__icon', 'aria-hidden': 'true', html: '<svg class="i"><use href="#i-gift"/></svg>' }),
      el('span', { class: 'gift-btn__name' }, gift.label),
      el('span', { class: 'gift-btn__note' }, gift.note),
      el('span', { class: 'gift-btn__price' }, price, was != null ? el('small', {}, `was ${money(was)}`) : null));
    }));
  }
  const badge = qs('[data-member-badge]');
  if (badge) badge.hidden = !member.active;
  const note = qs('[data-gifts-note]');
  if (note) note.textContent = member.active
    ? 'As a Plus member, you pay the member price. After paying, you get a link to send: Plus is theirs for life as soon as they open it.'
    : 'After paying, you get a link to send. Plus is theirs for life as soon as they open it.';
  qsa('[data-gift-price]').forEach(node => {
    const offer = personalOffer(node.dataset.giftPrice, sale.currency);
    if (offer?.amount != null) node.textContent = money(offer.amount);
  });
  qsa('[data-member-price]').forEach(node => {
    const reduced = memberGiftPrice(node.dataset.memberPrice, sale.currency);
    if (reduced != null) node.textContent = money(reduced);
  });
  // The ways to give it, under the Plus offer: “Member price €24 · was €29” for a member.
  qsa('[data-gift-offer]').forEach(node => {
    const plan = node.dataset.giftOffer;
    const { amount, was } = giftPriceFor(plan);
    if (amount == null) return;
    const after = plan === 'family-5' ? ', up to 5 people at home' : ', for one person';
    node.replaceChildren(...(was != null
      ? ['Member price ', el('b', {}, money(amount)), ` · was ${money(was)}`]
      : [el('span', { 'data-gift-price': plan }, money(amount)), after]));
  });
}

function renderOffers() {
  renderLaunch();
  renderPlus();
  renderGifts();
  // The currency lines, and the team banner's lowest price per person.
  renderPriceLines(sale);
}

function setupOffers() {
  const note = qs('[data-pricing-note]');
  if (note) note.textContent = LANDING.pricingNote;
  renderPlusLists();
  renderOffers();
  // Asked at once, so the prices are in the visitor's currency before they
  // scroll to them, and never change under their eyes.
  sale.load();
}

/* Compare plans: one disclosure with a smooth height change ---------------- */

function setupCompare() {
  const box = qs('[data-compare]');
  const toggle = box && qs('[data-compare-toggle]', box);
  const panel = box && qs('[data-compare-panel]', box);
  if (!toggle || !panel) return;
  let open = false;
  let controls = null;
  const canAnimate = () => !reduceQuery.matches && typeof Element.prototype.animate === 'function';
  const settle = () => {
    panel.style.removeProperty('height');
    panel.style.removeProperty('opacity');
    box.classList.remove('is-moving');
    if (!open) panel.hidden = true;
  };
  const show = next => {
    const from = panel.hidden ? 0 : panel.getBoundingClientRect().height;
    open = next;
    toggle.setAttribute('aria-expanded', String(open));
    box.classList.toggle('is-open', open);
    try { controls?.stop(); } catch (_) { /* already settled */ }
    controls = null;
    panel.hidden = false;
    if (!canAnimate()) {
      settle();
      return;
    }
    const to = open ? panel.scrollHeight : 0;
    box.classList.add('is-moving');
    const run = animate(panel, { height: [`${from}px`, `${to}px`], opacity: [open && !from ? 0 : 1, open ? 1 : 0] }, { duration: open ? 0.46 : 0.32, ease: open ? EASE_OUT : [0.4, 0, 0.2, 1] });
    controls = run;
    run.finished.then(() => { if (controls === run) { controls = null; settle(); } }, () => {});
  };
  // Without JavaScript the table simply shows; with it, it starts folded.
  panel.hidden = true;
  toggle.setAttribute('aria-expanded', 'false');
  toggle.addEventListener('click', () => show(!open));
}

/* Buy: Plus or a personal gift, through Creem ------------------------------ */

/*
 * The member price was shown, but the checkout the server opened charges the
 * usual price (the licence was refunded, or couldn't be checked): said under
 * the gifts before paying, with Continue (to that checkout) and Cancel. The
 * page then shows the usual prices, and the planner checks its licence the
 * next time it opens.
 */
function hideMemberCheck() {
  qs('[data-member-check]')?.remove();
}

function showMemberCheck(plan, text, url) {
  hideMemberCheck();
  const box = qs('[data-gifts]');
  if (!box) return false;
  const cancel = el('button', { class: 'btn btn--ghost btn--sm', type: 'button' }, 'Cancel');
  const go = el('button', { class: 'btn btn--primary btn--sm', type: 'button' }, 'Continue');
  const check = el('div', { class: 'member-check', 'data-member-check': true },
    el('p', { role: 'alert' }, text),
    el('div', { class: 'member-check__actions' }, cancel, go));
  cancel.addEventListener('click', () => {
    hideMemberCheck();
    qs(`[data-buy="gift"][data-plan="${CSS.escape(plan)}"]`)?.focus();
  });
  go.addEventListener('click', () => {
    go.disabled = true;
    cancel.disabled = true;
    go.textContent = 'Opening checkout…';
    location.assign(url);
  });
  box.insertBefore(check, qs('[data-buy-error]', box));
  check.scrollIntoView({ block: 'center' });
  go.focus({ preventScroll: true });
  return true;
}

function buy(clicked) {
  const plan = clicked.dataset.plan || '';
  const personal = clicked.dataset.buy === 'gift' && isPersonalGift(plan);
  hideMemberCheck();
  // A personal gift is Plus bought for someone else; team gifts have their own count.
  if (clicked.dataset.buy === 'plus' || personal) track('plus_checkout_clicked');
  else track('pack_checkout_clicked');
  return checkout(clicked, {
    sale,
    // A member's personal gift: the licence goes along, for the member price (checked by the server).
    license: personal && member.active ? member.token : '',
    // Not on sale online after all: the honest state.
    unavailable: () => renderOffers(),
    confirm: ({ result, url }) => {
      if (!personal) return false;
      const currency = sale.currency;
      const shown = giftPriceFor(plan).was != null;
      const notice = memberPriceNotice(plan, currency, { shown, confirmed: result.member === true });
      if (!notice) return false;
      // The usual prices from now on, and the planner checks its licence when it next opens.
      member.active = false;
      writePlusCheck({ at: 0 });
      renderGifts();
      return showMemberCheck(plan, notice, url);
    }
  });
}

/* Header, dock and click counts ------------------------------------------- */

function setupChrome() {
  setupTopBar();
  const dock = qs('[data-dock]');
  const heroCtas = qs('[data-hero-ctas]');
  // The dock steps aside where it would compete: the Plus offer, the team banner and the final call to action.
  const quiet = [qs('.plus-buy'), qs('[data-teams-banner]'), qs('[data-final-cta]')].filter(Boolean);
  if (dock && heroCtas && 'IntersectionObserver' in window) {
    let pastHero = false;
    const quietVisible = new Set();
    const sync = () => dock.classList.toggle('is-visible', pastHero && !quietVisible.size);
    new IntersectionObserver(([entry]) => {
      pastHero = !entry.isIntersecting && entry.boundingClientRect.top < 0;
      sync();
    }).observe(heroCtas);
    const quietObserver = new IntersectionObserver(entries => {
      entries.forEach(entry => { if (entry.isIntersecting) quietVisible.add(entry.target); else quietVisible.delete(entry.target); });
      sync();
    }, { rootMargin: '-80px 0px -12% 0px' });
    quiet.forEach(node => quietObserver.observe(node));
  }

  document.addEventListener('click', event => {
    const target = event.target.closest('a, button');
    if (!target) return;
    if (target.matches('[data-cta="app"]')) track('landing_cta_app');
    else if (target.matches('a[href^="../teams/"]')) track('landing_cta_teams');
  });
}

/* Counts: which parts of the page people reach, once per page view -------- */

function setupViewCounts() {
  if (!apiOn || !('IntersectionObserver' in window)) return;
  const sections = new Map([['plus', 'plus_viewed'], ['pricing', 'pricing_viewed']]);
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      observer.unobserve(entry.target);
      track(sections.get(entry.target.id));
    });
  }, { rootMargin: '0px 0px -30% 0px' });
  sections.forEach((name, id) => { const node = document.getElementById(id); if (node) observer.observe(node); });
}

/* Replica data: painted cells --------------------------------------------- */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// Illustrative demo years. The hero and Progress stop on a Friday in October
// 2026; the year in review covers the year before the one to plan.
const DEMO = { year: 2026, month: 9, day: 9, firstClosed: [0, 12], missed: ['8-10', '5-14', '2-23', '6-27'], jokers: ['9-2', '7-15', '4-7'] };
const REVIEW = { year: 2026, month: 11, day: 31, firstClosed: [0, 5], missed: ['1-17', '3-29', '5-14', '7-12', '10-24', '11-29'], jokers: ['2-11', '4-21', '6-3', '8-23', '10-5'], noToday: true };

/* The year of the ritual: next year from 1 October, else this one --------- */

const PLAN_YEAR = ritualYear(new Date());
REVIEW.year = PLAN_YEAR - 1;

function renderYears() {
  qsa('[data-plan-year]').forEach(node => { node.textContent = String(PLAN_YEAR + (Number(node.dataset.yearOffset) || 0)); });
}

/* The printed year map: twelve small months, a few dates, a pen ------------ */

// What the guided session planned (the same plan as its replica), by month.
const PRINT_EVENTS = [
  { month: 1, from: 2, kind: 'milestone', when: 'Feb 2', text: 'Book the flights' },
  { month: 2, from: 9, to: 11, kind: 'keydate', when: 'Mar 9 – 11', text: 'Team offsite in Lisbon' },
  { month: 2, from: 14, kind: 'adventure', when: 'Mar 14', text: 'Sleep in a mountain hut' },
  { month: 2, from: 21, kind: 'milestone', when: 'Mar 21', text: 'Walk 100 km in one week' },
  { month: 3, from: 11, kind: 'milestone', when: 'Apr 11', text: 'Test the gear on a weekend' },
  { month: 4, from: 3, to: 31, kind: 'misogi', when: 'May 3 – 31', text: 'Walk the Camino de Santiago' },
  { month: 5, from: 6, kind: 'adventure', when: 'Jun 6', text: 'Swim before 8am' },
  { month: 5, from: 20, kind: 'keydate', when: 'Jun 20', text: 'Sam’s wedding' },
  { month: 7, from: 2, to: 20, kind: 'keydate', when: 'Aug 2 – 20', text: 'Summer break' },
  { month: 10, from: 21, kind: 'adventure', when: 'Nov 21', text: 'Cook for twelve people' }
];
// Written by hand on the printout: a circled day, and a note on its month's first free line.
const PEN_CIRCLE = { month: 8, day: 9 };
const PEN_CIRCLE_PATH = 'M23.6 6.2C20.4 2.6 10.9 2.2 6.3 5.8 1.8 9.4 2.9 17.2 9.6 19.9c6.2 2.5 14.7.6 16.9-4.2 1.9-4.2-.9-8.9-6.4-10.8-2.6-.9-5.4-.9-7.6-.3';
const PEN_NOTE_PATH = 'M1 11.1c.5-.3 2.1-.8 3.1-1.8c.9-.9 2-2.7 2.6-3.9c.6-1.2 .9-2.7 .9-3.3c.1-.5-.4-.4-.7 .1c-.2 .5-.9 2-1 3.2c-.2 1.2-.3 3 .1 3.9c.3 1 1.3 1.6 1.9 1.7c.7 .2 1.4-.4 2.1-.8c.6-.5 1.3-1.4 1.7-1.9c.4-.6 .7-1.3 .8-1.6c.1-.3 0-.3-.1-.1c0 .3-.2 1-.2 1.6c.1 .6 .2 1.5 .5 2c.4 .4 1 .8 1.5 .8c.5 0 1-.3 1.5-.7c.6-.5 1.2-1.4 1.7-1.9c.4-.5 .9-1.1 1.2-1.4c.4-.2 .6-.3 .7 0c.2 .2 .2 .8 .4 1.4c.1 .5 .2 1.4 .4 1.9c.3 .4 .4 .8 1 .8c.7 0 2-.4 2.8-.8c.8-.4 1.5-1.3 1.9-1.8c.3-.5 .3-1.1 .2-1.3c-.1-.2-.6-.3-.8-.1c-.3 .3-.7 .9-.7 1.4c0 .6 .3 1.3 .8 1.7c.5 .5 1.9 .8 2.2 .9M30.1 11.1c.5-.3 2.1-.8 3-1.7c1-1 2.1-2.8 2.7-4c.6-1.1 .9-2.6 .9-3.1c.1-.5-.3-.5-.6 0c-.3 .5-.9 2-1 3.2c-.2 1.1-.3 3 .1 3.9c.3 .9 1.1 1.5 1.9 1.7c.8 .2 2.1-.4 2.9-.7c.8-.4 1.6-1.2 1.9-1.7c.4-.5 .4-1.1 .3-1.3c-.1-.3-.7-.3-.9-.1c-.3 .3-.7 .9-.7 1.4c.1 .5 .3 1.3 .9 1.7c.5 .4 2 .6 2.4 .7';
const PRINT_LINES = 3;
const SVG_NS = 'http://www.w3.org/2000/svg';

function penMark(className, viewBox, d, order) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', `pen ${className}`);
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('preserveAspectRatio', 'xMinYMax meet');
  svg.style.setProperty('--pen', String(order));
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('pathLength', '1');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
}

function buildPrintMonths(year) {
  const box = qs('[data-print-months]');
  if (!box) return;
  box.replaceChildren(...MONTHS.map((name, month) => {
    const events = PRINT_EVENTS.filter(event => event.month === month);
    const kindOf = day => events.find(event => day >= event.from && day <= (event.to || event.from))?.kind || '';
    const head = ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map(letter => el('span', { class: 'rp-pp__wd' }, letter));
    const days = monthWeeks(year, month).flat().map(day => {
      if (!day) return el('span', {});
      const weekday = new Date(year, month, day).getDay();
      const kind = kindOf(day);
      const cell = el('span', { class: [kind ? `is-${kind}` : '', weekday === 0 || weekday === 6 ? 'is-weekend' : ''].filter(Boolean).join(' ') || null }, String(day));
      if (month === PEN_CIRCLE.month && day === PEN_CIRCLE.day) cell.append(penMark('pen--circle', '0 0 30 24', PEN_CIRCLE_PATH, 1));
      return cell;
    });
    const lines = events.slice(0, PRINT_LINES).map(event => el('li', { class: `k-${event.kind}` }, el('i', {}), el('b', {}, event.when), ` ${event.text}`));
    while (lines.length < PRINT_LINES) lines.push(el('li', {}));
    if (month === PEN_CIRCLE.month) lines[events.length]?.append(penMark('pen--note', '0 0 48 14', PEN_NOTE_PATH, 2.6));
    return el('div', { class: 'rp-pp__month' },
      el('p', { class: 'rp-pp__mname' }, name, month % 3 === 0 ? el('small', {}, `Q${month / 3 + 1}`) : null),
      el('div', { class: 'rp-pp__cal' }, head, days),
      el('ul', { class: 'rp-pp__lines' }, lines));
  }));
}

function paintState(demo, month, day) {
  const date = new Date(demo.year, month, day);
  if (date.getMonth() !== month) return 'none';
  const key = `${month}-${day}`;
  const afterToday = month > demo.month || (month === demo.month && day > demo.day);
  if (afterToday) return '';
  if (!demo.noToday && month === demo.month && day === demo.day) return 'l3 is-today';
  if (month < demo.firstClosed[0] || (month === demo.firstClosed[0] && day < demo.firstClosed[1])) return 'before';
  const weekday = date.getDay();
  if (weekday === 0 || weekday === 6) return 'rest';
  if (demo.missed.includes(key)) return 'miss';
  if (demo.jokers.includes(key)) return 'joker';
  const roll = (month * 37 + day * 11 + day * day) % 10;
  return roll < 3 ? 'l1' : roll < 7 ? 'l2' : 'l3';
}

function buildYear(grid, demo) {
  let order = 0;
  let closed = 0;
  let mits = 0;
  const rows = MONTHS.map((name, monthIndex) => {
    const cells = [];
    for (let day = 1; day <= 31; day += 1) {
      const state = paintState(demo, monthIndex, day);
      if (/\bl[123]\b/.test(state)) closed += 1;
      if (/\bl[23]\b/.test(state)) mits += 1;
      const painted = /\b(l[123]|joker|miss)\b/.test(state);
      // --d: the order days were painted in; --w: a diagonal wave for recolouring.
      cells.push(el('span', { class: `cell ${state}`, style: painted ? `--d:${order};--w:${monthIndex + day}` : null }));
      if (painted) order += 1;
    }
    return el('div', { class: 'rp-paint__row' }, el('span', {}, name[0], el('b', {}, name.slice(1, 3))), el('div', { class: 'rp-paint__cells' }, cells));
  });
  grid.replaceChildren(...rows);
  return { order, closed, mits };
}

/* The quarter check-in, printed: the third quarter of the year in review ----- */

// Its days are painted as that review paints them; the winning habit ("Write
// three lines") is kept on most closed days, which shows as the darkest square.
const QUARTER = { months: [6, 7, 8], kept: (month, day) => (month * 5 + day * 7) % 10 < 8 };

function buildQuarter(year) {
  const box = qs('[data-quarter-months]');
  if (!box) return;
  const totals = { closed: 0, planning: 0, mits: 0, kept: 0, days: 0 };
  let run = 0;
  let best = 0;
  let habitRun = 0;
  let habitBest = 0;
  let order = 0;
  const habitMonths = [];
  const months = QUARTER.months.map(month => {
    const length = new Date(year, month + 1, 0).getDate();
    const lead = (new Date(year, month, 1).getDay() + 6) % 7;
    let closedInMonth = 0;
    let keptInMonth = 0;
    const cells = [];
    for (let day = 1; day <= length; day += 1) {
      const weekday = new Date(year, month, day).getDay();
      const state = paintState(REVIEW, month, day);
      totals.days += 1;
      if (weekday > 0 && weekday < 6) totals.planning += 1;
      if (/^l[123]/.test(state)) {
        const mit = !state.startsWith('l1');
        const kept = QUARTER.kept(month, day);
        totals.closed += 1;
        closedInMonth += 1;
        if (mit) totals.mits += 1;
        if (kept) { totals.kept += 1; keptInMonth += 1; }
        habitRun = kept ? habitRun + 1 : 0;
        habitBest = Math.max(habitBest, habitRun);
        run += 1;
        best = Math.max(best, run);
        cells.push(el('i', { class: `is-l${1 + (mit ? 1 : 0) + (kept ? 1 : 0)}`, style: `--d:${order}` }));
        order += 1;
      } else if (state === 'miss') {
        run = 0;
        habitRun = 0;
        cells.push(el('i', { class: 'is-miss', style: `--d:${order}` }));
        order += 1;
      } else {
        habitRun = 0;
        cells.push(el('i', { class: state === 'joker' ? 'is-joker' : 'is-rest', style: state === 'joker' ? `--d:${order}` : null }));
      }
    }
    habitMonths.push(Math.round((keptInMonth / length) * 100));
    return el('div', { class: 'rp-qp__month' },
      el('p', {}, MONTHS[month], el('span', {}, String(closedInMonth))),
      el('div', { class: 'rp-qp__cal' }, ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map(letter => el('b', {}, letter)), Array.from({ length: lead }, () => el('i', { class: 'is-pad' })), cells));
  });
  box.replaceChildren(...months);
  const root = box.closest('.rp--quarter');
  const values = { closed: totals.closed, rate: Math.round((totals.closed / totals.planning) * 100), streak: best, mits: totals.mits, habit: Math.round((totals.kept / totals.days) * 100) };
  Object.entries(values).forEach(([name, value]) => qsa(`[data-q="${name}"]`, root).forEach(node => setCount(node, value)));
  const words = { closed: totals.closed, squares: totals.closed, planning: totals.planning, kept: totals.kept, 'mit-share': Math.round((totals.mits / totals.closed) * 100), 'habit-streak': habitBest };
  Object.entries(words).forEach(([name, value]) => qsa(`[data-q-text="${name}"]`, root).forEach(node => { node.textContent = String(value); }));
  qsa('[data-quarter-habit] li', root).forEach((row, index) => {
    row.style.setProperty('--w', String(habitMonths[index]));
    const label = qs('b', row);
    if (label) label.textContent = `${habitMonths[index]}%`;
  });
  root?.style.setProperty('--paint-steps', String(order));
}

/* Insights: when your time is scheduled, Monday to Sunday, 7:00 to 20:00 --- */

const INSIGHTS_HEAT = ['4155231002011', '0155231233123', '3155231002021', '0155231233123', '0111131003021', '0022200000000', '0023300000000'];

function buildHeat() {
  const box = qs('[data-insights-heat]');
  if (!box) return;
  const hours = Array.from({ length: 13 }, (_, index) => 7 + index);
  const head = [el('span', {}), ...hours.map(hour => el('span', { class: `rp-ins__hour${hour % 2 ? ' is-odd' : ''}` }, String(hour)))];
  const rows = INSIGHTS_HEAT.flatMap((levels, row) => [
    el('span', { class: 'rp-ins__day' }, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][row]),
    ...[...levels].map((level, column) => el('i', { class: `is-l${level}`, style: `--d:${row + column}` }))
  ]);
  box.replaceChildren(...head, ...rows);
}

function setCount(node, value) {
  if (!node) return;
  node.dataset.count = String(value);
  node.textContent = String(value);
}

function buildPaint() {
  const month = qs('[data-month]');
  if (month) {
    const cells = [];
    for (let day = 1; day <= 31; day += 1) cells.push(el('span', { class: `cell ${paintState(DEMO, DEMO.month, day)}` }));
    month.replaceChildren(...cells);
  }

  const grid = qs('[data-paint]');
  if (grid) {
    const { order, closed } = buildYear(grid, DEMO);
    setCount(qs('[data-paint-total]'), closed);
    qs('.rp--progress')?.style.setProperty('--paint-steps', String(order));
  }

  const review = qs('[data-review-paint]');
  if (review) {
    const { order, closed, mits } = buildYear(review, REVIEW);
    setCount(qs('[data-review-closed]'), closed);
    setCount(qs('[data-review-mits]'), mits);
    qs('.rp--review')?.style.setProperty('--paint-steps', String(order));
  }

  buildPrintMonths(PLAN_YEAR);
  buildQuarter(REVIEW.year);
  buildHeat();

  // Colours for the painted year: a whole year, every level of the palette,
  // without the jokers' own colour.
  const palettes = qs('[data-palette-year]');
  if (palettes) buildYear(palettes, { ...REVIEW, firstClosed: [0, 1], jokers: [] });
}

/* Scenes: replicas that play near the viewport and pause when they leave --- */

const SCRIPTS = {
  // The hero's two views, Your day and Your year (Horizon): a pointer plans
  // and closes the day, then shapes the year. Their cues are in hero-views.js,
  // next to how long each view stays.
  day: { length: HERO_SCRIPTS.day.length, loop: true, run: t => playCues(t, HERO_SCRIPTS.day.cues) },
  horizon: { length: HERO_SCRIPTS.horizon.length, run: t => playCues(t, HERO_SCRIPTS.horizon.cues) },
  close: {
    length: 13000,
    loop: true,
    run(t) {
      const [memory, lesson, next] = qsa('[data-type]', t.root);
      t.add('s-save', 900);
      t.add('s-forget', 1800);
      t.type(memory, 2700);
      t.type(lesson, 4000);
      t.add('s-press', 5800);
      t.remove('s-press', 6060);
      t.add('s-closed', 6200);
      t.type(next, 7000);
    }
  },
  week: { run(t) { t.add('s-in', 150); } },
  journal: {
    run(t) {
      t.add('s-in', 120);
      t.add('s-new', 1500);
    }
  },
  unresolved: {
    length: 9400,
    loop: true,
    run(t) {
      t.add('s-press-plan', 900);
      t.remove('s-press-plan', 1120);
      t.add('s-plan', 1120);
      t.add('s-press-save', 2700);
      t.remove('s-press-save', 2920);
      t.add('s-save', 2920);
      t.add('s-later', 4700);
    }
  },
  stats: {
    run(t) {
      t.add('s-in', 150);
      t.add('s-elapsed', 1250);
    }
  },
  search: {
    length: 7200,
    loop: true,
    run(t) {
      t.type(qs('[data-type]', t.root), 500);
      t.add('s-res', 1250);
    }
  },
  ribbon: { run(t) { t.add('s-in', 150); } },
  adventures: { run(t) { t.add('s-planned', 1200); } },
  progress: {
    run(t) {
      const steps = Number(t.root.style.getPropertyValue('--paint-steps')) || 150;
      const span = steps * 7;
      t.add('s-in', 100);
      qsa('[data-count]', t.root).forEach(node => t.count(node, 150, span));
      t.add('s-toast', span + 900);
    }
  },
  trophies: { run(t) { t.add('s-in', 250); } },
  sync: {
    length: 7400,
    loop: true,
    run(t) {
      t.add('s-finger', 400);
      t.add('s-tap', 1050);
      t.add('s-sync', 1500);
      t.add('s-done', 2900);
      t.remove('s-sync', 3300);
    }
  },
  yearplan: {
    length: 16800,
    loop: true,
    run(t) {
      t.type(qs('[data-type]', t.root), 600);
      t.add('s-when', 2100);
      t.add('s-2', 3300);
      t.add('s-3', 5400);
      t.add('s-4', 7700);
      t.add('s-5', 9700);
      t.add('s-6', 11600);
      t.add('s-7', 13600);
      t.add('s-press', 15200);
      t.remove('s-press', 15460);
    }
  },
  // The printout: the pen goes over it once (ticks, a circled day, two notes).
  print: { length: 4200, run(t) { t.add('s-ink', 500); } },
  review: {
    run(t) {
      const steps = Number(t.root.style.getPropertyValue('--paint-steps')) || 240;
      const span = steps * 4;
      t.add('s-in', 100);
      qsa('[data-count]', t.root).forEach(node => t.count(node, 150, span));
      t.add('s-bars', 500);
      t.add('s-notes', Math.round(span * 0.6) + 400);
      t.add('s-press', span + 1100);
      t.remove('s-press', span + 1360);
    }
  },
  // The quarter, printed: its days paint in, the figures count, the bars grow,
  // then the notes appear and a pen writes on the lines under each answer.
  quarter: {
    length: 5200,
    run(t) {
      const steps = Number(t.root.style.getPropertyValue('--paint-steps')) || 60;
      const span = steps * 14;
      t.add('s-in', 100);
      qsa('[data-count]', t.root).forEach(node => t.count(node, 150, span));
      t.add('s-bars', 450);
      t.add('s-notes', Math.round(span * 0.6) + 350);
      t.add('s-ink', span + 900);
    }
  },
  insights: { run(t) { t.add('s-in', 120); t.add('s-bars', 420); } }
};

/* Start -------------------------------------------------------------------- */

let motionOn = motionWanted();
const motionHooks = [];

function start() {
  // A partner's link (?ref=CODE) is remembered for a later purchase.
  if (apiOn) rememberReferral();

  renderYears();
  buildPaint();
  setupOffers();
  checkMember();
  setupCompare();
  setupBuyButtons(buy, { onReturn: hideMemberCheck });
  renderFooter();
  createPrivacyDialog({
    dialog: qs('[data-privacy-dialog]'),
    enabled: apiOn,
    moments: countedMoments(LANDING_EVENTS),
    partnerDays: PARTNER_PROGRAM.cookieDays,
    countsEnabled: () => usageCountsEnabled(),
    setCountsEnabled: on => setUsageCountsEnabled(on),
    reduceMotion: () => reduceQuery.matches
  });
  setupChrome();
  setupViewCounts();
  const scenes = setupScenes({ scripts: SCRIPTS, motionOn, motionHooks });
  setupHeroViews(qs('[data-hero-views]'), { scene: scenes.scene, motionOn, motionHooks });
  createPaletteCard(qs('[data-palette-card]'), { motion: () => motionOn });
  setupReveal({ motionOn, motionHooks });
  setupFaq();
  followMotion(motionHooks, on => { motionOn = on; });

  html.classList.add('js-ready');
  track('landing_viewed');
}

// A payment confirmation sent here instead of to the gift page.
const params = new URLSearchParams(location.search);
// The team gift moved to the Teams page (/teams/) and the question form to the
// Contact page (/contact/): their old addresses (?ask=question → /contact/;
// another ?ask=…, #request, #teams, #team-prices, #seats → /teams/) lead there.
// The inline script in <head> already did this before first paint; this is the fallback.
const movedTo = movedAddress({ path: location.pathname, search: location.search, hash: location.hash });
if (params.get('checkout_id') || params.get('session')) location.replace(`./thanks/${location.search}`);
else if (movedTo) location.replace(movedTo);
else start();
