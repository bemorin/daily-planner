// Partner sales (migrations 0006 and 0007): which partner's link each paid sale
// came through, and what it earns the partner. Pure helpers, shared by the
// router (server/planner-api.js), both stores and the tests.
//
// A partner shares https://planner.bemorin.com/welcome/?ref=CODE. The visitor's
// browser keeps the code for 30 days (PARTNER_PROGRAM.cookieDays) and sends it
// with a checkout. For Plus and the personal gifts the API passes it to Creem
// as `affiliate_code`: Creem's affiliate program credits the partner and pays
// the 25% commission (Creem refuses a code it doesn't know). Since 1.28 a team
// gift is never sent to Creem with the code (Creem has one rate per program):
// its 10% is paid by the owner, by bank transfer, and the checkout's sealed
// metadata says so (`payout: 'owner'`). Team gifts sold before 1.28 were sent
// with the code, so Creem credits them: they stay Creem's to pay (`payer`).
// Every item carries the code in the checkout's metadata (`ref`), sealed with
// the rest of the checkout (server/creem.js). Once the checkout is paid
// (webhook or claim), and only with a valid seal — a product link opened by
// hand can't name a partner — the sale is recorded here: the code, what was
// bought, who pays the commission, the amount and the tax included in it
// (when Creem gives it), the currency, whether the member price applied,
// Creem's mode (test or live) and the date. Nothing about the buyer: a partner
// code names the partner, not the person who bought.
//
// Who pays is kept in partner_sales itself (migration 0006, which every 1.27
// deployment has): kind 'team' is a team gift whose commission the owner pays,
// kind 'gift' with a team plan one sold before 1.28 (Creem pays it). So a team
// sale made while migration 0007 is missing is still the owner's to pay.
//
// Nothing checks a code on a team checkout (Creem never sees it), so a team
// commission's code counts as confirmed only once Creem accepted it on a sale
// already recorded (any live sale Creem credits), or once the owner paid a
// commission to it; until then the dashboard asks the owner to check it in
// Creem → Affiliate Hub before paying, and the owner can mark it as not a
// partner (table partner_code_rejections: its team commissions earn nothing).
//
// The commission (PARTNER_PROGRAM in src/lib/pricing.js) is a share of the
// amount before tax: the amount paid less the tax Creem reports, less any
// partial refund (taken off in proportion). When the tax isn't known (sales
// recorded before migration 0007, or Creem didn't give it) or a partial
// refund's amount isn't, the figure is only an upper bound (`exact: false`:
// on the amount paid, tax included, before that refund) and the owner types
// what they paid when marking it as paid. A sale earns once its refund period
// (PARTNER_PROGRAM.refundDays) has passed without a refund or a dispute; a
// refunded, disputed or switched-off sale earns nothing. The owner marks a
// team commission as paid in the dashboard (table partner_payouts); a
// commission paid stays paid, even if the sale is refunded or disputed later.

import { CREEM_REASONS, moneyText } from './refunds.js';
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
export const COMMISSION_STATUSES = Object.freeze(['pending', 'earned', 'paid', 'refunded', 'disputed', 'revoked', 'not-partner']);
const OFF_STATES = new Set(['refunded', 'disputed', 'revoked']);
/** Who pays a partner's commission: Creem (it credited the code at checkout) or the owner (a team gift, since 1.28). */
export const PAYERS = Object.freeze(['creem', 'owner']);
/** What to check before paying a team commission: a code nothing confirmed, a refund of unknown amount, the tax. */
export const PAYOUT_CHECKS = Object.freeze(['code', 'refund', 'tax']);

const wholeOrNull = value => {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
};

/** Whether the owner pays a sale's commission: a team gift opened without Creem's affiliate_code (1.28 and later). */
const ownerPays = sale => sale?.payer === 'owner' && isTeamGift(sale.kind, sale.plan);

/**
 * The row to keep for a paid checkout (readCheckout() in server/creem.js, with
 * `sealed` from the router), or null when no partner's link was used or our
 * API did not open it (no valid seal: the code, who pays and the member flag
 * are only someone's metadata). The member price applies to gifts only.
 * `payer` is 'owner' only for a team gift whose checkout says so (sealed
 * `payout: 'owner'`, 1.28 and later): one opened before had `affiliate_code`,
 * so Creem credited the partner.
 */
