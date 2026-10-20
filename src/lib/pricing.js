/**
 * Prices and the Plus promise — one source for the landing page, the planner
 * and the owner API, which charges these exact amounts at checkout (Creem).
 *
 * OWNER DECISIONS: every price, the badge, PERSONAL_GIFTS, the launch price
 * (LAUNCH), the member price of gifts (MEMBER_GIFT_DISCOUNT), PLUS_UPCOMING (what
 * Plus promises next) and the currency rule (the euro area pays in EUR, the rest
 * of the world in USD; the server decides from the buyer's country). Change them
 * here only, then redeploy.
 * Prices are whole units of the currency (29 = 29.00) and include any tax
 * (set the Creem products to "tax inclusive").
 */

export const CURRENCIES = Object.freeze(['EUR', 'USD']);

/** Daily Planner Plus for one person, paid once, for life (at the launch price, below). */
export const PLUS_PRICE = Object.freeze({ EUR: 29, USD: 29 });

/**
 * The launch price (owner's decision, 1.27): during the launch Plus is paid
 * once and kept for life; after it, Plus becomes a yearly subscription for new
 * members, and launch buyers keep Plus for life. No end date and no countdown:
 * set `active: false` when the launch ends, and every “Launch price” badge and
 * line disappears (the landing page, the Plus dialog).
 * `line` is shown next to the price where there is room; where there isn't,
 * the price reads “once, for life” and `after` follows it.
 */
export const LAUNCH = Object.freeze({
  active: true,
  label: 'Launch price',
  line: 'Pay once during the launch and Plus is yours for life. After the launch, Plus becomes a yearly subscription for new members.',
  after: 'After the launch, Plus becomes a yearly subscription for new members.'
});

/**
 * The partner program (welcome/partners/, the terms, the planner's invitations, the
 * dashboard). `rate`: percent of the price before tax of Plus, Give Plus and Plus
 * Family bought through a partner's link, credited and paid by Creem (set the same
 * rate in Creem → Affiliate Hub; Creem has one rate per program). `teamRate`: percent
 * of a team gift a partner introduced, paid by the owner by bank transfer (team
 * checkouts are not credited in Creem). `cookieDays`: how long a partner's link
 * counts (the browser keeps the code that long; set the same in Creem).
 * `minimumPayout`: the balance a partner needs before a payout (Creem's minimum).
 * `refundDays`: a sale earns once its refund period has passed without a refund
 * or a dispute.
 */
export const PARTNER_PROGRAM = Object.freeze({
  rate: 25,
  teamRate: 10,
  cookieDays: 30,
  minimumPayout: Object.freeze({ EUR: 50, USD: 50 }),
  refundDays: 14
});

/** Team gift: one price for the company by number of people (seats). */
export const TEAM_TIERS = Object.freeze([
  Object.freeze({ plan: 'up-to-10', seats: 10, price: Object.freeze({ EUR: 195, USD: 195 }) }),
  Object.freeze({ plan: 'up-to-50', seats: 50, price: Object.freeze({ EUR: 595, USD: 595 }), highlight: true, badge: 'Suggested' }),
  Object.freeze({ plan: 'up-to-100', seats: 100, price: Object.freeze({ EUR: 995, USD: 995 }) }),
  Object.freeze({ plan: 'up-to-500', seats: 500, price: Object.freeze({ EUR: 2995, USD: 2995 }) }),
  Object.freeze({ plan: 'up-to-1000', seats: 1000, price: Object.freeze({ EUR: 4995, USD: 4995 }) })
]);

/**
 * Personal gifts — PROPOSAL, confirm the prices: the same gift link as a team
 * gift, bought by a person for someone else ('gift-1', the price of Plus) or for
 * a household ('family-5', up to five people). The buyer gets the link to send.
 */
export const PERSONAL_GIFTS = Object.freeze([
  Object.freeze({ plan: 'gift-1', seats: 1, price: PLUS_PRICE, label: 'Give Plus', note: 'For one person, for life' }),
  // Never cheaper per person than the smallest team pack (195 / 10 = 19.50), so
  // a company never saves by buying family packs; about 30% less than five Plus.
  Object.freeze({ plan: 'family-5', seats: 5, price: Object.freeze({ EUR: 99, USD: 99 }), label: 'Plus Family', note: 'Up to 5 people in one household, for life' })
]);

