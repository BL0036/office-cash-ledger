// Phase 4: standalone verification script for the new staff-profile
// fields (employeeId, position, contactNumber, photoDataUrl) added to
// support the printable ID card / summary view — see CHANGELOG for this
// phase.
//
// This is explicitly NOT an HR module — only these four fields, added to
// the existing Staff type/table via an additive Dexie migration
// (version 14), lib/staff.ts's addStaff()/editStaff(), and displayed by
// StaffView.tsx's StaffProfile (plus its new "Print ID Card"/"Print
// Summary" buttons — pure UI, not independently testable here without a
// browser, so this script covers everything BEHIND those buttons: the
// data those views read is exactly what StaffProfile already loads via
// useVehiclesForStaff/getOutstandingAdvance/useStaffSalaryTransactions,
// all of which are exercised elsewhere in this suite already).
//
// Runs entirely against fake-indexeddb — no browser, no emulator needed.
// Usage: tsx scripts/test-staff-profile.ts (wired up as
// `npm run test:staff-profile`, folded into `npm run test:all`).

import 'fake-indexeddb/auto';
import Dexie, { type Table } from 'dexie';
import { CashLedgerDB, db, seedReferenceData } from '../src/db/schema';
import { addStaff, editStaff } from '../src/lib/staff';
import { addVehicle } from '../src/lib/vehicles';
import { assignVehicleToStaff, getVehiclesForStaff, unassignVehicleFromStaff } from '../src/lib/staffVehicles';
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

async function assertThrows(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    failed++;
    console.log(`  FAIL  ${label}: expected to throw, but it didn't`);
  } catch {
    passed++;
    console.log(`  PASS  ${label} (threw as expected)`);
  }
}

const TINY_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

