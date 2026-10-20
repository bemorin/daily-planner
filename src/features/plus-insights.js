import { escAttr } from '../lib/text.js';
import { addDaysKey, dateFromKey, weekdayNames } from '../lib/dates.js';
import { ENOUGH, dayInsight, percent, weekdayFinding } from './insights-model.js';
import { SAMPLE_PLANNING_DAYS, sampleDay } from './insights-sample.js';
import { weekdayInitials, weekdayOrder } from './quarter-review.js';

/**
 * A small preview of Insights for the Daily Planner Plus dialog: its first
 * chart, “Days that work” (days closed and main outcomes done, by weekday),
 * over the last twelve weeks of this planner, or of Insights' own sample
 * planner when there are too few closed days. Counted as Insights counts it
 * (insights-model.js), from at most 84 stored days. Pure; unit-tested.
 */

export const RHYTHM_WEEKS = 12;

/**
 * Days closed and main outcomes done by weekday, from `weeks` weeks ending
 * today. As in Insights, a day counts from the first closed day of the period
 * on, once it is over (today only when it is closed); `enough` says whether
 * the rates mean anything yet.
 */
export function weekdayRhythm({ readDay, todayKey, weeks = RHYTHM_WEEKS, weekStartsOn = 1, planningDays = [1, 2, 3, 4, 5] }) {
  const planning = new Set((planningDays || []).map(Number));
  const rows = Array.from({ length: 7 }, (_, weekday) => ({ weekday, name: weekdayNames[weekday], planning: planning.has(weekday), days: 0, closed: 0, mitSet: 0, mitDone: 0 }));
  const startKey = addDaysKey(todayKey, -(Math.max(1, weeks) * 7 - 1));
  let started = false;
  let closed = 0;
  for (let key = startKey; key <= todayKey; key = addDaysKey(key, 1)) {
    let fact = null;
    try { fact = dayInsight(readDay(key)); } catch (_) { fact = null; }
    if (fact?.closed) started = true;
    if (!started || (key >= todayKey && !fact?.closed)) continue;
    const row = rows[dateFromKey(key).getDay()];
    row.days += 1;
    if (fact?.closed) { row.closed += 1; closed += 1; }
    if (fact?.mitSet) row.mitSet += 1;
    if (fact?.mitDone) row.mitDone += 1;
  }
  rows.forEach(row => {
    row.closeRate = row.days ? row.closed / row.days : 0;
    row.mitRate = row.mitSet ? row.mitDone / row.mitSet : 0;
  });
  const enough = closed >= ENOUGH.rhythmClosed && rows.filter(row => row.days >= 2).length >= 2;
  return { rows, order: weekdayOrder(weekStartsOn), closed, weeks, enough };
}

/**
 * The rhythm the dialog shows: this planner's when it has enough (with its
 * plain-language finding, when Insights would make one), else the sample's.
 * `source` is { readDay, planningDays(), weekStartsOn() } from app.js.
 */
export function rhythmPreview(source, { todayKey, weeks = RHYTHM_WEEKS } = {}) {
  const weekStartsOn = Number(source?.weekStartsOn?.() ?? 1);
  if (source?.readDay) {
    let planningDays = [1, 2, 3, 4, 5];
    try { planningDays = source.planningDays?.() || planningDays; } catch (_) {}
    const own = weekdayRhythm({ readDay: source.readDay, todayKey, weeks, weekStartsOn, planningDays });
    if (own.enough) return { ...own, sample: false, finding: weekdayFinding(own.rows, { closed: own.closed }) };
  }
  const sample = weekdayRhythm({ readDay: key => sampleDay(key, todayKey), todayKey, weeks, weekStartsOn, planningDays: SAMPLE_PLANNING_DAYS });
  return { ...sample, sample: true, finding: null };
}

/** The mini chart: two bars per weekday, in the planner's week order (rest days quieter). */
export function renderRhythmTry(rhythm) {
  const initials = weekdayInitials(rhythm.order[0]);
  const columns = rhythm.order.map((weekday, index) => {
    const row = rhythm.rows[weekday];
    const bar = (kind, value, shown) => `<i class="is-${kind}" style="--v:${shown ? Math.max(4, Math.round(value * 100)) : 0}%"></i>`;
    return `<span class="plus-rhythm__day${row.planning ? '' : ' is-rest'}"><span class="plus-rhythm__bars">${bar('closed', row.closeRate, row.days)}${bar('mit', row.mitRate, row.mitSet)}</span><b>${initials[index]}</b></span>`;
  }).join('');
  const label = rhythm.order.map(weekday => {
    const row = rhythm.rows[weekday];
    return `${row.name}: ${row.days ? `${percent(row.closeRate)}% closed` : 'no days yet'}${row.mitSet ? `, main outcome done on ${percent(row.mitRate)}%` : ''}`;
  }).join('; ');
  return `<div class="plus-preview plus-preview--insights">
      <span class="plus-rhythm" role="img" aria-label="${escAttr(`${rhythm.sample ? 'Sample planner' : `Your last ${rhythm.weeks} weeks`}, days closed and main outcomes done by weekday. ${label}.`)}">${columns}</span>
      <span class="plus-rhythm__key" aria-hidden="true"><span><i class="is-closed"></i>Days closed</span><span><i class="is-mit"></i>Main outcome</span></span>
    </div>`;
}
