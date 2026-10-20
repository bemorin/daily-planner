// Imported as a namespace so a value missing from an older config.js reads as
// undefined instead of failing the whole module.
import * as config from '../../src/config.js';
import { checkoutOptions, plannerApiEnabled, rememberReferral, trackEvent } from '../../src/lib/planner-api.js';
import { pageCurrency, readCheckoutOptions } from '../landing-model.js';
import { motionWanted, reduceQuery, setupFaq, setupReveal } from '../page-motion.js';
import { exampleMonth, formatCents, formatCommission, pageFigures, partnerPage, rateRows } from './partners-model.js';

/* ============================================================================
   Partners (/welcome/partners/): what the partner program pays, how it works,
   its rules and its questions. Creem runs the program for Plus and personal
   gifts (Growth → Affiliate Hub): partners join there, get their code, and
   Creem pays them on the 1st and the 15th. Team gifts earn partners 10%, paid
   by the owner. Every figure comes from PARTNER_PROGRAM and the prices in
   src/lib/pricing.js (./partners-model.js), in the visitor's currency.

   Build variable (runtime-config.js):
   DAILY_PLANNER_AFFILIATE_URL  the Creem sign-up link behind “Become a
                                partner”; blank: the question form on the
                                Teams page, about the program
   ============================================================================ */

const qs = (selector, root = document) => root.querySelector(selector);
const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];
const html = document.documentElement;
const apiOn = plannerApiEnabled();
const track = name => { if (apiOn) trackEvent(name); };
const page = partnerPage({ url: config.AFFILIATE_URL });
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

const setText = (selector, text) => qsa(selector).forEach(node => { if (node.textContent !== text) node.textContent = text; });

function renderRates(currency) {
  const money = cents => formatCents(cents, currency);
  const rows = rateRows(currency);
  const row = item => `<tr><th scope="row">${esc(item.label)}<small>${esc(item.note)}</small></th><td class="num">${esc(money(item.price))}${item.tax ? `<small>${esc(money(item.beforeTax))} before tax</small>` : ''}</td><td class="num"><b>${esc(formatCommission(item.commission, currency))}</b><small>${item.rate}%</small></td></tr>`;
  const group = (label, by) => `<tr class="pt-rates__group"><th scope="colgroup" colspan="2">${esc(label)} <span>· ${esc(by)}</span></th><td></td></tr>`;
  const personal = qs('[data-rates-personal]');
  const team = qs('[data-rates-team]');
  if (personal) personal.innerHTML = group('Plus and personal gifts', 'Creem pays you') + rows.filter(item => !item.team).map(row).join('');
  if (team) team.innerHTML = group('Team gifts', 'we pay you, by bank transfer') + rows.filter(item => item.team).map(row).join('');
}

function renderMonth(currency) {
  const money = cents => formatCommission(cents, currency);
  const month = exampleMonth(currency);
  const lines = qs('[data-month-lines]');
  if (lines) lines.innerHTML = month.lines.map(line => `<li><span class="pt-earn__dot" aria-hidden="true"></span><span>${line.count} × ${esc(line.label)}</span><small>${line.rate}%</small><b>${esc(money(line.amount))}</b></li>`).join('');
  const bar = qs('[data-month-bar]');
  if (bar) bar.innerHTML = month.lines.map(line => `<i style="flex-grow:${Math.max(1, line.amount)}"></i>`).join('');
  setText('[data-month-total]', money(month.total));
  setText('[data-month-split]', `${money(month.byCreem)} paid by Creem · ${money(month.byTransfer)} by bank transfer`);
}

function render(currency) {
  const figures = pageFigures(currency);
  setText('[data-rate]', figures.rate);
  setText('[data-team-rate]', figures.teamRate);
  setText('[data-cookie-days]', figures.cookieDays);
  setText('[data-refund-days]', figures.refundDays);
  setText('[data-minimum]', figures.minimum);
  setText('[data-plus-price]', figures.plusPrice);
  setText('[data-plus-earns]', figures.plusEarns);
  setText('[data-team-earns]', figures.teamEarns);
  setText('[data-tax-where]', figures.taxWhere);
  setText('[data-tax-note]', figures.taxNote);
  const example = qs('[data-plus-example]');
  if (example) {
    example.innerHTML = figures.taxed
      ? `One Plus bought ${esc(figures.taxWhere)}: ${esc(figures.plusPrice)}, of which ${esc(figures.plusTax)} is VAT. You earn <b>${esc(figures.plusEarns)}</b>.`
      : `One Plus bought ${esc(figures.taxWhere)}: ${esc(figures.plusPrice)}. You earn <b>${esc(figures.plusEarns)}</b>.`;
  }
  renderRates(currency);
  renderMonth(currency);
  qsa('[data-partner-cta]').forEach(link => {
    link.href = page.href;
    if (page.external) link.rel = 'noopener';
  });
}

function setupTop() {
  const top = qs('.top');
  if (!top) return;
  const update = () => top.classList.toggle('is-scrolled', window.scrollY > 4);
  update();
  window.addEventListener('scroll', update, { passive: true });
}

// A partner's own link may lead here too (?ref=CODE): kept like on the landing page.
if (apiOn) rememberReferral();
render(pageCurrency(null));
// The prices follow the visitor's country, as on the landing page (the server decides).
if (apiOn) checkoutOptions().then(result => render(pageCurrency(readCheckoutOptions(result)))).catch(() => {});
qsa('[data-counts-link]').forEach(link => { link.hidden = !apiOn; });
document.addEventListener('click', event => {
  if (event.target.closest('[data-partner-cta]')) track('partner_cta_clicked');
});

setupTop();
const motionHooks = [];
setupReveal({ motionOn: motionWanted(), motionHooks });
setupFaq();
reduceQuery.addEventListener?.('change', () => {
  const on = !reduceQuery.matches;
  if (!on) html.classList.remove('js-anim');
  motionHooks.forEach(hook => hook(on));
});
html.classList.add('js-ready');
track('partners_viewed');
