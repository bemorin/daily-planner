import { esc, escAttr } from '../lib/text.js';
import { PAINT_PALETTES } from './paint-palettes.js';
import { PLAN_STEPS } from './year-plan.js';

/**
 * Previews for the Daily Planner Plus dialog, built from the person's own
 * planner where there is something to show: the guided "Plan your year"
 * session with the parts already set, a printed page on a sheet of paper (the
 * year map or the year in review, drawn by the real print renderers), and the
 * painted year in each palette. Pure string rendering (the dialog binds the
 * swatches and scales the paper); the data helpers are unit-tested.
 */

/** The parts of a year the guided session sets up, in its order (its last step is the summary). */
export const PLAN_PARTS = Object.freeze(PLAN_STEPS.filter(step => step.id !== 'done').map(step => Object.freeze({ id: step.id, label: step.label, icon: step.icon })));

/** Below this many closed days the palette preview shows a sample year instead. */
export const SAMPLE_BELOW = 3;

/** A printed page: A4 landscape at 96 dpi; the print sheet sits inside the 6 mm page margin (styles/print.css). */
export const PAGE_SIZE = Object.freeze({ width: 297 * 96 / 25.4, height: 210 * 96 / 25.4 });

/** The scale that fits a page inside a `width` × `height` box (never above `max`). */
export function paperScale(width, height = Infinity, { max = 1 } = {}) {
  const value = Math.min(Number(width) / PAGE_SIZE.width, Number(height) / PAGE_SIZE.height, max);
  return Number.isFinite(value) && value > 0 ? Math.round(value * 10000) / 10000 : 0;
}

