import { qs, qsa } from '../lib/dom.js';
import { ymdKey } from '../lib/dates.js';
import { esc, escAttr, safeUrl } from '../lib/text.js';
import { activatePlusToken, hasPlus, isCheckoutReference, normalizeGiftCode, onPlusChange, parsePlusInput, plusAvailable, plusLicense, plusSettings, plusStatusLine } from '../lib/plus.js';
import { CURRENCIES, LAUNCH, PERSONAL_GIFTS, PLUS_PRICE, PLUS_UPCOMING, detectCurrency, formatMoney, isPersonalGift, memberGiftPrice, memberPriceNotice, memberPriceShown, validCurrency } from '../lib/pricing.js';
import { checkoutOptions, claimPurchase, dismissPartnerHint, fetchGift, partnerHintShown, plannerApiEnabled, redeemGift, rememberReferral, startCheckout, trackEvent } from '../lib/planner-api.js';
import { AFFILIATE_COMMISSION } from '../config.js';
import { requestPlusCheck } from './plus-check.js';
import { burst, panelEnter, pulse } from '../ui/motion.js';
import { readPaint, resolvePaint } from './paint-palettes.js';
import { paintRows, recentWeeks, renderPaletteTry } from './plus-previews.js';
import { createPlusCycle, cycleStepFor } from './plus-cycle.js';
import { renderRhythmTry, rhythmPreview } from './plus-insights.js';
import { defaultPlanYear } from './year-plan.js';

/**
 * The "Daily Planner Plus" dialog and its arrivals.
 *
 * One dialog shows, in turn: what Plus adds — the offer beside the title (the
 * price, Get Plus: a Creem checkout, and a field for a gift link, code or
 * licence), the yearly ritual it gives (Plan it, Print it, Check in, Look
 * back: plus-cycle.js, with the real printed pages), Insights and the
 * palettes, what is coming to Plus at no extra cost (while anything is), with
 * Get Plus in a bar once the offer has scrolled away — or, with Plus, a calm
 * "You have Plus" whose steps and rows open each feature and a bar with Done; a gift ("A gift from Acme Studio"), a purchase being
 * confirmed, a calm explanation when something can't be done, and a small
 * celebration once Plus is active.
 *
 * It opens on top of whatever dialog is showing — setup, Settings, Horizon —
 * and returns to it when closed. Links that arrive with `?gift=`,
 * `?checkout_id=` (back from the payment page), `?purchase=` (the receipt
 * email) or `?license=` are handled by handleLaunch() and removed from the
 * address bar straight away.
 */

const PENDING_PURCHASE_KEY = 'daily-planner-ui:plus-pending-purchase';
// A gift licence the server issued but this device couldn't check yet: kept so
// the seat it used isn't lost, and tried again at the next launch.
const UNVERIFIED_GIFT_KEY = 'daily-planner-ui:plus-unverified-gift';
const SITE = 'https://planner.bemorin.com';
// Parameters the payment page adds to the return address; none is needed once read.
const RETURN_PARAMS = ['gift', 'purchase', 'license', 'checkout_id', 'order_id', 'customer_id', 'product_id', 'request_id', 'signature'];

