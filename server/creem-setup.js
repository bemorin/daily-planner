// Creem setup assistant (1.31): creates the four products and the webhook the
// API needs, from the prices in src/lib/pricing.js. The owner sees the plan
// first (what exists, what differs, what would be created); "Create" makes
// only what is missing and never edits or deletes anything in Creem.
//
// Creem's API (docs.creem.io/api-reference, header x-api-key, base
// https://api.creem.io or https://test-api.creem.io, see creemApiBase):
//   GET  /v1/products/{id}                          ProductEntity; 404 when this key's store doesn't have it
//   GET  /v1/products/search?page_number&page_size  { items: ProductEntity[], pagination: { total_pages, … } }
//   POST /v1/products                               { name, description, price (cents), currency, billing_type,
//                                                   tax_mode, tax_category }; header Idempotency-Key (a retry
//                                                   answers the product it already made)
//   GET  /v1/webhooks?page_number&page_size         { items: WebhookEntity[], pagination } (no secret in it)
//   POST /v1/webhooks                               { url (https), name, events, delivery_mode } → WebhookEntity
//                                                   whose `secret` is returned on create only
//   GET  /v1/webhooks/{id}/secret                   { secret }: only compared with CREEM_WEBHOOK_SECRET here
// Webhook calls need a key with the webhooks:read / webhooks:write scopes.
//
// Products have no metadata in Creem's API, so each product made here carries
// a marker in its description (`Ref. dp-setup:plus-eur`) — the most robust
// field there is: Creem keeps it as written and the dashboard shows it. A
// product is the assistant's when its description has the marker; one made by
// hand counts when its exact name, currency and one-time billing match. A
// webhook is identified by its URL (two endpoints on one URL would deliver
// every event twice) and named "Daily Planner · dp-setup".
//
// Idempotent: Create plans again first (a fresh read of the store) and makes
// only what is still missing. What is guaranteed when two Creates overlap: in
// one worker isolate they are serialised (the second is refused, see
// server/admin-limits.js); across isolates each product request carries an
// Idempotency-Key derived from the mode and the product's marker (with its
// price, the UTC day and the count of earlier copies), so two workers that read
// the same store send the same key and Creem answers the same product; the
// webhook list is read again right before the webhook is created, which
// narrows (but can't close) the window for a second endpoint — the plan then
// shows the extra one. Product ids are not secrets; the webhook's signing
// secret goes to the owner's browser once, in the Create answer, and is never
// logged or stored. The API key and the signing secrets never appear anywhere
// else in an answer, nor any part of them (server/secret-scrub.js: Creem's
// words are dropped after a 401 or a 403, scrubbed otherwise). Every call has
// a short timeout; reads have no side effect. `fetch` is injectable so tests
// never reach the network.

import { timingSafeEqual } from './admin-auth.js';
import { ADMIN_LIMITS, sharedAdminLimits, waitWords } from './admin-limits.js';
import { CREEM_ITEMS, creemApiBase } from './creem.js';
import { scrubAnswer, upstreamText } from './secret-scrub.js';
import { CURRENCIES, formatMoney, PLUS_PRICE, TEAM_TIERS } from '../src/lib/pricing.js';

export const SETUP_TIMEOUT_MS = 5000;
export const SETUP_PAGE_SIZE = 50;
/** Pages read at most per list (SETUP_PAGE_SIZE each); a bigger store is not set up automatically. */
export const SETUP_MAX_PAGES = 10;
export const WEBHOOK_EVENTS = Object.freeze(['checkout.completed', 'refund.created', 'dispute.created']);
export const PRODUCT_NAMES = Object.freeze({ plus: 'Daily Planner Plus', gift: 'Daily Planner Plus gift' });
// What buyers may read on Creem's page; the marker follows it.
const PRODUCT_TEXT = Object.freeze({
  plus: 'Daily Planner Plus for one person, paid once.',
  gift: 'A gift of Daily Planner Plus: for one person, a household or a team.'
});
/** Prices in src/lib/pricing.js include any tax. */
export const TAX_MODE = 'inclusive';
/** Owner decision: Creem offers saas, digital-goods-service and ebooks; Plus is web software. Only used when creating. */
export const TAX_CATEGORY = 'saas';
export const WEBHOOK_NAME = 'Daily Planner · dp-setup';
const MARKER_RE = /\bdp-setup:(plus|gift)-(eur|usd)\b/i;
const PRODUCT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0']);
const SETUP_ROUTE_RE = /^admin\/creem\/setup\/(plan|apply)$/;

