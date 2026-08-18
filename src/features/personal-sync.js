import { qs } from '../lib/dom.js';
import { createGoogleDriveProvider } from '../sync/google-drive.js';
import { createRecoveryStore } from '../sync/recovery-store.js';
import { createSyncEngine } from '../sync/engine.js';

function relativeSyncLabel(iso, now = new Date()) {
  if (!iso) return 'Not synced yet';
  const then = new Date(iso);
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 10) return 'Last synced just now';
  if (seconds < 60) return `Last synced ${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `Last synced ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Last synced ${hours}h ago`;
  return `Last synced ${then.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

export function createPersonalSyncFeature({
  store,
  ledger,
  googleClientId = '',
  buildBackup,
  flushLocal,
  reloadFromStorage,
  now = () => new Date()
} = {}) {
  const root = qs('[data-personal-sync]');
  const status = qs('[data-personal-sync-status]');
  const detail = qs('[data-personal-sync-detail]');
  const primary = qs('[data-personal-sync-primary]');
  const disconnect = qs('[data-personal-sync-disconnect]');
  const recovery = qs('[data-personal-sync-recovery]');
  const conflictActions = qs('[data-personal-sync-conflict-actions]');
  const keepLocal = qs('[data-personal-sync-keep-local]');
  const useRemote = qs('[data-personal-sync-use-remote]');
  const provider = createGoogleDriveProvider({ clientId: googleClientId });
  const recoveryStore = createRecoveryStore({ now });
  const engine = createSyncEngine({ store, ledger, recoveryStore, now });
  let busy = false;
  let conflictCount = 0;

  if (!root) return { load() {}, syncNow() {} };
  root.hidden = !provider.configured;

  function providerState() { return ledger.provider(); }

  async function renderRecovery() {
    if (!recovery) return;
    try {
      const [count, latest] = await Promise.all([recoveryStore.count(), recoveryStore.latest()]);
      if (!count || !latest) {
        recovery.textContent = 'Recovery snapshots are created on this device before remote changes are applied.';
        return;
      }
      const when = new Date(latest.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      recovery.textContent = `${count} local recovery ${count === 1 ? 'snapshot' : 'snapshots'} kept · latest ${when}`;
    } catch {
      recovery.textContent = 'Local recovery snapshots are unavailable in this browser context.';
    }
  }

  function render() {
    if (!provider.configured) return;
    const state = providerState();
    const connected = !!state.connected;
    if (primary) {
      primary.disabled = busy;
      primary.textContent = connected ? (busy ? 'Syncing…' : 'Sync now') : 'Connect Google Drive';
    }
    if (disconnect) disconnect.hidden = !connected || busy;
    if (status) status.textContent = connected ? (conflictCount ? 'Sync needs attention' : 'Google Drive connected') : 'Not connected';
    if (detail) {
      if (busy) detail.textContent = 'Comparing this device with your Google Drive sync state…';
      else if (conflictCount) detail.textContent = `${conflictCount} ${conflictCount === 1 ? 'record changed' : 'records changed'} on both devices. Choose which side to keep.`;
      else detail.textContent = connected ? relativeSyncLabel(state.lastSyncedAt, now()) : 'Your planner stays local until you choose to connect it.';
    }
    if (conflictActions) conflictActions.hidden = !conflictCount || busy;
    renderRecovery();
  }

  async function runSync({ interactive = true, conflictResolution = null } = {}) {
    if (!provider.configured || busy) return null;
    busy = true;
    conflictCount = 0;
    render();
    try {
      await flushLocal?.();
      await provider.authorize({ interactive });
      const result = await engine.sync(provider, {
        buildBackup,
        conflictResolution,
        afterApply: async ({ pulled }) => {
          if (pulled.length) await reloadFromStorage?.();
        }
      });
      if (result.status === 'conflict') {
        conflictCount = result.conflicts.length;
        ledger.saveProvider({ connected: true, lastError: 'conflict' });
      } else {
        ledger.saveProvider({ connected: true, lastSyncedAt: now().toISOString(), lastError: '' });
      }
      return result;
    } catch (error) {
      ledger.saveProvider({ lastError: String(error?.message || error || '') });
      if (interactive && detail) detail.textContent = error?.message || 'Sync could not be completed.';
      return null;
    } finally {
      busy = false;
      render();
    }
  }

  primary?.addEventListener('click', async () => {
    const state = providerState();
    if (!state.connected) ledger.saveProvider({ connected: true });
    await runSync({ interactive: true });
  });

  disconnect?.addEventListener('click', () => {
    provider.clearToken();
    ledger.saveProvider({ connected: false, lastError: '' });
    conflictCount = 0;
    render();
  });

  keepLocal?.addEventListener('click', () => runSync({ interactive: true, conflictResolution: 'local' }));
  useRemote?.addEventListener('click', () => runSync({ interactive: true, conflictResolution: 'remote' }));

  async function load() {
    if (!provider.configured) return;
    render();
    if (!providerState().connected) return;
    // Silent startup sync never opens a consent or account chooser. If Google
    // cannot issue a token without UI, the planner remains local and Sync now
    // is available for an explicit user gesture.
    await runSync({ interactive: false });
  }

  return { load, syncNow: runSync, render };
}

export { relativeSyncLabel };
