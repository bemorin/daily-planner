/**
 * A partner's private statement (partners/statement/), in words and figures:
 * pure and unit-tested (tests/partner-statement.test.js). The page reads the
 * statement the API answers for one code (server/partners.js
 * partnerStatement: that code only, never anything about a buyer) and these
 * helpers say it calmly — the visits their link brought, what was bought
 * through it, each team commission's state, the yearly cap of an individual
 * and how to get paid.
 */

import { formatMoney, PARTNER_PROGRAM, validCurrency } from '../src/lib/pricing.js';

export const STATEMENT_CODE_RE = /^[A-Za-z0-9_-]{2,64}$/;
export const STATEMENT_KEY_RE = /^[0-9a-f]{32}$/;
/** Where partners ask a question (from /partners/statement/). */
export const PARTNER_QUESTION_HREF = '../../contact/?topic=partners';

/** The code and key of the link (`?code=CODE&key=KEY`), or null when either is missing or malformed. */
export function statementParams(search = '') {
  let params;
  try { params = new URLSearchParams(search); } catch (_) { return null; }
  const code = String(params.get('code') || '').trim();
  const key = String(params.get('key') || '').trim().toLowerCase();
  return STATEMENT_CODE_RE.test(code) && STATEMENT_KEY_RE.test(key) ? { code, key } : null;
}

