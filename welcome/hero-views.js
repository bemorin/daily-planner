/**
 * The hero's replica (landing): Your day, then Your year. The Day view plays,
 * Horizon fades in over it and plays, then the Day view again, while the hero
 * is on screen. The switch under the replica names what is shown, fills a thin
 * line until the next turn and lets the visitor choose; the pause button stops
 * the turns and the animation. The turns wait while the pointer is over the
 * figure, while a choice has keyboard focus, while the tab is hidden and while
 * the hero is off screen (the last two also stop the scene, which plays again
 * from its start). With reduced motion nothing moves: each view shows its
 * final frame and the switch changes it at once.
 *
 * The choices are radio buttons, so the switch also works without JavaScript
 * (landing.css, with :has). The scenes are scenes.js scenes marked
 * `data-scene-driven`, played from here.
 *
 * No imports: the single-file preview inlines this module as it is. The pure
 * turns are unit-tested (tests/landing-hero.test.js).
 */

/** The views in order, the scene each plays and how long it stays (ms): its script, then a moment on its last frame. */
export const HERO_VIEWS = Object.freeze([
  Object.freeze({ id: 'day', scene: 'day', dwell: 14000 }),
  Object.freeze({ id: 'year', scene: 'horizon', dwell: 9800 })
]);

/** What makes the turns wait. The last two also stop the scene: nobody can see it. */
export const HOLDS = Object.freeze(['hover', 'focus', 'hidden', 'offscreen']);
const UNSEEN = ['hidden', 'offscreen'];

const dwellOf = (view, views) => (views.find(item => item.id === view) || views[0]).dwell;

/** The first state: the first view, its time not started. */
export function rotationStart({ motion = true, holds = [] } = {}, views = HERO_VIEWS) {
  return { view: views[0].id, elapsed: 0, auto: true, motion: !!motion, holds: HOLDS.filter(reason => holds.includes(reason)), cue: '' };
}

/** The clock runs: motion welcome, not paused, nothing holding it. */
export const rotationRunning = state => !!(state.motion && state.auto && !state.holds.length);

/** Nothing hides the replica (the tab is visible and the hero on screen). */
export const rotationSeen = state => !state.holds.some(reason => UNSEEN.includes(reason));

/** The current scene plays (rather than standing still on a frame). */
export const rotationPlays = state => !!(state.motion && state.auto && rotationSeen(state));

/** Time left before the next view (ms). */
export const rotationLeft = (state, views = HERO_VIEWS) => Math.max(0, dwellOf(state.view, views) - state.elapsed);

/**
 * One step of the turns. Events:
 *   { type: 'tick', ms }           time passed; counts only while the clock runs
 *   { type: 'choose', view }       the visitor picked a view
 *   { type: 'hold', reason, on }   a reason to wait starts or ends (HOLDS)
 *   { type: 'toggle' }             the pause button
 *   { type: 'motion', on }         reduced motion turned off or on
 * The new state's `cue` is what the page does now: 'switch' (show `view`:
 * its scene from the start, or its last frame when nothing plays),
 * 'restart' (the scene again from its start), 'freeze' (the scene stops
 * where it is), 'finish' (the scene on its last frame) or ''.
 */
export function rotationStep(state, event = {}, views = HERO_VIEWS) {
  const next = { ...state, holds: [...state.holds], cue: '' };
  if (event.type === 'tick') {
    if (!rotationRunning(state)) return next;
    const elapsed = state.elapsed + Math.max(0, Number(event.ms) || 0);
    if (elapsed < dwellOf(state.view, views)) return { ...next, elapsed };
    const index = views.findIndex(item => item.id === state.view);
    return { ...next, view: views[(index + 1) % views.length].id, elapsed: 0, cue: 'switch' };
  }
  if (event.type === 'choose') {
    if (event.view === state.view || !views.some(item => item.id === event.view)) return next;
    return { ...next, view: event.view, elapsed: 0, cue: 'switch' };
  }
  if (event.type === 'hold') {
    if (!HOLDS.includes(event.reason) || !!event.on === state.holds.includes(event.reason)) return next;
    const after = { ...next, holds: HOLDS.filter(reason => (reason === event.reason ? !!event.on : state.holds.includes(reason))) };
    if (!UNSEEN.includes(event.reason) || !state.motion || !state.auto) return after;
    if (rotationSeen(state) && !rotationSeen(after)) return { ...after, cue: 'freeze' };
    if (!rotationSeen(state) && rotationSeen(after)) return { ...after, elapsed: 0, cue: 'restart' };
    return after;
  }
  if (event.type === 'toggle') {
    if (!state.motion) return next;
    if (state.auto) return { ...next, auto: false, elapsed: 0, cue: 'finish' };
    return { ...next, auto: true, elapsed: 0, cue: rotationSeen(state) ? 'restart' : '' };
  }
  if (event.type === 'motion') {
    const on = !!event.on;
    if (on === state.motion) return next;
    if (!on) return { ...next, motion: false, elapsed: 0, cue: 'finish' };
    return { ...next, motion: true, auto: true, elapsed: 0, cue: rotationSeen(state) ? 'restart' : '' };
  }
  return next;
}

// How long a switch takes (landing.css: the view coming in waits 140 ms, then
// fades in and its content settles over 760 ms); then the view going out hides.
const SETTLE = 920;

/**
 * Wires the figure (`[data-hero-views]`). `scene(name)` gives a driven
 * scene's controls (setupScenes); `motionOn` says whether motion is welcome
 * now and `motionHooks` hears when that changes. Returns { state, choose, toggle }.
 */
