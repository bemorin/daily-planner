import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canAddColumn, createConfigCheckRoute, describeShape, migrationSchema, parseRuntimeConfig, runConfigChecks, tableColumns, tokenStrength } from '../server/admin-config.js';
import { createRateLimiter } from '../server/admin-limits.js';
import { CONFIG_VARIABLES, configVariable, MIGRATIONS } from '../server/config-inventory.js';
import { createMemoryStore, createPlannerApi } from '../server/planner-api.js';
import { generatePlusKeyPair, importVerifyKey } from '../server/licenses.js';
import { BASE32_ALPHABET, fixFirst, newAdminToken, newPlusKeyPair, newTotpSecret, otpauthUri, summaryText, totalsText } from '../admin/configuration/config-model.js';

// The configuration checks (server/admin-config.js) against simulated services:
// every service answer that matters, the Plus signature, the database, the
// absence of any secret in the answer, the owner's sign-in and the rate limit,
// and the page's pure helpers (admin/configuration/config-model.js).

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const ORIGIN = 'https://planner.bemorin.com';
const PAIR = await generatePlusKeyPair();
const OTHER = await generatePlusKeyPair();
const random = (length, alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789') => Array.from(crypto.getRandomValues(new Uint8Array(length)), byte => alphabet[byte % alphabet.length]).join('');
// Fake secrets with their public prefix: only the part after it is secret.
const SECRETS = {
  ADMIN_TOKEN: random(48),
  ADMIN_TOTP_SECRET: random(32, BASE32_ALPHABET),
  CREEM_API_KEY: `creem_${random(32)}`,
  CREEM_WEBHOOK_SECRET: `whsec_${random(32)}`,
  RESEND_API_KEY: `re_${random(32)}`,
  PLUS_SIGNING_KEY: PAIR.signingKey
};
const PREFIXES = { CREEM_API_KEY: 'creem_', CREEM_WEBHOOK_SECRET: 'whsec_', RESEND_API_KEY: 're_' };

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const product = (id, fields = {}) => ({ id, object: 'product', name: id.includes('plus') ? 'Daily Planner Plus' : 'Daily Planner Plus gift', price: id.includes('plus') ? 2900 : 19500, currency: id.endsWith('usd') ? 'USD' : 'EUR', billing_type: 'onetime', status: 'active', tax_mode: 'inclusive', mode: 'prod', ...fields });
const HOOK = { id: 'wh_1', url: `${ORIGIN}/api/creem/webhook`, events: ['checkout.completed', 'refund.created', 'dispute.created'], status: 'enabled' };

function migrationRows(skip = [], { dropColumn = null } = {}) {
  const rows = [];
  for (const migration of MIGRATIONS) {
    const schema = migrationSchema(migration.sql);
    for (const table of schema.tables) {
      if (skip.includes(table.name)) continue;
      const columns = table.columns.filter(column => !(dropColumn && dropColumn[0] === table.name && dropColumn[1] === column.name));
      rows.push({ type: 'table', name: table.name, tableName: table.name, sql: `CREATE TABLE ${table.name} (\n  ${columns.map(column => column.definition).join(',\n  ')}\n)` });
    }
    for (const index of schema.indexes) if (!skip.includes(index.name) && !skip.includes(index.table)) rows.push({ type: 'index', name: index.name, tableName: index.table, sql: '' });
  }
  return rows;
}

function fakeDb({ rows = migrationRows(), fail = false } = {}) {
  return {
    prepare(sql) {
      return {
        first: async () => { if (fail) throw new Error('D1_ERROR: no such database'); return { one: 1 }; },
        all: async () => { assert.match(sql, /sqlite_master/); return { results: rows }; }
      };
    }
  };
}

const builtConfig = values => `globalThis.__DAILY_PLANNER_CONFIG__ = Object.freeze(${JSON.stringify(values, null, 2)});\n`;
const assets = values => ({ fetch: async () => new Response(builtConfig(values), { headers: { 'content-type': 'text/javascript' } }) });

/** A production environment where everything is right. */
function goodEnv(overrides = {}) {
  const built = { PLANNER_API_URL: '/api', PLUS_PUBLIC_KEY: PAIR.publicKey, SUPPORT_EMAIL: 'support@example.com', LEGAL_PHONE: '+33199001234', LEGAL_ADDRESS: '1 rue de la Paix, Paris', AFFILIATE_URL: 'https://www.creem.io/affiliate/daily-planner' };
  return {
    ...SECRETS,
    CREEM_PLUS_EUR: 'prod_plus_eur', CREEM_PLUS_USD: 'prod_plus_usd', CREEM_GIFT_EUR: 'prod_gift_eur', CREEM_GIFT_USD: 'prod_gift_usd',
    EMAIL_FROM: 'Daily Planner <hello@example.com>', OWNER_EMAIL: 'owner@example.com', PUBLIC_BASE_URL: ORIGIN,
    DAILY_PLANNER_API_URL: '/api', DAILY_PLANNER_PLUS_PUBLIC_KEY: PAIR.publicKey, DAILY_PLANNER_SUPPORT_EMAIL: built.SUPPORT_EMAIL,
    DAILY_PLANNER_LEGAL_PHONE: built.LEGAL_PHONE, DAILY_PLANNER_LEGAL_ADDRESS: built.LEGAL_ADDRESS, DAILY_PLANNER_AFFILIATE_URL: built.AFFILIATE_URL,
    DB: fakeDb(),
    ASSETS: assets(built),
    ...overrides
  };
}

/**
 * A fetch standing in for Creem and Resend. `routes` overrides an answer by
 * key: 'probe', 'product:<id>', 'webhooks', 'secret:<id>', 'domains'; a
 * function receives the URL and init. Calls are recorded.
 */
function services(routes = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const target = new URL(url);
    calls.push({ url: target.href, method: init.method || 'GET', headers: init.headers || {} });
    const answer = key => (typeof routes[key] === 'function' ? routes[key](target, init) : routes[key]);
    if (/creem\.io$/.test(target.hostname)) {
      if (target.pathname === '/v1/checkouts') return answer('probe') ?? json(404, { trace_id: 't', status: 404, error: 'Not Found', message: ['Checkout not found'] });
      const id = /^\/v1\/products\/([^/]+)$/.exec(target.pathname)?.[1];
      if (id) return answer(`product:${id}`) ?? json(200, product(decodeURIComponent(id)));
      if (target.pathname === '/v1/webhooks') return answer('webhooks') ?? json(200, { items: [HOOK], pagination: { total_pages: 1 } });
      const hook = /^\/v1\/webhooks\/([^/]+)\/secret$/.exec(target.pathname)?.[1];
      if (hook) return answer(`secret:${hook}`) ?? json(200, { secret: SECRETS.CREEM_WEBHOOK_SECRET });
    }
    if (target.hostname === 'api.resend.com' && target.pathname === '/domains') return answer('domains') ?? json(200, { object: 'list', has_more: false, data: [{ id: 'd1', name: 'example.com', status: 'verified', capabilities: { sending: 'enabled', receiving: 'disabled' } }] });
    return json(404, { message: 'unexpected call in the test' });
  };
  return { fetch, calls };
}

