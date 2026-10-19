import { checkPlusLicense, plannerApiEnabled } from '../lib/planner-api.js';
import { hasPlus, onPlusChange, PLUS_CHECK_KEY, plusLicense, plusSettings, readPlusCheck, refreshPlus, restorePlus, revokePlus, writePlusCheck } from '../lib/plus.js';

/**
 * The weekly licence check: a refunded purchase or gift switches Plus off, and
 * a restored one switches it back on.
 *
 * Plus is verified on the device, so a licence alone would work for ever. When
 * the owner API is on and the device is online, the planner asks POST
 * /api/plus/check about its licence — sending only the licence — at most once
 * every 7 days, and right after launch when the last check is older. The time
 * of the last check lives in `daily-planner-ui:plus-checked` (never synced or
 * backed up). Only an answer that says "revoked" removes Plus (revokePlus in
 * src/lib/plus.js); offline, a network error or a server error never does.
 * The revoked licence stays on this device, aside, and is asked about each
 * week while Plus is off: an answer that says "valid" (the owner restored it)
 * brings Plus back (restorePlus). Either way the person is told once, calmly,
 * in a small dialog.
 */

export const PLUS_CHECK_INTERVAL_MS = 7 * 86400000;
/** After launch, so the check never competes with the first paint. */
export const PLUS_CHECK_DELAY_MS = 4000;
/** While the planner stays open for days, whether a check is due is asked again this often. */
export const PLUS_CHECK_POLL_MS = 3 * 3600000;
const NOTICE_RETRY_MS = 1500;

/** Pure: true when a check should be made now. `lastAt` is 0 when this device never checked. */
export function plusCheckDue({ now, lastAt = 0, apiOn = false, online = true, active = false }) {
  if (!apiOn || !active || online === false) return false;
  const last = Number(lastAt) || 0;
  // A last check "in the future" (the clock moved back) counts as old.
  return !(last > 0 && last <= now && now - last < PLUS_CHECK_INTERVAL_MS);
}

/** Pure: 'revoked' or 'valid' from a clear answer; 'error' for anything else, which never removes Plus. */
export function checkOutcome(result) {
  if (result?.ok === true && result.revoked === true) return 'revoked';
  if (result?.ok === true && result.revoked === false) return 'valid';
  return 'error';
}

const NOTICES = Object.freeze({
  purchase: 'Plus was switched off on this planner: its purchase was refunded or cancelled. If this is a mistake, reply to your receipt email.',
  gift: 'Plus was switched off on this planner: the gift that activated it was refunded or cancelled. If this is a mistake, ask the person who gave it to you.',
  manual: 'Plus was switched off on this planner: its licence was withdrawn. If this is a mistake, reply to the email it came with.'
});

/**
 * The words of the one-time notice: for a revoked licence, by where it came
 * from ('purchase', 'gift', 'manual', 'dev'), or 'restored' when it is valid again.
 */
export function plusNotice(kind) {
  if (kind === 'restored') return { eyebrow: 'Daily Planner Plus', title: 'Plus is back on this planner', text: 'Its licence is valid again, so everything Plus adds works as before.' };
  return { eyebrow: 'Daily Planner Plus', title: 'Plus is no longer active on this planner', text: NOTICES[kind] || NOTICES.purchase };
}

const CLOSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg>';

/**
 * @param {object} options
 * @param {(modal: Element, focus?: Element) => void} options.openModal   app.js's dialog helpers, so the
 * @param {(modal: Element) => void} options.closeModal                    notice behaves like every other dialog
 * @param {() => Element|null} [options.getActiveModal]                    the notice waits until no dialog is open
 */
