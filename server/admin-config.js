// Configuration checks for the owner (1.31). POST /api/admin/config/check,
// behind the owner's sign-in, answers one row per production setting of
// server/config-inventory.js with its state, checked for real and read-only:
//   - D1: a simple read (SELECT 1), then every table, column and index that
//     migrations/0001…0008 create, from sqlite_master (D1 has no extensions or
//     scheduled jobs, and this app keeps no private settings there);
//   - Creem: the key (GET /v1/checkouts with a made-up id: 404 means accepted,
//     401/403 refused), each product (GET /v1/products/{id}: currency, one-time,
//     active, Plus at its price), the webhook (GET /v1/webhooks: one for this
//     site's /api/creem/webhook with the three events, then GET
//     /v1/webhooks/{id}/secret, compared here in constant time with
//     CREEM_WEBHOOK_SECRET and never returned);
//   - Resend: GET /domains (a sending-only key answers 401 restricted_api_key,
//     which still proves the key) and whether EMAIL_FROM's domain is verified;
//   - the Plus keys: a random message signed with PLUS_SIGNING_KEY, verified with
//     the public key the planner was built with;
//   - everything else by its shape (token strength, base32, addresses, links,
//     numbers) and the legal pages' own rules; build variables are compared
//     with what the deployed runtime-config.js was built with.
// Every call has a 5-second timeout and they run side by side (two at most
// one after the other: the webhook's secret after the webhook list, the tables
// after SELECT 1), so the whole check takes 10 seconds at most; none changes
// anything. No value of a secret goes into the answer — only whether it is
// set, its length and the shape recognised (“looks like a Creem live key
// (creem_…)”). A service's own words are dropped after a 401 or a 403 and
// scrubbed otherwise, and the whole answer is scrubbed again before it leaves
// (server/secret-scrub.js). Nothing is stored. `fetch` is injectable, so tests
// never reach the network.

import { base32Decode, timingSafeEqual, TOTP_MIN_SECRET_BYTES } from './admin-auth.js';
import { ADMIN_LIMITS, sharedAdminLimits, waitWords } from './admin-limits.js';
import { CLOUDFLARE, CONFIG_GROUPS, CONFIG_VARIABLES, MIGRATIONS } from './config-inventory.js';
import { creemApiBase, creemMode } from './creem.js';
import { parseAddress } from './email.js';
import { DEFAULT_PUBLIC_BASE_URL, normalizeBaseUrl } from './gifts.js';
import { base64Decode, importSigningKey, importVerifyKey, publicKeyFromSigningKey } from './licenses.js';
import { REFUND_EVENTS } from './refunds.js';
import { formatMoney, PLUS_PRICE } from '../src/lib/pricing.js';
import { emailAddress, legalEmail, legalValueProblem } from '../legal/legal-details.js';
import { scrubAnswer, scrubUpstream, upstreamText } from './secret-scrub.js';

export const CHECK_TIMEOUT_MS = 5000;
/** Checks per 10 minutes and worker isolate (server/admin-limits.js): Cloudflare's rate limiting rule on /api/ is the real guard. */
export const CHECK_LIMIT = ADMIN_LIMITS.check;
export const RESEND_API_URL = 'https://api.resend.com';
export const WEBHOOK_EVENTS = Object.freeze(['checkout.completed', ...Object.keys(REFUND_EVENTS)]);
export const STATES = Object.freeze(['ok', 'problem', 'missing', 'optional-missing', 'untested']);
/** A checkout id nobody has: Creem answers 404 to a key it accepts, 401 or 403 to one it refuses. */
const PROBE_CHECKOUT_ID = 'ch_config_check';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const PRODUCT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;
const GOOGLE_CLIENT_RE = /^\d{6,}-[a-z0-9]{8,}\.apps\.googleusercontent\.com$/;
const ORIGIN_RE = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/;
const FLAG_RE = /^(?:1|true|yes|on)$/i;
const ADMIN_TOKEN_MIN = 32;
const ADMIN_TOKEN_MIN_BITS = 128;
const TOTP_GOOD_BYTES = 20;
const REDEPLOY = `Save, then redeploy: ${CLOUDFLARE.redeploy}.`;

const plural = (count, word, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;
const chars = count => plural(count, 'character');
const listed = items => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items[0] || '');
const lowerFirst = text => text.charAt(0).toLowerCase() + text.slice(1);
const isOn = value => FLAG_RE.test(String(value ?? '').trim());
const money = (cents, currency) => (Number.isFinite(cents) ? (['EUR', 'USD'].includes(currency) ? formatMoney(cents / 100, currency) : `${(cents / 100).toFixed(2)} ${currency}`) : 'no price');
const clip = (value, max = 160) => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
const originOf = value => { try { return new URL(value).origin; } catch { return ''; } };
const hostOf = value => { try { return new URL(value).hostname; } catch { return ''; } };
const timeoutSeconds = ctx => Math.max(1, Math.round(ctx.timeoutMs / 1000));

/** { length, bits, kinds }: a rough strength from the kinds of characters used (letters, digits, symbols). */
export function tokenStrength(value) {
  const text = String(value ?? '');
  const pools = [['letters', /[a-z]/, 26], ['letters', /[A-Z]/, 26], ['digits', /\d/, 10], ['symbols', /[^A-Za-z0-9]/, 33]].filter(([, pattern]) => pattern.test(text));
  const size = pools.reduce((sum, [, , count]) => sum + count, 0);
  return { length: text.length, bits: size > 1 ? Math.floor(text.length * Math.log2(size)) : 0, kinds: listed([...new Set(pools.map(([kind]) => kind))]) };
}

function urlShape(text) {
  if (text.startsWith('/') && !text.startsWith('//')) return 'a path on this site';
  try {
    const { protocol } = new URL(text);
    if (protocol === 'https:') return 'an https address';
    return protocol === 'http:' ? 'an http address (not https)' : 'not a web address';
  } catch { return 'not a web address'; }
}

/** Long and varied enough: at least ADMIN_TOKEN_MIN characters and about ADMIN_TOKEN_MIN_BITS bits. */
const strongToken = text => {
  const strength = tokenStrength(text);
  return strength.length >= ADMIN_TOKEN_MIN && strength.bits >= ADMIN_TOKEN_MIN_BITS;
};

/** How a value looks, in words: its length and the form recognised. Never the value, nor any part of it. */
export function describeShape(def, raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  const length = chars(text.length);
  switch (def?.format) {
    case 'admin-token':
      // Its length and a verdict only: which kinds of characters a secret uses is a part of it.
      return `${length}, ${strongToken(text) ? 'strong' : 'weak'}`;
    case 'totp': {
      const bytes = base32Decode(text);
      return bytes ? `base32, ${length} (${bytes.length * 8} bits)` : `${length}, not base32 (A–Z and 2–7 only)`;
    }
    case 'creem-key':
      if (text.startsWith('creem_test_')) return `looks like a Creem test key (creem_test_…), ${length}`;
      return text.startsWith('creem_') ? `looks like a Creem live key (creem_…), ${length}` : `${length}, not the creem_… form of a Creem key`;
    case 'creem-webhook-secret':
      return text.startsWith('whsec_') ? `looks like a Creem webhook signing secret (whsec_…), ${length}` : `${length}, not the usual whsec_… form`;
    case 'creem-product':
      if (/^prod_[A-Za-z0-9]+$/.test(text)) return 'a Creem product id (prod_…)';
      return PRODUCT_ID_RE.test(text) ? 'an id, not the usual prod_… form' : 'not a product id';
    case 'flag':
      return isOn(text) ? 'on: Creem’s test API' : 'set, but not 1: read as off';
    case 'resend-key':
      return text.startsWith('re_') ? `looks like a Resend API key (re_…), ${length}` : `${length}, not the re_… form of a Resend key`;
    case 'sender':
    case 'email': {
      const address = parseAddress(text);
      if (!address) return 'not an email address';
      return address.name ? 'an address with a name (Name <address>)' : 'a plain email address';
    }
    case 'count':
      return /^\d+$/.test(text) ? 'a whole number' : 'not a whole number';
    case 'plus-signing-key':
    case 'plus-public-key': {
      const bytes = base64Decode(text);
      return bytes ? `base64, ${length} (${plural(bytes.length, 'byte')})` : `${length}, not base64`;
    }
    case 'api-url':
    case 'url':
    case 'url-or-path':
    case 'base-url':
      return urlShape(text);
    case 'origins':
      return plural(text.split(',').map(part => part.trim()).filter(Boolean).length, 'origin');
    case 'google-client-id':
      return GOOGLE_CLIENT_RE.test(text) ? 'looks like a Google OAuth client ID (….apps.googleusercontent.com)' : 'not the ….apps.googleusercontent.com form of a Google client ID';
    case 'legal-email':
      if (!legalEmail(text)) return 'not a plain email address';
      return emailAddress(text) === text ? 'a plain email address' : 'an address with a name or brackets, read as the plain address';
    case 'phone':
      return text.startsWith('+') ? 'a phone number in international form (+…)' : 'a phone number in national form (no +)';
    case 'd1':
      return 'a D1 database binding';
    default:
      return length;
  }
}