/**
 * Member price (owner's decision, 1.27): someone who already has Plus pays this
 * much less for a personal gift, in whole units of each currency — Give Plus
 * 29 → 24, Plus Family 99 → 79. Team packs have no member price. The server
 * applies it only for a licence it verified and that isn't revoked; the price
 * never goes below MEMBER_PRICE_FLOOR of the normal one (memberGiftPrice).
 * Plus Family at the member price (15.80 per person) stays for one household
 * (see the terms), so it is no cheaper way for a company to buy seats.
 */
export const MEMBER_GIFT_DISCOUNT = Object.freeze({
  'gift-1': Object.freeze({ EUR: 5, USD: 5 }),
  'family-5': Object.freeze({ EUR: 20, USD: 20 })
});
/** A member price is never less than this share of the normal price, whatever the discount says. */
export const MEMBER_PRICE_FLOOR = 0.5;

/** Above the last tier: a quote, asked for with the request form. */
export const TEAM_QUOTE = Object.freeze({ plan: 'over-1000', label: 'More than 1,000 people', note: 'A price for the whole organisation' });

/** What Plus adds today (short, for lists; the planner and the landing add their own visuals). */
export const PLUS_FEATURES = Object.freeze([
  Object.freeze({ id: 'plan', title: 'Plan your year', text: 'A guided session of about 30 minutes that sets up Horizon: look back, one Misogi, milestones, six mini-adventures, three commitments, quarterly habits and key dates. It ends with your year on one printed page.' }),
  Object.freeze({ id: 'quarter', title: 'Quarterly check-ins', text: 'Ten guided minutes as each quarter ends: the days you closed, how your winning habit held, two honest questions and the habit for the next three months. Printable on one page.' }),
  Object.freeze({ id: 'insights', title: 'Insights', text: 'Which weekdays work best, when your focus happens, where your hours go month by month, and how this year compares with last. Worked out on your device.' }),
  Object.freeze({ id: 'review', title: 'Your year in review', text: 'One page with your closed days, the painted year, streaks, trophies, outcomes, time by category and what you lived. Printable.' }),
  Object.freeze({ id: 'palettes', title: 'Colours for your painted year', text: 'Five more palettes for Progress and your review: ocean, forest, plum, graphite and sunset.' })
]);

/**
 * What Plus promises next, included at no extra cost when it ships: empty for
 * now (owner's decision, 1.25 — sharing became free, calendars and an evening
 * nudge would be free too). The landing page and the Plus dialog hide the
 * “Coming to Plus” parts while it is empty. Items look like
 * { id, title, text, status: 'Next' | 'Planned' | 'Exploring' }.
 */
export const PLUS_UPCOMING = Object.freeze([]);

