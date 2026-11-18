import { useSyncExternalStore } from 'react';
import { getAppLockState, subscribeAppLock, type AppLockState } from '../lib/appLock';

/**
 * Phase 7: the current App Lock state ('unconfigured' | 'locked' |
 * 'unlocked'). With no lock configured this is always 'unconfigured', and
 * every consumer renders exactly what it did before the feature existed.
 */
export function useAppLockState(): AppLockState {
  return useSyncExternalStore(subscribeAppLock, getAppLockState, getAppLockState);
}
