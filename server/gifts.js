// Gifts of Daily Planner Plus: codes, limits, validation and the emails sent
// to whoever bought one. Pure helpers, shared by the router
// (server/planner-api.js) and both stores.
//
// A gift is ONE link (https://planner.bemorin.com/?gift=XXXX-XXXX-XXXX) that a
// company shares with its people (a team gift), or that a person sends to a
// friend or to their family (a personal gift: 'gift-1', 'family-5' in
// src/lib/pricing.js). Each activation uses a seat; the server allows
// seats + max(1, floor(seats × 10%)) activations for team gifts of 10 seats or
// more (reinstalls) and exactly the seats below that; links can be
// activated for 12 months after creation. Nothing about the people who
// activate is stored: only a counter.

import { escapeHtml, htmlDocument, textToHtml } from './email.js';
import { isPersonalGift } from '../src/lib/pricing.js';

export const GIFT_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const GIFT_CODE_LENGTH = 12;
export const GIFT_SEATS_MAX = 100000;
export const GIFT_ORG_MAX = 80;
export const GIFT_MESSAGE_MAX = 280;
export const GIFT_NOTE_MAX = 500;
export const GIFT_VALID_MONTHS = 12;
export const GIFT_AMOUNT_MAX = 100000000;
export const GIFT_CURRENCIES = new Set(['EUR', 'USD']);
// 'creem': bought online (the gift keeps its checkout reference); 'manual': made in the dashboard.
export const GIFT_SOURCES = new Set(['manual', 'creem']);
export const DEFAULT_PUBLIC_BASE_URL = 'https://planner.bemorin.com';

const CODE_RE = new RegExp(`^[${GIFT_CODE_ALPHABET}]{${GIFT_CODE_LENGTH}}$`);
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"?&=%/#]{1,64}@[a-z0-9](?:[a-z0-9.-]{0,188}[a-z0-9])?\.[a-z]{2,24}$/i;

/** A new random gift code (12 characters, no look-alikes), without dashes. */
export function newGiftCode(random = bytes => crypto.getRandomValues(bytes)) {
  let code = '';
  // Rejection sampling keeps every character equally likely (248 = 8 × 31).
  while (code.length < GIFT_CODE_LENGTH) {
    for (const byte of random(new Uint8Array(16))) {
      if (byte < 248 && code.length < GIFT_CODE_LENGTH) code += GIFT_CODE_ALPHABET[byte % GIFT_CODE_ALPHABET.length];
    }
  }
  return code;
}

/** "abcd-efgh-jkmn" → "ABCDEFGHJKMN"; '' when it is not a gift code. Dashes are optional, case is ignored. */
export function normalizeGiftCode(value) {
  const text = String(value ?? '').trim();
  if (text.length > 20) return '';
  const code = text.replace(/-/g, '').toUpperCase();
  return CODE_RE.test(code) ? code : '';
}

/** "ABCDEFGHJKMN" → "ABCD-EFGH-JKMN". */
export const formatGiftCode = code => String(code).replace(/-/g, '').replace(/(.{4})(?=.)/g, '$1-');

/**
 * Activations allowed. Team gifts (10 seats or more): the seats plus 10% (at
 * least one) for people who set the planner up again. Smaller gifts — Give Plus,
 * Plus Family, small gifts made in the dashboard — get exactly their seats, so a
 * personal gift can't be shared beyond the people it was bought for.
 */
export const TEAM_MARGIN_FROM = 10;
export const giftLimit = seats => Number(seats) + (Number(seats) >= TEAM_MARGIN_FROM ? Math.max(1, Math.floor(Number(seats) * 0.1)) : 0);

/** ISO time GIFT_VALID_MONTHS after `date`. */
export function giftExpiry(date) {
  const expiry = new Date(date.getTime());
  expiry.setUTCMonth(expiry.getUTCMonth() + GIFT_VALID_MONTHS);
  return expiry.toISOString();
}

/** 'inactive' | 'expired' | 'claimed' | 'available' at ISO time `nowIso`. */
export function giftStatus(gift, nowIso) {
  if (!gift.active) return 'inactive';
  if (String(gift.expiresAt) <= nowIso) return 'expired';
  if (Number(gift.redeemed) >= giftLimit(gift.seats)) return 'claimed';
  return 'available';
}

