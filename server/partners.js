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
//
// 1.33 (migration 0008): the owner records whether a partner is an individual
// (the default, also for every code while 0008 is missing) or a business (a
// micro-entreprise or a company, any country, paid against an invoice). An
// individual's team commissions are capped per calendar year (UTC) and per
// currency (PARTNER_PROGRAM.individualYearlyCap), by the date they are paid:
// earned commissions are given what is left of the cap, the oldest first, and
// the rest is “held above the cap” until the partner becomes a business or
// the next year starts. So a commission can be paid in parts: the payment
// that settles it keeps its checkout id in partner_payouts, as before; a part
// paid before it is `<checkout>.<n>` (payoutPartId). Each partner can open a
// private statement (partnerStatement): visits through their link (table
// partner_visits, daily totals), their purchases by kind and each team
// commission's state — never anything about a buyer or another partner. Its
// link is signed (statementKey: HMAC of the code with a key derived from
// ADMIN_TOKEN, apart from every other use of it).

import { timingSafeEqual } from './admin-auth.js';
import { createRateLimiter } from './admin-limits.js';
import { affiliateCode } from './creem.js';
import { CREEM_REASONS, moneyText } from './refunds.js';
import { commissionCents, isPersonalGift, isTeamGift, PARTNER_PROGRAM, partnerRate, teamTier } from '../src/lib/pricing.js';

/** Sales read for the dashboard's Partners card (newest first), and how many are listed one by one. */
export const PARTNER_SALES_LISTED = 2000;
export const PARTNER_RECENT = 25;
/** Team commissions listed one by one: every one still to pay, then the newest others. */
export const TEAM_COMMISSIONS_LISTED = 200;
export const PAYOUT_NOTE_MAX = 200;
const DAY_MS = 86400000;
const CURRENCY_ORDER = ['EUR', 'USD'];
/** What a commission is, in the order the dashboard reads them. */
export const COMMISSION_STATUSES = Object.freeze(['pending', 'earned', 'held', 'paid', 'refunded', 'disputed', 'revoked', 'not-partner']);
/** Still open: pending, earned (to pay) or held above an individual's yearly cap. */
const OPEN_STATES = new Set(['pending', 'earned', 'held']);
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

/** What the owner records about a partner (migration 0008): an individual (the default: capped each year) or a business (invoices, no cap). */
export const PARTNER_STATUSES = Object.freeze(['individual', 'business']);
/** A stored or typed status: 'business', else 'individual' (anything unknown is treated as an individual, the safe side). */
export const partnerStatus = value => (String(value ?? '').trim().toLowerCase() === 'business' ? 'business' : 'individual');

/** A partner's profile (migration 0008), the same from both stores: { code, status, updatedAt }. */
export function normalizeProfile(row) {
  if (!row) return null;
  return { code: String(row.code ?? ''), status: partnerStatus(row.status), updatedAt: String(row.updatedAt ?? '') };
}

/**
 * The row id of a team commission's payment (partner_payouts.checkout_id):
 * the checkout itself for the payment that settles it (part 0, as before
 * 1.33), `<checkout>.<n>` for a part paid before it, when an individual's
 * yearly cap held the rest back. A checkout id never has a dot (CHECKOUT_ID_RE).
 */
export const payoutPartId = (checkoutId, part = 0) => (part > 0 ? `${checkoutId}.${part}` : String(checkoutId ?? ''));

/** The checkout a payout row pays and which part it is: { checkoutId, part } (0: the payment that settles it). */
export function payoutTarget(id) {
  const text = String(id ?? '');
  const match = /^([^.]+)\.(\d{1,4})$/.exec(text);
  return match && Number(match[2]) > 0 ? { checkoutId: match[1], part: Number(match[2]) } : { checkoutId: text, part: 0 };
}

