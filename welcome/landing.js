// Imported as a namespace so a value missing from an older config.js reads as
// undefined instead of failing the whole module.
import * as config from '../src/config.js';
import { trackEvent, plannerApiEnabled, checkoutOptions, startCheckout } from '../src/lib/planner-api.js';
import { animate } from '../src/vendor/motion.js';
import { CURRENCIES, PLUS_PRICE, PLUS_FEATURES, PLUS_UPCOMING, TEAM_TIERS, detectCurrency, formatMoney } from '../src/lib/pricing.js';
import { TEAM_ROWS, buyState, checkoutUrl, defaultPlan, lowestPerPerson, perPerson, planForPeople, planRow, readCheckoutOptions, rememberCurrency, statusTone, storedCurrency, tierLabel, tierPrice } from './landing-model.js';

/* ============================================================================
   LANDING — copy the owner may want to change without touching markup.
   Prices, what Plus adds and what it promises next live in
   src/lib/pricing.js (shared with the planner and the server, which charges
   exactly those amounts). Online checkout is Creem, through the owner API:
   GET /api/checkout says what can be bought in which currency.

   PROPOSALS TO CONFIRM BEFORE PUBLISHING (owner decision pending):
   - `pricingNote` (check the tax line with your accountant);
   - `replyDelay` (left blank on purpose: no response time is promised).
   ============================================================================ */
const LANDING = {
  pricingNote: 'One-time payments. Prices include tax. Receipts and invoices come from Creem, our payment partner.',
  // Optional add-on, shown under the team prices (and as a request type) when
  // enabled. Off: no workshops, travel or live sessions are sold for now.
  talk: { enabled: false, label: 'A remote talk by Ben (45 minutes)', price: 'On quote' },
  // When PLANNER_API_URL is blank, requests become an email to this address.
  // Left blank too, the form stays visible but cannot be sent.
  contactEmail: '',
  // Optional promise shown after a request, e.g. 'within two working days'.
  replyDelay: '',
  landingUrl: 'https://planner.bemorin.com/welcome/#teams',
  // "Send this to my manager": the same text feeds the mailto link and the
  // Copy message button. {url} becomes landingUrl; {perPerson} the lowest
  // price per person in the visitor's currency.
  managerEmail: {
    subject: 'An idea for our year-end gift',
    body: [
      'Hi,',
      '',
      'For our year-end gift, I’d like to suggest Daily Planner Plus for everyone. Instead of another object, each person gets a calm planner for their days and their year, with a guided session to plan the year ahead and a one-page review of the year.',
      '',
      'It’s simple to give: we get one link to forward, and each person who opens it activates Plus on their own planner. There’s nothing to install, no accounts to create and no names collected, and each person’s planner stays private: the company never sees it.',
      '',
      'It’s a one-time price for the company, from about {perPerson} per person, with an invoice and no subscription.',
      '',
      'Details and prices: {url}',
      '',
      'Worth a look?'
    ].join('\n')
  }
};

const PLANNER_API_URL = typeof config.PLANNER_API_URL === 'string' ? config.PLANNER_API_URL : '';
const APP_VERSION = typeof config.APP_VERSION === 'string' ? config.APP_VERSION : '';
const configUrl = key => (typeof config[key] === 'string' ? config[key].trim() : '');

const TIMING_LABELS = {
  'december-2026': 'Before the holidays (December 2026)',
  'january-2027': 'January 2027',
  'q1-2027': 'Later in Q1 2027',
  later: 'Later'
};

const KINDS = {
  invoice: { label: 'Invoice', title: 'Get it by invoice', intro: 'Tell us where to send the invoice. You’ll get it by email, then the gift link once it’s paid.', submit: 'Request the invoice', done: 'Thanks, your request is in. The invoice will follow by email' },
  quote: { label: 'Quote', title: 'Ask for a quote', intro: 'Tell us about your organisation, and you’ll get a quote by email.', submit: 'Ask for a quote', done: 'Thanks, your request is in. The quote will follow by email' },
  question: { label: 'Question', title: 'Ask a question', intro: 'Ask anything about the planner, Plus or the team gift. You’ll get a reply by email.', submit: 'Send the question', done: 'Thanks, your question is in. You’ll get a reply by email' },
  talk: { label: 'Remote talk', title: 'Ask about the talk', intro: 'Tell us about your team and when a remote talk would help. You’ll get a reply by email.', submit: 'Send the request', done: 'Thanks, your message is in. You’ll get a reply by email' }
};

const qs = (selector, root = document) => root.querySelector(selector);
const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];
const html = document.documentElement;
const apiOn = plannerApiEnabled();
const track = name => { if (apiOn) trackEvent(name); };
const reduceQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
const smoothBehavior = () => (reduceQuery.matches ? 'auto' : 'smooth');
const EASE_OUT = [0.22, 1, 0.36, 1];

// Same rule as the server: a plain domain (letters, digits, dots, hyphens).
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"?&=%/#]{1,64}@[a-z0-9](?:[a-z0-9.-]{0,188}[a-z0-9])?\.[a-z]{2,24}$/i;
const httpsUrl = value => (typeof value === 'string' && /^https:\/\/[^\s"'<>]+$/.test(value.trim()) ? value.trim() : '');

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([key, value]) => {
    if (value === false || value == null) return;
    if (key === 'class') node.className = value;
    else if (key === 'style') node.style.cssText = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  });
  children.flat().forEach(child => { if (child != null) node.append(child instanceof Node ? child : String(child)); });
  return node;
}

/* Currency: euro area pays in EUR, everyone else in USD ------------------- */

let currency = storedCurrency() || detectCurrency();
const money = value => formatMoney(value, currency);

/* What can be bought online: asked once, when prices come near ------------ */

const sale = { options: readCheckoutOptions(null), pending: null };

function loadSaleOptions() {
  if (!apiOn) return Promise.resolve(sale.options);
  if (sale.options.known) return Promise.resolve(sale.options);
  if (!sale.pending) {
    sale.pending = checkoutOptions().then(result => {
      sale.options = readCheckoutOptions(result);
      sale.pending = null;
      renderOffers();
      return sale.options;
    });
  }
  return sale.pending;
}

const saleFor = item => buyState({ apiOn, options: sale.options, item, currency });

