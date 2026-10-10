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
 */

export const PLUS_PRICE = 29;
export const GIFT_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
/** Visitors from these regions see the price in euros; everyone else in dollars (same number). */
export const EURO_AREA = Object.freeze(['AT', 'BE', 'BG', 'CY', 'DE', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PT', 'SI', 'SK', 'AD', 'MC', 'SM', 'VA', 'ME', 'XK']);
const SOURCES = new Set(['gift', 'purchase', 'manual', 'dev']);
const TOKEN_RE = /^DP1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;
const SESSION_RE = /^cs_(?:live|test)_[A-Za-z0-9_]+$/;
// Remembers the token this device last verified, so Plus is on from the first paint.
const VERIFIED_KEY = 'daily-planner-ui:plus-verified';

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
 * What someone pasted into "Have a gift link, code or licence?": a gift link
 * or code, a licence (or a ?license= link), or a ?purchase= link.
 */
export function parsePlusInput(input) {
  const text = String(input || '').trim();
  if (!text) return { kind: 'empty' };
  let value = text;
  if (/^https?:\/\/|[?&](?:gift|license|purchase)=/i.test(text)) {
    try {
      const params = new URL(text, 'https://planner.bemorin.com/').searchParams;
      if (params.get('gift')) return normalizeGiftCode(params.get('gift')) ? { kind: 'gift', code: normalizeGiftCode(params.get('gift')) } : { kind: 'invalid' };
      if (params.get('purchase')) value = params.get('purchase');
      else if (params.get('license')) value = params.get('license');
      else return { kind: 'invalid' };
    } catch (_) {
      return { kind: 'invalid' };
    }
  }
  value = value.trim();
  if (TOKEN_RE.test(value)) return { kind: 'license', token: value };
  if (SESSION_RE.test(value)) return { kind: 'purchase', session: value };
  const code = normalizeGiftCode(value);
  return code ? { kind: 'gift', code } : { kind: 'invalid' };
}

export const isCheckoutSession = value => SESSION_RE.test(String(value || ''));

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
  if (license.src === 'gift' && org) return `Plus is active · from ${org}`;
  if (license.src === 'purchase' && date(license.iat)) return `Plus is active · purchased on ${date(license.iat)}`;
  const since = date(activatedAt) || date(license.iat);
  return since ? `Plus is active · since ${since}` : 'Plus is active';
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

/** Re-reads the stored licence and verifies it (after a sync, an import or a reset). */
export async function refreshPlus() {
  const token = plusSettingsFrom(source.read()).plus?.token || '';
  if (!token || !publicKey) { setCurrent({ license: null, token: '' }); return false; }
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
  const known = publicKey && token && token === rememberedToken() ? decodePlusToken(token) : null;
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
