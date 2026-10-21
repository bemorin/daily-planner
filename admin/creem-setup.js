// Creem setup assistant (1.31), mounted by the admin Configuration page:
//   import('./creem-setup.js').then(({ mountCreemSetup }) => mountCreemSetup(container, { call, onUnauthorized }))
// `call(path, init)` is the page's authenticated fetch (it may throw, like
// admin.js's call(), or answer a Response); `onUnauthorized()` signs the page
// out when the session has ended (a 401), as the page's own calls do. When the
// answer to Create never arrives (the connection dropped), the page says that
// something may have been created and asks for Check again. It shows what exists in Creem and
// what would be created (POST admin/creem/setup/plan), creates what is missing
// on an explicit click (admin/creem/setup/apply; live mode asks for a
// confirmation first), then gives the .env lines to paste into the host. A
// webhook's signing secret, when one was just created, is shown once: it lives
// only in this DOM until the owner hides it or leaves the page — never in
// localStorage, sessionStorage or IndexedDB. Styles are scoped to .creem-setup
// and injected once, so the module needs nothing else than ../styles.css.

const STYLE_ID = 'creem-setup-style';
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;
const listText = items => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
const code = value => `<code>${esc(value)}</code>`;
const capital = value => String(value || '').replace(/^./, character => character.toUpperCase());

const PILLS = {
  ok: ['Ready', 'ok'], found: ['Found', 'found'], create: ['To create', 'create'], differs: ['Differs', 'warn'], created: ['Created', 'ok'],
  failed: ['Not created', 'bad'], manual: ['By hand', 'muted'], blocked: ['Needs https', 'bad'], unknown: ['Unknown', 'muted']
};