/* Offer: Plus, team tiers, talk -------------------------------------------- */

function renderPlusLists() {
  qsa('[data-plus-features]').forEach(list => {
    list.replaceChildren(...PLUS_FEATURES.map(feature => el('li', {}, feature.title)));
  });
  // The promise: what Plus gets next, at no extra cost, with its status. A
  // list in the Plus card of the prices; four columns (with headings) in the
  // Plus section.
  qsa('[data-plus-upcoming]').forEach(list => {
    const detailed = list.hasAttribute('data-detailed');
    list.replaceChildren(...PLUS_UPCOMING.map(next => el('li', { class: 'soon__item' },
      el('span', { class: 'soon__mark', 'aria-hidden': 'true' }),
      el('div', { class: 'soon__body' },
        el('div', { class: 'soon__top' },
          el(detailed ? 'h4' : 'b', { class: 'soon__name' }, next.title),
          el('span', { class: `chip chip--${statusTone(next.status)}` }, el('span', { class: 'sr-only' }, 'Status: '), next.status)),
        el('span', { class: 'soon__text' }, next.text)))));
  });
  qsa('[data-faq-upcoming]').forEach(node => { node.textContent = upcomingSentence(); });
}

const listText = items => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : items[0] || '');

/** "Planned: “A” and “B”. Exploring: “C”." for the FAQ, from PLUS_UPCOMING. */
function upcomingSentence() {
  const groups = new Map();
  PLUS_UPCOMING.forEach(next => {
    const status = next.status || 'Coming';
    groups.set(status, [...(groups.get(status) || []), `“${next.title}”`]);
  });
  return [...groups].map(([status, titles]) => `${status}: ${listText(titles)}.`).join(' ');
}

function plusCta(box) {
  const state = saleFor('plus');
  const children = [];
  if (state.buyable) {
    children.push(el('button', { class: 'btn btn--primary btn--buy', type: 'button', 'data-buy': 'plus' }, 'Buy Plus'));
  } else {
    const id = `plus-note-${box.dataset.plusCta || 'x'}`;
    children.push(el('button', { class: 'btn btn--primary btn--buy', type: 'button', disabled: true, 'aria-describedby': id }, 'Coming soon'));
    children.push(state.reason === 'currency'
      ? el('p', { class: 'buy__note', id }, `Not on sale in ${currency} yet. `, el('button', { class: 'linklike', type: 'button', 'data-cur-switch': state.other }, `Show prices in ${state.other}`))
      : el('p', { class: 'buy__note', id }, 'Plus isn’t on sale here yet. Everything else is free: ', el('a', { href: '../', 'data-cta': 'app' }, 'open the planner'), '.'));
  }
  children.push(el('p', { class: 'buy__error', role: 'alert', 'data-buy-error': true, hidden: true }));
  box.replaceChildren(...children);
}

function renderPlus() {
  const price = PLUS_PRICE[currency];
  qsa('[data-plus-price]').forEach(node => { node.textContent = Number.isFinite(price) ? money(price) : ''; });
  qsa('[data-free-price]').forEach(node => { node.textContent = money(0); });
  qsa('[data-plus-cta]').forEach(plusCta);
}

function renderTalk() {
  const talk = qs('[data-talk]');
  if (!talk) return;
  if (!LANDING.talk?.enabled) {
    talk.hidden = true;
    return;
  }
  talk.replaceChildren(
    el('span', { class: 'talk__what' }, el('b', {}, 'Add-on'), LANDING.talk.label),
    el('span', { class: 'talk__price' }, LANDING.talk.price),
    el('a', { class: 'tier__link', href: '#request', 'data-request': 'talk' }, 'Ask about the talk'));
  talk.hidden = false;
}

function renderTiers() {
  const box = qs('[data-tiers]');
  if (!box) return;
  const state = saleFor('gift');
  const rows = TEAM_ROWS.map(row => {
    const price = tierPrice(row, currency);
    const named = tierLabel(row).toLowerCase();
    const quote = price == null;
    const look = `btn btn--tier ${row.highlight ? 'btn--primary' : 'btn--ghost'}`;
    const actions = [];
    if (quote) {
      actions.push(el('a', { class: look, href: '#request', 'data-request': 'quote', 'data-plan': row.plan, 'aria-label': `Ask for a quote for ${named}` }, 'Ask for a quote'));
    } else if (state.buyable) {
      actions.push(el('button', { class: look, type: 'button', 'data-buy': 'gift', 'data-plan': row.plan, 'aria-label': `Buy the team gift for ${named}, ${money(price)}` }, 'Buy'));
      actions.push(el('a', { class: 'tier__link', href: '#request', 'data-request': 'invoice', 'data-plan': row.plan, 'aria-label': `Get the team gift for ${named} by invoice` }, 'Invoice'));
    } else {
      actions.push(el('a', { class: look, href: '#request', 'data-request': 'invoice', 'data-plan': row.plan, 'aria-label': `Get the team gift for ${named} by invoice` }, 'Get it by invoice'));
    }
    return el('div', { class: `tier${row.highlight ? ' is-highlight' : ''}${quote ? ' tier--quote' : ''}` },
      el('div', { class: 'tier__who' },
        el('b', {}, tierLabel(row), row.badge ? el('span', { class: 'tier__badge' }, row.badge) : null),
        el('small', {}, quote ? (row.note || '') : `${perPerson(row, currency)} per person`)),
      el('div', { class: 'tier__price' }, quote ? 'On quote' : money(price)),
      el('div', { class: 'tier__act' }, actions),
      el('p', { class: 'buy__error tier__error', role: 'alert', 'data-buy-error': true, hidden: true }));
  });
  box.replaceChildren(...rows);
  const after = qs('[data-gift-after]');
  if (after) {
    after.replaceChildren(...(state.buyable
      ? [el('b', {}, 'Right after paying, you land on your gift page'), ' with the link to forward, the seats used and the message your team sees. Its link also arrives by email.']
      : [el('b', {}, 'Once the invoice is paid,'), ' you get your gift page by email: a private page with the gift link to forward, the seats used and the message your team sees.']));
  }
}

