// Zero-dependency local server for Daily Planner.
//
//   node scripts/serve.mjs            serve the source tree on http://localhost:8080
//   node scripts/serve.mjs --dist     serve the production build in dist/
//   node scripts/serve.mjs --open     also open the default browser
//   node scripts/serve.mjs --port 9000 --lan
//   node scripts/serve.mjs --api      also run the owner API (waitlist, feedback, team requests, counts)
//   node scripts/serve.mjs --api --data /tmp/api.json   keep the API data in another file
//   node scripts/serve.mjs --api --fake-email            print emails instead of sending them
//   node scripts/serve.mjs --api --fake-creem            pretend Creem checkouts (below)
//   node scripts/serve.mjs --api --country FR            pretend every visitor is in France (prices in EUR)
//
// The local API is off by default, so everyday local use never collects
// anything. With --api it mirrors the production Cloudflare Function
// (server/planner-api.js), stores data in .planner-dev/api.json, and the owner
// dashboard is at /admin/ with the token printed below (set ADMIN_TOKEN to
// choose your own; on --lan a random token is generated instead of "dev").
// Set ADMIN_TOTP_SECRET (base32, see scripts/admin-secret.mjs) to also require
// an authenticator code at sign-in, exactly as in production.
// Email is off unless RESEND_API_KEY and EMAIL_FROM are set (plus OWNER_EMAIL,
// EMAIL_DAILY_LIMIT and PUBLIC_BASE_URL, as in production). With --fake-email,
// nothing is sent: each email is printed here instead, so the dashboard's
// announcement can be tried safely (it still deletes the local waitlist
// entries it "sent").
//
// Daily Planner Plus: with --api and no PLUS_SIGNING_KEY, a throwaway key pair
// is made at startup (new on every start, so licences from an earlier run stop
// working). Its public key is put into the served runtime-config.js, and
// POST /api/dev/license answers { license } signed with it. With
// PLUS_SIGNING_KEY set, its public key is served instead and there is no
// /api/dev/license.
//
// Payments: --fake-creem stands in for Creem, the payment provider. POST
// /api/checkout then answers a local page, /__fake-creem/pay?checkout=<id>,
// that sends the browser straight back to the return address with
// ?checkout_id=<id>&order_id=ord_fake&signature=fake, as Creem does after a
// payment; reading that checkout answers "completed" with what it was opened
// for (company "Acme Studio" for team gifts, from "Camille" for personal
// gifts). A partner code (affiliate_code) is printed; the code BADCODE is
// refused with HTTP 400, as Creem refuses an unknown code, so the API's retry
// without it can be tried. Two shortcuts need no checkout:
// /?checkout_id=fake_plus unlocks Plus and /welcome/thanks/?checkout_id=fake_gift50
// makes a 50-seat gift for "Acme Studio". Set CREEM_WEBHOOK_SECRET to try
// POST /api/creem/webhook too. Without --fake-creem the CREEM_* variables are
// used, as in production. Links in emails and checkout returns point at this
// server unless PUBLIC_BASE_URL is set.
//
// Currency: in production the buyer's country (from Cloudflare) decides it.
// Locally the country is unknown, so the page's own guess is used, unless a
// request carries a CF-IPCountry header or the server runs with --country FR
// (or US, DE …), which sets that header on every API request without one.
//
// Browsers keep planner data per address (host + port), so the server always
// prefers the same port. If that port already runs Daily Planner, it simply
// opens the existing instance instead of starting a second copy elsewhere.

import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { createMemoryStore, createPlannerApi } from '../server/planner-api.js';
import { generatePlusKeyPair, importSigningKey, publicKeyFromSigningKey, signLicense } from '../server/licenses.js';
import { checkoutSeal, creemMode, creemProductsFromEnv } from '../server/creem.js';
import { priceCents } from '../src/lib/pricing.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const useDist = flag('dist');
const shouldOpen = flag('open');
const lan = flag('lan');
const preferredPort = Number(option('port', process.env.PORT || 8080)) || 8080;
const host = lan ? '0.0.0.0' : '127.0.0.1';
const root = useDist ? resolve(projectRoot, 'dist') : projectRoot;
const MARKER = 'x-daily-planner';
const withApi = flag('api');
// Never expose the well-known "dev" token to other devices on the network.
const adminToken = process.env.ADMIN_TOKEN || (lan ? randomBytes(12).toString('base64url') : 'dev');
const adminTotpSecret = process.env.ADMIN_TOTP_SECRET || '';
const devDataFile = option('data', '') ? resolve(option('data', '')) : resolve(projectRoot, '.planner-dev', 'api.json');
const fakeEmail = flag('fake-email');
const fakeCreem = flag('fake-creem');
const devCountry = /^[A-Za-z]{2}$/.test(option('country', '')) ? option('country', '').toUpperCase() : '';
let plannerApi = null;
let emailMode = 'off';
let plusMode = 'off';
let creemLabel = 'off';
let plusSigningKey = '';
let plusPublicKey = '';
let devLicenses = false;

