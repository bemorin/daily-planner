// Daily Planner owner API: waitlist sign-ups, team kit requests, versioned
// feedback and anonymous interface counts, plus the private owner dashboard
// endpoints.
//
// The same router runs on Cloudflare Pages Functions (with a D1 store) and in
// scripts/serve.mjs (with a JSON-file store), so local testing behaves like
// production. It uses only standard Request/Response objects.
//
// Privacy contract
// - Counts: an allow-listed event name + app version, aggregated per day. No
//   identifiers, no IP addresses, no cookies, no user agent.
// - Waitlist: the email someone typed, with explicit consent. Deletable.
// - Feedback: what someone chose to send; email only if they added one.
// - Team kit requests: the work email, company, team size, plan, currency and
//   kind of request someone typed, with explicit consent, and the partner code
//   remembered on that browser (?ref= link), if any, so a team order by
//   invoice can earn that partner 10% (migration 0007). Deletable.
// - Email (optional, Resend, see server/email.js): the owner is notified of
//   each team request, and the dashboard can send the one waitlist
//   announcement; every address is deleted as soon as its email is accepted.
//   The device that joined gets a removal token so people can leave the list
//   on their own.
// - Daily Planner Plus (see server/licenses.js, server/gifts.js, server/creem.js):
//   licences are signed tokens kept in the person's own planner. A gift
//   stores the company (or, for a personal gift, the giver's name), its
//   message, the seat count and a counter of activations — never who
//   activated. A purchase stores the Creem checkout id, the licence id and the
//   buyer's email (from Creem, which is the merchant of record). A payment row
//   keeps what was sold, when, for how much and the buyer's country, for the
//   sales chart — no name, no email. The Creem order id of each paid checkout
//   is kept so a refund can be traced back to it (see server/refunds.js).
// - Refunds and disputes: Creem's reference, the amount, whether it was full,
//   the reason Creem gives and what was switched off. A revocation names a
//   licence id, a checkout, an order or a gift — never who used it. The
//   buyer's email Creem sends with a refund only goes into the owner's notice.
// - Licence checks (POST plus/check, about once a week per planner): only the
//   licence (with its random id) is sent; the answer says whether it was
//   revoked. Nothing is stored.
// - Checkouts: the currency follows the buyer's country as Cloudflare sees it
//   (request.cf.country; the euro area pays in EUR, the rest in USD), which is
//   read for that request only and never stored. A partner code from a ?ref=
//   link is passed to Creem as affiliate_code (Plus and personal gifts only:
//   Creem pays their commission; a team gift's 10% is paid by the owner, and
//   its metadata says so) and in the checkout's metadata (sealed); once the
//   checkout is paid, the code is kept with the sale (tables partner_sales and
//   partner_sale_taxes, see server/partners.js: what was bought, who pays the
//   commission, the amount and its tax, the date — a partner code names the
//   partner, not the buyer). Only a checkout our API opened, with a valid
//   seal, is recorded. A code Creem refuses is named in the server log and not
//   recorded. The owner marks team commissions as paid (table partner_payouts:
//   the checkout, the code, the amount, the date) and codes found to be no
//   partner (table partner_code_rejections: the code, the date).
// - Member price: a Plus member buying a personal gift sends their licence
//   with the checkout; it is verified (signature, not revoked) for that
//   request only and never stored. Creem only sees `member: '1'`.
// - Reviews: feedback whose author ticked that it may be quoted, with the
//   name they chose to give (optional). Deletable.
//
// Owner access: POST admin/session exchanges ADMIN_TOKEN (+ an authenticator
// code when ADMIN_TOTP_SECRET is set) for an 8-hour signed session, sent as
// `Authorization: Bearer <session>`. Without ADMIN_TOTP_SECRET the raw token
// is also accepted as the Bearer value. See server/admin-auth.js.

import { base32Decode, issueSession, looksLikeSession, timingSafeEqual, TOTP_MIN_SECRET_BYTES, verifySession, verifyTotp, verifyWaitlistRemoveToken, waitlistRemoveToken } from './admin-auth.js';
import { announcementEmail, createResendMailer, DEFAULT_EMAIL_TIMEOUT_MS, EMAILS_PER_SEND, escapeHtml, htmlDocument, idempotencyKey, parseAddress, plusPurchaseEmail, RESEND_MIN_INTERVAL_MS, textToHtml } from './email.js';
import { cleanOrg, DEFAULT_PUBLIC_BASE_URL, formatGiftCode, giftBuyerEmail, giftExpiry, giftLimit, giftManageUrl, giftStatus, giftUrl, licenseUrl, newGiftCode, normalizeBaseUrl, normalizeGift, normalizeGiftCode, publicGift, validateGiftFields } from './gifts.js';
import { GIFT_REF_RE, giftManageKey, giftRef, importSigningKey, importVerifyKey, isoDay, LICENSE_ID_RE, LICENSE_TOKEN_MAX, newLicenseId, publicKeyFromSigningKey, signLicense, verifyLicense } from './licenses.js';
import { affiliateCode, CHECKOUT_ID_RE, checkoutSeal, checkoutSealValid, createCheckout, CREEM_ITEMS, creemMode, fetchCheckout, fetchTransaction, parseCreemProducts, readCheckout, verifyWebhookSignature } from './creem.js';
import { CREEM_REASONS, OWNER_SOURCE_PREFIX, readRefundEvent, readTransaction, REFUND_EVENTS, refundNoticeEmail, refundScope, refundWaitingEmail, REVOCATION_NOTE_MAX, revocationTarget, shownScope } from './refunds.js';
import { normalizeCodeRejection, normalizePartnerSale, normalizePayout, PARTNER_SALES_LISTED, partnerSaleRow, partnerSummary, PAYOUT_NOTE_MAX, payoutCheck } from './partners.js';
import { currencyForCountry, CURRENCIES, giftPlan, hasMemberPrice, isPersonalGift, isTeamGift, PARTNER_PROGRAM, PERSONAL_GIFTS, priceCents, TEAM_TIERS, validCurrency } from '../src/lib/pricing.js';
// The release this API was deployed with (kept in step with package.json by scripts/check.mjs).
// The dashboard compares it with its own to spot a page served from an old cache.
import { APP_VERSION } from '../src/config.js';

export const EVENT_NAMES = new Set([
  'onboarding_completed',
  'sync_guide_opened',
  'sync_guide_step_2',
  'sync_guide_step_3',
  'drive_connect_clicked',
  'waitlist_form_opened',
  'waitlist_joined',
  'install_modal_opened',
  'install_accepted',
  'feedback_prompt_shown',
  'feedback_opened',
  'feedback_sent',
  'trophy_unlocked',
  'landing_viewed',
  'landing_cta_app',
  'landing_cta_teams',
  'team_form_opened',
  'team_request_sent',
  'manager_email_opened',
  // Daily Planner Plus (app)
  'plus_modal_opened',
  'plus_checkout_clicked',
  'plus_unlocked',
  'gift_opened',
  'gift_redeemed',
  'year_plan_completed',
  'quarter_review_completed',
  'year_review_opened',
  'review_sent',
  'share_image_created',
  // Usage, counted at most once per day, week or month on a device
  'app_active_day',
  'app_active_week',
  'app_active_month',
  'app_installed_day',
  'day_closed',
  'week_view_opened',
  'horizon_opened',
  'progress_opened',
  'journal_opened',
  'unresolved_opened',
  'stats_opened',
  'search_opened',
  'pip_opened',
  'print_used',
  // Team gifts and pricing (landing)
  'pack_checkout_clicked',
  'gift_link_copied',
  'plus_viewed',
  'teams_viewed',
  'pricing_viewed',
  // Partners page (landing)
  'partners_viewed',
  'partner_cta_clicked'
]);

export const FEEDBACK_KINDS = new Set(['idea', 'problem', 'praise', 'other']);
export const DEVICE_KINDS = new Set(['iphone', 'ipad', 'android', 'mac', 'windows', 'linux', 'other']);
export const TEAM_TIMINGS = new Set(['december-2026', 'january-2027', 'q1-2027', 'later']);
// Where a request was sent from: the welcome page (and older Teams pages), the Teams page (1.28) or the planner.
export const TEAM_SOURCES = new Set(['landing', 'teams', 'app']);
export const TEAM_PLAN_LABELS = Object.freeze({
  'up-to-10': 'Up to 10 people',
  'up-to-50': 'Up to 50 people',
  'up-to-100': 'Up to 100 people',
  'up-to-500': 'Up to 500 people',
  'up-to-1000': 'Up to 1,000 people',
  'over-1000': 'Over 1,000 people'
});
// Team requests keep their own list (quotes included); personal gifts are never requested.
export const TEAM_PLANS = new Set(Object.keys(TEAM_PLAN_LABELS));
/** Every plan a gift link can be bought for online, with the label used in gift notes ("Creem · Give Plus"). */
export const GIFT_PLAN_LABELS = Object.freeze(Object.fromEntries([
  ...TEAM_TIERS.map(tier => [tier.plan, TEAM_PLAN_LABELS[tier.plan] || tier.plan]),
  ...PERSONAL_GIFTS.map(gift => [gift.plan, gift.label])
]));
// The name a paid gift shows when the buyer left the checkout field empty.
const GIFT_ORG_FALLBACK = Object.freeze({ 'gift-1': 'A friend', 'family-5': 'Your family' });
const TEAM_ORG_FALLBACK = 'Your company';
export const TEAM_CURRENCIES = new Set(['EUR', 'USD']);
export const TEAM_KIND_LABELS = Object.freeze({ invoice: 'Invoice', quote: 'Quote', talk: 'Talk', question: 'Question' });
export const TEAM_REQUEST_KINDS = new Set(Object.keys(TEAM_KIND_LABELS));
export const TEAM_TIMING_LABELS = Object.freeze({ 'december-2026': 'December 2026', 'january-2027': 'January 2027', 'q1-2027': 'Q1 2027', later: 'Later' });
// Emails sent per UTC day are counted in the events table under a name the
// public events route can never accept, and hidden from the dashboard counts.
export const EMAIL_SENDS_EVENT = 'internal:email_sent';
const INTERNAL_EVENT_PREFIX = 'internal:';
// Resend's free plan: 100 emails a day (3,000 a month).
export const DEFAULT_EMAIL_DAILY_LIMIT = 100;
// A Plus purchase can be claimed again (reinstall, another browser) this many times.
export const PLUS_CLAIMS_MAX = 10;
const NOTIFY_TIMEOUT_MS = 3000;
const BUYER_EMAIL_TIMEOUT_MS = 10000;
const LICENSE_NOTE_MAX = 200;
const PLUS_OFF = 'Daily Planner Plus is not set up on this server yet.';
const GIFT_UNKNOWN = 'We could not find this gift link. Check that it was copied completely.';
const PAYMENT_UNKNOWN = 'We could not find this payment.';
const TEST_NOTE = 'Test mode';
const TEST_PURCHASE = 'This was a test purchase, made before payments went live.';
const EMAIL_IN_FLIGHT_MS = 2 * 60 * 1000;
const NOT_PLUS_PAYMENT = 'This payment is not for Daily Planner Plus.';
const PAYMENTS_OFF = 'Payments are not configured.';
const CHECKOUT_OFF = 'Payments are not set up yet.';
const CURRENCY_NAMES = Object.freeze({ EUR: 'euros', USD: 'US dollars' });
const CHECKOUT_FAILED = 'The checkout could not be opened. Please try again in a minute.';
const INVALID_SIGNATURE = 'Invalid signature';
const UNKNOWN_CHECKOUT_TTL_MS = 10 * 60 * 1000;
const UNKNOWN_CHECKOUTS_MAX = 500;
const REFUNDED_PURCHASE = 'This purchase was refunded, so it can’t be activated any more. If this is a mistake, reply to your receipt email.';
const SWITCHED_OFF_PURCHASE = 'This purchase was switched off, so it can’t be activated any more. If this is a mistake, reply to your receipt email.';
const CHECKOUT_EXPIRED = 'This checkout expired before it was paid.';
const GIFT_INACTIVE = 'This gift link is no longer active.';
const LICENSE_INVALID = 'This licence is not valid.';
const TRANSACTION_UNREAD = 'The refund’s transaction could not be read from Creem; send the event again later.';
export const REFUNDS_LISTED = 100;
// An unmatched refund reads the order of this many recent Creem checkouts that have none recorded yet
// (paid before 1.24), a few at a time: well within a Worker's 50 outside requests.
export const ORDER_BACKFILL_MAX = 40;
const ORDER_BACKFILL_BATCH = 8;
export const REVOCATIONS_LISTED = 500;
// Shown on the Creem checkout of a gift; the answer is the name the gift shows:
// the company for a team gift, the giver for a personal gift (labels ≤ 50 characters).
const COMPANY_FIELD = Object.freeze({ type: 'text', key: 'company', label: 'Company name, shown to your team', optional: true, text: Object.freeze({ max_length: 80 }) });
const FROM_FIELD = Object.freeze({ type: 'text', key: 'from', label: 'Your name, shown with the gift', optional: true, text: Object.freeze({ max_length: 80 }) });
export const REVIEW_NAME_MAX = 60;
export const REVIEWS_LATEST = 50;
export const SERIES_DEFAULT_DAYS = 400;
export const SERIES_MAX_DAYS = 1200;
const MISSING_TABLE = 'A database table is missing. Apply every file in migrations/ to the D1 database (see docs/FEEDBACK_AND_WAITLIST.md).';
const ANNOUNCE_SUBJECT_MAX = 150;
const ANNOUNCE_TEXT_MAX = 8000;
const TEAM_SIZE_MIN = 2;
const TEAM_SIZE_MAX = 100000;
const AUTH_FAILURE_DELAY_MS = 400;
const MAX_BODY_BYTES = 16 * 1024;
// A signed Creem event carries the whole checkout (product, order, customer).
const WEBHOOK_MAX_BYTES = 64 * 1024;
const VERSION_RE = /^\d{1,3}\.\d{1,3}\.\d{1,4}$/;
// Domain limited to letters, digits, dots and hyphens: nothing that could add
// query fields (?bcc=…) to a mailto: link in the dashboard.
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"?&=%/#]{1,64}@[a-z0-9](?:[a-z0-9.-]{0,188}[a-z0-9])?\.[a-z]{2,24}$/i;

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }
});

const clip = (value, max) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);
const dayKey = date => date.toISOString().slice(0, 10);

const sleep = ms => new Promise(resolveSleep => { setTimeout(resolveSleep, ms); });

/** The raw body bytes, at most `max` of them (more throws 'too-large'). */
async function readBody(request, max = MAX_BODY_BYTES) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > max) throw new Error('too-large');
  // Read with a byte cap: a missing or wrong content-length must not let a
  // client stream an unbounded body into memory.
  const chunks = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) { await reader.cancel().catch(() => {}); throw new Error('too-large'); }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function readJson(request) {
  const text = new TextDecoder().decode(await readBody(request));
  try { return JSON.parse(text || '{}'); } catch { throw new Error('invalid-json'); }
}

const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const shiftDay = (day, days) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const isDay = value => ISO_DAY_RE.test(String(value ?? '')) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && shiftDay(value, 0) === value;

/**
 * The days a chart covers: `to` defaults to today, `from` to SERIES_DEFAULT_DAYS
 * before it; reversed days are swapped and the range is cut to SERIES_MAX_DAYS.
 */
export function seriesRange(from, to, todayDay) {
  let end = isDay(to) ? to : todayDay;
  let start = isDay(from) ? from : shiftDay(end, 1 - SERIES_DEFAULT_DAYS);
  if (start > end) [start, end] = [end, start];
  const earliest = shiftDay(end, 1 - SERIES_MAX_DAYS);
  if (start < earliest) start = earliest;
  return { from: start, to: end };
}

