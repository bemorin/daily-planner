// The dashboard's Partners card, from the summary's `partners` (server/partners.js):
// what you owe partners for team gifts (10%, paid by bank transfer, with Mark as
// paid and Undo), what Creem owes them for Plus and personal gifts (25%, shown
// for information: Creem pays), each partner's figures, then the latest sales,
// each with where its commission stands. Pure: it returns HTML (every value
// escaped) and is unit-tested (tests/admin-partners.test.js); admin.js wires
// the buttons.

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
 * Where a commission stands, in plain words: { label, detail, tone }. `tone`
 * picks the pill: 'wait' (pending), 'due' (a team commission to pay), 'ok'
 * (earned by a Creem sale, or paid), 'off' (earns nothing).
 */
export function commissionState(sale, { day = defaultDay } = {}) {
  const team = sale?.program === 'team';
  switch (sale?.status) {
    case 'pending': return { label: 'Pending', detail: sale.earnedAt ? `Earned on ${day(sale.earnedAt)} if not refunded` : 'In its refund period', tone: 'wait' };
    case 'earned': return team ? { label: 'To pay', detail: 'By bank transfer', tone: 'due' } : { label: 'Earned', detail: 'Creem pays it', tone: 'ok' };
    case 'paid': return { label: 'Paid', detail: `${day(sale.paidAt)}${sale.paidNote ? ` · ${sale.paidNote}` : ''}`, tone: 'ok' };
    case 'refunded': return { label: 'Refunded', detail: sale.paidAt ? `After you paid it (${day(sale.paidAt)})` : 'Earns nothing', tone: 'off' };
    case 'disputed': return { label: 'Disputed', detail: sale.paidAt ? `After you paid it (${day(sale.paidAt)})` : 'Earns nothing', tone: 'off' };
    case 'revoked': return { label: 'Switched off', detail: 'Earns nothing', tone: 'off' };
    default: return { label: '', detail: '', tone: '' };
  }
}

/** “10% of €495.83 before tax”, or “… of €595 paid” when the tax isn't known. '' without an amount. */
export function commissionBasis(sale, money = defaultMoney) {
  if (sale?.base == null || !sale.rate) return '';
  return `${sale.rate}% of ${money(sale.base, sale.currency)} ${sale.basis === 'before-tax' ? 'before tax' : 'paid (tax unknown)'}`;
}

// What a sale would have earned, struck through when it earns nothing (refunded, disputed, switched off).
const struck = (html, off) => (off ? `<s>${html}</s><span class="sr-only"> (not earned)</span>` : html);
const pill = state => (state.label ? `<span class="owner-pill owner-pill--${esc(state.tone)}">${esc(state.label)}</span>` : '');

/** One team commission: date, partner, the gift, the commission, its state and the action that fits it. */
function teamRow(sale, fmt) {
  const state = commissionState(sale, fmt);
  const action = sale.status === 'earned'
    ? `<button class="secondary-button owner-pay" type="button" data-owner-payout="${esc(sale.checkoutId)}" data-owner-payout-code="${esc(sale.code)}" data-owner-payout-amount="${esc(fmt.exact(sale.commission, sale.currency))}">Mark as paid</button>`
    : sale.paidAt ? `<button class="text-button" type="button" data-owner-payout-undo="${esc(sale.checkoutId)}" data-owner-payout-code="${esc(sale.code)}">Undo</button>` : '';
  return `<tr data-owner-attn="partner:${esc(sale.checkoutId)}"${state.tone === 'off' ? ' class="is-off"' : ''}>
    <td class="owner-nowrap">${esc(fmt.day(sale.createdAt))}</td>
    <td><code>${esc(sale.code)}</code></td>
    <td>${esc(partnerWhat(sale))}<small class="owner-small">${esc(fmt.money(sale.amount, sale.currency))} paid${sale.refundedAmount ? ` · −${esc(fmt.money(sale.refundedAmount, sale.currency))} refunded` : ''}</small></td>
    <td class="num owner-nowrap"><b>${sale.commission == null ? '—' : struck(esc(fmt.exact(sale.status === 'paid' && sale.paidAmount != null ? sale.paidAmount : sale.commission, sale.currency)), state.tone === 'off')}</b><small class="owner-small">${esc(commissionBasis(sale, fmt.exact))}</small></td>
    <td>${pill(state)}<small class="owner-small">${esc(state.detail)}</small></td>
    <td>${action ? `<div class="owner-row-actions">${action}</div>` : ''}</td>
  </tr>`;
}

