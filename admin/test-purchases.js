// Test-mode purchases (the dashboard's Refunds and disputes card, 1.34). While
// Creem reviews the store, review mode (CREEM_TEST_ON_PRODUCTION) lets a test
// key sell on the production address; anyone who knows Creem's test card can
// buy then, and what they get works like a paid purchase. Once payments are
// live, “Switch off test-mode purchases” revokes them all at once
// (POST /api/admin/test-purchases/switch-off { confirm: 'SWITCH OFF' }, after
// the owner typed SWITCH OFF in a dialog), and “Restore all” undoes it
// (POST …/restore { confirm: 'RESTORE' }, confirmed in a dialog too).
// The HTML builders and the words are pure and unit-tested
// (tests/admin-test-purchases.test.js); openTestPurchasesDialog wires a native
// <dialog> (focus kept inside, Escape cancels) and resolves with true or false.

const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const defaultNumber = value => new Intl.NumberFormat('en-US').format(Number(value) || 0);
const CHECK_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false"><path d="m6.5 12.5 3.3 3.3 7.7-8"/></svg>';

/** What the owner types, and what the server is sent, to switch them off. */
export const SWITCH_OFF_WORDS = 'SWITCH OFF';
export const RESTORE_WORD = 'RESTORE';

/** Typed as the dialog asks, give or take case and spaces: “switch off”, “ SWITCH  OFF ”. */
export const confirmMatches = text => String(text ?? '').trim().replace(/\s+/g, ' ').toUpperCase() === SWITCH_OFF_WORDS;

/** “3 Plus licences and 1 gift link”, “1 Plus licence”, '' for none. */
export function purchaseWords(plus, gifts, { number = defaultNumber } = {}) {
  const parts = [
    plus > 0 ? `${number(plus)} Plus ${plus === 1 ? 'licence' : 'licences'}` : '',
    gifts > 0 ? `${number(gifts)} gift ${gifts === 1 ? 'link' : 'links'}` : ''
  ].filter(Boolean);
  return parts.join(' and ');
}

/** The counts of the summary (summary.testPurchases), read defensively; null without them. */
export function readStatus(status) {
  if (!status || typeof status !== 'object') return null;
  const count = value => Math.max(0, Math.floor(Number(value) || 0));
  const plus = count(status.plus);
  const gifts = count(status.gifts);
  const plusOff = Math.min(plus, count(status.plusOff));
  const giftsOff = Math.min(gifts, count(status.giftsOff));
  return {
    plus, gifts, plusOff, giftsOff,
    total: plus + gifts,
    off: plusOff + giftsOff,
    active: plus + gifts - plusOff - giftsOff,
    switchedOff: count(status.switchedOff),
    mode: String(status.mode || ''),
    reviewMode: status.reviewMode === true,
    reviewOpen: status.reviewOpen === true
  };
}

/** Whether the panel shows at all: once something was bought in test mode, or while review mode is open. */
export const panelShown = status => !!status && (status.total > 0 || status.reviewOpen);

/** The panel's lead, from the mode: what these purchases are, and when to switch them off. */
function leadText(status) {
  if (status.reviewOpen) return 'While Creem reviews your store, checkouts on the production address run in Creem’s test mode: no real payment, and anyone with a test card can buy. Once your live key is in, switch them all off here.';
  if (status.mode === 'live') return 'Bought before payments went live, with no real payment. They work like paid purchases until you switch them off: gift links stop at once, planners lose Plus at their next weekly check.';
  return 'Bought with Creem’s test key: no real payment. Once your live key is in, switch them all off here.';
}

/**
 * The panel (HTML, every value escaped): the counts, what the mode means, and
 * the two actions. `result`: { text, error } to show under the actions.
 */
export function testPurchasesHtml(status, { number = defaultNumber, result = null } = {}) {
  if (!panelShown(status)) return '';
  const counts = [
    ['Plus licences', status.plus, status.plusOff],
    ['Gift links', status.gifts, status.giftsOff]
  ].map(([label, all, off]) => `<div class="owner-tests__count"><dt>${esc(label)}</dt><dd><b>${esc(number(all))}</b>${all ? `<small>${off === all ? 'all off' : off ? `${esc(number(off))} off` : 'none off'}</small>` : ''}</dd></div>`).join('');
  const active = `<div class="owner-tests__count${status.active ? ' is-active' : ''}"><dt>Still active</dt><dd><b>${esc(number(status.active))}</b><small>${status.active ? 'give Plus' : status.total ? 'all switched off' : 'none yet'}</small></dd></div>`;
  // Nothing to switch off: a calm state instead of a button that can't be used.
  const switchButton = status.active
    ? '<button class="primary-button owner-danger" type="button" data-owner-tests-switch>Switch off test-mode purchases…</button>'
    : `<p class="owner-tests__state">${status.total ? `${CHECK_ICON}All switched off` : 'Nothing bought in test mode yet.'}</p>`;
  const restoreButton = status.switchedOff ? '<button class="text-button" type="button" data-owner-tests-restore>Restore all…</button>' : '';
  return `<section class="owner-subform owner-tests" data-owner-attn="test-purchases" aria-labelledby="owner-tests-title">
      <div class="owner-subform__head">
        <h3 id="owner-tests-title"><span>Test-mode purchases</span>${status.reviewOpen ? '<span class="owner-pill owner-pill--review">Review mode on</span>' : ''}</h3>
        <p>${esc(leadText(status))}</p>
      </div>
      <dl class="owner-tests__counts">${counts}${active}</dl>
      <div class="owner-actions">${switchButton}${restoreButton}</div>
      <p class="owner-result${result?.error ? ' is-error' : ''}" data-owner-tests-result role="status" aria-live="polite" tabindex="-1"${result?.text ? '' : ' hidden'}>${esc(result?.text || '')}</p>
    </section>`;
}

