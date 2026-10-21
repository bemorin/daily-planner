import { plannerApiEnabled, rememberReferral, trackEvent } from '../src/lib/planner-api.js';
import { LANDING } from '../welcome/landing-settings.js';
import { EMAIL_RE, configText, emailAddress, qs, qsa, renderFooter, setupTopBar } from '../welcome/page-kit.js';
import { followMotion, motionWanted, setupReveal } from '../welcome/page-motion.js';
import { createRequestForm } from '../welcome/request-form.js';
import { CONTACT_SOURCE, contactTopic } from '../welcome/teams-model.js';

/* ============================================================================
   CONTACT (/contact/): “Ask a question”, the site's one question form —
   anyone's, about the planner, Plus, a purchase or the partner program
   (?topic=partners: its own title and intro, the question started with
   “Partner program: ”). Every “Ask a question” link of the site leads here;
   the Teams page keeps its own form for the team gift.

   The form is welcome/request-form.js in its question-only mode (no kinds,
   no team fields), sent to POST /api/teams like the Teams page's questions;
   without the API it becomes an email to SUPPORT_EMAIL. Beside it, a few
   pointers (Help in the planner, the team gift, the partner program, and the
   privacy address when PRIVACY_EMAIL is set) and, when SUPPORT_EMAIL is set,
   the plain address as another way to write.
   ============================================================================ */

const html = document.documentElement;
const apiOn = plannerApiEnabled();
const track = name => { if (apiOn) trackEvent(name); };

/** An address from the configuration (“<…>” and “Name <…>” too), or '' when it isn't a plain one. */
const configEmail = (...values) => {
  const email = emailAddress(values.find(value => typeof value === 'string' && value.trim()) || '');
  return EMAIL_RE.test(email) ? email : '';
};

/** The plain address under the intro, and the privacy address in the list, when they are set. */
function renderAddresses() {
  const support = configEmail(LANDING.supportEmail, configText('SUPPORT_EMAIL'));
  const alt = qs('[data-support-alt]');
  if (alt && support) {
    const link = qs('[data-support-link]', alt);
    link.href = `mailto:${support}`;
    link.textContent = support;
    alt.hidden = false;
  }
  const privacy = configEmail(configText('PRIVACY_EMAIL'));
  const row = qs('[data-privacy-contact]');
  if (row && privacy) {
    qs('[data-privacy-link]', row).href = `mailto:${privacy}`;
    qs('[data-privacy-address]', row).textContent = privacy;
    row.hidden = false;
  }
}

// A partner's link may lead here too (?ref=CODE): kept like on the other pages, and sent with the question.
if (apiOn) rememberReferral();

createRequestForm({ settings: LANDING, questionsOnly: true, topic: contactTopic(location.search), source: CONTACT_SOURCE });
renderAddresses();
setupTopBar();
renderFooter({ supportEmail: LANDING.supportEmail });
qsa('[data-counts-link]').forEach(link => { link.hidden = !apiOn; });
document.addEventListener('click', event => {
  if (event.target.closest('[data-cta="app"]')) track('landing_cta_app');
});

const motionHooks = [];
setupReveal({ motionOn: motionWanted(), motionHooks });
followMotion(motionHooks);
html.classList.add('js-ready');
