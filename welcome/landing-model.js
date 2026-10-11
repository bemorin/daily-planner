import { CURRENCIES, TEAM_QUOTE, TEAM_TIERS, formatMoney, validCurrency } from '../src/lib/pricing.js';

/**
 * Pure helpers for the landing page and the gift page: prices per person,
 * what can be bought right now, and the return address after a payment.
 * No DOM here, so tests can import it directly.
 */

/** The visitor's EUR / USD choice, remembered on this browser. */
export const CURRENCY_KEY = 'daily-planner-landing:currency';

export function storedCurrency(storage = globalThis.localStorage) {
  try { return validCurrency(storage?.getItem(CURRENCY_KEY) || ''); } catch (_) { return ''; }
}

export function rememberCurrency(value, storage = globalThis.localStorage) {
  try { if (validCurrency(value)) storage?.setItem(CURRENCY_KEY, value); } catch (_) { /* private mode: the choice lasts for this visit */ }
}

const people = value => new Intl.NumberFormat('en-US').format(value);

/** Every row of the team gift table: the priced tiers, then the quote. */
export const TEAM_ROWS = Object.freeze([...TEAM_TIERS, TEAM_QUOTE]);

export const planRow = plan => TEAM_ROWS.find(row => row.plan === plan) || null;
export const defaultPlan = () => (TEAM_TIERS.find(tier => tier.highlight) || TEAM_TIERS[0]).plan;
export const tierLabel = row => row?.label || `Up to ${people(row?.seats || 0)} people`;

/** A tier's price in `currency`, or null for the quote (or an unknown currency). */
export function tierPrice(row, currency) {
  const value = row?.price?.[validCurrency(currency)];
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** "€11.90" for 595 / 50 people; '' when the row has no price. */
export function perPerson(row, currency) {
  const price = tierPrice(row, currency);
  return price != null && row.seats ? formatMoney(price / row.seats, currency) : '';
}

/** The lowest price per person across the tiers, formatted ("€5"). */
export function lowestPerPerson(currency) {
  const values = TEAM_TIERS.map(tier => {
    const price = tierPrice(tier, currency);
    return price != null && tier.seats ? price / tier.seats : Infinity;
  });
  const lowest = Math.min(...values);
  return Number.isFinite(lowest) ? formatMoney(lowest, currency) : '';
}

/** The smallest priced tier for `count` people, or the quote above the last one. */
export function planForPeople(count) {
  const number = Number(count);
  if (!Number.isFinite(number) || number < 1) return '';
  return (TEAM_TIERS.find(tier => number <= tier.seats) || TEAM_QUOTE).plan;
}

/**
 * GET /api/checkout answers { plus: ['EUR'], gift: ['EUR','USD'], test }.
 * `known` is false when the server could not be asked (offline, error):
 * the page then stays optimistic and asks again on the next click.
 */
export function readCheckoutOptions(result) {
  const list = value => (Array.isArray(value) ? CURRENCIES.filter(currency => value.includes(currency)) : []);
  if (!result || result.ok !== true) return { known: false, plus: [], gift: [], test: false };
  return { known: true, plus: list(result.plus), gift: list(result.gift), test: result.test === true };
}

/**
 * Whether `item` ('plus' | 'gift') can be bought online in `currency`.
 * reason: 'off' (no API, or nothing on sale), 'currency' (on sale in `other`
 * only), 'unknown' (not asked yet: shown as buyable, checked on click).
 */
export function buyState({ apiOn, options, item, currency }) {
  if (!apiOn) return { buyable: false, reason: 'off', other: '' };
  if (!options?.known) return { buyable: true, reason: 'unknown', other: '' };
  const list = options[item] || [];
  if (list.includes(currency)) return { buyable: true, reason: '', other: '' };
  if (list.length) return { buyable: false, reason: 'currency', other: list[0] };
  return { buyable: false, reason: 'off', other: '' };
}

/** Only a web address may be opened as the checkout. */
export const checkoutUrl = value => (typeof value === 'string' && /^https?:\/\/[^\s"'<>]+$/i.test(value.trim()) ? value.trim() : '');

/** Status label ('Planned', 'Exploring', 'Next') → a CSS modifier. */
export function statusTone(status) {
  const value = String(status || '').trim().toLowerCase();
  return ['next', 'planned', 'exploring'].includes(value) ? value : 'other';
}

/** The company name the server uses when the buyer typed none at checkout. */
export const DEFAULT_COMPANY = 'Your company';

export function isDefaultCompany(org) {
  const value = String(org || '').trim();
  return !value || value.toLowerCase() === DEFAULT_COMPANY.toLowerCase();
}

// Creem's checkout ids (ch_…), and older references kept working.
const CHECKOUT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{5,199}$/;

/**
 * What the gift page was opened with:
 *   ?checkout_id=…      back from the payment page (Creem)
 *   ?session=…          an older confirmation link
 *   ?gift=CODE&key=KEY  the gift page link (email, bookmark, invoice gifts)
 */
export function giftPageParams(search) {
  const params = new URLSearchParams(search || '');
  const checkout = (params.get('checkout_id') || params.get('session') || '').trim();
  if (params.has('checkout_id') || params.has('session')) return { kind: 'checkout', checkout: CHECKOUT_RE.test(checkout) ? checkout : '' };
  if (params.has('gift')) return { kind: 'gift', gift: params.get('gift') || '', key: (params.get('key') || '').trim() };
  return { kind: '' };
}