function csvCell(value) {
  const text = String(value ?? '');
  // Prefix formula-looking cells so spreadsheets do not execute them.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(rows, columns) {
  return [columns.join(','), ...rows.map(row => columns.map(column => csvCell(row[column])).join(','))].join('\n') + '\n';
}

/** Validate a sign-up. Returns { entry } or { error }. */
export function validateWaitlist(body, now = new Date()) {
  if (body?.website) return { spam: true };
  const email = clip(body?.email, 254).toLowerCase();
  if (!EMAIL_RE.test(email)) return { error: 'Please enter a valid email address.' };
  if (body?.consent !== true) return { error: 'Please confirm that we may email you about account sync.' };
  const devices = Array.isArray(body?.devices) ? [...new Set(body.devices.map(String).filter(device => DEVICE_KINDS.has(device)))] : [];
  const version = VERSION_RE.test(String(body?.version || '')) ? String(body.version) : '';
  return {
    entry: {
      email,
      devices: devices.join(','),
      note: clip(body?.note, 600),
      locale: clip(body?.locale, 24),
      appVersion: version,
      driveSeen: body?.driveSeen === true ? 1 : 0,
      createdAt: now.toISOString()
    }
  };
}

/**
 * Validate feedback. Returns { entry, review } or { error }. `review` is the row
 * to keep for quoting when the author ticked `quote: true` and gave both a
 * rating and a message (with an optional name, at most REVIEW_NAME_MAX characters); null otherwise.
 */
export function validateFeedback(body, now = new Date()) {
  if (body?.website) return { spam: true };
  const version = String(body?.version || '');
  if (!VERSION_RE.test(version)) return { error: 'Unknown app version.' };
  const rating = body?.rating == null || body?.rating === '' ? null : Number(body.rating);
  if (rating != null && !(Number.isInteger(rating) && rating >= 1 && rating <= 5)) return { error: 'Rating must be between 1 and 5.' };
  const message = clip(body?.message, 4000);
  if (rating == null && !message) return { error: 'Add a rating or a few words.' };
  const email = clip(body?.email, 254).toLowerCase();
  if (email && !EMAIL_RE.test(email)) return { error: 'That email address does not look right.' };
  const quote = body?.quote === true;
  const name = quote ? oneLine(clip(body?.name, 1000)) : '';
  if (name.length > REVIEW_NAME_MAX) return { error: `Please keep your name under ${REVIEW_NAME_MAX} characters.` };
  const createdAt = now.toISOString();
  return {
    entry: {
      appVersion: version,
      rating,
      kind: FEEDBACK_KINDS.has(body?.kind) ? body.kind : 'other',
      message,
      email,
      platform: clip(body?.platform, 40),
      createdAt
    },
    review: quote && rating != null && message ? { appVersion: version, rating, text: message, name, createdAt } : null
  };
}

/** Validate a team kit request. Returns { entry }, { error } or { spam }. */
export function validateTeamRequest(body, now = new Date()) {
  if (body?.website) return { spam: true };
  const email = clip(body?.email, 254).toLowerCase();
  if (!EMAIL_RE.test(email)) return { error: 'Please enter a valid work email address.' };
  const company = clip(body?.company, 200);
  if (!company) return { error: 'Please enter your company or organisation.' };
  if (company.length > 120) return { error: 'Please keep the company name under 120 characters.' };
  const rawSize = body?.teamSize;
  const teamSize = typeof rawSize === 'number' || (typeof rawSize === 'string' && /^\s*\d+\s*$/.test(rawSize)) ? Number(rawSize) : NaN;
  if (!Number.isInteger(teamSize) || teamSize < TEAM_SIZE_MIN || teamSize > TEAM_SIZE_MAX) return { error: 'Please enter a team size between 2 and 100,000 people.' };
  const timing = String(body?.timing ?? '');
  if (!TEAM_TIMINGS.has(timing)) return { error: 'Please choose when your team would like to start.' };
  const name = clip(body?.name, 200);
  if (name.length > 80) return { error: 'Please keep your name under 80 characters.' };
  const message = clip(body?.message, 2000);
  if (message.length > 1000) return { error: 'Please keep the message under 1,000 characters.' };
  if (body?.consent !== true) return { error: 'Please confirm that we may email you about the team kit.' };
  const version = VERSION_RE.test(String(body?.version || '')) ? String(body.version) : '';
  return {
    entry: {
      email,
      name,
      company,
      teamSize,
      timing,
      plan: TEAM_PLANS.has(body?.plan) ? body.plan : '',
      currency: TEAM_CURRENCIES.has(body?.currency) ? body.currency : '',
      kind: TEAM_REQUEST_KINDS.has(body?.kind) ? body.kind : 'quote',
      message,
      locale: clip(body?.locale, 35),
      appVersion: version,
      source: TEAM_SOURCES.has(body?.source) ? body.source : 'landing',
      createdAt: now.toISOString(),
      // The partner code remembered on this browser (?ref= link), when there is one: a malformed one is left out, never refused.
      ...(affiliateCode(body?.ref) ? { ref: affiliateCode(body.ref) } : {})
    }
  };
}

/**
 * What the owner reads about a request's partner code ('' when none): nothing
 * checks the code (anyone can type one in a link), so it says to check it in
 * Creem before paying.
 */
export const teamRequestPartnerLine = ref => (ref ? `${ref} — ${PARTNER_PROGRAM.teamRate}% if this becomes an order. Check that ${ref} is a partner in Creem → Affiliate Hub before paying.` : '');

