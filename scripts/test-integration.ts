// Phase 11 Part B & Part C (local-only portions): cross-phase integration
// tests, run against fake-indexeddb — no Firebase emulator needed for
// anything in this file. The Part C scenario 1's "...followed by a sync
// to a second local database" leg needs the Firestore emulator and is
// appended to scripts/test-sync.ts (Test Case 10) instead; everything
// else in Part C, and all of Part B, is fully covered and executed here.
//
// Usage: tsx scripts/test-integration.ts (also wired up as part of
// `npm run test:all` — see package.json).

import 'fake-indexeddb/auto';
import { seedReferenceData } from '../src/db/schema';
import { db } from '../src/db/schema';
import { addTransaction, editTransaction, softDeleteTransaction } from '../src/lib/ledger';
import { addStaff, getAdvanceReferenceIds, getOutstandingAdvance, setStaffActive } from '../src/lib/staff';
import { addVehicle, getPetrolExpenseHead, setVehicleActive } from '../src/lib/vehicles';
import { addInstitution, getDepositReferenceIds, setInstitutionActive } from '../src/lib/institutions';
import { addExpenseHead, setExpenseHeadActive } from '../src/lib/referenceData';
import { getExpenseHeadTotals, getVehicleTotals, getInstitutionTotals } from '../src/lib/aggregation';
import { setBudget, getBudgetStatusForHead } from '../src/lib/budgets';
import { getDashboardData, getMonthlyExpenseTableData, getPetrolTableData, getInstitutionReportData } from '../src/lib/reports';
import { exportBackup, restoreFromBackup, serializeBackup } from '../src/lib/backup';

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