const CSS = `
.creem-setup { container-type: inline-size; min-width: 0; display: grid; gap: 14px; color: var(--ink); }
.creem-setup [hidden] { display: none; }
.creem-setup__head { display: grid; gap: 6px; }
.creem-setup__title { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
.creem-setup__title > :first-child { margin: 0; font-size: 1.02rem; letter-spacing: -.02em; }
.creem-setup__lede { margin: 0; max-width: 76ch; color: var(--muted); font-size: .8rem; line-height: 1.55; }
.creem-setup code { padding: .08rem .32rem; border-radius: 5px; background: var(--soft); color: var(--ink); font-size: .86em; overflow-wrap: anywhere; }
.creem-setup__mode { display: inline-flex; align-items: center; gap: 6px; min-height: 22px; padding: 1px 10px 1px 8px; border-radius: 999px; font-size: .72rem; font-weight: 680; white-space: nowrap; }
.creem-setup__mode::before { content: ""; width: 7px; height: 7px; border-radius: 999px; background: currentColor; }
.creem-setup__mode.is-test { background: color-mix(in srgb, var(--hz-milestone) 17%, var(--surface-strong)); color: color-mix(in srgb, var(--hz-milestone) 62%, var(--ink)); }
.creem-setup__mode.is-live { background: color-mix(in srgb, var(--danger) 13%, var(--surface-strong)); color: var(--danger); }
.creem-setup__status { margin: 0; color: var(--muted); font-size: .76rem; line-height: 1.5; font-variant-numeric: tabular-nums; }
.creem-setup__error { margin: 0; padding: 10px 14px; border: 1px solid color-mix(in srgb, var(--danger) 35%, var(--line)); border-radius: 12px; background: color-mix(in srgb, var(--danger) 7%, var(--surface-strong)); color: var(--danger); font-size: .82rem; line-height: 1.5; overflow-wrap: anywhere; }
.cs-table { display: grid; border: 1px solid var(--line); border-radius: 12px; background: var(--surface-strong); overflow: hidden; }
.cs-cols { display: none; }
.cs-list { margin: 0; padding: 0; display: grid; list-style: none; }
.cs-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "name state" "code code" "creem creem"; gap: 8px 12px; padding: 13px 14px; border-top: 1px solid color-mix(in srgb, var(--line) 75%, transparent); }
.cs-list > .cs-row:first-child { border-top: 0; }
.cs-row.is-warn, .cs-row.is-bad { box-shadow: inset 3px 0 0 var(--cs-tone); }
.cs-row.is-warn { --cs-tone: var(--hz-milestone); }
.cs-row.is-bad { --cs-tone: var(--danger); }
.cs-name { grid-area: name; min-width: 0; display: grid; gap: 3px; align-content: start; }
.cs-name b { font-size: .86rem; font-weight: 650; }
.cs-name code { justify-self: start; font-size: .7rem; color: var(--muted); }
.cs-code { grid-area: code; }
.cs-creem { grid-area: creem; }
.cs-code, .cs-creem { min-width: 0; display: grid; gap: 4px; align-content: start; font-size: .8rem; line-height: 1.45; }
.cs-label { color: var(--faint); font-size: .66rem; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; }
.cs-small { margin: 0; color: var(--muted); font-size: .74rem; line-height: 1.5; overflow-wrap: anywhere; }
.cs-small.is-warn { color: color-mix(in srgb, var(--hz-milestone) 55%, var(--ink)); }
.cs-small.is-bad { color: var(--danger); }
.cs-id { justify-self: start; }
.cs-none { color: var(--muted); }
.cs-diffs { margin: 2px 0 0; padding: 0; display: grid; gap: 4px; list-style: none; }
.cs-diffs li { position: relative; padding-left: 12px; font-size: .76rem; line-height: 1.45; }
.cs-diffs li::before { content: ""; position: absolute; left: 0; top: .5em; width: 6px; height: 6px; border-radius: 999px; background: var(--hz-milestone); }
.cs-diffs b { font-weight: 650; }
.cs-state { grid-area: state; justify-self: end; align-self: start; }
.cs-pill { display: inline-flex; align-items: center; min-height: 22px; padding: 1px 9px; border-radius: 999px; background: var(--soft); color: var(--muted); font-size: .7rem; font-weight: 680; white-space: nowrap; }
.cs-pill.is-ok { background: color-mix(in srgb, var(--hz-habit) 16%, var(--surface-strong)); color: color-mix(in srgb, var(--hz-habit) 60%, var(--ink)); }
.cs-pill.is-found { background: color-mix(in srgb, var(--accent) 15%, var(--surface-strong)); color: var(--ink); }
.cs-pill.is-create { background: transparent; color: var(--ink); box-shadow: inset 0 0 0 1px var(--line-strong); }
.cs-pill.is-warn { background: color-mix(in srgb, var(--hz-milestone) 18%, var(--surface-strong)); color: color-mix(in srgb, var(--hz-milestone) 55%, var(--ink)); }
.cs-pill.is-bad { background: color-mix(in srgb, var(--danger) 12%, var(--surface-strong)); color: var(--danger); }
.cs-confirm { display: flex; align-items: flex-start; gap: 10px; padding: 12px 14px; border: 1px solid color-mix(in srgb, var(--danger) 35%, var(--line)); border-radius: 12px; background: color-mix(in srgb, var(--danger) 6%, var(--surface-strong)); font-size: .82rem; line-height: 1.5; cursor: pointer; }
.cs-confirm input { flex: 0 0 auto; width: 18px; height: 18px; margin: 1px 0 0; accent-color: var(--danger); cursor: pointer; }
.cs-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; }
.cs-actions .primary-button, .cs-actions .secondary-button { min-height: 38px; padding: 7px 14px; font-size: .78rem; }
.creem-setup .primary-button:disabled, .creem-setup .secondary-button:disabled { opacity: .45; cursor: not-allowed; }
.creem-setup .primary-button:disabled:hover { background: var(--ink); }
.cs-hint { flex: 1 1 260px; margin: 0; color: var(--muted); font-size: .76rem; line-height: 1.5; }
.cs-box { display: grid; gap: 10px; padding: 14px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); }
.cs-box:focus { outline: none; }
.cs-box:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.cs-box > h3, .cs-box > h4 { margin: 0; font-size: .9rem; letter-spacing: -.015em; }
.cs-box p { margin: 0; color: var(--muted); font-size: .8rem; line-height: 1.55; }
.cs-env { margin: 0; padding: 12px 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface-strong); color: var(--ink); font: 500 .78rem/1.7 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre; overflow-x: auto; }
.cs-env:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.cs-env mark { padding: 0 2px; border-radius: 3px; background: color-mix(in srgb, var(--accent) 18%, transparent); color: inherit; }
.cs-row-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.cs-row-actions .secondary-button, .cs-row-actions .text-button { min-height: 34px; padding: 6px 12px; font-size: .76rem; }
.cs-row-actions .text-button { margin-left: -12px; }
.cs-box.is-secret { border-color: color-mix(in srgb, var(--danger) 38%, var(--line)); background: color-mix(in srgb, var(--danger) 6%, var(--surface-strong)); }
.cs-box.is-secret p strong { color: var(--danger); }
.cs-secret { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 8px; align-items: center; }
.cs-secret input { width: 100%; min-width: 0; height: 36px; padding: 0 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface-strong); color: var(--ink); font: 500 .78rem ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.cs-secret .secondary-button { min-height: 36px; min-width: 68px; font-size: .76rem; }
@container (max-width: 420px) {
  .cs-env { padding: 10px 12px; font-size: .7rem; }
  .cs-secret { grid-template-columns: 1fr 1fr; }
  .cs-secret input { grid-column: 1 / -1; }
}
@container (min-width: 760px) {
  .cs-cols, .cs-row { grid-template-columns: minmax(118px, .62fr) minmax(0, 1.25fr) minmax(0, 1.55fr) 104px; grid-template-areas: "name code creem state"; column-gap: 16px; }
  .cs-cols { display: grid; padding: 9px 14px; border-bottom: 1px solid var(--line); background: var(--soft); color: var(--faint); font-size: .66rem; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; }
  .cs-cols span:last-child { text-align: right; }
  .cs-label { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
}
`;