const csvResponse = (rows, columns, filename, cors) => new Response(toCsv(rows, columns), {
  headers: { ...cors, 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${filename}"`, 'cache-control': 'no-store' }
});

const oneLine = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();

/** EMAIL_DAILY_LIMIT: a whole number ≥ 0; blank or invalid means the default (Resend's free plan). */
export function parseDailyLimit(value) {
  if (String(value ?? '').trim() === '') return DEFAULT_EMAIL_DAILY_LIMIT;
  const limit = Number(value);
  return Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : DEFAULT_EMAIL_DAILY_LIMIT;
}

/** The owner's notification for a stored team kit request. Every value is escaped. */
export function teamRequestEmail(entry, dashboardUrl = '') {
  const people = Number(entry.teamSize).toLocaleString('en-US');
  const fields = [
    ['Company', entry.company],
    ['People', people],
    ['Plan', TEAM_PLAN_LABELS[entry.plan] || '—'],
    ['Currency', entry.currency || '—'],
    ['Request', TEAM_KIND_LABELS[entry.kind] || entry.kind || '—'],
    ['Timing', TEAM_TIMING_LABELS[entry.timing] || entry.timing],
    ['Name', entry.name || '—'],
    ['Email', entry.email],
    ['Source', entry.source || '—'],
    ['Locale', entry.locale || '—'],
    ...(entry.ref ? [['Partner', teamRequestPartnerLine(entry.ref)]] : [])
  ];
  const cell = 'padding:4px 16px 4px 0;vertical-align:top';
  const table = `<table style="border-collapse:collapse">${fields.map(([label, value]) => `<tr><td style="${cell};color:#706a62">${escapeHtml(label)}</td><td style="${cell}"><b>${escapeHtml(value)}</b></td></tr>`).join('')}</table>`;
  const message = entry.message ? `<p style="color:#706a62;margin-top:20px">Message</p>\n${textToHtml(entry.message)}` : '<p style="color:#706a62;margin-top:20px">No message.</p>';
  const reply = `<p style="margin-top:20px">Reply to this email to answer ${escapeHtml(entry.name || entry.email)}.${dashboardUrl ? ` All requests: <a href="${escapeHtml(dashboardUrl)}">${escapeHtml(dashboardUrl)}</a>` : ''}</p>`;
  return {
    subject: oneLine(`Team kit request: ${entry.company} (${people} people)`),
    html: htmlDocument(`<p>A team asked for the team kit.</p>\n${table}\n${message}\n${reply}`),
    text: `A team asked for the team kit.\n\n${fields.map(([label, value]) => `${label}: ${oneLine(value)}`).join('\n')}\n\n${entry.message ? `Message:\n${entry.message}` : 'No message.'}\n\nReply to this email to answer ${oneLine(entry.name || entry.email)}.${dashboardUrl ? `\nAll requests: ${dashboardUrl}` : ''}\n`,
    replyTo: { email: entry.email }
  };
}

const isMissingTable = error => /no such table/i.test(String(error?.message || ''));

/**
 * The buyer's country (ISO alpha-2) as Cloudflare sees it: request.cf.country,
 * else the CF-IPCountry header (the dev server and tests set it); '' when unknown.
 */
export function requestCountry(request) {
  const value = String(request?.cf?.country || request?.headers?.get?.('cf-ipcountry') || '').trim();
  return /^[A-Za-z]{2}$/.test(value) ? value.toUpperCase() : '';
}

/** The currency the buyer pays in: EUR in the euro area, USD elsewhere, '' when the country is unknown. */
export const buyerCurrency = request => currencyForCountry(requestCountry(request));

/**
 * @param {object} options
 * @param {object} options.store            createMemoryStore() or createD1Store()
 * @param {string} [options.adminToken]     ADMIN_TOKEN; admin routes answer 503 without it
 * @param {string} [options.adminTotpSecret] ADMIN_TOTP_SECRET (base32); turns on two-factor sign-in
 * @param {string} [options.allowedOrigins] comma-separated origins allowed to call cross-origin
 * @param {() => Date} [options.now]
 * @param {number} [options.authFailureDelayMs] pause before answering a failed sign-in
 * @param {string} [options.resendApiKey]   RESEND_API_KEY; email is off without it
 * @param {string} [options.emailFrom]      EMAIL_FROM, e.g. "Ben Morin <hello@example.com>" (a domain verified in Resend)
 * @param {string} [options.ownerEmail]     OWNER_EMAIL: team request notifications, test sends, reply-to of buyer emails
 * @param {string|number} [options.emailDailyLimit] EMAIL_DAILY_LIMIT (default 100): emails per UTC day
 * @param {typeof fetch} [options.emailFetch] fetch used for Resend (tests inject one)
 * @param {number} [options.emailIntervalMs] pause between two Resend requests of one send
 * @param {number} [options.notifyTimeoutMs] give up on an owner notification after this long
 * @param {string|(() => string)} [options.publicBaseUrl] PUBLIC_BASE_URL for links in emails (default https://planner.bemorin.com)
 * @param {string} [options.plusSigningKey] PLUS_SIGNING_KEY (base64 PKCS#8, P-256); Plus is off without it
 * @param {string} [options.creemApiKey]    CREEM_API_KEY; payments are off without it
 * @param {string} [options.creemWebhookSecret] CREEM_WEBHOOK_SECRET; the webhook answers 503 without it
 * @param {string} [options.creemTestMode]  CREEM_TEST_MODE ('1' uses Creem's test API; so does a creem_test_ key)
 * @param {{ plus?: { EUR?: string, USD?: string }, gift?: { EUR?: string, USD?: string } }} [options.creemProducts]
 *   CREEM_PLUS_EUR, CREEM_PLUS_USD, CREEM_GIFT_EUR, CREEM_GIFT_USD (see creemProductsFromEnv in server/creem.js)
 * @param {typeof fetch} [options.creemFetch] fetch used for Creem (tests and the dev server inject one)
 * @param {(promise: Promise) => void} [options.defer] keeps background work alive after the
 *   response (Pages Functions: context.waitUntil); without it the work simply runs on
 * @param {(message: string) => void} [options.warn] where swallowed email and payment failures are reported
 */
export function createPlannerApi({
  store, adminToken = '', adminTotpSecret = '', allowedOrigins = '', now = () => new Date(), authFailureDelayMs = AUTH_FAILURE_DELAY_MS,
  resendApiKey = '', emailFrom = '', ownerEmail = '', emailDailyLimit = '', emailFetch, emailIntervalMs = RESEND_MIN_INTERVAL_MS, notifyTimeoutMs = NOTIFY_TIMEOUT_MS,
  publicBaseUrl = '', plusSigningKey = '', creemApiKey = '', creemWebhookSecret = '', creemTestMode = '', creemProducts = {}, creemFetch,
  defer = null, warn = message => console.warn(message)
}) {
  const origins = new Set(String(allowedOrigins || '').split(',').map(value => value.trim()).filter(Boolean));
  const totpEnabled = !!String(adminTotpSecret || '').trim();
  const totpKey = totpEnabled ? base32Decode(adminTotpSecret) : null;
  // Sessions are signed with a key the token alone cannot rebuild once 2FA is
  // on, so knowing ADMIN_TOKEN is never enough to mint a session; changing
  // either secret signs every session out.
  const sessionKey = totpEnabled && totpKey ? `${adminToken}\u0000totp:${[...totpKey].map(byte => byte.toString(16).padStart(2, '0')).join('')}` : adminToken;
  // A configured but unusable secret must never fall back to token-only access.
  const totpBroken = totpEnabled && !(totpKey && totpKey.length >= TOTP_MIN_SECRET_BYTES);
  const mailer = createResendMailer({ apiKey: resendApiKey, from: emailFrom, fetch: emailFetch, minIntervalMs: emailIntervalMs });
  const owner = parseAddress(ownerEmail);
  const dailyLimit = parseDailyLimit(emailDailyLimit);
  const today = () => dayKey(now());
  const publicEvents = rows => rows.filter(row => !String(row.name).startsWith(INTERNAL_EVENT_PREFIX));
  const safeWarn = message => { try { warn(message); } catch (_) {} };

  // Plus: licences and gift manage keys both come from PLUS_SIGNING_KEY.
  const signingSecret = String(plusSigningKey || '').trim();
  const signer = () => importSigningKey(signingSecret);
  const manageKeyOf = code => giftManageKey(signingSecret, code);
  let publicKeyPromise = null;
  const plusPublicKey = () => { publicKeyPromise ||= signingSecret ? publicKeyFromSigningKey(signingSecret) : Promise.resolve(''); return publicKeyPromise; };
  const baseUrl = () => normalizeBaseUrl(typeof publicBaseUrl === 'function' ? publicBaseUrl() : publicBaseUrl) || DEFAULT_PUBLIC_BASE_URL;
  // Payments: Creem, with four products and the prices of src/lib/pricing.js.
  const products = parseCreemProducts(creemProducts);
  const creem = { apiKey: String(creemApiKey || '').trim(), mode: '', fetch: creemFetch || globalThis.fetch?.bind(globalThis) };
  creem.mode = creemMode(creem.apiKey, creemTestMode);
  const webhookSecret = String(creemWebhookSecret || '').trim();
  const paymentsConfigured = !!(creem.apiKey && products.byId.size && creem.fetch);
  // Test keys never sell on the production address (anyone could pay with a test
  // card and get a real licence): test on a preview address or locally instead.
  const productionHost = () => { try { return new URL(baseUrl()).hostname; } catch { return ''; } };
  const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
  const testOnProduction = request => {
    if (creem.mode !== 'test') return false;
    try {
      const host = new URL(request.url).hostname;
      return !LOCAL_HOSTS.has(host) && host === productionHost();
    } catch { return true; }
  };
  /** Checkouts return to the address they were opened from (a preview address while testing). */
  const returnBase = request => {
    try {
      const origin = new URL(request.url).origin;
      if (origin === new URL(baseUrl()).origin) return baseUrl();
      return /^https?:\/\/[^/]+$/.test(origin) ? origin : baseUrl();
    } catch { return baseUrl(); }
  };
  const isTestRow = row => String(row?.note || '').startsWith(TEST_NOTE);
  /**
   * A checkout as read from Creem (readCheckout), with what our seal vouches
   * for: `sealed` when our API opened it. Anyone can open a product link by
   * hand and add metadata, so without the seal its partner code, who pays it
   * and the member flag count for nothing (no partner sale, never the member
   * price), and the member flag counts only on a gift.
   */
  async function sealedCheckout(paid) {
    const sealed = await checkoutSealValid(signingSecret, paid);
    const ref = sealed ? paid.ref : '';
    return { ...paid, sealed, ref, payout: ref ? paid.payout : '', member: sealed && paid.item?.kind === 'gift' && paid.member === true };
  }
  /** A gift needs our seal (a product link opened by hand can't pick its pack); every item must match its product's currency. */
  const honoured = paid => {
    if (paid.currency && paid.productCurrency && paid.currency !== paid.productCurrency) return false;
    return paid.item?.kind !== 'gift' || paid.sealed === true;
  };
  // Checkouts Creem did not know, that sell something else or that expired are
  // remembered for a few minutes with their answer, so repeating them costs no
  // Creem call. Per worker instance and best effort: the WAF rate limit is the real guard.
  const unknownCheckouts = new Map();
  const rememberedCheckout = id => {
    const entry = unknownCheckouts.get(id);
    if (!entry) return null;
    if (entry.until > now().getTime()) return entry;
    unknownCheckouts.delete(id);
    return null;
  };
  const rememberCheckout = (id, status, error, flags = {}) => {
    if (unknownCheckouts.size >= UNKNOWN_CHECKOUTS_MAX) unknownCheckouts.delete(unknownCheckouts.keys().next().value);
    unknownCheckouts.set(id, { until: now().getTime() + UNKNOWN_CHECKOUT_TTL_MS, status, error, flags });
  };

  // Refunds (migration 0005, server/refunds.js). Reads tolerate its tables
  // being missing: nothing counts as revoked until the migration is applied.
  const creemReady = !!(creem.apiKey && creem.fetch);
  const giftRefOf = code => giftRef(signingSecret, code);
  /** gift:<gift ref>, the target that revokes every licence activated from a gift; '' while Plus is off. */
  const giftTarget = async code => { const ref = await giftRefOf(code); return ref ? revocationTarget('gift', ref) : ''; };
  let verifyKeyPromise = null;
  const verifyKey = () => { verifyKeyPromise ||= plusPublicKey().then(key => (key ? importVerifyKey(key) : null)); return verifyKeyPromise; };
  async function isRevoked(targets) {
    try { return await store.isRevoked(targets.filter(Boolean)); } catch (error) { if (isMissingTable(error)) return false; throw error; }
  }
  /** Every revocation of these targets, oldest first; none while migration 0005 is missing. */
  async function revocationsOf(targets) {
    try { return await store.listRevocationsFor(targets.filter(Boolean)); } catch (error) { if (isMissingTable(error)) return []; throw error; }
  }
  const byCreem = rows => rows.some(row => CREEM_REASONS.includes(row.reason));
  /** The answer for a purchase link that no longer works: refunded (by Creem) or switched off (by the owner). */
  const refusedAnswer = (rows, cors) => (byCreem(rows) ? json(410, { error: REFUNDED_PURCHASE, refunded: true }, cors) : json(410, { error: SWITCHED_OFF_PURCHASE, revoked: true }, cors));
  /** The Creem order of a paid checkout, so a later refund finds it. Best effort: never blocks a delivery. */
  async function recordOrder(checkoutId, kind, orderId, mode = '') {
    if (!orderId) return;
    try { await store.addOrder({ orderId, checkoutId, kind, mode, createdAt: now().toISOString() }); }
    catch (error) { safeWarn(`Order ${orderId} of ${checkoutId} not recorded: ${error?.message || error}`); }
  }
  /** A sale through a partner's link (migration 0006). Best effort: never blocks a delivery. */
  async function recordPartnerSale(checkoutId, paid, createdAt) {
    const row = partnerSaleRow(checkoutId, paid, createdAt);
    if (!row) return;
    try { await store.addPartnerSale(row); }
    catch (error) { if (!isMissingTable(error)) safeWarn(`Partner sale ${checkoutId} (${row.code}) not recorded: ${error?.message || error}`); }
  }
  /**
   * The member price: true for a Plus licence this server signed that is not
   * revoked (its id, or the gift it came from). Anything else — no licence, a
   * forged or revoked one, the check failing — is the normal price.
   */
  async function memberLicense(value) {
    const token = typeof value === 'string' ? value.trim() : '';
    if (!token || token.length > LICENSE_TOKEN_MAX) return false;
    try {
      const key = await verifyKey();
      const license = key ? await verifyLicense(key, token) : null;
      if (!license) return false;
      const gift = GIFT_REF_RE.test(String(license.gift || '')) ? revocationTarget('gift', license.gift) : '';
      return !await isRevoked([revocationTarget('license', license.id), gift]);
    } catch (error) {
      safeWarn(`Member price not checked: ${error?.message || error}`);
      return false;
    }
  }
  /** Reads a Creem checkout's order and records it; true when one was recorded. */
  async function fetchOrder(checkoutId, kind) {
    const checkout = await fetchCheckout({ ...creem, checkoutId });
    const read = checkout ? readCheckout(checkout, products.byId) : null;
    if (!read?.orderId) return false;
    await store.addOrder({ orderId: read.orderId, checkoutId, kind, mode: read.mode, createdAt: now().toISOString() });
    return true;
  }
  /** A Creem checkout fulfilled before its order was recorded (before 1.24): read it from Creem once, in the background. */
  function recordOrderLater(checkoutId, kind) {
    if (!paymentsConfigured || !checkoutId.startsWith('ch_')) return;
    const task = (async () => {
      if (await store.getOrderByCheckout(checkoutId)) return;
      await fetchOrder(checkoutId, kind);
    })().catch(error => { if (!isMissingTable(error)) safeWarn(`Order of ${checkoutId} not recorded: ${error?.message || error}`); });
    try { defer?.(task); } catch (_) {}
  }
  /**
   * A refund whose order is not recorded: read the orders of the latest Creem
   * checkouts delivered without one (sold before 1.24, links not reopened since),
   * a few at a time, until `orderId` turns up. Returns its order row or null.
   */
  async function backfillOrders(orderId) {
    if (!creemReady) return null;
    let rows;
    try { rows = await store.listCheckoutsWithoutOrder(ORDER_BACKFILL_MAX); } catch (error) { if (isMissingTable(error)) return null; throw error; }
    // Test purchases can't be read with live keys.
    rows = rows.filter(row => !(creem.mode === 'live' && isTestRow(row)));
    for (let start = 0; start < rows.length; start += ORDER_BACKFILL_BATCH) {
      await Promise.all(rows.slice(start, start + ORDER_BACKFILL_BATCH).map(row => fetchOrder(row.checkoutId, row.kind)
        .catch(error => safeWarn(`Order of ${row.checkoutId} not read: ${error?.message || error}`))));
      const order = await store.getOrder(orderId);
      if (order) return order;
    }
    return null;
  }

  // Fire and forget: the 201 never waits for, or fails because of, an email.
  function notifyOwner(entry, dashboardUrl) {
    if (!mailer.configured || !owner) return;
    const task = (async () => {
      await mailer.send({ ...teamRequestEmail(entry, dashboardUrl), recipients: [owner] }, { timeoutMs: notifyTimeoutMs });
      await store.addEmailSends(today(), EMAIL_SENDS_EVENT, 1);
    })().catch(error => safeWarn(`Team request notification not sent: ${error?.message || error}`));
    try { defer?.(task); } catch (_) {}
  }

  async function announce(request, cors) {
    if (request.method !== 'POST') return json(405, { error: 'Method not allowed' }, cors);
    if (!mailer.configured) return json(503, { error: 'Email is not set up. Add RESEND_API_KEY and EMAIL_FROM to this deployment, then redeploy.' }, cors);
    const body = await readJson(request);
    const subject = oneLine(clip(body?.subject, 1000));
    const text = clip(body?.text, ANNOUNCE_TEXT_MAX + 1000).replace(/\r\n?/g, '\n');
    if (!subject) return json(400, { error: 'Add a subject.' }, cors);
    if (subject.length > ANNOUNCE_SUBJECT_MAX) return json(400, { error: `Keep the subject under ${ANNOUNCE_SUBJECT_MAX} characters.` }, cors);
    if (!text) return json(400, { error: 'Write the message first.' }, cors);
    if (text.length > ANNOUNCE_TEXT_MAX) return json(400, { error: `Keep the message under ${ANNOUNCE_TEXT_MAX.toLocaleString('en-US')} characters.` }, cors);
    const content = announcementEmail({ subject, text });
    const day = today();

    if (body?.test === true) {
      if (!owner) return json(503, { error: 'OWNER_EMAIL is not set, so there is nowhere to send a test.' }, cors);
      try {
        await mailer.send({ ...content, subject: `[Test] ${content.subject}`, recipients: [owner] });
      } catch (error) {
        return json(502, { error: `The test was not sent. ${error.message}.` }, cors);
      }
      await store.addEmailSends(day, EMAIL_SENDS_EVENT, 1);
      return json(200, { sent: 1, remaining: await store.countWaitlist(), limitReached: false, dailyLimit, test: true }, cors);
    }

    const sentBefore = await store.emailSendsOn(day, EMAIL_SENDS_EVENT);
    // At most EMAILS_PER_SEND per call (subrequest limits); the owner sends again for the rest.
    const allowance = Math.max(0, Math.min(dailyLimit - sentBefore, EMAILS_PER_SEND));
    const rows = allowance ? await store.oldestWaitlist(allowance) : [];
    let sent = 0;
    let failure = null;
    if (rows.length) {
      try {
        ({ sent } = await mailer.send({ ...content, recipients: rows.map(row => ({ email: row.email, id: row.id })) }, {
          // Resend answers a repeated request (same batch, same words, within
          // 24 hours) without sending again: a safety net if a delete failed.
          idempotency: batch => idempotencyKey('announce', subject, text, batch.map(row => row.id).join(',')),
          // Each accepted batch is counted, then deleted: people asked for exactly one email.
          onBatch: async batch => {
            await store.addEmailSends(day, EMAIL_SENDS_EVENT, batch.length);
            await store.deleteWaitlistIds(batch.map(row => row.id));
          }
        }));
      } catch (error) {
        failure = error;
        sent = Number(error?.sent) || 0;
      }
    }
    const remaining = await store.countWaitlist();
    const limitReached = remaining > 0 && sentBefore + sent >= dailyLimit;
    const result = { sent, remaining, limitReached, dailyLimit };
    if (!failure) return json(200, result, cors);
    if (failure.afterSend) return json(500, { ...result, error: `Sent to ${sent} people, but they could not all be removed from the list (${failure.message}). Check the list before sending again, or someone could get a second email.` }, cors);
    if (!sent) return json(502, { ...result, error: `Nothing was sent. ${failure.message}.` }, cors);
    return json(200, { ...result, error: `Stopped after ${sent} people. ${failure.message}.` }, cors);
  }

  // ---- Daily Planner Plus: gifts, purchases, licences -----------------------

  async function adminGift(gift, nowIso) {
    const manageKey = await manageKeyOf(gift.code);
    const base = baseUrl();
    return {
      ...gift,
      code: formatGiftCode(gift.code),
      limit: giftLimit(gift.seats),
      status: giftStatus(gift, nowIso),
      url: giftUrl(base, gift.code),
      manageKey,
      manageUrl: manageKey ? giftManageUrl(base, gift.code, manageKey) : ''
    };
  }

  /** Store a new gift under a fresh code; a checkout makes at most one gift. */
  async function createGift(fields) {
    const created = now();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const gift = normalizeGift({
        message: '', currency: '', amount: null, source: 'manual', checkoutRef: null, buyerEmail: '', note: '',
        ...fields,
        code: newGiftCode(), redeemed: 0, active: true, createdAt: created.toISOString(), expiresAt: giftExpiry(created), emailedAt: null
      });
      if (await store.addGift(gift)) return gift;
      if (gift.checkoutRef) {
        const existing = await store.getGiftByCheckout(gift.checkoutRef);
        if (existing) return existing;
      }
    }
    throw new Error('Could not create a unique gift code.');
  }

  /**
   * The plan a gift was bought for ('gift-1', 'family-5', 'up-to-50' …), or ''
   * for a gift made in the dashboard. Read from its payment row, else from the
   * note the checkout gave it ("Creem · Give Plus"), as gifts have no plan column.
   */
  async function giftPlanOf(gift) {
    if (!gift?.checkoutRef) return '';
    const payment = await store.getPayment(gift.checkoutRef).catch(() => null);
    if (payment?.kind === 'gift' && giftPlan(payment.plan)) return payment.plan;
    return Object.keys(GIFT_PLAN_LABELS).find(plan => String(gift.note).endsWith(`Creem · ${GIFT_PLAN_LABELS[plan]}`)) || '';
  }

  /**
   * Email the buyer the gift link, the manage link and a message to forward —
   * once per gift: emailed_at is claimed first, and released if Resend refuses.
   * `plan` (else read with giftPlanOf) picks the wording: personal or team.
   */
  async function emailGiftBuyer(gift, manageKey, timeoutMs, { resend = false, plan } = {}) {
    if (!mailer.configured) return { emailed: false, error: 'Email is not set up (RESEND_API_KEY and EMAIL_FROM).' };
    if (!gift.buyerEmail) return { emailed: false, error: 'There is no buyer email address.' };
    // `resend`: send even though another request reserved it moments ago. The
    // Idempotency-Key makes Resend drop the copy if that other send went out.
    if (!await store.markGiftEmailed(gift.code, now().toISOString()) && !resend) return { emailed: false, already: true };
    const base = baseUrl();
    const bought = plan ?? await giftPlanOf(gift);
    try {
      await mailer.send({ ...giftBuyerEmail({ gift, url: giftUrl(base, gift.code), manageUrl: giftManageUrl(base, gift.code, manageKey), plan: bought }), replyTo: owner, recipients: [{ email: gift.buyerEmail }] }, { timeoutMs, idempotency: await idempotencyKey('gift-buyer', gift.code) });
    } catch (error) {
      if (!resend) await store.clearGiftEmailed(gift.code).catch(() => {});
      return { emailed: false, error: String(error?.message || error) };
    }
    await store.addEmailSends(today(), EMAIL_SENDS_EVENT, 1).catch(() => {});
    return { emailed: true };
  }

  function emailGiftBuyerLater(gift, manageKey, plan) {
    if (!mailer.configured || !gift.buyerEmail || gift.emailedAt) return;
    const task = emailGiftBuyer(gift, manageKey, BUYER_EMAIL_TIMEOUT_MS, { plan })
      .then(result => { if (result.error) safeWarn(`Gift email not sent: ${result.error}`); })
      .catch(error => safeWarn(`Gift email not sent: ${error?.message || error}`));
    try { defer?.(task); } catch (_) {}
  }

  async function giftRoute(request, match, cors) {
    const redeem = !!match[2];
    const method = request.method;
    if (redeem ? method !== 'POST' : !['GET', 'PATCH'].includes(method)) return json(405, { error: 'Method not allowed' }, cors);
    const code = normalizeGiftCode(match[1]);
    if (!code) return json(404, { error: GIFT_UNKNOWN }, cors);
    if (method === 'GET') {
      const gift = await store.getGift(code);
      if (!gift) return json(404, { error: GIFT_UNKNOWN }, cors);
      // `revoked`: switched off after a refund, a dispute or by the owner; Plus is then switched off where it was activated too.
      const revoked = await isRevoked([await giftTarget(code), gift.checkoutRef ? revocationTarget('checkout', gift.checkoutRef) : '']);
      return json(200, { ...publicGift(gift, now().toISOString(), await giftPlanOf(gift)), ...(revoked ? { revoked: true } : {}) }, cors);
    }
    const key = await signer();
    if (!key) return json(503, { error: PLUS_OFF }, cors);
    if (method === 'PATCH') {
      const body = await readJson(request);
      const given = typeof body?.key === 'string' ? body.key.trim().toLowerCase() : '';
      if (!/^[0-9a-f]{64}$/.test(given) || !timingSafeEqual(given, await manageKeyOf(code))) return json(403, { error: 'This manage link is not valid.' }, cors);
      const result = validateGiftFields(body, { allowed: ['org', 'message'] });
      if (result.error) return json(400, { error: result.error }, cors);
      const gift = await store.getGift(code);
      if (!gift) return json(404, { error: GIFT_UNKNOWN }, cors);
      if (Object.keys(result.fields).length) await store.updateGift(code, result.fields);
      const updated = { ...gift, ...result.fields };
      return json(200, { ok: true, org: updated.org, message: updated.message }, cors);
    }
    // Redeem: one atomic increment that can never pass the limit. A revoked gift (or gift checkout) is
    // never redeemed, even if its link was switched back on by hand.
    const nowIso = now().toISOString();
    const known = await store.getGift(code);
    if (!known) return json(404, { error: GIFT_UNKNOWN }, cors);
    if (await isRevoked([await giftTarget(code), known.checkoutRef ? revocationTarget('checkout', known.checkoutRef) : ''])) return json(410, { error: GIFT_INACTIVE, revoked: true }, cors);
    if (await store.redeemGift(code, nowIso)) {
      const gift = await store.getGift(code);
      let license;
      try {
        // The gift ref lets a refund of this gift revoke the licence later, with nothing stored per activation.
        license = await signLicense(key, { src: 'gift', gift: await giftRefOf(code), org: gift.org, iat: isoDay(now()) });
      } catch (error) {
        await store.unredeemGift(code).catch(() => {});
        throw error;
      }
      return json(200, { license, org: gift.org, message: gift.message }, cors);
    }
    const gift = await store.getGift(code);
    if (!gift) return json(404, { error: GIFT_UNKNOWN }, cors);
    const status = giftStatus(gift, nowIso);
    if (status === 'expired') return json(410, { error: 'This gift link has expired.' }, cors);
    if (status === 'inactive') return json(410, { error: GIFT_INACTIVE }, cors);
    return json(409, { error: 'This gift has been fully claimed.' }, cors);
  }

  /** `plan`: what the checkout bought ('gift-1', 'up-to-50' …), read with giftPlanOf when not given. */
  async function giftClaimAnswer(gift, cors, plan) {
    const manageKey = await manageKeyOf(gift.code);
    const bought = plan ?? await giftPlanOf(gift);
    emailGiftBuyerLater(gift, manageKey, bought);
    const base = baseUrl();
    return json(200, {
      kind: 'gift', code: formatGiftCode(gift.code), url: giftUrl(base, gift.code), seats: gift.seats, redeemed: gift.redeemed,
      org: gift.org, message: gift.message, manageKey, manageUrl: giftManageUrl(base, gift.code, manageKey), expiresAt: gift.expiresAt, plan: bought
    }, cors);
  }

  async function plusClaimAnswer(purchase, key, cors) {
    if (!await store.claimPurchase(purchase.checkoutRef, PLUS_CLAIMS_MAX)) {
      return json(409, { error: `This purchase has already been activated ${PLUS_CLAIMS_MAX} times. Reply to your receipt and we will help.` }, cors);
    }
    const license = await signLicense(key, { src: 'purchase', id: purchase.licenseId, iat: String(purchase.createdAt).slice(0, 10) });
    return json(200, { kind: 'plus', license }, cors);
  }

  /**
   * Email a Plus buyer the activation link, once per checkout: the payment's
   * emailed_at is claimed first and released if Resend refuses (the webhook is
   * then answered 500, so Creem sends it again). The Idempotency-Key makes a
   * repeat within 24 hours harmless even if our answer was lost.
   */
  async function emailPlusBuyer(checkoutId, email) {
    if (!await store.markPaymentEmailed(checkoutId, now().toISOString())) return { emailed: false, already: true };
    const content = plusPurchaseEmail({ url: `${baseUrl()}/?purchase=${encodeURIComponent(checkoutId)}`, devices: PLUS_CLAIMS_MAX });
    try {
      await mailer.send({ ...content, replyTo: owner, recipients: [{ email }] }, { timeoutMs: BUYER_EMAIL_TIMEOUT_MS, idempotency: await idempotencyKey('plus-purchase', checkoutId) });
    } catch (error) {
      await store.clearPaymentEmailed(checkoutId).catch(() => {});
      return { emailed: false, error: String(error?.message || error) };
    }
    await store.addEmailSends(today(), EMAIL_SENDS_EVENT, 1).catch(() => {});
    return { emailed: true };
  }

  /**
   * Turn a paid checkout into what it bought, once: the same checkout always
   * gives the same purchase (one licence id) or the same gift, whether the
   * claim or the webhook comes first. The payment row feeds the sales chart;
   * a claim still answers when it cannot be written (migration 0004 missing),
   * the webhook does not (Creem retries it). The order id is recorded for
   * refunds, and the partner code (if any) for the Partners card, without
   * ever holding up a delivery (migrations 0005 and 0006 missing).
   * A checkout or an order revoked before delivery (refunded before the buyer
   * came back, or switched off by the owner) delivers nothing: { refused }.
   */
  async function fulfil(checkoutId, paid, { strict }) {
    const createdAt = now().toISOString();
    const { kind, plan, seats } = paid.item;
    const payment = store.addPayment({ checkoutId, kind, plan, seats, amount: paid.amount, currency: paid.currency, country: paid.country, createdAt });
    if (strict) await payment;
    else await payment.catch(error => safeWarn(`Payment ${checkoutId} not recorded: ${error?.message || error}`));
    await recordOrder(checkoutId, kind, paid.orderId, paid.mode);
    await recordPartnerSale(checkoutId, paid, createdAt);
    const blocked = await revocationsOf([revocationTarget('checkout', checkoutId), paid.orderId ? revocationTarget('order', paid.orderId) : '']);
    if (blocked.length) {
      await linkRefused(checkoutId, kind, blocked);
      return { refused: blocked };
    }
    if (kind === 'plus') {
      await store.addPurchase({ checkoutRef: checkoutId, kind: 'plus', licenseId: newLicenseId(), claims: 0, email: paid.email.slice(0, 254), note: creem.mode === 'test' ? TEST_NOTE : '', createdAt });
      return { purchase: await store.getPurchase(checkoutId) };
    }
    const gift = await createGift({
      // The name typed on the checkout: the company, or the giver of a personal gift.
      org: cleanOrg(paid.org) || GIFT_ORG_FALLBACK[plan] || TEAM_ORG_FALLBACK,
      seats,
      source: 'creem',
      checkoutRef: checkoutId,
      buyerEmail: paid.email.slice(0, 254),
      currency: paid.currency,
      amount: paid.amount,
      note: `${creem.mode === 'test' ? `${TEST_NOTE} · ` : ''}Creem · ${GIFT_PLAN_LABELS[plan] || plan}`
    });
    return { gift, plan };
  }

  /**
   * A checkout refused at delivery: its own target joins every decision that
   * blocked it (so Restore lets it through again), and a refund that matched
   * nothing until now names the checkout it paid for.
   */
  async function linkRefused(checkoutId, kind, rows) {
    const target = revocationTarget('checkout', checkoutId);
    for (const source of new Set(rows.map(row => row.source))) {
      const group = rows.filter(row => row.source === source);
      if (group.some(row => row.target === target)) continue;
      const [first] = group;
      await store.addRevocations([{ target, source, kind: 'checkout', label: checkoutId, reason: first.reason, note: first.note, createdAt: first.createdAt }]);
      if (!CREEM_REASONS.includes(first.reason)) continue;
      const refund = await store.getRefund(source);
      if (refund && !refund.item) await store.linkRefund(source, { checkoutId, item: kind, revoked: [...new Set([...String(refund.revoked).split(' ').filter(Boolean), target])].join(' ') });
    }
    safeWarn(`Checkout ${checkoutId} was paid, but ${byCreem(rows) ? 'refunded' : 'switched off'} before it was delivered (${[...new Set(rows.map(row => row.source))].join(', ')}): nothing was delivered or emailed.`);
  }

  async function claimRoute(request, cors) {
    if (request.method !== 'POST') return json(405, { error: 'Method not allowed' }, cors);
    const body = await readJson(request);
    const key = await signer();
    if (!key) return json(503, { error: PLUS_OFF }, cors);
    // `checkout` (Creem's checkout_id); `session` is the older name of the same field.
    const given = typeof body?.checkout === 'string' ? body.checkout : typeof body?.session === 'string' ? body.session : '';
    const checkoutId = given.trim();
    if (!CHECKOUT_ID_RE.test(checkoutId)) return json(404, { error: PAYMENT_UNKNOWN }, cors);
    // The gift page asks for a gift only: a Plus purchase opened there is sent
    // to the planner instead of spending one of its activations here.
    const giftOnly = body?.expect === 'gift';
    const notAGift = () => json(409, { kind: 'plus', error: 'This payment is for Daily Planner Plus: open it in the planner.' }, cors);
    // A refunded, disputed or switched-off checkout gives nothing any more (its gift link is switched off too).
    const revoked = await revocationsOf([revocationTarget('checkout', checkoutId)]);
    if (revoked.length) return refusedAnswer(revoked, cors);
    // Known checkouts are answered from the database, without asking Creem again —
    // except purchases made while testing, once the live keys are in place.
    const purchase = await store.getPurchase(checkoutId);
    if (purchase?.kind === 'plus') {
      if (creem.mode === 'live' && isTestRow(purchase)) return json(410, { error: TEST_PURCHASE, test: true }, cors);
      if (!giftOnly) recordOrderLater(checkoutId, 'plus');
      return giftOnly ? notAGift() : plusClaimAnswer(purchase, key, cors);
    }
    const existingGift = await store.getGiftByCheckout(checkoutId);
    if (existingGift) {
      if (creem.mode === 'live' && isTestRow(existingGift)) return json(410, { error: TEST_PURCHASE, test: true }, cors);
      recordOrderLater(checkoutId, 'gift');
      return giftClaimAnswer(existingGift, cors);
    }
    const remembered = rememberedCheckout(checkoutId);
    if (remembered) return json(remembered.status, { error: remembered.error, ...remembered.flags }, cors);
    if (!paymentsConfigured) return json(503, { error: PAYMENTS_OFF }, cors);

    let checkout;
    try {
      checkout = await fetchCheckout({ ...creem, checkoutId });
    } catch (error) {
      safeWarn(`Creem checkout not read: ${error?.message || error}`);
      return json(502, { error: 'The payment could not be checked right now. Please try again in a minute.' }, cors);
    }
    const refuse = (status, error, flags = {}) => { rememberCheckout(checkoutId, status, error, flags); return json(status, { error, ...flags }, cors); };
    if (!checkout) return refuse(404, PAYMENT_UNKNOWN);
    const paid = await sealedCheckout(readCheckout(checkout, products.byId));
    if (!paid.item || !honoured(paid)) return refuse(404, NOT_PLUS_PAYMENT);
    if (checkout.status === 'expired') return refuse(410, CHECKOUT_EXPIRED, { expired: true });
    if (!paid.paid) return json(402, { error: 'This payment is not complete yet.' }, cors);
    if (giftOnly && paid.item.kind === 'plus') return notAGift();
    const result = await fulfil(checkoutId, paid, { strict: false });
    if (result.refused) return refusedAnswer(result.refused, cors);
    if (result.gift) return giftClaimAnswer(result.gift, cors, result.plan);
    if (result.purchase?.kind === 'plus') return plusClaimAnswer(result.purchase, key, cors);
    return json(404, { error: PAYMENT_UNKNOWN }, cors);
  }

  /**
   * What can be bought right now (currencies with a product, while payments and
   * Plus are set up) and `currency`, the one this buyer pays in: from their
   * country, '' when it is unknown (local development).
   */
  async function checkoutOptions(request) {
    const ready = paymentsConfigured && !testOnProduction(request) && !!await signer();
    const currencies = item => (ready ? CURRENCIES.filter(currency => products.ids[item][currency]) : []);
    return { plus: currencies('plus'), gift: currencies('gift'), currency: buyerCurrency(request), test: ready && creem.mode === 'test' };
  }

  /**
   * Open the Creem checkout. A partner code Creem refuses (HTTP 400: unknown,
   * paused or mistyped) must never block a sale: the checkout is opened again,
   * once, without it (in the metadata and the seal too, so the sale isn't
   * listed under a partner Creem doesn't credit), and the owner is told in the
   * logs. `sealWithout()` is the seal of the same checkout without the code.
   */
  async function openCheckout(payload, sealWithout) {
    try {
      return await createCheckout({ ...creem, body: payload });
    } catch (error) {
      if (!payload.affiliate_code || error?.status !== 400) throw error;
      const { affiliate_code: refused, ...plain } = payload;
      const { ref: _dropped, ...metadata } = plain.metadata;
      metadata.seal = await sealWithout();
      safeWarn(`Creem refused the affiliate code "${refused}" (${error.message}); the checkout is opened without it.`);
      return createCheckout({ ...creem, body: { ...plain, metadata } });
    }
  }

  async function checkoutRoute(request, cors) {
    if (request.method === 'GET') return json(200, await checkoutOptions(request), cors);
    if (request.method !== 'POST') return json(405, { error: 'Method not allowed' }, cors);
    const body = await readJson(request);
    const item = typeof body?.item === 'string' ? body.item : '';
    if (!CREEM_ITEMS.includes(item)) return json(400, { error: 'Choose Daily Planner Plus or a gift.' }, cors);
    // The buyer's country decides (the euro area pays in EUR, everyone else in
    // USD), whatever the page sent; the page's currency counts only when the
    // country is unknown.
    const asked = validCurrency(typeof body?.currency === 'string' ? body.currency.trim().toUpperCase() : '');
    const currency = buyerCurrency(request) || asked;
    if (!currency) return json(400, { error: 'Choose a currency: EUR or USD.' }, cors);
    const gift = item === 'gift' ? giftPlan(typeof body?.plan === 'string' ? body.plan : '') : null;
    if (item === 'gift' && !gift) return json(400, { error: 'Choose which gift to buy.' }, cors);
    if (!paymentsConfigured || testOnProduction(request) || !await signer()) return json(503, { error: CHECKOUT_OFF }, cors);
    const productId = products.ids[item][currency];
    if (!productId) {
      // Never switched to another currency: the buyer would pay a price they were not shown.
      const elsewhere = CURRENCIES.some(other => products.ids[item][other]);
      return json(503, { error: elsewhere ? `Payments in ${CURRENCY_NAMES[currency]} are not set up yet.` : CHECKOUT_OFF }, cors);
    }
    const base = returnBase(request);
    const rid = `dp_${newLicenseId()}`;
    const plan = gift?.plan || '';
    // Someone who has Plus pays the member price for a personal gift, with a licence this server verifies.
    const member = item === 'gift' && hasMemberPrice(plan, currency) ? await memberLicense(body?.license) : false;
    // A partner's code (from a ?ref= link) is sealed with the rest: only a checkout opened here is listed under a partner.
    // A team gift's checkout also seals that the owner pays its partner (Creem doesn't: it never sees the code).
    const ref = affiliateCode(body?.ref);
    const ownerPays = isTeamGift(item, plan);
    const sealOf = code => checkoutSeal(signingSecret, { kind: item, plan, currency, rid, member, ref: code, payout: code && ownerPays ? 'owner' : '' });
    const seal = await sealOf(ref);
    const payload = item === 'plus'
      ? { product_id: productId, request_id: rid, success_url: `${base}/`, metadata: { kind: 'plus', currency, rid, seal } }
      : {
        product_id: productId,
        request_id: rid,
        units: 1,
        custom_price: priceCents('gift', plan, currency, { member }),
        custom_fields: [isPersonalGift(plan) ? FROM_FIELD : COMPANY_FIELD],
        success_url: `${base}/welcome/thanks/`,
        metadata: { kind: 'gift', plan, seats: String(gift.seats), currency, rid, seal, ...(member ? { member: '1' } : {}) }
      };
    // The partner's code goes in the metadata, so the paid sale is listed under it (never the return address),
    // and to Creem as affiliate_code, which credits the partner — except for a team gift: Creem has one rate per
    // program (25%), and a team gift earns its partner 10%, paid by the owner (`payout: 'owner'`, so the sale is
    // never taken for one sent to Creem before 1.28). The licence is never sent to Creem.
    if (ref) {
      payload.metadata.ref = ref;
      if (ownerPays) payload.metadata.payout = 'owner';
      else payload.affiliate_code = ref;
    }
    let checkout;
    try {
      checkout = await openCheckout(payload, () => sealOf(''));
    } catch (error) {
      safeWarn(`Creem checkout not opened: ${error?.message || error}`);
      return json(502, { error: CHECKOUT_FAILED }, cors);
    }
    const url = typeof checkout.checkout_url === 'string' ? checkout.checkout_url : '';
    if (!/^https?:\/\/[^\s]+$/i.test(url)) {
      safeWarn('Creem checkout not opened: the answer has no checkout_url.');
      return json(502, { error: CHECKOUT_FAILED }, cors);
    }
    return json(201, { url, ...(member ? { member: true } : {}) }, cors);
  }

  /**
   * POST /api/creem/webhook. The signature covers the raw body, so the body is
   * read as bytes before any JSON parsing. checkout.completed is processed like
   * a claim (idempotent) and emails the buyer; refund.created and
   * dispute.created go to refundWebhook(); other events are acknowledged.
   * Any failure answers 5xx so Creem tries again later.
   */
  async function webhookRoute(request, cors) {
    if (request.method !== 'POST') return json(405, { error: 'Method not allowed' }, cors);
    if (!webhookSecret) return json(503, { error: 'The Creem webhook is not set up: add CREEM_WEBHOOK_SECRET, then redeploy.' }, cors);
    const signature = (request.headers.get('creem-signature') || '').trim();
    if (!/^[0-9a-f]{64}$/i.test(signature)) return json(401, { error: INVALID_SIGNATURE }, cors);
    const raw = await readBody(request, WEBHOOK_MAX_BYTES);
    if (!await verifyWebhookSignature(raw, signature, webhookSecret)) return json(401, { error: INVALID_SIGNATURE }, cors);
    let event;
    try { event = JSON.parse(new TextDecoder().decode(raw)); } catch { return json(400, { error: 'Invalid JSON' }, cors); }
    const received = () => json(200, { received: true }, cors);
    const type = String(event?.eventType || event?.type || '');
    if (Object.hasOwn(REFUND_EVENTS, type)) return refundWebhook(event, cors);
    if (type !== 'checkout.completed') return received();
    // Creem sends the checkout as `object`; `data` (or data.object) is read too, defensively.
    const checkout = [event?.object, event?.data?.object, event?.data].find(value => value && typeof value === 'object' && !Array.isArray(value));
    const checkoutId = String(checkout?.id ?? '').trim();
    if (!CHECKOUT_ID_RE.test(checkoutId)) {
      safeWarn('Creem webhook: checkout.completed without a usable checkout id.');
      return received();
    }
    const paid = await sealedCheckout(readCheckout(checkout, products.byId));
    if (!paid.item) {
      safeWarn(`Creem webhook: checkout ${checkoutId} is not for a Daily Planner product (${paid.productId || 'no product'}); nothing to do.`);
      return received();
    }
    if (!honoured(paid)) {
      safeWarn(`Creem webhook: checkout ${checkoutId} was not opened by this site (no valid seal); nothing delivered. Check it in Creem and refund or create the gift by hand.`);
      return received();
    }
    if (!paid.paid) return received();
    if (!await signer()) return json(503, { error: PLUS_OFF }, cors);
    const result = await fulfil(checkoutId, paid, { strict: true });
    // Refunded or switched off before delivery: nothing to deliver, nobody to email (Creem needs no retry).
    if (result.refused) return received();
    let email = null;
    if (result.gift && mailer.configured && result.gift.buyerEmail) {
      email = await emailGiftBuyer(result.gift, await manageKeyOf(result.gift.code), BUYER_EMAIL_TIMEOUT_MS, { plan: result.plan });
      // The gift page may have started the same email moments ago and could still
      // fail: send it here too (Resend keeps one copy per Idempotency-Key).
      if (email.already) {
        const current = await store.getGift(result.gift.code);
        const startedAt = Date.parse(current?.emailedAt || '');
        if (Number.isFinite(startedAt) && now().getTime() - startedAt < EMAIL_IN_FLIGHT_MS) {
          email = await emailGiftBuyer(current, await manageKeyOf(current.code), BUYER_EMAIL_TIMEOUT_MS, { resend: true, plan: result.plan });
        }
      }
    }
    const buyer = result.purchase?.email || paid.email;
    if (result.purchase?.kind === 'plus' && mailer.configured && buyer) email = await emailPlusBuyer(checkoutId, buyer);
    if (email?.error) {
      safeWarn(`Buyer email for ${checkoutId} not sent: ${email.error}`);
      return json(500, { error: 'The buyer email was not sent; it will be tried again.' }, cors);
    }
    return received();
  }

  // ---- Refunds, disputes and revocations (server/refunds.js) ----------------

  /**
   * The rows that switch off what a checkout gave: its links (claim and gift
   * page), its order (so it is never delivered later), its licence (a Plus
   * purchase) or its gift link and every licence activated from it.
   */
  async function checkoutRows({ checkoutId = '', orderId = '', purchase = null, gift = null }) {
    const rows = [];
    if (checkoutId) rows.push({ target: revocationTarget('checkout', checkoutId), kind: 'checkout', label: checkoutId });
    if (orderId) rows.push({ target: revocationTarget('order', orderId), kind: 'order', label: orderId });
    if (LICENSE_ID_RE.test(String(purchase?.licenseId || ''))) rows.push({ target: revocationTarget('license', purchase.licenseId), kind: 'license', label: purchase.licenseId });
    if (gift) rows.push(...await giftRows(gift));
    return rows;
  }

  /** The row that revokes a gift, with whether its link was on before it was first revoked (Restore brings back exactly that). */
  async function giftRows(gift) {
    const target = await giftTarget(gift.code);
    if (!target) return [];
    const earlier = (await revocationsOf([target])).find(row => typeof row.wasActive === 'boolean');
    return [{ target, kind: 'gift', label: formatGiftCode(gift.code), wasActive: earlier ? earlier.wasActive : !!gift.active, code: gift.code }];
  }

  /** Stores the rows under one decision; a gift's link is switched off right away. Returns the targets. */
  async function addRevocations(rows, { source, reason, note = '' }) {
    for (const row of rows) if (row.code) await store.updateGift(row.code, { active: false });
    const createdAt = now().toISOString();
    await store.addRevocations(rows.map(({ code, ...row }) => ({ ...row, source, reason, note, createdAt })));
    return rows.map(row => row.target);
  }

  function notifyRefund(content, key) {
    if (!mailer.configured || !owner) return;
    const task = (async () => {
      await mailer.send({ ...content, recipients: [owner] }, { timeoutMs: notifyTimeoutMs, idempotency: await idempotencyKey('refund-notice', key) });
      await store.addEmailSends(today(), EMAIL_SENDS_EVENT, 1);
    })().catch(error => safeWarn(`Refund notice not sent: ${error?.message || error}`));
    try { defer?.(task); } catch (_) {}
  }

  /**
   * Creem's transaction could not be read: the event is kept as waiting (the
   * dashboard shows why) and Creem tries again. When its next try fails too,
   * the owner is emailed, once per refund.
   */
  async function refundWaiting(refund, existing, error) {
    const reason = oneLine(error).slice(0, 160);
    const note = `Creem’s transaction could not be read: ${reason}`;
    if (!existing) {
      await store.addRefund({ id: refund.id, kind: refund.kind, orderId: refund.orderId, transactionId: refund.transactionId, amount: refund.amount, currency: refund.currency, reason: refund.reason, status: 'pending', note, attempts: 1, createdAt: refund.createdAt });
      return;
    }
    await store.retryRefund(refund.id, note);
    if (await store.markRefundNotified(refund.id)) notifyRefund(refundWaitingEmail({ refund, error: reason, dashboardUrl: `${baseUrl()}/admin/` }), `waiting:${refund.id}`);
  }

  /**
   * refund.created and dispute.created, once per refund or dispute id. The
   * transaction leads to the order recorded when the checkout was paid; an
   * order not recorded yet is looked for among the latest checkouts delivered
   * without one. A full refund or a dispute revokes what the checkout gave,
   * and its order, so a purchase not delivered yet never is; a partial refund
   * revokes nothing; a refund from the other Creem mode (test or live) than
   * its order is never matched. Every event is recorded (matched or not) and
   * the owner is emailed. A refund that matches nothing still answers 200:
   * Creem would only send it again. One whose transaction can't be read is
   * kept as waiting and answered 502, so Creem sends it again.
   */
  async function refundWebhook(event, cors) {
    const received = () => json(200, { received: true }, cors);
    const refund = readRefundEvent(event, now().toISOString());
    if (!refund?.id) {
      safeWarn(`Creem webhook: ${refund?.kind || 'refund'} without an id; nothing recorded.`);
      return received();
    }
    const existing = await store.getRefund(refund.id);
    if (existing && existing.status !== 'pending') return received();
    let transaction = null;
    if (refund.transactionId && creemReady) {
      try {
        const entity = await fetchTransaction({ ...creem, transactionId: refund.transactionId });
        transaction = entity ? readTransaction(entity) : null;
      } catch (error) {
        safeWarn(`Creem transaction ${refund.transactionId} not read: ${error?.message || error}`);
        await refundWaiting(refund, existing, String(error?.message || error));
        return json(502, { error: TRANSACTION_UNREAD }, cors);
      }
    }
    const orderId = refund.orderId || transaction?.orderId || '';
    let order = orderId ? await store.getOrder(orderId) : null;
    let checkoutId = order?.checkoutId || refund.checkoutId || '';
    let purchase = checkoutId ? await store.getPurchase(checkoutId) : null;
    let gift = checkoutId && !purchase ? await store.getGiftByCheckout(checkoutId) : null;
    if (orderId && !order && !purchase && !gift) {
      order = await backfillOrders(orderId);
      if (order) {
        checkoutId = order.checkoutId;
        purchase = await store.getPurchase(checkoutId);
        gift = purchase ? null : await store.getGiftByCheckout(checkoutId);
      }
    }
    const mode = transaction?.mode || refund.mode || '';
    const otherMode = order?.mode && mode && order.mode !== mode ? { refund: mode, order: order.mode } : null;
    if (otherMode) safeWarn(`Creem webhook: ${refund.kind} ${refund.id} is in ${mode} mode but order ${orderId} was paid in ${order.mode} mode; ignored.`);
    const matched = !otherMode && !!(checkoutId && (purchase || gift || order));
    const item = matched ? (purchase ? 'plus' : gift ? 'gift' : order?.kind || '') : '';
    const scope = refundScope(refund, transaction);
    let revoked = [];
    let already = false;
    if (scope === 'full' && !otherMode) {
      // Unmatched: its order (and checkout, when Creem names it) is still blocked, in case it is delivered later.
      const rows = await checkoutRows(matched ? { checkoutId, orderId, purchase, gift } : { checkoutId: CHECKOUT_ID_RE.test(refund.checkoutId) ? refund.checkoutId : '', orderId });
      // Already switched off by another refund or dispute of the same payment: one decision, so one Restore.
      already = rows.length > 0 && byCreem((await revocationsOf(rows.map(row => row.target))).filter(row => row.source !== refund.id));
      if (rows.length && !already) revoked = await addRevocations(rows, { source: refund.id, reason: refund.kind });
    }
    if (!matched && !otherMode) safeWarn(`Creem webhook: ${refund.kind} ${refund.id} (transaction ${refund.transactionId || 'unknown'}, order ${orderId || 'unknown'}) matches no purchase; nothing was switched off${revoked.length ? ', and its order will not be delivered' : ''}. It is listed in the dashboard.`);
    const row = {
      id: refund.id, kind: refund.kind, orderId, transactionId: refund.transactionId, checkoutId: matched ? checkoutId : '', item, amount: refund.amount, currency: refund.currency,
      fullRefund: scope === 'full', scope: shownScope(refund, transaction), reason: refund.reason, revoked: revoked.join(' '),
      note: otherMode ? `Ignored: it is in ${otherMode.refund} mode, but its order was paid in ${otherMode.order} mode.` : already ? 'Already switched off by an earlier refund or dispute.' : '',
      createdAt: refund.createdAt
    };
    const written = existing ? await store.completeRefund(row) : await store.addRefund(row);
    if (written) {
      const match = matched
        ? { item, checkoutId, giftCode: gift ? formatGiftCode(gift.code) : '', giftOrg: gift?.org || '', giftRedeemed: gift?.redeemed || 0, amountPaid: transaction?.amountPaid ?? refund.amountPaid, delivered: !!(purchase || gift), already }
        : { otherMode, blocked: revoked.length > 0 };
      notifyRefund(refundNoticeEmail({ refund, scope: row.scope, match, dashboardUrl: `${baseUrl()}/admin/` }), refund.id);
    }
    return received();
  }

  /** POST plus/check { license }: { ok, revoked }. Only the licence is read, and nothing is stored. */
  async function plusCheckRoute(request, cors) {
    if (request.method !== 'POST') return json(405, { error: 'Method not allowed' }, cors);
    const body = await readJson(request);
    const key = await verifyKey();
    if (!key) return json(503, { error: PLUS_OFF }, cors);
    const token = typeof body?.license === 'string' ? body.license.trim() : '';
    const license = token && token.length <= LICENSE_TOKEN_MAX ? await verifyLicense(key, token) : null;
    if (!license) return json(400, { error: LICENSE_INVALID }, cors);
    const gift = GIFT_REF_RE.test(String(license.gift || '')) ? revocationTarget('gift', license.gift) : '';
    return json(200, { ok: true, revoked: await isRevoked([revocationTarget('license', license.id), gift]) }, cors);
  }

  /**
   * What the owner pasted to revoke by hand: a licence (its id or the whole
   * DP1… token), a gift code or a checkout id — a Creem checkout (ch_…) not
   * delivered yet too, so it never is. Returns { rows, undelivered? } or { error, status }.
   */
  async function ownerRevocation(text) {
    const value = String(text ?? '').trim();
    if (/^DP1\./.test(value)) {
      const license = await verifyLicense(await verifyKey(), value);
      if (!license) return { status: 400, error: 'This licence could not be verified with this server’s key.' };
      return { rows: [{ target: revocationTarget('license', license.id), kind: 'license', label: license.id }] };
    }
    if (LICENSE_ID_RE.test(value.toLowerCase())) return { rows: [{ target: revocationTarget('license', value.toLowerCase()), kind: 'license', label: value.toLowerCase() }] };
    const code = normalizeGiftCode(value);
    if (code) {
      const gift = await store.getGift(code);
      if (!gift) return { status: 404, error: 'No gift has this code.' };
      if (!await giftRefOf(code)) return { status: 503, error: PLUS_OFF };
      return { rows: await checkoutRows({ checkoutId: gift.checkoutRef || '', gift }) };
    }
    if (!CHECKOUT_ID_RE.test(value)) return { status: 400, error: 'Paste a licence id (16 letters and digits), a checkout id (ch_…) or a gift code.' };
    const purchase = await store.getPurchase(value);
    const gift = purchase ? null : await store.getGiftByCheckout(value);
    if (gift && !await giftRefOf(gift.code)) return { status: 503, error: PLUS_OFF };
    if (!purchase && !gift && !value.startsWith('ch_')) return { status: 404, error: 'No purchase or gift has this checkout id.' };
    return { rows: await checkoutRows({ checkoutId: value, purchase, gift }), undelivered: !purchase && !gift };
  }

  /** POST admin/revocations { target, note } revokes by hand; DELETE admin/revocations/<source> restores one group. */
  async function adminRevocations(request, path, cors) {
    if (path === 'admin/revocations') {
      if (request.method !== 'POST') return json(405, { error: 'Method not allowed' }, cors);
      const body = await readJson(request);
      const note = oneLine(clip(body?.note, 1000));
      if (note.length > REVOCATION_NOTE_MAX) return json(400, { error: `Keep the note under ${REVOCATION_NOTE_MAX} characters.` }, cors);
      const found = await ownerRevocation(body?.target);
      if (found.error) return json(found.status, { error: found.error }, cors);
      const source = `${OWNER_SOURCE_PREFIX}${newLicenseId()}`;
      const targets = await addRevocations(found.rows, { source, reason: 'owner', note });
      return json(201, { source, revoked: targets.length, ...(found.undelivered ? { undelivered: true } : {}) }, cors);
    }
    const match = /^admin\/revocations\/([A-Za-z0-9_-]{3,200})$/.exec(path);
    if (!match) return null;
    if (request.method !== 'DELETE') return json(405, { error: 'Method not allowed' }, cors);
    const rows = await store.listRevocationsBySource(match[1]);
    if (!rows.length) return json(404, { restored: 0 }, cors);
    const restored = await store.deleteRevocations(match[1]);
    // A gift link comes back as it was before it was revoked (an owner may have switched it off
    // by hand first), and only once no other refund, dispute or revocation holds it.
    for (const row of rows.filter(item => item.kind === 'gift' && item.wasActive !== false)) {
      const code = normalizeGiftCode(row.label);
      const gift = code ? await store.getGift(code) : null;
      if (gift && !await isRevoked([row.target, gift.checkoutRef ? revocationTarget('checkout', gift.checkoutRef) : ''])) await store.updateGift(code, { active: true });
    }
    return json(200, { restored }, cors);
  }

  async function setupInfo() {
    const publicKey = await plusPublicKey();
    return {
      email: {
        configured: mailer.configured,
        apiKeySet: !!String(resendApiKey || '').trim(),
        fromSet: !!String(emailFrom || '').trim(),
        from: mailer.sender ? mailer.from : '',
        ownerEmail: owner?.email || '',
        dailyLimit
      },
      payments: {
        provider: 'creem',
        configured: paymentsConfigured,
        apiKeySet: !!creem.apiKey,
        mode: creem.mode,
        products: { plus: { ...products.ids.plus }, gift: { ...products.ids.gift } },
        webhookSecretSet: !!webhookSecret,
        webhookUrl: `${baseUrl()}/api/creem/webhook`,
        webhookEvents: ['checkout.completed', ...Object.keys(REFUND_EVENTS)],
        error: products.error
      },
      plus: { configured: !!publicKey, keySet: !!signingSecret, publicKey },
      publicBaseUrl: baseUrl(),
      publicBaseUrlSet: !!normalizeBaseUrl(typeof publicBaseUrl === 'function' ? publicBaseUrl() : publicBaseUrl),
      twoFactor: totpEnabled
    };
  }

  /**
   * Daily counts and sales between two days, for the dashboard charts. Counts
   * are summed across app versions (internal rows excluded); sales are the
   * recorded Creem payments plus manual gifts that have an amount.
   */
  async function seriesAnswer(url) {
    const { from, to } = seriesRange(url.searchParams.get('from'), url.searchParams.get('to'), today());
    const [rows, payments, gifts] = await Promise.all([
      store.eventsSeries(from, to),
      store.listPayments({ fromDay: from, toDay: to }).catch(() => null),
      store.listGifts().catch(() => null)
    ]);
    const events = {};
    for (const row of rows) {
      if (String(row.name).startsWith(INTERNAL_EVENT_PREFIX)) continue;
      events[row.name] ||= {};
      events[row.name][row.day] = (events[row.name][row.day] || 0) + (Number(row.count) || 0);
    }
    const number = value => (value == null || value === '' ? null : Number(value));
    const sales = [
      ...(payments || []).map(row => ({ day: String(row.createdAt).slice(0, 10), kind: row.kind, source: 'creem', plan: row.plan || '', seats: number(row.seats), amount: number(row.amount), currency: row.currency || '' })),
      ...(gifts || []).filter(gift => gift.source === 'manual' && gift.amount != null && gift.createdAt.slice(0, 10) >= from && gift.createdAt.slice(0, 10) <= to)
        .map(gift => ({ day: gift.createdAt.slice(0, 10), kind: 'gift', source: 'manual', plan: TEAM_TIERS.find(tier => tier.seats === gift.seats)?.plan || '', seats: gift.seats, amount: gift.amount, currency: gift.currency }))
    ].sort((a, b) => a.day.localeCompare(b.day) || a.source.localeCompare(b.source) || a.kind.localeCompare(b.kind) || (a.seats ?? 0) - (b.seats ?? 0) || (a.amount ?? 0) - (b.amount ?? 0));
    return { from, to, events, sales, salesUnavailable: !payments || !gifts };
  }

  async function adminGifts(request, path, cors) {
    if (path === 'admin/gifts') {
      if (request.method === 'GET') {
        const nowIso = now().toISOString();
        const rows = await store.listGifts({ limit: 500 });
        return json(200, { rows: await Promise.all(rows.map(gift => adminGift(gift, nowIso))) }, cors);
      }
      if (request.method !== 'POST') return json(405, { error: 'Method not allowed' }, cors);
      const body = await readJson(request);
      const result = validateGiftFields(body, { create: true, allowed: ['org', 'seats', 'message', 'note', 'currency', 'amount', 'buyerEmail'] });
      if (result.error) return json(400, { error: result.error }, cors);
      const sendEmail = body?.sendEmail === true;
      if (sendEmail && !result.fields.buyerEmail) return json(400, { error: 'Add the buyer’s email address to email the link.' }, cors);
      if (sendEmail && !mailer.configured) return json(400, { error: 'Email is not set up (RESEND_API_KEY and EMAIL_FROM), so the link cannot be emailed. Untick “Email the link” and copy it instead.' }, cors);
      if (!await signer()) return json(503, { error: `${PLUS_OFF} Set PLUS_SIGNING_KEY (npm run plus:keys), then redeploy.` }, cors);
      const gift = await createGift({ ...result.fields, source: 'manual', checkoutRef: null });
      const answer = await adminGift(gift, now().toISOString());
      const email = sendEmail ? await emailGiftBuyer(gift, answer.manageKey, DEFAULT_EMAIL_TIMEOUT_MS) : null;
      if (email?.emailed) answer.emailedAt = now().toISOString();
      return json(201, { gift: answer, url: answer.url, manageUrl: answer.manageUrl, ...(email ? { emailed: email.emailed, ...(email.error ? { emailError: email.error } : {}) } : {}) }, cors);
    }
    const match = /^admin\/gifts\/([^/]{1,40})$/.exec(path);
    if (!match) return null;
    const code = normalizeGiftCode(match[1]);
    if (request.method === 'DELETE') {
      const existing = code ? await store.getGift(code) : null;
      if (!existing) return json(404, { removed: false }, cors);
      // A paid gift is switched off, never erased: its row is the only record
      // of the checkout, and erasing it would let the same checkout create a
      // fresh gift with all its seats again.
      if (existing.checkoutRef) {
        await store.updateGift(code, { active: false });
        return json(200, { removed: false, deactivated: true }, cors);
      }
      const removed = await store.deleteGift(code);
      return json(removed ? 200 : 404, { removed: !!removed }, cors);
    }
    if (request.method !== 'PATCH') return json(405, { error: 'Method not allowed' }, cors);
    const body = await readJson(request);
    const result = validateGiftFields(body, { allowed: ['org', 'seats', 'message', 'note', 'active'] });
    if (result.error) return json(400, { error: result.error }, cors);
    const gift = code ? await store.getGift(code) : null;
    if (!gift) return json(404, { error: 'Not found' }, cors);
    if (Object.keys(result.fields).length) await store.updateGift(code, result.fields);
    return json(200, { gift: await adminGift({ ...gift, ...result.fields }, now().toISOString()) }, cors);
  }

  async function adminLicense(request, cors) {
    if (request.method !== 'POST') return json(405, { error: 'Method not allowed' }, cors);
    const body = await readJson(request);
    const note = oneLine(clip(body?.note, 1000));
    if (note.length > LICENSE_NOTE_MAX) return json(400, { error: `Keep the note under ${LICENSE_NOTE_MAX} characters.` }, cors);
    const key = await signer();
    if (!key) return json(503, { error: `${PLUS_OFF} Set PLUS_SIGNING_KEY (npm run plus:keys), then redeploy.` }, cors);
    const id = newLicenseId();
    const createdAt = now().toISOString();
    // Recorded as a "manual" row of the purchases table: an id, a date and the owner's note.
    await store.addPurchase({ checkoutRef: `manual_${id}`, kind: 'manual', licenseId: id, claims: 0, email: '', note, createdAt });
    const license = await signLicense(key, { src: 'manual', id, iat: isoDay(new Date(createdAt)) });
    return json(201, { license, url: licenseUrl(baseUrl(), license) }, cors);
  }

  // ---- Partner commissions (server/partners.js) ----------------------------------

  /** The partner sales, their states and their refunds; null while migration 0006 is missing. */
  function partnerLists() {
    return Promise.all([store.listPartnerSales({ limit: PARTNER_SALES_LISTED }), store.partnerSaleStates().catch(() => []), store.partnerSaleRefunds().catch(() => [])]).catch(() => null);
  }

  /** The team commissions marked as paid and the codes found to be no partner: { payouts, rejections }, null while migration 0007 is missing. */
  function commissionLists() {
    return Promise.all([store.listPartnerPayouts(), store.listPartnerCodeRejections()])
      .then(([payouts, rejections]) => ({ payouts, rejections }))
      .catch(error => { if (isMissingTable(error)) return null; throw error; });
  }

  /**
   * POST admin/partners/payouts { checkout, note, confirmed, amount } marks an
   * earned team commission as paid (the owner paid it by bank transfer), with
   * the amount worked out now — or, when that is only an upper bound (tax or a
   * refund's amount unknown), the `amount` the owner paid, in cents.
   * `confirmed` says the owner checked what payoutCheck() asks to check (a
   * code nothing confirmed, a refund, the tax). DELETE
   * admin/partners/payouts/<checkout> undoes it.
   */
  async function adminPayouts(request, path, cors) {
    if (path === 'admin/partners/payouts') {
      if (request.method !== 'POST') return json(405, { error: 'Method not allowed' }, cors);
      const body = await readJson(request);
      const checkoutId = typeof body?.checkout === 'string' ? body.checkout.trim() : '';
      if (!CHECKOUT_ID_RE.test(checkoutId)) return json(400, { error: 'Give the checkout of the team gift.' }, cors);
      const note = oneLine(clip(body?.note, 1000));
      if (note.length > PAYOUT_NOTE_MAX) return json(400, { error: `Keep the note under ${PAYOUT_NOTE_MAX} characters.` }, cors);
      if (body?.amount != null && !Number.isInteger(body.amount)) return json(400, { error: 'Give the amount paid in cents.' }, cors);
      const [lists, commissions] = await Promise.all([partnerLists(), commissionLists()]);
      if (!lists || !commissions) return json(503, { error: MISSING_TABLE }, cors);
      const summary = partnerSummary(lists[0], lists[1], lists[2], { limit: PARTNER_SALES_LISTED, ...commissions, now: now().getTime() });
      const found = payoutCheck(summary, checkoutId, { confirmed: body?.confirmed === true, amount: body?.amount ?? null });
      if (found.error) return json(found.status, { error: found.error, ...(found.checks ? { checks: found.checks } : {}) }, cors);
      const payout = { checkoutId, code: found.sale.code, amount: found.amount, currency: found.sale.currency, note, paidAt: now().toISOString() };
      if (!await store.addPartnerPayout(payout)) return json(409, { error: 'This commission is already marked as paid.' }, cors);
      return json(201, { payout: normalizePayout(payout) }, cors);
    }
    const match = /^admin\/partners\/payouts\/([A-Za-z0-9_-]{1,200})$/.exec(path);
    if (!match) return null;
    if (request.method !== 'DELETE') return json(405, { error: 'Method not allowed' }, cors);
    if (!CHECKOUT_ID_RE.test(match[1])) return json(404, { removed: false }, cors);
    const removed = await store.deletePartnerPayout(match[1]);
    return json(removed ? 200 : 404, { removed: !!removed }, cors);
  }

  /**
   * POST admin/partners/rejections { code } records that the owner checked
   * Creem's Affiliate Hub and found no partner with this code: its team
   * commissions earn nothing. DELETE admin/partners/rejections/<code> undoes it.
   */
  async function adminCodeRejections(request, path, cors) {
    if (path === 'admin/partners/rejections') {
      if (request.method !== 'POST') return json(405, { error: 'Method not allowed' }, cors);
      const body = await readJson(request);
      const code = affiliateCode(body?.code);
      if (!code) return json(400, { error: 'Give the partner code.' }, cors);
      const row = { code, createdAt: now().toISOString() };
      if (!await store.addPartnerCodeRejection(row)) return json(409, { error: `${code} is already marked as not a partner.` }, cors);
      return json(201, { rejection: normalizeCodeRejection(row) }, cors);
    }
    const match = /^admin\/partners\/rejections\/([A-Za-z0-9_-]{1,200})$/.exec(path);
    if (!match) return null;
    if (request.method !== 'DELETE') return json(405, { error: 'Method not allowed' }, cors);
    const code = affiliateCode(match[1]);
    if (!code) return json(404, { removed: false }, cors);
    const removed = await store.deletePartnerCodeRejection(code);
    return json(removed ? 200 : 404, { removed: !!removed }, cors);
  }

  function corsHeaders(request) {
    const origin = request.headers.get('origin');
    if (!origin || !origins.has(origin)) return {};
    return { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'access-control-allow-headers': 'content-type,authorization', vary: 'origin' };
  }

  // Same status, body and headers whichever part was wrong, after a short pause.
  async function unauthorized(cors) {
    if (authFailureDelayMs > 0) await sleep(authFailureDelayMs);
    return json(401, { error: 'Unauthorized' }, cors);
  }

  async function isAdmin(request) {
    if (!adminToken) return false;
    const match = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') || '');
    if (!match) return false;
    const credential = match[1].trim();
    if (looksLikeSession(credential)) return verifySession(sessionKey, credential, now().getTime());
    // The raw token is a shortcut for curl and CSV scripts, only without 2FA.
    return !totpEnabled && timingSafeEqual(credential, adminToken);
  }

  async function signIn(request, cors) {
    if (request.method !== 'POST') return json(405, { error: 'Method not allowed' }, cors);
    const body = await readJson(request).catch(() => null);
    const tokenOk = timingSafeEqual(typeof body?.token === 'string' ? body.token : '', adminToken);
    const codeOk = totpEnabled ? await verifyTotp(totpKey, typeof body?.code === 'string' ? body.code : '', now().getTime()) : true;
    if (!tokenOk || !codeOk) return unauthorized(cors);
    const { session, expiresAt } = await issueSession(sessionKey, now().getTime());
    return json(200, { session, expiresAt: new Date(expiresAt).toISOString() }, cors);
  }

  async function admin(request, path, url, cors) {
    if (!adminToken) return json(503, { error: 'ADMIN_TOKEN is not configured.' }, cors);
    if (totpBroken) return json(503, { error: 'ADMIN_TOTP_SECRET is not valid base32 (A–Z and 2–7, at least 16 characters).' }, cors);
    if (path === 'admin/session') return signIn(request, cors);
    if (!await isAdmin(request)) return request.headers.has('authorization') ? unauthorized(cors) : json(401, { error: 'Unauthorized' }, cors);
    const days = Math.min(366, Math.max(1, Math.round(Number(url.searchParams.get('days')) || 90)));
    const sinceDay = dayKey(new Date(now().getTime() - days * 86400000));
    if (request.method === 'GET' && path === 'admin/summary') {
      const nowIso = now().toISOString();
      // Team and Plus queries must not take the whole dashboard down when the
      // 0002 or 0003 migration has not been applied yet.
      const teams = Promise.all([store.listTeamRequests({ limit: 200 }), store.teamRequestTotals()]).catch(() => null);
      const plusTables = Promise.all([store.listGifts({ limit: 200 }), store.giftTotals(), store.purchaseTotals(), store.listPurchases({ kind: 'manual', limit: 10 })]).catch(() => null);
      // Reviews come from migration 0004, refunds from 0005; without them the rest still loads.
      const reviewRows = store.listReviews({ limit: REVIEWS_LATEST }).catch(() => null);
      const refundData = Promise.all([store.listRefunds({ limit: REFUNDS_LISTED }), store.listRevocations({ limit: REVOCATIONS_LISTED })]).catch(() => null);
      // Partner sales come from migration 0006; which were refunded (in full or in part), from 0005 as well (none while it is missing);
      // team commissions marked as paid and codes found to be no partner, from 0007 (none while it is missing, and the card says so).
      const partnerData = partnerLists();
      const commissionData = commissionLists().catch(() => null);
      const [eventTotals, eventDaily, waitlist, feedbackByVersion, feedbackLatest, teamData, emailsSentToday, plusData, reviews, refundLists, partnerRows, commissions, setup] = await Promise.all([
        store.eventTotals({ sinceDay }).then(publicEvents),
        store.eventDaily({ sinceDay }).then(publicEvents),
        store.listWaitlist(),
        store.feedbackByVersion(),
        store.listFeedback({ limit: 30 }),
        teams,
        store.emailSendsOn(today(), EMAIL_SENDS_EVENT),
        plusTables,
        reviewRows,
        refundData,
        partnerData,
        commissionData,
        setupInfo()
      ]);
      const [teamRequests, teamRequestTotals] = teamData || [[], { count: 0, seats: 0 }];
      const [giftRows, giftTotals, purchaseTotals, manualLicenses] = plusData || [[], { count: 0, seats: 0, redeemed: 0, paid: 0 }, { plus: 0, manual: 0 }, []];
      return json(200, {
        version: APP_VERSION, generatedAt: nowIso, sinceDay, eventTotals, eventDaily, waitlist, feedbackByVersion, feedbackLatest, teamRequests, teamRequestTotals, teamRequestsUnavailable: !teamData,
        emailConfigured: mailer.configured, emailTestAvailable: mailer.configured && !!owner, emailDailyLimit: dailyLimit, emailsSentToday, emailsPerSend: EMAILS_PER_SEND,
        gifts: await Promise.all(giftRows.map(gift => adminGift(gift, nowIso))), giftTotals, plusUnavailable: !plusData,
        plus: { purchases: purchaseTotals.plus, manualLicenses: purchaseTotals.manual, recentLicenses: manualLicenses.map(row => ({ id: row.licenseId, note: row.note, createdAt: row.createdAt })) },
        reviews: reviews || [], reviewsUnavailable: !reviews,
        refunds: refundLists?.[0] || [], revocations: refundLists?.[1] || [], refundsUnavailable: !refundLists,
        partners: partnerSummary(partnerRows?.[0] || [], partnerRows?.[1] || [], partnerRows?.[2] || [], { limit: PARTNER_SALES_LISTED, payouts: commissions?.payouts || [], rejections: commissions?.rejections || [], now: now().getTime() }), partnersUnavailable: !partnerRows,
        partnerCommissionsUnavailable: !commissions, partnerProgram: { rate: PARTNER_PROGRAM.rate, teamRate: PARTNER_PROGRAM.teamRate, refundDays: PARTNER_PROGRAM.refundDays, cookieDays: PARTNER_PROGRAM.cookieDays, minimumPayout: { ...PARTNER_PROGRAM.minimumPayout } },
        setup
      }, cors);
    }
    if (request.method === 'GET' && path === 'admin/series') return json(200, await seriesAnswer(url), cors);
    if (request.method === 'GET' && path === 'admin/feedback') {
      const version = url.searchParams.get('version') || '';
      const rows = await store.listFeedback({ version: VERSION_RE.test(version) ? version : '', limit: 500 });
      if (url.searchParams.get('format') === 'csv') return csvResponse(rows, ['id', 'createdAt', 'appVersion', 'rating', 'kind', 'message', 'email', 'platform'], 'daily-planner-feedback.csv', cors);
      return json(200, { rows }, cors);
    }
    if (request.method === 'GET' && path === 'admin/waitlist') {
      const rows = await store.listWaitlist();
      if (url.searchParams.get('format') === 'csv') return csvResponse(rows, ['id', 'createdAt', 'email', 'devices', 'note', 'locale', 'appVersion', 'driveSeen'], 'daily-planner-waitlist.csv', cors);
      return json(200, { rows }, cors);
    }
    if (request.method === 'GET' && path === 'admin/teams') {
      const rows = await store.listTeamRequests();
      if (url.searchParams.get('format') === 'csv') return csvResponse(rows, ['id', 'createdAt', 'company', 'teamSize', 'plan', 'currency', 'kind', 'timing', 'name', 'email', 'message', 'locale', 'appVersion', 'source', 'ref'], 'daily-planner-team-requests.csv', cors);
      return json(200, { rows }, cors);
    }
    if (path === 'admin/waitlist/announce') return announce(request, cors);
    if (path === 'admin/licenses') return adminLicense(request, cors);
    if (path.startsWith('admin/revocations')) {
      const answer = await adminRevocations(request, path, cors);
      if (answer) return answer;
    }
    if (path.startsWith('admin/gifts')) {
      const answer = await adminGifts(request, path, cors);
      if (answer) return answer;
    }
    if (path.startsWith('admin/partners/payouts')) {
      const answer = await adminPayouts(request, path, cors);
      if (answer) return answer;
    }
    if (path.startsWith('admin/partners/rejections')) {
      const answer = await adminCodeRejections(request, path, cors);
      if (answer) return answer;
    }
    const removal = path.match(/^admin\/(waitlist|feedback|teams|reviews)\/(\d+)$/);
    if (request.method === 'DELETE' && removal) {
      const remove = { waitlist: store.deleteWaitlist, feedback: store.deleteFeedback, teams: store.deleteTeamRequest, reviews: store.deleteReview }[removal[1]];
      const removed = await remove.call(store, Number(removal[2]));
      return json(removed ? 200 : 404, { removed: !!removed }, cors);
    }
    return json(404, { error: 'Not found' }, cors);
  }

  return async function handle(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^.*?\/api\/?/, '').replace(/\/+$/, '');
    const cors = corsHeaders(request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      if (path === 'health' && request.method === 'GET') return json(200, { ok: true }, cors);
      if (path.startsWith('admin/')) return await admin(request, path, url, cors);
      // Before any JSON parsing: the signature covers the raw body.
      if (path === 'creem/webhook') return await webhookRoute(request, cors);
      if (path === 'checkout') return await checkoutRoute(request, cors);
      const gift = /^gifts\/([^/]{1,40})(\/redeem)?$/.exec(path);
      if (gift) return await giftRoute(request, gift, cors);
      if (path === 'purchases/claim') return await claimRoute(request, cors);
      if (path === 'plus/check') return await plusCheckRoute(request, cors);
      if (request.method !== 'POST') return json(405, { error: 'Method not allowed' }, cors);
      const body = await readJson(request);
      if (path === 'events') {
        const name = String(body?.name || '');
        const version = String(body?.version || '');
        if (!EVENT_NAMES.has(name) || !VERSION_RE.test(version)) return json(400, { error: 'Unknown event' }, cors);
        await store.countEvent(dayKey(now()), name, version);
        return new Response(null, { status: 204, headers: cors });
      }
      if (path === 'waitlist') {
        const result = validateWaitlist(body, now());
        if (result.error) return json(400, { error: result.error }, cors);
        // Same answer for new and existing emails (the removal token depends
        // only on the address), so the endpoint can't be used to check whether
        // someone is on the list. Honeypot hits get the same answer too.
        const removeToken = await waitlistRemoveToken(adminToken, result.entry?.email ?? clip(body?.email, 254).toLowerCase());
        if (!result.spam) await store.addWaitlist(result.entry);
        return json(201, { ok: true, removeToken }, cors);
      }
      if (path === 'waitlist/remove') {
        if (!adminToken) return json(503, { error: 'Leaving the waitlist is not available: ADMIN_TOKEN is not configured.' }, cors);
        const email = clip(body?.email, 254).toLowerCase();
        if (!EMAIL_RE.test(email) || !await verifyWaitlistRemoveToken(adminToken, email, body?.token)) return json(400, { error: 'This removal request is not valid.' }, cors);
        // Same answer whether or not the address was still listed.
        await store.deleteWaitlistByEmail(email);
        return json(200, { ok: true }, cors);
      }
      if (path === 'feedback') {
        const result = validateFeedback(body, now());
        if (result.spam) return json(201, { ok: true }, cors);
        if (result.error) return json(400, { error: result.error }, cors);
        await store.addFeedback(result.entry);
        // A quotable review is kept apart; without migration 0004 the feedback still counts.
        if (result.review) await store.addReview(result.review).catch(error => safeWarn(`Review not stored: ${error?.message || error}`));
        return json(201, { ok: true }, cors);
      }
      if (path === 'teams') {
        const result = validateTeamRequest(body, now());
        if (result.spam) return json(201, { ok: true }, cors);
        if (result.error) return json(400, { error: result.error }, cors);
        // Repeat requests are stored as they come and answered the same way.
        await store.addTeamRequest(result.entry);
        notifyOwner(result.entry, new URL('/admin/', url).href);
        return json(201, { ok: true }, cors);
      }
      return json(404, { error: 'Not found' }, cors);
    } catch (error) {
      if (error?.message === 'too-large') return json(413, { error: 'Request too large' }, cors);
      if (error?.message === 'invalid-json') return json(400, { error: 'Invalid JSON' }, cors);
      if (isMissingTable(error)) return json(503, { error: MISSING_TABLE }, cors);
      return json(500, { error: 'Server error' }, cors);
    }
  };
}