/** The values the deployed runtime-config.js holds ({ KEY: 'value' }), or null when it isn't one. Read as text, never run. */
export function parseRuntimeConfig(text) {
  const body = /Object\.freeze\(\{([\s\S]*)\}\)/.exec(String(text ?? ''))?.[1];
  if (body == null) return null;
  const values = {};
  for (const match of body.matchAll(/["']?([A-Z][A-Z0-9_]*)["']?\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g)) {
    const literal = match[2];
    let value = '';
    if (literal.startsWith('"')) { try { value = JSON.parse(literal); } catch { value = ''; } } else value = literal.slice(1, -1).replace(/\\(.)/g, '$1');
    values[match[1]] = String(value).trim();
  }
  return values;
}

const TABLE_CONSTRAINT_RE = /^(?:PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|CHECK|CONSTRAINT)\b/i;

/** Tables (with their columns and their own statement) and indexes (with theirs) a migration creates. */
export function migrationSchema(sql) {
  const tables = [];
  const indexes = [];
  for (const match of String(sql).matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g)) {
    const columns = match[2].split('\n').map(line => line.trim().replace(/,$/, ''))
      .filter(line => line && !TABLE_CONSTRAINT_RE.test(line))
      .map(line => ({ name: line.split(/\s+/)[0], definition: line }));
    tables.push({ name: match[1], columns, body: match[2], sql: match[0] });
  }
  for (const match of String(sql).matchAll(/CREATE INDEX IF NOT EXISTS (\w+) ON (\w+)[^;]*;/g)) indexes.push({ name: match[1], table: match[2], sql: match[0] });
  return { tables, indexes };
}

/**
 * The column names of a CREATE TABLE statement as sqlite_master keeps it: the
 * first word of each column definition (quotes removed), never a type or a
 * constraint, so a column `text` isn't found in `name TEXT`.
 */
export function tableColumns(createSql) {
  const sql = String(createSql ?? '').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
  const open = sql.indexOf('(');
  const close = sql.lastIndexOf(')');
  if (open < 0 || close <= open) return [];
  const parts = [];
  let depth = 0;
  let quote = '';
  let current = '';
  for (const character of sql.slice(open + 1, close)) {
    if (quote) {
      if (character === quote) quote = '';
    } else if (`'"\``.includes(character)) quote = character;
    else if (character === '[') quote = ']';
    else if (character === '(') depth += 1;
    else if (character === ')') depth -= 1;
    else if (character === ',' && depth === 0) { parts.push(current); current = ''; continue; }
    current += character;
  }
  parts.push(current);
  return parts.map(part => part.trim()).filter(part => part && !TABLE_CONSTRAINT_RE.test(part)).map(part => {
    const match = /^(?:"((?:[^"]|"")+)"|`((?:[^`]|``)+)`|\[([^\]]+)\]|'((?:[^']|'')+)'|([^\s(]+))/.exec(part);
    return match ? (match[1]?.replace(/""/g, '"') ?? match[2]?.replace(/``/g, '`') ?? match[3] ?? match[4]?.replace(/''/g, "'") ?? match[5]) : '';
  }).filter(Boolean);
}

// Names compare as SQLite compares them (ASCII case-insensitive): `Mode` is the column `mode`.
const hasColumn = (createSql, column) => tableColumns(createSql).some(name => name.toLowerCase() === String(column).toLowerCase());

/**
 * Whether SQLite's ALTER TABLE … ADD COLUMN accepts this column definition. It
 * refuses a PRIMARY KEY or UNIQUE column, NOT NULL without a default (other
 * than NULL), a default that isn't a constant (CURRENT_TIME…, an expression in
 * parentheses) and a stored generated column.
 */
export function canAddColumn(definition) {
  const text = String(definition ?? '').replace(/'(?:[^']|'')*'/g, "''");
  if (/\bPRIMARY\s+KEY\b|\bUNIQUE\b/i.test(text)) return false;
  if (/\bSTORED\b/i.test(text) && /\b(?:GENERATED|AS)\b/i.test(text)) return false;
  const fallback = /\bDEFAULT\s+(\(|[^\s,]+)/i.exec(text)?.[1] || '';
  if (fallback === '(' || /^CURRENT_(?:TIME|DATE|TIMESTAMP)$/i.test(fallback)) return false;
  return !(/\bNOT\s+NULL\b/i.test(text) && (!fallback || /^NULL$/i.test(fallback)));
}

// ---- Fixes -----------------------------------------------------------------------

/** Steps to set (or edit) a variable on Cloudflare, then redeploy. `copy`: lines the page offers to copy. */
function variableFix(def, { edit = false, value = '', before = [], after = [], copy = [] } = {}) {
  if (def.where === 'binding') {
    return {
      steps: [`${CLOUDFLARE.bindings} → Add → D1 database.`, `Variable name: ${def.name}. D1 database: ${CLOUDFLARE.d1Name} (create it first in Storage & Databases → D1 SQLite Database if it doesn’t exist).`, REDEPLOY],
      copy: [{ label: 'Variable name', text: def.name }]
    };
  }
  return {
    steps: [
      ...before,
      `${CLOUDFLARE.variables} → Production → ${edit ? `edit ${def.name}` : 'Add'}.`,
      `Type: ${def.type}. Variable name: ${def.name}. Value: ${value || def.source}`,
      ...after,
      def.where === 'build' ? `${REDEPLOY} The site is built with it only then.` : `${REDEPLOY} The API reads it from the next deployment on.`
    ],
    copy: [{ label: 'Variable name', text: def.name }, ...copy]
  };
}

const redeployFix = () => ({ steps: [`Redeploy: ${CLOUDFLARE.redeploy}. Nothing else to change.`], copy: [] });

/**
 * Why a column can't be added in place, in words: “a PRIMARY KEY”, “UNIQUE”,
 * “NOT NULL without a default”, “a default that isn't a constant”.
 */
function notAddableWhy(definition) {
  const text = String(definition).replace(/'(?:[^']|'')*'/g, "''");
  const reasons = [
    ...(/\bPRIMARY\s+KEY\b/i.test(text) ? ['a PRIMARY KEY'] : []),
    ...(/\bUNIQUE\b/i.test(text) ? ['UNIQUE'] : []),
    ...(/\bNOT\s+NULL\b/i.test(text) && !/\bDEFAULT\s+(?!NULL\b)\S/i.test(text) && !/\bINTEGER\s+PRIMARY\s+KEY\b/i.test(text) ? ['NOT NULL without a default'] : [])
  ];
  return reasons.length ? listed(reasons) : 'a default that isn’t a constant';
}

/**
 * The fix of a migration not fully applied: the SQL to run in the D1 console,
 * in the order to run it. A missing column SQLite can add in place gets its
 * ALTER TABLE line, run first (the file skips a table that exists, and its
 * indexes may need the column). A table missing a column SQLite can't add in
 * place (canAddColumn) is rebuilt in two steps that never lose a row: copy
 * every row into a complete new table (this fails, changing nothing, when rows
 * exist and a NOT NULL column has no value for them), then, only if the copy
 * worked, switch the tables, keeping the old one under another name. Then the
 * whole file, safe to run again.
 */
