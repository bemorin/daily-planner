// Imported as a namespace so a value missing from an older config.js reads as
// undefined instead of failing the whole module.
import * as config from '../../src/config.js';
import { trackEvent, plannerApiEnabled, claimPurchase, dismissPartnerHint, partnerHintShown, rememberReferral } from '../../src/lib/planner-api.js';
import { PARTNER_PROGRAM } from '../../src/lib/pricing.js';
import { giftAudience, giftPageParams, isDefaultCompany, partnerInvitation } from '../landing-model.js';

/* ============================================================================
   Your gift page (/welcome/thanks/): a private page with the gift link, the
   seats used and the message people see. A team gift speaks to a company
   ("your people", "company name"); Give Plus and Plus Family speak to one
   person giving Plus to someone, or to their family (COPY below).

   ?checkout_id=…         back from the payment page (Creem): POST /purchases/claim
   ?session=…             an older confirmation link: claimed the same way
   ?gift=CODE&key=KEY     the gift page link (email, bookmark, gifts made by invoice)

   The key only travels to PATCH /gifts/:code; the page never stores it.
   Under the gift, one quiet card mentions the partner program, until it is
   hidden or followed on this device (daily-planner-ui:partner-hints).
   ============================================================================ */

const API = typeof config.PLANNER_API_URL === 'string' ? config.PLANNER_API_URL : '';
const apiOn = plannerApiEnabled();
const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{12}$/;
const KEY_RE = /^[a-f0-9]{64}$/i;
const MESSAGE_MAX = 280;
const ORG_MAX = 80;
// A payment can take a few seconds to settle: check again on our own first.
const RETRY_DELAYS = [2500, 4000, 6000];

const qs = (selector, root = document) => root.querySelector(selector);
const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];
const view = { loading: qs('[data-view="loading"]'), error: qs('[data-view="error"]'), ready: qs('[data-view="ready"]') };
const state = { code: '', key: '', url: '', gift: null };

