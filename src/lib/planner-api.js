import { APP_VERSION, PLANNER_API_URL } from '../config.js';
import { isPersonalGift, PARTNER_PROGRAM } from './pricing.js';

/**
 * Client for the optional owner API (feedback, waitlist, anonymous counts,
 * Daily Planner Plus gifts, purchases and the weekly licence check).
 *
 * When PLANNER_API_URL is blank — the default in public source — nothing here
 * makes a network request. Counts carry only an allow-listed event name and the
 * app version: no identifiers, no planner content — and none at all on a
 * device where the person switched them off in the Privacy notice.
 */

export const plannerApiEnabled = () => !!PLANNER_API_URL;

/** Per-device choice ('off' stops counts on this browser). Waitlist and feedback are unaffected. */
export const USAGE_COUNTS_KEY = 'daily-planner-ui:usage-counts';

/**
 * Every moment this copy may count, in the plain words the Privacy notice
 * shows. trackEvent() sends nothing else, so the notice cannot drift from the
 * code (a unit test checks every trackEvent call is listed here).
 */
export const COUNTED_EVENTS = Object.freeze([
  ['onboarding_completed', 'finished setup'],
  ['install_modal_opened', 'opened the install instructions'],
  ['install_accepted', 'installed the app'],
  ['sync_guide_opened', 'opened the sync guide'],
  ['sync_guide_step_2', 'reached step 2 of the sync guide'],
  ['sync_guide_step_3', 'reached step 3 of the sync guide'],
  ['drive_connect_clicked', 'chose to set up Google Drive sync'],
  ['waitlist_form_opened', 'opened the account-sync waitlist'],
  ['waitlist_joined', 'joined that waitlist'],
  ['feedback_prompt_shown', 'was asked how a version is working'],
  ['feedback_opened', 'opened the feedback form'],
  ['feedback_sent', 'sent feedback'],
  ['trophy_unlocked', 'unlocked a trophy'],
  ['plus_modal_opened', 'opened the Plus details'],
  ['plus_checkout_clicked', 'went to buy Plus'],
  ['plus_unlocked', 'unlocked Plus'],
  ['gift_opened', 'opened a gift link'],
  ['gift_redeemed', 'activated a gift'],
  ['year_plan_completed', 'finished planning a year'],
  ['quarter_review_completed', 'finished a quarter check-in'],
  ['year_review_opened', 'opened a year in review'],
  ['review_sent', 'left a review that may be quoted'],
  ['share_image_created', 'made an image of their week or year to share'],
  // Usage, counted at most once per day, week or month on a device (see
  // trackOncePer): how many devices use the planner, and which parts of it.
  ['app_active_day', 'opened the planner on a day'],
  ['app_active_week', 'opened the planner during a week'],
  ['app_active_month', 'opened the planner during a month'],
  ['app_installed_day', 'opened the installed app on a day'],
  ['day_closed', 'closed a day'],
  ['week_view_opened', 'opened the week view on a day'],
  ['horizon_opened', 'opened Horizon on a day'],
  ['progress_opened', 'opened Progress on a day'],
  ['journal_opened', 'opened the journal on a day'],
  ['unresolved_opened', 'opened Unresolved on a day'],
  ['stats_opened', 'opened statistics on a day'],
  ['search_opened', 'searched on a day'],
  ['pip_opened', 'used the floating window on a day'],
  ['print_used', 'printed on a day']
]);
/** Moments the public landing page (welcome/) counts; its own notice lists them. */
export const LANDING_EVENTS = Object.freeze([
  ['landing_viewed', 'visited the landing page'],
  ['landing_cta_app', 'clicked “Open the planner”'],
  ['landing_cta_teams', 'went to the Teams page'],
  ['team_form_opened', 'opened the request form'],
  ['team_request_sent', 'sent a request'],
  ['manager_email_opened', 'prepared the message for a manager'],
  ['plus_checkout_clicked', 'went to buy Plus'],
  ['pack_checkout_clicked', 'went to buy a team gift'],
  ['gift_link_copied', 'copied a team gift link'],
  ['plus_viewed', 'scrolled to Plus'],
  ['teams_viewed', 'visited the Teams page'],
  ['pricing_viewed', 'scrolled to the prices'],
  ['partners_viewed', 'visited the partners page'],
  ['partner_cta_clicked', 'went to become a partner']
]);
const COUNTED = new Set([...COUNTED_EVENTS, ...LANDING_EVENTS].map(([name]) => name));

