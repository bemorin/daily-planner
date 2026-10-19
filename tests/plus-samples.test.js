import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProgressModel, TROPHIES } from '../src/features/progress-model.js';
import { buildYearReview, renderYearReviewPrint } from '../src/features/year-review.js';
import { renderYearPrint } from '../src/features/year-print.js';
import { planSummary } from '../src/features/year-plan.js';
import { defaultCategories } from '../src/config.js';
import { REVIEW_SAMPLE_BELOW, hasOwnReview, hasPrintablePlan, samplePrintModel, sampleKeyDates, sampleReview, sampleYearData } from '../src/features/plus-samples.js';

const icon = name => `<svg data-icon="${name}"></svg>`;

test('the sample plan is the landing page’s year, dated in the year to plan', () => {
  const data = sampleYearData(2027);
  assert.equal(data.misogi, 'Walk the Camino de Santiago');
  assert.equal(data.misogiStartDate, '2027-05-03');
  assert.equal(data.misogiEndDate, '2027-05-31');
  assert.deepEqual(data.misogiMilestones.map(item => [item.text, item.date]), [['Book the flights', '2027-02-02'], ['Walk 100 km in one week', '2027-03-21'], ['Test the gear on a weekend', '2027-04-11']]);
  assert.deepEqual(data.miniAdventures.map(item => item.text), ['Sleep in a mountain hut', 'Swim before 8am', 'Cook for twelve people', 'Learn to sail', 'A night under the stars', 'A day without a phone']);
  assert.deepEqual(data.meaningful, ['Home for dinner four nights a week', 'Read one book a month', 'Fewer projects, done better']);
  assert.deepEqual(data.habits, ['Walk after lunch', 'No phone in the bedroom', 'Write three lines', 'Stretch before bed']);
  assert.deepEqual(sampleKeyDates(2027).map(item => [item.text, item.startDate, item.endDate]), [['Team offsite in Lisbon', '2027-03-09', '2027-03-11'], ['Sam’s wedding', '2027-06-20', ''], ['Summer break', '2027-08-02', '2027-08-20']]);
  assert.equal(sampleYearData(2031).misogiStartDate, '2031-05-03', 'any year');
  const summary = planSummary({ ...data, months: { '2027-03': { anchors: sampleKeyDates(2027) } } }, 2027);
  assert.equal(summary.done, 6, 'every part but the look back');
});

test('the sample year prints as a plan just made: nothing done, nothing painted, empty rows left to write in', () => {
  const model = samplePrintModel(2027);
  assert.equal(model.year, 2027);
  assert.equal(model.isBlank, false);
  assert.equal(model.painted, null);
  assert.equal(model.misogi.text, 'Walk the Camino de Santiago');
  assert.equal(model.misogi.milestones.filter(Boolean).length, 3);
  assert.equal(model.misogi.milestones.filter(item => item === null).length, 2, 'two ruled rows for milestones added by hand');
  assert.ok(model.adventures.every(item => item && !item.done));
  assert.ok(model.habits.every(habit => habit.text && habit.kept === ''), 'no habit has been kept yet');
  assert.deepEqual(model.months[2].events.map(event => event.kind), ['keydate', 'milestone']);
  assert.ok(model.months[5].weeks.flat().some(cell => cell?.day === 20 && cell.kind === 'keydate'), 'Sam’s wedding on 20 June');
  const html = renderYearPrint(model);
  assert.match(html, /Walk the Camino de Santiago/);
  assert.match(html, /Sam’s wedding/);
  assert.equal(samplePrintModel(2027, { weekStartsOn: 0 }).weekdays.length, 7);
  assert.deepEqual(samplePrintModel(2027), samplePrintModel(2027), 'the same every time');
});