const ICONS = {
  spark: '<path d="M12 3.6 13.9 9l5.5 1.9-5.5 1.9L12 18.3l-1.9-5.5-5.5-1.9L10.1 9Z"/><path d="M18.6 3.8v3.4M16.9 5.5h3.4"/>',
  plan: '<path d="M4 6.5 9 4.5l6 2 5-2v13l-5 2-6-2-5 2Z"/><path d="M9 4.5v13M15 6.5v13"/>',
  review: '<rect x="5" y="3.5" width="14" height="17" rx="2"/><path d="M8.5 8h7M8.5 11.5h7M8.5 15h4"/>',
  quarter: '<rect x="4" y="5" width="16" height="15" rx="2.2"/><path d="M8 3v4M16 3v4M4 10h16"/><path d="m9.3 14.7 1.9 1.9 3.6-3.8"/>',
  chart: '<path d="M4 20h16"/><path d="M7.5 16.5v-5M12 16.5V6.5M16.5 16.5v-8"/>',
  paint: '<path d="M12 3.8a8.2 8.2 0 1 0 0 16.4c1.3 0 1.9-.9 1.9-1.8 0-1.2-1-1.6-1-2.6 0-1 .8-1.6 1.8-1.6h1.8a3.5 3.5 0 0 0 3.5-3.5c0-3.8-3.6-6.9-8-6.9Z"/><circle cx="7.8" cy="11" r="1" class="icon-fill"/><circle cx="10.3" cy="7.6" r="1" class="icon-fill"/><circle cx="14.6" cy="7.8" r="1" class="icon-fill"/>',
  gift: '<rect x="4" y="9" width="16" height="11" rx="1.6"/><path d="M3 9h18M12 9v11M12 9c-1.4-3.4-5.6-4.3-5.6-1.7C6.4 8.8 9 9 12 9Zm0 0c1.4-3.4 5.6-4.3 5.6-1.7 0 1.5-2.6 1.7-5.6 1.7Z"/>',
  share: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  close: '<path d="m7 7 10 10M17 7 7 17"/>',
  check: '<path d="m6.5 12.5 3.3 3.3 7.7-8"/>',
  team: '<circle cx="9" cy="8.5" r="3"/><path d="M3.5 19c.6-3 2.8-4.6 5.5-4.6s4.9 1.6 5.5 4.6"/><circle cx="16.5" cy="9.5" r="2.4"/><path d="M15.4 14.5c2.5-.3 4.5 1 5.1 3.8"/>',
  notice: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.8v5M12 16.2h.01"/>',
  offline: '<path d="M2.5 8.8a14 14 0 0 1 19 0M5.6 12.2a9.5 9.5 0 0 1 12.8 0M8.8 15.6a4.8 4.8 0 0 1 6.4 0M12 19h.01"/><path d="m4 4 16 16"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

/** The one muted line under the price: the currency is the buyer's (euro area: EUR, elsewhere: USD), taxes included. */
export const currencyNote = currency => (currency === 'EUR' ? 'Prices in euros, taxes included.' : 'Prices in US dollars, taxes included.');

/**
 * A personal gift button: "Give Plus — €29", "Plus Family — up to 5 people — €99";
 * for a member, the member price: "Give Plus — member price €24, was €29".
 */
export function giftLabel(gift, currency, { member = false } = {}) {
  const price = formatMoney(gift.price?.[currency], currency);
  const reduced = member ? memberGiftPrice(gift.plan, currency) : null;
  const amount = reduced != null && reduced < gift.price?.[currency] ? `member price ${formatMoney(reduced, currency)}, was ${price}` : price;
  return gift.seats > 1 ? `${gift.label} — up to ${gift.seats} people — ${amount}` : `${gift.label} — ${amount}`;
}

/** What a partner earns: “30% of every purchase …” with a commission configured, “a commission on every purchase …” without. */
export const partnerEarnText = (commission = AFFILIATE_COMMISSION) => (commission ? `${commission} of every purchase made through your link` : 'a commission on every purchase made through your link');

/** Who a gift is from, as a sentence reads it: the server's fallbacks ("A friend", "Your family") in lower case. */
export function giverName(org) {
  const name = String(org || '').trim();
  return name === 'A friend' || name === 'Your family' ? name.toLowerCase() : name;
}

/**
 * What Plus adds, in the order the dialog lists it. Ids match the Plus feature
 * modules; `plural` titles read “… come with Plus.”
 */
export const PLUS_FEATURES = Object.freeze([
  { id: 'year-plan', icon: 'plan', title: 'Plan your year', text: 'A guided half hour that fills Horizon — Misogi, milestones, adventures, commitments, habits and key dates — and prints your year on one page.' },
  { id: 'quarter-review', icon: 'quarter', title: 'Quarterly check-ins', plural: true, text: 'A guided ten minutes as each quarter ends: look back, choose the next habit and print the quarter on one page.' },
  { id: 'year-review', icon: 'review', title: 'Your year in review', text: 'One printable page with the days you closed, your painted year, streaks, trophies, main outcomes and what you lived.' },
  { id: 'insights', icon: 'chart', title: 'Insights', plural: true, text: 'Which weekdays work best for you, when your focus really happens, where your hours go month by month and how this year compares with the last. Worked out on this device.' },
  { id: 'paint-palettes', icon: 'paint', title: 'Colours for your painted year', plural: true, text: 'Five more palettes for Progress and your review. Terracotta stays free for everyone.' }
]);
const UPCOMING_STATUS = { Next: 'next', Planned: 'planned', Exploring: 'exploring' };
/** What Plus gives, in four short lines beside the offer. */
export const PLUS_POINTS = Object.freeze(['A guided half hour to plan your year, printed on one page', 'A ten-minute check-in each quarter, and your year in review', 'Insights into your weekdays, focus hours and time', 'Paid once: everything Plus gets later is included']);

/** The headline when the dialog opens on one feature: “Plan your year comes with Plus.”, “Insights come with Plus.” */
export const featureHeadline = feature => `${feature.title} ${feature.plural ? 'come' : 'comes'} with Plus.`;
const FEATURE_ALIASES = { plan: 'year-plan', 'plan-year': 'year-plan', review: 'year-review', 'year-in-review': 'year-review', quarter: 'quarter-review', quarterly: 'quarter-review', 'check-in': 'quarter-review', 'quarter-check-in': 'quarter-review', insight: 'insights', statistics: 'insights', 'advanced-stats': 'insights', paint: 'paint-palettes', palettes: 'paint-palettes', palette: 'paint-palettes', colours: 'paint-palettes', colors: 'paint-palettes' };

/** The canonical feature id for unlock(feature), or ''. */
export function plusFeatureId(name) {
  const key = String(name || '').trim().toLowerCase();
  if (PLUS_FEATURES.some(feature => feature.id === key)) return key;
  return FEATURE_ALIASES[key] || '';
}

/**
 * Calm explanations for what can go wrong with a gift or a purchase (pure;
 * unit-tested). `retry` offers Try again; `keep` means a purchase stays
 * pending and is tried again at the next launch.
 */
export function plusProblem(kind, result = {}, { org = '' } = {}) {
  const name = String(org || '').trim();
  const from = name && giverName(name) === name ? ` Ask ${name}` : ' Ask the person who sent it';
  if (result.unavailable) return { icon: 'notice', title: kind === 'purchase' ? 'This copy can’t confirm purchases' : 'Open this gift at planner.bemorin.com', text: kind === 'purchase' ? 'This copy of the planner isn’t connected to Daily Planner’s payments. Open the link from your receipt at planner.bemorin.com.' : 'This copy of the planner isn’t connected to the gift service. Open the same link on planner.bemorin.com to activate it there.', site: true };
  if (result.status === 0) return { icon: 'offline', title: result.offline ? 'You’re offline' : 'The planner couldn’t be reached', text: kind === 'purchase' ? 'Your payment is safe. Plus will be activated as soon as the planner can reach the server — now with Try again, or next time you open it.' : 'Connect to the internet and try again. The gift link keeps working.', retry: true, keep: true };
  if (kind === 'purchase') {
    // A purchase link that will never work (HTTP 410: refunded, switched off, a test purchase, an expired
    // checkout) is explained in the server's words, neither tried again nor kept pending.
    const said = String(result.error || '').trim();
    if (result.refunded) return { icon: 'notice', title: 'This purchase was refunded', text: said || 'Its Plus was switched off. If this is a mistake, reply to your receipt email.' };
    if (result.status === 410) {
      const title = result.test || /test purchase/i.test(said) ? 'This was a test purchase'
        : result.expired || /expired/i.test(said) ? 'This checkout expired'
          : result.revoked ? 'This purchase was switched off' : 'This purchase can’t be activated';
      return { icon: 'notice', title, text: said || 'If you were charged, reply to your receipt email and we’ll sort it out.' };
    }
    if (result.status === 402) return { icon: 'notice', title: 'Your payment isn’t complete yet', text: 'The payment hasn’t been confirmed yet — this usually takes a moment. Try again shortly; the planner will also try again the next time you open it.', retry: true, keep: true };
    if (result.status === 404) return { icon: 'notice', title: 'We couldn’t find this purchase', text: 'The link from the payment page may be incomplete. If you were charged, reply to your receipt email and we’ll sort it out.' };
    if (result.status === 503) return { icon: 'notice', title: 'Purchases can’t be confirmed right now', text: 'Your payment is safe. The planner will try again the next time you open it.', retry: true, keep: true };
    return { icon: 'notice', title: 'Something went wrong', text: `${result.error || 'The purchase couldn’t be confirmed.'} Your payment is safe — try again in a moment.`, retry: true, keep: true };
  }
  if (result.status === 404) return { icon: 'notice', title: 'We couldn’t find this gift', text: `Check that the whole link was copied — gift codes look like ABCD‑EFGH‑JKMN.${from} if it still doesn’t work.` };
  if (result.status === 409 || result.claimed) return { icon: 'gift', title: 'This gift has been fully claimed', text: `Every place in this gift has been used.${from} whether more can be added — or get Plus for yourself.`, overview: true };
  if (result.inactive || (result.status === 410 && /no longer active/i.test(String(result.error || '')))) return { icon: 'gift', title: 'This gift link is no longer active', text: `It was switched off by the people who bought it.${from} about it — or get Plus for yourself.`, overview: true };
  if (result.status === 410 || result.expired) return { icon: 'gift', title: 'This gift link has expired', text: `Gift links can be activated for a year after they’re created.${from} for a new one.`, overview: true };
  if (result.status === 503) return { icon: 'notice', title: 'Gifts can’t be activated right now', text: 'The gift service isn’t ready yet. Your link keeps working — try again a little later.', retry: true };
  return { icon: 'notice', title: 'Something went wrong', text: `${result.error || 'The gift couldn’t be opened.'} Try again in a moment.`, retry: true };
}

function readPending() { try { return localStorage.getItem(PENDING_PURCHASE_KEY) || ''; } catch (_) { return ''; } }
function writePending(checkout) { try { if (checkout) localStorage.setItem(PENDING_PURCHASE_KEY, checkout); else localStorage.removeItem(PENDING_PURCHASE_KEY); } catch (_) {} }

/** Where Get Plus may send the browser: an http(s) checkout page, or a page of this site. */
export function checkoutHref(url) {
  const value = String(url || '').trim();
  if (/^https?:\/\//i.test(value)) return safeUrl(value);
  return /^\/(?!\/)/.test(value) ? value : '';
}
function readUnverifiedGift() { try { const value = JSON.parse(localStorage.getItem(UNVERIFIED_GIFT_KEY) || 'null'); return value && typeof value.license === 'string' ? value : null; } catch (_) { return null; } }
function writeUnverifiedGift(value) { try { if (value) localStorage.setItem(UNVERIFIED_GIFT_KEY, JSON.stringify(value)); else localStorage.removeItem(UNVERIFIED_GIFT_KEY); } catch (_) {} }

/**
 * @param {object} options
 * @param {() => ({ plan?: object, progress?: object, print?: Function, review?: Function }|null)} [options.preview]
 *   what the previews are drawn from: planSummary() for the year to plan, the progress model of this year,
 *   print(year) the input of buildYearPrintModel() and review(year) the inputs of buildYearReview()
 * @param {(feature: string) => void} [options.openFeature] opens a Plus feature (with Plus: each step's action)
 * @param {(year: number) => void} [options.printYear] prints a year on one page (with Plus: "Print the year")
 */
export function createPlusFeature({ openModal, closeModal, getActiveModal = () => null, openPrivacy = null, flush = () => {}, preview = () => null, openFeature = null, printYear = null, locale = () => globalThis.navigator?.languages?.[0] || globalThis.navigator?.language || 'en-US' }) {
  const modal = () => qs('[data-plus-modal]');
  const root = () => qs('[data-plus]');
  let view = { stage: 'overview' };
  // The bar with Get Plus shows once the offer's own button has scrolled out of view.
  let barShown = false;
  let offerObserver = null;
  const leaveFor = feature => { closeModal(modal()); setTimeout(() => openFeature?.(feature), 200); };
  const cycle = createPlusCycle({
    modal,
    data: preview,
    palette: () => resolvePaint(readPaint(), hasPlus()),
    onAction: (action, year) => {
      if (action === 'print') printYear?.(year);
      else leaveFor({ review: 'year-review', quarter: 'quarter-review' }[action] || 'year-plan');
    }
  });
  // What can be bought right now ({ plus: [...], gift: [...] }); null until asked, a list is null when unknown.
  let options = null;
  // The buyer's currency: the server's choice from their country once it answers, a guess from the browser's languages until then.
  let currency = detectCurrency();

  const isOpen = () => !modal()?.hidden && modal()?.classList.contains('is-open');
  const price = (value = currency) => formatMoney(PLUS_PRICE[value], value);
  const statusLine = () => {
    const license = plusLicense();
    const gift = plusSettings().plusGift;
    return plusStatusLine(license && { ...license, org: giverName(license.org) }, { gift: gift && { ...gift, org: giverName(gift.org) }, activatedAt: plusSettings().plus?.activatedAt, locale: locale() });
  };
  const buyable = (item = 'plus') => (options === null ? 'loading' : options[item] === null || options[item]?.includes(currency) ? 'yes' : 'no');
  const giftsOffered = () => plannerApiEnabled() && plusAvailable() && buyable('gift') !== 'no';

  function featureList(focus = '', { compact = false } = {}) {
    return `<ul class="plus-features${compact ? ' plus-features--compact' : ''}">${PLUS_FEATURES.map(feature => `<li class="plus-feature plus-feature--${feature.id}${feature.id === focus ? ' is-focus' : ''}" data-plus-feature="${feature.id}"><span class="plus-feature__icon">${icon(feature.icon)}</span><span><strong>${esc(feature.title)}</strong>${compact ? '' : `<small>${esc(feature.text)}</small>`}</span></li>`).join('')}</ul>`;
  }

  /** One row of Also with Plus: its icon, what it is, Open (with Plus) and a small preview. */
  function extra(feature, { focus, active, kind, hint = '', note = '', preview: art = '' }) {
    return `<div class="plus-extra plus-extra--${kind}${focus === feature.id ? ' is-focus' : ''}" data-plus-feature="${feature.id}">
        <span class="plus-extra__icon">${icon(feature.icon)}</span>
        <span class="plus-extra__copy"><strong>${esc(feature.title)}</strong><small>${esc(feature.text)}${hint ? ` ${esc(hint)}` : ''}</small>${note}${active && openFeature ? `<button class="text-button plus-extra__open" type="button" data-plus-open-feature="${feature.id}">Open<span class="sr-only"> ${esc(feature.title)}</span></button>` : ''}</span>
        ${art}
      </div>`;
  }

  /**
   * Also with Plus: Insights, previewed by its weekday chart on this planner's
   * last twelve weeks (or Insights' sample), and the palettes, tried on the last
   * weeks of the painted year (or a sample).
   */
  function also(focus, active) {
    let data = null;
    try { data = preview() || null; } catch (_) { data = null; }
    const insights = PLUS_FEATURES.find(item => item.id === 'insights');
    let rhythm = null;
    try { rhythm = rhythmPreview(data?.insights || null, { todayKey: ymdKey(new Date()) }); } catch (_) { rhythm = null; }
    const finding = rhythm && !rhythm.sample && rhythm.finding ? `<span class="plus-extra__finding"><span class="plus-extra__tag">Your last ${rhythm.weeks} weeks</span>${esc(rhythm.finding.text)}</span>` : '';
    const year = data?.progress?.year || new Date().getFullYear();
    const paint = paintRows(data?.progress || null);
    const palette = PLUS_FEATURES.find(item => item.id === 'paint-palettes');
    const hint = active ? 'Choose yours in Horizon, under Progress.' : paint.sample ? 'Tap a colour to try it on these weeks.' : 'Tap a colour to see your last weeks in it.';
    return `<section class="plus-also" aria-labelledby="plus-also-title">
        <h3 class="plus-also__title" id="plus-also-title">Also with Plus</h3>
        <div class="plus-extras">
          ${extra(insights, { focus, active, kind: 'insights', hint: rhythm?.sample ? 'Here on a sample planner.' : '', note: finding, preview: rhythm ? renderRhythmTry(rhythm) : '' })}
          ${extra(palette, { focus, active, kind: 'palettes', hint, preview: renderPaletteTry(recentWeeks(paint.rows, { year }), { current: resolvePaint(readPaint(), active) }) })}
        </div>
      </section>`;
  }

  /** Coming to Plus, while anything is promised (PLUS_UPCOMING); nothing at all when the list is empty. */
  function upcoming(active) {
    if (!PLUS_UPCOMING.length) return '';
    const items = PLUS_UPCOMING.map(item => `<li><span class="plus-upcoming__copy"><strong>${esc(item.title)}</strong><small>${esc(item.text)}</small></span><em class="plus-chip plus-chip--${UPCOMING_STATUS[item.status] || 'planned'}">${esc(item.status)}</em></li>`).join('');
    return `<section class="plus-upcoming" aria-labelledby="plus-upcoming-title">
        <h3 id="plus-upcoming-title">Coming to Plus <span>— included, no extra cost</span></h3>
        <ul>${items}</ul>
        <p class="plus-promise">${icon('check')}<span>${active ? 'Yours when they ship: everything Plus gets later is included.' : 'Buy once: everything Plus gets later is yours.'}</span></p>
      </section>`;
  }

  /**
   * Personal gifts, below the main action: quiet, for someone else or a
   * household. With Plus, each shows its member price beside the usual one;
   * the server checks the licence and charges it (MEMBER_GIFT_DISCOUNT).
   */
  function gifts() {
    if (!giftsOffered()) return '';
    const member = hasPlus();
    const waiting = buyable('gift') === 'loading' || !!view.buying || !!view.confirm;
    const buttons = PERSONAL_GIFTS.map(gift => {
      const busy = view.buying === gift.plan;
      const normal = gift.price?.[currency];
      const reduced = member ? memberGiftPrice(gift.plan, currency) : null;
      const name = gift.seats > 1 ? `${gift.label} — up to ${gift.seats} people` : gift.label;
      const price = reduced != null && reduced < normal
        ? `<span class="plus-gifts__price"><b>${esc(formatMoney(reduced, currency))}</b><s>${esc(formatMoney(normal, currency))}</s></span>`
        : `<span class="plus-gifts__price"><b>${esc(formatMoney(normal, currency))}</b></span>`;
      const label = busy ? '<span>Opening checkout…</span>' : `<span>${esc(name)}</span>${price}`;
      return `<button class="secondary-button plus-gifts__buy" type="button" data-plus-gift="${gift.plan}" aria-label="${escAttr(busy ? 'Opening checkout…' : giftLabel(gift, currency, { member }))}"${waiting ? ' disabled' : ''}${busy ? ' aria-busy="true"' : ''}>${icon(gift.seats > 1 ? 'team' : 'gift')}${label}</button>`;
    }).join('');
    const lead = member
      ? '<span>You get a link to send. Plus is theirs for life once they open it, any time within a year. As a Plus member, you pay less.</span>'
      : '<span>You get a link to send. Plus is theirs for life once they open it, any time within a year.</span>';
    return `<section class="plus-gifts${member ? ' plus-gifts--member' : ''}" aria-labelledby="plus-gifts-title">
        <p class="plus-gifts__lead"><strong id="plus-gifts-title">Give Plus to someone${member ? ' <em class="plus-gifts__badge">Member price</em>' : ''}</strong>${lead}</p>
        <div class="plus-gifts__row">${buttons}</div>
        ${view.giftError ? `<p class="plus-inline-error" role="alert">${esc(view.giftError)}</p>` : ''}
        ${memberCheck()}
      </section>`;
  }

  /** The question about the member price, in the middle of the dialog: never under its sticky bar. */
  const showMemberCheck = () => qs('[data-plus-member-check]', root())?.scrollIntoView({ block: 'center' });

  /** The member price shown wasn't confirmed by the checkout: said before paying, with Continue or Cancel. */
  function memberCheck() {
    const check = view.confirm;
    if (!check) return '';
    return `<div class="plus-member-check" data-plus-member-check>
        <p role="alert">${esc(check.text)}</p>
        <div class="plus-member-check__actions">
          <button class="text-button" type="button" data-plus-member-cancel${check.leaving ? ' disabled' : ''}>Cancel</button>
          <button class="primary-button" type="button" data-plus-member-continue${check.leaving ? ' disabled aria-busy="true"' : ''}>${check.leaving ? 'Opening checkout…' : 'Continue'}</button>
        </div>
      </div>`;
  }

  /** With Plus: a quiet card about the partner program, until it is dismissed or followed on this device. */
  function partnerCard() {
    if (!hasPlus() || !partnerHintShown('plus')) return '';
    return `<aside class="plus-partner" aria-labelledby="plus-partner-title" data-plus-partner>
        <span class="plus-partner__icon">${icon('share')}</span>
        <p class="plus-partner__copy"><strong id="plus-partner-title">Recommend Daily Planner</strong><span>Know people who would like it? As a partner, you share your own link and earn ${esc(partnerEarnText())}.</span></p>
        <a class="secondary-button plus-partner__go" href="./welcome/partners/" target="_blank" rel="noopener" data-plus-partner-go>Partner program</a>
        <button class="icon-button plus-partner__close" type="button" data-plus-partner-dismiss aria-label="Hide the partner program">${icon('close')}</button>
      </aside>`;
  }

  function redeemForm() {
    if (!view.redeemOpen) return '';
    return `<form class="plus-redeem__form" data-plus-redeem-form novalidate>
        <label class="sr-only" for="plus-redeem-input">Gift link, gift code or licence</label>
        <input id="plus-redeem-input"${view.inputError ? ' class="is-invalid" aria-invalid="true" aria-describedby="plus-redeem-error"' : ''} name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="Gift link, code or licence" value="${escAttr(view.input || '')}">
        <button class="secondary-button" type="submit" data-plus-redeem-submit>Activate</button>
      </form>
      ${view.inputError ? `<p class="plus-inline-error" id="plus-redeem-error" role="alert">${esc(view.inputError)}</p>` : ''}`;
  }

  /**
   * The price as one unit, "€29 once, for life", with the currency said once,
   * quietly, under it. During the launch (LAUNCH in pricing.js) a small badge
   * says it is the launch price, and one line what comes after it.
   */
  function priceBlock() {
    const launch = LAUNCH.active ? `<p class="plus-launch"><span class="plus-launch__badge">${esc(LAUNCH.label)}</span></p>` : '';
    const after = LAUNCH.active ? `<p class="plus-launch__after">${esc(LAUNCH.after)}</p>` : '';
    return `${launch}<p class="plus-price"><strong>${esc(price())}</strong><span>once, for life</span></p>
      ${after}${plusAvailable() ? `<p class="plus-currency-note">${esc(currencyNote(currency))}</p>` : ''}`;
  }

  /** Get Plus, in the offer (`top`) and in the bar that follows the scroll (`bar`). */
  function buyButton(place) {
    if (buyable() === 'no') return '<button class="primary-button plus-cta__buy" type="button" disabled>Coming soon</button>';
    const waiting = buyable() === 'loading';
    const busy = view.buying === 'plus';
    return `<button class="primary-button plus-cta__buy" type="button" data-plus-checkout="${place}"${view.buying || waiting ? ' disabled' : ''}${busy || waiting ? ' aria-busy="true"' : ''}>${esc(busy ? 'Opening checkout…' : 'Get Plus')}</button>`;
  }

  /** The offer beside the title: the price, Get Plus and the way in for a gift link or a licence. */
  function offer() {
    if (!plusAvailable()) return `<div class="plus-offer">${priceBlock()}</div>`;
    return `<div class="plus-offer" data-plus-offer>
        ${priceBlock()}
        <div class="plus-cta">
          ${buyButton('top')}
          ${view.buyError ? `<p class="plus-inline-error" role="alert">${esc(view.buyError)}</p>` : buyable() === 'no' ? '<p class="plus-cta__note">Payments open soon. A gift link or a licence already works.</p>' : ''}
          <button class="text-button plus-cta__redeem" type="button" data-plus-redeem-toggle aria-expanded="${!!view.redeemOpen}">Have a gift link or a licence?</button>
          ${redeemForm()}
        </div>
      </div>`;
  }

  /** Get Plus stays in reach once the offer has scrolled away (watchOffer() shows it). */
  function bar() {
    if (!plusAvailable() || buyable() === 'no') return '';
    return `<div class="plus-bar${barShown ? ' is-shown' : ''}" data-plus-bar>
        <p class="plus-bar__price">${LAUNCH.active ? `<span class="plus-launch__badge plus-bar__badge">${esc(LAUNCH.label)}</span>` : ''}<strong>${esc(price())}</strong><span>once, for life</span></p>
        ${buyButton('bar')}
      </div>`;
  }

  function watchOffer(el) {
    offerObserver?.disconnect();
    offerObserver = null;
    const barEl = qs('[data-plus-bar]', el);
    const target = qs('[data-plus-checkout="top"]', el) || qs('[data-plus-offer]', el);
    if (!barEl || !target) return;
    const show = shown => { barShown = shown; barEl.classList.toggle('is-shown', shown); };
    if (!globalThis.IntersectionObserver) { show(true); return; }
    offerObserver = new IntersectionObserver(([entry]) => show(!entry.isIntersecting), { root: el, threshold: 0 });
    offerObserver.observe(target);
  }

  function overview() {
    const focus = PLUS_FEATURES.find(feature => feature.id === view.feature);
    const active = hasPlus();
    const footer = `<p class="plus-teams"><span class="plus-teams__icon">${icon('team')}</span><span>Buying for a team? <a href="./welcome/#teams" target="_blank" rel="noopener">Give Plus to your people</a> — one link for everyone, as a year‑end gift.</span></p>
      ${openPrivacy && plannerApiEnabled() && plusAvailable() ? '<p class="privacy-footnote">Plus is checked on this device — no account. <button class="privacy-link" type="button" data-plus-privacy>How this is handled</button></p>' : ''}`;
    if (active) {
      return `<header class="modal__header plus-header">
          <p class="modal__eyebrow plus-eyebrow"><span class="plus-mark">${icon('spark')}</span>Daily Planner Plus</p>
          <h2 id="plus-title">You have Plus.</h2>
          <p class="plus-status plus-status--header" role="status">${icon('check')}<span>${esc(statusLine())}</span></p>
          <p class="plus-lede">Thank you for supporting Daily Planner. Plus is yours for life, on this planner and every device it syncs to.</p>
        </header>
        ${cycle.markup({ step: view.step, active: true })}
        ${also(focus?.id || '', true)}
        ${upcoming(true)}
        ${gifts()}
        ${partnerCard()}
        ${footer}
        <div class="plus-bar plus-bar--done is-shown"><button class="primary-button plus-cta__buy" type="button" data-plus-close>Done</button></div>`;
    }
    const title = focus ? featureHeadline(focus) : `Make ${defaultPlanYear(new Date())} count.`;
    const unavailable = plusAvailable() ? '' : '<p class="plus-note" role="note">Daily Planner Plus isn’t available in this copy of the planner. It’s offered at <a href="https://planner.bemorin.com" target="_blank" rel="noopener">planner.bemorin.com</a> — everything you use here stays free.</p>';
    return `<header class="modal__header plus-header plus-header--offer">
        <div class="plus-header__copy">
          <p class="modal__eyebrow plus-eyebrow"><span class="plus-mark">${icon('spark')}</span>Daily Planner Plus</p>
          <h2 id="plus-title">${esc(title)}</h2>
          <p class="plus-lede">Plus adds a yearly ritual to your planner: plan the year, print it, check in each quarter and look back. The planner itself stays free.</p>
          <ul class="plus-points">${PLUS_POINTS.map(point => `<li>${icon('check')}<span>${esc(point)}</span></li>`).join('')}</ul>
        </div>
        ${offer()}
        ${unavailable}
      </header>
      ${cycle.markup({ step: view.step, active: false })}
      ${also(focus?.id || '', false)}
      ${upcoming(false)}
      ${plusAvailable() ? gifts() : ''}
      ${footer}
      ${bar()}`;
  }

  async function loadOptions() {
    if (!plannerApiEnabled() || !plusAvailable()) { options = { plus: [], gift: [] }; return; }
    const result = await checkoutOptions();
    const list = value => (Array.isArray(value) ? value.filter(code => CURRENCIES.includes(code)) : []);
    if (result.ok) {
      options = { plus: list(result.plus), gift: list(result.gift) };
      // The server decides from the buyer's country; when it can't tell, show a price that can be paid.
      const chosen = validCurrency(result.currency);
      if (chosen) currency = chosen;
      else if (options.plus.length && !options.plus.includes(currency)) currency = options.plus[0];
    } else if (!options) options = { plus: null, gift: null };
    if (isOpen() && view.stage === 'overview') render({ focus: false });
  }

  /** Get Plus (`plan` empty; `place` is the button used) or a personal gift ('gift-1', 'family-5'): off to the Creem checkout. */
  async function buy(plan = '', place = 'top') {
    const item = plan ? 'gift' : 'plus';
    if (view.buying || buyable(item) === 'no') return;
    view = { ...view, buying: plan || 'plus', buyError: '', giftError: '' };
    render({ focus: false });
    trackEvent('plus_checkout_clicked');
    flush();
    // A member's gift: the licence goes along, so the server can check it and charge the member price.
    const license = plan && hasPlus() ? plusSettings().plus?.token || '' : '';
    const shown = !!plan && memberPriceShown(plan, currency, hasPlus());
    const result = await startCheckout(plan ? { item, plan, currency, license } : { item, currency });
    const href = result.ok ? checkoutHref(result.url) : '';
    // The member price was shown but the server charges the usual one (a refunded licence, say): ask first,
    // and check the licence now, so the dialog follows what the server knows.
    const text = href && plan ? memberPriceNotice(plan, currency, { shown, confirmed: result.member === true }) : '';
    if (text) {
      view = { ...view, buying: false, confirm: { plan, href, text } };
      render({ focus: false });
      showMemberCheck();
      qs('[data-plus-member-continue]', root())?.focus({ preventScroll: true });
      requestPlusCheck();
      return;
    }
    if (href) { globalThis.location.assign(href); return; }
    const error = result.error && !result.ok ? result.error : 'The checkout could not be opened. Please try again in a minute.';
    view = { ...view, buying: false, [plan ? 'giftError' : 'buyError']: error };
    render({ focus: false });
    // The error shows in the offer: from the bar, focus goes back up to it.
    qs(plan ? `[data-plus-gift="${plan}"]` : '[data-plus-checkout="top"]', root())?.focus({ preventScroll: !!plan || place !== 'bar' });
  }

  function previewPalette(el, button) {
    const id = button.dataset.plusPalette;
    const grid = qs('[data-plus-palette-grid]', el);
    if (!grid || !id) return;
    grid.className = `plus-weeks hz-palette hz-palette--${id}`;
    qsa('[data-plus-palette]', el).forEach(swatch => { const on = swatch === button; swatch.classList.toggle('is-active', on); swatch.setAttribute('aria-pressed', String(on)); });
    const name = qs('[data-plus-palette-name]', el);
    if (name) name.textContent = button.dataset.tooltip || '';
  }

  function sheet({ mark = 'notice', tone = '', eyebrow = '', title, body = '', buttons = '' }) {
    return `<div class="plus-sheet${tone ? ` plus-sheet--${tone}` : ''}">
        <span class="plus-sheet__mark">${icon(mark)}</span>
        ${eyebrow ? `<p class="modal__eyebrow">${esc(eyebrow)}</p>` : ''}
        <h2 id="plus-title">${esc(title)}</h2>
        ${body}
        <div class="plus-sheet__actions">${buttons}</div>
      </div>`;
  }

  function giftView() {
    const { gift, busy, error } = view;
    const org = giverName(gift.org);
    const owned = hasPlus();
    return `<div class="plus-gift">
        <span class="plus-gift__mark">${icon('gift')}</span>
        <p class="modal__eyebrow">A gift for you</p>
        <h2 id="plus-title">${esc(org ? `A gift from ${org}` : 'A gift of Daily Planner Plus')}</h2>
        ${gift.message ? `<blockquote class="plus-gift__message">${esc(gift.message)}${gift.org ? `<cite>— ${esc(gift.org)}</cite>` : ''}</blockquote>` : ''}
        <p class="plus-gift__lead">Daily Planner Plus, for life — on this planner and the devices it syncs to.</p>
        ${featureList('', { compact: true })}
        ${owned ? '<p class="plus-note" role="note">Plus is already active on this planner, so there’s no need to use a place in this gift — keep it for someone else.</p>' : ''}
        ${error ? `<p class="plus-inline-error" role="alert">${esc(error)}</p>` : ''}
        <div class="plus-sheet__actions">
          <button class="text-button" type="button" data-plus-close>${owned ? 'Close' : 'Later'}</button>
          ${owned ? '' : `<button class="primary-button" type="button" data-plus-redeem-gift${busy ? ' disabled aria-busy="true"' : ''}>${busy ? 'Activating…' : 'Activate Plus'}</button>`}
        </div>
        <p class="plus-fine">No account and no name needed. Activating uses one of the gift’s places.</p>
      </div>`;
  }

  function celebrateView() {
    const org = giverName(view.org);
    const dots = Array.from({ length: 14 }, (_, index) => {
      const angle = (index / 14) * Math.PI * 2 + (index % 2 ? 0.2 : 0);
      const radius = index % 2 ? 50 : 64;
      return `<i class="plus-burst__dot plus-burst__dot--${index % 4}" data-x="${Math.round(Math.cos(angle) * radius)}" data-y="${Math.round(Math.sin(angle) * radius)}"></i>`;
    }).join('');
    return `<div class="plus-sheet plus-celebrate">
        <div class="plus-celebrate__badge"><span class="plus-burst" aria-hidden="true">${dots}</span><span class="plus-celebrate__mark">${icon('spark')}</span></div>
        <p class="modal__eyebrow">Daily Planner Plus</p>
        <h2 id="plus-title">${esc(view.already ? 'Plus is already active.' : org ? `Plus is yours — thanks to ${org}.` : 'Plus is yours.')}</h2>
        <p>Plan your year, quarterly check-ins, your year in review, Insights and five more colours for your painted year are ready. Plus travels with your planner through sync and backups.</p>
        <p class="plus-status" role="status">${icon('check')}<span>${esc(statusLine())}</span></p>
        <div class="plus-sheet__actions"><button class="primary-button" type="button" data-plus-close>Continue</button></div>
      </div>`;
  }

  function giftBoughtView() {
    const { gift, checkout } = view;
    const seats = Number(gift.seats) || 0;
    // Give Plus and Plus Family are bought by a person for someone else; the rest are team gifts.
    const personal = isPersonalGift(gift.plan) || (!gift.plan && seats > 0 && seats <= 5);
    const people = seats ? ` · ${seats} ${seats === 1 ? 'person' : 'people'}` : '';
    return sheet({
      mark: 'gift', tone: 'gift', eyebrow: `${personal ? 'Gift' : 'Team gift'}${people}`,
      title: personal ? 'Your gift is ready.' : gift.org ? `Your gift for ${gift.org} is ready.` : 'Your team gift is ready.',
      body: `<p>${personal ? (seats > 1 ? 'Send this link to the people you’re giving Plus to: each person who opens it activates Plus for life.' : 'Send this link to the person you’re giving Plus to: opening it activates Plus for life.') : 'Share this one link with your people: each person who opens it activates Plus for life.'} We’ve also emailed it to you, with a message you can forward.</p>
        <div class="plus-link"><input readonly value="${escAttr(safeUrl(gift.url || ''))}" aria-label="Gift link" data-plus-gift-url><button class="secondary-button" type="button" data-plus-copy>Copy link</button></div>
        <p class="plus-fine"><a href="./welcome/thanks/?checkout_id=${encodeURIComponent(checkout || '')}" target="_blank" rel="noopener">Open the gift page</a> to edit the message and see how many places are used.</p>`,
      buttons: '<button class="primary-button" type="button" data-plus-close>Done</button>'
    });
  }

  function problemView() {
    const { problem } = view;
    const siteLink = problem.site && view.code ? `<a class="primary-button" href="${escAttr(`${SITE}/?gift=${encodeURIComponent(view.code)}`)}" target="_blank" rel="noopener">Open planner.bemorin.com</a>` : '';
    return sheet({
      mark: problem.icon, tone: 'problem', title: problem.title,
      body: `<p>${esc(problem.text)}</p>`,
      buttons: `${problem.overview ? '<button class="text-button" type="button" data-plus-overview>See what Plus adds</button>' : ''}<button class="${problem.retry || siteLink ? 'text-button' : 'primary-button'}" type="button" data-plus-close>Close</button>${siteLink}${problem.retry ? '<button class="primary-button" type="button" data-plus-retry>Try again</button>' : ''}`
    });
  }

  const loadingView = () => `<div class="plus-sheet plus-sheet--loading" aria-busy="true"><span class="plus-spinner" aria-hidden="true"></span><h2 id="plus-title">${esc(view.message || 'One moment…')}</h2></div>`;

  function render({ animate = false, focus = true } = {}) {
    const el = root();
    if (!el) return;
    const views = { overview, gift: giftView, celebrate: celebrateView, 'gift-bought': giftBoughtView, problem: problemView, loading: loadingView };
    if (view.stage !== 'overview') cycle.closeZoom({ restore: false });
    // A quiet redraw (prices arriving, say) keeps keyboard focus where it was.
    const keep = !focus && el.contains(document.activeElement) ? focusSelector(document.activeElement) : '';
    el.innerHTML = (views[view.stage] || overview)();
    el.dataset.plusStage = view.stage;
    bind(el);
    if (animate) panelEnter(el.firstElementChild || el, { distance: 8 });
    if (view.stage === 'celebrate') celebrate(el);
    if (focus && isOpen()) focusPrimary();
    else if (keep) qs(keep, el)?.focus({ preventScroll: true });
  }

  /** A selector that finds the same control again after a redraw: its id, else its first data-plus-* attribute. */
  function focusSelector(node) {
    if (node.id) return `#${CSS.escape(node.id)}`;
    const attr = [...node.attributes].find(item => item.name.startsWith('data-plus'));
    return attr ? `[${attr.name}${attr.value ? `="${CSS.escape(attr.value)}"` : ''}]` : '';
  }

  // The first of these that exists takes focus: the step's main action, else a Close button.
  const FOCUS_ORDER = ['#plus-redeem-input.is-invalid', '[data-plus-redeem-gift]:not([disabled])', '[data-plus-retry]', '.plus-sheet .primary-button', '[data-plus-checkout]', '[data-plus-close]'];

  function focusPrimary() {
    const el = root();
    for (const selector of FOCUS_ORDER) {
      const target = qs(selector, el);
      if (target) { target.focus({ preventScroll: true }); return; }
    }
    qs('.modal__close', modal())?.focus({ preventScroll: true });
  }

  function celebrate(el) {
    const badge = qs('.plus-celebrate__mark', el);
    requestAnimationFrame(() => { pulse(badge); burst(qsa('.plus-burst__dot', el)); });
  }

  function show(next, { animate = true } = {}) {
    view = next;
    if (isOpen()) { render({ animate }); return; }
    render({ focus: false });
    const active = getActiveModal();
    openModal(modal(), null, { stack: !!active && active !== modal() });
    setTimeout(focusPrimary, 90);
  }

  async function activate(token, { gift = null } = {}) {
    const result = await activatePlusToken(token, { gift });
    if (result.ok && !result.already) trackEvent('plus_unlocked');
    return result;
  }

  // -------------------------------------------------------------------------
  // Gifts
  // -------------------------------------------------------------------------

  async function openGift(rawCode) {
    const code = normalizeGiftCode(rawCode);
    if (!code) { show({ stage: 'problem', problem: { icon: 'gift', title: 'This gift link isn’t complete', text: 'Gift codes have twelve letters and numbers, like ABCD‑EFGH‑JKMN. Check that the whole link was copied, or type the code in “Have a gift link or a licence?”.', overview: true } }); return; }
    if (!plannerApiEnabled() || !plusAvailable()) { show({ stage: 'problem', code, problem: plusProblem('gift', { unavailable: true }) }); return; }
    trackEvent('gift_opened');
    show({ stage: 'loading', message: 'Opening your gift…', code });
    const result = await fetchGift(code);
    if (!result.ok) { show({ stage: 'problem', code, retryGift: code, problem: plusProblem('gift', result) }); return; }
    const gift = { code, org: String(result.org || '').trim(), message: String(result.message || '').trim(), seats: result.seats };
    if (!result.available && !hasPlus()) {
      const expired = result.status === 'expired' || (result.expiresAt && new Date(result.expiresAt) < new Date());
      const reason = result.status === 'inactive' ? { inactive: true } : expired ? { expired: true } : { claimed: true };
      show({ stage: 'problem', code, problem: plusProblem('gift', reason, { org: gift.org }) });
      return;
    }
    show({ stage: 'gift', gift });
  }

  async function redeem() {
    const { gift } = view;
    if (!gift || view.busy) return;
    view = { ...view, busy: true, error: '' };
    render({ focus: false });
    const result = await redeemGift(gift.code);
    if (!result.ok) {
      const problem = plusProblem('gift', result, { org: gift.org });
      // A connection problem keeps the gift on screen with a quiet note; the rest is explained in full.
      if (problem.retry) { view = { ...view, busy: false, error: result.status === 0 ? problem.text : `${problem.title}. ${problem.text}` }; render(); return; }
      show({ stage: 'problem', code: gift.code, problem });
      return;
    }
    const org = String(result.org || gift.org || '').trim();
    const activated = await activate(result.license, { gift: { code: gift.code, org } });
    if (!activated.ok) {
      // The seat is already counted: keep the licence on this device and try again at the next launch.
      writeUnverifiedGift({ license: result.license, code: gift.code, org });
      show({ stage: 'problem', problem: { icon: 'notice', title: 'Plus couldn’t be checked on this device', text: `${activated.error} Your gift is saved on this device — it will be activated the next time you open the planner, without using another place.` } });
      return;
    }
    writeUnverifiedGift(null);
    trackEvent('gift_redeemed');
    show({ stage: 'celebrate', org });
  }

  // -------------------------------------------------------------------------
  // Purchases and licences
  // -------------------------------------------------------------------------

  /** A Creem checkout (`?checkout_id=`) or the receipt link (`?purchase=`): ask the server for the licence. */
  async function claim(checkout, { quiet = false } = {}) {
    if (!isCheckoutReference(checkout)) { if (!quiet) show({ stage: 'problem', problem: plusProblem('purchase', { status: 404 }) }); writePending(''); return; }
    if (!plannerApiEnabled()) { if (!quiet) show({ stage: 'problem', problem: plusProblem('purchase', { unavailable: true }) }); return; }
    writePending(checkout);
    if (!quiet) show({ stage: 'loading', message: 'Confirming your purchase…' });
    const result = await claimPurchase(checkout);
    if (!result.ok) {
      const problem = plusProblem('purchase', result);
      if (!problem.keep) writePending('');
      if (!quiet) show({ stage: 'problem', retryCheckout: checkout, problem });
      return;
    }
    if (result.kind === 'gift') {
      writePending('');
      show({ stage: 'gift-bought', checkout, gift: { url: result.url, org: result.org, seats: result.seats, plan: result.plan || '' } });
      return;
    }
    const activated = await activate(result.license);
    // Don't keep re-claiming silently: each claim counts on the server.
    if (!activated.ok) { writePending(''); if (!quiet) show({ stage: 'problem', problem: { icon: 'notice', title: 'Plus couldn’t be checked on this device', text: `${activated.error} Your payment is safe — open the link from your receipt email again, or reply to it and we’ll help.` } }); return; }
    writePending('');
    show({ stage: 'celebrate', already: activated.already });
  }

  async function activateLicense(token) {
    if (!plusAvailable()) { show({ stage: 'problem', problem: { icon: 'notice', title: 'Plus isn’t available in this copy', text: 'This copy of the planner can’t check Daily Planner Plus licences. Open the same link on planner.bemorin.com.' } }); return; }
    const result = await activate(token);
    if (!result.ok) { show({ stage: 'problem', problem: { icon: 'notice', title: 'This licence couldn’t be activated', text: result.error } }); return; }
    show({ stage: 'celebrate', already: result.already, org: result.license.org || '' });
  }

  async function submitInput(form) {
    const value = String(new FormData(form).get('code') || '');
    const parsed = parsePlusInput(value);
    if (parsed.kind === 'empty') { qs('input', form)?.focus(); return; }
    if (parsed.kind === 'invalid') { view = { ...view, input: value, inputError: 'That doesn’t look like a gift link, a gift code (ABCD‑EFGH‑JKMN) or a licence.', redeemOpen: true }; render(); return; }
    if (parsed.kind === 'gift') return openGift(parsed.code);
    if (parsed.kind === 'purchase') return claim(parsed.checkout);
    const result = await activate(parsed.token);
    if (!result.ok) { view = { ...view, input: value, inputError: result.error, redeemOpen: true }; render(); return; }
    show({ stage: 'celebrate', already: result.already, org: result.license.org || '' });
  }

  function bind(el) {
    qsa('[data-plus-close]', el).forEach(button => button.addEventListener('click', () => closeModal(modal())));
    qsa('[data-plus-checkout]', el).forEach(button => button.addEventListener('click', () => buy('', button.dataset.plusCheckout)));
    qsa('[data-plus-gift]', el).forEach(button => button.addEventListener('click', () => buy(button.dataset.plusGift)));
    qs('[data-plus-member-continue]', el)?.addEventListener('click', () => {
      const check = view.confirm;
      if (!check || check.leaving) return;
      view = { ...view, confirm: { ...check, leaving: true } };
      render({ focus: false });
      globalThis.location.assign(check.href);
    });
    qs('[data-plus-member-cancel]', el)?.addEventListener('click', () => {
      const plan = view.confirm?.plan || '';
      view = { ...view, confirm: null };
      render({ focus: false });
      qs(`[data-plus-gift="${plan}"]`, root())?.focus({ preventScroll: true });
    });
    qs('[data-plus-privacy]', el)?.addEventListener('click', () => openPrivacy?.());
    // The partner card goes for good once dismissed or followed.
    qs('[data-plus-partner-go]', el)?.addEventListener('click', () => dismissPartnerHint('plus'));
    qs('[data-plus-partner-dismiss]', el)?.addEventListener('click', () => {
      dismissPartnerHint('plus');
      qs('[data-plus-partner]', el)?.remove();
      qs('[data-plus-close]', el)?.focus({ preventScroll: true });
    });
    qs('[data-plus-overview]', el)?.addEventListener('click', () => show({ stage: 'overview' }));
    qs('[data-plus-redeem-gift]', el)?.addEventListener('click', redeem);
    qs('[data-plus-retry]', el)?.addEventListener('click', () => (view.retryCheckout ? claim(view.retryCheckout) : view.retryGift ? openGift(view.retryGift) : show({ stage: 'overview' })));
    qs('[data-plus-redeem-toggle]', el)?.addEventListener('click', () => {
      view = { ...view, redeemOpen: !view.redeemOpen, inputError: '' };
      render({ focus: false });
      qs(view.redeemOpen ? '#plus-redeem-input' : '[data-plus-redeem-toggle]', root())?.focus({ preventScroll: true });
    });
    qs('[data-plus-redeem-form]', el)?.addEventListener('submit', event => { event.preventDefault(); submitInput(event.currentTarget); });
    qsa('[data-plus-palette]', el).forEach(button => ['pointerenter', 'focus', 'click'].forEach(type => button.addEventListener(type, () => previewPalette(el, button))));
    qsa('[data-plus-open-feature]', el).forEach(button => button.addEventListener('click', () => leaveFor(button.dataset.plusOpenFeature)));
    // Binds the yearly ritual when the overview shows it (and lets go of it otherwise).
    cycle.mount(el, { active: hasPlus(), onStep: step => { view = { ...view, step }; } });
    qs('[data-plus-copy]', el)?.addEventListener('click', async event => {
      const input = qs('[data-plus-gift-url]', el);
      try { await navigator.clipboard.writeText(input.value); } catch (_) { input.select(); document.execCommand?.('copy'); }
      event.currentTarget.textContent = 'Copied';
    });
    watchOffer(el);
    const focused = qs('.plus-extra.is-focus', el);
    if (focused && !view.scrolled) { view = { ...view, scrolled: true }; requestAnimationFrame(() => focused.scrollIntoView({ block: 'center' })); }
  }

  /** Settings card, More menu and the reset note follow the Plus state. */
  function renderEntryPoints() {
    const active = hasPlus();
    qsa('[data-plus-status]').forEach(node => {
      node.textContent = active ? statusLine() : plusAvailable() ? `Plan your year, quarterly check-ins, Insights and more · ${price()} once, for life` : 'Not available in this copy of the planner';
    });
    qsa('[data-plus-open]').forEach(button => button.classList.toggle('is-active', active));
    qsa('[data-plus-reset-note]').forEach(node => { node.hidden = !active; });
  }

  /** Opens on what Plus adds; `feature` ('year-plan', 'quarter-review', 'year-review', 'insights', 'paint-palettes') puts that one first in mind. */
  function open({ feature = '' } = {}) {
    trackEvent('plus_modal_opened');
    const id = plusFeatureId(feature);
    cycle.reset();
    barShown = false;
    show({ stage: 'overview', feature: id, step: cycleStepFor(id) }, { animate: false });
    loadOptions();
  }

  /**
   * `?gift=`, `?checkout_id=` (Creem, back from paying), `?purchase=` (the
   * receipt email) and `?license=` arrivals; otherwise a purchase left pending
   * is tried again quietly.
   */
  function handleLaunch(search = globalThis.location?.search || '') {
    // A partner's link (?ref=CODE) is kept on this device so a later purchase credits them.
    rememberReferral(search);
    const params = new URLSearchParams(search);
    const gift = params.get('gift');
    const purchase = params.get('checkout_id') ?? params.get('purchase');
    const license = params.get('license');
    if (gift === null && purchase === null && license === null) {
      const pending = readPending();
      if (pending && !hasPlus()) claim(pending, { quiet: true });
      const unverified = readUnverifiedGift();
      if (unverified && !hasPlus()) {
        activate(unverified.license, { gift: { code: unverified.code, org: unverified.org } }).then(result => {
          if (!result.ok) return;
          writeUnverifiedGift(null);
          trackEvent('gift_redeemed');
          show({ stage: 'celebrate', org: unverified.org || '' });
        });
      } else if (unverified) writeUnverifiedGift(null);
      return false;
    }
    try {
      const url = new URL(globalThis.location.href);
      RETURN_PARAMS.forEach(key => url.searchParams.delete(key));
      history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
    } catch (_) {}
    if (license !== null) activateLicense(license);
    else if (purchase !== null) claim(purchase.trim());
    else openGift(gift);
    return true;
  }

  onPlusChange(() => {
    renderEntryPoints();
    if (!isOpen() || view.stage !== 'overview') return;
    render({ focus: false });
    // Plus switched off while the member price was being asked about: the question stays in view.
    if (view.confirm) showMemberCheck();
  });
  // Back from the payment page with the browser's Back button: the page may come from the cache, still busy.
  globalThis.addEventListener?.('pageshow', event => {
    if (!event.persisted || !(view.buying || view.confirm?.leaving)) return;
    view = { ...view, buying: false, ...(view.confirm ? { confirm: { ...view.confirm, leaving: false } } : {}) };
    if (isOpen()) render({ focus: false });
  });
  renderEntryPoints();

  return { open, handleLaunch, renderEntryPoints };
}