/** The euro area (and countries that use the euro) pays in EUR; everyone else in USD. */
export const EURO_REGIONS = Object.freeze(new Set(['AT', 'BE', 'BG', 'CY', 'DE', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PT', 'SI', 'SK', 'AD', 'MC', 'SM', 'VA', 'ME', 'XK']));

export const teamTier = plan => TEAM_TIERS.find(tier => tier.plan === plan) || null;
/** Any plan a gift link can be bought for: a team tier or a personal gift. */
export const giftPlan = plan => teamTier(plan) || PERSONAL_GIFTS.find(gift => gift.plan === plan) || null;
export const isPersonalGift = plan => PERSONAL_GIFTS.some(gift => gift.plan === plan);
export const validCurrency = value => (CURRENCIES.includes(value) ? value : '');

/** The currency a country pays in (ISO 3166 alpha-2), or '' when the country is unknown. */
export function currencyForCountry(country) {
  const code = String(country || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code) || code === 'XX' || code === 'T1') return '';
  return EURO_REGIONS.has(code) ? 'EUR' : 'USD';
}

/** True when `plan` has a member price (a personal gift with a discount in MEMBER_GIFT_DISCOUNT). */
export const hasMemberPrice = (plan, currency) => isPersonalGift(plan) && Number(MEMBER_GIFT_DISCOUNT[plan]?.[currency]) > 0 && !!validCurrency(currency);

/**
 * What a Plus member pays for a personal gift, in whole units: the normal price
 * less its discount, never below MEMBER_PRICE_FLOOR of the normal price (and
 * never above it). null when the plan has no member price in that currency.
 */
export function memberGiftPrice(plan, currency) {
  if (!hasMemberPrice(plan, currency)) return null;
  const price = giftPlan(plan)?.price?.[currency];
  if (!Number.isFinite(price) || price <= 0) return null;
  const discount = Math.max(0, Number(MEMBER_GIFT_DISCOUNT[plan][currency]) || 0);
  return Math.min(price, Math.max(price - discount, Math.ceil(price * MEMBER_PRICE_FLOOR)));
}

/** True when a member is shown a member price for this personal gift (lower than the usual one). */
export function memberPriceShown(plan, currency, member = false) {
  const reduced = member ? memberGiftPrice(plan, currency) : null;
  return reduced != null && reduced < giftPlan(plan)?.price?.[currency];
}

/**
 * A member price was shown for a personal gift, but the checkout the server
 * opened doesn't confirm it (no `member: true` in its answer: the licence was
 * refunded, or couldn't be checked). The buyer is told before paying, calmly,
 * with the usual price — '' when there is nothing to say.
 */
export function memberPriceNotice(plan, currency, { shown = false, confirmed = false } = {}) {
  if (!shown || confirmed === true) return '';
  const usual = giftPlan(plan)?.price?.[currency];
  if (!isPersonalGift(plan) || !Number.isFinite(usual)) return '';
  return `Your member price couldn’t be confirmed — the usual price applies (${formatMoney(usual, currency)}).`;
}

/**
 * Amount charged in cents, or 0 when the item, plan or currency is unknown.
 * `member`: the buyer has Plus (checked by the server), so a personal gift is
 * charged its member price; anything else is unchanged.
 */
export function priceCents(item, plan, currency, { member = false } = {}) {
  if (!validCurrency(currency)) return 0;
  const memberUnits = member && item === 'gift' ? memberGiftPrice(plan, currency) : null;
  const units = memberUnits ?? (item === 'plus' ? PLUS_PRICE[currency] : item === 'gift' ? giftPlan(plan)?.price?.[currency] : 0);
  return Number.isFinite(units) && units > 0 ? Math.round(units * 100) : 0;
}

function localeRegion(tag, guess) {
  try {
    const locale = new Intl.Locale(tag);
    return locale.region || (guess && locale.maximize().region) || '';
  } catch (_) {
    const match = /^[a-z]{2,3}(?:-[a-z]{4})?-([a-z]{2})(?:-|$)/i.exec(tag);
    return match ? match[1].toUpperCase() : '';
  }
}

/**
 * The visitor's likely currency from their languages: an explicit region
 * anywhere in the list wins ("en, fr-FR" is a French visitor); otherwise the
 * likely region of the first language.
 */
export function detectCurrency(languages = globalThis.navigator?.languages || [globalThis.navigator?.language]) {
  const tags = (languages || []).filter(tag => typeof tag === 'string' && tag);
  const region = tags.map(tag => localeRegion(tag, false)).find(Boolean) || (tags[0] ? localeRegion(tags[0], true) : '');
  return EURO_REGIONS.has(region) ? 'EUR' : 'USD';
}

const MONEY_LOCALE = { EUR: 'en-IE', USD: 'en-US' };

/** "€29", "$2,995", "€11.90" — cents only when the value has them. */
export function formatMoney(value, currency) {
  const rounded = Math.round(Number(value) * 100) / 100;
  const cents = !Number.isInteger(rounded);
  return new Intl.NumberFormat(MONEY_LOCALE[currency] || 'en-US', { style: 'currency', currency: validCurrency(currency) || 'USD', minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 }).format(rounded);
}
