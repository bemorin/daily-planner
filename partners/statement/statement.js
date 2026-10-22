// Imported as a namespace so a value missing from an older config.js reads as
// undefined instead of failing the whole module.
import * as config from '../../src/config.js';
import { fetchPartnerStatement, plannerApiEnabled } from '../../src/lib/planner-api.js';
import { legalDetails } from '../../legal/legal-details.js';
import { setupTopBar } from '../../welcome/page-kit.js';
import { capLines, capWords, creemRows, formatUnits, payAction, payWords, statementFigures, statementParams, teamLineViews, teamTotals, updatedLabel, visitFigures } from '../statement-model.js';

/* ============================================================================
   A partner's private statement (/partners/statement/#code=CODE&key=KEY):
   the visits their link brought, the purchases made through it, each team
   commission's state, the yearly cap of an individual and how to get paid.
   The key comes with the link the owner sends (signed by the API, see
   server/partners.js statementKey), after `#`: a browser never sends that
   part to a server. The page posts it to /api/partners/statement in the
   body, never in an address, and never stores it. The page sends no
   referrer, counts nothing, and the service worker never caches it (sw.js).
   ============================================================================ */

const qs = (selector, root = document) => root.querySelector(selector);
const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
let params = statementParams(location.hash);
const views = { loading: qs('[data-view="loading"]'), error: qs('[data-view="error"]'), ready: qs('[data-view="ready"]') };
let shown = '';

function show(name) {
  Object.entries(views).forEach(([key, node]) => { if (node) node.hidden = key !== name; });
  if (shown && shown !== name) qs(name === 'ready' ? '[data-view="ready"] h1' : '[data-error-title]')?.focus();
  shown = name;
}

function showError({ title, text, retry = false }) {
  qs('[data-error-title]').textContent = title;
  qs('[data-error-text]').textContent = text;
  qs('[data-retry]').hidden = !retry;
  show('error');
}

const setText = (selector, text) => qsa(selector).forEach(node => { node.textContent = text; });
const supportEmail = () => legalDetails(config).email || '';

function renderFigures(statement) {
  qs('[data-figures]').innerHTML = statementFigures(statement).map(item => `<li><b>${esc(item.figure)}</b><span>${esc(item.label)}</span></li>`).join('');
}

function renderVisits(statement) {
  const figures = visitFigures(statement);
  const list = qs('[data-visits]');
  list.innerHTML = figures
    ? figures.map(item => `<li><b>${esc(item.figure)}</b><span>${esc(item.label)}</span></li>`).join('')
    : '<li class="st-trio__none"><span>Visits aren’t counted yet. They will show here soon.</span></li>';
}

function renderCreem(statement) {
  const rows = creemRows(statement);
  qs('[data-creem]').innerHTML = rows.length
    ? rows.map(row => `<li><span class="st-list__what">${esc(row.label)}${row.note ? `<small>${esc(row.note)}</small>` : ''}</span><b>${esc(row.count)}</b></li>`).join('')
    : '<li class="st-list__none"><span>No purchase through your link yet.</span></li>';
}

function renderTeam(statement) {
  const lines = statement.team || [];
  qs('[data-team]').innerHTML = teamLineViews(statement).map(view => {
    return `<li class="st-line${view.off ? ' is-off' : ''}">
      <span class="st-line__when">${esc(view.soldOn)}</span>
      <span class="st-line__what">${esc(view.what)}</span>
      <span class="st-line__amount">${view.off ? `<s>${esc(view.amount)}</s><span class="sr-only"> (not earned)</span>` : esc(view.amount)}</span>
      <span class="st-line__state"><span class="st-pill st-pill--${esc(view.tone)}">${esc(view.label)}</span><small>${esc(view.detail)}</small></span>
    </li>`;
  }).join('');
  qs('[data-team-empty]').hidden = lines.length > 0;
  const parts = teamTotals(statement);
  qs('[data-team-totals]').innerHTML = parts.map(([label, value]) => `<span><small>${esc(label)}</small><b>${esc(value)}</b></span>`).join('');
  qs('[data-team-totals]').hidden = !parts.length;
}

