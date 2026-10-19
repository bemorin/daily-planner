// Refunds, disputes and revoked Plus licences. Pure helpers, shared by the
// router (server/planner-api.js) and the tests.
//
// Creem reports a refund with `refund.created` and a chargeback with
// `dispute.created`. Neither names the checkout, only the transaction: the API
// asks Creem for it (GET /v1/transactions?transaction_id=…), whose `order` is
// the order recorded when the checkout was paid (table orders, migration 0005).
//
// A full refund or a dispute revokes what the checkout gave. A revocation is a
// row (target, source):
//   checkout:<checkout id>  the purchase or gift checkout: its links stop working, and it is never delivered later
//   order:<order id>        the Creem order: a checkout paid with it is never delivered later (a refund that
//                           arrives before its purchase was delivered)
//   license:<licence id>    a licence (a Plus purchase, one made in the dashboard)
//   gift:<gift ref>         every licence activated from that gift (the link is switched off too)
// `source` groups the rows of one decision — the refund or dispute id, or
// owner_<id> for one made in the dashboard — so Restore undoes exactly that.
// A partial refund revokes nothing: the owner is emailed and decides.
// Planners ask POST /api/plus/check about once a week with their licence only.

import { escapeHtml, htmlDocument, textToHtml } from './email.js';
import { creemIdOf, creemModeOf } from './creem.js';

export const REFUND_EVENTS = Object.freeze({ 'refund.created': 'refund', 'dispute.created': 'dispute' });
export const REVOCATION_KINDS = Object.freeze(['checkout', 'order', 'license', 'gift']);
/** Reasons that come from Creem (a refund or a dispute), as opposed to the owner's own. */
export const CREEM_REASONS = Object.freeze(['refund', 'dispute']);
export const REFUND_REASON_MAX = 200;
export const REVOCATION_NOTE_MAX = 200;
export const OWNER_SOURCE_PREFIX = 'owner_';
// Transaction statuses: everything was given back, or only part of it.
const FULL_STATUSES = new Set(['refunded', 'chargedBack', 'chargeback', 'charged_back']);
const PARTIAL_STATUSES = new Set(['partialRefund', 'partially_refunded', 'partial_refund']);

export const revocationTarget = (kind, id) => `${kind}:${id}`;

const objectOrNull = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : null);
const cents = value => (Number.isInteger(value) && value >= 0 ? value : null);
const oneLine = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
const currencyOf = value => { const code = String(value ?? '').trim().toUpperCase(); return /^[A-Z]{3}$/.test(code) ? code : ''; };

/** Creem times are milliseconds (seconds and ISO text are read too); `fallback` when unreadable. */
export function isoTime(value, fallback) {
  let ms = typeof value === 'number' ? value : /^\d+$/.test(String(value ?? '')) ? Number(value) : Date.parse(String(value ?? ''));
  if (Number.isFinite(ms) && ms > 0 && ms < 1e11) ms *= 1000;
  return Number.isFinite(ms) && ms > 0 && ms < 8.64e15 ? new Date(ms).toISOString() : fallback;
}

/**
 * A refund.created or dispute.created event, read defensively; null for any
 * other event. `id` is the refund or dispute id (else the event id), the key
 * that makes processing idempotent; `orderId` and `checkoutId` are only set
 * when Creem happens to include them.
 */
export function readRefundEvent(event, nowIso = new Date().toISOString()) {
  const kind = REFUND_EVENTS[String(event?.eventType || event?.type || '')];
  if (!kind) return null;
  const object = [event?.object, event?.data?.object, event?.data].map(objectOrNull).find(Boolean) || {};
  const transaction = objectOrNull(object.transaction) || {};
  const customer = objectOrNull(object.customer) || {};
  const amount = kind === 'refund' ? cents(object.refund_amount) ?? cents(object.amount) : cents(object.amount);
  return {
    kind,
    id: creemIdOf(object.id) || creemIdOf(event?.id),
    transactionId: creemIdOf(object.transaction),
    orderId: creemIdOf(object.order) || creemIdOf(transaction.order),
    checkoutId: creemIdOf(object.checkout) || creemIdOf(transaction.checkout),
    amount,
    currency: currencyOf(kind === 'refund' ? object.refund_currency ?? object.currency : object.currency) || currencyOf(transaction.currency),
    reason: oneLine(object.reason).slice(0, REFUND_REASON_MAX),
    transactionStatus: String(transaction.status ?? ''),
    amountPaid: cents(transaction.amount_paid) ?? cents(transaction.amount),
    customerEmail: String(customer.email ?? '').trim().toLowerCase().slice(0, 254),
    mode: creemModeOf(object.mode) || creemModeOf(transaction.mode) || creemModeOf(event?.mode),
    createdAt: isoTime(object.created_at ?? event?.created_at, nowIso)
  };
}

