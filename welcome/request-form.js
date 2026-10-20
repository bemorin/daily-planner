// Imported as a namespace so a value missing from an older config.js reads as
// undefined instead of failing the whole module.
import * as config from '../src/config.js';
import { plannerApiEnabled, referralCode } from '../src/lib/planner-api.js';
import { TEAM_TIERS } from '../src/lib/pricing.js';
import { animate } from '../src/vendor/motion.js';
import { TEAM_ROWS, defaultPlan, planForPeople, planRow, tierLabel, tierPrice } from './landing-model.js';
import { createListbox } from './listbox.js';
import { EMAIL_RE, el, qs, qsa } from './page-kit.js';
import { EASE_OUT, reduceQuery } from './page-motion.js';
import { createStepper } from './stepper.js';
import { KINDS, PARTNER_QUESTION, PEOPLE_RANGE, TIMING_LABELS, requestFromAddress, requestPayload } from './teams-model.js';

/* ============================================================================
   The request form “Invoice, quote or question” (#request, on the Teams page):
   an invoice for a team gift, a quote, a question about the planner, Plus or
   the team gift — or about the partner program (?ask=question&topic=partners).

   Links anywhere open it with the right kind: `[data-request="invoice|quote|
   question|talk"]` (and `data-plan`) on this page, `?ask=…&plan=…` from other
   pages (…/welcome/teams/?ask=question#request). Sent to the owner API
   (POST /api/teams), with the partner code this browser remembers (`ref`),
   so a team gift a partner introduced can earn them their share. Without the
   API, it becomes an email to LANDING.contactEmail; without that either, it
   stays visible but cannot be sent.
   ============================================================================ */

const PLANNER_API_URL = typeof config.PLANNER_API_URL === 'string' ? config.PLANNER_API_URL : '';
const APP_VERSION = typeof config.APP_VERSION === 'string' ? config.APP_VERSION : '';

const PEOPLE_MIN = PEOPLE_RANGE.min;
const PEOPLE_MAX = PEOPLE_RANGE.max;
// One-click choices under "Number of people".
const PEOPLE_CHOICES = [10, 25, 50, 100, 500, 1000];

function readForm(form, kind) {
  const data = new FormData(form);
  const text = name => String(data.get(name) || '').trim();
  return {
    email: text('email'),
    name: text('name'),
    company: text('company'),
    plan: text('plan'),
    teamSize: text('teamSize'),
    timing: text('timing'),
    message: text('message'),
    consent: data.get('consent') === 'on',
    website: String(data.get('website') || ''),
    kind
  };
}

// A dropdown's value sits in a hidden input; errors and focus go to its button.
function fieldNode(form, name) {
  const node = qs(`[name="${name}"]`, form);
  return node?.type === 'hidden' ? qs('.lb__trigger', node.closest('.lb')) || node : node;
}

function setError(field, message) {
  const ids = (field.getAttribute('aria-describedby') || '').split(/\s+/);
  const box = ids.map(id => document.getElementById(id)).find(node => node?.classList.contains('field__err'));
  field.setAttribute('aria-invalid', message ? 'true' : 'false');
  if (box) box.textContent = message;
}

function validate(form, values, requestMode) {
  const count = Number(values.teamSize);
  const asking = values.kind === 'question' || values.kind === 'talk';
  const checks = [
    ['email', !values.email ? 'Enter your work email.' : (!EMAIL_RE.test(values.email) || values.email.length > 254 ? 'Enter an email address like name@company.com.' : '')],
    ['name', !values.name ? 'Enter your name.' : (values.name.length > 80 ? 'Keep your name under 80 characters.' : '')],
    ['company', !values.company ? 'Enter your company.' : (values.company.length > 120 ? 'Keep the company name under 120 characters.' : '')],
    ['plan', planRow(values.plan) ? '' : 'Choose a plan.'],
    ['teamSize', /^\d+$/.test(values.teamSize) && count >= PEOPLE_MIN && count <= PEOPLE_MAX ? '' : 'Enter the number of people, from 2 to 100,000.'],
    ['message', values.message.length > 1000 ? 'Keep the message under 1,000 characters.' : (asking && !values.message ? 'Write your question.' : '')],
    ['consent', requestMode !== 'api' || values.consent ? '' : 'Tick this box so we can reply to you.']
  ];
  let first = null;
  checks.forEach(([name, message]) => {
    const field = fieldNode(form, name);
    if (!field) return;
    setError(field, message);
    if (message && !first) first = field;
  });
  if (!TIMING_LABELS[values.timing]) values.timing = 'december-2026';
  return first;
}