/** Same shape from both stores: booleans and numbers, null when unknown. */
export function normalizeGift(row) {
  if (!row) return null;
  return {
    code: String(row.code),
    org: String(row.org ?? ''),
    message: String(row.message ?? ''),
    seats: Number(row.seats) || 0,
    redeemed: Number(row.redeemed) || 0,
    active: row.active === true || Number(row.active) === 1,
    currency: String(row.currency ?? ''),
    amount: row.amount == null || row.amount === '' ? null : Number(row.amount),
    source: String(row.source ?? 'manual'),
    // The checkout that paid for the gift (column stripe_session, kept for older rows); null for manual gifts.
    checkoutRef: row.checkoutRef ? String(row.checkoutRef) : row.stripeSession ? String(row.stripeSession) : null,
    buyerEmail: String(row.buyerEmail ?? ''),
    note: String(row.note ?? ''),
    createdAt: String(row.createdAt ?? ''),
    expiresAt: String(row.expiresAt ?? ''),
    emailedAt: row.emailedAt ? String(row.emailedAt) : null
  };
}

/**
 * What anyone holding the link may see. Never the buyer, the note or the amount.
 * `plan` is what was bought online ('gift-1', 'family-5', 'up-to-50' …), '' for a
 * gift made in the dashboard.
 */
export function publicGift(gift, nowIso, plan = '') {
  const status = giftStatus(gift, nowIso);
  return { org: gift.org, message: gift.message, seats: gift.seats, redeemed: gift.redeemed, available: status === 'available', expiresAt: gift.expiresAt, status, plan };
}

/** "https://host/path/" → "https://host/path"; '' unless it is an http(s) URL. */
export function normalizeBaseUrl(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return '';
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return '';
  }
}

export const giftUrl = (base, code) => `${base}/?gift=${formatGiftCode(code)}`;
export const giftManageUrl = (base, code, key) => `${base}/welcome/thanks/?gift=${formatGiftCode(code)}&key=${key}`;
export const licenseUrl = (base, token) => `${base}/?license=${token}`;

