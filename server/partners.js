// Partner sales (migration 0006): which partner's link each paid sale came
// through. Pure helpers, shared by the router (server/planner-api.js), both
// stores and the tests.
//
// A partner shares https://planner.bemorin.com/welcome/?ref=CODE. The visitor's
// browser keeps the code for 60 days and sends it with a checkout; the API
// passes it to Creem as `affiliate_code` (Creem's affiliate program counts the
// clicks and pays the commission) and in the checkout's metadata (`ref`), sealed
// with the rest of the checkout (server/creem.js). Once the checkout is paid
// (webhook or claim), and only with a valid seal — a product link opened by
// hand can't name a partner — the sale is recorded here: the code, what was
// bought, the amount and currency, whether the member price applied, Creem's
// mode (test or live) and the date. Nothing about the buyer: a partner code
// names the partner, not the person who bought.

import { CREEM_REASONS } from './refunds.js';

/** Sales read for the dashboard's Partners card (newest first), and how many are listed one by one. */
export const PARTNER_SALES_LISTED = 2000;
export const PARTNER_RECENT = 25;
const CURRENCY_ORDER = ['EUR', 'USD'];

/**
 * The row to keep for a paid checkout (readCheckout() in server/creem.js, with
 * `sealed` from the router), or null when no partner's link was used or our
 * API did not open it (no valid seal: the code and the member flag are only
 * someone's metadata). The member price applies to gifts only.
 */
export function partnerSaleRow(checkoutId, paid, createdAt) {
  if (!paid?.ref || !paid.item || paid.sealed !== true) return null;
  return {
    checkoutId,
    code: paid.ref,
    kind: paid.item.kind,
    plan: paid.item.plan || '',
    amount: Number.isInteger(paid.amount) ? paid.amount : null,
    currency: paid.currency || '',
    member: paid.item.kind === 'gift' && paid.member === true,
    mode: paid.mode || '',
    createdAt
  };
}

/** Same shape from both stores: booleans and numbers, null when unknown. */
export function normalizePartnerSale(row) {
  if (!row) return null;
  return {
    checkoutId: String(row.checkoutId ?? ''),
    code: String(row.code ?? ''),
    kind: String(row.kind ?? ''),
    plan: String(row.plan ?? ''),
    amount: row.amount == null || row.amount === '' ? null : Number(row.amount),
    currency: String(row.currency ?? ''),
    member: row.member === true || Number(row.member) === 1,
    mode: String(row.mode ?? ''),
    createdAt: String(row.createdAt ?? '')
  };
}

/**
 * What became of a sale, from the revocations of its checkout ({ checkoutId,
 * reason } rows): 'refunded' when a refund or a dispute switched it off,
 * 'revoked' when the owner did, '' while it stands.
 */
export function saleStates(rows = []) {
  const states = new Map();
  for (const row of rows) {
    const id = String(row?.checkoutId ?? '');
    if (!id) continue;
    const state = CREEM_REASONS.includes(row.reason) ? 'refunded' : 'revoked';
    if (states.get(id) !== 'refunded') states.set(id, state);
  }
  return states;
}

const byCurrency = totals => Object.fromEntries(Object.entries(totals).sort(([a], [b]) => {
  const rank = code => (CURRENCY_ORDER.includes(code) ? CURRENCY_ORDER.indexOf(code) : CURRENCY_ORDER.length);
  return rank(a) - rank(b) || a.localeCompare(b);
}));

/** Creem's test modes: a sale made while testing is never counted with real ones. */
export const isTestMode = mode => ['test', 'sandbox'].includes(String(mode ?? '').trim().toLowerCase());

/**
 * What partial refunds took back from each sale, in cents ({ checkoutId,
 * amount, currency, fullRefund } rows from the store): Map<checkoutId,
 * { amount, unknown }>. A full refund or a dispute switches the sale off
 * instead (saleStates); a partial refund whose amount Creem didn't give, or
 * in another currency than the sale, is counted in `unknown`.
 */