/** What GET /v1/transactions answers: { orderId, status, amountPaid, refundedAmount, currency, mode }. */
export function readTransaction(entity) {
  const transaction = objectOrNull(entity) || {};
  return {
    orderId: creemIdOf(transaction.order),
    status: String(transaction.status ?? ''),
    amountPaid: cents(transaction.amount_paid) ?? cents(transaction.amount),
    refundedAmount: cents(transaction.refunded_amount),
    currency: currencyOf(transaction.currency),
    mode: creemModeOf(transaction.mode)
  };
}

/**
 * 'full', 'partial' or 'unclear'. A dispute always counts as full. The
 * transaction's status decides first (Creem's own answer is the freshest),
 * then the amounts: refunded ≥ paid is full. Without either, 'unclear':
 * nothing is revoked and the owner is asked to check.
 */
export function refundScope(refund, transaction = null) {
  if (refund?.kind === 'dispute') return 'full';
  const status = transaction?.status || refund?.transactionStatus || '';
  if (FULL_STATUSES.has(status)) return 'full';
  if (PARTIAL_STATUSES.has(status)) return 'partial';
  const paid = transaction?.amountPaid ?? refund?.amountPaid ?? null;
  const refunded = Math.max(refund?.amount ?? -1, transaction?.refundedAmount ?? -1);
  if (paid != null && refunded >= 0) return refunded >= paid ? 'full' : 'partial';
  return 'unclear';
}

/**
 * The scope to show and store: 'completes' when the transaction is now refunded
 * in full but this event's own amount is only part of what was paid (a partial
 * refund that completed a full refund, or one delivered after the refund that
 * did), so the owner sees this event's own amount for what it is.
 */
export function shownScope(refund, transaction = null) {
  const scope = refundScope(refund, transaction);
  if (scope !== 'full' || refund?.kind !== 'refund') return scope;
  const paid = transaction?.amountPaid ?? refund?.amountPaid ?? null;
  return refund.amount != null && paid != null && refund.amount < paid ? 'completes' : 'full';
}

/** "29.00 EUR", or '' without an amount. */
export const moneyText = (amount, currency) => (amount == null ? '' : `${(Number(amount) / 100).toFixed(2)}${currency ? ` ${currency}` : ''}`);

/**
 * The short email the owner gets for every refund and dispute: what happened,
 * what was switched off and what is left to decide. `scope` is shownScope().
 * `match`: { item: 'plus'|'gift'|'', checkoutId, giftCode, giftOrg, giftRedeemed, amountPaid,
 *   delivered (false: paid for, never delivered), already (switched off by an earlier refund or dispute),
 *   blocked (not matched, but its order will never be delivered), otherMode: { refund, order } (modes differ) }.
 */
export function refundNoticeEmail({ refund, scope, match = {}, dashboardUrl = '' }) {
  const amount = moneyText(refund.amount, refund.currency);
  const paid = match.amountPaid != null ? moneyText(match.amountPaid, refund.currency) : '';
  const what = match.item === 'plus' ? 'a Daily Planner Plus purchase'
    : match.item === 'gift' ? `the gift ${match.giftCode || ''}${match.giftOrg ? ` (${match.giftOrg})` : ''}`.replace(/\s+/g, ' ').trim()
      : '';
  const name = match.item === 'plus' ? 'Daily Planner Plus' : match.item === 'gift' ? `gift ${match.giftCode || ''}`.trim() : '';
  const event = refund.kind === 'dispute' ? 'dispute (a chargeback)' : 'refund';
  const lines = [];
  let subject;
  if (!what) {
    subject = `${refund.kind === 'dispute' ? 'Dispute' : 'Refund'} not matched${amount ? ` (${amount})` : ''}`;
    if (match.otherMode) {
      lines.push(`Creem reported a ${event}${amount ? ` of ${amount}` : ''} in ${match.otherMode.refund} mode, but the order it names was paid in ${match.otherMode.order} mode, so it was ignored${refund.transactionId ? ` (transaction ${refund.transactionId})` : ''}. Nothing was switched off.`);
      lines.push('Check it in Creem. If it is genuine, switch Plus off by hand in the dashboard, under Refunds and disputes → Revoke.');
    } else {
      lines.push(`Creem reported a ${event}${amount ? ` of ${amount}` : ''} that the API could not link to a purchase${refund.transactionId ? ` (transaction ${refund.transactionId})` : ''}. Nothing was switched off.`);
      if (match.blocked) lines.push('If it paid for a purchase that has not been delivered yet, it will not be delivered: the claim link and the gift page will say it was refunded.');
      lines.push('Find the payment in Creem. To switch Plus off, paste its checkout id (ch_…), the gift code or the licence id in the dashboard, under Refunds and disputes → Revoke.');
    }
  } else if (refund.kind === 'dispute') {
    subject = `Dispute: ${name}${amount ? ` (${amount})` : ''}`;
    lines.push(`A buyer disputed the payment for ${what} with their bank (a chargeback)${amount ? `: ${amount}` : ''}.`);
    lines.push(switchedOff(match));
    lines.push('Answer the dispute in Creem. If you win it, restore the purchase from the dashboard (Refunds and disputes → Restore).');
  } else if (scope === 'full' || scope === 'completes') {
    subject = scope === 'completes' ? `Refund: ${name}${amount ? ` (${amount}, now refunded in full)` : ' (now refunded in full)'}` : `Refund: ${name}${amount ? ` (${amount})` : ''}`;
    lines.push(scope === 'completes'
      ? `A partial refund${amount ? ` of ${amount}` : ''} completed a full refund of ${what}${paid ? ` (${paid} paid)` : ''}.`
      : `Creem refunded ${what} in full${amount ? `: ${amount}` : ''}.`);
    lines.push(switchedOff(match));
    if (!match.already) lines.push('If this was a mistake, restore it from the dashboard (Refunds and disputes → Restore).');
  } else {
    subject = `${scope === 'partial' ? 'Partial refund' : 'Refund'} to check: ${name}${amount ? ` (${amount}${paid ? ` of ${paid}` : ''})` : ''}`;
    lines.push(scope === 'partial'
      ? `Creem refunded part of ${what}${amount ? `: ${amount}${paid ? ` of ${paid}` : ''}` : ''}. Nothing was switched off.`
      : `Creem refunded ${what}${amount ? ` (${amount})` : ''}, but the API could not tell whether the refund was full. Nothing was switched off.`);
    lines.push(match.item === 'gift'
      ? 'Decide what fits: lower the seats of the gift in the dashboard (Team gifts → Edit), or switch it off entirely with Refunds and disputes → Revoke.'
      : 'Decide what fits: keep Plus as it is, or switch it off with Refunds and disputes → Revoke in the dashboard.');
  }
  return noticeContent({ subject, lines, refund, checkoutId: match.checkoutId || '', dashboardUrl });
}

