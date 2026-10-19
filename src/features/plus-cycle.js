import { esc, escAttr } from '../lib/text.js';
import { panelEnter, prefersReducedMotion, slideIndicator } from '../ui/motion.js';
import { progressIcon } from './progress-view.js';
import { defaultPlanYear } from './year-plan.js';
import { buildYearPrintModel, renderYearPrint } from './year-print.js';
import { buildYearReview, defaultReviewYear, renderYearReviewPrint } from './year-review.js';
import { hasOwnReview, hasPrintablePlan, samplePrintModel, sampleReview } from './plus-samples.js';
import { PAGE_SIZE, paperScale, planPreview, renderPaper, renderPlanSession } from './plus-previews.js';

/**
 * The yearly ritual Plus gives, in the Daily Planner Plus dialog: Plan it,
 * Print it, Look back — three tabs over one stage. Plan shows the guided
 * session; Print and Look back show the real printed page on a sheet of paper
 * (the person's own when there is enough of it, otherwise a labelled sample),
 * which can be enlarged inside the dialog.
 *
 * The step model and the copy are pure (unit-tested); createPlusCycle() renders
 * and binds the section each time the dialog draws its overview.
 */

export const CYCLE_STEPS = Object.freeze([
  Object.freeze({ id: 'plan', feature: 'year-plan', number: 1, label: 'Plan it', short: 'December', when: 'Each December — or whenever you start' }),
  Object.freeze({ id: 'print', feature: 'year-print', number: 2, label: 'Print it', short: 'All year', when: 'All year, on your desk' }),
  Object.freeze({ id: 'review', feature: 'year-review', number: 3, label: 'Look back', short: 'Year end', when: 'When the year ends' })
]);

/** The step a feature opens on: the review for "Your year in review", otherwise Plan it. */
export function cycleStepFor(feature = '') {
  return feature === 'year-review' ? 'review' : 'plan';
}

/** The step a key moves to from `id` in the tab list (arrows wrap, Home/End), or '' for other keys. */
export function stepForKey(id, key) {
  const index = Math.max(0, CYCLE_STEPS.findIndex(step => step.id === id));
  const last = CYCLE_STEPS.length - 1;
  const next = { ArrowRight: index === last ? 0 : index + 1, ArrowDown: index === last ? 0 : index + 1, ArrowLeft: index === 0 ? last : index - 1, ArrowUp: index === 0 ? last : index - 1, Home: 0, End: last }[key];
  return next === undefined ? '' : CYCLE_STEPS[next].id;
}

/** What each step says, for the year to plan; `active` (Plus) adds its action, otherwise Print notes it's free. */
export function cycleCopy(id, { year, active = false } = {}) {
  const copy = {
    plan: {
      title: `Plan ${year} in a guided half hour.`,
      text: `One question at a time, it sets up ${year} in Horizon: your Misogi and its milestones, six mini-adventures, three commitments, a winning habit for each quarter and your key dates.`,
      action: { id: 'plan', label: `Plan ${year}`, icon: 'sparkle' }
    },
    print: {
      title: `${year} on one page, finished by hand.`,
      text: 'Print it once the plan is set and keep it on your desk. Tick the milestones, circle the dates, write in what you lived: empty parts print as lines and boxes, ready for a pen.',
      note: active ? '' : 'Printing the year is free in Horizon. Plus plans it with you.',
      action: { id: 'print', label: 'Print the year', icon: 'printer' }
    },
    review: {
      title: 'Your year in review, on one page.',
      text: 'Days closed, the painted year, your best streak, trophies, where the time went, how the Misogi, adventures and habits turned out, and a few memories. Print it and keep it with the plan.',
      action: { id: 'review', label: 'Open your review', icon: 'review' }
    }
  }[id];
  const step = CYCLE_STEPS.find(item => item.id === id);
  return { ...copy, when: step.when, action: active ? copy.action : null, note: copy.note || '' };
}

