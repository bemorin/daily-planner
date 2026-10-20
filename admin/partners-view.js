// The dashboard's Partners card, from the summary's `partners` (server/partners.js):
// what you owe partners for team gifts (10%, paid by bank transfer, with Mark as
// paid and Undo, and what to check first: a code nothing confirmed, a refund or
// the tax not recorded), what Creem owes them for Plus and personal gifts (25%,
// shown for information: Creem pays), each partner's figures, then the latest
// sales, each with where its commission stands. Pure: it returns HTML (every
// value escaped) and is unit-tested (tests/admin-partners.test.js); admin.js
// wires the buttons, and attention.js says the same checks in its own lines.

import { PARTNER_PROGRAM, teamTier } from '../src/lib/pricing.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const plural = (count, word) => `${word}${Number(count) === 1 ? '' : 's'}`;

const defaultNumber = value => new Intl.NumberFormat('en-US').format(Number(value) || 0);
function defaultMoney(amount, currency) {
  if (amount == null || amount === '') return '';
  const value = Number(amount) / 100;
  try {
    return currency ? new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: Number.isInteger(value) ? 0 : 2 }).format(value) : defaultNumber(value);
  } catch (_) {
    return `${value} ${currency}`;
  }
}
/** A commission, always to the cent, so a column of them lines up (“€5.00”, “€6.04”). */
function defaultExact(amount, currency) {
  if (amount == null || amount === '') return '';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(amount) / 100);
  } catch (_) {
    return `${(Number(amount) / 100).toFixed(2)} ${currency}`;
  }
}
const defaultDay = iso => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');

const PERSONAL_LABELS = { 'gift-1': 'Give Plus', 'family-5': 'Plus Family' };

/** What a sale bought, in words: “Plus”, “Give Plus”, “Team gift · up to 50 people”. */
export function partnerWhat(row) {
  if (row?.kind === 'plus') return 'Plus';
  if (PERSONAL_LABELS[row?.plan]) return PERSONAL_LABELS[row.plan];
  const tier = teamTier(row?.plan);
  return tier ? `Team gift · up to ${defaultNumber(tier.seats)} people` : 'Gift';
}

/** Amounts per currency, never added together: “€49.58 · $19.50”, or `empty`. */
export const perCurrency = (amounts, money = defaultMoney, empty = '—') => Object.entries(amounts || {}).filter(([, cents]) => cents > 0).map(([currency, cents]) => money(cents, currency)).join(' · ') || empty;

/**
 * What to check before paying a team commission (the API's `checks`), one
 * short sentence each: the code (nothing checks it on a team checkout), a
 * refund whose amount Creem didn't give, the tax not recorded.
 */
export function payoutCheckWords(sale, rate = PARTNER_PROGRAM.teamRate) {
  const checks = Array.isArray(sale?.checks) ? sale.checks : [];
  return [
    checks.includes('code') && `Check that ${sale.code} is a partner in Creem → Affiliate Hub before paying`,
    checks.includes('refund') && 'Part refunded, amount unknown: check the refund in Creem before paying',
    checks.includes('tax') && `Tax not recorded: check it in Creem, and pay ${rate}% of the price before tax`
  ].filter(Boolean);
}

const AFTER_PAID = { refunded: 'Refunded after you paid it', disputed: 'Disputed after you paid it', revoked: 'Switched off after you paid it' };

/**
 * Where a commission stands, in plain words: { label, detail, tone }. `tone`
 * picks the pill: 'wait' (pending), 'due' (a team commission to pay), 'ok'
 * (earned by a Creem sale, or paid), 'off' (earns nothing).
 */
export function commissionState(sale, { day = defaultDay } = {}) {
  const team = sale?.program === 'team';
  switch (sale?.status) {
    case 'pending': return { label: 'Pending', detail: sale.earnedAt ? `Earned on ${day(sale.earnedAt)} if not refunded` : 'In its refund period', tone: 'wait' };
    case 'earned': return team ? { label: 'To pay', detail: 'By bank transfer', tone: 'due' } : { label: 'Earned', detail: 'Creem pays it', tone: 'ok' };
    // Paid stays paid when the sale is refunded or disputed later: the money went out, and the state says what happened.
    case 'paid': return { label: 'Paid', detail: [day(sale.paidAt), sale.paidNote, AFTER_PAID[sale.state]].filter(Boolean).join(' · '), tone: 'ok' };
    case 'refunded': return { label: 'Refunded', detail: 'Earns nothing', tone: 'off' };
    case 'disputed': return { label: 'Disputed', detail: 'Earns nothing', tone: 'off' };
    case 'revoked': return { label: 'Switched off', detail: 'Earns nothing', tone: 'off' };
    case 'not-partner': return { label: 'Not a partner', detail: 'You checked Creem · earns nothing', tone: 'off' };
    default: return { label: '', detail: '', tone: '' };
  }
}

