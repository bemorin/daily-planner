// Creem checkouts for Daily Planner Plus and gift links. Creem is the
// merchant of record: it takes the payment, charges VAT and sends the receipt.
//
// The owner creates four one-time, tax-inclusive products in Creem (Plus EUR,
// Plus USD, Gift EUR, Gift USD). The API opens every checkout itself with the
// amount from src/lib/pricing.js: Plus uses the product price, a gift (a team
// tier or a personal gift) sends custom_price for its plan. A checkout is then
// trusted only once it is read back from Creem (claims) or arrives in a signed
// webhook.
//
// API     POST /v1/checkouts, GET /v1/checkouts?checkout_id=…,
//         GET /v1/transactions?transaction_id=… (a refund names only its transaction,
//         whose `order` leads back to the checkout), header x-api-key
//         https://api.creem.io (live) or https://test-api.creem.io (test)
//         A partner's code goes in `affiliate_code` (Creem's affiliate program,
//         which pays 25% of Plus and personal gifts); Creem refuses an unknown
//         code with HTTP 400. A team gift never carries `affiliate_code` (since
//         1.28; 1.27 sent it for every item): its 10% is paid by the owner, not
//         by Creem, and its metadata says so (`payout: 'owner'`, sealed), so a
//         team sale opened by 1.27 — credited by Creem — is never paid twice.
//         The code goes in the metadata (`ref`) and in the seal for every item,
//         so the sale can be listed by partner once it is paid — only when our
//         API opened the checkout.
//         (Creem's order has an `affiliate` field, but its docs don't say whether
//         it holds the code or an id, so the sealed `ref` is what is listed.)
//         The order's `tax_amount` is read so commissions are worked out on the
//         price before tax.
//         A gift at the member price (the buyer has Plus) carries `member: '1'`.
// Webhook header creem-signature = hex HMAC-SHA256(raw body, CREEM_WEBHOOK_SECRET)
// Env     CREEM_API_KEY, CREEM_WEBHOOK_SECRET, CREEM_PLUS_EUR, CREEM_PLUS_USD,
//         CREEM_GIFT_EUR, CREEM_GIFT_USD, CREEM_TEST_MODE ('1'; a creem_test_ key also means test)
// `fetch` is injectable so tests never reach the network.

import { timingSafeEqual } from './admin-auth.js';
import { CURRENCIES, giftPlan, isPersonalGift } from '../src/lib/pricing.js';

export const CREEM_API_URL = 'https://api.creem.io';
export const CREEM_TEST_API_URL = 'https://test-api.creem.io';
export const CREEM_TIMEOUT_MS = 10000;
export const CREEM_ITEMS = Object.freeze(['plus', 'gift']);
/** Checkout references: Creem ids (ch_…), older references kept in the database, dev fakes. */
export const CHECKOUT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{5,199}$/;
/** Creem ids of orders, transactions, refunds and disputes (ord_…, tran_…, ref_…, disp_…). */
export const CREEM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,199}$/;
const PRODUCT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;
const SIGNATURE_RE = /^[0-9a-f]{64}$/;
/** A partner code from a ?ref= link (the planner and the landing page keep the same rule). */
export const AFFILIATE_CODE_RE = /^[A-Za-z0-9_-]{2,64}$/;
const ENV_NAMES = Object.freeze({ plus: { EUR: 'CREEM_PLUS_EUR', USD: 'CREEM_PLUS_USD' }, gift: { EUR: 'CREEM_GIFT_EUR', USD: 'CREEM_GIFT_USD' } });
const encoder = new TextEncoder();

/** The product ids from an environment object: { plus: { EUR, USD }, gift: { EUR, USD } }. */
export function creemProductsFromEnv(env = {}) {
  const pick = name => String(env?.[name] ?? '').trim();
  return Object.fromEntries(CREEM_ITEMS.map(item => [item, Object.fromEntries(CURRENCIES.map(currency => [currency, pick(ENV_NAMES[item][currency])]))]));
}

/**
 * Check the four product ids. Returns { ids: { plus: { EUR, USD }, gift: { EUR, USD } },
 * byId: Map<productId, { kind, currency }>, error }: unusable or repeated ids are
 * left out and named in `error`.
 */