export function partnerSaleRow(checkoutId, paid, createdAt) {
  if (!paid?.ref || !paid.item || paid.sealed !== true) return null;
  const amount = Number.isInteger(paid.amount) ? paid.amount : null;
  const tax = wholeOrNull(paid.tax);
  const owner = paid.payout === 'owner' && isTeamGift(paid.item.kind, paid.item.plan);
  return {
    checkoutId,
    code: paid.ref,
    kind: paid.item.kind,
    plan: paid.item.plan || '',
    payer: owner ? 'owner' : 'creem',
    amount,
    tax: tax != null && amount != null && tax <= amount ? tax : null,
    currency: paid.currency || '',
    member: paid.item.kind === 'gift' && paid.member === true,
    mode: paid.mode || '',
    createdAt
  };
}

/**
 * partner_sales.kind as stored: 'team' for a team gift whose commission the
 * owner pays, else what was bought ('plus' or 'gift'). Who pays lives in the
 * 0006 table so it holds even while migration 0007 is missing.
 */
export const storedSaleKind = row => (ownerPays(row) ? 'team' : String(row?.kind ?? ''));

/** Same shape from both stores: booleans and numbers, null when unknown; a stored kind 'team' reads as a gift the owner pays. */
export function normalizePartnerSale(row) {
  if (!row) return null;
  const stored = String(row.kind ?? '');
  const sale = {
    checkoutId: String(row.checkoutId ?? ''),
    code: String(row.code ?? ''),
    kind: stored === 'team' ? 'gift' : stored,
    plan: String(row.plan ?? ''),
    payer: 'creem',
    amount: row.amount == null || row.amount === '' ? null : Number(row.amount),
    tax: wholeOrNull(row.tax),
    currency: String(row.currency ?? ''),
    member: row.member === true || Number(row.member) === 1,
    mode: String(row.mode ?? ''),
    createdAt: String(row.createdAt ?? '')
  };
  if ((stored === 'team' || row.payer === 'owner') && isTeamGift(sale.kind, sale.plan)) sale.payer = 'owner';
  return sale;
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

/** A partner code the owner marked as not a partner (migration 0007), the same from both stores. */
export function normalizeCodeRejection(row) {
  if (!row) return null;
  return { code: String(row.code ?? ''), createdAt: String(row.createdAt ?? '') };
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
 * instead (saleStates); a partial (or unclear) refund whose amount Creem
 * didn't give, or in another currency than the sale, is counted in `unknown`.
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
 * The rate a sale earns, in percent: PARTNER_PROGRAM.teamRate for a team gift
 * the owner pays; PARTNER_PROGRAM.rate for what Creem credits (Plus, the
 * personal gifts, and a team gift sold before 1.28, sent to Creem with the
 * code); 0 for anything else.
 */
export function saleRate(sale) {
  if (!partnerRate(sale?.kind, sale?.plan)) return 0;
  return ownerPays(sale) ? PARTNER_PROGRAM.teamRate : PARTNER_PROGRAM.rate;
}

/**
 * The commission on one sale: { rate, base, basis, commission, exact }.
 * `base` is the amount it is worked out on, in cents: the amount kept after
 * `refunded` (partial refunds), before tax when the tax is known
 * ('before-tax', the refund taken off in proportion), else the amount paid
 * ('paid'). `exact` is false when the figure is only an upper bound: the tax
 * isn't known (it is on the amount paid, tax included), or a partial refund's
 * amount isn't (`refundUnknown`). null amounts when the sale's amount isn't
 * known or nothing earns on it.
 */
export function saleCommission(sale, { refunded = 0, refundUnknown = false } = {}) {
  const rate = saleRate(sale);
  const amount = wholeOrNull(sale?.amount);
  if (!rate || amount == null) return { rate, base: null, basis: '', commission: null, exact: false };
  const kept = Math.max(0, amount - Math.max(0, Number(refunded) || 0));
  const tax = wholeOrNull(sale.tax);
  const taxKnown = tax != null && tax <= amount;
  const base = !taxKnown ? kept : amount ? Math.round(kept * (amount - tax) / amount) : 0;
  return { rate, base, basis: taxKnown ? 'before-tax' : 'paid', commission: commissionCents(base, rate), exact: taxKnown && !refundUnknown };
}

/** When a sale's refund period ends (ISO), '' when its date can't be read. */
export function earnedAt(createdAt, days = PARTNER_PROGRAM.refundDays) {
  const time = Date.parse(String(createdAt || ''));
  return Number.isFinite(time) ? new Date(time + days * DAY_MS).toISOString() : '';
}

/**
 * Where a sale's commission stands: 'paid' (a team commission the owner
 * marked as paid — it stays paid if the sale is refunded or disputed later),
 * 'refunded', 'disputed' or 'revoked' (it earns nothing), 'not-partner' (a
 * team commission whose code the owner found no partner for), 'earned' (its
 * refund period is over) or 'pending' (still within it).
 */
export function commissionStatus({ state = '', team = false, paidAt = '', earned = '', rejected = false }, now) {
  if (team && paidAt) return 'paid';
  if (OFF_STATES.has(state)) return state;
  if (team && rejected) return 'not-partner';
  const at = Date.parse(earned);
  return Number.isFinite(at) && now >= at ? 'earned' : 'pending';
}

/**
 * Which partner codes are confirmed, from the sales (normalized), the payouts
 * and the owner's rejections: Map<code, 'creem' | 'paid' | 'rejected'>.
 * 'creem': Creem accepted the code on a live sale it credits (it refuses a
 * code it doesn't know); 'paid': the owner paid a commission to it, so they
 * checked it; 'rejected': the owner checked Creem and found no such partner
 * (it wins). A code missing from the map isn't confirmed: nothing checks a
 * code on a team checkout, so anyone can type one in a link.
 */
export function codeChecks(sales = [], payouts = [], rejections = []) {
  const checks = new Map();
  for (const sale of sales) if (sale?.code && !isTestMode(sale.mode) && !ownerPays(sale)) checks.set(sale.code, 'creem');
  for (const payout of payouts) if (payout?.code && !checks.has(payout.code)) checks.set(payout.code, 'paid');
  for (const row of rejections) if (row?.code) checks.set(row.code, 'rejected');
  return checks;
}

/**
 * One sale as the dashboard reads it: its state, partial refunds, the program
 * that pays it ('creem' for what Creem credits, 'team' for a team gift the
 * owner pays), the commission and where it stands. `taken` is its entry of
 * partialRefunds(), `payout` its row of partner_payouts (team only), `check`
 * its code's entry of codeChecks() ('' when not confirmed). `checks` lists
 * what to check before paying a team commission still open (PAYOUT_CHECKS).
 */
export function describeSale(row, { state = '', taken = null, payout = null, check = '', now = Date.now() } = {}) {
  const sale = normalizePartnerSale(row);
  const partialTaken = state ? null : taken;
  const refundedAmount = partialTaken ? Math.min(partialTaken.amount, sale.amount ?? partialTaken.amount) : 0;
  const refundUnknown = !!partialTaken?.unknown;
  const team = ownerPays(sale);
  const commission = saleCommission(sale, { refunded: refundedAmount, refundUnknown });
  const earned = earnedAt(sale.createdAt);
  const paidAt = team && payout?.paidAt ? payout.paidAt : '';
  // Creem refuses a code it doesn't know: what it credits needs no check.
  const codeCheck = team ? check : 'creem';
  const status = commissionStatus({ state, team, paidAt, earned, rejected: codeCheck === 'rejected' }, now);
  const open = team && (status === 'pending' || status === 'earned');
  const checks = open ? PAYOUT_CHECKS.filter(key => (key === 'code' ? !codeCheck : key === 'refund' ? refundUnknown : commission.basis === 'paid')) : [];
  return {
    ...sale,
    state,
    test: isTestMode(sale.mode),
    partial: !!partialTaken,
    refundedAmount,
    refundUnknown,
    program: team ? 'team' : 'creem',
    ...commission,
    codeCheck,
    checks,
    earnedAt: earned,
    status,
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
 * then the newest others); `toPay`, the team commissions earned and not paid
 * yet, the oldest first, each with what to check before paying it; and
 * `codeChecks`, which codes are confirmed (codeChecks(), as an object). Sales
 * made in Creem's test mode are listed but counted apart (`test`, never in the
 * figures or the lists of commissions). `states` is saleStates() or its input
 * rows, `refunds` the partner sales' refund rows, `payouts` the rows of
 * partner_payouts, `rejections` those of partner_code_rejections; `limit` is
 * how many sales the store was asked for: when it gave that many,
 * `totals.capped` says the figures cover only the latest ones. `now` (ms)
 * decides what is earned.
 */
export function partnerSummary(rows = [], states = new Map(), refunds = [], { limit = PARTNER_SALES_LISTED, payouts = [], rejections = [], now = Date.now() } = {}) {
  const stateOf = states instanceof Map ? states : saleStates(states);
  const normalized = rows.map(normalizePartnerSale).filter(Boolean);
  const takenOf = refunds instanceof Map ? refunds : partialRefunds(refunds, normalized);
  const payoutRows = (payouts || []).map(normalizePayout).filter(row => row?.checkoutId);
  const payoutOf = new Map(payoutRows.map(row => [row.checkoutId, row]));
  const checkOf = codeChecks(normalized, payoutRows, (rejections || []).map(normalizeCodeRejection).filter(Boolean));
  const sales = normalized.map(row => describeSale(row, { state: stateOf.get(row.checkoutId) || '', taken: takenOf.get(row.checkoutId), payout: payoutOf.get(row.checkoutId), check: checkOf.get(row.code) || '', now }))
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
    toPay: toPay.map(sale => ({
      checkoutId: sale.checkoutId, code: sale.code, plan: sale.plan, amount: sale.amount, refundedAmount: sale.refundedAmount, refundUnknown: sale.refundUnknown,
      rate: sale.rate, base: sale.base, basis: sale.basis, commission: sale.commission, exact: sale.exact, currency: sale.currency, checks: sale.checks, earnedAt: sale.earnedAt, createdAt: sale.createdAt
    })),
    codeChecks: Object.fromEntries([...checkOf].sort(([a], [b]) => a.localeCompare(b))),
    totals: {
      sales: live.length,
      partners: new Set(live.map(sale => sale.code)).size,
      refunded: live.filter(sale => sale.state).length,
      partial: live.filter(sale => sale.partial).length,
      revenue: sorted(revenue),
      test: { sales: test.sales, revenue: sorted(test.revenue) },
      creem: { pending: sorted(creem.pending), earned: sorted(creem.earned) },
      team: { pending: sorted(teamTotals.pending), toPay: sorted(teamTotals.toPay), paid: sorted(teamTotals.paid), toPayCount: toPay.length, toCheck: toPay.filter(sale => sale.checks.length).length },
      // Commissions still pending or earned whose figure is only an upper bound (tax or a refund's amount unknown).
      inexact: live.filter(sale => sale.commission != null && !sale.exact && ['pending', 'earned'].includes(sale.status)).length,
      listed: sales.length,
      capped: limit > 0 && rows.length >= limit
    }
  };
}

/** What to check before paying a team commission (describeSale's `checks`), in the owner's words. */
export function payoutChecksText(sale) {
  const checks = Array.isArray(sale?.checks) ? sale.checks : [];
  return [
    checks.includes('code') && `${sale.code} isn’t confirmed: no sale credited by Creem has used this code yet. Check that ${sale.code} is a partner in Creem → Affiliate Hub before paying.`,
    checks.includes('refund') && 'Part of this sale was refunded and Creem didn’t give the amount: check the refund in Creem before paying.',
    checks.includes('tax') && `The tax on this sale isn’t recorded: check it in Creem, and pay ${sale.rate}% of the price before tax.`
  ].filter(Boolean).join(' ');
}

/**
 * Whether a team commission may be marked as paid now: { sale, amount }
 * (described, status 'earned'; `amount` what to record, in cents) or
 * { status, error } — 404 when no live team sale has this checkout, 409 when
 * it is still pending, already paid or earns nothing, or when something must
 * be checked first (`checks`) and the owner didn't confirm they did
 * (`confirmed`); 400 for an amount that doesn't fit. `amount` is what the
 * owner paid, for a commission that is only an upper bound (tax or a refund's
 * amount unknown): required then, at most that bound; never for an exact one.
 */
export function payoutCheck(summary, checkoutId, { confirmed = false, amount = null } = {}) {
  const sale = (summary?.team || []).find(row => row.checkoutId === checkoutId);
  if (!sale) return { status: 404, error: 'No team gift sold through a partner’s link has this checkout.' };
  if (sale.status === 'paid') return { status: 409, error: 'This commission is already marked as paid.' };
  if (sale.status === 'pending') return { status: 409, error: `This sale is still within its ${PARTNER_PROGRAM.refundDays}-day refund period: its commission isn’t earned yet.` };
  if (sale.status === 'not-partner') return { status: 409, error: `You marked ${sale.code} as not a partner, so this commission earns nothing. Undo that first if ${sale.code} is a partner in Creem.` };
  if (sale.status !== 'earned') return { status: 409, error: 'This sale was refunded, disputed or switched off: it earns nothing.' };
  if (!(sale.commission > 0) || !sale.currency) return { status: 409, error: 'This sale has no amount, so its commission can’t be worked out.' };
  const checks = Array.isArray(sale.checks) ? sale.checks : [];
  if (checks.length && confirmed !== true) return { status: 409, error: `${payoutChecksText(sale)} Then mark it as paid again.`, checks };
  if (sale.exact) {
    if (amount != null && amount !== sale.commission) return { status: 400, error: `This commission is known (${moneyText(sale.commission, sale.currency)}): mark it as paid without an amount.` };
    return { sale, amount: sale.commission };
  }
  if (!Number.isInteger(amount) || amount < 1 || amount > sale.commission) {
    return { status: 400, error: `Give the amount you paid: more than nothing and at most ${moneyText(sale.commission, sale.currency)} (${sale.rate}% of the amount paid, tax included).` };
  }
  return { sale, amount };
}
