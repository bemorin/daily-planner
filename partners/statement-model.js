/**
 * A partner's private statement (partners/statement/), in words and figures:
 * pure and unit-tested (tests/partner-statement.test.js). The page reads the
 * statement the API answers for one partner (server/partners.js
 * partnerStatement: that partner only, never anything about a buyer) and
 * these helpers say it calmly — the visits their link brought, what was
 * bought through it, each team commission's state, the yearly cap of an
 * individual and how to get paid. A figure worked out on an amount whose tax
 * (or a refund's amount) isn't known is only an upper bound: it reads “At
 * most”, alone and in every total it is part of.
 */

import { formatMoney, PARTNER_PROGRAM, partnerYear, validCurrency } from '../src/lib/pricing.js';

export const STATEMENT_CODE_RE = /^[A-Za-z0-9_-]{2,64}$/;
export const STATEMENT_KEY_RE = /^[0-9a-f]{32}$/;
/** Where partners ask a question (from /partners/statement/). Never for bank details or invoices: those go by email. */
export const PARTNER_QUESTION_HREF = '../../contact/?topic=partners';

/**
 * The code and key of the link, from the part of the address after `#`
 * (`#code=CODE&key=KEY`: a browser never sends it to a server), or null when
 * either is missing or malformed.
 */