async function check({ env = goodEnv(), routes = {}, origin = ORIGIN, timeoutMs = 5000 } = {}) {
  const { fetch, calls } = services(routes);
  const result = await runConfigChecks({ env, fetch, origin, timeoutMs });
  const items = Object.fromEntries(result.items.map(item => [item.id, item]));
  return { result, items, calls };
}

test('everything right: every setting is OK or optional, nothing to fix', async () => {
  const { result, items, calls } = await check();
  const notOk = result.items.filter(item => !['ok', 'optional-missing'].includes(item.state)).map(item => `${item.id}: ${item.state} ${item.summary}`);
  assert.deepEqual(notOk, []);
  assert.equal(result.deployment.production, true);
  assert.deepEqual(result.notes, []);
  assert.equal(items.CREEM_API_KEY.summary, 'Valid: Creem accepted it (live mode).');
  assert.match(items.CREEM_PLUS_EUR.summary, /“Daily Planner Plus”, €29, one-time, tax inclusive/);
  assert.match(items.CREEM_WEBHOOK_SECRET.summary, /^Matches the signing secret of Creem’s webhook/);
  assert.match(items.PLUS_SIGNING_KEY.summary, /^Signs/);
  assert.match(items['DAILY_PLANNER_PLUS_PUBLIC_KEY'].summary, /^Matches PLUS_SIGNING_KEY/);
  assert.equal(items.EMAIL_FROM.summary, 'Its domain is verified in Resend.');
  assert.match(items['migration:0007_partner_commissions.sql'].summary, /^Applied: 4 tables and 2 indexes/);
  assert.equal(fixFirst(result.items).length, 0);
  // Every call is a read: GET only, to the live Creem API and Resend.
  assert.ok(calls.length >= 8);
  for (const call of calls) {
    assert.equal(call.method, 'GET', call.url);
    assert.match(call.url, /^https:\/\/(?:api\.creem\.io|api\.resend\.com)\//, call.url);
  }
  assert.ok(calls.some(call => call.url === 'https://api.creem.io/v1/checkouts?checkout_id=ch_config_check'));
  assert.equal(calls.find(call => call.url.includes('creem.io')).headers['x-api-key'], SECRETS.CREEM_API_KEY, 'Creem gets the key in its header');
  assert.equal(calls.find(call => call.url.includes('resend.com')).headers.authorization, `Bearer ${SECRETS.RESEND_API_KEY}`);
  // One row per setting and per migration, in the order of the groups.
  assert.equal(result.items.length, CONFIG_VARIABLES.length + MIGRATIONS.length);
  assert.deepEqual([...new Set(result.items.map(item => item.group))], result.groups.map(group => group.id));
});

test('Creem: a refused key is a problem, and the products and the webhook are then not tested', async () => {
  const { items } = await check({ routes: { probe: json(403, { trace_id: 't', status: 403, error: 'Forbidden' }) } });
  assert.equal(items.CREEM_API_KEY.state, 'problem');
  assert.match(items.CREEM_API_KEY.summary, /^Creem refused it in live mode \(HTTP 403\)\. Copy the live key again/);
  assert.match(items.CREEM_API_KEY.fix.steps.join(' '), /Variables and Secrets → Production → edit CREEM_API_KEY/);
  assert.match(items.CREEM_API_KEY.fix.steps.join(' '), /Retry deployment/);
  for (const name of ['CREEM_PLUS_EUR', 'CREEM_GIFT_USD', 'CREEM_WEBHOOK_SECRET']) assert.equal(items[name].state, 'untested', name);
});

test('Creem: a live key sent to the test API by CREEM_TEST_MODE is named, and a test key on the production address is a problem', async () => {
  const refused = await check({ env: goodEnv({ CREEM_TEST_MODE: '1' }), routes: { probe: url => (url.hostname === 'test-api.creem.io' ? json(403, {}) : json(404, {})) } });
  assert.equal(refused.items.CREEM_TEST_MODE.state, 'problem');
  assert.match(refused.items.CREEM_API_KEY.summary, /CREEM_TEST_MODE sends this live key to the test API/);
  assert.ok(refused.calls.every(call => !call.url.includes('creem.io') || call.url.startsWith('https://test-api.creem.io/')), 'test mode reads the test API');

  const testKey = `creem_test_${random(24)}`;
  const production = await check({ env: goodEnv({ CREEM_API_KEY: testKey }) });
  assert.equal(production.items.CREEM_API_KEY.state, 'problem');
  assert.match(production.items.CREEM_API_KEY.summary, /^A valid test key: Creem accepted it\. On the production address, test mode switches buying off/);
  assert.match(production.items.CREEM_API_KEY.shape, /^looks like a Creem test key \(creem_test_…\), 35 characters$/);
  const preview = await check({ env: goodEnv({ CREEM_API_KEY: testKey }), origin: 'https://abc123.daily-planner.pages.dev', routes: { webhooks: json(200, { items: [{ ...HOOK, url: 'https://abc123.daily-planner.pages.dev/api/creem/webhook' }] }) } });
  assert.equal(preview.items.CREEM_API_KEY.state, 'ok', 'a preview may use test keys');
  assert.equal(preview.items.CREEM_WEBHOOK_SECRET.state, 'ok', 'its webhook points at the preview address');
  assert.match(preview.result.notes.join(' '), /another address than the production one/);
  // CREEM_TEST_MODE with a creem_test_ key: fine, and said to be unneeded (the setup assistant leaves it out of its lines).
  const both = await check({ env: goodEnv({ CREEM_API_KEY: testKey, CREEM_TEST_MODE: '1' }), origin: 'https://abc123.daily-planner.pages.dev' });
  assert.equal(both.items.CREEM_TEST_MODE.state, 'ok');
  assert.equal(both.items.CREEM_TEST_MODE.summary, 'On: every Creem call goes to the test API. Not needed: a creem_test_ key already means test mode.');
});

test('Creem: a missing product, a wrong price, currency, billing or tax, an archived product and a repeated id are problems', async () => {
  const { items } = await check({
    env: goodEnv({ CREEM_GIFT_USD: 'prod_gift_eur' }),
    routes: {
      'product:prod_plus_eur': json(200, product('prod_plus_eur', { price: 1900, tax_mode: 'exclusive' })),
      'product:prod_plus_usd': json(200, product('prod_plus_usd', { currency: 'EUR', billing_type: 'recurring' })),
      'product:prod_gift_eur': json(404, { message: ['Product not found'] })
    }
  });
  assert.equal(items.CREEM_PLUS_EUR.state, 'problem');
  assert.match(items.CREEM_PLUS_EUR.summary, /its price is €19, and the site sells Plus at €29 \(PLUS_PRICE in src\/lib\/pricing\.js\); its price is tax exclusive/);
  assert.match(items.CREEM_PLUS_USD.summary, /it is in EUR, and CREEM_PLUS_USD needs a USD product; it is a subscription/);
  assert.equal(items.CREEM_GIFT_EUR.state, 'problem');
  assert.match(items.CREEM_GIFT_EUR.summary, /^Creem has no product with this id in live mode\. Test and live products have different ids\.$/);
  assert.match(items.CREEM_GIFT_EUR.fix.steps.join(' '), /Creem setup assistant below/);
  assert.equal(items.CREEM_GIFT_USD.state, 'problem');
  assert.match(items.CREEM_GIFT_USD.summary, /^Repeats the id of CREEM_GIFT_EUR/);

  const archived = await check({ routes: { 'product:prod_gift_usd': json(200, product('prod_gift_usd', { status: 'archived', price: 100 })) } });
  assert.match(archived.items.CREEM_GIFT_USD.summary, /it is archived, so checkouts can’t use it\.$/, 'a gift’s own price is never compared');
  const forbidden = await check({ routes: { 'product:prod_plus_eur': json(403, {}) } });
  assert.equal(forbidden.items.CREEM_PLUS_EUR.state, 'untested');
  assert.match(forbidden.items.CREEM_PLUS_EUR.summary, /didn’t let this key read products \(HTTP 403\)/);
});

test('Creem: the webhook secret is compared with the webhook’s own, for this site, with its three events', async () => {
  const other = await check({ routes: { 'secret:wh_1': json(200, { secret: `whsec_${random(32)}` }) } });
  assert.equal(other.items.CREEM_WEBHOOK_SECRET.state, 'problem');
  assert.match(other.items.CREEM_WEBHOOK_SECRET.summary, /^Doesn’t match the signing secret of Creem’s webhook for this site/);
  assert.deepEqual(other.items.CREEM_WEBHOOK_SECRET.fix.copy.map(entry => entry.text).slice(0, 2), [`${ORIGIN}/api/creem/webhook`, 'checkout.completed, refund.created, dispute.created']);

  const events = await check({ routes: { webhooks: json(200, { items: [{ ...HOOK, events: ['checkout.completed'] }] }) } });
  assert.equal(events.items.CREEM_WEBHOOK_SECRET.state, 'problem');
  assert.match(events.items.CREEM_WEBHOOK_SECRET.summary, /but the webhook doesn’t send refund\.created and dispute\.created/);

  const none = await check({ routes: { webhooks: json(200, { items: [{ ...HOOK, url: 'https://elsewhere.example/hook' }] }) } });
  assert.equal(none.items.CREEM_WEBHOOK_SECRET.state, 'problem');
  assert.match(none.items.CREEM_WEBHOOK_SECRET.summary, /no webhook in Creem \(live mode\) sends events to this site’s \/api\/creem\/webhook/);
  const unset = await check({ env: goodEnv({ CREEM_WEBHOOK_SECRET: '' }), routes: { webhooks: json(200, { items: [] }) } });
  assert.equal(unset.items.CREEM_WEBHOOK_SECRET.state, 'missing');

  const scoped = await check({ routes: { webhooks: json(403, { error: 'Forbidden' }) } });
  assert.equal(scoped.items.CREEM_WEBHOOK_SECRET.state, 'untested');
  assert.match(scoped.items.CREEM_WEBHOOK_SECRET.summary, /^Creem didn’t let this key list webhooks \(HTTP 403\)/);
  const unreadable = await check({ routes: { 'secret:wh_1': json(404, {}) } });
  assert.equal(unreadable.items.CREEM_WEBHOOK_SECRET.state, 'untested');
  assert.match(unreadable.items.CREEM_WEBHOOK_SECRET.summary, /^Not compared/);
});

test('a service that doesn’t answer in time leaves its rows “present, not tested”, within the timeout', async () => {
  const never = (url, init) => new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  const hang = () => new Promise(() => {});
  const started = Date.now();
  const { items } = await check({ timeoutMs: 60, routes: { probe: never, 'product:prod_plus_eur': hang, webhooks: hang, domains: hang } });
  assert.ok(Date.now() - started < 1500, 'every call gives up after the timeout');
  assert.equal(items.CREEM_API_KEY.state, 'untested');
  assert.equal(items.CREEM_API_KEY.summary, 'Creem didn’t answer within 1 second. Check again in a minute.');
  assert.equal(items.CREEM_PLUS_EUR.state, 'untested');
  assert.equal(items.CREEM_WEBHOOK_SECRET.state, 'untested');
  assert.equal(items.RESEND_API_KEY.state, 'untested');
  assert.equal(items.EMAIL_FROM.state, 'untested');
  const busy = await check({ routes: { domains: json(429, { name: 'rate_limit_exceeded' }), probe: json(500, {}) } });
  assert.match(busy.items.RESEND_API_KEY.summary, /limiting requests \(HTTP 429\)/);
  assert.match(busy.items.CREEM_API_KEY.summary, /had a problem \(HTTP 500\)/);
});

test('Resend: a sending-only key is valid; an invalid or inactive key is a problem; the sender’s domain must be verified', async () => {
  const restricted = await check({ routes: { domains: json(401, { statusCode: 401, name: 'restricted_api_key', message: 'This API key is restricted to only send emails' }) } });
  assert.equal(restricted.items.RESEND_API_KEY.state, 'ok');
  assert.match(restricted.items.RESEND_API_KEY.summary, /^Valid, with sending access only/);
  assert.equal(restricted.items.EMAIL_FROM.state, 'untested');
  assert.match(restricted.items.EMAIL_FROM.summary, /Send me a test email/);

  // Resend's own words only after a 400: after a 401 or a 403 they may repeat the key, so the summary uses ours.
  for (const [status, name, message, said] of [[400, 'validation_error', 'API key is invalid', ': “API key is invalid”'], [401, 'validation_error', 'API key is invalid', ': the key is unknown or was deleted'], [403, 'restricted_api_key', 'API key is not active', ': the key is not allowed to read this account, or is not active']]) {
    const { items } = await check({ routes: { domains: json(status, { name, message }) } });
    assert.equal(items.RESEND_API_KEY.state, 'problem', `${status} ${name}`);
    assert.equal(items.RESEND_API_KEY.summary, `Resend refused it (HTTP ${status}${said}).`);
    assert.equal(items.EMAIL_FROM.state, 'untested');
  }
  const pending = await check({ routes: { domains: json(200, { data: [{ name: 'example.com', status: 'pending' }] }) } });
  assert.equal(pending.items.EMAIL_FROM.state, 'problem');
  assert.match(pending.items.EMAIL_FROM.summary, /“pending” in Resend, not verified/);
  const absent = await check({ routes: { domains: json(200, { data: [{ name: 'other.example', status: 'verified' }] }) } });
  assert.match(absent.items.EMAIL_FROM.summary, /isn’t in this Resend account/);
  assert.match(absent.items.EMAIL_FROM.fix.steps[0], /Resend → Domains → Add domain/);
  const bad = await check({ env: goodEnv({ EMAIL_FROM: 'Daily Planner', OWNER_EMAIL: 'me at home', EMAIL_DAILY_LIMIT: '0' }) });
  assert.equal(bad.items.EMAIL_FROM.state, 'problem');
  assert.equal(bad.items.OWNER_EMAIL.state, 'problem');
  assert.equal(bad.items.EMAIL_DAILY_LIMIT.state, 'problem');
  assert.match(bad.items.EMAIL_DAILY_LIMIT.summary, /^0 stops every email/);
});

test('Plus keys: a message signed with PLUS_SIGNING_KEY must verify with the public key the planner was built with', async () => {
  const mismatch = await check({ env: goodEnv({ DAILY_PLANNER_PLUS_PUBLIC_KEY: OTHER.publicKey, ASSETS: assets({ PLANNER_API_URL: '/api', PLUS_PUBLIC_KEY: OTHER.publicKey, SUPPORT_EMAIL: 'support@example.com', LEGAL_PHONE: '+33199001234', LEGAL_ADDRESS: '1 rue de la Paix, Paris', AFFILIATE_URL: 'https://www.creem.io/affiliate/daily-planner' }) }) });
  const row = mismatch.items.DAILY_PLANNER_PLUS_PUBLIC_KEY;
  assert.equal(row.state, 'problem');
  assert.equal(row.summary, 'Doesn’t match PLUS_SIGNING_KEY: licences issued now won’t verify in the planner.');
  const copy = row.fix.copy.find(entry => entry.label === 'Public key');
  assert.equal(copy.text, PAIR.publicKey, 'the fix gives the public key of the signing key (public, never the signing key)');
  assert.ok(await importVerifyKey(copy.text));
  assert.equal(mismatch.items.PLUS_SIGNING_KEY.state, 'ok');
  assert.equal(mismatch.items.PLUS_SIGNING_KEY.generate, undefined, 'no new pair is offered while a usable key is set');

  const missing = await check({ env: goodEnv({ DAILY_PLANNER_PLUS_PUBLIC_KEY: '', ASSETS: assets({ PLANNER_API_URL: '/api' }) }) });
  assert.equal(missing.items.DAILY_PLANNER_PLUS_PUBLIC_KEY.state, 'missing');
  assert.equal(missing.items.DAILY_PLANNER_PLUS_PUBLIC_KEY.fix.copy.find(entry => entry.label === 'Public key').text, PAIR.publicKey);

  const broken = await check({ env: goodEnv({ PLUS_SIGNING_KEY: 'bm90IGEga2V5' }) });
  assert.equal(broken.items.PLUS_SIGNING_KEY.state, 'problem');
  assert.match(broken.items.PLUS_SIGNING_KEY.summary, /^Not a usable P-256 private key: Plus is off/);
  assert.equal(broken.items.PLUS_SIGNING_KEY.generate, 'plus-pair');
  const none = await check({ env: goodEnv({ PLUS_SIGNING_KEY: '' }) });
  assert.equal(none.items.PLUS_SIGNING_KEY.state, 'missing');
  assert.equal(none.items.PLUS_SIGNING_KEY.generate, 'plus-pair', 'a pair is offered while the key is missing');
  assert.equal(none.items.DAILY_PLANNER_PLUS_PUBLIC_KEY.state, 'untested');
});

test('build variables: compared with the value the deployed runtime-config.js was built with', async () => {
  const stale = await check({ env: goodEnv({ DAILY_PLANNER_LEGAL_ADDRESS: '2 avenue Foch, Paris' }) });
  assert.equal(stale.items.DAILY_PLANNER_LEGAL_ADDRESS.state, 'problem');
  assert.match(stale.items.DAILY_PLANNER_LEGAL_ADDRESS.summary, /^The deployed site was built with another value than the one set now\. Retry the deployment/);
  assert.match(stale.items.DAILY_PLANNER_LEGAL_ADDRESS.fix.steps[0], /^Redeploy: .*Retry deployment/);
  const notBuilt = await check({ env: goodEnv({ DAILY_PLANNER_GITHUB_URL: 'https://github.com/example/planner' }) });
  assert.equal(notBuilt.items.DAILY_PLANNER_GITHUB_URL.state, 'problem');
  assert.match(notBuilt.items.DAILY_PLANNER_GITHUB_URL.summary, /^Set, but the deployed site was built without it/);

  const unreadable = await check({ env: goodEnv({ ASSETS: { fetch: async () => new Response('nope', { status: 500 }) } }) });
  assert.match(unreadable.result.notes.join(' '), /runtime-config\.js couldn’t be read \(HTTP 500\)/);
  assert.equal(unreadable.items.DAILY_PLANNER_API_URL.state, 'ok', 'judged from the settings instead');

  const wrong = await check({ env: goodEnv({ DAILY_PLANNER_API_URL: 'https://other.example/api', DAILY_PLANNER_SUPPORT_EMAIL: 'support at example', DAILY_PLANNER_LEGAL_PHONE: '+3301990012', DAILY_PLANNER_AFFILIATE_URL: 'http://example.com/join', DAILY_PLANNER_GOOGLE_CLIENT_ID: '123456789-abcdefghij.apps.googleusercontent.com', ASSETS: { fetch: async () => new Response('', { status: 404 }) } }) });
  assert.match(wrong.items.DAILY_PLANNER_API_URL.summary, /another site/);
  assert.match(wrong.items.DAILY_PLANNER_SUPPORT_EMAIL.summary, /^Set, but the legal pages leave it out: not a plain email address\.$/);
  assert.match(wrong.items.DAILY_PLANNER_LEGAL_PHONE.summary, /after \+33, the 9 digits of the number, without its leading 0/);
  assert.match(wrong.items.DAILY_PLANNER_AFFILIATE_URL.summary, /^Not an https link/);
  assert.equal(wrong.items.DAILY_PLANNER_GOOGLE_CLIENT_ID.state, 'untested', 'Google has no read-only check');
});

test('sign-in settings and addresses: by their shape', async () => {
  const { items } = await check({ env: goodEnv({ ADMIN_TOKEN: 'dev', ADMIN_TOTP_SECRET: 'not base32!', PUBLIC_BASE_URL: 'http://planner.example', ALLOWED_ORIGINS: 'https://ok.example, https://bad.example/' }) });
  assert.equal(items.ADMIN_TOKEN.state, 'problem');
  assert.equal(items.ADMIN_TOKEN.shape, '3 characters, weak', 'its length and a verdict, never what it is made of');
  assert.match(items.ADMIN_TOKEN.summary, /^Weak: easy to guess\./);
  assert.equal(describeShape(configVariable('ADMIN_TOKEN'), SECRETS.ADMIN_TOKEN), '48 characters, strong');
  assert.equal(describeShape(configVariable('ADMIN_TOKEN'), '1'.repeat(36)), '36 characters, weak', 'long but predictable');
  assert.equal(items.ADMIN_TOKEN.generate, 'token');
  assert.equal(items.ADMIN_TOTP_SECRET.state, 'problem');
  assert.equal(items.PUBLIC_BASE_URL.state, 'problem');
  assert.equal(items.ALLOWED_ORIGINS.state, 'problem');
  assert.match(items.ALLOWED_ORIGINS.summary, /^1 entry of 2 isn’t an origin/);
  assert.deepEqual(tokenStrength('Ab3'), { length: 3, bits: 17, kinds: 'letters and digits' });
  assert.equal(describeShape(configVariable('ADMIN_TOTP_SECRET'), 'JBSWY3DPEHPK3PXP'), 'base32, 16 characters (80 bits)');
});

test('D1: the database answers, and every table, column and index of the migrations is there', async () => {
  const missing = await check({ env: goodEnv({ DB: fakeDb({ rows: migrationRows(['refunds', 'partner_payouts_paid'], { dropColumn: ['orders', 'mode'] }) }) }) });
  const refunds = missing.items['migration:0005_refunds.sql'];
  assert.equal(refunds.state, 'problem');
  assert.equal(refunds.summary, 'Not fully applied. Missing: table refunds; column orders.mode; index refunds_created.');
  // In the order to run them: the column first (the file skips a table that exists), then the whole file.
  assert.deepEqual(refunds.fix.copy.map(entry => entry.label), ['Missing column', 'SQL of 0005_refunds.sql', 'Or from a terminal']);
  assert.equal(refunds.fix.copy[0].text, 'ALTER TABLE orders ADD COLUMN mode TEXT NOT NULL DEFAULT \'\';');
  assert.equal(refunds.fix.copy[1].text, MIGRATIONS.find(migration => migration.file === '0005_refunds.sql').sql, 'the SQL to paste, the whole file');
  assert.equal(refunds.fix.copy[2].text, 'npx wrangler d1 execute daily-planner --remote --command="ALTER TABLE orders ADD COLUMN mode TEXT NOT NULL DEFAULT \'\';"\nnpx wrangler d1 execute daily-planner --remote --file=migrations/0005_refunds.sql');
  assert.match(refunds.fix.steps[0], /Storage & Databases → D1 SQLite Database → daily-planner → Console/);
  assert.match(refunds.fix.steps[1], /^First run the ALTER TABLE line below/);
  assert.match(refunds.fix.steps[2], /^Then paste the SQL of migrations\/0005_refunds\.sql/);
  assert.equal(missing.items['migration:0007_partner_commissions.sql'].summary, 'Not fully applied. Missing: index partner_payouts_paid.');
  assert.equal(missing.items['migration:0001_planner_api.sql'].state, 'ok');

  const failing = await check({ env: goodEnv({ DB: fakeDb({ fail: true }) }) });
  assert.equal(failing.items.DB.state, 'problem');
  assert.match(failing.items.DB.summary, /^The database answered with an error: D1_ERROR/);
  assert.equal(failing.items['migration:0001_planner_api.sql'].state, 'untested');
  // No answer in time says nothing about the binding: not tested, and no “add the binding” fix.
  const slow = await check({ timeoutMs: 40, env: goodEnv({ DB: { prepare: () => ({ first: () => new Promise(() => {}), all: () => new Promise(() => {}) }) } }) });
  assert.equal(slow.items.DB.state, 'untested');
  assert.equal(slow.items.DB.summary, 'Not tested: the database didn’t answer within 1 second. Check again in a minute.');
  assert.equal(slow.items.DB.fix, null);

  const local = await check({ env: goodEnv({ DB: undefined }), origin: 'http://localhost:8080' });
  assert.equal(local.items.DB.state, 'untested', 'the dev server has no D1');
  assert.match(local.result.notes[0], /local server/);
  const unbound = await check({ env: goodEnv({ DB: undefined }) });
  assert.equal(unbound.items.DB.state, 'missing');
  assert.match(unbound.items.DB.fix.steps[0], /Settings → Bindings → Add → D1 database/);
});

test('no secret, nor any part of one, is ever in the answer — even when a service echoes it', async () => {
  const theirSecret = `whsec_${random(32)}`;
  const echo = (status, extra = {}) => () => json(status, { message: [`Invalid key ${SECRETS.CREEM_API_KEY}`], ...extra });
  const runs = [
    await check(),
    await check({ routes: { probe: echo(403), 'secret:wh_1': json(200, { secret: theirSecret }), domains: json(400, { name: 'validation_error', message: `API key is invalid: ${SECRETS.RESEND_API_KEY}` }) } }),
    await check({ env: goodEnv({ DB: fakeDb({ fail: true }), ADMIN_TOKEN: `${SECRETS.ADMIN_TOKEN}` }), routes: { 'product:prod_plus_eur': json(200, product('prod_plus_eur', { name: `Plus ${SECRETS.CREEM_API_KEY}` })), domains: json(403, { name: 'restricted_api_key', message: `not active ${SECRETS.RESEND_API_KEY}` }) } }),
    await check({ env: goodEnv({ PLUS_SIGNING_KEY: '' }) })
  ];
  for (const { result } of runs) {
    const text = JSON.stringify(result);
    for (const [name, value] of [...Object.entries(SECRETS), ['creem webhook secret', theirSecret]]) {
      assert.ok(!text.includes(value), `${name} appears in the answer`);
      const prefix = PREFIXES[name] || (name.startsWith('creem webhook') ? 'whsec_' : '');
      // PKCS#8 keys of P-256 all start with the same public header: only the rest is secret.
      const secretPart = name === 'PLUS_SIGNING_KEY' ? value.slice(48) : value.slice(prefix.length);
      for (let start = 0; start + 6 <= secretPart.length; start += 1) {
        const piece = secretPart.slice(start, start + 6);
        assert.ok(!text.includes(piece), `${name}: “${piece}” (6 characters of it) appears in the answer`);
      }
    }
  }
  const page = summaryText(runs[1].result);
  for (const value of [...Object.values(SECRETS), 'hello@example.com', 'owner@example.com', 'prod_plus_eur', PAIR.publicKey, ORIGIN]) assert.ok(!page.includes(value), `the copied summary holds no value: ${value.slice(0, 12)}`);
});

test('the route: owner sign-in required, POST only, rate-limited, and wired into the API with the deployment’s environment', async () => {
  const { fetch } = services();
  const api = createPlannerApi({ store: createMemoryStore(), adminToken: SECRETS.ADMIN_TOKEN, authFailureDelayMs: 0, configEnv: goodEnv(), configFetch: fetch });
  const post = token => new Request(`${ORIGIN}/api/admin/config/check`, { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {} });
  assert.equal((await api(post())).status, 401);
  assert.equal((await api(post('wrong'))).status, 401);
  assert.equal((await api(new Request(`${ORIGIN}/api/admin/config/check`, { headers: { authorization: `Bearer ${SECRETS.ADMIN_TOKEN}` } }))).status, 405);
  const response = await api(post(SECRETS.ADMIN_TOKEN));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.equal(body.items.length, CONFIG_VARIABLES.length + MIGRATIONS.length);
  assert.equal(body.deployment.origin, ORIGIN, 'the page’s own address');
  assert.ok(!JSON.stringify(body).includes(SECRETS.ADMIN_TOKEN));

  let time = 0;
  const route = createConfigCheckRoute(() => ({ env: {}, fetch }), { limiter: createRateLimiter({ limit: 2, windowMs: 60000, now: () => time }) });
  const request = new Request(`${ORIGIN}/api/admin/config/check`, { method: 'POST' });
  assert.equal((await route(request, 'admin/config/check')).status, 200);
  assert.equal((await route(request, 'admin/config/check')).status, 200);
  const limited = await route(request, 'admin/config/check');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers['retry-after'], '60');
  assert.match(limited.body.error, /^Too many checks in a short time\. Check again in 1 minute\.$/);
  time = 60001;
  assert.equal((await route(request, 'admin/config/check')).status, 200, 'allowed again after the window');
  assert.equal(await route(request, 'admin/other'), null);
});