export function setupHeroViews(figure, { scene = () => null, motionOn = false, motionHooks = [] } = {}) {
  if (!figure) return null;
  const views = HERO_VIEWS.filter(view => figure.querySelector(`[data-hero-view="${view.id}"]`));
  if (views.length < 2) return null;
  const panes = new Map(views.map(view => [view.id, figure.querySelector(`[data-hero-view="${view.id}"]`)]));
  const scenes = new Map(views.map(view => [view.id, scene(view.scene)]));
  const choices = [...figure.querySelectorAll('[data-hero-choice]')];
  const group = choices[0]?.closest('[role="radiogroup"]') || null;
  const pause = figure.querySelector('[data-hero-pause]');
  const pauseLabel = figure.querySelector('[data-hero-pause-label]');
  const fill = figure.querySelector('[data-hero-fill]');
  const stage = figure.querySelector('.hero-stage') || figure;
  const watch = 'IntersectionObserver' in window;

  let state = rotationStart({ motion: motionOn, holds: [watch ? 'offscreen' : '', document.hidden ? 'hidden' : ''] }, views);
  let since = 0;
  let timer = 0;
  let settleTimer = 0;
  let line = null;

  // Shows a view: the one coming in fades in over the one going out, which
  // then hides and goes back to its first frame, ready for its next turn.
  function show(id, animate) {
    window.clearTimeout(settleTimer);
    figure.dataset.view = id;
    choices.forEach(input => { input.checked = input.value === id; });
    panes.forEach((pane, key) => {
      const was = pane.classList.contains('is-shown') || pane.classList.contains('is-entering');
      pane.classList.remove('is-entering', 'is-leaving');
      pane.classList.toggle('is-shown', key === id);
      if (animate && key === id && !was) pane.classList.add('is-entering');
      if (animate && key !== id && was) pane.classList.add('is-leaving');
    });
    const settle = () => {
      panes.forEach((pane, key) => {
        pane.classList.remove('is-entering', 'is-leaving');
        if (key !== id && state.motion) scenes.get(key)?.arm();
      });
    };
    if (animate) settleTimer = window.setTimeout(settle, SETTLE);
    else settle();
  }

  function play(id) {
    const current = scenes.get(id);
    if (!current) return;
    if (rotationPlays(state)) current.restart();
    else if (state.motion) current.finish();
  }

  function render(cue, before) {
    if (cue === 'switch') {
      scenes.get(before.view)?.stop();
      show(state.view, state.motion);
      play(state.view);
    } else if (cue === 'restart') scenes.get(state.view)?.restart();
    else if (cue === 'freeze') scenes.get(state.view)?.stop();
    else if (cue === 'finish' && state.motion) scenes.get(state.view)?.finish();
  }

  // The thin line under the current choice: how much of its time has gone.
  function syncLine() {
    if (!fill || typeof fill.animate !== 'function') return;
    const dwell = dwellOf(state.view, views);
    if (!line || line.view !== state.view) {
      line?.run.cancel();
      line = { view: state.view, run: fill.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: dwell, easing: 'linear', fill: 'both' }) };
    }
    line.run.currentTime = Math.min(state.elapsed, dwell);
    if (rotationRunning(state)) line.run.play();
    else line.run.pause();
  }

  function sync() {
    figure.classList.toggle('is-moving', state.motion);
    figure.classList.toggle('is-paused', state.motion && !state.auto);
    figure.classList.toggle('is-turning', state.motion && state.auto);
    if (pauseLabel) pauseLabel.textContent = state.auto ? 'Pause the animation' : 'Play the animation';
    syncLine();
  }

  function commit(next) {
    const before = state;
    state = next;
    if (next.cue) render(next.cue, before);
  }

  // Every event first counts the time gone since the clock last started.
  function apply(event) {
    window.clearTimeout(timer);
    timer = 0;
    if (since) {
      const ms = performance.now() - since;
      since = 0;
      commit(rotationStep(state, { type: 'tick', ms }, views));
    }
    if (event) commit(rotationStep(state, event, views));
    if (rotationRunning(state)) {
      since = performance.now();
      timer = window.setTimeout(() => apply(null), rotationLeft(state, views) + 4);
    }
    sync();
  }

  choices.forEach(input => input.addEventListener('change', () => { if (input.checked) apply({ type: 'choose', view: input.value }); }));
  pause?.addEventListener('click', () => apply({ type: 'toggle' }));

  const hover = on => event => { if (event.pointerType !== 'touch') apply({ type: 'hold', reason: 'hover', on }); };
  figure.addEventListener('pointerenter', hover(true));
  figure.addEventListener('pointerleave', hover(false));

  // Keyboard focus on a choice holds the turns; a click (no visible focus) doesn't.
  group?.addEventListener('focusin', event => { if (event.target.matches(':focus-visible')) apply({ type: 'hold', reason: 'focus', on: true }); });
  group?.addEventListener('focusout', event => { if (!group.contains(event.relatedTarget)) apply({ type: 'hold', reason: 'focus', on: false }); });

  document.addEventListener('visibilitychange', () => apply({ type: 'hold', reason: 'hidden', on: document.hidden }));
  if (watch) {
    new IntersectionObserver(([entry]) => apply({ type: 'hold', reason: 'offscreen', on: !entry.isIntersecting }), { threshold: 0.3 }).observe(stage);
  }
  motionHooks.push(on => apply({ type: 'motion', on }));

  figure.classList.add('is-live');
  show(state.view, false);
  apply(null);

  return {
    state: () => ({ ...state }),
    choose: view => apply({ type: 'choose', view }),
    toggle: () => apply({ type: 'toggle' })
  };
}
