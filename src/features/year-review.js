import { esc, escAttr } from '../lib/text.js';
import { atNoon, dateFromKey, ymdKey } from '../lib/dates.js';
import { habitActivityStats, rangeLabel } from './horizon-model.js';
import { progressIcon, renderPaintedYear, renderPaintLegend } from './progress-view.js';
import { panelEnter } from '../ui/motion.js';

/**
 * "Your year in review" (Daily Planner Plus): one page for a year — days
 * closed, the painted year, best streak, trophies, main outcomes done, time by
 * category, how the Misogi, adventures and habits turned out, and a few
 * memories and lessons from closed days. Printable on one landscape page.
 *
 * `buildYearReview` is pure (unit-tested over fake day records); the markup
 * functions are pure strings; `createYearReview` renders in the overlay that
 * horizon-view.js provides and prints through the app's print sheet.
 */

export const REVIEW_FEATURE = 'year-review';
const MAX_CATEGORIES = 6;
const JOURNAL_LIMIT = 5;
const TRIM_AT = 150;
const UNCATEGORIZED = { id: '', name: 'No category', color: '#8c867f' };

/** In January the year to review is the one that just ended. */
export function defaultReviewYear(today = new Date()) {
  return today.getMonth() === 0 ? today.getFullYear() - 1 : today.getFullYear();
}

/** December 1 to January 31: the review is offered on the Overview. */
export function inReviewSeason(today = new Date()) {
  return today.getMonth() === 11 || today.getMonth() === 0;
}

/** Years that can be reviewed: from the first Horizon year (and always last year) to this one. */
export function reviewYearOptions(today = new Date(), minYear = today.getFullYear()) {
  const current = today.getFullYear();
  const first = Math.min(Number(minYear) || current, current - 1);
  return Array.from({ length: current - first + 1 }, (_, index) => first + index);
}

