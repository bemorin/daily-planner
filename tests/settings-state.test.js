import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultSettings, normalizePlannerSettings } from '../src/state/settings-state.js';

test('default settings preserve first-run behavior', () => {
  const settings = createDefaultSettings({ detectedWeekStart: 0, currentYear: 2026 });
  assert.equal(settings.startHour, 8);
  assert.equal(settings.endHour, 18);
  assert.equal(settings.expandedView, false);
  assert.equal(settings.onboardingComplete, false);
  assert.equal(settings.weekStartsOn, 1);
  assert.equal(settings.weekStartsOnExplicit, false);
  assert.deepEqual(settings.planningDays, [1, 2, 3, 4, 5]);
  assert.equal(settings.horizonStartYear, 2026);
});

test('legacy fit settings preserve migration behavior', () => {
  const legacy = normalizePlannerSettings({ expandedView: false }, { detectedWeekStart: 1, currentYear: 2026 });
  assert.equal(legacy.expandedView, true);
  const current = normalizePlannerSettings({ fitDefaultV8: true, expandedView: false }, { detectedWeekStart: 1, currentYear: 2026 });
  assert.equal(current.expandedView, false);
});

test('planning days are normalized and deduplicated', () => {
  const settings = normalizePlannerSettings({ planningDays: [1, '1', 5, 9, -1] }, { detectedWeekStart: 1, currentYear: 2026 });
  assert.deepEqual(settings.planningDays, [1, 5]);
});

test('open work keeps meaningful records and normalizes counters', () => {
  const settings = normalizePlannerSettings({
    openWork: [
      { id: 'x', text: ' Keep me ', carriedCount: -2 },
      { id: 'empty', text: '   ' }
    ]
  }, { detectedWeekStart: 1, currentYear: 2026 });
  assert.equal(settings.openWork.length, 1);
  assert.equal(settings.openWork[0].id, 'x');
  assert.equal(settings.openWork[0].carriedCount, 0);
});


test('legacy settings migrate to Monday-first until a user explicitly chooses another week start', () => {
  const legacy = normalizePlannerSettings({ weekStartDay: 1, weekStartsOn: 0 }, { detectedWeekStart: 0, currentYear: 2026 });
  assert.equal(legacy.weekStartsOn, 1);
  assert.equal(legacy.weekStartsOnExplicit, false);

  const explicit = normalizePlannerSettings({ weekStartDay: 1, weekStartsOn: 0, weekStartsOnExplicit: true }, { detectedWeekStart: 1, currentYear: 2026 });
  assert.equal(explicit.weekStartsOn, 0);
  assert.equal(explicit.weekStartsOnExplicit, true);
});
