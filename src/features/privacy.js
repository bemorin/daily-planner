import { qs, qsa } from '../lib/dom.js';
import { esc } from '../lib/text.js';
import { GOOGLE_CLIENT_ID, PLUS_PUBLIC_KEY } from '../config.js';
import { COUNTED_EVENTS, plannerApiEnabled, REFERRAL_DAYS, setUsageCountsEnabled, usageCountsEnabled } from '../lib/planner-api.js';

/**
 * Privacy notice. It is written from how this copy of the planner is
 * configured — owner API, Google Drive sync, or nothing — so it can only
 * describe what the code actually does. Its entry points (Settings, Help,
 * setup, the waitlist and feedback forms) appear only when the owner API is
 * switched on; it also holds the per-device switch for anonymous counts.
 */

/** Pure: the notice's sections for a configuration (unit-tested). */
export function privacyNoticeSections({ plannerApi = false, googleDrive = false, plus = false, events = COUNTED_EVENTS } = {}) {
  const local = [
    'Your plans, journal, Horizon and settings are saved in this browser, on this device. They are never sent to us — not even with feedback.',
    'Backups and exports are files you download and keep yourself.'
  ];
  if (!plannerApi) {
    local.push(googleDrive
      ? 'Apart from Google Drive sync, which only starts when you connect it, this copy of the planner makes no network requests after it has loaded.'
      : 'This copy of the planner makes no network requests after it has loaded.');
  }
  const sections = [{ id: 'local', title: 'Your plans stay in this browser', paragraphs: local }];
  if (plannerApi) {
    sections.push({
      id: 'counts',
      title: 'Anonymous usage counts',
      paragraphs: ['To learn which parts of the planner are used, this copy adds one to a daily count when someone:'],
      list: events.map(([, words]) => words),
      after: ['Each count holds only the name of the moment and the app version. No identifiers, no cookies, your IP address is not stored, and nothing you write in the planner is included.'],
      toggle: true
    });
    sections.push({
      id: 'submissions',
      title: 'Waitlist and feedback',
      paragraphs: [
        'Sent only when you submit them, and they keep working when usage counts are off.',
        'The waitlist stores the email you enter, the devices you tick, your optional note, your browser language, the app version, the date, and that you came from the Google Drive guide.',
        'Waitlist addresses are emailed once, through our email provider, when account sync is ready — and then deleted automatically. You can remove yours at any time from the sync guide (Leave the waitlist).',
        'Feedback stores your rating, the kind of note, your message, the app version, the kind of device (for example “Mac · browser”) and the date — and your email only if you add one.',
        'If you tick “You can quote this on the Daily Planner website”, your rating, your message and the name you chose are also kept as a review that may be published there. Ask and it is deleted.',
        'Either can be deleted on request.'
      ]
    });
    // Any opening of the planner through a partner's link (?ref=CODE) keeps the code and counts the visit, Plus or not.
    sections.push({
      id: 'partners',
      title: 'Partner links',
      paragraphs: [
        `If you open the planner through a partner’s link (one with a code, such as ?ref=), that code is kept in this browser for ${REFERRAL_DAYS} days and sent with a purchase, so the partner is credited. Once the purchase is paid, the code is kept with the sale’s record, so we can see which partners bring sales and pay what they earn. It names the partner, not you.`,
        'A visit through the link is counted once a day, as a daily total per partner code: only the code is sent, with nothing about you, and that partner sees the totals on their private statement. Only a code we know is counted, and nothing is sent when anonymous usage counts are off.'
      ]
    });
    if (plus) {
      sections.push({
        id: 'plus',
        title: 'Daily Planner Plus',
        paragraphs: [
          'Plus is checked on this device, from the licence saved with your planner settings. There is no account.',
          'About once a week, when you are online, the planner asks our server whether its licence is still valid, so Plus can be switched off after a refunded purchase, or back on if that is undone. It sends only the licence (with its random id), nothing else from your planner, and nothing about the request is kept.',
          'Activating a gift sends only the gift code, and a purchase sends only the checkout reference, so the payment can be confirmed. Payments themselves are handled by Creem, our payment provider, on its own page.',
          'With Plus, buying Give Plus or Plus Family also sends your licence, so the server can check it and charge the member price. It is checked for that request only, not stored, and never sent to Creem.',
          'Prices are shown in euros in the euro area and in US dollars elsewhere: the server reads the country of your connection for that one request (from Cloudflare) and never stores it.'
        ]
      });
    }
  }
  if (googleDrive) {
    sections.push({
      id: 'drive',
      title: 'Google Drive sync',
      paragraphs: [
        'Optional. When you connect Google Drive, the planner keeps one hidden file in your own Drive, written directly from this browser. It never passes through or stays on our servers.',
        'Nothing reaches Google until you choose Connect, and you can disconnect in Settings.'
      ]
    });
  }
  return sections;
}

