// Partner sales (migrations 0006 and 0007): which partner's link each paid sale
// came through, and what it earns the partner. Pure helpers, shared by the
// router (server/planner-api.js), both stores and the tests.
//
// A partner shares https://planner.bemorin.com/welcome/?ref=CODE. The visitor's
// browser keeps the code for 30 days (PARTNER_PROGRAM.cookieDays) and sends it
// with a checkout. For Plus and the personal gifts the API passes it to Creem
// as `affiliate_code`: Creem's affiliate program counts the clicks and pays the
// 25% commission. A team gift is never sent to Creem with the code (Creem has
// one rate per program): its 10% is paid by the owner, by bank transfer. Every
// item carries the code in the checkout's metadata (`ref`), sealed with the
// rest of the checkout (server/creem.js). Once the checkout is paid (webhook or
// claim), and only with a valid seal — a product link opened by hand can't
// name a partner — the sale is recorded here: the code, what was bought, the
// amount and the tax included in it (when Creem gives it), the currency,
// whether the member price applied, Creem's mode (test or live) and the date.
// Nothing about the buyer: a partner code names the partner, not the person
// who bought.
//
// The commission (PARTNER_PROGRAM in src/lib/pricing.js) is a share of the
// amount before tax: the amount paid less the tax Creem reports, less any
// partial refund (taken off in proportion). When the tax isn't known (sales
// recorded before 1.28, or Creem didn't give it) the commission is shown on
// the amount paid, and said so (`basis: 'paid'`). A sale earns once its
// refund period (PARTNER_PROGRAM.refundDays) has passed without a refund or a
// dispute; a refunded, disputed or switched-off sale earns nothing. The owner
// marks a team commission as paid in the dashboard (table partner_payouts).

import { CREEM_REASONS } from './refunds.js';
import { commissionCents, isTeamGift, PARTNER_PROGRAM, partnerRate } from '../src/lib/pricing.js';

/** Sales read for the dashboard's Partners card (newest first), and how many are listed one by one. */
export const PARTNER_SALES_LISTED = 2000;
export const PARTNER_RECENT = 25;
/** Team commissions listed one by one: every one still to pay, then the newest others. */
export const TEAM_COMMISSIONS_LISTED = 200;
export const PAYOUT_NOTE_MAX = 200;
const DAY_MS = 86400000;
const CURRENCY_ORDER = ['EUR', 'USD'];
/** What a commission is, in the order the dashboard reads them. */
export const COMMISSION_STATUSES = Object.freeze(['pending', 'earned', 'paid', 'refunded', 'disputed', 'revoked']);
const OFF_STATES = new Set(['refunded', 'disputed', 'revoked']);

const wholeOrNull = value => {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
};

/**
 * The row to keep for a paid checkout (readCheckout() in server/creem.js, with
 * `sealed` from the router), or null when no partner's link was used or our
 * API did not open it (no valid seal: the code and the member flag are only
 * someone's metadata). The member price applies to gifts only.
 */
export function partnerSaleRow(checkoutId, paid, createdAt) {
  if (!paid?.ref || !paid.item || paid.sealed !== true) return null;
  const amount = Number.isInteger(paid.amount) ? paid.amount : null;
  const tax = wholeOrNull(paid.tax);
  return {
    checkoutId,
    code: paid.ref,
    kind: paid.item.kind,
    plan: paid.item.plan || '',
    amount,
    tax: tax != null && amount != null && tax <= amount ? tax : null,
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
    tax: wholeOrNull(row.tax),
    currency: String(row.currency ?? ''),
    member: row.member === true || Number(row.member) === 1,
    mode: String(row.mode ?? ''),
    createdAt: String(row.createdAt ?? '')
  };
}

/** A team commission marked as paid (migration 0007), the same from both stores. */
export function normalizePayout(row) {
  if (!row) return null;
  return {
    checkoutId: String(row.checkoutId ?? ''),
    code: String(row.code ?? ''),
    amount: wholeOrNull(row.amount),
    currency: String(row.currency ?? ''),
    note: String(row.note ?? ''),
    paidAt: String(row.paidAt ?? '')
  };
}

/**
 * What became of a sale, from the revocations of its checkout ({ checkoutId,
 * reason } rows): 'refunded' or 'disputed' when a refund or a dispute switched
 * it off (the first one wins), 'revoked' when the owner did, '' while it stands.
 */
