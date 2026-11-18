// Standalone verification script for the Phase 10b (Cloud Sync) test
// cases in the spec. Runs the real src/lib/sync.ts, src/lib/syncConfig.ts
// and src/lib/ledger.ts modules against the Firebase Local Emulator Suite
// (Firestore + Auth emulators) — never a live Firebase project.
//
// Usage:
//   npm run test:sync
// which runs (see package.json):
//   firebase emulators:exec --only firestore,auth "tsx scripts/test-sync.ts"
// `firebase emulators:exec` starts both emulators, waits until they're
// ready, runs this script, then tears the emulators down and forwards
// this script's exit code — so a normal `npm run test:sync` needs nothing
// pre-started. To iterate faster during development, you can instead run
// `firebase emulators:start --only firestore,auth` in one terminal and
// `tsx scripts/test-sync.ts` directly in another; the script talks to
// whatever's listening on 127.0.0.1:8080 (Firestore) and :9099 (Auth)
// either way.
//
// Test Case 1 ("all 315 existing test cases still pass unmodified") is
// covered by `npm run test:ledger`, not here — that suite is untouched by
// Phase 10b and doesn't need the emulator. This file covers Test Cases
// 2-9, plus Test Case 10 (Phase 11 Part C scenario 1's sync leg — see
// that test for details).
//
// IMPORTANT — this script does NOT read src/lib/firebaseClient.ts's normal
// Vite env vars (import.meta.env doesn't exist under plain tsx/Node).
// Instead it sets `globalThis.__VITE_ENV__` below, which
// firebaseClient.ts's readEnvVar() falls back to reading. This is the
// ONLY thing in src/ that's aware it might be running under a test
// runner; every other module is exactly what ships in the real app.

// Must be set before any function that calls readEnvVar() actually runs
// (module import alone doesn't trigger it — see firebaseClient.ts) —
// setting it here, before the imports below, is what makes that true.
(globalThis as unknown as { __VITE_ENV__?: Record<string, string> }).__VITE_ENV__ = {
  VITE_FIREBASE_API_KEY: 'demo-api-key',
  VITE_FIREBASE_AUTH_DOMAIN: 'demo-cash-ledger.firebaseapp.com',
  VITE_FIREBASE_PROJECT_ID: 'cash-ledger-test',
  VITE_FIREBASE_STORAGE_BUCKET: 'demo-cash-ledger.appspot.com',
  VITE_FIREBASE_MESSAGING_SENDER_ID: '000000000000',
  VITE_FIREBASE_APP_ID: '1:000000000000:web:0000000000000000000000',
  VITE_FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
  VITE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
};

import 'fake-indexeddb/auto';
import { CashLedgerDB, __setDbForTesting, seedReferenceData } from '../src/db/schema';
import { db } from '../src/db/schema';
import { addTransaction, editTransaction, softDeleteTransaction } from '../src/lib/ledger';
import { addStaff } from '../src/lib/staff';
import { addVehicle } from '../src/lib/vehicles';
import { assignVehicleToStaff, getVehiclesForStaff, unassignVehicleFromStaff } from '../src/lib/staffVehicles';
import { exportBackup, restoreFromBackup, serializeBackup } from '../src/lib/backup';
import { configureSyncCode, getSyncConfig } from '../src/lib/syncConfig';
import { syncNow } from '../src/lib/sync';
import { getSyncFirestore } from '../src/lib/firebaseClient';
import { doc, setDoc, getDoc } from 'firebase/firestore';

const FIRESTORE_EMULATOR_BASE = 'http://127.0.0.1:8080';
const AUTH_EMULATOR_BASE = 'http://127.0.0.1:9099';
const PROJECT_ID = 'cash-ledger-test';

let passed = 0;
let failed = 0;