const LOCALES = { EUR: 'en-IE', USD: 'en-US' };
/** An amount in cents, always to the cent (“€16.25”, “$300.00”), so a column lines up. */
export function formatCents(cents, currency) {
  const code = validCurrency(currency) || 'USD';
  return new Intl.NumberFormat(LOCALES[code], { style: 'currency', currency: code, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.round(Number(cents) || 0) / 100);
}

/** A whole amount of a currency (“€300”, “$50”). */
export const formatUnits = (units, currency) => formatMoney(units, validCurrency(currency) || 'USD');

/** “2 Nov 2026” from an ISO day or date (UTC); '' when it can't be read. */
export function dayLabel(iso) {
  const time = Date.parse(String(iso || '').length === 10 ? `${iso}T00:00:00Z` : String(iso || ''));
  return Number.isFinite(time) ? new Date(time).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '';
}

/** Amounts per currency, never added together: “€16.25 · $19.50”, or `empty`. */
export const perCurrency = (amounts, empty = '') => Object.entries(amounts || {}).filter(([, cents]) => cents > 0).map(([currency, cents]) => formatCents(cents, currency)).join(' · ') || empty;

const plural = (count, word, many = `${word}s`) => `${new Intl.NumberFormat('en-US').format(count)} ${count === 1 ? word : many}`;

/** “Team gift · up to 50 people”. */
export const teamGiftLabel = seats => (seats ? `Team gift · up to ${new Intl.NumberFormat('en-US').format(seats)} people` : 'Team gift');

/**
 * Where one team commission stands, for the partner: { label, detail, tone }.
 * `tone` picks the pill: 'wait' (pending, or waiting above the yearly cap),
 * 'due' (earned, to be paid), 'ok' (paid), 'off' (earns nothing).
 */
export function teamLineState(line, { partner = 'individual' } = {}) {
  const money = cents => formatCents(cents, line.currency);
  const paidPart = line.paidAmount ? `${money(line.paidAmount)} paid${line.paidOn ? ` on ${dayLabel(line.paidOn)}` : ''}` : '';
  const how = partner === 'business' ? 'Invoice us for it: we pay it against your invoice' : 'We pay it by bank transfer within 30 days';
  switch (line.status) {
    case 'pending': return { label: 'Pending', detail: line.earnedOn ? `Earned on ${dayLabel(line.earnedOn)} if the gift isn’t refunded` : 'In its refund period', tone: 'wait' };
    case 'earned': {
      const capped = line.held > 0 ? `${money(line.payable)} to be paid now · ${money(line.held)} waits above your yearly cap` : '';
      return { label: 'Earned', detail: [paidPart, capped || how].filter(Boolean).join(' · '), tone: 'due' };
    }
    case 'held': return { label: 'Waiting', detail: [paidPart, 'Above your yearly cap as an individual: paid once you invoice us as a business, or from 1 January'].filter(Boolean).join(' · '), tone: 'wait' };
    case 'paid': return { label: 'Paid', detail: line.paidOn ? `${line.paidAmount != null && line.paidAmount !== line.commission ? `${money(line.paidAmount)} paid` : 'Paid'} on ${dayLabel(line.paidOn)}` : 'Paid', tone: 'ok' };
    case 'refunded': return { label: 'Refunded', detail: 'A refunded gift earns nothing', tone: 'off' };
    case 'disputed': return { label: 'Disputed', detail: 'A disputed payment earns nothing', tone: 'off' };
    case 'revoked': return { label: 'Not counted', detail: 'This purchase was cancelled: it earns nothing', tone: 'off' };
    case 'not-partner': return { label: 'Not counted', detail: 'Ask us about it', tone: 'off' };
    default: return { label: '', detail: '', tone: '' };
  }
}

/** One team commission as a row: { soldOn, what, amount, label, detail, tone, off }. */
export function teamLineView(line, options = {}) {
  const state = teamLineState(line, options);
  const amount = line.commission == null ? '—' : `${line.exact === false && !['paid', 'refunded', 'disputed', 'revoked', 'not-partner'].includes(line.status) ? 'At most ' : ''}${formatCents(line.status === 'paid' && line.paidAmount != null ? line.paidAmount : line.commission, line.currency)}`;
  return { soldOn: dayLabel(line.soldOn), what: teamGiftLabel(line.seats), amount, ...state, off: state.tone === 'off' };
}

/** What Creem credits, by kind, with how many were refunded: [{ label, count, note }] (kinds with none left out); [] when nothing. */
export function creemRows(statement) {
  return (statement?.creem || []).filter(row => row.count > 0).map(row => ({
    label: row.label,
    count: row.count,
    note: row.refunded ? `${row.refunded} refunded or disputed: ${row.refunded === 1 ? 'it earns' : 'they earn'} nothing` : ''
  }));
}

/** The figures at the top: visits (30 days), purchases credited by Creem, team commissions earned and not paid yet. */
export function statementFigures(statement) {
  const visits = statement?.visits;
  const purchases = (statement?.creem || []).reduce((sum, row) => sum + (row.count || 0), 0);
  const team = statement?.team || [];
  const toPay = perCurrency(statement?.totals?.toPay);
  const pending = perCurrency(statement?.totals?.pending);
  return [
    { id: 'visits', figure: visits ? new Intl.NumberFormat('en-US').format(visits.last30) : '—', label: 'visits through your link, last 30 days' },
    { id: 'purchases', figure: new Intl.NumberFormat('en-US').format(purchases), label: `${purchases === 1 ? 'purchase' : 'purchases'} of Plus or a gift, credited by Creem` },
    { id: 'team', figure: toPay || pending || formatCents(0, Object.keys(statement?.totals?.paid || {})[0] || 'EUR'), label: toPay ? 'in team commissions to be paid' : pending ? 'in team commissions pending' : team.length ? 'in team commissions to be paid' : 'in team commissions so far' }
  ];
}

/**
 * The yearly cap of an individual (PARTNER_PROGRAM.individualYearlyCap), per
 * currency: [{ currency, paid, limit, share (0–100), held, text, heldText }].
 * A currency with no team commission yet shows nothing paid. [] for a business.
 */
export function capLines(statement, currencies = []) {
  if (statement?.partner === 'business') return [];
  const program = statement?.program || PARTNER_PROGRAM;
  const year = statement?.cap?.year || new Date(statement?.generatedAt || Date.now()).getUTCFullYear();
  const known = new Map((statement?.cap?.lines || []).map(line => [line.currency, line]));
  const wanted = [...new Set([...known.keys(), ...currencies])].filter(currency => Number(program.individualYearlyCap?.[currency]) > 0);
  return wanted.map(currency => {
    const line = known.get(currency) || { paid: 0, held: 0, limit: Math.round(Number(program.individualYearlyCap[currency]) * 100) };
    const limit = line.limit || Math.round(Number(program.individualYearlyCap[currency]) * 100);
    return {
      currency,
      paid: line.paid,
      limit,
      held: line.held || 0,
      share: limit ? Math.min(100, Math.round(line.paid / limit * 100)) : 0,
      text: `${formatCents(line.paid, currency)} of ${formatCents(limit, currency)} paid in ${year}`,
      heldText: line.held > 0 ? `${formatCents(line.held, currency)} waits above the cap: invoice us as a business and we pay it against your invoice, or it is paid from 1 January ${year + 1}.` : ''
    };
  });
}

/** The cap in words for every currency: “€300 / $300”. */
export const capWords = (program = PARTNER_PROGRAM) => Object.entries(program.individualYearlyCap || {}).map(([currency, units]) => formatUnits(units, currency)).join(' / ');

/** The visits block: the three figures, or null while visits aren't counted (the dashboard's migration). */
export function visitFigures(statement) {
  const visits = statement?.visits;
  if (!visits) return null;
  const number = value => new Intl.NumberFormat('en-US').format(value || 0);
  return [
    { figure: number(visits.last30), label: 'Last 30 days' },
    { figure: number(visits.last90), label: 'Last 90 days' },
    { figure: number(visits.year), label: `In ${visits.yearOf || new Date(statement.generatedAt || Date.now()).getUTCFullYear()}` }
  ];
}

/**
 * How to get paid for team commissions, in the partner's words: one sentence
 * for an individual (send bank details) or a business (send an invoice),
 * with where to send it. `email` is the support address (SUPPORT_EMAIL) or ''.
 */
export function payWords(statement, { email = '' } = {}) {
  const business = statement?.partner === 'business';
  const where = email ? `email ${email}, or use the question form` : 'use the question form';
  return business
    ? `You invoice us as a business, with no yearly cap. Once a commission is earned, send us your invoice (${where}), naming the commission by its date and the team gift’s size as listed here, and we pay it by bank transfer within 30 days.`
    : `To be paid by bank transfer, send us the name on your bank account and its IBAN or account number once (${where}). We pay each commission within 30 days of it being earned, up to ${capWords(statement?.program)} a calendar year.`;
}

/** “Updated 22 Oct 2026, 11:20” for the page's header. */
export function updatedLabel(iso) {
  const time = Date.parse(String(iso || ''));
  if (!Number.isFinite(time)) return '';
  return `Updated ${new Date(time).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
}

export { plural };