function migrationFix(migration, missing = [], tableSql = new Map(), day = '') {
  const schema = migrationSchema(migration.sql);
  const rebuilt = [...new Set(missing.filter(entry => !canAddColumn(entry.column.definition)).map(entry => entry.table))];
  const alters = missing.filter(entry => !rebuilt.includes(entry.table))
    .map(({ table, column }) => `ALTER TABLE ${table} ADD COLUMN ${column.definition};`);
  const steps = [`${CLOUDFLARE.d1Console}.`];
  const copy = [];
  if (alters.length) {
    steps.push(`First run the ALTER TABLE ${alters.length === 1 ? 'line' : 'lines'} below (Missing column): running the file doesn’t add a column to a table that exists, and its indexes may need ${alters.length === 1 ? 'it' : 'them'}.`);
    copy.push({ label: 'Missing column', text: alters.join('\n'), kind: 'sql' });
  }
  for (const name of rebuilt) {
    const table = schema.tables.find(entry => entry.name === name);
    const lacking = missing.filter(entry => entry.table === name).map(entry => entry.column);
    const old = `${name}_before_${day || 'fix'}`;
    const scratch = `${name}_rebuild`;
    const have = new Set(tableColumns(tableSql.get(name)).map(column => column.toLowerCase()));
    const common = table.columns.map(column => column.name).filter(column => have.has(column.toLowerCase())).join(', ');
    const hard = lacking.filter(column => !canAddColumn(column.definition));
    // Columns existing rows can't be given a value for: NOT NULL without a default (an INTEGER PRIMARY KEY numbers itself).
    const noValue = lacking.filter(column => /\bNOT\s+NULL\b/i.test(column.definition) && !/\bDEFAULT\s+(?!NULL\b)\S/i.test(column.definition) && !/\bINTEGER\s+PRIMARY\s+KEY\b/i.test(column.definition));
    steps.push(`${alters.length || rebuilt.indexOf(name) > 0 ? 'Then r' : 'First r'}ebuild ${name}, keeping its rows: SQLite can’t add ${listed(hard.map(column => `${column.name} (${notAddableWhy(column.definition)})`))} to a table that exists. Run “Rebuild ${name}, 1 of 2”: it copies every row into a complete new table, ${scratch}, and changes nothing else.`);
    if (noValue.length) steps.push(`If ${name} has rows, that copy fails (“NOT NULL constraint failed”): its rows have no value for ${listed(noValue.map(column => column.name))}. Nothing has changed then: stop there and ask for help (Copy summary), and don’t run 2 of 2.`);
    steps.push(`Only if 1 of 2 ran without an error, run “Rebuild ${name}, 2 of 2”: ${name} becomes the complete table, and the old one is kept as ${old} (delete it later with DROP TABLE ${old}; once this page says OK).`);
    copy.push({
      label: `Rebuild ${name}, 1 of 2`,
      text: [`DROP TABLE IF EXISTS ${scratch};`, `CREATE TABLE ${scratch} (${table.body.replace(/\s*\n\s*/g, ' ').trim()});`, ...(common ? [`INSERT INTO ${scratch} (${common}) SELECT ${common} FROM ${name};`] : [])].join('\n'),
      kind: 'sql'
    });
    copy.push({
      label: `Rebuild ${name}, 2 of 2`,
      text: [...schema.indexes.filter(index => index.table === name).map(index => `DROP INDEX IF EXISTS ${index.name};`), `ALTER TABLE ${name} RENAME TO ${old};`, `ALTER TABLE ${scratch} RENAME TO ${name};`].join('\n'),
      kind: 'sql'
    });
  }
  steps.push(`${copy.length ? 'Then paste' : 'Paste'} the SQL of migrations/${migration.file} (below: the whole file, safe to run again) and select Run.`, 'Then check again here.');
  const terminal = [...alters.map(line => `npx wrangler d1 execute ${CLOUDFLARE.d1Name} --remote --command="${line}"`), `npx wrangler d1 execute ${CLOUDFLARE.d1Name} --remote --file=migrations/${migration.file}`];
  copy.push({ label: `SQL of ${migration.file}`, text: migration.sql, kind: 'sql' });
  if (!rebuilt.length) copy.push({ label: 'Or from a terminal', text: terminal.join('\n') });
  return { steps, copy };
}

// ---- HTTP --------------------------------------------------------------------

/** One read-only call: { status, data } (status 0 with `error` 'timeout' or 'network'). Never longer than the timeout. */
async function request(ctx, url, headers) {
  const controller = new AbortController();
  let timer = 0;
  const timeout = new Promise(resolveTimeout => {
    timer = setTimeout(() => { controller.abort(); resolveTimeout({ status: 0, error: 'timeout' }); }, ctx.timeoutMs);
  });
  const call = (async () => {
    try {
      const response = await ctx.fetch(url, { method: 'GET', headers, signal: controller.signal });
      const data = await response.json().catch(() => null);
      return { status: response.status, data };
    } catch {
      return { status: 0, error: controller.signal.aborted ? 'timeout' : 'network' };
    }
  })();
  try { return await Promise.race([call, timeout]); } finally { clearTimeout(timer); }
}

function withTimeout(promise, ms) {
  let timer = 0;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { timeout: true })), ms); })
  ]).finally(() => clearTimeout(timer));
}

/** A service's own words, only when they can't hold a secret (server/secret-scrub.js): none after a 401 or a 403. */
const upstreamMessage = (ctx, answer) => {
  const message = Array.isArray(answer.data?.message) ? answer.data.message.join(', ') : answer.data?.message ?? answer.data?.error ?? '';
  return typeof message === 'string' ? upstreamText(answer.status, message, ctx.secrets, 160) : '';
};

/** Why a service gave no usable answer, in words. */
function noAnswer(service, answer, seconds) {
  if (answer.error === 'timeout') return `${service} didn’t answer within ${plural(seconds, 'second')}. Check again in a minute.`;
  if (answer.error) return `${service} couldn’t be reached. Check again in a minute.`;
  if (answer.status === 429) return `${service} is limiting requests (HTTP 429). Check again in a minute.`;
  if (answer.status >= 500) return `${service} had a problem (HTTP ${answer.status}). Check again in a few minutes.`;
  return `${service} gave an unexpected answer (HTTP ${answer.status}).`;
}

// ---- The checks --------------------------------------------------------------

function patch(item, fields) {
  if (item) Object.assign(item, fields);
}

function checkSignIn(ctx, items) {
  const token = ctx.value('ADMIN_TOKEN');
  const tokenItem = items.get('ADMIN_TOKEN');
  tokenItem.test = 'Its length and how hard it is to guess (its value is never shown, nor what it is made of).';
  if (token) {
    if (!strongToken(token)) {
      patch(tokenItem, {
        state: 'problem',
        summary: `Weak: easy to guess. Use at least ${ADMIN_TOKEN_MIN} random letters and digits (Generate a value below).`,
        fix: variableFix(configVariableOf('ADMIN_TOKEN'), { edit: true, value: 'a new token: Generate a value below.', after: ['Changing it signs every session out: sign in again with the new token.', 'It also changes every partner’s private statement link and every waitlist removal link: the old ones stop working. Copy each partner’s new link from the Partners card and send it to them.'] })
      });
    } else patch(tokenItem, { summary: 'Long and varied enough to resist guessing.' });
  }
  const secret = ctx.value('ADMIN_TOTP_SECRET');
  const totpItem = items.get('ADMIN_TOTP_SECRET');
  totpItem.test = 'Decoded the way sign-in decodes it.';
  if (!secret) {
    patch(totpItem, { summary: 'Not set: the token alone opens the dashboard and this page.' });
    return;
  }
  const bytes = base32Decode(secret);
  if (!bytes || bytes.length < TOTP_MIN_SECRET_BYTES) {
    patch(totpItem, { state: 'problem', summary: 'Not usable base32 (A–Z and 2–7, at least 16 characters): every admin route answers 503.', fix: variableFix(configVariableOf('ADMIN_TOTP_SECRET'), { edit: true, value: 'a new setup key: Generate a value below, and add it to your authenticator app first.' }) });
  } else if (bytes.length < TOTP_GOOD_BYTES) {
    patch(totpItem, { summary: `Two-factor sign-in is on. ${bytes.length * 8} bits is accepted; 160 bits (32 characters) is the usual size.` });
  } else patch(totpItem, { summary: 'Two-factor sign-in is on.' });
}