test('the sample review: 190 days closed, a best streak of 34, 14 of 20 trophies', () => {
  const { review, progress } = sampleReview(2026);
  assert.equal(review.year, 2026);
  assert.equal(review.isCurrentYear, false, 'a whole year, not “so far”');
  assert.equal(review.days.closed, 190);
  assert.equal(review.bestStreak, 34);
  assert.equal(review.trophies.unlocked.length, 14);
  assert.equal(review.trophies.total, TROPHIES.length);
  assert.equal(review.trophies.unlocked.at(-1).title, 'Misogi accomplished', 'the latest trophy closes the year');
  assert.ok(review.trophies.unlocked.every(trophy => TROPHIES.some(item => item.id === trophy.id)));
  const hours = Object.fromEntries(review.time.rows.map(row => [row.name, row.minutes / 60]));
  assert.deepEqual(hours, { 'Deep work': 412, Admin: 236, Personal: 168, Health: 121, Learning: 64 });
  assert.deepEqual(review.time.rows.map(row => row.name), ['Deep work', 'Admin', 'Personal', 'Health', 'Learning'], 'most time first');
  assert.ok(review.time.rows.every(row => defaultCategories.some(category => category.name === row.name && category.color === row.color)), 'the default categories and colours');
  assert.equal(review.horizon.misogi.text, 'Run a marathon');
  assert.equal(review.horizon.misogi.done, true);
  assert.equal(review.horizon.adventures.lived, 5);
  assert.equal(review.horizon.adventures.items.length, 6);
  assert.equal(review.journal.memories.length, 2);
  assert.equal(review.journal.lessons.length, 2);
  assert.equal(review.outcomes.done, progress.months.flatMap(month => month.days).filter(cell => cell.mitDone).length);
  assert.deepEqual(sampleReview(2026), sampleReview(2026), 'the same every time');
});

test('the sample painted year is believable: weekdays from March, the closed count adds up', () => {
  for (const year of [2025, 2026, 2027, 2028]) {
    const { review, progress } = sampleReview(year);
    assert.equal(progress.months.length, 12);
    progress.months.forEach(month => assert.equal(month.days.length, new Date(year, month.month + 1, 0).getDate()));
    const cells = progress.months.flatMap(month => month.days);
    assert.equal(cells.filter(cell => cell.closed).length, 190, `${year}`);
    assert.equal(progress.months.reduce((sum, month) => sum + month.closed, 0), 190);
    assert.ok(cells.every(cell => !cell.closed || (cell.weekday > 0 && cell.weekday < 6)), 'weekdays only');
    assert.ok(cells.filter(cell => cell.key < `${year}-03-01`).every(cell => !cell.closed && cell.before), 'started in March');
    assert.ok(cells.every(cell => !cell.joker || !cell.closed), 'a joker stands in for a day not closed');
    assert.ok(cells.every(cell => (cell.closed ? cell.level >= 1 && cell.level <= 3 : cell.level === 0)));
    assert.equal(review.days.closeRate, Math.round(190 / review.days.planningElapsed * 100));
  }
});

test('the sample review has the shape buildYearReview() gives, and prints through the real renderer', () => {
  const real = buildYearReview({ year: 2025, progress: buildProgressModel({ year: 2025, today: new Date(2026, 1, 1), getRecord: () => null }), yearData: sampleYearData(2025), today: new Date(2026, 1, 1) });
  const { review, progress } = sampleReview(2025);
  const shape = value => (value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, shape(value[key])])) : Array.isArray(value) ? 'array' : typeof value);
  assert.deepEqual(shape(review), shape(real));
  const html = renderYearReviewPrint(review, progress, { icon });
  assert.match(html, /Your 2025/);
  assert.match(html, /1 January – 31 December 2025/);
  assert.match(html, />190</);
  assert.match(html, /Run a marathon/);
  assert.match(html, /412 h/);
  assert.match(html, /Crossing the finish line with Sam/);
});

test('own previews need a printable plan, or 20 closed days for the review', () => {
  assert.equal(REVIEW_SAMPLE_BELOW, 20);
  assert.equal(hasOwnReview(null), false);
  assert.equal(hasOwnReview({ closed: 19 }), false);
  assert.equal(hasOwnReview({ closed: 20 }), true);
  assert.equal(hasOwnReview({ closed: 3 }, { below: 3 }), true);
  assert.equal(hasPrintablePlan(null), false);
  assert.equal(hasPrintablePlan({ steps: { lookback: true } }), false, 'the look back doesn’t print');
  assert.equal(hasPrintablePlan({ steps: { lookback: true, keydates: true } }), true);
  assert.equal(hasPrintablePlan({ steps: { misogi: true } }), true);
});

test('a finished year’s review never says “so far”', () => {
  const { review, progress } = sampleReview(2026);
  const page = renderYearReviewPrint(review, progress, { icon });
  assert.doesNotMatch(page, /so far/);
  assert.match(page, /of \d+ planning days/);
});