export function usageCountsEnabled(storage = globalThis.localStorage) {
  try { return storage?.getItem(USAGE_COUNTS_KEY) !== 'off'; } catch (_) { return true; }
}

export function setUsageCountsEnabled(enabled, storage = globalThis.localStorage) {
  try { storage?.setItem(USAGE_COUNTS_KEY, enabled ? 'on' : 'off'); } catch (_) {}
}

export function platformLabel() {
  const ua = navigator.userAgent || '';
  const installed = window.matchMedia?.('(display-mode: standalone)')?.matches || navigator.standalone === true;
  const os = /iPhone|iPod/i.test(ua) ? 'iPhone' : /iPad/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ? 'iPad' : /Android/i.test(ua) ? 'Android' : /Mac/i.test(ua) ? 'Mac' : /Win/i.test(ua) ? 'Windows' : /Linux/i.test(ua) ? 'Linux' : 'Other';
  return `${os} · ${installed ? 'installed app' : 'browser'}`;
}

/** Fire-and-forget anonymous count. Never throws, never blocks the UI. */
export function trackEvent(name) {
  if (!plannerApiEnabled() || !COUNTED.has(name) || !usageCountsEnabled() || globalThis.navigator?.onLine === false) return;
  try {
    fetch(`${PLANNER_API_URL}/events`, {
      method: 'POST',
      keepalive: true,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, version: APP_VERSION })
    }).catch(() => {});
  } catch (_) {}
}

const ONCE_KEY = 'daily-planner-ui:counted';
const pad2 = value => String(value).padStart(2, '0');

/** Local period keys: 2026-10-11 (day), 2026-W41 (ISO week), 2026-10 (month). */
export function periodKey(period, date = new Date()) {
  if (period === 'month') return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
  if (period === 'week') {
    const day = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7));
    const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1);
    const week = Math.ceil(((day - yearStart) / 86400000 + 1) / 7);
    return `${day.getUTCFullYear()}-W${pad2(week)}`;
  }
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * Counts `name` at most once per local day, ISO week or month on this device,
 * so the dashboard can tell devices apart from repeated clicks without any
 * identifier ever leaving the device. Returns true when a count was sent.
 */
export function trackOncePer(period, name, { date = new Date(), storage = globalThis.localStorage } = {}) {
  // Offline, nothing is sent — so the period is not marked as counted either.
  if (!plannerApiEnabled() || !COUNTED.has(name) || !usageCountsEnabled(storage) || globalThis.navigator?.onLine === false) return false;
  const key = periodKey(period, date);
  let seen = {};
  try { seen = JSON.parse(storage?.getItem(ONCE_KEY) || '{}') || {}; } catch (_) { seen = {}; }
  if (seen[name] === key) return false;
  seen[name] = key;
  try { storage?.setItem(ONCE_KEY, JSON.stringify(seen)); } catch (_) { return false; }
  trackEvent(name);
  return true;
}

/** Planner opened: daily, weekly and monthly active counts, and installed-app days. */
export function trackAppActive({ installed = false, date = new Date() } = {}) {
  trackOncePer('day', 'app_active_day', { date });
  trackOncePer('week', 'app_active_week', { date });
  trackOncePer('month', 'app_active_month', { date });
  if (installed) trackOncePer('day', 'app_installed_day', { date });
}

