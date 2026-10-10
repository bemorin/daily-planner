// Zero-dependency local server for Daily Planner.
//
//   node scripts/serve.mjs            serve the source tree on http://localhost:8080
//   node scripts/serve.mjs --dist     serve the production build in dist/
//   node scripts/serve.mjs --open     also open the default browser
//   node scripts/serve.mjs --port 9000 --lan
//   node scripts/serve.mjs --api      also run the owner API (waitlist, feedback, team requests, counts)
//   node scripts/serve.mjs --api --data /tmp/api.json   keep the API data in another file
//   node scripts/serve.mjs --api --fake-email            print emails instead of sending them
//   node scripts/serve.mjs --api --fake-stripe           accept two pretend payments (below)
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
// /api/dev/license. --fake-stripe stands in for Stripe: /api/purchases/claim
// accepts cs_test_fake_plus (Plus) and cs_test_fake_gift50 (a gift of 50
// seats for "Acme Studio"); STRIPE_SECRET_KEY and STRIPE_PRICES are used
// otherwise, as in production. Links in emails point at this server unless
// PUBLIC_BASE_URL is set.
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
import { stripeMode } from '../server/stripe.js';

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
const fakeStripe = flag('fake-stripe');
let plannerApi = null;
let emailMode = 'off';
let plusMode = 'off';
let stripeLabel = 'off';
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

// Stands in for Stripe: two paid Checkout Sessions, everything else unknown.
const FAKE_PRICES = { price_fake_plus: { kind: 'plus' }, price_fake_gift50: { kind: 'gift', seats: 50, plan: 'up-to-50' } };
const FAKE_SESSIONS = {
  cs_test_fake_plus: { currency: 'eur', amount_total: 2900, customer_details: { email: 'buyer@example.com', name: 'Sam Buyer' }, custom_fields: [], price: 'price_fake_plus' },
  cs_test_fake_gift50: { currency: 'eur', amount_total: 59500, customer_details: { email: 'buyer@acme.example', name: 'Ada Lovelace' }, custom_fields: [{ key: 'company', type: 'text', text: { value: 'Acme Studio' } }], price: 'price_fake_gift50' }
};

async function fakeStripeFetch(url) {
  const id = decodeURIComponent(new URL(url).pathname.split('/').pop());
  const fake = Object.hasOwn(FAKE_SESSIONS, id) ? FAKE_SESSIONS[id] : null;
  if (!fake) return new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: `No such checkout.session: '${id}'` } }), { status: 404, headers: { 'content-type': 'application/json' } });
  const { price, ...session } = fake;
  console.log(`  [fake stripe] read ${id}`);
  return new Response(JSON.stringify({ id, object: 'checkout.session', mode: 'payment', livemode: false, status: 'complete', payment_status: 'paid', ...session, line_items: { object: 'list', data: [{ object: 'item', quantity: 1, price: { id: price } }] } }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function stripeOptions() {
  if (fakeStripe) {
    stripeLabel = 'fake (cs_test_fake_plus, cs_test_fake_gift50)';
    return { stripeSecretKey: 'sk_test_fake', stripePrices: JSON.stringify(FAKE_PRICES), stripeFetch: fakeStripeFetch };
  }
  const options = { stripeSecretKey: process.env.STRIPE_SECRET_KEY || '', stripePrices: process.env.STRIPE_PRICES || '' };
  if (options.stripeSecretKey && options.stripePrices) stripeLabel = `STRIPE_SECRET_KEY (${stripeMode(options.stripeSecretKey) || 'unknown'} mode)`;
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
    store, adminToken, adminTotpSecret, ...emailOptions(), ...stripeOptions(), ...await plusOptions(),
    // Links in emails point at this server (the port is known once it listens).
    publicBaseUrl: () => process.env.PUBLIC_BASE_URL || `http://localhost:${port}`
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
  const hasBody = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
  const webRequest = new Request(new URL(request.url, 'http://localhost'), { method: request.method, headers, body: hasBody ? Readable.toWeb(request) : undefined, duplex: 'half' });
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
  console.log(`  Email: ${emailMode} · Plus: ${plusMode} · Stripe: ${stripeLabel}`);
}
console.log('  Your plans stay in this browser. Press Ctrl+C to stop the server.');
console.log('');
if (shouldOpen) openBrowser(url);

const stop = () => server.close(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
