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
//   kind of request someone typed, with explicit consent. Deletable.
// - Email (optional, Resend, see server/email.js): the owner is notified of
//   each team request, and the dashboard can send the one waitlist
//   announcement; every address is deleted as soon as its email is accepted.
//   The device that joined gets a removal token so people can leave the list
//   on their own.
// - Daily Planner Plus (see server/licenses.js, server/gifts.js, server/stripe.js):
//   licences are signed tokens kept in the person's own planner. A team gift
//   stores the company, its message, the seat count and a counter of
//   activations — never who activated. A purchase stores the Stripe session
//   id, the licence id and the buyer's email (from Stripe).
//
// Owner access: POST admin/session exchanges ADMIN_TOKEN (+ an authenticator
// code when ADMIN_TOTP_SECRET is set) for an 8-hour signed session, sent as
// `Authorization: Bearer <session>`. Without ADMIN_TOTP_SECRET the raw token
// is also accepted as the Bearer value. See server/admin-auth.js.

import { base32Decode, issueSession, looksLikeSession, timingSafeEqual, TOTP_MIN_SECRET_BYTES, verifySession, verifyTotp, verifyWaitlistRemoveToken, waitlistRemoveToken } from './admin-auth.js';
import { announcementEmail, createResendMailer, DEFAULT_EMAIL_TIMEOUT_MS, EMAILS_PER_SEND, escapeHtml, htmlDocument, idempotencyKey, parseAddress, RESEND_MIN_INTERVAL_MS, textToHtml } from './email.js';
import { cleanOrg, DEFAULT_PUBLIC_BASE_URL, formatGiftCode, giftBuyerEmail, giftExpiry, giftLimit, giftManageUrl, giftStatus, giftUrl, licenseUrl, newGiftCode, normalizeBaseUrl, normalizeGift, normalizeGiftCode, publicGift, validateGiftFields } from './gifts.js';
import { giftManageKey, importSigningKey, isoDay, newLicenseId, publicKeyFromSigningKey, signLicense } from './licenses.js';
import { fetchCheckoutSession, parseStripePrices, readCheckoutSession, STRIPE_SESSION_RE, stripeMode } from './stripe.js';

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
  'year_review_opened',
  // Team gifts (landing)
  'pack_checkout_clicked',
  'gift_link_copied'
]);

export const FEEDBACK_KINDS = new Set(['idea', 'problem', 'praise', 'other']);
export const DEVICE_KINDS = new Set(['iphone', 'ipad', 'android', 'mac', 'windows', 'linux', 'other']);
export const TEAM_TIMINGS = new Set(['december-2026', 'january-2027', 'q1-2027', 'later']);
export const TEAM_SOURCES = new Set(['landing', 'app']);
export const TEAM_PLAN_LABELS = Object.freeze({
  'up-to-10': 'Up to 10 people',
  'up-to-50': 'Up to 50 people',
  'up-to-100': 'Up to 100 people',
  'up-to-500': 'Up to 500 people',
  'up-to-1000': 'Up to 1,000 people',
  'over-1000': 'Over 1,000 people'
});
export const TEAM_PLANS = new Set(Object.keys(TEAM_PLAN_LABELS));
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
const NOT_PLUS_PAYMENT = 'This payment is not for Daily Planner Plus.';
const UNKNOWN_SESSION_TTL_MS = 10 * 60 * 1000;
const UNKNOWN_SESSIONS_MAX = 500;
const MISSING_TABLE = 'A database table is missing. Apply every file in migrations/ to the D1 database (see docs/FEEDBACK_AND_WAITLIST.md).';
const ANNOUNCE_SUBJECT_MAX = 150;
const ANNOUNCE_TEXT_MAX = 8000;
const TEAM_SIZE_MIN = 2;
const TEAM_SIZE_MAX = 100000;
const AUTH_FAILURE_DELAY_MS = 400;
const MAX_BODY_BYTES = 16 * 1024;
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

async function readJson(request) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > MAX_BODY_BYTES) throw new Error('too-large');
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
      if (size > MAX_BODY_BYTES) { await reader.cancel().catch(() => {}); throw new Error('too-large'); }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const text = new TextDecoder().decode(bytes);
  try { return JSON.parse(text || '{}'); } catch { throw new Error('invalid-json'); }
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