/**
 * What a commission is worked out on: “10% of €495.83 before tax”, or “10% of
 * €195.00 paid, tax included” when the tax isn't recorded, “…, before the
 * refund” when a refund's amount isn't known. '' without an amount.
 */
export function commissionBasis(sale, money = defaultMoney) {
  if (sale?.base == null || !sale.rate) return '';
  const base = `${sale.rate}% of ${money(sale.base, sale.currency)} ${sale.basis === 'before-tax' ? 'before tax' : 'paid, tax included'}`;
  return sale.refundUnknown ? `${base}, before the refund` : base;
}

/** The commission's figure: “€16.25”, or “At most €19.50” when the tax or a refund's amount isn't known. */
export const commissionFigure = (sale, money = defaultExact, cents = sale?.commission) => (cents == null ? '' : `${sale.exact === false && sale.status !== 'paid' ? 'At most ' : ''}${money(cents, sale.currency)}`);

// What a sale would have earned, struck through when it earns nothing (refunded, disputed, switched off, not a partner).
const struck = (html, off) => (off ? `<s>${html}</s><span class="sr-only"> (not earned)</span>` : html);
const pill = state => (state.label ? `<span class="owner-pill owner-pill--${esc(state.tone)}">${esc(state.label)}</span>` : '');
const small = words => (words ? `<small class="owner-small">${esc(words)}</small>` : '');

/** The buttons of a team commission: Mark as paid, Not a partner, Undo — none while migration 0007 is missing. */
function teamActions(sale, fmt, ready) {
  if (!ready) return '';
  const checks = Array.isArray(sale.checks) ? sale.checks : [];
  const code = `data-owner-payout-code="${esc(sale.code)}"`;
  const reject = checks.includes('code') ? `<button class="text-button" type="button" data-owner-code-reject="${esc(sale.code)}" data-owner-row="${esc(sale.checkoutId)}" aria-label="${esc(`Mark ${sale.code} as not a partner`)}">Not a partner</button>` : '';
  if (sale.status === 'earned') {
    const exact = sale.exact !== false;
    const pay = `<button class="secondary-button owner-pay" type="button" data-owner-payout="${esc(sale.checkoutId)}" ${code} data-owner-payout-amount="${esc(fmt.exact(sale.commission, sale.currency))}" data-owner-payout-cents="${esc(sale.commission)}" data-owner-payout-currency="${esc(sale.currency)}" data-owner-payout-exact="${exact ? '1' : '0'}" data-owner-payout-checks="${esc(checks.join(' '))}">Mark as paid</button>`;
    return `${pay}${reject}`;
  }
  if (sale.status === 'pending') return reject;
  if (sale.status === 'paid') return `<button class="text-button" type="button" data-owner-payout-undo="${esc(sale.checkoutId)}" ${code}>Undo</button>`;
  if (sale.status === 'not-partner') return `<button class="text-button" type="button" data-owner-code-undo="${esc(sale.code)}" data-owner-row="${esc(sale.checkoutId)}" aria-label="${esc(`Undo: ${sale.code} is not a partner`)}">Undo</button>`;
  return '';
}

