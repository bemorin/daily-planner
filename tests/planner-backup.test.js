import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalStore } from '../src/state/local-store.js';
import { buildPlannerBackup, formatStorageBytes } from '../src/state/planner-backup.js';

class MemoryStorage {
  #data = new Map();
  get length() { return this.#data.size; }
  key(index) { return [...this.#data.keys()][index] ?? null; }
  getItem(key) { return this.#data.has(String(key)) ? this.#data.get(String(key)) : null; }
  setItem(key, value) { this.#data.set(String(key), String(value)); }
  removeItem(key) { this.#data.delete(String(key)); }
}

test('planner backup keeps settings and dated planner records only', () => {
  const store = createLocalStore(new MemoryStorage());
  store.writeJSON('daily-planner:settings', { startHour: 8 });
  store.writeJSON('daily-planner:2026-08-16', { focus: 'Ship' });
  const backup = buildPlannerBackup(store, { exportedAt: '2026-08-16T12:00:00.000Z' });
  assert.equal(backup.exportedAt, '2026-08-16T12:00:00.000Z');
  assert.deepEqual(backup.settings, { startHour: 8 });
  assert.deepEqual(backup.days, { '2026-08-16': { focus: 'Ship' } });
});

test('storage byte labels stay compact', () => {
  assert.equal(formatStorageBytes(800), '800 B');
  assert.equal(formatStorageBytes(2048), '2.0 KB');
  assert.equal(formatStorageBytes(1024 * 1024), '1.0 MB');
});
