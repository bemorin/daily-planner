import { CURRENCIES, PERSONAL_GIFTS, TEAM_QUOTE, TEAM_TIERS, detectCurrency, formatMoney, isPersonalGift, validCurrency } from '../src/lib/pricing.js';

/**
 * Pure helpers for the landing page and the gift page: prices per person,
 * what can be bought right now, and the return address after a payment.
 * No DOM here, so tests can import it directly.
 */

/**
 * The currency prices are shown in: the server's choice from the visitor's
 * country when it gave one (GET /api/checkout), else a first guess from the
 * browser's languages. There is no switch: the euro area pays in EUR, the
 * rest of the world in USD, and the checkout charges exactly that.
 */
export function pageCurrency(options, languages) {
  const server = validCurrency(options?.currency);
  if (server) return server;
  // Country unknown: the language's guess, unless only the other currency is on sale (as in the planner).
  const guess = detectCurrency(languages);
  const onSale = [...(options?.plus || []), ...(options?.gift || [])].filter(validCurrency);
  return !onSale.length || onSale.includes(guess) ? guess : onSale[0];
}

/** The one muted line shown near the prices. */
export const currencyLine = currency => (currency === 'EUR' ? 'Prices in euros, taxes included.' : 'Prices in US dollars, taxes included.');

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
  if (!result || result.ok !== true) return { known: false, plus: [], gift: [], currency: '', test: false };
  return { known: true, plus: list(result.plus), gift: list(result.gift), currency: validCurrency(result.currency), test: result.test === true };
}

/**
 * Whether `item` ('plus' | 'gift') can be bought online in `currency`.
 * reason: 'off' (no API, or nothing on sale), 'currency' (on sale in `other`
 * only, so not for this visitor), 'unknown' (not asked yet: shown as
 * buyable, checked on click).
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
/** The same for personal gifts: Give Plus, then Plus Family. */
export const DEFAULT_FROM = Object.freeze(['A friend', 'Your family']);

/** True when no name was given: the server's placeholder, or nothing at all. */
export function isDefaultCompany(org) {
  const value = String(org || '').trim().toLowerCase();
  return !value || [DEFAULT_COMPANY, ...DEFAULT_FROM].some(name => name.toLowerCase() === value);
}

/** A personal gift's offer from PERSONAL_GIFTS, with its price in `currency`. */
export function personalOffer(plan, currency) {
  const gift = PERSONAL_GIFTS.find(item => item.plan === plan);
  const value = gift?.price?.[validCurrency(currency)];
  return gift ? { ...gift, amount: Number.isFinite(value) && value > 0 ? value : null } : null;
}

/** Up to this many seats, a gift link reads as a personal gift (Give Plus, Plus Family). */
export const PERSONAL_SEATS_MAX = Math.max(...PERSONAL_GIFTS.map(gift => gift.seats));

/**
 * Who a gift is for, from the gift page's answer: 'one' (Give Plus), 'family'
 * (Plus Family) or 'team'. The plan decides when the server sends one ('' is
 * a gift made in the dashboard, for a company); from an older server without
 * it, a gift of a few seats is a personal one (team tiers start at 10).
 */
export function giftAudience(gift) {
  if (typeof gift?.plan === 'string') {
    const personal = PERSONAL_GIFTS.find(item => item.plan === gift.plan.trim());
    if (!personal || !isPersonalGift(personal.plan)) return 'team';
    return personal.seats > 1 ? 'family' : 'one';
  }
  const seats = Number(gift?.seats);
  if (!Number.isFinite(seats) || seats < 1 || seats > PERSONAL_SEATS_MAX) return 'team';
  return seats > 1 ? 'family' : 'one';
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