const oneLine = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
const multiLine = value => String(value ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

/** Company name: one line, at most GIFT_ORG_MAX characters (longer names are cut, e.g. from a checkout). */
export const cleanOrg = value => oneLine(value).slice(0, GIFT_ORG_MAX).trim();

/**
 * Validate gift fields from the dashboard (create: every required field) or a
 * manage link (allowed: only org and message). Returns { fields } or { error }.
 * `amount` is in minor units (cents).
 */
export function validateGiftFields(body, { create = false, allowed = ['org', 'seats', 'message', 'note', 'currency', 'amount', 'buyerEmail', 'active'] } = {}) {
  const fields = {};
  const has = name => allowed.includes(name) && (create || (body && Object.prototype.hasOwnProperty.call(body, name) && body[name] !== undefined));
  if (has('org')) {
    const org = oneLine(body?.org);
    if (!org) return { error: 'Add the company name.' };
    if (org.length > GIFT_ORG_MAX) return { error: `Keep the company name under ${GIFT_ORG_MAX} characters.` };
    fields.org = org;
  }
  if (has('seats')) {
    const raw = body?.seats;
    const seats = typeof raw === 'number' || (typeof raw === 'string' && /^\s*\d+\s*$/.test(raw)) ? Number(raw) : NaN;
    if (!Number.isInteger(seats) || seats < 1 || seats > GIFT_SEATS_MAX) return { error: 'Seats must be a whole number between 1 and 100,000.' };
    fields.seats = seats;
  }
  if (has('message')) {
    if (body?.message != null && typeof body.message !== 'string') return { error: 'The message must be text.' };
    const message = multiLine(body?.message);
    if (message.length > GIFT_MESSAGE_MAX) return { error: `Keep the message under ${GIFT_MESSAGE_MAX} characters.` };
    fields.message = message;
  }
  if (has('note')) {
    const note = multiLine(body?.note);
    if (note.length > GIFT_NOTE_MAX) return { error: `Keep the note under ${GIFT_NOTE_MAX} characters.` };
    fields.note = note;
  }
  if (has('currency')) {
    const currency = String(body?.currency ?? '').trim().toUpperCase();
    if (currency && !GIFT_CURRENCIES.has(currency)) return { error: 'The currency must be EUR or USD.' };
    fields.currency = currency;
  }
  if (has('amount')) {
    const raw = body?.amount;
    if (raw == null || raw === '') fields.amount = null;
    else {
      const amount = Number(raw);
      if (!Number.isInteger(amount) || amount < 0 || amount > GIFT_AMOUNT_MAX) return { error: 'The amount must be a whole number of cents.' };
      fields.amount = amount;
    }
    if (fields.amount != null && create && !fields.currency) return { error: 'Choose the currency of the amount.' };
  }
  if (has('buyerEmail')) {
    const email = String(body?.buyerEmail ?? '').trim().toLowerCase().slice(0, 300);
    if (email && !EMAIL_RE.test(email)) return { error: 'The buyer’s email address does not look right.' };
    fields.buyerEmail = email;
  }
  if (has('active') && !create) {
    if (typeof body.active !== 'boolean') return { error: 'Active must be true or false.' };
    fields.active = body.active;
  }
  return { fields };
}

const longDate = iso => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const PLUS_UNLOCKS = 'It unlocks Plan your year, Your year in review and new colours for your painted year, for life. No account, no sign-up: nothing about you is collected.';

/**
 * The message a buyer can forward to the people the gift is for. A team gift
 * speaks for the company (`org`); a personal gift (`personal`) is written by
 * the giver, to one person or, with more than one seat, to a family.
 */
export function giftForwardMessage({ org, message, url, expiresAt, seats = 1, personal = false }) {
  const extra = message ? ['', message] : [];
  const until = `The link can be activated until ${longDate(expiresAt)}.`;
  if (personal && Number(seats) > 1) {
    const people = Number(seats).toLocaleString('en-US');
    return {
      subject: 'A gift for the family: Daily Planner Plus',
      text: ['Hi everyone,', '', 'I’m giving each of you Daily Planner Plus: a lifetime upgrade of Daily Planner, the calm planner that keeps your plans on your own device.', '', `Each of you opens this link once, on the device where you plan (it works for up to ${people} people): ${url}`, '', PLUS_UNLOCKS, ...extra, '', until].join('\n')
    };
  }
  if (personal) {
    return {
      subject: 'A gift for you: Daily Planner Plus',
      text: ['Hi,', '', 'I’m giving you Daily Planner Plus: a lifetime upgrade of Daily Planner, the calm planner that keeps your plans on your own device.', '', `Open this link on the device where you plan: ${url}`, '', PLUS_UNLOCKS, ...extra, '', until].join('\n')
    };
  }
  const lines = [
    'Hi everyone,',
    '',
    `${org} is giving you Daily Planner Plus: a lifetime upgrade of Daily Planner, the calm planner that keeps your plans on your own device.`,
    '',
    `Open this link on the device where you plan: ${url}`,
    '',
    PLUS_UNLOCKS,
    ...extra,
    '',
    until
  ];
  return { subject: `A gift from ${org}: Daily Planner Plus`, text: lines.join('\n') };
}

const link = href => `<a href="${escapeHtml(href)}">${escapeHtml(href)}</a>`;
const QUOTE_STYLE = 'margin:12px 0;padding:12px 16px;border-left:3px solid #ddd8d0;background:#f7f5f1';

/**
 * The email to someone who gave Plus to a friend ('gift-1') or to their family
 * ('family-5'): the link to send, how activation works, the manage link and a
 * message to forward. Personal wording only: never a team or a company.
 */
function personalGiftEmail({ gift, url, manageUrl }) {
  const family = Number(gift.seats) > 1;
  const people = Number(gift.seats).toLocaleString('en-US');
  const forward = giftForwardMessage({ org: gift.org, message: gift.message, url, expiresAt: gift.expiresAt, seats: gift.seats, personal: true });
  const until = longDate(gift.expiresAt);
  const parts = {
    thanks: 'Thank you for giving Daily Planner Plus.',
    linkTitle: family ? `Your gift link, for up to ${people} people` : 'Your gift link, for one person',
    send: family ? 'Send this link to your family.' : 'Send this link to the person you are giving Plus to.',
    how: family
      ? `Each person opens it once on the device where they plan, and Plus is theirs for life. No account is needed. Each activation uses one of the ${gift.seats} places, so share the link only with them. The link can be activated until ${until}.`
      : `They open it once on the device where they plan, and Plus is theirs for life. No account is needed. The link works once, so send it only to them. The link can be activated until ${until}.`,
    manage: `(see ${family ? 'how many people have activated it' : 'whether it has been activated'}, change your message or the name shown with the gift). Keep this link to yourself:`,
    forwardTitle: family ? 'A message you can forward to your family' : 'A message you can send with the link',
    receipt: 'Your receipt comes separately from Creem, which handles the payment.'
  };
  const html = [
    `<p>${escapeHtml(parts.thanks)}</p>`,
    `<p><b>${escapeHtml(parts.linkTitle)}</b>:<br>\n${link(url)}</p>`,
    `<p>${escapeHtml(parts.send)} ${escapeHtml(parts.how)}</p>`,
    `<p><b>Manage the gift</b> ${escapeHtml(parts.manage)}<br>\n${link(manageUrl)}</p>`,
    `<p><b>${escapeHtml(parts.forwardTitle)}</b></p>`,
    `<div style="${QUOTE_STYLE}"><p><b>${escapeHtml(forward.subject)}</b></p>\n${textToHtml(forward.text)}</div>`,
    `<p>${escapeHtml(parts.receipt)}</p>`,
    '<p>Questions? Just reply to this email.</p>'
  ].join('\n');
  const text = [
    parts.thanks,
    '',
    `${parts.linkTitle}:`,
    url,
    '',
    `${parts.send} ${parts.how}`,
    '',
    `Manage the gift ${parts.manage}`,
    manageUrl,
    '',
    `${parts.forwardTitle}:`,
    '',
    `Subject: ${forward.subject}`,
    '',
    forward.text,
    '',
    parts.receipt,
    '',
    '---',
    'Questions? Just reply to this email.',
    ''
  ].join('\n');
  return { subject: 'Your Daily Planner Plus gift is ready', html: htmlDocument(html), text };
}

/**
 * The one email sent to the buyer of a gift: the link, the manage link and a
 * message to forward. `plan` is what was bought: a personal gift ('gift-1',
 * 'family-5') gets personal wording, anything else (a team tier, a gift made in
 * the dashboard) is written for a company.
 */
export function giftBuyerEmail({ gift, url, manageUrl, plan = '' }) {
  if (isPersonalGift(plan)) return personalGiftEmail({ gift, url, manageUrl });
  const seats = Number(gift.seats).toLocaleString('en-US');
  const forward = giftForwardMessage({ org: gift.org, message: gift.message, url, expiresAt: gift.expiresAt });
  const html = [
    `<p>Thank you for giving Daily Planner Plus to ${escapeHtml(gift.org)}.</p>`,
    `<p><b>Your gift link</b> (for up to ${escapeHtml(seats)} people):<br>\n${link(url)}</p>`,
    `<p>Each person opens it once on the device where they plan. It can be activated until ${escapeHtml(longDate(gift.expiresAt))}.</p>`,
    `<p><b>Manage the gift</b> (see how many people activated it, change the message or the company name). Keep this link to yourself:<br>\n${link(manageUrl)}</p>`,
    '<p><b>A message you can forward to your team</b></p>',
    `<div style="${QUOTE_STYLE}"><p><b>${escapeHtml(forward.subject)}</b></p>\n${textToHtml(forward.text)}</div>`,
    '<p>Questions? Just reply to this email.</p>'
  ].join('\n');
  const text = [
    `Thank you for giving Daily Planner Plus to ${oneLine(gift.org)}.`,
    '',
    `Your gift link (for up to ${seats} people):`,
    url,
    '',
    `Each person opens it once on the device where they plan. It can be activated until ${longDate(gift.expiresAt)}.`,
    '',
    'Manage the gift (see how many people activated it, change the message or the company name). Keep this link to yourself:',
    manageUrl,
    '',
    'A message you can forward to your team:',
    '',
    `Subject: ${forward.subject}`,
    '',
    forward.text,
    '',
    '---',
    'Questions? Just reply to this email.',
    ''
  ].join('\n');
  return { subject: oneLine(`Your Daily Planner Plus gift link for ${gift.org}`), html: htmlDocument(html), text };
}
