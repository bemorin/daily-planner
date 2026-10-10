// Stripe Checkout Sessions, read once to turn a Payment Link purchase into a
// Plus licence or a team gift. Nothing is created in Stripe from here: the
// owner makes Payment Links in the Stripe dashboard; this module only reads
// a session with a restricted key (Checkout Sessions: Read).
//
// Env  STRIPE_SECRET_KEY  restricted key (rk_live_… / rk_test_…) or secret key
//      STRIPE_PRICES      JSON { "<price id>": { "kind": "plus" } | { "kind": "gift", "seats": 50, "plan": "up-to-50" } }
// `fetch` is injectable so tests never reach the network.

export const STRIPE_API_URL = 'https://api.stripe.com/v1';
export const STRIPE_SESSION_RE = /^cs_(?:test|live)_[A-Za-z0-9_]{8,240}$/;
export const STRIPE_TIMEOUT_MS = 10000;
const PRICE_ID_RE = /^[A-Za-z0-9_]{3,120}$/;
const PLAN_RE = /^[a-z0-9-]{1,40}$/;

/**
 * Parse STRIPE_PRICES. Returns { prices: Map<priceId, { kind, seats?, plan? }>, error }.
 * Entries that are not understood are skipped and named in `error`.
 */
export function parseStripePrices(value) {
  const prices = new Map();
  const text = String(value ?? '').trim();
  if (!text) return { prices, error: '' };
  let parsed;
  try { parsed = JSON.parse(text); } catch { return { prices, error: 'STRIPE_PRICES is not valid JSON.' }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { prices, error: 'STRIPE_PRICES must be a JSON object of price ids.' };
  const skipped = [];
  for (const [id, entry] of Object.entries(parsed)) {
    const seats = Number(entry?.seats);
    if (PRICE_ID_RE.test(id) && entry?.kind === 'plus') prices.set(id, { kind: 'plus' });
    else if (PRICE_ID_RE.test(id) && entry?.kind === 'gift' && Number.isInteger(seats) && seats >= 1 && seats <= 100000) {
      prices.set(id, { kind: 'gift', seats, plan: PLAN_RE.test(String(entry.plan ?? '')) ? String(entry.plan) : '' });
    } else skipped.push(id);
  }
  return { prices, error: skipped.length ? `STRIPE_PRICES: skipped ${skipped.length} entr${skipped.length === 1 ? 'y' : 'ies'} that are not { "kind": "plus" } or { "kind": "gift", "seats": 1–100000 }.` : '' };
}

/** 'live', 'test' or '' from the key prefix (sk_/rk_). */
export function stripeMode(secretKey) {
  const match = /^(?:sk|rk)_(live|test)_/.exec(String(secretKey ?? '').trim());
  return match ? match[1] : '';
}

/**
 * GET the Checkout Session with its line items. Resolves with the session, or
 * null when Stripe does not know it; rejects on any other failure.
 */
export async function fetchCheckoutSession({ secretKey, sessionId, fetch: fetchImpl, timeoutMs = STRIPE_TIMEOUT_MS }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${STRIPE_API_URL}/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=line_items`, {
      method: 'GET',
      headers: { authorization: `Bearer ${secretKey}`, accept: 'application/json' },
      signal: controller.signal
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const detail = typeof body?.error?.message === 'string' ? `: ${body.error.message.slice(0, 200)}` : '';
      throw new Error(`Stripe answered HTTP ${response.status}${detail}`);
    }
    return await response.json();
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Stripe did not answer in time');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read what was bought. Returns { paid, item, org, email, currency, amount }:
 * `item` is { kind: 'plus' } or { kind: 'gift', seats, plan } (seats × quantity),
 * or null when no line item matches STRIPE_PRICES.
 */
export function readCheckoutSession(session, prices) {
  const paid = session?.status === 'complete' && ['paid', 'no_payment_required'].includes(session?.payment_status);
  const lines = Array.isArray(session?.line_items?.data) ? session.line_items.data : [];
  let item = null;
  for (const line of lines) {
    const price = prices.get(String(line?.price?.id ?? ''));
    if (!price) continue;
    if (price.kind === 'gift') {
      const quantity = Math.max(1, Math.floor(Number(line.quantity) || 1));
      item = { kind: 'gift', seats: Math.min(100000, price.seats * quantity), plan: price.plan };
      break;
    }
    item = { kind: 'plus' };
  }
  const company = (Array.isArray(session?.custom_fields) ? session.custom_fields : []).find(field => field?.key === 'company');
  const org = String(company?.text?.value || session?.customer_details?.name || '').trim();
  const email = String(session?.customer_details?.email || session?.customer_email || '').trim().toLowerCase();
  const currency = String(session?.currency || '').toUpperCase();
  const amount = Number.isInteger(session?.amount_total) ? session.amount_total : null;
  return { paid, item, org, email, currency, amount };
}
