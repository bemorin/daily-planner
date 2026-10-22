import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlannerApi, createMemoryStore, EVENT_NAMES, validateFeedback, validateTeamRequest, validateWaitlist, toCsv } from '../server/planner-api.js';
import { createD1Store } from '../server/d1-store.js';
import { signSession, totp } from '../server/admin-auth.js';
import { readdirSync, readFileSync } from 'node:fs';

const fixedNow = () => new Date('2026-10-09T08:00:00Z');
const post = (path, body, headers = {}) => new Request(`https://planner.test/api/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const get = (path, token) => new Request(`https://planner.test/api/${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
const del = (path, token) => new Request(`https://planner.test/api/${path}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
const TOTP_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const team = (overrides = {}) => ({ email: 'Lead@Acme.example', name: 'Ada', company: 'Acme', teamSize: 25, timing: 'q1-2027', message: 'Rolling out in January', consent: true, website: '', version: '1.18.0', locale: 'fr-FR', source: 'landing', ...overrides });

async function openSqlite(t, migrations = ['0001_planner_api.sql', '0002_team_requests.sql', '0003_plus.sql', '0004_creem_reviews.sql']) {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { t.skip('node:sqlite is not available in this Node version'); return null; }
  const sqlite = new DatabaseSync(':memory:');
  for (const migration of migrations) {
    sqlite.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
  }
  // Minimal D1 facade over node:sqlite: prepare().bind().run()/all().
  return {
    sqlite,
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      let params = [];
      const api = {
        bind(...values) { params = values; return api; },
        async run() { const result = statement.run(...params); return { meta: { changes: Number(result.changes) } }; },
        async all() { return { results: statement.all(...params) }; }
      };
      return api;
    }
  };
}

test('waitlist validation requires a real email and explicit consent', () => {
  assert.ok(validateWaitlist({ email: 'nope', consent: true }).error);
  assert.ok(validateWaitlist({ email: 'ben@example.com' }).error);
  const { entry } = validateWaitlist({ email: ' Ben@Example.com ', consent: true, devices: ['iphone', 'toaster', 'mac'], version: '1.18.0', driveSeen: true });
  assert.equal(entry.email, 'ben@example.com');
  assert.equal(entry.devices, 'iphone,mac');
  assert.equal(entry.driveSeen, 1);
  assert.equal(validateWaitlist({ website: 'spam', email: 'x@y.zz', consent: true }).spam, true);
});

test('feedback validation needs a version and a rating or a message', () => {
  assert.ok(validateFeedback({ rating: 5 }).error, 'version is required');
  assert.ok(validateFeedback({ version: '1.18.0' }).error, 'empty feedback is rejected');
  assert.ok(validateFeedback({ version: '1.18.0', rating: 7 }).error);
  const { entry } = validateFeedback({ version: '1.18.0', rating: 4, kind: 'idea', message: '  More themes  ' });
  assert.equal(entry.rating, 4);
  assert.equal(entry.message, 'More themes');
});

test('the router counts only allow-listed events and keeps no identifiers', async () => {
  const store = createMemoryStore();
  const api = createPlannerApi({ store, adminToken: 'secret', now: fixedNow });
  assert.equal((await api(post('events', { name: 'sync_guide_opened', version: '1.18.0' }))).status, 204);
  assert.equal((await api(post('events', { name: 'sync_guide_opened', version: '1.18.0' }))).status, 204);
  assert.equal((await api(post('events', { name: 'anything_else', version: '1.18.0' }))).status, 400);
  assert.deepEqual(store.data.events, [{ day: '2026-10-09', name: 'sync_guide_opened', appVersion: '1.18.0', count: 2 }]);
});

test('waitlist sign-ups are unique and admin endpoints require the token', async () => {
  const store = createMemoryStore();
  const api = createPlannerApi({ store, adminToken: 'secret', now: fixedNow });
  const first = await api(post('waitlist', { email: 'a@b.co', consent: true, version: '1.18.0' }));
  assert.equal(first.status, 201);
  const firstBody = await first.json();
  assert.match(firstBody.removeToken, /^[0-9a-f]{64}$/);
  const again = await api(post('waitlist', { email: 'A@b.co', consent: true, version: '1.18.0' }));
  // A repeat sign-up looks exactly like a new one: no way to probe the list.
  assert.equal(again.status, 201);
  assert.deepEqual(await again.json(), firstBody);
  assert.equal((await api(get('admin/summary'))).status, 401);
  assert.equal((await api(get('admin/summary', 'wrong'))).status, 401);
  assert.equal((await api(new Request('https://planner.test/api/admin/summary', { headers: { authorization: 'secret' } }))).status, 401);
  assert.equal((await api(get('admin/summary?days=abc', 'secret'))).status, 200);
  const summary = await (await api(get('admin/summary', 'secret'))).json();
  assert.equal(summary.waitlist.length, 1);
  const id = summary.waitlist[0].id;
  const removal = await api(new Request(`https://planner.test/api/admin/waitlist/${id}`, { method: 'DELETE', headers: { authorization: 'Bearer secret' } }));
  assert.equal(removal.status, 200);
  assert.equal(store.data.waitlist.length, 0);
});