/** A team commission's payments, the oldest first: { final (the row that settles it, or null), rows, next (the next part's number) }. */
export function payoutParts(checkoutId, rows = []) {
  const mine = (rows || []).filter(row => row && payoutTarget(row.checkoutId).checkoutId === checkoutId)
    .sort((a, b) => String(a.paidAt).localeCompare(String(b.paidAt)) || payoutTarget(a.checkoutId).part - payoutTarget(b.checkoutId).part);
  const final = mine.find(row => payoutTarget(row.checkoutId).part === 0) || null;
  const next = Math.max(0, ...mine.map(row => payoutTarget(row.checkoutId).part)) + 1;
  return { final, rows: mine, next };
}

/** The yearly cap of an individual's team commissions in a currency, in cents; null for a currency it doesn't name. */
export function yearlyCapCents(currency, program = PARTNER_PROGRAM) {
  const units = Number(program.individualYearlyCap?.[currency]);
  return Number.isFinite(units) && units > 0 ? Math.round(units * 100) : null;
}

/** The calendar year (UTC) of an ISO date, NaN when it can't be read. */
export const utcYear = iso => {
  const time = Date.parse(String(iso || ''));
  return Number.isFinite(time) ? new Date(time).getUTCFullYear() : Number.NaN;
};

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

const currencyRank = code => (CURRENCY_ORDER.includes(code) ? CURRENCY_ORDER.indexOf(code) : CURRENCY_ORDER.length);
const byCurrency = totals => Object.fromEntries(Object.entries(totals).sort(([a], [b]) => currencyRank(a) - currencyRank(b) || a.localeCompare(b)));

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
 * partialRefunds(), `payouts` its rows of partner_payouts (team only: the
 * payment that settles it and the parts paid before; `payout`, one row, is
 * read the same), `check` its code's entry of codeChecks() ('' when not
 * confirmed). `checks` lists what to check before paying a team commission
 * still open (PAYOUT_CHECKS). `paidAmount` is what was paid so far (null
 * when nothing), `rest` what is still owed on an open one; `payable` and
 * `held` split the rest under an individual's yearly cap (partnerSummary
 * works them out; here everything is payable).
 */
export function describeSale(row, { state = '', taken = null, payout = null, payouts = null, check = '', now = Date.now() } = {}) {
  const sale = normalizePartnerSale(row);
  const partialTaken = state ? null : taken;
  const refundedAmount = partialTaken ? Math.min(partialTaken.amount, sale.amount ?? partialTaken.amount) : 0;
  const refundUnknown = !!partialTaken?.unknown;
  const team = ownerPays(sale);
  const commission = saleCommission(sale, { refunded: refundedAmount, refundUnknown });
  const earned = earnedAt(sale.createdAt);
  const { final, rows } = team ? payoutParts(sale.checkoutId, payouts ?? (payout ? [{ ...payout, checkoutId: payout.checkoutId || sale.checkoutId }] : [])) : { final: null, rows: [] };
  const partsPaid = rows.filter(entry => entry !== final).reduce((sum, entry) => sum + (entry.amount ?? 0), 0);
  // A settling row without an amount (none is written so) stands for what was left of the commission.
  const paidAmount = rows.length ? partsPaid + (final ? final.amount ?? Math.max(0, (commission.commission ?? 0) - partsPaid) : 0) : null;
  const last = rows.at(-1) || null;
  // Creem refuses a code it doesn't know: what it credits needs no check.
  const codeCheck = team ? check : 'creem';
  const rejected = codeCheck === 'rejected';
  // Paid in part, then refunded, disputed or found to be no partner: the part paid stays paid, the rest earns nothing.
  const settled = final || (rows.length && (OFF_STATES.has(state) || rejected) ? last : null);
  const status = commissionStatus({ state, team, paidAt: settled?.paidAt || '', earned, rejected }, now);
  const open = team && OPEN_STATES.has(status);
  const checks = open ? PAYOUT_CHECKS.filter(key => (key === 'code' ? !codeCheck : key === 'refund' ? refundUnknown : commission.basis === 'paid')) : [];
  const rest = open ? Math.max(0, (commission.commission ?? 0) - (paidAmount ?? 0)) : 0;
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
    paidAt: status === 'paid' && settled ? settled.paidAt : '',
    paidAmount: team ? paidAmount : null,
    paidNote: team && last ? (final || last).note || '' : '',
    lastPaidAt: team && last ? last.paidAt : '',
    parts: rows.length,
    rest,
    payable: rest,
    held: 0,
    partner: 'individual',
    cap: null
  };
}

