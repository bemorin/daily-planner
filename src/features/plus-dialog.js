import { qs, qsa } from '../lib/dom.js';
import { esc, escAttr, safeUrl } from '../lib/text.js';
import { PLUS_CHECKOUT_URL } from '../config.js';
import { activatePlusToken, formatPlusPrice, hasPlus, isCheckoutSession, normalizeGiftCode, onPlusChange, parsePlusInput, plusAvailable, plusLicense, plusSettings, plusStatusLine } from '../lib/plus.js';
import { claimPurchase, fetchGift, plannerApiEnabled, redeemGift, trackEvent } from '../lib/planner-api.js';
import { burst, panelEnter, pulse } from '../ui/motion.js';

/**
 * The "Daily Planner Plus" dialog and its arrivals.
 *
 * One dialog shows, in turn: what Plus adds (with the price, Get Plus, a field
 * for a gift link, code or licence, and the team gift), a gift ("A gift from
 * Acme Studio"), a purchase being confirmed, a calm explanation when something
 * can't be done, and a small celebration once Plus is active.
 *
 * It opens on top of whatever dialog is showing — setup, Settings, Horizon —
 * and returns to it when closed. Links that arrive with `?gift=`,
 * `?purchase=` or `?license=` are handled by handleLaunch() and removed from
 * the address bar straight away.
 */

const PENDING_PURCHASE_KEY = 'daily-planner-ui:plus-pending-purchase';
// A gift licence the server issued but this device couldn't check yet: kept so
// the seat it used isn't lost, and tried again at the next launch.
const UNVERIFIED_GIFT_KEY = 'daily-planner-ui:plus-unverified-gift';
const SITE = 'https://planner.bemorin.com';
const CHECKOUT_URL = safeUrl(PLUS_CHECKOUT_URL);