test('the deployed runtime-config.js is read as text, in the build’s form and the source’s', () => {
  assert.deepEqual(parseRuntimeConfig(builtConfig({ PLANNER_API_URL: '/api', SUPPORT_EMAIL: 'a "quoted" <b@c.d>' })), { PLANNER_API_URL: '/api', SUPPORT_EMAIL: 'a "quoted" <b@c.d>' });
  const source = parseRuntimeConfig(read('runtime-config.js'));
  assert.equal(source.PLANNER_API_URL, '');
  assert.equal(Object.keys(source).length, CONFIG_VARIABLES.filter(entry => entry.where === 'build').length);
  assert.equal(parseRuntimeConfig('alert(1)'), null);
});

test('the page: “Fix first” puts required settings first; the summary has the totals, the states and no value', async () => {
  const { result } = await check({ env: goodEnv({ OWNER_EMAIL: '', EMAIL_DAILY_LIMIT: 'x', PLUS_SIGNING_KEY: '' }), routes: { 'product:prod_gift_eur': json(404, {}) } });
  const first = fixFirst(result.items).map(item => `${item.level}:${item.state}:${item.name}`);
  assert.deepEqual(first, ['required:problem:CREEM_GIFT_EUR', 'required:missing:PLUS_SIGNING_KEY', 'recommended:missing:OWNER_EMAIL', 'optional:problem:EMAIL_DAILY_LIMIT']);
  const text = summaryText(result);
  assert.match(text, /^Daily Planner — configuration check\nChecked \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC, on the production address/);
  assert.match(text, /\nFix first:\n1\. CREEM_GIFT_EUR \(required, Text\): Problem \[an id, not the usual prod_… form\] — Creem has no product with this id/);
  assert.match(text, /\n4\. EMAIL_DAILY_LIMIT \(optional, Text\): Problem \[not a whole number\] — .* If left blank: Blank: 100 a day/);
  assert.match(text, /\nCloudflare Pages — build variables\n- DAILY_PLANNER_API_URL \(required, Text\): OK/);
  assert.match(text, /- CREEM_API_KEY \(required, secret\): OK \[looks like a Creem live key \(creem_…\), 38 characters\]/);
  assert.match(text, /No value of any setting is included/);
  assert.ok(!text.includes('CREATE TABLE') && !text.includes('/api/creem/webhook\n'), 'the copy lines of the fixes are left out');
  assert.equal(totalsText({ ok: 1, problem: 2, untested: 0 }), '1 OK, 2 problems');
  assert.match(summaryText({ ...result, durationMs: 40 }), /, in under 0\.1 s\.\n/, 'never “in 0.0 s”');
  assert.match(summaryText({ ...result, durationMs: 1430 }), /, in 1\.4 s\.\n/);
});

