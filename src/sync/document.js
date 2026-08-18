import { contentHash } from './hash.js';
import { plannerRecordIds, readPlannerRecord } from './records.js';

export const SYNC_DOCUMENT_VERSION = 1;

export async function localSyncRecords(store, ledger) {
  const ids = new Set(plannerRecordIds(store));
  const ledgerState = ledger.read();
  Object.entries(ledgerState.records || {}).forEach(([recordId, entry]) => {
    if (entry?.deletedAt) ids.add(recordId);
  });

  const records = {};
  for (const recordId of [...ids].sort()) {
    const entry = ledger.entry(recordId) || {};
    if (entry.deletedAt) {
      const payload = { deleted: true, deletedAt: entry.deletedAt };
      records[recordId] = {
        updatedAt: entry.dirtyAt || entry.deletedAt,
        deletedAt: entry.deletedAt,
        hash: await contentHash(payload),
        value: null
      };
      continue;
    }
    const value = readPlannerRecord(store, recordId);
    if (value == null) continue;
    records[recordId] = {
      updatedAt: entry.dirtyAt || new Date(0).toISOString(),
      deletedAt: null,
      hash: await contentHash(value),
      value
    };
  }
  return records;
}

export function createSyncDocument(records = {}, { now = () => new Date() } = {}) {
  return {
    app: 'Daily Planner',
    kind: 'personal-sync',
    version: SYNC_DOCUMENT_VERSION,
    updatedAt: now().toISOString(),
    records
  };
}

export function normalizeSyncDocument(raw) {
  if (!raw || raw.app !== 'Daily Planner' || raw.kind !== 'personal-sync' || raw.version !== SYNC_DOCUMENT_VERSION || typeof raw.records !== 'object') {
    return createSyncDocument({});
  }
  const records = {};
  for (const [recordId, record] of Object.entries(raw.records)) {
    if (!record || typeof record.hash !== 'string') continue;
    records[recordId] = {
      updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
      deletedAt: typeof record.deletedAt === 'string' ? record.deletedAt : null,
      hash: record.hash,
      value: record.deletedAt ? null : record.value
    };
  }
  return { ...raw, records };
}