/** Validate feedback. Returns { entry } or { error }. */
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
  return {
    entry: {
      appVersion: version,
      rating,
      kind: FEEDBACK_KINDS.has(body?.kind) ? body.kind : 'other',
      message,
      email,
      platform: clip(body?.platform, 40),
      createdAt: now.toISOString()
    }
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
      createdAt: now.toISOString()
    }
  };
}

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
    ['Locale', entry.locale || '—']
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
 * @param {string} [options.stripeSecretKey] STRIPE_SECRET_KEY (a restricted key that can read Checkout Sessions)
 * @param {string} [options.stripePrices]   STRIPE_PRICES (JSON, see server/stripe.js)
 * @param {typeof fetch} [options.stripeFetch] fetch used for Stripe (tests inject one)
 * @param {(promise: Promise) => void} [options.defer] keeps background work alive after the
 *   response (Pages Functions: context.waitUntil); without it the work simply runs on
 * @param {(message: string) => void} [options.warn] where swallowed email and payment failures are reported
 */
export function createPlannerApi({
  store, adminToken = '', adminTotpSecret = '', allowedOrigins = '', now = () => new Date(), authFailureDelayMs = AUTH_FAILURE_DELAY_MS,
  resendApiKey = '', emailFrom = '', ownerEmail = '', emailDailyLimit = '', emailFetch, emailIntervalMs = RESEND_MIN_INTERVAL_MS, notifyTimeoutMs = NOTIFY_TIMEOUT_MS,
  publicBaseUrl = '', plusSigningKey = '', stripeSecretKey = '', stripePrices = '', stripeFetch,
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
  const stripe = parseStripePrices(stripePrices);
  const stripeKey = String(stripeSecretKey || '').trim();
  const stripeFetchImpl = stripeFetch || globalThis.fetch?.bind(globalThis);
  const paymentsConfigured = !!(stripeKey && stripe.prices.size && stripeFetchImpl);
  // Checkout references Stripe did not know (or that sell something else) are
  // remembered for a few minutes, so repeating a made-up id costs no Stripe call.
  // Per worker instance and best effort: the WAF rate limit is the real guard.
  const unknownSessions = new Map();
  const isUnknownSession = id => {
    const until = unknownSessions.get(id);
    if (until === undefined) return false;
    if (until > now().getTime()) return true;
    unknownSessions.delete(id);
    return false;
  };
  const rememberUnknownSession = id => {
    if (unknownSessions.size >= UNKNOWN_SESSIONS_MAX) unknownSessions.delete(unknownSessions.keys().next().value);
    unknownSessions.set(id, now().getTime() + UNKNOWN_SESSION_TTL_MS);
  };

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

  /** Store a new gift under a fresh code; a Stripe session makes at most one gift. */
  async function createGift(fields) {
    const created = now();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const gift = normalizeGift({
        message: '', currency: '', amount: null, source: 'manual', stripeSession: null, buyerEmail: '', note: '',
        ...fields,
        code: newGiftCode(), redeemed: 0, active: true, createdAt: created.toISOString(), expiresAt: giftExpiry(created), emailedAt: null
      });
      if (await store.addGift(gift)) return gift;
      if (gift.stripeSession) {
        const existing = await store.getGiftBySession(gift.stripeSession);
        if (existing) return existing;
      }
    }
    throw new Error('Could not create a unique gift code.');
  }

  /**
   * Email the buyer the gift link, the manage link and a message to forward —
   * once per gift: emailed_at is claimed first, and released if Resend refuses.
   */
  async function emailGiftBuyer(gift, manageKey, timeoutMs) {
    if (!mailer.configured) return { emailed: false, error: 'Email is not set up (RESEND_API_KEY and EMAIL_FROM).' };
    if (!gift.buyerEmail) return { emailed: false, error: 'There is no buyer email address.' };
    if (!await store.markGiftEmailed(gift.code, now().toISOString())) return { emailed: false, already: true };
    const base = baseUrl();
    try {
      await mailer.send({ ...giftBuyerEmail({ gift, url: giftUrl(base, gift.code), manageUrl: giftManageUrl(base, gift.code, manageKey) }), replyTo: owner, recipients: [{ email: gift.buyerEmail }] }, { timeoutMs });
    } catch (error) {
      await store.clearGiftEmailed(gift.code).catch(() => {});
      return { emailed: false, error: String(error?.message || error) };
    }
    await store.addEmailSends(today(), EMAIL_SENDS_EVENT, 1).catch(() => {});
    return { emailed: true };
  }

  function emailGiftBuyerLater(gift, manageKey) {
    if (!mailer.configured || !gift.buyerEmail || gift.emailedAt) return;
    const task = emailGiftBuyer(gift, manageKey, BUYER_EMAIL_TIMEOUT_MS)
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
      return gift ? json(200, publicGift(gift, now().toISOString()), cors) : json(404, { error: GIFT_UNKNOWN }, cors);
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
    // Redeem: one atomic increment that can never pass the limit.
    const nowIso = now().toISOString();
    if (await store.redeemGift(code, nowIso)) {
      const gift = await store.getGift(code);
      let license;
      try {
        license = await signLicense(key, { src: 'gift', org: gift.org, iat: isoDay(now()) });
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
    if (status === 'inactive') return json(410, { error: 'This gift link is no longer active.' }, cors);
    return json(409, { error: 'This gift has been fully claimed.' }, cors);
  }

  async function giftClaimAnswer(gift, cors) {
    const manageKey = await manageKeyOf(gift.code);
    emailGiftBuyerLater(gift, manageKey);
    const base = baseUrl();
    return json(200, {
      kind: 'gift', code: formatGiftCode(gift.code), url: giftUrl(base, gift.code), seats: gift.seats, redeemed: gift.redeemed,
      org: gift.org, message: gift.message, manageKey, manageUrl: giftManageUrl(base, gift.code, manageKey), expiresAt: gift.expiresAt
    }, cors);
  }

  async function plusClaimAnswer(purchase, key, cors) {
    if (!await store.claimPurchase(purchase.stripeSession, PLUS_CLAIMS_MAX)) {
      return json(409, { error: `This purchase has already been activated ${PLUS_CLAIMS_MAX} times. Reply to your receipt and we will help.` }, cors);
    }
    const license = await signLicense(key, { src: 'purchase', id: purchase.licenseId, iat: String(purchase.createdAt).slice(0, 10) });
    return json(200, { kind: 'plus', license }, cors);
  }

  async function claimRoute(request, cors) {
    if (request.method !== 'POST') return json(405, { error: 'Method not allowed' }, cors);
    const body = await readJson(request);
    if (!paymentsConfigured) return json(503, { error: 'Payments are not configured.' }, cors);
    const key = await signer();
    if (!key) return json(503, { error: PLUS_OFF }, cors);
    const sessionId = typeof body?.session === 'string' ? body.session.trim() : '';
    if (!STRIPE_SESSION_RE.test(sessionId)) return json(404, { error: PAYMENT_UNKNOWN }, cors);
    // Known sessions are answered from the database, without asking Stripe again.
    const purchase = await store.getPurchase(sessionId);
    if (purchase?.kind === 'plus') return plusClaimAnswer(purchase, key, cors);
    const existingGift = await store.getGiftBySession(sessionId);
    if (existingGift) return giftClaimAnswer(existingGift, cors);
    if (isUnknownSession(sessionId)) return json(404, { error: PAYMENT_UNKNOWN }, cors);

    let session;
    try {
      session = await fetchCheckoutSession({ secretKey: stripeKey, sessionId, fetch: stripeFetchImpl });
    } catch (error) {
      safeWarn(`Stripe session not read: ${error?.message || error}`);
      return json(502, { error: 'The payment could not be checked right now. Please try again in a minute.' }, cors);
    }
    if (!session) {
      rememberUnknownSession(sessionId);
      return json(404, { error: PAYMENT_UNKNOWN }, cors);
    }
    const paid = readCheckoutSession(session, stripe.prices);
    if (!paid.item) {
      rememberUnknownSession(sessionId);
      return json(404, { error: NOT_PLUS_PAYMENT }, cors);
    }
    if (!paid.paid) return json(402, { error: 'This payment is not complete yet.' }, cors);
    const createdAt = now().toISOString();
    if (paid.item.kind === 'plus') {
      const row = { stripeSession: sessionId, kind: 'plus', licenseId: newLicenseId(), claims: 1, email: paid.email.slice(0, 254), note: '', createdAt };
      if (await store.addPurchase(row)) {
        return json(200, { kind: 'plus', license: await signLicense(key, { src: 'purchase', id: row.licenseId, iat: createdAt.slice(0, 10) }) }, cors);
      }
      // Claimed at the same moment by another request: answer like a repeat claim.
      const again = await store.getPurchase(sessionId);
      if (again?.kind === 'plus') return plusClaimAnswer(again, key, cors);
      return json(404, { error: PAYMENT_UNKNOWN }, cors);
    }
    const gift = await createGift({
      org: cleanOrg(paid.org) || 'Your company',
      seats: paid.item.seats,
      source: 'stripe',
      stripeSession: sessionId,
      buyerEmail: paid.email.slice(0, 254),
      currency: paid.currency === 'EUR' || paid.currency === 'USD' ? paid.currency : '',
      amount: paid.amount,
      note: paid.item.plan ? `Stripe · ${TEAM_PLAN_LABELS[paid.item.plan] || paid.item.plan}` : 'Stripe'
    });
    return giftClaimAnswer(gift, cors);
  }

  async function setupInfo() {
    const publicKey = await plusPublicKey();
    const kinds = [...stripe.prices.values()];
    return {
      email: {
        configured: mailer.configured,
        apiKeySet: !!String(resendApiKey || '').trim(),
        fromSet: !!String(emailFrom || '').trim(),
        from: mailer.sender ? mailer.from : '',
        ownerEmail: owner?.email || '',
        dailyLimit
      },
      stripe: {
        configured: paymentsConfigured,
        keySet: !!stripeKey,
        mode: stripeMode(stripeKey),
        plusPrices: kinds.filter(price => price.kind === 'plus').length,
        giftPrices: kinds.filter(price => price.kind === 'gift').length,
        error: stripe.error
      },
      plus: { configured: !!publicKey, keySet: !!signingSecret, publicKey },
      publicBaseUrl: baseUrl(),
      publicBaseUrlSet: !!normalizeBaseUrl(typeof publicBaseUrl === 'function' ? publicBaseUrl() : publicBaseUrl),
      twoFactor: totpEnabled
    };
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
      const gift = await createGift({ ...result.fields, source: 'manual', stripeSession: null });
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
      // A paid Stripe gift is switched off, never erased: its row is the only
      // record of the session, and erasing it would let the same checkout
      // create a fresh gift with all its seats again.
      if (existing.stripeSession) {
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
    await store.addPurchase({ stripeSession: `manual_${id}`, kind: 'manual', licenseId: id, claims: 0, email: '', note, createdAt });
    const license = await signLicense(key, { src: 'manual', id, iat: isoDay(new Date(createdAt)) });
    return json(201, { license, url: licenseUrl(baseUrl(), license) }, cors);
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
      const [eventTotals, eventDaily, waitlist, feedbackByVersion, feedbackLatest, teamData, emailsSentToday, plusData, setup] = await Promise.all([
        store.eventTotals({ sinceDay }).then(publicEvents),
        store.eventDaily({ sinceDay }).then(publicEvents),
        store.listWaitlist(),
        store.feedbackByVersion(),
        store.listFeedback({ limit: 30 }),
        teams,
        store.emailSendsOn(today(), EMAIL_SENDS_EVENT),
        plusTables,
        setupInfo()
      ]);
      const [teamRequests, teamRequestTotals] = teamData || [[], { count: 0, seats: 0 }];
      const [giftRows, giftTotals, purchaseTotals, manualLicenses] = plusData || [[], { count: 0, seats: 0, redeemed: 0, stripe: 0 }, { plus: 0, manual: 0 }, []];
      return json(200, {
        generatedAt: nowIso, sinceDay, eventTotals, eventDaily, waitlist, feedbackByVersion, feedbackLatest, teamRequests, teamRequestTotals, teamRequestsUnavailable: !teamData,
        emailConfigured: mailer.configured, emailTestAvailable: mailer.configured && !!owner, emailDailyLimit: dailyLimit, emailsSentToday, emailsPerSend: EMAILS_PER_SEND,
        gifts: await Promise.all(giftRows.map(gift => adminGift(gift, nowIso))), giftTotals, plusUnavailable: !plusData,
        plus: { purchases: purchaseTotals.plus, manualLicenses: purchaseTotals.manual, recentLicenses: manualLicenses.map(row => ({ id: row.licenseId, note: row.note, createdAt: row.createdAt })) },
        setup
      }, cors);
    }
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
      if (url.searchParams.get('format') === 'csv') return csvResponse(rows, ['id', 'createdAt', 'company', 'teamSize', 'plan', 'currency', 'kind', 'timing', 'name', 'email', 'message', 'locale', 'appVersion', 'source'], 'daily-planner-team-requests.csv', cors);
      return json(200, { rows }, cors);
    }
    if (path === 'admin/waitlist/announce') return announce(request, cors);
    if (path === 'admin/licenses') return adminLicense(request, cors);
    if (path.startsWith('admin/gifts')) {
      const answer = await adminGifts(request, path, cors);
      if (answer) return answer;
    }
    const removal = path.match(/^admin\/(waitlist|feedback|teams)\/(\d+)$/);
    if (request.method === 'DELETE' && removal) {
      const remove = { waitlist: store.deleteWaitlist, feedback: store.deleteFeedback, teams: store.deleteTeamRequest }[removal[1]];
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
      const gift = /^gifts\/([^/]{1,40})(\/redeem)?$/.exec(path);
      if (gift) return await giftRoute(request, gift, cors);
      if (path === 'purchases/claim') return await claimRoute(request, cors);
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
 * oldest-first announcement order, internal email-send counts, gift limits).
 */
export function createMemoryStore(initial = {}, { onChange = null } = {}) {
  const data = {
    events: Array.isArray(initial.events) ? initial.events : [],
    waitlist: Array.isArray(initial.waitlist) ? initial.waitlist : [],
    feedback: Array.isArray(initial.feedback) ? initial.feedback : [],
    teamRequests: Array.isArray(initial.teamRequests) ? initial.teamRequests : [],
    gifts: Array.isArray(initial.gifts) ? initial.gifts : [],
    purchases: Array.isArray(initial.purchases) ? initial.purchases : [],
    nextId: Number(initial.nextId) || 1
  };
  const changed = () => onChange?.(data);
  const byNewest = (a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || b.id - a.id;
  const findGift = code => data.gifts.find(item => item.code === code);
  const GIFT_EDITABLE = ['org', 'message', 'seats', 'active', 'note'];
  return {
    data,
    async addGift(gift) {
      if (data.gifts.some(item => item.code === gift.code || (gift.stripeSession && item.stripeSession === gift.stripeSession))) return false;
      data.gifts.push({ ...normalizeGift(gift) });
      changed();
      return true;
    },
    async getGift(code) { return normalizeGift(findGift(code)); },
    async getGiftBySession(session) { return normalizeGift(data.gifts.find(item => item.stripeSession === session)); },
    async listGifts({ limit = 0 } = {}) {
      const rows = [...data.gifts].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || a.code.localeCompare(b.code)).map(normalizeGift);
      return limit ? rows.slice(0, limit) : rows;
    },
    async giftTotals() {
      return data.gifts.reduce((totals, item) => ({
        count: totals.count + 1,
        seats: totals.seats + (Number(item.seats) || 0),
        redeemed: totals.redeemed + (Number(item.redeemed) || 0),
        stripe: totals.stripe + (item.source === 'stripe' ? 1 : 0)
      }), { count: 0, seats: 0, redeemed: 0, stripe: 0 });
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
    async getPurchase(session) {
      const row = data.purchases.find(item => item.stripeSession === session);
      return row ? { ...row } : null;
    },
    async addPurchase(row) {
      if (data.purchases.some(item => item.stripeSession === row.stripeSession)) return false;
      data.purchases.push({ note: '', ...row });
      changed();
      return true;
    },
    async claimPurchase(session, max) {
      const row = data.purchases.find(item => item.stripeSession === session);
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
      data.teamRequests.push({ id: data.nextId++, ...entry });
      changed();
    },
    async listTeamRequests({ limit = 0 } = {}) {
      const rows = [...data.teamRequests].sort(byNewest);
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
