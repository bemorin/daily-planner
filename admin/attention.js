// What needs the owner's attention, read from the admin summary the dashboard
// already loads: refunds and disputes to follow up, team requests to answer,
// team commissions earned by partners and not paid yet, Setup items that are
// missing or need a check, gifts about to expire or full, and new reviews to read. Most urgent first, each with when it started and
// the card (and row) it points to. The Setup card takes its states from
// setupChecks() too, so the two always agree. Pure helpers, unit-tested
// (tests/admin-attention.test.js).

import { compareVersions } from './version.js';
import { payoutCheckWords } from './partners-view.js';
import { PARTNER_PROGRAM, teamTier } from '../src/lib/pricing.js';

/** Nothing records a reply or a decision, so these stay listed for a while after they arrive. */
export const TEAM_REPLY_DAYS = 14;
export const REFUND_FOLLOW_UP_DAYS = 30;
export const GIFT_EXPIRY_DAYS = 14;
export const NEW_REVIEW_DAYS = 14;

const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The cards an item can point to, with the name its “Go to” link uses. */
export const ATTENTION_SECTIONS = Object.freeze({
  refunds: 'Refunds',
  teams: 'Team kit requests',
  partners: 'Partners',
  setup: 'Setup',
  gifts: 'Team gifts',
  reviews: 'Reviews'
});

export const TONES = ['urgent', 'warn', 'info'];

// Order of the kinds of item, most urgent first; within a kind, the oldest (or
// the soonest to expire) first, and Setup in the card's own order.
const KINDS = {
  'refund-waiting': { order: 0, tone: 'urgent' },
  'refund-unmatched': { order: 1, tone: 'urgent' },
  'setup-missing': { order: 2, tone: 'urgent' },
  dispute: { order: 3, tone: 'warn' },
  'refund-partial': { order: 4, tone: 'warn' },
  team: { order: 5, tone: 'warn' },
  'partner-pay': { order: 6, tone: 'warn' },
  'setup-warn': { order: 7, tone: 'warn' },
  'gift-expiring': { order: 8, tone: 'info' },
  'gift-claimed': { order: 9, tone: 'info' },
  reviews: { order: 10, tone: 'info' }
};

const TEAM_NOUNS = { invoice: 'Invoice request', quote: 'Quote request', question: 'Question', talk: 'Talk request' };

const defaultNumber = value => new Intl.NumberFormat().format(Number(value) || 0);
function defaultMoney(amount, currency) {
  if (amount == null || amount === '') return '';
  const value = Number(amount) / 100;
  try {
    return currency ? new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: Number.isInteger(value) ? 0 : 2 }).format(value) : defaultNumber(value);
  } catch (_) {
    return `${value} ${currency}`;
  }
}

const timeOf = iso => {
  const time = Date.parse(String(iso || ''));
  return Number.isFinite(time) ? time : Number.NaN;
};