function checkAddresses(ctx, items) {
  const baseItem = items.get('PUBLIC_BASE_URL');
  const raw = ctx.value('PUBLIC_BASE_URL');
  baseItem.test = 'Read the way the API reads it, then compared with the address of this page.';
  if (!raw) patch(baseItem, { summary: `Not set: ${DEFAULT_PUBLIC_BASE_URL} is used in emails and checkout returns.` });
  else {
    const base = normalizeBaseUrl(raw);
    if (!base) patch(baseItem, { state: 'problem', summary: `Not an http(s) address: ${DEFAULT_PUBLIC_BASE_URL} is used instead.`, fix: variableFix(configVariableOf('PUBLIC_BASE_URL'), { edit: true }) });
    else if (new URL(base).protocol !== 'https:' && !LOCAL_HOSTS.has(new URL(base).hostname)) patch(baseItem, { state: 'problem', summary: 'Not https: links in emails and checkout returns would use plain http.', fix: variableFix(configVariableOf('PUBLIC_BASE_URL'), { edit: true }) });
    else if (ctx.production) patch(baseItem, { summary: 'An https address, and this page is open on it.' });
    else patch(baseItem, { summary: ctx.local ? 'An address; this local server isn’t it, as expected.' : 'An https address. This page is open on another one (a preview or the .pages.dev address), which is fine.' });
  }

  const originsItem = items.get('ALLOWED_ORIGINS');
  const origins = ctx.value('ALLOWED_ORIGINS');
  originsItem.test = 'Each entry compared with the form browsers send (scheme and host, no path).';
  if (origins) {
    const parts = origins.split(',').map(part => part.trim()).filter(Boolean);
    const bad = parts.filter(part => !ORIGIN_RE.test(part));
    if (bad.length) patch(originsItem, { state: 'problem', summary: `${plural(bad.length, 'entry', 'entries')} of ${parts.length} ${bad.length === 1 ? 'isn’t an origin' : 'aren’t origins'} (scheme and host only, no path or trailing slash): browsers there are refused.`, fix: variableFix(configVariableOf('ALLOWED_ORIGINS'), { edit: true }) });
    else patch(originsItem, { summary: `${plural(parts.length, 'other site')} may call the API from a browser.` });
  }
}

function checkEmailSettings(ctx, items) {
  const fromItem = items.get('EMAIL_FROM');
  const from = ctx.value('EMAIL_FROM');
  if (from && !parseAddress(from)) patch(fromItem, { state: 'problem', summary: 'Not an email address: nothing can be sent until it is one.', fix: variableFix(configVariableOf('EMAIL_FROM'), { edit: true }) });
  const ownerItem = items.get('OWNER_EMAIL');
  const owner = ctx.value('OWNER_EMAIL');
  ownerItem.test = 'Read the way the API reads it. Send me a test email tries the whole path.';
  if (owner) {
    if (!parseAddress(owner)) patch(ownerItem, { state: 'problem', summary: 'Not an email address: notifications and test emails have nowhere to go.', fix: variableFix(configVariableOf('OWNER_EMAIL'), { edit: true }) });
    else patch(ownerItem, { summary: 'An email address: notifications and test emails go there.' });
  }
  const limitItem = items.get('EMAIL_DAILY_LIMIT');
  const limit = ctx.value('EMAIL_DAILY_LIMIT');
  if (limit) {
    if (!/^\d+$/.test(limit)) patch(limitItem, { state: 'problem', summary: 'Not a whole number: the default, 100 a day, is used instead.', fix: variableFix(configVariableOf('EMAIL_DAILY_LIMIT'), { edit: true }) });
    else if (Number(limit) === 0) patch(limitItem, { state: 'problem', summary: '0 stops every email, notifications and buyers’ links included.', fix: variableFix(configVariableOf('EMAIL_DAILY_LIMIT'), { edit: true }) });
    else patch(limitItem, { summary: 'A whole number: the most emails sent per UTC day.' });
  }
}

/** The value of a build variable as the site serves it (the built runtime-config.js), else as set now. */
const builtValue = (ctx, def) => (ctx.built ? String(ctx.built[def.runtimeKey] ?? '').trim() : ctx.value(def.name));

/** Link and form checks of the build variables, then each one compared with the value the site was built with. */
function checkBuildVariables(ctx, items) {
  for (const def of CONFIG_VARIABLES.filter(entry => entry.where === 'build')) {
    const item = items.get(def.name);
    const value = builtValue(ctx, def);
    item.shape = describeShape(def, value);
    if (!value) {
      item.state = def.level === 'optional' ? 'optional-missing' : 'missing';
      item.summary = def.level === 'optional' ? `Not set. ${def.blocks}` : 'Not set.';
      item.fix = variableFix(def);
    } else {
      item.state = 'ok';
      item.fix = null;
      buildFormat(ctx, def, item, value);
    }
    if (def.format === 'plus-public-key') item.test = 'A random message signed with PLUS_SIGNING_KEY on the server, verified with this key.';
    if (!ctx.built) continue;
    const set = ctx.value(def.name);
    if (set === value) continue;
    const said = !value ? 'Set, but the deployed site was built without it.' : !set ? 'The deployed site was built with a value this deployment’s variables don’t have any more: the next deployment drops it.' : 'The deployed site was built with another value than the one set now.';
    item.state = 'problem';
    item.summary = `${said} ${!set ? 'Set it again, or leave it blank on purpose.' : 'Retry the deployment so the site uses it.'}`;
    item.fix = set ? redeployFix() : variableFix(def);
  }
}