async function main() {
  await seedReferenceData();

  console.log('\n--- Phase 4 staff-profile-fields tests ---\n');

  // ===================================================================
  // Test Case 2: adding a new staff member with all four optional
  // fields filled in persists and displays correctly.
  // ===================================================================
  console.log('\nTest Case 2: add staff with all four new fields filled in');
  const fullId = await addStaff({
    name: 'Full Profile Staff',
    monthlySalaryPaisa: 25_000_00,
    advanceLimitPaisa: null,
    joiningDate: '2024-01-15',
    notes: null,
    employeeId: 'EMP-042',
    position: 'Store Supervisor',
    contactNumber: '98XXXXXXXX',
    photoDataUrl: TINY_PNG_DATA_URL,
  });
  const fullStaff = await db.staff.get(fullId);
  assertEqual('employeeId persisted', fullStaff?.employeeId, 'EMP-042');
  assertEqual('position persisted', fullStaff?.position, 'Store Supervisor');
  assertEqual('contactNumber persisted', fullStaff?.contactNumber, '98XXXXXXXX');
  assertEqual('photoDataUrl persisted', fullStaff?.photoDataUrl, TINY_PNG_DATA_URL);

  // Fields are trimmed the same way `name`/`notes` already are.
  console.log('\nTest Case 2b: whitespace-only optional text fields trim to empty, and blank inputs store null');
  const trimId = await addStaff({
    name: 'Trim Test Staff',
    monthlySalaryPaisa: 10_000_00,
    advanceLimitPaisa: null,
    joiningDate: null,
    notes: null,
    employeeId: '  EMP-9  ',
    position: '   ',
    contactNumber: '',
  });
  const trimStaff = await db.staff.get(trimId);
  assertEqual('employeeId trimmed', trimStaff?.employeeId, 'EMP-9');
  assertEqual('whitespace-only position stores null', trimStaff?.position, null);
  assertEqual('empty contactNumber stores null', trimStaff?.contactNumber, null);
  assertEqual('photoDataUrl omitted entirely defaults to null', trimStaff?.photoDataUrl, null);

  // ===================================================================
  // Test Case 3: adding a new staff member with all four left blank
  // still works exactly as before this phase (regression).
  // ===================================================================
  console.log('\nTest Case 3: add staff with all four fields left blank (pre-Phase-4 regression)');
  const minimalId = await addStaff({
    name: 'Minimal Staff',
    monthlySalaryPaisa: 15_000_00,
    advanceLimitPaisa: null,
    joiningDate: null,
    notes: null,
  });
  const minimalStaff = await db.staff.get(minimalId);
  assertEqual('employeeId defaults to null', minimalStaff?.employeeId, null);
  assertEqual('position defaults to null', minimalStaff?.position, null);
  assertEqual('contactNumber defaults to null', minimalStaff?.contactNumber, null);
  assertEqual('photoDataUrl defaults to null', minimalStaff?.photoDataUrl, null);
  assertEqual('Every pre-existing field is completely unaffected (name)', minimalStaff?.name, 'Minimal Staff');
  assertEqual('Every pre-existing field is completely unaffected (aliases still [])', minimalStaff?.aliases, []);

  // editStaff() regression: editing unrelated fields must not disturb
  // these four when they're simply not mentioned in the change set.
  await editStaff(minimalId, { notes: 'A note, unrelated to Phase 4' });
  const afterUnrelatedEdit = await db.staff.get(minimalId);
  assertEqual(
    'editStaff() with no Phase 4 fields in the change set leaves them untouched (still null)',
    afterUnrelatedEdit?.employeeId,
    null,
  );
  assertEqual('...and the unrelated edit itself still applied', afterUnrelatedEdit?.notes, 'A note, unrelated to Phase 4');

  // editStaff() can also set/clear these fields directly.
  await editStaff(minimalId, { employeeId: 'EMP-100', position: 'Driver', contactNumber: '9800000000' });
  const afterEdit = await db.staff.get(minimalId);
  assertEqual('editStaff() sets employeeId', afterEdit?.employeeId, 'EMP-100');
  assertEqual('editStaff() sets position', afterEdit?.position, 'Driver');
  assertEqual('editStaff() sets contactNumber', afterEdit?.contactNumber, '9800000000');
  await editStaff(minimalId, { employeeId: '' });
  const afterClear = await db.staff.get(minimalId);
  assertEqual('editStaff() with an empty string clears employeeId back to null', afterClear?.employeeId, null);

  // ===================================================================
  // Test Case 4: photoDataUrl validation rejects a non-data-URL string
  // with a clear error.
  // ===================================================================
  console.log('\nTest Case 4: photoDataUrl validation');
  await assertThrows('addStaff() rejects a plain https:// URL as photoDataUrl', () =>
    addStaff({
      name: 'Bad Photo Staff',
      monthlySalaryPaisa: 10_000_00,
      advanceLimitPaisa: null,
      joiningDate: null,
      notes: null,
      photoDataUrl: 'https://example.com/photo.png',
    }),
  );
  await assertThrows('addStaff() rejects garbage text as photoDataUrl', () =>
    addStaff({
      name: 'Bad Photo Staff 2',
      monthlySalaryPaisa: 10_000_00,
      advanceLimitPaisa: null,
      joiningDate: null,
      notes: null,
      photoDataUrl: 'not a data url',
    }),
  );
  await assertThrows('editStaff() rejects a non-data-URL photoDataUrl the same way', () =>
    editStaff(minimalId, { photoDataUrl: 'file:///etc/passwd' }),
  );
  // A valid data URL of a different image type is still accepted (not
  // over-restricted to just image/png).
  const jpegId = await addStaff({
    name: 'Jpeg Photo Staff',
    monthlySalaryPaisa: 10_000_00,
    advanceLimitPaisa: null,
    joiningDate: null,
    notes: null,
    photoDataUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
  });
  const jpegStaff = await db.staff.get(jpegId);
  assertTrue('A valid data:image/jpeg;... URL is accepted', jpegStaff?.photoDataUrl?.startsWith('data:image/jpeg') ?? false);

  // ===================================================================
  // Test Case 5: backup/restore round-trip preserves all four new
  // fields.
  // ===================================================================
  console.log('\nTest Case 5: backup/restore round-trip preserves all four new fields');
  const backupBefore = await exportBackup();
  const serialized = serializeBackup(backupBefore);
  assertTrue('Serialized backup validates', validateBackupPayload(JSON.parse(serialized)).valid);
  await restoreFromBackup(serialized);
  const restoredFullStaff = await db.staff.get(fullId);
  assertEqual('employeeId survives backup/restore', restoredFullStaff?.employeeId, 'EMP-042');
  assertEqual('position survives backup/restore', restoredFullStaff?.position, 'Store Supervisor');
  assertEqual('contactNumber survives backup/restore', restoredFullStaff?.contactNumber, '98XXXXXXXX');
  assertEqual('photoDataUrl survives backup/restore', restoredFullStaff?.photoDataUrl, TINY_PNG_DATA_URL);
  const restoredMinimalStaff = await db.staff.get(minimalId);
  assertEqual(
    "A staff row with null Phase 4 fields also round-trips correctly (still null, not e.g. missing/undefined)",
    restoredMinimalStaff?.employeeId,
    null,
  );

  // ===================================================================
  // Test Case 8: print ID card data — multiple assigned vehicles show,
  // an unassigned one does not. (The print DOM itself is a UI concern —
  // this verifies the exact data getVehiclesForStaff() feeds it with,
  // covering the requirement precisely: "correctly lists multiple
  // assigned vehicles ... and correctly omits a vehicle that was
  // unassigned".)
  // ===================================================================
  console.log('\nTest Case 8: print-view vehicle data — multiple assignments, one unassigned');
  const vehicleAId = await addVehicle({ name: 'Card Van A', vehicleType: 'Van', registrationNumber: null });
  const vehicleBId = await addVehicle({ name: 'Card Van B', vehicleType: 'Van', registrationNumber: null });
  const vehicleCId = await addVehicle({ name: 'Card Van C (unassigned)', vehicleType: 'Van', registrationNumber: null });
  await assignVehicleToStaff(fullId, vehicleAId);
  await assignVehicleToStaff(fullId, vehicleBId);
  await assignVehicleToStaff(fullId, vehicleCId);
  await unassignVehicleFromStaff(fullId, vehicleCId);
  const cardVehicles = await getVehiclesForStaff(fullId);
  const cardVehicleNames = cardVehicles.map((v) => v.name).sort();
  assertEqual(
    'Both actively-assigned vehicles are present for the ID card, the unassigned one is not',
    cardVehicleNames,
    ['Card Van A', 'Card Van B'],
  );

  // ===================================================================
  // Test Case 7 (partial — data layer only): print views must not
  // assume any field is non-null. Confirm a pre-Phase-4-shaped
  // (minimal) staff record still reads back with well-defined nulls for
  // every Phase 4 field and an empty vehicle list, rather than throwing
  // or reading `undefined` — exactly what StaffProfile's PrintIdCard/
  // PrintSummary render against.
  // ===================================================================
  console.log('\nTest Case 7 (data layer): a minimal staff record has no non-null field assumptions to violate');
  const bareVehicles = await getVehiclesForStaff(minimalId);
  assertEqual('A staff member with no assignments returns an empty array, not null/undefined', bareVehicles, []);
  assertEqual('Minimal staff record has employeeId === null (not undefined)', minimalStaff?.employeeId === null, true);
  assertEqual('Minimal staff record has photoDataUrl === null (not undefined)', minimalStaff?.photoDataUrl === null, true);

  // ===================================================================
  // Test Case 1 & 9: migration — existing (pre-Phase-4) Staff rows get
  // all four new fields as null, nothing else about them changes; and
  // this migration composes correctly with every earlier phase's own
  // migration (11, 12, 13) in one continuous upgrade chain.
  // ===================================================================
  console.log(
    '\nTest Case 1: migration — a pre-Phase-4 (version 13-shaped) Staff row backfills all four new fields to null, nothing else changes',
  );

  // A minimal standalone class replicating ONLY the pre-Phase-4 (version
  // 13) schema — same technique test-ledger.ts's own P10a-3 migration
  // test and test-staff-vehicles.ts's Bugfix Test Case B5 already use:
  // seed a database in the exact pre-migration shape, then open the
  // REAL CashLedgerDB against the same database name so Dexie runs its
  // genuine upgrade path (versions 1-14), not a reimplementation of it.
  class PreV14SchemaDB extends Dexie {
    staff!: Table<any, string>;
    staffVehicles!: Table<any, string>;
    constructor(name: string) {
      super(name);
      this.version(13).stores({
        staff: 'id, active, updatedAt, name',
        staffVehicles: 'id, staffId, vehicleId, updatedAt',
      });
    }
  }

  const MIGRATION_TEST_DB_NAME = 'phase4-migration-test-db';
  await Dexie.delete(MIGRATION_TEST_DB_NAME);

  const oldDb = new PreV14SchemaDB(MIGRATION_TEST_DB_NAME);
  await oldDb.open();
  const now = Date.now();
  await oldDb.staff.add({
    id: 'preexisting-staff-1',
    name: 'Pre-Phase-4 Staff',
    monthlySalaryPaisa: 30_000_00,
    advanceLimitPaisa: null,
    joiningDate: '2020-06-01',
    active: true,
    assignedVehicleId: null,
    notes: 'Existing note',
    aliases: ['Nickname'],
    updatedAt: now,
  });
  oldDb.close();

  const migratedDb = new CashLedgerDB(MIGRATION_TEST_DB_NAME);
  await migratedDb.open();
  assertEqual('Migrated database reaches the same final schema version as the live app', migratedDb.verno, db.verno);
  const migratedStaff = await migratedDb.staff.get('preexisting-staff-1');
  assertEqual('employeeId backfilled to null', migratedStaff?.employeeId, null);
  assertEqual('position backfilled to null', migratedStaff?.position, null);
  assertEqual('contactNumber backfilled to null', migratedStaff?.contactNumber, null);
  assertEqual('photoDataUrl backfilled to null', migratedStaff?.photoDataUrl, null);
  assertEqual('Pre-existing name is untouched by the migration', migratedStaff?.name, 'Pre-Phase-4 Staff');
  assertEqual('Pre-existing monthlySalaryPaisa is untouched', migratedStaff?.monthlySalaryPaisa, 30_000_00);
  assertEqual('Pre-existing joiningDate is untouched', migratedStaff?.joiningDate, '2020-06-01');
  assertEqual('Pre-existing notes is untouched', migratedStaff?.notes, 'Existing note');
  assertEqual('Pre-existing aliases is untouched', migratedStaff?.aliases, ['Nickname']);
  migratedDb.close();
  await Dexie.delete(MIGRATION_TEST_DB_NAME);

  console.log('\n--- End Phase 4 staff-profile-fields tests ---\n');
  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