// Stands in for Resend: prints what would be sent and accepts it.
async function printEmail(url, init) {
  const body = JSON.parse(init.body);
  const messages = Array.isArray(body) ? body : [body];
  const recipients = messages.flatMap(message => message.to);
  console.log(`  [fake email] "${messages[0]?.subject}" → ${recipients.length} ${recipients.length === 1 ? 'recipient' : 'recipients'}: ${recipients.slice(0, 3).join(', ')}${recipients.length > 3 ? ', …' : ''}`);
  // A single email (notification, test, gift link) is printed in full.
  if (!Array.isArray(body)) console.log(String(body.text || '').trimEnd().split('\n').map(line => (line ? `      ${line}` : '')).join('\n'));
  const answer = String(url).endsWith('/batch') ? { data: messages.map((_, index) => ({ id: `fake-${index}` })) } : { id: 'fake-0' };
  return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
}

function emailOptions() {
  const env = process.env;
  const options = {
    resendApiKey: env.RESEND_API_KEY || '',
    emailFrom: env.EMAIL_FROM || '',
    ownerEmail: env.OWNER_EMAIL || '',
    emailDailyLimit: env.EMAIL_DAILY_LIMIT || ''
  };
  if (fakeEmail) {
    emailMode = 'fake, printed here';
    return { ...options, resendApiKey: 'fake', emailFrom: options.emailFrom || 'Daily Planner <planner@example.com>', ownerEmail: options.ownerEmail || 'owner@example.com', emailFetch: printEmail, emailIntervalMs: 0 };
  }
  if (options.resendApiKey && options.emailFrom) emailMode = 'Resend';
  return options;
}

// Links in emails and checkout returns point at this server (the port is known once it listens).
const devBaseUrl = () => (process.env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/+$/, '');

// Stands in for Creem: checkouts opened here (and two shortcuts) are always paid.
const FAKE_PRODUCTS = { plus: { EUR: 'prod_fake_plus_eur', USD: 'prod_fake_plus_usd' }, gift: { EUR: 'prod_fake_gift_eur', USD: 'prod_fake_gift_usd' } };
// What the pretend buyer types in the checkout's field: the company (team gift) or their name (personal gift).
const FAKE_FIELD_ANSWERS = { company: { label: 'Company name, shown to your team', value: 'Acme Studio' }, from: { label: 'Your name, shown with the gift', value: 'Camille' } };
const FAKE_REFUSED_AFFILIATE = 'BADCODE';
const fakeCheckouts = new Map([
  ['fake_plus', { product: FAKE_PRODUCTS.plus.EUR, metadata: { kind: 'plus' }, amount: priceCents('plus', '', 'EUR'), currency: 'EUR', successUrl: '/' }],
  ['fake_gift50', { product: FAKE_PRODUCTS.gift.EUR, metadata: { kind: 'gift', plan: 'up-to-50', seats: '50' }, amount: priceCents('gift', 'up-to-50', 'EUR'), currency: 'EUR', successUrl: '/welcome/thanks/' }]
]);
const fakeJson = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fakeCheckoutEntity(id, fake, status = 'completed') {
  const gift = fake.metadata?.kind === 'gift';
  const fields = gift ? fake.fields || ['company'] : [];
  const buyer = !gift ? { email: 'buyer@example.com', name: 'Sam Buyer' } : fields.includes('from') ? { email: 'camille@example.com', name: 'Camille Martin' } : { email: 'buyer@acme.example', name: 'Ada Lovelace' };
  return {
    id, object: 'checkout', mode: 'test', status, request_id: fake.requestId || null, units: 1, product: fake.product,
    ...(status === 'completed' ? { order: { id: 'ord_fake', object: 'order', status: 'paid', type: 'onetime', amount: fake.amount, amount_paid: fake.amount, currency: fake.currency } } : {}),
    customer: { id: 'cust_fake', object: 'customer', ...buyer, country: 'FR' },
    custom_fields: fields.filter(key => FAKE_FIELD_ANSWERS[key]).map(key => ({ type: 'text', key, label: FAKE_FIELD_ANSWERS[key].label, optional: true, text: { max_length: 80, ...(status === 'completed' ? { value: FAKE_FIELD_ANSWERS[key].value } : {}) } })),
    metadata: fake.metadata || {},
    success_url: new URL(fake.successUrl, `${devBaseUrl()}/`).href,
    checkout_url: `${devBaseUrl()}/__fake-creem/pay?checkout=${encodeURIComponent(id)}`
  };
}