const add = (into, currency, cents) => { if (cents > 0 && currency) into[currency] = (into[currency] || 0) + cents; };

/**
 * The yearly cap of individuals, applied to the described sales (mutated):
 * per code and currency, what was paid in `year` (every payment and part, by
 * the date paid, from the payout rows) leaves the rest of the cap to the
 * earned commissions, the oldest earned first; what doesn't fit is `held`,
 * and a commission with nothing payable reads 'held'. A business (`statusOf`)
 * has no cap. Each live team sale gets `partner` and, for an individual,
 * `cap` ({ year, limit, paid }: cents in its currency). Returns
 * Map<code, Map<currency, { limit, paid }>> for the codes' cap lines.
 */
function applyYearlyCap(sales, payoutRows, statusOf, year) {
  const byCheckout = new Map(sales.map(sale => [sale.checkoutId, sale]));
  const paid = new Map();
  const paidOf = code => { if (!paid.has(code)) paid.set(code, new Map()); return paid.get(code); };
  for (const row of payoutRows) {
    if (utcYear(row.paidAt) !== year) continue;
    const sale = byCheckout.get(payoutTarget(row.checkoutId).checkoutId);
    const code = row.code || sale?.code || '';
    const currency = row.currency || sale?.currency || '';
    // Every payment row has its amount (the dashboard always records one).
    const cents = row.amount ?? 0;
    if (!code || !currency || !(cents > 0)) continue;
    const map = paidOf(code);
    map.set(currency, (map.get(currency) || 0) + cents);
  }
  const team = sales.filter(sale => sale.program === 'team' && !sale.test);
  const lines = new Map();
  const lineOf = (code, currency) => {
    if (!lines.has(code)) lines.set(code, new Map());
    const map = lines.get(code);
    if (!map.has(currency)) {
      const limit = yearlyCapCents(currency);
      const already = paid.get(code)?.get(currency) || 0;
      map.set(currency, { limit, paid: already, left: limit == null ? null : Math.max(0, limit - already) });
    }
    return map.get(currency);
  };
  for (const sale of team) {
    sale.partner = statusOf(sale.code);
    if (sale.partner !== 'individual' || !sale.currency) continue;
    const line = lineOf(sale.code, sale.currency);
    if (line.limit != null) sale.cap = { year, limit: line.limit, paid: line.paid };
  }
  // Codes paid this year whose sales aren't listed still show their cap line.
  for (const [code, map] of paid) if (statusOf(code) === 'individual') for (const currency of map.keys()) lineOf(code, currency);
  const earned = team.filter(sale => sale.status === 'earned' && sale.cap).sort((a, b) => a.earnedAt.localeCompare(b.earnedAt) || a.checkoutId.localeCompare(b.checkoutId));
  for (const sale of earned) {
    const line = lineOf(sale.code, sale.currency);
    const payable = Math.min(sale.rest, line.left);
    line.left -= payable;
    sale.payable = payable;
    sale.held = sale.rest - payable;
    if (sale.rest > 0 && payable === 0) sale.status = 'held';
  }
  return lines;
}

