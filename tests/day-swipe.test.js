import test from 'node:test';
import assert from 'node:assert/strict';
import { swipeDirection } from '../src/features/day-swipe.js';

test('horizontal swipe direction maps left to next and right to previous', () => {
  assert.equal(swipeDirection(-90, 8), 1);
  assert.equal(swipeDirection(90, -8), -1);
});

test('short or mostly vertical gestures are not day swipes', () => {
  assert.equal(swipeDirection(40, 2), 0);
  assert.equal(swipeDirection(90, 80), 0);
});