async function fakeCreemFetch(url, init = {}) {
  const target = new URL(url);
  if (target.pathname !== '/v1/checkouts') return fakeJson(404, { message: 'Not found' });
  if (String(init.method || 'GET').toUpperCase() === 'POST') {
    const body = JSON.parse(init.body || '{}');
    const [kind, currency] = Object.entries(FAKE_PRODUCTS).flatMap(([item, ids]) => Object.entries(ids).map(([money, id]) => [item, money, id])).find(([, , id]) => id === body.product_id) || [];
    if (!kind) return fakeJson(404, { message: ['Product not found'] });
    // Like Creem, an unknown partner code refuses the whole checkout.
    if (body.affiliate_code === FAKE_REFUSED_AFFILIATE) {
      console.log(`  [fake creem] refused affiliate code ${body.affiliate_code} (HTTP 400)`);
      return fakeJson(400, { statusCode: 400, message: ['Affiliate code not found'] });
    }
    const id = `ch_fake_${randomBytes(8).toString('hex')}`;
    const fake = { product: body.product_id, metadata: body.metadata || {}, amount: body.custom_price ?? priceCents(kind, body.metadata?.plan, currency), currency, successUrl: body.success_url || '/', requestId: body.request_id, fields: (body.custom_fields || []).map(field => field?.key) };
    fakeCheckouts.set(id, fake);
    const affiliate = body.affiliate_code ? `, affiliate ${body.affiliate_code}` : '';
    console.log(`  [fake creem] opened ${id}: ${kind}${fake.metadata.plan ? ` ${fake.metadata.plan}` : ''}, ${(fake.amount / 100).toFixed(2)} ${currency}${affiliate}`);
    return fakeJson(200, fakeCheckoutEntity(id, fake, 'pending'));
  }
  const id = target.searchParams.get('checkout_id') || '';
  const fake = fakeCheckouts.get(id);
  if (!fake) return fakeJson(404, { message: [`Checkout not found: ${id}`] });
  // The two shortcuts carry the seal the API would have put on a checkout it opened.
  if (!fake.metadata.seal && plusSigningKey) {
    const { kind, plan = '' } = fake.metadata;
    fake.metadata = { ...fake.metadata, currency: fake.currency, rid: id, seal: await checkoutSeal(plusSigningKey, { kind, plan, currency: fake.currency, rid: id }) };
  }
  console.log(`  [fake creem] read ${id}`);
  return fakeJson(200, fakeCheckoutEntity(id, fake));
}

// The pretend payment page: straight back to the checkout's return address, as after a payment.
function fakePayPage(url, response) {
  const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', [MARKER]: '1' };
  const id = url.searchParams.get('checkout') || '';
  const fake = fakeCheckouts.get(id);
  if (!fake) { response.writeHead(404, headers).end('<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Fake Creem checkout</title></head><body><p>This pretend checkout does not exist (the dev server forgets them when it restarts).</p></body></html>\n'); return; }
  const back = new URL(fake.successUrl, `${devBaseUrl()}/`);
  back.searchParams.set('checkout_id', id);
  back.searchParams.set('order_id', 'ord_fake');
  back.searchParams.set('signature', 'fake');
  const href = back.href.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  console.log(`  [fake creem] paid ${id}`);
  response.writeHead(200, headers).end(`<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="0;url=${href}"><title>Fake Creem checkout</title></head><body><p>Pretend payment accepted. Back to <a href="${href}">Daily Planner</a>…</p></body></html>\n`);
}

