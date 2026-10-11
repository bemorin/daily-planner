import { esc, escAttr } from '../lib/text.js';
import { PAINT_PALETTES } from './paint-palettes.js';
import { PLAN_STEPS } from './year-plan.js';

/**
 * Small live previews for the Daily Planner Plus dialog, built from the
 * person's own planner where there is something to show: which parts of
 * Horizon "Plan your year" fills, their painted year so far, and that same
 * year in each palette. Pure string rendering (the dialog binds the palette
 * swatches); the data helpers are unit-tested.
 */

/** The parts of a year the guided session sets up, in its order (its last step is the summary). */
export const PLAN_PARTS = Object.freeze(PLAN_STEPS.filter(step => step.id !== 'done').map(step => Object.freeze({ id: step.id, label: step.label })));

/** Below this many closed days the review preview shows a sample year instead. */
export const SAMPLE_BELOW = 3;

/** { year, set, total, next, parts: [{ id, label, set }] } from planSummary()'s `steps`. */
export function planPreview(summary = null) {
  const steps = summary?.steps || {};
  const parts = PLAN_PARTS.map(part => ({ ...part, set: !!steps[part.id] }));
  const set = parts.filter(part => part.set).length;
  return { year: summary?.year || null, set, total: parts.length, next: parts.find(part => !part.set)?.label || '', misogi: String(summary?.misogi?.text || '').trim(), parts };
}

/** One line for the plan preview: what is already there, in plain words. */
export function planCaption(preview) {
  if (!preview.set) return 'Starts from a blank year — about 30 minutes, one part at a time.';
  if (preview.set === preview.total) return `Every part of ${preview.year || 'your year'} is set — revisit it any time.`;
  return `${preview.set} of ${preview.total} parts of ${preview.year || 'your year'} already set. Next: ${preview.next.toLowerCase()}.`;
}

/**
 * Twelve rows (months) of day codes for the mini painted year: 1–3 closed
 * (level), 'x' a planning day not closed, '' anything else (future, rest,
 * before the first closed day). `sample` is true when there is too little to
 * show and an invented year stands in.
 */
export function paintRows(model, { sampleBelow = SAMPLE_BELOW } = {}) {
  if (!model?.months?.length || (Number(model.closed) || 0) < sampleBelow) return { sample: true, closed: 0, rows: sampleRows(model?.year || new Date().getFullYear()) };
  const rows = model.months.map(month => month.days.map(cell => {
    if (cell.closed) return Math.min(3, Math.max(1, Number(cell.level) || 1));
    if (!cell.future && !cell.before && !cell.today && cell.planning && !cell.joker) return 'x';
    return '';
  }));
  return { sample: false, closed: Number(model.closed) || 0, rows };
}

/** A believable year, the same on every render: weekdays mostly closed until early autumn. */
export function sampleRows(year) {
  let seed = 7;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  return Array.from({ length: 12 }, (_, month) => {
    const days = new Date(year, month + 1, 0).getDate();
    return Array.from({ length: days }, (__, index) => {
      const weekday = new Date(year, month, index + 1).getDay();
      if (month > 8 || weekday === 0 || weekday === 6) return '';
      const roll = random();
      if (roll < 0.12) return 'x';
      return roll < 0.5 ? 1 : roll < 0.84 ? 2 : 3;
    });
  });
}

/** The last `weeks` weeks of the painted rows as a week grid (columns = weeks), for the palette preview. */
export function recentWeeks(rows, { weeks = 12, year = new Date().getFullYear(), today = new Date() } = {}) {
  const flat = [];
  rows.forEach((days, month) => days.forEach((code, index) => flat.push({ code, date: new Date(year, month, index + 1) })));
  const sample = !flat.some(cell => cell.code !== '' && cell.date <= today);
  // Sample years end in September; real years end today.
  const end = sample ? flat.findLastIndex(cell => cell.code !== '') : flat.findLastIndex(cell => cell.date <= today);
  const last = Math.max(0, end);
  const lastWeekday = (flat[last]?.date.getDay() + 6) % 7;
  const start = Math.max(0, last - lastWeekday - (weeks - 1) * 7);
  const slice = flat.slice(start, last + 1).map(cell => cell.code);
  return Array.from({ length: weeks }, (_, week) => slice.slice(week * 7, week * 7 + 7));
}

const cellClass = code => (code === 'x' ? 'is-missed' : code ? `is-l${code}` : '');

export function renderPlanRail(preview) {
  const nodes = preview.parts.map(part => `<li class="plus-rail__step plus-rail__step--${part.id}${part.set ? ' is-set' : ''}${!part.set && part.label === preview.next ? ' is-next' : ''}"><span class="plus-rail__dot"></span></li>`).join('');
  return `<div class="plus-preview plus-preview--plan" aria-hidden="true">
      <div class="plus-preview__head"><span>${esc(preview.year ? `Your ${preview.year}` : 'Your year')}</span><b>${preview.set}/${preview.total} set</b></div>
      <ol class="plus-rail">${nodes}<li class="plus-rail__step plus-rail__step--print"><span class="plus-rail__dot"><svg viewBox="0 0 24 24"><path d="M7 3.5h7l4 4V20.5H7Z"/><path d="M14 3.5v4h4"/></svg></span></li></ol>
      <span class="plus-rail__ends"><span>${esc(PLAN_PARTS[0].label)}</span><span>Your year on one page</span></span>
      ${preview.misogi ? `<span class="plus-rail__note"><i></i><span>${esc(preview.misogi)}</span></span>` : ''}
    </div>`;
}

export function renderPaintStrip(paint, { year = new Date().getFullYear() } = {}) {
  const rows = paint.rows.map(days => `<span class="plus-paint__row">${days.map(code => `<i class="${cellClass(code)}"></i>`).join('')}</span>`).join('');
  return `<div class="plus-preview plus-preview--review" aria-hidden="true">
      <div class="plus-preview__head"><span>${esc(paint.sample ? 'A sample year' : `Your ${year}`)}</span><b>${paint.sample ? 'Sample' : `${paint.closed} days`}</b></div>
      <span class="plus-paint">${rows}</span>
    </div>`;
}

/** The palette preview: a few weeks of the painted year and one swatch per palette (buttons, bound by the dialog). */
export function renderPaletteTry(weeks, { current = 'terracotta' } = {}) {
  const grid = weeks.map(days => `<span class="plus-weeks__col">${days.map(code => `<i class="${cellClass(code)}"></i>`).join('')}</span>`).join('');
  const swatches = PAINT_PALETTES.map(palette => `<button type="button" class="plus-swatch hz-palette hz-palette--${palette.id}${palette.id === current ? ' is-active' : ''}" data-plus-palette="${escAttr(palette.id)}" aria-pressed="${palette.id === current}" aria-label="${escAttr(`Preview ${palette.name}`)}" data-tooltip="${escAttr(palette.name)}"><i class="is-l1"></i><i class="is-l2"></i><i class="is-l3"></i></button>`).join('');
  const name = PAINT_PALETTES.find(palette => palette.id === current)?.name || '';
  return `<div class="plus-preview plus-preview--palettes">
      <div class="plus-preview__head" aria-hidden="true"><span>Preview</span><b data-plus-palette-name>${esc(name)}</b></div>
      <span class="plus-weeks hz-palette hz-palette--${escAttr(current)}" data-plus-palette-grid aria-hidden="true">${grid}</span>
      <span class="plus-swatches" role="group" aria-label="Palettes">${swatches}</span>
    </div>`;
}
