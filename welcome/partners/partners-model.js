/**
 * The partners page's words and figures (pure, unit-tested): where “Become a
 * partner” goes, and what a sale earns, worked out from the real prices
 * (src/lib/pricing.js) and the program's terms (PARTNER_PROGRAM) — never typed
 * in by hand.
 *
 * `url`: DAILY_PLANNER_AFFILIATE_URL, the Creem affiliate sign-up link (Creem →
 * Growth → Affiliate Hub). Only an https address counts; without one, the
 * button opens the question form on the Teams page, about the program.
 */

import { beforeTaxCents, commissionCents, formatMoney, PARTNER_PROGRAM, partnerRate, priceCents, TEAM_TIERS } from '../../src/lib/pricing.js';

/** The question form of the Teams page, about the partner program (from welcome/partners/). */
export const PARTNER_QUESTION_HREF = '../teams/?ask=question&topic=partners#request';
/** The Teams page, for a partner bringing a company. */
export const TEAMS_HREF = '../teams/';

/** The Creem sign-up link when it is an https address, else ''. */
export function affiliateHref(value) {
  const text = String(value ?? '').trim();
  return /^https:\/\/[^\s"'<>]+$/.test(text) ? text : '';
}

/** { href, external }: where “Become a partner” goes. */
export function partnerPage({ url = '' } = {}) {
  const link = affiliateHref(url);
  return { href: link || PARTNER_QUESTION_HREF, external: !!link };
}

/**
 * The tax in the page's examples (prices include tax): France's 20% VAT for
 * a euro visitor; none for a US-dollar visitor, said as such. The examples are
 * worked out on the price before tax, which depends on the buyer's country.
 * They are examples only: Creem calculates its commission (PARTNER_PROGRAM.rate)
 * under its own affiliate terms, which don't say what it is worked out on, so
 * the notes never present the example as Creem's figure.
 */
export const EXAMPLE_TAX = Object.freeze({
  EUR: Object.freeze({ percent: 20, where: 'in France', note: `An example in France, where prices include 20% VAT, worked out on the price before tax. VAT depends on the buyer’s country, and Creem calculates the ${PARTNER_PROGRAM.rate}% under its own affiliate terms, so what you earn may differ a little.` }),
  USD: Object.freeze({ percent: 0, where: 'without sales tax', note: `An example without sales tax. Where the buyer pays sales tax or VAT, the price before tax is lower, and Creem calculates the ${PARTNER_PROGRAM.rate}% under its own affiliate terms, so what you earn may differ a little.` })
});
const taxOf = currency => EXAMPLE_TAX[currency] || EXAMPLE_TAX.USD;

/** What can be bought, in the rates table's order: Plus and the personal gifts, then every team gift. */
export const EXAMPLE_ITEMS = Object.freeze([
  Object.freeze({ id: 'plus', kind: 'plus', plan: '', label: 'Daily Planner Plus', note: 'Paid once, for life' }),
  Object.freeze({ id: 'gift-1', kind: 'gift', plan: 'gift-1', label: 'Give Plus', note: 'Plus for one person' }),
  Object.freeze({ id: 'family-5', kind: 'gift', plan: 'family-5', label: 'Plus Family', note: 'Up to 5 people in one household' }),
  ...TEAM_TIERS.map(tier => Object.freeze({ id: tier.plan, kind: 'gift', plan: tier.plan, label: 'Team gift', note: `Up to ${new Intl.NumberFormat('en-US').format(tier.seats)} people`, team: true }))
]);

/**
 * One sale in the page's example, in cents: { price, beforeTax, tax, rate,
 * commission }. `price` is what the buyer pays (tax included), `beforeTax`
 * that price without EXAMPLE_TAX, `commission` the partner's share of it.
 */
export function saleExample(kind, plan, currency) {
  const price = priceCents(kind, plan, currency);
  const beforeTax = beforeTaxCents(price, taxOf(currency).percent);
  const rate = partnerRate(kind, plan);
  return { price, beforeTax, tax: price - beforeTax, rate, commission: commissionCents(beforeTax, rate) };
}

/** Every row of the rates table for a currency: EXAMPLE_ITEMS with saleExample(). */
export const rateRows = currency => EXAMPLE_ITEMS.map(item => ({ ...item, ...saleExample(item.kind, item.plan, currency) }));

/** The hero's example month: how many of what, sold through one partner's link. */
export const EXAMPLE_MONTH = Object.freeze([
  Object.freeze({ id: 'plus', count: 8, label: 'Plus' }),
  Object.freeze({ id: 'family-5', count: 1, label: 'Plus Family' }),
  Object.freeze({ id: 'up-to-50', count: 1, label: 'Team gift, up to 50 people' })
]);

/**
 * The example month in a currency: { lines: [{ id, count, label, rate,
 * amount }], total, byCreem, byTransfer } in cents. Each sale's commission is
 * rounded to the cent, then multiplied, as each sale earns on its own.
 */
export function exampleMonth(currency) {
  const items = new Map(EXAMPLE_ITEMS.map(item => [item.id, item]));
  const lines = EXAMPLE_MONTH.map(line => {
    const item = items.get(line.id);
    const sale = saleExample(item.kind, item.plan, currency);
    return { id: line.id, count: line.count, label: line.label, rate: sale.rate, team: !!item.team, amount: sale.commission * line.count };
  });
  const sum = rows => rows.reduce((total, line) => total + line.amount, 0);
  return { lines, total: sum(lines), byCreem: sum(lines.filter(line => !line.team)), byTransfer: sum(lines.filter(line => line.team)) };
}

const money = (cents, currency) => formatMoney(cents / 100, currency);
const LOCALES = { EUR: 'en-IE', USD: 'en-US' };
/** A commission, always to the cent (“€6.04”, “$58.00”), so a column of them lines up. */
export const formatCommission = (cents, currency) => new Intl.NumberFormat(LOCALES[currency] || 'en-US', { style: 'currency', currency: LOCALES[currency] ? currency : 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.round(Number(cents)) / 100);

/**
 * Everything the page fills in for a currency, as text: the rates, the
 * days, the minimum payout, the example of one Plus sale, the tax note.
 */
export function pageFigures(currency) {
  const plus = saleExample('plus', '', currency);
  const team = saleExample('gift', 'up-to-50', currency);
  return {
    rate: `${PARTNER_PROGRAM.rate}%`,
    teamRate: `${PARTNER_PROGRAM.teamRate}%`,
    cookieDays: String(PARTNER_PROGRAM.cookieDays),
    refundDays: String(PARTNER_PROGRAM.refundDays),
    minimum: money((PARTNER_PROGRAM.minimumPayout[currency] ?? PARTNER_PROGRAM.minimumPayout.USD) * 100, currency),
    plusPrice: money(plus.price, currency),
    plusTax: money(plus.tax, currency),
    plusBeforeTax: money(plus.beforeTax, currency),
    plusEarns: formatCommission(plus.commission, currency),
    teamPrice: money(team.price, currency),
    teamEarns: formatCommission(team.commission, currency),
    taxWhere: taxOf(currency).where,
    taxNote: taxOf(currency).note,
    taxed: taxOf(currency).percent > 0
  };
}

export const formatCents = money;