export function statementParams(hash = '') {
  let params;
  try { params = new URLSearchParams(String(hash || '').replace(/^#/, '')); } catch (_) { return null; }
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

/**
 * Amounts per currency, never added together: “€16.25 · $19.50”, or `empty`.
 * A currency in `atMost` (a Set) reads “At most €16.25”: an upper bound is part of it.
 */
export const perCurrency = (amounts, empty = '', atMost = null) => Object.entries(amounts || {}).filter(([, cents]) => cents > 0).map(([currency, cents]) => `${atMost?.has(currency) ? 'At most ' : ''}${formatCents(cents, currency)}`).join(' · ') || empty;

const plural = (count, word, many = `${word}s`) => `${new Intl.NumberFormat('en-US').format(count)} ${count === 1 ? word : many}`;

/** “Team gift · up to 50 people”. */
export const teamGiftLabel = seats => (seats ? `Team gift · up to ${new Intl.NumberFormat('en-US').format(seats)} people` : 'Team gift');

const OFF_STATES = ['paid', 'refunded', 'disputed', 'revoked', 'not-partner'];
/** Whether a line's figure is only an upper bound still (paid or switched-off lines are what they are). */
const uncertain = line => line?.exact === false && !OFF_STATES.includes(line.status);

/**
 * Which totals include an upper bound, per currency: { pending, toPay, held }
 * (Sets of currencies), from the lines whose figure reads “At most”.
 */
export function uncertainTotals(statement) {
  const sets = { pending: new Set(), toPay: new Set(), held: new Set() };
  for (const line of statement?.team || []) {
    if (!uncertain(line)) continue;
    if (line.status === 'pending') sets.pending.add(line.currency);
    if (line.payable > 0) sets.toPay.add(line.currency);
    if (line.held > 0) sets.held.add(line.currency);
  }
  return sets;
}

const WAITS = 'it waits until 1 January, or until you invoice us as a business';

/**
 * For an individual: what a pending commission will meet once earned, per
 * line (a Map from line to words). The cap left this year goes first to what
 * is to be paid now, then to the pending lines, the first earned first; a
 * line earned in a later year starts that year's cap. '' when it fits.
 */
function capWaitNotes(statement) {
  const notes = new Map();
  if (statement?.partner === 'business') return notes;
  const program = statement?.program || PARTNER_PROGRAM;
  const year = statement?.cap?.year || partnerYear(statement?.generatedAt || Date.now());
  const known = new Map((statement?.cap?.lines || []).map(line => [line.currency, line]));
  const room = new Map();
  const roomOf = currency => {
    if (!room.has(currency)) {
      const limit = Math.round(Number(program.individualYearlyCap?.[currency]) * 100);
      const line = known.get(currency);
      room.set(currency, Number.isFinite(limit) && limit > 0 ? Math.max(0, (line ? line.limit - line.paid : limit) - (statement?.totals?.toPay?.[currency] || 0)) : null);
    }
    return room.get(currency);
  };
  const pending = (statement?.team || []).filter(line => line.status === 'pending').sort((a, b) => String(a.earnedOn).localeCompare(String(b.earnedOn)));
  for (const line of pending) {
    const left = roomOf(line.currency);
    if (left == null || Number(String(line.earnedOn).slice(0, 4)) > year) continue;
    const rest = Math.max(0, (line.commission || 0) - (line.paidAmount || 0));
    if (left <= 0) notes.set(line, `Your cap for this year is used up: once earned, ${WAITS}`);
    else if (rest > left) notes.set(line, `Only ${formatCents(left, line.currency)} fits under your yearly cap this year: once earned, the rest waits until 1 January, or until you invoice us as a business`);
    room.set(line.currency, Math.max(0, left - rest));
  }
  return notes;
}

/**
 * Where one team commission stands, for the partner: { label, detail, tone }.
 * `tone` picks the pill: 'wait' (pending, or waiting above the yearly cap),
 * 'due' (earned, to be paid), 'ok' (paid), 'off' (earns nothing). `capNote`
 * says what a pending one will meet under the yearly cap (capWaitNotes).
 */
export function teamLineState(line, { partner = 'individual', capNote = '' } = {}) {
  const money = cents => formatCents(cents, line.currency);
  const atMost = uncertain(line) ? 'at most ' : '';
  const paidPart = line.paidAmount ? `${money(line.paidAmount)} paid${line.paidOn ? ` on ${dayLabel(line.paidOn)}` : ''}` : '';
  const how = partner === 'business' ? 'Invoice us for it: we pay it against your invoice' : 'We pay it by bank transfer within 30 days';
  switch (line.status) {
    case 'pending': return { label: 'Pending', detail: [line.earnedOn ? `Earned on ${dayLabel(line.earnedOn)} if the gift isn’t refunded` : 'In its refund period', capNote].filter(Boolean).join(' · '), tone: 'wait' };
    case 'earned': {
      const capped = line.held > 0 ? `${money(line.payable)} to be paid now · ${atMost}${money(line.held)} waits above your yearly cap` : '';
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
  const amount = line.commission == null ? '—' : `${uncertain(line) ? 'At most ' : ''}${formatCents(line.status === 'paid' && line.paidAmount != null ? line.paidAmount : line.commission, line.currency)}`;
  return { soldOn: dayLabel(line.soldOn), what: teamGiftLabel(line.seats), amount, ...state, off: state.tone === 'off' };
}

/** Every team commission of a statement as rows (teamLineView), newest first, with what the yearly cap means for the pending ones. */
export function teamLineViews(statement) {
  const notes = capWaitNotes(statement);
  return (statement?.team || []).map(line => teamLineView(line, { partner: statement.partner, capNote: notes.get(line) || '' }));
}

/** The totals under the team gifts, in the order shown: [[label, text]], the empty ones left out; “At most” where an upper bound is part of one. */
export function teamTotals(statement) {
  const totals = statement?.totals || {};
  const unsure = uncertainTotals(statement);
  return [
    ['To be paid', perCurrency(totals.toPay, '', unsure.toPay)],
    ['Pending', perCurrency(totals.pending, '', unsure.pending)],
    ['Above your yearly cap', perCurrency(totals.held, '', unsure.held)],
    ['Paid', perCurrency(totals.paid)]
  ].filter(([, value]) => value);
}

/** What Creem credits, by kind, with how many were refunded: [{ label, count, note }] (kinds with none left out); [] when nothing. */
export function creemRows(statement) {
  return (statement?.creem || []).filter(row => row.count > 0).map(row => ({
    label: row.label,
    count: row.count,
    note: row.refunded ? `${row.refunded} refunded or disputed: ${row.refunded === 1 ? 'it earns' : 'they earn'} nothing` : ''
  }));
}

/**
 * The team figure at the top, in the partner's own currency: what is to be
 * paid (and what waits above the yearly cap), else what waits, else what is
 * pending, else what was paid, else nothing yet — zero in the currency of the
 * partner's latest sale, or no amount at all without one.
 */
function teamFigure(statement) {
  const totals = statement?.totals || {};
  const unsure = uncertainTotals(statement);
  const toPay = perCurrency(totals.toPay, '', unsure.toPay);
  const held = perCurrency(totals.held, '', unsure.held);
  const pending = perCurrency(totals.pending, '', unsure.pending);
  const paid = perCurrency(totals.paid);
  if (toPay) return { figure: toPay, label: held ? `in team commissions to be paid · ${held.replace(/At most/g, 'at most')} waits above your yearly cap` : 'in team commissions to be paid' };
  if (held) return { figure: held, label: 'in team commissions waiting above your yearly cap' };
  if (pending) return { figure: pending, label: 'in team commissions pending' };
  if (paid) return { figure: paid, label: 'in team commissions paid to you' };
  const currency = validCurrency(statement?.currency) || validCurrency((statement?.team || []).find(line => line.currency)?.currency);
  return currency ? { figure: formatCents(0, currency), label: 'in team commissions so far' } : { figure: '0', label: 'team commissions so far' };
}

/** The figures at the top: visits (30 days), purchases credited by Creem, and the team commissions (teamFigure). */
export function statementFigures(statement) {
  const visits = statement?.visits;
  const purchases = (statement?.creem || []).reduce((sum, row) => sum + (row.count || 0), 0);
  return [
    { id: 'visits', figure: visits ? new Intl.NumberFormat('en-US').format(visits.last30) : '—', label: 'visits through your link, last 30 days' },
    { id: 'purchases', figure: new Intl.NumberFormat('en-US').format(purchases), label: `${purchases === 1 ? 'purchase' : 'purchases'} of Plus or a gift, credited by Creem` },
    { id: 'team', ...teamFigure(statement) }
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
  const year = statement?.cap?.year || partnerYear(statement?.generatedAt || Date.now());
  const known = new Map((statement?.cap?.lines || []).map(line => [line.currency, line]));
  const unsure = uncertainTotals(statement).held;
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
      heldText: line.held > 0 ? `${unsure.has(currency) ? 'At most ' : ''}${formatCents(line.held, currency)} waits above the cap: invoice us as a business and we pay it against your invoice, or it is paid from 1 January ${year + 1}.` : ''
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
 * How to get paid for team commissions, in the partner's words: bank
 * details (an individual) or an invoice (a business), sent by email to the
 * support address (SUPPORT_EMAIL, `email`) — never through a form — or, when
 * there is none, as a reply to the email this link came with.
 */
export function payWords(statement, { email = '' } = {}) {
  const business = statement?.partner === 'business';
  const send = email ? `email ${business ? 'it' : 'them'} to ${email}` : 'reply to the email we sent you with this link';
  return business
    ? `You invoice us as a business, with no yearly cap. Once a commission is earned, send us your invoice — ${send} — naming the commission by its date and the team gift’s size as listed here. We pay it by bank transfer within 30 days of it being earned.`
    : `To be paid by bank transfer, send us the name on your bank account and its IBAN or account number once — ${send}. We pay each commission within 30 days of it becoming payable: once it is earned, within your cap of ${capWords(statement?.program)} a calendar year. What waits above the cap becomes payable on 1 January, or once you invoice us as a business.`;
}

/**
 * The button that sends payment details: a mailto: link to the support
 * address with the subject “Partner payment details — CODE” (an individual)
 * or “Partner invoice — CODE” (a business), or null without an address (then
 * the partner replies to our email). `email` is a plain address already
 * checked (legal/legal-details.js legalEmail), the code one of the link's.
 */
export function payAction(statement, { email = '' } = {}) {
  const code = STATEMENT_CODE_RE.test(String(statement?.code || '')) ? statement.code : '';
  if (!email || !code) return null;
  const business = statement.partner === 'business';
  const subject = `${business ? 'Partner invoice' : 'Partner payment details'} — ${code}`;
  return { href: `mailto:${email}?subject=${encodeURIComponent(subject)}`, label: business ? 'Email your invoice' : 'Email your bank details', subject };
}

/** “Updated 22 Oct 2026, 11:20” for the page's header. */
export function updatedLabel(iso) {
  const time = Date.parse(String(iso || ''));
  if (!Number.isFinite(time)) return '';
  return `Updated ${new Date(time).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
}

export { plural };