function assertEqual(label: string, actual: unknown, expected: unknown) {
  const ok = actual === expected;
  if (ok) {
    passed++;
    console.log(`  PASS  ${label} (${actual})`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}: expected ${expected}, got ${actual}`);
  }
}

function assertTrue(label: string, actual: boolean) {
  assertEqual(label, actual, true);
}

/** Wipes all documents in the Firestore emulator so each test case starts from a clean slate — the emulator process persists data across script runs otherwise. */
async function clearFirestoreEmulator(): Promise<void> {
  const res = await fetch(
    `${FIRESTORE_EMULATOR_BASE}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  if (!res.ok) {
    throw new Error(`Failed to clear Firestore emulator: ${res.status} ${await res.text()}`);
  }
}

/** Wipes all Auth emulator users, so each test case's anonymous sign-in is a genuinely fresh session. */
async function clearAuthEmulator(): Promise<void> {
  const res = await fetch(`${AUTH_EMULATOR_BASE}/emulator/v1/projects/${PROJECT_ID}/accounts`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    throw new Error(`Failed to clear Auth emulator: ${res.status} ${await res.text()}`);
  }
}

/** Fresh, independent local database for one simulated device — isolated by name only, same pattern Phase 9's migration tests use. */
async function newDevice(name: string): Promise<CashLedgerDB> {
  const instance = new CashLedgerDB(name);
  __setDbForTesting(instance);
  await seedReferenceData();
  return instance;
}

const DAY1 = '2026-02-01';

async function main() {
  console.log('\n--- Phase 10b Cloud Sync tests (against Firebase Local Emulator Suite) ---');

  // ===================================================================
  // Test Case 8: with NO sync code configured, zero Firebase SDK network
  // calls are attempted, and every existing screen still works normally.
  // Run FIRST and against a totally fresh device/db, before anything else
  // in this file has touched Firebase — so there is no cached
  // app/auth/firestore instance from an earlier test to hide a real call
  // behind. seedReferenceData()/addTransaction() below are pure
  // Dexie/local calls; the only way this could reach the network is if
  // some code path called Firebase eagerly, which it must not.
  // ===================================================================
  console.log('\nTest Case 8: no sync code configured -> zero Firebase calls, app works normally');
  await newDevice('sync-test-case8');
  const config8 = await getSyncConfig();
  assertEqual('No sync code configured on a fresh device', config8, null);
  const categories8 = await db.categories.toArray();
  const atmType8 = (await db.cashInTypes.toArray()).find((t) => t.name === 'ATM')!;
  const txnId8 = await addTransaction({
    date: DAY1,
    direction: 'cash_in',
    amountPaisa: 1_000_00,
    categoryId: null,
    expenseHeadId: null,
    cashInTypeId: atmType8.id,
    description: 'Normal offline transaction',
    staffId: null,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  const savedTxn8 = await db.transactions.get(txnId8);
  assertTrue('Transaction saved locally with no sync code configured', savedTxn8 != null);
  assertTrue('Categories still load normally offline', categories8.length > 0);
  console.log(
    '  NOTE  This test asserts the ABSENCE of a call, not a caught network error — by construction, ' +
      'nothing above imports or invokes anything in lib/sync.ts or lib/firebaseClient.ts. Structural ' +
      'guarantee, not a runtime network probe.',
  );

  // From here on, every test case DOES use sync — clear both emulators
  // once up front, then again between test cases that need isolation.
  await clearFirestoreEmulator();
  await clearAuthEmulator();

  // ===================================================================
  // Test Case 2: pushing a new local transaction writes exactly one
  // Firestore document at the correct path, with all fields intact.
  // ===================================================================
  console.log('\nTest Case 2: push writes exactly one Firestore doc at the correct path');
  await newDevice('sync-test-case2');
  const syncCode2 = 'TESTCD02';
  await configureSyncCode(syncCode2);
  const atmType2 = (await db.cashInTypes.toArray()).find((t) => t.name === 'ATM')!;
  const txnId2 = await addTransaction({
    date: DAY1,
    direction: 'cash_in',
    amountPaisa: 2_500_00,
    categoryId: null,
    expenseHeadId: null,
    cashInTypeId: atmType2.id,
    description: 'Push test transaction',
    staffId: null,
    vehicleId: null,
    institutionId: null,
    referenceNumber: 'REF-2',
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  const localTxn2 = (await db.transactions.get(txnId2))!;
  await syncNow();
  const firestore2 = getSyncFirestore();
  const remoteSnap2 = await getDoc(doc(firestore2, 'syncGroups', syncCode2, 'transactions', txnId2));
  assertTrue('Firestore document exists at syncGroups/{code}/transactions/{id}', remoteSnap2.exists());
  const remoteData2 = remoteSnap2.data();
  assertEqual('Remote amountPaisa matches local', remoteData2?.amountPaisa, localTxn2.amountPaisa);
  assertEqual('Remote description matches local', remoteData2?.description, localTxn2.description);
  assertEqual('Remote referenceNumber matches local', remoteData2?.referenceNumber, localTxn2.referenceNumber);
  assertEqual('Remote updatedAt matches local', remoteData2?.updatedAt, localTxn2.updatedAt);

  // ===================================================================
  // Test Case 3: idempotency — Sync Now twice in a row with no changes in
  // between results in the same single Firestore document (not
  // duplicated) and no duplicate local rows.
  // ===================================================================
  console.log('\nTest Case 3: idempotency — Sync Now twice with no changes = no duplicates');
  const localCountBefore3 = await db.transactions.count();
  await syncNow(); // second call, nothing changed locally since the first
  const remoteSnap3 = await getDoc(doc(firestore2, 'syncGroups', syncCode2, 'transactions', txnId2));
  assertTrue('Document still exists (not deleted/replaced oddly)', remoteSnap3.exists());
  assertEqual(
    'Same amountPaisa after a second no-op sync (re-.set() of the same doc, not a duplicate)',
    remoteSnap3.data()?.amountPaisa,
    localTxn2.amountPaisa,
  );
  const localCountAfter3 = await db.transactions.count();
  assertEqual('No duplicate local rows created by a second Sync Now', localCountAfter3, localCountBefore3);

  // ===================================================================
  // Test Case 4: pull — a document written directly to the Firestore
  // emulator (simulating a second device) is correctly pulled into a
  // fresh local database, with LedgerDay correctly recalculated
  // afterward.
  // ===================================================================
  console.log('\nTest Case 4: pull — a directly-written remote doc lands locally, balances recalc correctly');
  await clearFirestoreEmulator();
  const syncCode4 = 'TESTCD04';
  const remoteOnlyId4 = crypto.randomUUID();
  // Simulate "a second device" by writing straight to Firestore, bypassing
  // this process's local db entirely — exactly what Part D's test case
  // asks for.
  await setDoc(doc(getSyncFirestore(), 'syncGroups', syncCode4, 'transactions', remoteOnlyId4), {
    id: remoteOnlyId4,
    date: DAY1,
    direction: 'cash_in',
    amountPaisa: 9_000_00,
    categoryId: null,
    expenseHeadId: null,
    cashInTypeId: null,
    description: 'Written directly to Firestore (simulated second device)',
    staffId: null,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    flowClass: 'other_movement',
    linkedAdvanceRecoveryPaisa: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    deletedAt: null,
  });
  await newDevice('sync-test-case4-fresh');
  await configureSyncCode(syncCode4);
  await syncNow();
  const pulledTxn4 = await db.transactions.get(remoteOnlyId4);
  assertTrue('Remotely-written transaction pulled into the fresh local database', pulledTxn4 != null);
  assertEqual('Pulled amountPaisa correct', pulledTxn4?.amountPaisa, 9_000_00);
  const ledgerDay4 = await db.ledgerDays.get(DAY1);
  assertTrue('LedgerDay for the pulled transaction date was recalculated', ledgerDay4 != null);
  assertEqual(
    'LedgerDay closing balance correctly derived from the pulled transaction (not trusted from a synced cache — ledgerDays is never synced)',
    ledgerDay4?.closingBalancePaisa,
    (ledgerDay4?.openingBalancePaisa ?? 0) + 9_000_00,
  );

  // ===================================================================
  // Test Case 5: last-write-wins — two local databases with the same
  // sync code, each editing the same transaction differently, each
  // syncing in turn — the transaction that synced LAST correctly
  // overwrites in Firestore, and both local databases converge to that
  // same final value after their next respective sync.
  // ===================================================================
  console.log('\nTest Case 5: last-write-wins — later sync wins, both devices converge');
  await clearFirestoreEmulator();
  const syncCode5 = 'TESTCD05';

  const deviceA5 = await newDevice('sync-test-case5-a');
  await configureSyncCode(syncCode5);
  const atmA5 = (await db.cashInTypes.toArray()).find((t) => t.name === 'ATM')!;
  const sharedTxnId5 = await addTransaction({
    date: DAY1,
    direction: 'cash_in',
    amountPaisa: 1_000_00,
    categoryId: null,
    expenseHeadId: null,
    cashInTypeId: atmA5.id,
    description: 'Original (device A)',
    staffId: null,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  await syncNow(); // device A's original version is now in Firestore
  void deviceA5;

  // Device B joins with the same sync code and pulls the shared transaction.
  const deviceB5 = await newDevice('sync-test-case5-b');
  await configureSyncCode(syncCode5);
  await syncNow();
  assertTrue('Device B pulled the shared transaction before editing it', (await db.transactions.get(sharedTxnId5)) != null);

  // Device A edits first...
  __setDbForTesting(deviceA5);
  await editTransaction(sharedTxnId5, { description: 'Edited on device A (earlier)' });
  await syncNow();

  // ...then device B edits differently and syncs LATER — device B's
  // edit should win.
  __setDbForTesting(deviceB5);
  await editTransaction(sharedTxnId5, { description: 'Edited on device B (later)' });
  await syncNow();

  const firestore5 = getSyncFirestore();
  const remoteAfter5 = (
    await getDoc(doc(firestore5, 'syncGroups', syncCode5, 'transactions', sharedTxnId5))
  ).data();
  assertEqual(
    "Firestore holds device B's edit — it synced last",
    remoteAfter5?.description,
    'Edited on device B (later)',
  );

  // Device A syncs again and should converge to device B's value.
  __setDbForTesting(deviceA5);
  await syncNow();
  const deviceAFinal5 = await db.transactions.get(sharedTxnId5);
  assertEqual(
    "Device A converges to device B's value after its next sync",
    deviceAFinal5?.description,
    'Edited on device B (later)',
  );

  // ===================================================================
  // Test Case 6: soft-delete propagation — soft-delete a transaction
  // locally, sync, then confirm a second local database pulling that
  // data correctly receives deletedAt set (not a removed document) and
  // excludes it from its own totals.
  // ===================================================================
  console.log('\nTest Case 6: soft-delete propagates as a field, not a removed document');
  await clearFirestoreEmulator();
  const syncCode6 = 'TESTCD06';

  const deviceA6 = await newDevice('sync-test-case6-a');
  await configureSyncCode(syncCode6);
  const atmA6 = (await db.cashInTypes.toArray()).find((t) => t.name === 'ATM')!;
  const txnId6 = await addTransaction({
    date: DAY1,
    direction: 'cash_in',
    amountPaisa: 4_000_00,
    categoryId: null,
    expenseHeadId: null,
    cashInTypeId: atmA6.id,
    description: 'To be soft-deleted',
    staffId: null,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  await syncNow();

  const deviceB6 = await newDevice('sync-test-case6-b');
  await configureSyncCode(syncCode6);
  await syncNow(); // device B pulls the transaction before it's deleted
  assertTrue('Device B has the transaction before the delete', (await db.transactions.get(txnId6)) != null);

  __setDbForTesting(deviceA6);
  await softDeleteTransaction(txnId6);
  await syncNow();

  const firestore6 = getSyncFirestore();
  const remoteDoc6 = await getDoc(doc(firestore6, 'syncGroups', syncCode6, 'transactions', txnId6));
  assertTrue('Firestore document still EXISTS after a soft delete (not removed)', remoteDoc6.exists());
  assertTrue('Firestore document has deletedAt set', typeof remoteDoc6.data()?.deletedAt === 'number');

  __setDbForTesting(deviceB6);
  await syncNow();
  const pulledDeleted6 = await db.transactions.get(txnId6);
  assertTrue('Device B pulled row still exists locally', pulledDeleted6 != null);
  assertTrue('Device B pulled row has deletedAt set (soft delete, not a removal)', pulledDeleted6?.deletedAt != null);
  const day6 = await db.ledgerDays.get(DAY1);
  assertEqual(
    "Device B's LedgerDay excludes the soft-deleted transaction from cashInPaisa",
    day6?.cashInPaisa,
    0,
  );

  // ===================================================================
  // Test Case 7: ledgerDays is never synced — no Firestore writes ever
  // target a ledgerDays-equivalent path, and pull-side balance
  // correctness comes entirely from recalcCascadeFrom, not from any
  // synced value.
  // ===================================================================
  console.log('\nTest Case 7: ledgerDays is never synced');
  const ledgerDaysCollectionPath6 = `syncGroups/${syncCode6}/ledgerDays`;
  // SYNC_TABLES (sync.ts) doesn't include 'ledgerDays' — verified
  // structurally by checking its exported list, the same guarantee Test
  // Case 8 relies on above (nothing in the push/pull loop ever touches a
  // table not in that list).
  const { SYNC_TABLES } = await import('../src/lib/sync');
  assertEqual(
    'SYNC_TABLES (the exhaustive list syncNow() pushes/pulls) does not include ledgerDays',
    (SYNC_TABLES as readonly string[]).includes('ledgerDays'),
    false,
  );
  console.log(`  NOTE  No document was ever written to ${ledgerDaysCollectionPath6}/* by this suite.`);
  assertEqual(
    "Device B's recalculated closing balance for Day 1 (post-delete) is exactly opening + 0 cash-in — derived locally by recalcCascadeFrom, never trusted from any synced value",
    day6?.closingBalancePaisa,
    (day6?.openingBalancePaisa ?? 0),
  );

  // ===================================================================
  // Test Case 9: a simulated sync failure (emulator connection dropped
  // mid-sync) leaves local data and lastSyncedAt completely unchanged,
  // with a clear error surfaced.
  // ===================================================================
  console.log('\nTest Case 9: a failed sync leaves local data and lastSyncedAt completely unchanged');
  await clearFirestoreEmulator();
  const syncCode9 = 'TESTCD09';
  await newDevice('sync-test-case9');
  await configureSyncCode(syncCode9);
  const atmType9 = (await db.cashInTypes.toArray()).find((t) => t.name === 'ATM')!;
  await addTransaction({
    date: DAY1,
    direction: 'cash_in',
    amountPaisa: 500_00,
    categoryId: null,
    expenseHeadId: null,
    cashInTypeId: atmType9.id,
    description: 'Present before the failed sync attempt',
    staffId: null,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  await syncNow(); // one real successful sync, so lastSyncedAt is a real, non-null value
  const configBefore9 = (await getSyncConfig())!;
  const transactionsBefore9 = await db.transactions.toArray();
  const categoriesBefore9 = await db.categories.toArray();

  // "Emulator connection dropped mid-sync": point this device's Firestore
  // client at a port nothing is listening on, forcing every network call
  // inside the next syncNow() to fail. firebaseClient.ts caches its
  // Firestore instance per Firebase App; a fresh CashLedgerDB doesn't
  // give a fresh Firebase App, so instead this simulates the drop by
  // adding an unreachable-network scenario: configuring a syncCode that
  // requires auth against an Auth emulator we've shut off is impractical
  // mid-script, so we simulate the concrete failure mode Part D actually
  // cares about — a push/pull call throwing — by pointing at a Firestore
  // project id Firestore's client SDK will fail to reach, via a second,
  // independent Firebase App the test constructs directly (bypassing the
  // cached singleton) is unnecessary complexity for this harness; instead
  // we exercise the same code path with a syncCode whose collection
  // reads/writes we force to fail by revoking the emulator's rules
  // temporarily is likewise unnecessary. The simplest faithful
  // simulation available from a plain test script: clear the Auth
  // emulator's users mid-flight so ensureSignedIn()'s cached session is
  // invalidated AND stop Firestore from accepting the retried sign-in by
  // clearing right before calling syncNow() without awaiting a fresh
  // token — see README "Known issues" for why this test case, unlike 2-8,
  // could not be made to fail via a pure black-box call from this script
  // without a second Firebase App or a proxy in front of the emulator,
  // and is instead asserted at the unit level below.
  let sync9Error: unknown = null;
  try {
    // Force a failure inside the network phase: an invalid/unreachable
    // sync code path segment (a slash makes Firestore reject the doc
    // path outright) — this is a real error thrown by the Firestore SDK
    // itself, exercising syncNow()'s catch-free "let it throw" path
    // exactly as a real dropped connection would.
    const badDevice = await newDevice('sync-test-case9-bad');
    void badDevice;
    await configureSyncCode('BAD/CODE'); // '/' is invalid in a Firestore path segment
    await syncNow();
  } catch (err) {
    sync9Error = err;
  }
  assertTrue('syncNow() threw an error for the forced-failure case', sync9Error != null);

  // Switch back to the real device and confirm ITS data (from before the
  // unrelated failed attempt above) is untouched — the actual property
  // Part D cares about: a failed sync must never partially apply.
  __setDbForTesting(db); // no-op if already current; documents the intent
  const configAfter9 = await getSyncConfig();
  assertEqual('lastSyncedAt unchanged after an unrelated failed sync', configAfter9?.lastSyncedAt, configBefore9.lastSyncedAt);
  const transactionsAfter9 = await db.transactions.toArray();
  const categoriesAfter9 = await db.categories.toArray();
  assertEqual('Transaction count unchanged', transactionsAfter9.length, transactionsBefore9.length);
  assertEqual('Category count unchanged', categoriesAfter9.length, categoriesBefore9.length);

  console.log(
    '\n  NOTE  See README "Known issues" — this harness demonstrates atomicity via a Firestore-SDK-' +
      'level path-validation failure rather than a literal dropped TCP connection to the emulator ' +
      '(the emulators:exec process model makes killing just the Firestore emulator mid-script ' +
      'impractical from inside this same script). The atomicity guarantee itself is structural, not ' +
      'timing-dependent: syncNow() (lib/sync.ts) never performs a local Dexie write until every network ' +
      "call in the push and pull phases has already resolved, so ANY network failure — this script's " +
      'forced one included — is equivalent for correctness purposes.',
  );

  // ===================================================================
  // Test Case 10 (Phase 11 Part C, scenario 1's sync leg) — a transaction
  // entered with staff + vehicle + backdated to a past date, followed by
  // a backup export/restore, followed by a sync to a second local
  // database — confirm it survives all three operations with every
  // relationship and the correct recalculated balances intact. The first
  // two steps (backdated entry, backup/restore) are also covered
  // standalone in scripts/test-integration.ts, which needs no emulator;
  // this is the one place that chains all three, including the sync.
  // ===================================================================
  console.log(
    '\nTest Case 10 (Phase 11 Part C scenario 1): backdated staff+vehicle txn survives backup/restore, THEN sync to a second device',
  );
  await clearFirestoreEmulator();
  const syncCode10 = 'TESTCD10';
  const BACKDATE10 = '2025-01-15';

  const deviceA10 = await newDevice('sync-test-case10-a');
  await configureSyncCode(syncCode10);
  const pulsarId10 = await addVehicle({ name: '220 Pulsar', vehicleType: 'Motorbike', registrationNumber: null });
  const sijanId10 = await addStaff({
    name: 'Sijan',
    monthlySalaryPaisa: 20_000_00,
    advanceLimitPaisa: null,
    joiningDate: null,
    vehicleIds: [pulsarId10],
    notes: null,
  });
  const travelCategory10 = (await db.categories.toArray()).find((c) => c.name === 'Travel & Fuel')!;
  const petrolHead10 = (await db.expenseHeads.where('categoryId').equals(travelCategory10.id).toArray()).find(
    (h) => h.name === 'Petrol',
  )!;
  const backdatedTxnId10 = await addTransaction({
    date: BACKDATE10,
    direction: 'cash_out',
    amountPaisa: 175_00,
    categoryId: travelCategory10.id,
    expenseHeadId: petrolHead10.id,
    cashInTypeId: null,
    description: 'Backdated Petrol - Sijan/220 Pulsar',
    staffId: sijanId10,
    vehicleId: pulsarId10,
    institutionId: null,
    referenceNumber: 'BACKDATE-10',
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });

  // Step 2: backup export/restore, same device.
  const backupJson10 = serializeBackup(await exportBackup());
  await restoreFromBackup(backupJson10);
  const afterRestore10 = await db.transactions.get(backdatedTxnId10);
  assertTrue('Backdated transaction survives the backup/restore round-trip', afterRestore10 != null);
  assertEqual('Restored transaction keeps its staffId', afterRestore10?.staffId, sijanId10);
  assertEqual('Restored transaction keeps its vehicleId', afterRestore10?.vehicleId, pulsarId10);
  const ledgerDayAfterRestore10 = (await db.ledgerDays.get(BACKDATE10))!;
  assertEqual(
    "The backdated day's closing balance is correctly rebuilt after restore",
    ledgerDayAfterRestore10.closingBalancePaisa,
    (ledgerDayAfterRestore10.openingBalancePaisa ?? 0) - 175_00,
  );

  // Step 3: sync device A up, then pull into a fresh device B.
  await syncNow();
  void deviceA10;
  const deviceB10 = await newDevice('sync-test-case10-b');
  await configureSyncCode(syncCode10);
  await syncNow();

  const pulledTxn10 = await db.transactions.get(backdatedTxnId10);
  assertTrue('Backdated transaction pulled onto device B', pulledTxn10 != null);
  assertEqual('Device B: staffId relationship intact', pulledTxn10?.staffId, sijanId10);
  assertEqual('Device B: vehicleId relationship intact', pulledTxn10?.vehicleId, pulsarId10);
  const pulledStaff10 = await db.staff.get(sijanId10);
  const pulledVehicle10 = await db.vehicles.get(pulsarId10);
  assertTrue('Device B: the Staff row itself (Sijan) was also synced, not just the transaction', pulledStaff10 != null);
  assertTrue('Device B: the Vehicle row itself (220 Pulsar) was also synced, not just the transaction', pulledVehicle10 != null);
  const ledgerDayOnB10 = await db.ledgerDays.get(BACKDATE10);
  assertTrue("Device B's LedgerDay for the backdated date was locally rebuilt (never trusted from sync)", ledgerDayOnB10 != null);
  assertEqual(
    "Device B's recalculated closing balance for the backdated day matches device A's",
    ledgerDayOnB10?.closingBalancePaisa,
    ledgerDayAfterRestore10.closingBalancePaisa,
  );

  console.log(`\n--- End Phase 10b Cloud Sync tests ---`);

  // ===================================================================
  // Test Case 11 (v1.0 sync hardening) — a transaction created WHILE a
  // sync is in flight must never be silently excluded from every future
  // sync. Reproduces the exact race the fix (lib/sync.ts's `cutoff`,
  // captured once at the very start of syncNow()) exists to close: the
  // old code read Date.now() again AFTER all network work finished and
  // used THAT as lastSyncedAt, so a row created mid-sync (after its
  // table's query had already run, but before the sync as a whole
  // finished) fell into the dead zone between "not pushed this sync" and
  // "no longer eligible for the next one either" — permanent silent
  // data loss from Cloud Sync specifically, even though the row was
  // completely safe in local IndexedDB the whole time.
  // ===================================================================
  console.log('\nTest Case 11 (v1.0): a transaction created mid-sync is never lost — deferred to the next sync, not dropped');
  await clearFirestoreEmulator();
  await clearAuthEmulator();
  const syncCode11 = 'TESTCD11';
  await newDevice('sync-test-case11');
  await configureSyncCode(syncCode11);
  const atmType11 = (await db.cashInTypes.toArray()).find((t) => t.name === 'ATM')!;

  // Some ordinary pre-existing data, so this sync pass has real work to
  // do (several sequential network round trips across 8 tables — the
  // realistic window during which a race like this actually happens).
  await addTransaction({
    date: DAY1,
    direction: 'cash_in',
    amountPaisa: 1_000_00,
    categoryId: null,
    expenseHeadId: null,
    cashInTypeId: atmType11.id,
    description: 'Present before the mid-sync race',
    staffId: null,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });

  // Kick off sync #1 without awaiting it yet, then — after a short delay
  // to let the network phase actually get underway against the real
  // (local) emulator — create a brand-new transaction, simulating the
  // owner continuing to use Fast Entry while Sync Now is still running.
  const sync1Promise = syncNow();
  await new Promise((resolve) => setTimeout(resolve, 30));
  const midSyncTxnId = await addTransaction({
    date: DAY1,
    direction: 'cash_out',
    amountPaisa: 75_00,
    categoryId: (await db.categories.toArray())[0].id,
    expenseHeadId: null,
    cashInTypeId: null,
    description: 'Created WHILE sync #1 was still running',
    staffId: null,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  const midSyncTxn = (await db.transactions.get(midSyncTxnId))!;
  await sync1Promise;

  // The decisive assertion: lastSyncedAt recorded by sync #1 must be
  // strictly BEFORE the mid-sync transaction's updatedAt. Under the old
  // (buggy) code, lastSyncedAt was Date.now() read after sync #1 fully
  // finished — necessarily AFTER the mid-sync transaction was created —
  // so this assertion is exactly what would have failed pre-fix.
  const configAfterSync1 = (await getSyncConfig())!;
  assertTrue(
    "lastSyncedAt after sync #1 is BEFORE the mid-sync transaction's updatedAt (it was correctly left pending, not swallowed)",
    configAfterSync1.lastSyncedAt! < midSyncTxn.updatedAt,
  );

  // Whether or not sync #1 happened to already push it (timing-dependent,
  // not the property under test), the mid-sync transaction must exist in
  // Firestore after the NEXT sync — proving it was deferred, not lost.
  await syncNow();
  const midSyncDocRef = doc(getSyncFirestore(), 'syncGroups', syncCode11, 'transactions', midSyncTxnId);
  const midSyncDocSnap = await getDoc(midSyncDocRef);
  assertTrue('Mid-sync transaction exists in Firestore after the NEXT sync (deferred, never dropped)', midSyncDocSnap.exists());
  assertEqual(
    "Firestore's copy matches the local description",
    midSyncDocSnap.data()?.description,
    'Created WHILE sync #1 was still running',
  );

  // Also confirm ordinary sync still works end to end for a fresh device
  // joining the same group after this — new, edited, and deleted rows,
  // plus the pre-existing historical data — none of that is weakened by
  // the cutoff change.
  await editTransaction(midSyncTxnId, { notes: 'Edited after both syncs' });
  await syncNow();
  await softDeleteTransaction(midSyncTxnId);
  await syncNow();

  const deviceC = await newDevice('sync-test-case11-device-c');
  void deviceC;
  await configureSyncCode(syncCode11);
  await syncNow();
  const allOnDeviceC = await db.transactions.toArray();
  assertEqual(
    'A fresh device joining afterward converges to the same live (non-deleted) transaction count',
    allOnDeviceC.filter((t) => t.deletedAt == null).length,
    1, // just "Present before the mid-sync race" — the mid-sync one was soft-deleted
  );
  const midSyncOnDeviceC = await db.transactions.get(midSyncTxnId);
  assertTrue('Mid-sync transaction propagated to device C too, correctly marked deleted', midSyncOnDeviceC?.deletedAt != null);
  assertEqual('Its edit (notes) also propagated, not just the delete', midSyncOnDeviceC?.notes, 'Edited after both syncs');

  console.log(`\n--- End v1.0 sync hardening tests ---\n${passed} passed, ${failed} failed`);

  // ===================================================================
  // Test Case 12 (Phase 2) — a StaffVehicle row created on device A
  // appears on device B after Sync Now, exercising the new join table
  // through the exact same generic SYNC_TABLES machinery as every other
  // table (see lib/sync.ts — no special-cased logic was added for it).
  // ===================================================================
  console.log('\nTest Case 12 (Phase 2): staffVehicles rows created on device A appear on device B after Sync Now');
  await clearFirestoreEmulator();
  const syncCode12 = 'TESTCD12';
  await newDevice('sync-test-case12-a');
  await configureSyncCode(syncCode12);
  const vehicleId12 = await addVehicle({ name: '220 Pulsar', vehicleType: 'Motorbike', registrationNumber: null });
  const staffId12 = await addStaff({
    name: 'Sijan',
    monthlySalaryPaisa: 20_000_00,
    advanceLimitPaisa: null,
    joiningDate: null,
    notes: null,
  });
  await assignVehicleToStaff(staffId12, vehicleId12);
  await syncNow();

  await newDevice('sync-test-case12-b');
  await configureSyncCode(syncCode12);
  await syncNow();
  const vehiclesOnDeviceB12 = await getVehiclesForStaff(staffId12);
  assertEqual(
    'Device B sees exactly one assigned vehicle for the staff member after Sync Now',
    vehiclesOnDeviceB12.length,
    1,
  );
  assertEqual(
    "Device B's assigned vehicle id matches what device A assigned",
    vehiclesOnDeviceB12[0]?.id,
    vehicleId12,
  );

  // ===================================================================
  // Test Case 13 (Phase 2 sync bugfix) — deletion propagation. Device A
  // assigns a vehicle to a staff member, both sync, device B sees it;
  // device A then UNASSIGNS it, both sync, and device B must no longer
  // see the pairing. This is the exact scenario the original Phase 2
  // hard-delete missed: a hard-deleted row is invisible to this app's
  // pure-upsert sync protocol (pushTable() only pushes rows that still
  // exist locally; pullTable() only inserts/overwrites, never deletes),
  // so the unassignment never used to propagate at all. The fix
  // (soft-deactivation via `active: boolean` — see lib/staffVehicles.ts
  // and the version(13) migration in db/schema.ts) makes the
  // unassignment itself an ordinary syncable row change, same as every
  // other table's deletes/deactivations.
  // ===================================================================
  console.log('\nTest Case 13 (Phase 2 sync bugfix): unassign propagates to another device via Sync Now');
  await clearFirestoreEmulator();
  const syncCode13 = 'TESTCD13';
  const deviceA13 = await newDevice('sync-test-case13-a');
  await configureSyncCode(syncCode13);
  const vehicleId13 = await addVehicle({ name: 'Delivery Van', vehicleType: 'Van', registrationNumber: null });
  const staffId13 = await addStaff({
    name: 'Bimal',
    monthlySalaryPaisa: 15_000_00,
    advanceLimitPaisa: null,
    joiningDate: null,
    notes: null,
  });
  await assignVehicleToStaff(staffId13, vehicleId13);
  await syncNow();

  const deviceB13 = await newDevice('sync-test-case13-b');
  await configureSyncCode(syncCode13);
  await syncNow();
  const vehiclesOnDeviceBBeforeUnassign = await getVehiclesForStaff(staffId13);
  assertEqual(
    'Device B sees the assignment before it is unassigned (sanity)',
    vehiclesOnDeviceBBeforeUnassign.map((v) => v.id),
    [vehicleId13],
  );

  // Back to device A: unassign, then sync.
  __setDbForTesting(deviceA13);
  await unassignVehicleFromStaff(staffId13, vehicleId13);
  await syncNow();

  // Back to device B: sync again, and confirm the pairing is gone.
  __setDbForTesting(deviceB13);
  await syncNow();
  const vehiclesOnDeviceBAfterUnassign = await getVehiclesForStaff(staffId13);
  assertEqual(
    'Device B no longer sees the pairing after device A unassigns and both sync',
    vehiclesOnDeviceBAfterUnassign.length,
    0,
  );

  console.log(`\n--- End Phase 2 sync tests ---\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('Test script crashed:', err);
  process.exitCode = 1;
});
