import { APP_VERSION, PLANNER_API_URL } from '../config.js';

/**
 * Client for the optional owner API (feedback, waitlist, anonymous counts,
 * Daily Planner Plus gifts and purchases).
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
  ['year_review_opened', 'opened a year in review']
]);
/** Moments the public landing page (welcome/) counts; its own notice lists them. */
export const LANDING_EVENTS = Object.freeze([
  ['landing_viewed', 'visited the landing page'],
  ['landing_cta_app', 'clicked “Open the planner”'],
  ['landing_cta_teams', 'went to the team kit'],
  ['team_form_opened', 'opened the team kit request'],
  ['team_request_sent', 'sent a team kit request'],
  ['manager_email_opened', 'prepared the message for a manager'],
  ['plus_checkout_clicked', 'went to buy Plus'],
  ['pack_checkout_clicked', 'went to buy a team gift'],
  ['gift_link_copied', 'copied a team gift link']
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
 * server couldn't be reached) so the caller can explain what happened.
 */
async function request(path, { method = 'POST', body } = {}) {
  if (!plannerApiEnabled()) return { ok: false, status: 0, unavailable: true, error: 'Not available in this version of the planner.' };
  try {
    const response = await fetch(`${PLANNER_API_URL}/${path}`, method === 'GET'
      ? { method, headers: { accept: 'application/json' } }
      : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return { ...data, ok: false, status: response.status, error: data.error || 'Something went wrong. Please try again.' };
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
/** Gift codes go in the path in their canonical XXXX-XXXX-XXXX form. */
export const fetchGift = code => request(`gifts/${encodeURIComponent(code)}`, { method: 'GET' });
export const redeemGift = code => request(`gifts/${encodeURIComponent(code)}/redeem`, { body: {} });
export const claimPurchase = session => request('purchases/claim', { body: { session } });
