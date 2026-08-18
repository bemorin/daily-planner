import { decideRecordSync } from './merge.js';
import { createSyncDocument, localSyncRecords, normalizeSyncDocument } from './document.js';
import { recordIdToPlannerKey } from './records.js';

function allRecordIds(localRecords, remoteRecords, ledger) {
  return [...new Set([
    ...Object.keys(localRecords || {}),
    ...Object.keys(remoteRecords || {}),
    ...Object.keys(ledger.read().records || {})
  ])].sort();
}

export function createSyncEngine({ store, ledger, recoveryStore = null, now = () => new Date() } = {}) {
  if (!store || !ledger) throw new Error('Sync engine requires store and ledger.');

  async function snapshot(reason, buildBackup) {
    if (!recoveryStore || typeof buildBackup !== 'function') return null;
    try { return await recoveryStore.save(buildBackup(), reason); } catch { return null; }
  }

  async function sync(provider, { buildBackup, beforeApply, afterApply, conflictResolution = null } = {}) {
    if (!provider?.read || !provider?.write) throw new Error('Sync provider is not configured.');
    const localRecords = await localSyncRecords(store, ledger);
    const remotePayload = await provider.read();
    const remoteDocument = normalizeSyncDocument(remotePayload?.document);
    const remoteRecords = remoteDocument.records || {};
    const nextRemote = { ...remoteRecords };
    const conflicts = [];
    const pulled = [];
    const pushed = [];
    const marked = [];

    for (const recordId of allRecordIds(localRecords, remoteRecords, ledger)) {
      const localRecord = localRecords[recordId] || null;
      const remoteRecord = remoteRecords[recordId] || null;
      const lastSyncedHash = ledger.entry(recordId)?.lastSyncedHash || null;
      let decision = decideRecordSync({ localRecord, remoteRecord, lastSyncedHash });

      if (decision.action === 'conflict' && conflictResolution === 'local') decision = { action: 'push-local' };
      if (decision.action === 'conflict' && conflictResolution === 'remote') decision = { action: 'pull-remote' };
      if (decision.action === 'conflict') {
        conflicts.push(recordId);
        continue;
      }

      if (decision.action === 'push-local') {
        if (localRecord) nextRemote[recordId] = localRecord;
        else delete nextRemote[recordId];
        pushed.push(recordId);
        continue;
      }

      if (decision.action === 'pull-remote') {
        pulled.push(recordId);
        continue;
      }

      if (decision.action === 'mark-synced') marked.push(recordId);
    }

    if (conflicts.length) {
      await snapshot('sync-conflict', buildBackup);
      return { status: 'conflict', conflicts, pulled: [], pushed: [] };
    }

    if (pulled.length) await snapshot('before-remote-sync', buildBackup);
    if (typeof beforeApply === 'function') await beforeApply({ pulled, pushed });

    if (pulled.length) {
      store.withoutMutationTracking(() => {
        for (const recordId of pulled) {
          const remoteRecord = remoteRecords[recordId];
          const key = recordIdToPlannerKey(recordId);
          if (!key || !remoteRecord) continue;
          if (remoteRecord.deletedAt) store.remove(key);
          else store.writeJSON(key, remoteRecord.value);
        }
      });
    }

    const remoteChanged = pushed.length > 0 || !remotePayload?.exists;
    if (remoteChanged) {
      const nextDocument = createSyncDocument(nextRemote, { now });
      await provider.write(nextDocument, { fileId: remotePayload?.fileId || '' });
    }

    for (const recordId of pulled) {
      const record = remoteRecords[recordId];
      if (record) ledger.markRemoteApplied(recordId, { hash: record.hash, deletedAt: record.deletedAt });
    }
    for (const recordId of pushed) {
      const record = localRecords[recordId];
      if (record) ledger.markSynced(recordId, { hash: record.hash, deletedAt: record.deletedAt });
    }
    for (const recordId of marked) {
      const record = localRecords[recordId] || remoteRecords[recordId];
      if (record) ledger.markSynced(recordId, { hash: record.hash, deletedAt: record.deletedAt });
    }

    if (typeof afterApply === 'function') await afterApply({ pulled, pushed });
    return { status: 'ok', conflicts: [], pulled, pushed };
  }

  return { sync };
}