function creemOptions() {
  const env = process.env;
  const options = { creemApiKey: env.CREEM_API_KEY || '', creemWebhookSecret: env.CREEM_WEBHOOK_SECRET || '', creemTestMode: env.CREEM_TEST_MODE || '', creemProducts: creemProductsFromEnv(env) };
  const webhook = options.creemWebhookSecret ? ', webhook on' : '';
  if (fakeCreem) {
    creemLabel = `fake (/?checkout_id=fake_plus, /welcome/thanks/?checkout_id=fake_gift50${webhook})`;
    return { ...options, creemApiKey: 'creem_test_fake', creemTestMode: '1', creemProducts: FAKE_PRODUCTS, creemFetch: fakeCreemFetch };
  }
  if (options.creemApiKey) creemLabel = `CREEM_API_KEY (${creemMode(options.creemApiKey, options.creemTestMode)} mode${webhook})`;
  return options;
}

async function plusOptions() {
  const fromEnv = (process.env.PLUS_SIGNING_KEY || '').trim();
  if (fromEnv) {
    plusSigningKey = fromEnv;
    plusPublicKey = await publicKeyFromSigningKey(fromEnv);
    plusMode = plusPublicKey ? 'PLUS_SIGNING_KEY' : 'PLUS_SIGNING_KEY is not a valid P-256 key, Plus is off';
  } else {
    ({ signingKey: plusSigningKey, publicKey: plusPublicKey } = await generatePlusKeyPair());
    devLicenses = true;
    plusMode = 'dev keys (new on every start; POST /api/dev/license)';
  }
  return { plusSigningKey };
}

// Served runtime-config.js: the local API, and the public key licences are checked with.
function devRuntimeConfig(source) {
  let text = source.replace("PLANNER_API_URL: ''", "PLANNER_API_URL: '/api'");
  if (plusPublicKey) {
    if (/PLUS_PUBLIC_KEY:\s*''/.test(text)) text = text.replace(/PLUS_PUBLIC_KEY:\s*''/, `PLUS_PUBLIC_KEY: '${plusPublicKey}'`);
    else if (!/PLUS_PUBLIC_KEY\s*:/.test(text)) text = text.replace('Object.freeze({', `Object.freeze({\n  PLUS_PUBLIC_KEY: '${plusPublicKey}',`);
  }
  return text;
}

if (withApi) {
  const saved = await fs.readFile(devDataFile, 'utf8').then(JSON.parse).catch(() => ({}));
  let writeTimer = null;
  const store = createMemoryStore(saved, {
    onChange: data => {
      clearTimeout(writeTimer);
      writeTimer = setTimeout(async () => {
        await fs.mkdir(dirname(devDataFile), { recursive: true });
        await fs.writeFile(devDataFile, JSON.stringify(data, null, 2));
      }, 120);
    }
  });
  plannerApi = createPlannerApi({
    store, adminToken, adminTotpSecret, ...emailOptions(), ...creemOptions(), ...await plusOptions(),
    publicBaseUrl: devBaseUrl
  });
}

async function devLicense(request, response) {
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', [MARKER]: '1' };
  if (request.method !== 'POST') { response.writeHead(405, headers).end(JSON.stringify({ error: 'Method not allowed' })); return; }
  request.resume();
  const license = await signLicense(await importSigningKey(plusSigningKey), { src: 'dev' });
  response.writeHead(200, headers).end(JSON.stringify({ license }));
}

async function handleApi(request, response) {
  const headers = new Headers();
  Object.entries(request.headers).forEach(([key, value]) => { if (value != null) headers.set(key, Array.isArray(value) ? value.join(', ') : value); });
  // Stands in for Cloudflare's country header, which decides the currency in production.
  if (devCountry && !headers.has('cf-ipcountry')) headers.set('cf-ipcountry', devCountry);
  const hasBody = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
  const webRequest = new Request(new URL(request.url, `http://${/^[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(request.headers.host || '') ? request.headers.host : `localhost:${port}`}`), { method: request.method, headers, body: hasBody ? Readable.toWeb(request) : undefined, duplex: 'half' });
  const result = await plannerApi(webRequest);
  response.writeHead(result.status, Object.fromEntries([...result.headers.entries(), [MARKER, '1']]));
  response.end(Buffer.from(await result.arrayBuffer()));
}

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2'
};

try {
  await fs.access(join(root, 'index.html'));
} catch {
  console.error(useDist
    ? 'No production build found. Run "npm run build" first, or start without --dist.'
    : `index.html not found in ${root}.`);
  process.exit(1);
}