function renderCurrencyCopy() {
  qsa('[data-min-per-person]').forEach(node => { node.textContent = lowestPerPerson(currency); });
  const pay = qs('[data-faq-pay]');
  if (pay) {
    pay.textContent = saleFor('gift').buyable
      ? 'Yes, or by card. “Buy” opens a secure checkout run by Creem, our payment partner; you land on your gift page as soon as it’s paid, and its link arrives by email. “Invoice” sends a request instead: you receive an invoice to pay by bank transfer, then the gift link once it’s paid. Either way it’s one payment, with no subscription.'
      : 'Yes. Choose a team size and send the request: you’ll receive an invoice to pay by bank transfer, then the gift link once it’s paid. It’s one payment, with no subscription.';
  }
}

function renderOffers() {
  qsa('[data-cur]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.cur === currency)));
  renderPlus();
  renderTiers();
  renderCurrencyCopy();
  renderPlanOptions();
  updateManagerLink();
}

function setCurrency(next, { animated = false } = {}) {
  if (!CURRENCIES.includes(next) || next === currency) return;
  currency = next;
  rememberCurrency(currency);
  renderOffers();
  if (animated && !reduceQuery.matches) {
    qsa('.tier__price, .tier__who small, .offer__price, .plus-buy__price b').forEach((node, index) => {
      try { animate(node, { opacity: [0, 1], transform: ['translateY(5px)', 'none'] }, { duration: 0.32, delay: (index % 6) * 0.025, ease: EASE_OUT }); } catch (_) { /* static is fine */ }
    });
  }
}

function setupOffers() {
  const group = qs('[data-currency]');
  const note = qs('[data-pricing-note]');
  if (note) note.textContent = LANDING.pricingNote;
  renderTalk();
  renderPlusLists();
  if (group) {
    group.hidden = false;
    group.addEventListener('click', event => {
      const button = event.target.closest('[data-cur]');
      if (button) setCurrency(button.dataset.cur, { animated: true });
    });
  }
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-cur-switch]');
    if (button) setCurrency(button.dataset.curSwitch, { animated: true });
  });
  renderOffers();

  // Ask what's on sale once, a little before the prices come into view.
  const near = [qs('#pricing'), qs('.plus-buy')].filter(Boolean);
  if (apiOn && near.length && 'IntersectionObserver' in window) {
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      loadSaleOptions();
    }, { rootMargin: '900px 0px' });
    near.forEach(node => observer.observe(node));
  }
}

/* Buy: Plus or a team gift, through the owner API's Creem checkout -------- */

function buyError(button, text) {
  const box = button.closest('[data-plus-cta], .tier');
  const error = box && qs('[data-buy-error]', box);
  if (!error) return;
  error.textContent = text;
  error.hidden = !text;
}

function setBusy(button, busy) {
  if (busy) {
    button.dataset.label = button.textContent;
    button.textContent = button.dataset.buy === 'plus' ? 'Opening checkout…' : 'Opening…';
  } else if (button.dataset.label) {
    button.textContent = button.dataset.label;
  }
  button.disabled = busy;
  button.classList.toggle('is-busy', busy);
  button.setAttribute('aria-busy', String(busy));
}

let openRequest = () => {};

async function buy(button) {
  const item = button.dataset.buy;
  const plan = button.dataset.plan || '';
  if (item === 'plus') track('plus_checkout_clicked');
  else track('pack_checkout_clicked');
  buyError(button, '');
  setBusy(button, true);
  await loadSaleOptions();
  const state = saleFor(item);
  if (!state.buyable) {
    // On sale nowhere (or not in this currency) after all: show the honest
    // state, and for a team gift go on with the invoice request.
    setBusy(button, false);
    renderOffers();
    if (item === 'gift') openRequest({ kind: 'invoice', plan });
    return;
  }
  const result = await startCheckout({ item, plan, currency });
  const url = result.ok ? checkoutUrl(result.url) : '';
  if (url) {
    // The button stays busy while the browser leaves for the checkout.
    location.assign(url);
    return;
  }
  setBusy(button, false);
  buyError(button, result.error || 'The checkout could not be opened. Please try again in a minute.');
}

function setupBuy() {
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-buy]');
    if (!button || button.disabled) return;
    event.preventDefault();
    buy(button);
  });
  // Back from the checkout page (back/forward cache): buttons work again.
  window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    qsa('[data-buy].is-busy').forEach(button => setBusy(button, false));
  });
}

/* Footer: privacy notice and configured links ----------------------------- */

function renderFooter() {
  if (apiOn) qsa('[data-privacy]').forEach(node => { node.hidden = false; });
  const social = qs('[data-social]');
  const links = [['PROJECT_GITHUB_URL', 'GitHub'], ['SOCIAL_X_URL', 'X'], ['SOCIAL_LINKEDIN_URL', 'LinkedIn']]
    .map(([key, label]) => [httpsUrl(configUrl(key)), label])
    .filter(([url]) => url)
    .map(([url, label]) => el('a', { href: url, rel: 'noopener' }, label));
  if (social && links.length) {
    social.replaceChildren(...links);
    social.hidden = false;
  }
}

/* Send this to my manager ------------------------------------------------- */

const managerBody = () => LANDING.managerEmail.body.replaceAll('{url}', LANDING.landingUrl).replaceAll('{perPerson}', lowestPerPerson(currency));

function updateManagerLink() {
  const link = qs('[data-manager-mail]');
  if (!link) return;
  const body = managerBody().replace(/\n/g, '\r\n');
  link.href = `mailto:?subject=${encodeURIComponent(LANDING.managerEmail.subject)}&body=${encodeURIComponent(body)}`;
}

function setupManagerEmail() {
  const link = qs('[data-manager-mail]');
  const copy = qs('[data-manager-copy]');
  const status = qs('[data-copy-status]');
  updateManagerLink();
  link?.addEventListener('click', () => track('manager_email_opened'));
  copy?.addEventListener('click', async () => {
    const ok = await copyText(`Subject: ${LANDING.managerEmail.subject}\n\n${managerBody()}`);
    if (status) status.textContent = ok ? 'Message copied. Paste it into an email or a chat with your manager.' : 'Copy didn’t work here. Use “Send this to my manager” instead.';
    if (ok) track('manager_email_opened');
  });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    const area = el('textarea', { readonly: true, style: 'position:fixed;top:0;left:0;opacity:0' });
    area.value = text;
    document.body.append(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
    area.remove();
    return ok;
  }
}

