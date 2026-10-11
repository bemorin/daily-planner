import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, verify as nodeVerify, createPublicKey } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { base64Decode, base64Encode, base64UrlEncode, generatePlusKeyPair, giftManageKey, importSigningKey, LICENSE_SOURCES, newLicenseId, publicKeyFromSigningKey, signLicense, verifyLicense } from '../server/licenses.js';

// The app's check, written independently of server/licenses.js: base64 SPKI
// public key, WebCrypto importKey('spki') + verify(ECDSA P-256 / SHA-256).
const fromBase64 = text => Uint8Array.from(atob(text), character => character.charCodeAt(0));
const fromBase64Url = text => fromBase64(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
async function appVerify(publicKeyBase64, token) {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'DP1') return null;
  const key = await crypto.subtle.importKey('spki', fromBase64(publicKeyBase64), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, fromBase64Url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  return ok ? JSON.parse(new TextDecoder().decode(fromBase64Url(parts[1]))) : null;
}

const KEYS = await generatePlusKeyPair();

test('a licence signed on the server verifies exactly as the app checks it', async () => {
  const token = await signLicense(KEYS.signingKey, { src: 'gift', org: 'Café Société <Paris>', iat: '2026-10-09' });
  assert.match(token, /^DP1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const [, payloadPart, signaturePart] = token.split('.');
  assert.equal(fromBase64Url(signaturePart).length, 64, 'raw P1363 r||s, not DER');
  // The payload keeps the contract's key order and UTF-8 text.
  const payloadText = new TextDecoder().decode(fromBase64Url(payloadPart));
  const payload = JSON.parse(payloadText);
  assert.deepEqual(Object.keys(payload), ['v', 'p', 'id', 'src', 'org', 'iat']);
  assert.equal(payload.v, 1);
  assert.equal(payload.p, 'plus');
  assert.match(payload.id, /^[0-9a-f]{16}$/);
  assert.equal(payload.src, 'gift');
  assert.equal(payload.org, 'Café Société <Paris>');
  assert.equal(payload.iat, '2026-10-09');
  assert.deepEqual(await appVerify(KEYS.publicKey, token), payload);
  assert.deepEqual(await verifyLicense(KEYS.publicKey, token), payload);
  // Without an org (purchase, manual, dev) the field is left out.
  for (const src of ['purchase', 'manual', 'dev']) {
    const plain = await appVerify(KEYS.publicKey, await signLicense(KEYS.signingKey, { src }));
    assert.deepEqual(Object.keys(plain), ['v', 'p', 'id', 'src', 'iat'], src);
    assert.match(plain.iat, /^\d{4}-\d{2}-\d{2}$/);
  }
  assert.deepEqual(LICENSE_SOURCES, ['gift', 'purchase', 'manual', 'dev']);
});

test('tampered, re-signed or malformed licences are refused', async () => {
  const token = await signLicense(KEYS.signingKey, { src: 'purchase', id: 'a1b2c3d4e5f60718', iat: '2026-10-09' });
  const [prefix, payload, signature] = token.split('.');
  const forgedPayload = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ v: 1, p: 'plus', id: 'a1b2c3d4e5f60718', src: 'gift', org: 'Evil', iat: '2026-10-09' })));
  const other = await generatePlusKeyPair();
  const flipped = signature.slice(0, -2) + (signature.at(-2) === 'A' ? 'B' : 'A') + signature.at(-1);
  const cases = {
    'payload swapped': `${prefix}.${forgedPayload}.${signature}`,
    'signature altered': `${prefix}.${payload}.${flipped}`,
    'other prefix': `DP2.${payload}.${signature}`,
    'missing part': `${prefix}.${payload}`,
    'extra part': `${token}.x`,
    'not base64url': `${prefix}.${payload}+.${signature}`,
    empty: ''
  };
  for (const [label, value] of Object.entries(cases)) {
    assert.equal(await verifyLicense(KEYS.publicKey, value), null, label);
  }
  assert.equal(await appVerify(KEYS.publicKey, `${prefix}.${forgedPayload}.${signature}`), null);
  assert.equal(await verifyLicense(other.publicKey, token), null, 'another key pair');
  assert.equal(await appVerify(other.publicKey, token), null);
  assert.equal(await verifyLicense('not a key', token), null);
  // A validly signed payload that is not a Plus licence is refused too.
  const key = await importSigningKey(KEYS.signingKey);
  const wrongBody = `DP1.${base64UrlEncode(new TextEncoder().encode(JSON.stringify({ v: 2, p: 'plus', id: 'a1b2c3d4e5f60718', src: 'gift', iat: '2026-10-09' })))}`;
  const wrongSignature = base64UrlEncode(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(wrongBody)));
  assert.equal(await verifyLicense(KEYS.publicKey, `${wrongBody}.${wrongSignature}`), null);
  assert.ok(await appVerify(KEYS.publicKey, `${wrongBody}.${wrongSignature}`), 'the signature itself is valid');
});