export function partialRefunds(rows = [], sales = []) {
  const currencyOf = new Map(sales.map(sale => [sale.checkoutId, sale.currency]));
  const taken = new Map();
  for (const row of rows) {
    const id = String(row?.checkoutId ?? '');
    if (!id || row.fullRefund === true || Number(row.fullRefund) === 1) continue;
    const entry = taken.get(id) || { amount: 0, unknown: 0 };
    const cents = row.amount == null || row.amount === '' ? NaN : Number(row.amount);
    const currency = String(row.currency ?? '').toUpperCase();
    const same = !currency || !currencyOf.get(id) || currency === currencyOf.get(id);
    if (Number.isInteger(cents) && cents > 0 && same) entry.amount += cents;
    else entry.unknown += 1;
    taken.set(id, entry);
  }
  return taken;
}

/**
 * The dashboard's Partners card: one line per code — sales, how many were
 * refunded (in full or in part) or switched off, how many at the member
 * price, revenue per currency (in cents, after refunds: refunded and
 * switched-off sales left out, partial refunds taken off by their amount;
 * currencies never added together) and the last sale — most sales first; then
 * the latest sales one by one, each with its state. Sales made in Creem's test
 * mode are counted apart (`test`, never in the figures). `states` is
 * saleStates() or its input rows, `refunds` the partner sales' refund rows;
 * `limit` is how many sales the store was asked for: when it gave that many,
 * `totals.capped` says the figures cover only the latest ones.
 */
export function partnerSummary(rows = [], states = new Map(), refunds = [], { limit = PARTNER_SALES_LISTED } = {}) {
  const stateOf = states instanceof Map ? states : saleStates(states);
  const normalized = rows.map(normalizePartnerSale).filter(Boolean);
  const takenOf = refunds instanceof Map ? refunds : partialRefunds(refunds, normalized);
  const sales = normalized.map(row => {
    const state = stateOf.get(row.checkoutId) || '';
    const taken = state ? null : takenOf.get(row.checkoutId);
    const refunded = taken ? Math.min(taken.amount, row.amount ?? taken.amount) : 0;
    return { ...row, state, test: isTestMode(row.mode), partial: !!taken, refundedAmount: refunded, refundUnknown: !!taken?.unknown };
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.checkoutId.localeCompare(b.checkoutId));
  const codes = new Map();
  const revenue = {};
  const test = { sales: 0, revenue: {} };
  const add = (into, sale, cents) => { if (cents > 0 && sale.currency) into[sale.currency] = (into[sale.currency] || 0) + cents; };
  for (const sale of sales) {
    const entry = codes.get(sale.code) || { code: sale.code, sales: 0, refunded: 0, partial: 0, revoked: 0, members: 0, revenue: {}, test: 0, lastAt: '' };
    const net = sale.state || sale.amount == null ? 0 : sale.amount - sale.refundedAmount;
    if (sale.test) {
      entry.test += 1;
      test.sales += 1;
      add(test.revenue, sale, net);
    } else {
      entry.sales += 1;
      if (sale.state === 'refunded') entry.refunded += 1;
      if (sale.state === 'revoked') entry.revoked += 1;
      if (sale.partial) entry.partial += 1;
      if (sale.member) entry.members += 1;
      add(entry.revenue, sale, net);
      add(revenue, sale, net);
    }
    if (sale.createdAt > entry.lastAt) entry.lastAt = sale.createdAt;
    codes.set(sale.code, entry);
  }
  const live = sales.filter(sale => !sale.test);
  return {
    codes: [...codes.values()].map(entry => ({ ...entry, revenue: byCurrency(entry.revenue) }))
      .sort((a, b) => b.sales - a.sales || b.test - a.test || b.lastAt.localeCompare(a.lastAt) || a.code.localeCompare(b.code)),
    recent: sales.slice(0, PARTNER_RECENT),
    totals: {
      sales: live.length,
      partners: new Set(live.map(sale => sale.code)).size,
      refunded: live.filter(sale => sale.state).length,
      partial: live.filter(sale => sale.partial).length,
      revenue: byCurrency(revenue),
      test: { sales: test.sales, revenue: byCurrency(test.revenue) },
      listed: sales.length,
      capped: limit > 0 && rows.length >= limit
    }
  };
}
