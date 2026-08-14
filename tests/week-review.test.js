import test from 'node:test';
import assert from 'node:assert/strict';
import { createWeekReviewFeature } from '../src/features/week-review.js';
import { atNoon, ymdKey } from '../src/lib/dates.js';

function makeFeature({ openWork = [], needsCount = 0 } = {}) {
  const currentDate = atNoon(new Date(2026, 7, 14));
  const days = [10, 11, 12, 13, 14].map(day => atNoon(new Date(2026, 7, day)));
  const dayState = {
    priorities: [{ text: 'Ship', done: true, carriedCount: 0 }, { text: '', done: false }, { text: '', done: false }],
    tasks: [],
    blocks: [{ categoryId: 'work', duration: 60 }],
    triaged: [],
    lesson: 'Keep it simple.'
  };
  return createWeekReviewFeature({
    getDate: () => currentDate,
    getState: () => dayState,
    getSettings: () => ({ openWork }),
    planningWeekDates: () => days,
    isPlanningDay: inputDate => days.some(day => ymdKey(day) === ymdKey(inputDate)),
    ymd: ymdKey,
    loadStateForDate: () => dayState,
    categoryFor: () => ({ id: 'work', name: 'Work', color: '#999' }),
    categoryFallback: () => ({ id: 'uncategorized', name: 'Uncategorized', color: '#999' }),
    getUnresolvedCounts: () => ({ needs: needsCount, later: openWork.length })
  });
}

test('weekly review recognizes the configured final planning day', () => {
  const feature = makeFeature();
  assert.equal(feature.isLastPlanningDay(new Date(2026, 7, 14)), true);
  assert.equal(feature.isLastPlanningDay(new Date(2026, 7, 13)), false);
});

test('weekly review renders unresolved work as an inline action', () => {
  const feature = makeFeature({ openWork: [{ id: 'o1', text: 'Decide later', carriedCount: 1 }] });
  const review = feature.weekReviewData(new Date(2026, 7, 14));
  const html = feature.renderWeekReviewSummary(review);
  assert.match(html, /data-review-open-work/);
  assert.match(html, /Review all/);
  assert.match(html, /Where your scheduled time went/);
  assert.match(html, /Still unresolved/);
  assert.match(html, />1<\/em>/);
});

test('weekly review renders the exact unresolved total from both queues', () => {
  const feature = makeFeature({ openWork: [{ id: 'o1', text: 'Decide later', carriedCount: 1 }], needsCount: 3 });
  const review = feature.weekReviewData(new Date(2026, 7, 14));
  const html = feature.renderWeekReviewSummary(review);
  assert.match(html, />4<\/em>/);
});
