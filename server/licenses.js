// Daily Planner Plus licences, signed with ECDSA P-256. Only WebCrypto
// (globalThis.crypto.subtle) is used, so the same code runs on Cloudflare
// Pages Functions and on Node 20 or newer.
//
// Token     DP1.<payload>.<signature>
//   payload   base64url(UTF-8 JSON { v: 1, p: 'plus', id, src, gift?, org?, iat })
//   signature base64url of the raw 64-byte (IEEE P1363 r||s) ECDSA P-256 /
//             SHA-256 signature over the ASCII bytes of "DP1.<payload>"
// Keys      PLUS_SIGNING_KEY (server secret) = base64 of the PKCS#8 DER private key
//           DAILY_PLANNER_PLUS_PUBLIC_KEY (app build) = base64 of the SPKI DER public key
// The app verifies with importKey('spki', …, { name: 'ECDSA', namedCurve: 'P-256' })
// and verify({ name: 'ECDSA', hash: 'SHA-256' }). Nothing about the person is
// in a licence: a random id, where it came from, a company name for gifts and
// the day it was made. A licence activated from a gift (since 1.24) also
// carries `gift`, the gift ref: it names the gift without revealing its code,
// so refunding the gift revokes every licence activated from it without the
// server keeping anything per activation.
//
// Gift manage key: hex HMAC-SHA256(key = the PKCS#8 DER bytes of
// PLUS_SIGNING_KEY, message = 'gift-manage:' + CODE without dashes).
// Gift ref: the first 16 hex characters of the same HMAC over 'gift-ref:' + CODE.
// Both are deterministic and never stored; rotating PLUS_SIGNING_KEY changes
// every manage link and gift ref (and every licence signed afterwards).

export const LICENSE_PREFIX = 'DP1';
export const LICENSE_SOURCES = Object.freeze(['gift', 'purchase', 'manual', 'dev']);
export const LICENSE_ID_RE = /^[0-9a-f]{16}$/;
export const GIFT_REF_RE = /^[0-9a-f]{16}$/;
export const LICENSE_TOKEN_MAX = 2048;

const ALGORITHM = Object.freeze({ name: 'ECDSA', namedCurve: 'P-256' });
const SIGNATURE = Object.freeze({ name: 'ECDSA', hash: 'SHA-256' });
const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z)?$/;
const encoder = new TextEncoder();

const subtle = () => {
  const api = globalThis.crypto?.subtle;
  if (!api) throw new Error('WebCrypto (crypto.subtle) is not available.');
  return api;
};

const toHex = bytes => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');

/** Standard base64 (with padding) of bytes. */
export function base64Encode(bytes) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** base64url without padding. */
export const base64UrlEncode = bytes => base64Encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * Decode standard or URL-safe base64; whitespace and missing padding are
 * tolerated (a pasted secret may carry a line break). Returns null when invalid.
 */
export function base64Decode(text) {
  const clean = String(text ?? '').replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (!clean || /[^A-Za-z0-9+/]/.test(clean) || clean.length % 4 === 1) return null;
  try {
    const binary = atob(clean + '='.repeat((4 - (clean.length % 4)) % 4));
    return Uint8Array.from(binary, character => character.charCodeAt(0));
  } catch {
    return null;
  }
}

/** A new random licence id: 16 hex characters. */
export const newLicenseId = () => toHex(crypto.getRandomValues(new Uint8Array(8)));

const signingKeys = new Map();

/**
 * Import PLUS_SIGNING_KEY (base64 PKCS#8 DER, P-256) for signing. Resolves with
 * null when it is blank or not a usable key. Cached per value.
 */
export function importSigningKey(secret) {
  const text = String(secret ?? '').trim();
  if (!text) return Promise.resolve(null);
  if (!signingKeys.has(text)) {
    if (signingKeys.size > 8) signingKeys.clear();
    const bytes = base64Decode(text);
    signingKeys.set(text, bytes ? Promise.resolve().then(() => subtle().importKey('pkcs8', bytes, ALGORITHM, false, ['sign'])).catch(() => null) : Promise.resolve(null));
  }
  return signingKeys.get(text);
}

/** Import a base64 SPKI public key for verifying, exactly as the app does. Null when invalid. */
export async function importVerifyKey(publicKey) {
  const bytes = base64Decode(publicKey);
  if (!bytes) return null;
  try { return await subtle().importKey('spki', bytes, ALGORITHM, false, ['verify']); } catch { return null; }
}

/** A new key pair: { signingKey: base64 PKCS#8 (secret), publicKey: base64 SPKI }. */
export async function generatePlusKeyPair() {
  const pair = await subtle().generateKey(ALGORITHM, true, ['sign', 'verify']);
  const [pkcs8, spki] = await Promise.all([subtle().exportKey('pkcs8', pair.privateKey), subtle().exportKey('spki', pair.publicKey)]);
  return { signingKey: base64Encode(pkcs8), publicKey: base64Encode(spki) };
}

