// Phase 2: standalone verification script for the new many-to-many
// staff<->vehicle join table (StaffVehicle / lib/staffVehicles.ts) and
// everything downstream of it (resolveAssignedVehicleId's ask-don't-guess
// rule, backup/restore, and a real-data migration regression).
//
// Runs entirely against fake-indexeddb — no Firebase emulator needed.
// (The Phase 2 SYNC_TABLES/cross-device coverage lives in
// scripts/test-sync.ts's Test Case 12 instead, since that genuinely does
// need the emulator.)
//
// Usage: tsx scripts/test-staff-vehicles.ts (wired up as part of
// `npm run test:all` — see package.json's new "test:staff-vehicles").
//
// NOTE on Test Case 9 (real-data regression): the EXACT SCOPE document
// referenced a supplied `cash-ledger-backup-2026-09-15.json` containing
// the real staff/vehicle names to seed this test with. No such file was
// actually present in the delivered ZIP — see the Phase 2 changelog.
// This test seeds the exact names given in the spec text itself (staff
// "SABIN ACHARYA", vehicle "PULSAR 150") directly, rather than silently
// substituting different names.
//
// Phase 2 SYNC BUGFIX: added Bugfix Test Cases B1-B6, covering the
// switch from hard-delete to soft-delete (`active: boolean`) on
// unassign — see the version(13) migration in db/schema.ts and
// lib/staffVehicles.ts. Test Case 13 in scripts/test-sync.ts covers the
// actual cross-device deletion-propagation scenario this was all for
// (the emulator-only half of this fix's own required test coverage).

import 'fake-indexeddb/auto';
import Dexie, { type Table } from 'dexie';
import { CashLedgerDB, db, seedReferenceData } from '../src/db/schema';
import { addStaff, resolveAssignedVehicleId } from '../src/lib/staff';
import { addVehicle } from '../src/lib/vehicles';
import {
  assignVehicleToStaff,
  getStaffForVehicle,
  getVehiclesForStaff,
  unassignVehicleFromStaff,
} from '../src/lib/staffVehicles';
import { exportBackup, restoreFromBackup, serializeBackup, validateBackupPayload } from '../src/lib/backup';

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