const ICONS = {
  sparkle: '<path d="M12 3.5c.5 3.9 2.6 6 6.5 6.5-3.9.5-6 2.6-6.5 6.5-.5-3.9-2.6-6-6.5-6.5 3.9-.5 6-2.6 6.5-6.5Z"/><path d="M18.5 15.5c.2 1.5 1 2.3 2.5 2.5-1.5.2-2.3 1-2.5 2.5-.2-1.5-1-2.3-2.5-2.5 1.5-.2 2.3-1 2.5-2.5Z"/>',
  printer: '<path d="M7 8V4h10v4M7 17H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2M7 14h10v6H7z"/>',
  review: '<rect x="5" y="3.5" width="14" height="17" rx="2"/><path d="M8.5 8h7M8.5 11.5h7M8.5 15h4"/>',
  enlarge: '<path d="M14.5 4.5h5v5M19.5 4.5l-6 6M9.5 19.5h-5v-5M4.5 19.5l6-6"/>',
  loop: '<path d="M19.5 12a7.5 7.5 0 0 1-13 5.1"/><path d="M4.5 12a7.5 7.5 0 0 1 13-5.1"/><path d="M17.8 3.6v3.6h-3.6M6.2 20.4v-3.6h3.6"/>',
  close: '<path d="m7 7 10 10M17 7 7 17"/>',
  check: '<path d="m6.5 12.5 3.3 3.3 7.7-8"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
// The review's own icons: progress-view's set, plus the tick of its checkboxes.
const reviewIcon = name => (name === 'check' ? `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS.check}</svg>` : progressIcon(name));

// Hand-drawn marks for the printed year, in their own little boxes (see placePen).
const PEN = {
  tick: { box: [20, 20], d: 'M2.6 11.2c1.5 1 2.9 2.6 4.3 4.8C9.5 10.6 12.9 5.6 18.2 1.6' },
  circle: { box: [26, 20], d: 'M15.6 2.4C9.2 1.2 2.6 4.3 2.2 9.8c-.3 4.9 5.5 7.9 11.4 7.3 5.8-.6 10.1-3.7 10-7.8-.2-4.6-6.1-7.4-12.3-6.2' },
  scribble: { box: [100, 14], d: 'M1 10c2.4-.4 3.6-4.6 5.4-7.6.6 2.6-.4 6.4.2 8 1.6-1.4 2.6-3.8 4.4-4.2 1.2 1.2-.8 3.6.6 4.2 1.8-.4 2.6-3.6 4.6-3.8 1.6.4 0 3.4 1.6 3.8 2-.6 2.8-3.4 4.8-3.6.6 1.6-.6 3.6.8 3.8 2.2-.2 3.2-6.6 5.4-8.2.6 2.8-1.4 6.6-.2 8.2 1.8-.6 2.6-3.4 4.6-3.6 1.4.6-.2 3.2 1.2 3.6 1.6-.2 2.2-2.6 3.8-3.2 1.8 0 .8 3 2.4 3.2 3.4-.8 6.2-2.6 9.6-2.8m5.4-.4c2-.2 3-3.4 5-3.6 1.4.8-.2 3.4 1.4 3.8 2-.4 3-3.6 5-3.8 1.4.8 0 3.2 1.4 3.6 2.2-.6 3.4-4.8 5.4-5.4' }
};

/**
 * @param {object} options
 * @param {() => HTMLElement|null} options.modal the Plus dialog (the enlarged page opens inside it)
 * @param {() => object|null} options.data preview(): { plan, print(year), review(year) } from app.js
 * @param {() => string} options.palette the painted-year palette in use
 * @param {(action: string, year: number) => void} options.onAction a step's action (with Plus)
 */
export function createPlusCycle({ modal, data, palette = () => 'terracotta', onAction = () => {} }) {
  let current = 'plan';
  let cache = {};
  let host = null;
  let observer = null;
  let zoom = null;
  let onStep = null;

  const today = () => new Date();
  const planYear = () => defaultPlanYear(today());
  const read = () => { try { return data() || {}; } catch (_) { return {}; } };
  const attempt = fn => { try { return fn(); } catch (_) { return null; } };

  /** The printed year: the person's own once a part of it is planned, the sample year otherwise. */
  function printSource() {
    if (cache.print) return cache.print;
    const year = planYear();
    const source = read();
    const input = attempt(() => source.print?.(year));
    const mine = input && hasPrintablePlan(source.plan) ? attempt(() => buildYearPrintModel(input)) : null;
    const model = mine || samplePrintModel(year, { weekStartsOn: input?.weekStartsOn ?? 1 });
    cache.print = { kind: 'year', own: !!mine, html: renderYearPrint(model), tag: mine ? `Your ${year}` : 'Sample', title: mine ? `Your ${year} on one page` : 'A sample year on one page' };
    return cache.print;
  }

  /** The year in review: the person's own with enough closed days this year, the sample review otherwise. */
  function reviewSource() {
    if (cache.review) return cache.review;
    const now = today();
    const year = defaultReviewYear(now);
    const input = attempt(() => read().review?.(year));
    let html = '';
    if (input && hasOwnReview(input.progress)) {
      html = attempt(() => renderYearReviewPrint(buildYearReview({ year, progress: input.progress, yearData: input.yearData, readDay: input.readDay, categoryFor: input.categoryFor, today: now }), input.progress, { icon: reviewIcon })) || '';
    }
    if (html) cache.review = { kind: 'review', own: true, html, tag: `Your ${year}${year === now.getFullYear() ? ' so far' : ''}`, title: `Your ${year} in review` };
    else {
      const sample = sampleReview(planYear() - 1);
      cache.review = { kind: 'review', own: false, html: renderYearReviewPrint(sample.review, sample.progress, { icon: reviewIcon }), tag: 'Sample', title: 'A sample year in review' };
    }
    return cache.review;
  }

  function stage(id) {
    const year = planYear();
    if (id === 'plan') {
      const plan = planPreview(read().plan || null);
      return `<span class="plus-tag plus-tag--own">Your ${year}${plan.set ? ` · ${plan.set} of ${plan.total} parts set` : ''}</span>${renderPlanSession(plan, { year })}`;
    }
    const source = id === 'print' ? printSource() : reviewSource();
    return `<span class="plus-tag${source.own ? ' plus-tag--own' : ''}">${esc(source.tag)}</span>
      <div class="plus-stage__paper" data-plus-enlarge-area>${renderPaper(source.html, { kind: source.kind, palette: palette() })}</div>
      <button class="plus-stage__enlarge" type="button" data-plus-enlarge aria-label="${escAttr(`Enlarge: ${source.title}`)}">${icon('enlarge')}<span>Enlarge</span></button>`;
  }

  function caption(id, active) {
    const copy = cycleCopy(id, { year: planYear(), active });
    return `<p class="plus-caption__when">${esc(copy.when)}</p>
      <h4 class="plus-caption__title">${esc(copy.title)}</h4>
      <p class="plus-caption__text">${esc(copy.text)}${copy.note ? ` <span class="plus-caption__note">${esc(copy.note)}</span>` : ''}</p>
      ${copy.action ? `<button class="secondary-button plus-caption__action" type="button" data-plus-cycle-action="${copy.action.id}">${icon(copy.action.icon)}<span>${esc(copy.action.label)}</span></button>` : ''}`;
  }

  function panel(id, active) {
    return `<div class="plus-caption plus-caption--${id}">${caption(id, active)}</div>
      <div class="plus-stage plus-stage--${id}" data-plus-stage>${stage(id)}</div>`;
  }

  // A panel with nothing to focus inside (Plan it without Plus) takes focus itself, as tab panels do.
  const panelFocusable = (id, active) => id === 'plan' && !active;

  /** The section, on `step`. Only the shown step's preview is built. */
  function markup({ step = current, active = false } = {}) {
    current = CYCLE_STEPS.some(item => item.id === step) ? step : 'plan';
    const tabs = CYCLE_STEPS.map(item => {
      const on = item.id === current;
      return `<button class="plus-step plus-step--${item.id}${on ? ' is-active' : ''}" type="button" role="tab" id="plus-step-${item.id}" aria-controls="plus-step-panel" aria-selected="${on}" tabindex="${on ? 0 : -1}" data-plus-step="${item.id}"><span class="plus-step__number" aria-hidden="true">${item.number}</span><span class="plus-step__copy"><strong>${esc(item.label)}</strong><small>${esc(item.short)}</small></span></button>`;
    }).join('');
    return `<section class="plus-cycle" aria-labelledby="plus-cycle-title" data-plus-cycle>
        <h3 class="sr-only" id="plus-cycle-title">Every year with Plus</h3>
        <div class="plus-steps" role="tablist" aria-label="Every year with Plus"><span class="plus-steps__indicator" aria-hidden="true" data-plus-step-indicator></span>${tabs}</div>
        <div class="plus-panel" id="plus-step-panel" role="tabpanel" aria-labelledby="plus-step-${current}"${panelFocusable(current, active) ? ' tabindex="0"' : ''} data-plus-step-panel>${panel(current, active)}</div>
        <p class="plus-loop">${icon('loop')}<span>Then plan the next year. Plus is paid once and yours every year.</span></p>
      </section>`;
  }

  // -------------------------------------------------------------------------
  // The stage: paper scaled to fit, pen marks, enlarging
  // -------------------------------------------------------------------------

  function fit(root = host) {
    const stageEl = root?.querySelector('[data-plus-stage]');
    const paper = stageEl?.querySelector('.plus-paper');
    if (!paper) return false;
    const area = paper.parentElement;
    const scale = paperScale(area.clientWidth, area.clientHeight);
    if (!scale) return false;
    paper.style.setProperty('--plus-paper-scale', String(scale));
    return true;
  }

  /** A tick on a milestone, a circled date and a line written by hand, over the printed year (decorative). */
  function placePen(paper) {
    const page = paper?.querySelector('.plus-paper__page');
    if (!page || paper.dataset.plusPaper !== 'year' || page.querySelector('.plus-pen')) return;
    // Layout offsets, not client rects: they don't depend on the page's scale, or on when it was applied.
    const box = el => {
      let x = 0;
      let y = 0;
      for (let node = el; node && node !== page; node = node.offsetParent) { x += node.offsetLeft; y += node.offsetTop; }
      return { x, y, w: el.offsetWidth, h: el.offsetHeight };
    };
    const milestones = [...page.querySelectorAll('.pyr-card--misogi .pyr-list .pyr-row')];
    const tickRow = milestones.find(row => row.querySelector('.pyr-row__text') && !row.classList.contains('is-done'));
    const tickBox = (tickRow || page.querySelector('.pyr-misogi:not(.is-done)'))?.querySelector('.pyr-box');
    const months = [...page.querySelectorAll('.pyr-month')];
    const single = months.map(month => [...month.querySelectorAll('.pyr-day.is-keydate')]).find(days => days.length === 1)?.[0];
    const day = single || page.querySelector('.pyr-day.is-keydate, .pyr-day.is-milestone') || page.querySelector('.pyr-day:not(.is-outside)');
    const blankRow = [...page.querySelectorAll('.pyr-card--misogi .pyr-row, .pyr-card--adventures .pyr-row')].find(row => row.querySelector('.pyr-blank:not(.pyr-blank--date)'));
    const line = blankRow?.querySelector('.pyr-blank:not(.pyr-blank--date)');
    // Each mark is scaled evenly from its box to `width` page pixels; the ink stays 1.6 px wide.
    const mark = (name, x, y, width, delay) => {
      const k = width / PEN[name].box[0];
      return `<path class="plus-pen__line" pathLength="1" style="--pen-delay:${delay}ms" stroke-width="${(1.6 / k).toFixed(3)}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${k.toFixed(4)})" d="${PEN[name].d}"/>`;
    };
    const marks = [];
    if (tickBox) { const b = box(tickBox); const width = b.w * 2.1; marks.push(mark('tick', b.x - b.w * 0.2, b.y + b.h * 0.6 - width * 0.8, width, 250)); }
    if (day) { const b = box(day); const width = Math.max(b.w, b.h * 1.3) * 1.75; marks.push(mark('circle', b.x + b.w / 2 - width / 2, b.y + b.h / 2 - width * 0.38, width, 650)); }
    if (line) { const b = box(line); const width = Math.min(b.w * 0.6, 150); marks.push(mark('scribble', b.x + 1, b.y + b.h - width * 0.12, width, 1000)); }
    if (!marks.length) return;
    page.insertAdjacentHTML('beforeend', `<svg class="plus-pen${prefersReducedMotion() ? ' is-still' : ''}" viewBox="0 0 ${PAGE_SIZE.width.toFixed(1)} ${PAGE_SIZE.height.toFixed(1)}" aria-hidden="true">${marks.join('')}</svg>`);
  }

  function settle(root = host) {
    if (fit(root)) placePen(root?.querySelector('[data-plus-stage] .plus-paper'));
  }

  function openZoom(trigger) {
    if (zoom || current === 'plan') return;
    const dialog = modal();
    if (!dialog) return;
    const source = current === 'print' ? printSource() : reviewSource();
    const layer = document.createElement('div');
    layer.className = 'plus-zoom';
    layer.setAttribute('role', 'dialog');
    layer.setAttribute('aria-modal', 'true');
    layer.setAttribute('aria-labelledby', 'plus-zoom-title');
    layer.innerHTML = `<header class="plus-zoom__head">
        <div class="plus-zoom__title"><span class="plus-tag${source.own ? ' plus-tag--own' : ''}">${esc(source.tag)}</span><h2 id="plus-zoom-title">${esc(source.title)}</h2></div>
        <button class="icon-button plus-zoom__close" type="button" data-plus-zoom-close aria-label="Close the enlarged page">${icon('close')}</button>
      </header>
      <div class="plus-zoom__scroll" tabindex="0" aria-label="${escAttr(`${source.title}, enlarged`)}" data-plus-zoom-scroll>${renderPaper(source.html, { kind: source.kind, palette: palette(), zoom: true })}</div>`;
    // Everything else in the dialog waits behind the page until it is put back.
    const behind = [...dialog.children];
    dialog.append(layer);
    behind.forEach(node => { node.inert = true; });
    zoom = { layer, behind, trigger };
    const paper = layer.querySelector('.plus-paper');
    const scroller = layer.querySelector('[data-plus-zoom-scroll]');
    const size = () => paper.style.setProperty('--plus-paper-scale', String(Math.max(1, paperScale(scroller.clientWidth - 32, Infinity, { max: 1.35 }))));
    size();
    zoom.resize = size;
    globalThis.addEventListener?.('resize', size);
    placePen(paper);
    layer.tabIndex = -1;
    const close = layer.querySelector('[data-plus-zoom-close]');
    // Caught for the whole page while the page is enlarged, wherever focus is: Escape only puts the
    // page back (the dialog stays open), and Tab stays between the close button and the page.
    zoom.keys = event => {
      if (!zoom || zoom.layer !== layer) return;
      if (!layer.isConnected || dialog.hidden) { closeZoom({ restore: false }); return; }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeZoom();
      } else if (event.key === 'Tab') {
        const stops = [close, scroller];
        const index = stops.indexOf(document.activeElement);
        const next = event.shiftKey ? (index <= 0 ? stops.length - 1 : index - 1) : (index === -1 || index === stops.length - 1 ? 0 : index + 1);
        event.preventDefault();
        stops[next].focus({ preventScroll: true });
      }
    };
    document.addEventListener('keydown', zoom.keys, true);
    close.addEventListener('click', () => closeZoom());
    panelEnter(layer, { distance: 10 });
    close.focus({ preventScroll: true });
  }

  function closeZoom({ restore = true } = {}) {
    if (!zoom) return;
    const { layer, behind, trigger, resize, keys } = zoom;
    zoom = null;
    globalThis.removeEventListener?.('resize', resize);
    if (keys) document.removeEventListener('keydown', keys, true);
    behind.forEach(node => { node.inert = false; });
    layer.remove();
    if (restore) (trigger?.isConnected ? trigger : host?.querySelector('[data-plus-enlarge]') || host?.querySelector('.plus-step.is-active'))?.focus({ preventScroll: true });
  }

  function select(id, { focus = false, direction = 0 } = {}) {
    if (!host || !CYCLE_STEPS.some(item => item.id === id)) return;
    const changed = id !== current;
    current = id;
    host.querySelectorAll('[data-plus-step]').forEach(tab => {
      const on = tab.dataset.plusStep === id;
      tab.classList.toggle('is-active', on);
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      if (on && focus) tab.focus({ preventScroll: true });
    });
    moveIndicator(true);
    if (!changed) return;
    const active = host.dataset.plusActive === 'true';
    const panelEl = host.querySelector('[data-plus-step-panel]');
    panelEl.setAttribute('aria-labelledby', `plus-step-${id}`);
    if (panelFocusable(id, active)) panelEl.tabIndex = 0; else panelEl.removeAttribute('tabindex');
    panelEl.innerHTML = panel(id, active);
    settle(host);
    panelEnter(panelEl, { direction, distance: 12 });
    onStep?.(id);
  }

  function moveIndicator(animate) {
    const tab = host?.querySelector('.plus-step.is-active');
    slideIndicator(host?.querySelector('[data-plus-step-indicator]'), tab, { animateMove: animate });
  }

  /** Binds the section drawn by markup() inside `root`; `onStep` hears the step change. */
  function mount(root, { active = false, onStep: listener = null } = {}) {
    destroy();
    host = root?.querySelector('[data-plus-cycle]') || null;
    if (!host) return;
    host.dataset.plusActive = String(!!active);
    onStep = listener;
    host.addEventListener('click', event => {
      const tab = event.target.closest('[data-plus-step]');
      if (tab) { const from = CYCLE_STEPS.findIndex(item => item.id === current); select(tab.dataset.plusStep, { direction: Math.sign(CYCLE_STEPS.findIndex(item => item.id === tab.dataset.plusStep) - from) }); return; }
      const action = event.target.closest('[data-plus-cycle-action]');
      if (action) { onAction(action.dataset.plusCycleAction, planYear()); return; }
      const enlarge = event.target.closest('[data-plus-enlarge]');
      if (enlarge) { openZoom(enlarge); return; }
      if (event.target.closest('[data-plus-enlarge-area]')) openZoom(host.querySelector('[data-plus-enlarge]'));
    });
    host.querySelector('[role="tablist"]')?.addEventListener('keydown', event => {
      const next = stepForKey(current, event.key);
      if (!next) return;
      event.preventDefault();
      const from = CYCLE_STEPS.findIndex(item => item.id === current);
      select(next, { focus: true, direction: Math.sign(CYCLE_STEPS.findIndex(item => item.id === next) - from) });
    });
    if (globalThis.ResizeObserver) {
      observer = new ResizeObserver(() => { moveIndicator(false); settle(host); });
      observer.observe(host);
    }
    requestAnimationFrame(() => { moveIndicator(false); settle(host); });
  }

  function destroy() {
    observer?.disconnect();
    observer = null;
    host = null;
  }

  /** A new opening reads the planner again. */
  function reset() { cache = {}; closeZoom({ restore: false }); }

  return { markup, mount, reset, closeZoom, step: () => current };
}