test('the page generates values in the browser: letters and digits, base32, a working Plus key pair', async () => {
  const tokens = new Set(Array.from({ length: 20 }, () => newAdminToken()));
  assert.equal(tokens.size, 20);
  for (const token of tokens) assert.match(token, /^[A-Za-z0-9]{48}$/);
  const totp = newTotpSecret();
  assert.match(totp, /^[A-Z2-7]{32}$/);
  assert.equal(describeShape(configVariable('ADMIN_TOTP_SECRET'), totp), 'base32, 32 characters (160 bits)');
  assert.equal(otpauthUri('ABC'), 'otpauth://totp/Daily%20Planner:owner?secret=ABC&issuer=Daily%20Planner&digits=6&period=30');
  // No modulo bias: with bytes always 255, a 62-letter alphabet skips them rather than favouring a letter.
  let calls = 0;
  const skewed = { getRandomValues: array => { calls += 1; array.fill(calls === 1 ? 255 : 1); return array; } };
  assert.equal(newAdminToken(skewed), 'B'.repeat(48));
  const pair = await newPlusKeyPair();
  const { items } = await check({ env: goodEnv({ PLUS_SIGNING_KEY: pair.signingKey, DAILY_PLANNER_PLUS_PUBLIC_KEY: pair.publicKey, ASSETS: assets({ PLANNER_API_URL: '/api', PLUS_PUBLIC_KEY: pair.publicKey }) }) });
  assert.equal(items.PLUS_SIGNING_KEY.state, 'ok');
  assert.equal(items.DAILY_PLANNER_PLUS_PUBLIC_KEY.state, 'ok', 'the pair made in the browser signs and verifies as the server’s');
});

