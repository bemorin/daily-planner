import { LANDING_EVENTS, plannerApiEnabled, rememberReferral, setUsageCountsEnabled, trackEvent, usageCountsEnabled } from '../../src/lib/planner-api.js';
import { PARTNER_PROGRAM } from '../../src/lib/pricing.js';
import { countedMoments } from '../landing-model.js';
import { LANDING } from '../landing-settings.js';
import { qs, qsa, renderFooter, setupTopBar } from '../page-kit.js';
import { followMotion, motionWanted, reduceQuery, setupFaq, setupReveal } from '../page-motion.js';
import { createPrivacyDialog } from '../privacy-dialog.js';
import { createRequestForm } from '../request-form.js';
import { createSale, renderPriceLines, setupBuyButtons } from '../sale.js';
import { setupScenes } from '../scenes.js';
import { createTeamOffer } from '../team-offer.js';

/* ============================================================================
   TEAMS (/welcome/teams/): the team gift — what it is, how seats work, its
   prices (Buy online through Creem, or by invoice; a quote above the last
   tier), “Send this to my manager”, the request form “Invoice, quote or
   question” (#request) and the team questions.

   Copy the owner may change: welcome/landing-settings.js (LANDING); the
   prices: src/lib/pricing.js (TEAM_TIERS, TEAM_QUOTE). The pieces are shared
   modules: sale.js (currency, what's on sale, buy buttons), team-offer.js
   (tiers, manager email), request-form.js (the form), scenes.js (the gift
   replica), page-motion.js (entrances and the FAQ).
   ============================================================================ */

const html = document.documentElement;
const apiOn = plannerApiEnabled();
const track = name => { if (apiOn) trackEvent(name); };

// The gift, in three steps: the link in a team chat, one person's planner
// activating it, and the seats used on the buyer's gift page.
const SCRIPTS = {
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

const sale = createSale({ onLoad: () => render() });
const form = createRequestForm({ sale, track, settings: LANDING });
const offer = createTeamOffer({ sale, track, settings: LANDING, openRequest: request => form?.open(request), refresh: () => render() });

/** Everything that follows the currency and what is on sale. */
function render() {
  renderPriceLines(sale);
  offer.render();
  form?.renderPlanOptions();
}

/* Coaches and consultants: a team gift they introduced earns them their share. */
function renderPartnerLine() {
  const rate = PARTNER_PROGRAM.teamRate;
  if (!Number.isFinite(rate) || rate <= 0) return;
  qsa('[data-partner-earn]').forEach(node => { node.textContent = `${rate}% of the team gifts they buy`; });
}

const motionOn = motionWanted();
const motionHooks = [];

// A partner's link may lead here too (?ref=CODE): kept like on the landing page,
// and sent with a purchase or a request.
if (apiOn) rememberReferral();

render();
// Asked at once, so the prices are in the visitor's currency before they
// scroll to them, and never change under their eyes.
sale.load();
renderPartnerLine();
setupBuyButtons(button => offer.buy(button));
setupTopBar();
renderFooter({ supportEmail: LANDING.supportEmail });
createPrivacyDialog({
  dialog: qs('[data-privacy-dialog]'),
  enabled: apiOn,
  moments: countedMoments(LANDING_EVENTS),
  partnerDays: PARTNER_PROGRAM.cookieDays,
  countsEnabled: () => usageCountsEnabled(),
  setCountsEnabled: on => setUsageCountsEnabled(on),
  reduceMotion: () => reduceQuery.matches
});
document.addEventListener('click', event => {
  if (event.target.closest('[data-cta="app"]')) track('landing_cta_app');
});
setupScenes({ scripts: SCRIPTS, motionOn, motionHooks });
setupReveal({ motionOn, motionHooks });
setupFaq();
followMotion(motionHooks);

// Arriving at a part of the page (…/teams/?ask=invoice#request): the prices
// above it were just drawn, so bring it back into view.
let arrived = null;
try { arrived = location.hash.length > 1 ? document.getElementById(decodeURIComponent(location.hash.slice(1))) : null; } catch (_) { arrived = null; }
if (arrived?.closest('main')) arrived.scrollIntoView({ block: 'start' });

html.classList.add('js-ready');
track('teams_viewed');
