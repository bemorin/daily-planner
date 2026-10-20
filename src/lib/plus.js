import { PLUS_PUBLIC_KEY } from '../config.js';

/**
 * Daily Planner Plus — a one-time, lifetime unlock, verified on the device.
 *
 * A licence is `DP1.<payload>.<signature>`: base64url JSON, signed with ECDSA
 * P-256 / SHA-256 (raw r||s) over the ASCII bytes of `DP1.<payload>`. The
 * public key comes from the runtime configuration; with it blank (the public
 * source), Plus can't be activated in that copy.
 *
 * The licence lives in the planner settings (`settings.plus = { token,
 * activatedAt }`, and `settings.plusGift = { code, org }` after a gift), so
 * backups and Google Drive sync carry it to the person's other devices. app.js
 * owns the settings object and connects it here with connectPlus(); every
 * feature asks hasPlus() and listens with onPlusChange().
 *
 * A refunded purchase or gift is revoked on the server; about once a week
 * src/features/plus-check.js asks whether this licence still holds and, when
 * it doesn't, calls revokePlus(). This device then remembers the licence id
 * as revoked, so sync, a backup or another tab never brings it back, and keeps
 * the licence itself aside (never synced or backed up) to ask about it again
 * each week: when the owner restores it, restorePlus() brings Plus back.
 */