// "3 min", "2 h", "5 days", "3 weeks", "4 months", "1 year".
function span(ms) {
  if (ms < HOUR) return `${Math.max(1, Math.floor(ms / MINUTE))} min`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)} h`;
  const days = Math.floor(ms / DAY);
  if (days < 14) return `${days} ${days === 1 ? 'day' : 'days'}`;
  if (days < 61) return `${Math.floor(days / 7)} weeks`;
  const months = Math.floor(days / 30.4375);
  if (months < 12) return `${months} months`;
  const years = Math.floor(days / 365.25);
  return `${years} ${years === 1 ? 'year' : 'years'}`;
}

/** How long ago `iso` was, at `now` (ms): “just now”, “5 min ago”, “2 h ago”, “3 days ago”… '' when unknown. */
export function timeAgo(iso, now) {
  const at = timeOf(iso);
  if (Number.isNaN(at)) return '';
  const ms = now - at;
  return ms < MINUTE ? 'just now' : `${span(ms)} ago`;
}

/** How long until `iso`, at `now` (ms): “in 9 days”, “in 5 h”; “expired” once past. '' when unknown. */
export function timeUntil(iso, now) {
  const at = timeOf(iso);
  if (Number.isNaN(at)) return '';
  const ms = at - now;
  return ms <= 0 ? 'expired' : `in ${span(ms)}`;
}

/** The time shown on an item's line. */
export function attentionWhen(item, now) {
  if (item.when === 'setup') return 'this deployment';
  if (item.when === 'until') return timeUntil(item.at, now);
  if (item.when === 'created' || item.when === 'earned') {
    const ago = timeAgo(item.at, now);
    return ago ? `${item.when} ${ago}` : '';
  }
  return timeAgo(item.at, now);
}

const within = (iso, now, days) => {
  const at = timeOf(iso);
  return !Number.isNaN(at) && now - at <= days * DAY;
};

// ---- Setup ----------------------------------------------------------------

const PAYMENT_ITEMS = ['plus', 'gift'];
const PAYMENT_CURRENCIES = ['EUR', 'USD'];
const LEGAL_FIELDS = [['SUPPORT_EMAIL', 'contact address'], ['LEGAL_ADDRESS', 'postal address']];
const MIGRATIONS = [['teamRequestsUnavailable', '0002_team_requests.sql'], ['plusUnavailable', '0003_plus.sql'], ['reviewsUnavailable', '0004_creem_reviews.sql'], ['refundsUnavailable', '0005_refunds.sql'], ['partnersUnavailable', '0006_partners.sql'], ['partnerCommissionsUnavailable', '0007_partner_commissions.sql']];
const listed = words => (words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : words[0] || '');

/**
 * The state of each Setup item ('ok', 'warn' or 'missing') and, when it is
 * not ok, one short sentence per problem. `config` is the page's runtime
 * config (legal details, the app's Plus public key, the partner sign-up link); `pageVersion` this
 * dashboard's own version. [] when the API does not report its setup.
 */
export function setupChecks(summary, { config = {}, pageVersion = '' } = {}) {
  const setup = summary?.setup;
  if (!setup) return [];
  const checks = [];
  const add = (key, state, problems = []) => checks.push({ key, state, problems: state === 'ok' ? [] : problems });

  const server = String(summary.version || '').trim();
  const order = compareVersions(server, pageVersion);
  if (Number.isNaN(order)) add('version', 'warn', ['The API doesn’t report its version: redeploy it']);
  else if (order === 0) add('version', 'ok');
  else add('version', 'warn', [order > 0 ? `This dashboard is ${pageVersion}, ${server} is deployed: reload it` : `This dashboard is ${pageVersion}, the deployed one is ${server}: reload it`]);

  const email = setup.email || {};
  add('email', email.configured ? 'ok' : 'missing', ['Email isn’t set up: nothing can be sent']);
  add('owner-email', email.ownerEmail ? 'ok' : 'missing', ['Owner email isn’t set: no team request notifications']);

  const plus = setup.plus || {};
  const appKey = String(config.PLUS_PUBLIC_KEY || '').trim();
  if (!plus.configured) add('plus', 'missing', [plus.keySet ? 'The Plus signing key isn’t valid' : 'Plus isn’t set up: gifts and licences can’t be made']);
  else add('plus', appKey === plus.publicKey ? 'ok' : 'warn', [appKey ? 'The app’s Plus public key doesn’t match' : 'The app has no Plus public key']);

  const payments = setup.payments || {};
  if (!payments.configured) add('payments', 'missing', ['Payments aren’t set up: nothing can be bought online']);
  else {
    const products = payments.products || {};
    const missingProducts = PAYMENT_ITEMS.flatMap(item => PAYMENT_CURRENCIES.filter(currency => !products[item]?.[currency])).length;
    const problems = [];
    if (payments.mode === 'test') problems.push('Creem is in test mode: no real payments');
    if (payments.error) problems.push('Creem’s settings have an error');
    if (missingProducts) problems.push(`Creem: ${missingProducts} product ${missingProducts === 1 ? 'id is' : 'ids are'} missing`);
    if (!payments.webhookSecretSet) problems.push('Creem’s webhook secret isn’t set: refunds don’t switch Plus off');
    add('payments', problems.length ? 'warn' : 'ok', problems);
  }

  add('links', 'ok');
  // Partners: “Become a partner” needs the Creem affiliate sign-up link (a build variable).
  add('partners', /^https:\/\/\S+$/.test(String(config.AFFILIATE_URL || '').trim()) ? 'ok' : 'warn', ['Partners: the Creem sign-up link isn’t set']);
  const legalMissing = LEGAL_FIELDS.filter(([key]) => !String(config[key] || '').trim()).map(([, label]) => label);
  add('legal', legalMissing.length ? 'warn' : 'ok', [`Legal pages: ${listed(legalMissing)} missing`]);

  const migrations = MIGRATIONS.filter(([flag]) => summary[flag]).map(([, file]) => file);
  const missingText = file => (file === '0007_partner_commissions.sql' ? `Database: run migrations/${file} to track team commissions` : `Database: migration ${file} not applied`);
  add('database', migrations.length ? 'missing' : 'ok', [migrations.length === 1 ? missingText(migrations[0]) : `Database: ${migrations.length} migrations not applied`]);
  add('sign-in', setup.twoFactor ? 'ok' : 'warn', ['Two-factor sign-in is off']);
  return checks;
}

// ---- Refunds ----------------------------------------------------------------

function refundItems(summary, now, { money }) {
  if (summary.refundsUnavailable) return [];
  const rows = Array.isArray(summary.refunds) ? summary.refunds : [];
  const sources = new Set((Array.isArray(summary.revocations) ? summary.revocations : []).map(row => row.source));
  // The API says whether a refund's revocations still stand; an older API, from the revocations listed.
  const inForce = row => (typeof row.inForce === 'boolean' ? row.inForce : sources.has(row.id));
  const gifts = Array.isArray(summary.gifts) ? summary.gifts : [];
  const purchase = row => {
    if (row.item === 'plus') return 'a Plus purchase';
    const gift = gifts.find(item => item.checkoutRef && item.checkoutRef === row.checkoutId);
    return gift ? `${gift.org}’s gift` : 'a team gift';
  };
  // What already switched off a payment: a full refund or dispute whose
  // revocations stand, or any revocation of its checkout or order.
  const revoked = new Set((Array.isArray(summary.revocations) ? summary.revocations : []).map(row => row.target));
  rows.forEach(row => {
    if (row.status === 'pending' || !row.fullRefund || !inForce(row)) return;
    if (row.checkoutId) revoked.add(`checkout:${row.checkoutId}`);
    if (row.orderId) revoked.add(`order:${row.orderId}`);
  });
  const switchedOff = row => (!!row.checkoutId && revoked.has(`checkout:${row.checkoutId}`)) || (!!row.orderId && revoked.has(`order:${row.orderId}`));
  // The server ignores a refund from the other Creem mode (test or live) than its order, and says so in its note.
  const ignored = row => /^Ignored\b/.test(String(row.note || ''));
  const items = [];
  rows.forEach(row => {
    if (ignored(row)) return;
    const noun = row.kind === 'dispute' ? 'dispute' : 'refund';
    const Noun = noun === 'dispute' ? 'Dispute' : 'Refund';
    const amount = money(row.amount, row.currency);
    const base = { section: 'refunds', rows: [`refund:${row.id}`], at: row.createdAt, when: 'since' };
    const detail = text => [amount, text].filter(Boolean).join(' · ');
    if (row.status === 'pending') {
      const tries = Number(row.attempts) > 1 ? ` (${row.attempts} tries)` : '';
      items.push({ ...base, kind: 'refund-waiting', key: `refund-waiting:${row.id}`, icon: 'waiting', text: `${Noun} waiting for Creem`, detail: detail(`Nothing is switched off until Creem’s transaction can be read${tries}.`) });
      return;
    }
    if (!within(row.createdAt, now, REFUND_FOLLOW_UP_DAYS)) return;
    if (!row.item) {
      // Restored by the owner: decided.
      if (row.revoked && !inForce(row)) return;
      items.push({ ...base, kind: 'refund-unmatched', key: `refund-unmatched:${row.id}`, icon: noun, text: `A ${noun} matched no purchase`, detail: detail('Find the payment in Creem, then revoke it by hand if needed.') });
      return;
    }
    if (row.kind === 'dispute') {
      // Every dispute needs an answer in Creem, whatever it switched off; one the owner restored was won.
      if (row.revoked && !inForce(row)) return;
      const off = row.revoked ? 'Plus is off. Follow it in Creem; Restore it if you win.'
        : /^Already\b/.test(String(row.note || '')) ? 'An earlier refund or dispute already switched it off. Answer it in Creem.'
          : 'Nothing was switched off. Answer it in Creem, and revoke it by hand if needed.';
      items.push({ ...base, kind: 'dispute', key: `dispute:${row.id}`, icon: 'dispute', text: `Dispute on ${purchase(row)}`, detail: detail(off) });
      return;
    }
    // A partial refund is decided once a later full refund or a revocation switched the payment off.
    if (!row.fullRefund && !switchedOff(row)) items.push({ ...base, kind: 'refund-partial', key: `refund-partial:${row.id}`, icon: 'refund', text: `Partial refund on ${purchase(row)}`, detail: detail('Nothing was switched off. Decide whether to revoke it by hand.') });
  });
  return items;
}

// ---- Partner commissions ------------------------------------------------------------

/**
 * One line per team commission a partner earned (its refund period passed,
 * no refund or dispute) that isn't marked as paid yet, the longest-waiting
 * first, with what to check before paying it (a code nothing confirmed, a
 * refund or the tax not recorded: then the figure is “at most”). Creem pays
 * the other commissions itself: nothing to do for those. None while migration
 * 0007 is missing: nothing could be marked as paid (Setup says to run it).
 */
function partnerItems(summary, now, { money }) {
  if (summary.partnersUnavailable || summary.partnerCommissionsUnavailable) return [];
  const rows = Array.isArray(summary.partners?.toPay) ? summary.partners.toPay : [];
  const rate = Number(summary.partnerProgram?.teamRate) || PARTNER_PROGRAM.teamRate;
  return rows.filter(row => row?.checkoutId).map(row => {
    const seats = teamTier(row.plan)?.seats;
    const basis = row.base != null ? `${rate}% of ${money(row.base, row.currency)} ${row.basis === 'paid' ? 'paid, tax included' : 'before tax'}` : '';
    return {
      kind: 'partner-pay', key: `partner-pay:${row.checkoutId}`, section: 'partners', rows: [`partner:${row.checkoutId}`], icon: 'partner', at: row.earnedAt, when: 'earned',
      text: `Pay ${row.code} ${row.exact === false ? 'at most ' : ''}${money(row.commission, row.currency)} (${rate}% of a team gift)`,
      detail: [...payoutCheckWords(row, rate), seats ? `Team gift for up to ${new Intl.NumberFormat('en-US').format(seats)} people` : 'Team gift', basis, 'by bank transfer, then Mark as paid'].filter(Boolean).join(' · ')
    };
  });
}

// ---- Team requests, gifts, reviews ---------------------------------------------

function teamItems(summary, now, { number }) {
  if (summary.teamRequestsUnavailable) return [];
  const rows = Array.isArray(summary.teamRequests) ? summary.teamRequests : [];
  return rows.filter(row => within(row.createdAt, now, TEAM_REPLY_DAYS)).map(row => {
    const size = Number(row.teamSize) || 0;
    const who = String(row.name || '').trim() || String(row.email || '').trim();
    return {
      kind: 'team', key: `team:${row.id}`, section: 'teams', rows: [`team:${row.id}`], icon: 'team', at: row.createdAt, when: 'since',
      text: `${TEAM_NOUNS[row.kind] || 'Team request'} from ${String(row.company || '').trim() || 'a team'} waiting for a reply`,
      detail: [size ? `${number(size)} ${size === 1 ? 'person' : 'people'}` : '', who].filter(Boolean).join(' · ')
    };
  });
}

function giftItems(summary, now, { number }) {
  if (summary.plusUnavailable) return [];
  const rows = Array.isArray(summary.gifts) ? summary.gifts : [];
  const items = [];
  rows.forEach(gift => {
    const base = { section: 'gifts', rows: [`gift:${gift.code}`], icon: 'gift' };
    const org = String(gift.org || '').trim();
    const link = org ? `${org}’s gift link` : 'A gift link';
    const left = timeOf(gift.expiresAt) - now;
    if (gift.status === 'available' && left > 0 && left <= GIFT_EXPIRY_DAYS * DAY) {
      items.push({ ...base, kind: 'gift-expiring', key: `gift-expiring:${gift.code}`, at: gift.expiresAt, when: 'until', text: `${link} is about to expire`, detail: `${number(gift.redeemed)} of ${number(gift.seats)} seats activated` });
    } else if (gift.status === 'claimed') {
      items.push({ ...base, kind: 'gift-claimed', key: `gift-claimed:${gift.code}`, at: gift.createdAt, when: 'created', text: `${link} is fully claimed`, detail: `${number(gift.redeemed)} of ${number(gift.limit ?? gift.seats)} activations used` });
    }
  });
  return items;
}

function reviewItems(summary, now) {
  if (summary.reviewsUnavailable) return [];
  const fresh = (Array.isArray(summary.reviews) ? summary.reviews : []).filter(row => within(row.createdAt, now, NEW_REVIEW_DAYS));
  if (!fresh.length) return [];
  const newestFirst = [...fresh].sort((a, b) => timeOf(b.createdAt) - timeOf(a.createdAt));
  const oldest = newestFirst.at(-1);
  const name = String(newestFirst[0].name || '').trim();
  return [{
    kind: 'reviews', key: 'reviews', section: 'reviews', rows: newestFirst.map(row => `review:${row.id}`), icon: 'review', at: oldest.createdAt, when: 'since',
    text: fresh.length === 1 ? `New review${name ? ` from ${name}` : ''} to read` : `${fresh.length} new reviews to read`,
    detail: 'Delete any you would not quote.'
  }];
}

// ---- The list -------------------------------------------------------------------

/**
 * Everything that needs the owner's attention, most urgent first. Each item:
 * { key, kind, tone, section, rows (the elements to highlight, the first one
 * focused), icon, text, detail, at (ISO), when ('since' | 'until' | 'created'
 * | 'earned' | 'setup') }. `now` defaults to the summary's own time.
 */
export function buildAttention(summary, { now, config = {}, pageVersion = '', money = defaultMoney, number = defaultNumber } = {}) {
  if (!summary) return [];
  const at = Number.isFinite(now) ? now : Number.isFinite(timeOf(summary.generatedAt)) ? timeOf(summary.generatedAt) : Date.now();
  const format = { money, number };
  const setup = setupChecks(summary, { config, pageVersion }).flatMap((check, index) => check.problems.map((text, part) => ({
    kind: check.state === 'missing' ? 'setup-missing' : 'setup-warn',
    key: `setup:${check.key}:${part}`, section: 'setup', rows: [`setup:${check.key}`], icon: check.key === 'version' ? 'version' : 'setup',
    text, detail: '', at: '', when: 'setup', position: index * 10 + part
  })));
  const items = [...refundItems(summary, at, format), ...teamItems(summary, at, format), ...partnerItems(summary, at, format), ...setup, ...giftItems(summary, at, format), ...reviewItems(summary, at)];
  const sortKey = item => (item.when === 'setup' ? item.position : timeOf(item.at) || 0);
  return items
    .map(item => ({ ...item, tone: KINDS[item.kind].tone }))
    .sort((a, b) => KINDS[a.kind].order - KINDS[b.kind].order || sortKey(a) - sortKey(b) || a.key.localeCompare(b.key))
    .map(({ position, ...item }) => item);
}

const rank = tone => Math.max(0, TONES.indexOf(tone));
const higher = (a, b) => (!a || rank(b) < rank(a) ? b : a);

/**
 * Per card: how many of its rows need attention and the most urgent tone;
 * per row: its tone. { sections: { refunds: { count, tone } }, rows: Map(row → tone) }.
 */
export function attentionBySection(items) {
  const rows = new Map();
  const sectionRows = new Map();
  items.forEach(item => item.rows.forEach(row => {
    rows.set(row, higher(rows.get(row), item.tone));
    if (!sectionRows.has(item.section)) sectionRows.set(item.section, new Set());
    sectionRows.get(item.section).add(row);
  }));
  const sections = {};
  sectionRows.forEach((set, section) => {
    sections[section] = { count: set.size, tone: [...set].reduce((tone, row) => higher(tone, rows.get(row)), '') };
  });
  return { sections, rows };
}

/** Why some lines stay for a set time: replies and decisions aren't recorded. '' when none of those is listed. */
export function attentionNote(items) {
  const team = items.some(item => item.kind === 'team');
  const refunds = items.some(item => ['refund-unmatched', 'refund-partial', 'dispute'].includes(item.kind));
  if (team && refunds) return `Replies and refund decisions aren’t recorded here, so team requests stay listed for ${TEAM_REPLY_DAYS} days and refunds for ${REFUND_FOLLOW_UP_DAYS}.`;
  if (team) return `Replies aren’t recorded here, so team requests stay listed for ${TEAM_REPLY_DAYS} days.`;
  if (refunds) return `Refund decisions aren’t recorded here, so refunds and disputes stay listed for ${REFUND_FOLLOW_UP_DAYS} days.`;
  return '';
}