function buildFormat(ctx, def, item, value) {
  const problem = (summary, extra = {}) => Object.assign(item, { state: 'problem', summary, fix: variableFix(def, { edit: true, ...extra }) });
  switch (def.format) {
    case 'api-url': {
      item.test = 'Resolved from this page’s address, as the planner resolves it.';
      let target = null;
      try { target = new URL(value, `${ctx.origin || ctx.base}/`); } catch { target = null; }
      if (!target || !/^https?:$/.test(target.protocol)) return problem('Not an address the planner can call: it never reaches the API.', { value: '/api' });
      if (target.pathname.replace(/\/+$/, '') !== '/api') return problem('Doesn’t end in /api: the planner calls an address where no API answers.', { value: '/api' });
      if (ctx.origin && target.origin !== ctx.origin) return problem('Points to the API of another site: this deployment’s API isn’t the one the planner uses.', { value: '/api' });
      item.summary = 'Points to this site’s own API, which is answering now.';
      return;
    }
    case 'url':
      item.test = 'Its form only: the link itself isn’t opened from here.';
      if (!/^https:\/\/[^\s"'<>]+$/.test(value)) return problem('Not an https link: the pages leave it out.');
      item.summary = def.name === 'DAILY_PLANNER_AFFILIATE_URL' && !/(?:^|\.)creem\.io$/i.test(hostOf(value)) ? 'An https link, but not on creem.io: check it is the Affiliate Hub’s sign-up link.' : 'An https link.';
      return;
    case 'url-or-path':
      if (!/^https:\/\/[^\s"'<>]+$/.test(value) && !(value.startsWith('/') && !value.startsWith('//'))) return problem('Neither an https address nor a path on this site.');
      item.summary = 'An address the planner can call.';
      return;
    case 'google-client-id':
      item.test = 'Its form only: Google has no read-only check for a client ID.';
      if (!GOOGLE_CLIENT_RE.test(value)) return problem('Doesn’t look like a Google OAuth client ID (….apps.googleusercontent.com): Personal sync can’t sign in.');
      Object.assign(item, { state: 'untested', summary: 'Looks right. Google has no read-only check for a client ID: connect Google Drive in the planner (Settings → Personal sync) to try it.' });
      return;
    case 'legal-email':
    case 'phone': {
      item.test = 'The legal pages’ own rules (legal/legal-details.js).';
      const why = legalValueProblem(def.runtimeKey, value);
      if (why) return problem(`Set, but the legal pages leave it out: ${why}.`);
      item.summary = def.format === 'phone' ? 'A phone number the legal notice shows, with a link that dials it.' : 'A plain address, shown as a mailto: link.';
      return;
    }
    case 'text':
      item.summary = 'Shown on the legal pages as it is, on one line.';
      return;
    default:
      item.summary = 'Set.';
  }
}

async function checkPlus(ctx, items) {
  const keyItem = items.get('PLUS_SIGNING_KEY');
  const publicItem = items.get('DAILY_PLANNER_PLUS_PUBLIC_KEY');
  const publicDef = configVariableOf('DAILY_PLANNER_PLUS_PUBLIC_KEY');
  const signing = ctx.value('PLUS_SIGNING_KEY');
  keyItem.test = 'A random message signed with it here, then verified with its own public key.';
  const appKey = builtValue(ctx, publicDef);
  if (!signing) {
    if (appKey && publicItem.state === 'ok') patch(publicItem, { state: 'untested', summary: 'Not checked: PLUS_SIGNING_KEY is missing.' });
    return;
  }
  const key = await importSigningKey(signing);
  if (!key) {
    patch(keyItem, { state: 'problem', shape: `${chars(signing.length)}, not a base64 PKCS#8 ECDSA P-256 private key`, summary: 'Not a usable P-256 private key: Plus is off, so no purchase, gift or licence can be delivered.', fix: variableFix(configVariableOf('PLUS_SIGNING_KEY'), { edit: true, value: 'the PLUS_SIGNING_KEY kept in your password manager, or a new pair (Generate a value below).' }) });
    if (appKey) patch(publicItem, { state: publicItem.state === 'ok' ? 'untested' : publicItem.state, summary: publicItem.state === 'ok' ? 'Not checked: PLUS_SIGNING_KEY isn’t usable.' : publicItem.summary });
    return;
  }
  // A usable signing key: replacing the pair would invalidate every licence, so no value is generated for it any more.
  delete keyItem.generate;
  delete publicItem.generate;
  keyItem.shape = `base64 PKCS#8 ECDSA P-256 private key, ${chars(signing.length)}`;
  const publicKey = await publicKeyFromSigningKey(signing);
  const message = crypto.getRandomValues(new Uint8Array(32));
  const algorithm = { name: 'ECDSA', hash: 'SHA-256' };
  const signature = await crypto.subtle.sign(algorithm, key, message);
  const verifies = async candidate => {
    const verifyKey = await importVerifyKey(candidate);
    if (!verifyKey) return null;
    try { return await crypto.subtle.verify(algorithm, verifyKey, signature, message); } catch { return false; }
  };
  if (!await verifies(publicKey)) {
    patch(keyItem, { state: 'problem', summary: 'Its signature doesn’t verify with its own public key: the key is damaged. Paste it again from your password manager.', fix: variableFix(configVariableOf('PLUS_SIGNING_KEY'), { edit: true }) });
    return;
  }
  patch(keyItem, { summary: 'Signs: a random message signed with it verified with its own public key.' });
  const copy = [{ label: 'Public key', text: publicKey }];
  if (!appKey) {
    patch(publicItem, { state: 'missing', summary: 'The planner has no public key: Plus can’t be activated in it.', fix: variableFix(publicDef, { value: 'the public key below (it is public: it goes into runtime-config.js).', copy }) });
    return;
  }
  if (publicItem.state === 'problem' && ctx.built && ctx.value(publicDef.name) !== appKey && await verifies(ctx.value(publicDef.name))) return;
  const result = await verifies(appKey);
  if (result !== null) publicItem.shape = `base64 SPKI ECDSA P-256 public key, ${chars(appKey.length)}`;
  if (result === null) {
    patch(publicItem, { state: 'problem', summary: 'Not a base64 SPKI P-256 public key: Plus can’t be activated in the planner.', fix: variableFix(publicDef, { edit: true, value: 'the public key below.', copy }) });
  } else if (!result) {
    patch(publicItem, {
      state: 'problem',
      summary: 'Doesn’t match PLUS_SIGNING_KEY: licences issued now won’t verify in the planner.',
      fix: variableFix(publicDef, { edit: true, value: 'the public key below, the one of PLUS_SIGNING_KEY.', copy, before: ['If licences were already sold with the signing key that matches the planner’s key, put that signing key back into PLUS_SIGNING_KEY instead: changing the planner’s key invalidates them.'] })
    });
  } else if (publicItem.state === 'ok') {
    patch(publicItem, { summary: 'Matches PLUS_SIGNING_KEY: a random message signed by the API verified with the key the planner was built with.' });
  }
}

const readProduct = data => ({
  name: clip(data?.name, 80),
  price: Number.isFinite(data?.price) ? Math.round(data.price) : null,
  currency: String(data?.currency ?? '').trim().toUpperCase(),
  billingType: String(data?.billing_type ?? '').trim().toLowerCase(),
  status: String(data?.status ?? '').trim().toLowerCase(),
  taxMode: String(data?.tax_mode ?? '').trim().toLowerCase()
});

const urlKey = value => {
  try {
    const url = new URL(String(value ?? '').trim());
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch { return ''; }
};

/** Where Creem should send events for this deployment: the production address, or this page's own (a preview). */
const webhookTarget = ctx => `${ctx.production || !ctx.origin || (ctx.local && ctx.value('PUBLIC_BASE_URL')) ? ctx.base : ctx.origin}/api/creem/webhook`;

function webhookFix(ctx, mode, edit) {
  const modeWord = mode === 'test' ? 'on' : 'off';
  return {
    steps: [
      `Creem, with Test mode ${modeWord} → Developers → Webhooks → Add endpoint (or open the one for this site).`,
      `URL: the webhook URL below. Events: ${listed(WEBHOOK_EVENTS)}.`,
      'Save, then copy its signing secret (whsec_…).',
      `${CLOUDFLARE.variables} → Production → ${edit ? 'edit CREEM_WEBHOOK_SECRET' : 'Add'}. Type: Secret. Variable name: CREEM_WEBHOOK_SECRET. Value: that signing secret.`,
      REDEPLOY
    ],
    copy: [{ label: 'Webhook URL', text: webhookTarget(ctx) }, { label: 'Events', text: WEBHOOK_EVENTS.join(', ') }, { label: 'Variable name', text: 'CREEM_WEBHOOK_SECRET' }]
  };
}

async function checkCreem(ctx, items) {
  const key = ctx.value('CREEM_API_KEY');
  const flag = ctx.value('CREEM_TEST_MODE');
  const mode = creemMode(key, flag);
  const modeWord = mode === 'test' ? 'test' : 'live';
  const keyItem = items.get('CREEM_API_KEY');
  const secretItem = items.get('CREEM_WEBHOOK_SECRET');
  const flagItem = items.get('CREEM_TEST_MODE');
  const productDefs = CONFIG_VARIABLES.filter(def => def.format === 'creem-product');
  const liveLooking = key.startsWith('creem_') && !key.startsWith('creem_test_');
  keyItem.test = 'Creem: GET /v1/checkouts with a made-up id, read-only (404 means the key was accepted).';
  secretItem.test = 'Creem: GET /v1/webhooks, then that webhook’s signing secret, compared here in constant time and never sent back.';
  for (const def of productDefs) items.get(def.name).test = 'Creem: GET /v1/products/{id}, read-only.';
  flagItem.test = 'Compared with the form of CREEM_API_KEY.';

  if (flag) {
    if (isOn(flag) && liveLooking) patch(flagItem, { state: 'problem', summary: 'On, but CREEM_API_KEY looks like a live key, and Creem’s test API refuses live keys.', fix: { steps: [`${CLOUDFLARE.variables} → Production → delete CREEM_TEST_MODE (a creem_test_ key already means test mode).`, REDEPLOY], copy: [{ label: 'Variable name', text: 'CREEM_TEST_MODE' }] } });
    else if (isOn(flag)) patch(flagItem, { summary: key.startsWith('creem_test_') ? 'On: every Creem call goes to the test API. Not needed: a creem_test_ key already means test mode.' : 'On: every Creem call goes to the test API.' });
    else patch(flagItem, { summary: 'Set, but not 1: read as off.' });
  }

  // Product ids: their form, and no id used twice, before asking Creem.
  const seen = new Map();
  const toRead = [];
  for (const def of productDefs) {
    const id = ctx.value(def.name);
    const item = items.get(def.name);
    if (!id) continue;
    if (!PRODUCT_ID_RE.test(id)) patch(item, { state: 'problem', summary: 'Not a product id: checkouts in this currency fail.', fix: variableFix(def, { edit: true }) });
    else if (seen.has(id)) patch(item, { state: 'problem', summary: `Repeats the id of ${seen.get(id)}: each product needs its own id, so this one is ignored.`, fix: variableFix(def, { edit: true }) });
    else { seen.set(id, def.name); toRead.push(def); }
  }

  if (!key) {
    for (const def of toRead) patch(items.get(def.name), { state: 'untested', summary: 'Not checked: CREEM_API_KEY is missing.' });
    if (ctx.value('CREEM_WEBHOOK_SECRET')) patch(secretItem, { state: 'untested', summary: 'Not tested: CREEM_API_KEY is missing.' });
    else secretItem.fix = webhookFix(ctx, 'live', false);
    return;
  }

  const base = creemApiBase(mode);
  const headers = { 'x-api-key': key, accept: 'application/json' };
  const [probe, products, hooks] = await Promise.all([
    request(ctx, `${base}/v1/checkouts?checkout_id=${PROBE_CHECKOUT_ID}`, headers),
    Promise.all(toRead.map(def => request(ctx, `${base}/v1/products/${encodeURIComponent(ctx.value(def.name))}`, headers))),
    request(ctx, `${base}/v1/webhooks?page_number=1&page_size=50`, headers)
  ]);
  const seconds = timeoutSeconds(ctx);
  const refused = [401, 403].includes(probe.status);

  // The key.
  if ([200, 400, 404].includes(probe.status)) {
    if (mode === 'test' && ctx.production) {
      patch(keyItem, { state: 'problem', summary: 'A valid test key: Creem accepted it. On the production address, test mode switches buying off: put the live key here once Creem has approved your store.', fix: variableFix(configVariableOf('CREEM_API_KEY'), { edit: true, value: 'the live key from Creem → Developers → API keys, with Test mode off.', after: [...(flag ? ['Delete CREEM_TEST_MODE too.'] : []), 'Live mode has its own products and webhook: put their ids and signing secret here as well.'] }) });
    } else patch(keyItem, { summary: `Valid: Creem accepted it (${modeWord} mode).` });
  } else if (refused) {
    const hint = isOn(flag) && liveLooking ? 'CREEM_TEST_MODE sends this live key to the test API: delete CREEM_TEST_MODE.'
      : mode === 'test' ? 'Copy the key again from Creem → Developers → API keys, with Test mode on.'
        : 'Copy the live key again from Creem → Developers → API keys, with Test mode off (a test key starts with creem_test_).';
    patch(keyItem, { state: 'problem', summary: `Creem refused it in ${modeWord} mode (HTTP ${probe.status}). ${hint}`, fix: variableFix(configVariableOf('CREEM_API_KEY'), { edit: true }) });
  } else patch(keyItem, { state: 'untested', summary: noAnswer('Creem', probe, seconds) });

  // The products.
  toRead.forEach((def, index) => {
    const item = items.get(def.name);
    const answer = products[index];
    if (refused) { patch(item, { state: 'untested', summary: 'Not checked: Creem refused CREEM_API_KEY.' }); return; }
    if (answer.status === 200 && answer.data && typeof answer.data === 'object') {
      const product = readProduct(answer.data);
      const problems = [];
      if (product.currency && product.currency !== def.currency) problems.push(`it is in ${product.currency}, and ${def.name} needs a ${def.currency} product`);
      if (product.billingType && product.billingType !== 'onetime') problems.push('it is a subscription, and Plus and gifts are paid once');
      if (product.status === 'archived') problems.push('it is archived, so checkouts can’t use it');
      const expected = def.item === 'plus' ? Math.round(PLUS_PRICE[def.currency] * 100) : null;
      if (expected != null && product.price !== expected) problems.push(`its price is ${money(product.price, product.currency || def.currency)}, and the site sells Plus at ${money(expected, def.currency)} (PLUS_PRICE in src/lib/pricing.js)`);
      if (product.taxMode === 'exclusive') problems.push('its price is tax exclusive, so buyers would pay tax on top of the price the site shows');
      const named = product.name ? `“${product.name}”` : 'the product';
      if (problems.length) {
        patch(item, {
          state: 'problem',
          summary: `Found in Creem (${modeWord} mode), but ${problems.join('; ')}.`,
          fix: { steps: [`Creem, with Test mode ${mode === 'test' ? 'on' : 'off'} → Products → ${named} → Edit, and correct it; or create a one-time, tax-inclusive product${expected != null ? ` at ${money(expected, def.currency)}` : ''} in ${def.currency} (the Creem setup assistant below can) and put its id in ${def.name}.`, REDEPLOY], copy: [{ label: 'Variable name', text: def.name }] }
        });
      } else {
        const tax = product.taxMode === 'inclusive' ? ', tax inclusive' : '';
        patch(item, { summary: def.item === 'plus' ? `Found in Creem (${modeWord} mode): ${named}, ${money(product.price, product.currency)}, one-time${tax}.` : `Found in Creem (${modeWord} mode): ${named}, one-time, in ${product.currency || def.currency}${tax}. Each gift sets its own price at checkout.` });
      }
    } else if ([400, 404].includes(answer.status)) {
      patch(item, {
        state: 'problem',
        summary: `Creem has no product with this id in ${modeWord} mode. Test and live products have different ids.`,
        fix: variableFix(def, { edit: true, value: `the id (prod_…) from Creem → Products, with Test mode ${mode === 'test' ? 'on' : 'off'}.`, after: ['No such product in Creem yet? The Creem setup assistant below creates it and gives you its id.'] })
      });
    } else if ([401, 403].includes(answer.status)) {
      patch(item, { state: 'untested', summary: `Creem didn’t let this key read products (HTTP ${answer.status}): check this one in Creem → Products.` });
    } else patch(item, { state: 'untested', summary: noAnswer('Creem', answer, seconds) });
  });

  // The webhook and its signing secret.
  const secret = ctx.value('CREEM_WEBHOOK_SECRET');
  if (refused) {
    if (secret) patch(secretItem, { state: 'untested', summary: 'Not checked: Creem refused CREEM_API_KEY.' });
    else secretItem.fix = webhookFix(ctx, mode, false);
    return;
  }
  if (hooks.status !== 200 || !Array.isArray(hooks.data?.items)) {
    const why = [401, 403, 404].includes(hooks.status) ? `Creem didn’t let this key list webhooks (HTTP ${hooks.status}), so it can’t be compared. Check in Creem → Developers → Webhooks that the webhook of this site has this signing secret.` : noAnswer('Creem', hooks, seconds);
    if (secret) patch(secretItem, { state: 'untested', summary: why });
    else secretItem.fix = webhookFix(ctx, mode, false);
    return;
  }
  const targets = new Set([webhookTarget(ctx), `${ctx.base}/api/creem/webhook`, ...(ctx.origin ? [`${ctx.origin}/api/creem/webhook`] : [])].map(urlKey));
  const matching = hooks.data.items.filter(hook => targets.has(urlKey(hook?.url)));
  const hook = matching.find(entry => String(entry?.status ?? '').toLowerCase() !== 'disabled') || matching[0];
  if (!hook) {
    patch(secretItem, { state: secret ? 'problem' : 'missing', summary: `${secret ? 'Set, but n' : 'N'}o webhook in Creem (${modeWord} mode) sends events to this site’s /api/creem/webhook: refunds don’t switch Plus off.`, fix: webhookFix(ctx, mode, !!secret) });
    return;
  }
  const events = Array.isArray(hook.events) ? hook.events.map(String) : [];
  const missingEvents = WEBHOOK_EVENTS.filter(event => !events.includes(event));
  const hookProblems = [
    ...(missingEvents.length ? [`doesn’t send ${listed(missingEvents)}`] : []),
    ...(String(hook.status ?? '').toLowerCase() === 'disabled' ? ['is disabled'] : [])
  ];
  const hookFix = { steps: [`Creem, with Test mode ${mode === 'test' ? 'on' : 'off'} → Developers → Webhooks → the webhook of this site → Edit: enable it and tick ${listed(WEBHOOK_EVENTS)}.`, 'Save. Nothing changes on Cloudflare.'], copy: [{ label: 'Events', text: WEBHOOK_EVENTS.join(', ') }] };
  if (!secret) {
    patch(secretItem, { summary: 'Not set. Creem has a webhook for this site: copy its signing secret.', fix: webhookFix(ctx, mode, false) });
    return;
  }
  if (!hook.id || !/^[A-Za-z0-9_-]{1,200}$/.test(String(hook.id))) {
    patch(secretItem, { state: 'untested', summary: 'Creem listed the webhook without a usable id, so its signing secret couldn’t be compared.' });
    return;
  }
  const read = await request(ctx, `${base}/v1/webhooks/${encodeURIComponent(hook.id)}/secret`, headers);
  const theirs = typeof read.data?.secret === 'string' ? read.data.secret.trim() : '';
  if (theirs) ctx.secrets.push(theirs);
  const also = hookProblems.length ? ` Also, the webhook ${listed(hookProblems)}: refunds may not switch Plus off.` : '';
  if (read.status === 200 && theirs) {
    if (timingSafeEqual(theirs, secret)) {
      patch(secretItem, hookProblems.length
        ? { state: 'problem', summary: `Matches the signing secret of Creem’s webhook for this site, but the webhook ${listed(hookProblems)}.`, fix: hookFix }
        : { summary: `Matches the signing secret of Creem’s webhook for this site (${modeWord} mode), which sends all three events.` });
    } else {
      patch(secretItem, { state: 'problem', summary: `Doesn’t match the signing secret of Creem’s webhook for this site: Creem’s events are refused.${also}`, fix: webhookFix(ctx, mode, true) });
    }
  } else if ([401, 403, 404].includes(read.status)) {
    patch(secretItem, { state: hookProblems.length ? 'problem' : 'untested', summary: `Not compared: Creem didn’t let this key read the webhook’s signing secret (HTTP ${read.status}).${also}`, ...(hookProblems.length ? { fix: hookFix } : {}) });
  } else patch(secretItem, { state: 'untested', summary: `Not compared: ${noAnswer('Creem', read, seconds)}${also}` });
}

async function checkResend(ctx, items) {
  const key = ctx.value('RESEND_API_KEY');
  const keyItem = items.get('RESEND_API_KEY');
  const fromItem = items.get('EMAIL_FROM');
  const sender = parseAddress(ctx.value('EMAIL_FROM'));
  keyItem.test = 'Resend: GET /domains, read-only (a sending-only key answers “restricted”, which still proves it).';
  fromItem.test = 'Its domain looked up in Resend → Domains.';
  if (!key) {
    if (sender) patch(fromItem, { state: 'untested', summary: 'Not checked: RESEND_API_KEY is missing.' });
    return;
  }
  const answer = await request(ctx, `${RESEND_API_URL}/domains`, { authorization: `Bearer ${key}`, accept: 'application/json' });
  const seconds = timeoutSeconds(ctx);
  const name = String(answer.data?.name ?? '');
  if (answer.status === 200 && Array.isArray(answer.data?.data)) {
    patch(keyItem, { summary: 'Valid: Resend accepted it (full access).' });
    if (!sender) return;
    const domain = sender.email.split('@').pop().toLowerCase();
    const found = answer.data.data.find(entry => String(entry?.name ?? '').trim().toLowerCase() === domain);
    const domainFix = { steps: ['Resend → Domains → Add domain: the domain of EMAIL_FROM (or open it if it is listed).', 'Add each DNS record Resend shows in Cloudflare → your domain → DNS, as “DNS only”.', 'Wait until Resend shows Verified, then check again here.'], copy: [] };
    if (!found) patch(fromItem, { state: 'problem', summary: 'Its domain isn’t in this Resend account: Resend refuses to send from it.', fix: domainFix });
    else if (String(found.status ?? '').toLowerCase() !== 'verified') patch(fromItem, { state: 'problem', summary: `Its domain is “${clip(found.status, 30) || 'unknown'}” in Resend, not verified: Resend refuses to send from it until it is.`, fix: domainFix });
    else if (String(found.capabilities?.sending ?? '').toLowerCase() === 'disabled') patch(fromItem, { state: 'problem', summary: 'Its domain is verified, but sending is disabled for it in Resend.', fix: { steps: ['Resend → Domains → the domain of EMAIL_FROM → turn sending on.'], copy: [] } });
    else patch(fromItem, { summary: 'Its domain is verified in Resend.' });
  } else if (answer.status === 401 && name === 'restricted_api_key') {
    patch(keyItem, { summary: 'Valid, with sending access only: Resend answered that this key may only send emails, which is all the API needs.' });
    if (sender) patch(fromItem, { state: 'untested', summary: 'A sending-only key can’t read domains, so its domain wasn’t looked up: Send me a test email checks the whole path.' });
  } else if ([400, 401, 403].includes(answer.status)) {
    // After a 401 or a 403 only our own words: Resend's may repeat a part of the key.
    const said = upstreamMessage(ctx, answer);
    const why = answer.status === 400 ? (said ? `: “${said}”` : '') : answer.status === 401 ? ': the key is unknown or was deleted' : ': the key is not allowed to read this account, or is not active';
    patch(keyItem, { state: 'problem', summary: `Resend refused it (HTTP ${answer.status}${why}).`, fix: variableFix(configVariableOf('RESEND_API_KEY'), { edit: true, value: 'a new key from Resend → API Keys → Create API key (Sending access).' }) });
    if (sender) patch(fromItem, { state: 'untested', summary: 'Not checked: Resend refused RESEND_API_KEY.' });
  } else {
    patch(keyItem, { state: 'untested', summary: noAnswer('Resend', answer, seconds) });
    if (sender) patch(fromItem, { state: 'untested', summary: 'Not checked: Resend gave no usable answer.' });
  }
}

async function checkDatabase(ctx, items) {
  const dbItem = items.get('DB');
  const db = ctx.env?.DB;
  const migrationItems = MIGRATIONS.map(migration => items.get(`migration:${migration.file}`));
  dbItem.test = 'A simple read (SELECT 1), then the tables, columns and indexes listed in sqlite_master.';
  const untested = summary => migrationItems.forEach(item => patch(item, { state: 'untested', summary }));
  if (!db || typeof db.prepare !== 'function') {
    if (ctx.local) {
      patch(dbItem, { state: 'untested', summary: 'This local server keeps its data in a JSON file, not in D1: the database is checked on Cloudflare.', fix: null });
      untested('Checked on Cloudflare: there is no D1 database on this local server.');
    } else untested('Not checked: no database is bound as DB.');
    return;
  }
  dbItem.shape = describeShape(configVariableOf('DB'), 'DB');
  try {
    await withTimeout(db.prepare('SELECT 1 AS one').first(), ctx.timeoutMs);
  } catch (error) {
    // No answer in time says nothing about the binding: not tested. An error does: it is bound to no usable database.
    if (error?.timeout) patch(dbItem, { state: 'untested', summary: `Not tested: the database didn’t answer within ${plural(timeoutSeconds(ctx), 'second')}. Check again in a minute.`, fix: null });
    else patch(dbItem, { state: 'problem', summary: `The database answered with an error: ${scrubUpstream(error?.message, ctx.secrets, 160) || 'unknown error'}.`, fix: variableFix(configVariableOf('DB')) });
    untested(error?.timeout ? 'Not checked: the database didn’t answer in time.' : 'Not checked: the database didn’t answer.');
    return;
  }
  patch(dbItem, { state: 'ok', summary: 'Answers: a simple read (SELECT 1) worked.', fix: null });
  let rows;
  try {
    rows = (await withTimeout(db.prepare("SELECT type, name, tbl_name AS tableName, sql FROM sqlite_master WHERE type IN ('table', 'index')").all(), ctx.timeoutMs))?.results || [];
  } catch (error) {
    untested(`Not checked: the list of tables couldn’t be read (${error?.timeout ? 'no answer in time' : scrubUpstream(error?.message, ctx.secrets, 80) || 'error'}).`);
    return;
  }
  const tables = new Map(rows.filter(row => row?.type === 'table').map(row => [String(row.name), String(row.sql ?? '')]));
  const indexes = new Set(rows.filter(row => row?.type === 'index').map(row => String(row.name)));
  MIGRATIONS.forEach((migration, index) => {
    const item = migrationItems[index];
    const schema = migrationSchema(migration.sql);
    const missingTables = schema.tables.filter(table => !tables.has(table.name)).map(table => table.name);
    const missingColumns = schema.tables.filter(table => tables.has(table.name))
      .flatMap(table => table.columns.filter(column => !hasColumn(tables.get(table.name), column.name)).map(column => ({ table: table.name, column })));
    const missingIndexes = schema.indexes.filter(entry => !indexes.has(entry.name)).map(entry => entry.name);
    const parts = [
      ...(missingTables.length ? [`${missingTables.length === 1 ? 'table' : 'tables'} ${listed(missingTables)}`] : []),
      ...(missingColumns.length ? [`${missingColumns.length === 1 ? 'column' : 'columns'} ${listed(missingColumns.map(entry => `${entry.table}.${entry.column.name}`))}`] : []),
      ...(missingIndexes.length ? [`${missingIndexes.length === 1 ? 'index' : 'indexes'} ${listed(missingIndexes)}`] : [])
    ];
    if (parts.length) patch(item, { state: 'problem', summary: `Not fully applied. Missing: ${parts.join('; ')}.`, fix: migrationFix(migration, missingColumns, tables, ctx.day) });
    else patch(item, { state: 'ok', summary: `Applied: ${plural(schema.tables.length, 'table')} and ${plural(schema.indexes.length, 'index', 'indexes')}, every column in place.` });
  });
}

// ---- The whole check ---------------------------------------------------------

const configVariableOf = name => CONFIG_VARIABLES.find(entry => entry.name === name);

function inventoryItem(def, value) {
  const present = value !== '';
  return {
    id: def.name,
    name: def.name,
    group: def.group,
    level: def.level,
    secret: def.secret,
    where: def.where,
    type: def.type,
    state: present ? 'ok' : def.level === 'optional' ? 'optional-missing' : 'missing',
    shape: present ? describeShape(def, value) : '',
    summary: present ? 'Set.' : def.level === 'optional' ? `Not set. ${def.blocks}` : 'Not set.',
    source: def.source,
    unlocks: def.unlocks,
    blocks: def.blocks,
    test: 'Whether it is set.',
    fix: present ? null : variableFix(def),
    ...(def.generate ? { generate: def.generate } : {})
  };
}

function migrationItem(migration) {
  const schema = migrationSchema(migration.sql);
  return {
    id: `migration:${migration.file}`,
    name: `migrations/${migration.file}`,
    group: 'database',
    level: 'required',
    secret: false,
    where: 'database',
    type: 'D1 migration',
    state: 'untested',
    shape: `${plural(schema.tables.length, 'table')}, ${plural(schema.indexes.length, 'index', 'indexes')}`,
    summary: 'Not checked.',
    source: `migrations/${migration.file} in the repository.`,
    unlocks: migration.unlocks,
    blocks: `Needed for ${lowerFirst(migration.unlocks)}`,
    test: 'Its tables, columns and indexes looked up in sqlite_master.',
    fix: null
  };
}

async function readBuiltConfig(ctx) {
  const url = `${ctx.origin || ctx.base}/runtime-config.js`;
  const assets = ctx.env?.ASSETS;
  try {
    const response = await withTimeout(assets && typeof assets.fetch === 'function' ? assets.fetch(url) : ctx.fetch(url, { headers: { accept: 'text/javascript' } }), ctx.timeoutMs);
    if (!response?.ok) return { error: `HTTP ${response?.status ?? 0}` };
    const values = parseRuntimeConfig(await response.text());
    return values ? { values } : { error: 'not the expected format' };
  } catch (error) {
    return { error: error?.timeout ? `no answer within ${plural(timeoutSeconds(ctx), 'second')}` : 'it could not be fetched' };
  }
}

/**
 * Run every check. `env`: the deployment's variables, secrets and bindings
 * (Pages: context.env; DB and ASSETS included). `origin`: the address the
 * page was opened on. Resolves with { checkedAt, durationMs, deployment,
 * groups, items, counts, notes }: no value of a secret anywhere.
 */
export async function runConfigChecks({ env = {}, fetch: fetchImpl = globalThis.fetch?.bind(globalThis), origin = '', now = () => Date.now(), timeoutMs = CHECK_TIMEOUT_MS } = {}) {
  const started = now();
  const value = name => {
    const raw = env?.[name];
    return typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : '';
  };
  const pageOrigin = originOf(origin);
  const base = normalizeBaseUrl(value('PUBLIC_BASE_URL')) || DEFAULT_PUBLIC_BASE_URL;
  const ctx = {
    env, value, fetch: fetchImpl, timeoutMs, base,
    origin: pageOrigin,
    local: LOCAL_HOSTS.has(hostOf(pageOrigin)),
    production: !!pageOrigin && pageOrigin === originOf(base),
    built: null,
    // Every configured secret, then the signing secrets read from Creem: what upstream text is scrubbed of.
    secrets: CONFIG_VARIABLES.filter(def => def.secret).map(def => value(def.name)),
    day: new Date(now()).toISOString().slice(0, 10).replaceAll('-', '')
  };

  const items = new Map();
  for (const def of CONFIG_VARIABLES) {
    const present = def.where === 'binding' ? !!env?.[def.name] : value(def.name) !== '';
    items.set(def.name, inventoryItem(def, present ? (def.where === 'binding' ? def.name : value(def.name)) : ''));
  }
  for (const migration of MIGRATIONS) items.set(`migration:${migration.file}`, migrationItem(migration));

  checkSignIn(ctx, items);
  checkAddresses(ctx, items);
  checkEmailSettings(ctx, items);
  const built = readBuiltConfig(ctx).then(answer => {
    ctx.built = answer.values || null;
    ctx.builtError = answer.error || '';
    checkBuildVariables(ctx, items);
    return checkPlus(ctx, items);
  });
  // A check that throws leaves its rows as they are: “not checked”, never a crash of the page.
  await Promise.all([built, checkCreem(ctx, items), checkResend(ctx, items), checkDatabase(ctx, items)].map(task => task.catch(() => {})));

  const order = new Map(CONFIG_GROUPS.map((group, index) => [group.id, index]));
  const list = [...items.values()].sort((a, b) => order.get(a.group) - order.get(b.group));
  const counts = Object.fromEntries(STATES.map(state => [state, list.filter(item => item.state === state).length]));
  const notes = [];
  if (!ctx.production) {
    notes.push(ctx.local
      ? 'This is a local server: it checks this computer’s settings, not Cloudflare’s.'
      : 'This page is open on another address than the production one: it checks the deployment that answers here (a preview deployment uses the Preview variables).');
  }
  if (ctx.builtError) notes.push(`The deployed runtime-config.js couldn’t be read (${ctx.builtError}): build variables are judged from this deployment’s settings.`);
  const answer = {
    checkedAt: new Date(now()).toISOString(),
    durationMs: Math.max(0, now() - started),
    deployment: { origin: pageOrigin, baseUrl: base, production: ctx.production, local: ctx.local, single: true },
    groups: CONFIG_GROUPS,
    items: list,
    counts,
    notes
  };
  return scrubAnswer(answer, ctx.secrets);
}

/**
 * POST admin/config/check, behind the owner's sign-in (checked by the caller).
 * `getOptions()` gives runConfigChecks' options; the page's origin comes from
 * the request. `limiter`: the worker isolate's own (server/admin-limits.js),
 * shared by every request it answers. Answers { status, body, headers? }, or
 * null for another path.
 */
export function createConfigCheckRoute(getOptions, { limiter = sharedAdminLimits.check } = {}) {
  return async function configCheckRoute(request, path) {
    if (path !== 'admin/config/check') return null;
    if (request.method !== 'POST') return { status: 405, body: { error: 'Method not allowed' } };
    const wait = limiter();
    if (wait) return { status: 429, body: { error: `Too many checks in a short time. Check again in ${waitWords(wait)}.`, retryAfter: wait }, headers: { 'retry-after': String(wait) } };
    return { status: 200, body: await runConfigChecks({ ...getOptions(), origin: new URL(request.url).origin }) };
  };
}