/** The four products: { slot: 'plus-eur', item, currency, env: 'CREEM_PLUS_EUR' }. */
export const SETUP_SLOTS = Object.freeze(CREEM_ITEMS.flatMap(item => CURRENCIES.map(currency => Object.freeze({
  slot: `${item}-${currency.toLowerCase()}`, item, currency, env: `CREEM_${item.toUpperCase()}_${currency}`
}))));
const ITEM_LABELS = { plus: 'Plus', gift: 'Gift' };

export const productMarker = slot => `dp-setup:${slot}`;
/** The slot a description's marker names ('plus-eur'), or ''. */
export function markerOf(text) {
  const match = MARKER_RE.exec(String(text ?? ''));
  return match ? `${match[1].toLowerCase()}-${match[2].toLowerCase()}` : '';
}

/**
 * What the product of a slot should be. Plus costs PLUS_PRICE; the gift
 * product's own price is never charged by the site (each gift checkout sends
 * its price), so it is the smallest team pack, as the setup guide says.
 */
export function expectedProduct(item, currency) {
  const units = item === 'plus' ? PLUS_PRICE[currency] : TEAM_TIERS[0].price[currency];
  const slot = `${item}-${currency.toLowerCase()}`;
  return {
    name: PRODUCT_NAMES[item],
    description: `${PRODUCT_TEXT[item]} Ref. ${productMarker(slot)}`,
    price: Math.round(units * 100),
    currency,
    billing_type: 'onetime',
    tax_mode: TAX_MODE,
    tax_category: TAX_CATEGORY
  };
}

/** A failure the owner can act on. `reason`: no-key, key, timeout, network, refused, creem, answer, busy. */
export class CreemSetupError extends Error {
  constructor(reason, message, status = 0) {
    super(message);
    this.name = 'CreemSetupError';
    this.reason = reason;
    this.status = status;
  }
}