async function main() {
  await seedReferenceData();

  // ===================================================================
  // PART B — master spec §38's exact worked scenario, as one integration
  // test proving "enter once, appears everywhere" end-to-end.
  // ===================================================================
  console.log('\n--- Part B: master spec §38 end-to-end acceptance scenario ---');

  // v1.0 Nepali BS Edition: moved from 2026-08-04 (BS 2083 Shrawan 19 —
  // the PREVIOUS BS month relative to NOW's BS Bhadra 4, not current) to
  // 2026-08-18 (BS 2083 Bhadra 2 — the real current BS month, still
  // on-or-before NOW's "today").
  const DATE = '2026-08-18'; // BS 2083 Bhadra 2
  const NOW = new Date(2026, 7, 20); // Aug 20, 2026 = BS 2083 Bhadra 4 -> "current month" = BS Bhadra, same convention Phase 5's own worked-example test uses

  const categories = await db.categories.toArray();
  const cashInTypes = await db.cashInTypes.toArray();
  const foodCategory = categories.find((c) => c.name === 'Food')!;
  const travelCategory = categories.find((c) => c.name === 'Travel & Fuel')!;
  const stationeryCategory = categories.find((c) => c.name === 'Stationery')!;
  const atmType = cashInTypes.find((t) => t.name === 'ATM')!;

  const expenseHeadsBefore = await db.expenseHeads.where('categoryId').equals(foodCategory.id).toArray();
  const khajaHead = expenseHeadsBefore.find((h) => h.name === 'Khaja')!;
  const petrolHead = (await getPetrolExpenseHead())!;
  const stationeryHeadId = await addExpenseHead(stationeryCategory.id, 'Stationery');

  const advanceRefs = (await getAdvanceReferenceIds())!;
  const depositRefs = (await getDepositReferenceIds())!;

  const pulsarId = await addVehicle({ name: '220 Pulsar', vehicleType: 'Motorbike', registrationNumber: 'BA 12 PA 3456' });
  const sijanId = await addStaff({
    name: 'Sijan',
    monthlySalaryPaisa: 20_000_00,
    advanceLimitPaisa: null,
    joiningDate: null,
    vehicleIds: [pulsarId],
    notes: null,
  });
  const dhanodayaId = await addInstitution({ name: 'Dhanodaya' });

  // Set up Day 1's opening balance: Rs. 20,000.
  await addTransaction({
    date: DATE,
    direction: 'cash_in',
    amountPaisa: 20_000_00,
    categoryId: null,
    expenseHeadId: null,
    cashInTypeId: cashInTypes.find((t) => t.name === 'Owner Cash')!.id,
    description: 'Opening cash',
    staffId: null,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: 'Starting balance',
    linkedAdvanceRecoveryPaisa: null,
  });
  const openingDay = (await db.ledgerDays.get(DATE))!;
  assertEqual('Opening balance for the day is Rs. 20,000 (2,000,000 paisa)', openingDay.closingBalancePaisa, 20_000_00);

  // Cash In — ATM Rs. 10,000.
  await addTransaction({
    date: DATE,
    direction: 'cash_in',
    amountPaisa: 10_000_00,
    categoryId: null,
    expenseHeadId: null,
    cashInTypeId: atmType.id,
    description: 'ATM withdrawal',
    staffId: null,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });

  // Cash Out — Khaja Rs. 300.
  await addTransaction({
    date: DATE,
    direction: 'cash_out',
    amountPaisa: 300_00,
    categoryId: foodCategory.id,
    expenseHeadId: khajaHead.id,
    cashInTypeId: null,
    description: 'Khaja',
    staffId: null,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });

  // Cash Out — Petrol Rs. 220, vehicle 220 Pulsar.
  await addTransaction({
    date: DATE,
    direction: 'cash_out',
    amountPaisa: 220_00,
    categoryId: travelCategory.id,
    expenseHeadId: petrolHead.id!,
    cashInTypeId: null,
    description: 'Petrol',
    staffId: sijanId,
    vehicleId: pulsarId,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });

  // Cash Out — Stationery Rs. 1,000.
  await addTransaction({
    date: DATE,
    direction: 'cash_out',
    amountPaisa: 1_000_00,
    categoryId: stationeryCategory.id,
    expenseHeadId: stationeryHeadId,
    cashInTypeId: null,
    description: 'Stationery',
    staffId: null,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });

  // Cash Out — Dhanodaya deposit Rs. 5,000.
  await addTransaction({
    date: DATE,
    direction: 'cash_out',
    amountPaisa: 5_000_00,
    categoryId: depositRefs.savingsCategoryId,
    expenseHeadId: depositRefs.depositExpenseHead.id!,
    cashInTypeId: null,
    description: 'Deposit to Dhanodaya',
    staffId: null,
    vehicleId: null,
    institutionId: dhanodayaId,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });

  // Cash Out — Sijan advance Rs. 3,000.
  await addTransaction({
    date: DATE,
    direction: 'cash_out',
    amountPaisa: 3_000_00,
    categoryId: advanceRefs.staffCategory.id!,
    expenseHeadId: advanceRefs.advanceExpenseHead.id!,
    cashInTypeId: null,
    description: 'Advance - Sijan',
    staffId: sijanId,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });

  const day = (await db.ledgerDays.get(DATE))!;
  assertEqual('Cash In (excl. opening) = Rs. 10,000 (1,000,000 paisa)', day.cashInPaisa - 20_000_00, 10_000_00);
  const cashOutTotal = 300_00 + 220_00 + 1_000_00 + 5_000_00 + 3_000_00;
  assertEqual('Cash Out total = Rs. 9,520 (952,000 paisa), hand-summed', cashOutTotal, 9_520_00);
  assertEqual('Cash Out total from LedgerDay matches the hand-summed figure', day.cashOutPaisa, cashOutTotal);
  assertEqual(
    'Closing = Rs. 20,480 (2,048,000 paisa): 20,000 opening + 10,000 in − 9,520 out',
    day.closingBalancePaisa,
    20_000_00 + 10_000_00 - cashOutTotal,
  );

  const khajaTotals = await getExpenseHeadTotals(khajaHead.id, NOW);
  assertTrue("Khaja's August diary total includes the 300", khajaTotals.currentMonthPaisa >= 300_00);

  const petrolTotals = await getExpenseHeadTotals(petrolHead.id!, NOW);
  assertTrue("Petrol's August diary total includes the 220", petrolTotals.currentMonthPaisa >= 220_00);

  const pulsarTotals = await getVehicleTotals(pulsarId, petrolHead.id!, NOW);
  assertTrue("220 Pulsar's own August Petrol total includes the 220", pulsarTotals.petrol.currentMonthPaisa >= 220_00);

  const stationeryTotals = await getExpenseHeadTotals(stationeryHeadId, NOW);
  assertTrue("Stationery's August total includes the 1,000", stationeryTotals.currentMonthPaisa >= 1_000_00);

  const dhanodayaTotals = await getInstitutionTotals(dhanodayaId, NOW);
  assertTrue("Dhanodaya's August deposit total includes the 5,000", dhanodayaTotals.deposits.currentMonthPaisa >= 5_000_00);

  const sijanOutstandingBefore = await getOutstandingAdvance(sijanId); // 0, nothing recovered yet
  assertEqual("Sijan's outstanding advance increased by exactly 3,000", sijanOutstandingBefore.outstandingPaisa, 3_000_00);

  console.log('\n  §38 scenario summary (all figures in paisa, hand-checked above):');
  console.log(`    Cash In (excl. opening): ${day.cashInPaisa - 20_000_00}`);
  console.log(`    Cash Out: ${day.cashOutPaisa}`);
  console.log(`    Closing: ${day.closingBalancePaisa}`);
  console.log(`    Khaja Aug total (>=): ${khajaTotals.currentMonthPaisa}`);
  console.log(`    Petrol Aug total (>=): ${petrolTotals.currentMonthPaisa}`);
  console.log(`    220 Pulsar Aug Petrol total (>=): ${pulsarTotals.petrol.currentMonthPaisa}`);
  console.log(`    Stationery Aug total (>=): ${stationeryTotals.currentMonthPaisa}`);
  console.log(`    Dhanodaya Aug deposit total (>=): ${dhanodayaTotals.deposits.currentMonthPaisa}`);
  console.log(`    Sijan outstanding advance: ${sijanOutstandingBefore.outstandingPaisa}`);

  // ===================================================================
  // PART C, scenario 1 (local-only portion) — backdated transaction with
  // staff + vehicle, then a full backup export/restore round-trip.
  // (The "...then synced to a second local database" continuation of
  // this scenario is Test Case 10 in scripts/test-sync.ts — needs the
  // Firestore emulator, so it isn't run here.)
  // ===================================================================
  console.log('\n--- Part C, scenario 1 (local-only): backdated staff+vehicle txn survives backup export/restore ---');
  const BACKDATE = '2025-01-15'; // well before DATE, to exercise the recalc cascade on restore too
  const backdatedTxnId = await addTransaction({
    date: BACKDATE,
    direction: 'cash_out',
    amountPaisa: 175_00,
    categoryId: travelCategory.id,
    expenseHeadId: petrolHead.id!,
    cashInTypeId: null,
    description: 'Backdated Petrol - Sijan/220 Pulsar',
    staffId: sijanId,
    vehicleId: pulsarId,
    institutionId: null,
    referenceNumber: 'BACKDATE-1',
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  const backdatedBefore = (await db.transactions.get(backdatedTxnId))!;
  const dayAfterBackdateBefore = (await db.ledgerDays.get(DATE))!; // recalculated forward from the backdated entry

  const backup = await exportBackup();
  const backupJson = serializeBackup(backup); // same string a real Export/Restore round-trip would use
  const restoreResult = await restoreFromBackup(backupJson);
  assertTrue('Restore succeeds and returns a pre-restore safety snapshot', restoreResult.preRestoreSnapshot != null);

  const backdatedAfter = await db.transactions.get(backdatedTxnId);
  assertTrue('Backdated transaction survives the restore', backdatedAfter != null);
  assertEqual('Restored transaction keeps its staffId', backdatedAfter?.staffId, sijanId);
  assertEqual('Restored transaction keeps its vehicleId', backdatedAfter?.vehicleId, pulsarId);
  assertEqual('Restored transaction keeps its amountPaisa', backdatedAfter?.amountPaisa, backdatedBefore.amountPaisa);
  assertEqual('Restored transaction keeps its date (backdated)', backdatedAfter?.date, BACKDATE);
  const dayAfterRestore = (await db.ledgerDays.get(DATE))!;
  assertEqual(
    "The later day's closing balance is correctly rebuilt after restore (matches pre-restore cascade result)",
    dayAfterRestore.closingBalancePaisa,
    dayAfterBackdateBefore.closingBalancePaisa,
  );

  // ===================================================================
  // PART C, scenario 2 — a budget-exceeded expense head: Dashboard alert
  // and Reports table must agree on the same current-month figure,
  // proven by actually calling both, not assumed from code inspection.
  // ===================================================================
  console.log('\n--- Part C, scenario 2: budget-exceeded head — Dashboard alert vs Reports table agree ---');
  // Stationery so far this "August" = 1,000.00 from Part B above. Set a
  // low budget so it's already over, then add more spend for a clean,
  // unambiguous over-budget figure independent of Part B's.
  await setBudget(stationeryHeadId, 500_00);
  await addTransaction({
    date: DATE,
    direction: 'cash_out',
    amountPaisa: 800_00,
    categoryId: stationeryCategory.id,
    expenseHeadId: stationeryHeadId,
    cashInTypeId: null,
    description: 'More stationery (pushes it over budget)',
    staffId: null,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });

  const reportsTable = await getMonthlyExpenseTableData(NOW);
  const stationeryReportRow = reportsTable.rows.find((r) => r.expenseHeadId === stationeryHeadId)!;
  const stationeryReportsCurrentMonth = stationeryReportRow.monthTotals[stationeryReportRow.monthTotals.length - 1];

  const budgetStatus = (await getBudgetStatusForHead(stationeryHeadId, NOW))!;
  assertEqual('Stationery budget status reports tier = over', budgetStatus.tier, 'over');
  assertEqual(
    "Budget status's spentPaisa matches the Reports table's current-month figure for the same head",
    budgetStatus.spentPaisa,
    stationeryReportsCurrentMonth,
  );

  const dashboard = await getDashboardData(NOW);
  const dashboardAlert = dashboard.alerts.budgetAlerts.find((a) => a.expenseHeadId === stationeryHeadId);
  assertTrue('Dashboard surfaces a budget alert for Stationery', dashboardAlert != null);
  assertEqual('Dashboard alert tier = over', dashboardAlert?.tier, 'over');
  assertEqual(
    "Dashboard alert's percentage matches Settings' budget status percentage exactly (same computeBudgetStatuses() call, not two implementations)",
    dashboardAlert?.percentage,
    budgetStatus.percentage,
  );
  assertEqual(
    'Reports table current-month Stationery total = 1,800 (1,000 from Part B + 800 here)',
    stationeryReportsCurrentMonth,
    1_800_00,
  );

  // ===================================================================
  // PART C, scenario 3 — deactivating a staff member, vehicle, AND
  // institution that each have real transaction history: Reports
  // includes them, entry-form-dropdown-equivalent active-only queries
  // exclude them, simultaneously, with no leakage either way.
  // ===================================================================
  console.log('\n--- Part C, scenario 3: deactivated entities — Reports include them, active-only queries exclude them ---');
  await setStaffActive(sijanId, false);
  await setVehicleActive(pulsarId, false);
  await setInstitutionActive(dhanodayaId, false);

  // Entry-form-dropdown-equivalent queries (same active-only filters
  // src/hooks/useLedger.ts's useActiveStaff/useActiveVehicles/
  // useActiveInstitutions hooks use) correctly exclude them now.
  const activeStaffIds = (await db.staff.filter((s) => s.active).toArray()).map((s) => s.id);
  const activeVehicleIds = (await db.vehicles.filter((v) => v.active).toArray()).map((v) => v.id);
  const activeInstitutionIds = (await db.financialInstitutions.filter((i) => i.active).toArray()).map((i) => i.id);
  assertEqual('Deactivated Sijan is excluded from the active-staff (dropdown) query', activeStaffIds.includes(sijanId), false);
  assertEqual('Deactivated 220 Pulsar is excluded from the active-vehicle (dropdown) query', activeVehicleIds.includes(pulsarId), false);
  assertEqual('Deactivated Dhanodaya is excluded from the active-institution (dropdown) query', activeInstitutionIds.includes(dhanodayaId), false);

  // Reports (Phase 7) deliberately include inactive entities — their
  // historical spend is still real spend.
  const petrolTable = await getPetrolTableData(NOW);
  const pulsarRow = petrolTable.rows.find((r) => r.vehicleId === pulsarId);
  assertTrue('Petrol report table still has a row for the deactivated 220 Pulsar', pulsarRow != null);
  assertEqual("Deactivated 220 Pulsar's row is flagged inactive (not silently dropped)", pulsarRow?.active, false);
  assertTrue(
    "220 Pulsar's Petrol report row still reflects its real spend (>0) despite being deactivated",
    (pulsarRow?.yearToDatePaisa ?? 0) > 0,
  );

  const institutionTable = await getInstitutionReportData(NOW);
  const dhanodayaRow = institutionTable.rows.find((r) => r.institutionId === dhanodayaId);
  assertTrue('Institution report table still has a row for the deactivated Dhanodaya', dhanodayaRow != null);
  assertEqual("Deactivated Dhanodaya's row is flagged inactive (not silently dropped)", dhanodayaRow?.active, false);
  assertTrue(
    "Dhanodaya's institution report row still reflects its real deposit history (>0) despite being deactivated",
    (dhanodayaRow?.depositYtdPaisa ?? 0) > 0,
  );

  // Sijan's own outstanding-advance figure (his profile view) is still
  // correctly computed even though he's now inactive — deactivation
  // never erases or corrupts historical financial data.
  const sijanOutstandingAfterDeactivation = await getOutstandingAdvance(sijanId);
  assertEqual(
    "Deactivated Sijan's outstanding advance is still correctly resolvable (unchanged by deactivation)",
    sijanOutstandingAfterDeactivation.outstandingPaisa,
    sijanOutstandingBefore.outstandingPaisa,
  );

  // Dashboard's outstandingStaffAdvancesPaisa deliberately sums ACTIVE
  // staff only (see reports.ts doc comment) — confirm Sijan's advance
  // drops OUT of that particular sum now that he's inactive, which is
  // the intentional, opposite-direction behavior from the Reports tables
  // above, proven simultaneously rather than assumed.
  const dashboardAfterDeactivation = await getDashboardData(NOW);
  assertEqual(
    "Dashboard's active-staff-only outstanding-advances sum excludes the now-inactive Sijan's advance (0 active staff have advances)",
    dashboardAfterDeactivation.thisMonth.outstandingStaffAdvancesPaisa,
    0,
  );

  // Cleanup: reactivate the custom expense head this file added, so it
  // doesn't matter either way — no assertion depends on this, just
  // hygiene for anyone reading state after this script.
  await setExpenseHeadActive(stationeryHeadId, true);

  console.log(`\n--- End Phase 11 integration tests ---\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('Integration test script crashed:', err);
  process.exitCode = 1;
});
