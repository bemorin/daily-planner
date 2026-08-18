import { plannerKeyToRecordId } from './records.js';

const LEDGER_KEY = 'daily-planner-sync:ledger';
const PROVIDER_KEY = 'daily-planner-sync:google';
const VERSION = 1;

function safeParse(raw, fallback) {
  try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
}

function nowIso(now = () => new Date()) {
  return now().toISOString();
}

export function createSyncLedger(storage = localStorage, { now = () => new Date() } = {}) {
  const read = () => {
    const parsed = safeParse(storage.getItem(LEDGER_KEY), null);
    if (!parsed || parsed.version !== VERSION || typeof parsed.records !== 'object') return { version: VERSION, records: {} };
    return parsed;
  };

  const write = ledger => storage.setItem(LEDGER_KEY, JSON.stringify(ledger));

  const recordMutation = mutation => {
    const recordId = plannerKeyToRecordId(mutation?.key);
    if (!recordId) return;
    const ledger = read();
    const previous = ledger.records[recordId] || {};
    ledger.records[recordId] = {
      ...previous,
      dirtyAt: nowIso(now),
      deletedAt: mutation.type === 'remove' ? nowIso(now) : null
    };
    write(ledger);
  };

  const entry = recordId => read().records[recordId] || null;

  const markSynced = (recordId, { hash, deletedAt = null } = {}) => {
    const ledger = read();
    ledger.records[recordId] = {
      ...(ledger.records[recordId] || {}),
      lastSyncedHash: hash || null,
      dirtyAt: null,
      deletedAt: deletedAt || null,
      syncedAt: nowIso(now)
    };
    write(ledger);
  };

  const markRemoteApplied = (recordId, { hash, deletedAt = null } = {}) => markSynced(recordId, { hash, deletedAt });

  const forgetRecord = recordId => {
    const ledger = read();
    delete ledger.records[recordId];
    write(ledger);
  };

  const provider = () => safeParse(storage.getItem(PROVIDER_KEY), { connected: false, fileId: '', lastSyncedAt: '', lastError: '' });
  const saveProvider = patch => {
    const next = { ...provider(), ...patch };
    storage.setItem(PROVIDER_KEY, JSON.stringify(next));
    return next;
  };

  const reset = () => {
    storage.removeItem(LEDGER_KEY);
    storage.removeItem(PROVIDER_KEY);
  };

  return { entry, read, recordMutation, markSynced, markRemoteApplied, forgetRecord, provider, saveProvider, reset };
}
