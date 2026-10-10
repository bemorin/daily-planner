import { qs, qsa } from '../lib/dom.js';
import { esc, escAttr } from '../lib/text.js';
import { APP_VERSION, PROJECT_GITHUB_URL } from '../config.js';
import { platformLabel, plannerApiEnabled, sendFeedback, trackEvent } from '../lib/planner-api.js';
import { itemEnter, itemExit } from '../ui/motion.js';

/**
 * Versioned feedback. People can always send feedback from Help or the menu;
 * at most once per version — after the planner has been used for a few days —
 * a small card asks how this version is working. Sending or dismissing it means
 * that version is never asked about again on this device.
 */

const STATE_KEY = 'daily-planner-ui:feedback';
const DAY = 86400000;
const KINDS = [['idea', 'Idea'], ['problem', 'Problem'], ['praise', 'Praise'], ['other', 'Other']];
const STAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3.6 2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8Z"/></svg>';
const RATING_LABELS = ['', 'Not working for me', 'Needs work', 'It’s fine', 'Really useful', 'Love it'];

export function readFeedbackState(storage = globalThis.localStorage) {
  try {
    const raw = JSON.parse(storage?.getItem(STATE_KEY) || '{}');
    return { versions: raw.versions && typeof raw.versions === 'object' ? raw.versions : {}, lastPromptAt: raw.lastPromptAt || '' };
  } catch (_) {
    return { versions: {}, lastPromptAt: '' };
  }
}

function writeFeedbackState(state, storage = globalThis.localStorage) {
  try { storage?.setItem(STATE_KEY, JSON.stringify(state)); } catch (_) {}
}

/**
 * Pure prompt rule (unit-tested): ask about a version at most once, only after
 * five closed days in total and three days on this version, and never more
 * than once a fortnight across versions.
 */
export function shouldPromptFeedback(state, { version, now = new Date(), closeDayCount = 0, enabled = true }) {
  if (!enabled || closeDayCount < 5) return false;
  const entry = state.versions?.[version];
  // Once shown, a version is never asked about again — even if the card was
  // ignored or the page reloaded before it was answered.
  if (!entry?.firstSeen || entry.sent || entry.dismissed || entry.prompted) return false;
  if (now - new Date(entry.firstSeen) < 3 * DAY) return false;
  if (state.lastPromptAt && now - new Date(state.lastPromptAt) < 14 * DAY) return false;
  return true;
}