const objectOrNull = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : null);
const text = (value, max = 200) => String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
const lower = value => text(value, 40).toLowerCase();
const cents = value => (Number.isFinite(value) ? Math.round(value) : null);
const moneyLabel = (amount, currency) => (amount == null ? 'no price' : CURRENCIES.includes(currency) ? formatMoney(amount / 100, currency) : `${(amount / 100).toFixed(2)} ${currency || ''}`.trim());
const urlKey = value => {
  try {
    const url = new URL(String(value ?? '').trim());
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch { return ''; }
};

function creemMessage(data) {
  const message = Array.isArray(data?.message) ? data.message.join(', ') : data?.message ?? data?.error ?? '';
  return typeof message === 'string' ? message : '';
}

/** A failed HTTP answer from Creem as a CreemSetupError. Creem's own words only when they can't hold the key (server/secret-scrub.js). */
function failure(ctx, status, data, what) {
  if (status === 401 || status === 403) {
    const hint = ctx.mode === 'test'
      ? 'A test key starts with creem_test_ and works only with Creem’s test API; a live key needs CREEM_TEST_MODE unset.'
      : 'Check that it is the live key from Creem → Developers → API keys (a test key starts with creem_test_).';
    return new CreemSetupError('key', `Creem refused CREEM_API_KEY while ${what} (HTTP ${status}). ${hint}`, status);
  }
  const detail = upstreamText(status, creemMessage(data), ctx.secrets);
  const suffix = detail ? `: ${detail}` : '';
  if (status === 429) return new CreemSetupError('busy', `Creem is limiting requests (HTTP 429) while ${what}. Wait a minute, then try again.`, status);
  if (status >= 500) return new CreemSetupError('creem', `Creem had a problem while ${what} (HTTP ${status}${suffix}). Try again in a few minutes.`, status);
  return new CreemSetupError('refused', `Creem refused ${what} (HTTP ${status}${suffix}).`, status);
}

const timeoutError = ctx => {
  const seconds = Math.max(1, Math.round(ctx.timeoutMs / 1000));
  return new CreemSetupError('timeout', `Creem didn’t answer within ${seconds} ${seconds === 1 ? 'second' : 'seconds'}. Try again.`);
};

async function creemCall(ctx, method, path, { body, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ctx.timeoutMs);
  try {
    const response = await ctx.fetch(`${creemApiBase(ctx.mode)}${path}`, {
      method,
      headers: { 'x-api-key': ctx.apiKey, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal
    });
    // The body is read under the same timeout: a body cut off by it is a timeout, not an odd answer.
    const data = await response.json().catch(() => null);
    if (data === null && controller.signal.aborted) throw timeoutError(ctx);
    return { status: response.status, ok: response.ok, data };
  } catch (error) {
    if (error instanceof CreemSetupError) throw error;
    if (error?.name === 'AbortError' || controller.signal.aborted) throw timeoutError(ctx);
    throw new CreemSetupError('network', 'Creem couldn’t be reached. Check the connection, then try again.');
  } finally {
    clearTimeout(timer);
  }
}

/** Every item of a paginated Creem list (page 1, then the others in parallel). */
async function listAll(ctx, path, what) {
  const page = async number => {
    const answer = await creemCall(ctx, 'GET', `${path}?page_number=${number}&page_size=${SETUP_PAGE_SIZE}`);
    if (!answer.ok) throw failure(ctx, answer.status, answer.data, what);
    if (!Array.isArray(answer.data?.items)) throw new CreemSetupError('answer', `Creem answered without a list while ${what}.`);
    return answer.data;
  };
  const first = await page(1);
  const pages = Math.max(1, Math.floor(Number(first.pagination?.total_pages) || 1));
  if (pages > SETUP_MAX_PAGES) throw new CreemSetupError('answer', `Your Creem store has more than ${SETUP_MAX_PAGES * SETUP_PAGE_SIZE} entries to read while ${what}: set it up by hand (Creem → Products, Developers → Webhooks).`);
  const rest = await Promise.all(Array.from({ length: pages - 1 }, (_, index) => page(index + 2)));
  return [first, ...rest].flatMap(data => data.items);
}

/** A ProductEntity, read defensively; null without a usable id. */
export function readProduct(entity) {
  const product = objectOrNull(entity);
  const id = text(product?.id, 128);
  if (!product || !PRODUCT_ID_RE.test(id)) return null;
  return {
    id,
    name: text(product.name),
    marker: markerOf(product.description),
    price: cents(product.price),
    currency: text(product.currency, 8).toUpperCase(),
    billingType: lower(product.billing_type),
    billingPeriod: lower(product.billing_period),
    taxMode: lower(product.tax_mode),
    status: lower(product.status) || 'active',
    mode: lower(product.mode),
    createdAt: text(product.created_at, 40)
  };
}

/** A WebhookEntity without its secret; null without an id. */
export function readWebhook(entity) {
  const hook = objectOrNull(entity);
  const id = text(hook?.id, 128);
  if (!hook || !id) return null;
  return {
    id,
    name: text(hook.name),
    url: text(hook.url, 500),
    status: lower(hook.status) || 'enabled',
    deliveryMode: lower(hook.delivery_mode) || 'http',
    events: Array.isArray(hook.events) ? hook.events.map(event => text(event, 60)).filter(Boolean) : []
  };
}

const billingLabel = product => (product.billingType === 'onetime' ? 'One-time' : product.billingType === 'recurring' ? `Subscription${product.billingPeriod ? ` (${product.billingPeriod})` : ''}` : product.billingType || 'not set');
const taxLabel = mode => (mode === 'inclusive' ? 'Tax included' : mode === 'exclusive' ? 'Tax added on top' : mode || 'not set');

/**
 * How a product differs from what its slot needs. `critical` ones make it
 * unusable as it is (the site would sell at another price, currency or
 * billing); the others are for information only.
 */
export function productDifferences(product, slot, keyMode = '') {
  const expected = expectedProduct(slot.item, slot.currency);
  const out = [];
  const add = (field, label, want, actual, critical) => out.push({ field, label, expected: want, actual, critical });
  if (product.status !== 'active') add('status', 'Status', 'Active', product.status.replace(/^./, character => character.toUpperCase()), true);
  if (product.currency !== expected.currency) add('currency', 'Currency', expected.currency, product.currency || 'not set', true);
  if (product.billingType !== 'onetime') add('billing', 'Billing', 'One-time', billingLabel(product), true);
  if (product.taxMode && product.taxMode !== TAX_MODE) add('tax', 'Tax', taxLabel(TAX_MODE), taxLabel(product.taxMode), true);
  if (product.price !== expected.price) add('price', 'Price', moneyLabel(expected.price, expected.currency), moneyLabel(product.price, product.currency), slot.item === 'plus');
  if (product.marker && product.marker !== slot.slot) add('marker', 'Made for', slot.slot, product.marker, true);
  const liveProduct = product.mode === 'prod' || product.mode === 'live';
  if (keyMode && product.mode && liveProduct !== (keyMode === 'live')) add('mode', 'Mode', keyMode, liveProduct ? 'live' : product.mode, true);
  if (product.name !== expected.name) add('name', 'Name', expected.name, product.name || 'no name', false);
  return out;
}

const isUsable = differences => !differences.some(entry => entry.critical);
const byAge = (a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id);
const publicProduct = product => (product ? {
  id: product.id, name: product.name, price: product.price, priceLabel: moneyLabel(product.price, product.currency), currency: product.currency,
  billing: billingLabel(product), tax: taxLabel(product.taxMode), status: product.status, marked: !!product.marker
} : null);

/** The env value of each slot: { envId, envNote: '' | 'invalid' | 'repeated' }. */
function envSlots(products = {}) {
  const seen = new Set();
  return SETUP_SLOTS.map(slot => {
    const raw = text(products?.[slot.item]?.[slot.currency], 200);
    if (!raw) return { ...slot, envId: '', envNote: '' };
    if (!PRODUCT_ID_RE.test(raw)) return { ...slot, envId: '', envNote: 'invalid' };
    if (seen.has(raw)) return { ...slot, envId: '', envNote: 'repeated' };
    seen.add(raw);
    return { ...slot, envId: raw, envNote: '' };
  });
}

/** GET one product: { product } or { missing: status } when this key's store doesn't have it. */
async function getProduct(ctx, id) {
  const answer = await creemCall(ctx, 'GET', `/v1/products/${encodeURIComponent(id)}`);
  if ([400, 403, 404].includes(answer.status)) return { missing: answer.status };
  if (!answer.ok) throw failure(ctx, answer.status, answer.data, `reading product ${id}`);
  const product = readProduct(answer.data);
  return product ? { product } : { missing: 404 };
}

/** Decide one slot from its env product (if any) and the store's products. */
function planSlot(slot, current, catalogue, keyMode) {
  const expected = expectedProduct(slot.item, slot.currency);
  const view = {
    slot: slot.slot, item: slot.item, currency: slot.currency, env: slot.env, label: `${ITEM_LABELS[slot.item]} · ${slot.currency}`,
    expected: { name: expected.name, price: expected.price, priceLabel: moneyLabel(expected.price, slot.currency), billing: 'One-time', tax: taxLabel(TAX_MODE), priceMatters: slot.item === 'plus' },
    envId: slot.envId, envNote: slot.envNote, state: 'create', source: 'new', id: '', product: null, differences: [], duplicates: 0
  };
  const marked = catalogue.filter(product => product.marker === slot.slot).sort(byAge);
  const activeMarked = marked.filter(product => product.status === 'active');
  view.seen = marked.length;
  if (current?.product) {
    const differences = productDifferences(current.product, slot, keyMode);
    return { ...view, state: isUsable(differences) ? 'ok' : 'differs', source: 'env', id: current.product.id, product: publicProduct(current.product), differences, duplicates: activeMarked.filter(product => product.id !== current.product.id).length };
  }
  if (slot.envId) view.envNote = 'unknown';
  const usable = activeMarked.filter(product => isUsable(productDifferences(product, slot, keyMode)));
  if (usable.length) return { ...view, state: 'found', source: 'marker', id: usable[0].id, product: publicProduct(usable[0]), differences: productDifferences(usable[0], slot, keyMode), duplicates: activeMarked.length - 1 };
  // A product carrying the marker is never duplicated: the owner fixes or archives it in Creem first.
  if (activeMarked.length) return { ...view, state: 'differs', source: 'marker', id: activeMarked[0].id, product: publicProduct(activeMarked[0]), differences: productDifferences(activeMarked[0], slot, keyMode), duplicates: activeMarked.length - 1 };
  const named = catalogue
    .filter(product => !product.marker && product.status === 'active' && product.name.toLowerCase() === expected.name.toLowerCase() && product.currency === slot.currency)
    .filter(product => isUsable(productDifferences(product, slot, keyMode)))
    .sort(byAge);
  if (named.length) return { ...view, state: 'found', source: 'name', id: named[0].id, product: publicProduct(named[0]), differences: productDifferences(named[0], slot, keyMode), duplicates: named.length - 1 };
  return view;
}

/**
 * The webhook address the assistant registers for a page opened on `origin`:
 * PUBLIC_BASE_URL's (`baseUrl`) on the production address and on a local
 * server; on another address (a preview, the .pages.dev one) that address
 * itself, as the configuration check expects, but only with a test key: a live
 * store's webhook belongs to production, so Create is refused there.
 * Answers { url, source: 'production' | 'local' | 'preview', refused: '' | why }.
 */
export function setupTarget({ origin = '', baseUrl = '', mode = 'live' } = {}) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const production = { url: `${base}/api/creem/webhook`, source: 'production', refused: '' };
  let page = null;
  try { page = new URL(String(origin)); } catch { return production; }
  let baseOrigin = '';
  try { baseOrigin = new URL(base).origin; } catch { baseOrigin = ''; }
  if (page.origin === baseOrigin) return production;
  const host = page.hostname.toLowerCase();
  if (LOCAL_HOSTS.has(host) || host.endsWith('.localhost')) return { ...production, source: 'local' };
  if (mode === 'test') return { url: `${page.origin}/api/creem/webhook`, source: 'preview', refused: '' };
  return { ...production, refused: `This page is open on ${page.origin}, not on the production address ${base}: with a live key, set Creem up from ${base}/admin/configuration/.` };
}

/** Why Creem can't call this webhook URL: '' when it can (a public https address). */
export function webhookUrlProblem(value) {
  try {
    const url = new URL(String(value ?? ''));
    if (url.protocol !== 'https:') return 'https';
    const host = url.hostname.toLowerCase();
    if (LOCAL_HOSTS.has(host) || host.endsWith('.localhost') || host.endsWith('.local')) return 'local';
    return '';
  } catch { return 'invalid'; }
}

/** Decide the webhook from the store's endpoints (or why it can't be read). */
function planWebhook({ url, source = 'production', events, hooks, hooksError, secretSet }) {
  const view = { state: 'create', url, source, events: [...events], name: WEBHOOK_NAME, webhook: null, differences: [], duplicates: 0, others: [], reason: '', message: '', secret: { set: secretSet, matches: null } };
  const problem = webhookUrlProblem(url);
  if (problem) return { ...view, state: 'blocked', reason: 'url', message: `Creem calls the webhook from the internet, so it needs a public https address; ${source === 'preview' ? 'this page’s address' : 'PUBLIC_BASE_URL'} gives ${url}.` };
  if (hooksError) {
    const scope = hooksError.reason === 'key' || hooksError.status === 404;
    return {
      ...view,
      state: scope ? 'manual' : 'unknown',
      reason: scope ? 'scope' : 'unreadable',
      message: scope
        ? `This API key can’t read webhooks (HTTP ${hooksError.status}): Creem asks for the webhooks:read and webhooks:write scopes. Add the webhook by hand in Creem → Developers → Webhooks.`
        : `Creem didn’t list its webhooks: ${hooksError.message}`
    };
  }
  const key = urlKey(url);
  const same = hooks.filter(hook => urlKey(hook.url) === key && hook.deliveryMode !== 'cli');
  view.others = hooks.filter(hook => urlKey(hook.url) !== key && hook.name.includes('dp-setup')).map(hook => ({ id: hook.id, url: hook.url, status: hook.status }));
  if (!same.length) return view;
  const hook = same.find(entry => entry.status === 'enabled') || same[0];
  const differences = [];
  if (hook.status !== 'enabled') differences.push({ field: 'status', label: 'Status', expected: 'Enabled', actual: hook.status.replace(/^./, character => character.toUpperCase()), critical: true });
  // An empty list subscribes the endpoint to every event (Creem's docs).
  const missing = hook.events.length ? events.filter(event => !hook.events.includes(event)) : [];
  if (missing.length) differences.push({ field: 'events', label: 'Events', expected: events.join(', '), actual: hook.events.join(', ') || 'none', missing, critical: true });
  return { ...view, state: isUsable(differences) ? 'ok' : 'differs', webhook: hook, differences, duplicates: same.length - 1 };
}

/** Compare CREEM_WEBHOOK_SECRET with the endpoint's signing secret, on the server only: true, false or null (unknown). */
async function secretMatches(ctx, hookId) {
  try {
    const answer = await creemCall(ctx, 'GET', `/v1/webhooks/${encodeURIComponent(hookId)}/secret`);
    const secret = typeof answer.data?.secret === 'string' ? answer.data.secret.trim() : '';
    return answer.ok && secret ? timingSafeEqual(secret, ctx.webhookSecret) : null;
  } catch { return null; }
}

/**
 * Whether the .env lines need CREEM_TEST_MODE=1: only in test mode with a key
 * that isn't creem_test_… (a creem_test_ key means test mode by itself; any
 * other key is in test mode only because CREEM_TEST_MODE is on already).
 */
export const needsTestModeLine = (mode, apiKey = '') => mode === 'test' && !String(apiKey ?? '').trim().startsWith('creem_test_');

/** The .env lines for the products (ids are not secrets), and CREEM_TEST_MODE=1 when needsTestModeLine. */
export function envBlock(products, mode, apiKey = '') {
  const lines = products.filter(slot => slot.id).map(slot => `${slot.env}=${slot.id}`);
  if (needsTestModeLine(mode, apiKey)) lines.push('CREEM_TEST_MODE=1');
  return lines.length ? `${lines.join('\n')}\n` : '';
}

function summary(ctx, products, webhook) {
  const create = [...products.filter(slot => slot.state === 'create').map(slot => slot.slot), ...(webhook.state === 'create' ? ['webhook'] : [])];
  return {
    mode: ctx.mode,
    checkedAt: ctx.now().toISOString(),
    products: products.map(({ seen: _seen, ...slot }) => slot),
    webhook,
    create,
    // Why Create is refused here ('' when it isn't): a live key on a page that isn't on the production address.
    refused: ctx.refused,
    env: envBlock(products, ctx.mode, ctx.apiKey),
    testModeLine: needsTestModeLine(ctx.mode, ctx.apiKey),
    envChanges: products.filter(slot => slot.id && slot.id !== slot.envId).map(slot => slot.env),
    envComplete: products.every(slot => slot.id)
  };
}

function context(options = {}) {
  const apiKey = String(options.apiKey ?? '').trim();
  if (!apiKey) throw new CreemSetupError('no-key', 'Set the secret CREEM_API_KEY first (Creem → Developers → API keys), then redeploy.');
  if (typeof options.fetch !== 'function') throw new CreemSetupError('network', 'This server has no fetch to reach Creem.');
  const webhookSecret = String(options.webhookSecret ?? '').trim();
  return {
    apiKey, mode: options.mode === 'test' ? 'test' : 'live', fetch: options.fetch, webhookSecret,
    timeoutMs: Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : SETUP_TIMEOUT_MS,
    now: typeof options.now === 'function' ? () => new Date(options.now()) : () => new Date(),
    url: String(options.webhookUrl ?? ''),
    urlSource: ['local', 'preview'].includes(options.webhookUrlSource) ? options.webhookUrlSource : 'production',
    refused: String(options.refused ?? ''),
    events: Array.isArray(options.events) && options.events.length ? options.events.map(String) : [...WEBHOOK_EVENTS],
    secrets: [apiKey, webhookSecret]
  };
}

async function planWith(ctx, envProducts) {
  const slots = envSlots(envProducts);
  const readHooks = !webhookUrlProblem(ctx.url);
  const [catalogue, current, hooks] = await Promise.all([
    listAll(ctx, '/v1/products/search', 'listing your products').then(items => items.map(readProduct).filter(Boolean)),
    Promise.all(slots.map(slot => (slot.envId ? getProduct(ctx, slot.envId) : null))),
    readHooks ? listAll(ctx, '/v1/webhooks', 'listing your webhooks').then(items => items.map(readWebhook).filter(Boolean), error => error) : []
  ]);
  const products = slots.map((slot, index) => planSlot(slot, current[index], catalogue, ctx.mode));
  const hooksError = hooks instanceof Error ? hooks : null;
  const webhook = planWebhook({ url: ctx.url, source: ctx.urlSource, events: ctx.events, hooks: hooksError ? [] : hooks, hooksError, secretSet: !!ctx.webhookSecret });
  if (webhook.webhook && ctx.webhookSecret) webhook.secret.matches = await secretMatches(ctx, webhook.webhook.id);
  return { products, webhook };
}

/**
 * Read-only: what exists in Creem and what Create would make.
 * options: { apiKey, mode: 'test' | 'live', fetch, products: { plus: { EUR, USD }, gift: { EUR, USD } } (env ids),
 *   webhookUrl, webhookUrlSource ('production', 'local' or 'preview', see setupTarget), refused (why Create is
 *   refused, see setupTarget), webhookSecret, events, timeoutMs, now }
 */
export async function planCreemSetup(options) {
  const ctx = context(options);
  const { products, webhook } = await planWith(ctx, options.products);
  return summary(ctx, products, webhook);
}

/**
 * The Idempotency-Key of a product request, derived from the mode and the
 * product's marker (dp-setup-test-plus-eur-…), its price, the UTC day and the
 * count of earlier copies in the store: two workers that read the same store on
 * the same day send the same key, so Creem answers the product already made;
 * once an earlier copy was archived, the key changes and a new one is made.
 */
export const productIdempotencyKey = (mode, slot, price, day, seen = 0) => `${productMarker(slot).replace(':', `-${mode}-`)}-${price}-${day}-${seen || 0}`;

async function createProduct(ctx, slot, day) {
  const expected = expectedProduct(slot.item, slot.currency);
  const key = productIdempotencyKey(ctx.mode, slot.slot, expected.price, day, slot.seen);
  const answer = await creemCall(ctx, 'POST', '/v1/products', { body: expected, headers: { 'Idempotency-Key': key } });
  if (!answer.ok) throw failure(ctx, answer.status, answer.data, `creating ${expected.name} (${slot.currency})`);
  const product = readProduct(answer.data);
  if (!product) throw new CreemSetupError('answer', `Creem answered without a product id for ${expected.name} (${slot.currency}).`);
  if (product.status !== 'active') throw new CreemSetupError('answer', `Creem answered with an archived product for ${expected.name} (${slot.currency}). Try again tomorrow, or create it in Creem → Products.`);
  return product;
}

async function createWebhook(ctx) {
  const answer = await creemCall(ctx, 'POST', '/v1/webhooks', { body: { url: ctx.url, name: WEBHOOK_NAME, events: ctx.events, delivery_mode: 'http' } });
  if (!answer.ok) throw failure(ctx, answer.status, answer.data, 'creating the webhook');
  const hook = readWebhook(answer.data);
  if (!hook) throw new CreemSetupError('answer', 'Creem answered without a webhook id.');
  const secret = typeof answer.data?.secret === 'string' ? answer.data.secret.trim().slice(0, 500) : '';
  return { hook, secret };
}

/**
 * Create what is missing and was asked for (`create`: slots such as 'gift-eur', and 'webhook'),
 * after planning again. Never edits or deletes. Answers the plan after creation, with
 * `created`, `failures` and, only when the webhook was just created, `webhookSecret`.
 */
export async function applyCreemSetup(options, { create = [] } = {}) {
  const ctx = context(options);
  const wanted = new Set((Array.isArray(create) ? create : []).filter(entry => typeof entry === 'string'));
  const { products, webhook } = await planWith(ctx, options.products);
  const day = ctx.now().toISOString().slice(0, 10).replaceAll('-', '');
  const todo = products.filter(slot => slot.state === 'create' && wanted.has(slot.slot));
  const created = [];
  const failures = [];
  const outcomes = await Promise.allSettled(todo.map(slot => createProduct(ctx, slot, day)));
  outcomes.forEach((outcome, index) => {
    const slot = todo[index];
    if (outcome.status === 'fulfilled') {
      Object.assign(slot, { state: 'created', source: 'new', id: outcome.value.id, product: publicProduct(outcome.value), differences: productDifferences(outcome.value, slot, ctx.mode) });
      created.push({ slot: slot.slot, id: outcome.value.id });
    } else {
      // Our own words (CreemSetupError), Creem's already scrubbed: a thrown bug says nothing.
      Object.assign(slot, { state: 'failed', error: outcome.reason instanceof CreemSetupError ? outcome.reason.message : 'Not created.' });
      failures.push({ slot: slot.slot, reason: outcome.reason?.reason || 'creem', error: slot.error });
    }
  });
  let webhookSecret = '';
  if (webhook.state === 'create' && wanted.has('webhook')) {
    try {
      // Read again right before creating: another Create (a second tab, another worker) may have made it meanwhile.
      const hooks = (await listAll(ctx, '/v1/webhooks', 'listing your webhooks')).map(readWebhook).filter(Boolean);
      const again = planWebhook({ url: ctx.url, source: ctx.urlSource, events: ctx.events, hooks, hooksError: null, secretSet: !!ctx.webhookSecret });
      if (again.state !== 'create') Object.assign(webhook, again);
      else {
        const result = await createWebhook(ctx);
        Object.assign(webhook, { state: 'created', webhook: result.hook, secret: { set: !!ctx.webhookSecret, matches: null, created: !!result.secret } });
        webhookSecret = result.secret;
        created.push({ slot: 'webhook', id: result.hook.id });
      }
    } catch (error) {
      Object.assign(webhook, { state: 'failed', message: error instanceof CreemSetupError ? error.message : 'Not created.' });
      failures.push({ slot: 'webhook', reason: error?.reason || 'creem', error: webhook.message });
    }
  }
  const already = [...wanted].filter(entry => !created.some(item => item.slot === entry) && !failures.some(item => item.slot === entry));
  return { ...summary(ctx, products, webhook), created, failures, already, ...(webhookSecret ? { webhookSecret } : {}) };
}

// Never 401 (the dashboard would sign the owner out) nor 503 (it reads as “the API is not set up”).
const HTTP_STATUS = { 'no-key': 409, key: 502, refused: 502, creem: 502, answer: 502, busy: 502, timeout: 504, network: 504 };
export const SETUP_LIMITS = Object.freeze({ plan: ADMIN_LIMITS.plan, apply: ADMIN_LIMITS.apply });
const RUNNING = 'creem-setup-apply';

/**
 * The admin routes, behind the owner's sign-in (checked by the caller):
 *   POST admin/creem/setup/plan                                   → the plan
 *   POST admin/creem/setup/apply { confirm: true, mode, create }  → the plan after creating
 * `getOptions(request)` gives planCreemSetup's options; `readBody()` the parsed JSON body.
 * Answers { status, body, headers } or null for another path. `limits`: the worker
 * isolate's own (server/admin-limits.js), shared by every request it answers —
 * SETUP_LIMITS per 10 minutes, and one Create at a time.
 */
export function createCreemSetupRoute(getOptions, { limits = sharedAdminLimits } = {}) {
  return async function creemSetupRoute(request, path, readBody) {
    const match = SETUP_ROUTE_RE.exec(path);
    if (!match) return null;
    const action = match[1];
    if (request.method !== 'POST') return { status: 405, body: { error: 'Method not allowed' } };
    const wait = limits[action]();
    if (wait) return { status: 429, body: { error: `Too many setup requests in a short time. Try again in ${waitWords(wait)}.`, reason: 'rate', retryAfter: wait }, headers: { 'retry-after': String(wait) } };
    const options = getOptions(request);
    const secrets = [options.apiKey, options.webhookSecret];
    // The one secret an answer carries on purpose is the new webhook's, in webhookSecret: it is hidden everywhere else.
    const answer = (status, body) => ({ status, body: scrubAnswer(body, [...secrets, body?.webhookSecret], new Set(['webhookSecret'])) });
    try {
      if (action === 'plan') return answer(200, await planCreemSetup(options));
      const body = await readBody();
      const mode = options.mode === 'test' ? 'test' : 'live';
      if (!String(options.apiKey ?? '').trim()) throw new CreemSetupError('no-key', 'Set the secret CREEM_API_KEY first (Creem → Developers → API keys), then redeploy.');
      if (body?.confirm !== true) return answer(400, { error: 'Nothing was created: confirm first.', reason: 'confirm' });
      if (body?.mode !== mode) return answer(409, { error: `Nothing was created: CREEM_API_KEY is in ${mode} mode now. Check the plan again.`, reason: 'mode', mode });
      if (options.refused) return answer(409, { error: `Nothing was created. ${options.refused}`, reason: 'origin' });
      if (limits.busy.has(RUNNING)) return answer(409, { error: 'Nothing was created: a setup is already running. Wait a moment, then check again.', reason: 'running' });
      limits.busy.add(RUNNING);
      try {
        return answer(200, await applyCreemSetup(options, { create: body.create }));
      } finally {
        limits.busy.delete(RUNNING);
      }
    } catch (error) {
      if (error instanceof CreemSetupError) return answer(HTTP_STATUS[error.reason] || 502, { error: error.message, reason: error.reason });
      throw error;
    }
  };
}
