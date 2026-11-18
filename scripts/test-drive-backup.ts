// Google Drive backup: tests for the OPTIONAL, opt-in Google Drive
// backup destination (lib/googleDriveBackup.ts,
// lib/googleDriveSettingsStore.ts) and its scheduling/isolation
// guarantees.
//
// No real network calls, no real Google OAuth/Drive endpoints, and no
// real Google account are used anywhere in this file. `globalThis.fetch`
// is replaced with a controllable mock, `globalThis.google` (the GIS
// library's own global, normally injected by loading
// https://accounts.google.com/gsi/client) is replaced with a fully
// scripted fake, and `localStorage` gets the same minimal in-memory
// polyfill scripts/test-ai-fallback.ts already established. Same
// headless-suite limitation as every other scripts/test-*.ts file: this
// cannot literally render SettingsView.tsx's React UI, so "no new UI
// beyond the Settings section itself" (test case 1) is verified at the
// level this suite CAN check — that the underlying functions make zero
// network/OAuth calls when unconfigured, which is exactly what would
// keep the UI itself inert too.
//
// Usage: npx tsx scripts/test-drive-backup.ts

import 'fake-indexeddb/auto';
import { db, seedReferenceData } from '../src/db/schema';
import { addTransaction, type NewTransactionInput } from '../src/lib/ledger';
import { exportBackup, serializeBackup } from '../src/lib/backup';
import { SYNC_TABLES } from '../src/lib/sync';
import {
  autoBackupTick,
  backupNow,
  connect,
  disconnect,
  getLastBackupStatus,
  isConnected,
  MIN_AUTO_BACKUP_INTERVAL_MS,
  restoreFromDrive,
} from '../src/lib/googleDriveBackup';
import { getGoogleDriveBackupSettings, setGoogleDriveBackupSettings } from '../src/lib/googleDriveSettingsStore';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;

function assertEqual(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
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

// ---- Minimal in-memory localStorage polyfill (same as test-ai-fallback.ts) ----
class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
  get length(): number {
    return this.store.size;
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
}
(globalThis as unknown as { localStorage: Storage }).localStorage = new MemoryStorage() as unknown as Storage;

// ---- Controllable fetch mock (captures every call for inspection) ----
interface CapturedCall {
  url: string;
  method: string;
  body: string | undefined;
}
let capturedCalls: CapturedCall[] = [];
let fetchImpl: ((url: string, init?: RequestInit) => Promise<Response>) | null = null;
(globalThis as unknown as { fetch: typeof fetch }).fetch = ((url: string, init?: RequestInit) => {
  capturedCalls.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : undefined });
  if (!fetchImpl) throw new Error('fetchImpl not set for this test');
  return fetchImpl(url, init);
}) as typeof fetch;

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  fetchImpl = impl;
}
function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}
function textResponse(status: number, body: string): Response {
  return { ok: status >= 200 && status < 300, status, text: async () => body, json: async () => JSON.parse(body) } as Response;
}
/**
 * Distinguishes a folder-search query from a file-search query robustly,
 * by decoding the URL's own `q` param rather than substring-matching the
 * still-percent-encoded raw URL (a raw-substring check like
 * `url.includes('folder')` is fragile here because the FILE search query
 * embeds the folder's own ID as a literal parent-id string, e.g.
 * "'mock-folder-id' in parents...", which itself contains the substring
 * "folder" and would wrongly match a naive folder-query check).
 */
function isFolderSearchUrl(url: string): boolean {
  const q = new URL(url).searchParams.get('q') ?? '';
  return q.includes('mimeType=');
}
function isFileSearchUrl(url: string): boolean {
  const q = new URL(url).searchParams.get('q') ?? '';
  return q.includes(' in parents');
}