export function createFeedbackFeature({ openModal, closeModal, openPrivacy = null }) {
  const modal = () => qs('[data-feedback-modal]');
  const root = () => qs('[data-feedback]');
  let draft = { rating: null, kind: 'idea', message: '', email: '' };

  const available = () => plannerApiEnabled() || !!PROJECT_GITHUB_URL;

  function update(mutator) {
    const state = readFeedbackState();
    mutator(state);
    writeFeedbackState(state);
  }

  /** Remember when this version was first used, so prompts wait a few days. */
  function noteVersionSeen(now = new Date()) {
    update(state => {
      state.versions[APP_VERSION] ||= { firstSeen: now.toISOString() };
    });
  }

  function render(error = '') {
    if (!plannerApiEnabled()) {
      root().innerHTML = `<header class="modal__header"><p class="modal__eyebrow">Feedback</p><h2 id="feedback-title">Tell us what to improve.</h2><p>Feedback for this copy of the planner goes through the project page.</p></header>
        <div class="modal__actions"><button class="text-button" type="button" data-feedback-close>Close</button><div class="modal__actions-right"><a class="primary-button" href="${escAttr(PROJECT_GITHUB_URL)}/issues/new" target="_blank" rel="noopener">Open the project page</a></div></div>`;
      return;
    }
    const sentBefore = !!readFeedbackState().versions[APP_VERSION]?.sent;
    root().innerHTML = `<header class="modal__header"><p class="modal__eyebrow">Feedback · version ${esc(APP_VERSION)}</p><h2 id="feedback-title">How is Daily Planner working for you?</h2><p>${sentBefore ? 'Thanks for your earlier note on this version — anything else is welcome.' : 'A rating, a sentence, or both. It goes straight to Ben, grouped by version.'}</p></header>
      <form class="feedback-form" data-feedback-form novalidate>
        <div class="feedback-rating" role="radiogroup" aria-label="Rating">${[1, 2, 3, 4, 5].map(value => `<button type="button" role="radio" aria-checked="${draft.rating === value}" class="${draft.rating >= value ? 'is-on' : ''}" data-feedback-rate="${value}" aria-label="${escAttr(`${value} — ${RATING_LABELS[value]}`)}">${STAR}</button>`).join('')}<span class="feedback-rating__label" data-feedback-rating-label>${draft.rating ? esc(RATING_LABELS[draft.rating]) : 'Tap a star'}</span></div>
        <div class="feedback-kinds" role="radiogroup" aria-label="Type">${KINDS.map(([value, label]) => `<button type="button" role="radio" aria-checked="${draft.kind === value}" class="${draft.kind === value ? 'is-active' : ''}" data-feedback-kind="${value}">${label}</button>`).join('')}</div>
        <label class="form-field"><span>What should we keep, change or fix?</span><textarea name="message" rows="4" maxlength="4000" placeholder="The more concrete, the better.">${esc(draft.message)}</textarea></label>
        <label class="form-field"><span>Email <em>optional — only if you’d like a reply</em></span><input type="email" name="email" maxlength="254" autocomplete="email" value="${escAttr(draft.email)}"></label>
        <input type="text" name="website" tabindex="-1" autocomplete="off" class="sg-honeypot" aria-hidden="true">
        <p class="feedback-meta">Sent with: Daily Planner ${esc(APP_VERSION)} · ${esc(platformLabel())}. Your plans are never included.</p>
        ${error ? `<p class="sg-error" role="alert">${esc(error)}</p>` : ''}
        <div class="modal__actions"><button class="text-button" type="button" data-feedback-close>Cancel</button><div class="modal__actions-right"><button class="primary-button" type="submit" data-feedback-submit>Send feedback</button></div></div>
        ${openPrivacy ? '<p class="privacy-footnote">Only what you send is stored. <button class="privacy-link" type="button" data-feedback-privacy>How this is handled</button></p>' : ''}
      </form>`;
    bind();
  }

  function bind() {
    const el = root();
    qsa('[data-feedback-close]', el).forEach(button => button.addEventListener('click', () => closeModal(modal())));
    qs('[data-feedback-privacy]', el)?.addEventListener('click', () => openPrivacy?.());
    const form = qs('[data-feedback-form]', el);
    if (!form) return;
    const capture = () => { draft.message = form.elements.message.value; draft.email = form.elements.email.value; };
    qsa('[data-feedback-rate]', el).forEach(button => button.addEventListener('click', () => {
      draft.rating = Number(button.dataset.feedbackRate);
      qsa('[data-feedback-rate]', el).forEach(star => {
        const value = Number(star.dataset.feedbackRate);
        star.classList.toggle('is-on', value <= draft.rating);
        star.setAttribute('aria-checked', String(value === draft.rating));
      });
      qs('[data-feedback-rating-label]', el).textContent = RATING_LABELS[draft.rating];
    }));
    qsa('[data-feedback-kind]', el).forEach(button => button.addEventListener('click', () => {
      draft.kind = button.dataset.feedbackKind;
      qsa('[data-feedback-kind]', el).forEach(chip => { const on = chip === button; chip.classList.toggle('is-active', on); chip.setAttribute('aria-checked', String(on)); });
    }));
    form.addEventListener('submit', async event => {
      event.preventDefault();
      capture();
      const submit = qs('[data-feedback-submit]', form);
      submit.disabled = true;
      submit.textContent = 'Sending…';
      const result = await sendFeedback({ rating: draft.rating, kind: draft.kind, message: draft.message, email: draft.email, website: form.elements.website.value });
      if (!result.ok) { render(result.error); return; }
      update(state => { state.versions[APP_VERSION] = { ...(state.versions[APP_VERSION] || {}), sent: new Date().toISOString() }; });
      trackEvent('feedback_sent');
      draft = { rating: null, kind: 'idea', message: '', email: '' };
      root().innerHTML = `<div class="sg-success"><span class="sg-success__mark"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6.5 12.5 3.3 3.3 7.7-8"/></svg></span><h2 id="feedback-title">Thank you.</h2><p>Your note on version ${esc(APP_VERSION)} has been sent. You won’t be asked about this version again.</p><button class="primary-button" type="button" data-feedback-close>Done</button></div>`;
      qs('[data-feedback-close]', root())?.addEventListener('click', () => closeModal(modal()));
    });
  }

  function open(rating = null) {
    if (rating) draft.rating = rating;
    render();
    // A rating that came from the card moves focus to the message; otherwise to the stars.
    openModal(modal(), qs(rating ? 'textarea' : '[data-feedback-rate]', root()));
    trackEvent('feedback_opened');
    dismissPromptCard(false);
  }

  function dismissPromptCard(markDismissed = true) {
    const card = qs('[data-feedback-card]');
    if (!card) return;
    if (markDismissed) update(state => { state.versions[APP_VERSION] = { ...(state.versions[APP_VERSION] || {}), dismissed: new Date().toISOString() }; });
    itemExit(card).then(() => card.remove());
  }

  /** Show the small "how's this version?" card when the rule allows it. */
  function maybePrompt({ closeDayCount = 0, now = new Date() } = {}) {
    const state = readFeedbackState();
    if (!shouldPromptFeedback(state, { version: APP_VERSION, now, closeDayCount, enabled: plannerApiEnabled() })) return false;
    if (qs('[data-feedback-card]') || document.querySelector('.modal.is-open')) return false;
    update(next => {
      next.lastPromptAt = now.toISOString();
      next.versions[APP_VERSION] = { ...(next.versions[APP_VERSION] || {}), prompted: now.toISOString() };
    });
    const card = document.createElement('aside');
    card.className = 'feedback-card';
    card.dataset.feedbackCard = '';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Rate this version');
    card.innerHTML = `<button type="button" class="feedback-card__close" data-feedback-card-close aria-label="Not now"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg></button>
      <small>Daily Planner ${esc(APP_VERSION)}</small><strong>How is this version working for you?</strong>
      <div class="feedback-card__stars">${[1, 2, 3, 4, 5].map(value => `<button type="button" data-feedback-card-rate="${value}" aria-label="${escAttr(`${value} — ${RATING_LABELS[value]}`)}">${STAR}</button>`).join('')}</div>
      <button type="button" class="text-button feedback-card__later" data-feedback-card-close>Not now</button>`;
    document.body.append(card);
    qsa('[data-feedback-card-close]', card).forEach(button => button.addEventListener('click', () => dismissPromptCard(true)));
    qsa('[data-feedback-card-rate]', card).forEach(button => button.addEventListener('click', () => open(Number(button.dataset.feedbackCardRate))));
    itemEnter(card);
    trackEvent('feedback_prompt_shown');
    return true;
  }

  return { open, available, maybePrompt, noteVersionSeen };
}