export function parseCreemProducts(products = {}) {
  const ids = {};
  const byId = new Map();
  const problems = [];
  for (const item of CREEM_ITEMS) {
    ids[item] = {};
    for (const currency of CURRENCIES) {
      const id = String(products?.[item]?.[currency] ?? '').trim();
      ids[item][currency] = '';
      if (!id) continue;
      if (!PRODUCT_ID_RE.test(id)) problems.push(`${ENV_NAMES[item][currency]} is not a product id (prod_…)`);
      else if (byId.has(id)) problems.push(`${ENV_NAMES[item][currency]} repeats another product id`);
      else {
        ids[item][currency] = id;
        byId.set(id, { kind: item, currency });
      }
    }
  }
  return { ids, byId, error: problems.length ? `${problems.join('; ')}.` : '' };
}

/** 'test', 'live', or '' without a key. CREEM_TEST_MODE=1 or a creem_test_ key means test. */
export function creemMode(apiKey, testMode = '') {
  const key = String(apiKey ?? '').trim();
  if (!key) return '';
  return /^(?:1|true|yes|on)$/i.test(String(testMode ?? '').trim()) || key.startsWith('creem_test_') ? 'test' : 'live';
}

export const creemApiBase = mode => (mode === 'test' ? CREEM_TEST_API_URL : CREEM_API_URL);

/** The partner code sent with a checkout, trimmed, or '' when it is missing or malformed. */
export function affiliateCode(value) {
  const code = typeof value === 'string' ? value.trim() : '';
  return AFFILIATE_CODE_RE.test(code) ? code : '';
}

async function describeFailure(response) {
  const body = await response.json().catch(() => null);
  const message = Array.isArray(body?.message) ? body.message.join(', ') : body?.message ?? body?.error ?? '';
  const detail = typeof message === 'string' && message ? `: ${message.slice(0, 200)}` : '';
  return `Creem answered HTTP ${response.status}${detail}`;
}