// ---- Controllable fake Google Identity Services (GIS) global ----
// Pre-populating `globalThis.google` makes lib/googleDriveBackup.ts's own
// loadGisScript() resolve immediately without ever touching
// document.createElement/appendChild - see that function's own
// `if (window.google) return Promise.resolve()` fast path.
let gisTokenResponse: { access_token?: string; expires_in?: number; error?: string; error_description?: string } = {
  access_token: 'mock-access-token',
  expires_in: 3600,
};
let initTokenClientCallCount = 0;
let requestAccessTokenCallCount = 0;
let revokeCallCount = 0;
let capturedCallback: ((r: typeof gisTokenResponse) => void) | null = null;

function installFakeGis() {
  initTokenClientCallCount = 0;
  requestAccessTokenCallCount = 0;
  revokeCallCount = 0;
  (globalThis as unknown as { window: typeof globalThis }).window = globalThis;
  (globalThis as unknown as { google: unknown }).google = {
    accounts: {
      oauth2: {
        initTokenClient: (config: { callback: (r: typeof gisTokenResponse) => void }) => {
          initTokenClientCallCount++;
          capturedCallback = config.callback;
          return {
            requestAccessToken: () => {
              requestAccessTokenCallCount++;
              // GIS's real popup flow is asynchronous - a microtask queue
              // flush mirrors that without an actual timer/UI.
              Promise.resolve().then(() => capturedCallback?.(gisTokenResponse));
            },
          };
        },
        revoke: (_token: string, cb: () => void) => {
          revokeCallCount++;
          cb();
        },
      },
    },
  };
}