const normalizeCode = raw => {
  const code = String(raw || '').replace(/[\s-]+/g, '').toUpperCase();
  return CODE_RE.test(code) ? code : '';
};
const formatCode = code => `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;

function giftUrl(code, fromServer) {
  if (typeof fromServer === 'string' && /^https?:\/\/[^\s"'<>]+$/.test(fromServer)) return fromServer;
  const root = new URL('../../', location.href);
  return `${root.origin}${root.pathname}?gift=${formatCode(code)}`;
}

const dateText = value => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'long', year: 'numeric' }).format(date);
};

const count = value => new Intl.NumberFormat('en-US').format(value);

async function request(method, path, body) {
  try {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store'
    });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, data: data && typeof data === 'object' ? data : {} };
  } catch (_) {
    return { ok: false, status: 0, data: {}, offline: navigator.onLine === false };
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.append(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
    area.remove();
    return ok;
  }
}

function setStatus(node, text, error = false) {
  if (!node) return;
  node.textContent = text;
  node.classList.toggle('is-error', error);
}

/* Views -------------------------------------------------------------------- */

function show(name) {
  Object.entries(view).forEach(([key, node]) => { if (node) node.hidden = key !== name; });
}

function showLoading(text) {
  qs('[data-loading-text]').textContent = text;
  show('loading');
}

const ERRORS = {
  off: ['Gifts can’t be looked up here', 'This copy of the site runs without its API, so there’s no gift to show. Open the link from your email on planner.bemorin.com.'],
  empty: ['Nothing to show yet', 'This page shows a gift link once it’s bought. Open it from the link in your email.'],
  unpaid: ['Your payment is still being confirmed', 'This usually takes a few seconds. Check again in a moment; the gift link will also arrive by email once the payment is confirmed.'],
  noSession: ['We couldn’t find this payment', 'The link may be incomplete. Open your gift page from the link in your email, or ask us and we’ll send your gift link.'],
  paymentsOff: ['Card payments aren’t switched on yet', 'This site can’t confirm card payments yet. If you’ve paid, ask us and we’ll send your gift link.'],
  badCode: ['This gift link looks incomplete', 'A gift code has 12 letters and digits, like ABCD-EFGH-JKLM. Open the page from the link in your email.'],
  refunded: ['This purchase was refunded', 'This link was switched off, and so was Plus on the planners that activated it. If this is a mistake, reply to your receipt email.'],
  revoked: ['This gift was switched off', 'This link was switched off, and so was Plus on the planners that activated it. If this is a mistake, reply to your receipt email.'],
  testPurchase: ['This was a test purchase', 'It was made before payments went live, so it no longer gives a gift link. If you were charged, ask us.'],
  expired: ['This checkout expired', 'It expired before it was paid, so there is no gift for it. Buy the gift again from the landing page.'],
  noGift: ['We couldn’t find this gift', 'Check that you opened the full link from your email. If it still doesn’t work, ask us.'],
  network: ['The server couldn’t be reached', 'Check your connection, then try again.'],
  offline: ['You’re offline', 'Connect to the internet, then try again.'],
  generic: ['Something went wrong', 'Try again in a moment. If it keeps happening, ask us.']
};

function showError(kind, { retry = null, detail = '', about = false } = {}) {
  const [title, text] = ERRORS[kind] || ERRORS.generic;
  qs('[data-error-kicker]').textContent = 'Your gift page';
  qs('[data-error-title]').textContent = title;
  qs('[data-error-text]').textContent = detail || text;
  const button = qs('[data-retry]');
  button.hidden = !retry;
  button.onclick = retry;
  button.textContent = kind === 'unpaid' ? 'Check again' : 'Try again';
  qs('[data-plus-open]').hidden = true;
  qs('[data-about]').hidden = !about;
  show('error');
  qs('[data-error-title]').focus({ preventScroll: true });
}

const failure = (result, retry) => {
  if (result.status === 0) return showError(result.offline ? 'offline' : 'network', { retry });
  return showError('generic', { retry, detail: typeof result.data.error === 'string' ? result.data.error : '' });
};

function showPlus(checkout) {
  qs('[data-error-kicker]').textContent = 'Daily Planner Plus';
  qs('[data-error-title]').textContent = 'Your Plus is ready';
  qs('[data-error-text]').textContent = 'This payment was for Daily Planner Plus for one person. Open your planner on the device you use, and Plus is activated there.';
  qs('[data-retry]').hidden = true;
  const open = qs('[data-plus-open]');
  open.href = `../../?purchase=${encodeURIComponent(checkout)}`;
  open.hidden = false;
  qs('[data-about]').hidden = true;
  show('error');
  qs('[data-error-title]').focus({ preventScroll: true });
}

/* The gift ----------------------------------------------------------------- */

function readGift(data) {
  const number = value => (Number.isFinite(Number(value)) ? Math.max(0, Math.round(Number(value))) : 0);
  return {
    org: typeof data.org === 'string' ? data.org : '',
    message: typeof data.message === 'string' ? data.message : '',
    seats: number(data.seats),
    redeemed: number(data.redeemed),
    available: data.available !== false,
    status: typeof data.status === 'string' ? data.status : '',
    expiresAt: typeof data.expiresAt === 'string' ? data.expiresAt : '',
    // Switched off after a refund, a dispute or by the owner (Plus was switched off where it was activated too).
    revoked: data.revoked === true,
    // 'gift-1', 'family-5', a team tier, or '' for a gift made in the dashboard;
    // left out by an older server (the number of seats decides then).
    ...(typeof data.plan === 'string' ? { plan: data.plan } : {})
  };
}

/* Words for whom the gift is for ------------------------------------------- */

const COPY = {
  team: {
    lead: 'Forward the link below to your people. Each person who opens it activates Daily Planner Plus for life on their own planner. No accounts, no names collected.',
    about: 'This is your gift page: a private page with your gift link, the seats used and the message your team sees. Its link is also in your email.',
    linkFine: 'Share it only with the people it’s for: whoever opens it uses a seat.',
    promptBefore: 'Before you forward it, ',
    promptLink: 'add your company name',
    seatsTitle: 'Seats used',
    messageTitle: 'What people see',
    messageFine: 'Shown with the gift when someone opens the link.',
    fromLabel: 'From',
    fromPlaceholder: 'Your company name',
    orgPrompt: 'Add your company name before you forward the link: people see it as “A gift from …” when they open it.',
    orgPromptLocked: 'No company name yet. To add it before you forward the link, open this page from the link in your email.',
    nameMissing: 'Enter the name people will see.',
    forwardTitle: 'Ready to forward',
    chatLabel: 'Slack or Teams',
    ownTitle: 'Your own planner',
    ownText: 'To get Plus yourself, open the gift link too: it uses one seat, like everyone else’s.',
    ownLabel: 'Open your own planner',
    ownHref: '../../'
  },
  one: {
    lead: 'Send this link to the person you’re giving Plus to. When they open it, Daily Planner Plus is theirs for life, on their own planner. No account needed.',
    about: 'This is your gift page: a private page with the gift link, whether it has been opened, and what they see with the gift. Its link is also in your email.',
    linkFine: 'Send it only to the person it’s for: the first person to open it gets Plus.',
    promptBefore: 'Before you send it, ',
    promptLink: 'add your name',
    seatsTitle: 'Opened',
    messageTitle: 'What they see',
    messageFine: 'Shown with the gift when they open the link.',
    fromLabel: 'From (shown with the gift)',
    fromPlaceholder: 'Your name',
    orgPrompt: 'Add your name before you send the link: they see it as “A gift from …” when they open it.',
    orgPromptLocked: 'No name yet. To add yours before you send the link, open this page from the link in your email.',
    nameMissing: 'Enter the name they will see.',
    forwardTitle: 'Ready to send',
    chatLabel: 'Message',
    ownTitle: 'Plus for yourself',
    ownText: 'This link is for the person you’re giving it to. To have Plus on your own planner too, get it for yourself.',
    ownLabel: 'Get Plus',
    ownHref: '../#pricing'
  },
  family: {
    lead: 'Send this link to your family. Each person who opens it gets Daily Planner Plus for life, on their own planner. No accounts needed.',
    about: 'This is your gift page: a private page with the gift link, how many people have opened it, and what they see with the gift. Its link is also in your email.',
    linkFine: 'Share it only with your family: each person who opens it uses one of the places.',
    promptBefore: 'Before you send it, ',
    promptLink: 'add your name',
    seatsTitle: 'People who opened it',
    messageTitle: 'What they see',
    messageFine: 'Shown with the gift when someone opens the link.',
    fromLabel: 'From (shown with the gift)',
    fromPlaceholder: 'Your name',
    orgPrompt: 'Add your name before you send the link: they see it as “A gift from …” when they open it.',
    orgPromptLocked: 'No name yet. To add yours before you send the link, open this page from the link in your email.',
    nameMissing: 'Enter the name they will see.',
    forwardTitle: 'Ready to send',
    chatLabel: 'Message',
    ownTitle: 'Your own planner',
    ownText: 'To get Plus yourself, open the gift link too: it counts as one of the places.',
    ownLabel: 'Open your own planner',
    ownHref: '../../'
  }
};

const audience = () => giftAudience(state.gift);
const copy = () => COPY[audience()] || COPY.team;

function renderAudience() {
  const words = copy();
  const text = (selector, value) => { const node = qs(selector); if (node) node.textContent = value; };
  text('[data-ready-lead]', words.lead);
  text('[data-ready-about]', words.about);
  text('[data-link-fine]', words.linkFine);
  text('[data-prompt-before]', words.promptBefore);
  text('[data-prompt-link]', words.promptLink);
  text('[data-seats-title]', words.seatsTitle);
  text('[data-message-title]', words.messageTitle);
  text('[data-message-fine]', words.messageFine);
  text('[data-org-label]', words.fromLabel);
  text('[data-forward-title]', words.forwardTitle);
  text('[data-chat-label]', words.chatLabel);
  text('[data-own-title]', words.ownTitle);
  text('[data-own-text]', words.ownText);
  text('[data-own-label]', words.ownLabel);
  const own = qs('[data-own-link]');
  if (own) own.href = words.ownHref;
  qs('[data-message-form]').elements.org.autocomplete = audience() === 'team' ? 'organization' : 'name';
}

// The name people see, or none yet: the buyer typed no company at checkout.
const companyName = gift => (isDefaultCompany(gift.org) ? '' : gift.org.trim());

function forwardEmail(gift) {
  const kind = audience();
  if (kind !== 'team') {
    const name = companyName(gift);
    const family = kind === 'family';
    return {
      subject: family ? 'A gift for the family: Daily Planner Plus' : 'A gift for you: Daily Planner Plus',
      body: [
        family ? 'Hi all,' : 'Hi,',
        '',
        `I’m giving ${family ? 'each of you' : 'you'} Daily Planner Plus: a calm planner for your days, your weeks and your year, with a guided session to plan the year ahead and a one-page review of the year.`,
        '',
        'Open this link on the device you plan on, and Plus is activated on your planner, for life:',
        state.url,
        '',
        `There’s no account to create and nothing to install. Your planner stays private: it lives in your own browser${family ? ', and nobody else can see it' : ''}.`,
        '',
        'Happy planning!',
        ...(name ? [name] : [])
      ].join('\n')
    };
  }
  const org = companyName(gift) || 'our company';
  return {
    subject: `A year-end gift from ${org}: Daily Planner Plus`,
    body: [
      'Hi everyone,',
      '',
      `To thank you for this year, ${org} is giving each of you Daily Planner Plus: a calm planner for your days, your weeks and your year, with a guided session to plan the year ahead and a one-page review of the year.`,
      '',
      'Open this link on the device you plan on, and Plus is activated on your planner, for life:',
      state.url,
      '',
      `There’s no account to create and nothing to install. Your planner stays private: it lives in your own browser, and nobody at ${org} can see it.`,
      '',
      'Happy planning!'
    ].join('\n')
  };
}

function forwardChat() {
  const kind = audience();
  if (kind === 'team') return `Our year-end gift to everyone: Daily Planner Plus, a private planner for your days and your year. Open this link to activate it on your planner, for life (no account needed): ${state.url}`;
  return `I’m giving ${kind === 'family' ? 'each of you' : 'you'} Daily Planner Plus, a private planner for your days and your year. Open this link to activate it on your planner, for life (no account needed): ${state.url}`;
}

function renderSeats() {
  const gift = state.gift;
  qs('[data-redeemed]').textContent = count(gift.redeemed);
  qs('[data-seats]').textContent = count(gift.seats);
  const share = gift.seats ? Math.min(1, gift.redeemed / gift.seats) : 0;
  qs('[data-meter]').style.width = `${Math.round(share * 1000) / 10}%`;
  const left = Math.max(0, gift.seats - gift.redeemed);
  const until = dateText(gift.expiresAt);
  const expired = gift.expiresAt && Date.parse(gift.expiresAt) < Date.now();
  const kind = audience();
  const untilText = until ? ` · Can be activated until ${until}` : '';
  let note;
  if (gift.revoked) note = 'This link was switched off, and so was Plus on the planners that activated it.';
  else if (gift.status === 'inactive') note = 'This link has been switched off. Plus stays on every planner where it was activated; write to us to switch it back on.';
  else if (expired) note = `This link expired on ${until}. Plus stays on every planner where it was activated.`;
  else if (kind === 'one') note = gift.redeemed ? 'Opened: Plus is active on their planner.' : `Not opened yet${untilText}`;
  else if (!gift.available) note = 'Fully claimed: the link no longer activates Plus. Plus stays on every planner where it was activated.';
  else if (kind === 'family') note = `${count(left)} ${left === 1 ? 'place' : 'places'} left${untilText}`;
  else note = `${count(left)} ${left === 1 ? 'seat' : 'seats'} left${untilText}`;
  qs('[data-seats-note]').textContent = note;
}

function renderForward() {
  const email = forwardEmail(state.gift);
  qs('[data-forward="email"]').textContent = `Subject: ${email.subject}\n\n${email.body}`;
  qs('[data-forward="chat"]').textContent = forwardChat();
}

function renderMessageForm() {
  const form = qs('[data-message-form]');
  form.elements.org.value = companyName(state.gift);
  form.elements.message.value = state.gift.message;
  qs('[data-message-count]').textContent = `${form.elements.message.value.length}/${MESSAGE_MAX}`;
  const locked = !state.key;
  [form.elements.org, form.elements.message, qs('[data-save]', form)].forEach(node => { node.disabled = locked; });
  qs('[data-message-locked]', form).hidden = !locked;
  renderCompanyPrompt();
}

// No company name yet: people would read “A gift from Your company”. Point
// at the From field until a name is saved.
function renderCompanyPrompt() {
  const missing = !companyName(state.gift);
  const field = qs('[data-org-field]');
  field.classList.toggle('is-prompt', missing);
  qs('[data-org-prompt]').hidden = !missing;
  qs('[data-org-prompt-text]').textContent = state.key ? copy().orgPrompt : copy().orgPromptLocked;
  qs('[data-link-prompt]').hidden = !missing || !state.key;
  const input = qs('[data-message-form]').elements.org;
  input.placeholder = missing ? copy().fromPlaceholder : '';
  input.setAttribute('aria-describedby', missing ? 'org-prompt org-hint' : 'org-hint');
}

function readyTitle(gift) {
  // A team gift is "for" the company; a personal gift's name is the giver's.
  const name = audience() === 'team' ? companyName(gift) : '';
  qs('[data-ready-title]').textContent = name ? `Your gift for ${name} is ready` : 'Your gift is ready';
  document.title = name ? `Your gift page, ${name} — Daily Planner` : 'Your gift page — Daily Planner';
}

/* The partner program, once per device ------------------------------------- */

function renderPartnerHint() {
  const hint = qs('[data-partner-hint]');
  if (!hint) return;
  // The partner program's terms (PARTNER_PROGRAM in src/lib/pricing.js).
  qs('[data-partner-text]', hint).textContent = partnerInvitation(PARTNER_PROGRAM.rate);
  hint.hidden = !partnerHintShown('gift');
}

function showReady() {
  const gift = state.gift;
  renderAudience();
  renderPartnerHint();
  readyTitle(gift);
  qs('[data-gift-url]').value = state.url;
  renderSeats();
  renderForward();
  renderMessageForm();
  show('ready');
  qs('[data-ready-title]').focus({ preventScroll: true });
}

/* Loading a gift ----------------------------------------------------------- */

async function claim(checkout, attempt = 0) {
  showLoading(attempt ? 'Your payment is still being confirmed…' : 'Confirming your payment…');
  // `expect: 'gift'`: a Plus payment opened here is not activated (that would use one of its
  // activations for nothing); the page sends the buyer to the planner instead.
  const result = await claimPurchase(checkout, { expect: 'gift' });
  const data = result;
  if ((result.ok || result.status === 409) && data.kind === 'plus') return showPlus(checkout);
  if (result.ok && data.kind === 'gift' && normalizeCode(data.code)) {
    state.code = normalizeCode(data.code);
    state.key = KEY_RE.test(String(data.manageKey || '')) ? String(data.manageKey).toLowerCase() : '';
    state.url = giftUrl(state.code, data.url);
    state.gift = readGift(data);
    // From now on the address is the gift page link: a reload or a bookmark
    // reads the gift instead of claiming the payment again.
    const next = state.key ? `?gift=${formatCode(state.code)}&key=${state.key}` : `?gift=${formatCode(state.code)}`;
    try { history.replaceState(null, '', `${location.pathname}${next}`); } catch (_) { /* sandboxed */ }
    return showReady();
  }
  if (result.ok) return showError('generic');
  if (result.status === 402) {
    if (attempt < RETRY_DELAYS.length) {
      window.setTimeout(() => claim(checkout, attempt + 1), RETRY_DELAYS[attempt]);
      return undefined;
    }
    return showError('unpaid', { retry: () => claim(checkout, 0) });
  }
  if (result.status === 404) return showError('noSession');
  if (result.status === 410 && result.refunded) return showError('refunded');
  if (result.status === 410 && result.revoked) return showError('revoked');
  if (result.status === 410) return showError(result.expired ? 'expired' : 'testPurchase', { detail: typeof result.error === 'string' ? result.error : '' });
  if (result.status === 503) return showError('paymentsOff');
  if (result.status === 0) return showError(result.offline ? 'offline' : 'network', { retry: () => claim(checkout, attempt) });
  return showError('generic', { retry: () => claim(checkout, attempt), detail: typeof result.error === 'string' ? result.error : '' });
}

async function load(code) {
  showLoading('Getting your gift…');
  const result = await request('GET', `/gifts/${code}`);
  if (result.ok) {
    state.gift = readGift(result.data);
    return showReady();
  }
  if (result.status === 404) return showError('noGift');
  return failure(result, () => load(code));
}

/* Actions ------------------------------------------------------------------ */

function setupActions() {
  const linkStatus = qs('[data-link-status]');
  qs('[data-copy-link]').addEventListener('click', async () => {
    const ok = await copyText(state.url);
    setStatus(linkStatus, ok ? 'Link copied. Paste it into an email or a chat.' : 'Copy didn’t work here. Select the link and copy it.', !ok);
    if (ok) trackEvent('gift_link_copied');
    else qs('[data-gift-url]').select();
  });
  qs('[data-gift-url]').addEventListener('focus', event => event.target.select());

  const forwardStatus = qs('[data-forward-status]');
  qsa('[data-copy]').forEach(button => button.addEventListener('click', async () => {
    const kind = button.dataset.copy;
    const text = qs(`[data-forward="${kind}"]`).textContent;
    const ok = await copyText(text);
    setStatus(forwardStatus, ok ? `${kind === 'email' ? 'Email' : 'Message'} copied.` : 'Copy didn’t work here. Select the text and copy it.', !ok);
  }));

  const refresh = qs('[data-refresh]');
  const seatsStatus = qs('[data-seats-status]');
  refresh.addEventListener('click', async () => {
    refresh.disabled = true;
    setStatus(seatsStatus, 'Checking…');
    const result = await request('GET', `/gifts/${state.code}`);
    refresh.disabled = false;
    if (result.ok) {
      const fresh = readGift(result.data);
      state.gift = { ...state.gift, seats: fresh.seats, redeemed: fresh.redeemed, available: fresh.available, status: fresh.status, expiresAt: fresh.expiresAt, revoked: fresh.revoked, ...('plan' in fresh ? { plan: fresh.plan } : {}) };
      renderSeats();
      setStatus(seatsStatus, `Updated at ${new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(new Date())}.`);
    } else {
      setStatus(seatsStatus, result.status === 0 ? 'The server couldn’t be reached. Try again in a moment.' : (result.data.error || 'Couldn’t refresh. Try again in a moment.'), true);
    }
  });

  qs('[data-partner-go]')?.addEventListener('click', () => dismissPartnerHint('gift'));
  qs('[data-partner-dismiss]')?.addEventListener('click', () => {
    dismissPartnerHint('gift');
    qs('[data-partner-hint]').hidden = true;
    qs('[data-own-link]')?.focus({ preventScroll: true });
  });

  const form = qs('[data-message-form]');
  qs('[data-link-prompt] a').addEventListener('click', event => {
    event.preventDefault();
    form.elements.org.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    form.elements.org.focus({ preventScroll: true });
  });
  const counter = qs('[data-message-count]');
  const messageStatus = qs('[data-message-status]');
  form.elements.message.addEventListener('input', () => { counter.textContent = `${form.elements.message.value.length}/${MESSAGE_MAX}`; });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!state.key) return;
    const org = form.elements.org.value.trim();
    const message = form.elements.message.value.trim();
    if (!org) {
      setStatus(messageStatus, copy().nameMissing, true);
      form.elements.org.focus();
      return;
    }
    if (org.length > ORG_MAX || message.length > MESSAGE_MAX) {
      setStatus(messageStatus, `Keep the name under ${ORG_MAX} characters and the message under ${MESSAGE_MAX}.`, true);
      return;
    }
    const save = qs('[data-save]', form);
    save.disabled = true;
    setStatus(messageStatus, 'Saving…');
    const result = await request('PATCH', `/gifts/${state.code}`, { key: state.key, message, org });
    save.disabled = false;
    if (result.ok) {
      state.gift = { ...state.gift, org: typeof result.data.org === 'string' ? result.data.org : org, message: typeof result.data.message === 'string' ? result.data.message : message };
      readyTitle(state.gift);
      renderForward();
      renderCompanyPrompt();
      setStatus(messageStatus, audience() === 'team' ? 'Saved. People see it from now on.' : 'Saved. They see it from now on.');
    } else if (result.status === 403) {
      setStatus(messageStatus, 'This page can’t change the gift. Open it from the gift page link in your email.', true);
    } else if (result.status === 0) {
      setStatus(messageStatus, 'The server couldn’t be reached. Try again in a moment.', true);
    } else {
      setStatus(messageStatus, result.data.error || 'Couldn’t save. Try again in a moment.', true);
    }
  });
}

/* Start -------------------------------------------------------------------- */

function start() {
  // A partner's link that leads here is remembered like on the landing page.
  rememberReferral();
  setupActions();
  if (!apiOn) return showError('off', { about: true });
  const opened = giftPageParams(location.search);
  if (opened.kind === 'checkout') return opened.checkout ? claim(opened.checkout) : showError('noSession');
  if (opened.kind === 'gift') {
    const code = normalizeCode(opened.gift);
    if (!code) return showError('badCode');
    state.code = code;
    state.key = KEY_RE.test(opened.key) ? opened.key.toLowerCase() : '';
    state.url = giftUrl(code);
    return load(code);
  }
  return showError('empty', { about: true });
}

start();