/** One team commission: date, partner, the gift, the commission, its state and the actions that fit it. */
function teamRow(sale, fmt, { ready, rate }) {
  const state = commissionState(sale, fmt);
  const checks = Array.isArray(sale.checks) ? sale.checks : [];
  const words = payoutCheckWords(sale, rate);
  // Pending: when it will be earned, then what to check; to pay: what to check, else how.
  const detail = !words.length ? state.detail : sale.status === 'pending' ? [state.detail, ...words].join(' · ') : words.join(' · ');
  const codeNote = sale.status === 'not-partner' ? 'Not a partner' : checks.includes('code') ? 'Not confirmed' : '';
  const refunds = [sale.refundedAmount ? `−${fmt.money(sale.refundedAmount, sale.currency)} refunded` : '', sale.refundUnknown ? 'part refunded, amount unknown' : ''].filter(Boolean);
  const figure = sale.status === 'paid' && sale.paidAmount != null ? fmt.exact(sale.paidAmount, sale.currency) : commissionFigure(sale, fmt.exact);
  const actions = teamActions(sale, fmt, ready);
  return `<tr data-owner-attn="partner:${esc(sale.checkoutId)}"${state.tone === 'off' ? ' class="is-off"' : ''}>
    <td class="owner-nowrap">${esc(fmt.day(sale.createdAt))}</td>
    <td><code>${esc(sale.code)}</code>${codeNote ? `<small class="owner-small owner-small--warn">${esc(codeNote)}</small>` : ''}</td>
    <td>${esc(partnerWhat(sale))}${small([`${fmt.money(sale.amount, sale.currency)} paid`, ...refunds].join(' · '))}</td>
    <td class="num owner-nowrap"><b>${sale.commission == null ? '—' : struck(esc(figure), state.tone === 'off')}</b>${small(commissionBasis(sale, fmt.exact))}</td>
    <td>${pill(state)}${small(detail)}</td>
    <td>${actions ? `<div class="owner-row-actions">${actions}</div>` : ''}</td>
  </tr>`;
}

/** One of the latest sales, whichever program pays it. */
function saleRow(sale, fmt) {
  const state = sale.test ? { label: 'Test · not counted', detail: 'Creem test mode', tone: 'off' } : commissionState(sale, fmt);
  const refunded = [sale.refundedAmount ? `−${fmt.money(sale.refundedAmount, sale.currency)} refunded` : '', sale.refundUnknown ? 'Part refunded, amount unknown' : ''].filter(Boolean).join(' · ');
  // A team gift sold before 1.28 went to Creem with the code: Creem credits it, at its own rate.
  const who = sale.program === 'team' ? 'You pay it' : teamTier(sale.plan) ? 'Creem pays it (sent with the code before 1.28)' : 'Creem pays it';
  return `<tr${sale.test || state.tone === 'off' ? ' class="is-off"' : ''}>
    <td class="owner-nowrap">${esc(fmt.day(sale.createdAt))}</td>
    <td><code>${esc(sale.code)}</code></td>
    <td>${esc(partnerWhat(sale))}${sale.member ? ' <span class="owner-pill">Member price</span>' : ''}</td>
    <td class="num owner-nowrap">${esc(fmt.money(sale.amount, sale.currency)) || '—'}${small(refunded)}</td>
    <td class="num owner-nowrap">${sale.commission == null ? '—' : `${struck(esc(sale.status === 'paid' && sale.paidAmount != null ? fmt.exact(sale.paidAmount, sale.currency) : commissionFigure(sale, fmt.exact)), !sale.test && state.tone === 'off')}${small(`${sale.rate}% · ${who}`)}`}</td>
    <td>${pill(state)}${state.detail && !sale.test ? small(state.detail) : ''}</td>
  </tr>`;
}

/** One partner: sales, Creem's commissions (for information) and yours to pay; a code nothing confirmed says so. */
function codeRow(row, fmt, check) {
  const off = [row.refunded ? `${fmt.number(row.refunded)} refunded or disputed` : '', row.partial ? `${fmt.number(row.partial)} partly refunded` : '', row.revoked ? `${fmt.number(row.revoked)} switched off` : '', row.test ? `${fmt.number(row.test)} in test mode` : ''].filter(Boolean).join(' · ');
  const creem = row.creem || {};
  const team = row.team || {};
  const pending = perCurrency(creem.pending, fmt.exact, '');
  const creemNote = [pending && `${pending} pending`, `${fmt.number(creem.sales)} ${plural(creem.sales, 'sale')}`].filter(Boolean).join(' · ');
  const creemLine = creem.sales ? `${esc(perCurrency(creem.earned, fmt.exact))}${small(creemNote)}` : '—';
  const teamParts = [perCurrency(team.pending, fmt.exact, '') && `${perCurrency(team.pending, fmt.exact)} pending`, perCurrency(team.paid, fmt.exact, '') && `${perCurrency(team.paid, fmt.exact)} paid`].filter(Boolean).join(' · ');
  const teamLine = team.sales ? `${esc(perCurrency(team.toPay, fmt.exact))}${small(teamParts || `${fmt.number(team.sales)} ${plural(team.sales, 'sale')}`)}` : '—';
  const codeNote = check === 'rejected' ? 'Not a partner (you checked)' : !check && team.sales ? 'Not confirmed' : '';
  return `<tr>
    <td><code>${esc(row.code)}</code>${codeNote ? `<small class="owner-small owner-small--warn">${esc(codeNote)}</small>` : ''}</td>
    <td class="num"><b>${fmt.number(row.sales)}</b>${small(off)}</td>
    <td class="num owner-nowrap">${creemLine}</td>
    <td class="num owner-nowrap">${teamLine}</td>
    <td class="num owner-nowrap">${esc(perCurrency(row.revenue, fmt.money))}</td>
    <td class="owner-nowrap">${esc(fmt.day(row.lastAt))}</td>
  </tr>`;
}