function ensureStyle(doc) {
  if (!doc?.head || doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS.trim();
  doc.head.append(style);
}

/** Copy text; the button says “Copied” for a moment. Falls back to a selected, hidden textarea. */
async function copyText(text, button) {
  let copied = false;
  try {
    await navigator.clipboard.writeText(text);
    copied = true;
  } catch (_) {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
    document.body.append(area);
    area.select();
    try { copied = document.execCommand('copy'); } catch (_) {}
    area.remove();
  }
  if (!button.dataset.label) button.dataset.label = button.textContent;
  button.textContent = copied ? 'Copied' : 'Copy failed';
  clearTimeout(Number(button.dataset.timer));
  button.dataset.timer = String(setTimeout(() => { button.textContent = button.dataset.label; }, 1600));
}

const SESSION_ENDED = 'Your session has ended. Sign in again, then check again.';

/**
 * A Response's JSON or a thrown error, as { data } or { error: { message, reason, status } }. Reasons of
 * this page: 'session' (401), 'lost' (the answer never arrived, or arrived cut off: what the server did is
 * unknown), 'server' (a server failure without our own words); the others are the server's.
 */
async function request(call, path, body) {
  let response;
  try {
    response = await call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  } catch (error) {
    if (error?.kind === 'unauthorized') return { error: { reason: 'session', status: 401, message: SESSION_ENDED } };
    // fetch's TypeError (“Failed to fetch”), an abort, a dropped connection: never shown as such.
    return { error: { reason: 'lost', message: 'The answer didn’t arrive: the connection dropped or the API couldn’t be reached.' } };
  }
  const data = await response.json().catch(() => null);
  if (response.ok && data) return { data };
  if (response.status === 401) return { error: { reason: 'session', status: 401, message: SESSION_ENDED } };
  if (response.ok) return { error: { reason: 'lost', status: response.status, message: 'The answer arrived cut off.' } };
  if (response.status >= 500 && !data?.reason) return { error: { reason: 'server', status: response.status, message: `The server had a problem (HTTP ${response.status}).` } };
  return { error: { reason: data?.reason || 'failed', status: response.status, message: data?.error || `The API answered HTTP ${response.status}.` } };
}

/** After a Create whose answer is unknown: what may have happened, and what to do. */
const unknownOutcome = error => `${error.reason === 'server' ? `The server had a problem while creating (HTTP ${error.status})` : 'The answer to Create didn’t arrive'}, so this page can’t tell what was made: something may have been created. Select Check again to see what Creem has now. If the webhook was created, its signing secret can’t be shown here any more: copy it from Creem → Developers → Webhooks (or rotate it there) into CREEM_WEBHOOK_SECRET, as a Secret, then redeploy.`;

// “Tax included” → “included”, “One-time” → “one-time”: the label already says what it is.
const diffValue = (entry, value) => {
  const text = String(value ?? '');
  if (entry.field === 'tax') return text.replace(/^Tax\s+/i, '');
  return ['billing', 'status'].includes(entry.field) ? text.toLowerCase() : text;
};

function diffLine(entry) {
  if (entry.field === 'marker') return `<li><b>Made for</b> ${code(entry.actual)}: this product carries another product’s reference.</li>`;
  if (entry.field === 'mode') return `<li><b>Mode</b> a ${esc(entry.actual)} product, while the key is in ${esc(entry.expected)} mode</li>`;
  return `<li><b>${esc(entry.label)}</b> ${esc(diffValue(entry, entry.actual))} in Creem, ${esc(diffValue(entry, entry.expected))} in the code</li>`;
}

function envNoteText(slot, mode) {
  if (slot.envNote === 'invalid') return `${code(slot.env)} isn’t a product id (${code('prod_…')}).`;
  if (slot.envNote === 'repeated') return `${code(slot.env)} repeats another product’s id.`;
  if (slot.envNote === 'unknown') return `${code(slot.env)} names ${code(slot.envId)}, which this ${esc(mode)}-mode store doesn’t have.`;
  return '';
}

function productCreemCell(slot, mode) {
  const parts = [];
  const notes = slot.differences.filter(entry => !entry.critical);
  const critical = slot.differences.filter(entry => entry.critical);
  const envNote = envNoteText(slot, mode);
  if (slot.product) parts.push(`<span class="cs-id">${code(slot.product.id)}</span>`);
  if (slot.state === 'ok') parts.push(`<p class="cs-small">Set in ${code(slot.env)}.</p>`);
  if (slot.state === 'found') {
    parts.push(`<p class="cs-small">${slot.source === 'name' ? 'Already in Creem, found by its name.' : 'Already in Creem, made by this assistant.'} The variables below put it in ${code(slot.env)}.</p>`);
  }
  if (slot.state === 'create') parts.push('<span class="cs-none">Not in Creem yet: it will be created.</span>');
  if (slot.state === 'created') parts.push('<p class="cs-small">Created just now.</p>');
  if (slot.state === 'failed') parts.push(`<p class="cs-small is-bad">${esc(slot.error || 'Not created.')}</p>`);
  if (slot.state === 'differs') {
    parts.push(`<ul class="cs-diffs">${critical.map(diffLine).join('')}</ul>`);
    parts.push('<p class="cs-small is-warn">Change it in Creem → Products. The assistant never edits a product, and creates no second one while this one is active.</p>');
  }
  if (envNote) parts.push(`<p class="cs-small">${envNote}</p>`);
  for (const note of notes) {
    if (note.field === 'name') parts.push(`<p class="cs-small">Named “${esc(note.actual)}” in Creem; buyers see that name.</p>`);
    else if (note.field === 'price') parts.push(`<p class="cs-small">Its own price is ${esc(note.actual)}: fine, each gift checkout sends its price.</p>`);
  }
  if (slot.duplicates > 0) parts.push(`<p class="cs-small is-warn">${plural(slot.duplicates, 'other active product carries', 'other active products carry')} the same reference: archive the extra ${slot.duplicates === 1 ? 'one' : 'ones'} in Creem.</p>`);
  return parts.join('');
}

function webhookSecretLine(hook) {
  if (!hook.webhook || !['ok', 'differs'].includes(hook.state)) return '';
  const secret = hook.secret || {};
  if (!secret.set) return `<p class="cs-small is-warn">${code('CREEM_WEBHOOK_SECRET')} isn’t set: copy the signing secret from Creem → Developers → Webhooks into it, as a Secret, then redeploy.</p>`;
  if (secret.matches === true) return `<p class="cs-small">${code('CREEM_WEBHOOK_SECRET')} matches its signing secret.</p>`;
  if (secret.matches === false) return `<p class="cs-small is-bad">${code('CREEM_WEBHOOK_SECRET')} doesn’t match its signing secret: copy the secret from Creem → Developers → Webhooks into it, as a Secret, then redeploy.</p>`;
  return `<p class="cs-small">${code('CREEM_WEBHOOK_SECRET')} is set; it couldn’t be compared with Creem’s.</p>`;
}

function webhookCreemCell(hook, secretShown) {
  const parts = [];
  if (hook.webhook) parts.push(`<span class="cs-id">${code(hook.webhook.id)}</span>`);
  if (hook.state === 'ok') parts.push('<p class="cs-small">Sends the three events to this address.</p>');
  if (hook.state === 'create') parts.push('<span class="cs-none">Not in Creem yet: it will be created, and its signing secret shown once.</span>');
  if (hook.state === 'created') {
    parts.push(secretShown
      ? '<p class="cs-small">Created just now. Copy its signing secret below.</p>'
      : '<p class="cs-small is-warn">Created just now. Creem didn’t send its signing secret here: copy it from Creem → Developers → Webhooks into <code>CREEM_WEBHOOK_SECRET</code>.</p>');
  }
  if (hook.state === 'differs') {
    parts.push(`<ul class="cs-diffs">${hook.differences.map(entry => (entry.field === 'events' ? `<li><b>Events</b> missing ${(entry.missing || []).map(code).join(', ')}</li>` : diffLine(entry))).join('')}</ul>`);
    parts.push('<p class="cs-small is-warn">Change it in Creem → Developers → Webhooks. The assistant never edits a webhook.</p>');
  }
  if (['manual', 'blocked', 'unknown'].includes(hook.state)) parts.push(`<p class="cs-small${hook.state === 'blocked' ? ' is-bad' : ''}">${esc(hook.message)}</p>`);
  if (hook.state === 'unknown') parts.push('<p class="cs-small">Nothing is created for it until Creem answers.</p>');
  if (hook.state === 'failed') parts.push(`<p class="cs-small is-bad">${esc(hook.message || 'Not created.')}</p>`);
  parts.push(webhookSecretLine(hook));
  if (hook.duplicates > 0) parts.push(`<p class="cs-small is-warn">Creem has ${plural(hook.duplicates, 'more endpoint', 'more endpoints')} on this address, so each event arrives ${hook.duplicates + 1} times: delete the extra ${hook.duplicates === 1 ? 'one' : 'ones'} in Creem.</p>`);
  for (const other of hook.others || []) parts.push(`<p class="cs-small">Another Daily Planner webhook points to ${code(other.url)}.</p>`);
  return parts.join('');
}

function pill(state) {
  const [label, tone] = PILLS[state] || [capital(state), 'muted'];
  return `<span class="cs-pill is-${tone}">${esc(label)}</span>`;
}

const rowTone = state => ({ differs: 'warn', failed: 'bad', blocked: 'bad' }[state] || '');

function productRow(slot, mode) {
  const expected = slot.expected;
  const price = expected.priceMatters ? `${esc(expected.priceLabel)} · one-time · tax included` : `${esc(expected.priceLabel)} base price · one-time · tax included`;
  const gift = expected.priceMatters ? '' : '<p class="cs-small">Each gift sets its own price at checkout.</p>';
  return `<li class="cs-row${rowTone(slot.state) ? ` is-${rowTone(slot.state)}` : ''}">
    <div class="cs-name"><b>${esc(slot.label)}</b>${code(slot.env)}</div>
    <div class="cs-code"><span class="cs-label">From the code</span><span>${esc(expected.name)}</span><p class="cs-small">${price}</p>${gift}</div>
    <div class="cs-creem"><span class="cs-label">In Creem</span>${productCreemCell(slot, mode)}</div>
    <div class="cs-state">${pill(slot.state)}</div>
  </li>`;
}

// Which address the webhook is registered at, and why that one.
const SOURCE_NOTES = {
  production: 'The production address (PUBLIC_BASE_URL).',
  local: 'PUBLIC_BASE_URL’s address: this is a local server.',
  preview: 'This page’s own address: a preview with a test key gets its own webhook.'
};

function webhookRow(hook, secretShown) {
  return `<li class="cs-row${rowTone(hook.state) ? ` is-${rowTone(hook.state)}` : ''}">
    <div class="cs-name"><b>Webhook</b>${code('CREEM_WEBHOOK_SECRET')}</div>
    <div class="cs-code"><span class="cs-label">From the code</span><span>${code(hook.url)}</span><p class="cs-small">${esc(SOURCE_NOTES[hook.source] || SOURCE_NOTES.production)}</p><p class="cs-small">${(hook.events || []).map(code).join(', ')}</p></div>
    <div class="cs-creem"><span class="cs-label">In Creem</span>${webhookCreemCell(hook, secretShown)}</div>
    <div class="cs-state">${pill(hook.state)}</div>
  </li>`;
}

/** What Create would make, in words: “2 products and the webhook”. */
function createWords(plan) {
  const products = plan.create.filter(entry => entry !== 'webhook').length;
  const parts = [];
  if (products) parts.push(plural(products, 'product', 'products'));
  if (plan.create.includes('webhook')) parts.push('the webhook');
  return listText(parts);
}

function envHtml(plan, changes, fresh) {
  const lines = String(plan.env || '').trimEnd().split('\n').filter(Boolean);
  const body = lines.map(line => {
    const name = line.split('=')[0];
    return changes.includes(name) ? `<mark>${esc(line)}</mark>` : esc(line);
  }).join('\n');
  const changed = changes.length
    ? `Set ${listText(changes.map(code))} (highlighted); the other lines are already right.`
    : 'Your variables already name these products: nothing to change.';
  const intro = fresh ? 'Paste these lines into your host’s environment variables' : 'The variables for these products. Paste them into your host’s environment variables';
  // CREEM_TEST_MODE=1 is listed only when it is what puts this key in test mode.
  const testMode = plan.testModeLine
    ? ` ${code('CREEM_TEST_MODE=1')} is what sends this key to Creem’s test API (a ${code('creem_test_')} key wouldn’t need it): delete it when you switch to the live key.`
    : plan.mode === 'test' ? ` No ${code('CREEM_TEST_MODE')}: a ${code('creem_test_')} key already means test mode.` : '';
  return `<p>${intro} (Cloudflare Pages → Settings → Variables and Secrets), each as <b>Text</b>, then redeploy. Product ids aren’t secrets. ${changed}${testMode}</p>
    <pre class="cs-env" tabindex="0" aria-label=".env lines">${body}</pre>
    <div class="cs-row-actions"><button class="secondary-button" type="button" data-cs-copy-env>Copy</button></div>`;
}

/**
 * Mount the assistant in `container`. Options: `call` (required), `onUnauthorized` (signs the
 * page out after a 401; without it the assistant says the session has ended), `base` (the API
 * path, default 'admin/creem/setup'), `headingLevel` (2). Checks Creem at once. Answers
 * { refresh, destroy }.
 */
export function mountCreemSetup(container, { call, onUnauthorized = null, base = 'admin/creem/setup', headingLevel = 2 } = {}) {
  if (!container || typeof call !== 'function') throw new Error('mountCreemSetup needs a container and call(path, init).');
  const doc = container.ownerDocument || document;
  ensureStyle(doc);
  const level = Math.min(6, Math.max(2, Number(headingLevel) || 2));
  const sub = Math.min(6, level + 1);
  const section = doc.createElement('section');
  section.className = 'creem-setup';
  section.setAttribute('aria-labelledby', 'creem-setup-title');
  section.innerHTML = `
    <header class="creem-setup__head">
      <div class="creem-setup__title"><h${level} id="creem-setup-title">Set up Creem products</h${level}><span class="creem-setup__mode" data-cs-mode hidden></span></div>
      <p class="creem-setup__lede">Creates the four products and the webhook the site needs, from the prices in the code. It shows what exists first, never edits or deletes anything in Creem, and running it again creates nothing twice.</p>
    </header>
    <p class="creem-setup__status" data-cs-status role="status" aria-live="polite">Checking Creem…</p>
    <p class="creem-setup__error" data-cs-error role="alert" hidden></p>
    <div class="cs-table" data-cs-table hidden>
      <div class="cs-cols" aria-hidden="true"><span>Product</span><span>From the code</span><span>In Creem</span><span>Status</span></div>
      <ul class="cs-list" data-cs-list></ul>
    </div>
    <label class="cs-confirm" data-cs-confirm hidden><input type="checkbox" data-cs-live><span>I understand this creates real products in my <b>live</b> Creem store, where buyers pay.</span></label>
    <div class="cs-actions">
      <button class="primary-button" type="button" data-cs-create disabled>Create the missing products</button>
      <button class="secondary-button" type="button" data-cs-check disabled>Check again</button>
      <p class="cs-hint" data-cs-hint></p>
    </div>
    <div class="cs-box is-secret" data-cs-secret tabindex="-1" hidden></div>
    <div class="cs-box" data-cs-env tabindex="-1" hidden></div>`;
  container.append(section);

  const $ = selector => section.querySelector(selector);
  // `stale`: the last Create's answer never arrived, so the plan on screen may be out of date.
  const state = { plan: null, busy: false, fresh: false, secretShown: false, stale: false, signedOut: false };
  const createButton = $('[data-cs-create]');
  const checkButton = $('[data-cs-check]');
  const liveBox = $('[data-cs-live]');

  const setError = message => {
    const node = $('[data-cs-error]');
    node.textContent = message || '';
    node.hidden = !message;
  };

  function updateActions() {
    const plan = state.plan;
    const todo = plan?.create?.length || 0;
    const live = plan?.mode === 'live';
    $('[data-cs-confirm]').hidden = !(live && todo) || !!plan?.refused || state.stale;
    createButton.hidden = !plan;
    createButton.disabled = state.busy || state.stale || state.signedOut || !!plan?.refused || !todo || (live && !liveBox.checked);
    checkButton.disabled = state.busy || state.signedOut;
    const hint = $('[data-cs-hint]');
    if (!plan) { hint.textContent = ''; return; }
    if (state.stale) { hint.textContent = 'Check again first: the last Create may have made something.'; return; }
    if (plan.refused) { hint.textContent = plan.refused; return; }
    const differs = plan.products.some(slot => slot.state === 'differs') || plan.webhook.state === 'differs';
    const left = differs ? ' What differs is left as it is.' : '';
    const where = plan.create.includes('webhook') ? ` The webhook goes to ${plan.webhook.url}.` : '';
    if (todo) hint.textContent = `Creates ${createWords(plan)} in your ${plan.mode} store.${where}${left}`;
    else hint.textContent = differs ? 'Nothing to create. Fix what differs in Creem, then check again.' : 'Nothing to create: everything the site needs is in Creem.';
  }

  function render() {
    const plan = state.plan;
    const mode = $('[data-cs-mode]');
    if (!plan) {
      $('[data-cs-table]').hidden = true;
      mode.hidden = true;
      updateActions();
      return;
    }
    mode.hidden = false;
    mode.className = `creem-setup__mode is-${plan.mode === 'live' ? 'live' : 'test'}`;
    mode.textContent = plan.mode === 'live' ? 'Live mode · real payments' : 'Test mode · no real payments';
    $('[data-cs-list]').innerHTML = [...plan.products.map(slot => productRow(slot, plan.mode)), webhookRow(plan.webhook, state.secretShown)].join('');
    $('[data-cs-table]').hidden = false;
    const envBox = $('[data-cs-env]');
    const showEnv = state.fresh ? !!plan.env : plan.envComplete && !plan.create.length;
    envBox.hidden = !showEnv;
    if (showEnv) envBox.innerHTML = `<h${sub}>Environment variables</h${sub}>${envHtml(plan, plan.envChanges || [], !!state.fresh)}`;
    updateActions();
  }

  function setStatus(text) {
    const node = $('[data-cs-status]');
    node.textContent = text;
    node.hidden = !text;
  }

  function checkedText(plan) {
    const time = new Date(plan.checkedAt || Date.now()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const ready = plan.products.filter(slot => ['ok', 'found', 'created'].includes(slot.state)).length;
    const hook = ['ok', 'created'].includes(plan.webhook.state) ? 'ready' : 'not ready';
    return `Checked at ${time} · ${ready} of ${plan.products.length} products ready · webhook ${hook}.`;
  }

  /** The session has ended: the page signs out (onUnauthorized), or the assistant says so and stops. */
  function sessionEnded() {
    state.signedOut = true;
    setStatus('');
    if (typeof onUnauthorized === 'function') { onUnauthorized(); return; }
    setError(SESSION_ENDED);
    updateActions();
  }

  async function refresh() {
    if (state.busy || state.signedOut) return;
    state.busy = true;
    state.fresh = false;
    setError('');
    setStatus('Checking Creem…');
    updateActions();
    const { data, error } = await request(call, `${base}/plan`, {});
    state.busy = false;
    if (error) {
      if (error.reason === 'session') { sessionEnded(); return; }
      setStatus('');
      setError(`Couldn’t check Creem. ${error.reason === 'lost' ? 'The API couldn’t be reached. Check the connection, then try again.' : error.reason === 'server' ? `${error.message} Try again in a minute.` : error.message}`);
      if (error.reason === 'no-key') state.plan = null;
      render();
      return;
    }
    state.stale = false;
    state.plan = data;
    if (data.mode !== 'live') liveBox.checked = false;
    setStatus(checkedText(data));
    render();
  }

  function showSecret(secret) {
    const box = $('[data-cs-secret]');
    if (!secret) { box.hidden = true; box.innerHTML = ''; return; }
    box.innerHTML = `<h${sub}>Webhook signing secret · shown once</h${sub}>
      <p><strong>Copy it now</strong> into <code>CREEM_WEBHOOK_SECRET</code>, as a <b>Secret</b> (not Text), then redeploy. It won’t be shown here again; if you lose it, Creem → Developers → Webhooks shows it.</p>
      <div class="cs-secret"><input type="password" readonly autocomplete="off" spellcheck="false" aria-label="Webhook signing secret" data-cs-secret-value><button class="secondary-button" type="button" data-cs-reveal aria-pressed="false">Show</button><button class="secondary-button" type="button" data-cs-copy-secret>Copy</button></div>
      <div class="cs-row-actions"><button class="text-button" type="button" data-cs-hide-secret>I’ve saved it · hide</button></div>`;
    // Set as a property, never through HTML: the value stays out of the markup.
    box.querySelector('[data-cs-secret-value]').value = secret;
    box.hidden = false;
  }

  async function apply() {
    const plan = state.plan;
    if (state.busy || !plan?.create?.length) return;
    if (plan.mode === 'live' && !liveBox.checked) return;
    state.busy = true;
    setError('');
    createButton.textContent = 'Creating…';
    section.setAttribute('aria-busy', 'true');
    updateActions();
    setStatus(`Creating ${createWords(plan)}…`);
    const { data, error } = await request(call, `${base}/apply`, { confirm: true, mode: plan.mode, create: plan.create });
    state.busy = false;
    createButton.textContent = 'Create the missing products';
    section.removeAttribute('aria-busy');
    if (error) {
      if (error.reason === 'session') { sessionEnded(); return; }
      setStatus('');
      if (['lost', 'server'].includes(error.reason)) {
        // What the server did is unknown: say so, and ask for a fresh plan before another Create.
        state.stale = true;
        setError(unknownOutcome(error));
      } else setError(/^Nothing was created/.test(error.message) ? error.message : `Nothing was created. ${error.message}`);
      updateActions();
      checkButton.focus();
      return;
    }
    state.plan = data;
    liveBox.checked = false;
    const made = data.created.filter(entry => entry.slot !== 'webhook').length;
    const hook = data.created.some(entry => entry.slot === 'webhook');
    const words = listText([made ? plural(made, 'product', 'products') : '', hook ? 'the webhook' : ''].filter(Boolean));
    const failed = data.failures.length ? ` ${plural(data.failures.length, 'item wasn’t', 'items weren’t')} created: see the list.` : '';
    state.fresh = words ? `Created ${words} in your ${data.mode} store.${failed}` : `Nothing new was needed: it was all in Creem already.${failed}`;
    state.secretShown = !!data.webhookSecret;
    if (data.webhookSecret) showSecret(data.webhookSecret);
    setStatus(state.fresh);
    if (data.failures.length) setError(data.failures.map(entry => entry.error).join(' '));
    render();
    ($('[data-cs-secret]').hidden ? $('[data-cs-env]') : $('[data-cs-secret]')).focus();
  }

  function onClick(event) {
    const target = event.target.closest('button');
    if (!target || !section.contains(target)) return;
    if (target.matches('[data-cs-check]')) refresh();
    else if (target.matches('[data-cs-create]')) apply();
    else if (target.matches('[data-cs-copy-env]')) copyText(state.plan?.env || '', target);
    else if (target.matches('[data-cs-copy-secret]')) copyText(section.querySelector('[data-cs-secret-value]')?.value || '', target);
    else if (target.matches('[data-cs-reveal]')) {
      const input = section.querySelector('[data-cs-secret-value]');
      const shown = input.type === 'password';
      input.type = shown ? 'text' : 'password';
      target.textContent = shown ? 'Hide' : 'Show';
      target.setAttribute('aria-pressed', String(shown));
    } else if (target.matches('[data-cs-hide-secret]')) {
      showSecret('');
      checkButton.focus();
    }
  }

  section.addEventListener('click', onClick);
  liveBox.addEventListener('change', updateActions);
  refresh();

  return {
    refresh,
    destroy() {
      section.removeEventListener('click', onClick);
      section.remove();
    }
  };
}