/** One of the latest sales, whichever program pays it. */
function saleRow(sale, fmt) {
  const state = sale.test ? { label: 'Test · not counted', detail: 'Creem test mode', tone: 'off' } : commissionState(sale, fmt);
  const refunded = sale.refundedAmount ? `−${fmt.money(sale.refundedAmount, sale.currency)} refunded` : sale.partial ? 'Part refunded, amount unknown' : '';
  const who = sale.program === 'team' ? 'You pay it' : 'Creem pays it';
  return `<tr${sale.test || state.tone === 'off' ? ' class="is-off"' : ''}>
    <td class="owner-nowrap">${esc(fmt.day(sale.createdAt))}</td>
    <td><code>${esc(sale.code)}</code></td>
    <td>${esc(partnerWhat(sale))}${sale.member ? ' <span class="owner-pill">Member price</span>' : ''}</td>
    <td class="num owner-nowrap">${esc(fmt.money(sale.amount, sale.currency)) || '—'}${refunded ? `<small class="owner-small">${esc(refunded)}</small>` : ''}</td>
    <td class="num owner-nowrap">${sale.commission == null ? '—' : `${struck(esc(fmt.exact(sale.commission, sale.currency)), !sale.test && state.tone === 'off')}<small class="owner-small">${esc(sale.rate)}% · ${esc(who)}</small>`}</td>
    <td>${pill(state)}${state.detail && !sale.test ? `<small class="owner-small">${esc(state.detail)}</small>` : ''}</td>
  </tr>`;
}

/** One partner: sales, Creem's commissions (for information) and yours to pay. */
function codeRow(row, fmt) {
  const off = [row.refunded ? `${fmt.number(row.refunded)} refunded or disputed` : '', row.partial ? `${fmt.number(row.partial)} partly refunded` : '', row.revoked ? `${fmt.number(row.revoked)} switched off` : '', row.test ? `${fmt.number(row.test)} in test mode` : ''].filter(Boolean).join(' · ');
  const creem = row.creem || {};
  const team = row.team || {};
  const pending = perCurrency(creem.pending, fmt.exact, '');
  const creemNote = [pending && `${pending} pending`, `${fmt.number(creem.sales)} ${plural(creem.sales, 'sale')}`].filter(Boolean).join(' · ');
  const creemLine = creem.sales ? `${esc(perCurrency(creem.earned, fmt.exact))}<small class="owner-small">${esc(creemNote)}</small>` : '—';
  const teamParts = [perCurrency(team.pending, fmt.exact, '') && `${perCurrency(team.pending, fmt.exact)} pending`, perCurrency(team.paid, fmt.exact, '') && `${perCurrency(team.paid, fmt.exact)} paid`].filter(Boolean).join(' · ');
  const teamLine = team.sales ? `${esc(perCurrency(team.toPay, fmt.exact))}<small class="owner-small">${esc(teamParts || `${fmt.number(team.sales)} ${plural(team.sales, 'sale')}`)}</small>` : '—';
  return `<tr>
    <td><code>${esc(row.code)}</code></td>
    <td class="num"><b>${fmt.number(row.sales)}</b>${off ? `<small class="owner-small">${esc(off)}</small>` : ''}</td>
    <td class="num owner-nowrap">${creemLine}</td>
    <td class="num owner-nowrap">${teamLine}</td>
    <td class="num owner-nowrap">${esc(perCurrency(row.revenue, fmt.money))}</td>
    <td class="owner-nowrap">${esc(fmt.day(row.lastAt))}</td>
  </tr>`;
}