/**
 * The dashboard's Partners card. Per code: sales, how many were refunded or
 * disputed (in full) or switched off, partly refunded, at the member price,
 * the revenue per currency (cents, after refunds; currencies never added
 * together), Creem's commissions (25%, for information: Creem pays them)
 * pending and earned, and team commissions (10%, the owner pays them) pending,
 * to pay (what can be paid now), held above an individual's yearly cap and
 * paid — most sales first — with the partner's status (`partner`: 'individual'
 * or 'business', from `profiles`, migration 0008) and, for an individual,
 * `cap`: { year, lines: [{ currency, limit, paid, left, held }] }. Then
 * `recent`, the latest sales one by one; `team`, the team commissions one by
 * one (every one pending, to pay or held, then the newest others); `toPay`,
 * the team commissions with something payable now (earned, under the cap),
 * the oldest first, each with what to check before paying it; and
 * `codeChecks`, which codes are confirmed (codeChecks(), as an object). Sales
 * made in Creem's test mode are listed but counted apart (`test`, never in the
 * figures or the lists of commissions). `states` is saleStates() or its input
 * rows, `refunds` the partner sales' refund rows, `payouts` the rows of
 * partner_payouts (parts included), `rejections` those of
 * partner_code_rejections; `limit` is how many sales the store was asked
 * for: when it gave that many, `totals.capped` says the figures cover only the
 * latest ones. `now` (ms) decides what is earned, and the year of the cap.
 * `withSales` adds `sales`, every sale described (partnerStatement).
 */
