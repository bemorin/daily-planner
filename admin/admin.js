// Owner dashboard for the planner API (server/planner-api.js).
// Sign-in exchanges the admin token (plus an authenticator code when two-factor
// is on) for a signed 8-hour session (POST admin/session). Only that session is
// kept, in sessionStorage for this tab, and sent as a Bearer header; the token
// itself is never stored. Every value rendered here is escaped. Secret values
// (Resend, Creem, Plus signing key) never reach this page: the Setup card
// only says whether they are set. Trends (./trends-view.js) read the daily
// series once per sign-in and again on Refresh. The page carries its own
// version (APP_VERSION) and compares it with the one the API was deployed
// with: when they differ, a banner offers a reload past the caches
// (./version.js). “Needs your attention”, at the top, lists what to act on
// (./attention.js) and marks the cards and rows it points to.

import { ATTENTION_SECTIONS, attentionBySection, attentionNote, attentionWhen, buildAttention, setupChecks } from './attention.js';
import { partnersCardHtml, yearlyCapText } from './partners-view.js';
// Mark as paid: what to check, the amount, the day paid and a reference, in one dialog.
import { openPayoutDialog, parseAmount } from './payout-dialog.js';
// The requests table: a question reads as one, without a team's details.
import { teamRequestsTableHtml } from './requests-view.js';
import { createTrendsView } from './trends-view.js';
import { dayOf, normalizeSeries, seriesWindow } from './trends.js';
// The landing page's stepper (− value +): no browser spin arrows on Seats.
import { createStepper } from '../welcome/stepper.js';
import { compareVersions, readReloadMark, reloadUrl, versionNotice } from './version.js';
// The legal pages' checks (a plain email address, a phone number): Setup says what the pages will leave out.
import { legalDetails, legalEmail, legalValueProblem } from '../legal/legal-details.js';

const SESSION_KEY = 'daily-planner-owner-session';
const LEGACY_TOKEN_KEY = 'daily-planner-owner-token';
const API = (() => {
  const configured = globalThis.__DAILY_PLANNER_CONFIG__?.PLANNER_API_URL;
  return (typeof configured === 'string' && configured.trim() ? configured.trim() : '../api').replace(/\/+$/, '');
})();

const $ = (selector, root = document) => root.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
// A reply link only for plain addresses: nothing that could add ?bcc= or a body to the draft.
const mailLink = email => (/^[^\s?&=%/#@]+@[a-z0-9.-]+$/i.test(String(email || '')) ? `<a href="mailto:${esc(email)}">${esc(email)}</a>` : `<span>${esc(email)}</span>`);
const number = value => new Intl.NumberFormat().format(Number(value) || 0);
const percent = (part, whole) => (whole ? `${Math.round(part / whole * 100)}%` : '—');
const plural = (count, word) => `${word}${Number(count) === 1 ? '' : 's'}`;
const when = iso => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const stars = rating => (rating ? `<span class="owner-stars" aria-label="${rating} out of 5">${'★'.repeat(rating)}<span>${'★'.repeat(5 - rating)}</span></span>` : '<span class="owner-stars"><span>No rating</span></span>');

const APP_CONFIG = globalThis.__DAILY_PLANNER_CONFIG__ || {};
// A team order a partner introduced earns them this share (PARTNER_PROGRAM.teamRate, from the API's summary).
let TEAM_RATE = 10;
// The program as the API last said it (its individual yearly cap, for the status switch's words).
let PARTNER_PROGRAM_SEEN = { individualYearlyCap: { EUR: 300, USD: 300 } };
const CURRENCIES = [{ value: 'EUR', label: 'EUR (€)' }, { value: 'USD', label: 'USD ($)' }, { value: '', label: 'No currency' }];
const GIFT_STATUS_LABELS = { available: 'Open', claimed: 'Fully claimed', expired: 'Expired', inactive: 'Switched off' };
const day = iso => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const PERIODS = [{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }, { value: '365', label: '12 months' }];
const CHECK_SVG = '<svg class="option-check" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="m6.5 12.5 3.3 3.3 7.7-8"/></svg>';
const people = count => `${number(count)} ${Number(count) === 1 ? 'person' : 'people'}`;
const SIGNED_OUT_MESSAGE = 'Your session has ended. Please sign in again.';
const SIGN_IN_FAILED_MESSAGE = 'Sign-in failed. Check the token and the code, then try again.';
const UPDATE_API_MESSAGE = 'Update the API to see trends: this one does not answer admin/series yet (added in 1.21).';
const SOURCE_LABELS = { creem: 'Paid online', stripe: 'Paid online (Stripe)', manual: 'Invoice / manual' };
// This page's own release, kept in step with package.json and src/config.js
// (tests/admin-version.test.js). Not imported: it must come from this very
// file, so an old cached admin.js shows its old number.
const APP_VERSION = '1.33.1';
// What Reload fetches again past the browser cache before opening the page anew.
const DASHBOARD_FILES = ['./', './admin.js', './admin.css', './version.js', './attention.js', './partners-view.js', './payout-dialog.js', './requests-view.js', './trends-view.js', './trends.js', './charts.js', '../styles.css', '../runtime-config.js', '../welcome/stepper.js', '../src/vendor/motion.js', '../src/lib/pricing.js', '../legal/legal-details.js', '../src/lib/text.js'];
const RELOAD_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4.5v4h-4"/></svg>';

class ApiError extends Error {
  constructor(kind, message = '') {
    super(message || kind);
    this.kind = kind;
  }
}

// App-style dropdown (the planner's .select-trigger + .app-popover list):
// a button with aria-haspopup="listbox" opens a list of options. Arrow keys,
// Home/End, Enter/Space, Escape, Tab and a click outside all behave like a
// native select. Only one list is open at a time.
let openDropdown = null;

function createDropdown(trigger, { items = [], value = '', onChange = () => {} } = {}) {
  const valueLabel = $('.select-trigger__value', trigger);
  const listId = `${trigger.id}-list`;
  let options = items;
  let current = String(value);
  let popover = null;

  const render = () => {
    const item = options.find(option => option.value === current);
    valueLabel.textContent = item ? item.label : '';
  };

  function place() {
    const rect = trigger.getBoundingClientRect();
    popover.style.minWidth = `${Math.round(rect.width)}px`;
    const box = popover.getBoundingClientRect();
    const left = Math.min(rect.left, innerWidth - box.width - 8);
    const below = rect.bottom + 6;
    const top = below + box.height > innerHeight - 8 && rect.top - box.height - 6 > 8 ? rect.top - box.height - 6 : below;
    popover.style.left = `${Math.max(8, left)}px`;
    popover.style.top = `${Math.max(8, top)}px`;
  }

  const optionButtons = () => [...popover.querySelectorAll('[role="option"]')];

  function focusOption(index) {
    const buttons = optionButtons();
    if (!buttons.length) return;
    buttons[Math.max(0, Math.min(buttons.length - 1, index))].focus();
  }

  function close({ restoreFocus = false } = {}) {
    if (!popover) return;
    popover.remove();
    popover = null;
    openDropdown = null;
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    removeEventListener('resize', onViewportChange);
    removeEventListener('scroll', onViewportChange, true);
    if (restoreFocus) trigger.focus();
  }

  function choose(next) {
    const changed = next !== current;
    current = next;
    render();
    close({ restoreFocus: true });
    if (changed) onChange(current);
  }

  function onOutside(event) {
    if (!popover?.contains(event.target) && !trigger.contains(event.target)) close();
  }

  function onViewportChange(event) {
    if (event.type === 'scroll' && popover?.contains(event.target)) return;
    close();
  }

  function onListKey(event) {
    const buttons = optionButtons();
    const index = buttons.indexOf(document.activeElement);
    if (event.key === 'ArrowDown') { event.preventDefault(); focusOption(index + 1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); focusOption(index - 1); }
    else if (event.key === 'Home' || event.key === 'PageUp') { event.preventDefault(); focusOption(0); }
    else if (event.key === 'End' || event.key === 'PageDown') { event.preventDefault(); focusOption(buttons.length - 1); }
    else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (index >= 0) choose(options[index].value);
    } else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close({ restoreFocus: true }); }
    // Tab leaves from the trigger, so focus moves on as it would from a select.
    else if (event.key === 'Tab') close({ restoreFocus: true });
  }

  function open(focus = 'selected') {
    if (popover) return;
    openDropdown?.close();
    popover = document.createElement('div');
    popover.className = 'app-popover app-popover--list is-compact owner-popover';
    popover.id = listId;
    popover.setAttribute('role', 'listbox');
    popover.setAttribute('aria-labelledby', trigger.getAttribute('aria-labelledby') || trigger.id);
    popover.innerHTML = options.map((option, index) => {
      const selected = option.value === current;
      return `<button class="popover-option${selected ? ' is-selected' : ''}" type="button" role="option" tabindex="-1" aria-selected="${selected}" data-index="${index}"><span>${esc(option.label)}</span>${selected ? CHECK_SVG : ''}</button>`;
    }).join('');
    popover.addEventListener('click', event => {
      const button = event.target.closest('[role="option"]');
      if (button) choose(options[Number(button.dataset.index)].value);
    });
    popover.addEventListener('keydown', onListKey);
    document.body.append(popover);
    trigger.setAttribute('aria-expanded', 'true');
    trigger.setAttribute('aria-controls', listId);
    openDropdown = api;
    place();
    document.addEventListener('pointerdown', onOutside, true);
    addEventListener('resize', onViewportChange);
    addEventListener('scroll', onViewportChange, true);
    const selectedIndex = Math.max(0, options.findIndex(option => option.value === current));
    focusOption(focus === 'first' ? 0 : focus === 'last' ? options.length - 1 : selectedIndex);
    requestAnimationFrame(() => popover?.classList.add('is-open'));
  }

  trigger.addEventListener('click', () => { if (popover) close({ restoreFocus: true }); else open(); });
  trigger.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      open();
    } else if (event.key === 'Escape' && popover) {
      event.preventDefault();
      close({ restoreFocus: true });
    }
  });

  const api = {
    get value() { return current; },
    setItems(next, fallback = '') {
      options = next;
      if (!options.some(option => option.value === current)) current = fallback;
      render();
      if (popover) close();
    },
    close
  };
  render();
  return api;
}

function readSession() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
    if (typeof saved?.session === 'string' && Number(saved.expiresAt) > Date.now() + 5000) return { session: saved.session, expiresAt: Number(saved.expiresAt) };
  } catch (_) {}
  return null;
}

// An earlier dashboard kept the raw token in this tab; never leave it behind.
try { sessionStorage.removeItem(LEGACY_TOKEN_KEY); } catch (_) {}

let session = readSession();
let expiryTimer = 0;
// The session the trends series was last read for: once per sign-in, and on Refresh.
let seriesSession = null;
const trends = createTrendsView($('[data-owner-trends]'));

function scheduleExpiry() {
  clearTimeout(expiryTimer);
  if (session) expiryTimer = setTimeout(() => signOut(SIGNED_OUT_MESSAGE), Math.max(0, session.expiresAt - Date.now()));
}

function saveSession(value) {
  session = value;
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(value)); } catch (_) {}
  scheduleExpiry();
}

function clearSession() {
  session = null;
  clearTimeout(expiryTimer);
  try { sessionStorage.removeItem(SESSION_KEY); } catch (_) {}
}

async function call(path, { auth = true, ...options } = {}) {
  const headers = { ...(options.headers || {}) };
  if (auth && session) headers.authorization = `Bearer ${session.session}`;
  let response;
  try {
    response = await fetch(`${API}/${path}`, { ...options, headers, cache: 'no-store' });
  } catch (_) {
    throw new ApiError('offline');
  }
  if (response.ok) return response;
  const body = await response.json().catch(() => null);
  if (response.status === 401) throw new ApiError('unauthorized');
  if (response.status === 503 && body?.error) throw new ApiError('setup', body.error);
  // A static server (or a host without the Functions) has no JSON answer.
  if (!body && [404, 405, 501].includes(response.status)) throw new ApiError('offline', `HTTP ${response.status}`);
  throw new ApiError('failed', `${body?.error || 'Request failed'} (HTTP ${response.status}).`);
}

async function jsonOf(response) {
  try { return await response.json(); } catch (_) { throw new ApiError('offline', 'the answer was not JSON'); }
}

// Unauthenticated call: a running, configured API answers 401; a missing
// binding or secret answers 503; anything else means there is no API here.
async function probe() {
  try {
    await jsonOf(await call('admin/summary?days=1', { auth: false }));
  } catch (error) {
    if (error.kind === 'unauthorized') return;
    throw error;
  }
  throw new ApiError('offline', 'unexpected answer');
}

function setNotice(message = '') {
  const notice = $('[data-owner-notice]');
  notice.hidden = !message;
  notice.textContent = message;
}

function show(view) {
  $('[data-owner-checking]').hidden = view !== 'checking';
  $('[data-owner-unavailable]').hidden = view !== 'unavailable';
  $('[data-owner-login]').hidden = view !== 'login';
  $('[data-owner-body]').hidden = view !== 'dashboard';
  $('[data-owner-actions]').hidden = view !== 'dashboard';
}

function showLogin(message = '') {
  show('login');
  const error = $('[data-owner-error]');
  error.hidden = !message;
  error.textContent = message;
  $('[data-owner-login] input[name="token"]').focus();
}

function showUnavailable(error) {
  const target = new URL(`${API}/`, location.href).href;
  const setup = error.kind === 'setup';
  $('[data-owner-unavailable-title]').textContent = setup ? 'The owner API isn’t set up yet.' : 'The owner API isn’t running here.';
  $('[data-owner-unavailable-detail]').textContent = setup
    ? `The API at ${target} answered: “${error.message}”`
    : `Nothing answered at ${target}${error.message && error.message !== 'offline' ? ` (${error.message})` : ''}, so this page is being served without the API.`;
  show('unavailable');
}

