import { qs } from '../lib/dom.js';
import { createGoogleDriveProvider, GoogleAuthRequiredError } from '../sync/google-drive.js';
import { createRecoveryStore } from '../sync/recovery-store.js';
import { createSyncEngine } from '../sync/engine.js';
import { createSyncScheduler } from '../sync/scheduler.js';

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

function conflictSummary(count) {
  if (count <= 0) return '';
  if (count === 1) return 'Some days were edited on both devices.';
  return `${count} items were edited on both devices.`;
}

export function createPersonalSyncFeature({
  store,
  ledger,
  googleClientId = '',
  buildBackup,
  flushLocal,
  reloadFromStorage,
  now = () => new Date(),
  idleMs = 50_000,
  maxWaitMs = 120_000,
  addEventListener = (target, type, handler, options) => target?.addEventListener?.(type, handler, options),
  documentRef = typeof document !== 'undefined' ? document : null,
  windowRef = typeof window !== 'undefined' ? window : null,
  providerFactory = createGoogleDriveProvider
} = {}) {
  const root = qs('[data-personal-sync]');
  const status = qs('[data-personal-sync-status]');
  const detail = qs('[data-personal-sync-detail]');
  const primary = qs('[data-personal-sync-primary]');
  const disconnect = qs('[data-personal-sync-disconnect]');
  const recovery = qs('[data-personal-sync-recovery]');
  const conflictActions = qs('[data-personal-sync-conflict-actions]');
  const conflictCopy = qs('[data-personal-sync-conflict-copy]');
  const keepLocal = qs('[data-personal-sync-keep-local]');
  const useRemote = qs('[data-personal-sync-use-remote]');
  const provider = providerFactory({ clientId: googleClientId });
  const recoveryStore = createRecoveryStore({ now });
  const engine = createSyncEngine({ store, ledger, recoveryStore, now });
  let busy = false;
  let conflictCount = 0;
  let lastErrorMessage = '';
  let needsReconnect = false;

  if (!root) {
    return {
      load() {},
      syncNow() {},
      noteLocalChange() {},
      render() {},
      destroy() {}
    };
  }
  root.hidden = !provider.configured;

  function providerState() { return ledger.provider(); }
  function isConnected() { return !!providerState().connected; }

  const scheduler = createSyncScheduler({
    idleMs,
    maxWaitMs,
    isEnabled: () => provider.configured && isConnected(),
    isBusy: () => busy,
    hasDirty: () => ledger.hasDirty(),
    sync: options => runSync({ ...options, interactive: false }),
    now: () => now().getTime()
  });

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
    const dirty = connected && ledger.hasDirty();
    const reconnect = connected && (needsReconnect || !provider.hasUsableToken());
    root.dataset.syncState = !connected
      ? 'disconnected'
      : busy
        ? 'syncing'
        : conflictCount
          ? 'attention'
          : reconnect
            ? 'reconnect'
            : dirty
              ? 'pending'
              : 'synced';

    if (primary) {
      primary.disabled = busy;
      if (!connected) primary.textContent = 'Connect Google Drive';
      else if (busy) primary.textContent = 'Syncing…';
      else if (reconnect) primary.textContent = 'Reconnect Google Drive';
      else primary.textContent = 'Sync now';
      primary.classList.toggle('primary-button', connected);
      primary.classList.toggle('secondary-button', !connected);
    }
    if (disconnect) disconnect.hidden = !connected || busy;

    if (status) {
      if (!connected) status.textContent = 'Not connected';
      else if (busy) status.textContent = 'Syncing…';
      else if (conflictCount) status.textContent = 'Sync needs attention';
      else if (reconnect) status.textContent = 'Reconnect to continue syncing';
      else if (dirty) status.textContent = 'Changes waiting to sync';
      else status.textContent = 'Synced';
    }

    if (detail) {
      if (busy) detail.textContent = 'Updating Google Drive in the background…';
      else if (conflictCount) detail.textContent = conflictSummary(conflictCount);
      else if (!connected) detail.textContent = 'Your planner stays local until you choose to connect it.';
      else if (reconnect) {
        detail.textContent = dirty
          ? 'Local changes are saved on this device. Reconnect when you are ready to sync.'
          : 'Authorization expired. Reconnect to check Google Drive again.';
      } else if (dirty) detail.textContent = `${relativeSyncLabel(state.lastSyncedAt, now())}. Changes will sync after a short pause.`;
      else if (lastErrorMessage && state.lastError && state.lastError !== 'conflict' && state.lastError !== 'auth-required') {
        detail.textContent = `${relativeSyncLabel(state.lastSyncedAt, now())}. Last sync could not finish; local editing continues.`;
      } else detail.textContent = relativeSyncLabel(state.lastSyncedAt, now());
    }

    if (conflictCopy) {
      conflictCopy.textContent = conflictCount
        ? `Review ${conflictCount} ${conflictCount === 1 ? 'conflict' : 'conflicts'}`
        : '';
    }
    if (conflictActions) conflictActions.hidden = !conflictCount || busy || reconnect;
    renderRecovery();
  }

  async function runEngineSync(conflictResolution = null) {
    return engine.sync(provider, {
      buildBackup,
      conflictResolution,
      afterApply: async ({ pulled }) => {
        if (pulled.length) await reloadFromStorage?.();
      }
    });
  }

  async function runSync({ interactive = false, conflictResolution = null, reason = 'manual' } = {}) {
    if (!provider.configured || busy) return null;
    // Only explicit UI gestures pass interactive:true. Scheduler events always pass false.
    const automatic = !interactive;
    const force = interactive || conflictResolution || reason === 'startup' || reason === 'visible'
      || reason === 'focus' || reason === 'online' || reason === 'manual' || reason === 'close-day'
      || reason === 'hidden' || reason === 'reconnect' || reason === 'connect';
    if (!force && !ledger.hasDirty()) return null;

    // Automatic paths never escalate into Google OAuth UI.
    if (automatic && !provider.hasUsableToken()) {
      needsReconnect = true;
      ledger.saveProvider({ lastError: 'auth-required' });
      render();
      return null;
    }

    busy = true;
    conflictCount = 0;
    lastErrorMessage = '';
    render();
    try {
      await flushLocal?.();

      if (!automatic) {
        // Connect / Reconnect only — Sync now with a usable token skips GIS entirely.
        if (!provider.hasUsableToken() || reason === 'reconnect' || reason === 'connect') {
          await provider.authorizeInteractive();
        }
        needsReconnect = false;
      }

      const result = await runEngineSync(conflictResolution);
      if (result.status === 'conflict') {
        conflictCount = result.conflicts.length;
        ledger.saveProvider({ connected: true, lastError: 'conflict' });
      } else {
        ledger.saveProvider({ connected: true, lastSyncedAt: now().toISOString(), lastError: '' });
        if (!ledger.hasDirty()) scheduler.markClean();
      }
      needsReconnect = false;
      return result;
    } catch (error) {
      const authRequired = error instanceof GoogleAuthRequiredError || error?.code === 'auth-required';
      lastErrorMessage = String(error?.message || error || '');
      if (authRequired) {
        needsReconnect = true;
        ledger.saveProvider({ lastError: 'auth-required' });
      } else {
        ledger.saveProvider({ lastError: lastErrorMessage });
      }
      if (!automatic && detail && !authRequired) detail.textContent = error?.message || 'Sync could not be completed.';
      return null;
    } finally {
      busy = false;
      render();
    }
  }

  function noteLocalChange() {
    if (!provider.configured || !isConnected()) return;
    scheduler.noteLocalChange();
    render();
  }

  primary?.addEventListener('click', async () => {
    const state = providerState();
    if (!state.connected) {
      ledger.saveProvider({ connected: true });
      await runSync({ interactive: true, reason: 'connect' });
      return;
    }
    if (needsReconnect || !provider.hasUsableToken()) {
      await runSync({ interactive: true, reason: 'reconnect' });
      return;
    }
    // Sync now with a usable token never opens OAuth.
    await runSync({ interactive: true, reason: 'manual' });
  });

  disconnect?.addEventListener('click', () => {
    provider.clearToken();
    ledger.saveProvider({ connected: false, lastError: '' });
    conflictCount = 0;
    lastErrorMessage = '';
    needsReconnect = false;
    scheduler.clearTimers();
    scheduler.markClean();
    render();
  });

  keepLocal?.addEventListener('click', () => runSync({ interactive: true, conflictResolution: 'local', reason: 'manual' }));
  useRemote?.addEventListener('click', () => runSync({ interactive: true, conflictResolution: 'remote', reason: 'manual' }));

  const onVisibility = () => {
    if (!provider.configured || !isConnected()) return;
    if (documentRef?.hidden) scheduler.attempt('hidden');
    else scheduler.attempt('visible');
  };
  const onFocus = () => {
    if (!provider.configured || !isConnected()) return;
    scheduler.attempt('focus');
  };
  const onOnline = () => {
    if (!provider.configured || !isConnected()) return;
    scheduler.attempt('online');
  };

  if (documentRef) addEventListener(documentRef, 'visibilitychange', onVisibility);
  if (windowRef) {
    addEventListener(windowRef, 'focus', onFocus);
    addEventListener(windowRef, 'online', onOnline);
  }

  async function load() {
    if (!provider.configured) return;
    render();
    if (!providerState().connected) return;
    // Startup may sync only when a usable in-memory token already exists.
    // It must never call Google OAuth automatically.
    await runSync({ interactive: false, reason: 'startup' });
  }

  function destroy() {
    scheduler.clearTimers();
  }

  return {
    load,
    syncNow: runSync,
    noteLocalChange,
    render,
    destroy,
    scheduler,
    get needsReconnect() { return needsReconnect; },
    get provider() { return provider; }
  };
}

export { relativeSyncLabel, conflictSummary };