const ICONS = {
  spark: '<path d="M12 3.6 13.9 9l5.5 1.9-5.5 1.9L12 18.3l-1.9-5.5-5.5-1.9L10.1 9Z"/><path d="M18.6 3.8v3.4M16.9 5.5h3.4"/>',
  plan: '<path d="M4 6.5 9 4.5l6 2 5-2v13l-5 2-6-2-5 2Z"/><path d="M9 4.5v13M15 6.5v13"/>',
  review: '<rect x="5" y="3.5" width="14" height="17" rx="2"/><path d="M8.5 8h7M8.5 11.5h7M8.5 15h4"/>',
  paint: '<path d="M12 3.8a8.2 8.2 0 1 0 0 16.4c1.3 0 1.9-.9 1.9-1.8 0-1.2-1-1.6-1-2.6 0-1 .8-1.6 1.8-1.6h1.8a3.5 3.5 0 0 0 3.5-3.5c0-3.8-3.6-6.9-8-6.9Z"/><circle cx="7.8" cy="11" r="1" class="icon-fill"/><circle cx="10.3" cy="7.6" r="1" class="icon-fill"/><circle cx="14.6" cy="7.8" r="1" class="icon-fill"/>',
  later: '<path d="M12 5v14M5 12h14"/>',
  gift: '<rect x="4" y="9" width="16" height="11" rx="1.6"/><path d="M3 9h18M12 9v11M12 9c-1.4-3.4-5.6-4.3-5.6-1.7C6.4 8.8 9 9 12 9Zm0 0c1.4-3.4 5.6-4.3 5.6-1.7 0 1.5-2.6 1.7-5.6 1.7Z"/>',
  check: '<path d="m6.5 12.5 3.3 3.3 7.7-8"/>',
  team: '<circle cx="9" cy="8.5" r="3"/><path d="M3.5 19c.6-3 2.8-4.6 5.5-4.6s4.9 1.6 5.5 4.6"/><circle cx="16.5" cy="9.5" r="2.4"/><path d="M15.4 14.5c2.5-.3 4.5 1 5.1 3.8"/>',
  notice: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.8v5M12 16.2h.01"/>',
  offline: '<path d="M2.5 8.8a14 14 0 0 1 19 0M5.6 12.2a9.5 9.5 0 0 1 12.8 0M8.8 15.6a4.8 4.8 0 0 1 6.4 0M12 19h.01"/><path d="m4 4 16 16"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

/** What Plus adds, in the order the dialog lists it. Ids match the Plus feature modules. */
export const PLUS_FEATURES = Object.freeze([
  { id: 'year-plan', icon: 'plan', title: 'Plan your year', text: 'A guided half hour that sets up Horizon — your Misogi, its milestones, six mini-adventures, three commitments, a habit per quarter and key dates — and ends with your year printed on one page.' },
  { id: 'year-review', icon: 'review', title: 'Your year in review', text: 'One page for your year: days closed, the painted year, your best streak, trophies, main outcomes, time by category, and a few memories and lessons from your journal. Printable.' },
  { id: 'paint-palettes', icon: 'paint', title: 'Colours for your painted year', text: 'Five more palettes for Progress — ocean, forest, plum, graphite and sunset. Terracotta stays free for everyone.' },
  { id: 'later', icon: 'later', title: 'Everything Plus adds later', text: 'Included. One payment, no subscription.' }
]);
const FEATURE_ALIASES = { plan: 'year-plan', 'plan-year': 'year-plan', review: 'year-review', 'year-in-review': 'year-review', paint: 'paint-palettes', palettes: 'paint-palettes', palette: 'paint-palettes', colours: 'paint-palettes', colors: 'paint-palettes' };

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
  const from = org ? ` Ask ${org}` : ' Ask the person who sent it';
  if (result.unavailable) return { icon: 'notice', title: kind === 'purchase' ? 'This copy can’t confirm purchases' : 'Open this gift at planner.bemorin.com', text: kind === 'purchase' ? 'This copy of the planner isn’t connected to Daily Planner’s payments. Open the link from your receipt at planner.bemorin.com.' : 'This copy of the planner isn’t connected to the gift service. Open the same link on planner.bemorin.com to activate it there.', site: true };
  if (result.status === 0) return { icon: 'offline', title: result.offline ? 'You’re offline' : 'The planner couldn’t be reached', text: kind === 'purchase' ? 'Your payment is safe. Plus will be activated as soon as the planner can reach the server — now with Try again, or next time you open it.' : 'Connect to the internet and try again. The gift link keeps working.', retry: true, keep: true };
  if (kind === 'purchase') {
    if (result.status === 402) return { icon: 'notice', title: 'Your payment isn’t complete yet', text: 'Stripe hasn’t confirmed it yet — this usually takes a moment. Try again shortly; the planner will also try again the next time you open it.', retry: true, keep: true };
    if (result.status === 404) return { icon: 'notice', title: 'We couldn’t find this purchase', text: 'The link from the payment page may be incomplete. If you were charged, reply to your Stripe receipt and we’ll sort it out.' };
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
function writePending(session) { try { if (session) localStorage.setItem(PENDING_PURCHASE_KEY, session); else localStorage.removeItem(PENDING_PURCHASE_KEY); } catch (_) {} }
function readUnverifiedGift() { try { const value = JSON.parse(localStorage.getItem(UNVERIFIED_GIFT_KEY) || 'null'); return value && typeof value.license === 'string' ? value : null; } catch (_) { return null; } }
function writeUnverifiedGift(value) { try { if (value) localStorage.setItem(UNVERIFIED_GIFT_KEY, JSON.stringify(value)); else localStorage.removeItem(UNVERIFIED_GIFT_KEY); } catch (_) {} }

export function createPlusFeature({ openModal, closeModal, getActiveModal = () => null, openPrivacy = null, flush = () => {}, locale = () => globalThis.navigator?.languages?.[0] || globalThis.navigator?.language || 'en-US' }) {
  const modal = () => qs('[data-plus-modal]');
  const root = () => qs('[data-plus]');
  let view = { stage: 'overview' };

  const isOpen = () => !modal()?.hidden && modal()?.classList.contains('is-open');
  const price = () => formatPlusPrice(locale());
  const statusLine = () => plusStatusLine(plusLicense(), { gift: plusSettings().plusGift, activatedAt: plusSettings().plus?.activatedAt, locale: locale() });

  function featureList(focus = '', { compact = false } = {}) {
    return `<ul class="plus-features${compact ? ' plus-features--compact' : ''}">${PLUS_FEATURES.filter(feature => !compact || feature.id !== 'later').map(feature => `<li class="plus-feature plus-feature--${feature.id}${feature.id === focus ? ' is-focus' : ''}" data-plus-feature="${feature.id}"><span class="plus-feature__icon">${icon(feature.icon)}</span><span><strong>${esc(feature.title)}</strong>${compact ? '' : `<small>${esc(feature.text)}</small>`}</span></li>`).join('')}</ul>`;
  }

  function overview() {
    const focus = PLUS_FEATURES.find(feature => feature.id === view.feature && feature.id !== 'later');
    const active = hasPlus();
    const title = active ? 'Thank you for supporting Daily Planner.' : focus ? `${focus.title} comes with Plus.` : 'More for your year — once, for life.';
    let offer = '';
    if (!plusAvailable()) {
      offer = '<p class="plus-note" role="note">Daily Planner Plus isn’t available in this copy of the planner. It’s offered at <a href="https://planner.bemorin.com" target="_blank" rel="noopener">planner.bemorin.com</a> — everything you use here stays free.</p>';
    } else if (!active) {
      const buy = CHECKOUT_URL ? `<a class="primary-button plus-buy__button" href="${escAttr(CHECKOUT_URL)}" data-plus-checkout>Get Plus</a>` : '<span class="plus-soon">Coming soon</span>';
      offer = `<div class="plus-buy"><div class="plus-price"><strong>${esc(price())}</strong><span>once · yours for life</span></div>${buy}</div>
        <details class="plus-redeem"${view.redeemOpen ? ' open' : ''} data-plus-redeem>
          <summary>Have a gift link, code or licence?</summary>
          <form class="plus-redeem__form" data-plus-redeem-form novalidate>
            <label class="sr-only" for="plus-redeem-input">Gift link, gift code or licence</label>
            <input id="plus-redeem-input"${view.inputError ? ' class="is-invalid" aria-invalid="true" aria-describedby="plus-redeem-error"' : ''} name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="Paste a link, or a code like ABCD-EFGH-JKMN" value="${escAttr(view.input || '')}">
            <button class="secondary-button" type="submit" data-plus-redeem-submit>Use it</button>
          </form>
          ${view.inputError ? `<p class="plus-inline-error" id="plus-redeem-error" role="alert">${esc(view.inputError)}</p>` : ''}
        </details>`;
    }
    return `<header class="modal__header plus-header">
        <p class="modal__eyebrow plus-eyebrow"><span class="plus-mark">${icon('spark')}</span>Daily Planner Plus</p>
        <h2 id="plus-title">${esc(title)}</h2>
        <p>${active ? 'Plus is yours for life, on this planner and every device it syncs to. Find its features in Horizon.' : 'The planner stays free, as it is today. Plus adds new things for the year ahead — and everything Plus gains later.'}</p>
      </header>
      ${active ? `<p class="plus-status plus-status--header" role="status">${icon('check')}<span>${esc(statusLine())}</span></p>` : ''}
      ${featureList(focus?.id || '')}
      ${offer}
      <p class="plus-teams"><span class="plus-teams__icon">${icon('team')}</span><span>Buying for a team? <a href="./welcome/#teams" target="_blank" rel="noopener">Give Plus to your people</a> — one link for everyone, as a year‑end gift.</span></p>
      ${openPrivacy && plannerApiEnabled() && plusAvailable() ? '<p class="privacy-footnote">Plus is checked on this device — no account. <button class="privacy-link" type="button" data-plus-privacy>How this is handled</button></p>' : ''}`;
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
    const org = gift.org || '';
    const owned = hasPlus();
    return `<div class="plus-gift">
        <span class="plus-gift__mark">${icon('gift')}</span>
        <p class="modal__eyebrow">A gift for you</p>
        <h2 id="plus-title">${esc(org ? `A gift from ${org}` : 'A gift of Daily Planner Plus')}</h2>
        ${gift.message ? `<blockquote class="plus-gift__message">${esc(gift.message)}${org ? `<cite>— ${esc(org)}</cite>` : ''}</blockquote>` : ''}
        <p class="plus-gift__lead">Daily Planner Plus, for life — on this planner and the devices it syncs to.</p>
        ${featureList('', { compact: true })}
        ${owned ? '<p class="plus-note" role="note">Plus is already active on this planner, so there’s no need to use a place in this gift — keep it for a colleague.</p>' : ''}
        ${error ? `<p class="plus-inline-error" role="alert">${esc(error)}</p>` : ''}
        <div class="plus-sheet__actions">
          <button class="text-button" type="button" data-plus-close>${owned ? 'Close' : 'Later'}</button>
          ${owned ? '' : `<button class="primary-button" type="button" data-plus-redeem-gift${busy ? ' disabled aria-busy="true"' : ''}>${busy ? 'Activating…' : 'Activate Plus'}</button>`}
        </div>
        <p class="plus-fine">No account and no name needed. Activating uses one of the gift’s places.</p>
      </div>`;
  }

  function celebrateView() {
    const org = view.org || '';
    const dots = Array.from({ length: 14 }, (_, index) => {
      const angle = (index / 14) * Math.PI * 2 + (index % 2 ? 0.2 : 0);
      const radius = index % 2 ? 50 : 64;
      return `<i class="plus-burst__dot plus-burst__dot--${index % 4}" data-x="${Math.round(Math.cos(angle) * radius)}" data-y="${Math.round(Math.sin(angle) * radius)}"></i>`;
    }).join('');
    return `<div class="plus-sheet plus-celebrate">
        <div class="plus-celebrate__badge"><span class="plus-burst" aria-hidden="true">${dots}</span><span class="plus-celebrate__mark">${icon('spark')}</span></div>
        <p class="modal__eyebrow">Daily Planner Plus</p>
        <h2 id="plus-title">${esc(view.already ? 'Plus is already active.' : org ? `Plus is yours — thanks to ${org}.` : 'Plus is yours.')}</h2>
        <p>Plan your year, your year in review and the new colours for your painted year are ready in Horizon. Plus travels with your planner through sync and backups.</p>
        <p class="plus-status" role="status">${icon('check')}<span>${esc(statusLine())}</span></p>
        <div class="plus-sheet__actions"><button class="primary-button" type="button" data-plus-close>Continue</button></div>
      </div>`;
  }

  function giftBoughtView() {
    const { gift, session } = view;
    const seats = Number(gift.seats) || 0;
    return sheet({
      mark: 'gift', tone: 'gift', eyebrow: seats ? `Team gift · ${seats} ${seats === 1 ? 'person' : 'people'}` : 'Team gift',
      title: gift.org ? `Your gift for ${gift.org} is ready.` : 'Your team gift is ready.',
      body: `<p>Share this one link with your people: each person who opens it activates Plus for life. We’ve also emailed it to you, with a message you can forward.</p>
        <div class="plus-link"><input readonly value="${escAttr(safeUrl(gift.url || ''))}" aria-label="Gift link" data-plus-gift-url><button class="secondary-button" type="button" data-plus-copy>Copy link</button></div>
        <p class="plus-fine"><a href="./welcome/thanks/?session=${encodeURIComponent(session || '')}" target="_blank" rel="noopener">Open the gift page</a> to edit the message and see how many places are used.</p>`,
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
    el.innerHTML = (views[view.stage] || overview)();
    el.dataset.plusStage = view.stage;
    bind(el);
    if (animate) panelEnter(el.firstElementChild || el, { distance: 8 });
    if (view.stage === 'celebrate') celebrate(el);
    if (focus && isOpen()) focusPrimary();
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
    if (!code) { show({ stage: 'problem', problem: { icon: 'gift', title: 'This gift link isn’t complete', text: 'Gift codes have twelve letters and numbers, like ABCD‑EFGH‑JKMN. Check that the whole link was copied, or type the code in “Have a gift link, code or licence?”.', overview: true } }); return; }
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

  async function claim(session, { quiet = false } = {}) {
    if (!isCheckoutSession(session)) { if (!quiet) show({ stage: 'problem', problem: plusProblem('purchase', { status: 404 }) }); writePending(''); return; }
    if (!plannerApiEnabled()) { if (!quiet) show({ stage: 'problem', problem: plusProblem('purchase', { unavailable: true }) }); return; }
    writePending(session);
    if (!quiet) show({ stage: 'loading', message: 'Confirming your purchase…' });
    const result = await claimPurchase(session);
    if (!result.ok) {
      const problem = plusProblem('purchase', result);
      if (!problem.keep) writePending('');
      if (!quiet) show({ stage: 'problem', retrySession: session, problem });
      return;
    }
    if (result.kind === 'gift') {
      writePending('');
      show({ stage: 'gift-bought', session, gift: { url: result.url, org: result.org, seats: result.seats } });
      return;
    }
    const activated = await activate(result.license);
    // Don't keep re-claiming silently: each claim counts on the server.
    if (!activated.ok) { writePending(''); if (!quiet) show({ stage: 'problem', problem: { icon: 'notice', title: 'Plus couldn’t be checked on this device', text: `${activated.error} Your payment is safe — open the link from your receipt again, or reply to your Stripe receipt and we’ll help.` } }); return; }
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
    if (parsed.kind === 'purchase') return claim(parsed.session);
    const result = await activate(parsed.token);
    if (!result.ok) { view = { ...view, input: value, inputError: result.error, redeemOpen: true }; render(); return; }
    show({ stage: 'celebrate', already: result.already, org: result.license.org || '' });
  }

  function bind(el) {
    qsa('[data-plus-close]', el).forEach(button => button.addEventListener('click', () => closeModal(modal())));
    qs('[data-plus-checkout]', el)?.addEventListener('click', () => { trackEvent('plus_checkout_clicked'); flush(); });
    qs('[data-plus-privacy]', el)?.addEventListener('click', () => openPrivacy?.());
    qs('[data-plus-overview]', el)?.addEventListener('click', () => show({ stage: 'overview' }));
    qs('[data-plus-redeem-gift]', el)?.addEventListener('click', redeem);
    qs('[data-plus-retry]', el)?.addEventListener('click', () => (view.retrySession ? claim(view.retrySession) : view.retryGift ? openGift(view.retryGift) : show({ stage: 'overview' })));
    qs('[data-plus-redeem]', el)?.addEventListener('toggle', event => { view.redeemOpen = event.currentTarget.open; if (view.redeemOpen) qs('#plus-redeem-input', el)?.focus({ preventScroll: true }); });
    qs('[data-plus-redeem-form]', el)?.addEventListener('submit', event => { event.preventDefault(); submitInput(event.currentTarget); });
    qs('[data-plus-copy]', el)?.addEventListener('click', async event => {
      const input = qs('[data-plus-gift-url]', el);
      try { await navigator.clipboard.writeText(input.value); } catch (_) { input.select(); document.execCommand?.('copy'); }
      event.currentTarget.textContent = 'Copied';
    });
    const focused = qs('.plus-feature.is-focus', el);
    if (focused) requestAnimationFrame(() => focused.scrollIntoView({ block: 'nearest' }));
  }

  /** Settings card, More menu and the reset note follow the Plus state. */
  function renderEntryPoints() {
    const active = hasPlus();
    qsa('[data-plus-status]').forEach(node => {
      node.textContent = active ? statusLine() : plusAvailable() ? `Plan your year, your year in review and more · ${price()} once` : 'Not available in this copy of the planner';
    });
    qsa('[data-plus-open]').forEach(button => button.classList.toggle('is-active', active));
    qsa('[data-plus-reset-note]').forEach(node => { node.hidden = !active; });
  }

  /** Opens on what Plus adds; `feature` ('year-plan', 'year-review', 'paint-palettes') puts that one first in mind. */
  function open({ feature = '' } = {}) {
    trackEvent('plus_modal_opened');
    show({ stage: 'overview', feature: plusFeatureId(feature) }, { animate: false });
  }

  /** `?gift=`, `?purchase=` and `?license=` arrivals; otherwise a purchase left pending is tried again quietly. */
  function handleLaunch(search = globalThis.location?.search || '') {
    const params = new URLSearchParams(search);
    const gift = params.get('gift');
    const purchase = params.get('purchase');
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
      ['gift', 'purchase', 'license'].forEach(key => url.searchParams.delete(key));
      history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
    } catch (_) {}
    if (license !== null) activateLicense(license);
    else if (purchase !== null) claim(purchase.trim());
    else openGift(gift);
    return true;
  }

  onPlusChange(() => { renderEntryPoints(); if (isOpen() && view.stage === 'overview') render({ focus: false }); });
  renderEntryPoints();

  return { open, handleLaunch, renderEntryPoints };
}