async function main() {
  await seedReferenceData();

  console.log('\n--- Phase 2 staff<->vehicle join table tests ---\n');

  // ===================================================================
  // Setup: two vehicles, one staff member.
  // ===================================================================
  const pulsarId = await addVehicle({ name: '220 Pulsar', vehicleType: 'Motorbike', registrationNumber: null });
  const vanId = await addVehicle({ name: 'Delivery Van', vehicleType: 'Van', registrationNumber: null });
  const sijanId = await addStaff({
    name: 'Sijan',
    monthlySalaryPaisa: 20_000_00,
    advanceLimitPaisa: null,
    joiningDate: null,
    notes: null,
  });

  // ===================================================================
  // Test Case 2: assignVehicleToStaff() twice with the same pair does
  // not create a duplicate row.
  // ===================================================================
  console.log('\nTest Case 2: no duplicate (staffId, vehicleId) pairs');
  await assignVehicleToStaff(sijanId, pulsarId);
  await assignVehicleToStaff(sijanId, pulsarId);
  const afterDoubleAssign = await getVehiclesForStaff(sijanId);
  assertEqual('Assigning the same pair twice still results in exactly one row', afterDoubleAssign.length, 1);
  assertEqual('The one assigned vehicle is correct', afterDoubleAssign[0]?.id, pulsarId);
  const rawStaffVehicleRows = await db.staffVehicles.where('staffId').equals(sijanId).toArray();
  assertEqual('Confirmed via a direct table read too (no duplicate rows at the storage level)', rawStaffVehicleRows.length, 1);

  // ===================================================================
  // Test Case 4: a staff member with exactly 1 assigned vehicle — Fast
  // Entry's vehicle-default logic (resolveAssignedVehicleId) still
  // auto-suggests it, unchanged from pre-Phase-2 behavior.
  // ===================================================================
  console.log('\nTest Case 4: exactly 1 assigned vehicle -> still auto-suggested');
  assertEqual('resolveAssignedVehicleId suggests the single assigned vehicle', await resolveAssignedVehicleId(sijanId), pulsarId);

  // ===================================================================
  // Test Case 3: a staff member with 2 assigned vehicles — Fast Entry's
  // vehicle-default logic does NOT auto-fill either one (ask-don't-guess);
  // a picker/selection path remains available (structurally guaranteed —
  // see FastEntryBar.tsx/TransactionFormModal.tsx, whose Vehicle select
  // is never overwritten when resolveAssignedVehicleId returns null, so
  // it stays exactly as user-editable as any other selection).
  // ===================================================================
  console.log('\nTest Case 3: 2+ assigned vehicles -> no auto-fill, ask-don\'t-guess');
  await assignVehicleToStaff(sijanId, vanId);
  const afterSecondAssign = await getVehiclesForStaff(sijanId);
  assertEqual('Staff now has 2 assigned vehicles', afterSecondAssign.length, 2);
  assertEqual(
    'resolveAssignedVehicleId returns null with 2 assigned vehicles (does not guess between them)',
    await resolveAssignedVehicleId(sijanId),
    null,
  );

  // Reverse direction too — getStaffForVehicle().
  const staffForVan = await getStaffForVehicle(vanId);
  assertEqual('getStaffForVehicle() correctly finds Sijan for the Van', staffForVan.map((s) => s.id), [sijanId]);

  // ===================================================================
  // Test Case 5: unassignVehicleFromStaff() removes only the targeted
  // pair, leaving other assignments for that staff member and other
  // staff-vehicle pairs for that vehicle intact.
  // ===================================================================
  console.log('\nTest Case 5: unassign removes only the targeted pair');
  const otherStaffId = await addStaff({
    name: 'Bimal',
    monthlySalaryPaisa: 15_000_00,
    advanceLimitPaisa: null,
    joiningDate: null,
    notes: null,
  });
  await assignVehicleToStaff(otherStaffId, vanId); // Van now shared by Sijan AND Bimal
  await unassignVehicleFromStaff(sijanId, vanId);
  const sijanAfterUnassign = await getVehiclesForStaff(sijanId);
  assertEqual("Sijan's Van assignment is gone", sijanAfterUnassign.map((v) => v.id), [pulsarId]);
  assertEqual('resolveAssignedVehicleId suggests again now that Sijan is back down to 1', await resolveAssignedVehicleId(sijanId), pulsarId);
  const bimalAfterSijansUnassign = await getVehiclesForStaff(otherStaffId);
  assertEqual("Bimal's own Van assignment is untouched by Sijan's unassign", bimalAfterSijansUnassign.map((v) => v.id), [vanId]);
  const staffForVanAfter = await getStaffForVehicle(vanId);
  assertEqual('Van now shows only Bimal assigned to it', staffForVanAfter.map((s) => s.id), [otherStaffId]);
  // Clean up Bimal's assignment so it doesn't affect the backup tests below.
  await unassignVehicleFromStaff(otherStaffId, vanId);

  // ===================================================================
  // Bugfix Test Case B1: unassignVehicleFromStaff() soft-deletes — the
  // row itself must still exist in the table (with active: false), never
  // hard-deleted. This is the core of the sync bugfix: a hard-deleted row
  // is invisible to this app's upsert-only sync protocol, so the
  // unassignment would never propagate to another device.
  // ===================================================================
  console.log('\nBugfix Test Case B1: unassign soft-deletes (row still present, active: false)');
  const sijanVanRowAfterUnassign = await db.staffVehicles
    .where('staffId')
    .equals(sijanId)
    .and((sv) => sv.vehicleId === vanId)
    .first();
  assertTrue("Sijan/Van row still exists after unassign (not hard-deleted)", sijanVanRowAfterUnassign != null);
  assertEqual("Sijan/Van row is marked active: false", sijanVanRowAfterUnassign?.active, false);
  const bimalVanRowAfterUnassign = await db.staffVehicles
    .where('staffId')
    .equals(otherStaffId)
    .and((sv) => sv.vehicleId === vanId)
    .first();
  assertTrue("Bimal/Van row also still exists after its own unassign (not hard-deleted)", bimalVanRowAfterUnassign != null);
  assertEqual("Bimal/Van row is marked active: false", bimalVanRowAfterUnassign?.active, false);

  // ===================================================================
  // Bugfix Test Case B2: both query directions correctly omit a
  // deactivated pairing (already exercised above via Test Case 5's
  // assertions on getVehiclesForStaff/getStaffForVehicle — reconfirmed
  // here directly against the now-deactivated Sijan/Van and Bimal/Van
  // rows from B1, since both are inactive at this point).
  // ===================================================================
  console.log('\nBugfix Test Case B2: deactivated pairings are omitted from both query directions');
  assertEqual(
    "getVehiclesForStaff(Sijan) omits the deactivated Van pairing",
    (await getVehiclesForStaff(sijanId)).map((v) => v.id),
    [pulsarId],
  );
  assertEqual(
    "getStaffForVehicle(Van) omits both deactivated pairings (empty)",
    (await getStaffForVehicle(vanId)).map((s) => s.id),
    [],
  );

  // ===================================================================
  // Bugfix Test Case B3: re-assigning a previously-unassigned pair
  // reactivates the SAME row (same id) rather than creating a duplicate.
  // ===================================================================
  console.log('\nBugfix Test Case B3: re-assigning a deactivated pair reactivates the same row');
  const reassignedId = await assignVehicleToStaff(sijanId, vanId);
  assertEqual(
    "Reactivating returns the SAME row id as the original (now-deactivated) row",
    reassignedId,
    sijanVanRowAfterUnassign!.id,
  );
  const rowsForSijanVanAfterReassign = await db.staffVehicles
    .where('staffId')
    .equals(sijanId)
    .and((sv) => sv.vehicleId === vanId)
    .toArray();
  assertEqual(
    "Still exactly one row for the (Sijan, Van) pair after reactivation — no duplicate created",
    rowsForSijanVanAfterReassign.length,
    1,
  );
  assertEqual("Reactivated row is active: true", rowsForSijanVanAfterReassign[0]?.active, true);
  assertEqual(
    "getVehiclesForStaff(Sijan) shows Van again after reactivation",
    (await getVehiclesForStaff(sijanId)).map((v) => v.id).sort(),
    [pulsarId, vanId].sort(),
  );

  // ===================================================================
  // Bugfix Test Case B4: a staff member with one ACTIVE and one
  // DEACTIVATED assignment still counts as having exactly one, and
  // resolveAssignedVehicleId() auto-suggests the single active vehicle
  // rather than treating it as ambiguous (2 rows) or unassigned (0 rows).
  // ===================================================================
  console.log('\nBugfix Test Case B4: one active + one deactivated assignment -> still auto-suggests the active one');
  await unassignVehicleFromStaff(sijanId, vanId); // back to: Pulsar active, Van deactivated
  const rawRowsForSijan = await db.staffVehicles.where('staffId').equals(sijanId).toArray();
  assertEqual('Sijan has 2 raw rows (1 active, 1 deactivated) at the storage level', rawRowsForSijan.length, 2);
  assertEqual(
    'resolveAssignedVehicleId still suggests the single ACTIVE vehicle, not treating the deactivated row as a second candidate',
    await resolveAssignedVehicleId(sijanId),
    pulsarId,
  );

  // ===================================================================
  // Bugfix Test Case B5: migration — a StaffVehicle row created under
  // version 12 (no `active` field at all, the exact shape the version 12
  // upgrade's bulkAdd produces) comes out of the new version 13 migration
  // with `active: true`.
  // ===================================================================
  console.log('\nBugfix Test Case B5: version 12 -> version 13 migration backfills active: true');
  const MIGRATION_B5_DB_NAME = 'phase2-bugfix-active-migration-db';
  await Dexie.delete(MIGRATION_B5_DB_NAME);
  class PreActiveFieldDB extends Dexie {
    staffVehicles!: Table<{ id: string; staffId: string; vehicleId: string; updatedAt: number }, string>;
    constructor(name: string) {
      super(name);
      this.version(12).stores({ staffVehicles: 'id, staffId, vehicleId, updatedAt' });
    }
  }
  const preActiveDb = new PreActiveFieldDB(MIGRATION_B5_DB_NAME);
  await preActiveDb.open();
  await preActiveDb.staffVehicles.add({
    id: 'pre-active-row-uuid',
    staffId: 'pre-active-staff-uuid',
    vehicleId: 'pre-active-vehicle-uuid',
    updatedAt: Date.now(),
  } as any); // deliberately no `active` key — the exact version-12 shape
  preActiveDb.close();

  const migratedActiveDb = new CashLedgerDB(MIGRATION_B5_DB_NAME);
  await migratedActiveDb.open();
  assertEqual(
    'Migration test database reaches the same schema version as the live app',
    migratedActiveDb.verno,
    db.verno,
  );
  const migratedPreActiveRow = await migratedActiveDb.staffVehicles.get('pre-active-row-uuid');
  assertTrue('Pre-version-13 row survived the migration', migratedPreActiveRow != null);
  assertEqual('Pre-version-13 row (no active field) was backfilled to active: true', migratedPreActiveRow?.active, true);
  migratedActiveDb.close();

  // ===================================================================
  // Test Case 6: a backup taken from a pre-Phase-2 database (no
  // staffVehicles key at all) restores successfully, with staffVehicles
  // treated as an empty array — never throws.
  // ===================================================================
  console.log('\nTest Case 6: pre-Phase-2 backup (no staffVehicles key) restores successfully');
  const currentBackup = await exportBackup();
  const prePhase2Backup = { ...currentBackup } as Record<string, unknown>;
  delete prePhase2Backup.staffVehicles; // simulate an export taken before this field existed
  const prePhase2Json = JSON.stringify(prePhase2Backup);

  const preValidation = validateBackupPayload(JSON.parse(prePhase2Json));
  assertTrue(
    'A backup missing only the staffVehicles key still validates (staffVehicles is deliberately not in REQUIRED_TABLE_KEYS)',
    preValidation.valid,
  );

  const assignedBefore6 = (await getVehiclesForStaff(sijanId)).length;
  assertEqual('Sanity: Sijan has 1 assignment before this restore', assignedBefore6, 1);
  await restoreFromBackup(prePhase2Json);
  const staffVehiclesAfterOldRestore = await db.staffVehicles.toArray();
  assertEqual(
    'staffVehicles table is empty after restoring a backup that never had the key (treated as [], not thrown)',
    staffVehiclesAfterOldRestore.length,
    0,
  );
  assertEqual(
    "Sijan's assignment is gone too (it wasn't in the restored backup — same as every other table on a destructive restore)",
    (await getVehiclesForStaff(sijanId)).length,
    0,
  );

  // ===================================================================
  // Test Case 7: full backup/restore round-trip including staffVehicles
  // rows preserves them exactly.
  // ===================================================================
  console.log('\nTest Case 7: full backup/restore round-trip preserves staffVehicles exactly');
  await assignVehicleToStaff(sijanId, pulsarId);
  await assignVehicleToStaff(sijanId, vanId);
  const beforeRoundTrip = (await db.staffVehicles.toArray()).sort((a, b) => a.id.localeCompare(b.id));
  const roundTripBackup = await exportBackup();
  assertEqual('exportBackup() includes both StaffVehicle rows', roundTripBackup.staffVehicles.length, 2);
  const roundTripJson = serializeBackup(roundTripBackup);
  // Clear the table first, so the restore is provably re-populating from
  // the backup file, not just leaving pre-existing rows untouched.
  await db.staffVehicles.clear();
  assertEqual('staffVehicles cleared before restore (sanity)', await db.staffVehicles.count(), 0);
  await restoreFromBackup(roundTripJson);
  const afterRoundTrip = (await db.staffVehicles.toArray()).sort((a, b) => a.id.localeCompare(b.id));
  assertEqual('Restored staffVehicles rows match the pre-backup rows exactly (byte-for-byte)', afterRoundTrip, beforeRoundTrip);

  // ===================================================================
  // Bugfix Test Case B6: backup/restore round-trip preserves
  // active: false on a deactivated link, and a payload whose
  // staffVehicles rows lack `active` entirely (a pre-bugfix-shaped row
  // slipped into an otherwise-current backup) restores it as active.
  // ===================================================================
  console.log('\nBugfix Test Case B6: backup/restore preserves active: false, and defaults a missing per-row active to true');
  await unassignVehicleFromStaff(sijanId, vanId); // Van -> active: false again
  const deactivatedRoundTripBackup = await exportBackup();
  const deactivatedRow = deactivatedRoundTripBackup.staffVehicles.find(
    (sv) => sv.staffId === sijanId && sv.vehicleId === vanId,
  );
  assertEqual('exportBackup() carries the deactivated row with active: false', deactivatedRow?.active, false);

  // Simulate a row from before this bugfix by stripping its `active` key
  // entirely (distinct from Test Case 6 above, which drops the whole
  // staffVehicles KEY — this drops the field on one ROW within an
  // otherwise-current backup).
  const payloadWithLegacyRow = {
    ...deactivatedRoundTripBackup,
    staffVehicles: deactivatedRoundTripBackup.staffVehicles.map((sv) => {
      if (sv.staffId !== sijanId || sv.vehicleId !== pulsarId) return sv;
      const { active: _drop, ...rest } = sv as unknown as Record<string, unknown>;
      return rest;
    }),
  } as unknown as Record<string, unknown>;
  await restoreFromBackup(JSON.stringify(payloadWithLegacyRow));

  const restoredDeactivated = await db.staffVehicles
    .where('staffId')
    .equals(sijanId)
    .and((sv) => sv.vehicleId === vanId)
    .first();
  assertEqual('Restored deactivated row keeps active: false (not reset to active)', restoredDeactivated?.active, false);
  const restoredLegacyRow = await db.staffVehicles
    .where('staffId')
    .equals(sijanId)
    .and((sv) => sv.vehicleId === pulsarId)
    .first();
  assertTrue('Row with active key stripped before restore still restores', restoredLegacyRow != null);
  assertEqual(
    'A restored row with no active field at all is treated as active (getVehiclesForStaff still includes it)',
    (await getVehiclesForStaff(sijanId)).map((v) => v.id),
    [pulsarId],
  );

  // ===================================================================
  // Test Case 9: real-data regression. Seed the exact real staff/vehicle
  // names given in the spec (staff "SABIN ACHARYA", vehicle "PULSAR
  // 150") with a single legacy assignedVehicleId-style link in a
  // pre-Phase-2 database, run the version(12) migration by opening it
  // with the current CashLedgerDB, and confirm SABIN ACHARYA still shows
  // PULSAR 150 as an assigned vehicle afterward — mirroring exactly how
  // scripts/test-ledger.ts's own Phase 10a migration test proves UUID
  // migration end-to-end, but targeted specifically at this real pairing.
  // ===================================================================
  console.log('\nTest Case 9: real-data regression — SABIN ACHARYA / PULSAR 150 survives the version(12) migration');

  // A minimal stand-in for the app's OWN pre-Phase-2 schema (version 11 —
  // the last version before this phase's version(12) bump), using the
  // exact same index strings db/schema.ts's own STAFF_INDEXES_V10 /
  // VEHICLES_INDEXES_V10 constants define (unchanged through version 11 —
  // see that file's own comment on why version 11 doesn't re-list them).
  class PreStaffVehicleDB extends Dexie {
    staff!: Table<{ id: string; name: string; active: boolean; assignedVehicleId: string | null }, string>;
    vehicles!: Table<{ id: string; name: string; active: boolean }, string>;
    constructor(name: string) {
      super(name);
      this.version(11).stores({
        staff: 'id, active, updatedAt, name',
        vehicles: 'id, active, updatedAt, name',
      });
    }
  }

  const REAL_DATA_DB_NAME = 'phase2-real-data-regression-db';
  await Dexie.delete(REAL_DATA_DB_NAME);
  const oldDb = new PreStaffVehicleDB(REAL_DATA_DB_NAME);
  await oldDb.open();

  const realVehicleId = 'real-pulsar-150-uuid'; // stand-in UUID (already-migrated, pre-Phase-2 shape)
  await oldDb.vehicles.add({ id: realVehicleId, name: 'PULSAR 150', active: true } as any);
  const realStaffId = 'real-sabin-acharya-uuid';
  await oldDb.staff.add({
    id: realStaffId,
    name: 'SABIN ACHARYA',
    active: true,
    assignedVehicleId: realVehicleId,
  } as any);
  // Test Case 1's "null -> no row" half, folded into this same seed: a
  // second staff member with no assignment must produce zero
  // StaffVehicle rows, not a row with a null vehicleId.
  const unassignedStaffId = 'real-unassigned-staff-uuid';
  await oldDb.staff.add({
    id: unassignedStaffId,
    name: 'UNASSIGNED STAFF',
    active: true,
    assignedVehicleId: null,
  } as any);
  void unassignedStaffId; // exists purely to seed the null-assignment half of Test Case 1
  oldDb.close();

  const migratedRealDb = new CashLedgerDB(REAL_DATA_DB_NAME);
  await migratedRealDb.open();
  assertEqual('Real-data test database reaches the same schema version as the live app', migratedRealDb.verno, db.verno);

  const migratedSabin = (await migratedRealDb.staff.toArray()).find((s: any) => s.name === 'SABIN ACHARYA');
  assertTrue('SABIN ACHARYA survived the migration', migratedSabin != null);
  const migratedSabinVehicles = (await migratedRealDb.staffVehicles.toArray()).filter(
    (sv: any) => sv.staffId === migratedSabin!.id,
  );
  assertEqual('Exactly one StaffVehicle row was backfilled for SABIN ACHARYA', migratedSabinVehicles.length, 1);
  const migratedPulsar150 = (await migratedRealDb.vehicles.toArray()).find((v: any) => v.name === 'PULSAR 150');
  assertTrue('PULSAR 150 survived the migration', migratedPulsar150 != null);
  assertEqual(
    "SABIN ACHARYA's backfilled StaffVehicle row correctly points to PULSAR 150",
    migratedSabinVehicles[0]?.vehicleId,
    migratedPulsar150!.id,
  );
  const allMigratedStaffVehicles = await migratedRealDb.staffVehicles.toArray();
  assertEqual(
    'Test Case 1 (null half): UNASSIGNED STAFF produced zero StaffVehicle rows — exactly one row total across both seeded staff',
    allMigratedStaffVehicles.length,
    1,
  );
  migratedRealDb.close();

  console.log(`\n--- End Phase 2 staff<->vehicle join table tests ---\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('Test script crashed:', err);
  process.exitCode = 1;
});
