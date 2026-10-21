import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HERO_VIEWS, HOLDS, rotationLeft, rotationPlays, rotationRunning, rotationSeen, rotationStart, rotationStep } from '../welcome/hero-views.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => readFile(join(root, rel), 'utf8');

const [DAY, YEAR] = HERO_VIEWS;
const step = (state, ...events) => events.reduce((current, event) => rotationStep(current, event), state);

test('the hero shows your day, then your year, each for its own time, and starts again', () => {
  assert.deepEqual(HERO_VIEWS.map(view => [view.id, view.scene]), [['day', 'day'], ['year', 'horizon']]);
  const start = rotationStart();
  assert.deepEqual(start, { view: 'day', elapsed: 0, auto: true, motion: true, holds: [], cue: '' });
  assert.equal(rotationRunning(start), true);
  assert.equal(rotationLeft(start), DAY.dwell);

  const part = rotationStep(start, { type: 'tick', ms: 4000 });
  assert.equal(part.view, 'day');
  assert.equal(part.elapsed, 4000);
  assert.equal(part.cue, '');
  assert.equal(rotationLeft(part), DAY.dwell - 4000);

  const year = rotationStep(part, { type: 'tick', ms: DAY.dwell - 4000 });
  assert.equal(year.view, 'year');
  assert.equal(year.elapsed, 0, 'the next view starts its own time');
  assert.equal(year.cue, 'switch');
  assert.equal(rotationLeft(year), YEAR.dwell);

  const back = rotationStep(year, { type: 'tick', ms: YEAR.dwell + 500 });
  assert.equal(back.view, 'day', 'and back to the day');
  assert.equal(back.cue, 'switch');
  assert.equal(rotationStep(back, { type: 'tick', ms: -50 }).elapsed, 0, 'time never runs backwards');
  assert.equal(rotationStep(back, { type: 'tick' }).elapsed, 0);
});

test('choosing a view shows it now and gives it its whole time', () => {
  const later = rotationStep(rotationStart(), { type: 'tick', ms: 9000 });
  const chosen = rotationStep(later, { type: 'choose', view: 'year' });
  assert.equal(chosen.view, 'year');
  assert.equal(chosen.elapsed, 0);
  assert.equal(chosen.cue, 'switch');
  assert.equal(chosen.auto, true, 'the turns go on');
  const same = rotationStep(chosen, { type: 'choose', view: 'year' });
  assert.equal(same.cue, '', 'the view already shown: nothing happens');
  assert.equal(rotationStep(chosen, { type: 'choose', view: 'week' }).view, 'year', 'an unknown view is ignored');
});

test('the pointer over the replica or keyboard focus on a choice holds the turn, and the scene plays on', () => {
  const start = rotationStep(rotationStart(), { type: 'tick', ms: 3000 });
  for (const reason of ['hover', 'focus']) {
    const held = rotationStep(start, { type: 'hold', reason, on: true });
    assert.equal(held.cue, '', `${reason}: the scene isn't touched`);
    assert.equal(rotationRunning(held), false);
    assert.equal(rotationPlays(held), true);
    const still = rotationStep(held, { type: 'tick', ms: 60000 });
    assert.equal(still.view, 'day', `${reason}: no turn while held`);
    assert.equal(still.elapsed, 3000, `${reason}: the time left is kept`);
    const free = rotationStep(still, { type: 'hold', reason, on: false });
    assert.equal(rotationRunning(free), true);
    assert.equal(free.elapsed, 3000, `${reason}: it goes on from where it was`);
  }
  const both = step(start, { type: 'hold', reason: 'hover', on: true }, { type: 'hold', reason: 'focus', on: true }, { type: 'hold', reason: 'hover', on: false });
  assert.equal(rotationRunning(both), false, 'every reason has to end');
  assert.deepEqual(both.holds, ['focus']);
  assert.deepEqual(rotationStep(both, { type: 'hold', reason: 'focus', on: true }).holds, ['focus'], 'a reason counts once');
  assert.deepEqual(rotationStep(start, { type: 'hold', reason: 'hover', on: false }).holds, [], 'ending what never started changes nothing');
});