// The yearly cap, for an individual with team commissions: what is paid this year and what waits above it.
// A business, or nothing yet: no card, and “How you get paid” takes the whole width (it says the rule).
function renderCap(statement) {
  const section = qs('[data-cap]');
  const program = statement.program || {};
  const currencies = [...new Set((statement.team || []).map(line => line.currency).filter(Boolean))];
  const lines = statement.partner === 'business' ? [] : capLines(statement, currencies);
  section.hidden = !lines.length;
  qs('.st-pay').classList.toggle('is-wide', !lines.length);
  qs('[data-cap-lines]').innerHTML = lines.map(line => `<div class="st-capline">
      <p><b>${esc(line.text)}</b></p>
      <span class="mg-meter st-meter${line.share >= 100 ? ' is-full' : ''}" aria-hidden="true"><i style="width:${line.share}%"></i></span>
      ${line.heldText ? `<p class="st-capline__held">${esc(line.heldText)}</p>` : ''}
    </div>`).join('');
  qs('[data-cap-note]').textContent = `As an individual, the team commissions we pay you are capped at ${capWords(program)} a calendar year, by the date paid. Above that, invoice us as a business: a micro-entreprise or a company, in any country.`;
}

function render(statement) {
  const program = statement.program || {};
  setText('[data-code]', statement.code);
  setText('[data-updated]', updatedLabel(statement.generatedAt));
  setText('[data-rate]', `${program.rate ?? 25}%`);
  setText('[data-team-rate]', `${program.teamRate ?? 10}%`);
  setText('[data-cookie-days]', String(program.cookieDays ?? 30));
  setText('[data-minimum]', Object.entries(program.minimumPayout || { EUR: 50, USD: 50 }).map(([code, units]) => formatUnits(units, code)).join(' or '));
  document.title = `${statement.code} · Partner statement — Daily Planner`;
  const link = new URL(`../../welcome/?ref=${encodeURIComponent(statement.code)}`, location.href);
  qs('[data-ref-url]').value = `${link.host}${link.pathname}${link.search}`;
  qs('[data-ref-url]').dataset.full = link.href;
  renderFigures(statement);
  renderVisits(statement);
  renderCreem(statement);
  renderTeam(statement);
  renderCap(statement);
  qs('[data-pay-team]').textContent = payWords(statement, { email: supportEmail() });
  // Bank details and invoices go by email (never through the question form): the button opens one, ready to send.
  const action = payAction(statement, { email: supportEmail() });
  const send = qs('[data-pay-send]');
  send.hidden = !action;
  if (action) { send.href = action.href; send.textContent = action.label; }
  show('ready');
}

async function load() {
  if (!params) {
    showError({ title: 'This link isn’t complete', text: 'Open your statement from the private link we sent you, exactly as it is: it ends with your code and a key. If it still doesn’t open, ask us for your link again.' });
    return;
  }
  if (!plannerApiEnabled()) {
    showError({ title: 'Statements aren’t available here', text: 'This copy of Daily Planner doesn’t run the partner program. Open the link we sent you.' });
    return;
  }
  const result = await fetchPartnerStatement(params);
  if (result.ok && result.statement) { render(result.statement); return; }
  if (result.status === 404) showError({ title: 'This link isn’t valid', text: 'Open your statement from the private link we sent you, exactly as it is. If it still doesn’t open, ask us for your link again: when we send you a new one, the one before stops working.' });
  else if (result.status === 429) showError({ title: 'Too many requests', text: 'Wait a minute, then try again.', retry: true });
  else showError({ title: 'Your statement didn’t load', text: result.status >= 500 || !result.error ? 'Something went wrong on our side. Try again in a moment.' : result.error, retry: true });
}

qs('[data-retry]').addEventListener('click', () => { show('loading'); load(); });
// Another link pasted into this tab: read its code and key.
addEventListener('hashchange', () => { params = statementParams(location.hash); show('loading'); load(); });
qs('[data-refresh]').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  await load();
  button.disabled = false;
});
qs('[data-copy-ref]').addEventListener('click', async () => {
  const input = qs('[data-ref-url]');
  const status = qs('[data-copy-status]');
  try {
    await navigator.clipboard.writeText(input.dataset.full || input.value);
    status.textContent = 'Copied.';
  } catch (_) {
    input.select();
    status.textContent = 'Select the link and copy it.';
  }
  setTimeout(() => { status.textContent = ''; }, 2400);
});

setupTopBar();
load();
