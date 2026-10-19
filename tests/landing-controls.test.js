import test from 'node:test';
import assert from 'node:assert/strict';

import { typeaheadIndex } from '../welcome/listbox.js';
import { readCount, stepCount } from '../welcome/stepper.js';

const PLANS = ['Up to 10 people', 'Up to 50 people', 'Up to 100 people', 'More than 1,000 people'];
const TIMING = ['Before the holidays (December 2026)', 'January 2027', 'Later in Q1 2027', 'Later'];

test('dropdown typeahead: the first option starting with what was typed, after the current one', () => {
  assert.equal(typeaheadIndex(TIMING, 'j', 0), 1);
  assert.equal(typeaheadIndex(TIMING, 'L', 0), 2, 'case is ignored');
  assert.equal(typeaheadIndex(TIMING, 'l', 2), 3, 'the same letter again moves to the next match');
  assert.equal(typeaheadIndex(TIMING, 'l', 3), 2, 'and wraps around');
  assert.equal(typeaheadIndex(TIMING, 'll', 2), 3, 'a repeated letter cycles like a single one');
  assert.equal(typeaheadIndex(TIMING, 'later ', 2), 2, 'a longer query keeps the current match');
  assert.equal(typeaheadIndex(TIMING, 'later in', -1), 2);
  assert.equal(typeaheadIndex(PLANS, 'm', 1), 3);
  assert.equal(typeaheadIndex(['Été', 'Hiver'], 'e', -1), 0, 'accents are ignored');
  assert.equal(typeaheadIndex(TIMING, 'x', 0), -1);
  assert.equal(typeaheadIndex([], 'a', 0), -1);
  assert.equal(typeaheadIndex(TIMING, '', 0), -1);
});

test('number stepper: whole numbers within range, or nothing', () => {
  const range = { min: 2, max: 100000 };
  assert.equal(readCount('40', range), 40);
  assert.equal(readCount(' 1,000 ', range), 1000, 'thousands separators are fine');
  assert.equal(readCount('1', range), 2, 'below the minimum: the minimum');
  assert.equal(readCount('250000', range), 100000, 'above the maximum: the maximum');
  assert.equal(readCount('', range), null);
  assert.equal(readCount('12a', range), null);
  assert.equal(readCount('1.5', range), null);
  assert.equal(readCount('-3', range), null);
});

test('number stepper: − and + move by one and stop at the ends', () => {
  const range = { min: 2, max: 100000, step: 1 };
  assert.equal(stepCount('40', 1, range), 41);
  assert.equal(stepCount('40', -1, range), 39);
  assert.equal(stepCount('2', -1, range), 2, 'never below the minimum');
  assert.equal(stepCount('100000', 1, range), 100000, 'never above the maximum');
  assert.equal(stepCount('', 1, range), 2, 'an empty field starts at the minimum');
  assert.equal(stepCount('', -1, range), 2);
  assert.equal(stepCount('40', 10, range), 50, 'a held button can move faster');
  assert.equal(stepCount('1', 1, range), 2, 'a number below the range comes back into it');
});