/** The dialog's form for 'switch-off' (type SWITCH OFF) or 'restore' (one button). */
export function dialogHtml(kind, status, { number = defaultNumber } = {}) {
  if (kind === 'restore') {
    return `<form class="owner-subform owner-tests-dialog" data-owner-tests-form novalidate>
        <div class="owner-subform__head"><h2 id="owner-tests-dialog-title">Restore the test-mode purchases?</h2>
          <p>This undoes the switch-off: what it holds gives Plus again. Gift links work again at once; planners get Plus back at their next weekly check, when they are online.</p></div>
        <ul class="owner-tests__list"><li>A purchase also refunded, disputed or revoked by hand stays off.</li><li>You can switch them off again at any time.</li></ul>
        <p class="owner-result is-error" data-owner-tests-error role="alert" hidden></p>
        <div class="owner-actions"><button class="primary-button" type="submit">Restore all</button><button class="text-button" type="button" data-owner-tests-cancel>Cancel</button></div>
      </form>`;
  }
  const bought = purchaseWords(status.plus, status.gifts, { number }) || 'Nothing';
  const already = status.off ? ` ${esc(number(status.off))} ${status.off === 1 ? 'is' : 'are'} already off.` : '';
  const losing = purchaseWords(status.plus - status.plusOff, status.gifts - status.giftsOff, { number });
  return `<form class="owner-subform owner-tests-dialog" data-owner-tests-form novalidate>
      <div class="owner-subform__head"><h2 id="owner-tests-dialog-title">Switch off every test-mode purchase?</h2>
        <p>${esc(bought)} ${status.total === 1 ? 'was' : 'were'} bought in Creem’s test mode.${already}</p></div>
      <ul class="owner-tests__list">
        <li>${esc(losing)} stop${status.active === 1 ? 's' : ''} giving Plus: gift links at once, planners at their next weekly check, when they are online.</li>
        <li>It is recorded as your revocation, and <b>Restore all</b> undoes it.</li>
        ${status.reviewOpen ? '<li class="is-warn">Review mode is still on: test purchases made after this stay active until you switch off again.</li>' : ''}
      </ul>
      <label class="form-field"><span>Type <b>${SWITCH_OFF_WORDS}</b> to confirm</span><input name="confirm" autocomplete="off" autocapitalize="characters" spellcheck="false"></label>
      <p class="owner-result is-error" data-owner-tests-error role="alert" hidden></p>
      <div class="owner-actions"><button class="primary-button owner-danger" type="submit" disabled>Switch off ${esc(number(status.active))}</button><button class="text-button" type="button" data-owner-tests-cancel>Cancel</button></div>
    </form>`;
}

/** What to say once it is done, from the counts before and the server's answer. */
export function doneText(kind, before, answer, { number = defaultNumber } = {}) {
  const after = readStatus(answer?.status) || before;
  if (kind === 'restore') {
    const back = Math.max(0, after.active - before.active);
    return back ? `Restored: ${number(back)} test-mode ${back === 1 ? 'purchase gives' : 'purchases give'} Plus again. Planners get it back at their next weekly check.` : 'Restored. Nothing gives Plus again: what was switched off is still held by a refund, a dispute or a revocation by hand.';
  }
  const stopped = Math.max(0, before.active - after.active);
  const more = Number(answer?.more) > 0 ? ` ${number(answer.more)} more to go: switch off again.` : '';
  if (!stopped) return `Nothing left to switch off.${more}`;
  return `Switched off: ${purchaseWords(before.plus - before.plusOff - (after.plus - after.plusOff), before.gifts - before.giftsOff - (after.gifts - after.giftsOff), { number }) || `${number(stopped)} purchases`}. Gift links stopped now; planners lose Plus at their next weekly check.${more}`;
}

let dialog = null;

/**
 * Opens the dialog for `kind` ('switch-off' or 'restore') and resolves with
 * true once confirmed (SWITCH OFF typed, or Restore all pressed), else false.
 */
export function openTestPurchasesDialog(kind, status, { number = defaultNumber } = {}) {
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.className = 'owner-dialog owner-dialog--tests';
    dialog.setAttribute('aria-labelledby', 'owner-tests-dialog-title');
    document.body.append(dialog);
  }
  dialog.innerHTML = dialogHtml(kind, status, { number });
  const form = dialog.querySelector('[data-owner-tests-form]');
  const submit = form.querySelector('button[type="submit"]');
  const input = form.elements.confirm;
  const error = dialog.querySelector('[data-owner-tests-error]');
  return new Promise(resolve => {
    let confirmed = false;
    const finish = () => { dialog.removeEventListener('close', finish); resolve(confirmed); };
    dialog.addEventListener('close', finish);
    dialog.querySelector('[data-owner-tests-cancel]').addEventListener('click', () => dialog.close());
    input?.addEventListener('input', () => {
      submit.disabled = !confirmMatches(input.value);
      error.hidden = true;
    });
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (input && !confirmMatches(input.value)) {
        error.textContent = `Type ${SWITCH_OFF_WORDS} to confirm.`;
        error.hidden = false;
        input.focus();
        return;
      }
      confirmed = true;
      dialog.close();
    });
    dialog.showModal();
    (input || dialog.querySelector('[data-owner-tests-cancel]')).focus();
  });
}