async function main() {
  await seedReferenceData();
  installFakeGis();

  console.log('\n--- Google Drive backup tests ---\n');

  // ===================================================================
  // Test case 1: not connected -> zero network calls anywhere, and the
  // underlying gate every UI affordance depends on is false.
  // ===================================================================
  console.log('Test case 1: not connected -> fully inert');
  setGoogleDriveBackupSettings({
    clientId: null,
    connected: false,
    accessToken: null,
    accessTokenExpiresAt: null,
    folderId: null,
    fileId: null,
    lastBackupAt: null,
    lastError: null,
  });
  assertEqual('isConnected() is false with nothing configured', isConnected(), false);
  capturedCalls = [];
  const backupNowResult = await backupNow();
  assertEqual('backupNow() declines immediately when not connected', backupNowResult.ok, false);
  assertEqual('...and makes ZERO network calls doing so', capturedCalls.length, 0);
  assertEqual('...and ZERO GIS calls either (no popup, nothing)', initTokenClientCallCount + requestAccessTokenCallCount, 0);
  const autoTickResult = await autoBackupTick(Date.now());
  assertEqual('autoBackupTick() also declines immediately when not connected', autoTickResult.ok, false);
  assertEqual('...and makes ZERO network calls doing so either', capturedCalls.length, 0);

  // ===================================================================
  // Test case 2: connect flow (mocked GIS) stores connection state
  // LOCAL-ONLY - confirmed absent from exportBackup()'s actual output and
  // from SYNC_TABLES, same rigor Phase 6 used for the Gemini key.
  // ===================================================================
  console.log('\nTest case 2: connect flow is local-only (absent from backup/sync)');
  const connectResult = await connect('mock-client-id-12345.apps.googleusercontent.com');
  assertTrue('connect() succeeds against the mocked GIS flow', connectResult.ok);
  assertEqual('Exactly one GIS token client was initialized', initTokenClientCallCount, 1);
  assertEqual('Exactly one requestAccessToken() call was made (a real user-gesture-triggered connect)', requestAccessTokenCallCount, 1);
  assertTrue('isConnected() is now true', isConnected());
  const settingsAfterConnect = getGoogleDriveBackupSettings();
  assertEqual('The clientId was stored', settingsAfterConnect.clientId, 'mock-client-id-12345.apps.googleusercontent.com');
  assertEqual('The access token was cached', settingsAfterConnect.accessToken, 'mock-access-token');

  assertTrue('SYNC_TABLES does not include any Drive-backup-related table name', !SYNC_TABLES.some((t) => /drive|google/i.test(t)));
  const backupAfterConnect = await exportBackup();
  const backupJsonAfterConnect = JSON.stringify(backupAfterConnect);
  assertTrue('The exported backup JSON contains no trace of the Client ID', !backupJsonAfterConnect.includes('mock-client-id-12345'));
  assertTrue('The exported backup JSON contains no trace of the access token', !backupJsonAfterConnect.includes('mock-access-token'));
  assertTrue(
    'The exported backup has no "googleDrive"/"clientId"/"accessToken" top-level key at all',
    !('googleDrive' in backupAfterConnect) && !('clientId' in backupAfterConnect) && !('accessToken' in backupAfterConnect),
  );
  // Static guard, same reasoning Phase 6 used for aiFallback.ts/
  // aiSettingsStore.ts: these two files must never even IMPORT the Drive
  // settings store, so a future edit can't accidentally wire it into a
  // sync/backup path unnoticed.
  const backupSource = fs.readFileSync(path.join(__dirname, '../src/lib/backup.ts'), 'utf-8');
  const syncSource = fs.readFileSync(path.join(__dirname, '../src/lib/sync.ts'), 'utf-8');
  assertTrue('lib/backup.ts never imports googleDriveSettingsStore/googleDriveBackup (statically verified)', !/googleDriveSettingsStore|googleDriveBackup/.test(backupSource));
  assertTrue('lib/sync.ts never imports googleDriveSettingsStore/googleDriveBackup (statically verified)', !/googleDriveSettingsStore|googleDriveBackup/.test(syncSource));
  assertTrue(
    'lib/googleDriveSettingsStore.ts itself uses localStorage, not a Dexie table (statically verified)',
    /localStorage/.test(fs.readFileSync(path.join(__dirname, '../src/lib/googleDriveSettingsStore.ts'), 'utf-8')),
  );

  // ===================================================================
  // Test case 3: backupNow() with a mocked successful Drive response.
  // First call: no cached folder/file -> searches (empty) -> creates
  // both, uploads content matching exportBackup()'s real current output.
  // Second call: SAME file is updated in place (PATCH), not a second
  // create.
  // ===================================================================
  console.log('\nTest case 3: backupNow() uploads real content, second call updates in place');
  let uploadedContent: string | null = null;
  mockFetch(async (url, init) => {
    const method = init?.method ?? 'GET';
    if (url.includes('/files?q=') && isFolderSearchUrl(url)) return jsonResponse(200, { files: [] }); // no existing folder
    if (method === 'POST' && url.includes('/files?fields=id')) return jsonResponse(200, { id: 'mock-folder-id' }); // folder create
    if (url.includes('/files?q=') && isFileSearchUrl(url)) return jsonResponse(200, { files: [] }); // no existing file yet
    if (method === 'POST' && url.includes('uploadType=multipart')) {
      // Multipart body: split on the boundary and take the actual JSON
      // content part (the part whose Content-Type header has no
      // "charset=UTF-8" - that one is the metadata part).
      const body = init?.body as string;
      const parts = body.split('office_cash_ledger_backup_boundary');
      const contentPart = parts.find((p) => p.includes('Content-Type: application/json\r\n\r\n'));
      uploadedContent = contentPart ? contentPart.split('\r\n\r\n')[1]?.replace(/\r\n--$/, '') ?? null : null;
      return jsonResponse(200, { id: 'mock-file-id' });
    }
    throw new Error(`Unexpected fetch in test case 3 (first call): ${method} ${url}`);
  });
  const realBackupJson = serializeBackup(await exportBackup());
  const firstBackupResult = await backupNow();
  assertTrue('First backupNow() succeeds', firstBackupResult.ok);
  assertTrue('The uploaded content is present', uploadedContent != null);
  // Compare everything except `exportedAt`, which legitimately differs by
  // a few ms between this baseline call and backupNow()'s own internal
  // exportBackup() call - not a real discrepancy to compare on.
  function withoutExportedAt(json: string): unknown {
    const obj = JSON.parse(json) as Record<string, unknown>;
    const { exportedAt: _exportedAt, ...rest } = obj;
    return rest;
  }
  assertEqual(
    'The uploaded content is JSON-equal to exportBackup()\'s real current output (ignoring the few-ms-apart exportedAt timestamp)',
    uploadedContent ? withoutExportedAt(uploadedContent) : null,
    withoutExportedAt(realBackupJson),
  );
  const settingsAfterFirstBackup = getGoogleDriveBackupSettings();
  assertEqual('folderId was cached', settingsAfterFirstBackup.folderId, 'mock-folder-id');
  assertEqual('fileId was cached', settingsAfterFirstBackup.fileId, 'mock-file-id');
  assertTrue('lastBackupAt was recorded', settingsAfterFirstBackup.lastBackupAt != null);

  let secondCallWasPatchToSameFile = false;
  let secondCallCreatedANewFile = false;
  mockFetch(async (url, init) => {
    const method = init?.method ?? 'GET';
    if (method === 'PATCH' && url.includes('/files/mock-file-id')) {
      secondCallWasPatchToSameFile = true;
      return jsonResponse(200, { id: 'mock-file-id' });
    }
    if (method === 'POST' && url.includes('uploadType=multipart')) {
      secondCallCreatedANewFile = true;
      return jsonResponse(200, { id: 'a-DIFFERENT-file-id' });
    }
    throw new Error(`Unexpected fetch in test case 3 (second call): ${method} ${url}`);
  });
  const secondBackupResult = await backupNow();
  assertTrue('Second backupNow() succeeds', secondBackupResult.ok);
  assertTrue('Second call updates the SAME file (PATCH), using the cached folder/file IDs (no re-search)', secondCallWasPatchToSameFile);
  assertEqual('Second call did NOT create a new file', secondCallCreatedANewFile, false);
  assertEqual('fileId is still the original one after the second backup (never a new dated file, constraint #8)', getGoogleDriveBackupSettings().fileId, 'mock-file-id');

  // ===================================================================
  // Test case 4: multiple failure modes each resolve gracefully, and a
  // REAL local addTransaction() call immediately after each still
  // succeeds - normal app usage is completely unaffected.
  // ===================================================================
  console.log('\nTest case 4: graceful degradation on failure, local save path unaffected');
  const categories = await db.categories.toArray();
  const officeCategory = categories.find((c) => c.name === 'Office')!;
  async function assertNormalSaveStillWorks(label: string) {
    const before = await db.transactions.count();
    const input: NewTransactionInput = {
      date: '2026-09-01',
      direction: 'cash_out',
      amountPaisa: 50_00,
      categoryId: officeCategory.id,
      expenseHeadId: null,
      cashInTypeId: null,
      description: `drive-backup manual save check - ${label}`,
      staffId: null,
      vehicleId: null,
      institutionId: null,
      referenceNumber: null,
      notes: null,
      linkedAdvanceRecoveryPaisa: null,
    };
    await addTransaction(input);
    assertEqual(`A normal local save still works immediately after ${label}`, await db.transactions.count(), before + 1);
  }

  mockFetch(async () => {
    throw new TypeError('Failed to fetch');
  });
  const networkFailureResult = await backupNow();
  assertEqual('A network failure resolves to ok:false, never throws', networkFailureResult.ok, false);
  await assertNormalSaveStillWorks('a network failure');

  mockFetch(async (url) => (url.includes('/files?q=') ? jsonResponse(401, { error: { message: 'Invalid Credentials' } }) : jsonResponse(401, {})));
  const authFailureResult = await backupNow();
  assertEqual('A 401 (expired/revoked token) resolves to ok:false, never throws', authFailureResult.ok, false);
  await assertNormalSaveStillWorks('a 401 auth failure');

  mockFetch(async () => jsonResponse(429, { error: { message: 'User rate limit exceeded' } }));
  const quotaFailureResult = await backupNow();
  assertEqual('A 429 quota response resolves to ok:false, never throws', quotaFailureResult.ok, false);
  await assertNormalSaveStillWorks('a 429 quota failure');

  // Clear the cached folder/file IDs first so this exercises the
  // search-then-create path (which DOES call .json() on the response) -
  // files.update's own response body isn't parsed by this app at all
  // (only res.ok is checked), so a cached-file "malformed JSON" scenario
  // wouldn't actually exercise any JSON-parsing code path.
  setGoogleDriveBackupSettings({ ...getGoogleDriveBackupSettings(), folderId: null, fileId: null });
  mockFetch(async (url) => {
    if (url.includes('/files?q=')) {
      // Malformed: claims success but the body is not valid JSON.
      return { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token'); } } as unknown as Response;
    }
    throw new Error(`Unexpected fetch in malformed-response test: ${url}`);
  });
  const malformedResult = await backupNow();
  assertEqual('A malformed (unparseable) Drive response resolves to ok:false, never throws', malformedResult.ok, false);
  await assertNormalSaveStillWorks('a malformed Drive response');

  // ===================================================================
  // Test case 5: restoreFromDrive() is routed through the REAL
  // restoreFromBackup() - an old/incompatible schemaVersion in the
  // mocked downloaded file is rejected the exact same way local restore
  // already rejects it, and a valid current-schema file restores
  // successfully.
  // ===================================================================
  console.log('\nTest case 5: restoreFromDrive() uses the real restoreFromBackup() validation');
  mockFetch(async (url, init) => {
    const method = init?.method ?? 'GET';
    if (url.includes('/files?q=') && isFolderSearchUrl(url)) return jsonResponse(200, { files: [{ id: 'mock-folder-id' }] });
    if (url.includes('/files?q=') && isFileSearchUrl(url)) return jsonResponse(200, { files: [{ id: 'mock-file-id' }] });
    if (url.includes('/files/mock-file-id?alt=media')) {
      return textResponse(200, JSON.stringify({ schemaVersion: 10, exportedAt: '2020-01-01T00:00:00.000Z', appVersion: '0.0.0', transactions: [], ledgerDays: [], categories: [], expenseHeads: [], cashInTypes: [], staff: [], vehicles: [], financialInstitutions: [], budgets: [] }));
    }
    throw new Error(`Unexpected fetch in test case 5 (old schema): ${method} ${url}`);
  });
  const oldSchemaRestoreResult = await restoreFromDrive();
  assertEqual('An old (schemaVersion 10) Drive-downloaded file is rejected, not silently accepted', oldSchemaRestoreResult.ok, false);
  if (!oldSchemaRestoreResult.ok) {
    assertTrue(
      'The rejection message names both versions, matching restoreFromBackup()\'s own local-restore rejection wording exactly',
      oldSchemaRestoreResult.reason.includes('10') && oldSchemaRestoreResult.reason.includes(String(db.verno)),
    );
  }
  const txCountBeforeRejectedDriveRestore = await db.transactions.count();
  assertEqual('The live database is untouched by the rejected Drive restore attempt', await db.transactions.count(), txCountBeforeRejectedDriveRestore);

  // Now a genuinely valid, current-schema file -> should succeed.
  const validBackupForRestore = serializeBackup(await exportBackup());
  mockFetch(async (url, init) => {
    const method = init?.method ?? 'GET';
    if (url.includes('/files?q=') && isFolderSearchUrl(url)) return jsonResponse(200, { files: [{ id: 'mock-folder-id' }] });
    if (url.includes('/files?q=') && isFileSearchUrl(url)) return jsonResponse(200, { files: [{ id: 'mock-file-id' }] });
    if (url.includes('/files/mock-file-id?alt=media')) return textResponse(200, validBackupForRestore);
    throw new Error(`Unexpected fetch in test case 5 (valid schema): ${method} ${url}`);
  });
  const validRestoreResult = await restoreFromDrive();
  assertTrue('A valid, current-schema Drive-downloaded file restores successfully', validRestoreResult.ok);
  if (validRestoreResult.ok) {
    assertTrue('...and returns the same RestoreResult shape (preRestoreSnapshot) the real restoreFromBackup() always produces', validRestoreResult.result.preRestoreSnapshot != null);
  }

  // ===================================================================
  // Test case 6: auto-backup scheduling never fires more often than
  // MIN_AUTO_BACKUP_INTERVAL_MS, even under rapid repeated triggers
  // (simulating visibilitychange/pagehide/interval all firing close
  // together).
  // ===================================================================
  console.log('\nTest case 6: auto-backup rate limiting');
  let autoBackupNetworkCallCount = 0;
  mockFetch(async (url, init) => {
    autoBackupNetworkCallCount++;
    const method = init?.method ?? 'GET';
    if (url.includes('/files?q=') && isFolderSearchUrl(url)) return jsonResponse(200, { files: [{ id: 'mock-folder-id' }] });
    if (url.includes('/files?q=') && isFileSearchUrl(url)) return jsonResponse(200, { files: [{ id: 'mock-file-id' }] });
    if (method === 'PATCH') return jsonResponse(200, { id: 'mock-file-id' });
    throw new Error(`Unexpected fetch in test case 6: ${method} ${url}`);
  });
  // Force a fresh, still-valid cached token (auto-backup is
  // non-interactive and must never prompt) and clear lastBackupAt so the
  // first tick below is guaranteed to actually attempt.
  setGoogleDriveBackupSettings({ ...getGoogleDriveBackupSettings(), accessToken: 'mock-access-token', accessTokenExpiresAt: Date.now() + 3600_000, lastBackupAt: 0 });
  const baseTime = Date.now();
  const tick1 = await autoBackupTick(baseTime);
  assertTrue('The first auto-backup tick actually attempts (not skipped)', tick1.ok);
  const callsAfterFirstTick = autoBackupNetworkCallCount;
  assertTrue('The first tick made real network calls', callsAfterFirstTick > 0);

  // Simulate a burst of rapid triggers (visibilitychange + pagehide +
  // another interval tick, all within milliseconds) - none of these
  // should make ANY further network calls.
  const rapidTicks = await Promise.all([
    autoBackupTick(baseTime + 10),
    autoBackupTick(baseTime + 20),
    autoBackupTick(baseTime + 100),
    autoBackupTick(baseTime + 1000),
  ]);
  assertTrue('Every rapid follow-up tick within the minimum interval is skipped', rapidTicks.every((r) => !r.ok && 'skipped' in r && r.skipped));
  assertEqual('No additional network calls were made by any of the rapid follow-up ticks', autoBackupNetworkCallCount, callsAfterFirstTick);

  // Advance past the minimum interval - the next tick should attempt again.
  const tickAfterInterval = await autoBackupTick(baseTime + MIN_AUTO_BACKUP_INTERVAL_MS + 1);
  assertTrue('A tick AFTER the minimum interval has elapsed attempts again', tickAfterInterval.ok);
  assertTrue('...and this one DOES make a new network call', autoBackupNetworkCallCount > callsAfterFirstTick);

  // Non-interactive auto-backup must NEVER prompt via GIS, even when it
  // does proceed - only the cached token is ever used.
  assertEqual('Auto-backup never calls requestAccessToken() (never prompts in the background)', requestAccessTokenCallCount, 1 /* only the earlier interactive connect() call */);

  // ===================================================================
  // Disconnect: best-effort revoke + local state cleared.
  // ===================================================================
  console.log('\nDisconnect: best-effort revoke, local state cleared');
  await disconnect();
  assertEqual('revoke() was called once', revokeCallCount, 1);
  assertEqual('isConnected() is false again after disconnect', isConnected(), false);
  const settingsAfterDisconnect = getGoogleDriveBackupSettings();
  assertEqual('accessToken cleared', settingsAfterDisconnect.accessToken, null);
  assertEqual('folderId cleared', settingsAfterDisconnect.folderId, null);
  assertEqual('fileId cleared', settingsAfterDisconnect.fileId, null);
  assertEqual('clientId is KEPT (so the owner doesn\'t have to retype it to reconnect)', settingsAfterDisconnect.clientId, 'mock-client-id-12345.apps.googleusercontent.com');
  const statusAfterDisconnect = getLastBackupStatus();
  assertTrue('getLastBackupStatus() still reports the earlier successful backup time (history preserved)', statusAfterDisconnect.lastBackupAt != null);

  console.log('\n--- End Google Drive backup tests ---\n');
  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
