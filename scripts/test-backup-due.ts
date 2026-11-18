// Google Drive backup: the 24-hour "backup is due" rule and the honest
// "last successful backup" record.
//
// Covers isBackupDue() / BACKUP_DUE_AFTER_MS and the lastSuccessAt field
// (lib/googleDriveBackup.ts, lib/googleDriveSettingsStore.ts). Same
// headless approach as test-drive-backup.ts: in-memory localStorage, a
// scripted fake `fetch` and a scripted fake Google Identity Services
// library. No real network, no real Google account.
//
// Usage: npx tsx scripts/test-backup-due.ts

import 'fake-indexeddb/auto';
import { seedReferenceData } from '../src/db/schema';
import {
  BACKUP_DUE_AFTER_MS,
  autoBackupTick,
  backupNow,
  getLastBackupStatus,
  isBackupDue,
} from '../src/lib/googleDriveBackup';
import { getGoogleDriveBackupSettings, setGoogleDriveBackupSettings } from '../src/lib/googleDriveSettingsStore';

let passed = 0;
let failed = 0;
function assertEqual(label: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++;
    console.log(`  PASS  ${label} (${JSON.stringify(actual)})`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function assertTrue(label: string, actual: boolean) {
  assertEqual(label, actual, true);
}

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(k: string) { return this.store.has(k) ? this.store.get(k)! : null; }
  setItem(k: string, v: string) { this.store.set(k, v); }
  removeItem(k: string) { this.store.delete(k); }
  clear() { this.store.clear(); }
}
(globalThis as unknown as { localStorage: MemoryStorage }).localStorage = new MemoryStorage();

const BASE = {
  clientId: 'test-client.apps.googleusercontent.com',
  connected: true,
  accessToken: null,
  accessTokenExpiresAt: null,
  folderId: null,
  fileId: null,
  lastBackupAt: null,
  lastSuccessAt: null,
  lastError: null,
};

async function main() {
  await seedReferenceData();
  const now = 1_800_000_000_000;

  console.log('\n[1] 24-hour rule');
  assertEqual('BACKUP_DUE_AFTER_MS is exactly 24 hours', BACKUP_DUE_AFTER_MS, 24 * 60 * 60 * 1000);

  setGoogleDriveBackupSettings({ ...BASE, connected: false, lastSuccessAt: null });
  assertEqual('not connected -> never due', isBackupDue(now), false);

  setGoogleDriveBackupSettings({ ...BASE, lastSuccessAt: null });
  assertEqual('connected, never backed up -> due', isBackupDue(now), true);

  setGoogleDriveBackupSettings({ ...BASE, lastSuccessAt: now - 60 * 60 * 1000 });
  assertEqual('connected, backed up 1 hour ago -> not due', isBackupDue(now), false);

  setGoogleDriveBackupSettings({ ...BASE, lastSuccessAt: now - BACKUP_DUE_AFTER_MS + 1 });
  assertEqual('connected, 1 ms short of 24 hours -> not due', isBackupDue(now), false);

  setGoogleDriveBackupSettings({ ...BASE, lastSuccessAt: now - BACKUP_DUE_AFTER_MS });
  assertEqual('connected, exactly 24 hours -> due', isBackupDue(now), true);

  setGoogleDriveBackupSettings({ ...BASE, lastSuccessAt: now - 3 * BACKUP_DUE_AFTER_MS });
  assertEqual('connected, 3 days -> due', isBackupDue(now), true);

  console.log('\n[2] A skipped silent attempt must NOT count as a backup');
  // Old behaviour: autoBackupTick() wrote the attempt time into lastBackupAt
  // BEFORE trying, so a skipped attempt (expired Google login, no pop-up
  // allowed in the background) looked like a fresh backup in the UI.
  setGoogleDriveBackupSettings({ ...BASE, lastSuccessAt: now - 2 * BACKUP_DUE_AFTER_MS });
  const tick = await autoBackupTick(now);
  assertEqual('silent attempt with no valid login is skipped', tick.ok === false && tick.skipped === true, true);
  const afterSkip = getLastBackupStatus();
  assertEqual('lastSuccessAt unchanged by the skipped attempt', afterSkip.lastSuccessAt, now - 2 * BACKUP_DUE_AFTER_MS);
  assertEqual('backup is still due after the skipped attempt', isBackupDue(now), true);

  console.log('\n[3] A real successful backup clears "due"');
  const fetchCalls: string[] = [];
  (globalThis as unknown as { fetch: unknown }).fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    fetchCalls.push(`${method} ${url}`);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.includes('/drive/v3/files') && method === 'GET') {
      if (url.includes('mimeType')) return json({ files: [{ id: 'folder-1' }] });
      return json({ files: [] });
    }
    if (url.includes('/upload/drive/v3/files')) return json({ id: 'file-1' });
    return json({});
  };
  setGoogleDriveBackupSettings({
    ...BASE,
    accessToken: 'fake-token',
    accessTokenExpiresAt: Date.now() + 3600_000,
    lastSuccessAt: Date.now() - 2 * BACKUP_DUE_AFTER_MS,
  });
  assertEqual('due before the backup', isBackupDue(), true);
  const result = await backupNow();
  assertEqual('backupNow() reports success', result.ok, true);
  const s = getGoogleDriveBackupSettings();
  assertTrue('lastSuccessAt moved forward to about now', s.lastSuccessAt != null && Date.now() - s.lastSuccessAt < 5000);
  assertEqual('no longer due', isBackupDue(), false);
  assertEqual('status exposes lastSuccessAt', getLastBackupStatus().lastSuccessAt, s.lastSuccessAt);

  console.log('\n[4] A failed real attempt does not count either');
  (globalThis as unknown as { fetch: unknown }).fetch = async () => new Response('{}', { status: 500 });
  setGoogleDriveBackupSettings({
    ...BASE,
    accessToken: 'fake-token',
    accessTokenExpiresAt: Date.now() + 3600_000,
    lastSuccessAt: Date.now() - 2 * BACKUP_DUE_AFTER_MS,
  });
  const failedResult = await backupNow();
  assertEqual('backupNow() reports failure on a server error', failedResult.ok, false);
  assertEqual('still due after the failed attempt', isBackupDue(), true);

  console.log('\n[5] Old saved settings (no lastSuccessAt field) still load');
  localStorage.setItem(
    'officeCashLedger.googleDriveBackup.v1',
    JSON.stringify({ clientId: 'old.apps.googleusercontent.com', connected: true, lastBackupAt: Date.now() }),
  );
  assertEqual('lastSuccessAt defaults to null', getGoogleDriveBackupSettings().lastSuccessAt, null);
  assertEqual('such a user is treated as due (no confirmed backup)', isBackupDue(), true);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
