import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// config.js reads the runtime configuration when it loads: switch the owner
// API on and stub the browser pieces trackEvent() touches before importing.
globalThis.__DAILY_PLANNER_CONFIG__ = { PLANNER_API_URL: '/api/' };
const stored = new Map();
const storage = {
  getItem: key => (stored.has(key) ? stored.get(key) : null),
  setItem: (key, value) => stored.set(key, String(value)),
  removeItem: key => stored.delete(key)
};
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
const requests = [];
globalThis.fetch = async (url, options = {}) => {
  requests.push({ url, body: JSON.parse(options.body || '{}') });
  return { ok: true, json: async () => ({ ok: true }) };
};

const api = await import('../src/lib/planner-api.js');
const { privacyNoticeSections } = await import('../src/features/privacy.js');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const text = sections => sections.flatMap(section => [section.title, ...section.paragraphs, ...(section.list || []), ...(section.after || [])]).join(' ');
const ids = sections => sections.map(section => section.id);

test('with nothing configured the notice says no network requests are made', () => {
  const sections = privacyNoticeSections({ plannerApi: false, googleDrive: false });
  assert.deepEqual(ids(sections), ['local']);
  assert.match(text(sections), /makes no network requests after it has loaded/);
  assert.doesNotMatch(text(sections), /usage counts|Google Drive/);
});

test('with the owner API on, the notice names every counted moment and the opt-out', () => {
  const sections = privacyNoticeSections({ plannerApi: true, googleDrive: false });
  assert.deepEqual(ids(sections), ['local', 'counts', 'submissions']);
  const counts = sections.find(section => section.id === 'counts');
  assert.deepEqual(counts.list, api.COUNTED_EVENTS.map(([, words]) => words));
  assert.ok(counts.list.includes('finished setup') && counts.list.includes('opened the sync guide'));
  assert.equal(counts.toggle, true);
  const all = text(sections);
  assert.match(all, /No identifiers, no cookies, your IP address is not stored/);
  assert.match(all, /deleted on request/);
  assert.match(all, /keep working when usage counts are off/);
  assert.doesNotMatch(all, /no network requests/, 'an API copy does make requests');
  assert.doesNotMatch(all, /one hidden file in your own Drive/, 'no Drive section without a client ID');
});

test('the waitlist says it is emailed once, deleted afterwards and can be left from the sync guide', () => {
  const all = text(privacyNoticeSections({ plannerApi: true }));
  assert.match(all, /emailed once, through our email provider, when account sync is ready — and then deleted automatically/);
  assert.match(all, /remove yours at any time from the sync guide/);
});

test('with Plus configured, the notice says what a gift and a purchase send — and nothing else', () => {
  assert.deepEqual(ids(privacyNoticeSections({ plannerApi: true, plus: true })), ['local', 'counts', 'submissions', 'plus']);
  assert.deepEqual(ids(privacyNoticeSections({ plannerApi: false, plus: true })), ['local'], 'no API: nothing is sent for Plus either');
  const plusSection = privacyNoticeSections({ plannerApi: true, plus: true }).find(section => section.id === 'plus');
  const words = text([plusSection]);
  assert.match(words, /checked on this device/);
  assert.match(words, /no account, and nothing else is sent/i);
  assert.match(words, /Activating a gift sends only the gift code/);
  assert.match(words, /purchase sends only the Stripe checkout reference/);
  const counts = privacyNoticeSections({ plannerApi: true }).find(section => section.id === 'counts');
  for (const words of ['opened the Plus details', 'went to buy Plus', 'unlocked Plus', 'opened a gift link', 'activated a gift']) assert.ok(counts.list.includes(words), words);
  const landing = new Map(api.LANDING_EVENTS);
  assert.equal(landing.get('pack_checkout_clicked'), 'went to buy a team gift');
  assert.equal(landing.get('gift_link_copied'), 'copied a team gift link');
});

test('Google Drive sync is described only when a client ID is configured', () => {
  const driveOnly = privacyNoticeSections({ plannerApi: false, googleDrive: true });
  assert.deepEqual(ids(driveOnly), ['local', 'drive']);
  assert.match(text(driveOnly), /Apart from Google Drive sync, which only starts when you connect it/);
  assert.match(text(driveOnly), /one hidden file in your own Drive/);
  assert.match(text(driveOnly), /never passes through or stays on our servers/);
  assert.deepEqual(ids(privacyNoticeSections({ plannerApi: true, googleDrive: true })), ['local', 'counts', 'submissions', 'drive']);
});

test('trackEvent sends allow-listed counts only, and nothing once switched off on this device', async () => {
  requests.length = 0;
  stored.clear();
  assert.equal(api.usageCountsEnabled(), true, 'on by default');
  api.trackEvent('onboarding_completed');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/events');
  assert.deepEqual(Object.keys(requests[0].body).sort(), ['name', 'version'], 'no identifiers in the payload');
  api.trackEvent('not_a_listed_moment');
  assert.equal(requests.length, 1, 'unlisted moments are never sent');

  api.setUsageCountsEnabled(false);
  assert.equal(stored.get(api.USAGE_COUNTS_KEY), 'off');
  api.trackEvent('onboarding_completed');
  api.trackEvent('feedback_opened');
  assert.equal(requests.length, 1, 'switched off: no count leaves the device');

  const joined = await api.joinWaitlist({ email: 'someone@example.com', consent: true });
  assert.equal(joined.ok, true);
  assert.equal(requests.length, 2, 'an explicit waitlist submission still works');
  assert.equal(requests[1].url, '/api/waitlist');

  api.setUsageCountsEnabled(true);
  api.trackEvent('trophy_unlocked');
  assert.equal(requests.length, 3, 'switched back on');
});

test('an unreadable preference never blocks the planner', () => {
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(api.usageCountsEnabled(broken), true);
  assert.doesNotThrow(() => api.setUsageCountsEnabled(false, broken));
});

test('every trackEvent() call in the planner is listed in the Privacy notice', async () => {
  const files = ['app.js'];
  const walk = async dir => {
    for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await walk(rel);
      else if (rel.endsWith('.js')) files.push(rel);
    }
  };
  await walk('src');
  const listed = new Set(api.COUNTED_EVENTS.map(([name]) => name));
  const used = new Set();
  for (const file of files) {
    const source = await readFile(join(root, file), 'utf8');
    // trackEvent('…') directly, or ctx.track?.('…') from features that receive it.
    for (const match of source.matchAll(/(?:trackEvent|\btrack(?:\?\.)?)\(\s*'([a-z0-9_]+)'\s*\)/g)) used.add(match[1]);
  }
  assert.ok(used.size >= 10, 'found the planner’s counts');
  for (const name of used) assert.ok(listed.has(name), `${name} is counted but not described in the Privacy notice`);
  for (const name of listed) assert.ok(used.has(name), `${name} is described but never counted`);
});
