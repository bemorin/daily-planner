import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_PAINT,
  PAINT_PALETTES,
  PAINT_STORAGE_KEY,
  applyPaint,
  choosePaint,
  isPremiumPaint,
  normalizePaint,
  readPaint,
  renderPaintChooser,
  resolvePaint,
  syncPaint,
  writePaint
} from '../src/features/paint-palettes.js';

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key),
    has: key => map.has(key)
  };
}

const fakeDoc = () => ({ documentElement: { dataset: {} } });

test('the palette list matches the contract: terracotta first and free, five more', () => {
  assert.deepEqual(PAINT_PALETTES.map(palette => palette.id), ['terracotta', 'ocean', 'forest', 'plum', 'graphite', 'sunset']);
  assert.equal(DEFAULT_PAINT, 'terracotta');
  assert.equal(PAINT_STORAGE_KEY, 'daily-planner-ui:paint');
  assert.equal(isPremiumPaint('terracotta'), false);
  assert.equal(isPremiumPaint('ocean'), true);
  assert.equal(isPremiumPaint('nonsense'), false, 'an unknown value falls back to the free default');
});

test('unknown or missing values normalise to the default', () => {
  assert.equal(normalizePaint('plum'), 'plum');
  assert.equal(normalizePaint('Plum'), DEFAULT_PAINT);
  assert.equal(normalizePaint(null), DEFAULT_PAINT);
  assert.equal(normalizePaint(undefined), DEFAULT_PAINT);
});

test('a stored palette only counts while Plus is active', () => {
  assert.equal(resolvePaint('sunset', true), 'sunset');
  assert.equal(resolvePaint('sunset', false), DEFAULT_PAINT);
  assert.equal(resolvePaint('bogus', true), DEFAULT_PAINT);
  assert.equal(resolvePaint(DEFAULT_PAINT, false), DEFAULT_PAINT);
});

test('storage: the default removes the key, a palette is stored, failures fall back', () => {
  const storage = memoryStorage();
  assert.equal(writePaint('forest', storage), 'forest');
  assert.equal(storage.getItem(PAINT_STORAGE_KEY), 'forest');
  assert.equal(readPaint(storage), 'forest');
  writePaint(DEFAULT_PAINT, storage);
  assert.equal(storage.has(PAINT_STORAGE_KEY), false);
  assert.equal(readPaint(memoryStorage({ [PAINT_STORAGE_KEY]: 'neon' })), DEFAULT_PAINT);
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  assert.equal(readPaint(broken), DEFAULT_PAINT);
  assert.equal(writePaint('ocean', broken), 'ocean', 'a blocked storage never throws');
});

test('applying a palette sets or clears html[data-paint]', () => {
  const doc = fakeDoc();
  assert.equal(applyPaint('ocean', doc), 'ocean');
  assert.equal(doc.documentElement.dataset.paint, 'ocean');
  applyPaint(DEFAULT_PAINT, doc);
  assert.equal('paint' in doc.documentElement.dataset, false);
  assert.equal(applyPaint('ocean', {}), DEFAULT_PAINT, 'no document: nothing to paint');
});

test('without Plus the stored palette is ignored but kept, and comes back with Plus', () => {
  const storage = memoryStorage({ [PAINT_STORAGE_KEY]: 'plum' });
  const doc = fakeDoc();
  assert.equal(syncPaint(false, { storage, doc }), DEFAULT_PAINT);
  assert.equal('paint' in doc.documentElement.dataset, false);
  assert.equal(storage.getItem(PAINT_STORAGE_KEY), 'plum', 'the choice is not wiped');
  assert.equal(syncPaint(true, { storage, doc }), 'plum');
  assert.equal(doc.documentElement.dataset.paint, 'plum');
});

test('choosing: premium palettes need Plus, the default is always free', () => {
  const storage = memoryStorage();
  const doc = fakeDoc();
  assert.equal(choosePaint('graphite', false, { storage, doc }), null);
  assert.equal(storage.has(PAINT_STORAGE_KEY), false);
  assert.equal('paint' in doc.documentElement.dataset, false);
  assert.equal(choosePaint('graphite', true, { storage, doc }), 'graphite');
  assert.equal(storage.getItem(PAINT_STORAGE_KEY), 'graphite');
  assert.equal(choosePaint(DEFAULT_PAINT, false, { storage, doc }), DEFAULT_PAINT);
  assert.equal(storage.has(PAINT_STORAGE_KEY), false);
  assert.equal('paint' in doc.documentElement.dataset, false);
});

test('the chooser shows every palette, marks the current one and locks the rest without Plus', () => {
  const locked = renderPaintChooser({ current: 'ocean', plusActive: false });
  PAINT_PALETTES.forEach(palette => assert.match(locked, new RegExp(`data-paint-choice="${palette.id}"`)));
  assert.equal((locked.match(/is-locked/g) || []).length, 5);
  assert.match(locked, /data-paint-choice="terracotta" aria-pressed="true"/, 'a stored premium palette shows as not applied');
  assert.match(locked, /Plus/);
  const open = renderPaintChooser({ current: 'ocean', plusActive: true });
  assert.equal((open.match(/is-locked/g) || []).length, 0);
  assert.match(open, /data-paint-choice="ocean" aria-pressed="true"/);
});

test('every premium palette has light rules, both dark rules and a swatch class in styles/year.css', () => {
  const css = readFileSync(new URL('../styles/year.css', import.meta.url), 'utf8');
  PAINT_PALETTES.filter(palette => palette.id !== DEFAULT_PAINT).forEach(({ id }) => {
    assert.ok(css.includes(`html[data-paint="${id}"]`), `${id}: light rule`);
    assert.ok(css.includes(`.hz-palette--${id}`), `${id}: swatch class`);
    assert.ok(css.includes(`:root:not([data-theme="light"])[data-paint="${id}"]`), `${id}: system dark rule`);
    assert.ok(css.includes(`:root[data-theme="dark"][data-paint="${id}"]`), `${id}: explicit dark rule`);
  });
  assert.ok(css.includes('.hz-palette--terracotta'), 'the default swatch resets to terracotta');
  assert.equal((css.match(/!important/g) || []).length, 0);
});