test('signing refuses bad input and unusable keys', async () => {
  await assert.rejects(signLicense(KEYS.signingKey, { src: 'stolen' }), /source/);
  await assert.rejects(signLicense(KEYS.signingKey, { src: 'gift', id: 'XYZ' }), /16 hex/);
  await assert.rejects(signLicense(KEYS.signingKey, { src: 'gift', iat: 'yesterday' }), /ISO date/);
  await assert.rejects(signLicense('', { src: 'gift' }), /PLUS_SIGNING_KEY/);
  await assert.rejects(signLicense('bm90IGEga2V5', { src: 'gift' }), /PLUS_SIGNING_KEY/);
  assert.equal(await importSigningKey(''), null);
  assert.equal(await importSigningKey('%%%'), null);
  assert.equal(await importSigningKey(KEYS.publicKey), null, 'a public key cannot sign');
  assert.equal(await publicKeyFromSigningKey('nope'), '');
  assert.match(newLicenseId(), /^[0-9a-f]{16}$/);
  assert.notEqual(newLicenseId(), newLicenseId());
});

test('keys: base64 PKCS#8 / SPKI DER, interoperable with Node and OpenSSL-made keys', async () => {
  // The SPKI DER of a P-256 key is 91 bytes; PKCS#8 from WebCrypto ~138.
  assert.equal(fromBase64(KEYS.publicKey).length, 91);
  assert.ok(fromBase64(KEYS.signingKey).length > 60);
  assert.equal(await publicKeyFromSigningKey(KEYS.signingKey), KEYS.publicKey);
  // A pasted secret may carry whitespace or line breaks.
  assert.equal(await publicKeyFromSigningKey(`  ${KEYS.signingKey.slice(0, 40)}\n${KEYS.signingKey.slice(40)}\n`), KEYS.publicKey);
  // Node's own verifier (OpenSSL) accepts the P1363 signature.
  const token = await signLicense(KEYS.signingKey, { src: 'manual' });
  const [prefix, payload, signature] = token.split('.');
  const nodeKey = createPublicKey({ key: Buffer.from(KEYS.publicKey, 'base64'), format: 'der', type: 'spki' });
  assert.equal(nodeVerify('sha256', Buffer.from(`${prefix}.${payload}`), { key: nodeKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(fromBase64Url(signature))), true);
  // A key made with Node/OpenSSL (openssl genpkey … | openssl pkcs8 -topk8 -nocrypt -outform DER | base64) works as PLUS_SIGNING_KEY.
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'pkcs8', format: 'der' }, publicKeyEncoding: { type: 'spki', format: 'der' } });
  const secret = privateKey.toString('base64');
  assert.equal(await publicKeyFromSigningKey(secret), publicKey.toString('base64'));
  assert.ok(await appVerify(publicKey.toString('base64'), await signLicense(secret, { src: 'dev' })));
  // base64 helpers round-trip.
  const bytes = crypto.getRandomValues(new Uint8Array(77));
  assert.deepEqual(base64Decode(base64Encode(bytes)), bytes);
  assert.deepEqual(base64Decode(base64UrlEncode(bytes)), bytes);
  assert.equal(base64Decode('a'), null);
  assert.equal(base64Decode('ab$c'), null);
});

test('the gift manage key is hex HMAC-SHA256 keyed with the PKCS#8 bytes of PLUS_SIGNING_KEY', async () => {
  const hmacKey = await crypto.subtle.importKey('raw', fromBase64(KEYS.signingKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = [...new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, new TextEncoder().encode('gift-manage:ABCDEFGHJKMN')))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  assert.equal(await giftManageKey(KEYS.signingKey, 'ABCDEFGHJKMN'), expected);
  assert.equal(await giftManageKey(KEYS.signingKey, 'abcd-efgh-jkmn'), expected, 'dashes and case do not matter');
  assert.notEqual(await giftManageKey(KEYS.signingKey, 'ABCDEFGHJKMP'), expected);
  assert.notEqual(await giftManageKey((await generatePlusKeyPair()).signingKey, 'ABCDEFGHJKMN'), expected);
  assert.equal(await giftManageKey('', 'ABCDEFGHJKMN'), '');
});

test('npm run plus:keys prints a working pair, and --public re-derives the public key', async () => {
  const script = fileURLToPath(new URL('../scripts/plus-keys.mjs', import.meta.url));
  const output = execFileSync(process.execPath, [script], { encoding: 'utf8' });
  const secret = /^PLUS_SIGNING_KEY=(\S+)$/m.exec(output)?.[1];
  const publicKey = /^DAILY_PLANNER_PLUS_PUBLIC_KEY=(\S+)$/m.exec(output)?.[1];
  assert.ok(secret && publicKey);
  assert.ok(await appVerify(publicKey, await signLicense(secret, { src: 'dev' })));
  const again = execFileSync(process.execPath, [script, '--public'], { encoding: 'utf8', env: { ...process.env, PLUS_SIGNING_KEY: secret } });
  assert.equal(again.trim(), `DAILY_PLANNER_PLUS_PUBLIC_KEY=${publicKey}`);
  assert.throws(() => execFileSync(process.execPath, [script, '--public'], { encoding: 'utf8', env: { ...process.env, PLUS_SIGNING_KEY: '' }, stdio: 'pipe' }));
});
