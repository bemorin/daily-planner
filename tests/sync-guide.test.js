import test from 'node:test';
import assert from 'node:assert/strict';
import { readWaitlistJoined } from '../src/features/sync-guide.js';

const storageWith = value => ({ getItem: () => value });

test('a sign-up keeps the address and the removal token so it can be left later', () => {
  const entry = readWaitlistJoined(storageWith(JSON.stringify({ at: '2026-10-09T10:00:00.000Z', email: 'someone@example.com', token: 'abc123' })));
  assert.deepEqual(entry, { at: '2026-10-09T10:00:00.000Z', email: 'someone@example.com', token: 'abc123' });
});

test('an older sign-up stored as a plain date still counts as joined, without a way to leave from here', () => {
  assert.deepEqual(readWaitlistJoined(storageWith('2026-09-01T08:00:00.000Z')), { at: '2026-09-01T08:00:00.000Z', email: '', token: '' });
});

test('nothing stored, or storage that cannot be read, means not joined', () => {
  assert.equal(readWaitlistJoined(storageWith(null)), null);
  assert.equal(readWaitlistJoined({ getItem() { throw new Error('denied'); } }), null);
  assert.deepEqual(readWaitlistJoined(storageWith('{broken')), { at: '{broken', email: '', token: '' }, 'still joined');
});