/* Requests: invoice, quote or question ------------------------------------ */

const requestMode = apiOn ? 'api' : (EMAIL_RE.test(LANDING.contactEmail || '') ? 'mailto' : 'off');
const request = { kind: 'invoice', peopleTouched: false, opened: false, quoted: false };

function renderPlanOptions() {
  const select = qs('[data-plan-select]');
  if (!select) return;
  const current = select.value || defaultPlan();
  select.replaceChildren(...TEAM_ROWS.map(row => {
    const price = tierPrice(row, currency);
    return el('option', { value: row.plan }, `${tierLabel(row)} · ${price == null ? 'on quote' : money(price)}`);
  }));
  select.value = planRow(current) ? current : defaultPlan();
}

function setupRequest() {
  const panel = qs('[data-form-panel]');
  const form = qs('[data-team-form]');
  if (!panel || !form) return;

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
  const select = field('plan');
  const size = field('teamSize');

  if (LANDING.talk?.enabled && kindGroup && !qs('input[value="talk"]', kindGroup)) {
    kindGroup.append(el('label', {}, el('input', { type: 'radio', name: 'kind', value: 'talk' }), el('span', {}, KINDS.talk.label)));
  }

  renderPlanOptions();

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

  function setPlan(plan, prefill) {
    if (!planRow(plan)) return;
    select.value = plan;
    if (prefill) {
      const row = planRow(plan);
      size.value = row.seats ? String(row.seats) : '';
      request.peopleTouched = false;
      setError(size, '');
    }
  }

  // An invoice needs a price; a tier without one is quoted.
  function matchKindToPlan() {
    const priced = tierPrice(planRow(select.value), currency) != null;
    request.quoted = request.kind === 'invoice' && !priced;
    if (request.quoted) setKind('quote', false);
  }

  // "Pay by invoice" chosen while the plan is on quote: move to the priced
  // tier that fits the number of people, if there is one.
  function pricePlanForInvoice() {
    if (tierPrice(planRow(select.value), currency) != null) return;
    const count = Number(size.value);
    const fit = TEAM_TIERS.find(tier => !count || count <= tier.seats);
    if (fit) select.value = fit.plan;
  }

  function fitPlanToPeople() {
    const count = Number(size.value);
    if (!/^\d+$/.test(size.value.trim()) || count < 2) return;
    const current = planRow(select.value);
    const fits = current && (current.seats ? count <= current.seats : count > Math.max(...TEAM_TIERS.map(tier => tier.seats)));
    if (fits) return;
    const next = planForPeople(count);
    if (next) select.value = next;
  }

  function setKind(kind, apply = true) {
    request.kind = KINDS[kind] && (kind !== 'talk' || LANDING.talk?.enabled) ? kind : 'invoice';
    qsa('input[name="kind"]', form).forEach(input => { input.checked = input.value === request.kind; });
    if (apply) applyKind();
  }

  function applyKind() {
    matchKindToPlan();
    const copy = KINDS[request.kind];
    title.textContent = copy.title;
    intro.textContent = requestMode === 'mailto' ? 'Fill this in and your email app will open with the request, ready to send.' : copy.intro;
    // Below the choice, so the buttons never move under the pointer.
    kindNote.textContent = request.quoted ? `${tierLabel(planRow(select.value))}: it starts with a quote, and the invoice follows.` : '';
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

  function open({ kind, plan }) {
    showForm();
    setKind(kind || request.kind, false);
    if (plan) setPlan(plan, true);
    else if (!size.value) setPlan(select.value || defaultPlan(), true);
    applyKind();
    noteOpened();
    panel.scrollIntoView({ block: 'start', behavior: smoothBehavior() });
    title.focus({ preventScroll: true });
    if (!reduceQuery.matches) {
      try { animate(title, { opacity: [0.35, 1] }, { duration: 0.5, ease: EASE_OUT }).finished.then(() => title.style.removeProperty('opacity'), () => {}); } catch (_) { /* static is fine */ }
    }
  }
  openRequest = open;

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

  select.addEventListener('change', () => {
    setPlan(select.value, !request.peopleTouched || !size.value);
    applyKind();
  });
  size.addEventListener('input', () => { request.peopleTouched = true; });
  size.addEventListener('change', () => {
    fitPlanToPeople();
    applyKind();
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

  setPlan(defaultPlan(), true);
  // Arriving from a link such as ../?ask=question#request.
  const ask = new URLSearchParams(location.search).get('ask');
  setKind(KINDS[ask] ? ask : 'invoice');

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (requestMode === 'off') return;
    errorBox.hidden = true;
    fitPlanToPeople();
    applyKind();
    const values = readForm(form, request.kind);
    const invalid = validate(form, values);
    if (invalid) { invalid.focus(); return; }

    if (requestMode === 'mailto') {
      const tier = planRow(values.plan);
      const price = tierPrice(tier, currency);
      const lines = [
        `Request: ${KINDS[values.kind].label}`,
        `Plan: Team gift, ${tierLabel(tier).toLowerCase()} (${price == null ? 'on quote' : money(price)})`,
        `Number of people: ${values.teamSize}`,
        `Timing: ${TIMING_LABELS[values.timing]}`,
        `Company: ${values.company}`,
        `Name: ${values.name}`,
        `Email: ${values.email}`
      ];
      if (values.message) lines.push('', values.message);
      const subject = `Daily Planner team gift — ${KINDS[values.kind].label}: ${values.company}`;
      location.href = `mailto:${LANDING.contactEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join('\r\n'))}`;
      showDone(`Your email app should open with the request, ready to send. If it doesn’t, write to ${LANDING.contactEmail}.`);
      return;
    }

    submit.disabled = true;
    const label = submit.textContent;
    submit.textContent = 'Sending…';
    const result = await sendRequest(values);
    submit.disabled = false;
    submit.textContent = label;
    if (result.ok) {
      track('team_request_sent');
      const delay = LANDING.replyDelay ? ` ${LANDING.replyDelay}` : '';
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
}

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

function setError(field, message) {
  const ids = (field.getAttribute('aria-describedby') || '').split(/\s+/);
  const box = ids.map(id => document.getElementById(id)).find(node => node?.classList.contains('field__err'));
  field.setAttribute('aria-invalid', message ? 'true' : 'false');
  if (box) box.textContent = message;
}

function validate(form, values) {
  const count = Number(values.teamSize);
  const asking = values.kind === 'question' || values.kind === 'talk';
  const checks = [
    ['email', !values.email ? 'Enter your work email.' : (!EMAIL_RE.test(values.email) || values.email.length > 254 ? 'Enter an email address like name@company.com.' : '')],
    ['name', !values.name ? 'Enter your name.' : (values.name.length > 80 ? 'Keep your name under 80 characters.' : '')],
    ['company', !values.company ? 'Enter your company.' : (values.company.length > 120 ? 'Keep the company name under 120 characters.' : '')],
    ['plan', planRow(values.plan) ? '' : 'Choose a plan.'],
    ['teamSize', /^\d+$/.test(values.teamSize) && count >= 2 && count <= 100000 ? '' : 'Enter the number of people, from 2 to 100,000.'],
    ['message', values.message.length > 1000 ? 'Keep the message under 1,000 characters.' : (asking && !values.message ? 'Write your question.' : '')],
    ['consent', requestMode !== 'api' || values.consent ? '' : 'Tick this box so we can reply to you.']
  ];
  let first = null;
  checks.forEach(([name, message]) => {
    const field = qs(`[name="${name}"]`, form);
    setError(field, message);
    if (message && !first) first = field;
  });
  if (!TIMING_LABELS[values.timing]) values.timing = 'december-2026';
  return first;
}

async function sendRequest(values) {
  const payload = {
    email: values.email,
    name: values.name,
    company: values.company,
    teamSize: Number.parseInt(values.teamSize, 10),
    timing: values.timing,
    message: values.message,
    consent: true,
    website: values.website,
    version: APP_VERSION,
    locale: navigator.language || '',
    source: 'landing',
    plan: values.plan,
    currency,
    kind: values.kind
  };
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

/* Header, dock and click counts ------------------------------------------- */

function setupChrome() {
  const top = qs('[data-top]');
  let ticking = false;
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      top?.classList.toggle('is-scrolled', window.scrollY > 4);
      ticking = false;
    });
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  const dock = qs('[data-dock]');
  const heroCtas = qs('[data-hero-ctas]');
  // The dock steps aside where it would compete: the team gift, the request form and the final call to action.
  const quiet = [qs('#teams .band'), qs('[data-form-panel]'), qs('[data-final-cta]')].filter(Boolean);
  if (dock && heroCtas && 'IntersectionObserver' in window) {
    let pastHero = false;
    const quietVisible = new Set();
    const sync = () => dock.classList.toggle('is-visible', pastHero && !quietVisible.size);
    new IntersectionObserver(([entry]) => {
      pastHero = !entry.isIntersecting && entry.boundingClientRect.top < 0;
      sync();
    }).observe(heroCtas);
    const quietObserver = new IntersectionObserver(entries => {
      entries.forEach(entry => { if (entry.isIntersecting) quietVisible.add(entry.target); else quietVisible.delete(entry.target); });
      sync();
    }, { rootMargin: '-80px 0px -12% 0px' });
    quiet.forEach(node => quietObserver.observe(node));
  }

  document.addEventListener('click', event => {
    const target = event.target.closest('a, button');
    if (!target) return;
    if (target.matches('[data-cta="app"]')) track('landing_cta_app');
    else if (target.getAttribute('href') === '#teams') track('landing_cta_teams');
  });
}

/* Counts: which parts of the page people reach, once per page view -------- */

function setupViewCounts() {
  if (!apiOn || !('IntersectionObserver' in window)) return;
  const sections = new Map([['plus', 'plus_viewed'], ['teams', 'teams_viewed'], ['pricing', 'pricing_viewed']]);
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      observer.unobserve(entry.target);
      track(sections.get(entry.target.id));
    });
  }, { rootMargin: '0px 0px -30% 0px' });
  sections.forEach((name, id) => { const node = document.getElementById(id); if (node) observer.observe(node); });
}