function clearRendered() {
  ['[data-owner-kpis]', '[data-owner-funnel]', '[data-owner-team-funnel]', '[data-owner-teams]', '[data-owner-waitlist]', '[data-owner-versions]', '[data-owner-feedback]', '[data-owner-signals]',
    '[data-owner-gifts]', '[data-owner-gift-created]', '[data-owner-gift-panel]', '[data-owner-plus-stats]', '[data-owner-plus-funnel]', '[data-owner-license-created]', '[data-owner-license-list]', '[data-owner-setup]',
    '[data-owner-reviews]', '[data-owner-refunds]', '[data-owner-revocations]', '[data-owner-partners]']
    .forEach(selector => { $(selector).innerHTML = ''; });
  trends.clear();
  seriesSession = null;
  ['[data-owner-gift-created]', '[data-owner-gift-panel]', '[data-owner-license-created]'].forEach(selector => { $(selector).hidden = true; });
  giftRows = [];
  giftPanel = null;
  $('[data-owner-session]').textContent = '';
  openDropdown?.close();
  hideAnnounceConfirm();
  showAnnounceResult('');
  showResult('[data-owner-gift-result]', '');
  showResult('[data-owner-license-result]', '');
  showResult('[data-owner-revoke-result]', '');
  revokedState = { gifts: new Map(), licenses: new Map(), sources: new Set() };
  clearAttention();
}

function signOut(message = '') {
  clearSession();
  clearRendered();
  setNotice('');
  showLogin(message);
}

function handleError(error) {
  if (error?.kind === 'unauthorized') { signOut(SIGNED_OUT_MESSAGE); return; }
  if (error?.kind === 'offline' || error?.kind === 'setup') { showUnavailable(error); return; }
  $('[data-owner-checking]').hidden = true;
  setNotice(error?.message || 'Something went wrong.');
}

