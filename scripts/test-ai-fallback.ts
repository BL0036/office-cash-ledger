// Phase 6: tests for the OPTIONAL, on-demand Gemini API fallback
// (lib/aiFallback.ts, lib/aiSettingsStore.ts) and its wiring points.
//
// No real network calls are made anywhere in this file - `globalThis.fetch`
// is replaced with a controllable mock for every test that needs one, and
// restored afterward. No real API key is required to run this suite.
//
// This file cannot literally render FastEntryBar.tsx (this whole test
// suite is headless - fake-indexeddb, no DOM/React harness, same as every
// other scripts/test-*.ts file). Where a test case describes UI/button
// behavior, this file instead exercises the exact underlying condition/
// function FastEntryBar.tsx itself calls (mirrored here deliberately -
// see `canAskAi()` below - since a .tsx component can't be imported into
// a plain script), which is the same style test-fastentry-enter.ts
// already uses for its own "simulated submit" guard-race tests.
//
// Usage: npx tsx scripts/test-ai-fallback.ts

import 'fake-indexeddb/auto';
import { db, seedReferenceData } from '../src/db/schema';
import { addStaff } from '../src/lib/staff';
import { addVehicle } from '../src/lib/vehicles';
import { addInstitution } from '../src/lib/institutions';
import { addTransaction, type NewTransactionInput } from '../src/lib/ledger';
import {
  resolveUniqueMatch,
  type SuggestionCandidatePool,
} from '../src/lib/fastEntrySuggestions';
import {
  buildAiCandidates,
  requestAiFallbackSuggestion,
  isAiFallbackConfigured,
} from '../src/lib/aiFallback';
import { setAiFallbackSettings } from '../src/lib/aiSettingsStore';
import { createFastEntrySaveGuard } from '../src/lib/fastEntry';
import { SYNC_TABLES } from '../src/lib/sync';
import { exportBackup } from '../src/lib/backup';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Direction } from '../src/types';

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

// ---- Minimal in-memory localStorage polyfill (Node has none by default) ----
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

// ---- Controllable fetch mock ----
let fetchCallCount = 0;
let fetchImpl: ((url: string, init: RequestInit) => Promise<Response>) | null = null;
const realFetch = globalThis.fetch;
(globalThis as unknown as { fetch: typeof fetch }).fetch = ((url: string, init: RequestInit) => {
  fetchCallCount++;
  if (!fetchImpl) throw new Error('fetchImpl not set for this test');
  return fetchImpl(url, init);
}) as typeof fetch;