/** What the figures leave out or cover: test-mode sales, the cap on how many sales are read, migration 0007. */
export function partnerFootnote(summary, fmt = {}) {
  const number = fmt.number || defaultNumber;
  const money = fmt.money || defaultMoney;
  const totals = summary?.partners?.totals || {};
  const test = totals.test || {};
  const parts = [];
  if (test.sales) parts.push(`${number(test.sales)} ${plural(test.sales, 'sale')} in test mode${Object.keys(test.revenue || {}).length ? ` (${perCurrency(test.revenue, money)})` : ''} ${Number(test.sales) === 1 ? 'is' : 'are'} not counted.`);
  if (totals.capped) parts.push(`The figures cover the latest ${number(totals.listed)} sales.`);
  if (summary?.partnerCommissionsUnavailable) parts.push('Apply migrations/0007_partner_commissions.sql to mark team commissions as paid and to work new commissions out before tax.');
  return parts.join(' ');
}

/**
 * The card's HTML. `fmt`: { money(cents, currency), number(value), day(iso) };
 * defaults format in English.
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
  if (!codes.length) {
    return `<p class="owner-empty">No sales through a partner’s link yet. Partners share <code>https://planner.bemorin.com/welcome/?ref=CODE</code>; a purchase made through it shows here once it is paid. Plus, Give Plus and Plus Family earn them ${esc(program.rate)}% (Creem pays); a team gift earns them ${esc(program.teamRate)}% (you pay, by bank transfer).</p>${footnote ? `<p class="owner-partner-note">${esc(footnote)}</p>` : ''}`;
  }
  const totals = partners.totals || {};
  const teamTotals = totals.team || {};
  const creemTotals = totals.creem || {};
  const toPay = perCurrency(teamTotals.toPay, f.exact, '');
  const dueCount = Number(teamTotals.toPayCount) || 0;
  const stats = [
    {
      label: 'Team commissions to pay',
      figure: toPay || f.exact(0, 'EUR'),
      note: dueCount ? `${f.number(dueCount)} earned, not paid yet · by bank transfer` : perCurrency(teamTotals.pending, f.exact, '') ? `Nothing yet · ${perCurrency(teamTotals.pending, f.exact)} still in the ${program.refundDays}-day refund period` : `Nothing to pay · ${program.teamRate}% of team gifts`,
      due: !!dueCount
    },
    {
      label: `Creem commissions (${program.rate}%)`,
      figure: perCurrency(creemTotals.earned, f.exact, f.exact(0, 'EUR')),
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
    <div class="owner-scroll"><table class="owner-table owner-partner-team"><thead><tr><th>Sold</th><th>Partner</th><th>Team gift</th><th class="num">Commission</th><th>State</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${team.map(sale => teamRow(sale, f)).join('')}</tbody></table></div>`
    : '';
  return `<div class="owner-stats owner-partner-stats">${stats}</div>
    ${footnote ? `<p class="owner-partner-note">${esc(footnote)}</p>` : ''}
    <p class="owner-result" data-owner-payout-result role="status" aria-live="polite" hidden></p>
    ${teamTable}
    <div class="owner-list"><h3>By partner</h3></div>
    <div class="owner-scroll"><table class="owner-table owner-partners"><thead><tr><th>Partner code</th><th class="num">Sales</th><th class="num">Creem · ${esc(program.rate)}%</th><th class="num">To pay · ${esc(program.teamRate)}%</th><th class="num">Revenue</th><th>Last sale</th></tr></thead><tbody>${codes.map(row => codeRow(row, f)).join('')}</tbody></table></div>
    <div class="owner-list"><h3>Latest partner sales</h3></div>
    <div class="owner-scroll"><table class="owner-table owner-partner-sales"><thead><tr><th>Sold</th><th>Code</th><th>What</th><th class="num">Amount</th><th class="num">Commission</th><th>State</th></tr></thead><tbody>${recent.map(sale => saleRow(sale, f)).join('')}</tbody></table></div>`;
}