test('the page keeps nothing: no storage but the dashboard’s session, the Creem assistant loaded only if it is there', () => {
  const script = read('admin/configuration/configuration.js');
  const model = read('admin/configuration/config-model.js');
  for (const source of [script, model]) {
    assert.doesNotMatch(source, /localStorage|indexedDB/);
    assert.doesNotMatch(source.replace(/sessionStorage\.(?:getItem|setItem|removeItem)\(SESSION_KEY/g, ''), /sessionStorage\./, 'only the signed session, as the dashboard keeps it');
  }
  assert.match(script, /const SESSION_KEY = 'daily-planner-owner-session';/, 'the dashboard’s own session');
  assert.match(read('admin/admin.js'), /const SESSION_KEY = 'daily-planner-owner-session';/);
  assert.match(script, /await import\('\.\.\/creem-setup\.js'\)/);
  assert.match(script, /catch \(_\) \{\n\s*\/\/ No assistant in this deployment: nothing to show\./);
  assert.match(script, /setAttribute\('data-creem-setup', ''\)/);
  assert.match(script, /crypto|newAdminToken/);
  const html = read('admin/configuration/index.html');
  for (const hook of ['data-cfg-check', 'data-cfg-copy', 'data-cfg-test-email', 'data-cfg-first', 'data-cfg-groups', 'data-cfg-login']) assert.ok(html.includes(hook), hook);
  assert.match(html, /<link rel="stylesheet" href="\.\.\/\.\.\/styles\.css">/);
  assert.match(html, /<meta name="robots" content="noindex,nofollow">/);
  // Reached from the dashboard: its header and its Setup card.
  const admin = read('admin/index.html');
  assert.equal((admin.match(/href="\.\/configuration\/"/g) || []).length, 2);
});