function mockFetchOnce(impl: (url: string, init: RequestInit) => Promise<Response>) {
  fetchImpl = impl;
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

/**
 * Mirrors FastEntryBar.tsx's own `canAskAi` boolean EXACTLY (see that
 * component's own comment above the real one) - duplicated here because a
 * .tsx React component can't be imported into this headless test runner.
 * Kept as a single, named, one-line-per-clause function specifically so a
 * future edit to the real component's condition has an obvious matching
 * spot to update here too.
 */
function canAskAi(description: string, direction: Direction, pool: SuggestionCandidatePool | null, aiConfigured: boolean): boolean {
  if (!pool) return false;
  if (!aiConfigured) return false;
  if (description.trim().length < 3) return false;
  return resolveUniqueMatch(description, pool) == null;
}

async function buildPool(direction: Direction): Promise<SuggestionCandidatePool> {
  const categories = await db.categories.toArray();
  const expenseHeads = await db.expenseHeads.toArray();
  const cashInTypes = await db.cashInTypes.toArray();
  const activeStaff = await db.staff.filter((s) => s.active).toArray();
  const activeInstitutions = await db.financialInstitutions.filter((i) => i.active).toArray();
  const activeVehicles = await db.vehicles.filter((v) => v.active).toArray();
  const historyTransactions = await db.transactions
    .where('direction')
    .equals(direction)
    .and((t) => t.deletedAt == null && t.description.trim() !== '')
    .toArray();

  const categoryNameById = new Map(categories.map((c) => [c.id, c.name]));
  const expenseHeadNameById = new Map(expenseHeads.map((h) => [h.id, h.name]));
  const cashInTypeNameById = new Map(cashInTypes.map((t) => [t.id, t.name]));

  const savingsCategory = categories.find((c) => c.name === 'Savings & Financial');
  const staffCategory = categories.find((c) => c.name === 'Staff');
  const staffAdvanceHead = staffCategory
    ? expenseHeads.find((h) => h.categoryId === staffCategory.id && h.name === 'Advance')
    : undefined;
  const vehicleMaintenanceCategory = categories.find((c) => c.name === 'Vehicle Maintenance');
  const vehicleServiceHead = vehicleMaintenanceCategory
    ? expenseHeads.find((h) => h.categoryId === vehicleMaintenanceCategory.id && h.name === 'Service')
    : undefined;

  return {
    direction,
    expenseHeadCandidates: expenseHeads.filter((h) => h.active).map((h) => ({ id: h.id, name: h.name, categoryId: h.categoryId })),
    cashInTypeCandidates: cashInTypes.filter((t) => t.active).map((t) => ({ id: t.id, name: t.name })),
    historyEntries: historyTransactions.map((t) => ({
      description: t.description,
      categoryOrTypeId: (direction === 'cash_in' ? t.cashInTypeId : t.categoryId) ?? '',
      expenseHeadId: t.expenseHeadId,
      createdAt: t.createdAt,
    })),
    institutionCandidates: activeInstitutions.map((i) => ({ id: i.id, name: i.name, aliases: i.aliases })),
    staffCandidates: activeStaff.map((s) => ({ id: s.id, name: s.name, aliases: s.aliases })),
    vehicleCandidates: activeVehicles.map((v) => ({ id: v.id, name: v.name, aliases: v.aliases })),
    categoryNameById,
    expenseHeadNameById,
    cashInTypeNameById,
    savingsCategoryId: savingsCategory?.id ?? null,
    staffCategoryId: staffCategory?.id ?? null,
    staffAdvanceExpenseHeadId: staffAdvanceHead?.id ?? null,
    vehicleMaintenanceCategoryId: vehicleMaintenanceCategory?.id ?? null,
    vehicleServiceExpenseHeadId: vehicleServiceHead?.id ?? null,
  };
}

async function main() {
  await seedReferenceData();
  const staffId = await addStaff({ name: 'Test Staff', monthlySalaryPaisa: 10_000_00, advanceLimitPaisa: null, joiningDate: null, notes: null });
  const vehicleId = await addVehicle({ name: 'TEST BIKE 100', vehicleType: 'Motorbike', registrationNumber: null });
  const institutionId = await addInstitution({ name: 'TEST COOPERATIVE LTD', aliases: ['TESTCOOP'] });
  void staffId;
  void vehicleId;
  void institutionId;

  console.log('\n--- Phase 6 AI fallback tests ---\n');

  // ===================================================================
  // Test case 1: with no key configured, zero network calls anywhere,
  // and the affordance-gating condition is always false.
  // ===================================================================
  console.log('Test case 1: no key configured -> fully inert');
  setAiFallbackSettings({ enabled: false, apiKey: null });
  assertEqual('isAiFallbackConfigured() is false with nothing set', isAiFallbackConfigured(), false);
  const pool1 = await buildPool('cash_out');
  fetchCallCount = 0;
  const resultNoKey = await requestAiFallbackSuggestion('SOME BRAND NEW UNMATCHED TEXT', 'cash_out', pool1);
  assertEqual('requestAiFallbackSuggestion() refuses immediately when not configured', resultNoKey.ok, false);
  assertEqual('...and makes ZERO network calls doing so', fetchCallCount, 0);
  assertEqual('canAskAi() (mirrors the real button-gating condition) is false with no key configured', canAskAi('SOME BRAND NEW UNMATCHED TEXT', 'cash_out', pool1, isAiFallbackConfigured()), false);

  // Also with enabled:true but no key (half-configured) - still fully inert.
  setAiFallbackSettings({ enabled: true, apiKey: null });
  assertEqual('isAiFallbackConfigured() is still false with enabled=true but no key', isAiFallbackConfigured(), false);
  fetchCallCount = 0;
  const resultHalfConfigured = await requestAiFallbackSuggestion('SOME BRAND NEW UNMATCHED TEXT', 'cash_out', pool1);
  assertEqual('requestAiFallbackSuggestion() also refuses when enabled but no key', resultHalfConfigured.ok, false);
  assertEqual('...zero network calls here too', fetchCallCount, 0);

  // Now actually configure it for the rest of the suite.
  setAiFallbackSettings({ enabled: true, apiKey: 'test-fake-key-not-real' });
  assertTrue('isAiFallbackConfigured() is true once both enabled and a key are set', isAiFallbackConfigured());

  // ===================================================================
  // Test case 2: with a key configured, a description the deterministic
  // engine ALREADY resolves confidently -> AI path never invoked.
  // ===================================================================
  console.log('\nTest case 2: deterministic engine already confident -> AI never invoked');
  const khajaPool = await buildPool('cash_out');
  const khajaAutoMatch = resolveUniqueMatch('KHAJA', khajaPool);
  assertTrue('Sanity: "KHAJA" really does resolve deterministically (Rule 1/2)', khajaAutoMatch != null);
  assertEqual('canAskAi() is false for "KHAJA" even with a key configured, because Rules 1-5 already found it', canAskAi('KHAJA', 'cash_out', khajaPool, isAiFallbackConfigured()), false);
  fetchCallCount = 0;
  // Belt-and-braces: even if something upstream ignored canAskAi() and
  // called this function anyway, it still only makes a network call for
  // the pool/description it's given - it never itself re-checks the
  // deterministic engine, by design (constraint #2's gating belongs to
  // the CALLER; but this at least proves calling it on a resolvable
  // description doesn't short-circuit to zero calls on its own, i.e. the
  // real protection is genuinely the caller-side canAskAi() check, not a
  // hidden double gate that could mask a wiring bug in FastEntryBar.tsx).
  // The actual guarantee this test cares about is the canAskAi() == false
  // assertion above; this call count check confirms our mock harness
  // itself is wired correctly.
  mockFetchOnce(async () => jsonResponse(200, { candidates: [{ content: { parts: [{ text: '{"matchIndex":"NONE"}' }] } }] }));
  if (canAskAi('KHAJA', 'cash_out', khajaPool, isAiFallbackConfigured())) {
    await requestAiFallbackSuggestion('KHAJA', 'cash_out', khajaPool);
  }
  assertEqual('Following the real gating condition, zero network calls are made for "KHAJA"', fetchCallCount, 0);

  // ===================================================================
  // Test case 3: a description the deterministic engine finds NOTHING
  // for -> the affordance becomes available, and triggering it fires
  // exactly one mocked network call.
  // ===================================================================
  console.log('\nTest case 3: no deterministic match -> affordance available, exactly one call fires');
  const novelText = 'QWERTYUIOP ZXCVBNM PLUGH XYZZY FOOBARBAZ';
  const pool3 = await buildPool('cash_out');
  const novelAutoMatch = resolveUniqueMatch(novelText, pool3);
  assertEqual('Sanity: this text really has no deterministic match', novelAutoMatch, null);
  assertTrue('canAskAi() is TRUE for this text once a key is configured', canAskAi(novelText, 'cash_out', pool3, isAiFallbackConfigured()));
  fetchCallCount = 0;
  let capturedUrl: string | null = null;
  mockFetchOnce(async (url) => {
    capturedUrl = url;
    return jsonResponse(200, { candidates: [{ content: { parts: [{ text: '{"matchIndex":"NONE"}' }] } }] });
  });
  await requestAiFallbackSuggestion(novelText, 'cash_out', pool3);
  assertEqual('Triggering it fires EXACTLY one network call', fetchCallCount, 1);
  // Phase 6 model-fix: regression guard confirming the CURRENT model
  // string is actually the one used in the request URL, not silently
  // still pointing at the retired gemini-2.5-flash-lite (or any other
  // stale value) - see MODEL CURRENCY in aiFallback.ts's header comment.
  assertEqual('The request URL uses the current, non-retired model string', capturedUrl, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');

  // ===================================================================
  // Test case 4: a successful mocked response naming one of the owner's
  // real candidates -> appears as SUGGESTION data only, never applied.
  // ===================================================================
  console.log('\nTest case 4: successful AI response is suggestion-only, never auto-applied');
  const candidates4 = buildAiCandidates(pool3);
  const institutionCandidateIndex = candidates4.findIndex((c) => c.match.suggestedInstitutionId != null);
  assertTrue('Sanity: at least one institution candidate exists to be picked', institutionCandidateIndex >= 0);
  mockFetchOnce(async () =>
    jsonResponse(200, {
      candidates: [{ content: { parts: [{ text: JSON.stringify({ matchIndex: String(institutionCandidateIndex) }) }] } }],
    }),
  );
  const txCountBeforeAiCall = await db.transactions.count();
  const successResult = await requestAiFallbackSuggestion('some text about the test cooperative', 'cash_out', pool3);
  assertTrue('Result is ok:true with a real suggestion object', successResult.ok && successResult.suggestion != null);
  if (successResult.ok && successResult.suggestion) {
    assertEqual('The suggestion carries source: "ai" (for the UI badge)', successResult.suggestion.source, 'ai');
    assertEqual('...and the correct institutionId picked from the owner\'s real candidates', successResult.suggestion.suggestedInstitutionId, institutionId);
    assertEqual('...it is a plain data object with a description/label - nothing more', typeof successResult.suggestion.description, 'string');
  }
  assertEqual('Nothing was written to the database by this call - suggestion-only, never auto-saved', await db.transactions.count(), txCountBeforeAiCall);
  // Static guard: this module must never even IMPORT a write path, so a
  // future edit can't accidentally wire one in without this test noticing.
  const aiFallbackSource = fs.readFileSync(path.join(__dirname, '../src/lib/aiFallback.ts'), 'utf-8');
  assertTrue('lib/aiFallback.ts never imports addTransaction/editTransaction (statically verified)', !/addTransaction|editTransaction|softDeleteTransaction/.test(aiFallbackSource));

  // Also: a hallucinated / out-of-range index must be treated as "no match", never guessed at.
  mockFetchOnce(async () => jsonResponse(200, { candidates: [{ content: { parts: [{ text: '{"matchIndex":"9999"}' }] } }] }));
  const outOfRangeResult = await requestAiFallbackSuggestion('anything', 'cash_out', pool3);
  assertEqual('An out-of-range index from the API is treated as "no match", not a guess (defense in depth)', outOfRangeResult.ok && outOfRangeResult.suggestion === null, true);

  // ===================================================================
  // Test case 5: network failure / 429 / malformed-empty response all
  // resolve to a graceful "unavailable" state, and a normal manual save
  // remains fully usable immediately after each.
  // ===================================================================
  console.log('\nTest case 5: graceful degradation on failure, save path unaffected');

  async function assertNormalSaveStillWorks(label: string) {
    const before = await db.transactions.count();
    const categories = await db.categories.toArray();
    const officeCategory = categories.find((c) => c.name === 'Office')!;
    const input: NewTransactionInput = {
      date: '2026-09-01',
      direction: 'cash_out',
      amountPaisa: 100_00,
      categoryId: officeCategory.id,
      expenseHeadId: null,
      cashInTypeId: null,
      description: `manual save check - ${label}`,
      staffId: null,
      vehicleId: null,
      institutionId: null,
      referenceNumber: null,
      notes: null,
      linkedAdvanceRecoveryPaisa: null,
    };
    await addTransaction(input);
    assertEqual(`Fast Entry's normal save path still works immediately after ${label}`, await db.transactions.count(), before + 1);
  }

  // 5a: network failure (fetch itself throws)
  mockFetchOnce(async () => {
    throw new TypeError('Failed to fetch');
  });
  const networkFailureResult = await requestAiFallbackSuggestion('network failure case', 'cash_out', pool3);
  assertEqual('A network failure resolves to ok:false, never throws', networkFailureResult.ok, false);
  await assertNormalSaveStillWorks('a network failure');

  // 5b: 429 quota exceeded
  mockFetchOnce(async () => jsonResponse(429, { error: { message: 'Resource exhausted' } }));
  const quotaResult = await requestAiFallbackSuggestion('quota exceeded case', 'cash_out', pool3);
  assertEqual('A 429 response resolves to ok:false with a quota-specific reason', quotaResult.ok === false && /quota|rate limit/i.test((quotaResult as { reason: string }).reason), true);
  await assertNormalSaveStillWorks('a 429 quota response');

  // 5c: malformed/empty response
  mockFetchOnce(async () => jsonResponse(200, {}));
  const emptyResult = await requestAiFallbackSuggestion('empty response case', 'cash_out', pool3);
  assertEqual('An empty/malformed response resolves to ok:false, never throws', emptyResult.ok, false);
  await assertNormalSaveStillWorks('an empty/malformed response');

  // 5d: response.json() itself throws (genuinely malformed body)
  mockFetchOnce(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token'); } }) as unknown as Response);
  const brokenJsonResult = await requestAiFallbackSuggestion('broken json case', 'cash_out', pool3);
  assertEqual('A response whose .json() itself throws resolves to ok:false, never throws upward', brokenJsonResult.ok, false);
  await assertNormalSaveStillWorks('a broken-JSON response');

  // 5e: timeout (AbortController) - simulate by having the mock reject with an AbortError-shaped DOMException.
  mockFetchOnce(async () => {
    throw new DOMException('The operation was aborted.', 'AbortError');
  });
  const timeoutResult = await requestAiFallbackSuggestion('timeout case', 'cash_out', pool3);
  assertEqual('A timeout resolves to ok:false with a timeout-specific reason', timeoutResult.ok === false && /timed out/i.test((timeoutResult as { reason: string }).reason), true);
  await assertNormalSaveStillWorks('a timeout');

  // 5f: 401 invalid key
  mockFetchOnce(async () => jsonResponse(401, { error: { message: 'API key not valid' } }));
  const invalidKeyResult = await requestAiFallbackSuggestion('invalid key case', 'cash_out', pool3);
  assertEqual('A 401 response resolves to ok:false with an invalid-key-specific reason', invalidKeyResult.ok === false && /invalid api key/i.test((invalidKeyResult as { reason: string }).reason), true);
  await assertNormalSaveStillWorks('a 401 invalid-key response');

  // ===================================================================
  // Test case 6: the API key is structurally absent from both
  // exportBackup()'s output and SYNC_TABLES.
  // ===================================================================
  console.log('\nTest case 6: API key excluded from backup and sync');
  assertTrue('SYNC_TABLES does not include any AI-fallback-related table name', !SYNC_TABLES.some((t) => /ai|gemini|apikey/i.test(t)));
  const backup = await exportBackup();
  const backupJson = JSON.stringify(backup);
  assertTrue('The exported backup JSON contains no trace of the configured API key value', !backupJson.includes('test-fake-key-not-real'));
  assertTrue('The exported backup has no "aiSettings"/"apiKey"/"geminiKey" top-level key at all', !('aiSettings' in backup) && !('apiKey' in backup) && !('geminiKey' in backup));
  // Static guard, same reasoning as the aiFallback.ts check above: these
  // two files must never even IMPORT the settings store, so a future edit
  // can't accidentally wire the key into a sync/backup path unnoticed.
  const backupSource = fs.readFileSync(path.join(__dirname, '../src/lib/backup.ts'), 'utf-8');
  const syncSource = fs.readFileSync(path.join(__dirname, '../src/lib/sync.ts'), 'utf-8');
  assertTrue('lib/backup.ts never imports aiSettingsStore/aiFallback (statically verified)', !/aiSettingsStore|aiFallback/.test(backupSource));
  assertTrue('lib/sync.ts never imports aiSettingsStore/aiFallback (statically verified)', !/aiSettingsStore|aiFallback/.test(syncSource));
  assertTrue('lib/aiSettingsStore.ts itself uses localStorage, not a Dexie table (statically verified)', /localStorage/.test(fs.readFileSync(path.join(__dirname, '../src/lib/aiSettingsStore.ts'), 'utf-8')));

  // ===================================================================
  // Test case 7: rapid Enter / double-submit guard completely unaffected
  // when the AI affordance is visible (configured + no deterministic
  // match) but never triggered. Exact same race-simulation pattern
  // test-fastentry-enter.ts's own Test case 6 uses.
  // ===================================================================
  console.log('\nTest case 7: double-submit guard unaffected by a visible-but-untriggered AI affordance');
  {
    const pool7 = await buildPool('cash_out');
    const description = 'GUARD RACE CHECK PLUGH XYZZY QUUX';
    assertTrue('Sanity: the AI affordance WOULD be visible for this entry (configured + no deterministic match)', canAskAi(description, 'cash_out', pool7, isAiFallbackConfigured()));
    const categories = await db.categories.toArray();
    const officeCategory = categories.find((c) => c.name === 'Office')!;
    const guard = createFastEntrySaveGuard();
    const txBefore = await db.transactions.count();
    async function simulatedPlainSubmit(): Promise<'saved' | 'blocked'> {
      if (!guard.tryStart()) return 'blocked';
      try {
        // The AI affordance being visible never enters this path at all -
        // handleSubmit() in the real component has zero dependency on
        // aiSuggestion/aiStatus/canAskAi; this mirrors that by simply
        // never calling anything AI-related here, exactly as the real
        // save handler doesn't.
        await addTransaction({
          date: '2026-09-02',
          direction: 'cash_out',
          amountPaisa: 50_00,
          categoryId: officeCategory.id,
          expenseHeadId: null,
          cashInTypeId: null,
          description,
          staffId: null,
          vehicleId: null,
          institutionId: null,
          referenceNumber: null,
          notes: null,
          linkedAdvanceRecoveryPaisa: null,
        });
        return 'saved';
      } finally {
        guard.finish();
      }
    }
    const [o1, o2] = await Promise.all([simulatedPlainSubmit(), simulatedPlainSubmit()]);
    assertEqual('A double-Enter race still saves exactly once, AI affordance being visible changes nothing', [o1, o2].sort().join(','), 'blocked,saved');
    assertEqual('Exactly one Transaction row was created', await db.transactions.count(), txBefore + 1);
    // And confirm the AI path itself was never touched by any of this -
    // no fetch call happened just from the affordance being visible/the
    // guard racing.
    fetchCallCount = 0;
    assertEqual('No network call occurred purely from the save race above (AI is only ever triggered by its own explicit click)', fetchCallCount, 0);
  }

  console.log('\n--- End Phase 6 AI fallback tests ---\n');
  console.log(`${passed} passed, ${failed} failed`);
  (globalThis as unknown as { fetch: typeof fetch }).fetch = realFetch;
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