/** The base64 SPKI public key that matches PLUS_SIGNING_KEY, or '' when the secret is not a usable key. */
export async function publicKeyFromSigningKey(secret) {
  const bytes = base64Decode(String(secret ?? '').trim());
  if (!bytes) return '';
  try {
    const privateKey = await subtle().importKey('pkcs8', bytes, ALGORITHM, true, ['sign']);
    const { kty, crv, x, y } = await subtle().exportKey('jwk', privateKey);
    const publicKey = await subtle().importKey('jwk', { kty, crv, x, y, ext: true }, ALGORITHM, true, ['verify']);
    return base64Encode(await subtle().exportKey('spki', publicKey));
  } catch {
    return '';
  }
}

/** Today as an ISO date (YYYY-MM-DD, UTC). */
export const isoDay = (date = new Date()) => date.toISOString().slice(0, 10);

/**
 * Sign a Plus licence. `signingKey` is a CryptoKey from importSigningKey() or
 * the base64 secret itself. `gift` is the gift ref of the gift it came from.
 * @param {{ src: 'gift'|'purchase'|'manual'|'dev', id?: string, gift?: string, org?: string, iat?: string }} claims
 */
export async function signLicense(signingKey, { src, id = newLicenseId(), gift = '', org = '', iat = isoDay() } = {}) {
  const key = typeof signingKey === 'string' ? await importSigningKey(signingKey) : signingKey;
  if (!key) throw new Error('PLUS_SIGNING_KEY is not a usable P-256 key.');
  if (!LICENSE_SOURCES.includes(src)) throw new Error(`Unknown licence source: ${src}`);
  if (!LICENSE_ID_RE.test(String(id))) throw new Error('A licence id is 16 hex characters.');
  if (gift && !GIFT_REF_RE.test(String(gift))) throw new Error('A gift ref is 16 hex characters.');
  if (!ISO_DAY_RE.test(String(iat))) throw new Error('A licence date is an ISO date.');
  const payload = { v: 1, p: 'plus', id, src, ...(gift ? { gift: String(gift) } : {}), ...(org ? { org: String(org) } : {}), iat };
  const signed = `${LICENSE_PREFIX}.${base64UrlEncode(encoder.encode(JSON.stringify(payload)))}`;
  const signature = await subtle().sign(SIGNATURE, key, encoder.encode(signed));
  return `${signed}.${base64UrlEncode(signature)}`;
}

/**
 * Verify a licence token with the base64 SPKI public key (or an imported
 * CryptoKey). Resolves with the payload, or null when anything is wrong.
 */
export async function verifyLicense(publicKey, token) {
  const text = String(token ?? '').trim();
  if (!text || text.length > LICENSE_TOKEN_MAX) return null;
  const parts = text.split('.');
  if (parts.length !== 3 || parts[0] !== LICENSE_PREFIX || !/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]+$/.test(parts[2])) return null;
  const key = typeof publicKey === 'string' ? await importVerifyKey(publicKey) : publicKey;
  const signature = base64Decode(parts[2]);
  if (!key || signature?.length !== 64) return null;
  let valid = false;
  try { valid = await subtle().verify(SIGNATURE, key, signature, encoder.encode(`${parts[0]}.${parts[1]}`)); } catch { return null; }
  if (!valid) return null;
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(base64Decode(parts[1]))); } catch { return null; }
  const ok = payload?.v === 1 && payload.p === 'plus' && LICENSE_ID_RE.test(String(payload.id)) && LICENSE_SOURCES.includes(payload.src) && typeof payload.iat === 'string';
  return ok ? payload : null;
}

const hmacKeys = new Map();
const plainCode = code => String(code ?? '').replace(/-/g, '').toUpperCase();

/** Hex HMAC-SHA256 of `message`, keyed with the PKCS#8 bytes of PLUS_SIGNING_KEY; '' without a key. */
async function signingKeyHmac(secret, message) {
  const text = String(secret ?? '').trim();
  const bytes = base64Decode(text);
  if (!bytes) return '';
  if (!hmacKeys.has(text)) {
    if (hmacKeys.size > 8) hmacKeys.clear();
    hmacKeys.set(text, subtle().importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']));
  }
  const key = await hmacKeys.get(text);
  return toHex(await subtle().sign('HMAC', key, encoder.encode(message)));
}

/** The manage key of a gift: hex HMAC-SHA256(PKCS#8 bytes of PLUS_SIGNING_KEY, 'gift-manage:' + code). '' without a key. */
export const giftManageKey = (secret, code) => signingKeyHmac(secret, `gift-manage:${plainCode(code)}`);

/** The gift ref licences from a gift carry: 16 hex characters of HMAC(…, 'gift-ref:' + code). '' without a key. */
export const giftRef = async (secret, code) => (await signingKeyHmac(secret, `gift-ref:${plainCode(code)}`)).slice(0, 16);
