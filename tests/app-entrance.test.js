import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { ENTRANCE_BUDGET_MS, ENTRANCE_SEEN_KEY, FAILSAFE_MS, LATE_BOOT_MS, entranceMode, entranceSchedule, hasLaunchDialog, shouldPlay, startAppEntrance } from '../src/features/app-entrance.js';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: key => (data.has(key) ? data.get(key) : null), setItem: (key, value) => data.set(key, String(value)), removeItem: key => data.delete(key), data };
}

function fakeDocument({ animate = true } = {}) {
  const attributes = new Map([['data-booting', '']]);
  const documentElement = { dataset: {}, removeAttribute: name => attributes.delete(name), hasAttribute: name => attributes.has(name) };
  if (animate) documentElement.animate = () => ({ finished: Promise.resolve(), finish() {} });
  return { documentElement, visibilityState: 'visible', querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {} };
}

test('a cold, visible navigation earns the entrance', () => {
  assert.equal(shouldPlay({}), true);
  assert.equal(shouldPlay({ navigationType: 'navigate' }), true);
  assert.equal(shouldPlay({ navigationType: 'reload' }), true, 'a reload in a new session (the flag is per session) still counts as a first look');
});

test('it never plays with reduced motion, in the background, from history, twice a session or under a launch dialog', () => {
  assert.equal(shouldPlay({ reducedMotion: true }), false);
  assert.equal(shouldPlay({ visible: false }), false);
  assert.equal(shouldPlay({ navigationType: 'back_forward' }), false);
  assert.equal(shouldPlay({ navigationType: 'prerender' }), false);
  assert.equal(shouldPlay({ seen: true }), false);
  assert.equal(shouldPlay({ dialog: true }), false);
});

test('gift, purchase and licence links open a dialog on launch; other parameters do not', () => {
  assert.equal(hasLaunchDialog('?license=abc'), true);
  assert.equal(hasLaunchDialog('?gift=ABCD-EFGH-JKMN'), true);
  assert.equal(hasLaunchDialog('?checkout_id=ch_1&order_id=o_1'), true);
  assert.equal(hasLaunchDialog('?purchase=p_1'), true);
  assert.equal(hasLaunchDialog('?ref=partner'), false);
  assert.equal(hasLaunchDialog(''), false);
  assert.equal(hasLaunchDialog(undefined), false);
});

test('a slow device gets a short fade, a very slow one nothing', () => {
  assert.equal(entranceMode({ bootMs: 420 }), 'full');
  assert.equal(entranceMode({ bootMs: LATE_BOOT_MS + 1 }), 'fade');
  assert.equal(entranceMode({ bootMs: 420, frameLagMs: 200 }), 'fade', 'a late first frame steps the stagger aside');
  assert.equal(entranceMode({ bootMs: 420, frameLagMs: 500 }), 'none');
  assert.equal(entranceMode({ bootMs: FAILSAFE_MS }), 'none', 'the stylesheet has already shown the planner');
  assert.equal(entranceMode({ bootMs: 420, reducedMotion: true }), 'none');
  assert.equal(entranceMode({ bootMs: 420, seen: true }), 'none');
});

test('the choreography lands within the budget, header first, however much is on screen', () => {
  for (const counts of [{ header: 5, grid: 1, left: 6, right: 6, meter: 1 }, { header: 4, left: 5, dock: 1 }, { header: 12, left: 40, right: 60, dock: 2 }]) {
    const plan = entranceSchedule(counts);
    assert.ok(plan.total <= ENTRANCE_BUDGET_MS, `total ${plan.total} ms`);
    Object.entries(counts).forEach(([name, count]) => {
      assert.equal(plan[name].length, count);
      plan[name].forEach((step, index) => {
        assert.ok(step.delay >= 0 && step.duration > 0);
        assert.ok(step.delay + step.duration <= ENTRANCE_BUDGET_MS);
        if (index) assert.ok(step.delay >= plan[name][index - 1].delay, 'a group staggers top to bottom');
      });
    });
    assert.equal(plan.header[0].delay, 0, 'the header starts on the first frame');
    assert.ok(plan.left[0].delay > plan.header[0].delay, 'the day follows the header');
  }
  assert.equal(entranceSchedule({}).total, 0);
  assert.ok(entranceSchedule({ header: 1 }).header[0].distance < 0, 'the header settles down, the day rises up');
  assert.ok(entranceSchedule({ left: 1 }).left[0].distance > 0);
});

test('the stylesheet failsafe and the module agree on when the planner shows by itself', () => {
  const css = read('styles/entrance.css');
  const match = /\[data-booting\] \.planner \{[^}]*animation: entrance-failsafe 1ms linear (\d+)ms forwards/.exec(css);
  assert.ok(match, 'entrance.css keeps the planner hidden only until its failsafe');
  assert.equal(Number(match[1]), FAILSAFE_MS);
  assert.match(read('styles.css'), /@import url\('\.\/styles\/entrance\.css'\);/);
});

