// Imported as a namespace so a value missing from an older config.js reads as
// undefined instead of failing the whole module.
import * as config from '../src/config.js';
import { trackEvent, plannerApiEnabled } from '../src/lib/planner-api.js';
import { animate } from '../src/vendor/motion.js';

/* ============================================================================
   LANDING — everything the owner may want to change without touching markup.
   Prices, checkout links and the optional talk are rendered from here.

   PROPOSALS TO CONFIRM BEFORE PUBLISHING (owner decision pending):
   - `plus.price` and every price in `tiers`, and the `badge` on the
     highlighted tier;
   - `pricingNote` (check the VAT line with your accountant);
   - `replyDelay` (left blank on purpose: no response time is promised).
   ============================================================================ */
const LANDING = {
  // PROPOSAL: Daily Planner Plus for one person, paid once. The same number
  // in EUR and USD; write { EUR: 29, USD: 32 } to set them apart. The buy
  // button links to PLUS_CHECKOUT_URL from the deployment config (build
  // variable DAILY_PLANNER_PLUS_CHECKOUT_URL); blank shows "Coming soon".
  plus: { price: 29 },
  // PROPOSAL: team gift, one-time price per company by number of people.
  // `price` is the same number in EUR and USD; write { EUR: 595, USD: 650 } to
  // set them apart. `price: null` turns a tier into "On quote".
  tiers: [
    { plan: 'up-to-10', people: 10, price: 195 },
    { plan: 'up-to-50', people: 50, price: 595, highlight: true, badge: 'Suggested' },
    { plan: 'up-to-100', people: 100, price: 995 },
    { plan: 'up-to-500', people: 500, price: 2995 },
    { plan: 'up-to-1000', people: 1000, price: 4995 },
    { plan: 'over-1000', people: null, price: null, label: 'More than 1,000 people', note: 'A price for the whole organisation' }
  ],
  // Stripe Payment Links (https://buy.stripe.com/…), one per tier and currency.
  // While a link is blank, that tier offers the invoice request instead.
  // Set each link's confirmation page to
  // https://planner.bemorin.com/welcome/thanks/?session={CHECKOUT_SESSION_ID}
  checkout: {
    'up-to-10': { EUR: '', USD: '' },
    'up-to-50': { EUR: '', USD: '' },
    'up-to-100': { EUR: '', USD: '' },
    'up-to-500': { EUR: '', USD: '' },
    'up-to-1000': { EUR: '', USD: '' }
  },
  pricingNote: 'One-time payment. Invoice included. No subscription. No VAT is added.',
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

const CURRENCIES = ['EUR', 'USD'];
const MONEY_LOCALE = { EUR: 'en-IE', USD: 'en-US' };
const EURO_REGIONS = new Set(['AT', 'BE', 'BG', 'CY', 'DE', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PT', 'SI', 'SK', 'AD', 'MC', 'SM', 'VA', 'ME', 'XK']);
const CURRENCY_KEY = 'daily-planner-landing:currency';

function localeRegion(tag, guess) {
  try {
    const locale = new Intl.Locale(tag);
    return locale.region || (guess && locale.maximize().region) || '';
  } catch (_) {
    const match = /^[a-z]{2,3}(?:-[a-z]{4})?-([a-z]{2})(?:-|$)/i.exec(tag);
    return match ? match[1].toUpperCase() : '';
  }
}

function detectCurrency() {
  const tags = [...(navigator.languages || []), navigator.language].filter(tag => typeof tag === 'string' && tag);
  // An explicit region anywhere in the list wins ("en, fr-FR" is a French
  // visitor); otherwise the likely region of the first language.
  const region = tags.map(tag => localeRegion(tag, false)).find(Boolean) || (tags[0] ? localeRegion(tags[0], true) : '');
  return EURO_REGIONS.has(region) ? 'EUR' : 'USD';
}

function storedCurrency() {
  try {
    const value = localStorage.getItem(CURRENCY_KEY);
    return CURRENCIES.includes(value) ? value : '';
  } catch (_) {
    return '';
  }
}

function rememberCurrency(value) {
  try { localStorage.setItem(CURRENCY_KEY, value); } catch (_) { /* private mode: the choice lasts for this visit */ }
}

let currency = storedCurrency() || detectCurrency();

function money(value, cents = false) {
  return new Intl.NumberFormat(MONEY_LOCALE[currency] || 'en-US', { style: 'currency', currency, minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 }).format(value);
}

const roundedMoney = value => {
  const rounded = Math.round(value * 100) / 100;
  return money(rounded, !Number.isInteger(rounded));
};

const people = value => new Intl.NumberFormat('en-US').format(value);

function priceIn(price) {
  if (price == null) return null;
  const value = typeof price === 'object' ? price[currency] : price;
  return Number.isFinite(value) ? value : null;
}

const tierPrice = tier => priceIn(tier?.price);
const plusPrice = () => priceIn(LANDING.plus?.price);
const tierLabel = tier => tier.label || `Up to ${people(tier.people)} people`;
const tierByPlan = plan => LANDING.tiers.find(tier => tier.plan === plan) || null;
const quoteTier = () => LANDING.tiers.find(tier => tierPrice(tier) == null) || null;
const defaultPlan = () => (LANDING.tiers.find(tier => tier.highlight) || LANDING.tiers[0]).plan;

function perPerson(tier) {
  const price = tierPrice(tier);
  return price != null && tier.people ? roundedMoney(price / tier.people) : '';
}

function lowestPerPerson() {
  const values = LANDING.tiers.map(tier => {
    const price = tierPrice(tier);
    return price != null && tier.people ? price / tier.people : Infinity;
  });
  const lowest = Math.min(...values);
  return Number.isFinite(lowest) ? roundedMoney(lowest) : '';
}

const checkoutUrl = tier => httpsUrl(LANDING.checkout?.[tier.plan]?.[currency]);
const anyCheckout = () => LANDING.tiers.some(checkoutUrl);
const plusCheckoutUrl = () => httpsUrl(configUrl('PLUS_CHECKOUT_URL'));

/* Offer: Plus, team tiers, talk -------------------------------------------- */

function renderPlus() {
  const price = plusPrice();
  qsa('[data-plus-price]').forEach(node => { node.textContent = price == null ? '' : money(price); });
  const url = plusCheckoutUrl();
  qsa('[data-plus-cta]').forEach(box => {
    box.replaceChildren(url
      ? el('a', { class: 'btn btn--primary', href: url, rel: 'noopener', 'data-plus-checkout': true }, 'Get Plus')
      : el('button', { class: 'btn btn--primary', type: 'button', disabled: true }, 'Coming soon'));
  });
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
  const rows = LANDING.tiers.map(tier => {
    const price = tierPrice(tier);
    const label = tierLabel(tier);
    const named = label.toLowerCase();
    const quote = price == null;
    const url = quote ? '' : checkoutUrl(tier);
    const look = `btn btn--tier ${tier.highlight ? 'btn--primary' : 'btn--ghost'}`;
    let action;
    let invoice = null;
    if (quote) {
      action = el('a', { class: look, href: '#request', 'data-request': 'quote', 'data-plan': tier.plan, 'aria-label': `Ask for a quote for ${named}` }, 'Ask for a quote');
    } else if (url) {
      action = el('a', { class: look, href: url, rel: 'noopener', 'data-checkout': tier.plan, 'aria-label': `Buy the team gift for ${named}, ${money(price)}` }, 'Buy');
      invoice = el('a', { class: 'tier__link', href: '#request', 'data-request': 'invoice', 'data-plan': tier.plan, 'aria-label': `Pay by invoice for ${named}` }, 'Pay by invoice');
    } else {
      action = el('a', { class: look, href: '#request', 'data-request': 'invoice', 'data-plan': tier.plan, 'aria-label': `Get the team gift for ${named} by invoice` }, 'Get it by invoice');
    }
    return el('div', { class: `tier${tier.highlight ? ' is-highlight' : ''}${quote ? ' tier--quote' : ''}` },
      el('div', { class: 'tier__who' },
        tier.badge ? el('span', { class: 'tier__badge' }, tier.badge) : null,
        el('b', {}, label),
        el('small', {}, quote ? (tier.note || '') : `${perPerson(tier)} per person`),
        invoice),
      el('div', { class: 'tier__price' }, quote ? 'On quote' : money(price)),
      el('div', { class: 'tier__act' }, action));
  });
  box.replaceChildren(...rows);
}

function renderCurrencyCopy() {
  qsa('[data-min-per-person]').forEach(node => { node.textContent = lowestPerPerson(); });
  const pay = qs('[data-faq-pay]');
  if (pay) {
    pay.textContent = anyCheckout()
      ? 'Yes, or by card. “Buy” opens a secure card payment page, and the gift link arrives as soon as it’s paid. “Pay by invoice” sends a request instead: you receive an invoice to pay by bank transfer, then the gift link once it’s paid. Either way it’s one payment, with no subscription.'
      : 'Yes. Choose a team size and send the request: you’ll receive an invoice to pay by bank transfer, then the gift link once it’s paid. It’s one payment, with no subscription.';
  }
}

function setupCurrency() {
  const group = qs('[data-currency]');
  const note = qs('[data-pricing-note]');
  if (note) note.textContent = LANDING.pricingNote;
  renderTalk();
  const apply = ({ animated = false } = {}) => {
    qsa('[data-cur]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.cur === currency)));
    renderPlus();
    renderTiers();
    renderCurrencyCopy();
    renderPlanOptions();
    updateManagerLink();
    if (animated && !reduceQuery.matches) {
      qsa('.tier__price, .tier__who small, .price--plus .price__big').forEach((node, index) => {
        try { animate(node, { opacity: [0, 1], transform: ['translateY(5px)', 'none'] }, { duration: 0.32, delay: (index % 6) * 0.025, ease: EASE_OUT }); } catch (_) { /* static is fine */ }
      });
    }
  };
  if (group) {
    group.hidden = false;
    group.addEventListener('click', event => {
      const button = event.target.closest('[data-cur]');
      if (!button || !CURRENCIES.includes(button.dataset.cur) || button.dataset.cur === currency) return;
      currency = button.dataset.cur;
      rememberCurrency(currency);
      apply({ animated: true });
    });
  }
  apply();
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

const managerBody = () => LANDING.managerEmail.body.replaceAll('{url}', LANDING.landingUrl).replaceAll('{perPerson}', lowestPerPerson());

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
  select.replaceChildren(...LANDING.tiers.map(tier => {
    const price = tierPrice(tier);
    return el('option', { value: tier.plan }, `${tierLabel(tier)} · ${price == null ? 'on quote' : money(price)}`);
  }));
  select.value = tierByPlan(current) ? current : defaultPlan();
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
    if (!tierByPlan(plan)) return;
    select.value = plan;
    if (prefill) {
      const tier = tierByPlan(plan);
      size.value = tier.people ? String(tier.people) : '';
      request.peopleTouched = false;
      setError(size, '');
    }
  }

  // An invoice needs a price; a tier without one is quoted.
  function matchKindToPlan() {
    const priced = tierPrice(tierByPlan(select.value)) != null;
    request.quoted = request.kind === 'invoice' && !priced;
    if (request.quoted) setKind('quote', false);
  }

  // "Pay by invoice" chosen while the plan is on quote: move to the priced
  // tier that fits the number of people, if there is one.
  function pricePlanForInvoice() {
    if (tierPrice(tierByPlan(select.value)) != null) return;
    const count = Number(size.value);
    const fit = LANDING.tiers.find(tier => tierPrice(tier) != null && tier.people && (!count || count <= tier.people));
    if (fit) select.value = fit.plan;
  }

  function fitPlanToPeople() {
    const count = Number(size.value);
    if (!/^\d+$/.test(size.value.trim()) || count < 2) return;
    const current = tierByPlan(select.value);
    const fits = current && (current.people ? count <= current.people : count > Math.max(...LANDING.tiers.map(tier => tier.people || 0)));
    if (fits) return;
    const next = LANDING.tiers.find(tier => tier.people && count <= tier.people) || quoteTier();
    if (next) select.value = next.plan;
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
    kindNote.textContent = request.quoted ? `${tierLabel(tierByPlan(select.value))}: it starts with a quote, and the invoice follows.` : '';
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
      const tier = tierByPlan(values.plan);
      const price = tierPrice(tier);
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
    ['plan', tierByPlan(values.plan) ? '' : 'Choose a plan.'],
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
    else if (target.matches('[data-plus-checkout]')) track('plus_checkout_clicked');
    else if (target.matches('[data-checkout]')) track('pack_checkout_clicked');
    else if (target.getAttribute('href') === '#teams') track('landing_cta_teams');
  });
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

const SCRIPTS = {
  day: {
    length: 11500,
    loop: true,
    run(t) {
      t.type(qs('[data-type]', t.root), 500);
      t.add('s-mit', 2500);
      t.add('s-block', 3300);
      t.add('s-press', 4600);
      t.remove('s-press', 4860);
      t.add('s-closed', 5000);
      t.count(qs('[data-count]', t.root), 5900, 300);
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
const TRANSIENT = ['s-press', 's-sync', 's-finger', 's-press-plan', 's-press-save', 's-save', 's-later', 's-tap', ...PALETTES.map(name => `pal-${name}`)];

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

  function reset() {
    root.classList.remove(...finals, ...TRANSIENT);
    typed.forEach(node => { node.textContent = ''; node.classList.remove('is-typing'); });
    counters.forEach(node => { node.textContent = node.dataset.from || '0'; });
    state = 'reset';
  }

  function finish() {
    clear();
    root.classList.remove(...TRANSIENT, 'is-playing');
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

// A Stripe confirmation pointed at this page instead of the manage page.
const params = new URLSearchParams(location.search);
if (/^cs_(?:live|test)_[A-Za-z0-9_]+$/.test(params.get('session') || '')) location.replace(`./thanks/${location.search}`);

// The inline script in <head> set `js-anim` before first paint when motion is
// welcome. If it gave up waiting for this module, stay static.
motionOn = html.classList.contains('js-anim') && !reduceQuery.matches;

buildPaint();
setupCurrency();
renderFooter();
setupManagerEmail();
setupRequest();
setupChrome();
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