/**
 * The partner line of a team request (HTML): its code, what it may earn, and
 * whether the code is confirmed (`check`, the summary's codeChecks entry:
 * nothing checks a code typed in a link, so an unconfirmed one says to check
 * it in Creem before paying). '' without a code.
 */
export function requestPartnerHtml(ref, check = '', rate = PARTNER_PROGRAM.teamRate) {
  if (!ref) return '';
  const code = `<code>${esc(ref)}</code>`;
  if (check === 'rejected') return `<span class="owner-partner-ref is-off">Partner: ${code} — not a partner (you checked Creem)</span>`;
  const warn = check ? '' : `<small>Not confirmed: check that ${esc(ref)} is a partner in Creem → Affiliate Hub before paying.</small>`;
  return `<span class="owner-partner-ref">Partner: ${code} — ${esc(rate)}% if this becomes an order${warn}</span>`;
}

/** What the figures leave out or cover: test-mode sales, the cap on how many sales are read, figures that are upper bounds. */
export function partnerFootnote(summary, fmt = {}) {
  const number = fmt.number || defaultNumber;
  const money = fmt.money || defaultMoney;
  const totals = summary?.partners?.totals || {};
  const test = totals.test || {};
  const parts = [];
  if (test.sales) parts.push(`${number(test.sales)} ${plural(test.sales, 'sale')} in test mode${Object.keys(test.revenue || {}).length ? ` (${perCurrency(test.revenue, money)})` : ''} ${Number(test.sales) === 1 ? 'is' : 'are'} not counted.`);
  if (totals.inexact) parts.push(`${number(totals.inexact)} ${plural(totals.inexact, 'commission')} ${Number(totals.inexact) === 1 ? 'is' : 'are'} shown “at most”: the tax or a refund’s amount isn’t recorded.`);
  if (totals.capped) parts.push(`The figures cover the latest ${number(totals.listed)} sales.`);
  return parts.join(' ');
}

/** The one line that says migration 0007 is missing, '' when it is there. */
export function commissionsSetupHtml(summary) {
  return summary?.partnerCommissionsUnavailable
    ? '<p class="owner-partner-setup" role="note">Run <code>migrations/0007_partner_commissions.sql</code> on the D1 database to track team commissions. Until then they can’t be marked as paid, and new sales are recorded without their tax.</p>'
    : '';
}

/** Zero in the one currency the partner sales use, or “—” when they use several (or none). */
function zeroFigure(codes, exact) {
  const currencies = new Set(codes.flatMap(row => [row.revenue, row.creem?.pending, row.creem?.earned, row.team?.pending, row.team?.toPay, row.team?.paid].flatMap(amounts => Object.keys(amounts || {}))));
  return currencies.size === 1 ? exact(0, [...currencies][0]) : '—';
}

/**
 * The card's HTML. `fmt`: { money(cents, currency), exact(cents, currency),
 * number(value), day(iso) }; defaults format in English.
 */