test('the head script marks the document booting and applies a saved theme before the first paint', () => {
  const html = read('index.html');
  const head = html.slice(0, html.indexOf('</head>'));
  const script = /<script>([^<]*data-booting[^<]*)<\/script>/.exec(head)?.[1];
  assert.ok(script, 'an inline script in <head> sets data-booting');
  assert.ok(head.indexOf('name="color-scheme"') < head.indexOf(script), 'the script comes after the colour metas it updates');
  const run = saved => {
    const attributes = {};
    const metas = [{ content: '#f6f3ed' }, { content: '#141311' }];
    const scheme = { content: 'light dark' };
    const documentElement = { dataset: {}, setAttribute: (name, value) => { attributes[name] = value; } };
    const document = { documentElement, querySelectorAll: () => metas, querySelector: () => scheme };
    const localStorage = { getItem: () => saved };
    vm.runInNewContext(script, { document, localStorage });
    return { attributes, theme: documentElement.dataset.theme, metas: metas.map(meta => meta.content), scheme: scheme.content };
  };
  assert.deepEqual(run(null), { attributes: { 'data-booting': '' }, theme: undefined, metas: ['#f6f3ed', '#141311'], scheme: 'light dark' }, 'following the system leaves the media-specific colours alone');
  assert.deepEqual(run('dark'), { attributes: { 'data-booting': '' }, theme: 'dark', metas: ['#141311', '#141311'], scheme: 'dark' });
  assert.deepEqual(run('light'), { attributes: { 'data-booting': '' }, theme: 'light', metas: ['#f6f3ed', '#f6f3ed'], scheme: 'light' });
  assert.equal(run('sepia').theme, undefined);
});

test('the planner is released at once when the entrance does not play, and the session remembers the first look', () => {
  const storage = memoryStorage();
  const first = fakeDocument();
  const originalRaf = globalThis.requestAnimationFrame;
  const frames = [];
  globalThis.requestAnimationFrame = callback => frames.push(callback);
  try {
    assert.notEqual(startAppEntrance({ doc: first, storage }), 'none', 'full, or a fade if this test process is slow to get here');
    assert.equal(storage.getItem(ENTRANCE_SEEN_KEY), '1');
    assert.equal(first.documentElement.hasAttribute('data-booting'), true, 'held until the first frame of the entrance');
    frames.shift()();
    assert.equal(first.documentElement.hasAttribute('data-booting'), false);

    const again = fakeDocument();
    assert.equal(startAppEntrance({ doc: again, storage }), 'none', 'once per session');
    assert.equal(again.documentElement.hasAttribute('data-booting'), false, 'released synchronously');
    assert.equal(frames.length, 0);

    const setup = fakeDocument();
    assert.equal(startAppEntrance({ doc: setup, storage: memoryStorage(), dialog: true }), 'none', 'first-run setup opens on top');
    assert.equal(setup.documentElement.hasAttribute('data-booting'), false);

    const old = fakeDocument({ animate: false });
    assert.equal(startAppEntrance({ doc: old, storage: memoryStorage() }), 'none', 'no Web Animations: the planner simply appears');
    assert.equal(old.documentElement.hasAttribute('data-booting'), false);

    const broken = fakeDocument();
    broken.querySelector = () => { throw new Error('boom'); };
    startAppEntrance({ doc: broken, storage: memoryStorage() });
    frames.shift()();
    assert.equal(broken.documentElement.hasAttribute('data-booting'), false, 'a failure still shows the planner');
  } finally {
    globalThis.requestAnimationFrame = originalRaf;
  }
});

test('blocked storage (an opaque origin, cookies off) never stops the planner from showing', () => {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get() { throw new Error('SecurityError: access is denied for this document'); } });
  try {
    const doc = fakeDocument({ animate: false });
    assert.doesNotThrow(() => startAppEntrance({ doc }));
    assert.equal(doc.documentElement.hasAttribute('data-booting'), false);
  } finally {
    if (before) Object.defineProperty(globalThis, 'sessionStorage', before);
    else delete globalThis.sessionStorage;
  }
});

test('the installed app opens on the planner’s paper, light or dark', () => {
  const manifest = JSON.parse(read('manifest.webmanifest'));
  assert.equal(manifest.background_color, '#f6f3ed');
  assert.equal(manifest.theme_color, '#f6f3ed');
  assert.deepEqual(manifest.user_preferences?.color_scheme?.dark, { background_color: '#151412', theme_color: '#141311' });
});
