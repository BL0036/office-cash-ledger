// Google Drive backup: local-only storage for the OAuth Client ID,
// connection state, cached access token, and the app-created folder/file
// IDs on Drive.
//
// DELIBERATELY NOT a Dexie table — same reasoning and same isolation
// pattern as lib/aiSettingsStore.ts (read that file first if you haven't
// — this one is a sibling, not a modification of it). Every other piece
// of app data lives in Dexie precisely so it CAN be synced (lib/sync.ts's
// SYNC_TABLES) and backed up (lib/backup.ts's BackupPayload/
// exportBackup()) — those two files work by iterating Dexie tables.
// Neither file references `localStorage` anywhere in this codebase, so
// there is no code path by which anything stored here could reach a
// backup file or Firestore, not even by a future accidental omission the
// way a forgotten Dexie table could. Verified directly (not assumed) in
// scripts/test-drive-backup.ts, the same rigor Phase 6 used for the
// Gemini key.
//
// Same-device-and-browser-profile only, by construction — nothing here
// does anything extra to enforce that, it's simply what storing this in
// localStorage (rather than Dexie) means in practice. This also means
// the access token cached here is NOT a refresh token — Google's current
// Identity Services token model deliberately issues browser-side apps an
// access token ONLY (no refresh token; those only ever go to a backend
// via the OAuth "code" flow, which this app has no backend to use). See
// lib/googleDriveBackup.ts's own header comment for the full research
// this is based on.

const STORAGE_KEY = 'officeCashLedger.googleDriveBackup.v1';

export interface GoogleDriveBackupSettings {
  /** The owner's own Google Cloud OAuth Client ID for a Public/SPA client — NOT a secret (see googleDriveBackup.ts), just not worth syncing since it's device-specific setup, same treatment as the Gemini key for consistency. */
  clientId: string | null;
  /** True once the owner has completed the OAuth consent flow at least once for this clientId. Independent of whether the cached access token below is still valid right now — that's checked separately at call time. */
  connected: boolean;
  /** Cached OAuth access token from the most recent successful requestAccessToken() call. Short-lived (~1 hour, per Google) — always check accessTokenExpiresAt before using it. */
  accessToken: string | null;
  /** Epoch ms. null if no token has ever been obtained. */
  accessTokenExpiresAt: number | null;
  /** The app-created "Office Cash Ledger Backups" folder's Drive file ID, cached after first use so later backups don't need to search for it again. */
  folderId: string | null;
  /** The app-created "office-cash-ledger-backup.json" file's Drive file ID inside that folder — the ONE continuously-updated backup file (constraint #8: never a new dated file per backup). */
  fileId: string | null;
  /** Epoch ms of the last successful backup, or null if none yet. */
  lastBackupAt: number | null;
  /** Human-readable reason for the most recent failure, or null if the last attempt (if any) succeeded. Cleared on the next successful attempt. */
  lastError: string | null;
}

const DEFAULT_SETTINGS: GoogleDriveBackupSettings = {
  clientId: null,
  connected: false,
  accessToken: null,
  accessTokenExpiresAt: null,
  folderId: null,
  fileId: null,
  lastBackupAt: null,
  lastError: null,
};

/**
 * Reads the current settings. Wrapped in try/catch — localStorage can
 * throw in some private/incognito browser modes, and a storage-layer
 * hiccup here must never be capable of breaking the rest of Settings or
 * normal app use (the same "degrade gracefully, every time" standard
 * Phase 6 set applies to this local storage layer too, not just the
 * network calls).
 */
export function getGoogleDriveBackupSettings(): GoogleDriveBackupSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<GoogleDriveBackupSettings>;
    return {
      clientId: typeof parsed.clientId === 'string' && parsed.clientId.trim() !== '' ? parsed.clientId : null,
      connected: parsed.connected === true,
      accessToken: typeof parsed.accessToken === 'string' && parsed.accessToken !== '' ? parsed.accessToken : null,
      accessTokenExpiresAt: typeof parsed.accessTokenExpiresAt === 'number' ? parsed.accessTokenExpiresAt : null,
      folderId: typeof parsed.folderId === 'string' && parsed.folderId !== '' ? parsed.folderId : null,
      fileId: typeof parsed.fileId === 'string' && parsed.fileId !== '' ? parsed.fileId : null,
      lastBackupAt: typeof parsed.lastBackupAt === 'number' ? parsed.lastBackupAt : null,
      lastError: typeof parsed.lastError === 'string' && parsed.lastError !== '' ? parsed.lastError : null,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** Returns false (rather than throwing) if the localStorage write fails, so callers can show a calm message instead of crashing. */
export function setGoogleDriveBackupSettings(settings: GoogleDriveBackupSettings): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

/** Convenience partial-update helper — reads current settings, applies `patch`, writes back. Same fail-quietly-return-false contract as setGoogleDriveBackupSettings(). */
export function patchGoogleDriveBackupSettings(patch: Partial<GoogleDriveBackupSettings>): boolean {
  const current = getGoogleDriveBackupSettings();
  return setGoogleDriveBackupSettings({ ...current, ...patch });
}

/** True only once the owner has both entered a Client ID and completed OAuth consent at least once — the single gate every call site should check before showing Drive-related UI or attempting any Drive network call. Does NOT check token freshness — see lib/googleDriveBackup.ts's ensureFreshAccessToken() for that. */
export function isGoogleDriveConnected(): boolean {
  const s = getGoogleDriveBackupSettings();
  return s.connected && !!s.clientId;
}