export function partnersCardHtml(summary, fmt = {}) {
  const f = { money: fmt.money || defaultMoney, exact: fmt.exact || defaultExact, number: fmt.number || defaultNumber, day: fmt.day || defaultDay };
  const program = { ...PARTNER_PROGRAM, ...(summary?.partnerProgram || {}) };
  if (summary?.partnersUnavailable) {
    return '<p class="owner-empty">The <code>partner_sales</code> table does not exist yet, so sales through a partner’s link are not recorded. Apply <code>migrations/0006_partners.sql</code> and <code>migrations/0007_partner_commissions.sql</code> to the D1 database (see <code>docs/FEEDBACK_AND_WAITLIST.md</code>).</p>';
  }
  const partners = summary?.partners || {};
  const codes = Array.isArray(partners.codes) ? partners.codes : [];
  const footnote = partnerFootnote(summary, f);
  const setup = commissionsSetupHtml(summary);
  if (!codes.length) {
    return `<p class="owner-empty">No sales through a partner’s link yet. Partners share <code>https://planner.bemorin.com/welcome/?ref=CODE</code>; a purchase made through it shows here once it is paid. Plus, Give Plus and Plus Family earn them ${esc(program.rate)}% (Creem pays); a team gift earns them ${esc(program.teamRate)}% (you pay, by bank transfer).</p>${setup}${footnote ? `<p class="owner-partner-note">${esc(footnote)}</p>` : ''}`;
  }
  const totals = partners.totals || {};
  const teamTotals = totals.team || {};
  const creemTotals = totals.creem || {};
  const ready = !summary?.partnerCommissionsUnavailable;
  const checks = partners.codeChecks || {};
  const zero = zeroFigure(codes, f.exact);
  const toPay = perCurrency(teamTotals.toPay, f.exact, '');
  const dueCount = Number(teamTotals.toPayCount) || 0;
  const toCheck = Number(teamTotals.toCheck) || 0;
  const stats = [
    {
      label: 'Team commissions to pay',
      figure: toPay || zero,
      note: dueCount ? `${f.number(dueCount)} earned, not paid yet${toCheck ? ` · ${f.number(toCheck)} to check first` : ''} · by bank transfer` : perCurrency(teamTotals.pending, f.exact, '') ? `Nothing yet · ${perCurrency(teamTotals.pending, f.exact)} still in the ${program.refundDays}-day refund period` : `Nothing to pay · ${program.teamRate}% of team gifts`,
      due: !!dueCount
    },
    {
      label: `Creem commissions (${program.rate}%)`,
      figure: perCurrency(creemTotals.earned, f.exact, zero),
      note: `Earned${perCurrency(creemTotals.pending, f.exact, '') ? ` · ${perCurrency(creemTotals.pending, f.exact)} pending` : ''} · Creem pays these, shown for information`
    },
    {
      label: 'Partner sales',
      figure: f.number(totals.sales),
      note: `${f.number(totals.partners)} ${plural(totals.partners, 'partner')} · ${perCurrency(totals.revenue, f.money)} after refunds${totals.refunded ? ` · ${f.number(totals.refunded)} refunded or switched off` : ''}`
    }
  ].map(stat => `<div class="owner-stat${stat.due ? ' owner-stat--due' : ''}"><span>${esc(stat.label)}</span><strong>${esc(stat.figure)}</strong><small>${esc(stat.note)}</small></div>`).join('');
  const team = Array.isArray(partners.team) ? partners.team : [];
  const recent = Array.isArray(partners.recent) ? partners.recent : [];
  const teamTable = team.length
    ? `<div class="owner-list"><h3>Team commissions · you pay ${esc(program.teamRate)}%</h3></div>
    <div class="owner-scroll"><table class="owner-table owner-partner-team"><thead><tr><th>Sold</th><th>Partner</th><th>Team gift</th><th class="num">Commission</th><th>State</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${team.map(sale => teamRow(sale, f, { ready, rate: program.teamRate })).join('')}</tbody></table></div>`
    : '';
  return `<div class="owner-stats owner-partner-stats">${stats}</div>
    ${setup}
    ${footnote ? `<p class="owner-partner-note">${esc(footnote)}</p>` : ''}
    <p class="owner-result" data-owner-payout-result role="status" aria-live="polite" tabindex="-1" hidden></p>
    ${teamTable}
    <div class="owner-list"><h3>By partner</h3></div>
    <div class="owner-scroll"><table class="owner-table owner-partners"><thead><tr><th>Partner code</th><th class="num">Sales</th><th class="num">Creem · ${esc(program.rate)}%</th><th class="num">To pay · ${esc(program.teamRate)}%</th><th class="num">Revenue</th><th>Last sale</th></tr></thead><tbody>${codes.map(row => codeRow(row, f, checks[row.code] || '')).join('')}</tbody></table></div>
    <div class="owner-list"><h3>Latest partner sales</h3></div>
    <div class="owner-scroll"><table class="owner-table owner-partner-sales"><thead><tr><th>Sold</th><th>Code</th><th>What</th><th class="num">Amount</th><th class="num">Commission</th><th>State</th></tr></thead><tbody>${recent.map(sale => saleRow(sale, f)).join('')}</tbody></table></div>`;
}