export function saleStates(rows = []) {
  const states = new Map();
  for (const row of rows) {
    const id = String(row?.checkoutId ?? '');
    if (!id) continue;
    const byCreem = CREEM_REASONS.includes(row.reason);
    const current = states.get(id);
    if (current && current !== 'revoked') continue;
    if (byCreem) states.set(id, row.reason === 'dispute' ? 'disputed' : 'refunded');
    else if (!current) states.set(id, 'revoked');
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
 * The commission on one sale: { rate, base, basis, commission }. `base` is
 * the amount it is worked out on, in cents: the amount kept after `refunded`
 * (partial refunds), before tax when the tax is known ('before-tax', the
 * refund taken off in proportion), else the amount paid ('paid'). null
 * amounts when the sale's amount isn't known or nothing earns on it.
 */
export function saleCommission(sale, { refunded = 0 } = {}) {
  const rate = partnerRate(sale?.kind, sale?.plan);
  const amount = wholeOrNull(sale?.amount);
  if (!rate || amount == null) return { rate, base: null, basis: '', commission: null };
  const kept = Math.max(0, amount - Math.max(0, Number(refunded) || 0));
  const tax = wholeOrNull(sale.tax);
  const taxKnown = tax != null && tax <= amount;
  const base = !taxKnown ? kept : amount ? Math.round(kept * (amount - tax) / amount) : 0;
  return { rate, base, basis: taxKnown ? 'before-tax' : 'paid', commission: commissionCents(base, rate) };
}

/** When a sale's refund period ends (ISO), '' when its date can't be read. */
export function earnedAt(createdAt, days = PARTNER_PROGRAM.refundDays) {
  const time = Date.parse(String(createdAt || ''));
  return Number.isFinite(time) ? new Date(time + days * DAY_MS).toISOString() : '';
}

/**
 * Where a sale's commission stands: 'refunded', 'disputed' or 'revoked' (it
 * earns nothing), 'paid' (a team commission the owner marked as paid),
 * 'earned' (its refund period is over) or 'pending' (still within it).
 */
export function commissionStatus({ state = '', team = false, paidAt = '', earned = '' }, now) {
  if (OFF_STATES.has(state)) return state;
  if (team && paidAt) return 'paid';
  const at = Date.parse(earned);
  return Number.isFinite(at) && now >= at ? 'earned' : 'pending';
}

/**
 * One sale as the dashboard reads it: its state, partial refunds, the program
 * that pays it ('creem' for Plus and personal gifts, 'team' for a team gift),
 * the commission and where it stands. `taken` is its entry of partialRefunds(),
 * `payout` its row of partner_payouts (team only).
 */
export function describeSale(row, { state = '', taken = null, payout = null, now = Date.now() } = {}) {
  const sale = normalizePartnerSale(row);
  const partialTaken = state ? null : taken;
  const refundedAmount = partialTaken ? Math.min(partialTaken.amount, sale.amount ?? partialTaken.amount) : 0;
  const team = isTeamGift(sale.kind, sale.plan);
  const commission = saleCommission(sale, { refunded: refundedAmount });
  const earned = earnedAt(sale.createdAt);
  const paidAt = team && payout?.paidAt ? payout.paidAt : '';
  return {
    ...sale,
    state,
    test: isTestMode(sale.mode),
    partial: !!partialTaken,
    refundedAmount,
    refundUnknown: !!partialTaken?.unknown,
    program: team ? 'team' : 'creem',
    ...commission,
    earnedAt: earned,
    status: commissionStatus({ state, team, paidAt, earned }, now),
    paidAt,
    paidAmount: paidAt ? payout.amount : null,
    paidNote: paidAt ? payout.note || '' : ''
  };
}

const add = (into, currency, cents) => { if (cents > 0 && currency) into[currency] = (into[currency] || 0) + cents; };

/**
 * The dashboard's Partners card. Per code: sales, how many were refunded or
 * disputed (in full) or switched off, partly refunded, at the member price,
 * the revenue per currency (cents, after refunds; currencies never added
 * together), Creem's commissions (25%, for information: Creem pays them)
 * pending and earned, and team commissions (10%, the owner pays them) pending,
 * to pay and paid — most sales first. Then `recent`, the latest sales one by
 * one; `team`, the team commissions one by one (every one pending or to pay,
 * then the newest others); and `toPay`, the team commissions earned and not
 * paid yet, the oldest first. Sales made in Creem's test mode are listed but
 * counted apart (`test`, never in the figures or the lists of commissions).
 * `states` is saleStates() or its input rows, `refunds` the partner sales'
 * refund rows, `payouts` the rows of partner_payouts; `limit` is how many
 * sales the store was asked for: when it gave that many, `totals.capped` says
 * the figures cover only the latest ones. `now` (ms) decides what is earned.
 */
export function partnerSummary(rows = [], states = new Map(), refunds = [], { limit = PARTNER_SALES_LISTED, payouts = [], now = Date.now() } = {}) {
  const stateOf = states instanceof Map ? states : saleStates(states);
  const normalized = rows.map(normalizePartnerSale).filter(Boolean);
  const takenOf = refunds instanceof Map ? refunds : partialRefunds(refunds, normalized);
  const payoutOf = new Map((payouts || []).map(normalizePayout).filter(row => row?.checkoutId).map(row => [row.checkoutId, row]));
  const sales = normalized.map(row => describeSale(row, { state: stateOf.get(row.checkoutId) || '', taken: takenOf.get(row.checkoutId), payout: payoutOf.get(row.checkoutId), now }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.checkoutId.localeCompare(b.checkoutId));
  const codes = new Map();
  const revenue = {};
  const test = { sales: 0, revenue: {} };
  const creem = { pending: {}, earned: {} };
  const teamTotals = { pending: {}, toPay: {}, paid: {} };
  const blank = code => ({
    code, sales: 0, refunded: 0, partial: 0, revoked: 0, members: 0, revenue: {}, test: 0, lastAt: '',
    creem: { sales: 0, pending: {}, earned: {} },
    team: { sales: 0, pending: {}, toPay: {}, paid: {} }
  });
  for (const sale of sales) {
    const entry = codes.get(sale.code) || blank(sale.code);
    const net = sale.state || sale.amount == null ? 0 : sale.amount - sale.refundedAmount;
    if (sale.test) {
      entry.test += 1;
      test.sales += 1;
      add(test.revenue, sale.currency, net);
    } else {
      entry.sales += 1;
      if (sale.state === 'refunded' || sale.state === 'disputed') entry.refunded += 1;
      if (sale.state === 'revoked') entry.revoked += 1;
      if (sale.partial) entry.partial += 1;
      if (sale.member) entry.members += 1;
      add(entry.revenue, sale.currency, net);
      add(revenue, sale.currency, net);
      const program = sale.program === 'team' ? entry.team : entry.creem;
      program.sales += 1;
      const cents = sale.commission ?? 0;
      if (sale.program === 'team') {
        const bucket = { pending: 'pending', earned: 'toPay', paid: 'paid' }[sale.status];
        const paid = sale.status === 'paid' ? sale.paidAmount ?? cents : cents;
        if (bucket) { add(entry.team[bucket], sale.currency, paid); add(teamTotals[bucket], sale.currency, paid); }
      } else if (sale.status === 'pending' || sale.status === 'earned') {
        add(entry.creem[sale.status], sale.currency, cents);
        add(creem[sale.status], sale.currency, cents);
      }
    }
    if (sale.createdAt > entry.lastAt) entry.lastAt = sale.createdAt;
    codes.set(sale.code, entry);
  }
  const live = sales.filter(sale => !sale.test);
  const liveTeam = live.filter(sale => sale.program === 'team');
  const open = liveTeam.filter(sale => sale.status === 'pending' || sale.status === 'earned');
  const settled = liveTeam.filter(sale => !open.includes(sale)).slice(0, Math.max(0, TEAM_COMMISSIONS_LISTED - open.length));
  const toPay = open.filter(sale => sale.status === 'earned').sort((a, b) => a.earnedAt.localeCompare(b.earnedAt) || a.checkoutId.localeCompare(b.checkoutId));
  const sorted = map => byCurrency(map);
  return {
    codes: [...codes.values()].map(entry => ({
      ...entry,
      revenue: sorted(entry.revenue),
      creem: { sales: entry.creem.sales, pending: sorted(entry.creem.pending), earned: sorted(entry.creem.earned) },
      team: { sales: entry.team.sales, pending: sorted(entry.team.pending), toPay: sorted(entry.team.toPay), paid: sorted(entry.team.paid) }
    })).sort((a, b) => b.sales - a.sales || b.test - a.test || b.lastAt.localeCompare(a.lastAt) || a.code.localeCompare(b.code)),
    recent: sales.slice(0, PARTNER_RECENT),
    team: [...open, ...settled].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.checkoutId.localeCompare(b.checkoutId)),
    toPay: toPay.map(sale => ({ checkoutId: sale.checkoutId, code: sale.code, plan: sale.plan, rate: sale.rate, base: sale.base, basis: sale.basis, commission: sale.commission, currency: sale.currency, earnedAt: sale.earnedAt, createdAt: sale.createdAt })),
    totals: {
      sales: live.length,
      partners: new Set(live.map(sale => sale.code)).size,
      refunded: live.filter(sale => sale.state).length,
      partial: live.filter(sale => sale.partial).length,
      revenue: sorted(revenue),
      test: { sales: test.sales, revenue: sorted(test.revenue) },
      creem: { pending: sorted(creem.pending), earned: sorted(creem.earned) },
      team: { pending: sorted(teamTotals.pending), toPay: sorted(teamTotals.toPay), paid: sorted(teamTotals.paid), toPayCount: toPay.length },
      listed: sales.length,
      capped: limit > 0 && rows.length >= limit
    }
  };
}

/**
 * Whether a team commission may be marked as paid now: { sale } (described,
 * status 'earned') or { status, error } — 404 when no live team sale has
 * this checkout, 409 when it is still pending, already paid or earns nothing.
 */
export function payoutCheck(summary, checkoutId) {
  const sale = (summary?.team || []).find(row => row.checkoutId === checkoutId);
  if (!sale) return { status: 404, error: 'No team gift sold through a partner’s link has this checkout.' };
  if (sale.status === 'paid') return { status: 409, error: 'This commission is already marked as paid.' };
  if (sale.status === 'pending') return { status: 409, error: `This sale is still within its ${PARTNER_PROGRAM.refundDays}-day refund period: its commission isn’t earned yet.` };
  if (sale.status !== 'earned') return { status: 409, error: 'This sale was refunded, disputed or switched off: it earns nothing.' };
  if (!(sale.commission > 0) || !sale.currency) return { status: 409, error: 'This sale has no amount, so its commission can’t be worked out.' };
  return { sale };
}