/** { year, set, total, next, misogi, why, when, parts: [{ id, label, icon, set }] } from planSummary(). */
export function planPreview(summary = null) {
  const steps = summary?.steps || {};
  const parts = PLAN_PARTS.map(part => ({ ...part, set: !!steps[part.id] }));
  const set = parts.filter(part => part.set).length;
  return { year: summary?.year || null, set, total: parts.length, next: parts.find(part => !part.set)?.label || '', misogi: String(summary?.misogi?.text || '').trim(), why: String(summary?.misogi?.why || '').trim(), when: String(summary?.misogi?.when || '').trim(), parts };
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

/** The palette preview: a few weeks of the painted year and one swatch per palette (buttons, bound by the dialog). */
export function renderPaletteTry(weeks, { current = 'terracotta' } = {}) {
  const grid = weeks.map(days => `<span class="plus-weeks__col">${days.map(code => `<i class="${cellClass(code)}"></i>`).join('')}</span>`).join('');
  const swatches = PAINT_PALETTES.map(palette => `<button type="button" class="plus-swatch hz-palette hz-palette--${palette.id}${palette.id === current ? ' is-active' : ''}" data-plus-palette="${escAttr(palette.id)}" aria-pressed="${palette.id === current}" aria-label="${escAttr(`Preview ${palette.name}`)}" data-tooltip="${escAttr(palette.name)}"><i class="is-l1"></i><i class="is-l2"></i><i class="is-l3"></i></button>`).join('');
  const name = PAINT_PALETTES.find(palette => palette.id === current)?.name || '';
  return `<div class="plus-preview plus-preview--palettes">
      <span class="plus-weeks hz-palette hz-palette--${escAttr(current)}" data-plus-palette-grid aria-hidden="true">${grid}</span>
      <span class="plus-palette-pick"><b class="plus-palette-pick__name" data-plus-palette-name aria-hidden="true">${esc(name)}</b><span class="plus-swatches" role="group" aria-label="Palettes">${swatches}</span></span>
    </div>`;
}

const ICONS = {
  history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.5 4.5v4h4"/><path d="M12 7.5V12l3 2"/>',
  mountain: '<path d="M2.5 19.5h19"/><path d="m4.5 19.5 6-10.5 4.2 7.2"/><path d="m12.8 13.2 2.6-4.2 5.1 10.5"/>',
  diamond: '<path d="m12 3.5 8.5 8.5-8.5 8.5L3.5 12Z"/>',
  flag: '<path d="M5.5 21V3.5"/><path d="M5.5 4.5h12l-2.3 4 2.3 4h-12"/>',
  heart: '<path d="M12 20s-7.5-4.4-7.5-10.1A4.4 4.4 0 0 1 12 7.2a4.4 4.4 0 0 1 7.5 2.7C19.5 15.6 12 20 12 20Z"/>',
  repeat: '<path d="M16.5 3 20 6.5 16.5 10"/><path d="M4 11.5V10a3.5 3.5 0 0 1 3.5-3.5H20"/><path d="M7.5 21 4 17.5 7.5 14"/><path d="M20 12.5V14a3.5 3.5 0 0 1-3.5 3.5H4"/>',
  pin: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z"/><circle cx="12" cy="10" r="2.3"/>',
  sparkle: '<path d="M12 3.5c.5 3.9 2.6 6 6.5 6.5-3.9.5-6 2.6-6.5 6.5-.5-3.9-2.6-6-6.5-6.5 3.9-.5 6-2.6 6.5-6.5Z"/><path d="M18.5 15.5c.2 1.5 1 2.3 2.5 2.5-1.5.2-2.3 1-2.5 2.5-.2-1.5-1-2.3-2.5-2.5 1.5-.2 2.3-1 2.5-2.5Z"/>',
  check: '<path d="m6.5 12.5 3.3 3.3 7.7-8"/>',
  calendar: '<path d="M7 3v3M17 3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;

/** The guided session at its Misogi question, with the parts already set ticked on the rail (decorative). */
export function renderPlanSession(preview, { year }) {
  const steps = [...preview.parts, { id: 'done', label: 'Your year', icon: 'sparkle', set: false }];
  const current = 1;
  const rail = steps.map((part, index) => `<li class="plus-session__part plus-session__part--${part.id}${part.set ? ' is-set' : ''}${index === current ? ' is-current' : ''}"><span class="plus-session__icon">${icon(part.set && index !== current ? 'check' : part.icon)}</span><span>${esc(part.label)}</span></li>`).join('');
  const bar = steps.map((_, index) => `<i class="${index < current ? 'is-past' : index === current ? 'is-current' : ''}"></i>`).join('');
  return `<div class="plus-session" aria-hidden="true">
      <div class="plus-session__head">
        <span class="plus-session__title"><span class="plus-session__eyebrow">${icon('sparkle')}Plan your year</span><b>${esc(String(year))}</b></span>
        <span class="plus-session__progress"><span class="plus-session__bar">${bar}</span><small>Step ${current + 1} of ${steps.length} · Misogi</small></span>
      </div>
      <div class="plus-session__main">
        <ol class="plus-session__rail">${rail}</ol>
        <div class="plus-session__step">
          <span class="plus-session__kicker">Step ${current + 1} · Misogi</span>
          <p class="plus-session__question">What one challenge would define ${esc(String(year))}?</p>
          <p class="plus-session__lead">Hard enough that you might not make it, meaningful enough that you will train for it.</p>
          <span class="plus-session__label">Your Misogi</span>
          <span class="plus-session__field${preview.misogi ? '' : ' is-placeholder'}"><span>${esc(preview.misogi || 'Run a mountain ultra, write the first draft, swim across the lake…')}</span><i class="plus-session__caret"></i></span>
          <span class="plus-session__label plus-session__why">Why it matters <em>optional</em></span>
          <span class="plus-session__field plus-session__field--quiet plus-session__why${preview.why ? '' : ' is-placeholder'}"><span>${esc(preview.why || 'What changes for you if you do it')}</span></span>
          <span class="plus-session__when"><span class="plus-session__label">When</span><span class="plus-session__chip${preview.when ? ' has-value' : ''}">${icon('calendar')}${esc(preview.when || 'Put it on the calendar')}</span></span>
        </div>
      </div>
      <div class="plus-session__foot"><span>${preview.set ? `${preview.set} of ${preview.total} parts set · saved as you type` : 'About 30 minutes · saved as you type'}</span><span class="plus-session__next">Next${icon('arrow')}</span></div>
    </div>`;
}

/**
 * A printed page as a sheet of paper: `sheet` is the print markup and `kind`
 * its print-sheet modifier ('year', 'review'). The page is inert (its link and
 * text are decoration here); the dialog sets --plus-paper-scale.
 */
export function renderPaper(sheet, { kind, palette = 'terracotta', zoom = false } = {}) {
  return `<div class="plus-paper${zoom ? ' plus-paper--zoom' : ''}" data-plus-paper="${escAttr(kind)}">
      <div class="plus-paper__page plus-paper--${escAttr(palette)}" inert aria-hidden="true"><section class="print-sheet print-sheet--${escAttr(kind)}">${sheet}</section></div>
    </div>`;
}
