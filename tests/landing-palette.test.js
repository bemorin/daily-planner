import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FREE_SWATCH, SWATCHES, shownSwatch, swatchById, swatchStep, tourOrder } from '../welcome/palette-card.js';
import { currencyLine, taxLine } from '../welcome/landing-model.js';
import { DEFAULT_PAINT, PAINT_PALETTES } from '../src/features/paint-palettes.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => readFile(join(root, rel), 'utf8');

test('the landing’s palettes are the planner’s, in the same order, and only Terracotta is free', () => {
  assert.deepEqual(SWATCHES.map(swatch => [swatch.id, swatch.name]), PAINT_PALETTES.map(palette => [palette.id, palette.name]));
  assert.equal(FREE_SWATCH, DEFAULT_PAINT);
  assert.deepEqual(SWATCHES.filter(swatch => swatch.free).map(swatch => swatch.id), [DEFAULT_PAINT]);
  assert.equal(swatchById('plum').name, 'Plum');
  assert.equal(swatchById('nope').id, FREE_SWATCH, 'an unknown id falls back to the free palette');
});

test('swatches: arrows step and wrap, Home and End jump, other keys are left alone', () => {
  assert.equal(swatchStep('ArrowRight', 0, 6), 1);
  assert.equal(swatchStep('ArrowDown', 5, 6), 0, 'wraps forward');
  assert.equal(swatchStep('ArrowLeft', 0, 6), 5, 'wraps back');
  assert.equal(swatchStep('ArrowUp', 3, 6), 2);
  assert.equal(swatchStep('Home', 4, 6), 0);
  assert.equal(swatchStep('End', 1, 6), 5);
  assert.equal(swatchStep('Enter', 1, 6), -1);
  assert.equal(swatchStep('Tab', 1, 6), -1);
  assert.equal(swatchStep('ArrowRight', 0, 0), -1, 'nothing to move to');
  assert.equal(swatchStep('ArrowRight', 9, 6), 0, 'an index out of range is clamped first');
});

test('the painted year shows the swatch under the pointer, else the focused one, else the pressed one', () => {
  assert.equal(shownSwatch({ hover: 'ocean', focus: 'plum', chosen: 'forest' }), 'ocean');
  assert.equal(shownSwatch({ focus: 'plum', chosen: 'forest' }), 'plum');
  assert.equal(shownSwatch({ chosen: 'forest' }), 'forest');
  assert.equal(shownSwatch({}), FREE_SWATCH);
  assert.equal(shownSwatch({ hover: 'nope' }), FREE_SWATCH);
});

test('the tour shows every other palette once and ends where it started', () => {
  assert.deepEqual(tourOrder(), ['ocean', 'forest', 'plum', 'graphite', 'sunset', 'terracotta']);
  assert.deepEqual(tourOrder('graphite'), ['sunset', 'terracotta', 'ocean', 'forest', 'plum', 'graphite']);
  assert.deepEqual(tourOrder('nope'), tourOrder(FREE_SWATCH));
});

test('the card: one toggle button per palette, marked Free or Plus, each with its colours', async () => {
  const page = await read('welcome/index.html');
  const css = await read('welcome/landing.css');
  const card = page.slice(page.indexOf('data-palette-card'), page.indexOf('</article>', page.indexOf('data-palette-card')));
  const buttons = [...card.matchAll(/<button class="pal-sw pal-sw--([a-z]+)" type="button" data-swatch="([a-z]+)" aria-pressed="(true|false)">([\s\S]*?)<\/button>/g)];
  assert.deepEqual(buttons.map(match => match[2]), SWATCHES.map(swatch => swatch.id));
  buttons.forEach(([, cls, id, pressed, inner]) => {
    const swatch = swatchById(id);
    assert.equal(cls, id);
    assert.equal(pressed, String(swatch.free), `${id}: only the free palette starts pressed`);
    assert.match(inner, new RegExp(`>${swatch.name}<`), `${id}: visible name`);
    assert.match(inner, swatch.free ? />Free</ : />Plus</, `${id}: Free or Plus`);
    assert.ok(css.includes(`.plus-card--paint[data-palette="${id}"]`), `${id}: the painted year can take its colours`);
    assert.ok(css.includes(`.pal-sw--${id}`), `${id}: its swatch has its colours`);
  });
  assert.match(card, /role="group" aria-label="[^"]+"/, 'the swatches are a labelled group');
  assert.match(card, /data-palette-preview aria-hidden="true"/, 'the painted year is decoration');
  assert.match(css, /\.motion-ok \.pal-year \.cell \{ transition:/, 'the recolouring only moves when motion is welcome');
});

test('one price, its currency and taxes, in the visitor’s currency', () => {
  assert.equal(taxLine('EUR'), 'In euros, taxes included');
  assert.equal(taxLine('USD'), 'In US dollars, taxes included');
  assert.match(currencyLine('USD'), /US dollars/);
});

test('the Plus offer keeps its hooks: price, currency line, buy button, gift prices', async () => {
  const page = await read('welcome/index.html');
  const start = page.indexOf('<div class="plus-buy"');
  const block = page.slice(start, page.indexOf('</section>', start));
  for (const hook of ['data-plus-price', 'data-tax-line', 'data-plus-cta="plus"', 'data-gift-price="gift-1"', 'data-gift-price="family-5"', 'data-min-per-person', 'href="#gifts"', 'href="#teams"']) {
    assert.ok(block.includes(hook), hook);
  }
  assert.equal((block.match(/class="ok"/g) || []).length, 5, 'five ticks: what you get');
});