async function postJson(path, body) {
  if (!plannerApiEnabled()) return { ok: false, error: 'Not available in this version of the planner.' };
  try {
    const response = await fetch(`${PLANNER_API_URL}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, version: APP_VERSION })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, error: data.error || 'Something went wrong. Please try again.' };
    return { ok: true, ...data };
  } catch (_) {
    return { ok: false, error: navigator.onLine === false ? 'You are offline. Try again once you are connected.' : 'Could not reach the server. Please try again.' };
  }
}

/**
 * JSON request for the gift, purchase and waitlist-removal routes. Bodies are
 * sent exactly as given. The answer carries the HTTP `status` (0 when the
 * server couldn't be reached) so the caller can explain what happened —
 * except a success with `ownStatus`, which keeps the answer's own `status`
 * (a gift's 'available', 'inactive' …) and puts the HTTP one in `httpStatus`.
 */
async function request(path, { method = 'POST', body, ownStatus = false } = {}) {
  if (!plannerApiEnabled()) return { ok: false, status: 0, unavailable: true, error: 'Not available in this version of the planner.' };
  try {
    const response = await fetch(`${PLANNER_API_URL}/${path}`, method === 'GET'
      ? { method, headers: { accept: 'application/json' } }
      : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return { ...data, ok: false, status: response.status, error: data.error || 'Something went wrong. Please try again.' };
    if (ownStatus && typeof data.status === 'string') return { ...data, ok: true, httpStatus: response.status };
    return { ...data, ok: true, status: response.status };
  } catch (_) {
    const offline = globalThis.navigator?.onLine === false;
    return { ok: false, status: 0, offline, error: offline ? 'You are offline. Try again once you are connected.' : 'Could not reach the server. Please try again.' };
  }
}

export const joinWaitlist = payload => postJson('waitlist', payload);
/** Removes an address with the token the server returned when it joined. */
export const leaveWaitlist = ({ email, token }) => request('waitlist/remove', { body: { email, token } });
export const sendFeedback = payload => postJson('feedback', { platform: platformLabel(), ...payload });
/**
 * Gift codes go in the path in their canonical XXXX-XXXX-XXXX form. A gift that
 * was read keeps its own `status` ('available', 'claimed', 'expired',
 * 'inactive'), so a switched-off or refunded link is explained as such.
 */
export const fetchGift = code => request(`gifts/${encodeURIComponent(code)}`, { method: 'GET', ownStatus: true });
export const redeemGift = code => request(`gifts/${encodeURIComponent(code)}/redeem`, { body: {} });
/** Confirms a Creem checkout (`checkout_id` on the return URL) and returns a licence or a gift. */
export const claimPurchase = (checkout, { expect = '' } = {}) => request('purchases/claim', { body: expect ? { checkout, expect } : { checkout } });
/**
 * Asks whether a Plus licence still holds: { ok, revoked } (a refund or a
 * dispute revokes it). Only the licence is sent — no identifier, no app
 * version, nothing from the planner (src/features/plus-check.js, about once a week).
 */
export const checkPlusLicense = license => request('plus/check', { body: { license } });
/**
 * Which items and currencies can be bought right now, and the visitor's currency
 * chosen by the server from their country: { plus: ['EUR','USD'], gift: [...],
 * currency: 'EUR'|'USD'|'', test }. `currency` is '' when the country is unknown
 * (then use detectCurrency() from pricing.js).
 */
export const checkoutOptions = () => request('checkout', { method: 'GET' });
/**
 * Opens a Creem checkout for Plus (`item: 'plus'`) or a gift link (`item: 'gift'`,
 * `plan` from TEAM_TIERS or PERSONAL_GIFTS). `currency` is only a hint: the server
 * charges the currency of the buyer's country when it knows it. A referral code
 * remembered on this device (rememberReferral) goes along. `license`, this
 * planner's Plus licence, goes only with a personal gift: the server checks it
 * and charges the member price (MEMBER_GIFT_DISCOUNT); it is not stored. Answers
 * { ok, url, member }.
 */
export const startCheckout = ({ item, plan = '', currency, license = '' }) => {
  const ref = referralCode();
  const member = item === 'gift' && isPersonalGift(plan) && typeof license === 'string' && license.trim() ? { license: license.trim() } : {};
  return request('checkout', { body: { item, plan, currency, ...(ref ? { ref } : {}), ...member } });
};

/* Referral codes (Creem affiliate program) -------------------------------- */

// Outside the 'daily-planner:' prefix, so backups and sync never carry it.
export const REFERRAL_KEY = 'daily-planner-ui:ref';
/** How long a partner's link counts on this device (the same as Creem's attribution window). */
export const REFERRAL_DAYS = PARTNER_PROGRAM.cookieDays;
const REFERRAL_RE = /^[A-Za-z0-9_-]{2,64}$/;
const REFERRAL_PARAMS = ['ref', 'via', 'aff'];

/**
 * Keeps the partner code from a link like /welcome/?ref=CODE for REFERRAL_DAYS
 * (30) on this device (the latest link wins), so a purchase made later — or a
 * team request — is credited to that partner. Returns the code it kept, or ''.
 * The visit itself is counted for the partner's statement (countPartnerVisit):
 * the code only, at most once a day per code on this device, and never when
 * the anonymous counts are switched off here. Nothing else is sent until a
 * checkout or a request.
 */
export function rememberReferral(search = globalThis.location?.search || '', { storage = globalThis.localStorage, now = Date.now() } = {}) {
  let params;
  try { params = new URLSearchParams(search); } catch (_) { return ''; }
  const code = REFERRAL_PARAMS.map(name => String(params.get(name) || '').trim()).find(value => REFERRAL_RE.test(value)) || '';
  if (!code) return '';
  let saved = null;
  try { saved = JSON.parse(storage?.getItem(REFERRAL_KEY) || 'null'); } catch (_) { saved = null; }
  const counted = countPartnerVisit(code, { counted: saved?.counted, storage, now });
  try { storage?.setItem(REFERRAL_KEY, JSON.stringify({ code, at: now, ...(counted ? { counted } : {}) })); } catch (_) { return ''; }
  return code;
}

/** Codes a device remembers having counted on one day, at most (a few partners' links in a day, never a list that grows). */
const COUNTED_CODES_MAX = 20;

/**
 * Counts one visit through a partner's link (POST partners/visit { ref }:
 * the code, nothing else) unless this device already counted that code
 * today (`counted`: { day, codes }, the local day and the codes counted on
 * it, kept with the code under REFERRAL_KEY), the anonymous counts are off
 * here, or the API is off or offline. Answers what to remember: today's
 * codes with this one when it was sent, else `counted` as it was (null when
 * there is nothing to keep).
 */
export function countPartnerVisit(code, { counted = null, storage = globalThis.localStorage, now = Date.now() } = {}) {
  const day = periodKey('day', new Date(now));
  const today = counted && counted.day === day && Array.isArray(counted.codes) ? counted.codes.filter(item => REFERRAL_RE.test(String(item))).slice(-COUNTED_CODES_MAX) : [];
  const kept = today.length ? { day, codes: today } : null;
  if (today.includes(code) || !REFERRAL_RE.test(String(code || '')) || !plannerApiEnabled() || !usageCountsEnabled(storage) || globalThis.navigator?.onLine === false) return kept;
  try {
    fetch(`${PLANNER_API_URL}/partners/visit`, {
      method: 'POST',
      keepalive: true,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ref: code })
    }).catch(() => {});
  } catch (_) { return kept; }
  return { day, codes: [...today, code].slice(-COUNTED_CODES_MAX) };
}

/**
 * A partner's private statement (partners/statement/): GET
 * partners/statement?code=…&key=… with the code and the key of their link.
 * Answers { ok, statement } or { ok: false, status, error } (404: the link
 * isn't valid).
 */
export const fetchPartnerStatement = ({ code, key }) => request(`partners/statement?${new URLSearchParams({ code: String(code || ''), key: String(key || '') })}`, { method: 'GET' });

/** The remembered partner code, or '' once it is older than REFERRAL_DAYS (30) or unreadable. */
export function referralCode({ storage = globalThis.localStorage, now = Date.now() } = {}) {
  try {
    const saved = JSON.parse(storage?.getItem(REFERRAL_KEY) || 'null');
    if (!saved || !REFERRAL_RE.test(String(saved.code || '')) || !(now - Number(saved.at) < REFERRAL_DAYS * 86400000)) return '';
    return saved.code;
  } catch (_) {
    return '';
  }
}

/* Partner hints ------------------------------------------------------------- */

// Where the planner and the gift page mention the partner program, quietly:
// the Plus dialog (for everyone), after a share image, and the gift page. Once
// dismissed (or followed), a place stays quiet on this device. UI prefix:
// never synced or backed up.
export const PARTNER_HINTS_KEY = 'daily-planner-ui:partner-hints';
export const PARTNER_HINT_PLACES = Object.freeze(['plus', 'share', 'gift']);

/** The places already dismissed on this device; [] when none or unreadable. */
export function dismissedPartnerHints(storage = globalThis.localStorage) {
  try {
    const saved = JSON.parse(storage?.getItem(PARTNER_HINTS_KEY) || '[]');
    return Array.isArray(saved) ? PARTNER_HINT_PLACES.filter(place => saved.includes(place)) : [];
  } catch (_) {
    return [];
  }
}

/** True when the hint at `place` may show: the owner API is on and it was never dismissed here. */
export const partnerHintShown = (place, storage = globalThis.localStorage) => plannerApiEnabled() && PARTNER_HINT_PLACES.includes(place) && !dismissedPartnerHints(storage).includes(place);

/** Keeps the hint at `place` quiet from now on. Returns the dismissed places. */
export function dismissPartnerHint(place, storage = globalThis.localStorage) {
  if (!PARTNER_HINT_PLACES.includes(place)) return dismissedPartnerHints(storage);
  const next = [...new Set([...dismissedPartnerHints(storage), place])];
  try { storage?.setItem(PARTNER_HINTS_KEY, JSON.stringify(next)); } catch (_) {}
  return next;
}
