import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CYCLE_STEPS, cycleCopy, cycleStepFor, stepForKey } from '../src/features/plus-cycle.js';
import { PAINT_PALETTES } from '../src/features/paint-palettes.js';

test('the yearly ritual: plan it, print it, look back', () => {
  assert.deepEqual(CYCLE_STEPS.map(step => step.id), ['plan', 'print', 'review']);
  assert.deepEqual(CYCLE_STEPS.map(step => step.label), ['Plan it', 'Print it', 'Look back']);
  assert.deepEqual(CYCLE_STEPS.map(step => step.when), ['Each December — or whenever you start', 'All year, on your desk', 'When the year ends']);
});

test('the dialog opens on the step of the feature that was asked for', () => {
  assert.equal(cycleStepFor('year-review'), 'review');
  assert.equal(cycleStepFor('year-plan'), 'plan');
  assert.equal(cycleStepFor('paint-palettes'), 'plan', 'the palettes are below the cycle');
  assert.equal(cycleStepFor(''), 'plan');
  assert.equal(cycleStepFor(), 'plan');
});

test('arrow keys move between the steps and wrap; Home and End jump', () => {
  assert.equal(stepForKey('plan', 'ArrowRight'), 'print');
  assert.equal(stepForKey('print', 'ArrowRight'), 'review');
  assert.equal(stepForKey('review', 'ArrowRight'), 'plan');
  assert.equal(stepForKey('plan', 'ArrowLeft'), 'review');
  assert.equal(stepForKey('review', 'ArrowUp'), 'print');
  assert.equal(stepForKey('print', 'ArrowDown'), 'review');
  assert.equal(stepForKey('review', 'Home'), 'plan');
  assert.equal(stepForKey('plan', 'End'), 'review');
  assert.equal(stepForKey('plan', 'Enter'), '');
  assert.equal(stepForKey('plan', 'a'), '');
});

test('each step says what it is and when; with Plus it has its action', () => {
  const plan = cycleCopy('plan', { year: 2027 });
  assert.equal(plan.title, 'Plan 2027 in a guided half hour.');
  assert.match(plan.text, /sets up 2027 in Horizon/);
  assert.equal(plan.action, null, 'without Plus, the action is Get Plus below');
  assert.equal(cycleCopy('plan', { year: 2027, active: true }).action.label, 'Plan 2027');
  const print = cycleCopy('print', { year: 2027 });
  assert.equal(print.title, '2027 on one page, finished by hand.');
  assert.match(print.text, /lines and boxes/);
  assert.equal(print.note, 'Printing the year is free in Horizon. Plus plans it with you.');
  const printWithPlus = cycleCopy('print', { year: 2027, active: true });
  assert.equal(printWithPlus.note, '');
  assert.deepEqual([printWithPlus.action.id, printWithPlus.action.label], ['print', 'Print the year']);
  const review = cycleCopy('review', { year: 2027, active: true });
  assert.equal(review.when, 'When the year ends');
  assert.deepEqual([review.action.id, review.action.label], ['review', 'Open your review']);
  for (const step of CYCLE_STEPS) {
    const copy = cycleCopy(step.id, { year: 2028, active: true });
    assert.doesNotMatch(`${copy.title} ${copy.text}`, /2027/, 'the year comes from the caller');
    assert.doesNotMatch(`${copy.title} ${copy.text} ${copy.when}`, /'|"/, 'curly quotes only');
  }
});

test('the paper preview prints each palette in its light colours, as styles/year.css does', () => {
  const plus = readFileSync(new URL('../styles/plus.css', import.meta.url), 'utf8');
  const year = readFileSync(new URL('../styles/year.css', import.meta.url), 'utf8');
  for (const palette of PAINT_PALETTES.filter(item => item.id !== 'terracotta')) {
    const light = year.match(new RegExp(`html\\[data-paint="${palette.id}"\\],\\s*\\.hz-palette--${palette.id} \\{ --hz-paint: (#[0-9a-f]{6})`));
    const paper = plus.match(new RegExp(`\\.plus-paper__page\\.plus-paper--${palette.id} \\{ --hz-paint: (#[0-9a-f]{6})`));
    assert.ok(light && paper, palette.id);
    assert.equal(paper[1], light[1], palette.id);
  }
  assert.match(plus, /\.plus-paper__page \{[^}]*--hz-misogi: #a5522e;[^}]*--hz-paint: #a5522e;/, 'terracotta, light');
});
