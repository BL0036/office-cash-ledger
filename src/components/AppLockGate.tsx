// Phase 7: gates the whole app behind the optional PIN/password lock.
//
// With NO lock configured (the default) this renders `children` untouched
// and adds no UI - the only things it sets up are a passive `storage`
// listener (to notice another tab configuring a lock) and nothing else, so
// the app opens exactly as it did before this feature existed.
//
// When locked, `children` (the whole app) is NOT mounted at all, so no
// screen renders and no ledger read happens until the PIN is entered. This
// is a gate on the UI only: the data layer itself is never touched here.

import { useEffect, type ReactNode } from 'react';
import { useAppLockState } from '../hooks/useAppLock';
import { APP_LOCK_STORAGE_KEY, notifyAppLockStorageChanged, startIdleWatcher } from '../lib/appLock';
import { LockScreen } from './LockScreen';

export function AppLockGate({ children }: { children: ReactNode }) {
  const state = useAppLockState();

  // Another tab turned the lock on/off/changed it: re-evaluate this tab's state.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === null || e.key === APP_LOCK_STORAGE_KEY) notifyAppLockStorageChanged();
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Idle auto-lock: only watches while a lock is configured AND unlocked.
  useEffect(() => {
    if (state !== 'unlocked') return;
    return startIdleWatcher({
      activityTarget: window,
      visibilityTarget: document,
      isHidden: () => document.visibilityState === 'hidden',
    });
  }, [state]);

  if (state === 'locked') return <LockScreen />;
  return <>{children}</>;
}
