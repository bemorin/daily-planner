// Mark as paid (the dashboard's Partners card, 1.33): one small dialog asks
// everything paying a team commission needs — what to check first (a code
// nothing confirmed, a refund or the tax not recorded), the amount paid when
// the commission is only an upper bound, the day it was paid and an optional
// reference only the owner sees. The day is in Europe/Paris (today by
// default, never in the future, never before the commission was earned) and
// decides the yearly cap it counts against. When an individual's yearly cap
// cuts the amount, only the part that fits is marked and the rest stays open,
// with no question; the one question left (“Is that all of it?”, for an upper
// bound paid below what the cap allows) starts on the safe answer: keep the
// rest open. payoutDetails, payoutFormHtml and payoutRequest are pure and
// unit-tested (tests/admin-partners.test.js); openPayoutDialog wires a native
// <dialog> (focus kept inside, Escape cancels) and resolves with the request
// to send, or null.

import { partnerDay } from '../src/lib/pricing.js';
import { payoutCheckWords } from './partners-view.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const NOTE_MAX = 200;

/** An amount as the owner types it (“595”, “595.50”, “595,5”): { amount } in cents (null when blank) or { error }. */
export function parseAmount(text) {
  const clean = String(text || '').replace(/[\s\u00a0\u202f]/g, '').replace(',', '.');
  if (!clean) return { amount: null };
  if (!/^\d{1,9}(?:\.\d{1,2})?$/.test(clean)) return { error: 'Write the amount like 595 or 595.50.' };
  return { amount: Math.round(Number(clean) * 100) };
}