export const PLUS_PRICE = 29;
export const GIFT_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
/** Visitors from these regions see the price in euros; everyone else in dollars (same number). */
export const EURO_AREA = Object.freeze(['AT', 'BE', 'BG', 'CY', 'DE', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PT', 'SI', 'SK', 'AD', 'MC', 'SM', 'VA', 'ME', 'XK']);
const SOURCES = new Set(['gift', 'purchase', 'manual', 'dev']);
const TOKEN_RE = /^DP1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;
// Checkout references: Creem ids (ch_…), older Stripe sessions (cs_…) and dev fakes —
// the same shape the server accepts. Typed on their own (not in a link), only the
// two known prefixes count, so a gift code is never mistaken for one.
const CHECKOUT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{5,199}$/;
const BARE_CHECKOUT_RE = /^(?:ch|cs_(?:live|test))_[A-Za-z0-9_-]+$/;
// Remembers the token this device last verified, so Plus is on from the first paint.
const VERIFIED_KEY = 'daily-planner-ui:plus-verified';
// The last licence check with the server, licence ids found revoked, the last
// revoked licence kept aside to ask about again (`held`: { token, activatedAt,
// gift }) and a notice to show once: { at, revoked: [id], held, notice:
// 'purchase'|'gift'|'manual'|'dev'|'restored' }. UI prefix: never synced or backed up.
export const PLUS_CHECK_KEY = 'daily-planner-ui:plus-checked';
const REVOKED_MAX = 20;
const LICENSE_ID_RE = /^[0-9a-f]{16}$/;
const TOKEN_MAX = 2048;
const NOTICES = new Set([...SOURCES, 'restored']);

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

export function base64ToBytes(value) {
  const clean = String(value || '').replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  const binary = atob(clean + '==='.slice((clean.length + 3) % 4));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

/** `ABCD-EFGH-JKMN` from a code typed any way (dashes and spaces optional, any case), or ''. */
export function normalizeGiftCode(input) {
  const raw = String(input || '').toUpperCase().replace(/[\s\-–—]/g, '');
  if (raw.length !== 12 || [...raw].some(char => !GIFT_ALPHABET.includes(char))) return '';
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
}

/**
 * What someone pasted into "Have a gift link or a licence?": a gift link or
 * code, a licence (or a ?license= link), or a purchase link (?purchase= from
 * the receipt email, ?checkout_id= from the payment page).
 */
export function parsePlusInput(input) {
  const text = String(input || '').trim();
  if (!text) return { kind: 'empty' };
  let value = text;
  if (/^https?:\/\/|[?&](?:gift|license|purchase|checkout_id)=/i.test(text)) {
    try {
      const params = new URL(text, 'https://planner.bemorin.com/').searchParams;
      if (params.get('gift')) return normalizeGiftCode(params.get('gift')) ? { kind: 'gift', code: normalizeGiftCode(params.get('gift')) } : { kind: 'invalid' };
      const checkout = (params.get('purchase') || params.get('checkout_id') || '').trim();
      if (checkout) return CHECKOUT_RE.test(checkout) ? { kind: 'purchase', checkout } : { kind: 'invalid' };
      if (params.get('license')) value = params.get('license');
      else return { kind: 'invalid' };
    } catch (_) {
      return { kind: 'invalid' };
    }
  }
  value = value.trim();
  if (TOKEN_RE.test(value)) return { kind: 'license', token: value };
  const code = normalizeGiftCode(value);
  if (code) return { kind: 'gift', code };
  return BARE_CHECKOUT_RE.test(value) && CHECKOUT_RE.test(value) ? { kind: 'purchase', checkout: value } : { kind: 'invalid' };
}

/** A checkout reference the server can look up (Creem `checkout_id`, a receipt's `?purchase=`). */
export const isCheckoutReference = value => CHECKOUT_RE.test(String(value || '').trim());

/** Region of a BCP 47 locale ('fr' → 'FR', 'en' → 'US'), or ''. */
export function localeRegion(locale) {
  try {
    const parsed = new Intl.Locale(String(locale || ''));
    return String(parsed.region || parsed.maximize().region || '').toUpperCase();
  } catch (_) {
    return '';
  }
}

export const plusCurrency = locale => (EURO_AREA.includes(localeRegion(locale)) ? 'EUR' : 'USD');

/** "29 €", "€29", "$29"… in the visitor's own format. */
export function formatPlusPrice(locale, amount = PLUS_PRICE) {
  const currency = plusCurrency(locale);
  try {
    return new Intl.NumberFormat(locale || undefined, { style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(amount);
  } catch (_) {
    return currency === 'EUR' ? `${amount} €` : `$${amount}`;
  }
}

/** Splits and checks a licence's shape (not its signature). Null when malformed. */
export function decodePlusToken(token) {
  const match = TOKEN_RE.exec(String(token || '').trim());
  if (!match) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(base64ToBytes(match[1])));
    if (!payload || payload.v !== 1 || payload.p !== 'plus' || !/^[0-9a-f]{16}$/.test(payload.id) || !SOURCES.has(payload.src) || typeof payload.iat !== 'string') return null;
    const signature = base64ToBytes(match[2]);
    if (signature.length !== 64) return null;
    const org = typeof payload.org === 'string' ? payload.org.trim().slice(0, 80) : '';
    return { payload: { v: 1, p: 'plus', id: payload.id, src: payload.src, iat: payload.iat, ...(org ? { org } : {}) }, signed: `DP1.${match[1]}`, signature };
  } catch (_) {
    return null;
  }
}

const keyCache = new Map();

/** The licence's payload when its signature matches `publicKey`, otherwise null. Never throws. */
export async function verifyPlusToken(token, publicKey = PLUS_PUBLIC_KEY, subtle = globalThis.crypto?.subtle) {
  const parts = decodePlusToken(token);
  if (!parts || !publicKey || !subtle) return null;
  try {
    if (!keyCache.has(publicKey)) keyCache.set(publicKey, subtle.importKey('spki', base64ToBytes(publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']));
    const key = await keyCache.get(publicKey);
    const ok = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, parts.signature, new TextEncoder().encode(parts.signed));
    return ok ? parts.payload : null;
  } catch (_) {
    keyCache.delete(publicKey);
    return null;
  }
}

/** The Plus fields of a raw settings object, cleaned (normalisation drops unknown keys). */
export function plusSettingsFrom(raw) {
  const fields = {};
  const plus = raw?.plus;
  if (plus && typeof plus === 'object' && TOKEN_RE.test(String(plus.token || '').trim())) {
    fields.plus = { token: String(plus.token).trim(), activatedAt: typeof plus.activatedAt === 'string' ? plus.activatedAt : '' };
  }
  const gift = raw?.plusGift;
  if (fields.plus && gift && typeof gift === 'object' && normalizeGiftCode(gift.code)) {
    fields.plusGift = { code: normalizeGiftCode(gift.code), org: String(gift.org || '').slice(0, 80) };
  }
  return fields;
}

/**
 * A licence is never lost by restoring an older backup, resetting the planner
 * or taking settings from another device: when `next` has none and `previous`
 * had one, it is carried over. Returns true when `next` changed.
 */
export function keepPlus(next, previous) {
  if (!next || next.plus?.token || !previous?.plus?.token) return false;
  Object.assign(next, plusSettingsFrom(previous));
  return true;
}

/** Another tab activated Plus: take its licence into this tab's settings. Returns true when adopted. */
export function adoptPlus(settings, rawSettingsJson) {
  try {
    const fields = plusSettingsFrom(JSON.parse(rawSettingsJson || 'null'));
    if (!settings || !fields.plus || fields.plus.token === settings.plus?.token) return false;
    Object.assign(settings, fields);
    return true;
  } catch (_) {
    return false;
  }
}

/** "Plus is active · from Acme Studio" / "· purchased on 9 Oct 2026" / "· since …". */
export function plusStatusLine(license, { gift = null, activatedAt = '', locale } = {}) {
  if (!license) return '';
  const date = value => {
    const parsed = value ? new Date(value) : null;
    return parsed && !Number.isNaN(parsed.valueOf()) ? parsed.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  };
  const org = license.org || gift?.org || '';
  // The server's fallback names for a personal gift with no name typed read as plain words.
  const giver = org === 'A friend' ? 'a friend' : org === 'Your family' ? 'your family' : org;
  if (license.src === 'gift' && giver) return `Plus is active · from ${giver}`;
  if (license.src === 'purchase' && date(license.iat)) return `Plus is active · purchased on ${date(license.iat)}`;
  const since = date(activatedAt) || date(license.iat);
  return since ? `Plus is active · since ${since}` : 'Plus is active';
}

/** A revoked licence kept aside, cleaned; null when absent or malformed. */
function heldFrom(value) {
  const token = String(value?.token || '').trim();
  if (!value || typeof value !== 'object' || token.length > TOKEN_MAX || !TOKEN_RE.test(token)) return null;
  const code = normalizeGiftCode(value.gift?.code);
  return {
    token,
    activatedAt: typeof value.activatedAt === 'string' ? value.activatedAt.slice(0, 40) : '',
    gift: code ? { code, org: String(value.gift.org || '').slice(0, 80) } : null
  };
}

/** The licence check record of this device; never throws. */
export function readPlusCheck(storage = globalThis.localStorage) {
  let value = null;
  try { value = JSON.parse(storage?.getItem(PLUS_CHECK_KEY) || 'null'); } catch (_) { value = null; }
  const at = Number(value?.at);
  return {
    at: Number.isFinite(at) && at > 0 ? at : 0,
    revoked: Array.isArray(value?.revoked) ? value.revoked.filter(id => LICENSE_ID_RE.test(String(id))).slice(-REVOKED_MAX) : [],
    held: heldFrom(value?.held),
    notice: NOTICES.has(value?.notice) ? value.notice : ''
  };
}

/** Merges `changes` into the check record and saves it. Returns the new record. */
export function writePlusCheck(changes, storage = globalThis.localStorage) {
  const next = { ...readPlusCheck(storage), ...changes };
  try { storage?.setItem(PLUS_CHECK_KEY, JSON.stringify(next)); } catch (_) {}
  return next;
}

const licenseIdOf = token => decodePlusToken(token)?.payload.id || '';
const revokedHere = token => { const id = licenseIdOf(token); return !!id && readPlusCheck().revoked.includes(id); };

/** Where the planner keeps its settings, Plus licence included (app.js). */
export const PLANNER_SETTINGS_KEY = 'daily-planner:settings';

/**
 * The Plus licence saved in this browser's planner settings, for pages of the
 * same site that aren't the planner (the landing page shows a member its gift
 * prices, and sends the licence with a gift checkout so the server can check
 * it). '' when there is none, it is malformed, or this device found it
 * revoked. Its signature is not checked here: use verifyPlusToken().
 */
export function savedPlusToken(storage = globalThis.localStorage) {
  let raw = null;
  try { raw = JSON.parse(storage?.getItem(PLANNER_SETTINGS_KEY) || 'null'); } catch (_) { return ''; }
  const token = plusSettingsFrom(raw).plus?.token || '';
  const id = licenseIdOf(token);
  return id && !readPlusCheck(storage).revoked.includes(id) ? token : '';
}

// ---------------------------------------------------------------------------
// Device state
// ---------------------------------------------------------------------------

let publicKey = PLUS_PUBLIC_KEY;
let source = { read: () => null, write: () => {} };
let current = { license: null, token: '' };
// The token whose signature was checked in this page session. A licence
// remembered from an earlier visit is shown at once but still re-checked.
let verifiedToken = '';
const listeners = new Set();

function remember(token) {
  try { if (token) localStorage.setItem(VERIFIED_KEY, token); else localStorage.removeItem(VERIFIED_KEY); } catch (_) {}
}

function rememberedToken() {
  try { return localStorage.getItem(VERIFIED_KEY) || ''; } catch (_) { return ''; }
}

function setCurrent(next) {
  const changed = next.token !== current.token || !!next.license !== !!current.license;
  current = next;
  if (changed) listeners.forEach(listener => { try { listener(!!current.license); } catch (_) {} });
}

export const plusAvailable = () => !!publicKey;
export const hasPlus = () => !!current.license;
export const plusLicense = () => (current.license ? { ...current.license } : null);
/** The stored Plus fields ({ plus, plusGift }) of the connected settings. */
export const plusSettings = () => plusSettingsFrom(source.read());

export function onPlusChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Re-reads the stored licence and verifies it (after a sync, an import or a reset). A licence revoked here stays off. */
export async function refreshPlus() {
  const token = plusSettingsFrom(source.read()).plus?.token || '';
  if (!token || !publicKey || revokedHere(token)) { if (token && token === rememberedToken()) remember(''); setCurrent({ license: null, token: '' }); return false; }
  if (token === current.token && current.license && token === verifiedToken) return true;
  const license = await verifyPlusToken(token, publicKey);
  verifiedToken = license ? token : '';
  // The stored licence may have changed while this one was being checked.
  if ((plusSettingsFrom(source.read()).plus?.token || '') !== token) return refreshPlus();
  remember(license ? token : '');
  setCurrent(license ? { license, token } : { license: null, token: '' });
  return !!license;
}

/**
 * app.js hands over its settings: `read()` returns the settings object and
 * `write(fields)` merges { plus, plusGift } into it and saves. A licence this
 * device has already verified is active at once; it is checked again anyway.
 */
export function connectPlus({ read, write, key = PLUS_PUBLIC_KEY } = {}) {
  source = { read: read || (() => null), write: write || (() => {}) };
  publicKey = String(key || '');
  verifiedToken = '';
  const token = plusSettingsFrom(source.read()).plus?.token || '';
  const known = publicKey && token && token === rememberedToken() && !revokedHere(token) ? decodePlusToken(token) : null;
  current = known ? { license: known.payload, token } : { license: null, token: '' };
  return refreshPlus();
}

/** Verifies a licence, stores it in the settings and tells every listener. */
export async function activatePlusToken(token, { gift = null } = {}) {
  const clean = String(token || '').trim();
  if (!publicKey) return { ok: false, reason: 'unavailable', error: 'Daily Planner Plus isn’t available in this copy of the planner.' };
  if (!globalThis.crypto?.subtle) return { ok: false, reason: 'insecure', error: 'This browser can only check a licence on a secure (https) page.' };
  const license = await verifyPlusToken(clean, publicKey);
  if (!license) return { ok: false, reason: 'invalid', error: 'This licence couldn’t be verified. Check that it was copied in full.' };
  // Activated again by hand after it was revoked here (restored after a mistake, say): check it with the server at once.
  const { revoked, held } = readPlusCheck();
  if (revoked.includes(license.id)) writePlusCheck({ revoked: revoked.filter(id => id !== license.id), at: 0, ...(licenseIdOf(held?.token) === license.id ? { held: null } : {}) });
  verifiedToken = clean;
  const already = current.token === clean;
  const fields = { plus: { token: clean, activatedAt: already ? plusSettings().plus?.activatedAt || new Date().toISOString() : new Date().toISOString() } };
  const code = normalizeGiftCode(gift?.code);
  if (code) fields.plusGift = { code, org: String(gift.org || license.org || '').slice(0, 80) };
  else if (!already) fields.plusGift = null;
  source.write(fields);
  remember(clean);
  setCurrent({ license, token: clean });
  return { ok: true, license, already };
}

/**
 * The server says this licence was revoked (a refund or a dispute): Plus is
 * removed from this planner's settings, and this device keeps the licence id
 * as revoked so sync, a backup or another tab never turn it back on. The
 * licence itself is kept aside on this device only, so the weekly check can
 * ask about it again. Returns true when Plus was active with that licence.
 */
export function revokePlus(token = current.token) {
  const id = licenseIdOf(token);
  if (!id) return false;
  const { revoked } = readPlusCheck();
  const stored = plusSettingsFrom(source.read());
  const mine = licenseIdOf(stored.plus?.token) === id;
  const held = heldFrom({ token, activatedAt: mine ? stored.plus.activatedAt : '', gift: mine ? stored.plusGift : null });
  writePlusCheck({ revoked: [...revoked.filter(item => item !== id), id].slice(-REVOKED_MAX), held });
  if (mine) source.write({ plus: null, plusGift: null });
  if (licenseIdOf(rememberedToken()) === id) remember('');
  const active = current.license?.id === id;
  if (active) { verifiedToken = ''; setCurrent({ license: null, token: '' }); }
  return active;
}

/**
 * The server says a licence revoked here is valid again (the owner restored
 * the purchase or the gift): it leaves the revoked list and, unless another
 * licence gave Plus meanwhile, goes back into the settings, as it was. Returns
 * true when Plus is back on this planner.
 */
export async function restorePlus(token) {
  const clean = String(token || '').trim();
  const id = licenseIdOf(clean);
  if (!id) return false;
  const record = readPlusCheck();
  const held = licenseIdOf(record.held?.token) === id ? record.held : null;
  writePlusCheck({ revoked: record.revoked.filter(item => item !== id), ...(held ? { held: null } : {}) });
  if (current.license || !publicKey) return false;
  const license = await verifyPlusToken(clean, publicKey);
  if (!license || current.license) return false;
  verifiedToken = clean;
  source.write({ plus: { token: clean, activatedAt: held?.activatedAt || new Date().toISOString() }, plusGift: held?.gift || null });
  remember(clean);
  setCurrent({ license, token: clean });
  return true;
}