test('a hidden tab or the hero off screen stops the scene; back in view it plays again from its start', () => {
  const running = step(rotationStart(), { type: 'choose', view: 'year' }, { type: 'tick', ms: 4000 });
  for (const reason of ['hidden', 'offscreen']) {
    const away = rotationStep(running, { type: 'hold', reason, on: true });
    assert.equal(away.cue, 'freeze', reason);
    assert.equal(rotationSeen(away), false);
    assert.equal(rotationPlays(away), false);
    const back = rotationStep(away, { type: 'hold', reason, on: false });
    assert.equal(back.cue, 'restart', reason);
    assert.equal(back.elapsed, 0, `${reason}: its whole time again`);
    assert.equal(back.view, 'year', `${reason}: the same view`);
  }
  // Both at once: the scene starts again only when both are over.
  const twice = step(running, { type: 'hold', reason: 'offscreen', on: true }, { type: 'hold', reason: 'hidden', on: true });
  assert.equal(twice.cue, '', 'already stopped');
  const half = rotationStep(twice, { type: 'hold', reason: 'hidden', on: false });
  assert.equal(half.cue, '');
  assert.equal(rotationStep(half, { type: 'hold', reason: 'offscreen', on: false }).cue, 'restart');
  // The page starts off screen until the observer says otherwise.
  const first = rotationStart({ holds: ['offscreen', '', 'nope'] });
  assert.deepEqual(first.holds, ['offscreen']);
  assert.equal(rotationStep(first, { type: 'hold', reason: 'offscreen', on: false }).cue, 'restart', 'the day plays as soon as the hero is seen');
  assert.equal(rotationStep(first, { type: 'hold', reason: 'later', on: true }).holds.length, 1, 'unknown reasons are ignored');
  assert.deepEqual(HOLDS, ['hover', 'focus', 'hidden', 'offscreen']);
});

test('pause stops the turns and the scene on its last frame; play starts the scene again', () => {
  const start = rotationStep(rotationStart(), { type: 'tick', ms: 5000 });
  const paused = rotationStep(start, { type: 'toggle' });
  assert.equal(paused.auto, false);
  assert.equal(paused.cue, 'finish');
  assert.equal(rotationRunning(paused), false);
  assert.equal(rotationPlays(paused), false);
  assert.equal(rotationStep(paused, { type: 'tick', ms: 60000 }).view, 'day', 'no turn while paused');
  const chosen = rotationStep(paused, { type: 'choose', view: 'year' });
  assert.equal(chosen.cue, 'switch', 'the choice still works, on its last frame');
  assert.equal(rotationPlays(chosen), false);
  assert.equal(rotationStep(paused, { type: 'hold', reason: 'offscreen', on: true }).cue, '', 'nothing to stop');
  assert.equal(step(paused, { type: 'hold', reason: 'offscreen', on: true }, { type: 'hold', reason: 'offscreen', on: false }).cue, '', 'nothing to start');
  const played = rotationStep(chosen, { type: 'toggle' });
  assert.equal(played.auto, true);
  assert.equal(played.cue, 'restart');
  assert.equal(played.elapsed, 0);
  assert.equal(rotationRunning(played), true);
  const unseen = step(paused, { type: 'hold', reason: 'hidden', on: true }, { type: 'toggle' });
  assert.equal(unseen.cue, '', 'played while hidden: it starts once seen');
  assert.equal(rotationStep(unseen, { type: 'hold', reason: 'hidden', on: false }).cue, 'restart');
});

test('reduced motion: nothing turns or plays, the choice still switches, and motion can come back', () => {
  const still = rotationStart({ motion: false });
  assert.equal(rotationRunning(still), false);
  assert.equal(rotationPlays(still), false);
  assert.equal(rotationStep(still, { type: 'tick', ms: 60000 }).view, 'day');
  assert.equal(rotationStep(still, { type: 'toggle' }).cue, '', 'no pause without motion');
  const chosen = rotationStep(still, { type: 'choose', view: 'year' });
  assert.equal(chosen.cue, 'switch');
  assert.equal(rotationStep(chosen, { type: 'hold', reason: 'offscreen', on: true }).cue, '');
  const moving = rotationStep(chosen, { type: 'motion', on: true });
  assert.equal(moving.cue, 'restart');
  assert.equal(moving.auto, true);
  assert.equal(rotationRunning(moving), true);
  // Paused by the visitor, then reduced motion on and off again: still paused, on its last frame.
  const paused = step(rotationStart(), { type: 'tick', ms: 3000 }, { type: 'toggle' }, { type: 'motion', on: false });
  assert.equal(paused.auto, false);
  const back = rotationStep(paused, { type: 'motion', on: true });
  assert.equal(back.auto, false, 'the pause is kept');
  assert.equal(back.motion, true);
  assert.equal(back.cue, 'finish', 'the scene stands on its last frame');
  assert.equal(rotationRunning(back), false);
  assert.equal(rotationPlays(back), false);
  assert.equal(rotationStep(back, { type: 'tick', ms: 60000 }).view, 'day', 'no turn');
  assert.equal(rotationStep(back, { type: 'toggle' }).cue, 'restart', 'play still starts it');
  const off = rotationStep(rotationStep(rotationStart(), { type: 'tick', ms: 2000 }), { type: 'motion', on: false });
  assert.equal(off.cue, 'finish');
  assert.equal(off.motion, false);
  assert.equal(off.elapsed, 0);
  assert.equal(rotationStep(off, { type: 'motion', on: false }).cue, '', 'no change, no cue');
});

