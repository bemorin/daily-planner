// Cloudflare Pages Function: every /api/* request of the deployed planner.
// Bindings (Pages → Settings): D1 database as `DB`, secret `ADMIN_TOKEN`,
// optional secret `ADMIN_TOTP_SECRET` (base32) to require an authenticator
// code at owner sign-in, optional `ALLOWED_ORIGINS` (comma-separated) for
// cross-origin callers.
// Optional email through Resend: secret `RESEND_API_KEY`, `EMAIL_FROM`
// ("Name <address>" on a domain verified in Resend), `OWNER_EMAIL` (team
// request notifications, test sends, reply-to of buyer emails) and
// `EMAIL_DAILY_LIMIT` (default 100, Resend's free plan).
// Daily Planner Plus: secret `PLUS_SIGNING_KEY` (npm run plus:keys; the app
// build needs the matching DAILY_PLANNER_PLUS_PUBLIC_KEY) and `PUBLIC_BASE_URL`
// for links in emails and checkout returns (default https://planner.bemorin.com).
// Payments through Creem: secret `CREEM_API_KEY`, secret `CREEM_WEBHOOK_SECRET`
// (for /api/creem/webhook), the product ids `CREEM_PLUS_EUR`, `CREEM_PLUS_USD`,
// `CREEM_GIFT_EUR`, `CREEM_GIFT_USD`, and optional `CREEM_TEST_MODE` = 1.
// The checkout currency follows the buyer's country from Cloudflare
// (request.cf.country): EUR in the euro area, USD elsewhere.
// Setup guide: docs/FEEDBACK_AND_WAITLIST.md

import { createPlannerApi } from '../../server/planner-api.js';
import { createD1Store } from '../../server/d1-store.js';
import { creemProductsFromEnv } from '../../server/creem.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (!env.DB) {
    return new Response(JSON.stringify({ error: 'The D1 binding "DB" is not configured.' }), { status: 503, headers: { 'content-type': 'application/json; charset=utf-8' } });
  }
  const handle = createPlannerApi({
    store: createD1Store(env.DB),
    adminToken: env.ADMIN_TOKEN || '',
    adminTotpSecret: env.ADMIN_TOTP_SECRET || '',
    allowedOrigins: env.ALLOWED_ORIGINS || '',
    resendApiKey: env.RESEND_API_KEY || '',
    emailFrom: env.EMAIL_FROM || '',
    ownerEmail: env.OWNER_EMAIL || '',
    emailDailyLimit: env.EMAIL_DAILY_LIMIT ?? '',
    publicBaseUrl: env.PUBLIC_BASE_URL || '',
    plusSigningKey: env.PLUS_SIGNING_KEY || '',
    creemApiKey: env.CREEM_API_KEY || '',
    creemWebhookSecret: env.CREEM_WEBHOOK_SECRET || '',
    creemTestMode: env.CREEM_TEST_MODE || '',
    creemProducts: creemProductsFromEnv(env),
    // Owner notifications and gift emails finish after the response has been sent.
    defer: promise => context.waitUntil(promise)
  });
  return handle(request);
}