async function handle(request, response) {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (devLicenses && url.pathname === '/api/dev/license') { await devLicense(request, response); return; }
    if (plannerApi && fakeCreem && url.pathname === '/__fake-creem/pay') { fakePayPage(url, response); return; }
    if (plannerApi && url.pathname.startsWith('/api/')) { await handleApi(request, response); return; }
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = resolve(root, `.${pathname}`);
    // Never serve paths outside the root, dotfiles (.git, .github) or dependencies.
    // Segments come from the resolved path so "\" separators on Windows are covered too.
    const segments = relative(root, file).split(sep);
    if ((file !== root && !file.startsWith(root + sep)) || segments.some(part => part.startsWith('.') || part === 'node_modules')) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    let target = file;
    const stat = await fs.stat(target).catch(() => null);
    if (stat?.isDirectory()) {
      target = join(target, 'index.html');
      // "/admin" must become "/admin/" so the page's relative links
      // (./admin.css, ./admin.js) resolve inside the folder.
      if (!url.pathname.endsWith('/') && await fs.stat(target).then(found => found.isFile(), () => false)) {
        // One leading slash only: "//host/" would be read as another site.
        response.writeHead(301, { location: `/${url.pathname.replace(/^\/+/, '')}/${url.search}`, 'cache-control': 'no-store', [MARKER]: '1' }).end();
        return;
      }
    }
    let body = await fs.readFile(target);
    // Point the served runtime config at the local API and its Plus public key, unless a build already set them.
    if (plannerApi && relative(root, target) === 'runtime-config.js') body = Buffer.from(devRuntimeConfig(body.toString('utf8')));
    response.writeHead(200, {
      'content-type': types[extname(target).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
      [MARKER]: '1'
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', [MARKER]: '1' }).end('Not found');
  }
}

async function isPlannerRunning(port) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1200);
    const result = await fetch(`http://127.0.0.1:${port}/manifest.webmanifest`, { signal: controller.signal });
    clearTimeout(timer);
    if (result.headers.get(MARKER)) return true;
    return (await result.text()).includes('Daily Planner');
  } catch {
    return false;
  }
}

function openBrowser(url) {
  const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const commandArgs = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(command, commandArgs, { stdio: 'ignore', detached: true, windowsHide: true }).unref();
  } catch {
    console.log(`Open ${url} in your browser.`);
  }
}

function listen(port) {
  return new Promise((resolveListen, rejectListen) => {
    const server = createServer(handle);
    server.once('error', rejectListen);
    server.listen(port, host, () => resolveListen(server));
  });
}

function lanAddresses(port) {
  return Object.values(networkInterfaces()).flat()
    .filter(address => address && address.family === 'IPv4' && !address.internal)
    .map(address => `http://${address.address}:${port}`);
}

let port = preferredPort;
let server = null;
for (let attempt = 0; attempt < 15 && !server; attempt += 1) {
  try {
    server = await listen(port);
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    if (port === preferredPort && await isPlannerRunning(port)) {
      const url = `http://localhost:${port}`;
      console.log(`Daily Planner is already running at ${url}`);
      if (shouldOpen) openBrowser(url);
      process.exit(0);
    }
    if (port === preferredPort) {
      console.warn(`Port ${preferredPort} is used by another program.`);
      console.warn('Heads-up: browsers keep planner data per address, so plans saved on');
      console.warn(`http://localhost:${preferredPort} will not appear on a different port. Free port ${preferredPort} to keep the same data.`);
    }
    port += 1;
  }
}

if (!server) {
  console.error('Could not find a free port. Try: node scripts/serve.mjs --port 9000');
  process.exit(1);
}

const url = `http://localhost:${port}`;
console.log('');
console.log(`  Daily Planner ${useDist ? '(production build)' : '(source)'} is running`);
console.log(`  → ${url}`);
if (lan) lanAddresses(port).forEach(address => console.log(`  → ${address}  (other devices on this network)`));
console.log('');
if (plannerApi) {
  console.log(`  Owner dashboard → ${url}/admin/   (token: ${process.env.ADMIN_TOKEN ? 'from ADMIN_TOKEN' : `${adminToken} — set ADMIN_TOKEN to choose your own`}${adminTotpSecret ? ' · 2FA on' : ''})`);
  console.log(`  Email: ${emailMode} · Plus: ${plusMode} · Creem: ${creemLabel}`);
  if (devCountry) console.log(`  Visitors are treated as in ${devCountry} (currency from the country, as in production)`);
}
console.log('  Your plans stay in this browser. Press Ctrl+C to stop the server.');
console.log('');
if (shouldOpen) openBrowser(url);

const stop = () => server.close(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