test('each view stays long enough for its scene to end, and the scenes it plays have scripts', async () => {
  const landing = await read('welcome/landing.js');
  const lengthOf = name => Number(new RegExp(`\\n  ${name}: \\{\\s*length: (\\d+)`).exec(landing)?.[1]);
  for (const view of HERO_VIEWS) {
    const length = lengthOf(view.scene);
    assert.ok(length > 0, `${view.scene} has a script`);
    assert.ok(view.dwell >= length, `${view.id}: its time covers its script`);
  }
  // The day's last change (its streak) comes well before its turn ends.
  assert.match(landing, /t\.count\(qs\('\[data-count\]', t\.root\), 11700, 300\)/);
  assert.ok(DAY.dwell - 12000 >= 1200, 'a moment on the painted month');
  assert.match(landing, /import \{ setupHeroViews \} from '\.\/hero-views\.js';/);
  assert.match(landing, /const scenes = setupScenes\(\{ scripts: SCRIPTS, motionOn, motionHooks \}\);\s*setupHeroViews\(qs\('\[data-hero-views\]'\), \{ scene: scenes\.scene, motionOn, motionHooks \}\);/);
  const scenes = await read('welcome/scenes.js');
  assert.match(scenes, /const watched = scenes\.filter\(scene => !scene\.root\.hasAttribute\('data-scene-driven'\)\);/, 'driven scenes are not played by scrolling');
  assert.match(scenes, /watched\.forEach\(scene => observer\.observe\(scene\.root\)\);/);
  assert.match(scenes, /return found;/);
  const module = await read('welcome/hero-views.js');
  assert.doesNotMatch(module, /^import /m, 'no imports: the preview inlines it as it is');
});