/* Replica data: painted cells --------------------------------------------- */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// Illustrative demo years. The hero and Progress stop on a Friday in October;
// the year in review covers all of 2026.
const DEMO = { year: 2026, month: 9, day: 9, firstClosed: [0, 12], missed: ['8-10', '5-14', '2-23', '6-27'], jokers: ['9-2', '7-15', '4-7'] };
const REVIEW = { year: 2026, month: 11, day: 31, firstClosed: [0, 5], missed: ['1-17', '3-29', '5-14', '7-12', '10-24', '11-29'], jokers: ['2-11', '4-21', '6-3', '8-23', '10-5'], noToday: true };

function paintState(demo, month, day) {
  const date = new Date(demo.year, month, day);
  if (date.getMonth() !== month) return 'none';
  const key = `${month}-${day}`;
  const afterToday = month > demo.month || (month === demo.month && day > demo.day);
  if (afterToday) return '';
  if (!demo.noToday && month === demo.month && day === demo.day) return 'l3 is-today';
  if (month < demo.firstClosed[0] || (month === demo.firstClosed[0] && day < demo.firstClosed[1])) return 'before';
  const weekday = date.getDay();
  if (weekday === 0 || weekday === 6) return 'rest';
  if (demo.missed.includes(key)) return 'miss';
  if (demo.jokers.includes(key)) return 'joker';
  const roll = (month * 37 + day * 11 + day * day) % 10;
  return roll < 3 ? 'l1' : roll < 7 ? 'l2' : 'l3';
}

function buildYear(grid, demo) {
  let order = 0;
  let closed = 0;
  let mits = 0;
  const rows = MONTHS.map((name, monthIndex) => {
    const cells = [];
    for (let day = 1; day <= 31; day += 1) {
      const state = paintState(demo, monthIndex, day);
      if (/\bl[123]\b/.test(state)) closed += 1;
      if (/\bl[23]\b/.test(state)) mits += 1;
      const painted = /\b(l[123]|joker|miss)\b/.test(state);
      cells.push(el('span', { class: `cell ${state}`, style: painted ? `--d:${order}` : null }));
      if (painted) order += 1;
    }
    return el('div', { class: 'rp-paint__row' }, el('span', {}, name[0], el('b', {}, name.slice(1, 3))), el('div', { class: 'rp-paint__cells' }, cells));
  });
  grid.replaceChildren(...rows);
  return { order, closed, mits };
}