test('admin is disabled entirely without a configured token', async () => {
  const api = createPlannerApi({ store: createMemoryStore(), adminToken: '' });
  assert.equal((await api(get('admin/summary', ''))).status, 503);
});

test('oversized and malformed bodies are rejected', async () => {
  const api = createPlannerApi({ store: createMemoryStore() });
  const big = new Request('https://planner.test/api/feedback', { method: 'POST', body: JSON.stringify({ message: 'x'.repeat(20000) }) });
  assert.equal((await api(big)).status, 413);
  const bad = new Request('https://planner.test/api/feedback', { method: 'POST', body: '{nope' });
  assert.equal((await api(bad)).status, 400);
  // No content-length: the body is still capped while it is read.
  const stream = new ReadableStream({ start(controller) { for (let index = 0; index < 40; index += 1) controller.enqueue(new TextEncoder().encode('x'.repeat(1024))); controller.close(); } });
  const streamed = new Request('https://planner.test/api/feedback', { method: 'POST', body: stream, duplex: 'half' });
  assert.equal((await api(streamed)).status, 413);
});

test('admin responses carry CORS headers for an allowed origin', async () => {
  const api = createPlannerApi({ store: createMemoryStore(), adminToken: 'secret', allowedOrigins: 'https://owner.example' });
  const response = await api(new Request('https://planner.test/api/admin/summary', { headers: { authorization: 'Bearer secret', origin: 'https://owner.example' } }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://owner.example');
  const other = await api(new Request('https://planner.test/api/admin/summary', { headers: { authorization: 'Bearer secret', origin: 'https://evil.example' } }));
  assert.equal(other.headers.get('access-control-allow-origin'), null);
});

test('CSV export neutralises spreadsheet formulas', () => {
  const csv = toCsv([{ email: '=HYPERLINK("x")', note: 'a,b' }], ['email', 'note']);
  assert.equal(csv, 'email,note\n"\'=HYPERLINK(""x"")","a,b"\n');
});

test('the D1 store SQL works against SQLite with the shipped migrations', async t => {
  const d1 = await openSqlite(t);
  if (!d1) return;
  const store = createD1Store(d1);
  const api = createPlannerApi({ store, adminToken: 'secret', now: fixedNow });
  await api(post('events', { name: 'waitlist_joined', version: '1.18.0' }));
  await api(post('events', { name: 'waitlist_joined', version: '1.18.0' }));
  assert.equal((await api(post('waitlist', { email: 'x@y.co', consent: true, version: '1.18.0', devices: ['mac'] }))).status, 201);
  assert.equal((await api(post('waitlist', { email: 'x@y.co', consent: true, version: '1.18.0' }))).status, 201);
  await api(post('feedback', { version: '1.18.0', rating: 5, message: 'Love Horizon' }));
  await api(post('feedback', { version: '1.18.0', rating: 3 }));
  await api(post('feedback', { version: '1.17.0', message: 'Bug in year map' }));
  const summary = await (await api(get('admin/summary', 'secret'))).json();
  assert.deepEqual(summary.eventTotals, [{ name: 'waitlist_joined', appVersion: '1.18.0', count: 2 }]);
  assert.equal(summary.waitlist.length, 1);
  const latest = summary.feedbackByVersion.find(row => row.appVersion === '1.18.0');
  assert.equal(latest.count, 2);
  assert.equal(latest.avgRating, 4);
  assert.equal(summary.feedbackByVersion[0].appVersion, '1.18.0', 'newest version first');

  // Team kit requests (migration 0002).
  assert.equal(summary.teamRequestsUnavailable, false);
  assert.equal((await api(post('teams', team()))).status, 201);
  assert.equal((await api(post('teams', team({ company: '=cmd|calc', teamSize: '40', source: 'app', version: 'beta' })))).status, 201);
  assert.equal((await api(post('teams', team({ website: 'bot' })))).status, 201);
  assert.equal((await api(post('teams', team({ teamSize: 1 })))).status, 400);
  const teams = await (await api(get('admin/summary', 'secret'))).json();
  assert.deepEqual(teams.teamRequestTotals, { count: 2, seats: 65 });
  assert.equal(teams.teamRequests.length, 2);
  const [newest] = teams.teamRequests;
  assert.deepEqual({ ...newest, id: 0 }, { id: 0, email: 'lead@acme.example', name: 'Ada', company: '=cmd|calc', teamSize: 40, timing: 'q1-2027', plan: '', currency: '', kind: 'quote', message: 'Rolling out in January', locale: 'fr-FR', appVersion: '', source: 'app', createdAt: '2026-10-09T08:00:00.000Z', ref: '' });
  const csv = await (await api(get('admin/teams?format=csv', 'secret'))).text();
  assert.match(csv, /^id,createdAt,company,teamSize,plan,currency,kind,timing,name,email,message,locale,appVersion,source,ref\n/);
  assert.ok(csv.includes(",'=cmd|calc,40,"), 'formula neutralised in CSV');
  assert.equal((await api(del(`admin/teams/${newest.id}`, 'secret'))).status, 200);
  assert.equal((await api(del(`admin/teams/${newest.id}`, 'secret'))).status, 404);
  assert.equal((await (await api(get('admin/teams', 'secret'))).json()).rows.length, 1);
  // Bound parameters only: a hostile value is stored verbatim, not executed.
  await api(post('teams', team({ company: "x'); DROP TABLE team_requests; --" })));
  assert.equal(d1.sqlite.prepare('SELECT COUNT(*) AS n FROM team_requests').get().n, 2);
});

test('the summary survives a D1 database without the 0002 migration', async t => {
  const d1 = await openSqlite(t, ['0001_planner_api.sql']);
  if (!d1) return;
  const api = createPlannerApi({ store: createD1Store(d1), adminToken: 'secret', now: fixedNow });
  const response = await api(get('admin/summary', 'secret'));
  assert.equal(response.status, 200);
  const summary = await response.json();
  assert.equal(summary.teamRequestsUnavailable, true);
  assert.deepEqual(summary.teamRequests, []);
  // Applying 0002 later (or twice) is safe.
  for (let round = 0; round < 2; round += 1) d1.sqlite.exec(readFileSync(new URL('../migrations/0002_team_requests.sql', import.meta.url), 'utf8'));
  assert.equal((await (await api(get('admin/summary', 'secret'))).json()).teamRequestsUnavailable, false);
});

test('team kit requests are validated with human messages', () => {
  const now = new Date('2026-10-09T08:00:00Z');
  const { entry } = validateTeamRequest(team({ email: ' Lead@Acme.example ', company: '  Acme  ', teamSize: '25' }), now);
  assert.deepEqual(entry, { email: 'lead@acme.example', name: 'Ada', company: 'Acme', teamSize: 25, timing: 'q1-2027', plan: '', currency: '', kind: 'quote', message: 'Rolling out in January', locale: 'fr-FR', appVersion: '1.18.0', source: 'landing', createdAt: '2026-10-09T08:00:00.000Z' });
  assert.equal(validateTeamRequest(team({ website: 'https://spam.example' })).spam, true);
  const rejected = {
    'invalid email': { email: 'not-an-email' },
    'missing consent': { consent: undefined },
    'consent must be true, not truthy': { consent: 'yes' },
    'consent unticked': { consent: false },
    'empty company': { company: '   ' },
    'company over 120': { company: 'x'.repeat(121) },
    'team of one': { teamSize: 1 },
    'team too large': { teamSize: 100001 },
    'fractional team': { teamSize: 2.5 },
    'non-numeric team': { teamSize: 'ten' },
    'missing team size': { teamSize: undefined },
    'unknown timing': { timing: 'tomorrow' },
    'name over 80': { name: 'n'.repeat(81) },
    'message over 1000': { message: 'm'.repeat(1001) }
  };
  for (const [label, overrides] of Object.entries(rejected)) {
    const result = validateTeamRequest(team(overrides));
    assert.equal(typeof result.error, 'string', label);
    assert.ok(result.error.length > 10, `${label}: human message`);
  }
  assert.ok(validateTeamRequest(team({ company: 'x'.repeat(120), name: 'n'.repeat(80), message: 'm'.repeat(1000), teamSize: 100000 })).entry);
  assert.ok(validateTeamRequest(team({ teamSize: 2, timing: 'later' })).entry);
  for (const timing of ['december-2026', 'january-2027', 'q1-2027', 'later']) assert.ok(validateTeamRequest(team({ timing })).entry, timing);
  assert.equal(validateTeamRequest(team({ version: '1.18' })).entry.appVersion, '', 'unknown version stored blank');
  assert.equal(validateTeamRequest(team({ source: undefined })).entry.source, 'landing');
  assert.equal(validateTeamRequest(team({ source: 'app' })).entry.source, 'app');
  assert.equal(validateTeamRequest(team({ source: 'partner' })).entry.source, 'landing');
  assert.equal(validateTeamRequest(team({ locale: 'x'.repeat(50) })).entry.locale.length, 35);
});

test('team kit requests are stored, listed, exported and deletable', async () => {
  const store = createMemoryStore();
  const api = createPlannerApi({ store, adminToken: 'secret', now: fixedNow });
  const first = await api(post('teams', team()));
  assert.equal(first.status, 201);
  assert.deepEqual(await first.json(), { ok: true });
  // A repeat request is stored and answered exactly like a new one.
  const repeat = await api(post('teams', team({ company: '+Acme', teamSize: 30, message: 'line one\nline, two' })));
  assert.equal(repeat.status, 201);
  assert.deepEqual(await repeat.json(), { ok: true });
  const spam = await api(post('teams', team({ website: 'x' })));
  assert.equal(spam.status, 201);
  assert.deepEqual(await spam.json(), { ok: true });
  assert.equal(store.data.teamRequests.length, 2, 'honeypot submissions are not stored');
  const invalid = await api(post('teams', team({ timing: 'someday' })));
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /when/);
  assert.equal(store.data.teamRequests.length, 2);

  assert.equal((await api(get('admin/teams'))).status, 401);
  const summary = await (await api(get('admin/summary', 'secret'))).json();
  assert.equal(summary.teamRequests.length, 2);
  assert.deepEqual(summary.teamRequestTotals, { count: 2, seats: 55 });
  assert.equal(summary.teamRequestsUnavailable, false);
  const { rows } = await (await api(get('admin/teams', 'secret'))).json();
  assert.equal(rows.length, 2);
  const csvResponse = await api(get('admin/teams?format=csv', 'secret'));
  assert.equal(csvResponse.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.match(csvResponse.headers.get('content-disposition'), /daily-planner-team-requests\.csv/);
  const csv = await csvResponse.text();
  assert.ok(csv.includes(`'+Acme`), 'formula-looking company neutralised');
  assert.ok(csv.includes('"line one\nline, two"'), 'multi-line message quoted');
  const id = rows.find(row => row.company === 'Acme').id;
  assert.equal((await api(del(`admin/teams/${id}`, 'secret'))).status, 200);
  assert.equal((await api(del(`admin/teams/${id}`, 'secret'))).status, 404);
  assert.equal(store.data.teamRequests.length, 1);
});

test('landing and team events are allow-listed anonymous counts', async () => {
  const store = createMemoryStore();
  const api = createPlannerApi({ store, now: fixedNow });
  const names = ['landing_viewed', 'landing_cta_app', 'landing_cta_teams', 'team_form_opened', 'team_request_sent', 'manager_email_opened'];
  for (const name of names) {
    assert.ok(EVENT_NAMES.has(name), name);
    assert.equal((await api(post('events', { name, version: '1.18.0' }))).status, 204, name);
  }
  assert.deepEqual(store.data.events.map(row => row.name), names);
});

/** Event names of COUNTED_EVENTS and LANDING_EVENTS, read from the client source as text. */
function clientEventNames() {
  const source = readFileSync(new URL('../src/lib/planner-api.js', import.meta.url), 'utf8');
  const names = [];
  for (const list of ['COUNTED_EVENTS', 'LANDING_EVENTS']) {
    const block = new RegExp(`export const ${list} = Object\\.freeze\\(\\[([\\s\\S]*?)\\n\\]\\);`).exec(source);
    assert.ok(block, `${list} found in src/lib/planner-api.js`);
    const found = [...block[1].matchAll(/^\s*\[\s*'([a-z0-9_]+)'\s*,/gm)].map(match => match[1]);
    assert.ok(found.length >= 5, `${list} lists its events`);
    names.push(...found);
  }
  return new Set(names);
}

test('the server accepts exactly the events the planner and the landing page may count', async () => {
  const client = clientEventNames();
  assert.deepEqual([...EVENT_NAMES].filter(name => !client.has(name)).sort(), [], 'accepted by the server but never sent');
  assert.deepEqual([...client].filter(name => !EVENT_NAMES.has(name)).sort(), [], 'sent by a client but refused by the server');
  assert.ok(EVENT_NAMES.has('pricing_viewed') && EVENT_NAMES.has('app_active_month') && EVENT_NAMES.has('review_sent'));
  const store = createMemoryStore();
  const api = createPlannerApi({ store, now: fixedNow });
  for (const name of client) assert.equal((await api(post('events', { name, version: '1.21.0' }))).status, 204, name);
  assert.equal(store.data.events.length, client.size);
  assert.equal((await api(post('events', { name: 'internal:email_sent', version: '1.21.0' }))).status, 400, 'internal rows can never be sent');
});

test('Daily Planner Plus and team gift events are allow-listed anonymous counts', async () => {
  const store = createMemoryStore();
  const api = createPlannerApi({ store, now: fixedNow });
  const names = ['plus_modal_opened', 'plus_checkout_clicked', 'plus_unlocked', 'gift_opened', 'gift_redeemed', 'year_plan_completed', 'quarter_review_completed', 'year_review_opened', 'pack_checkout_clicked', 'gift_link_copied'];
  for (const name of names) {
    assert.ok(EVENT_NAMES.has(name), name);
    assert.equal((await api(post('events', { name, version: '1.20.0' }))).status, 204, name);
  }
  assert.deepEqual(store.data.events.map(row => row.name), names);
  assert.equal((await api(post('events', { name: 'plus_purchased_secretly', version: '1.20.0' }))).status, 400);
});

test('two-factor sign-in issues a signed 8-hour session', async () => {
  let clock = Date.parse('2026-10-09T08:00:00Z');
  const api = createPlannerApi({ store: createMemoryStore(), adminToken: 'secret', adminTotpSecret: TOTP_SECRET, now: () => new Date(clock), authFailureDelayMs: 0 });
  const code = await totp(TOTP_SECRET, clock);
  const response = await api(post('admin/session', { token: 'secret', code }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const { session, expiresAt } = await response.json();
  assert.match(session, /^v1\.\d+\.[0-9a-f]{64}$/);
  assert.equal(expiresAt, '2026-10-09T16:00:00.000Z');
  assert.equal((await api(get('admin/summary', session))).status, 200);
  assert.equal((await api(get('admin/teams?format=csv', session))).status, 200);
  // With two-factor on, the raw token alone never opens the data.
  assert.equal((await api(get('admin/summary', 'secret'))).status, 401);
  // A code from the previous 30-second step is still accepted (clock drift).
  assert.equal((await api(post('admin/session', { token: 'secret', code: await totp(TOTP_SECRET, clock - 30000) }))).status, 200);
  assert.equal((await api(post('admin/session', { token: 'secret', code: await totp(TOTP_SECRET, clock - 60000) }))).status, 401);
  assert.equal((await api(new Request('https://planner.test/api/admin/session'))).status, 405);
  // Bearer prefix still required; a tampered session is refused.
  assert.equal((await api(new Request('https://planner.test/api/admin/summary', { headers: { authorization: session } }))).status, 401);
  assert.equal((await api(get('admin/summary', session.replace(/.$/, session.endsWith('0') ? '1' : '0')))).status, 401);
  // Eight hours later the session has expired.
  clock += 8 * 3600 * 1000 - 1;
  assert.equal((await api(get('admin/summary', session))).status, 200);
  clock += 1;
  assert.equal((await api(get('admin/summary', session))).status, 401);
});

test('knowing ADMIN_TOKEN alone cannot mint a session once two-factor is on', async () => {
  const clock = Date.parse('2026-10-09T08:00:00Z');
  const api = createPlannerApi({ store: createMemoryStore(), adminToken: 'secret', adminTotpSecret: TOTP_SECRET, now: () => new Date(clock), authFailureDelayMs: 0 });
  const forged = await signSession('secret', clock + 3600000);
  assert.equal((await api(get('admin/summary', forged))).status, 401);
  // A session issued before two-factor was switched on stops working too.
  const before = createPlannerApi({ store: createMemoryStore(), adminToken: 'secret', now: () => new Date(clock), authFailureDelayMs: 0 });
  const { session } = await (await before(post('admin/session', { token: 'secret' }))).json();
  assert.equal((await before(get('admin/summary', session))).status, 200);
  assert.equal((await api(get('admin/summary', session))).status, 401);
});

test('emails that would add fields to a mailto: link are refused', () => {
  for (const email of ['victim@corp.com?bcc=spy%40evil.org', 'a@b.co&subject=x', 'a@exa%6dple.com', 'a?x=1@b.co', 'a@b/c.co']) {
    assert.ok(validateTeamRequest({ email, company: 'Acme', teamSize: 5, timing: 'january-2027', consent: true }).error, email);
    assert.ok(validateWaitlist({ email, consent: true }).error, email);
  }
  for (const email of ['lea@acme.fr', 'tester+m@example.com', 'first.last@mail.corp-example.co.uk']) {
    assert.equal(validateTeamRequest({ email, company: 'Acme', teamSize: 5, timing: 'january-2027', consent: true }).error, undefined, email);
  }
});

test('a failed sign-in looks the same whether the token or the code was wrong', async () => {
  const clock = Date.parse('2026-10-09T08:00:00Z');
  const api = createPlannerApi({ store: createMemoryStore(), adminToken: 'secret', adminTotpSecret: TOTP_SECRET, now: () => new Date(clock) });
  const code = await totp(TOTP_SECRET, clock);
  const wrongCode = code === '000000' ? '111111' : '000000';
  const attempts = [
    { token: 'wrong', code },
    { token: 'secret', code: wrongCode },
    { token: 'secret' },
    { token: 'secret', code: '' },
    {}
  ];
  const answers = [];
  for (const body of attempts) {
    const started = Date.now();
    const response = await api(post('admin/session', body));
    const elapsed = Date.now() - started;
    answers.push({ status: response.status, body: await response.text(), headers: [...response.headers.entries()] });
    assert.ok(elapsed >= 350, `failures are delayed (${elapsed} ms)`);
  }
  answers.forEach(answer => assert.deepEqual(answer, answers[0]));
  assert.equal(answers[0].status, 401);
  assert.equal(answers[0].body, JSON.stringify({ error: 'Unauthorized' }));
  const invalidJson = await api(new Request('https://planner.test/api/admin/session', { method: 'POST', body: '{nope' }));
  assert.equal(invalidJson.status, 401);
});

test('without two-factor the raw token still works and sign-in needs only the token', async () => {
  const api = createPlannerApi({ store: createMemoryStore(), adminToken: 'secret', now: fixedNow, authFailureDelayMs: 0 });
  assert.equal((await api(get('admin/summary', 'secret'))).status, 200);
  const response = await api(post('admin/session', { token: 'secret', code: '' }));
  assert.equal(response.status, 200);
  const { session } = await response.json();
  assert.equal((await api(get('admin/summary', session))).status, 200);
  assert.equal((await api(post('admin/session', { token: 'secret', code: '123456' }))).status, 200, 'a code is ignored when 2FA is off');
  assert.equal((await api(post('admin/session', { token: 'nope' }))).status, 401);
  // A session signed with another ADMIN_TOKEN is refused.
  const other = createPlannerApi({ store: createMemoryStore(), adminToken: 'rotated', now: fixedNow, authFailureDelayMs: 0 });
  assert.equal((await other(get('admin/summary', session))).status, 401);
});

test('admin sign-in fails closed when the token or the TOTP secret is unusable', async () => {
  const noToken = createPlannerApi({ store: createMemoryStore(), adminToken: '', adminTotpSecret: TOTP_SECRET });
  const missing = await noToken(post('admin/session', { token: '', code: '' }));
  assert.equal(missing.status, 503);
  assert.match((await missing.json()).error, /ADMIN_TOKEN/);
  for (const secret of ['not base32!', 'ABCDEFGH']) {
    const api = createPlannerApi({ store: createMemoryStore(), adminToken: 'secret', adminTotpSecret: secret, authFailureDelayMs: 0 });
    const response = await api(post('admin/session', { token: 'secret', code: '123456' }));
    assert.equal(response.status, 503, secret);
    assert.match((await response.json()).error, /ADMIN_TOTP_SECRET/);
    assert.equal((await api(get('admin/summary', 'secret'))).status, 503, 'never falls back to token-only access');
  }
});

test('sign-in answers CORS headers for an allowed origin', async () => {
  const clock = Date.parse('2026-10-09T08:00:00Z');
  const api = createPlannerApi({ store: createMemoryStore(), adminToken: 'secret', adminTotpSecret: TOTP_SECRET, allowedOrigins: 'https://owner.example', now: () => new Date(clock), authFailureDelayMs: 0 });
  const origin = { origin: 'https://owner.example' };
  const preflight = await api(new Request('https://planner.test/api/admin/session', { method: 'OPTIONS', headers: origin }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://owner.example');
  assert.match(preflight.headers.get('access-control-allow-headers'), /authorization/);
  assert.match(preflight.headers.get('access-control-allow-methods'), /POST/);
  const ok = await api(post('admin/session', { token: 'secret', code: await totp(TOTP_SECRET, clock) }, origin));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://owner.example');
  const refused = await api(post('admin/session', { token: 'wrong', code: '000000' }, origin));
  assert.equal(refused.status, 401);
  assert.equal(refused.headers.get('access-control-allow-origin'), 'https://owner.example');
  const elsewhere = await api(post('admin/session', { token: 'secret', code: await totp(TOTP_SECRET, clock) }, { origin: 'https://evil.example' }));
  assert.equal(elsewhere.headers.get('access-control-allow-origin'), null);
});

test('a question needs no team: no company, number of people or timing; an invoice, a quote or a talk still does', () => {
  const now = new Date('2026-10-21T08:00:00Z');
  const question = { email: ' Ann@Example.com ', name: 'Ann', message: 'Can I move my plans to a new laptop?', consent: true, website: '', version: '1.29.1', locale: 'fr-FR', source: 'teams', kind: 'question' };
  assert.deepEqual(validateTeamRequest(question, now).entry, { email: 'ann@example.com', name: 'Ann', company: '', teamSize: 0, timing: '', plan: '', currency: '', kind: 'question', message: 'Can I move my plans to a new laptop?', locale: 'fr-FR', appVersion: '1.29.1', source: 'teams', createdAt: '2026-10-21T08:00:00.000Z' }, 'stored as \'\' / 0 / \'\' (the columns are NOT NULL)');
  // An older page may still send the team's fields with a question: they are not kept, nor checked.
  assert.deepEqual(validateTeamRequest({ ...question, company: 'Acme', teamSize: 1, timing: 'tomorrow', plan: 'up-to-50', currency: 'EUR' }, now).entry, validateTeamRequest(question, now).entry);
  // Everything else is still checked.
  for (const [label, overrides, words] of [
    ['invalid email', { email: 'not-an-email' }, /valid email address/],
    ['no question', { message: '   ' }, /write your question/],
    ['question over 1000', { message: 'm'.repeat(1001) }, /1,000 characters/],
    ['name over 80', { name: 'n'.repeat(81) }, /80 characters/],
    ['no consent', { consent: undefined }, /tick the box/],
    ['consent unticked', { consent: false }, /tick the box/]
  ]) assert.match(validateTeamRequest({ ...question, ...overrides }, now).error || '', words, label);
  // The box is required again (1.33): a question sent by a 1.32 page, without `consent`, is refused.
  const { consent, ...unticked } = question;
  assert.equal(consent, true, 'what the form sends once the box is ticked');
  assert.equal(validateTeamRequest(unticked, now).error, 'Please tick the box so we can use your details to reply to you.');
  assert.equal(validateTeamRequest({ ...question, website: 'bot' }, now).spam, true);
  assert.doesNotMatch(validateTeamRequest({ ...question, email: 'nope' }, now).error, /work email/, 'any address, not a work one');
  // A team request without its team's fields is refused, as before.
  for (const kind of ['invoice', 'quote', 'talk', undefined]) {
    for (const missing of ['company', 'teamSize', 'timing']) {
      assert.ok(validateTeamRequest(team({ kind, [missing]: undefined }), now).error, `${kind} without ${missing}`);
    }
    assert.ok(validateTeamRequest(team({ kind, message: '' }), now).entry, `${kind}: the message stays optional`);
  }
  assert.match(validateTeamRequest(team({ kind: 'invoice', email: 'nope' }), now).error, /valid work email address/);
});

test('a question is stored, listed and exported without a team (memory and D1)', async t => {
  const d1 = await openSqlite(t);
  if (!d1) return;
  for (const [label, store] of [['memory', createMemoryStore()], ['D1', createD1Store(d1)]]) {
    const api = createPlannerApi({ store, adminToken: 'secret', now: fixedNow });
    assert.equal((await api(post('teams', { email: 'ann@example.com', name: 'Ann', message: 'Partner program: who can join?', consent: true, kind: 'question', source: 'teams', ref: 'COACH_ANNA' }))).status, 201, label);
    // As a 1.32 page sends it, with no box: refused, and nothing is stored.
    const unticked = await api(post('teams', { email: 'bob@example.com', name: 'Bob', message: 'Hello?', kind: 'question', source: 'contact' }));
    assert.equal(unticked.status, 400, `${label}: a question without consent`);
    assert.match((await unticked.json()).error, /tick the box/, label);
    const refused = await api(post('teams', { email: 'ann@example.com', name: 'Ann', message: '', consent: true, kind: 'question' }));
    assert.equal(refused.status, 400, `${label}: a question without its question`);
    assert.equal((await api(post('teams', { email: 'ann@example.com', name: 'Ann', consent: true, kind: 'invoice', message: 'Hi' }))).status, 400, `${label}: an invoice without its team`);
    const { rows } = await (await api(get('admin/teams', 'secret'))).json();
    assert.equal(rows.length, 1, label);
    assert.deepEqual(['company', 'teamSize', 'timing', 'plan', 'currency', 'kind', 'message'].map(key => rows[0][key]), ['', 0, '', '', '', 'question', 'Partner program: who can join?'], label);
    const summary = await (await api(get('admin/summary', 'secret'))).json();
    assert.deepEqual(summary.teamRequestTotals, { count: 1, seats: 0 }, `${label}: no seats from a question`);
  }
});

test('team requests accept a plan, a currency and a kind of request, strictly', () => {
  const plans = ['up-to-10', 'up-to-50', 'up-to-100', 'up-to-500', 'up-to-1000', 'over-1000'];
  for (const plan of plans) assert.equal(validateTeamRequest(team({ plan })).entry.plan, plan);
  for (const currency of ['EUR', 'USD']) assert.equal(validateTeamRequest(team({ currency })).entry.currency, currency);
  for (const kind of ['invoice', 'quote', 'talk', 'question']) assert.equal(validateTeamRequest(team({ kind })).entry.kind, kind);
  // Anything else is stored blank (plan, currency) or as the default kind, never refused.
  // Personal gifts are bought online, never requested: a team request keeps its own list.
  for (const plan of ['up-to-20', 'UP-TO-10', '', null, 10, ['up-to-10'], 'gift-1', 'family-5']) assert.equal(validateTeamRequest(team({ plan })).entry.plan, '', String(plan));
  for (const currency of ['eur', 'GBP', ' EUR', 1]) assert.equal(validateTeamRequest(team({ currency })).entry.currency, '', String(currency));
  for (const kind of ['Invoice', 'call', '', undefined, {}]) assert.equal(validateTeamRequest(team({ kind })).entry.kind, 'quote', String(kind));
});

test('plan, currency and kind are stored, listed and exported (memory and D1)', async t => {
  const d1 = await openSqlite(t);
  if (!d1) return;
  for (const [label, store] of [['memory', createMemoryStore()], ['D1', createD1Store(d1)]]) {
    const api = createPlannerApi({ store, adminToken: 'secret', now: fixedNow });
    assert.equal((await api(post('teams', team({ plan: 'up-to-50', currency: 'EUR', kind: 'invoice' })))).status, 201, label);
    assert.equal((await api(post('teams', team({ plan: 'nope', currency: 'GBP', kind: 'nope' })))).status, 201, label);
    const { rows } = await (await api(get('admin/teams', 'secret'))).json();
    const picked = rows.map(({ plan, currency, kind }) => ({ plan, currency, kind })).sort((a, b) => a.kind.localeCompare(b.kind));
    assert.deepEqual(picked, [{ plan: 'up-to-50', currency: 'EUR', kind: 'invoice' }, { plan: '', currency: '', kind: 'quote' }], label);
    const summary = await (await api(get('admin/summary', 'secret'))).json();
    assert.ok(summary.teamRequests.some(row => row.plan === 'up-to-50' && row.currency === 'EUR' && row.kind === 'invoice'), label);
    const csv = await (await api(get('admin/teams?format=csv', 'secret'))).text();
    assert.match(csv, /^id,createdAt,company,teamSize,plan,currency,kind,timing,/, label);
    assert.ok(csv.includes(',Acme,25,up-to-50,EUR,invoice,q1-2027,'), label);
    assert.ok(csv.includes(',Acme,25,,,quote,q1-2027,'), label);
  }
});

test('every migration runs when the D1 console joins it into one line', async t => {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { t.skip('node:sqlite is not available in this Node version'); return; }
  const files = readdirSync(new URL('../migrations/', import.meta.url)).filter(name => name.endsWith('.sql')).sort();
  assert.ok(files.length >= 4);
  assert.ok(files.includes('0003_plus.sql'));
  assert.ok(files.includes('0004_creem_reviews.sql'));
  assert.ok(files.includes('0005_refunds.sql'));
  assert.ok(files.includes('0006_partners.sql'));
  assert.ok(files.includes('0007_partner_commissions.sql'));
  assert.ok(files.includes('0008_partner_profiles.sql'));
  const sqlite = new DatabaseSync(':memory:');
  for (const file of files) {
    const source = readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8');
    // A line comment would swallow every statement after it once lines are joined.
    assert.ok(!source.includes('--'), `${file} has no "--"`);
    assert.ok((source.match(/\/\*/g) || []).length <= 1, `${file} has at most one block comment`);
    const flat = source.replace(/\r?\n/g, ' ');
    assert.ok(!flat.includes('\n'));
    assert.ok(/;\s*$/.test(flat), `${file} ends with ";"`);
    // Alone, in a fresh database (as pasted), and again on top (safe to re-run).
    const fresh = new DatabaseSync(':memory:');
    if (file !== files[0]) fresh.exec(readFileSync(new URL(`../migrations/${files[0]}`, import.meta.url), 'utf8').replace(/\r?\n/g, ' '));
    const objects = () => fresh.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get().n;
    const before = objects();
    fresh.exec(flat);
    // SQLite runs a comment-only string without complaint, so check that tables appeared.
    assert.ok(objects() > before, `${file} creates its tables when flattened`);
    fresh.exec(flat);
    sqlite.exec(flat);
  }
  const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
  assert.deepEqual(tables, ['events', 'feedback', 'gifts', 'orders', 'partner_code_rejections', 'partner_payouts', 'partner_profiles', 'partner_sale_taxes', 'partner_sales', 'partner_visits', 'payments', 'purchases', 'refunds', 'reviews', 'revocations', 'team_request_partners', 'team_requests', 'waitlist']);
  const teamColumns = sqlite.prepare('PRAGMA table_info(team_requests)').all();
  const column = name => teamColumns.find(row => row.name === name);
  assert.deepEqual(['plan', 'currency', 'kind'].map(name => [column(name)?.type, column(name)?.notnull, column(name)?.dflt_value]), [['TEXT', 1, "''"], ['TEXT', 1, "''"], ['TEXT', 1, "'quote'"]]);
});
