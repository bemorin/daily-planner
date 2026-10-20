import { qs, qsa } from '../lib/dom.js';
import { esc } from '../lib/text.js';
import { prefersReducedMotion } from '../ui/motion.js';
import { buildTourSteps, carryStep, placeCard, readTourFlags, scrollDelta, shouldOfferTour, spotlightHoles, stepEyebrow, TOUR_FLAG_KEY, tourEnvironment, unionRect, visibleArea } from './tour-model.js';

/**
 * The planner tour: a spotlight on each part of the real interface, with a
 * short card beside it (src/features/tour-model.js decides what each screen
 * gets). It starts by itself once, right after first-run setup — after the
 * Install dialog when that was chosen — and is offered once, in a small card,
 * to people who set the planner up before it existed. How it works and the
 * More menu (`[data-tour-open]`) start it again at any time.
 *
 * While it runs the rest of the page is inert and the card is a modal dialog:
 * → / Enter move on, ← goes back, Escape leaves, Tab stays in the card. It
 * never opens a dialog; on phones it switches the Plan / Schedule pane and
 * opens the More menu where a step needs them, and puts them back after.
 * Pinch-zoom and panning stay free, and the card follows the part of the page
 * on screen, so a zoomed-in phone always has Next and Skip in reach.
 */

const NS = 'http://www.w3.org/2000/svg';
const SIGNPOST = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18M9 21h6"/><path d="M12 5.5h6.2l2.3 2.5-2.3 2.5H12M12 12.5H5.8L3.5 15l2.3 2.5H12"/></svg>';

const isVisible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
const rectOf = el => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };

function scrollParent(el) {
  for (let node = el?.parentElement; node && node !== document.body; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 1) return node;
  }
  return null;
}