function setCount(node, value) {
  if (!node) return;
  node.dataset.count = String(value);
  node.textContent = String(value);
}

function buildPaint() {
  const month = qs('[data-month]');
  if (month) {
    const cells = [];
    for (let day = 1; day <= 31; day += 1) cells.push(el('span', { class: `cell ${paintState(DEMO, DEMO.month, day)}` }));
    month.replaceChildren(...cells);
  }

  const grid = qs('[data-paint]');
  if (grid) {
    const { order, closed } = buildYear(grid, DEMO);
    setCount(qs('[data-paint-total]'), closed);
    qs('.rp--progress')?.style.setProperty('--paint-steps', String(order));
  }

  const review = qs('[data-review-paint]');
  if (review) {
    const { order, closed, mits } = buildYear(review, REVIEW);
    setCount(qs('[data-review-closed]'), closed);
    setCount(qs('[data-review-mits]'), mits);
    qs('.rp--review')?.style.setProperty('--paint-steps', String(order));
  }

  const palette = qs('[data-palette-grid]');
  if (palette) {
    const cells = [];
    for (let index = 0; index < 35; index += 1) {
      const weekday = index % 7;
      const roll = (index * 7 + index * index) % 10;
      const state = weekday > 4 ? 'rest' : index === 31 ? 'joker' : roll < 3 ? 'l1' : roll < 7 ? 'l2' : 'l3';
      cells.push(el('span', { class: `cell ${index > 32 ? '' : state}`, style: `--i:${index}` }));
    }
    palette.replaceChildren(...cells);
  }
}

/* Scenes: replicas that play near the viewport and pause when they leave --- */

const PALETTES = ['ocean', 'forest', 'plum', 'graphite', 'sunset'];

// A click in a replica: the pointer dips, a ripple spreads, the target presses.
function click(t, ms, press = '') {
  t.add('d-click', ms);
  t.remove('d-click', ms + 640);
  if (!press) return;
  t.add(press, ms);
  t.remove(press, ms + 240);
}

const SCRIPTS = {
  // The hero: plan, then a pointer closes the day. The Close day sheet opens,
  // two open items are decided, a memory is written, and only then is the
  // day's square painted.
  day: {
    length: 14000,
    loop: true,
    run(t) {
      const [focus, memory] = qsa('[data-type]', t.root);
      t.type(focus, 300);
      t.add('s-mit', 1800);
      t.add('s-block', 2300);
      t.point('.rp-window', 2900, { x: 0.6, y: 0.94, jump: true });
      t.add('d-cursor', 2950);
      t.point('.rp-closebtn', 3050, { duration: 950, x: 0.42, y: 0.62 });
      t.add('d-hover', 3850);
      click(t, 4150, 'd-press');
      t.remove('d-hover', 4450);
      t.add('d-modal', 4450);
      t.point('.rp-mi--save .rp-mc--save', 5100, { duration: 700 });
      click(t, 5850);
      t.add('d-save', 5850);
      t.point('.rp-mi--forget .rp-mc--forget', 6350, { duration: 560 });
      click(t, 7000);
      t.add('d-forget', 7000);
      t.point('.rp-modal .rp-field', 7550, { duration: 620, x: 0.16, y: 0.55 });
      click(t, 8250);
      t.type(memory, 8350);
      t.point('.rp-modal .rp-primary', 9650, { duration: 640, x: 0.5, y: 0.58 });
      click(t, 10400, 'd-submit');
      t.remove('d-modal', 10700);
      t.remove('d-cursor', 10700);
      t.add('s-closed', 11050);
      t.count(qs('[data-count]', t.root), 11700, 300);
    }
  },
  close: {
    length: 13000,
    loop: true,
    run(t) {
      const [memory, lesson, next] = qsa('[data-type]', t.root);
      t.add('s-save', 900);
      t.add('s-forget', 1800);
      t.type(memory, 2700);
      t.type(lesson, 4000);
      t.add('s-press', 5800);
      t.remove('s-press', 6060);
      t.add('s-closed', 6200);
      t.type(next, 7000);
    }
  },
  week: { run(t) { t.add('s-in', 150); } },
  journal: {
    run(t) {
      t.add('s-in', 120);
      t.add('s-new', 1500);
    }
  },
  unresolved: {
    length: 9400,
    loop: true,
    run(t) {
      t.add('s-press-plan', 900);
      t.remove('s-press-plan', 1120);
      t.add('s-plan', 1120);
      t.add('s-press-save', 2700);
      t.remove('s-press-save', 2920);
      t.add('s-save', 2920);
      t.add('s-later', 4700);
    }
  },
  stats: {
    run(t) {
      t.add('s-in', 150);
      t.add('s-elapsed', 1250);
    }
  },
  search: {
    length: 7200,
    loop: true,
    run(t) {
      t.type(qs('[data-type]', t.root), 500);
      t.add('s-res', 1250);
    }
  },
  ribbon: { run(t) { t.add('s-in', 150); } },
  adventures: { run(t) { t.add('s-planned', 1200); } },
  progress: {
    run(t) {
      const steps = Number(t.root.style.getPropertyValue('--paint-steps')) || 150;
      const span = steps * 7;
      t.add('s-in', 100);
      qsa('[data-count]', t.root).forEach(node => t.count(node, 150, span));
      t.add('s-toast', span + 900);
    }
  },
  trophies: { run(t) { t.add('s-in', 250); } },
  sync: {
    length: 7400,
    loop: true,
    run(t) {
      t.add('s-finger', 400);
      t.add('s-tap', 1050);
      t.add('s-sync', 1500);
      t.add('s-done', 2900);
      t.remove('s-sync', 3300);
    }
  },
  yearplan: {
    length: 16800,
    loop: true,
    run(t) {
      t.type(qs('[data-type]', t.root), 600);
      t.add('s-when', 2100);
      t.add('s-2', 3300);
      t.add('s-3', 5400);
      t.add('s-4', 7700);
      t.add('s-5', 9700);
      t.add('s-6', 11600);
      t.add('s-7', 13600);
      t.add('s-press', 15200);
      t.remove('s-press', 15460);
    }
  },
  review: {
    run(t) {
      const steps = Number(t.root.style.getPropertyValue('--paint-steps')) || 240;
      const span = steps * 4;
      t.add('s-in', 100);
      qsa('[data-count]', t.root).forEach(node => t.count(node, 150, span));
      t.add('s-bars', 500);
      t.add('s-notes', Math.round(span * 0.6) + 400);
      t.add('s-press', span + 1100);
      t.remove('s-press', span + 1360);
    }
  },
  palettes: {
    length: 10400,
    loop: true,
    run(t) {
      PALETTES.forEach((name, index) => {
        const at = 1100 + index * 1650;
        t.add(`pal-${name}`, at);
        if (index) t.remove(`pal-${PALETTES[index - 1]}`, at);
      });
      t.remove(`pal-${PALETTES[PALETTES.length - 1]}`, 1100 + PALETTES.length * 1650);
    }
  },
  gift: {
    length: 9200,
    loop: true,
    run(t) {
      t.add('s-tap', 700);
      t.add('s-open', 1300);
      t.add('s-press', 3100);
      t.remove('s-press', 3360);
      t.add('s-on', 3360);
      t.add('s-seat', 4400);
      t.count(qs('[data-count]', t.root), 4500, 200);
    }
  }
};