export function createPlusCheck({
  openModal = null, closeModal = null, getActiveModal = () => null,
  check = checkPlusLicense, apiOn = plannerApiEnabled, online = () => globalThis.navigator?.onLine !== false,
  now = () => Date.now(), timers = globalThis, doc = globalThis.document
} = {}) {
  let running = null;
  let noticeTimer = 0;

  /**
   * Checks the licence when due: the active one, else the revoked one kept
   * aside. Resolves with 'skipped', 'valid', 'revoked', 'restored' or 'error'.
   */
  function run() {
    if (running) return running;
    const token = plusSettings().plus?.token || '';
    const license = plusLicense();
    const active = hasPlus() && !!token && !!license;
    const held = active ? '' : readPlusCheck().held?.token || '';
    if (!plusCheckDue({ now: now(), lastAt: readPlusCheck().at, apiOn: apiOn(), online: online(), active: active || !!held })) return Promise.resolve('skipped');
    running = (async () => {
      let result = null;
      try { result = await check(active ? token : held); } catch (_) { result = null; }
      const outcome = checkOutcome(result);
      // An error is simply tried again at the next launch or poll; Plus stays as it is.
      if (outcome === 'error') return outcome;
      writePlusCheck({ at: now() });
      // Another licence may have been activated while the server answered.
      if (active && outcome === 'revoked' && (plusSettings().plus?.token || '') === token) {
        writePlusCheck({ notice: license.src || 'purchase' });
        revokePlus(token);
        showNotice();
      }
      // Restored by the owner: Plus comes back, unless another licence gave it meanwhile.
      if (!active && outcome === 'valid' && readPlusCheck().held?.token === held && await restorePlus(held)) {
        writePlusCheck({ notice: 'restored' });
        showNotice();
        return 'restored';
      }
      return outcome;
    })().finally(() => { running = null; });
    return running;
  }

  function noticeModal() {
    let modal = doc.querySelector('[data-plus-revoked-modal]');
    if (modal) return modal;
    modal = doc.createElement('div');
    modal.className = 'modal modal--small';
    modal.hidden = true;
    modal.setAttribute('data-plus-revoked-modal', '');
    modal.innerHTML = `<button class="modal__backdrop" type="button" data-plus-revoked-close aria-label="Close"></button>
      <section class="modal__panel" role="dialog" aria-modal="true" aria-labelledby="plus-revoked-title" aria-describedby="plus-revoked-text">
        <button class="modal__close icon-button" type="button" data-plus-revoked-close aria-label="Close">${CLOSE_ICON}</button>
        <div class="modal__scroll">
          <header class="modal__header">
            <p class="modal__eyebrow" data-plus-revoked-eyebrow></p>
            <h2 id="plus-revoked-title" data-plus-revoked-title></h2>
            <p id="plus-revoked-text" data-plus-revoked-text></p>
          </header>
          <div class="modal__actions"><span></span><div class="modal__actions-right"><button class="primary-button" type="button" data-plus-revoked-close>OK</button></div></div>
        </div>
      </section>`;
    modal.querySelectorAll('[data-plus-revoked-close]').forEach(button => button.addEventListener('click', () => closeModal?.(modal)));
    doc.body.append(modal);
    return modal;
  }

  /** Shows the one-time notice if one is waiting, once no other dialog is open. Returns true when shown. */
  function showNotice() {
    timers.clearTimeout?.(noticeTimer);
    const { notice } = readPlusCheck();
    if (!notice || !openModal || !doc?.body) return false;
    if (getActiveModal()) { noticeTimer = timers.setTimeout(showNotice, NOTICE_RETRY_MS); return false; }
    const modal = noticeModal();
    const words = plusNotice(notice);
    modal.querySelector('[data-plus-revoked-eyebrow]').textContent = words.eyebrow;
    modal.querySelector('[data-plus-revoked-title]').textContent = words.title;
    modal.querySelector('[data-plus-revoked-text]').textContent = words.text;
    writePlusCheck({ notice: '' });
    openModal(modal, modal.querySelector('.modal__actions [data-plus-revoked-close]'));
    return true;
  }

  /** Called once by app.js after the planner is set up. */
  function start() {
    timers.setTimeout(() => { showNotice(); run(); }, PLUS_CHECK_DELAY_MS);
    timers.setInterval(() => run(), PLUS_CHECK_POLL_MS);
    globalThis.addEventListener?.('online', () => run());
    // Another tab found the licence revoked (or restored): follow it here too.
    globalThis.addEventListener?.('storage', event => { if (event.key === PLUS_CHECK_KEY) refreshPlus(); });
    // A licence arriving (activated, synced, restored) is checked when due.
    onPlusChange(active => { if (active) run(); });
  }

  return { run, start, showNotice };
}