export function partnerSummary(rows = [], states = new Map(), refunds = [], { limit = PARTNER_SALES_LISTED, payouts = [], rejections = [], profiles = [], now = Date.now(), withSales = false } = {}) {
  const stateOf = states instanceof Map ? states : saleStates(states);
  const normalized = rows.map(normalizePartnerSale).filter(Boolean);
  const takenOf = refunds instanceof Map ? refunds : partialRefunds(refunds, normalized);
  const payoutRows = (payouts || []).map(normalizePayout).filter(row => row?.checkoutId);
  const payoutsOf = new Map();
  for (const row of payoutRows) {
    const id = payoutTarget(row.checkoutId).checkoutId;
    if (!payoutsOf.has(id)) payoutsOf.set(id, []);
    payoutsOf.get(id).push(row);
  }
  const checkOf = codeChecks(normalized, payoutRows, (rejections || []).map(normalizeCodeRejection).filter(Boolean));
  const profileOf = new Map((profiles || []).map(normalizeProfile).filter(row => row?.code).map(row => [row.code, row.status]));
  const statusOf = code => profileOf.get(code) || 'individual';
  const year = new Date(now).getUTCFullYear();
  const sales = normalized.map(row => describeSale(row, { state: stateOf.get(row.checkoutId) || '', taken: takenOf.get(row.checkoutId), payouts: payoutsOf.get(row.checkoutId) || [], check: checkOf.get(row.code) || '', now }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.checkoutId.localeCompare(b.checkoutId));
  const capLines = applyYearlyCap(sales, payoutRows, statusOf, year);
  const codes = new Map();
  const revenue = {};
  const test = { sales: 0, revenue: {} };
  const creem = { pending: {}, earned: {} };
  const teamTotals = { pending: {}, toPay: {}, held: {}, paid: {} };
  const blank = code => ({
    code, sales: 0, refunded: 0, partial: 0, revoked: 0, members: 0, revenue: {}, test: 0, lastAt: '',
    creem: { sales: 0, pending: {}, earned: {} },
    team: { sales: 0, pending: {}, toPay: {}, held: {}, paid: {} }
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
        const both = (bucket, amount) => { add(entry.team[bucket], sale.currency, amount); add(teamTotals[bucket], sale.currency, amount); };
        if (sale.status === 'pending') both('pending', sale.rest);
        if (sale.status === 'earned' || sale.status === 'held') { both('toPay', sale.payable); both('held', sale.held); }
        // What went out: a settled commission, or the parts paid of one still open (or switched off since).
        if (sale.paidAmount) both('paid', sale.paidAmount);
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
  const open = liveTeam.filter(sale => OPEN_STATES.has(sale.status));
  const settled = liveTeam.filter(sale => !open.includes(sale)).slice(0, Math.max(0, TEAM_COMMISSIONS_LISTED - open.length));
  const toPay = open.filter(sale => sale.status === 'earned' && sale.payable > 0).sort((a, b) => a.earnedAt.localeCompare(b.earnedAt) || a.checkoutId.localeCompare(b.checkoutId));
  const sorted = map => byCurrency(map);
  const capOf = code => {
    if (statusOf(code) !== 'individual' || !capLines.has(code)) return null;
    const lines = [...capLines.get(code)].filter(([, line]) => line.limit != null).map(([currency, line]) => ({
      currency, limit: line.limit, paid: line.paid, left: Math.max(0, line.limit - line.paid),
      held: liveTeam.filter(sale => sale.code === code && sale.currency === currency).reduce((sum, sale) => sum + (sale.held || 0), 0)
    })).sort((a, b) => currencyRank(a.currency) - currencyRank(b.currency) || a.currency.localeCompare(b.currency));
    return lines.length ? { year, lines } : null;
  };
  return {
    codes: [...codes.values()].map(entry => ({
      ...entry,
      revenue: sorted(entry.revenue),
      creem: { sales: entry.creem.sales, pending: sorted(entry.creem.pending), earned: sorted(entry.creem.earned) },
      team: { sales: entry.team.sales, pending: sorted(entry.team.pending), toPay: sorted(entry.team.toPay), held: sorted(entry.team.held), paid: sorted(entry.team.paid) },
      partner: statusOf(entry.code),
      cap: capOf(entry.code)
    })).sort((a, b) => b.sales - a.sales || b.test - a.test || b.lastAt.localeCompare(a.lastAt) || a.code.localeCompare(b.code)),
    recent: sales.slice(0, PARTNER_RECENT),
    team: [...open, ...settled].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.checkoutId.localeCompare(b.checkoutId)),
    toPay: toPay.map(sale => ({
      checkoutId: sale.checkoutId, code: sale.code, plan: sale.plan, amount: sale.amount, refundedAmount: sale.refundedAmount, refundUnknown: sale.refundUnknown,
      rate: sale.rate, base: sale.base, basis: sale.basis, commission: sale.commission, exact: sale.exact, currency: sale.currency, checks: sale.checks, earnedAt: sale.earnedAt, createdAt: sale.createdAt,
      paidAmount: sale.paidAmount, rest: sale.rest, payable: sale.payable, held: sale.held, partner: sale.partner, cap: sale.cap
    })),
    codeChecks: Object.fromEntries([...checkOf].sort(([a], [b]) => a.localeCompare(b))),
    // Every sale described, for one partner's statement only (never in the dashboard's answer).
    ...(withSales ? { sales } : {}),
    totals: {
      sales: live.length,
      partners: new Set(live.map(sale => sale.code)).size,
      refunded: live.filter(sale => sale.state).length,
      partial: live.filter(sale => sale.partial).length,
      revenue: sorted(revenue),
      test: { sales: test.sales, revenue: sorted(test.revenue) },
      creem: { pending: sorted(creem.pending), earned: sorted(creem.earned) },
      team: {
        pending: sorted(teamTotals.pending), toPay: sorted(teamTotals.toPay), held: sorted(teamTotals.held), paid: sorted(teamTotals.paid),
        toPayCount: toPay.length, toCheck: toPay.filter(sale => sale.checks.length).length, heldCount: open.filter(sale => sale.held > 0).length
      },
      // Commissions still open whose figure is only an upper bound (tax or a refund's amount unknown).
      inexact: live.filter(sale => sale.commission != null && !sale.exact && OPEN_STATES.has(sale.status)).length,
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
 * Why (part of) a team commission can't be paid now: the individual's yearly
 * cap (`sale.cap`). `asked` is the amount the owner wanted to mark as paid.
 */
export function capRefusalText(sale, asked = sale?.rest) {
  const cap = sale?.cap || { year: new Date().getUTCFullYear(), limit: 0, paid: 0 };
  const money = cents => moneyText(cents, sale.currency);
  const where = `${sale.code}’s yearly cap for an individual: ${money(cap.limit)} of team commissions in ${cap.year}, ${money(cap.paid)} paid so far`;
  const after = `until ${sale.code} invoices you as a business (switch ${sale.code} to Business on the Partners card), or until 1 January ${cap.year + 1}`;
  if (!(sale.payable > 0)) {
    const older = cap.paid < cap.limit ? ', and what is left goes to older commissions first' : '';
    return `This commission is above ${where}${older}. It waits ${after}.`;
  }
  return `${money(asked)} is more than what fits under ${where}. Mark ${money(sale.payable)} as paid now; the rest (${money(sale.rest - sale.payable)}) waits ${after}.`;
}

/**
 * Whether a team commission may be marked as paid now: { sale, amount, final }
 * (described, status 'earned'; `amount` what to record, in cents; `final`
 * whether it settles the commission) or { status, error } — 404 when no live
 * team sale has this checkout, 409 when it is still pending, already paid,
 * earns nothing, is held above an individual's yearly cap, or when something
 * must be checked first (`checks`) and the owner didn't confirm they did
 * (`confirmed`); 400 for an amount that doesn't fit. What can be paid is the
 * rest still owed (`rest`), within what the cap leaves (`payable`, the oldest
 * commission first): an exact commission is marked with that figure (no
 * `amount`, or that amount); asking for more than the cap leaves is refused
 * with 409 (`cap: true`). An upper bound (tax or a refund's amount unknown)
 * needs the `amount` the owner paid, at most the rest and the cap's part; it
 * settles the commission, unless the cap held part of it back and the owner
 * says more is owed (`part: true`).
 */
export function payoutCheck(summary, checkoutId, { confirmed = false, amount = null, part = false } = {}) {
  const sale = (summary?.team || []).find(row => row.checkoutId === checkoutId);
  if (!sale) return { status: 404, error: 'No team gift sold through a partner’s link has this checkout.' };
  if (sale.status === 'paid') return { status: 409, error: 'This commission is already marked as paid.' };
  if (sale.status === 'pending') return { status: 409, error: `This sale is still within its ${PARTNER_PROGRAM.refundDays}-day refund period: its commission isn’t earned yet.` };
  if (sale.status === 'not-partner') return { status: 409, error: `You marked ${sale.code} as not a partner, so this commission earns nothing. Undo that first if ${sale.code} is a partner in Creem.` };
  if (sale.status !== 'earned' && sale.status !== 'held') return { status: 409, error: 'This sale was refunded, disputed or switched off: it earns nothing.' };
  if (!(sale.commission > 0) || !sale.currency) return { status: 409, error: 'This sale has no amount, so its commission can’t be worked out.' };
  const checks = Array.isArray(sale.checks) ? sale.checks : [];
  if (checks.length && confirmed !== true) return { status: 409, error: `${payoutChecksText(sale)} Then mark it as paid again.`, checks };
  const rest = Number.isInteger(sale.rest) ? sale.rest : sale.commission;
  const payable = Number.isInteger(sale.payable) ? Math.min(sale.payable, rest) : rest;
  if (!(payable > 0)) return { status: 409, error: capRefusalText(sale), cap: true };
  const left = sale.paidAmount ? ' left to pay' : '';
  if (sale.exact) {
    const asked = amount ?? rest;
    if (!Number.isInteger(asked) || asked < 1 || asked > rest) return { status: 400, error: `This commission is known (${moneyText(rest, sale.currency)}${left}): mark it as paid without an amount.` };
    if (asked > payable) return { status: 409, error: capRefusalText(sale, asked), cap: true };
    if (asked !== payable) return { status: 400, error: `Mark ${moneyText(payable, sale.currency)} as paid: ${payable < rest ? 'what fits under the yearly cap' : 'the commission'}.` };
    return { sale, amount: asked, final: asked === rest };
  }
  if (!Number.isInteger(amount) || amount < 1 || amount > rest) {
    return { status: 400, error: `Give the amount you paid: more than nothing and at most ${moneyText(rest, sale.currency)}${left} (${sale.rate}% of the amount paid, tax included).` };
  }
  if (amount > payable) return { status: 409, error: capRefusalText(sale, amount), cap: true };
  return { sale, amount, final: !(part === true && amount === payable && payable < rest) };
}

// ---- The partner's private statement (1.33) ------------------------------------

/** Visits through partner links (migration 0008): new codes a UTC day takes at most; a code with a sale or a status always counts. */
export const PARTNER_VISIT_CODES_PER_DAY = 200;
/** How far back a statement reads visits: 90 days, or the whole calendar year when that is longer. */
export const STATEMENT_VISIT_DAYS = 90;
/** Rate limits of the public partner routes, per worker isolate (module scope, best effort: Cloudflare's rule on /api/ is the real guard). */
export const PARTNER_LIMITS = Object.freeze({
  statement: Object.freeze({ limit: 60, windowMs: 60 * 1000 }),
  visit: Object.freeze({ limit: 600, windowMs: 60 * 1000 })
});
/** A set of limiters ({ statement, visit }); tests make their own. */
export const createPartnerLimits = ({ now = () => Date.now(), limits = PARTNER_LIMITS } = {}) => Object.fromEntries(Object.entries(limits).map(([name, value]) => [name, createRateLimiter({ ...value, now })]));
/** The isolate's own set, shared by every request it answers. */
export const sharedPartnerLimits = createPartnerLimits();

const encoder = new TextEncoder();
const STATEMENT_KEY_RE = /^[0-9a-f]{32}$/;
const hex = buffer => [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('');
async function hmacHex(keyBytes, message) {
  const key = await globalThis.crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await globalThis.crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

/**
 * The key of a partner's private statement link: 32 hex characters (128 bits)
 * of HMAC-SHA256(key = HMAC-SHA256(ADMIN_TOKEN, 'partner-statement-key'),
 * 'statement:v1:' + code). The derived key keeps it apart from every other use
 * of ADMIN_TOKEN (sessions, waitlist removal tokens). Deterministic: a code
 * always gets the same link. Rotating ADMIN_TOKEN changes every key, so every
 * link given out stops working (send new ones from the dashboard). '' without
 * an ADMIN_TOKEN or a valid code.
 */
export async function statementKey(adminToken, code) {
  const clean = affiliateCode(code);
  if (!adminToken || !clean || clean !== code) return '';
  const derived = await hmacHex(encoder.encode(String(adminToken)), 'partner-statement-key');
  return (await hmacHex(encoder.encode(derived), `statement:v1:${clean}`)).slice(0, 32);
}

/** Constant-time check of a statement link's key, for exactly this code. */
export async function verifyStatementKey(adminToken, code, key) {
  if (!adminToken || typeof key !== 'string' || !STATEMENT_KEY_RE.test(key) || typeof code !== 'string') return false;
  const expected = await statementKey(adminToken, code);
  return !!expected && timingSafeEqual(expected, key);
}

/** The private statement's address for a code: `<base>/partners/statement/?code=CODE&key=KEY`, '' without a key. */
export async function statementUrl(baseUrl, adminToken, code) {
  const key = await statementKey(adminToken, code);
  if (!key) return '';
  const url = new URL('partners/statement/', `${String(baseUrl || '').replace(/\/+$/, '')}/`);
  url.search = new URLSearchParams({ code, key }).toString();
  return url.href;
}

const dayOf = ms => new Date(ms).toISOString().slice(0, 10);
/** The first UTC day a statement reads visits from: 89 days before today, or 1 January when that is earlier. */
export const statementVisitsFrom = now => [dayOf(now - (STATEMENT_VISIT_DAYS - 1) * DAY_MS), `${new Date(now).getUTCFullYear()}-01-01`].sort()[0];

/** Visits through a code's link from its daily rows ({ day, count }): the last 30 and 90 days and this calendar year (UTC), today included. */
export function visitTotals(rows = [], now = Date.now()) {
  const today = dayOf(now);
  const since = days => dayOf(now - (days - 1) * DAY_MS);
  const yearStart = `${today.slice(0, 4)}-01-01`;
  const sum = from => (rows || []).filter(row => String(row?.day || '') >= from && String(row.day) <= today).reduce((total, row) => total + Math.max(0, Number(row.count) || 0), 0);
  return { last30: sum(since(30)), last90: sum(since(90)), year: sum(yearStart), yearOf: Number(today.slice(0, 4)) };
}

const STATEMENT_KINDS = Object.freeze([['plus', 'Plus'], ['gift-1', 'Give Plus'], ['family-5', 'Plus Family']]);
const statementKind = sale => (sale.kind === 'plus' ? 'plus' : isPersonalGift(sale.plan) ? sale.plan : 'gift');
const dayText = iso => (iso ? String(iso).slice(0, 10) : '');

/**
 * A partner's private statement, for that code only: its sales, payouts,
 * rejection and profile are picked out of the rows given (`rows` the partner
 * sales, `states` and `refunds` their revocations and refunds, `payouts`,
 * `rejections`, `profiles` the 0007 and 0008 rows) and read as the dashboard
 * reads them (partnerSummary). Answers { code, partner ('individual' |
 * 'business'), visits (visitTotals of the daily `visits` rows, or null while
 * migration 0008 is missing), creem: [{ kind, label, count, refunded }] (Plus
 * and the personal gifts: Creem pays them, so no amounts), team: [{ soldOn,
 * seats, commission, exact, currency, status, earnedOn, paidOn, paidAmount,
 * payable, held }] (newest first), totals per currency, cap ({ year, lines })
 * for an individual, program }. Never a checkout, an order, a buyer's name,
 * email or country, or what a buyer paid: only the partner's own commission
 * lines. Sales made in Creem's test mode are left out.
 */
export function partnerStatement(code, { rows = [], states = [], refunds = [], payouts = [], rejections = [], profiles = [], visits = null, now = Date.now() } = {}) {
  const own = list => (list || []).filter(row => row?.code === code);
  const summary = partnerSummary(own(rows), states, refunds, { limit: 0, payouts: own(payouts), rejections: own(rejections), profiles: own(profiles), now, withSales: true });
  const entry = summary.codes.find(row => row.code === code) || null;
  const sales = summary.sales.filter(sale => !sale.test);
  const offState = sale => sale.state === 'refunded' || sale.state === 'disputed';
  const creemSales = sales.filter(sale => sale.program === 'creem');
  const creem = STATEMENT_KINDS.map(([kind, label]) => {
    const sold = creemSales.filter(sale => statementKind(sale) === kind);
    return { kind, label, count: sold.length, refunded: sold.filter(offState).length };
  });
  // A team gift sold before 1.28 went to Creem with the code: Creem's, listed with what it credits.
  const legacy = creemSales.filter(sale => statementKind(sale) === 'gift');
  if (legacy.length) creem.push({ kind: 'team-creem', label: 'Team gift, credited by Creem', count: legacy.length, refunded: legacy.filter(offState).length });
  const team = sales.filter(sale => sale.program === 'team').map(sale => ({
    soldOn: dayText(sale.createdAt),
    seats: teamTier(sale.plan)?.seats ?? null,
    commission: sale.commission,
    exact: sale.exact !== false,
    currency: sale.currency,
    status: sale.status,
    earnedOn: dayText(sale.earnedAt),
    paidOn: dayText(sale.status === 'paid' ? sale.paidAt : sale.lastPaidAt),
    paidAmount: sale.paidAmount ?? null,
    payable: sale.status === 'earned' ? sale.payable : 0,
    held: sale.held || 0
  }));
  const profile = own(profiles).map(normalizeProfile)[0];
  const blankTotals = { pending: {}, toPay: {}, held: {}, paid: {} };
  return {
    code,
    generatedAt: new Date(now).toISOString(),
    partner: entry?.partner || partnerStatus(profile?.status),
    visits: visits ? visitTotals(visits, now) : null,
    creem,
    team,
    totals: entry ? { pending: entry.team.pending, toPay: entry.team.toPay, held: entry.team.held, paid: entry.team.paid } : blankTotals,
    cap: entry?.cap || null,
    program: { rate: PARTNER_PROGRAM.rate, teamRate: PARTNER_PROGRAM.teamRate, refundDays: PARTNER_PROGRAM.refundDays, cookieDays: PARTNER_PROGRAM.cookieDays, minimumPayout: { ...PARTNER_PROGRAM.minimumPayout }, individualYearlyCap: { ...PARTNER_PROGRAM.individualYearlyCap } }
  };
}
