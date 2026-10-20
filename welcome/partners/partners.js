// Imported as a namespace so a value missing from an older config.js reads as
// undefined instead of failing the whole module.
import * as config from '../../src/config.js';
import { checkoutOptions, plannerApiEnabled, rememberReferral, trackEvent } from '../../src/lib/planner-api.js';
import { PERSONAL_GIFTS, PLUS_PRICE, TEAM_TIERS, formatMoney } from '../../src/lib/pricing.js';
import { pageCurrency, readCheckoutOptions } from '../landing-model.js';
import { partnerPage } from './partners-model.js';

/* ============================================================================
   Partners (/welcome/partners/): who the partner program is for, how it works
   and what it pays. Creem runs the program (Growth → Affiliate Hub): partners
   apply there, get their code, and Creem pays them on the 1st and the 15th.

   Build variables (runtime-config.js):
   DAILY_PLANNER_AFFILIATE_URL         the Creem sign-up link behind “Become a
                                       partner”; blank: the landing page's
                                       question form, about the program
   DAILY_PLANNER_AFFILIATE_COMMISSION  the commission as shown (“30%”); blank:
                                       “a commission”, without a number
   ============================================================================ */

const qs = (selector, root = document) => root.querySelector(selector);
const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];
const apiOn = plannerApiEnabled();
const track = name => { if (apiOn) trackEvent(name); };
const page = partnerPage({ url: config.AFFILIATE_URL, commission: config.AFFILIATE_COMMISSION });

function render(currency) {
  const money = value => formatMoney(value, currency);
  qsa('[data-earn]').forEach(node => { node.textContent = page.earn; });
  qsa('[data-earn-short]').forEach(node => { node.textContent = page.short; });
  qsa('[data-commission-figure]').forEach(node => { node.textContent = page.figure; });
  qsa('[data-commission-big]').forEach(node => {
    node.textContent = page.big;
    node.classList.toggle('is-words', !page.commission);
  });
  qsa('[data-commission-of]').forEach(node => { node.textContent = page.of; });
  const prices = { plus: PLUS_PRICE[currency], team: TEAM_TIERS[0]?.price?.[currency], ...Object.fromEntries(PERSONAL_GIFTS.map(gift => [gift.plan, gift.price?.[currency]])) };
  qsa('[data-price]').forEach(node => {
    const value = prices[node.dataset.price];
    if (Number.isFinite(value)) node.textContent = money(value);
  });
  qsa('[data-partner-cta]').forEach(link => {
    link.href = page.href;
    if (page.external) link.rel = 'noopener';
  });
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
track('partners_viewed');
