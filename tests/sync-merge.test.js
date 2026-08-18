import test from 'node:test';
import assert from 'node:assert/strict';
import { decideRecordSync } from '../src/sync/merge.js';

test('first sync pushes local-only records and pulls remote-only records', () => {
  assert.equal(decideRecordSync({ localRecord: { hash: 'local' }, remoteRecord: null, lastSyncedHash: null }).action, 'push-local');
  assert.equal(decideRecordSync({ localRecord: null, remoteRecord: { hash: 'remote' }, lastSyncedHash: null }).action, 'pull-remote');
});

test('sync follows the side that changed since the last shared hash', () => {
  assert.equal(decideRecordSync({ localRecord: { hash: 'new' }, remoteRecord: { hash: 'base' }, lastSyncedHash: 'base' }).action, 'push-local');
  assert.equal(decideRecordSync({ localRecord: { hash: 'base' }, remoteRecord: { hash: 'new' }, lastSyncedHash: 'base' }).action, 'pull-remote');
});

test('sync refuses to silently overwrite concurrent changes', () => {
  assert.equal(decideRecordSync({ localRecord: { hash: 'local' }, remoteRecord: { hash: 'remote' }, lastSyncedHash: 'base' }).action, 'conflict');
});

test('identical concurrent changes can be marked synced', () => {
  assert.equal(decideRecordSync({ localRecord: { hash: 'same' }, remoteRecord: { hash: 'same' }, lastSyncedHash: 'base' }).action, 'mark-synced');
});
