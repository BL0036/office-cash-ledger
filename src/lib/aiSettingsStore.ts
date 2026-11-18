// Phase 6: local-only storage for the optional Gemini API fallback's
// enabled flag + API key.
//
// DELIBERATELY NOT a Dexie table. Every other piece of app data lives in
// Dexie precisely so it CAN be synced (lib/sync.ts's SYNC_TABLES) and
// backed up (lib/backup.ts's BackupPayload/exportBackup()) — those two
// files work by iterating Dexie tables. Per this phase's non-negotiable
// constraint #5 ("must NOT be added to SYNC_TABLES... must NOT appear
// anywhere in BackupPayload/exportBackup()... structurally impossible for
// it to end up in an exported backup file or in Firestore"), the
// strongest guarantee available isn't "a Dexie table we remember to
// exclude from two allowlists" — it's storing the key somewhere
// exportBackup() and syncNow() have literally never heard of and never
// import. localStorage is exactly that: neither lib/backup.ts nor
// lib/sync.ts references `localStorage` anywhere in this codebase, so
// there is no code path by which a key stored here could reach a backup
// file or Firestore, not even by a future accidental omission the way a
// forgotten Dexie table could.
//
// Same-device only, by construction: localStorage is already scoped to
// one browser profile on one device — nothing here does anything extra
// to enforce that, it's simply what NOT syncing/backing this up means in
// practice.

const STORAGE_KEY = 'officeCashLedger.aiFallback.v1';

export interface AiFallbackSettings {
  enabled: boolean;
  /** null when no key has ever been entered. Never logged, never included in any export. */
  apiKey: string | null;
}

const DEFAULT_SETTINGS: AiFallbackSettings = { enabled: false, apiKey: null };

/**
 * Reads the current settings. Wrapped in try/catch — localStorage can
 * throw in some private/incognito browser modes, and a storage-layer
 * hiccup here must never be capable of breaking the rest of Settings or
 * Fast Entry (constraint #6's "degrade gracefully, every time" applies
 * to this local storage layer too, not just the network call).
 */
export function getAiFallbackSettings(): AiFallbackSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<AiFallbackSettings>;
    return {
      enabled: parsed.enabled === true,
      apiKey: typeof parsed.apiKey === 'string' && parsed.apiKey.trim() !== '' ? parsed.apiKey : null,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** Returns false (rather than throwing) if localStorage write fails, so callers can show a calm message instead of crashing. */
export function setAiFallbackSettings(settings: AiFallbackSettings): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

/** True only when the owner has both turned this on AND entered a non-empty key — the single gate every call site should check before showing any AI-related UI or making any network call. */
export function isAiFallbackConfigured(): boolean {
  const s = getAiFallbackSettings();
  return s.enabled && !!s.apiKey;
}