/**
 * The one email the owner gets when a refund or a dispute is still waiting:
 * Creem's transaction could not be read, and Creem's next try failed too.
 */
export function refundWaitingEmail({ refund, error = '', dashboardUrl = '' }) {
  const amount = moneyText(refund.amount, refund.currency);
  const event = refund.kind === 'dispute' ? 'dispute (a chargeback)' : 'refund';
  const why = oneLine(error).replace(/[.\s]+$/, '');
  const lines = [
    `Creem reported a ${event}${amount ? ` of ${amount}` : ''}, but its transaction could not be read from Creem, twice${why ? ` (${why})` : ''}. Nothing was switched off yet.`,
    'Creem sends the event again on its own, and the dashboard lists it as waiting. If it is still waiting tomorrow, find the payment in Creem and switch Plus off by hand: Refunds and disputes → Revoke.'
  ];
  return noticeContent({ subject: `${refund.kind === 'dispute' ? 'Dispute' : 'Refund'} waiting: Creem’s transaction could not be read${amount ? ` (${amount})` : ''}`, lines, refund, dashboardUrl });
}

function noticeContent({ subject, lines, refund, checkoutId = '', dashboardUrl = '' }) {
  const facts = [
    ['Refund', refund.kind === 'dispute' ? '' : refund.id],
    ['Dispute', refund.kind === 'dispute' ? refund.id : ''],
    ['Transaction', refund.transactionId],
    ['Checkout', checkoutId],
    ['Buyer', refund.customerEmail],
    ['Reason', refund.reason]
  ].filter(([, value]) => value);
  const link = dashboardUrl ? `Dashboard: ${dashboardUrl}` : '';
  const text = [...lines.flatMap(line => [line, '']), ...facts.map(([label, value]) => `${label}: ${oneLine(value)}`), ...(link ? ['', link] : []), ''].join('\n');
  const html = htmlDocument([
    textToHtml(lines.join('\n\n')),
    facts.length ? `<p style="color:#706a62">${facts.map(([label, value]) => `${escapeHtml(label)}: <b>${escapeHtml(value)}</b>`).join('<br>\n')}</p>` : '',
    dashboardUrl ? `<p><a href="${escapeHtml(dashboardUrl)}">Open the dashboard</a></p>` : ''
  ].filter(Boolean).join('\n'));
  return { subject: oneLine(subject), html, text };
}

function switchedOff(match) {
  if (match.already) return 'It was already switched off by an earlier refund or dispute, so nothing more was needed.';
  if (match.delivered === false) return 'It had not been delivered yet, and now never will be: its activation link and gift page say it was refunded.';
  if (match.item === 'plus') return 'Plus was switched off: the activation link no longer works, and planners that activated it lose Plus at their next check (about once a week, when they are online).';
  const redeemed = Number(match.giftRedeemed) || 0;
  const people = redeemed ? ` The ${redeemed === 1 ? 'planner that activated it loses' : `${redeemed.toLocaleString('en-US')} planners that activated it lose`} Plus at their next check (about once a week, when online).` : ' Nobody had activated it yet.';
  return `The gift link was switched off.${people} Planners activated before version 1.24 can’t be reached this way.`;
}