test('the hero: two replicas in one box, a labelled choice, a pause, a caption for each', async () => {
  const page = await read('welcome/index.html');
  const hero = /<section class="hero"[\s\S]*?<\/section>/.exec(page)[0];
  assert.match(hero, /<h1 id="hero-title"><span>Plan what matters\.<\/span> <span>Close the day\.<\/span> <span>Keep the year in view\.<\/span><\/h1>/, 'the heading is unchanged');
  assert.match(hero, /<figure class="hero__visual" data-hero-views>\s*<div class="rp-scale hero-stage">\s*<div class="hero-view hero-view--day is-shown" data-hero-view="day">/);
  assert.match(hero, /<div class="hero-view hero-view--year" data-hero-view="year">/);
  // Both replicas are pictures for sighted visitors, played by the hero.
  assert.match(hero, /data-scene="day" data-final="s-mit s-block s-closed" data-scene-driven data-first-frame aria-hidden="true"/, 'the day keeps its first frame before the script');
  assert.match(hero, /data-scene="horizon" data-final="s-in s-key s-lived s-step" data-scene-driven aria-hidden="true"/);
  assert.equal((hero.match(/data-first-frame/g) || []).length, 1, 'only the day is shown on first paint');
  // The choice: native radio buttons in a labelled group, the day first.
  assert.match(hero, /<div class="hero-switch__views" role="radiogroup" aria-label="What the planner shows">/);
  const choices = [...hero.matchAll(/<label class="hero-switch__view"><input type="radio" name="hero-view" value="(\w+)"( checked)? autocomplete="off" data-hero-choice>[\s\S]*?<span>([^<]+)<\/span><\/label>/g)].map(match => [match[1], !!match[2], match[3]]);
  assert.deepEqual(choices, [['day', true, 'Your day'], ['year', false, 'Your year']]);
  assert.deepEqual(choices.map(choice => choice[0]), HERO_VIEWS.map(view => view.id));
  assert.match(hero, /<span class="hero-switch__thumb" aria-hidden="true"><i class="hero-switch__fill" data-hero-fill><\/i><\/span>/);
  assert.match(hero, /<button class="hero-switch__pause" type="button" data-hero-pause>[\s\S]*?<span class="sr-only" data-hero-pause-label>Pause the animation<\/span><\/button>/);
  assert.match(hero, /<figcaption class="hero-captions">\s*<span data-hero-caption="day">A day in the planner:[^<]+<\/span>\s*<span data-hero-caption="year">Horizon, the year in the planner:[^<]+<\/span>\s*<\/figcaption>/);
  // Every icon the hero uses is in the page's sprite.
  const symbols = new Set([...page.matchAll(/<symbol id="([^"]+)"/g)].map(match => match[1]));
  for (const id of new Set([...hero.matchAll(/<use href="#([^"]+)"/g)].map(match => match[1]))) assert.ok(symbols.has(id), `#${id}`);
  for (const id of ['i-day', 'i-heart', 'i-pause', 'i-play']) assert.ok(symbols.has(id), id);
  // Counted numbers start from what the scene shows first.
  for (const [, to, from] of hero.matchAll(/data-count="(\d+)" data-from="(\d+)" data-at="\w+">(\d+)</g)) assert.ok(Number(to) > Number(from));
});

test('hero styles: the views share a box, the switch works without the script, motion only behind motion-ok', async () => {
  const css = await read('welcome/landing.css');
  assert.match(css, /\.hero-view \{ z-index: 0; grid-area: 1 \/ 1;/, 'one cell, each view stacked on its own');
  assert.match(css, /\.hero__visual:not\(\.is-live\):has\(\[data-hero-choice\]\[value="year"\]:checked\) :is\(\.hero-view--day, \[data-hero-caption="day"\]\) \{ visibility: hidden; \}/);
  assert.match(css, /\.hero__visual\.is-live \.hero-view\.is-shown \{ z-index: 1; visibility: visible; \}/);
  assert.match(css, /\.motion-ok \.hero-view\.is-entering \{ animation: hero-view-in/);
  assert.match(css, /\.js-anim \.hero-switch__pause,\n\.hero__visual\.is-moving \.hero-switch__pause \{ display: grid; \}/, 'the pause shows from first paint when motion is welcome');
  assert.match(css, /\.hero-switch__view:has\(input:focus-visible\) \{ outline: 2\.5px solid var\(--focus\);/, 'visible focus');
  // Every transition or animation of the Horizon replica waits for motion-ok.
  const horizon = /\/\* Hero: Horizon -+ \*\/([\s\S]*?)\/\* Close day -+ \*\//.exec(css)[1];
  for (const rule of horizon.split('\n').filter(line => /\b(transition|animation):/.test(line))) assert.match(rule.trim(), /^\.motion-ok /, rule);
});

test('the welcome pages use the planner’s scrollbar, without the browser’s arrows', async () => {
  const css = await read('welcome/landing.css');
  assert.match(css, /@supports not selector\(::-webkit-scrollbar\) \{\n {2}html,\n {2}\* \{ scrollbar-width: thin; scrollbar-color: var\(--scrollbar-thumb\) transparent; \}\n\}/, 'standard properties only where ::-webkit-scrollbar is unknown');
  const outside = css.replace(/@supports not selector\(::-webkit-scrollbar\) \{[\s\S]*?\n\}/, '');
  assert.doesNotMatch(outside, /scrollbar-(?:width|color):/, 'set anywhere else, Chromium would ignore the parts below and draw arrows');
  assert.match(css, /\*::-webkit-scrollbar-button \{ display: none; width: 0; height: 0; \}/);
  assert.match(css, /\*::-webkit-scrollbar-thumb:hover \{\n {2}background: var\(--scrollbar-thumb-hover\);/);
  assert.match(css, /--scrollbar-thumb: color-mix\(in srgb, var\(--line\) 82%, var\(--paper\)\);/, 'the planner’s colours (styles/core.css)');
  for (const page of ['welcome/index.html', 'welcome/teams/index.html', 'welcome/partners/index.html', 'welcome/thanks/index.html']) {
    assert.match(await read(page), /<link rel="stylesheet" href="(?:\.\.\/)?(?:\.\/)?landing\.css">/, page);
  }
});

test('the caption is painted at once and stays one node: a turn changes its text, never adds a Largest Contentful Paint', async () => {
  const css = await read('welcome/landing.css');
  // The stage and the switch rise in; the caption, out of the rise-in, is on screen from first paint.
  assert.match(css, /\.hero__visual > :not\(\.hero-captions\) \{ animation: rise-in 820ms/);
  assert.match(css, /\.hero__visual > :not\(\.hero-captions\) \{ animation-duration: 1000ms; animation-delay: 180ms; \}/);
  assert.doesNotMatch(css, /\.hero__visual \{[^}]*animation/, 'the figure itself (with its caption) does not fade in');
  // With the script, no caption is shown or hidden: the first one gets each view's text.
  assert.doesNotMatch(css, /\.hero__visual\.is-live[^{]*\[data-hero-caption/, 'no caption toggles once live');
  assert.match(css, /\.hero-captions \[data-hero-caption="year"\] \{ visibility: hidden; \}|\.hero-view--year,\n\.hero-captions \[data-hero-caption="year"\] \{ visibility: hidden; \}/, 'the others keep the box at the tallest caption, hidden');
  const module = await read('welcome/hero-views.js');
  assert.match(module, /const caption = captionNodes\[0\] \|\| null;/);
  assert.match(module, /caption\.textContent = text;/);
  assert.match(module, /caption\.animate\(\[\{ opacity: 0 \}, \{ opacity: 1 \}\]/, 'with motion it fades in with the view, on the same node');
  assert.doesNotMatch(module, /caption[A-Za-z]*\.(?:hidden|style\.visibility)/);
});

test('a view going out is reset to its first frame with its transitions off, so none runs unseen', async () => {
  const module = await read('welcome/hero-views.js');
  const rearm = /function rearm\(pane, replica\) \{([\s\S]*?)\n {2}\}/.exec(module)?.[1] || '';
  assert.ok(rearm.includes('replica.arm()') && rearm.indexOf("pane.classList.add('is-resetting')") < rearm.indexOf('replica.arm()'), 'transitions off first');
  assert.ok(rearm.indexOf('replica.arm()') < rearm.indexOf('void pane.offsetWidth') && rearm.indexOf('void pane.offsetWidth') < rearm.indexOf("pane.classList.remove('is-resetting')"), 'the reset styles apply before transitions are back');
  assert.match(module, /if \(key !== id && state\.motion\) rearm\(pane, scenes\.get\(key\)\);/);
  const css = await read('welcome/landing.css');
  // More specific than any replica transition (at most four classes), pseudo-elements included.
  assert.match(css, /\.motion-ok \.hero__visual\.is-live \.hero-view\.is-resetting \*,\n\.motion-ok \.hero__visual\.is-live \.hero-view\.is-resetting \*::before,\n\.motion-ok \.hero__visual\.is-live \.hero-view\.is-resetting \*::after \{ transition: none; \}/);
  // Every transition the two hero replicas can run (the other scenes' own rules aside).
  const selectors = [...css.matchAll(/^\s*(\.motion-ok [^{]*)\{[^}]*\btransition:/gm)].flatMap(match => match[1].split(/,(?![^(]*\))/)).map(selector => selector.trim());
  // (The panes' own entrance and exit run on visible panes, before any reset.)
  const hero = selectors.filter(selector => /\.rp(?:\b|-)/.test(selector) && !/\.rp--(?!day\b|horizon\b)[\w-]+/.test(selector) && !/\.(?:yp|mg)-|\.hero-/.test(selector));
  assert.ok(hero.length > 20, `${hero.length} replica transitions found`);
  for (const selector of hero) {
    const classes = (selector.match(/[.:][\w-]+/g) || []).length;
    assert.ok(classes <= 4 || /is-resetting/.test(selector), `${selector} would beat the reset`);
  }
});

test('narrower than the switch’s rise, Horizon fills the whole box: no empty band above the switch', async () => {
  const css = await read('welcome/landing.css');
  assert.match(css, /@container hero-visual \(min-width: 520px\) \{\n {2}\.hero-switch \{ margin-top: calc\(18px - 3\.6 \* /, 'wide: the switch rises into the room under the windows');
  assert.match(css, /\.rp--horizon \{ padding: 0 0 3\.6em; \}/, 'the same room as the Day view, kept free when the switch rises into it');
  const narrow = /@container hero-visual \(max-width: 519\.98px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] || '';
  assert.match(narrow, /\.rp--horizon \{ padding-bottom: 0; \}/, 'narrow: its window takes that room');
  assert.match(narrow, /\.rp--horizon \.rp-hz-map \{ flex: 1 1 auto;/, 'shared between the year at a glance and the tiles');
  assert.match(narrow, /\.hero-view\.is-leaving \.rp--horizon \.rp-window \{ opacity: 0; \}/, 'going out, the taller window fades');
  assert.match(css, /\.hero-view > \.rp \{ flex: 1 1 auto; display: flex; flex-direction: column; \}/);
  assert.match(css, /\.hero-view \.rp-window \{ flex: 1 1 auto; \}/);
});
