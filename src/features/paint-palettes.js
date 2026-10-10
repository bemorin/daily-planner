import { esc, escAttr } from '../lib/text.js';

/**
 * Colours for the painted year (Daily Planner Plus).
 *
 * The choice belongs to the device, like the appearance: it is stored outside
 * the `daily-planner:` namespace, so backups, resets and sync never carry it.
 * The colours themselves live in styles/year.css (light and dark), keyed by
 * `html[data-paint="…"]` and by `.hz-palette--…` for the swatches. Terracotta
 * is the free default; any other palette needs Plus, and a stored palette is
 * ignored (the default shows) while Plus is not active.
 */

export const PAINT_STORAGE_KEY = 'daily-planner-ui:paint';
export const DEFAULT_PAINT = 'terracotta';
export const PAINT_FEATURE = 'paint-palettes';

export const PAINT_PALETTES = [
  { id: 'terracotta', name: 'Terracotta', note: 'The original' },
  { id: 'ocean', name: 'Ocean', note: 'Deep sea blues' },
  { id: 'forest', name: 'Forest', note: 'Pine and moss' },
  { id: 'plum', name: 'Plum', note: 'Dusk violet' },
  { id: 'graphite', name: 'Graphite', note: 'Pencil on paper' },
  { id: 'sunset', name: 'Sunset', note: 'Amber to rose' }
];

const IDS = new Set(PAINT_PALETTES.map(palette => palette.id));
const MARKS = {
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  check: '<path d="m6.5 12.5 3.3 3.3 7.7-8"/>'
};
const mark = name => `<span class="hz-swatch__mark" aria-hidden="true"><svg viewBox="0 0 24 24">${MARKS[name]}</svg></span>`;

export function normalizePaint(value) {
  return IDS.has(value) ? value : DEFAULT_PAINT;
}

export const isPremiumPaint = id => normalizePaint(id) !== DEFAULT_PAINT;

/** The palette actually painted: a stored choice only counts with Plus. */
export function resolvePaint(stored, plusActive = false) {
  const id = normalizePaint(stored);
  return plusActive ? id : DEFAULT_PAINT;
}

export function readPaint(storage = globalThis.localStorage) {
  try { return normalizePaint(storage?.getItem(PAINT_STORAGE_KEY)); } catch (_) { return DEFAULT_PAINT; }
}

export function writePaint(value, storage = globalThis.localStorage) {
  const id = normalizePaint(value);
  try {
    if (id === DEFAULT_PAINT) storage?.removeItem(PAINT_STORAGE_KEY);
    else storage?.setItem(PAINT_STORAGE_KEY, id);
  } catch (_) {}
  return id;
}

export function applyPaint(value, doc = globalThis.document) {
  const root = doc?.documentElement;
  if (!root) return DEFAULT_PAINT;
  const id = normalizePaint(value);
  if (id === DEFAULT_PAINT) delete root.dataset.paint;
  else root.dataset.paint = id;
  return id;
}

/** Re-apply the stored palette for the current Plus state (call when Plus changes). */
export function syncPaint(plusActive, { storage = globalThis.localStorage, doc = globalThis.document } = {}) {
  return applyPaint(resolvePaint(readPaint(storage), plusActive), doc);
}

/**
 * Choose a palette. Without Plus only the default can be chosen; the caller
 * then offers the unlock instead. Returns the palette now painted, or null
 * when the choice needs Plus.
 */
export function choosePaint(value, plusActive, { storage = globalThis.localStorage, doc = globalThis.document } = {}) {
  const id = normalizePaint(value);
  if (id !== DEFAULT_PAINT && !plusActive) return null;
  writePaint(id, storage);
  return applyPaint(id, doc);
}

/** Swatch chooser for the Progress section (bound by horizon-view.js). */
export function renderPaintChooser({ current = DEFAULT_PAINT, plusActive = false } = {}) {
  const selected = resolvePaint(current, plusActive);
  const swatches = PAINT_PALETTES.map(palette => {
    const locked = palette.id !== DEFAULT_PAINT && !plusActive;
    const active = palette.id === selected;
    const label = `${palette.name}${active ? ', current colours' : ''}${locked ? ', needs Daily Planner Plus' : ''}`;
    return `<button type="button" class="hz-swatch hz-palette hz-palette--${palette.id}${active ? ' is-active' : ''}${locked ? ' is-locked' : ''}" data-paint-choice="${escAttr(palette.id)}" aria-pressed="${active}" aria-label="${escAttr(label)}">
      <span class="hz-swatch__ramp" aria-hidden="true"><i class="hz-paint__cell is-closed is-level-1"></i><i class="hz-paint__cell is-closed is-level-2"></i><i class="hz-paint__cell is-closed is-level-3"></i></span>
      <span class="hz-swatch__name">${esc(palette.name)}</span>${active ? mark('check') : locked ? mark('lock') : ''}
    </button>`;
  }).join('');
  const lockedNote = plusActive ? '' : '<span class="hz-plus-badge" aria-hidden="true">Plus</span>';
  return `<section class="hz-card hz-paint-palettes" aria-labelledby="hz-paint-palettes-title">
    <header class="hz-paint-palettes__head"><div><span class="hz-eyebrow">Colours</span><h4 id="hz-paint-palettes-title">Paint your year in your colours ${lockedNote}</h4></div><p>${plusActive ? 'On this device only. Every palette works in light and dark.' : 'Terracotta is included. Five more palettes come with Daily Planner Plus.'}</p></header>
    <div class="hz-swatches" role="group" aria-label="Painted year colours">${swatches}</div>
  </section>`;
}

// Apply the stored palette before the first paint of Horizon; horizon-view.js
// re-checks it against Plus as soon as its context exists.
if (typeof document !== 'undefined') {
  try { applyPaint(readPaint()); } catch (_) {}
}