const toggleNote = on => (on
  ? 'On for this browser. Turn it off and nothing is counted from here.'
  : 'Off for this browser — nothing is counted from here.');

export function createPrivacyNotice({ openModal, closeModal, googleDrive = () => !!GOOGLE_CLIENT_ID }) {
  const modal = () => qs('[data-privacy-modal]');
  const root = () => qs('[data-privacy]');
  const available = () => plannerApiEnabled();

  function refreshEntryPoints() {
    const on = usageCountsEnabled();
    qsa('[data-privacy-entry]').forEach(element => { element.hidden = !available(); });
    qsa('[data-privacy-status]').forEach(element => { element.textContent = on ? 'Anonymous usage counts are on' : 'Anonymous usage counts are off'; });
  }

  function render() {
    const on = usageCountsEnabled();
    const toggle = `<label class="privacy-toggle"><span><strong>Send anonymous usage counts</strong><small data-privacy-toggle-note>${esc(toggleNote(on))}</small></span><input class="privacy-switch" type="checkbox" role="switch" data-usage-counts-toggle${on ? ' checked' : ''}></label>`;
    const sections = privacyNoticeSections({ plannerApi: plannerApiEnabled(), googleDrive: googleDrive(), plus: !!PLUS_PUBLIC_KEY }).map(section => `<section class="privacy-section privacy-section--${section.id}">
        <h3>${esc(section.title)}</h3>
        ${section.paragraphs.map(text => `<p>${esc(text)}</p>`).join('')}
        ${section.list ? `<ul class="privacy-moments">${section.list.map(item => `<li>${esc(item)}</li>`).join('')}</ul>` : ''}
        ${(section.after || []).map(text => `<p>${esc(text)}</p>`).join('')}
        ${section.toggle ? toggle : ''}
      </section>`).join('');
    root().innerHTML = `<header class="modal__header"><p class="modal__eyebrow">Privacy</p><h2 id="privacy-title">What this copy of the planner shares</h2><p>Written from how this copy is set up, so it says exactly what it does.</p></header>
      <div class="privacy-sections">${sections}</div>
      <div class="modal__actions"><span></span><div class="modal__actions-right"><button class="primary-button" type="button" data-privacy-done>Done</button></div></div>`;
    qs('[data-usage-counts-toggle]', root())?.addEventListener('change', event => {
      setUsageCountsEnabled(event.target.checked);
      const note = qs('[data-privacy-toggle-note]', root());
      if (note) note.textContent = toggleNote(usageCountsEnabled());
      refreshEntryPoints();
    });
    qs('[data-privacy-done]', root())?.addEventListener('click', () => closeModal(modal()));
  }

  /** Opens above whatever dialog is showing and returns to it when closed. */
  function open() {
    if (!available()) return;
    render();
    openModal(modal(), qs('[data-privacy-done]', root()), { stack: true });
  }

  qsa('[data-privacy-open]').forEach(button => button.addEventListener('click', open));
  refreshEntryPoints();

  return { open, available };
}