async function sendRequest(values, currency) {
  const payload = requestPayload(values, { currency, version: APP_VERSION, locale: navigator.language || '', ref: referralCode() });
  try {
    const response = await fetch(`${PLANNER_API_URL}/teams`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok && data.ok !== false) return { ok: true };
    return { ok: false, error: data.error || 'The request could not be sent. Check the form and try again.' };
  } catch (_) {
    return { ok: false, error: navigator.onLine === false ? 'You’re offline. Send the request again once you’re connected.' : 'The server couldn’t be reached. Try again in a moment.' };
  }
}

/**
 * Wires the form. Returns { open({ kind, plan }), renderPlanOptions() }, or
 * null when the page has no form.
 *
 * @param {object} options
 * @param {{ currency: string, money: (value: number) => string }} options.sale
 * @param {(name: string) => void} options.track
 * @param {{ contactEmail: string, replyDelay: string, talk: { enabled: boolean } }} options.settings
 */
export function createRequestForm({ sale, track = () => {}, settings }) {
  const panel = qs('[data-form-panel]');
  const form = qs('[data-team-form]');
  if (!panel || !form) return null;

  const talkOn = !!settings.talk?.enabled;
  const requestMode = plannerApiEnabled() ? 'api' : (EMAIL_RE.test(settings.contactEmail || '') ? 'mailto' : 'off');
  const request = { kind: 'invoice', topic: '', opened: false, quoted: false };
  const smoothBehavior = () => (reduceQuery.matches ? 'auto' : 'smooth');

  const field = name => qs(`[name="${name}"]`, form);
  const title = qs('[data-form-title]', form);
  const intro = qs('[data-form-intro]', form);
  const submit = qs('[data-form-submit]', form);
  const errorBox = qs('[data-form-error]', form);
  const counter = qs('[data-message-count]', form);
  const messageLabel = qs('[data-message-label]', form);
  const kindGroup = qs('[data-kind-group]', form);
  const kindNote = qs('[data-kind-note]', form);
  const done = qs('[data-form-done]', panel);
  const doneText = qs('[data-form-done-text]', panel);
  const size = field('teamSize');

  if (talkOn && kindGroup && !qs('input[value="talk"]', kindGroup)) {
    kindGroup.append(el('label', {}, el('input', { type: 'radio', name: 'kind', value: 'talk' }), el('span', {}, KINDS.talk.label)));
  }

  const planOptions = () => TEAM_ROWS.map(row => {
    const price = tierPrice(row, sale.currency);
    return { value: row.plan, label: tierLabel(row), hint: price == null ? 'On quote' : sale.money(price) };
  });

  // The app's own dropdowns and number stepper, instead of the browser's.
  const plan = createListbox(qs('[data-listbox="plan"]', form), { options: planOptions(), value: defaultPlan(), onChange: chosen => planChosen(chosen) });
  createListbox(qs('[data-listbox="timing"]', form), { options: Object.entries(TIMING_LABELS).map(([value, label]) => ({ value, label })), value: 'december-2026' });
  const people = createStepper(size, { min: PEOPLE_MIN, max: PEOPLE_MAX, quick: PEOPLE_CHOICES, noun: 'people', onChange: count => peopleChanged(count) });

  if (requestMode === 'api') {
    qs('[data-privacy-line]', form).hidden = false;
  } else {
    qs('[data-consent-row]', form).hidden = true;
    field('consent').required = false;
  }
  if (requestMode === 'off') {
    submit.disabled = true;
    submit.setAttribute('aria-describedby', 'form-off');
    const off = qs('[data-form-off]', form);
    off.id = 'form-off';
    off.hidden = false;
  } else {
    submit.disabled = false;
  }

  // The plan and the number of people stay in step: the plan is always the
  // smallest one that fits the number (planForPeople), and choosing a plan
  // fills in its number unless the number typed already fits it.
  function fillPeople(row) {
    people.set(row?.seats || '');
    size.placeholder = row?.seats ? 'e.g. 40' : `More than ${new Intl.NumberFormat('en-US').format(Math.max(...TEAM_TIERS.map(tier => tier.seats)))}`;
    setError(size, '');
  }

  function setPlan(value, prefill) {
    const row = planRow(value);
    if (!row) return;
    plan.setValue(value);
    if (prefill) fillPeople(row);
  }

  function planChosen(value) {
    const count = people.value;
    if (count == null || planForPeople(count) !== value) fillPeople(planRow(value));
    applyKind();
  }

  function peopleChanged(count) {
    if (count == null || count < PEOPLE_MIN) return;
    const next = planForPeople(count);
    if (next && next !== plan.value) plan.setValue(next);
    applyKind();
  }

  // An invoice needs a price; a tier without one is quoted.
  function matchKindToPlan() {
    const priced = tierPrice(planRow(plan.value), sale.currency) != null;
    request.quoted = request.kind === 'invoice' && !priced;
    if (request.quoted) setKind('quote', false);
  }

  // "Pay by invoice" chosen while the plan is on quote: move to the priced
  // tier that fits the number of people, if there is one.
  function pricePlanForInvoice() {
    if (tierPrice(planRow(plan.value), sale.currency) != null) return;
    const count = people.value;
    const fit = TEAM_TIERS.find(tier => !count || count <= tier.seats);
    if (fit) plan.setValue(fit.plan);
  }

  function setKind(kind, apply = true) {
    request.kind = KINDS[kind] && (kind !== 'talk' || talkOn) ? kind : 'invoice';
    qsa('input[name="kind"]', form).forEach(input => { input.checked = input.value === request.kind; });
    if (apply) applyKind();
  }

  function applyKind() {
    matchKindToPlan();
    const copy = request.kind === 'question' && request.topic === 'partners' ? { ...KINDS.question, ...PARTNER_QUESTION } : KINDS[request.kind];
    title.textContent = copy.title;
    intro.textContent = requestMode === 'mailto' ? 'Fill this in and your email app will open with the request, ready to send.' : copy.intro;
    // Below the choice, so the buttons never move under the pointer.
    kindNote.textContent = request.quoted ? `${tierLabel(planRow(plan.value))}: it starts with a quote, and the invoice follows.` : '';
    kindNote.hidden = !request.quoted;
    submit.textContent = requestMode === 'mailto' ? 'Write the request email' : copy.submit;
    const asking = request.kind === 'question' || request.kind === 'talk';
    messageLabel.replaceChildren(asking ? 'Your question' : 'Anything else? ', asking ? '' : el('em', {}, 'Optional'));
    field('message').required = asking;
  }

  function showForm() {
    form.hidden = false;
    done.hidden = true;
    errorBox.hidden = true;
  }

  function noteOpened() {
    if (request.opened) return;
    request.opened = true;
    track('team_form_opened');
  }

  function open({ kind, plan: chosen }) {
    // Any other request from the page's own links is no longer about the partner program.
    request.topic = '';
    showForm();
    setKind(kind || request.kind, false);
    if (chosen) setPlan(chosen, true);
    else if (!size.value) setPlan(plan.value || defaultPlan(), true);
    applyKind();
    noteOpened();
    panel.scrollIntoView({ block: 'start', behavior: smoothBehavior() });
    title.focus({ preventScroll: true });
    if (!reduceQuery.matches) {
      try { animate(title, { opacity: [0.35, 1] }, { duration: 0.5, ease: EASE_OUT }).finished.then(() => title.style.removeProperty('opacity'), () => {}); } catch (_) { /* static is fine */ }
    }
  }

  document.addEventListener('click', event => {
    const trigger = event.target.closest('[data-request]');
    if (!trigger) return;
    event.preventDefault();
    open({ kind: trigger.dataset.request, plan: trigger.dataset.plan });
  });

  form.addEventListener('focusin', noteOpened);
  form.addEventListener('change', event => {
    if (event.target.name !== 'kind') return;
    if (event.target.value === 'invoice') pricePlanForInvoice();
    setKind(event.target.value);
  });

  // Typing: the plan follows as soon as the number makes sense.
  size.addEventListener('input', () => {
    const typed = size.value.trim();
    if (/^\d+$/.test(typed) && Number(typed) >= PEOPLE_MIN) peopleChanged(Math.min(Number(typed), PEOPLE_MAX));
  });

  const updateCount = () => { counter.textContent = `${field('message').value.length}/1000`; };
  field('message').addEventListener('input', updateCount);

  form.addEventListener('input', event => {
    if (event.target.getAttribute('aria-invalid') === 'true') setError(event.target, '');
  });

  qs('[data-form-again]', panel)?.addEventListener('click', () => {
    field('message').value = '';
    updateCount();
    showForm();
    title.focus({ preventScroll: true });
  });

  // Arriving from a link such as …/teams/?ask=quote&plan=over-1000#request.
  const asked = requestFromAddress(location.search, { talk: talkOn });
  setPlan(asked.plan || defaultPlan(), true);
  setKind(asked.kind || 'invoice');
  // “Become a partner” on the partners page, before the Creem sign-up link is set: a question about the program.
  if (asked.topic === 'partners') {
    request.topic = 'partners';
    if (!field('message').value) field('message').value = PARTNER_QUESTION.message;
    updateCount();
    applyKind();
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (requestMode === 'off') return;
    errorBox.hidden = true;
    peopleChanged(people.value);
    applyKind();
    const values = readForm(form, request.kind);
    const invalid = validate(form, values, requestMode);
    if (invalid) { invalid.focus(); return; }

    if (requestMode === 'mailto') {
      const tier = planRow(values.plan);
      const price = tierPrice(tier, sale.currency);
      const lines = [
        `Request: ${KINDS[values.kind].label}`,
        `Plan: Team gift, ${tierLabel(tier).toLowerCase()} (${price == null ? 'on quote' : sale.money(price)})`,
        `Number of people: ${values.teamSize}`,
        `Timing: ${TIMING_LABELS[values.timing]}`,
        `Company: ${values.company}`,
        `Name: ${values.name}`,
        `Email: ${values.email}`
      ];
      const ref = referralCode();
      if (ref) lines.push(`Partner code: ${ref}`);
      if (values.message) lines.push('', values.message);
      const subject = `Daily Planner team gift — ${KINDS[values.kind].label}: ${values.company}`;
      location.href = `mailto:${settings.contactEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join('\r\n'))}`;
      showDone(`Your email app should open with the request, ready to send. If it doesn’t, write to ${settings.contactEmail}.`);
      return;
    }

    submit.disabled = true;
    const label = submit.textContent;
    submit.textContent = 'Sending…';
    const result = await sendRequest(values, sale.currency);
    submit.disabled = false;
    submit.textContent = label;
    if (result.ok) {
      track('team_request_sent');
      const delay = settings.replyDelay ? ` ${settings.replyDelay}` : '';
      showDone(`${KINDS[values.kind].done}${delay}.`);
    } else {
      errorBox.textContent = result.error;
      errorBox.hidden = false;
    }
  });

  function showDone(text) {
    doneText.textContent = text;
    form.hidden = true;
    done.hidden = false;
    done.focus();
  }

  return {
    open,
    /** The plan dropdown's prices follow the currency. */
    renderPlanOptions: () => plan.setOptions(planOptions(), defaultPlan())
  };
}