async function creemRequest({ fetch: fetchImpl, url, init, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Creem did not answer in time');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST /v1/checkouts. Resolves with the CheckoutEntity ({ id, checkout_url, … });
 * rejects on any failure (an HTTP failure carries Creem's `status`).
 */
export async function createCheckout({ apiKey, mode = 'live', body, fetch: fetchImpl, timeoutMs = CREEM_TIMEOUT_MS }) {
  const response = await creemRequest({
    fetch: fetchImpl,
    url: `${creemApiBase(mode)}/v1/checkouts`,
    init: { method: 'POST', headers: { 'x-api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) },
    timeoutMs
  });
  if (!response.ok) {
    const failure = new Error(await describeFailure(response));
    failure.status = response.status;
    throw failure;
  }
  const checkout = await response.json().catch(() => null);
  if (!checkout || typeof checkout !== 'object') throw new Error('Creem answered without a checkout');
  return checkout;
}

/**
 * GET /v1/checkouts?checkout_id=…. Resolves with the CheckoutEntity, or null when
 * Creem does not know the id (404, or 400 for an id it cannot read); rejects otherwise.
 */
export async function fetchCheckout({ apiKey, mode = 'live', checkoutId, fetch: fetchImpl, timeoutMs = CREEM_TIMEOUT_MS }) {
  const response = await creemRequest({
    fetch: fetchImpl,
    url: `${creemApiBase(mode)}/v1/checkouts?checkout_id=${encodeURIComponent(checkoutId)}`,
    init: { method: 'GET', headers: { 'x-api-key': apiKey, accept: 'application/json' } },
    timeoutMs
  });
  if (response.status === 404 || response.status === 400) return null;
  if (!response.ok) throw new Error(await describeFailure(response));
  const checkout = await response.json().catch(() => null);
  return checkout && typeof checkout === 'object' ? checkout : null;
}

/**
 * GET /v1/transactions?transaction_id=…. Resolves with the transaction entity
 * ({ id, order, status, amount_paid, refunded_amount, … }), or null when Creem
 * does not know the id (404, or 400 for an id it cannot read); rejects otherwise.
 */
export async function fetchTransaction({ apiKey, mode = 'live', transactionId, fetch: fetchImpl, timeoutMs = CREEM_TIMEOUT_MS }) {
  const response = await creemRequest({
    fetch: fetchImpl,
    url: `${creemApiBase(mode)}/v1/transactions?transaction_id=${encodeURIComponent(transactionId)}`,
    init: { method: 'GET', headers: { 'x-api-key': apiKey, accept: 'application/json' } },
    timeoutMs
  });
  if (response.status === 404 || response.status === 400) return null;
  if (!response.ok) throw new Error(await describeFailure(response));
  const transaction = await response.json().catch(() => null);
  return transaction && typeof transaction === 'object' && !Array.isArray(transaction) ? transaction : null;
}

const objectOrNull = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : null);
const wholeCents = value => (Number.isInteger(value) && value >= 0 ? value : null);
/** A Creem id given as a string or as an expanded object; '' when missing or malformed. */
/** Creem's `mode` of a checkout or a transaction ('test', 'live', 'prod', 'sandbox'…), lower case; '' when absent or odd. */
export const creemModeOf = value => { const mode = String(value ?? '').trim().toLowerCase(); return /^[a-z][a-z_-]{0,19}$/.test(mode) ? mode : ''; };

export const creemIdOf = value => {
  const id = String((typeof value === 'string' ? value : objectOrNull(value)?.id) ?? '').trim();
  return CREEM_ID_RE.test(id) ? id : '';
};

/**
 * What a checkout bought, read defensively (ids or expanded objects).
 * Returns { completed, paid, productId, item, email, country, org, amount, tax, currency, …, orderId }
 * (`amount` is what was paid in cents, `tax` the tax included in it, null when Creem doesn't say):
 * `item` is { kind: 'plus', plan: '', seats: 1 } or { kind: 'gift', plan, seats } with
 * seats from the plan (a team tier or a personal gift, never from the metadata alone),
 * or null when the product is not one of `products` (Map from parseCreemProducts) or
 * its metadata does not match it. `org` is the name typed on the checkout: the
 * company (`company`) for a team gift, the giver (`from`) for a personal gift.
 * `orderId` is Creem's order (kept so a later refund can be traced back), '' when absent.
 * `ref` is the partner code from the metadata ('' when none or malformed),
 * `payout` 'owner' when the owner pays that partner's commission (a team gift
 * opened without `affiliate_code`, 1.28 and later; '' otherwise: Creem credits
 * the partner) and `member` whether a gift was sold at the member price: all
 * three are in the seal, and count for nothing without it (see sealedCheckout
 * in server/planner-api.js).
 */
/** The member flag of a checkout's metadata: we send '1'; 1, true or 'true' read the same. */
export const memberFlag = value => /^(?:1|true)$/i.test(String(value ?? '').trim());

export function readCheckout(checkout, products = new Map()) {
  const entity = objectOrNull(checkout) || {};
  const order = objectOrNull(entity.order);
  const customer = objectOrNull(entity.customer);
  const metadata = objectOrNull(entity.metadata) || {};
  const productId = String((typeof entity.product === 'string' ? entity.product : objectOrNull(entity.product)?.id) ?? '').trim();
  const completed = entity.status === 'completed';
  // Only an expanded order marked paid counts: a missing order, an order id or any other status does not.
  const paid = completed && order?.status === 'paid';
  const product = productId ? products.get(productId) : null;
  let item = null;
  if (product && (!metadata.kind || metadata.kind === product.kind)) {
    if (product.kind === 'plus') item = { kind: 'plus', plan: '', seats: 1 };
    else {
      const plan = giftPlan(String(metadata.plan ?? ''));
      if (plan) item = { kind: 'gift', plan: plan.plan, seats: plan.seats };
    }
  }
  const fields = Array.isArray(entity.custom_fields) ? entity.custom_fields : [];
  const answer = key => {
    const field = fields.find(entry => entry?.key === key);
    return String(field?.text?.value ?? field?.value ?? '').trim();
  };
  const keys = isPersonalGift(item?.plan) ? ['from', 'company'] : ['company', 'from'];
  const org = keys.map(answer).find(Boolean) || '';
  const email = String(customer?.email ?? entity.customer_email ?? '').trim().toLowerCase();
  const country = /^[A-Za-z]{2}$/.test(String(customer?.country ?? '')) ? String(customer.country).toUpperCase() : '';
  const amount = wholeCents(order?.amount_paid) ?? wholeCents(order?.amount);
  // The tax included in the amount paid (VAT or sales tax, set by Creem from the buyer's country), when Creem gives it.
  const tax = wholeCents(order?.tax_amount);
  const currency = String(order?.currency ?? objectOrNull(entity.product)?.currency ?? product?.currency ?? '').toUpperCase();
  return {
    completed, paid, productId, item, email, country, org, amount, tax: tax != null && amount != null && tax <= amount ? tax : null,
    currency: CURRENCIES.includes(currency) ? currency : '',
    productCurrency: product?.currency || '',
    requestId: String(entity.request_id ?? ''),
    seal: { rid: String(metadata.rid ?? ''), currency: String(metadata.currency ?? ''), value: String(metadata.seal ?? '') },
    orderId: creemIdOf(entity.order),
    mode: creemModeOf(entity.mode),
    // The partner whose link the sale came through ('' when none), and whether a gift was sold at the member price.
    // Both are only claims until checkoutSealValid() says our API sealed them. The flag is read leniently
    // ('1', 1, true or 'true'), in case Creem gives back metadata typed differently from what was sent.
    ref: affiliateCode(metadata.ref),
    payout: String(metadata.payout ?? '').trim().toLowerCase() === 'owner' ? 'owner' : '',
    member: memberFlag(metadata.member)
  };
}

/**
 * The seal our API puts in a checkout's metadata (Plus and gifts): an HMAC
 * (with the Plus signing secret) of what it sells. Creem's product links let
 * anyone add metadata, so a gift is honoured only with a valid seal — a link
 * opened by hand cannot claim a bigger pack than it paid for — and a partner
 * code or the member price count only when sealed. A gift at the member price
 * seals that (`|member`), a partner's code seals itself (`|ref:CODE`), and so
 * does who pays its commission when it isn't Creem (`|payout:owner`), so none
 * of them can be added or taken off afterwards; a seal with none is unchanged.
 */
export async function checkoutSeal(secret, { kind, plan = '', currency, rid, member = false, ref = '', payout = '' }) {
  return (await webhookSignature(`checkout-seal:${kind}|${plan}|${currency}|${rid}${member ? '|member' : ''}${ref ? `|ref:${ref}` : ''}${payout ? `|payout:${payout}` : ''}`, secret)).slice(0, 32);
}

/** True when `paid` (from readCheckout) carries a valid seal for its item, the product's currency, its member flag, its partner code and who pays it. */
export async function checkoutSealValid(secret, paid) {
  const { rid, currency, value } = paid?.seal || {};
  if (!secret || !paid?.item || !rid || !/^[0-9a-f]{32}$/.test(value) || currency !== paid.productCurrency) return false;
  // The seal belongs to the checkout our API opened: when Creem reports the request id, it must be the sealed one.
  if (paid.requestId && paid.requestId !== rid) return false;
  return timingSafeEqual(await checkoutSeal(secret, { kind: paid.item.kind, plan: paid.item.plan, currency, rid, member: paid.member === true, ref: paid.ref || '', payout: paid.payout || '' }), value);
}

const hmacKeys = new Map();
const toHex = bytes => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');

/** Hex HMAC-SHA256 of the raw body (string or bytes) with the webhook secret. */
export async function webhookSignature(rawBody, secret) {
  const text = String(secret ?? '');
  if (!hmacKeys.has(text)) {
    if (hmacKeys.size > 8) hmacKeys.clear();
    hmacKeys.set(text, crypto.subtle.importKey('raw', encoder.encode(text), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']));
  }
  const bytes = typeof rawBody === 'string' ? encoder.encode(rawBody) : rawBody;
  return toHex(await crypto.subtle.sign('HMAC', await hmacKeys.get(text), bytes));
}

/** Constant-time check of the creem-signature header. False without a secret or a well-formed signature. */
export async function verifyWebhookSignature(rawBody, signature, secret) {
  const given = String(signature ?? '').trim().toLowerCase();
  if (!String(secret ?? '').trim() || !SIGNATURE_RE.test(given)) return false;
  return timingSafeEqual(await webhookSignature(rawBody, String(secret).trim()), given);
}