/**
 * In-memory store with optional persistence hooks; used by the dev server and
 * the unit tests. Mirrors the D1 store's behaviour (unique emails, counts,
 * oldest-first announcement order, internal email-send counts, gift limits,
 * one gift, purchase, payment, partner sale and payout per checkout, one order
 * and one refund per Creem id, one revocation per target and source, a
 * request's partner code kept with it, one rejection per partner code).
 */
export function createMemoryStore(initial = {}, { onChange = null } = {}) {
  const data = {
    events: Array.isArray(initial.events) ? initial.events : [],
    waitlist: Array.isArray(initial.waitlist) ? initial.waitlist : [],
    feedback: Array.isArray(initial.feedback) ? initial.feedback : [],
    teamRequests: Array.isArray(initial.teamRequests) ? initial.teamRequests : [],
    gifts: Array.isArray(initial.gifts) ? initial.gifts : [],
    purchases: Array.isArray(initial.purchases) ? initial.purchases : [],
    payments: Array.isArray(initial.payments) ? initial.payments : [],
    reviews: Array.isArray(initial.reviews) ? initial.reviews : [],
    orders: Array.isArray(initial.orders) ? initial.orders : [],
    refunds: Array.isArray(initial.refunds) ? initial.refunds : [],
    revocations: Array.isArray(initial.revocations) ? initial.revocations : [],
    partnerSales: Array.isArray(initial.partnerSales) ? initial.partnerSales : [],
    partnerPayouts: Array.isArray(initial.partnerPayouts) ? initial.partnerPayouts : [],
    partnerCodeRejections: Array.isArray(initial.partnerCodeRejections) ? initial.partnerCodeRejections : [],
    nextId: Number(initial.nextId) || 1
  };
  // Data files written before 1.21 call the checkout reference stripeSession.
  for (const row of [...data.gifts, ...data.purchases]) {
    if (row && typeof row === 'object' && row.checkoutRef === undefined && 'stripeSession' in row) {
      row.checkoutRef = row.stripeSession ?? null;
      delete row.stripeSession;
    }
  }
  const changed = () => onChange?.(data);
  const byNewest = (a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || b.id - a.id;
  const findGift = code => data.gifts.find(item => item.code === code);
  const GIFT_EDITABLE = ['org', 'message', 'seats', 'active', 'note'];
  // `notified` stays inside the store, as in D1; rows written before it existed read as they were.
  const refundOut = ({ notified, ...row }) => ({ scope: '', status: '', note: '', attempts: 0, ...row });
  const revocationOut = row => ({ wasActive: null, ...row });
  return {
    data,
    async addGift(gift) {
      if (data.gifts.some(item => item.code === gift.code || (gift.checkoutRef && item.checkoutRef === gift.checkoutRef))) return false;
      data.gifts.push({ ...normalizeGift(gift) });
      changed();
      return true;
    },
    async getGift(code) { return normalizeGift(findGift(code)); },
    async getGiftByCheckout(ref) { return normalizeGift(data.gifts.find(item => item.checkoutRef === ref)); },
    async listGifts({ limit = 0 } = {}) {
      const rows = [...data.gifts].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || a.code.localeCompare(b.code)).map(normalizeGift);
      return limit ? rows.slice(0, limit) : rows;
    },
    async giftTotals() {
      return data.gifts.reduce((totals, item) => ({
        count: totals.count + 1,
        seats: totals.seats + (Number(item.seats) || 0),
        redeemed: totals.redeemed + (Number(item.redeemed) || 0),
        paid: totals.paid + (String(item.source ?? 'manual') !== 'manual' ? 1 : 0)
      }), { count: 0, seats: 0, redeemed: 0, paid: 0 });
    },
    /** One activation, only while the gift is active, unexpired and under its limit. */
    async redeemGift(code, nowIso) {
      const gift = findGift(code);
      if (!gift || !normalizeGift(gift).active || !(String(gift.expiresAt) > nowIso) || Number(gift.redeemed) >= giftLimit(gift.seats)) return false;
      gift.redeemed = Number(gift.redeemed) + 1;
      changed();
      return true;
    },
    async unredeemGift(code) {
      const gift = findGift(code);
      if (!gift || !(gift.redeemed > 0)) return false;
      gift.redeemed -= 1;
      changed();
      return true;
    },
    async updateGift(code, fields) {
      const gift = findGift(code);
      if (!gift) return false;
      GIFT_EDITABLE.forEach(name => { if (fields[name] !== undefined) gift[name] = fields[name]; });
      changed();
      return true;
    },
    async deleteGift(code) {
      const before = data.gifts.length;
      data.gifts = data.gifts.filter(item => item.code !== code);
      changed();
      return before !== data.gifts.length;
    },
    async markGiftEmailed(code, iso) {
      const gift = findGift(code);
      if (!gift || gift.emailedAt) return false;
      gift.emailedAt = iso;
      changed();
      return true;
    },
    async clearGiftEmailed(code) {
      const gift = findGift(code);
      if (gift) { gift.emailedAt = null; changed(); }
    },
    async getPurchase(ref) {
      const row = data.purchases.find(item => item.checkoutRef === ref);
      return row ? { ...row } : null;
    },
    async addPurchase(row) {
      if (data.purchases.some(item => item.checkoutRef === row.checkoutRef)) return false;
      data.purchases.push({ note: '', ...row });
      changed();
      return true;
    },
    async claimPurchase(ref, max) {
      const row = data.purchases.find(item => item.checkoutRef === ref);
      if (!row || row.claims >= max) return false;
      row.claims += 1;
      changed();
      return true;
    },
    async purchaseTotals() {
      return { plus: data.purchases.filter(item => item.kind === 'plus').length, manual: data.purchases.filter(item => item.kind === 'manual').length };
    },
    async listPurchases({ kind = '', limit = 50 } = {}) {
      return data.purchases.filter(item => !kind || item.kind === kind).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, limit).map(row => ({ ...row }));
    },
    async addPayment(row) {
      if (data.payments.some(item => item.checkoutId === row.checkoutId)) return false;
      data.payments.push({ plan: '', seats: null, amount: null, currency: '', country: '', ...row, emailedAt: null });
      changed();
      return true;
    },
    async getPayment(id) {
      const row = data.payments.find(item => item.checkoutId === id);
      return row ? { ...row } : null;
    },
    async listPayments({ fromDay, toDay }) {
      return data.payments.filter(item => String(item.createdAt).slice(0, 10) >= fromDay && String(item.createdAt).slice(0, 10) <= toDay)
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.checkoutId).localeCompare(String(b.checkoutId))).map(row => ({ ...row }));
    },
    async markPaymentEmailed(id, iso) {
      const row = data.payments.find(item => item.checkoutId === id);
      if (!row || row.emailedAt) return false;
      row.emailedAt = iso;
      changed();
      return true;
    },
    async clearPaymentEmailed(id) {
      const row = data.payments.find(item => item.checkoutId === id);
      if (row) { row.emailedAt = null; changed(); }
    },
    async addOrder(row) {
      if (data.orders.some(item => item.orderId === row.orderId)) return false;
      data.orders.push({ orderId: row.orderId, checkoutId: row.checkoutId, kind: row.kind, mode: row.mode || '', createdAt: row.createdAt });
      changed();
      return true;
    },
    async getOrder(id) {
      const row = data.orders.find(item => item.orderId === id);
      return row ? { mode: '', ...row } : null;
    },
    async getOrderByCheckout(id) {
      const row = data.orders.find(item => item.checkoutId === id);
      return row ? { mode: '', ...row } : null;
    },
    async listCheckoutsWithoutOrder(limit = 50) {
      const ordered = new Set(data.orders.map(item => item.checkoutId));
      const isCreem = ref => typeof ref === 'string' && ref.startsWith('ch_') && !ordered.has(ref);
      return [
        ...data.purchases.filter(item => item.kind === 'plus' && isCreem(item.checkoutRef)).map(item => ({ checkoutId: item.checkoutRef, kind: 'plus', note: item.note || '', createdAt: item.createdAt })),
        ...data.gifts.filter(item => isCreem(item.checkoutRef)).map(item => ({ checkoutId: item.checkoutRef, kind: 'gift', note: item.note || '', createdAt: item.createdAt }))
      ].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || a.checkoutId.localeCompare(b.checkoutId)).slice(0, limit);
    },
    async addRefund(row) {
      if (data.refunds.some(item => item.id === row.id)) return false;
      data.refunds.push({ orderId: '', transactionId: '', checkoutId: '', item: '', amount: null, currency: '', scope: '', reason: '', revoked: '', status: '', note: '', ...row, fullRefund: !!row.fullRefund, attempts: Number(row.attempts) || 0, notified: false });
      changed();
      return true;
    },
    async completeRefund(row) {
      const index = data.refunds.findIndex(item => item.id === row.id && item.status === 'pending');
      if (index < 0) return false;
      const { attempts, notified } = data.refunds[index];
      data.refunds[index] = { orderId: '', transactionId: '', checkoutId: '', item: '', amount: null, currency: '', scope: '', reason: '', revoked: '', note: '', ...row, fullRefund: !!row.fullRefund, status: '', attempts, notified };
      changed();
      return true;
    },
    async retryRefund(id, note) {
      const row = data.refunds.find(item => item.id === id && item.status === 'pending');
      if (!row) return false;
      row.attempts = (Number(row.attempts) || 0) + 1;
      row.note = note || '';
      changed();
      return true;
    },
    async markRefundNotified(id) {
      const row = data.refunds.find(item => item.id === id);
      if (!row || row.notified) return false;
      row.notified = true;
      changed();
      return true;
    },
    async linkRefund(id, fields) {
      const row = data.refunds.find(item => item.id === id);
      if (!row) return false;
      Object.assign(row, { checkoutId: fields.checkoutId || '', item: fields.item || '', revoked: fields.revoked || '' });
      changed();
      return true;
    },
    async getRefund(id) {
      const row = data.refunds.find(item => item.id === id);
      return row ? refundOut(row) : null;
    },
    async listRefunds({ limit = 100 } = {}) {
      return [...data.refunds].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || String(a.id).localeCompare(String(b.id))).slice(0, limit)
        .map(row => ({ ...refundOut(row), inForce: data.revocations.some(item => item.source === row.id) }));
    },
    async addRevocations(rows) {
      let added = 0;
      for (const row of rows) {
        if (data.revocations.some(item => item.target === row.target && item.source === row.source)) continue;
        data.revocations.push({ target: row.target, source: row.source, kind: row.kind, label: row.label || '', reason: row.reason || '', note: row.note || '', wasActive: typeof row.wasActive === 'boolean' ? row.wasActive : null, createdAt: row.createdAt });
        added += 1;
      }
      if (added) changed();
      return added;
    },
    async isRevoked(targets) {
      return data.revocations.some(item => targets.includes(item.target));
    },
    async listRevocationsFor(targets) {
      return data.revocations.filter(item => targets.includes(item.target)).map(revocationOut)
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.source).localeCompare(String(b.source)) || String(a.target).localeCompare(String(b.target)));
    },
    async listRevocations({ limit = 500 } = {}) {
      return [...data.revocations].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || String(a.source).localeCompare(String(b.source)) || String(a.target).localeCompare(String(b.target))).slice(0, limit).map(revocationOut);
    },
    async listRevocationsBySource(source) {
      return data.revocations.filter(item => item.source === source).sort((a, b) => String(a.target).localeCompare(String(b.target))).map(revocationOut);
    },
    async deleteRevocations(source) {
      const before = data.revocations.length;
      data.revocations = data.revocations.filter(item => item.source !== source);
      changed();
      return before - data.revocations.length;
    },
    async addPartnerSale(row) {
      if (data.partnerSales.some(item => item.checkoutId === row.checkoutId)) return false;
      data.partnerSales.push(normalizePartnerSale(row));
      changed();
      return true;
    },
    async listPartnerSales({ limit = 2000 } = {}) {
      return [...data.partnerSales].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || String(a.checkoutId).localeCompare(String(b.checkoutId))).slice(0, limit).map(normalizePartnerSale);
    },
    async partnerSaleStates() {
      const sold = new Set(data.partnerSales.map(item => `checkout:${item.checkoutId}`));
      return data.revocations.filter(item => sold.has(item.target)).map(item => ({ checkoutId: item.target.slice('checkout:'.length), reason: item.reason }));
    },
    async partnerSaleRefunds() {
      const sold = new Set(data.partnerSales.map(item => item.checkoutId));
      return data.refunds.filter(item => item.checkoutId && sold.has(item.checkoutId) && item.status !== 'pending')
        .map(item => ({ checkoutId: item.checkoutId, amount: item.amount ?? null, currency: item.currency || '', fullRefund: !!item.fullRefund }));
    },
    async addPartnerPayout(row) {
      if (data.partnerPayouts.some(item => item.checkoutId === row.checkoutId)) return false;
      data.partnerPayouts.push(normalizePayout(row));
      changed();
      return true;
    },
    async listPartnerPayouts() {
      return [...data.partnerPayouts].sort((a, b) => String(b.paidAt).localeCompare(String(a.paidAt)) || String(a.checkoutId).localeCompare(String(b.checkoutId))).map(normalizePayout);
    },
    async deletePartnerPayout(checkoutId) {
      const before = data.partnerPayouts.length;
      data.partnerPayouts = data.partnerPayouts.filter(item => item.checkoutId !== checkoutId);
      if (before !== data.partnerPayouts.length) changed();
      return before !== data.partnerPayouts.length;
    },
    async addPartnerCodeRejection(row) {
      if (data.partnerCodeRejections.some(item => item.code === row.code)) return false;
      data.partnerCodeRejections.push(normalizeCodeRejection(row));
      changed();
      return true;
    },
    async listPartnerCodeRejections() {
      return [...data.partnerCodeRejections].sort((a, b) => String(a.code).localeCompare(String(b.code))).map(normalizeCodeRejection);
    },
    async deletePartnerCodeRejection(code) {
      const before = data.partnerCodeRejections.length;
      data.partnerCodeRejections = data.partnerCodeRejections.filter(item => item.code !== code);
      if (before !== data.partnerCodeRejections.length) changed();
      return before !== data.partnerCodeRejections.length;
    },
    async addReview(entry) {
      data.reviews.push({ id: data.nextId++, appVersion: entry.appVersion, rating: entry.rating, text: entry.text, name: entry.name || '', createdAt: entry.createdAt });
      changed();
    },
    async listReviews({ limit = 50 } = {}) {
      return [...data.reviews].sort(byNewest).slice(0, limit).map(row => ({ ...row }));
    },
    async deleteReview(id) {
      const before = data.reviews.length;
      data.reviews = data.reviews.filter(item => item.id !== id);
      changed();
      return before !== data.reviews.length;
    },
    async eventsSeries(fromDay, toDay) {
      const totals = new Map();
      data.events.filter(item => item.day >= fromDay && item.day <= toDay && !String(item.name).startsWith(INTERNAL_EVENT_PREFIX)).forEach(item => {
        const key = `${item.day}|${item.name}`;
        totals.set(key, { day: item.day, name: item.name, count: (totals.get(key)?.count || 0) + item.count });
      });
      return [...totals.values()].sort((a, b) => a.day.localeCompare(b.day) || a.name.localeCompare(b.name));
    },
    async countEvent(day, name, appVersion) {
      const row = data.events.find(item => item.day === day && item.name === name && item.appVersion === appVersion);
      if (row) row.count += 1; else data.events.push({ day, name, appVersion, count: 1 });
      changed();
    },
    async addWaitlist(entry) {
      if (data.waitlist.some(item => item.email === entry.email)) return { duplicate: true };
      data.waitlist.push({ id: data.nextId++, ...entry });
      changed();
      return { duplicate: false };
    },
    async addFeedback(entry) {
      data.feedback.push({ id: data.nextId++, ...entry });
      changed();
    },
    async addTeamRequest(entry) {
      const { ref = '', ...rest } = entry;
      data.teamRequests.push({ id: data.nextId++, ...rest, ...(ref ? { ref } : {}) });
      changed();
    },
    async listTeamRequests({ limit = 0 } = {}) {
      const rows = [...data.teamRequests].sort(byNewest).map(row => ({ ...row, ref: row.ref || '' }));
      return limit ? rows.slice(0, limit) : rows;
    },
    async teamRequestTotals() {
      return { count: data.teamRequests.length, seats: data.teamRequests.reduce((sum, item) => sum + (Number(item.teamSize) || 0), 0) };
    },
    async deleteTeamRequest(id) {
      const before = data.teamRequests.length;
      data.teamRequests = data.teamRequests.filter(item => item.id !== id);
      changed();
      return before !== data.teamRequests.length;
    },
    async eventTotals({ sinceDay }) {
      const totals = new Map();
      data.events.filter(item => item.day >= sinceDay).forEach(item => {
        const key = `${item.name}|${item.appVersion}`;
        totals.set(key, { name: item.name, appVersion: item.appVersion, count: (totals.get(key)?.count || 0) + item.count });
      });
      return [...totals.values()].sort((a, b) => a.name.localeCompare(b.name) || b.appVersion.localeCompare(a.appVersion));
    },
    async eventDaily({ sinceDay }) {
      const totals = new Map();
      data.events.filter(item => item.day >= sinceDay).forEach(item => {
        const key = `${item.day}|${item.name}`;
        totals.set(key, { day: item.day, name: item.name, count: (totals.get(key)?.count || 0) + item.count });
      });
      return [...totals.values()].sort((a, b) => a.day.localeCompare(b.day) || a.name.localeCompare(b.name));
    },
    async listWaitlist() { return [...data.waitlist].sort(byNewest); },
    async deleteWaitlist(id) {
      const before = data.waitlist.length;
      data.waitlist = data.waitlist.filter(item => item.id !== id);
      changed();
      return before !== data.waitlist.length;
    },
    async deleteWaitlistByEmail(email) {
      const before = data.waitlist.length;
      data.waitlist = data.waitlist.filter(item => item.email !== email);
      changed();
      return before !== data.waitlist.length;
    },
    async oldestWaitlist(limit) {
      return [...data.waitlist].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.id - b.id).slice(0, limit);
    },
    async countWaitlist() { return data.waitlist.length; },
    async deleteWaitlistIds(ids) {
      const remove = new Set(ids);
      const before = data.waitlist.length;
      data.waitlist = data.waitlist.filter(item => !remove.has(item.id));
      changed();
      return before - data.waitlist.length;
    },
    async addEmailSends(day, name, count) {
      const row = data.events.find(item => item.day === day && item.name === name && item.appVersion === '');
      if (row) row.count += count; else data.events.push({ day, name, appVersion: '', count });
      changed();
    },
    async emailSendsOn(day, name) {
      return data.events.filter(item => item.day === day && item.name === name).reduce((sum, item) => sum + item.count, 0);
    },
    async deleteFeedback(id) {
      const before = data.feedback.length;
      data.feedback = data.feedback.filter(item => item.id !== id);
      changed();
      return before !== data.feedback.length;
    },
    async listFeedback({ version = '', limit = 100 } = {}) {
      return data.feedback.filter(item => !version || item.appVersion === version).sort(byNewest).slice(0, limit);
    },
    async feedbackByVersion() {
      const groups = new Map();
      data.feedback.forEach(item => {
        const group = groups.get(item.appVersion) || { appVersion: item.appVersion, count: 0, rated: 0, ratingSum: 0, lastAt: '' };
        group.count += 1;
        if (item.rating != null) { group.rated += 1; group.ratingSum += item.rating; }
        if (item.createdAt > group.lastAt) group.lastAt = item.createdAt;
        groups.set(item.appVersion, group);
      });
      return [...groups.values()].map(group => ({ appVersion: group.appVersion, count: group.count, rated: group.rated, avgRating: group.rated ? Math.round(group.ratingSum / group.rated * 100) / 100 : null, lastAt: group.lastAt }))
        .sort((a, b) => b.appVersion.localeCompare(a.appVersion, undefined, { numeric: true }));
    }
  };
}