// Classes a scene passes through on its way to the final frame.
const TRANSIENT = ['s-press', 's-sync', 's-finger', 's-press-plan', 's-press-save', 's-save', 's-later', 's-tap', ...PALETTES.map(name => `pal-${name}`),
  'd-cursor', 'd-hover', 'd-press', 'd-click', 'd-modal', 'd-save', 'd-forget', 'd-submit'];

// Moves a replica's pointer onto `target` (a selector inside the scene), in
// em so it stays in place if the replica is resized while it glides.
function aim(root, target, { duration = 700, x = 0.5, y = 0.5, jump = false } = {}) {
  const pointer = qs('.rp-cursor', root);
  const node = qs(target, root);
  if (!pointer || !node) return;
  const box = root.getBoundingClientRect();
  const rect = node.getBoundingClientRect();
  const em = Number.parseFloat(getComputedStyle(root).fontSize) || 12;
  const left = (rect.left - box.left + rect.width * x) / em;
  const top = (rect.top - box.top + rect.height * y) / em;
  pointer.style.setProperty('--move', `${jump ? 0 : duration}ms`);
  pointer.style.setProperty('--cx', `${left.toFixed(2)}em`);
  pointer.style.setProperty('--cy', `${top.toFixed(2)}em`);
}

function createScene(root) {
  const script = SCRIPTS[root.dataset.scene];
  if (!script) return null;
  const finals = (root.dataset.final || '').split(/\s+/).filter(Boolean);
  const typed = qsa('[data-type]', root);
  typed.forEach(node => { node.dataset.text = node.textContent; });
  const counters = qsa('[data-count]', root);
  let timers = [];
  let state = 'final';
  let playing = false;

  const later = (ms, fn) => { timers.push(window.setTimeout(fn, ms)); };
  const clear = () => { timers.forEach(id => window.clearTimeout(id)); timers = []; };

  const api = {
    root,
    add: (cls, ms) => later(ms, () => root.classList.add(cls)),
    remove: (cls, ms) => later(ms, () => root.classList.remove(cls)),
    point: (target, ms, options) => later(ms, () => aim(root, target, options)),
    type(node, ms) {
      if (!node) return;
      const text = node.dataset.text || '';
      const speed = Number(node.dataset.speed) || 42;
      later(ms, () => node.classList.add('is-typing'));
      for (let index = 1; index <= text.length; index += 1) later(ms + index * speed, () => { node.textContent = text.slice(0, index); });
      later(ms + text.length * speed + 700, () => node.classList.remove('is-typing'));
    },
    count(node, ms, duration) {
      if (!node) return;
      const to = Number(node.dataset.count) || 0;
      const from = Number(node.dataset.from) || 0;
      const steps = Math.max(1, Math.min(Math.abs(to - from), Math.round(duration / 40)));
      for (let step = 1; step <= steps; step += 1) later(ms + (duration * step) / steps, () => { node.textContent = String(Math.round(from + ((to - from) * step) / steps)); });
    }
  };

  const pointers = qsa('.rp-cursor', root);

  function reset() {
    root.classList.remove(...finals, ...TRANSIENT);
    pointers.forEach(node => node.removeAttribute('style'));
    typed.forEach(node => { node.textContent = ''; node.classList.remove('is-typing'); });
    counters.forEach(node => { node.textContent = node.dataset.from || '0'; });
    state = 'reset';
  }

  function finish() {
    clear();
    root.classList.remove(...TRANSIENT, 'is-playing');
    pointers.forEach(node => node.removeAttribute('style'));
    root.classList.add(...finals, 'is-armed');
    typed.forEach(node => { node.textContent = node.dataset.text; node.classList.remove('is-typing'); });
    counters.forEach(node => { node.textContent = node.dataset.count; });
    state = 'final';
    playing = false;
  }

  function run() {
    clear();
    state = 'running';
    script.run(api);
    if (script.loop) {
      later(script.length, () => {
        reset();
        later(900, run);
      });
    } else {
      later(script.length || 6000, () => { state = 'final'; });
    }
  }

  return {
    root,
    loop: !!script.loop,
    arm() {
      clear();
      playing = false;
      root.classList.remove('is-playing');
      reset();
      root.classList.add('is-armed');
    },
    finish,
    play() {
      if (playing || (!script.loop && state === 'final')) return;
      playing = true;
      root.classList.add('is-playing');
      if (state === 'reset') run();
      else {
        // Coming back after a pause: hold the current frame briefly, then replay.
        later(1400, () => {
          reset();
          later(900, run);
        });
      }
    },
    stop() {
      if (!playing) return;
      playing = false;
      clear();
      root.classList.remove('is-playing');
    }
  };
}

let motionOn = false;
const motionHooks = [];

