function hashOf(record) {
  return record?.hash || null;
}

export function decideRecordSync({ localRecord, remoteRecord, lastSyncedHash }) {
  const localHash = hashOf(localRecord);
  const remoteHash = hashOf(remoteRecord);
  const base = lastSyncedHash || null;

  if (!localRecord && !remoteRecord) return { action: 'none' };

  if (!base) {
    if (localRecord && !remoteRecord) return { action: 'push-local' };
    if (!localRecord && remoteRecord) return { action: 'pull-remote' };
    if (localHash === remoteHash) return { action: 'mark-synced' };
    return { action: 'conflict' };
  }

  const localChanged = localHash !== base;
  const remoteChanged = remoteHash !== base;

  if (!localChanged && !remoteChanged) return { action: 'none' };
  if (localChanged && !remoteChanged) return { action: 'push-local' };
  if (!localChanged && remoteChanged) return { action: 'pull-remote' };
  if (localHash === remoteHash) return { action: 'mark-synced' };
  return { action: 'conflict' };
}