function untilLabel(ms) {
  const date = new Date(ms);
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return date.toDateString() === new Date().toDateString() ? time : `${date.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
}

const totalOf = (rows, name) => rows.filter(row => row.name === name).reduce((sum, row) => sum + Number(row.count || 0), 0);

function teamTotals(summary) {
  if (summary.teamRequestTotals) return summary.teamRequestTotals;
  const rows = summary.teamRequests || [];
  return { count: rows.length, seats: rows.reduce((sum, row) => sum + Number(row.teamSize || 0), 0) };
}

function renderKpis(summary, days) {
  const rows = summary.eventTotals;
  const sinceWeek = new Date(Date.now() - 7 * 86400000).toISOString();
  const lastWeek = summary.waitlist.filter(row => row.createdAt >= sinceWeek).length;
  const reachedEnd = totalOf(rows, 'sync_guide_step_3');
  const joined = totalOf(rows, 'waitlist_joined');
  const teams = teamTotals(summary);
  const latest = summary.feedbackByVersion[0];
  const feedbackTotal = summary.feedbackByVersion.reduce((sum, row) => sum + Number(row.count || 0), 0);
  $('[data-owner-kpis]').innerHTML = [
    ['Waitlist sign-ups', number(summary.waitlist.length), `${number(lastWeek)} in the last 7 days`],
    ['Still joined after seeing Drive', percent(joined, reachedEnd), `${number(joined)} of ${number(reachedEnd)} who finished the Drive guide · ${days} days`],
    ['Requests and questions', number(teams.count), summary.teamRequestsUnavailable ? 'Table missing — apply migration 0002' : `${number(teams.seats)} ${plural(teams.seats, 'seat')} requested in total`],
    ['Feedback received', number(feedbackTotal), latest ? `Latest version ${esc(latest.appVersion)}: ${number(latest.count)} ${plural(latest.count, 'response')}` : 'None yet'],
    ['Average rating, latest version', latest?.avgRating != null ? Number(latest.avgRating).toFixed(1) : '—', latest ? `${number(latest.rated)} ${plural(latest.rated, 'rating')} on ${esc(latest.appVersion)}` : 'No ratings yet']
  ].map(([label, value, note]) => `<div class="owner-kpi"><span>${label}</span><strong>${value}</strong><small>${note}</small></div>`).join('');
}

// Stages take one hue, lighter to darker in order (the same ramp as the
// Trends funnels); a side branch stays grey. Values and shares are text.
function funnelHtml(steps, baseLabel, insight) {
  const base = steps[0].value;
  const max = Math.max(1, ...steps.map(step => step.value));
  const stages = steps.filter(step => !step.branch).length;
  let stage = -1;
  const row = step => {
    if (!step.branch) stage += 1;
    const tone = step.branch ? 'owner-funnel__bar--branch' : `trend-tone-${stages > 1 ? Math.round(stage * 4 / (stages - 1)) + 1 : 5}`;
    return `<div class="owner-funnel__row${step.branch ? ' owner-funnel__row--branch' : ''}" title="${esc(`${step.label}: ${step.value} (${percent(step.value, base)} of ${baseLabel})`)}">
      <span class="owner-funnel__label">${esc(step.label)}</span>
      <span class="owner-funnel__value">${number(step.value)}<small>${percent(step.value, base)}</small></span>
      <span class="owner-funnel__track"><span class="owner-funnel__bar ${tone}" style="width:${Math.min(100, Math.round(step.value / max * 100))}%"></span></span>
    </div>`;
  };
  return `${steps.map(row).join('')}${insight}`;
}

function renderFunnel(summary, days) {
  const rows = summary.eventTotals;
  const value = name => totalOf(rows, name);
  const opened = value('sync_guide_opened');
  const reached = value('sync_guide_step_3');
  const driveChosen = value('drive_connect_clicked');
  const joined = value('waitlist_joined');
  const steps = [
    { label: 'Opened “Sync on all my devices”', value: opened },
    { label: 'Reached step 2 (other device)', value: value('sync_guide_step_2') },
    { label: 'Finished the Google Drive guide', value: reached },
    { label: '↳ Chose “Set up Google Drive sync”', value: driveChosen, branch: true },
    { label: 'Opened the waitlist form', value: value('waitlist_form_opened') },
    { label: 'Joined the waitlist', value: joined }
  ];
  const insight = opened
    ? `<p class="owner-insight">Over the last ${days} days, <strong>${number(reached)}</strong> people saw the whole free Google Drive route. <strong>${number(driveChosen)}</strong> went on to set it up and <strong>${number(joined)}</strong> still joined the waitlist (${percent(joined, reached)}).</p>`
    : '<p class="owner-insight">No one has opened the sync guide in this period yet.</p>';
  $('[data-owner-funnel]').innerHTML = funnelHtml(steps, 'openings', insight);
}

function renderTeamFunnel(summary, days) {
  const rows = summary.eventTotals;
  const visits = totalOf(rows, 'landing_viewed');
  const sent = totalOf(rows, 'team_request_sent');
  const manager = totalOf(rows, 'manager_email_opened');
  const steps = [
    { label: 'Landing page visits', value: visits },
    { label: 'Went to the Teams page', value: totalOf(rows, 'landing_cta_teams') },
    { label: 'Opened the team kit form', value: totalOf(rows, 'team_form_opened') },
    { label: 'Sent a request', value: sent },
    { label: '↳ Sent it to a manager', value: manager, branch: true }
  ];
  const insight = visits
    ? `<p class="owner-insight">Over the last ${days} days, <strong>${number(visits)}</strong> landing ${plural(visits, 'visit')} led to <strong>${number(sent)}</strong> team kit ${plural(sent, 'request')} (${percent(sent, visits)}). An email to a manager was opened <strong>${number(manager)}</strong> ${plural(manager, 'time')}.</p>`
    : '<p class="owner-insight">No landing page visits were counted in this period yet.</p>';
  $('[data-owner-team-funnel]').innerHTML = funnelHtml(steps, 'visits', insight);
}

function renderTeams(summary) {
  const target = $('[data-owner-teams]');
  const caption = $('[data-owner-teams-caption]');
  if (summary.teamRequestsUnavailable) {
    caption.textContent = 'Team kit requests, and questions from the “Ask a question” form.';
    target.innerHTML = '<p class="owner-empty">The <code>team_requests</code> table does not exist yet. Apply <code>migrations/0002_team_requests.sql</code> to the D1 database (see <code>docs/FEEDBACK_AND_WAITLIST.md</code>).</p>';
    return;
  }
  const rows = summary.teamRequests || [];
  const totals = teamTotals(summary);
  // A request's partner code says whether it is confirmed (a sale Creem credited, a commission paid) or found to be no partner.
  const codeChecks = summary.partners?.codeChecks || {};
  caption.textContent = totals.count > rows.length
    ? `Latest ${number(rows.length)} of ${number(totals.count)} requests (export CSV for all). Reply by email; delete on request.`
    : 'Team kit requests, and questions from the “Ask a question” form. Reply by email; delete on request.';
  target.innerHTML = rows.length
    ? teamRequestsTableHtml(rows, { codeChecks, teamRate: TEAM_RATE, when, number })
    : '<p class="owner-empty">No requests or questions yet.</p>';
}

function renderVersions(summary) {
  const rows = summary.feedbackByVersion;
  $('[data-owner-versions]').innerHTML = rows.length
    ? `<div class="owner-scroll"><table class="owner-table"><thead><tr><th>Version</th><th class="num">Responses</th><th class="num">Ratings</th><th>Average</th><th>Last</th></tr></thead><tbody>${rows.map(row => `<tr><td><b>${esc(row.appVersion)}</b></td><td class="num">${number(row.count)}</td><td class="num">${number(row.rated)}</td><td>${row.avgRating != null ? `${stars(Math.round(row.avgRating))} ${Number(row.avgRating).toFixed(1)}` : '—'}</td><td>${esc(when(row.lastAt))}</td></tr>`).join('')}</tbody></table></div>`
    : '<p class="owner-empty">No feedback yet.</p>';
  versionFilter.setItems([{ value: '', label: 'All versions' }, ...rows.map(row => ({ value: String(row.appVersion), label: String(row.appVersion) }))]);
}

async function renderFeedback() {
  const version = versionFilter.value;
  const { rows } = await jsonOf(await call(`admin/feedback${version ? `?version=${encodeURIComponent(version)}` : ''}`));
  $('[data-owner-feedback-caption]').textContent = `${rows.length} ${plural(rows.length, 'item')}${version ? ` for ${version}` : ''}`;
  $('[data-owner-feedback]').innerHTML = rows.length
    ? `<div class="owner-feedback-list">${rows.map(row => `<article class="owner-feedback"><div class="owner-feedback__meta"><b>${esc(row.appVersion)}</b>${stars(row.rating)}<span>${esc(row.kind)}</span><span>${esc(row.platform)}</span><span>${esc(when(row.createdAt))}</span>${row.email ? mailLink(row.email) : ''}<button class="text-button text-button--danger owner-feedback__delete" type="button" data-owner-delete-feedback="${Number(row.id)}">Delete</button></div>${row.message ? `<p>${esc(row.message)}</p>` : ''}</article>`).join('')}</div>`
    : '<p class="owner-empty">Nothing here yet.</p>';
}

function renderWaitlist(summary) {
  const rows = summary.waitlist;
  $('[data-owner-waitlist]').innerHTML = rows.length
    ? `<div class="owner-scroll"><table class="owner-table"><thead><tr><th>Email</th><th>Devices</th><th>Note</th><th>Version</th><th>Joined</th><th></th></tr></thead><tbody>${rows.map(row => `<tr><td>${esc(row.email)}</td><td>${esc(String(row.devices || '').split(',').filter(Boolean).join(', ') || '—')}</td><td>${esc(row.note || '')}</td><td>${esc(row.appVersion || '')}</td><td>${esc(when(row.createdAt))}</td><td><button class="text-button text-button--danger" type="button" data-owner-delete="${Number(row.id)}">Delete</button></td></tr>`).join('')}</tbody></table></div>`
    : '<p class="owner-empty">No sign-ups yet.</p>';
}

// Waitlist announcement (POST admin/waitlist/announce). The server sends
// oldest sign-ups first, up to the daily limit, and deletes each address it
// sent; this panel only explains, confirms and reports.
let announceState = { configured: false, testAvailable: false, count: 0, allowance: 0, limit: 100, perSend: 1000 };
let announceBusy = false;
const announceForm = $('[data-owner-announce]');

function prefillAnnouncement() {
  const planner = new URL('../', location.href).href;
  announceForm.elements.subject.value = 'Account sync is ready in Daily Planner';
  announceForm.elements.text.value = `Hi,\n\nYou asked us to email you once when Daily Planner could keep your plans in sync across your devices with an account. It is ready.\n\nOpen the planner and choose “Sync on all my devices” to turn it on:\n${planner}\n\nThank you for waiting,\nBen`;
}

function showAnnounceResult(message, isError = false) {
  const result = $('[data-owner-announce-result]');
  result.hidden = !message;
  result.textContent = message;
  result.classList.toggle('is-error', !!isError);
}

function hideAnnounceConfirm() {
  $('[data-owner-announce-confirm]').hidden = true;
  $('[data-owner-announce-actions]').hidden = false;
}

// One press sends at most this many (oldest first), within the daily limit.
const announceBatch = () => Math.min(announceState.count, announceState.allowance, announceState.perSend);

function renderAnnounce(summary) {
  const limit = Number(summary.emailDailyLimit ?? 100);
  const sentToday = Number(summary.emailsSentToday) || 0;
  const count = summary.waitlist.length;
  const allowance = Math.max(0, limit - sentToday);
  const perSend = Number(summary.emailsPerSend) || 1000;
  announceState = { configured: !!summary.emailConfigured, testAvailable: !!summary.emailTestAvailable, count, allowance, limit, perSend };
  const status = $('[data-owner-announce-status]');
  const send = $('[data-owner-announce-send]');
  const testButton = $('[data-owner-announce-test]');
  const batch = announceBatch();
  if (!announceState.configured) {
    status.innerHTML = 'Email isn’t set up yet. In Cloudflare Pages → Settings → Variables and secrets, add the secret <code>RESEND_API_KEY</code> and <code>EMAIL_FROM</code> (an address on a domain verified in Resend, see Setup), plus <code>OWNER_EMAIL</code> for test sends, then redeploy. Until then, export the CSV, email everyone yourself and delete the rows.';
  } else {
    const parts = [`Sent through Resend, oldest sign-ups first, at most ${number(limit)} emails per day (UTC; every email counts: tests, team notifications and gift emails included).`];
    if (sentToday) parts.push(`${number(sentToday)} sent today.`);
    if (count > batch && batch > 0) parts.push(allowance > batch && count > perSend ? `Up to ${number(perSend)} per send: press Send again for the next ones.` : `${people(count - batch)} will have to wait until tomorrow.`);
    if (!announceState.testAvailable) parts.push('Set OWNER_EMAIL to send yourself a test.');
    status.textContent = parts.join(' ');
  }
  testButton.disabled = announceBusy || !announceState.testAvailable;
  send.disabled = announceBusy || !announceState.configured || !batch;
  send.textContent = !announceState.configured || count === 0 ? (count === 0 ? 'No one to email yet' : 'Send to everyone')
    : allowance === 0 ? 'Daily limit reached — send tomorrow'
      : `Send to ${people(batch)}`;
  if (send.disabled) hideAnnounceConfirm();
}

function readAnnouncement() {
  const subject = announceForm.elements.subject.value.trim();
  const text = announceForm.elements.text.value.trim();
  if (!subject || !text) {
    showAnnounceResult('Add a subject and a message first.', true);
    (subject ? announceForm.elements.text : announceForm.elements.subject).focus();
    return null;
  }
  return { subject, text };
}

function setAnnounceBusy(busy) {
  announceBusy = busy;
  announceForm.setAttribute('aria-busy', String(busy));
  [...announceForm.querySelectorAll('button')].forEach(button => { button.disabled = busy; });
  if (!busy) {
    $('[data-owner-announce-test]').disabled = !announceState.testAvailable;
    $('[data-owner-announce-send]').disabled = !announceState.configured || !announceBatch();
  }
}

function announceResultText(result) {
  const limit = number(result.dailyLimit ?? announceState.limit);
  if (!result.sent && result.limitReached) return `Nothing sent: today’s limit of ${limit} emails is used up. Send the rest tomorrow.`;
  if (!result.sent && !result.remaining) return 'No one is on the waitlist.';
  const head = `Sent to ${people(result.sent)}`;
  if (!result.remaining) return `${head} · the waitlist is now empty.`;
  return result.limitReached
    ? `${head} · ${number(result.remaining)} left — send the rest tomorrow (daily limit ${limit}).`
    : `${head} · ${number(result.remaining)} left — press Send again to continue.`;
}

async function sendAnnouncement(test) {
  const message = readAnnouncement();
  if (!message || announceBusy) return;
  hideAnnounceConfirm();
  setAnnounceBusy(true);
  showAnnounceResult(test ? 'Sending a test…' : 'Sending…');
  let reload = false;
  try {
    const result = await jsonOf(await call('admin/waitlist/announce', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...message, test }) }));
    if (test) showAnnounceResult('Test sent to your OWNER_EMAIL address. Check the inbox (and the spam folder).');
    else showAnnounceResult(`${announceResultText(result)}${result.error ? ` ${result.error}` : ''}`, !!result.error);
    reload = true;
  } catch (error) {
    if (error.kind === 'unauthorized') { setAnnounceBusy(false); handleError(error); return; }
    showAnnounceResult(error.kind === 'offline' ? 'The API could not be reached. Nothing was confirmed as sent; refresh before trying again.' : error.message, true);
    reload = !test;
  }
  setAnnounceBusy(false);
  if (reload) await load();
}

// ---- Shared bits for the Plus cards -------------------------------------------

function showResult(selector, message, isError = false) {
  const result = $(selector);
  if (!result) return;
  result.hidden = !message;
  result.textContent = message;
  result.classList.toggle('is-error', !!isError);
}

function money(amount, currency) {
  if (amount == null || amount === '') return '';
  const value = Number(amount) / 100;
  try {
    return currency ? new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: Number.isInteger(value) ? 0 : 2 }).format(value) : number(value);
  } catch (_) {
    return `${value} ${currency}`;
  }
}

/** Copy text; the button says "Copied" for a moment. Falls back to a hidden textarea. */
async function copyText(text, button) {
  let copied = false;
  try {
    await navigator.clipboard.writeText(text);
    copied = true;
  } catch (_) {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.className = 'owner-offscreen';
    document.body.append(area);
    area.select();
    try { copied = document.execCommand('copy'); } catch (_) {}
    area.remove();
  }
  if (!button) return;
  if (!button.dataset.label) button.dataset.label = button.textContent;
  button.textContent = copied ? 'Copied' : 'Copy failed';
  clearTimeout(Number(button.dataset.timer));
  button.dataset.timer = String(setTimeout(() => { button.textContent = button.dataset.label; }, 1600));
}

/** An http(s) address to link to, or ''. */
function webUrl(value) {
  try {
    const url = new URL(String(value || ''), location.href);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch (_) {
    return '';
  }
}

const copyRow = (label, value) => `<div class="owner-copy-row"><span>${esc(label)}</span><input type="text" readonly value="${esc(value)}" aria-label="${esc(label)}" spellcheck="false"><button class="secondary-button" type="button" data-owner-copy="${esc(value)}">Copy</button></div>`;

// Mutations from the Plus cards: errors stay in the card instead of replacing
// the dashboard, except an ended session, which signs out as everywhere else.
/** A commission, always to the cent, so a column of them lines up. */
function exactMoney(amount, currency) {
  if (amount == null || amount === '') return '';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(amount) / 100);
  } catch (_) {
    return `${(Number(amount) / 100).toFixed(2)} ${currency}`;
  }
}

async function sendJson(path, method, body) {
  return jsonOf(await call(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }));
}

function failureText(error) {
  return error?.kind === 'offline' ? 'The API could not be reached. Check your connection and try again.' : (error?.message || 'Something went wrong.');
}

// ---- Team gifts ---------------------------------------------------------------

let giftRows = [];
let giftPanel = null; // { mode: 'edit' | 'delete', code }
let giftBusy = false;
let emailReady = false;
const SEATS_STEPPER = { min: 1, max: 100000, noun: 'seats', prefix: 'owner-stepper' };
const giftForm = $('[data-owner-gift-form]');
const seatsStepper = createStepper(giftForm.elements.seats, SEATS_STEPPER);
const currencyPicker = createDropdown($('[data-owner-gift-currency]'), { items: CURRENCIES, value: 'EUR' });

function updateGiftEmailSwitch() {
  const toggle = giftForm.elements.sendEmail;
  toggle.disabled = !emailReady;
  if (!emailReady) toggle.checked = false;
  $('[data-owner-gift-email-hint]').textContent = emailReady
    ? 'Sent once: the gift link, the manage link and a message they can forward to their team.'
    : 'Email isn’t set up (see Setup), so copy the links instead.';
}

function giftRowHtml(row) {
  const status = row.status !== 'available' ? `<span class="owner-pill owner-pill--${esc(row.status)}">${esc(GIFT_STATUS_LABELS[row.status] || row.status)}</span>` : '';
  const message = row.message ? `<small class="owner-small owner-quote">“${esc(row.message)}”</small>` : '';
  const buyer = row.buyerEmail ? `<small class="owner-small">${mailLink(row.buyerEmail)}${row.emailedAt ? ` · emailed ${esc(day(row.emailedAt))}` : ''}</small>` : '';
  const note = row.note ? `<small class="owner-small">${esc(row.note)}</small>` : '';
  const amount = row.amount != null ? `<small class="owner-small">${esc(money(row.amount, row.currency))}</small>` : '';
  return `<tr data-owner-attn="gift:${esc(row.code)}">
    <td class="owner-nowrap"><code>${esc(row.code)}</code></td>
    <td class="owner-gift-org"><b>${esc(row.org)}</b>${message}${buyer}${note}</td>
    <td class="num owner-nowrap"><b>${number(row.redeemed)}</b> / ${number(row.seats)}<small class="owner-small">up to ${number(row.limit)}</small>${status}</td>
    <td class="owner-nowrap">${esc(day(row.createdAt))}</td>
    <td class="owner-nowrap">${esc(day(row.expiresAt))}</td>
    <td class="owner-nowrap">${esc(SOURCE_LABELS[row.source] || row.source || SOURCE_LABELS.manual)}${amount}${revokedPill(revokedState.gifts.get(row.code))}</td>
    <td><input class="privacy-switch" type="checkbox" role="switch" data-owner-gift-active="${esc(row.code)}"${row.active ? ' checked' : ''} aria-label="Gift link for ${esc(row.org)} is active"></td>
    <td><div class="owner-row-actions">
      <button class="text-button" type="button" data-owner-copy="${esc(row.url)}">Copy link</button>
      <button class="text-button" type="button" data-owner-copy="${esc(row.manageUrl)}"${row.manageUrl ? '' : ' disabled'}>Copy manage link</button>
      <button class="text-button" type="button" data-owner-gift-edit="${esc(row.code)}">Edit</button>
      ${(row.source || 'manual') === 'manual' ? `<button class="text-button text-button--danger" type="button" data-owner-gift-delete="${esc(row.code)}">Delete</button>` : ''}
    </div></td>
  </tr>`;
}

function renderGifts(summary) {
  const target = $('[data-owner-gifts]');
  const caption = $('[data-owner-gifts-caption]');
  emailReady = !!summary.emailConfigured;
  updateGiftEmailSwitch();
  const intro = 'One link per company. Each activation unlocks Plus for life on one planner; links can be activated for 12 months.';
  if (summary.plusUnavailable) {
    giftRows = [];
    caption.textContent = intro;
    target.innerHTML = '<p class="owner-empty">The <code>gifts</code> and <code>purchases</code> tables do not exist yet. Apply <code>migrations/0003_plus.sql</code> to the D1 database (see <code>docs/FEEDBACK_AND_WAITLIST.md</code>).</p>';
    renderGiftPanel();
    return;
  }
  giftRows = Array.isArray(summary.gifts) ? summary.gifts : [];
  const totals = summary.giftTotals || { count: 0, seats: 0, redeemed: 0, paid: 0 };
  caption.textContent = totals.count
    ? `${number(totals.count)} ${plural(totals.count, 'gift')} · ${number(totals.redeemed)} of ${number(totals.seats)} seats activated · ${number(totals.paid)} bought online. ${intro}`
    : intro;
  target.innerHTML = giftRows.length
    ? `<div class="owner-scroll"><table class="owner-table owner-gifts"><thead><tr><th>Code</th><th>Company</th><th class="num">Activated</th><th>Created</th><th>Expires</th><th>Source</th><th>Active</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${giftRows.map(giftRowHtml).join('')}</tbody></table></div>`
    : '<p class="owner-empty">No gifts yet. Create one above for an invoice; gifts bought online appear here on their own.</p>';
  renderGiftPanel();
}

function renderGiftPanel() {
  const panel = $('[data-owner-gift-panel]');
  const row = giftPanel && giftRows.find(item => item.code === giftPanel.code);
  if (!row) {
    giftPanel = null;
    panel.hidden = true;
    panel.innerHTML = '';
    delete panel.dataset.key;
    return;
  }
  // Keep what the owner is typing when the dashboard refreshes underneath.
  const key = `${giftPanel.mode}:${row.code}`;
  if (panel.dataset.key === key && !panel.hidden) return;
  panel.dataset.key = key;
  panel.hidden = false;
  if (giftPanel.mode === 'delete') {
    panel.innerHTML = `<div class="owner-confirm" role="group" aria-labelledby="owner-gift-delete-text">
      <p id="owner-gift-delete-text">Delete the gift for <b>${esc(row.org)}</b> (<code>${esc(row.code)}</code>, ${number(row.redeemed)} of ${number(row.seats)} activated)? The link stops working at once; people who already activated it keep Plus. This can’t be undone.</p>
      <div class="owner-actions"><button class="primary-button owner-danger" type="button" data-owner-gift-delete-confirm>Yes, delete this gift</button><button class="text-button" type="button" data-owner-gift-panel-cancel>Cancel</button></div>
      <p class="owner-result" data-owner-gift-panel-result role="status" hidden></p>
    </div>`;
    $('[data-owner-gift-panel-cancel]', panel).focus();
    return;
  }
  panel.innerHTML = `<form class="owner-subform" data-owner-gift-edit-form aria-labelledby="owner-gift-edit-title" novalidate>
    <div class="owner-subform__head"><h3 id="owner-gift-edit-title">Edit the gift <code>${esc(row.code)}</code></h3><p>Changes show at once to everyone who opens the link.</p></div>
    <div class="owner-form-grid">
      <label class="form-field"><span>Company</span><input name="org" maxlength="80" autocomplete="off" value="${esc(row.org)}" required></label>
      <label class="form-field"><span>Seats <em>${number(row.redeemed)} activated so far</em></span><input name="seats" type="number" inputmode="numeric" min="1" max="100000" step="1" value="${Number(row.seats)}" required></label>
      <label class="form-field form-field--full"><span>Message to the team</span><textarea name="message" rows="3" maxlength="280">${esc(row.message)}</textarea></label>
      <label class="form-field form-field--full"><span>Private note</span><input name="note" maxlength="500" autocomplete="off" value="${esc(row.note)}"></label>
    </div>
    <div class="owner-actions"><button class="primary-button" type="submit">Save changes</button><button class="text-button" type="button" data-owner-gift-panel-cancel>Cancel</button></div>
    <p class="owner-result" data-owner-gift-panel-result role="status" hidden></p>
  </form>`;
  createStepper($('input[name="seats"]', panel), SEATS_STEPPER);
  $('input[name="org"]', panel).focus();
}

function openGiftPanel(mode, code) {
  giftPanel = { mode, code };
  const panel = $('[data-owner-gift-panel]');
  delete panel.dataset.key;
  renderGiftPanel();
  panel.scrollIntoView({ block: 'nearest' });
}

function closeGiftPanel() {
  const code = giftPanel?.code;
  giftPanel = null;
  renderGiftPanel();
  const button = code && [...document.querySelectorAll('[data-owner-gift-edit]')].find(item => item.dataset.ownerGiftEdit === code);
  button?.focus();
}

function readSeats(input) {
  const seats = Number(input.value);
  return Number.isInteger(seats) && seats >= 1 && seats <= 100000 ? seats : 0;
}

function renderGiftCreated(result) {
  const created = $('[data-owner-gift-created]');
  const gift = result.gift;
  const emailed = result.emailed ? ` · emailed to ${esc(gift.buyerEmail)}` : '';
  created.innerHTML = `<p><b>Gift created for ${esc(gift.org)}</b> · ${people(gift.seats)} (up to ${number(gift.limit)} activations) · until ${esc(day(gift.expiresAt))}${emailed}</p>
    ${copyRow('Gift link', result.url)}
    ${copyRow('Manage link', result.manageUrl)}
    <p class="owner-hint">The gift link is for the company to share with its people. The manage link is for the buyer only: it shows the activations and lets them change the company name and the message.</p>`;
  created.hidden = false;
}

giftForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (giftBusy) return;
  const fields = giftForm.elements;
  const org = fields.org.value.trim();
  const seats = readSeats(fields.seats);
  const { amount, error: amountError } = parseAmount(fields.amount.value);
  const currency = currencyPicker.value;
  const buyerEmail = fields.buyerEmail.value.trim();
  const sendEmail = fields.sendEmail.checked;
  const problem = !org ? ['Add the company name.', fields.org]
    : !seats ? ['Seats must be a whole number between 1 and 100,000.', fields.seats]
      : amountError ? [amountError, fields.amount]
        : amount != null && !currency ? ['Choose the currency of the amount.', $('[data-owner-gift-currency]')]
          : sendEmail && !buyerEmail ? ['Add the buyer’s email address to email the link.', fields.buyerEmail]
            : null;
  if (problem) { showResult('[data-owner-gift-result]', problem[0], true); problem[1].focus(); return; }
  giftBusy = true;
  $('[data-owner-gift-submit]').disabled = true;
  showResult('[data-owner-gift-result]', sendEmail ? 'Creating the gift and emailing the buyer…' : 'Creating the gift…');
  try {
    const result = await sendJson('admin/gifts', 'POST', { org, seats, message: fields.message.value, note: fields.note.value, currency, amount, buyerEmail, sendEmail });
    giftForm.reset();
    seatsStepper.sync(); // reset() fires no input event: refresh the − / + buttons
    updateGiftEmailSwitch();
    renderGiftCreated(result);
    showResult('[data-owner-gift-result]', result.emailError ? `Gift created, but the email was not sent: ${result.emailError}` : '', !!result.emailError);
    await load();
  } catch (error) {
    if (error.kind === 'unauthorized') handleError(error);
    else showResult('[data-owner-gift-result]', failureText(error), true);
  } finally {
    giftBusy = false;
    $('[data-owner-gift-submit]').disabled = false;
  }
});

$('[data-owner-gifts]').addEventListener('click', event => {
  const edit = event.target.closest('[data-owner-gift-edit]');
  if (edit) { openGiftPanel('edit', edit.dataset.ownerGiftEdit); return; }
  const remove = event.target.closest('[data-owner-gift-delete]');
  if (remove) openGiftPanel('delete', remove.dataset.ownerGiftDelete);
});

$('[data-owner-gifts]').addEventListener('change', async event => {
  const toggle = event.target.closest('[data-owner-gift-active]');
  if (!toggle) return;
  const active = toggle.checked;
  toggle.disabled = true;
  try {
    await sendJson(`admin/gifts/${encodeURIComponent(toggle.dataset.ownerGiftActive)}`, 'PATCH', { active });
    showResult('[data-owner-gift-result]', '');
    await load();
  } catch (error) {
    toggle.checked = !active;
    toggle.disabled = false;
    if (error.kind === 'unauthorized') handleError(error);
    else showResult('[data-owner-gift-result]', `The gift was not ${active ? 'switched on' : 'switched off'}. ${failureText(error)}`, true);
  }
});

$('[data-owner-gift-panel]').addEventListener('click', async event => {
  if (event.target.closest('[data-owner-gift-panel-cancel]')) { closeGiftPanel(); return; }
  const confirm = event.target.closest('[data-owner-gift-delete-confirm]');
  if (!confirm || !giftPanel) return;
  confirm.disabled = true;
  try {
    await call(`admin/gifts/${encodeURIComponent(giftPanel.code)}`, { method: 'DELETE' });
  } catch (error) {
    // "failed" here is usually a 404: already deleted. Just refresh.
    if (error.kind !== 'failed') {
      confirm.disabled = false;
      if (error.kind === 'unauthorized') handleError(error);
      else showResult('[data-owner-gift-panel-result]', failureText(error), true);
      return;
    }
  }
  giftPanel = null;
  renderGiftPanel();
  await load();
});

$('[data-owner-gift-panel]').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target.closest('[data-owner-gift-edit-form]');
  if (!form || !giftPanel) return;
  const fields = form.elements;
  const org = fields.org.value.trim();
  const seats = readSeats(fields.seats);
  if (!org) { showResult('[data-owner-gift-panel-result]', 'Add the company name.', true); fields.org.focus(); return; }
  if (!seats) { showResult('[data-owner-gift-panel-result]', 'Seats must be a whole number between 1 and 100,000.', true); fields.seats.focus(); return; }
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    await sendJson(`admin/gifts/${encodeURIComponent(giftPanel.code)}`, 'PATCH', { org, seats, message: fields.message.value, note: fields.note.value });
    giftPanel = null;
    renderGiftPanel();
    await load();
  } catch (error) {
    submit.disabled = false;
    if (error.kind === 'unauthorized') handleError(error);
    else showResult('[data-owner-gift-panel-result]', failureText(error), true);
  }
});

// ---- Plus ---------------------------------------------------------------------

function renderPlus(summary, days) {
  const plus = summary.plus || {};
  const totals = summary.giftTotals || {};
  const missing = !!summary.plusUnavailable;
  const value = count => (missing ? '—' : number(count));
  $('[data-owner-plus-stats]').innerHTML = [
    ['Individual purchases', value(plus.purchases), 'Bought online'],
    ['Gift activations', value(totals.redeemed), `${number(totals.count)} ${plural(totals.count, 'gift')} · ${number(totals.seats)} seats`],
    ['Licences made here', value(plus.manualLicenses), 'Support and giveaways']
  ].map(([label, figure, note]) => `<div class="owner-stat"><span>${esc(label)}</span><strong>${figure}</strong><small>${esc(note)}</small></div>`).join('');
  const rows = summary.eventTotals;
  const opened = totalOf(rows, 'plus_modal_opened');
  const steps = [
    { label: 'Opened the Plus details', value: opened },
    { label: 'Went to buy Plus', value: totalOf(rows, 'plus_checkout_clicked') },
    { label: 'Unlocked Plus (any way)', value: totalOf(rows, 'plus_unlocked') }
  ];
  const giftsOpened = totalOf(rows, 'gift_opened');
  const giftsRedeemed = totalOf(rows, 'gift_redeemed');
  const insight = `<p class="owner-insight">Over the last ${days} days, <strong>${number(giftsOpened)}</strong> ${Number(giftsOpened) === 1 ? 'person' : 'people'} opened a gift link and <strong>${number(giftsRedeemed)}</strong> activated one. <strong>${number(totalOf(rows, 'year_plan_completed'))}</strong> finished planning a year; a year in review was opened <strong>${number(totalOf(rows, 'year_review_opened'))}</strong> ${plural(totalOf(rows, 'year_review_opened'), 'time')}.</p>`;
  $('[data-owner-plus-funnel]').innerHTML = funnelHtml(steps, 'openings', insight);
  const licences = Array.isArray(plus.recentLicenses) ? plus.recentLicenses : [];
  $('[data-owner-license-list]').innerHTML = licences.length
    ? `<div class="owner-list"><h3>Latest licences made here</h3><ul>${licences.map(item => `<li><span>${esc(when(item.createdAt))}</span><span>${esc(item.note || 'No note')}${revokedPill(revokedState.licenses.get(item.id), ' ')}</span><code>${esc(item.id)}</code></li>`).join('')}</ul></div>`
    : '';
}

const licenseForm = $('[data-owner-license-form]');
licenseForm.addEventListener('submit', async event => {
  event.preventDefault();
  const submit = $('[data-owner-license-submit]');
  if (submit.disabled) return;
  submit.disabled = true;
  showResult('[data-owner-license-result]', 'Creating a licence…');
  try {
    const result = await sendJson('admin/licenses', 'POST', { note: licenseForm.elements.note.value });
    licenseForm.reset();
    const created = $('[data-owner-license-created]');
    const link = webUrl(result.url);
    created.innerHTML = `<div class="owner-copy-row owner-copy-row--plain"><span>Licence link</span><input type="text" readonly value="${esc(result.url)}" aria-label="Licence link" spellcheck="false"></div>
      <div class="owner-actions">${link ? `<a class="secondary-button owner-link-button" href="${esc(link)}" target="_blank" rel="noopener">Open in the planner</a>` : ''}<button class="secondary-button" type="button" data-owner-copy="${esc(result.url)}">Copy link</button></div>
      <p class="owner-hint">Opening this link on a device unlocks Plus there — handy to see the planner as a Plus user. Whoever opens it gets Plus for life on that planner, so send it privately.</p>`;
    created.hidden = false;
    showResult('[data-owner-license-result]', '');
    await load();
  } catch (error) {
    if (error.kind === 'unauthorized') handleError(error);
    else showResult('[data-owner-license-result]', failureText(error), true);
  } finally {
    submit.disabled = false;
  }
});

// ---- Refunds and disputes ------------------------------------------------------

const REFUND_REASON_PILLS = { refund: 'Refunded', dispute: 'Disputed', owner: 'Revoked' };
let revokedState = { gifts: new Map(), licenses: new Map(), sources: new Set() };

/** What is revoked right now (summary.revocations): gift codes and licence ids with their reason, and the groups still in force. */
function readRevocations(summary) {
  const rows = Array.isArray(summary.revocations) ? summary.revocations : [];
  revokedState = {
    gifts: new Map(rows.filter(row => row.kind === 'gift').map(row => [row.label, row.reason])),
    licenses: new Map(rows.filter(row => row.kind === 'license').map(row => [row.label, row.reason])),
    sources: new Set(rows.map(row => row.source))
  };
}

// The API says whether a refund's revocations still stand; an older API, from the latest revocations listed.
const inForce = row => (typeof row.inForce === 'boolean' ? row.inForce : revokedState.sources.has(row.id));
const revokedPill = (reason, before = '') => (reason ? `${before}<span class="owner-pill owner-pill--inactive">${esc(REFUND_REASON_PILLS[reason] || 'Revoked')}</span>` : '');

function refundPurchaseHtml(row) {
  if (row.status === 'pending') return `<span class="owner-pill owner-pill--inactive">Waiting</span>${row.transactionId ? `<small class="owner-small">Transaction <code>${esc(row.transactionId)}</code></small>` : ''}`;
  if (!row.item) return `<span class="owner-pill owner-pill--inactive">Not matched</span>${row.transactionId ? `<small class="owner-small">Transaction <code>${esc(row.transactionId)}</code></small>` : ''}`;
  const gift = row.item === 'gift' ? giftRows.find(item => item.checkoutRef === row.checkoutId) : null;
  const title = row.item === 'gift' ? `Gift${gift ? ` <code>${esc(gift.code)}</code>` : ''}` : 'Plus';
  return `<b>${title}</b>${gift ? `<small class="owner-small">${esc(gift.org)}</small>` : ''}<small class="owner-small"><code>${esc(row.checkoutId)}</code></small>`;
}

const revokedTargets = row => String(row.revoked || '').split(' ').filter(Boolean);

function refundOutcomeHtml(row) {
  if (row.status === 'pending') return `${esc(row.note || 'Creem’s transaction could not be read yet.')} Creem sends the event again; nothing is switched off until then.${row.attempts > 1 ? ` <small class="owner-small">${esc(String(row.attempts))} tries so far</small>` : ''}`;
  const restored = !inForce(row) ? ' <span class="owner-pill">Restored</span>' : '';
  if (!row.item) {
    if (row.note) return `${esc(row.note)} Nothing was switched off.`;
    if (row.revoked) return `Matched no purchase delivered so far, so nothing was switched off; if its payment is delivered later, it will be refused. Find the payment in Creem, then revoke it below if needed.${restored}`;
    return 'Matched no purchase, so nothing was switched off. Find the payment in Creem, then revoke it below.';
  }
  if (!row.fullRefund) return 'Not a full refund: nothing was switched off. You were emailed to decide.';
  const completes = row.scope === 'completes' ? `A partial refund of ${esc(money(row.amount, row.currency)) || 'part of the price'} completed a full refund. ` : '';
  if (!row.revoked) return `${completes}${row.note ? esc(row.note) : 'Nothing to switch off.'}`;
  if (!inForce(row)) return `${completes}<span class="owner-pill">Restored</span>`;
  const targets = revokedTargets(row);
  if (!targets.some(target => target.startsWith('license:') || target.startsWith('gift:'))) return `${completes}Refunded before it was delivered: nothing was delivered, and its links say so.`;
  return `${completes}${row.item === 'gift' ? 'The gift link is off, and so is Plus on every planner that activated it.' : 'The activation link and its licence are off.'}`;
}

// Creem's reason codes ("requested_by_customer") read as words.
const reasonText = value => String(value || '').replace(/[_-]+/g, ' ').trim().replace(/^./, character => character.toUpperCase());

function refundRowHtml(row) {
  const kind = row.kind === 'dispute' ? 'Dispute' : row.status === 'pending' || (row.fullRefund && row.scope !== 'completes') ? 'Refund' : 'Partial refund';
  const reason = row.reason ? `<small class="owner-small">${esc(reasonText(row.reason))}</small>` : '';
  const label = row.item === 'gift' ? 'this gift' : row.item ? 'this purchase' : 'this payment';
  const restore = row.revoked && inForce(row)
    ? `<button class="text-button" type="button" data-owner-restore="${esc(row.id)}" data-owner-restore-label="${esc(label)}">Restore</button>`
    : '';
  return `<tr data-owner-attn="refund:${esc(row.id)}">
    <td class="owner-nowrap">${esc(day(row.createdAt))}</td>
    <td class="owner-nowrap"><b>${esc(kind)}</b>${reason}</td>
    <td class="num owner-nowrap">${esc(money(row.amount, row.currency)) || '—'}</td>
    <td>${refundPurchaseHtml(row)}</td>
    <td>${refundOutcomeHtml(row)}</td>
    <td class="owner-nowrap">${restore}</td>
  </tr>`;
}

/** Revocations made in this dashboard, one line per Revoke (owner_… groups). */
function ownerRevocationsHtml(rows) {
  const groups = new Map();
  rows.filter(row => String(row.source).startsWith('owner_')).forEach(row => { if (groups.has(row.source)) groups.get(row.source).push(row); else groups.set(row.source, [row]); });
  if (!groups.size) return '';
  const describe = items => {
    const gift = items.find(item => item.kind === 'gift');
    const checkout = items.find(item => item.kind === 'checkout');
    const license = items.find(item => item.kind === 'license');
    if (gift) return `Gift <code>${esc(gift.label)}</code> and its activations`;
    if (checkout && !license) return `Checkout <code>${esc(checkout.label)}</code>, blocked before delivery`;
    if (checkout) return `Purchase <code>${esc(checkout.label)}</code> and its licence`;
    return `Licence <code>${esc(license?.label || items[0].label)}</code>`;
  };
  const lines = [...groups].map(([source, items]) => `<tr>
    <td class="owner-nowrap">${esc(when(items[0].createdAt))}</td>
    <td>${describe(items)}${items[0].note ? `<small class="owner-small">${esc(items[0].note)}</small>` : ''}</td>
    <td class="owner-nowrap"><button class="text-button" type="button" data-owner-restore="${esc(source)}" data-owner-restore-label="it">Restore</button></td>
  </tr>`).join('');
  return `<div class="owner-list"><h3>Revoked by you</h3></div><div class="owner-scroll"><table class="owner-table owner-revoked"><thead><tr><th>Date</th><th>What</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${lines}</tbody></table></div>`;
}

function renderRefunds(summary) {
  const target = $('[data-owner-refunds]');
  const form = $('[data-owner-revoke-form]');
  if (summary.refundsUnavailable) {
    target.innerHTML = '<p class="owner-empty">The refunds tables do not exist yet, so refunds are not recorded and nothing is switched off. Apply <code>migrations/0005_refunds.sql</code> to the D1 database (see <code>docs/FEEDBACK_AND_WAITLIST.md</code>).</p>';
    form.hidden = true;
    $('[data-owner-revocations]').innerHTML = '';
    return;
  }
  form.hidden = false;
  const rows = Array.isArray(summary.refunds) ? summary.refunds : [];
  target.innerHTML = rows.length
    ? `<div class="owner-scroll"><table class="owner-table owner-refunds"><thead><tr><th>Date</th><th>Kind</th><th class="num">Amount</th><th>Purchase</th><th>What happened</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${rows.map(refundRowHtml).join('')}</tbody></table></div>`
    : '<p class="owner-empty">No refunds or disputes. Creem reports them here once its webhook sends <code>refund.created</code> and <code>dispute.created</code> (see Setup).</p>';
  $('[data-owner-revocations]').innerHTML = ownerRevocationsHtml(Array.isArray(summary.revocations) ? summary.revocations : []);
}

const revokeForm = $('[data-owner-revoke-form]');
revokeForm.addEventListener('submit', async event => {
  event.preventDefault();
  const submit = $('[data-owner-revoke-submit]');
  if (submit.disabled) return;
  const target = revokeForm.elements.target.value.trim();
  if (!target) { showResult('[data-owner-revoke-result]', 'Paste a licence id, a checkout id or a gift code.', true); revokeForm.elements.target.focus(); return; }
  if (!window.confirm(`Revoke ${target.length > 40 ? 'this licence' : target}? Planners that use it lose Plus at their next check, within about a week.`)) return;
  submit.disabled = true;
  showResult('[data-owner-revoke-result]', 'Revoking…');
  try {
    const answer = await sendJson('admin/revocations', 'POST', { target, note: revokeForm.elements.note.value });
    revokeForm.reset();
    showResult('[data-owner-revoke-result]', answer?.undelivered
      ? 'Revoked. Nothing has been delivered for this checkout yet; if it is paid and delivered later, it will be refused.'
      : 'Revoked. Its links stop working now; planners that use it lose Plus at their next check, within about a week.');
    await load();
  } catch (error) {
    if (error.kind === 'unauthorized') handleError(error);
    else showResult('[data-owner-revoke-result]', failureText(error), true);
  } finally {
    submit.disabled = false;
  }
});

$('[data-owner-refunds]').closest('.owner-card').addEventListener('click', async event => {
  const button = event.target.closest('[data-owner-restore]');
  if (!button) return;
  if (!window.confirm(`Restore ${button.dataset.ownerRestoreLabel || 'it'}? Its links work again, and planners that already lost Plus get it back at their next weekly check, when they are online.`)) return;
  button.disabled = true;
  try {
    await call(`admin/revocations/${encodeURIComponent(button.dataset.ownerRestore)}`, { method: 'DELETE' });
  } catch (error) {
    // "failed" here is usually a 404: already restored. Just refresh.
    if (error.kind !== 'failed') {
      button.disabled = false;
      if (error.kind === 'unauthorized') handleError(error);
      else showResult('[data-owner-revoke-result]', failureText(error), true);
      return;
    }
  }
  showResult('[data-owner-revoke-result]', '');
  await load();
});

// ---- Partners ------------------------------------------------------------------

/** Sales through a partner's link (migrations 0006 and 0007): see ./partners-view.js. */
function renderPartners(summary) {
  if (summary.partnerProgram) PARTNER_PROGRAM_SEEN = { ...PARTNER_PROGRAM_SEEN, ...summary.partnerProgram };
  $('[data-owner-partners]').innerHTML = partnersCardHtml(summary, { money, exact: exactMoney, number, day });
}

// After the card is drawn again, focus stays on the row that was acted on (its new first button), else on the result line.
function focusPartnerRow(checkoutId, code = '') {
  const row = checkoutId ? [...document.querySelectorAll('[data-owner-partners] [data-owner-attn]')].find(item => item.dataset.ownerAttn === `partner:${checkoutId}`) : null;
  // A partner's status switch: its chosen button.
  const status = code ? [...document.querySelectorAll('[data-owner-partners] [data-owner-partner-code]')].find(item => item.dataset.ownerPartnerCode === code && item.getAttribute('aria-pressed') === 'true') : null;
  (status || row?.querySelector('button') || $('[data-owner-payout-result]'))?.focus();
}

/**
 * A partner's private statement link, from the API (signed there, never kept
 * here): copied, and shown under the card so it can be copied by hand too.
 * `renew` makes a new link first (asked before): the one sent before stops
 * working.
 */
async function copyStatementLink(code, button, { renew = false } = {}) {
  if (!/^[A-Za-z0-9_-]{2,64}$/.test(code)) { showResult('[data-owner-payout-result]', 'Type a partner code: 2 to 64 letters, digits, - or _.', true); return; }
  if (renew && !window.confirm(`Make a new private link for ${code}? The link you sent before stops working at once, for every case of the code (CAMILLE and Camille alike). Then send ${code} the new one.`)) return;
  if (button) button.disabled = true;
  try {
    const { url } = await sendJson('admin/partners/links', 'POST', renew ? { code, renew: true } : { code });
    await copyText(url, button);
    const shown = $('[data-owner-statement-shown]');
    if (shown) { shown.hidden = false; shown.innerHTML = copyRow(`${code}’s ${renew ? 'new ' : ''}private link`, url); }
    showResult('[data-owner-payout-result]', renew
      ? `${code} has a new private statement link, copied: the one sent before no longer opens. Send the new one to ${code} only.`
      : `${code}’s private statement link is copied. Send it to ${code} only: anyone with it can see their statement.`);
  } catch (error) {
    if (error.kind === 'unauthorized') { handleError(error); return; }
    showResult('[data-owner-payout-result]', failureText(error), true);
  } finally {
    if (button) button.disabled = false;
  }
}

$('[data-owner-partners]').addEventListener('submit', event => {
  const form = event.target.closest('[data-owner-statement-form]');
  if (!form) return;
  event.preventDefault();
  copyStatementLink(String(form.elements.code.value || '').trim(), form.querySelector('button[type="submit"]'));
});

/**
 * Undo on a team commission: the question names the exact payment it takes
 * back (the row's words, from partners-view.js undoWords), and the API is
 * told which one, so nothing else is undone if the commission changed since
 * the page loaded (the card is then drawn again, and says so). A payment
 * from an earlier cap year needs a second, explicit yes (the API refuses it
 * otherwise): it changes that year's figures. Answers { text, isError } to
 * show once the card is drawn again, or null when the owner said no.
 */
async function undoPayout(dataset) {
  const code = dataset.ownerPayoutCode || 'this partner';
  if (!window.confirm(dataset.ownerPayoutQuestion || `Mark ${code}’s commission as not paid?`)) return null;
  const path = `admin/partners/payouts/${encodeURIComponent(dataset.ownerPayoutUndo)}`;
  const payment = dataset.ownerPayoutPayment ? `?payment=${encodeURIComponent(dataset.ownerPayoutPayment)}` : '';
  try {
    await call(`${path}${payment}`, { method: 'DELETE' });
  } catch (error) {
    const message = String(error?.message || '');
    if (error.kind !== 'failed') throw error;
    if (/\(HTTP 404\)/.test(message)) return { text: 'There was no payment left to undo: the card is up to date.', isError: false };
    if (/changed since the page loaded/.test(message)) return { text: `${code}’s payments changed since the page loaded, so nothing was undone. The card now shows them: check, then undo again if you need to.`, isError: true };
    const year = /made in (\d{4}): undoing it changes/.exec(message)?.[1];
    if (!year) throw error;
    if (!window.confirm(`This payment was made in ${year}: undoing it changes ${year}’s figures, the yearly cap included. Undo it anyway?`)) return null;
    await call(`${path}${payment ? `${payment}&` : '?'}confirm=1`, { method: 'DELETE' });
  }
  return { text: dataset.ownerPayoutDone || `Marked as not paid: ${code}.`, isError: false };
}

// Mark an earned team commission as paid (after the bank transfer) or undo it; mark a code as not a partner or undo it;
// a partner's status; their private link, copied or made anew.
$('[data-owner-partners]').addEventListener('click', async event => {
  const link = event.target.closest('[data-owner-statement-link]');
  if (link && !link.disabled) { copyStatementLink(link.dataset.ownerStatementLink, link); return; }
  const renew = event.target.closest('[data-owner-statement-renew], [data-owner-statement-renew-form]');
  if (renew && !renew.disabled) {
    const code = renew.dataset.ownerStatementRenew ?? String(renew.closest('form')?.elements.code.value || '').trim();
    copyStatementLink(code, renew, { renew: true });
    return;
  }
  const button = event.target.closest('[data-owner-payout], [data-owner-payout-undo], [data-owner-code-reject], [data-owner-code-undo], [data-owner-partner-status]');
  if (!button || button.disabled || button.getAttribute('aria-pressed') === 'true') return;
  const { dataset } = button;
  let focusCode = '';
  const row = dataset.ownerPayout || dataset.ownerPayoutUndo || dataset.ownerRow || '';
  const undoingPayout = dataset.ownerPayoutUndo !== undefined;
  let send;
  let done;
  if (dataset.ownerPayout !== undefined) {
    // One dialog asks what to check, the amount when it is an upper bound, the day paid and a reference.
    const asked = await openPayoutDialog(dataset, { money: exactMoney, rate: TEAM_RATE });
    if (!asked) { button.focus(); return; }
    send = () => sendJson('admin/partners/payouts', 'POST', asked.body);
    done = asked.done;
  } else if (undoingPayout) {
    send = () => undoPayout(dataset);
  } else if (dataset.ownerPartnerStatus !== undefined) {
    const code = dataset.ownerPartnerCode;
    const status = dataset.ownerPartnerStatus === 'business' ? 'business' : 'individual';
    const cap = yearlyCapText(PARTNER_PROGRAM_SEEN);
    const question = status === 'business'
      ? `Mark ${code} as a business (a micro-entreprise or a company, in any country)? You then pay their team commissions against their invoice, with no yearly cap.`
      : `Mark ${code} as an individual? Their team commissions are capped at ${cap} a calendar year again, counting what you paid them this year.`;
    if (!window.confirm(question)) return;
    send = () => sendJson('admin/partners/profiles', 'POST', { code, status });
    done = status === 'business' ? `${code} is a business: pay against their invoice, no yearly cap.` : `${code} is an individual: team commissions capped at ${cap} a calendar year.`;
    focusCode = code;
  } else if (dataset.ownerCodeReject !== undefined) {
    const code = dataset.ownerCodeReject;
    if (!window.confirm(`Mark ${code} as not a partner? Do it once you have checked Creem → Affiliate Hub and found no partner with this code. Its team commissions will earn nothing (you can undo it).`)) return;
    send = () => sendJson('admin/partners/rejections', 'POST', { code });
    done = `${code} is marked as not a partner: its team commissions earn nothing.`;
  } else {
    const code = dataset.ownerCodeUndo;
    if (!window.confirm(`Is ${code} a partner after all? Its team commissions count again.`)) return;
    send = () => call(`admin/partners/rejections/${encodeURIComponent(code)}`, { method: 'DELETE' });
    done = `${code} counts as a partner again.`;
  }
  button.disabled = true;
  let isError = false;
  try {
    const answer = await send();
    // Undo answers its own words, or null when the owner said no.
    if (undoingPayout) {
      if (answer === null) { button.disabled = false; button.focus(); return; }
      ({ text: done, isError } = answer);
    }
  } catch (error) {
    button.disabled = false;
    if (error.kind === 'unauthorized') { handleError(error); return; }
    // "failed" on the Undo of a rejection is usually a 404: already undone. Just refresh.
    if (dataset.ownerCodeUndo === undefined || error.kind !== 'failed') { showResult('[data-owner-payout-result]', failureText(error), true); button.focus(); return; }
  }
  await load();
  showResult('[data-owner-payout-result]', done, isError);
  focusPartnerRow(row, focusCode);
});

// ---- Setup --------------------------------------------------------------------

const SETUP_STATES = { ok: 'Ready', warn: 'Check', missing: 'Not set' };
const PAYMENT_ITEMS = [['plus', 'Plus'], ['gift', 'Team gift']];
const PAYMENT_CURRENCIES = ['EUR', 'USD'];

// Creem: the API key, one product per item and currency, and the webhook.
function paymentsItem(payments) {
  const products = payments.products || {};
  const cell = (item, currency) => {
    const id = String(products[item]?.[currency] || '');
    return id
      ? `<td><span class="owner-check" aria-hidden="true">✓</span><span class="sr-only">Set: </span><code>${esc(id)}</code></td>`
      : `<td class="owner-missing">missing · <code>CREEM_${item.toUpperCase()}_${currency}</code></td>`;
  };
  const table = `<div class="owner-scroll"><table class="owner-table owner-mini"><thead><tr><th>Product</th>${PAYMENT_CURRENCIES.map(currency => `<th>${currency}</th>`).join('')}</tr></thead><tbody>${PAYMENT_ITEMS.map(([item, label]) => `<tr><th scope="row">${label}</th>${PAYMENT_CURRENCIES.map(currency => cell(item, currency)).join('')}</tr>`).join('')}</tbody></table></div>`;
  const mode = payments.mode === 'live' ? 'live mode' : payments.mode === 'test' ? 'test mode: no real payments, and buying is switched off on the public address — test on your project’s .pages.dev address' : '';
  const key = payments.apiKeySet
    ? `<p>API key set${mode ? ` · ${mode}` : ''} (<code>CREEM_API_KEY</code>).</p>`
    : '<p>Set the secret <code>CREEM_API_KEY</code> (Creem → Developers → API keys), then redeploy. Until then nothing can be bought online.</p>';
  const webhook = payments.webhookSecretSet
    ? '<p>Webhook signing secret set (<code>CREEM_WEBHOOK_SECRET</code>).</p>'
    : '<p>Webhook signing secret not set (<code>CREEM_WEBHOOK_SECRET</code>). Recommended: without it, a purchase is recorded only when the buyer comes back to the site after paying, and refunds never switch Plus off.</p>';
  const url = payments.webhookUrl
    ? `${copyRow('Webhook URL', payments.webhookUrl)}<p>Creem → Developers → Webhooks: add this URL with the events <code>checkout.completed</code>, <code>refund.created</code> and <code>dispute.created</code>, then paste the signing secret into <code>CREEM_WEBHOOK_SECRET</code>. The last two switch Plus off after a refund or a dispute.</p>`
    : '';
  const error = payments.error ? `<p class="owner-setup__error">${esc(payments.error)}</p>` : '';
  return { key: 'payments', title: 'Payments (Creem)', html: `${key}${error}<p>Product ids (one-time products, one per item and currency):</p>${table}${webhook}${url}` };
}

// Partners (/partners/): “Become a partner” opens the Creem affiliate sign-up link, a build variable,
// and the program's terms are set in Creem to match PARTNER_PROGRAM (src/lib/pricing.js).
function partnersItem(summary, base = 'https://planner.bemorin.com') {
  const program = { rate: 25, teamRate: 10, cookieDays: 30, refundDays: 14, minimumPayout: { EUR: 50, USD: 50 }, ...(summary.partnerProgram || {}) };
  const url = String(APP_CONFIG.AFFILIATE_URL || '').trim();
  const page = copyRow('Partners page', new URL('partners/', `${base.replace(/\/+$/, '')}/`).href);
  const creem = `<p>In Creem → Growth → Affiliate Hub, set the program to match the partners page and the terms: commission <b>${esc(program.rate)}%</b>, attribution window <b>${esc(program.cookieDays)} days</b>, and a <b>public</b> program (anyone can join, no Plus needed). Creem pays partners on the 1st and the 15th once they have ${esc(money(program.minimumPayout.EUR * 100, 'EUR'))} / ${esc(money(program.minimumPayout.USD * 100, 'USD'))}. Check that a refunded or disputed sale earns nothing there. Team gifts aren’t sent to Creem with the partner’s code: you pay their ${esc(program.teamRate)}% yourself (Partners card).</p>`;
  const link = /^https:\/\/\S+$/.test(url)
    ? `<p>“Become a partner” opens your Creem sign-up link (<code>DAILY_PLANNER_AFFILIATE_URL</code>).</p>`
    : '<p>Copy the program’s sign-up link into the build variable <code>DAILY_PLANNER_AFFILIATE_URL</code>, then redeploy: it is the link behind “Become a partner”. Until then the button opens the question form on the Teams page.</p>';
  return { key: 'partners', title: 'Partners', html: `${link}${creem}${page}` };
}

// Legal pages (legal/): their contact details and address come from build
// variables (LEGAL_VARIABLES: what each one fills). A value the pages can't
// use (legal/legal-details.js: not a plain email address, not a phone
// number) is left out of them, and said so here. Creem's store review asks
// for the terms, the privacy policy and the website.
const LEGAL_VARIABLES = [
  ['SUPPORT_EMAIL', 'the contact address, in the legal notice, the terms and on the Contact page (“Prefer email? Write to …”), and for privacy questions unless <code>DAILY_PLANNER_PRIVACY_EMAIL</code> is set. Blank: the “Ask a question” form only.'],
  ['PRIVACY_EMAIL', 'optional, the address for privacy questions, in the privacy policy (data controller, your rights) and the cookies page.'],
  ['LEGAL_PHONE', 'recommended (French law asks an individual publisher for one): your phone number in international form, <code>+33</code> then the number without its 0, with no spaces (e.g. <code>+33199001234</code>). The legal notice shows it as people of that country write it (<code>+33 1 99 00 12 34</code>) in a Phone row, as a link that dials it.'],
  ['LEGAL_ADDRESS', 'the postal address, in the legal notice and the privacy policy.'],
  ['LEGAL_REGISTRATION', 'optional, SIRET and/or VAT number, in the legal notice and the privacy policy.']
];

/**
 * A legal build variable's state in the Setup card: “set” (the phone: “set,
 * shown as …”; an address typed “<…>” or “Name <…>”: “set, read as …”),
 * “blank”, or “set, but not used: …”.
 */
function legalVariableState(key) {
  const problem = legalValueProblem(key, APP_CONFIG[key]);
  if (problem) return `set, but not used: ${problem}`;
  const value = String(APP_CONFIG[key] || '').trim();
  if (!value) return 'blank';
  if (key === 'LEGAL_PHONE') return `set, shown as ${esc(legalDetails(APP_CONFIG).phone)}`;
  const email = key.endsWith('_EMAIL') ? legalEmail(value) : '';
  return email && email !== value ? `set, read as ${esc(email)}` : 'set';
}

function legalItem(base = 'https://planner.bemorin.com') {
  const details = legalDetails(APP_CONFIG);
  const unusable = key => !!legalValueProblem(key, APP_CONFIG[key]);
  const missing = [['email', 'SUPPORT_EMAIL', 'contact address'], ['address', 'LEGAL_ADDRESS', 'postal address']].filter(([field]) => !details[field]);
  // The public site (PUBLIC_BASE_URL), not a preview deployment this page may be open on.
  const page = path => new URL(path, `${base.replace(/\/+$/, '')}/`).href;
  const urls = `<p>The addresses Creem asks for:</p>${copyRow('Terms', page('legal/terms/'))}${copyRow('Privacy', page('legal/privacy/'))}${copyRow('Website', page('welcome/'))}`;
  const variables = LEGAL_VARIABLES.map(([key, what]) => `<p><code>DAILY_PLANNER_${key}</code> (${legalVariableState(key)}): ${what}</p>`).join('');
  const fix = LEGAL_VARIABLES.some(([key]) => unusable(key)) ? ' A value marked “not used” is left out of the pages until you correct it.' : '';
  if (!missing.length) {
    const privacy = details.privacyEmail ? `, privacy questions to ${esc(details.privacyEmail)}` : '';
    return { key: 'legal', title: 'Legal pages', html: `<p>The legal notice shows your contact (${esc(details.email)}${privacy}) and postal address.${fix} Build variables (type Text; redeploy after a change):</p>${variables}${urls}` };
  }
  const names = missing.map(([, key]) => `<code>DAILY_PLANNER_${key}</code>${unusable(key) ? ' to a plain email address' : ''}`).join(' and ');
  const what = missing.map(([, , label]) => label).join(' or ');
  return {
    key: 'legal',
    title: 'Legal pages',
    html: `<p>Set the build variable${missing.length > 1 ? 's' : ''} ${names} (Settings → Variables and Secrets, type Text), then redeploy. Until then the legal pages show no ${what}${details.email ? '' : ' and point to the “Ask a question” form'}.${fix} What each variable fills:</p>${variables}${urls}`
  };
}

// The release the API was deployed with, and whether this page is the same one.
function versionItem(summary) {
  const server = String(summary.version || '').trim();
  const page = esc(APP_VERSION);
  const order = compareVersions(server, APP_VERSION);
  if (Number.isNaN(order)) return { key: 'version', title: 'Deployed version', label: 'Unknown', html: `<p>This API does not report its version yet (it is older than 1.25.0): redeploy it. This page is version ${page}.</p>` };
  if (order === 0) return { key: 'version', title: `Deployed version ${server}`, label: 'Up to date', html: '<p>This page is the deployed dashboard.</p>' };
  return {
    key: 'version',
    title: `Deployed version ${server}`,
    label: 'Reload needed',
    html: `<p>This page is version ${page}, from ${order > 0 ? 'an older' : 'a different'} deployment kept in a cache. Use Reload at the top of the page. If it stays, purge Cloudflare’s cache: your domain → Caching → Configuration → Purge Everything.</p>`
  };
}

// Each item's state comes from setupChecks() (./attention.js), which also
// feeds “Needs your attention”, so the two always agree.
function setupItems(summary) {
  const setup = summary.setup;
  const base = setup.publicBaseUrl || 'https://planner.bemorin.com';
  const states = new Map(setupChecks(summary, { config: APP_CONFIG, pageVersion: APP_VERSION }).map(check => [check.key, check.state]));
  const items = [versionItem(summary)];
  const email = setup.email || {};
  items.push(email.configured
    ? { key: 'email', title: 'Email (Resend)', html: `<p>Sending as ${esc(email.from)}, at most ${number(email.dailyLimit)} emails a day (<code>EMAIL_DAILY_LIMIT</code>; Resend’s free plan allows 100 a day, 3,000 a month).</p>` }
    : {
      key: 'email',
      title: 'Email (Resend)',
      html: `<p>Set the secret <code>RESEND_API_KEY</code>${email.apiKeySet ? ' (set)' : ''} and <code>EMAIL_FROM</code>${email.fromSet ? ' (set, but not a valid address)' : ''}, e.g. <code>Ben Morin &lt;hello@bemorin.com&gt;</code>, then redeploy.</p>
        <p>In Resend → Domains, add your domain. Resend lists DNS records (DKIM and SPF, plus MX for bounces): add each one in Cloudflare → your domain → DNS as “DNS only”, then wait until Resend shows “Verified”. Create the API key with “Sending access” only.</p>`
    });
  items.push(email.ownerEmail
    ? { key: 'owner-email', title: 'Owner email', html: `<p>Team requests and test sends go to ${esc(email.ownerEmail)}; gift buyers’ replies too.</p>` }
    : { key: 'owner-email', title: 'Owner email', html: '<p>Set <code>OWNER_EMAIL</code> to get team request notifications and test sends, and to receive replies from gift buyers.</p>' });

  const plus = setup.plus || {};
  if (plus.configured) {
    const appKey = String(APP_CONFIG.PLUS_PUBLIC_KEY || '').trim();
    const app = appKey === plus.publicKey ? 'The app on this site has the matching public key.'
      : appKey ? 'The app on this site has a different public key: licences made here won’t unlock Plus in it. Set the build variable to the key above and redeploy.'
        : 'The app on this site has no public key yet, so Plus can’t be activated in it. Set the build variable to the key above and redeploy.';
    items.push({ key: 'plus', title: 'Plus licences', html: `<p><code>PLUS_SIGNING_KEY</code> is set. Public key for the app build (<code>DAILY_PLANNER_PLUS_PUBLIC_KEY</code>):</p>${copyRow('Public key', plus.publicKey)}<p>${esc(app)}</p>` });
  } else {
    items.push({
      key: 'plus',
      title: 'Plus licences',
      html: plus.keySet
        ? '<p><code>PLUS_SIGNING_KEY</code> is set but is not a base64 PKCS#8 P-256 private key. Run <code>npm run plus:keys</code> for a new pair.</p>'
        : '<p>Run <code>npm run plus:keys</code>. Add <code>PLUS_SIGNING_KEY</code> as an encrypted secret and <code>DAILY_PLANNER_PLUS_PUBLIC_KEY</code> as a build variable, then redeploy. Until then, gifts and licences can’t be created.</p>'
    });
  }

  items.push(paymentsItem(setup.payments || {}));

  items.push({ key: 'links', title: 'Links in emails', html: `<p>They start with ${esc(base)}${setup.publicBaseUrlSet ? ' (<code>PUBLIC_BASE_URL</code>)' : ', the default. Set <code>PUBLIC_BASE_URL</code> to change it'}.</p>` });
  items.push(partnersItem(summary, base));
  items.push(legalItem(base));
  const missingTables = [summary.teamRequestsUnavailable && '0002_team_requests.sql', summary.plusUnavailable && '0003_plus.sql', summary.reviewsUnavailable && '0004_creem_reviews.sql', summary.refundsUnavailable && '0005_refunds.sql', summary.partnersUnavailable && '0006_partners.sql', summary.partnerCommissionsUnavailable && '0007_partner_commissions.sql', summary.partnerProfilesUnavailable && '0008_partner_profiles.sql'].filter(Boolean);
  const listed = files => (files.length > 1 ? `${files.slice(0, -1).join(', ')} and ${files.at(-1)}` : files[0]);
  items.push(missingTables.length
    ? { key: 'database', title: 'Database', html: `<p>Apply ${listed(missingTables.map(file => `<code>migrations/${file}</code>`))} to the D1 database.${summary.refundsUnavailable ? ' Until <code>0005_refunds.sql</code> is applied, refunds are not recorded and nothing is switched off.' : ''}</p>` }
    : { key: 'database', title: 'Database', html: '<p>All tables are in place.</p>' });
  items.push(setup.twoFactor
    ? { key: 'sign-in', title: 'Owner sign-in', html: '<p>Two-factor sign-in is on.</p>' }
    : { key: 'sign-in', title: 'Owner sign-in', html: '<p>Only the admin token protects this page. Run <code>npm run admin:secret</code> and set <code>ADMIN_TOTP_SECRET</code> to also require an authenticator code.</p>' });
  return items.map(item => ({ ...item, state: states.get(item.key) || 'ok' }));
}

// ---- Reviews -------------------------------------------------------------------

const quoteOf = row => `“${String(row.text || '').trim()}” — ${String(row.name || '').trim() || 'Anonymous'}`;

function reviewHtml(row) {
  const name = String(row.name || '').trim();
  return `<article class="owner-review" data-owner-attn="review:${Number(row.id)}">
    <div class="owner-review__meta">${stars(row.rating)}<span>${esc(row.appVersion)}</span><span>${esc(day(row.createdAt))}</span></div>
    <blockquote class="owner-review__text">${esc(row.text)}</blockquote>
    <p class="owner-review__name">${name ? `— ${esc(name)}` : '<span>Anonymous</span>'}</p>
    <div class="owner-review__actions"><button class="text-button" type="button" data-owner-copy="${esc(quoteOf(row))}">Copy as quote</button><button class="text-button text-button--danger" type="button" data-owner-delete-review="${Number(row.id)}" data-owner-review-name="${esc(name || 'Anonymous')}">Delete</button></div>
  </article>`;
}

function renderReviews(summary) {
  const target = $('[data-owner-reviews]');
  const caption = $('[data-owner-reviews-caption]');
  if (summary.reviewsUnavailable) {
    caption.textContent = 'Reviews people agreed to have quoted.';
    target.innerHTML = '<p class="owner-empty">Run migration 0004 to collect reviews: apply <code>migrations/0004_creem_reviews.sql</code> to the D1 database.</p>';
    return;
  }
  const rows = Array.isArray(summary.reviews) ? summary.reviews : [];
  caption.textContent = rows.length
    ? `${rows.length === 50 ? 'The newest 50' : `${number(rows.length)} ${plural(rows.length, 'review')}`}, sent from the planner with permission to quote them. Delete any you would not quote.`
    : 'Reviews people agreed to have quoted.';
  target.innerHTML = rows.length ? `<div class="owner-reviews">${rows.map(reviewHtml).join('')}</div>` : '<p class="owner-empty">No reviews yet.</p>';
}

// ---- Needs your attention -------------------------------------------------------

// Lines shown before “Show N more”.
const ATTENTION_SHOWN = 6;
const ATTENTION_ICONS = {
  refund: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  dispute: '<path d="M12 3.5 5 6.2v5.1c0 4.3 2.9 7.6 7 9.2 4.1-1.6 7-4.9 7-9.2V6.2z"/><path d="M12 8.5v4"/><path d="M12 15.8v.01"/>',
  waiting: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  team: '<rect x="3.5" y="5.5" width="17" height="13" rx="2.5"/><path d="m4.5 7.5 7.5 5.5 7.5-5.5"/>',
  setup: '<path d="M4 7h9"/><path d="M17 7h3"/><path d="M4 17h3"/><path d="M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  version: '<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4.5v4h-4"/>',
  gift: '<rect x="3.5" y="8.5" width="17" height="4" rx="1"/><path d="M5.5 12.5v7h13v-7"/><path d="M12 8.5v11"/><path d="M12 8.5C10.6 5 7 4.6 7 6.6c0 1.4 2.2 1.9 5 1.9 2.8 0 5-.5 5-1.9 0-2-3.6-1.6-5 1.9"/>',
  review: '<path d="m12 4.5 2.3 4.7 5.2.8-3.8 3.6.9 5.1-4.6-2.4-4.6 2.4.9-5.1-3.8-3.6 5.2-.8z"/>',
  clear: '<circle cx="12" cy="12" r="8.5"/><path d="m8.4 12.3 2.5 2.5 4.7-5"/>',
  partner: '<circle cx="12" cy="12" r="8.5"/><path d="M14.6 9.2c-.5-.9-1.5-1.4-2.6-1.4-1.6 0-2.7.8-2.7 2 0 2.8 5.5 1.5 5.5 4.3 0 1.2-1.2 2.1-2.8 2.1-1.2 0-2.3-.6-2.8-1.5M12 6v1.8M12 16.2V18"/>'
};
const ATTENTION_ARROW = '<svg class="owner-attention__arrow" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>';
// The mark on a row: “!” to act on, “i” worth a look. A shape and words, not only a colour.
const ATTENTION_FLAGS = {
  act: '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" focusable="false"><path d="M12 6.5v7"/><path d="M12 17.5v.01"/></svg>',
  look: '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" focusable="false"><path d="M12 10.5v7"/><path d="M12 6.5v.01"/></svg>'
};
const ATTENTION_TONE_WORDS = { urgent: 'Urgent', warn: 'To do', info: 'Worth a look' };
// The card each section points to, found from the container it renders into.
const ATTENTION_CARDS = { refunds: '[data-owner-refunds]', teams: '[data-owner-teams]', partners: '[data-owner-partners]', setup: '[data-owner-setup]', gifts: '[data-owner-gifts]', reviews: '[data-owner-reviews]' };
const ATTENTION_TONE_CLASSES = ['is-attention', 'is-attn-urgent', 'is-attn-warn', 'is-attn-info'];
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
let attentionExpanded = false;

const attentionIcon = name => `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">${ATTENTION_ICONS[name] || ATTENTION_ICONS.setup}</svg>`;
const exactTime = iso => (iso ? new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const clockTime = iso => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

function attentionCard(section) {
  const card = $(ATTENTION_CARDS[section])?.closest('.owner-card');
  if (card && !card.id) card.id = `owner-${section}-card`;
  return card;
}

function attentionFlag(tone) {
  const act = tone !== 'info';
  const words = act ? 'Needs your attention' : 'Worth a look';
  return `<span class="owner-attn-flag" data-owner-attn-flag title="${words}">${ATTENTION_FLAGS[act ? 'act' : 'look']}<span class="sr-only">${words}. </span></span>`;
}

/** Cards get an alert style and a count; their rows a tint, a left bar and a “!” (or “i”) mark. */
function markAttention(items) {
  const { sections, rows } = attentionBySection(items);
  Object.keys(ATTENTION_CARDS).forEach(section => {
    const card = attentionCard(section);
    if (!card) return;
    card.classList.remove(...ATTENTION_TONE_CLASSES);
    $('[data-owner-attn-count]', card)?.remove();
    const found = sections[section];
    if (!found) return;
    card.classList.add('is-attention', `is-attn-${found.tone}`);
    const label = `${found.count} ${found.count === 1 ? 'needs' : 'need'} your attention`;
    $('h2', card)?.insertAdjacentHTML('beforeend', `<span class="owner-attn-count" data-owner-attn-count title="${label}">${number(found.count)}<span class="sr-only"> ${label}</span></span>`);
  });
  document.querySelectorAll('[data-owner-attn]').forEach(element => {
    element.classList.remove(...ATTENTION_TONE_CLASSES);
    element.querySelectorAll('[data-owner-attn-flag]').forEach(flag => flag.remove());
    const tone = rows.get(element.dataset.ownerAttn);
    if (!tone) return;
    element.classList.add('is-attention', `is-attn-${tone}`);
    // Setup items already say “Check” or “Not set” in words.
    const place = element.matches('tr') ? element.cells[0] : element.matches('.owner-review') ? $('.owner-review__meta', element) : null;
    place?.insertAdjacentHTML('afterbegin', attentionFlag(tone));
  });
  // A table with marks keeps its first column aligned on the rows without one.
  document.querySelectorAll('.owner-table').forEach(table => table.classList.toggle('has-attention', !!$('tr.is-attention', table)));
}

function attentionLine(item, index, summary, now) {
  const setup = item.when === 'setup';
  const label = attentionWhen(item, now);
  const title = setup ? `A setting of this deployment: it has no date. Checked ${exactTime(summary.generatedAt)}.`
    : `${item.when === 'until' ? 'Expires' : item.when === 'created' ? 'Created' : item.when === 'earned' ? 'Earned' : 'Since'} ${exactTime(item.at)}`;
  const time = setup || !label ? `<span class="owner-attention__when" title="${esc(title)}">${esc(label)}</span>`
    : `<time class="owner-attention__when" datetime="${esc(item.at)}" title="${esc(title)}">${esc(label)}</time>`;
  const card = attentionCard(item.section);
  return `<li class="owner-attention__item is-attn-${item.tone}"${index >= ATTENTION_SHOWN && !attentionExpanded ? ' hidden' : ''}>
    <a class="owner-attention__link" href="#${esc(card?.id || '')}" data-owner-attn-go="${esc(item.rows[0])}" data-owner-attn-section="${esc(item.section)}">
      <span class="owner-attention__icon" aria-hidden="true">${attentionIcon(item.icon)}</span>
      <span class="owner-attention__text"><span class="owner-attention__title"><span class="sr-only">${ATTENTION_TONE_WORDS[item.tone]}: </span>${esc(item.text)}</span>${item.detail ? `<span class="owner-attention__detail">${esc(item.detail)}</span>` : ''}</span>
      ${time}
      <span class="owner-attention__go">Go to ${esc(ATTENTION_SECTIONS[item.section])}${ATTENTION_ARROW}</span>
    </a>
  </li>`;
}

function renderAttention(summary) {
  const items = buildAttention(summary, { config: APP_CONFIG, pageVersion: APP_VERSION, money, number });
  markAttention(items);
  const panel = $('[data-owner-attention]');
  if (!panel) return;
  const now = Date.parse(summary.generatedAt) || Date.now();
  const checked = `<p class="owner-attention__checked">Checked <time datetime="${esc(summary.generatedAt)}" title="${esc(exactTime(summary.generatedAt))}">${esc(clockTime(now))}</time></p>`;
  panel.classList.remove('is-clear', ...ATTENTION_TONE_CLASSES);
  // Sorted most urgent first: the first line sets the panel's tone.
  panel.classList.add(items.length ? `is-attn-${items[0].tone}` : 'is-clear');
  if (!items.length) {
    panel.innerHTML = `<div class="owner-attention__clear">
      <span class="owner-attention__icon" aria-hidden="true">${attentionIcon('clear')}</span>
      <div class="owner-attention__text"><h2 id="owner-attention-title">All clear</h2><p>Nothing needs your attention. Refunds and disputes, team requests, partner commissions, Setup, gifts and reviews were checked.</p></div>
      ${checked}
    </div>`;
    return;
  }
  const hidden = Math.max(0, items.length - ATTENTION_SHOWN);
  const note = attentionNote(items);
  panel.innerHTML = `<div class="owner-attention__head">
      <h2 id="owner-attention-title">Needs your attention <span class="owner-attn-count">${number(items.length)}</span></h2>
      ${checked}
    </div>
    <ol class="owner-attention__list" id="owner-attention-list">${items.map((item, index) => attentionLine(item, index, summary, now)).join('')}</ol>
    ${hidden || note ? `<div class="owner-attention__foot">${hidden ? `<button class="text-button owner-attention__more" type="button" data-owner-attention-more aria-controls="owner-attention-list" aria-expanded="${attentionExpanded}">${attentionExpanded ? 'Show fewer' : `Show ${number(hidden)} more`}</button>` : ''}${note ? `<p class="owner-attention__note">${esc(note)}</p>` : ''}</div>` : ''}`;
}

function clearAttention() {
  markAttention([]);
  const panel = $('[data-owner-attention]');
  if (!panel) return;
  panel.innerHTML = '';
  panel.classList.remove('is-clear', ...ATTENTION_TONE_CLASSES);
}

/** Scroll to the row (or else the card), focus it and outline it until it loses focus. */
function locateAttention(rowKey, section) {
  const card = attentionCard(section);
  const target = [...document.querySelectorAll('[data-owner-attn]')].find(element => element.dataset.ownerAttn === rowKey && !element.closest('[hidden]')) || (card && $('h2', card));
  if (!target) return;
  document.querySelectorAll('.is-located').forEach(element => element.classList.remove('is-located'));
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  target.classList.add('is-located');
  // A row taller than most of the screen (a narrow phone) shows from its top.
  const tall = target.getBoundingClientRect().height > innerHeight * 0.6;
  target.scrollIntoView({ block: tall ? 'start' : 'center', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
  target.focus({ preventScroll: true });
  target.addEventListener('blur', () => target.classList.remove('is-located'), { once: true });
}

$('[data-owner-attention]')?.addEventListener('click', event => {
  const more = event.target.closest('[data-owner-attention-more]');
  if (more) {
    attentionExpanded = !attentionExpanded;
    const items = [...document.querySelectorAll('.owner-attention__item')];
    items.forEach((item, index) => { item.hidden = index >= ATTENTION_SHOWN && !attentionExpanded; });
    more.setAttribute('aria-expanded', String(attentionExpanded));
    more.textContent = attentionExpanded ? 'Show fewer' : `Show ${number(items.length - ATTENTION_SHOWN)} more`;
    if (attentionExpanded) $('a', items[ATTENTION_SHOWN])?.focus();
    return;
  }
  const link = event.target.closest('[data-owner-attn-go]');
  if (!link) return;
  event.preventDefault();
  locateAttention(link.dataset.ownerAttnGo, link.dataset.ownerAttnSection);
});

// ---- Version -------------------------------------------------------------------

// A reload for another version arrives as ?v=<version>: read it, then put the
// plain address back.
const reloadMark = readReloadMark(location.href);
if (reloadMark.cleanUrl !== location.href) {
  try { history.replaceState(history.state, '', reloadMark.cleanUrl); } catch (_) {}
}

// “Version X” in the header and the banner's live region, made here so they
// also appear when an older index.html comes from a cache.
function mountVersion() {
  const eyebrow = $('.owner-head .modal__eyebrow');
  if (eyebrow && !$('[data-owner-version]')) eyebrow.insertAdjacentHTML('beforeend', `<span class="owner-version" data-owner-version> · Version ${esc(APP_VERSION)}</span>`);
  if ($('[data-owner-update]')) return;
  const banner = document.createElement('div');
  banner.className = 'owner-update';
  banner.dataset.ownerUpdate = '';
  banner.setAttribute('role', 'status');
  banner.hidden = true;
  banner.addEventListener('click', event => {
    const button = event.target.closest('[data-owner-update-reload]');
    if (button) reloadDashboard(button);
  });
  $('.owner-shell').prepend(banner);
}

function renderVersion(summary) {
  const banner = $('[data-owner-update]');
  if (!banner) return;
  const server = String(summary.version || '').trim();
  const notice = versionNotice(APP_VERSION, server, { retried: !!reloadMark.version && reloadMark.version === server });
  banner.hidden = !notice;
  banner.dataset.version = notice ? notice.server : '';
  banner.innerHTML = notice
    ? `<span class="owner-update__icon" aria-hidden="true">${RELOAD_SVG}</span>
      <div class="owner-update__body"><p class="owner-update__title"><b>${esc(notice.title)}</b> ${esc(notice.action)}</p><p>${esc(notice.detail)}</p>${notice.hint ? `<p class="owner-update__hint">${esc(notice.hint)}</p>` : ''}</div>
      <button class="primary-button" type="button" data-owner-update-reload>Reload</button>`
    : '';
}

// Fetch every file of the page again past the browser cache, then open the
// page at a new address (?v=), which no cached copy can answer.
async function reloadDashboard(button) {
  const version = $('[data-owner-update]')?.dataset.version;
  if (!version) return;
  button.disabled = true;
  button.textContent = 'Reloading…';
  await Promise.allSettled(DASHBOARD_FILES.map(path => fetch(new URL(path, import.meta.url), { cache: 'reload' })));
  location.replace(reloadUrl(location.href, version));
}

function renderSetup(summary) {
  const target = $('[data-owner-setup]');
  if (!summary.setup) {
    target.innerHTML = '<li class="owner-empty">This API does not report its setup yet. Redeploy it.</li>';
    return;
  }
  target.innerHTML = setupItems(summary).map(item => `<li class="owner-setup__item is-${item.state}" data-owner-attn="setup:${esc(item.key)}"><span class="owner-setup__mark" aria-hidden="true"></span><div class="owner-setup__body"><p class="owner-setup__title"><b>${esc(item.title)}</b><span>${esc(item.label || SETUP_STATES[item.state])}</span></p>${item.html}</div></li>`).join('');
}

document.addEventListener('click', event => {
  const button = event.target.closest('[data-owner-copy]');
  if (button) copyText(button.dataset.ownerCopy, button);
});

function renderSignals(summary) {
  const labels = {
    onboarding_completed: 'Finished onboarding',
    install_modal_opened: 'Opened “Install the app”',
    install_accepted: 'Installed from the prompt',
    feedback_prompt_shown: 'Saw the “rate this version” card',
    feedback_opened: 'Opened feedback',
    feedback_sent: 'Sent feedback',
    trophy_unlocked: 'Days with a trophy unlocked',
    landing_viewed: 'Landing page visits',
    landing_cta_app: 'Landing → opened the planner',
    landing_cta_teams: 'Landing → went to the Teams page',
    team_form_opened: 'Opened the request form',
    team_request_sent: 'Sent a request (invoice, quote or question)',
    manager_email_opened: 'Opened the email to a manager',
    plus_modal_opened: 'Opened the Plus details',
    plus_checkout_clicked: 'Went to buy Plus',
    plus_unlocked: 'Unlocked Plus',
    gift_opened: 'Opened a gift link',
    gift_redeemed: 'Activated a gift',
    year_plan_completed: 'Finished planning a year',
    quarter_review_completed: 'Finished a quarter check-in',
    year_review_opened: 'Opened a year in review',
    share_image_created: 'Made a share image (week or year)',
    pack_checkout_clicked: 'Landing → went to buy a team gift',
    gift_link_copied: 'Copied a team gift link',
    plus_viewed: 'Landing → scrolled to Plus',
    teams_viewed: 'Visited the Teams page',
    pricing_viewed: 'Landing → scrolled to the prices',
    review_sent: 'Left a review that may be quoted',
    partners_viewed: 'Visited the partners page',
    partner_cta_clicked: 'Partners page → went to become a partner'
  };
  const versions = [...new Set(summary.eventTotals.map(row => row.appVersion))].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  const body = Object.entries(labels).map(([name, label]) => `<tr><td>${esc(label)}</td><td class="num"><b>${number(totalOf(summary.eventTotals, name))}</b></td>${versions.map(version => `<td class="num">${number(summary.eventTotals.filter(row => row.name === name && row.appVersion === version).reduce((sum, row) => sum + row.count, 0))}</td>`).join('')}</tr>`).join('');
  $('[data-owner-signals]').innerHTML = `<div class="owner-scroll"><table class="owner-table"><thead><tr><th>Signal</th><th class="num">Total</th>${versions.map(version => `<th class="num">${esc(version)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`;
}

// The daily series behind Trends: { series } or { message } (an older API has no
// admin/series), or { error } when the session has ended.
async function fetchSeries() {
  const { from, to } = seriesWindow(dayOf(new Date()));
  try {
    const series = normalizeSeries(await jsonOf(await call(`admin/series?from=${from}&to=${to}`)));
    return series ? { series } : { message: UPDATE_API_MESSAGE };
  } catch (error) {
    if (error.kind === 'unauthorized') return { error };
    if (error.kind === 'offline' || /HTTP 40[45]\)/.test(error.message)) return { message: UPDATE_API_MESSAGE };
    return { message: `Trends could not be loaded. ${failureText(error)}` };
  }
}

async function showSeries(pending, forSession) {
  const result = await pending;
  if (!session || session.session !== forSession) return;
  if (result.error) { handleError(result.error); return; }
  if (result.series) {
    seriesSession = forSession;
    trends.show(result.series);
  } else {
    trends.unavailable(result.message);
  }
}

async function load({ series: refreshSeries = false } = {}) {
  if (!session) { await start(); return; }
  const days = Number(periodPicker.value) || 90;
  const forSession = session.session;
  const pending = refreshSeries === true || seriesSession !== forSession ? fetchSeries() : null;
  if (pending) trends.refreshing();
  try {
    const summary = await jsonOf(await call(`admin/summary?days=${days}`));
    if (!session) return;
    setNotice('');
    show('dashboard');
    $('[data-owner-session]').textContent = `Signed in until ${untilLabel(session.expiresAt)}`;
    $('[data-owner-sub]').textContent = `Private. Updated ${when(summary.generatedAt)} · counts since ${summary.sinceDay}.`;
    renderVersion(summary);
    if (Number(summary.partnerProgram?.teamRate) > 0) TEAM_RATE = Number(summary.partnerProgram.teamRate);
    renderKpis(summary, days);
    renderFunnel(summary, days);
    renderTeamFunnel(summary, days);
    renderTeams(summary);
    readRevocations(summary);
    renderGifts(summary);
    renderPlus(summary, days);
    renderRefunds(summary);
    renderPartners(summary);
    renderSetup(summary);
    renderWaitlist(summary);
    renderAnnounce(summary);
    renderVersions(summary);
    renderSignals(summary);
    renderReviews(summary);
    // Last: it marks the rows the cards above have just rendered.
    renderAttention(summary);
    if (pending) await showSeries(pending, forSession);
    await renderFeedback();
  } catch (error) {
    handleError(error);
    if (pending && session) await showSeries(pending, forSession);
  }
}

async function start() {
  setNotice('');
  show('checking');
  if (session) { scheduleExpiry(); await load(); return; }
  try {
    await probe();
    showLogin();
  } catch (error) {
    handleError(error);
  }
}

async function download(path, filename) {
  try {
    const response = await call(path);
    const url = URL.createObjectURL(await response.blob());
    Object.assign(document.createElement('a'), { href: url, download: filename }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    handleError(error);
  }
}

async function remove(path) {
  try {
    await call(path, { method: 'DELETE' });
  } catch (error) {
    // "failed" here is usually a 404: already removed. Just refresh.
    if (error.kind !== 'failed') { handleError(error); return; }
  }
  await load();
}

const loginForm = $('[data-owner-login]');
const codeInput = $('input[name="code"]', loginForm);
codeInput.addEventListener('input', () => {
  const digits = codeInput.value.replace(/\D/g, '').slice(0, 6);
  if (digits !== codeInput.value) codeInput.value = digits;
});

loginForm.addEventListener('submit', async event => {
  event.preventDefault();
  const data = new FormData(loginForm);
  const token = String(data.get('token') || '').trim();
  const code = String(data.get('code') || '').replace(/\D/g, '');
  const error = $('[data-owner-error]');
  if (!token) { showLogin('Enter the admin token.'); return; }
  if (code && code.length !== 6) { showLogin('The authenticator code has 6 digits.'); return; }
  const submit = $('[data-owner-submit]');
  submit.disabled = true;
  submit.textContent = 'Signing in…';
  error.hidden = true;
  try {
    const body = await jsonOf(await call('admin/session', { auth: false, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, code }) }));
    const expiresAt = Date.parse(body?.expiresAt);
    if (typeof body?.session !== 'string' || !Number.isFinite(expiresAt)) throw new ApiError('failed', 'The API answered without a session.');
    loginForm.reset();
    saveSession({ session: body.session, expiresAt });
    await load();
  } catch (failure) {
    if (failure.kind === 'unauthorized') showLogin(SIGN_IN_FAILED_MESSAGE);
    else if (failure.kind === 'failed') showLogin(failure.message);
    else handleError(failure);
  } finally {
    submit.disabled = false;
    submit.textContent = 'Open dashboard';
  }
});

const periodPicker = createDropdown($('[data-owner-days]'), { items: PERIODS, value: '90', onChange: () => load() });
const versionFilter = createDropdown($('[data-owner-version-filter]'), { items: [{ value: '', label: 'All versions' }], value: '', onChange: () => renderFeedback().catch(handleError) });

$('[data-owner-refresh]').addEventListener('click', () => load({ series: true }));
$('[data-owner-retry]').addEventListener('click', start);
$('[data-owner-signout]').addEventListener('click', () => signOut());
$('[data-owner-waitlist-csv]').addEventListener('click', event => { event.preventDefault(); download('admin/waitlist?format=csv', 'daily-planner-waitlist.csv'); });
$('[data-owner-teams-csv]').addEventListener('click', event => { event.preventDefault(); download('admin/teams?format=csv', 'daily-planner-team-requests.csv'); });
$('[data-owner-feedback-csv]').addEventListener('click', event => {
  event.preventDefault();
  const version = versionFilter.value;
  download(`admin/feedback?format=csv${version ? `&version=${encodeURIComponent(version)}` : ''}`, 'daily-planner-feedback.csv');
});
$('[data-owner-waitlist]').addEventListener('click', event => {
  const button = event.target.closest('[data-owner-delete]');
  if (!button) return;
  const row = button.closest('tr');
  if (!window.confirm(`Delete ${row?.cells[0]?.textContent || 'this sign-up'} from the waitlist? This cannot be undone.`)) return;
  remove(`admin/waitlist/${button.dataset.ownerDelete}`);
});
$('[data-owner-teams]').addEventListener('click', event => {
  const button = event.target.closest('[data-owner-delete-team]');
  if (!button) return;
  const row = button.closest('tr');
  if (!window.confirm(`Delete the team kit request from ${row?.cells[1]?.textContent || 'this team'}? This cannot be undone.`)) return;
  remove(`admin/teams/${button.dataset.ownerDeleteTeam}`);
});
$('[data-owner-reviews]').addEventListener('click', event => {
  const button = event.target.closest('[data-owner-delete-review]');
  if (!button) return;
  if (!window.confirm(`Delete the review from ${button.dataset.ownerReviewName || 'this person'}? It can no longer be quoted. This cannot be undone.`)) return;
  remove(`admin/reviews/${button.dataset.ownerDeleteReview}`);
});
$('[data-owner-feedback]').addEventListener('click', event => {
  const button = event.target.closest('[data-owner-delete-feedback]');
  if (!button) return;
  if (!window.confirm('Delete this feedback? This cannot be undone.')) return;
  remove(`admin/feedback/${button.dataset.ownerDeleteFeedback}`);
});

announceForm.addEventListener('submit', event => event.preventDefault());
announceForm.addEventListener('input', () => { if (!$('[data-owner-announce-confirm]').hidden) hideAnnounceConfirm(); });
$('[data-owner-announce-test]').addEventListener('click', () => sendAnnouncement(true));
$('[data-owner-announce-send]').addEventListener('click', () => {
  const message = readAnnouncement();
  if (!message) return;
  const batch = announceBatch();
  const rest = announceState.count - batch;
  $('[data-owner-announce-confirm-text]').textContent = `Send “${message.subject}” to ${people(batch)} now? Each address is deleted as soon as Resend accepts its email, so this can’t be undone.${rest > 0 ? ` The other ${people(rest)} stay on the list for ${announceState.allowance > batch ? 'the next send' : 'tomorrow'}.` : ''}`;
  $('[data-owner-announce-confirm-send]').textContent = `Yes, send to ${people(batch)}`;
  showAnnounceResult('');
  $('[data-owner-announce-actions]').hidden = true;
  $('[data-owner-announce-confirm]').hidden = false;
  $('[data-owner-announce-cancel]').focus();
});
$('[data-owner-announce-cancel]').addEventListener('click', () => { hideAnnounceConfirm(); $('[data-owner-announce-send]').focus(); });
$('[data-owner-announce-confirm-send]').addEventListener('click', () => sendAnnouncement(false));
prefillAnnouncement();
mountVersion();

start();