function setupScenes() {
  const scenes = qsa('[data-scene]').map(createScene).filter(Boolean);
  if (!scenes.length) return;
  const visible = new Set();
  let observer = null;

  const enable = () => {
    scenes.forEach(scene => scene.arm());
    // Let the armed (pre-animation) state settle without transitions first.
    void document.body.offsetHeight;
    html.classList.add('motion-ok');
    observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        const scene = scenes.find(item => item.root === entry.target);
        if (!scene) return;
        if (entry.isIntersecting) {
          visible.add(scene);
          if (!document.hidden) scene.play();
          if (!scene.loop) observer.unobserve(scene.root);
        } else {
          visible.delete(scene);
          if (scene.loop) scene.stop();
        }
      });
    }, { threshold: 0.3 });
    scenes.forEach(scene => observer.observe(scene.root));
  };

  const disable = () => {
    observer?.disconnect();
    observer = null;
    visible.clear();
    html.classList.remove('motion-ok');
    scenes.forEach(scene => scene.finish());
  };

  if (motionOn) enable();
  else disable();

  motionHooks.push(on => { if (on) enable(); else disable(); });

  document.addEventListener('visibilitychange', () => {
    if (!observer) return;
    visible.forEach(scene => { if (document.hidden) scene.stop(); else scene.play(); });
  });
}

/* Entrances: headings, cards and replicas rise in as they reach the viewport */

function rise(target, delay) {
  const settle = () => {
    target.style.removeProperty('opacity');
    target.style.removeProperty('transform');
  };
  try {
    animate(target, { opacity: [0, 1], transform: ['translateY(18px)', 'none'] }, { duration: 0.7, delay, ease: EASE_OUT }).finished.then(settle, settle);
  } catch (_) {
    settle();
  }
}

function setupReveal() {
  const nodes = qsa('[data-reveal], [data-reveal-each]');
  const showAll = () => nodes.forEach(node => node.classList.add('is-in'));
  if (!motionOn) {
    showAll();
    return;
  }
  const observer = new IntersectionObserver(entries => {
    const entering = entries.filter(entry => entry.isIntersecting).map(entry => entry.target)
      .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    entering.forEach((node, index) => {
      observer.unobserve(node);
      const start = Math.min(index, 4) * 0.08;
      const targets = node.hasAttribute('data-reveal-each') ? [...node.children] : [node];
      node.classList.add('is-in');
      targets.forEach((target, step) => rise(target, start + Math.min(step, 8) * 0.07));
    });
  }, { rootMargin: '0px 0px -8% 0px' });
  nodes.forEach(node => observer.observe(node));
  motionHooks.push(on => {
    if (on) return;
    observer.disconnect();
    showAll();
  });
}

/* FAQ: one answer open at a time, with a smooth height change ------------- */

function setupFaq() {
  const items = qsa('[data-faq] details');
  if (!items.length) return;
  // Native exclusivity would close the previous answer instantly; we animate it.
  items.forEach(item => item.removeAttribute('name'));
  const running = new Map();
  const panelOf = item => qs('.qa__a', item);
  const settle = panel => {
    panel.style.removeProperty('height');
    panel.style.removeProperty('opacity');
  };
  const stop = item => {
    const controls = running.get(item);
    running.delete(item);
    try { controls?.stop(); } catch (_) { /* already settled */ }
  };
  const canAnimate = () => !reduceQuery.matches && typeof Element.prototype.animate === 'function';

  function close(item) {
    const panel = panelOf(item);
    const from = panel.getBoundingClientRect().height;
    stop(item);
    if (!canAnimate()) {
      item.classList.remove('is-closing');
      item.open = false;
      settle(panel);
      return;
    }
    item.classList.add('is-closing');
    const controls = animate(panel, { height: [`${from}px`, '0px'], opacity: [1, 0] }, { duration: 0.26, ease: [0.4, 0, 0.2, 1] });
    running.set(item, controls);
    controls.finished.then(() => {
      if (running.get(item) !== controls) return;
      running.delete(item);
      item.classList.remove('is-closing');
      item.open = false;
      settle(panel);
    }, () => {});
  }

  function open(item) {
    items.forEach(other => { if (other !== item && other.open && !other.classList.contains('is-closing')) close(other); });
    const panel = panelOf(item);
    const from = item.open ? panel.getBoundingClientRect().height : 0;
    stop(item);
    item.classList.remove('is-closing');
    item.open = true;
    if (!canAnimate()) {
      settle(panel);
      return;
    }
    const to = panel.scrollHeight;
    const controls = animate(panel, { height: [`${from}px`, `${to}px`], opacity: [from ? 1 : 0, 1] }, { duration: 0.36, ease: EASE_OUT });
    running.set(item, controls);
    controls.finished.then(() => {
      if (running.get(item) !== controls) return;
      running.delete(item);
      settle(panel);
    }, () => {});
  }

  items.forEach(item => {
    qs('summary', item).addEventListener('click', event => {
      event.preventDefault();
      if (item.open && !item.classList.contains('is-closing')) close(item);
      else open(item);
    });
    item.addEventListener('toggle', () => {
      // Opened by the browser itself (find in page): still one answer at a time.
      if (item.open && !running.has(item)) items.forEach(other => { if (other !== item && other.open && !other.classList.contains('is-closing')) close(other); });
    });
  });
}

/* Start -------------------------------------------------------------------- */

// A payment confirmation sent here instead of to the gift page.
const params = new URLSearchParams(location.search);
if (params.get('checkout_id') || params.get('session')) location.replace(`./thanks/${location.search}`);

// The inline script in <head> set `js-anim` before first paint when motion is
// welcome. If it gave up waiting for this module, stay static.
motionOn = html.classList.contains('js-anim') && !reduceQuery.matches;

buildPaint();
setupOffers();
setupBuy();
renderFooter();
setupManagerEmail();
setupRequest();
setupChrome();
setupViewCounts();
setupScenes();
setupReveal();
setupFaq();

reduceQuery.addEventListener?.('change', () => {
  motionOn = !reduceQuery.matches;
  if (!motionOn) html.classList.remove('js-anim');
  motionHooks.forEach(hook => hook(motionOn));
});

html.classList.add('js-ready');
track('landing_viewed');