/** Collapse whitespace and cut at a word boundary. */
export function trimText(value, max = TRIM_AT) {
  const clean = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:!?–—-]+$/, '')}…`;
}

/** Hours for a year's worth of minutes: "45 min", "7.5 h", "126 h". */
export function hoursLabel(minutes) {
  const value = Math.max(0, Number(minutes) || 0);
  if (value < 60) return `${Math.round(value)}\u00a0min`;
  const hours = value / 60;
  return `${hours < 10 ? Math.round(hours * 10) / 10 : Math.round(hours)}\u00a0h`;
}

/** Up to `limit` journal entries, balanced between memories and lessons. */
export function pickJournal(memories, lessons, limit = JOURNAL_LIMIT) {
  let memoryCount = Math.min(memories.length, Math.ceil(limit / 2));
  const lessonCount = Math.min(lessons.length, limit - memoryCount);
  memoryCount = Math.min(memories.length, limit - lessonCount);
  return { memories: memories.slice(0, memoryCount), lessons: lessons.slice(0, lessonCount) };
}

/**
 * @param {object} options
 * @param {number} options.year
 * @param {object} options.progress progress model for the year (progress-model.js)
 * @param {object} options.yearData Horizon data for the year
 * @param {(key: string) => object|null} options.readDay stored day record
 * @param {(id: string) => object|null} options.categoryFor
 */
export function buildYearReview({ year, progress, yearData = {}, readDay = () => null, categoryFor = () => null, today = new Date() }) {
  const now = atNoon(today);
  const todayKey = ymdKey(now);
  const isCurrentYear = year === now.getFullYear();
  const last = isCurrentYear ? todayKey : `${year}-12-31`;
  const minutes = new Map();
  const entries = [];
  let scheduledDays = 0;

  if (year <= now.getFullYear()) {
    for (let day = atNoon(new Date(year, 0, 1)); day.getFullYear() === year; day.setDate(day.getDate() + 1)) {
      const key = ymdKey(day);
      if (key > last) break;
      let record = null;
      try { record = readDay(key); } catch (_) { record = null; }
      if (!record || typeof record !== 'object') continue;
      const blocks = Array.isArray(record.blocks) ? record.blocks : [];
      let any = false;
      blocks.forEach(block => {
        const duration = Math.min(24 * 60, Math.max(0, Number(block?.duration) || 0));
        if (!duration) return;
        any = true;
        const id = String(block.categoryId || '');
        minutes.set(id, (minutes.get(id) || 0) + duration);
      });
      if (any) scheduledDays += 1;
      if (record.endedAt) ['memory', 'lesson'].forEach(field => { const value = trimText(record[field]); if (value) entries.push({ field, key, text: value }); });
    }
  }

  const total = [...minutes.values()].reduce((sum, value) => sum + value, 0);
  // Blocks without a category, or whose category was deleted, share one row.
  const buckets = new Map();
  minutes.forEach((value, id) => {
    let category = null;
    try { category = id ? categoryFor(id) : null; } catch (_) { category = null; }
    const row = category ? { id: String(category.id || id), name: String(category.name || UNCATEGORIZED.name), color: category.color || UNCATEGORIZED.color } : { ...UNCATEGORIZED };
    const bucket = buckets.get(row.id) || { ...row, minutes: 0 };
    bucket.minutes += value;
    buckets.set(row.id, bucket);
  });
  const ranked = [...buckets.values()].sort((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name));
  let rows = ranked;
  if (ranked.length > MAX_CATEGORIES) {
    const rest = ranked.slice(MAX_CATEGORIES - 1);
    rows = [...ranked.slice(0, MAX_CATEGORIES - 1), { id: '__other', name: `${rest.length} other categories`, color: UNCATEGORIZED.color, minutes: rest.reduce((sum, row) => sum + row.minutes, 0) }];
  }
  rows = rows.map(row => ({ ...row, share: total ? row.minutes / total : 0 }));

  // Most recent first; a memory written on several days is kept once, at its latest day.
  const memories = [];
  const lessons = [];
  const seen = new Set();
  entries.reverse().forEach(entry => {
    const id = `${entry.field}:${entry.text.toLocaleLowerCase()}`;
    if (seen.has(id)) return;
    seen.add(id);
    (entry.field === 'memory' ? memories : lessons).push({ key: entry.key, text: entry.text });
  });
  const journal = pickJournal(memories, lessons);

  const d = yearData || {};
  const milestones = (d.misogiMilestones || []).filter(item => String(item?.text || '').trim());
  const adventures = (d.miniAdventures || []).filter(item => String(item?.text || '').trim()).map(item => ({ text: item.text.trim(), done: !!item.done || item.status === 'done', when: item.startDate ? rangeLabel(item.startDate, item.endDate) : '' }));
  const habits = (Array.isArray(d.habits) ? d.habits : []).map((habit, index) => {
    const textValue = String(habit || '').trim();
    if (!textValue) return { quarter: index + 1, text: '', percent: null, done: 0, elapsed: 0 };
    const stats = habitActivityStats(d, index, year, today);
    return { quarter: index + 1, text: textValue, percent: stats.elapsed ? stats.percent : null, done: stats.done, elapsed: stats.elapsed };
  });
  const unlocked = (progress?.unlocked || []).slice().sort((a, b) => String(a.unlockedOn || '9999').localeCompare(String(b.unlockedOn || '9999')));
  const closed = progress?.closed || 0;
  const mitDone = progress?.metrics?.mitDone || 0;

  return {
    year,
    isCurrentYear,
    isFutureYear: year > now.getFullYear(),
    asOf: isCurrentYear ? todayKey : '',
    days: { closed, closeRate: progress?.closeRate || 0, planningElapsed: progress?.planningElapsed || 0 },
    bestStreak: progress?.streak?.yearBest || 0,
    trophies: { unlocked: unlocked.map(trophy => ({ id: trophy.id, title: trophy.title, icon: trophy.icon, group: trophy.group, unlockedOn: trophy.unlockedOn || '' })), total: progress?.trophies?.length || 0 },
    outcomes: { done: mitDone, share: closed ? Math.round(mitDone / closed * 100) : 0 },
    time: { total, days: scheduledDays, rows },
    horizon: {
      misogi: { text: String(d.misogi || '').trim(), why: String(d.misogiWhy || '').trim(), when: d.misogiStartDate ? rangeLabel(d.misogiStartDate, d.misogiEndDate) : '', done: !!d.misogiDone, milestones: milestones.map(item => ({ text: item.text.trim(), done: !!item.done })), milestonesDone: milestones.filter(item => item.done).length },
      adventures: { items: adventures, lived: adventures.filter(item => item.done).length },
      commitments: (d.meaningful || []).map(value => String(value || '').trim()).filter(Boolean),
      habits
    },
    journal,
    isEmpty: !closed && !total && !String(d.misogi || '').trim() && !adventures.length
  };
}

// ---------------------------------------------------------------------------
// Markup
// ---------------------------------------------------------------------------

const shortDay = key => dateFromKey(key).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

function periodLabel(review) {
  if (review.isCurrentYear) return `1 January – ${shortDay(review.asOf)}`;
  return `1 January – 31 December ${review.year}`;
}

function statTiles(review) {
  const tiles = [
    { label: 'Days closed', value: review.days.closed, note: review.days.planningElapsed ? `${review.days.closeRate}% of planning days` : 'Close a day to paint it' },
    { label: 'Close rate', value: `${review.days.closeRate}<small>%</small>`, note: review.days.planningElapsed ? `${plural(review.days.planningElapsed, 'planning day')} so far` : 'No planning days yet' },
    { label: 'Best streak', value: `${review.bestStreak}<small> d</small>`, note: 'Planning days in a row', icon: 'flame' },
    { label: 'Trophies', value: `${review.trophies.unlocked.length}<small>/${review.trophies.total}</small>`, note: review.trophies.unlocked.length ? `Latest: ${esc(review.trophies.unlocked[review.trophies.unlocked.length - 1].title)}` : 'None unlocked yet', icon: 'trophy' },
    { label: 'Main outcomes done', value: review.outcomes.done, note: review.days.closed ? `${review.outcomes.share}% of closed days` : 'Your most important outcome', icon: 'target' }
  ];
  return tiles.map(tile => `<div class="yr-stat"><span>${esc(tile.label)}</span><strong>${tile.icon ? progressIcon(tile.icon) : ''}${tile.value}</strong><small>${tile.note}</small></div>`).join('');
}

function timeList(review, { limit = 6 } = {}) {
  if (!review.time.total) return '<p class="yr-empty">Time appears here once your days have scheduled blocks.</p>';
  const max = Math.max(...review.time.rows.map(row => row.minutes));
  return `<ol class="yr-bars">${review.time.rows.slice(0, limit).map(row => `<li class="yr-bar" style="--bar-color:${escAttr(row.color)}">
      <span class="yr-bar__name"><i aria-hidden="true"></i>${esc(row.name)}</span>
      <span class="yr-bar__value">${esc(hoursLabel(row.minutes))}<small> · ${Math.round(row.share * 100)}%</small></span>
      <span class="yr-bar__track" aria-hidden="true"><span style="width:${(row.minutes / max * 100).toFixed(1)}%"></span></span>
    </li>`).join('')}</ol>`;
}

function horizonBlock(review, iconFn) {
  const { misogi, adventures, habits, commitments } = review.horizon;
  const check = done => `<span class="yr-check${done ? ' is-done' : ''}" aria-hidden="true">${done ? iconFn('check') : ''}</span>`;
  const misogiPart = misogi.text
    ? `<div class="yr-misogi${misogi.done ? ' is-done' : ''}">${check(misogi.done)}<div><strong>${esc(misogi.text)}</strong><small>${esc([misogi.done ? 'Accomplished' : 'Not marked done', misogi.when, misogi.milestones.length ? `${misogi.milestonesDone}/${misogi.milestones.length} milestones` : ''].filter(Boolean).join(' · '))}</small>${misogi.why ? `<em>${esc(misogi.why)}</em>` : ''}</div></div>`
    : '<p class="yr-empty">No Misogi was named for this year.</p>';
  const adventureList = adventures.items.length
    ? `<ul class="yr-list">${adventures.items.map(item => `<li class="${item.done ? 'is-done' : ''}">${check(item.done)}<span>${esc(item.text)}</span>${item.when ? `<small>${esc(item.when)}</small>` : ''}</li>`).join('')}</ul>`
    : '<p class="yr-empty">No mini-adventures were written down.</p>';
  const habitList = `<ul class="yr-habits">${habits.map(habit => `<li${habit.text ? '' : ' class="is-empty"'}><b>Q${habit.quarter}</b><span>${habit.text ? esc(habit.text) : 'No habit'}</span>${habit.percent == null ? '' : `<em>${habit.percent}%</em>`}</li>`).join('')}</ul>`;
  return `<div class="yr-horizon">
    <section class="yr-sub yr-kind--misogi"><h5>${iconFn('mountain')}Misogi</h5>${misogiPart}</section>
    <section class="yr-sub yr-kind--adventure"><h5>${iconFn('flag')}Mini-adventures <span>${adventures.lived} of ${adventures.items.length || 6} lived</span></h5>${adventureList}</section>
    <section class="yr-sub yr-kind--habit"><h5>${iconFn('repeat')}Winning habits</h5>${habitList}</section>
    ${commitments.length ? `<section class="yr-sub yr-kind--commitment"><h5>${iconFn('heart')}Commitments</h5><ol class="yr-commitments">${commitments.map(value => `<li>${esc(value)}</li>`).join('')}</ol></section>` : ''}
  </div>`;
}

function journalBlock(review) {
  const { memories, lessons } = review.journal;
  if (!memories.length && !lessons.length) return '<p class="yr-empty">Memories and lessons you write when you close a day will appear here.</p>';
  const quote = (entry, kind) => `<li class="yr-quote yr-quote--${kind}"><blockquote>${esc(entry.text)}</blockquote><small>${esc(shortDay(entry.key))}</small></li>`;
  return `<div class="yr-journal">
    ${memories.length ? `<section><h5>Memories</h5><ul>${memories.map(entry => quote(entry, 'memory')).join('')}</ul></section>` : ''}
    ${lessons.length ? `<section><h5>Lessons</h5><ul>${lessons.map(entry => quote(entry, 'lesson')).join('')}</ul></section>` : ''}
  </div>`;
}

function trophyChips(review, { limit = 20 } = {}) {
  if (!review.trophies.unlocked.length) return '<p class="yr-empty">Trophies you unlock this year will line up here.</p>';
  return `<ul class="yr-trophies">${review.trophies.unlocked.slice(0, limit).map(trophy => `<li class="hz-trophy--${escAttr(trophy.group)}">${progressIcon(trophy.icon)}<span>${esc(trophy.title)}</span>${trophy.unlockedOn ? `<small>${esc(shortDay(trophy.unlockedOn))}</small>` : ''}</li>`).join('')}</ul>`;
}

/** The review as shown in Horizon. */
export function renderYearReview(review, progress, { icon: iconFn }) {
  const lead = review.isEmpty
    ? `Nothing to look back on in ${review.year} yet. Close a day and the year starts painting itself.`
    : `${plural(review.days.closed, 'day')} closed, ${plural(review.horizon.adventures.lived, 'adventure')} lived${review.time.total ? `, ${hoursLabel(review.time.total)} scheduled` : ''}.`;
  return `<header class="yr-hero"><span class="hz-eyebrow">${esc(periodLabel(review))}${review.isCurrentYear ? ' · so far' : ''}</span><h3 tabindex="-1" data-review-autofocus>Your ${review.year} in review</h3><p>${esc(lead)}</p></header>
    <div class="yr-stats">${statTiles(review)}</div>
    <section class="hz-card yr-card yr-card--paint"><header class="hz-card__head"><div><span class="hz-eyebrow">The year, painted</span><h4>${review.days.closed ? `${plural(review.days.closed, 'square')}, one per closed day` : 'No squares yet'}</h4></div>${renderPaintLegend()}</header><div class="hz-paint-scroller">${renderPaintedYear(progress)}</div></section>
    <div class="yr-grid">
      <section class="hz-card yr-card"><header class="yr-card__head"><span class="hz-eyebrow">Where the time went</span><h4>${review.time.total ? `${hoursLabel(review.time.total)} scheduled over ${plural(review.time.days, 'day')}` : 'No scheduled time yet'}</h4></header>${timeList(review)}</section>
      <section class="hz-card yr-card"><header class="yr-card__head"><span class="hz-eyebrow">Horizon</span><h4>How the year’s intentions turned out</h4></header>${horizonBlock(review, iconFn)}</section>
    </div>
    <section class="hz-card yr-card"><header class="yr-card__head"><span class="hz-eyebrow">Trophies unlocked</span><h4>${review.trophies.unlocked.length} of ${review.trophies.total}</h4></header>${trophyChips(review)}</section>
    <section class="hz-card yr-card"><header class="yr-card__head"><span class="hz-eyebrow">From your journal</span><h4>A few memories and lessons</h4></header>${journalBlock(review)}</section>`;
}

/** One landscape page for the print sheet (styles/year.css, `.print-sheet--review`). */
export function renderYearReviewPrint(review, progress, { icon: iconFn }) {
  const rows = (progress?.months || []).map(month => `<div class="rv-paint__row"><span>${esc(new Date(review.year, month.month, 1).toLocaleDateString(undefined, { month: 'short' }))}</span>${month.days.map(cell => `<i class="${cell.closed ? `is-level-${cell.level}` : cell.future ? 'is-future' : cell.joker ? 'is-joker' : cell.planning && !cell.before ? 'is-missed' : ''}"></i>`).join('')}<b>${month.closed || ''}</b></div>`).join('');
  return `<header class="print-sheet-head rv-head">
      <div><span>Year in review · ${esc(periodLabel(review))}</span><h1>Your ${review.year}</h1></div>
      <div class="rv-stats">${statTiles(review)}</div>
    </header>
    <div class="rv-body">
      <div class="rv-col">
        <section class="rv-card rv-card--paint"><h2>The year, painted</h2><div class="rv-paint">${rows}</div><p class="rv-legend"><i class="is-level-1"></i>Closed <i class="is-level-2"></i>+ main outcome <i class="is-level-3"></i>+ winning habit <i class="is-joker"></i>Joker</p></section>
        <section class="rv-card"><h2>Trophies unlocked <small>${review.trophies.unlocked.length} of ${review.trophies.total}</small></h2>${trophyChips(review, { limit: 12 })}</section>
      </div>
      <div class="rv-col">
        <section class="rv-card"><h2>Where the time went <small>${review.time.total ? `${esc(hoursLabel(review.time.total))} scheduled` : ''}</small></h2>${timeList(review)}</section>
        <section class="rv-card rv-card--horizon"><h2>Horizon</h2>${horizonBlock(review, iconFn)}</section>
      </div>
      <div class="rv-col">
        <section class="rv-card rv-card--journal"><h2>From the journal</h2>${journalBlock(review)}</section>
      </div>
    </div>
    <a class="print-sheet-domain" href="https://planner.bemorin.com">planner.bemorin.com</a>`;
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/**
 * @param {object} options
 * @param {object} options.ctx Horizon context (progress, yearData, readDay, categoryFor, minYear, track?)
 * @param {Function} options.overlay mounts an overlay over the Horizon dialog
 * @param {Function} options.icon
 * @param {Function} [options.onLeave]
 */
export function createYearReview({ ctx, overlay, icon, onLeave }) {
  let session = null;

  function build(year) {
    const progress = ctx.progress(year);
    const review = buildYearReview({ year, progress, yearData: ctx.yearData(year), readDay: key => ctx.readDay?.(key) ?? null, categoryFor: id => ctx.categoryFor?.(id) ?? null, today: new Date() });
    return { review, progress };
  }

  function render(direction = 0) {
    const { el } = session.handle;
    const options = reviewYearOptions(new Date(), ctx.minYear?.());
    const index = options.indexOf(session.year);
    const { review, progress } = build(session.year);
    session.model = { review, progress };
    el.querySelector('[data-review-years]').innerHTML = `<button type="button" class="icon-button hz-year-step" data-review-year="-1" aria-label="Previous year" ${index <= 0 ? 'disabled' : ''}>${icon('chevronLeft')}</button>
      <h2><span class="sr-only">Review of </span>${session.year}</h2>
      <button type="button" class="icon-button hz-year-step" data-review-year="1" aria-label="Next year" ${index < 0 || index >= options.length - 1 ? 'disabled' : ''}>${icon('chevronRight')}</button>`;
    const body = el.querySelector('[data-review-body]');
    body.innerHTML = renderYearReview(review, progress, { icon });
    el.querySelector('[data-review-scroll]').scrollTop = 0;
    if (direction) panelEnter(body, { direction });
  }

  function open({ year = defaultReviewYear(new Date()) } = {}) {
    if (session) return;
    const options = reviewYearOptions(new Date(), ctx.minYear?.());
    session = { year: options.includes(year) ? year : defaultReviewYear(new Date()), handle: null, model: null };
    session.handle = overlay({ className: 'yr', label: `Your ${session.year} in review`, onEscape: () => close(), onKey: key => { if (key === 'p' || key === 'P') { print(); return true; } return false; } });
    const { el } = session.handle;
    el.innerHTML = `<header class="yp-head yr-head">
        <div class="yp-head__title"><span class="yp-eyebrow">${icon('sparkle')}Year in review</span><div class="yp-year" data-review-years></div></div>
        <div class="yr-head__actions"><button type="button" class="secondary-button yr-print" data-review-print>${icon('printer')}<span>Print on one page</span></button></div>
        <button type="button" class="icon-button yp-close" data-review-close aria-label="Close the year in review">${icon('close')}</button>
      </header>
      <div class="yp-scroll yr-scroll" data-review-scroll><div class="yr-body" data-review-body></div></div>`;
    el.addEventListener('click', event => {
      const button = event.target.closest('button');
      if (!button || button.disabled || !session) return;
      if ('reviewClose' in button.dataset) close();
      else if ('reviewPrint' in button.dataset) print();
      else if (button.dataset.reviewYear) {
        const options = reviewYearOptions(new Date(), ctx.minYear?.());
        const next = options[options.indexOf(session.year) + Number(button.dataset.reviewYear)];
        if (next) { session.year = next; el.setAttribute('aria-label', `Your ${next} in review`); render(Math.sign(Number(button.dataset.reviewYear))); }
      }
    });
    render();
    ctx.track?.('year_review_opened');
    requestAnimationFrame(() => el.querySelector('[data-review-autofocus]')?.focus({ preventScroll: true }));
  }

  function close({ silent = false } = {}) {
    if (!session) return;
    const { handle, year } = session;
    session = null;
    handle.close({ restoreFocus: !silent });
    if (!silent) onLeave?.(year);
  }

  function buildSheet() {
    if (!session) return null;
    document.querySelectorAll('[data-print-sheet]').forEach(sheet => sheet.remove());
    const { review, progress } = session.model || build(session.year);
    const sheet = document.createElement('section');
    sheet.className = 'print-sheet print-sheet--review';
    sheet.dataset.printSheet = 'true';
    sheet.innerHTML = renderYearReviewPrint(review, progress, { icon });
    document.body.append(sheet);
    document.body.classList.add('is-printing');
    return sheet;
  }

  function print() {
    if (!session) return;
    ctx.closeAllPopovers?.();
    const titleBefore = document.title;
    document.title = `Daily Planner - review-${session.year}`;
    buildSheet();
    const cleanup = () => {
      document.querySelectorAll('.print-sheet--review').forEach(sheet => sheet.remove());
      if (!document.querySelector('[data-print-sheet]')) document.body.classList.remove('is-printing');
      document.title = titleBefore;
    };
    window.addEventListener('afterprint', cleanup, { once: true });
    requestAnimationFrame(() => requestAnimationFrame(() => window.print()));
  }

  // The browser's own Print command while the review is open prints the review.
  // Registered when Horizon is created, so it runs before the app's handler,
  // which leaves an existing print sheet alone.
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeprint', () => {
      if (session && !document.body.classList.contains('is-printing')) {
        buildSheet();
        window.addEventListener('afterprint', () => { document.querySelectorAll('.print-sheet--review').forEach(sheet => sheet.remove()); }, { once: true });
      }
    });
  }

  return { open, close, isOpen: () => !!session, print };
}
