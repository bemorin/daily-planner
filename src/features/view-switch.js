import { slideIndicator } from '../ui/motion.js';

/**
 * The phone's Plan / Schedule switch: a light two-tab dock whose indicator
 * slides to the active tab (no movement with reduced motion), each tab with a
 * one-line summary of what it holds. Every `[data-view-summary="plan"]` or
 * `[data-view-summary="schedule"]` on the page shows the same words, so the
 * Day view's "Plan" heading stays in step with the dock.
 */
export function createViewSwitch({ qs, qsa, summary }) {
  let timer = 0;

  function place(animate) {
    const indicator = qs('[data-mobile-view-indicator]');
    const active = qs('[data-mobile-view].is-active');
    if (!indicator || !active || !active.offsetWidth) return;
    slideIndicator(indicator, active, { animateMove: animate });
  }

  function setActive(view, { animate = true } = {}) {
    qsa('[data-mobile-view]').forEach(button => {
      const on = button.dataset.mobileView === view;
      button.classList.toggle('is-active', on);
      button.setAttribute('aria-selected', String(on));
    });
    place(animate);
  }

  function write() {
    clearTimeout(timer);
    let text = {};
    try { text = summary() || {}; } catch (_) { text = {}; }
    qsa('[data-view-summary]').forEach(node => {
      const value = text[node.dataset.viewSummary] || '';
      if (node.textContent !== value) node.textContent = value;
    });
    const counts = text.counts;
    qsa('[data-view-progress]').forEach(node => {
      node.hidden = !counts?.total;
      node.style.setProperty('--progress', counts?.total ? (counts.done / counts.total).toFixed(3) : '0');
    });
  }

  /** Coalesces the many small edits of typing into one update. */
  function refresh() {
    clearTimeout(timer);
    timer = setTimeout(write, 90);
  }

  globalThis.addEventListener?.('resize', () => place(false));
  return { setActive, refresh, write, place };
}
