import test from 'node:test';
import assert from 'node:assert/strict';
import { addDaysKey, dateFromKey } from '../src/lib/dates.js';
import { RHYTHM_WEEKS, renderRhythmTry, rhythmPreview, weekdayRhythm } from '../src/features/plus-insights.js';

const TODAY = '2026-10-21'; // a Wednesday

/** Days from `from` to the day before today: weekdays closed unless `open` says so, the main outcome done on Tuesdays only. */
function planner({ from = addDaysKey(TODAY, -83), open = () => false, closeToday = false } = {}) {
  const days = new Map();
  for (let key = from; key <= TODAY; key = addDaysKey(key, 1)) {
    const weekday = dateFromKey(key).getDay();
    if (weekday === 0 || weekday === 6) continue;
    const closed = key < TODAY ? !open(key, weekday) : closeToday;
    days.set(key, { priorities: [{ text: 'The one thing', done: weekday === 2 }], blocks: [], endedAt: closed ? `${key}T18:00:00` : '' });
  }
  return key => days.get(key) || null;
}

test('the weekday rhythm counts as Insights does: closed and main outcome rates by weekday', () => {
  const rhythm = weekdayRhythm({ readDay: planner({ open: (key, weekday) => weekday === 5 && key < '2026-09-15' }), todayKey: TODAY });
  assert.equal(rhythm.weeks, RHYTHM_WEEKS);
  assert.deepEqual(rhythm.order, [1, 2, 3, 4, 5, 6, 0], 'Monday first');
  assert.equal(rhythm.enough, true);
  const [sunday, monday, tuesday, wednesday, , friday, saturday] = rhythm.rows;
  assert.equal(monday.closeRate, 1);
  assert.ok(friday.closeRate > 0.3 && friday.closeRate < 0.7, `Fridays ${friday.closeRate}`);
  assert.equal(tuesday.mitRate, 1);
  assert.equal(monday.mitRate, 0);
  assert.equal(wednesday.days, 11, 'today is not over and not closed: it does not count yet');
  assert.equal(saturday.planning, false);
  assert.equal(sunday.closed, 0);
  assert.equal(rhythm.closed, rhythm.rows.reduce((sum, row) => sum + row.closed, 0));
  const closedToday = weekdayRhythm({ readDay: planner({ closeToday: true }), todayKey: TODAY });
  assert.equal(closedToday.rows[3].days, 12, 'a closed today counts');
});

test('days before the first closed day of the period do not count; too few closed days are not enough', () => {
  const late = weekdayRhythm({ readDay: planner({ from: addDaysKey(TODAY, -9) }), todayKey: TODAY });
  assert.equal(late.rows[1].days, 2);
  assert.equal(late.enough, true);
  const thin = weekdayRhythm({ readDay: planner({ from: addDaysKey(TODAY, -3) }), todayKey: TODAY });
  assert.equal(thin.enough, false);
  const broken = weekdayRhythm({ readDay: () => { throw new Error('storage'); }, todayKey: TODAY });
  assert.equal(broken.closed, 0);
  assert.equal(broken.enough, false);
});

test('the preview shows this planner when it has enough, with Insights’ own finding, else the sample', () => {
  const own = rhythmPreview({ readDay: planner({ open: (key, weekday) => weekday === 5 && key < '2026-10-10' }), planningDays: () => [1, 2, 3, 4, 5], weekStartsOn: () => 0 }, { todayKey: TODAY });
  assert.equal(own.sample, false);
  assert.deepEqual(own.order, [0, 1, 2, 3, 4, 5, 6], 'Sunday first, as the planner says');
  assert.match(own.finding.text, /strongest days: 100% closed\.$/);
  const empty = rhythmPreview({ readDay: () => null, planningDays: () => [1, 2, 3, 4, 5], weekStartsOn: () => 1 }, { todayKey: TODAY });
  assert.equal(empty.sample, true);
  assert.equal(empty.enough, true, 'the sample always has a rhythm');
  assert.equal(empty.finding, null);
  assert.equal(rhythmPreview(null, { todayKey: TODAY }).sample, true);
  assert.deepEqual(rhythmPreview(null, { todayKey: TODAY }), rhythmPreview(undefined, { todayKey: TODAY }), 'the sample is the same on every render');
});

test('the mini chart: two bars per weekday in week order, rest days quieter, described for screen readers', () => {
  const rhythm = rhythmPreview(null, { todayKey: TODAY });
  const html = renderRhythmTry(rhythm);
  assert.equal((html.match(/class="plus-rhythm__day/g) || []).length, 7);
  assert.equal((html.match(/class="is-closed" style="--v:/g) || []).length, 7);
  assert.equal((html.match(/class="is-mit" style="--v:/g) || []).length, 7);
  assert.equal((html.match(/plus-rhythm__day is-rest/g) || []).length, 2);
  assert.match(html, /role="img" aria-label="Sample planner, days closed and main outcomes done by weekday\. Monday: \d+% closed/);
  assert.match(html, /Sunday: \d+% closed[^"]*\."/);
  const own = renderRhythmTry({ ...rhythm, sample: false });
  assert.match(own, /aria-label="Your last 12 weeks,/);
});