/** “22 Oct 2026” for a YYYY-MM-DD day. */
export const payDayLabel = day => (DAY_RE.test(String(day || '')) ? new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');

/**
 * What the Mark as paid button says about its commission (its data-owner-payout-* attributes,
 * admin/partners-view.js): { checkout, code, currency, checks, business, cents (what can be paid now), rest,
 * exact, capped (the yearly cap holds part of it back), shown (`cents` in words), earned (the day it was
 * earned, Europe/Paris), today }.
 */
export function payoutDetails(dataset, { today = partnerDay(Date.now()) } = {}) {
  const cents = Number(dataset.ownerPayoutCents) || 0;
  const rest = Number(dataset.ownerPayoutRest) || cents;
  const earned = DAY_RE.test(String(dataset.ownerPayoutEarned || '')) ? dataset.ownerPayoutEarned : '';
  return {
    checkout: String(dataset.ownerPayout || ''),
    code: dataset.ownerPayoutCode || 'this partner',
    currency: dataset.ownerPayoutCurrency || '',
    checks: String(dataset.ownerPayoutChecks || '').split(' ').filter(Boolean),
    business: dataset.ownerPayoutPartner === 'business',
    cents,
    rest,
    exact: dataset.ownerPayoutExact !== '0',
    capped: cents > 0 && cents < rest,
    shown: dataset.ownerPayoutAmount || '',
    earned: earned && earned > today ? today : earned,
    today
  };
}

/**
 * The dialog's form (HTML, every value escaped). `money(cents, currency)`
 * formats an amount to the cent; `rate` is the team commission's rate.
 */
export function payoutFormHtml(details, { money, rate = 10 } = {}) {
  const { code, currency, cents, rest, exact, capped, business } = details;
  const how = business ? 'against their invoice' : 'by bank transfer';
  const waits = `until ${code} invoices you as a business, or until 1 January`;
  const lead = capped
    ? `Only ${details.shown} fits under ${code}’s yearly cap for an individual. The rest (${exact ? '' : 'at most '}${money(rest - cents, currency)}) stays open: it waits ${waits}.`
    : exact ? `${details.shown}, paid ${how}.` : `Paid ${how}.`;
  const checks = details.checks.length
    ? `<fieldset class="owner-pay__checks"><legend>Before paying</legend><ul>${payoutCheckWords({ code, checks: details.checks }, rate).map(line => `<li>${esc(line)}.</li>`).join('')}</ul><label class="owner-pay__tick"><input type="checkbox" name="verified" required> I checked ${details.checks.length === 1 ? 'it' : 'them'}</label></fieldset>`
    : '';
  const amount = exact ? '' : `<label class="form-field"><span>Commission you paid <em>at most ${esc(details.shown)}</em></span><input name="amount" inputmode="decimal" autocomplete="off" spellcheck="false" required aria-describedby="owner-pay-amount-note"></label>
      <small class="owner-small" id="owner-pay-amount-note">${esc(money(rest, currency))} is the most ${esc(code)} can have earned: the tax or a refund’s amount isn’t recorded. Check it in Creem and pay ${esc(rate)}% of the price before tax.</small>`;
  const more = !exact && capped
    ? `<fieldset class="owner-pay__more" data-owner-pay-more hidden><legend>Is that all of this commission?</legend>
        <label><input type="radio" name="more" value="open" checked> No, more may be owed: keep the rest open</label>
        <label><input type="radio" name="more" value="settle"> Yes, it was all of it: settle the commission</label>
      </fieldset>`
    : '';
  const min = details.earned ? ` min="${esc(details.earned)}"` : '';
  return `<form class="owner-subform owner-pay" data-owner-pay-form novalidate>
      <div class="owner-subform__head"><h2 id="owner-pay-title">Mark ${esc(code)}’s commission as paid</h2><p>${esc(lead)}</p></div>
      ${checks}
      ${amount}
      ${more}
      <div class="owner-form-grid">
        <label class="form-field"><span>Paid on <em>${business ? 'the day you paid their invoice' : 'the day the transfer was sent'}</em></span><input name="paidOn" type="date" value="${esc(details.today)}"${min} max="${esc(details.today)}" required></label>
        <label class="form-field"><span>Reference <em>optional, only you see it</em></span><input name="note" maxlength="${NOTE_MAX}" autocomplete="off" spellcheck="false"></label>
      </div>
      <p class="owner-result is-error" data-owner-pay-error role="alert" hidden></p>
      <div class="owner-actions"><button class="primary-button" type="submit">Mark as paid</button><button class="text-button" type="button" data-owner-pay-cancel>Cancel</button></div>
    </form>`;
}

/**
 * Whether the “Is that all of it?” question applies to what was typed: an
 * upper bound the yearly cap holds back, paid below what the cap allows (paid
 * exactly that, it is a part with no question).
 */
export const asksIfWhole = (details, typed) => !details.exact && details.capped && Number.isInteger(typed) && typed > 0 && typed < details.cents;

/**
 * The request the form's values make: { body, done } (POST
 * admin/partners/payouts, and what to say once it is sent) or { error, field }
 * (the field to fix). `values`: { checked, amount, more, paidOn, note }.
 */
export function payoutRequest(details, values, { money } = {}) {
  const { code, currency, cents } = details;
  if (details.checks.length && values.checked !== true) return { error: `Check ${details.checks.length === 1 ? 'it' : 'them'} first, then tick the box.`, field: 'verified' };
  let amount = null;
  let part = null;
  if (!details.exact) {
    const parsed = parseAmount(values.amount);
    if (parsed.error || !parsed.amount || parsed.amount > cents) return { error: parsed.error || `Type the commission you paid: more than nothing and at most ${details.shown}.`, field: 'amount' };
    amount = parsed.amount;
    // The cap cut it: a part, the rest stays open. Below what the cap allows: the owner's answer, keep it open unless they say it was all.
    if (details.capped) part = amount === cents ? true : values.more !== 'settle';
  } else if (details.capped) {
    amount = cents;
  }
  const paidOn = String(values.paidOn || '');
  if (!DAY_RE.test(paidOn)) return { error: 'Choose the day you paid it.', field: 'paidOn' };
  if (paidOn > details.today) return { error: 'The day paid can’t be in the future.', field: 'paidOn' };
  if (details.earned && paidOn < details.earned) return { error: `This commission was earned on ${payDayLabel(details.earned)}: the day paid can’t be before it.`, field: 'paidOn' };
  const shown = amount == null ? details.shown : money(amount, currency);
  const rest = part ? (amount === cents && details.capped ? ' The rest stays open: it waits above the yearly cap.' : ' The rest stays open.') : details.capped && details.exact ? ' The rest stays open: it waits above the yearly cap.' : '';
  return {
    body: { checkout: details.checkout, note: String(values.note || '').trim().slice(0, NOTE_MAX), paidOn, ...(details.checks.length ? { confirmed: true } : {}), ...(amount == null ? {} : { amount }), ...(part == null ? {} : { part }) },
    done: `Marked as paid: ${code}, ${shown}, on ${payDayLabel(paidOn)}.${rest}`
  };
}

let dialog = null;

/**
 * Opens the dialog for a Mark as paid button's `dataset` and resolves with
 * payoutRequest()'s { body, done }, or null when cancelled. `money` formats
 * amounts, `rate` is the team rate.
 */
export function openPayoutDialog(dataset, { money, rate } = {}) {
  const details = payoutDetails(dataset);
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.className = 'owner-dialog';
    dialog.setAttribute('aria-labelledby', 'owner-pay-title');
    document.body.append(dialog);
  }
  dialog.innerHTML = payoutFormHtml(details, { money, rate });
  const form = dialog.querySelector('[data-owner-pay-form]');
  const error = dialog.querySelector('[data-owner-pay-error]');
  const more = dialog.querySelector('[data-owner-pay-more]');
  return new Promise(resolve => {
    let answer = null;
    const finish = () => { dialog.removeEventListener('close', finish); resolve(answer); };
    dialog.addEventListener('close', finish);
    form.elements.amount?.addEventListener('input', () => { if (more) more.hidden = !asksIfWhole(details, parseAmount(form.elements.amount.value).amount); });
    dialog.querySelector('[data-owner-pay-cancel]').addEventListener('click', () => dialog.close());
    form.addEventListener('submit', event => {
      event.preventDefault();
      const values = { checked: form.elements.verified?.checked === true, amount: form.elements.amount?.value || '', more: form.elements.more?.value || 'open', paidOn: form.elements.paidOn.value, note: form.elements.note.value };
      const result = payoutRequest(details, values, { money });
      if (result.error) {
        error.textContent = result.error;
        error.hidden = false;
        const field = form.elements[result.field];
        (field?.focus ? field : form.querySelector('button[type="submit"]')).focus();
        return;
      }
      answer = result;
      dialog.close();
    });
    dialog.showModal();
    (form.elements.verified || form.elements.amount || form.elements.paidOn).focus();
  });
}