export function createTour({ getActiveModal = () => null, closeModal = () => {}, closePopovers = () => {}, setPane = () => {}, range = () => 'day', setRange = () => {}, isReady = () => true, storage = globalThis.localStorage } = {}) {
  let root = null;
  let card = null;
  let offer = null;
  let offerBefore = null;
  let steps = [];
  let index = 0;
  let active = false;
  let env = null;
  let saved = null;
  let inerted = [];
  let menuOpened = false;
  let frame = 0;
  let followUntil = 0;
  let idleTimer = 0;
  let hideTimer = 0;

  const workspace = () => qs('[data-workspace]');
  const currentPane = () => workspace()?.dataset.mobileActive || 'plan';
  const matches = query => !!globalThis.matchMedia?.(query)?.matches;
  const environment = () => tourEnvironment(matches);
  // A dialog, or a popover (the date picker, a menu: they leave the page when they close).
  const busy = () => !!getActiveModal() || qsa('.modal').some(modal => !modal.hidden) || !!qs('.app-popover');

  function readFlags() {
    try { return readTourFlags(storage?.getItem(TOUR_FLAG_KEY)); } catch (_) { return readTourFlags(null); }
  }

  function writeFlags(patch) {
    try { storage?.setItem(TOUR_FLAG_KEY, JSON.stringify({ ...readFlags(), ...patch })); } catch (_) {}
  }

  /** Visible now — or, on a phone, once the pane the step shows is the one on screen. */
  function visible(selector, pane = '') {
    const space = workspace();
    const swap = pane && space && space.dataset.mobileActive !== pane;
    const before = swap ? space.dataset.mobileActive : '';
    if (swap) space.dataset.mobileActive = pane;
    const found = qsa(selector).some(isVisible);
    if (swap) space.dataset.mobileActive = before;
    return found;
  }

  function build() {
    env = environment();
    return buildTourSteps({ ...env, visible });
  }

  function targets(step) {
    return step.spot.flatMap(entry => {
      const css = typeof entry === 'string' ? entry : entry.css;
      const found = qsa(css).filter(isVisible);
      if (typeof entry === 'string' || entry.pick !== 'first-in-view') return found.slice(0, 1);
      const inView = found.find(el => {
        const box = rectOf(el);
        const port = scrollParent(el);
        const area = port ? rectOf(port) : { top: 0, bottom: innerHeight };
        return box.top >= area.top && box.bottom <= area.bottom;
      });
      return inView ? [inView] : [];
    });
  }

  // ---------------------------------------------------------------------------
  // Markup
  // ---------------------------------------------------------------------------

  function ensureDom() {
    if (root) return;
    root = document.createElement('div');
    root.className = 'tour';
    root.hidden = true;
    root.dataset.tour = '';
    root.innerHTML = `
      <svg class="tour__scrim" aria-hidden="true" focusable="false">
        <defs>
          <mask id="tour-holes" maskUnits="userSpaceOnUse" x="0" y="0" width="100%" height="100%"><rect x="0" y="0" width="100%" height="100%" fill="#fff"/><g data-tour-mask></g></mask>
          <filter id="tour-outline" filterUnits="userSpaceOnUse" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
            <feMorphology in="SourceAlpha" operator="dilate" radius="1.5" result="grown"/>
            <feComposite in="grown" in2="SourceAlpha" operator="out" result="edge"/>
            <feMorphology in="SourceAlpha" operator="dilate" radius="4" result="wide"/>
            <feGaussianBlur in="wide" stdDeviation="6" result="blur"/>
            <feFlood class="tour__glow"/>
            <feComposite in2="blur" operator="in"/>
            <feComposite in2="SourceAlpha" operator="out" result="glow"/>
            <feFlood class="tour__line"/>
            <feComposite in2="edge" operator="in" result="line"/>
            <feMerge><feMergeNode in="glow"/><feMergeNode in="line"/></feMerge>
          </filter>
        </defs>
        <rect class="tour__dim" x="0" y="0" width="100%" height="100%" mask="url(#tour-holes)"/>
        <g class="tour__rings" filter="url(#tour-outline)" data-tour-rings></g>
      </svg>
      <section class="tour-card" role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-describedby="tour-text" tabindex="-1" data-tour-card>
        <div class="tour-card__top"><p class="tour-card__eyebrow" data-tour-eyebrow></p><span class="tour-card__dots" data-tour-dots aria-hidden="true"></span></div>
        <h2 class="tour-card__title" id="tour-title" data-tour-title></h2>
        <p class="tour-card__text" id="tour-text"><span class="sr-only" data-tour-name></span><span data-tour-body></span></p>
        <ul class="tour-card__keys" data-tour-keys aria-label="Keyboard shortcuts"></ul>
        <p class="tour-card__hint" data-tour-hint hidden><kbd>←</kbd><kbd>→</kbd> move through the tour · <kbd>Esc</kbd> leaves it</p>
        <div class="tour-card__actions">
          <button class="text-button tour-card__skip" type="button" data-tour-skip>Skip the tour</button>
          <div class="tour-card__nav">
            <button class="text-button" type="button" data-tour-back>Back</button>
            <button class="primary-button" type="button" data-tour-next>Next</button>
          </div>
        </div>
        <p class="sr-only" aria-live="polite" data-tour-live></p>
      </section>`;
    document.body.append(root);
    card = qs('[data-tour-card]', root);
    qs('[data-tour-next]', root).addEventListener('click', () => next());
    qs('[data-tour-back]', root).addEventListener('click', () => go(index - 1));
    qs('[data-tour-skip]', root).addEventListener('click', () => end());
    // Clicks stay with the tour: the planner behind must not react (its menus close on outside clicks).
    root.addEventListener('click', event => event.stopPropagation());
    root.addEventListener('pointerdown', event => { if (!card.contains(event.target)) event.preventDefault(); });
  }

  function syncShapes(group, holes, className, radius) {
    const nodes = [...group.children];
    while (nodes.length > holes.length) nodes.pop().remove();
    holes.forEach((hole, i) => {
      let node = nodes[i];
      if (!node) { node = document.createElementNS(NS, 'rect'); node.setAttribute('class', className); group.append(node); }
      const width = hole.right - hole.left;
      const height = hole.bottom - hole.top;
      const rx = Math.min(radius, width / 2, height / 2);
      const geometry = { x: hole.left, y: hole.top, width, height, rx, ry: rx };
      Object.entries(geometry).forEach(([name, value]) => { node.setAttribute(name, String(value)); node.style[name] = `${value}px`; });
    });
  }

  // ---------------------------------------------------------------------------
  // Layout: spotlight and card, kept in place while things move
  // ---------------------------------------------------------------------------

  /**
   * Spotlight and card in the part of the page on screen: pinch-zoomed, the
   * card stays whole in the visual viewport at its usual size (never taller
   * than it: its text scrolls, its buttons stay), so Next and Skip are always
   * in reach.
   */
  function layout() {
    if (!active || !root) return;
    const step = steps[index];
    const area = visibleArea(globalThis.visualViewport, { width: innerWidth, height: innerHeight });
    const holes = step ? spotlightHoles(targets(step).map(rectOf), area, { pad: env?.layout === 'phone' ? 5 : 6, join: step.join }) : [];
    syncShapes(qs('[data-tour-mask]', root), holes, 'tour__hole', 12);
    syncShapes(qs('[data-tour-rings]', root), holes, 'tour__ring', 12);
    card.style.maxHeight = `${Math.max(160, Math.floor(area.height * area.scale) - 24)}px`;
    const place = placeCard(unionRect(holes), { width: card.offsetWidth, height: card.offsetHeight }, area);
    card.dataset.side = place.side;
    card.style.transform = `translate(${place.left}px, ${place.top}px)${area.scale === 1 ? '' : ` scale(${1 / area.scale})`}`;
  }

  function tick() {
    frame = 0;
    layout();
    if (active && performance.now() < followUntil) frame = requestAnimationFrame(tick);
  }

  /** Keep the spotlight on its target for a moment (smooth scrolls, the phone pane switch). */
  function follow(ms = 650) {
    followUntil = Math.max(followUntil, performance.now() + ms);
    if (!frame) frame = requestAnimationFrame(tick);
  }

  function relayout() {
    if (!active) return;
    follow(0);
  }

  /** Scrolls the step's target into its area at once; the spotlight then glides to it. */
  function bringIntoView(step) {
    const els = targets(step);
    const port = els.map(scrollParent).find(Boolean);
    if (!port) return;
    const inside = els.filter(el => port.contains(el)).map(rectOf);
    const delta = inside.length ? scrollDelta(unionRect(inside), rectOf(port)) : 0;
    if (delta) port.scrollTop += delta;
  }

  /** Window resizes follow at once, without the glide between steps. */
  let stillTimer = 0;
  function holdStill() {
    root?.classList.add('is-still');
    clearTimeout(stillTimer);
    stillTimer = setTimeout(() => root?.classList.remove('is-still'), 220);
  }

  // ---------------------------------------------------------------------------
  // Steps
  // ---------------------------------------------------------------------------

  function openMore(open) {
    const menu = qs('[data-mobile-more-menu]');
    const button = qs('[data-mobile-more]');
    if (!menu) return;
    if (open) { menuOpened = menuOpened || menu.hidden; menu.hidden = false; button?.setAttribute('aria-expanded', 'true'); return; }
    if (!menuOpened) return;
    menuOpened = false;
    menu.hidden = true;
    button?.setAttribute('aria-expanded', 'false');
  }

  function render() {
    const step = steps[index];
    const last = index === steps.length - 1;
    qs('[data-tour-eyebrow]', root).textContent = stepEyebrow(index, steps.length);
    qs('[data-tour-title]', root).textContent = step.title;
    qs('[data-tour-name]', root).textContent = `Highlighted: ${step.name}. `;
    qs('[data-tour-body]', root).textContent = step.body;
    const keys = qs('[data-tour-keys]', root);
    keys.innerHTML = step.keys.map(item => `<li${item.keys.length > 1 || item.label.length > 18 ? ' class="is-wide"' : ''}><span class="tour-card__caps">${item.keys.map(key => `<kbd>${esc(key)}</kbd>`).join('')}</span><span>${esc(item.label)}</span></li>`).join('');
    keys.hidden = !step.keys.length;
    qs('[data-tour-hint]', root).hidden = !(env?.keys && index === 0);
    qs('[data-tour-dots]', root).innerHTML = steps.map((_, i) => `<i class="${i === index ? 'is-active' : i < index ? 'is-done' : ''}"></i>`).join('');
    qs('[data-tour-back]', root).hidden = index === 0;
    qs('[data-tour-skip]', root).hidden = last;
    qs('[data-tour-next]', root).textContent = last ? 'Done' : 'Next';
    card.dataset.step = step.id;
  }

  function show(target, { announce = true } = {}) {
    const step = steps[target];
    if (!step) return;
    index = target;
    if (step.menu !== 'more') openMore(false);
    if (step.pane && currentPane() !== step.pane) setPane(step.pane);
    if (step.menu === 'more') openMore(true);
    render();
    if (announce) qs('[data-tour-live]', root).textContent = `${stepEyebrow(index, steps.length)}. ${step.title}. Highlighted: ${step.name}. ${step.body}`;
    // A button that just disappeared (Back on the first step, Skip on the last) hands focus to Next.
    const focused = document.activeElement;
    if (!card.contains(focused) || focused === card || focused.hidden) qs('[data-tour-next]', root).focus({ preventScroll: true });
    bringIntoView(step);
    layout();
    follow();
  }

  function go(target) {
    if (!active || target < 0 || target >= steps.length || target === index) return;
    show(target);
  }

  function next() {
    if (index >= steps.length - 1) end();
    else go(index + 1);
  }

  function onKey(event) {
    if (!active) return;
    // The planner's own shortcuts wait until the tour is over.
    event.stopPropagation();
    if (event.isComposing) return;
    const onButton = !!event.target?.closest?.('button') && card.contains(event.target);
    if (event.key === 'Escape') { event.preventDefault(); end(); return; }
    if (event.key === 'Tab') { trapTab(event); return; }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'ArrowRight' || (event.key === 'Enter' && !onButton)) { event.preventDefault(); next(); return; }
    if (event.key === 'ArrowLeft') { event.preventDefault(); go(index - 1); return; }
    if (!onButton && event.key === ' ') event.preventDefault();
  }

  function trapTab(event) {
    const items = qsa('button', card).filter(button => !button.hidden && isVisible(button));
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const current = document.activeElement;
    if (!card.contains(current) || current === card) { event.preventDefault(); (event.shiftKey ? last : first).focus(); return; }
    if (event.shiftKey && current === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && current === last) { event.preventDefault(); first.focus(); }
  }

  function onFocusIn(event) {
    if (active && card && !card.contains(event.target)) qs('[data-tour-next]', root)?.focus({ preventScroll: true });
  }

  function onResize() {
    if (!active) return;
    holdStill();
    const before = env;
    const now = environment();
    if (before && (now.layout !== before.layout || now.keys !== before.keys || now.touch !== before.touch)) {
      const rebuilt = build();
      if (!rebuilt.length) { end(); return; }
      const target = carryStep(steps, rebuilt, index);
      steps = rebuilt;
      index = -1;
      show(target, { announce: false });
      return;
    }
    relayout();
  }

  /** Pinch-zoom and panning move the visual viewport: the card and spotlight follow at once. */
  function onViewport() {
    if (!active) return;
    holdStill();
    relayout();
  }

  function listen(on) {
    const method = on ? 'addEventListener' : 'removeEventListener';
    window[method]('keydown', onKey, true);
    window[method]('resize', onResize);
    document[method]('scroll', relayout, true);
    document[method]('focusin', onFocusIn);
    globalThis.visualViewport?.[method]('resize', onViewport);
    globalThis.visualViewport?.[method]('scroll', onViewport);
  }

  function setInert(on) {
    if (on) {
      inerted = [...document.body.children].filter(el => el !== root && !el.inert && el.tagName !== 'SCRIPT');
      inerted.forEach(el => { el.inert = true; });
    } else {
      inerted.forEach(el => { el.inert = false; });
      inerted = [];
    }
  }

  /**
   * Where focus goes when the tour or the offer leaves: back where it was,
   * else to what opened it, else to the heading of the pane on screen — never
   * into a text field on a phone (that would open the keyboard).
   */
  function returnFocus(candidates) {
    const phone = environment().layout === 'phone';
    const usable = el => !!el && el !== document.body && el.isConnected && !root?.contains(el) && !el.closest?.('.tour-offer') && isVisible(el)
      && !(phone && el.matches?.('input, textarea, [contenteditable="true"]'));
    let target = candidates.find(usable);
    if (!target) {
      target = qsa('[data-workspace] h2').find(isVisible);
      if (target && !target.hasAttribute('tabindex')) { target.tabIndex = -1; target.dataset.tourReturn = ''; }
    }
    if (target) target.focus?.({ preventScroll: true });
    else if (root?.contains(document.activeElement)) document.activeElement.blur();
  }

  /** Starts the tour now. Returns false when there is nothing to show (or it is already running). `opener` gets focus back if nothing better is left. */
  function start({ opener = null } = {}) {
    if (active) return false;
    clearTimeout(idleTimer);
    hideOffer();
    closePopovers();
    const startRange = range();
    // The tour walks through the Day view; Week comes back afterwards.
    if (startRange === 'week') setRange('day');
    const built = build();
    if (!built.length) { if (startRange === 'week') setRange('week'); return false; }
    ensureDom();
    clearTimeout(hideTimer);
    steps = built;
    index = -1;
    saved = { focus: document.activeElement, opener, pane: currentPane(), range: startRange };
    active = true;
    writeFlags({ seen: new Date().toISOString() });
    root.hidden = false;
    setInert(true);
    listen(true);
    show(0, { announce: false });
    requestAnimationFrame(() => root?.classList.add('is-open'));
    return true;
  }

  function end() {
    if (!active) return;
    active = false;
    cancelAnimationFrame(frame);
    frame = 0;
    listen(false);
    openMore(false);
    setInert(false);
    // Not open any more: clicks go through at once (tour.css), while it fades out.
    root.classList.remove('is-open');
    hideTimer = setTimeout(() => { if (!active) root.hidden = true; }, prefersReducedMotion() ? 0 : 200);
    // The pane it started on, even if the window crossed the phone breakpoint since.
    if (saved.pane && currentPane() !== saved.pane) setPane(saved.pane);
    if (saved.range === 'week' && range() !== 'week') setRange('week');
    const { focus, opener } = saved;
    saved = null;
    returnFocus([focus, opener]);
  }

  /**
   * After first-run setup: starts once the planner is free — no dialog open
   * (the Install dialog, when it was chosen, closes first).
   */
  function startWhenIdle({ delay = 650 } = {}) {
    clearTimeout(idleTimer);
    let waited = false;
    const attempt = () => {
      if (active) return;
      if (busy()) { waited = true; idleTimer = setTimeout(attempt, 300); return; }
      if (waited) { waited = false; idleTimer = setTimeout(attempt, 380); return; }
      start();
    };
    idleTimer = setTimeout(attempt, delay);
  }

  // ---------------------------------------------------------------------------
  // The one-time offer for people who set the planner up before the tour
  // ---------------------------------------------------------------------------

  function hideOffer() {
    if (!offer) return;
    const node = offer;
    offer = null;
    node.classList.remove('is-open');
    setTimeout(() => node.remove(), prefersReducedMotion() ? 0 : 180);
  }

  /** Not now or Escape: focus, if it was in the offer, goes back to where it came from. */
  function dismissOffer() {
    const inside = !!offer?.contains(document.activeElement);
    const before = offerBefore;
    hideOffer();
    if (inside) returnFocus([before]);
  }

  function showOffer() {
    const { keys, layout: screen } = environment();
    const later = screen === 'phone' ? 'More' : 'How it works';
    offer = document.createElement('aside');
    offer.className = 'tour-offer';
    offer.setAttribute('aria-labelledby', 'tour-offer-title');
    offer.setAttribute('aria-live', 'polite');
    offerBefore = null;
    offer.addEventListener('focusin', event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) offerBefore = event.relatedTarget; });
    document.body.append(offer);
    // Filled a moment after it exists, so screen readers announce it once.
    requestAnimationFrame(() => {
      if (!offer) return;
      offer.innerHTML = `<span class="tour-offer__icon">${SIGNPOST}</span>
        <div class="tour-offer__copy"><p class="tour-offer__eyebrow">New</p><h2 id="tour-offer-title">A quick tour of the planner</h2><p>Each part${keys ? ' and its shortcuts' : ''}, in a minute or two. You can also take it later from ${later}.</p></div>
        <div class="tour-offer__actions"><button class="text-button" type="button" data-tour-offer-later>Not now</button><button class="primary-button" type="button" data-tour-offer-start>Take the tour</button></div>`;
      qs('[data-tour-offer-later]', offer).addEventListener('click', dismissOffer);
      qs('[data-tour-offer-start]', offer).addEventListener('click', () => { const before = offerBefore; if (!start({ opener: before })) returnFocus([before]); });
      offer.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); dismissOffer(); } });
      requestAnimationFrame(() => offer?.classList.add('is-open'));
    });
  }

  /** Once, for someone who finished setup before the tour existed; never over a dialog. */
  function maybeOffer() {
    const flags = readFlags();
    if (!shouldOfferTour(flags, { onboardingComplete: isReady(), busy: active || busy() })) return false;
    writeFlags({ offered: new Date().toISOString() });
    showOffer();
    return true;
  }

  // How it works and More → Take the tour. Focus comes back to the button that led there (How it works, or More).
  qsa('[data-tour-open]').forEach(button => button.addEventListener('click', () => {
    const menu = button.closest('[data-mobile-more-menu]');
    if (menu) { menu.hidden = true; qs('[data-mobile-more]')?.setAttribute('aria-expanded', 'false'); }
    const opener = menu ? qs('[data-mobile-more]') : ['[data-help-open]', '[data-mobile-more]'].map(css => qs(css)).find(isVisible) || null;
    const modal = getActiveModal();
    if (modal) { closeModal(modal); setTimeout(() => start({ opener }), 220); } else start({ opener });
  }));

  return { start, end, startWhenIdle, maybeOffer, isActive: () => active, offerVisible: () => !!offer };
}
