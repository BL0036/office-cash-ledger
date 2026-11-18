import { db } from '../db/schema';
import type { SyncConfig } from '../types';

// The `syncConfig` table (Dexie schema version 9) always holds either zero
// or exactly one row, at this fixed id — there's only ever one sync
// configuration per device/install (Phase 10b Non-Goals: no multiple sync
// codes per install). This file is the ONLY place that reads/writes that
// table, so every other module (sync.ts, firebaseClient.ts, SettingsView)
// goes through these functions rather than touching db.syncConfig
// directly.
const SYNC_CONFIG_ROW_ID: SyncConfig['id'] = 'singleton';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I — easy to read/type on another device
const CODE_LENGTH = 8;

/** Generates a new random 8-character alphanumeric sync code (not persisted — call configureSyncCode to save it). */
export function generateSyncCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return code;
}

/** The current sync config, or null if sync has never been configured on this device. */
export async function getSyncConfig(): Promise<SyncConfig | null> {
  return (await db.syncConfig.get(SYNC_CONFIG_ROW_ID)) ?? null;
}

/**
 * Save a sync code (either a freshly-generated one or one typed in to join
 * an existing group), starting with lastSyncedAt: null so the very next
 * Sync Now treats every local row as unsynced and pulls the group's full
 * existing data (Part C/D "first sync" behavior).
 */
export async function configureSyncCode(syncCode: string): Promise<void> {
  const trimmed = syncCode.trim().toUpperCase();
  if (!trimmed) throw new Error('Enter a sync code.');
  await db.syncConfig.put({ id: SYNC_CONFIG_ROW_ID, syncCode: trimmed, lastSyncedAt: null });
}

/** Removes sync configuration entirely (Non-Goals: this is the one supported way to change sync codes — clear, then configure a new one as if fresh). Does not touch Firestore or any local entity data. */
export async function clearSyncConfig(): Promise<void> {
  await db.syncConfig.delete(SYNC_CONFIG_ROW_ID);
}

/** Only updated after a fully successful push+pull (Part D) — never partially. */
export async function updateLastSyncedAt(timestamp: number): Promise<void> {
  const existing = await getSyncConfig();
  if (!existing) throw new Error('No sync code configured.');
  await db.syncConfig.put({ ...existing, lastSyncedAt: timestamp });
}
