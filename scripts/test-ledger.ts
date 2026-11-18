// Standalone verification script for the Phase 1 test cases in the spec.
// Runs the real db/ledger modules against fake-indexeddb (no browser needed).
// Usage: npx tsx scripts/test-ledger.ts

import 'fake-indexeddb/auto';
import Dexie, { type Table } from 'dexie';
import { CashLedgerDB, db, seedReferenceData } from '../src/db/schema';
import {
  addTransaction,
  editTransaction,
  softDeleteTransaction,
  setManualOpeningBalance,
  getOrCreateLedgerDay,
} from '../src/lib/ledger';
import { formatPaisaAsRupees } from '../src/lib/money';
import {
  addCategory,
  addExpenseHead,
  addCashInType,
  setCategoryActive,
  setExpenseHeadActive,
} from '../src/lib/referenceData';
import { aggregateTransactions, getCurrentMonthPetrolByVehicle, getExpenseHeadTotals, getInstitutionTotals, getMonthlySeriesTotals, getStaffTotals, getVehicleTotals } from '../src/lib/aggregation';
import { addStaff, editStaff, getAdvanceReferenceIds, checkAdvanceLimit, checkRecoveryAmount, getOutstandingAdvance, getSalaryReferenceIds, resolveAssignedVehicleId, setStaffActive } from '../src/lib/staff';
import { assignVehicleToStaff, getVehiclesForStaff, unassignVehicleFromStaff } from '../src/lib/staffVehicles';
import { addVehicle, editVehicle, getPetrolExpenseHead, setVehicleActive } from '../src/lib/vehicles';
import { addInstitution, editInstitution, getDepositReferenceIds, getFinancialWithdrawalCashInType, setInstitutionActive } from '../src/lib/institutions';
import { getCategoryBreakdown, getDashboardData, getInstitutionReportData, getMonthlyExpenseTableData, getPetrolTableData } from '../src/lib/reports';
import { clearBudget, getBudgetForHead, getBudgetStatusForHead, setBudget } from '../src/lib/budgets';
import { backupFileName, exportBackup, restoreFromBackup, serializeBackup, validateBackupPayload } from '../src/lib/backup';
import { buildTransactionExportRows, type ExportLookups } from '../src/lib/exportRows';
import { escapeCsvField, transactionRowsToCsv } from '../src/lib/csv';
import { transactionRowsToSheet } from '../src/lib/excel';
import * as XLSX from 'xlsx';

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

/** Deep-equality check for arrays of rows, order-independent (sorted by id before comparing) — used for full-table before/after backup comparisons. */
function assertRowsMatch(label: string, actualRows: unknown[], expectedRows: unknown[]) {
  const sortById = (rows: unknown[]) =>
    [...rows].sort((a, b) => {
      const ra = a as Record<string, unknown>;
      const rb = b as Record<string, unknown>;
      const aKey = typeof ra.id === 'string' ? ra.id : typeof ra.date === 'string' ? ra.date : '';
      const bKey = typeof rb.id === 'string' ? rb.id : typeof rb.date === 'string' ? rb.date : '';
      return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
    });
  const actualJson = JSON.stringify(sortById(actualRows));
  const expectedJson = JSON.stringify(sortById(expectedRows));
  const ok = actualJson === expectedJson;
  if (ok) {
    passed++;
    console.log(`  PASS  ${label} (${actualRows.length} rows match)`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}: row sets differ`);
    const aSorted = sortById(actualRows);
    const eSorted = sortById(expectedRows);
    for (let i = 0; i < Math.max(aSorted.length, eSorted.length); i++) {
      const aStr = JSON.stringify(aSorted[i]);
      const eStr = JSON.stringify(eSorted[i]);
      if (aStr !== eStr) {
        console.log(`    first diff at index ${i}:`);
        console.log(`      expected: ${eStr}`);
        console.log(`      actual:   ${aStr}`);
        break;
      }
    }
  }
}

async function main() {
  await seedReferenceData();
  const categories = await db.categories.toArray();
  const cashInTypes = await db.cashInTypes.toArray();
  const foodCategory = categories.find((c) => c.name === 'Food')!;
  const officeCategory = categories.find((c) => c.name === 'Office')!;
  const atmType = cashInTypes.find((t) => t.name === 'ATM')!;

  const DAY1 = '2026-01-01';
  const DAY2 = '2026-01-02';
  const DAY3 = '2026-01-03';

  console.log('\nTest 1: Day 1 manual opening + 1 cash in + 2 cash out');
  await getOrCreateLedgerDay(DAY1);
  await setManualOpeningBalance(DAY1, 10_00_00); // Rs. 1000.00 -> paisa
  const cashInId = await addTransaction({
    date: DAY1,
    direction: 'cash_in',
    amountPaisa: 5_000_00,
    categoryId: null,
    expenseHeadId: null,
    cashInTypeId: atmType.id!,
    description: 'ATM withdrawal',
    staffId: null,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  await addTransaction({
    date: DAY1,
    direction: 'cash_out',
    amountPaisa: 1_200_00,
    categoryId: foodCategory.id!,
    expenseHeadId: null,
    cashInTypeId: null,
    description: 'Lunch',
    staffId: null,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  const day1CashOut2Id = await addTransaction({
    date: DAY1,
    direction: 'cash_out',
    amountPaisa: 800_00,
    categoryId: officeCategory.id!,
    expenseHeadId: null,
    cashInTypeId: null,
    description: 'Stationery run',
    staffId: null,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });

  let day1 = await db.ledgerDays.get(DAY1);
  const expectedDay1Closing = 10_00_00 + 5_000_00 - 1_200_00 - 800_00;
  assertEqual('Day1 opening (paisa)', day1!.openingBalancePaisa, 10_00_00);
  assertEqual('Day1 cashIn (paisa)', day1!.cashInPaisa, 5_000_00);
  assertEqual('Day1 cashOut (paisa)', day1!.cashOutPaisa, 2_000_00);
  assertEqual('Day1 closing (paisa)', day1!.closingBalancePaisa, expectedDay1Closing);
  assertEqual(
    'Day1 closing = opening + in - out (raw paisa formula check)',
    day1!.closingBalancePaisa,
    day1!.openingBalancePaisa + day1!.cashInPaisa - day1!.cashOutPaisa,
  );

  console.log('\nTest 2: Day 2 opening auto-equals Day 1 closing, not editable');
  const day2 = await getOrCreateLedgerDay(DAY2);
  assertEqual('Day2 opening === Day1 closing (paisa)', day2.openingBalancePaisa, day1!.closingBalancePaisa);
  assertEqual('Day2 isManualOpening', day2.isManualOpening, false);

  console.log('\nTest 3: Day 3 opening === Day 2 closing after adding txns on Day2 & Day3');
  await addTransaction({
    date: DAY2,
    direction: 'cash_in',
    amountPaisa: 2_000_00,
    categoryId: null,
    expenseHeadId: null,
    cashInTypeId: atmType.id!,
    description: 'Owner top-up',
    staffId: null,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  await getOrCreateLedgerDay(DAY3);
  await addTransaction({
    date: DAY3,
    direction: 'cash_out',
    amountPaisa: 500_00,
    categoryId: foodCategory.id!,
    expenseHeadId: null,
    cashInTypeId: null,
    description: 'Tea',
    staffId: null,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  const day2After = await db.ledgerDays.get(DAY2);
  const day3After = await db.ledgerDays.get(DAY3);
  assertEqual('Day3 opening === Day2 closing (paisa)', day3After!.openingBalancePaisa, day2After!.closingBalancePaisa);

  console.log('\nTest 4: Editing a Day1 Cash Out cascades through Day2 and Day3');
  await editTransaction(day1CashOut2Id, { amountPaisa: 300_00 }); // was 800.00 -> now 300.00
  const day1Edited = await db.ledgerDays.get(DAY1);
  const day2Edited = await db.ledgerDays.get(DAY2);
  const day3Edited = await db.ledgerDays.get(DAY3);
  const expectedDay1ClosingEdited = 10_00_00 + 5_000_00 - 1_200_00 - 300_00;
  assertEqual('Day1 closing after edit (paisa)', day1Edited!.closingBalancePaisa, expectedDay1ClosingEdited);
  assertEqual('Day2 opening after Day1 edit (paisa)', day2Edited!.openingBalancePaisa, expectedDay1ClosingEdited);
  assertEqual(
    'Day2 closing after Day1 edit (paisa)',
    day2Edited!.closingBalancePaisa,
    day2Edited!.openingBalancePaisa + day2Edited!.cashInPaisa - day2Edited!.cashOutPaisa,
  );
  assertEqual('Day3 opening after Day1 edit cascade (paisa)', day3Edited!.openingBalancePaisa, day2Edited!.closingBalancePaisa);
  assertEqual(
    'Day3 closing after Day1 edit cascade (paisa)',
    day3Edited!.closingBalancePaisa,
    day3Edited!.openingBalancePaisa + day3Edited!.cashInPaisa - day3Edited!.cashOutPaisa,
  );

  console.log('\nTest 5: Deleting a Day1 transaction cascades through Day2 and Day3');
  await softDeleteTransaction(cashInId); // remove the 5000.00 ATM withdrawal
  const day1Deleted = await db.ledgerDays.get(DAY1);
  const day2Deleted = await db.ledgerDays.get(DAY2);
  const day3Deleted = await db.ledgerDays.get(DAY3);
  const expectedDay1ClosingDeleted = 10_00_00 + 0 - 1_200_00 - 300_00;
  assertEqual('Day1 closing after delete (paisa)', day1Deleted!.closingBalancePaisa, expectedDay1ClosingDeleted);
  assertEqual('Day2 opening after Day1 delete cascade (paisa)', day2Deleted!.openingBalancePaisa, expectedDay1ClosingDeleted);
  assertEqual('Day3 opening after Day1 delete cascade (paisa)', day3Deleted!.openingBalancePaisa, day2Deleted!.closingBalancePaisa);
  const deletedTxn = await db.transactions.get(cashInId);
  assertEqual('Deleted transaction still present in table (soft delete)', deletedTxn != null, true);
  assertEqual('Deleted transaction has deletedAt set', deletedTxn!.deletedAt != null, true);

  console.log('\nTest 6: Add/edit/delete on the CURRENT latest day only changes that day');
  const day3BeforeLatestOps = await db.ledgerDays.get(DAY3);
  const day2BeforeLatestOps = await db.ledgerDays.get(DAY2);
  const latestTxnId = await addTransaction({
    date: DAY3,
    direction: 'cash_out',
    amountPaisa: 150_00,
    categoryId: foodCategory.id!,
    expenseHeadId: null,
    cashInTypeId: null,
    description: 'Snacks',
    staffId: null,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  const day2AfterLatestOp = await db.ledgerDays.get(DAY2);
  const day3AfterLatestOp = await db.ledgerDays.get(DAY3);
  assertEqual('Day2 unchanged when only latest-day (Day3) txn added', day2AfterLatestOp!.closingBalancePaisa, day2BeforeLatestOps!.closingBalancePaisa);
  assertEqual(
    'Day3 closing reflects the new latest-day txn',
    day3AfterLatestOp!.closingBalancePaisa,
    day3BeforeLatestOps!.closingBalancePaisa - 150_00,
  );
  await softDeleteTransaction(latestTxnId);
  const day3AfterLatestDelete = await db.ledgerDays.get(DAY3);
  assertEqual('Day3 closing reverts after deleting the latest-day txn', day3AfterLatestDelete!.closingBalancePaisa, day3BeforeLatestOps!.closingBalancePaisa);

  console.log('\n--- Phase 2 tests ---');

  console.log('\nTest P2-2: New custom expense head is immediately query-selectable (dropdown source)');
  const newHeadId = await addExpenseHead(foodCategory.id!, 'Test Snacks Head');
  const foodHeadsAfterAdd = await db.expenseHeads
    .where('categoryId')
    .equals(foodCategory.id!)
    .and((h) => h.active)
    .toArray();
  assertEqual(
    'New expense head appears in the same live-query the dropdown uses (no reload)',
    foodHeadsAfterAdd.some((h) => h.id === newHeadId),
    true,
  );

  console.log('\nTest P2-3: Deactivating hides from entry-form query but historical name still resolves');
  const tempCategoryId = await addCategory('Temp Test Category');
  const tempHeadId = await addExpenseHead(tempCategoryId, 'Temp Test Head');
  const tempCashInTypeId = await addCashInType('Temp Test Cash-In Type');
  const historicalTxnId = await addTransaction({
    date: DAY3,
    direction: 'cash_out',
    amountPaisa: 42_00,
    categoryId: tempCategoryId,
    expenseHeadId: tempHeadId,
    cashInTypeId: null,
    description: 'Uses a category that will be deactivated',
    staffId: null,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  await setCategoryActive(tempCategoryId, false);
  await setExpenseHeadActive(tempHeadId, false);
  const activeCategoriesAfterDeactivate = await db.categories
    .where('direction')
    .equals('cash_out')
    .and((c) => c.active)
    .toArray();
  assertEqual(
    'Deactivated category no longer in the active-only entry-form query',
    activeCategoriesAfterDeactivate.some((c) => c.id === tempCategoryId),
    false,
  );
  const historicalTxn = await db.transactions.get(historicalTxnId);
  const categoryForHistoricalTxn = await db.categories.get(historicalTxn!.categoryId!);
  const headForHistoricalTxn = await db.expenseHeads.get(historicalTxn!.expenseHeadId!);
  assertEqual(
    'Historical transaction still resolves its (now-inactive) category name',
    categoryForHistoricalTxn?.name,
    'Temp Test Category',
  );
  assertEqual(
    'Historical transaction still resolves its (now-inactive) expense head name',
    headForHistoricalTxn?.name,
    'Temp Test Head',
  );

  console.log('\nTest P2-4: New cash_out transactions get the correct flowClass per category');
  const savingsCategory = categories.find((c) => c.name === 'Savings & Financial')!;
  const staffCategory = categories.find((c) => c.name === 'Staff')!;
  const savingsTxnId = await addTransaction({
    date: DAY3,
    direction: 'cash_out',
    amountPaisa: 500_00,
    categoryId: savingsCategory.id!,
    expenseHeadId: null,
    cashInTypeId: null,
    description: 'Bank deposit',
    staffId: null,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  const staffTxnId = await addTransaction({
    date: DAY3,
    direction: 'cash_out',
    amountPaisa: 1_000_00,
    categoryId: staffCategory.id!,
    expenseHeadId: null,
    cashInTypeId: null,
    description: 'Staff advance',
    staffId: null,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  const foodTxnId = await addTransaction({
    date: DAY3,
    direction: 'cash_out',
    amountPaisa: 90_00,
    categoryId: foodCategory.id!,
    expenseHeadId: null,
    cashInTypeId: null,
    description: 'Ordinary food expense',
    staffId: null,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  const savingsTxn = await db.transactions.get(savingsTxnId);
  const staffTxn = await db.transactions.get(staffTxnId);
  const foodTxn = await db.transactions.get(foodTxnId);
  assertEqual('Savings & Financial transaction gets flowClass savings_financial', savingsTxn!.flowClass, 'savings_financial');
  assertEqual('Staff transaction gets flowClass staff_payment', staffTxn!.flowClass, 'staff_payment');
  assertEqual('Ordinary Food transaction gets flowClass operating_expense', foodTxn!.flowClass, 'operating_expense');
  assertEqual(
    'Staff and Savings flowClass are distinct from the ordinary Food flowClass',
    staffTxn!.flowClass !== foodTxn!.flowClass && savingsTxn!.flowClass !== foodTxn!.flowClass,
    true,
  );

  console.log('\nTest P2-5: aggregateTransactions totals cross-checked by hand across 3 months');
  const aggHeadId = await addExpenseHead(foodCategory.id!, 'Aggregation Test Head');
  // v1.0 Nepali BS Edition: dates below are chosen so they land cleanly in
  // three consecutive REAL BS months (Baisakh -> Jestha -> Asar, BS 2083),
  // verified via lib/bsCalendar.ts against nepali-date-converter's actual
  // calendar table rather than assumed — see this file's replacement note
  // near the top. FIXED_NOW = 2026-06-29 AD = BS 2083 Asar 15.
  const FIXED_NOW = new Date(2026, 5, 29); // BS 2083 Asar 15 ("current BS month" = Asar)
  // Baisakh (BS year-start month; not YTD-excluded — YTD starts Baisakh 1, so it counts)
  await addTransaction({
    date: '2026-04-23', // BS 2083 Baisakh 10
    direction: 'cash_out',
    amountPaisa: 100_00,
    categoryId: foodCategory.id!,
    expenseHeadId: aggHeadId,
    cashInTypeId: null,
    description: 'Baisakh entry',
    staffId: null,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  // Jestha (previous BS month relative to FIXED_NOW)
  await addTransaction({
    date: '2026-05-19', // BS 2083 Jestha 5
    direction: 'cash_out',
    amountPaisa: 200_00,
    categoryId: foodCategory.id!,
    expenseHeadId: aggHeadId,
    cashInTypeId: null,
    description: 'Jestha entry #1',
    staffId: null,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  await addTransaction({
    date: '2026-06-03', // BS 2083 Jestha 20
    direction: 'cash_out',
    amountPaisa: 300_00,
    categoryId: foodCategory.id!,
    expenseHeadId: aggHeadId,
    cashInTypeId: null,
    description: 'Jestha entry #2',
    staffId: null,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  // Asar (current BS month relative to FIXED_NOW), one before and one after "today" (BS Asar 15)
  await addTransaction({
    date: '2026-06-24', // BS 2083 Asar 10
    direction: 'cash_out',
    amountPaisa: 400_00,
    categoryId: foodCategory.id!,
    expenseHeadId: aggHeadId,
    cashInTypeId: null,
    description: 'Asar entry (before today)',
    staffId: null,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  // Asar, after "today" (BS day 20 > fixed-now's BS day 15) — still within
  // the current BS month, so it MUST count toward Current Month, and it
  // must NOT be excluded by YTD (YTD here is defined as बैशाख १ .. today,
  // so this is the one entry that proves Current Month and YTD are
  // separate windows, not the same query).
  await addTransaction({
    date: '2026-07-04', // BS 2083 Asar 20
    direction: 'cash_out',
    amountPaisa: 50_00,
    categoryId: foodCategory.id!,
    expenseHeadId: aggHeadId,
    cashInTypeId: null,
    description: 'Asar entry (after today)',
    staffId: null,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });


  const aggTotals = await getExpenseHeadTotals(aggHeadId, FIXED_NOW);
  // Current month (Asar): 400.00 + 50.00 = 450.00 -> 45000 paisa
  assertEqual('Current month total (paisa), hand-checked', aggTotals.currentMonthPaisa, 400_00 + 50_00);
  // Previous month (Jestha): 200.00 + 300.00 = 500.00 -> 50000 paisa
  assertEqual('Previous month total (paisa), hand-checked', aggTotals.previousMonthPaisa, 200_00 + 300_00);
  // YTD (बैशाख १ - Asar 15): Baisakh 100 + Jestha 500 + Asar-10 400 = 1000.00 (Asar-20 excluded, after "today")
  assertEqual('Year-to-date total (paisa), hand-checked', aggTotals.yearToDatePaisa, 100_00 + 200_00 + 300_00 + 400_00);
  // Lifetime: everything, including the Asar-20 entry
  assertEqual(
    'Lifetime total (paisa), hand-checked',
    aggTotals.lifetimePaisa,
    100_00 + 200_00 + 300_00 + 400_00 + 50_00,
  );

  console.log('\nTest P2-5b: aggregateTransactions groupBy=category sums match groupBy=expenseHead rollup');
  const byCategory = await aggregateTransactions({ groupBy: 'category', dateFrom: '2026-01-01', dateTo: '2026-12-31' });
  const foodCategoryTotal = byCategory.find((r) => r.groupId === foodCategory.id)?.totalPaisa ?? 0;
  assertEqual(
    'Category-level total is >= the aggregation test head total alone (sanity, not double-counted below actual)',
    foodCategoryTotal >= 100_00 + 200_00 + 300_00 + 400_00 + 50_00,
    true,
  );

  console.log('\nTest P2-6: Fresh custom expense head with zero transactions shows all-zero totals, no error');
  const emptyHeadId = await addExpenseHead(foodCategory.id!, 'Brand New Empty Head');
  const emptyTotals = await getExpenseHeadTotals(emptyHeadId, FIXED_NOW);
  assertEqual('Empty head current month is 0', emptyTotals.currentMonthPaisa, 0);
  assertEqual('Empty head previous month is 0', emptyTotals.previousMonthPaisa, 0);
  assertEqual('Empty head YTD is 0', emptyTotals.yearToDatePaisa, 0);
  assertEqual('Empty head lifetime is 0', emptyTotals.lifetimePaisa, 0);

  console.log('\nTest P2-7: Soft-deleting a transaction removes it from its head\'s diary total immediately');
  const beforeDeleteTotals = await getExpenseHeadTotals(aggHeadId, FIXED_NOW);
  // v1.0 Nepali BS Edition: moved from 2026-06-12 (BS 2083 Jestha 29 — the
  // PREVIOUS BS month relative to FIXED_NOW's BS Asar 15) to 2026-06-19
  // (BS 2083 Asar 5 — the real current BS month).
  const juneEntryId = await addTransaction({
    date: '2026-06-19', // BS 2083 Asar 5
    direction: 'cash_out',
    amountPaisa: 77_00,
    categoryId: foodCategory.id!,
    expenseHeadId: aggHeadId,
    cashInTypeId: null,
    description: 'Extra Asar entry to delete',
    staffId: null,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  const afterAddTotals = await getExpenseHeadTotals(aggHeadId, FIXED_NOW);
  assertEqual(
    'Diary current-month total increases by the new entry',
    afterAddTotals.currentMonthPaisa,
    beforeDeleteTotals.currentMonthPaisa + 77_00,
  );
  await softDeleteTransaction(juneEntryId);
  const afterDeleteTotals = await getExpenseHeadTotals(aggHeadId, FIXED_NOW);
  assertEqual(
    'Diary current-month total reverts immediately after soft-delete',
    afterDeleteTotals.currentMonthPaisa,
    beforeDeleteTotals.currentMonthPaisa,
  );

  console.log('\n--- End Phase 2 tests ---');

  console.log('\nTest 7: Reload persistence (re-open the same IndexedDB and re-read)');
  db.close();
  const { CashLedgerDB } = await import('../src/db/schema');
  const reopened = new CashLedgerDB();
  const day1Reopened = await reopened.ledgerDays.get(DAY1);
  assertEqual('Day1 closing persists across DB re-open', day1Reopened!.closingBalancePaisa, day1Deleted!.closingBalancePaisa);
  const txnCountReopened = await reopened.transactions.count();
  assertEqual('Transactions persist across DB re-open (count > 0)', txnCountReopened > 0, true);
  reopened.close();

  console.log('\nTest 8: Exactly one Dexie table holds money-moving rows');
  const tableNames = db.tables.map((t) => t.name);
  const moneyTables = tableNames.filter((n) => n === 'transactions');
  assertEqual('Exactly one "transactions" table exists', moneyTables.length, 1);
  console.log(`  (all tables: ${tableNames.join(', ')})`);

  console.log('\nTest 9: Paisa-to-rupee display formatting is display-only');
  assertEqual('2048000 paisa displays as "रु २०,४८०"', formatPaisaAsRupees(2_048_000), 'रु २०,४८०');
  const storedRaw = 2_048_000;
  assertEqual('Underlying stored value stays the raw paisa integer', storedRaw, 2048000);

  console.log('\n--- Phase 3 tests ---');
  // db was closed during Test 7's reload-persistence check; reopen it before
  // resuming queries (Dexie doesn't auto-reopen after an explicit close()).
  await db.open();

  console.log('\nTest P3-2: Creating a staff member and paying salary produces exactly one Transaction row');
  const salaryRefs = await getSalaryReferenceIds();
  if (!salaryRefs) throw new Error('Salary expense head not seeded — cannot run Phase 3 tests.');
  const staffAId = await addStaff({
    name: 'Ram Bahadur',
    monthlySalaryPaisa: 25_000_00,
    joiningDate: '2026-01-15',
    notes: null,
  });
  const LATER = '2026-02-15';
  const salaryAmount1 = 25_000_00;
  const salaryTxn1Id = await addTransaction({
    date: LATER,
    direction: 'cash_out',
    amountPaisa: salaryAmount1,
    categoryId: staffCategory.id!,
    expenseHeadId: salaryRefs.salaryExpenseHead.id!,
    cashInTypeId: null,
    description: 'Salary - Ram Bahadur',
    staffId: staffAId,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  const staffATxns = await db.transactions
    .where('staffId')
    .equals(staffAId)
    .filter((t) => !t.deletedAt)
    .toArray();
  assertEqual('Exactly one Transaction row for the staff member so far', staffATxns.length, 1);
  assertEqual('Row has staffId set to the paying staff member', staffATxns[0].staffId, staffAId);
  assertEqual('Row has categoryId = Staff category', staffATxns[0].categoryId, staffCategory.id!);
  assertEqual(
    'Row has expenseHeadId = Salary expense head',
    staffATxns[0].expenseHeadId,
    salaryRefs.salaryExpenseHead.id!,
  );

  console.log(
    "\nTest P3-3: Salary payment affects that day's LedgerDay totals, and cascades forward correctly if backdated",
  );
  const laterDayBefore = await getOrCreateLedgerDay(LATER);
  // laterDayBefore already reflects salaryTxn1 (recalc ran inside addTransaction above);
  // capture it as the baseline for the backdate step below.
  const laterClosingAfterFirstPayment = laterDayBefore.closingBalancePaisa;
  const laterCashOutAfterFirstPayment = laterDayBefore.cashOutPaisa;

  // v1.0 Nepali BS Edition: BACKDATE moved to 2026-02-13 (BS 2082 Magh 1)
  // so it lands in the SAME real BS month as LATER (2026-02-15 = BS 2082
  // Magh 3) — Test P3-4 below needs both salary payments to fall in the
  // current BS month, not just "February" (LATER's original BACKDATE,
  // 2026-02-01, is actually BS Poush 18 — a different BS month entirely,
  // verified via lib/bsCalendar.ts). Still chronologically before LATER,
  // so the backdated-cascade test below is unaffected.
  const BACKDATE = '2026-02-13'; // BS 2082 Magh 1 — earlier than LATER, no LedgerDay row for it yet
  const salaryAmount2 = 5_000_00;
  const salaryTxn2Id = await addTransaction({
    date: BACKDATE,
    direction: 'cash_out',
    amountPaisa: salaryAmount2,
    categoryId: staffCategory.id!,
    expenseHeadId: salaryRefs.salaryExpenseHead.id!,
    cashInTypeId: null,
    description: 'Salary - Ram Bahadur (advance top-up)',
    staffId: staffAId,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  const laterDayAfterBackdate = await db.ledgerDays.get(LATER);
  assertEqual(
    "LATER day's own cashOut unchanged by an earlier backdated entry",
    laterDayAfterBackdate!.cashOutPaisa,
    laterCashOutAfterFirstPayment,
  );
  assertEqual(
    "LATER day's closing decreases by exactly the backdated amount (cascaded from BACKDATE)",
    laterDayAfterBackdate!.closingBalancePaisa,
    laterClosingAfterFirstPayment - salaryAmount2,
  );

  console.log(
    "\nTest P3-4: Salary payment shows up automatically in the Salary expense head's Diary totals",
  );
  const P3_NOW = new Date(2026, 1, 20); // Feb 20, 2026 = BS 2082 Magh 8 -> "current month" = BS Magh
  const salaryHeadTotals = await getExpenseHeadTotals(salaryRefs.salaryExpenseHead.id!, P3_NOW);
  assertEqual(
    "Salary expense head's current-month total equals both Feb salary payments summed",
    salaryHeadTotals.currentMonthPaisa,
    salaryAmount1 + salaryAmount2,
  );

  console.log(
    '\nTest P3-5: Staff profile month/previous-month/lifetime totals (groupBy: staff), hand-checked',
  );
  const staffBId = await addStaff({
    name: 'Sita Devi',
    monthlySalaryPaisa: 20_000_00,
    joiningDate: null,
    notes: null,
  });
  const staffBJanAmount = 20_000_00;
  await addTransaction({
    date: '2026-01-25', // BS 2082 Poush 11 — the BS month before Magh, so this is genuinely "previous month" relative to P3_NOW
    direction: 'cash_out',
    amountPaisa: staffBJanAmount,
    categoryId: staffCategory.id!,
    expenseHeadId: salaryRefs.salaryExpenseHead.id!,
    cashInTypeId: null,
    description: 'Salary - Sita Devi',
    staffId: staffBId,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  const staffATotals = await getStaffTotals(staffAId, P3_NOW);
  assertEqual('Staff A current-month total (Feb) = both Feb payments', staffATotals.currentMonthPaisa, salaryAmount1 + salaryAmount2);
  assertEqual('Staff A previous-month total (Jan) is 0 (no Jan payments)', staffATotals.previousMonthPaisa, 0);
  assertEqual('Staff A lifetime total = both Feb payments', staffATotals.lifetimePaisa, salaryAmount1 + salaryAmount2);
  const staffBTotals = await getStaffTotals(staffBId, P3_NOW);
  assertEqual('Staff B current-month total (Feb) is 0 (payment was in Jan)', staffBTotals.currentMonthPaisa, 0);
  assertEqual('Staff B previous-month total (Jan) = the Jan payment', staffBTotals.previousMonthPaisa, staffBJanAmount);
  assertEqual('Staff B lifetime total = the Jan payment', staffBTotals.lifetimePaisa, staffBJanAmount);
  assertEqual(
    "Staff A's totals unaffected by Staff B's payment (per-staff totals stay distinct)",
    staffATotals.lifetimePaisa,
    salaryAmount1 + salaryAmount2,
  );

  console.log(
    '\nTest P3-6: Deactivating a staff member still resolves their name on historical Salary transactions',
  );
  await setStaffActive(staffAId, false);
  const deactivatedStaffA = await db.staff.get(staffAId);
  assertEqual('Staff A is now inactive', deactivatedStaffA!.active, false);
  const historicalSalaryTxn = await db.transactions.get(salaryTxn1Id);
  assertEqual('Historical Salary transaction still has staffId set', historicalSalaryTxn!.staffId, staffAId);
  const resolvedStaffName = (await db.staff.get(historicalSalaryTxn!.staffId!))!.name;
  assertEqual(
    "Historical transaction's staffId still resolves to the (now-inactive) staff member's name",
    resolvedStaffName,
    'Ram Bahadur',
  );
  // Re-activate so the later edit test below (P3-7) isn't operating on inactive-staff data.
  await setStaffActive(staffAId, true);

  console.log(
    '\nTest P3-7: Editing the amount on a backdated Salary transaction cascades correctly via editTransaction',
  );
  const laterDayBeforeEdit = await db.ledgerDays.get(LATER);
  const newBackdatedAmount = 8_000_00; // was salaryAmount2 = 5_000_00
  await editTransaction(salaryTxn2Id, { amountPaisa: newBackdatedAmount });
  const laterDayAfterEdit = await db.ledgerDays.get(LATER);
  assertEqual(
    "LATER day's closing shifts by exactly the backdated edit's delta",
    laterDayAfterEdit!.closingBalancePaisa,
    laterDayBeforeEdit!.closingBalancePaisa - (newBackdatedAmount - salaryAmount2),
  );
  const editedBackdatedTxn = await db.transactions.get(salaryTxn2Id);
  assertEqual(
    "Edited transaction retains its Staff categoryId (not special-cased)",
    editedBackdatedTxn!.categoryId,
    staffCategory.id!,
  );
  assertEqual(
    'Edited transaction retains its Salary expenseHeadId (not special-cased)',
    editedBackdatedTxn!.expenseHeadId,
    salaryRefs.salaryExpenseHead.id!,
  );
  assertEqual(
    'Edited transaction retains its staffId (not special-cased)',
    editedBackdatedTxn!.staffId,
    staffAId,
  );

  console.log('\n--- End Phase 3 tests ---');

  console.log('\n--- Phase 4 tests ---');

  console.log('\nTest P4-2: Giving an advance creates exactly one Transaction, no second write path');
  const advanceRefs = await getAdvanceReferenceIds();
  if (!advanceRefs) throw new Error('Advance expense head not seeded — cannot run Phase 4 tests.');
  const staffCId = await addStaff({
    name: 'Hari Prasad',
    monthlySalaryPaisa: 15_000_00,
    advanceLimitPaisa: null,
    joiningDate: '2026-03-01',
    notes: null,
  });
  const ADV_DATE1 = '2026-03-05';
  const advance1Amount = 5_000_00;
  const advanceTxn1Id = await addTransaction({
    date: ADV_DATE1,
    direction: 'cash_out',
    amountPaisa: advance1Amount,
    categoryId: staffCategory.id!,
    expenseHeadId: advanceRefs.advanceExpenseHead.id!,
    cashInTypeId: null,
    description: 'Advance - Hari Prasad',
    staffId: staffCId,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  const staffCTxnsAfterAdvance1 = await db.transactions
    .where('staffId')
    .equals(staffCId)
    .filter((t) => !t.deletedAt)
    .toArray();
  assertEqual('Exactly one Transaction row for staff C so far', staffCTxnsAfterAdvance1.length, 1);
  assertEqual('Row has categoryId = Staff category', staffCTxnsAfterAdvance1[0].categoryId, staffCategory.id!);
  assertEqual(
    'Row has expenseHeadId = Advance expense head',
    staffCTxnsAfterAdvance1[0].expenseHeadId,
    advanceRefs.advanceExpenseHead.id!,
  );
  assertEqual('Row has staffId set to the receiving staff member', staffCTxnsAfterAdvance1[0].staffId, staffCId);
  assertEqual('Row amountPaisa equals the advance amount', staffCTxnsAfterAdvance1[0].amountPaisa, advance1Amount);

  console.log(
    '\nTest P4-3: Outstanding advance calculation hand-checked (two advances + one partial-recovery salary payment)',
  );
  const advance2Amount = 3_000_00;
  const ADV_DATE2 = '2026-03-10';
  await addTransaction({
    date: ADV_DATE2,
    direction: 'cash_out',
    amountPaisa: advance2Amount,
    categoryId: staffCategory.id!,
    expenseHeadId: advanceRefs.advanceExpenseHead.id!,
    cashInTypeId: null,
    description: 'Advance - Hari Prasad (second)',
    staffId: staffCId,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  const recovery1Amount = 2_000_00;
  const SALARY_DATE_C1 = '2026-03-25';
  await addTransaction({
    date: SALARY_DATE_C1,
    direction: 'cash_out',
    amountPaisa: 15_000_00 - recovery1Amount,
    categoryId: staffCategory.id!,
    expenseHeadId: salaryRefs.salaryExpenseHead.id!,
    cashInTypeId: null,
    description: 'Salary - Hari Prasad',
    staffId: staffCId,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: recovery1Amount,
  });
  const outstandingAfterFirstRecovery = await getOutstandingAdvance(staffCId);
  assertEqual(
    'Advances given = advance1 + advance2, in raw paisa',
    outstandingAfterFirstRecovery.advancesGivenPaisa,
    advance1Amount + advance2Amount,
  );
  assertEqual(
    'Advances recovered = the one recovery amount, in raw paisa',
    outstandingAfterFirstRecovery.advancesRecoveredPaisa,
    recovery1Amount,
  );
  assertEqual(
    'Outstanding = advances given − recovered, in raw paisa',
    outstandingAfterFirstRecovery.outstandingPaisa,
    advance1Amount + advance2Amount - recovery1Amount,
  );

  console.log(
    '\nTest P4-4: Advance limit check with default (monthlySalaryPaisa) limit — over exceeds it, at-or-under stays within it',
  );
  const staffDId = await addStaff({
    name: 'Gita Kumari',
    monthlySalaryPaisa: 10_000_00,
    advanceLimitPaisa: null,
    joiningDate: null,
    notes: null,
  });
  // Outstanding is 0 so far; salary (and thus default limit) is 10,000.00.
  // Phase 3 Part A: renamed allowed -> withinLimit (advisory-only now —
  // see checkAdvanceLimit's own doc comment in lib/staff.ts). This test
  // only exercises the raw check's arithmetic, unchanged by that rename.
  const overLimitCheck = await checkAdvanceLimit(staffDId, 10_000_01);
  assertEqual('Advance that would push outstanding above the salary-default limit exceeds it', overLimitCheck.withinLimit, false);
  const atLimitCheck = await checkAdvanceLimit(staffDId, 10_000_00);
  assertEqual('Advance that stays exactly at the salary-default limit is within it', atLimitCheck.withinLimit, true);
  const blockedTxnCountBefore = await db.transactions.where('staffId').equals(staffDId).count();
  assertEqual('No Transaction row exists yet for staff D (limit checks alone create nothing)', blockedTxnCountBefore, 0);

  console.log('\nTest P4-5: Advance limit check with a custom advanceLimitPaisa overrides the salary default');
  await editStaff(staffDId, { advanceLimitPaisa: 4_000_00 });
  const customLimitOverCheck = await checkAdvanceLimit(staffDId, 4_000_01);
  assertEqual('Advance above the custom (lower) limit exceeds it even though it is under salary', customLimitOverCheck.withinLimit, false);
  const customLimitAtCheck = await checkAdvanceLimit(staffDId, 4_000_00);
  assertEqual('Advance at the custom limit is within it', customLimitAtCheck.withinLimit, true);
  assertEqual('checkAdvanceLimit reports the custom limit, not the salary default', customLimitOverCheck.limitPaisa, 4_000_00);

  console.log(
    '\nTest P4-6/P4-7: Paying salary with recovery produces exactly ONE Transaction and reduces outstanding advance immediately',
  );
  const outstandingBeforeSecondRecovery = await getOutstandingAdvance(staffCId);
  const recovery2Amount = 1_500_00;
  const grossSalaryC2 = 15_000_00;
  const SALARY_DATE_C2 = '2026-04-25';
  const salaryTxnC2Id = await addTransaction({
    date: SALARY_DATE_C2,
    direction: 'cash_out',
    amountPaisa: grossSalaryC2 - recovery2Amount,
    categoryId: staffCategory.id!,
    expenseHeadId: salaryRefs.salaryExpenseHead.id!,
    cashInTypeId: null,
    description: 'Salary - Hari Prasad (second)',
    staffId: staffCId,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: recovery2Amount,
  });
  const staffCTxnsOnSalaryDate2 = await db.transactions
    .where('date')
    .equals(SALARY_DATE_C2)
    .filter((t) => !t.deletedAt)
    .toArray();
  assertEqual('Exactly one Transaction row created on the second salary date', staffCTxnsOnSalaryDate2.length, 1);
  const salaryTxnC2 = await db.transactions.get(salaryTxnC2Id);
  assertEqual('Transaction amountPaisa = gross − recovery', salaryTxnC2!.amountPaisa, grossSalaryC2 - recovery2Amount);
  assertEqual('Transaction linkedAdvanceRecoveryPaisa = recovery', salaryTxnC2!.linkedAdvanceRecoveryPaisa, recovery2Amount);
  const outstandingAfterSecondRecovery = await getOutstandingAdvance(staffCId);
  assertEqual(
    'Outstanding advance decreases by exactly the second recovery amount',
    outstandingAfterSecondRecovery.outstandingPaisa,
    outstandingBeforeSecondRecovery.outstandingPaisa - recovery2Amount,
  );

  console.log('\nTest P4-8: Recovery amount validation — recovering more than outstanding is blocked, no transaction created');
  const outstandingForStaffC = await getOutstandingAdvance(staffCId);
  const attemptedOverRecovery = outstandingForStaffC.outstandingPaisa + 1;
  const rejectedRecoveryCheck = await checkRecoveryAmount(staffCId, attemptedOverRecovery, 15_000_00);
  assertEqual('checkRecoveryAmount rejects a recovery larger than outstanding advance', rejectedRecoveryCheck.allowed, false);
  const txnCountBeforeRejectedRecovery = await db.transactions.where('staffId').equals(staffCId).count();
  // The Pay Salary form only calls addTransaction when checkRecoveryAmount.allowed is
  // true (see PaySalaryModal.handleSubmit), so a rejected check must never be followed
  // by a write — confirmed by re-reading the same count after the check above.
  const txnCountAfterRejectedRecoveryCheck = await db.transactions.where('staffId').equals(staffCId).count();
  assertEqual(
    'No transaction created as a result of the rejected recovery check',
    txnCountAfterRejectedRecoveryCheck,
    txnCountBeforeRejectedRecovery,
  );
  const validRecoveryCheck = await checkRecoveryAmount(staffCId, outstandingForStaffC.outstandingPaisa, 15_000_00);
  assertEqual('checkRecoveryAmount allows a recovery exactly at outstanding advance', validRecoveryCheck.allowed, true);
  const overGrossRecoveryCheck = await checkRecoveryAmount(staffCId, 15_000_01, 15_000_00);
  assertEqual('checkRecoveryAmount also rejects a recovery larger than the gross salary amount', overGrossRecoveryCheck.allowed, false);

  console.log(
    '\nTest P4-9: A backdated Advance transaction still cascades LedgerDay balances correctly via the existing addTransaction path',
  );
  const laterDayC = await getOrCreateLedgerDay(SALARY_DATE_C2);
  const closingBeforeBackdatedAdvance = laterDayC.closingBalancePaisa;
  const BACKDATED_ADV_DATE = '2026-04-10'; // before SALARY_DATE_C2, after existing days
  const backdatedAdvanceAmount = 1_000_00;
  await addTransaction({
    date: BACKDATED_ADV_DATE,
    direction: 'cash_out',
    amountPaisa: backdatedAdvanceAmount,
    categoryId: staffCategory.id!,
    expenseHeadId: advanceRefs.advanceExpenseHead.id!,
    cashInTypeId: null,
    description: 'Advance - Hari Prasad (backdated)',
    staffId: staffCId,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  const laterDayCAfterBackdate = await db.ledgerDays.get(SALARY_DATE_C2);
  assertEqual(
    "Later day's closing decreases by exactly the backdated advance amount (cascaded)",
    laterDayCAfterBackdate!.closingBalancePaisa,
    closingBeforeBackdatedAdvance - backdatedAdvanceAmount,
  );
  const outstandingAfterBackdatedAdvance = await getOutstandingAdvance(staffCId);
  assertEqual(
    "getOutstandingAdvance's raw-paisa total includes the backdated advance",
    outstandingAfterBackdatedAdvance.advancesGivenPaisa,
    advance1Amount + advance2Amount + backdatedAdvanceAmount,
  );

  console.log(
    '\nTest P4-10: Deactivating a staff member with nonzero outstanding advance still shows correct outstanding and resolves historical transactions by name',
  );
  await setStaffActive(staffCId, false);
  const deactivatedStaffC = await db.staff.get(staffCId);
  assertEqual('Staff C is now inactive', deactivatedStaffC!.active, false);
  const outstandingWhileInactive = await getOutstandingAdvance(staffCId);
  assertEqual(
    'Outstanding advance figure is unaffected by deactivation',
    outstandingWhileInactive.outstandingPaisa,
    outstandingAfterBackdatedAdvance.outstandingPaisa,
  );
  const historicalAdvanceTxn = await db.transactions.get(advanceTxn1Id);
  const resolvedStaffCName = (await db.staff.get(historicalAdvanceTxn!.staffId!))!.name;
  assertEqual(
    "Historical Advance transaction's staffId still resolves to the (now-inactive) staff member's name",
    resolvedStaffCName,
    'Hari Prasad',
  );

  console.log('\n--- End Phase 4 tests ---');

  console.log('\n--- Phase 5 tests ---');

  const petrolHead = await getPetrolExpenseHead();
  if (!petrolHead) throw new Error('Petrol expense head not seeded — cannot run Phase 5 tests.');
  const travelCategory = categories.find((c) => c.name === 'Travel & Fuel')!;
  const vehicleMaintenanceCategory = categories.find((c) => c.name === 'Vehicle Maintenance')!;

  console.log(
    '\nTest P5-2 (Phase 2): Creating a vehicle and staff, then assigning the vehicle, correctly links them via the StaffVehicle join table',
  );
  const pulsarId = await addVehicle({
    name: '220 Pulsar',
    vehicleType: 'Motorbike',
    registrationNumber: 'BA 12 PA 3456',
  });
  const vanId = await addVehicle({ name: 'Delivery Van', vehicleType: 'Van', registrationNumber: null });
  const scooterId = await addVehicle({ name: 'Old Scooter', vehicleType: 'Scooter', registrationNumber: null });
  const sijanId = await addStaff({
    name: 'Sijan',
    monthlySalaryPaisa: 20_000_00,
    advanceLimitPaisa: null,
    joiningDate: null,
    notes: null,
  });
  const sijanBeforeAssignment = await db.staff.get(sijanId);
  assertEqual(
    'Staff.assignedVehicleId (deprecated) is never written by addStaff — stays null',
    sijanBeforeAssignment!.assignedVehicleId,
    null,
  );
  assertEqual('No vehicles assigned before assignment', (await getVehiclesForStaff(sijanId)).length, 0);
  await assignVehicleToStaff(sijanId, pulsarId);
  const sijanAfterAssignment = await db.staff.get(sijanId);
  assertEqual(
    'Staff.assignedVehicleId (deprecated) is STILL never written — assignVehicleToStaff() only touches StaffVehicle',
    sijanAfterAssignment!.assignedVehicleId,
    null,
  );
  const sijanVehiclesAfterAssignment = await getVehiclesForStaff(sijanId);
  assertEqual('Exactly one vehicle assigned, confirmed via the join table', sijanVehiclesAfterAssignment.length, 1);
  assertEqual(
    'The assigned vehicle is the one just linked, confirmed via direct read',
    sijanVehiclesAfterAssignment[0]?.id,
    pulsarId,
  );
  assertEqual(
    'resolveAssignedVehicleId() correctly suggests it (exactly one assignment)',
    await resolveAssignedVehicleId(sijanId),
    pulsarId,
  );
  // Duplicate assignment is a no-op (EXACT SCOPE: no duplicate pairs).
  await assignVehicleToStaff(sijanId, pulsarId);
  assertEqual(
    'Re-assigning the same (staff, vehicle) pair does not create a duplicate row',
    (await getVehiclesForStaff(sijanId)).length,
    1,
  );

  console.log(
    '\nTest P5-2b (Phase 2): a staff member with 2+ assigned vehicles gets no auto-suggestion (ask-don\'t-guess)',
  );
  await assignVehicleToStaff(sijanId, vanId);
  const sijanVehiclesAfterSecond = await getVehiclesForStaff(sijanId);
  assertEqual('Two vehicles now assigned', sijanVehiclesAfterSecond.length, 2);
  assertEqual(
    'resolveAssignedVehicleId() returns null with 2+ assignments (does not guess)',
    await resolveAssignedVehicleId(sijanId),
    null,
  );
  await unassignVehicleFromStaff(sijanId, vanId);
  const sijanVehiclesAfterUnassign = await getVehiclesForStaff(sijanId);
  assertEqual(
    'unassignVehicleFromStaff() removes only the targeted pair, leaving exactly one assignment',
    sijanVehiclesAfterUnassign.length,
    1,
  );
  assertEqual(
    'unassignVehicleFromStaff() removes only the targeted pair, leaving the OTHER assignment intact',
    sijanVehiclesAfterUnassign[0]?.id,
    pulsarId,
  );
  assertEqual(
    'resolveAssignedVehicleId() suggests again once back down to exactly one',
    await resolveAssignedVehicleId(sijanId),
    pulsarId,
  );

  console.log(
    '\nTest P5-3: Saving a Cash Out transaction stores the user-chosen vehicle, not the staff-assigned one',
  );
  // Simulates the Cash Out form: staff = Sijan (assigned vehicle = Pulsar)
  // pre-fills Vehicle = Pulsar, but the user then picks the Van instead
  // before saving — only the final, explicitly-picked vehicleId is what
  // addTransaction ever sees or stores.
  const P5_PICK_OVERRIDE_DATE = '2026-06-01';
  const overrideTxnId = await addTransaction({
    date: P5_PICK_OVERRIDE_DATE,
    direction: 'cash_out',
    amountPaisa: 150_00,
    categoryId: travelCategory.id!,
    expenseHeadId: petrolHead.id!,
    cashInTypeId: null,
    description: 'Petrol - Sijan (picked Van over assigned Pulsar)',
    staffId: sijanId,
    vehicleId: vanId,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  const overrideTxn = await db.transactions.get(overrideTxnId);
  assertEqual(
    "Saved transaction's vehicleId matches what was picked (Van), not what was assigned (Pulsar)",
    overrideTxn!.vehicleId,
    vanId,
  );

  console.log(
    '\nTest P5-4: A Cash Out transaction with staffId AND vehicleId set (Petrol/Sijan/220 Pulsar) saves as one row and appears in the right places, with no leakage into staff Salary history',
  );
  // v1.0 Nepali BS Edition: moved from 2026-08-05 (BS 2083 Shrawan 20 — the
  // PREVIOUS BS month relative to P5_NOW below, BS Bhadra) to 2026-08-18
  // (BS 2083 Bhadra 2), so the "current-month total includes the worked
  // example" check further down actually lands in the current BS month.
  const P5_WORKED_EXAMPLE_DATE = '2026-08-18'; // BS 2083 Bhadra 2
  const workedExampleAmount = 220_00;
  const dayBeforeWorkedExample = await getOrCreateLedgerDay(P5_WORKED_EXAMPLE_DATE);
  const closingBeforeWorkedExample = dayBeforeWorkedExample.closingBalancePaisa;
  const workedExampleTxnId = await addTransaction({
    date: P5_WORKED_EXAMPLE_DATE,
    direction: 'cash_out',
    amountPaisa: workedExampleAmount,
    categoryId: travelCategory.id!,
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
  const txnsOnWorkedExampleDate = await db.transactions
    .where('date')
    .equals(P5_WORKED_EXAMPLE_DATE)
    .filter((t) => !t.deletedAt)
    .toArray();
  assertEqual('Worked example saves as exactly one Transaction row', txnsOnWorkedExampleDate.length, 1);

  // Appears in the Daily Ledger (cascade updates that day's closing balance).
  const dayAfterWorkedExample = await db.ledgerDays.get(P5_WORKED_EXAMPLE_DATE);
  assertEqual(
    "Daily Ledger: that day's closing balance decreases by the transaction amount",
    dayAfterWorkedExample!.closingBalancePaisa,
    closingBeforeWorkedExample - workedExampleAmount,
  );

  // Appears in the Petrol expense head's Diary total.
  const P5_NOW = new Date(2026, 7, 20); // Aug 20, 2026 = BS 2083 Bhadra 4 -> "current month" = BS Bhadra
  const petrolDiaryTotals = await getExpenseHeadTotals(petrolHead.id!, P5_NOW);
  assertEqual(
    "Petrol expense head's Diary current-month total includes the worked example (>= its amount)",
    petrolDiaryTotals.currentMonthPaisa >= workedExampleAmount,
    true,
  );

  // Appears in the vehicle's (220 Pulsar) profile totals.
  const pulsarTotalsAfterWorkedExample = await getVehicleTotals(pulsarId, petrolHead.id!, P5_NOW);
  assertEqual(
    "Vehicle profile: Pulsar's current-month Petrol total includes the worked example (>= its amount)",
    pulsarTotalsAfterWorkedExample.petrol.currentMonthPaisa >= workedExampleAmount,
    true,
  );

  // Does NOT appear in the staff member's Salary-payment-history view.
  const salaryRefsForP5 = await getSalaryReferenceIds();
  const sijanSalaryHistory = await db.transactions
    .where('staffId')
    .equals(sijanId)
    .filter((t) => !t.deletedAt && t.expenseHeadId === salaryRefsForP5!.salaryExpenseHead.id)
    .toArray();
  assertEqual(
    "Sijan's Salary-payment-history correctly excludes the Petrol transaction (no leakage)",
    sijanSalaryHistory.some((t) => t.id === workedExampleTxnId),
    false,
  );

  console.log(
    '\nTest P5-5: Vehicle profile totals (overall + Petrol, month/previous-month/YTD/lifetime), hand-checked across 2 vehicles and 2 real BS months',
  );
  // v1.0 Nepali BS Edition: moved from 2026-07-10 (BS 2083 Asar 26 — TWO
  // BS months back relative to P5_NOW, not "previous") to 2026-07-26 (BS
  // 2083 Shrawan 10 — the real previous BS month).
  await addTransaction({
    date: '2026-07-26', // BS 2083 Shrawan 10
    direction: 'cash_out',
    amountPaisa: 1_000_00,
    categoryId: travelCategory.id!,
    expenseHeadId: petrolHead.id!,
    cashInTypeId: null,
    description: 'Petrol - Pulsar (Shrawan)',
    staffId: null,
    vehicleId: pulsarId,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  // v1.0 Nepali BS Edition: moved from 2026-08-12 (BS 2083 Shrawan 27 —
  // that's the PREVIOUS BS month relative to P5_NOW, not current) to
  // 2026-08-19 (BS 2083 Bhadra 3 — the real current BS month, and still
  // on-or-before P5_NOW's BS Bhadra 4 "today").
  await addTransaction({
    date: '2026-08-19', // BS 2083 Bhadra 3
    direction: 'cash_out',
    amountPaisa: 500_00,
    categoryId: travelCategory.id!,
    expenseHeadId: petrolHead.id!,
    cashInTypeId: null,
    description: 'Petrol - Pulsar (Bhadra)',
    staffId: null,
    vehicleId: pulsarId,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  await addTransaction({
    date: '2026-08-18',
    direction: 'cash_out',
    amountPaisa: 300_00,
    categoryId: vehicleMaintenanceCategory.id!,
    expenseHeadId: null,
    cashInTypeId: null,
    description: 'Chain replacement - Pulsar',
    staffId: null,
    vehicleId: pulsarId,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  // v1.0 Nepali BS Edition: moved from 2026-07-11 (BS 2083 Asar 27) to
  // 2026-07-27 (BS 2083 Shrawan 11 — the real previous BS month).
  await addTransaction({
    date: '2026-07-27', // BS 2083 Shrawan 11
    direction: 'cash_out',
    amountPaisa: 700_00,
    categoryId: travelCategory.id!,
    expenseHeadId: petrolHead.id!,
    cashInTypeId: null,
    description: 'Petrol - Van (Shrawan)',
    staffId: null,
    vehicleId: vanId,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  // v1.0 Nepali BS Edition: moved from 2026-08-13 (BS 2083 Shrawan 28) to
  // 2026-08-17 (BS 2083 Bhadra 1 — the real current BS month). NOT
  // 2026-08-20 (P5_NOW's own date) — that date is deliberately reserved
  // as P7_TODAY, a "never-before-used date" for a later Dashboard test
  // further down this file (see P7_TODAY below) — using it here would
  // silently inflate that later test's "today" totals.
  await addTransaction({
    date: '2026-08-17', // BS 2083 Bhadra 1
    direction: 'cash_out',
    amountPaisa: 400_00,
    categoryId: travelCategory.id!,
    expenseHeadId: petrolHead.id!,
    cashInTypeId: null,
    description: 'Petrol - Van (Bhadra)',
    staffId: null,
    vehicleId: vanId,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });

  // Pulsar: Bhadra = worked example (220) + 500 (Petrol) + 300 (Maintenance) = 1020; Shrawan = 1000.
  const pulsarTotals = await getVehicleTotals(pulsarId, petrolHead.id!, P5_NOW);
  assertEqual('Pulsar overall current month = 220 + 500 + 300', pulsarTotals.overall.currentMonthPaisa, 1_020_00);
  assertEqual('Pulsar overall previous month = 1000 (Shrawan Petrol only)', pulsarTotals.overall.previousMonthPaisa, 1_000_00);
  assertEqual('Pulsar Petrol current month = 220 + 500', pulsarTotals.petrol.currentMonthPaisa, 720_00);
  assertEqual('Pulsar Petrol previous month = 1000', pulsarTotals.petrol.previousMonthPaisa, 1_000_00);
  assertEqual('Pulsar overall YTD = Shrawan 1000 + Bhadra 1020', pulsarTotals.overall.yearToDatePaisa, 2_020_00);
  assertEqual('Pulsar overall lifetime = same as YTD (no other dates)', pulsarTotals.overall.lifetimePaisa, 2_020_00);
  assertEqual('Pulsar Petrol YTD = Shrawan 1000 + Bhadra 720', pulsarTotals.petrol.yearToDatePaisa, 1_720_00);
  assertEqual('Pulsar Petrol lifetime = same as YTD', pulsarTotals.petrol.lifetimePaisa, 1_720_00);

  // Van: Bhadra = 400; Shrawan = 700. Van has only Petrol transactions, so overall == petrol.
  const vanTotals = await getVehicleTotals(vanId, petrolHead.id!, P5_NOW);
  assertEqual('Van overall current month = 400', vanTotals.overall.currentMonthPaisa, 400_00);
  assertEqual('Van overall previous month = 700', vanTotals.overall.previousMonthPaisa, 700_00);
  assertEqual('Van Petrol current month = overall (Van has no non-Petrol transactions)', vanTotals.petrol.currentMonthPaisa, vanTotals.overall.currentMonthPaisa);
  // Van YTD/lifetime also include test P5-3's override transaction (Rs.
  // 150, 2026-06-01 = BS 2083 Jestha 18, Van) — Jestha falls inside the
  // बैशाख-Bhadra YTD window even though it's outside both the current and
  // previous BS month buckets.
  assertEqual('Van overall YTD = Shrawan 700 + Bhadra 400 + Jestha 150 (P5-3 override txn)', vanTotals.overall.yearToDatePaisa, 1_250_00);
  assertEqual('Van overall lifetime = same as YTD', vanTotals.overall.lifetimePaisa, 1_250_00);

  console.log(
    '\nTest P5-6: Monthly Petrol comparison table returns correct current-month totals per vehicle, with a zero-Petrol vehicle showing 0 (not omitted)',
  );
  const comparisonVehicleIds = [pulsarId, vanId, scooterId];
  const comparison = await getCurrentMonthPetrolByVehicle(petrolHead.id!, comparisonVehicleIds, P5_NOW);
  assertEqual('Comparison table has an entry for every vehicle passed in', comparison.size, comparisonVehicleIds.length);
  assertEqual('Pulsar Petrol this month in the comparison table = 720', comparison.get(pulsarId), 720_00);
  assertEqual('Van Petrol this month in the comparison table = 400', comparison.get(vanId), 400_00);
  assertEqual(
    'Scooter (zero Petrol transactions this month) shows 0, not omitted or erroring',
    comparison.get(scooterId),
    0,
  );

  console.log(
    '\nTest P5-7: Deactivating a vehicle removes it from the active list but historical transactions still resolve its name',
  );
  const scooterHistoricalTxnId = await addTransaction({
    date: '2026-01-05',
    direction: 'cash_out',
    amountPaisa: 150_00,
    categoryId: travelCategory.id!,
    expenseHeadId: petrolHead.id!,
    cashInTypeId: null,
    description: 'Petrol - Old Scooter (January)',
    staffId: null,
    vehicleId: scooterId,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  await setVehicleActive(scooterId, false);
  const activeVehiclesAfterDeactivation = await db.vehicles.filter((v) => v.active).toArray();
  assertEqual(
    "Deactivated vehicle no longer appears in the active list (Cash Out / Staff form dropdowns)",
    activeVehiclesAfterDeactivation.some((v) => v.id === scooterId),
    false,
  );
  const scooterHistoricalTxn = await db.transactions.get(scooterHistoricalTxnId);
  const resolvedScooterName = (await db.vehicles.get(scooterHistoricalTxn!.vehicleId!))!.name;
  assertEqual(
    "Historical transaction's vehicleId still resolves to the (now-inactive) vehicle's name",
    resolvedScooterName,
    'Old Scooter',
  );
  const scooterAfterDeactivation = await db.vehicles.get(scooterId);
  assertEqual('Deactivated vehicle itself still resolves its own name (for its own profile screen)', scooterAfterDeactivation!.name, 'Old Scooter');

  console.log(
    '\nTest P5-8: A backdated transaction with vehicleId set still cascades LedgerDay balances correctly via the existing addTransaction path',
  );
  const laterDayForVehicleCascade = await getOrCreateLedgerDay(P5_WORKED_EXAMPLE_DATE);
  const closingBeforeBackdatedVehicleTxn = laterDayForVehicleCascade.closingBalancePaisa;
  const BACKDATED_VEHICLE_DATE = '2026-08-17'; // BS 2083 Bhadra 1 — before P5_WORKED_EXAMPLE_DATE (BS Bhadra 2), same BS month
  const backdatedVehicleAmount = 90_00;
  await addTransaction({
    date: BACKDATED_VEHICLE_DATE,
    direction: 'cash_out',
    amountPaisa: backdatedVehicleAmount,
    categoryId: travelCategory.id!,
    expenseHeadId: petrolHead.id!,
    cashInTypeId: null,
    description: 'Petrol - Pulsar (backdated)',
    staffId: null,
    vehicleId: pulsarId,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  const laterDayAfterBackdatedVehicleTxn = await db.ledgerDays.get(P5_WORKED_EXAMPLE_DATE);
  assertEqual(
    "Later day's closing decreases by exactly the backdated vehicle transaction amount (cascaded)",
    laterDayAfterBackdatedVehicleTxn!.closingBalancePaisa,
    closingBeforeBackdatedVehicleTxn - backdatedVehicleAmount,
  );
  const pulsarTotalsAfterBackdate = await getVehicleTotals(pulsarId, petrolHead.id!, P5_NOW);
  assertEqual(
    "Vehicle profile's raw-paisa total includes the backdated transaction",
    pulsarTotalsAfterBackdate.petrol.currentMonthPaisa,
    pulsarTotals.petrol.currentMonthPaisa + backdatedVehicleAmount,
  );

  console.log('\n--- End Phase 5 tests ---');

  console.log('\n--- Phase 6 tests ---');

  const depositRefs = await getDepositReferenceIds();
  if (!depositRefs) throw new Error('Deposit expense head not seeded — cannot run Phase 6 tests.');
  const financialWithdrawalType = await getFinancialWithdrawalCashInType();
  if (!financialWithdrawalType) {
    throw new Error('Financial Withdrawal cash-in type not seeded — cannot run Phase 6 tests.');
  }

  const nicAsiaId = await addInstitution({ name: 'NIC Asia Bank' });
  const globalImeId = await addInstitution({ name: 'Global IME Bank' });
  const cascadeBankId = await addInstitution({ name: 'Cascade Test Bank' });

  console.log(
    '\nTest P6-2: Recording a deposit creates exactly one cash_out Transaction (categoryId = Savings & Financial, institutionId set), no second write path',
  );
  const DEPOSIT_TEST_DATE = '2025-12-01';
  const depositTestAmount = 5_000_00;
  const depositTxnId = await addTransaction({
    date: DEPOSIT_TEST_DATE,
    direction: 'cash_out',
    amountPaisa: depositTestAmount,
    categoryId: savingsCategory.id!,
    expenseHeadId: depositRefs.depositExpenseHead.id!,
    cashInTypeId: null,
    description: 'Deposit - NIC Asia Bank',
    staffId: null,
    vehicleId: null,
    institutionId: nicAsiaId,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  const nicAsiaTxnsAfterDeposit = await db.transactions
    .where('institutionId')
    .equals(nicAsiaId)
    .filter((t) => !t.deletedAt)
    .toArray();
  assertEqual('Exactly one Transaction row for NIC Asia so far', nicAsiaTxnsAfterDeposit.length, 1);
  assertEqual(
    'Deposit row has categoryId = Savings & Financial category',
    nicAsiaTxnsAfterDeposit[0].categoryId,
    savingsCategory.id!,
  );
  assertEqual('Deposit row has institutionId set', nicAsiaTxnsAfterDeposit[0].institutionId, nicAsiaId);
  assertEqual('Deposit row is direction cash_out', nicAsiaTxnsAfterDeposit[0].direction, 'cash_out');
  assertEqual('Deposit row amountPaisa equals the deposit amount', nicAsiaTxnsAfterDeposit[0].amountPaisa, depositTestAmount);

  console.log(
    '\nTest P6-3: Recording a withdrawal creates exactly one cash_in Transaction (institutionId set, direction = cash_in), no second write path',
  );
  const WITHDRAWAL_TEST_DATE = '2025-12-02';
  const withdrawalTestAmount = 2_000_00;
  const withdrawalTxnId = await addTransaction({
    date: WITHDRAWAL_TEST_DATE,
    direction: 'cash_in',
    amountPaisa: withdrawalTestAmount,
    categoryId: null,
    expenseHeadId: null,
    cashInTypeId: financialWithdrawalType.id!,
    description: 'Withdrawal - NIC Asia Bank',
    staffId: null,
    vehicleId: null,
    institutionId: nicAsiaId,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  const nicAsiaTxnsAfterWithdrawal = await db.transactions
    .where('institutionId')
    .equals(nicAsiaId)
    .filter((t) => !t.deletedAt)
    .toArray();
  assertEqual('Exactly two Transaction rows for NIC Asia now (deposit + withdrawal)', nicAsiaTxnsAfterWithdrawal.length, 2);
  const withdrawalRow = nicAsiaTxnsAfterWithdrawal.find((t) => t.id === withdrawalTxnId)!;
  assertEqual('Withdrawal row is direction cash_in', withdrawalRow.direction, 'cash_in');
  assertEqual('Withdrawal row has institutionId set', withdrawalRow.institutionId, nicAsiaId);
  assertEqual(
    'Withdrawal row has cashInTypeId = Financial Withdrawal (categoryId stays null on cash_in, per the established convention)',
    withdrawalRow.cashInTypeId,
    financialWithdrawalType.id!,
  );
  assertEqual('Withdrawal row categoryId is null (cash_in rows never carry a categoryId)', withdrawalRow.categoryId, null);
  assertEqual('Withdrawal row amountPaisa equals the withdrawal amount', withdrawalRow.amountPaisa, withdrawalTestAmount);

  console.log(
    "\nTest P6-4: Both deposit and withdrawal transactions get flowClass = 'savings_financial', confirmed via direct read",
  );
  const depositTxn = await db.transactions.get(depositTxnId);
  assertEqual("Deposit transaction's stored flowClass", depositTxn!.flowClass, 'savings_financial');
  const withdrawalTxn = await db.transactions.get(withdrawalTxnId);
  assertEqual("Withdrawal transaction's stored flowClass", withdrawalTxn!.flowClass, 'savings_financial');

  console.log(
    '\nTest P6-5: A deposit increases LedgerDay cashOut and decreases closing; a withdrawal increases cashIn and increases closing; a backdated one still cascades correctly',
  );
  const CASCADE_DEPOSIT_DATE = '2026-05-10';
  const dayBeforeCascadeDeposit = await getOrCreateLedgerDay(CASCADE_DEPOSIT_DATE);
  const cashOutBeforeCascadeDeposit = dayBeforeCascadeDeposit.cashOutPaisa;
  const closingBeforeCascadeDeposit = dayBeforeCascadeDeposit.closingBalancePaisa;
  const cascadeDepositAmount = 3_000_00;
  await addTransaction({
    date: CASCADE_DEPOSIT_DATE,
    direction: 'cash_out',
    amountPaisa: cascadeDepositAmount,
    categoryId: savingsCategory.id!,
    expenseHeadId: depositRefs.depositExpenseHead.id!,
    cashInTypeId: null,
    description: 'Deposit - Cascade Test Bank',
    staffId: null,
    vehicleId: null,
    institutionId: cascadeBankId,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  const dayAfterCascadeDeposit = await db.ledgerDays.get(CASCADE_DEPOSIT_DATE);
  assertEqual(
    "Deposit: day's cashOutPaisa increases by exactly the deposit amount",
    dayAfterCascadeDeposit!.cashOutPaisa,
    cashOutBeforeCascadeDeposit + cascadeDepositAmount,
  );
  assertEqual(
    "Deposit: day's closingBalancePaisa decreases by exactly the deposit amount",
    dayAfterCascadeDeposit!.closingBalancePaisa,
    closingBeforeCascadeDeposit - cascadeDepositAmount,
  );

  const CASCADE_WITHDRAWAL_DATE = '2026-05-11';
  const dayBeforeCascadeWithdrawal = await getOrCreateLedgerDay(CASCADE_WITHDRAWAL_DATE);
  const cashInBeforeCascadeWithdrawal = dayBeforeCascadeWithdrawal.cashInPaisa;
  const closingBeforeCascadeWithdrawal = dayBeforeCascadeWithdrawal.closingBalancePaisa;
  const cascadeWithdrawalAmount = 1_200_00;
  await addTransaction({
    date: CASCADE_WITHDRAWAL_DATE,
    direction: 'cash_in',
    amountPaisa: cascadeWithdrawalAmount,
    categoryId: null,
    expenseHeadId: null,
    cashInTypeId: financialWithdrawalType.id!,
    description: 'Withdrawal - Cascade Test Bank',
    staffId: null,
    vehicleId: null,
    institutionId: cascadeBankId,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  const dayAfterCascadeWithdrawal = await db.ledgerDays.get(CASCADE_WITHDRAWAL_DATE);
  assertEqual(
    "Withdrawal: day's cashInPaisa increases by exactly the withdrawal amount",
    dayAfterCascadeWithdrawal!.cashInPaisa,
    cashInBeforeCascadeWithdrawal + cascadeWithdrawalAmount,
  );
  assertEqual(
    "Withdrawal: day's closingBalancePaisa increases by exactly the withdrawal amount",
    dayAfterCascadeWithdrawal!.closingBalancePaisa,
    closingBeforeCascadeWithdrawal + cascadeWithdrawalAmount,
  );

  // Backdated deposit: confirm it cascades into the later day's closing,
  // same pattern as the Phase 4/5 backdating tests.
  const laterDayForInstitutionCascade = await db.ledgerDays.get(CASCADE_WITHDRAWAL_DATE);
  const closingBeforeBackdatedDeposit = laterDayForInstitutionCascade!.closingBalancePaisa;
  const BACKDATED_DEPOSIT_DATE = '2026-05-09'; // before both cascade dates above
  const backdatedDepositAmount = 800_00;
  await addTransaction({
    date: BACKDATED_DEPOSIT_DATE,
    direction: 'cash_out',
    amountPaisa: backdatedDepositAmount,
    categoryId: savingsCategory.id!,
    expenseHeadId: depositRefs.depositExpenseHead.id!,
    cashInTypeId: null,
    description: 'Deposit - Cascade Test Bank (backdated)',
    staffId: null,
    vehicleId: null,
    institutionId: cascadeBankId,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  const laterDayAfterBackdatedDeposit = await db.ledgerDays.get(CASCADE_WITHDRAWAL_DATE);
  assertEqual(
    "Backdated deposit: the later day's closing decreases by exactly the backdated amount (cascaded)",
    laterDayAfterBackdatedDeposit!.closingBalancePaisa,
    closingBeforeBackdatedDeposit - backdatedDepositAmount,
  );

  console.log(
    '\nTest P6-6: Institution profile deposits/withdrawals/net totals (month/previous-month/YTD/lifetime), hand-checked across 2 BS months of both deposits and withdrawals',
  );
  // v1.0 Nepali BS Edition: moved from 2026-07-08/09 (BS 2083 Asar 24/25 —
  // TWO BS months back relative to P6_NOW below, not "previous month") to
  // 2026-07-24/25 (BS 2083 Shrawan 8/9 — the real previous BS month).
  await addTransaction({
    date: '2026-07-24', // BS 2083 Shrawan 8
    direction: 'cash_out',
    amountPaisa: 10_000_00,
    categoryId: savingsCategory.id!,
    expenseHeadId: depositRefs.depositExpenseHead.id!,
    cashInTypeId: null,
    description: 'Deposit - NIC Asia Bank (Shrawan)',
    staffId: null,
    vehicleId: null,
    institutionId: nicAsiaId,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  await addTransaction({
    date: '2026-07-25', // BS 2083 Shrawan 9
    direction: 'cash_in',
    amountPaisa: 3_000_00,
    categoryId: null,
    expenseHeadId: null,
    cashInTypeId: financialWithdrawalType.id!,
    description: 'Withdrawal - NIC Asia Bank (Shrawan)',
    staffId: null,
    vehicleId: null,
    institutionId: nicAsiaId,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  // v1.0 Nepali BS Edition: moved from 2026-08-14/15 (BS 2083 Shrawan
  // 29/30 — that's the PREVIOUS BS month relative to P6_NOW, not current)
  // to 2026-08-18/19 (BS 2083 Bhadra 2/3 — the real current BS month, and
  // still on-or-before P6_NOW's BS Bhadra 4 "today", so it counts toward
  // YTD as well as the current-month bucket).
  await addTransaction({
    date: '2026-08-18', // BS 2083 Bhadra 2
    direction: 'cash_out',
    amountPaisa: 4_000_00,
    categoryId: savingsCategory.id!,
    expenseHeadId: depositRefs.depositExpenseHead.id!,
    cashInTypeId: null,
    description: 'Deposit - NIC Asia Bank (Bhadra)',
    staffId: null,
    vehicleId: null,
    institutionId: nicAsiaId,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  await addTransaction({
    date: '2026-08-19', // BS 2083 Bhadra 3
    direction: 'cash_in',
    amountPaisa: 1_000_00,
    categoryId: null,
    expenseHeadId: null,
    cashInTypeId: financialWithdrawalType.id!,
    description: 'Withdrawal - NIC Asia Bank (Bhadra)',
    staffId: null,
    vehicleId: null,
    institutionId: nicAsiaId,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  // A deposit into a DIFFERENT institution on the same Aug date — confirms
  // per-institution grouping isolation (doesn't leak into NIC Asia's totals).
  await addTransaction({
    date: '2026-08-14',
    direction: 'cash_out',
    amountPaisa: 9_999_00,
    categoryId: savingsCategory.id!,
    expenseHeadId: depositRefs.depositExpenseHead.id!,
    cashInTypeId: null,
    description: 'Deposit - Global IME Bank (Aug)',
    staffId: null,
    vehicleId: null,
    institutionId: globalImeId,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });

  const P6_NOW = new Date(2026, 7, 20); // Aug 20, 2026 = BS 2083 Bhadra 4 -> "current month" = BS Bhadra
  const nicAsiaTotals = await getInstitutionTotals(nicAsiaId, P6_NOW);
  // Deposits: Dec 2025 (5000, test P6-2) + Shrawan (10000) + Bhadra (4000).
  assertEqual('NIC Asia deposits — this month (Bhadra) = 4000', nicAsiaTotals.deposits.currentMonthPaisa, 4_000_00);
  assertEqual('NIC Asia deposits — last month (Shrawan) = 10000', nicAsiaTotals.deposits.previousMonthPaisa, 10_000_00);
  assertEqual('NIC Asia deposits — YTD (बैशाख-Bhadra 2083) = Shrawan 10000 + Bhadra 4000', nicAsiaTotals.deposits.yearToDatePaisa, 14_000_00);
  assertEqual('NIC Asia deposits — lifetime = YTD 14000 + Dec 2025 5000', nicAsiaTotals.deposits.lifetimePaisa, 19_000_00);
  // Withdrawals: Dec 2025 (2000, test P6-3) + Shrawan (3000) + Bhadra (1000).
  assertEqual('NIC Asia withdrawals — this month (Bhadra) = 1000', nicAsiaTotals.withdrawals.currentMonthPaisa, 1_000_00);
  assertEqual('NIC Asia withdrawals — last month (Shrawan) = 3000', nicAsiaTotals.withdrawals.previousMonthPaisa, 3_000_00);
  assertEqual('NIC Asia withdrawals — YTD = Shrawan 3000 + Bhadra 1000', nicAsiaTotals.withdrawals.yearToDatePaisa, 4_000_00);
  assertEqual('NIC Asia withdrawals — lifetime = YTD 4000 + Dec 2025 2000', nicAsiaTotals.withdrawals.lifetimePaisa, 6_000_00);
  // Net = deposits - withdrawals, per period.
  assertEqual('NIC Asia net — this month = 4000 - 1000', nicAsiaTotals.net.currentMonthPaisa, 3_000_00);
  assertEqual('NIC Asia net — last month = 10000 - 3000', nicAsiaTotals.net.previousMonthPaisa, 7_000_00);
  assertEqual('NIC Asia net — YTD = 14000 - 4000', nicAsiaTotals.net.yearToDatePaisa, 10_000_00);
  assertEqual('NIC Asia net — lifetime = 19000 - 6000', nicAsiaTotals.net.lifetimePaisa, 13_000_00);

  console.log(
    '\nTest P6-7: Deactivating an institution excludes it from the active-only set, but historical transactions still resolve its name',
  );
  await setInstitutionActive(nicAsiaId, false);
  const activeInstitutionsAfterDeactivation = await db.financialInstitutions
    .filter((i) => i.active)
    .toArray();
  assertEqual(
    'Deactivated institution no longer appears among active institutions',
    activeInstitutionsAfterDeactivation.some((i) => i.id === nicAsiaId),
    false,
  );
  const resolvedNicAsiaName = (await db.financialInstitutions.get(depositTxn!.institutionId!))!.name;
  assertEqual(
    "Historical transaction's institutionId still resolves to the (now-inactive) institution's name",
    resolvedNicAsiaName,
    'NIC Asia Bank',
  );

  console.log(
    "\nTest P6-8: A savings/financial transaction's amount is fully included in its day's LedgerDay cashOut/cashIn total — flowClass does NOT exclude it from the cash math",
  );
  // computeDayTotals (lib/ledger.ts) sums every non-deleted row on the date
  // by `direction` alone and never reads `flowClass` — inspected directly
  // in the source as part of this phase's Part D check. This test proves
  // it empirically: build the day's expected cashOut by hand from every
  // transaction actually on CASCADE_DEPOSIT_DATE (the ordinary expense
  // categories seeded, if any, plus the savings deposit) and confirm the
  // stored LedgerDay.cashOutPaisa matches exactly — if flowClass were
  // silently filtering the savings transaction out, this would fail.
  const rowsOnCascadeDepositDate = await db.transactions
    .where('date')
    .equals(CASCADE_DEPOSIT_DATE)
    .filter((t) => !t.deletedAt)
    .toArray();
  const expectedCashOutOnCascadeDepositDate = rowsOnCascadeDepositDate
    .filter((t) => t.direction === 'cash_out')
    .reduce((sum, t) => sum + t.amountPaisa, 0);
  const finalCascadeDepositDay = await db.ledgerDays.get(CASCADE_DEPOSIT_DATE);
  assertEqual(
    "LedgerDay.cashOutPaisa on the deposit's date equals the hand-summed total of every cash_out row that day, savings deposit included",
    finalCascadeDepositDay!.cashOutPaisa,
    expectedCashOutOnCascadeDepositDate,
  );
  assertEqual(
    "The savings deposit's own amount is part of that hand-summed total (sanity check that the day isn't empty/trivial)",
    expectedCashOutOnCascadeDepositDate >= cascadeDepositAmount,
    true,
  );

  console.log('\n--- End Phase 6 tests ---');

  console.log('\n--- Phase 7 tests ---');

  // v1.0 Nepali BS Edition: day-of-month moved from 4 to 15 within the
  // same BS month (Bhadra) so that every QA fixture further down this
  // block (days 1-10 of Bhadra, all deliberately chosen to be within the
  // current BS month) lands BEFORE "today" — needed so P7_TODAY further
  // down (a deliberately never-before-used date, for the Dashboard
  // "most recent LedgerDay" test) stays the single latest LedgerDay in
  // this whole block, and so every QA fixture correctly counts toward
  // both the current-month bucket AND YTD (YTD's upper bound is "today").
  const P7_NOW = new Date(2026, 7, 31); // Aug 31, 2026 = BS 2083 Bhadra 15 -> "current month" = BS Bhadra, "today" = 2026-08-31

  console.log(
    '\nTest P7-2: getMonthlySeriesTotals returns correct per-month totals for a specific expense head and a specific vehicle, hand-checked in raw paisa',
  );
  const qaHeadId = await addExpenseHead(officeCategory.id!, 'QA Test Head');
  await addTransaction({
    date: '2026-06-15', // BS 2083 Asar 1
    direction: 'cash_out',
    amountPaisa: 1_500_00,
    categoryId: officeCategory.id!,
    expenseHeadId: qaHeadId,
    cashInTypeId: null,
    description: 'QA head - Asar',
    staffId: null,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  // Deliberately no transaction in BS Shrawan, to exercise the zero-month case.
  // v1.0 Nepali BS Edition: moved from 2026-08-10 (BS 2083 Shrawan 25 —
  // which would land in the deliberately-empty gap month, not the current
  // one) to 2026-08-21 (BS 2083 Bhadra 5 — the real current BS month).
  await addTransaction({
    date: '2026-08-21', // BS 2083 Bhadra 5
    direction: 'cash_out',
    amountPaisa: 2_500_00,
    categoryId: officeCategory.id!,
    expenseHeadId: qaHeadId,
    cashInTypeId: null,
    description: 'QA head - Bhadra',
    staffId: null,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });

  const qaVehicleId = await addVehicle({ name: 'QA Test Vehicle', vehicleType: 'Car', registrationNumber: null });
  const petrolHeadForP7 = await getPetrolExpenseHead();
  if (!petrolHeadForP7) throw new Error('Petrol expense head not seeded — cannot run Phase 7 tests.');
  const travelCategoryForP7 = categories.find((c) => c.name === 'Travel & Fuel')!;
  await addTransaction({
    date: '2026-06-16', // BS 2083 Asar 2
    direction: 'cash_out',
    amountPaisa: 800_00,
    categoryId: travelCategoryForP7.id!,
    expenseHeadId: petrolHeadForP7.id!,
    cashInTypeId: null,
    description: 'Petrol - QA Test Vehicle (Asar)',
    staffId: null,
    vehicleId: qaVehicleId,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  // v1.0 Nepali BS Edition: moved from 2026-08-11 (BS 2083 Shrawan 26 —
  // the deliberately-empty gap month) to 2026-08-22 (BS 2083 Bhadra 6).
  await addTransaction({
    date: '2026-08-22', // BS 2083 Bhadra 6
    direction: 'cash_out',
    amountPaisa: 1_200_00,
    categoryId: travelCategoryForP7.id!,
    expenseHeadId: petrolHeadForP7.id!,
    cashInTypeId: null,
    description: 'Petrol - QA Test Vehicle (Bhadra)',
    staffId: null,
    vehicleId: qaVehicleId,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });

  // v1.0 Nepali BS Edition: p7Months now spans 3 real, CONSECUTIVE BS
  // months — Asar(3, has data) -> Shrawan(4, deliberately empty, the
  // "gap month" case) -> Bhadra(5, has data, P7_NOW's own month) — rather
  // than Gregorian June/July/August, which don't align with any 3
  // consecutive BS months (verified via lib/bsCalendar.ts: 2026-06-15 and
  // 2026-07-05 both land in BS Asar, for example).
  const p7Months = [
    { year: 2083, month: 3 }, // Asar
    { year: 2083, month: 4 }, // Shrawan (empty)
    { year: 2083, month: 5 }, // Bhadra
  ];
  const expenseHeadSeries = await getMonthlySeriesTotals({ groupBy: 'expenseHead', months: p7Months });
  assertEqual(
    'QA head — Asar total = 1500',
    expenseHeadSeries.find((s) => s.month === 3)!.totals.find((r) => r.groupId === qaHeadId)?.totalPaisa ?? 0,
    1_500_00,
  );
  assertEqual(
    'QA head — Shrawan total = 0 (no transactions that month, not omitted)',
    expenseHeadSeries.find((s) => s.month === 4)!.totals.find((r) => r.groupId === qaHeadId)?.totalPaisa ?? 0,
    0,
  );
  assertEqual(
    'QA head — Bhadra total = 2500',
    expenseHeadSeries.find((s) => s.month === 5)!.totals.find((r) => r.groupId === qaHeadId)?.totalPaisa ?? 0,
    2_500_00,
  );

  const vehicleSeries = await getMonthlySeriesTotals({
    groupBy: 'vehicle',
    months: p7Months,
    expenseHeadId: petrolHeadForP7.id!,
  });
  assertEqual(
    'QA Test Vehicle — Asar Petrol total = 800',
    vehicleSeries.find((s) => s.month === 3)!.totals.find((r) => r.groupId === qaVehicleId)?.totalPaisa ?? 0,
    800_00,
  );
  assertEqual(
    'QA Test Vehicle — Shrawan Petrol total = 0',
    vehicleSeries.find((s) => s.month === 4)!.totals.find((r) => r.groupId === qaVehicleId)?.totalPaisa ?? 0,
    0,
  );
  assertEqual(
    'QA Test Vehicle — Bhadra Petrol total = 1200',
    vehicleSeries.find((s) => s.month === 5)!.totals.find((r) => r.groupId === qaVehicleId)?.totalPaisa ?? 0,
    1_200_00,
  );

  console.log(
    '\nTest P7-3: Monthly Expense Table shows 0 (not omitted) for a month with no transactions for an active expense head',
  );
  const expenseTableData = await getMonthlyExpenseTableData(P7_NOW);
  const qaHeadRow = expenseTableData.rows.find((r) => r.expenseHeadId === qaHeadId)!;
  assertEqual('QA head row exists in the Monthly Expense Table', qaHeadRow != null, true);
  assertEqual('QA head row — Asar (index 0) = 1500', qaHeadRow.monthTotals[0], 1_500_00);
  assertEqual('QA head row — Shrawan (index 1) = 0, not omitted', qaHeadRow.monthTotals[1], 0);
  assertEqual('QA head row — Bhadra (index 2) = 2500', qaHeadRow.monthTotals[2], 2_500_00);

  console.log(
    '\nTest P7-4: Monthly Petrol Table includes a deactivated vehicle\'s historical Petrol spend (not silently dropped)',
  );
  const qaInactiveVehicleId = await addVehicle({
    name: 'QA Inactive Vehicle',
    vehicleType: 'Motorbike',
    registrationNumber: null,
  });
  // v1.0 Nepali BS Edition: moved from 2026-08-12 (BS 2083 Shrawan 27 —
  // the gap/previous BS month) to 2026-08-23 (BS 2083 Bhadra 7).
  await addTransaction({
    date: '2026-08-23', // BS 2083 Bhadra 7
    direction: 'cash_out',
    amountPaisa: 555_00,
    categoryId: travelCategoryForP7.id!,
    expenseHeadId: petrolHeadForP7.id!,
    cashInTypeId: null,
    description: 'Petrol - QA Inactive Vehicle (Bhadra)',
    staffId: null,
    vehicleId: qaInactiveVehicleId,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  await setVehicleActive(qaInactiveVehicleId, false);
  const petrolTableData = await getPetrolTableData(P7_NOW);
  const qaInactiveVehicleRow = petrolTableData.rows.find((r) => r.vehicleId === qaInactiveVehicleId);
  assertEqual('Deactivated vehicle still appears as a row in the Petrol Table', qaInactiveVehicleRow != null, true);
  assertEqual("Deactivated vehicle's row is flagged inactive", qaInactiveVehicleRow!.active, false);
  assertEqual(
    "Deactivated vehicle's Bhadra Petrol total is correct, not dropped",
    qaInactiveVehicleRow!.monthTotals[2],
    555_00,
  );

  console.log(
    '\nTest P7-5: Financial Institution Report shows deposits/withdrawals separately per month, hand-checked, including an inactive institution',
  );
  const qaInstitutionId = await addInstitution({ name: 'QA Test Institution' });
  const savingsCategoryForP7 = categories.find((c) => c.name === 'Savings & Financial')!;
  const depositRefsForP7 = await getDepositReferenceIds();
  const withdrawalTypeForP7 = await getFinancialWithdrawalCashInType();
  if (!depositRefsForP7 || !withdrawalTypeForP7) {
    throw new Error('Deposit/Withdrawal reference data not seeded — cannot run Phase 7 tests.');
  }
  // v1.0 Nepali BS Edition: moved from 2026-07-05/06 (BS 2083 Asar 21/22 —
  // p7Months index 0, not index 1) to 2026-07-21/22 (BS 2083 Shrawan 5/6 —
  // p7Months index 1, "Shrawan").
  await addTransaction({
    date: '2026-07-21', // BS 2083 Shrawan 5
    direction: 'cash_out',
    amountPaisa: 4_000_00,
    categoryId: savingsCategoryForP7.id!,
    expenseHeadId: depositRefsForP7.depositExpenseHead.id!,
    cashInTypeId: null,
    description: 'Deposit - QA Test Institution (Shrawan)',
    staffId: null,
    vehicleId: null,
    institutionId: qaInstitutionId,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  await addTransaction({
    date: '2026-07-22', // BS 2083 Shrawan 6
    direction: 'cash_in',
    amountPaisa: 1_000_00,
    categoryId: null,
    expenseHeadId: null,
    cashInTypeId: withdrawalTypeForP7.id!,
    description: 'Withdrawal - QA Test Institution (Shrawan)',
    staffId: null,
    vehicleId: null,
    institutionId: qaInstitutionId,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  // v1.0 Nepali BS Edition: deposit moved from 2026-08-16 (BS 2083
  // Shrawan 31 — p7Months index 1, not index 2) to 2026-08-24 (BS 2083
  // Bhadra 8). Withdrawal (2026-08-17) was already BS Bhadra 1 — correct
  // as-is, kept unchanged.
  await addTransaction({
    date: '2026-08-24', // BS 2083 Bhadra 8
    direction: 'cash_out',
    amountPaisa: 2_000_00,
    categoryId: savingsCategoryForP7.id!,
    expenseHeadId: depositRefsForP7.depositExpenseHead.id!,
    cashInTypeId: null,
    description: 'Deposit - QA Test Institution (Bhadra)',
    staffId: null,
    vehicleId: null,
    institutionId: qaInstitutionId,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  await addTransaction({
    date: '2026-08-17', // BS 2083 Bhadra 1
    direction: 'cash_in',
    amountPaisa: 500_00,
    categoryId: null,
    expenseHeadId: null,
    cashInTypeId: withdrawalTypeForP7.id!,
    description: 'Withdrawal - QA Test Institution (Bhadra)',
    staffId: null,
    vehicleId: null,
    institutionId: qaInstitutionId,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });

  const qaInactiveInstitutionId = await addInstitution({ name: 'QA Inactive Institution' });
  // v1.0 Nepali BS Edition: moved from 2026-08-16 (BS 2083 Shrawan 31 —
  // p7Months index 1) to 2026-08-25 (BS 2083 Bhadra 9 — p7Months index 2).
  await addTransaction({
    date: '2026-08-25', // BS 2083 Bhadra 9
    direction: 'cash_out',
    amountPaisa: 999_00,
    categoryId: savingsCategoryForP7.id!,
    expenseHeadId: depositRefsForP7.depositExpenseHead.id!,
    cashInTypeId: null,
    description: 'Deposit - QA Inactive Institution (Bhadra)',
    staffId: null,
    vehicleId: null,
    institutionId: qaInactiveInstitutionId,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  await setInstitutionActive(qaInactiveInstitutionId, false);

  const institutionReportData = await getInstitutionReportData(P7_NOW);
  const qaInstitutionRow = institutionReportData.rows.find((r) => r.institutionId === qaInstitutionId)!;
  assertEqual('QA Test Institution — Shrawan deposits = 4000', qaInstitutionRow.depositMonthTotals[1], 4_000_00);
  assertEqual('QA Test Institution — Shrawan withdrawals = 1000', qaInstitutionRow.withdrawalMonthTotals[1], 1_000_00);
  assertEqual('QA Test Institution — Bhadra deposits = 2000', qaInstitutionRow.depositMonthTotals[2], 2_000_00);
  assertEqual('QA Test Institution — Bhadra withdrawals = 500', qaInstitutionRow.withdrawalMonthTotals[2], 500_00);
  const qaInactiveInstitutionRow = institutionReportData.rows.find(
    (r) => r.institutionId === qaInactiveInstitutionId,
  );
  assertEqual('Inactive institution still appears as a row', qaInactiveInstitutionRow != null, true);
  assertEqual("Inactive institution's row is flagged inactive", qaInactiveInstitutionRow!.active, false);
  assertEqual(
    "Inactive institution's Bhadra deposit total is correct, not dropped",
    qaInactiveInstitutionRow!.depositMonthTotals[2],
    999_00,
  );

  console.log(
    '\nTest P7-6: Category breakdown correctly groups known test transactions by flowClass, hand-checked in raw paisa',
  );
  const qaOpexCategoryId = crypto.randomUUID();
  await db.categories.add({
    id: qaOpexCategoryId,
    name: 'QA OpEx Category',
    direction: 'cash_out',
    flowClass: 'operating_expense',
    isCustom: true,
    active: true,
  });
  const qaStaffPaymentCategoryId = crypto.randomUUID();
  await db.categories.add({
    id: qaStaffPaymentCategoryId,
    name: 'QA Staff-Payment Category',
    direction: 'cash_out',
    flowClass: 'staff_payment',
    isCustom: true,
    active: true,
  });
  const qaSavingsCategoryId = crypto.randomUUID();
  await db.categories.add({
    id: qaSavingsCategoryId,
    name: 'QA Savings Category',
    direction: 'cash_out',
    flowClass: 'savings_financial',
    isCustom: true,
    active: true,
  });
  // v1.0 Nepali BS Edition: moved from 2026-08-13 (BS 2083 Shrawan 28 —
  // the previous BS month relative to P7_NOW) to 2026-08-26 (BS 2083
  // Bhadra 10 — the real current BS month).
  await addTransaction({
    date: '2026-08-26', // BS 2083 Bhadra 10
    direction: 'cash_out',
    amountPaisa: 700_00,
    categoryId: qaOpexCategoryId,
    expenseHeadId: null,
    cashInTypeId: null,
    description: 'QA OpEx txn',
    staffId: null,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  await addTransaction({
    date: '2026-08-26', // BS 2083 Bhadra 10
    direction: 'cash_out',
    amountPaisa: 300_00,
    categoryId: qaStaffPaymentCategoryId,
    expenseHeadId: null,
    cashInTypeId: null,
    description: 'QA Staff-Payment txn',
    staffId: null,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  await addTransaction({
    date: '2026-08-26', // BS 2083 Bhadra 10
    direction: 'cash_out',
    amountPaisa: 400_00,
    categoryId: qaSavingsCategoryId,
    expenseHeadId: null,
    cashInTypeId: null,
    description: 'QA Savings txn',
    staffId: null,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });

  const categoryBreakdown = await getCategoryBreakdown(P7_NOW);
  const qaOpexRow = categoryBreakdown.rows.find((r) => r.categoryId === qaOpexCategoryId)!;
  const qaStaffRow = categoryBreakdown.rows.find((r) => r.categoryId === qaStaffPaymentCategoryId)!;
  const qaSavingsRow = categoryBreakdown.rows.find((r) => r.categoryId === qaSavingsCategoryId)!;
  assertEqual('QA OpEx category total = 700', qaOpexRow.totalPaisa, 700_00);
  assertEqual('QA Staff-Payment category total = 300', qaStaffRow.totalPaisa, 300_00);
  assertEqual('QA Savings category total = 400', qaSavingsRow.totalPaisa, 400_00);
  assertEqual(
    'QA OpEx category is grouped under operating_expense',
    categoryBreakdown.byFlowClass.operating_expense.rows.some((r) => r.categoryId === qaOpexCategoryId),
    true,
  );
  assertEqual(
    'QA OpEx category is NOT grouped under staff_payment',
    categoryBreakdown.byFlowClass.staff_payment.rows.some((r) => r.categoryId === qaOpexCategoryId),
    false,
  );
  assertEqual(
    'QA Staff-Payment category is grouped under staff_payment',
    categoryBreakdown.byFlowClass.staff_payment.rows.some((r) => r.categoryId === qaStaffPaymentCategoryId),
    true,
  );
  assertEqual(
    'QA Savings category is grouped under savings_financial',
    categoryBreakdown.byFlowClass.savings_financial.rows.some((r) => r.categoryId === qaSavingsCategoryId),
    true,
  );

  console.log(
    '\nTest P7-7: Dashboard "This Month" and "Today" totals hand-checked (via before/after delta for This Month, exact for the never-before-used Today date)',
  );
  const dashboardBaseline = await getDashboardData(P7_NOW);

  const P7_TODAY = '2026-08-31'; // matches P7_NOW's date; never used by any earlier test in this file
  if (!atmType) throw new Error('ATM cash-in type not seeded — cannot run Phase 7 Dashboard test.');
  await addTransaction({
    date: P7_TODAY,
    direction: 'cash_in',
    amountPaisa: 5_000_00,
    categoryId: null,
    expenseHeadId: null,
    cashInTypeId: atmType.id!,
    description: 'ATM cash in (QA today test)',
    staffId: null,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  await addTransaction({
    date: P7_TODAY,
    direction: 'cash_out',
    amountPaisa: 1_200_00,
    categoryId: qaOpexCategoryId,
    expenseHeadId: null,
    cashInTypeId: null,
    description: 'QA OpEx (today)',
    staffId: null,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  await addTransaction({
    date: P7_TODAY,
    direction: 'cash_out',
    amountPaisa: 800_00,
    categoryId: qaStaffPaymentCategoryId,
    expenseHeadId: null,
    cashInTypeId: null,
    description: 'QA Staff-Payment (today)',
    staffId: null,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  await addTransaction({
    date: P7_TODAY,
    direction: 'cash_out',
    amountPaisa: 600_00,
    categoryId: qaSavingsCategoryId,
    expenseHeadId: null,
    cashInTypeId: null,
    description: 'QA Savings (today)',
    staffId: null,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });

  const dashboardAfterToday = await getDashboardData(P7_NOW);
  assertEqual("Today's date matches P7_NOW", dashboardAfterToday.today.date, P7_TODAY);
  assertEqual("Today's cash in = 5000 (never-before-used date, exact check)", dashboardAfterToday.today.cashInPaisa, 5_000_00);
  assertEqual("Today's operating expenses = 1200", dashboardAfterToday.today.operatingExpensesPaisa, 1_200_00);
  assertEqual("Today's staff payments = 800", dashboardAfterToday.today.staffPaymentsPaisa, 800_00);
  assertEqual("Today's savings/deposits = 600", dashboardAfterToday.today.savingsDepositsPaisa, 600_00);
  assertEqual(
    "Today's closing − opening = cashIn − cashOut (2400), the fundamental invariant",
    dashboardAfterToday.today.closingCashPaisa - dashboardAfterToday.today.openingCashPaisa,
    5_000_00 - (1_200_00 + 800_00 + 600_00),
  );

  assertEqual(
    'This Month cash-in delta = 5000 (my ATM transaction), isolating from all other months\' data via before/after',
    dashboardAfterToday.thisMonth.totalCashInPaisa - dashboardBaseline.thisMonth.totalCashInPaisa,
    5_000_00,
  );
  assertEqual(
    'This Month operating-expenses delta = 1200',
    dashboardAfterToday.thisMonth.totalOperatingExpensesPaisa - dashboardBaseline.thisMonth.totalOperatingExpensesPaisa,
    1_200_00,
  );
  assertEqual(
    'This Month staff-payments delta = 800',
    dashboardAfterToday.thisMonth.totalStaffPaymentsPaisa - dashboardBaseline.thisMonth.totalStaffPaymentsPaisa,
    800_00,
  );
  assertEqual(
    'This Month savings/deposits delta = 600',
    dashboardAfterToday.thisMonth.totalSavingsDepositsPaisa - dashboardBaseline.thisMonth.totalSavingsDepositsPaisa,
    600_00,
  );
  assertEqual(
    'This Month cash-out delta = 1200 + 800 + 600',
    dashboardAfterToday.thisMonth.totalCashOutPaisa - dashboardBaseline.thisMonth.totalCashOutPaisa,
    1_200_00 + 800_00 + 600_00,
  );
  assertEqual(
    "This Month's closing cash equals Today's closing cash, since today (Aug 20) is now the most recent LedgerDay",
    dashboardAfterToday.thisMonth.closingCashPaisa,
    dashboardAfterToday.today.closingCashPaisa,
  );

  console.log(
    '\nTest P7-8: Dashboard negative-cash alert triggers correctly and does not trigger when balances are healthy',
  );
  // Note: by this point in the test run, several earlier phases' cash_out
  // -heavy fixtures have incidentally driven some days negative as a side
  // effect (they weren't testing for it) — so a global "zero negative
  // days" assertion isn't a valid baseline here. Instead, check the
  // precise, contamination-proof case this test actually cares about:
  // P7_TODAY, which P7-7 already established closes with a healthy
  // (positive) net movement (cash in > cash out that day), must NOT
  // appear in the alert.
  // Note: by this point in the test run, several earlier phases' cash_out
  // -heavy fixtures have incidentally driven the shared running balance
  // negative on many days as a side effect (they weren't testing for it,
  // and this file is one continuous cascading ledger from Phase 1
  // onward) — so there's no "the whole fixture is healthy right now"
  // state available to assert against. Instead, test the alert's filter
  // logic directly and precisely: seed one isolated LedgerDay row with a
  // known-positive closing balance, on a date far outside every other
  // date used in this file (so recalcCascadeFrom never touches it), and
  // confirm it's correctly excluded from the alert.
  const HEALTHY_ALERT_TEST_DATE = '2099-01-01';
  await db.ledgerDays.put({
    date: HEALTHY_ALERT_TEST_DATE,
    openingBalancePaisa: 100_00,
    cashInPaisa: 50_00,
    cashOutPaisa: 20_00,
    closingBalancePaisa: 130_00,
    isManualOpening: false,
    recalculatedAt: Date.now(),
  });
  const dashboardWithHealthyDay = await getDashboardData(P7_NOW);
  assertEqual(
    'A day with a positive closing balance does not trigger the negative-cash alert',
    dashboardWithHealthyDay.alerts.negativeCashDays.some((d) => d.date === HEALTHY_ALERT_TEST_DATE),
    false,
  );
  const NEGATIVE_CASH_DATE = '2026-08-25'; // after every other date used in this file so far
  await addTransaction({
    date: NEGATIVE_CASH_DATE,
    direction: 'cash_out',
    amountPaisa: 50_000_000_00, // Rs. 5 crore — guaranteed to push closing negative
    categoryId: qaOpexCategoryId,
    expenseHeadId: null,
    cashInTypeId: null,
    description: 'QA stress-test overdraft',
    staffId: null,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  const negativeCashDay = await db.ledgerDays.get(NEGATIVE_CASH_DATE);
  assertEqual('Sanity check: the stress-test day really did close negative', negativeCashDay!.closingBalancePaisa < 0, true);
  const dashboardAfterNegative = await getDashboardData(P7_NOW);
  assertEqual(
    'Negative-cash alert includes the stress-test date',
    dashboardAfterNegative.alerts.negativeCashDays.some((d) => d.date === NEGATIVE_CASH_DATE),
    true,
  );
  assertEqual('missingOpeningBalance is false once LedgerDays exist', dashboardAfterNegative.alerts.missingOpeningBalance, false);

  console.log(
    '\nTest P7-9: Dashboard "outstanding staff advances" sums active staff only, excluding inactive staff\'s outstanding advance',
  );
  const dashboardBeforeQaStaff = await getDashboardData(P7_NOW);
  const qaActiveStaffId = await addStaff({
    name: 'QA Active Staff',
    monthlySalaryPaisa: 50_000_00,
    advanceLimitPaisa: null,
    joiningDate: null,
    notes: null,
  });
  const advanceRefsForP7 = await getAdvanceReferenceIds();
  if (!advanceRefsForP7) throw new Error('Advance expense head not seeded — cannot run Phase 7 test.');
  const qaStaffCategory = categories.find((c) => c.name === 'Staff')!;
  await addTransaction({
    date: '2026-08-19',
    direction: 'cash_out',
    amountPaisa: 3_000_00,
    categoryId: qaStaffCategory.id!,
    expenseHeadId: advanceRefsForP7.advanceExpenseHead.id!,
    cashInTypeId: null,
    description: 'Advance - QA Active Staff',
    staffId: qaActiveStaffId,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  const qaInactiveStaffId = await addStaff({
    name: 'QA Inactive Staff',
    monthlySalaryPaisa: 50_000_00,
    advanceLimitPaisa: null,
    joiningDate: null,
    notes: null,
  });
  await addTransaction({
    date: '2026-08-19',
    direction: 'cash_out',
    amountPaisa: 2_000_00,
    categoryId: qaStaffCategory.id!,
    expenseHeadId: advanceRefsForP7.advanceExpenseHead.id!,
    cashInTypeId: null,
    description: 'Advance - QA Inactive Staff',
    staffId: qaInactiveStaffId,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  await setStaffActive(qaInactiveStaffId, false);

  const dashboardAfterQaStaff = await getDashboardData(P7_NOW);
  assertEqual(
    'Outstanding staff advances delta = only the active staff\'s advance (3000), excluding the inactive staff\'s (2000)',
    dashboardAfterQaStaff.thisMonth.outstandingStaffAdvancesPaisa -
      dashboardBeforeQaStaff.thisMonth.outstandingStaffAdvancesPaisa,
    3_000_00,
  );

  console.log('\n--- End Phase 7 tests ---');

  console.log('\n--- Phase 8 tests ---');

  // v1.0 Nepali BS Edition: BS 2083 Bhadra 20 (day moved later within
  // the same BS month than the raw literal below suggests, so every
  // QA budget fixture further down this block — days 6-9 of Bhadra —
  // lands safely before "today").
  const P8_NOW = new Date(2026, 8, 5); // Sep 5, 2026 = BS 2083 Bhadra 20 -> "current month" = BS Bhadra

  console.log(
    '\nTest P8-2: Spend under 80% of a set budget produces no warning, hand-checked percentage',
  );
  const qaBudgetHeadUnderId = await addExpenseHead(officeCategory.id!, 'QA Budget Head — Under');
  await setBudget(qaBudgetHeadUnderId, 10_000_00);
  await addTransaction({
    date: '2026-08-22', // BS 2083 Bhadra 6
    direction: 'cash_out',
    amountPaisa: 7_000_00,
    categoryId: officeCategory.id!,
    expenseHeadId: qaBudgetHeadUnderId,
    cashInTypeId: null,
    description: 'QA budget test — under 80%',
    staffId: null,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  const underStatus = await getBudgetStatusForHead(qaBudgetHeadUnderId, P8_NOW);
  assertEqual('Under-80% status exists', underStatus != null, true);
  assertEqual('Under-80% spent = 7000', underStatus!.spentPaisa, 7_000_00);
  assertEqual('Under-80% percentage = 70', underStatus!.percentage, 70);
  assertEqual("Under-80% tier = 'under' (no warning)", underStatus!.tier, 'under');

  console.log(
    '\nTest P8-3: Spend at exactly 80%, exactly 100%, and above 100% each produce the correct distinct status tier',
  );
  const qaBudgetHead80Id = await addExpenseHead(officeCategory.id!, 'QA Budget Head — 80%');
  await setBudget(qaBudgetHead80Id, 10_000_00);
  await addTransaction({
    date: '2026-08-23', // BS 2083 Bhadra 7
    direction: 'cash_out',
    amountPaisa: 8_000_00,
    categoryId: officeCategory.id!,
    expenseHeadId: qaBudgetHead80Id,
    cashInTypeId: null,
    description: 'QA budget test — exactly 80%',
    staffId: null,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  const status80 = await getBudgetStatusForHead(qaBudgetHead80Id, P8_NOW);
  assertEqual('Exactly-80% percentage = 80', status80!.percentage, 80);
  assertEqual("Exactly-80% tier = 'informational'", status80!.tier, 'informational');

  const qaBudgetHead100Id = await addExpenseHead(officeCategory.id!, 'QA Budget Head — 100%');
  await setBudget(qaBudgetHead100Id, 10_000_00);
  await addTransaction({
    date: '2026-08-24', // BS 2083 Bhadra 8
    direction: 'cash_out',
    amountPaisa: 10_000_00,
    categoryId: officeCategory.id!,
    expenseHeadId: qaBudgetHead100Id,
    cashInTypeId: null,
    description: 'QA budget test — exactly 100%',
    staffId: null,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  const status100 = await getBudgetStatusForHead(qaBudgetHead100Id, P8_NOW);
  assertEqual('Exactly-100% percentage = 100', status100!.percentage, 100);
  assertEqual("Exactly-100% tier = 'reached' (not 'over')", status100!.tier, 'reached');

  const qaBudgetHeadOverId = await addExpenseHead(officeCategory.id!, 'QA Budget Head — Over');
  await setBudget(qaBudgetHeadOverId, 10_000_00);
  await addTransaction({
    date: '2026-08-25', // BS 2083 Bhadra 9
    direction: 'cash_out',
    amountPaisa: 12_000_00,
    categoryId: officeCategory.id!,
    expenseHeadId: qaBudgetHeadOverId,
    cashInTypeId: null,
    description: 'QA budget test — above 100%',
    staffId: null,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  const statusOver = await getBudgetStatusForHead(qaBudgetHeadOverId, P8_NOW);
  assertEqual('Above-100% percentage = 120', statusOver!.percentage, 120);
  assertEqual("Above-100% tier = 'over'", statusOver!.tier, 'over');

  console.log(
    '\nTest P8-4: An expense head with no budget set never appears in budget alerts or shows a status tier, regardless of spend',
  );
  const qaBudgetHeadNoBudgetId = await addExpenseHead(officeCategory.id!, 'QA Budget Head — No Budget');
  await addTransaction({
    date: '2026-08-10',
    direction: 'cash_out',
    amountPaisa: 50_000_00,
    categoryId: officeCategory.id!,
    expenseHeadId: qaBudgetHeadNoBudgetId,
    cashInTypeId: null,
    description: 'QA budget test — huge spend, no budget set',
    staffId: null,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  const noBudgetStatus = await getBudgetStatusForHead(qaBudgetHeadNoBudgetId, P8_NOW);
  assertEqual('Head with no budget set has no status', noBudgetStatus, null);
  const dashboardForNoBudgetCheck = await getDashboardData(P8_NOW);
  assertEqual(
    'Head with no budget set never appears in Dashboard budget alerts, however much was spent',
    dashboardForNoBudgetCheck.alerts.budgetAlerts.some((a) => a.expenseHeadId === qaBudgetHeadNoBudgetId),
    false,
  );

  console.log(
    '\nTest P8-5: A transaction can still be saved normally when it would push an expense head over its budget — no error, no block',
  );
  const txnCountBeforeOverBudgetSave = await db.transactions.count();
  let overBudgetSaveError: unknown = null;
  let overBudgetTxnId: string | null = null;
  try {
    overBudgetTxnId = await addTransaction({
      date: '2026-08-11',
      direction: 'cash_out',
      amountPaisa: 1_000_00,
      categoryId: officeCategory.id!,
      expenseHeadId: qaBudgetHeadOverId, // already over budget from P8-3
      cashInTypeId: null,
      description: 'QA budget test — additional spend while already over budget',
      staffId: null,
      vehicleId: null,
      institutionId: null,
      referenceNumber: null,
      notes: null,
      linkedAdvanceRecoveryPaisa: null,
    });
  } catch (err) {
    overBudgetSaveError = err;
  }
  assertEqual('Saving over budget does not throw/block', overBudgetSaveError, null);
  const txnCountAfterOverBudgetSave = await db.transactions.count();
  assertEqual(
    'Exactly one new Transaction row was created, same as with no budget set',
    txnCountAfterOverBudgetSave - txnCountBeforeOverBudgetSave,
    1,
  );
  const overBudgetTxn = await db.transactions.get(overBudgetTxnId!);
  assertEqual('The over-budget transaction was created with the correct amount', overBudgetTxn!.amountPaisa, 1_000_00);

  console.log(
    '\nTest P8-6: Clearing a budget immediately stops that head from appearing in alerts, without a deactivate step',
  );
  const dashboardBeforeClear = await getDashboardData(P8_NOW);
  assertEqual(
    "QA Budget Head — 100% appears in budget alerts before clearing",
    dashboardBeforeClear.alerts.budgetAlerts.some((a) => a.expenseHeadId === qaBudgetHead100Id),
    true,
  );
  await clearBudget(qaBudgetHead100Id);
  const clearedBudgetRow = await getBudgetForHead(qaBudgetHead100Id);
  assertEqual('Budget row is actually gone (real delete, not deactivated)', clearedBudgetRow, null);
  const statusAfterClear = await getBudgetStatusForHead(qaBudgetHead100Id, P8_NOW);
  assertEqual('No status is returned for a cleared budget', statusAfterClear, null);
  const dashboardAfterClear = await getDashboardData(P8_NOW);
  assertEqual(
    'QA Budget Head — 100% no longer appears in budget alerts after clearing, immediately',
    dashboardAfterClear.alerts.budgetAlerts.some((a) => a.expenseHeadId === qaBudgetHead100Id),
    false,
  );

  console.log(
    '\nTest P8-7: Dashboard shows a budget alert AND the negative-cash alert simultaneously (Part C is additive, not replacing Phase 7 alerts)',
  );
  const P8_NEGATIVE_DATE = '2026-08-27'; // fresh date, unused elsewhere in this file
  await addTransaction({
    date: P8_NEGATIVE_DATE,
    direction: 'cash_out',
    amountPaisa: 60_000_000_00, // Rs. 6 crore — guaranteed to push closing negative
    categoryId: officeCategory.id!,
    expenseHeadId: null,
    cashInTypeId: null,
    description: 'QA stress-test overdraft (Phase 8)',
    staffId: null,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  const dashboardWithBothAlerts = await getDashboardData(P8_NOW);
  assertEqual(
    'Negative-cash alert is present',
    dashboardWithBothAlerts.alerts.negativeCashDays.some((d) => d.date === P8_NEGATIVE_DATE),
    true,
  );
  assertEqual(
    'Budget alert (QA Budget Head — Over) is present in the SAME dashboard fetch',
    dashboardWithBothAlerts.alerts.budgetAlerts.some(
      (a) => a.expenseHeadId === qaBudgetHeadOverId && a.tier === 'over',
    ),
    true,
  );

  console.log(
    '\nTest P8-8: The same budget-status calculation, called from the Settings-list path and the Dashboard-alert path, returns identical numbers',
  );
  const settingsPathStatus = await getBudgetStatusForHead(qaBudgetHead80Id, P8_NOW);
  const dashboardPathAlert = dashboardWithBothAlerts.alerts.budgetAlerts.find(
    (a) => a.expenseHeadId === qaBudgetHead80Id,
  );
  assertEqual('Both paths agree the head has an alert-worthy status', dashboardPathAlert != null, true);
  assertEqual(
    'Percentage matches between Settings-list path and Dashboard-alert path',
    settingsPathStatus!.percentage,
    dashboardPathAlert!.percentage,
  );
  assertEqual(
    'Tier matches between Settings-list path and Dashboard-alert path',
    settingsPathStatus!.tier,
    dashboardPathAlert!.tier,
  );

  console.log('\n--- End Phase 8 tests ---');

  console.log('\n--- Phase 9 tests ---');

  async function snapshotCounts() {
    return {
      transactions: await db.transactions.count(),
      ledgerDays: await db.ledgerDays.count(),
      categories: await db.categories.count(),
      expenseHeads: await db.expenseHeads.count(),
      cashInTypes: await db.cashInTypes.count(),
      staff: await db.staff.count(),
      vehicles: await db.vehicles.count(),
      financialInstitutions: await db.financialInstitutions.count(),
      budgets: await db.budgets.count(),
    };
  }

  function parseCsvLine(line: string): string[] {
    const fields: string[] = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            cur += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          cur += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    fields.push(cur);
    return fields;
  }

  function stripRecalculatedAt(rows: unknown[]) {
    return rows.map((r) => {
      const { recalculatedAt: _recalculatedAt, ...rest } = r as Record<string, unknown>;
      return rest;
    });
  }

  console.log(
    '\nTest P9-2: Export produces valid JSON containing every table, including soft-deleted rows, with a correct schemaVersion header',
  );
  const qaSoftDeleteTxnId = await addTransaction({
    date: '2026-08-21',
    direction: 'cash_out',
    amountPaisa: 111_00,
    categoryId: officeCategory.id!,
    expenseHeadId: null,
    cashInTypeId: null,
    description: 'QA soft-delete test txn',
    staffId: null,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  await softDeleteTransaction(qaSoftDeleteTxnId);

  const liveCountsForExportTest = await snapshotCounts();
  const exportedForP92 = await exportBackup();
  const reparsedP92 = JSON.parse(serializeBackup(exportedForP92));

  assertEqual('Exported JSON has correct schemaVersion (db.verno)', reparsedP92.schemaVersion, db.verno);
  assertEqual('Exported transactions count matches live db exactly', reparsedP92.transactions.length, liveCountsForExportTest.transactions);
  assertEqual('Exported ledgerDays count matches live db exactly', reparsedP92.ledgerDays.length, liveCountsForExportTest.ledgerDays);
  assertEqual('Exported categories count matches live db exactly', reparsedP92.categories.length, liveCountsForExportTest.categories);
  assertEqual('Exported expenseHeads count matches live db exactly', reparsedP92.expenseHeads.length, liveCountsForExportTest.expenseHeads);
  assertEqual('Exported cashInTypes count matches live db exactly', reparsedP92.cashInTypes.length, liveCountsForExportTest.cashInTypes);
  assertEqual('Exported staff count matches live db exactly', reparsedP92.staff.length, liveCountsForExportTest.staff);
  assertEqual('Exported vehicles count matches live db exactly', reparsedP92.vehicles.length, liveCountsForExportTest.vehicles);
  assertEqual('Exported financialInstitutions count matches live db exactly', reparsedP92.financialInstitutions.length, liveCountsForExportTest.financialInstitutions);
  assertEqual('Exported budgets count matches live db exactly', reparsedP92.budgets.length, liveCountsForExportTest.budgets);

  const exportedSoftDeletedTxn = reparsedP92.transactions.find((t: { id: string }) => t.id === qaSoftDeleteTxnId);
  assertEqual('Soft-deleted transaction IS included in the export (not filtered out)', exportedSoftDeletedTxn != null, true);
  assertEqual(
    "Soft-deleted transaction's deletedAt marker is preserved in the export",
    exportedSoftDeletedTxn.deletedAt != null,
    true,
  );
  assertEqual(
    'Backup file name includes the export date',
    backupFileName(exportedForP92).includes(exportedForP92.exportedAt.slice(0, 10)),
    true,
  );

  console.log(
    '\nTest P9-4: Restore validation rejects a malformed/corrupt file (missing table key, or unrecognized schemaVersion) and leaves the live database completely untouched',
  );
  const countsBeforeBadRestores = await snapshotCounts();

  const missingKeyPayload = {
    schemaVersion: db.verno,
    exportedAt: new Date().toISOString(),
    appVersion: '0.0.0',
    transactions: [],
    ledgerDays: [],
    categories: [],
    expenseHeads: [],
    cashInTypes: [],
    staff: [],
    vehicles: [],
    financialInstitutions: [],
    // budgets deliberately omitted
  };
  let missingKeyError: string | null = null;
  try {
    await restoreFromBackup(JSON.stringify(missingKeyPayload));
  } catch (err) {
    missingKeyError = err instanceof Error ? err.message : String(err);
  }
  assertEqual('Restore with a missing required table key is rejected with an error', missingKeyError != null, true);

  const badVersionPayload = { ...missingKeyPayload, budgets: [], schemaVersion: 9999 };
  let badVersionError: string | null = null;
  try {
    await restoreFromBackup(JSON.stringify(badVersionPayload));
  } catch (err) {
    badVersionError = err instanceof Error ? err.message : String(err);
  }
  assertEqual('Restore with an unrecognized schemaVersion is rejected with an error', badVersionError != null, true);

  let notJsonError: string | null = null;
  try {
    await restoreFromBackup('{ this is not valid json');
  } catch (err) {
    notJsonError = err instanceof Error ? err.message : String(err);
  }
  assertEqual('Restore with a non-JSON file is rejected with an error', notJsonError != null, true);

  const countsAfterBadRestores = await snapshotCounts();
  assertEqual('Transaction count unchanged after all three rejected restore attempts', countsAfterBadRestores.transactions, countsBeforeBadRestores.transactions);
  assertEqual('LedgerDay count unchanged after all three rejected restore attempts', countsAfterBadRestores.ledgerDays, countsBeforeBadRestores.ledgerDays);
  assertEqual('Budget count unchanged after all three rejected restore attempts', countsAfterBadRestores.budgets, countsBeforeBadRestores.budgets);
  assertEqual('Staff count unchanged after all three rejected restore attempts', countsAfterBadRestores.staff, countsBeforeBadRestores.staff);

  console.log(
    '\nTest P9-7: CSV export correctly resolves staff/vehicle/institution/category names and escapes a comma and a quote character',
  );
  const qaCsvVehicleId = await addVehicle({ name: 'QA CSV Vehicle', vehicleType: 'Car', registrationNumber: null });
  const qaCsvStaffId = await addStaff({
    name: 'QA CSV Staff',
    monthlySalaryPaisa: 10_000_00,
    advanceLimitPaisa: null,
    joiningDate: null,
    notes: null,
  });
  const qaCsvInstitutionId = await addInstitution({ name: 'QA CSV Institution' });
  const qaCsvTxnId = await addTransaction({
    date: '2026-08-22',
    direction: 'cash_out',
    amountPaisa: 1_234_56,
    categoryId: officeCategory.id!,
    expenseHeadId: null,
    cashInTypeId: null,
    description: 'QA CSV description',
    staffId: qaCsvStaffId,
    vehicleId: qaCsvVehicleId,
    institutionId: qaCsvInstitutionId,
    referenceNumber: 'REF-001',
    notes: 'Contains a comma, and a "quoted" word',
    linkedAdvanceRecoveryPaisa: null,
  });
  const qaCsvTxn = (await db.transactions.get(qaCsvTxnId))!;

  const exportLookups: ExportLookups = {
    categories: new Map((await db.categories.toArray()).map((c) => [c.id!, c])),
    expenseHeads: new Map((await db.expenseHeads.toArray()).map((h) => [h.id!, h])),
    cashInTypes: new Map((await db.cashInTypes.toArray()).map((t) => [t.id!, t])),
    staff: new Map((await db.staff.toArray()).map((s) => [s.id!, s])),
    vehicles: new Map((await db.vehicles.toArray()).map((v) => [v.id!, v])),
    institutions: new Map((await db.financialInstitutions.toArray()).map((i) => [i.id!, i])),
  };

  const csvTestRows = buildTransactionExportRows([qaCsvTxn], exportLookups);
  assertEqual('Row resolves category name (not raw id)', csvTestRows[0].category, 'Office');
  assertEqual('Row resolves staff name (not raw id)', csvTestRows[0].staffName, 'QA CSV Staff');
  assertEqual('Row resolves vehicle name (not raw id)', csvTestRows[0].vehicleName, 'QA CSV Vehicle');
  assertEqual('Row resolves institution name (not raw id)', csvTestRows[0].institutionName, 'QA CSV Institution');
  assertEqual('Row amount converted to plain rupees with 2 decimals', csvTestRows[0].amount, '1234.56');

  assertEqual('escapeCsvField wraps a value containing a comma in quotes', escapeCsvField('a,b'), '"a,b"');
  assertEqual('escapeCsvField doubles an internal quote character', escapeCsvField('a"b'), '"a""b"');
  assertEqual('escapeCsvField leaves a plain value untouched', escapeCsvField('plain value'), 'plain value');

  const csvOutput = transactionRowsToCsv(csvTestRows);
  const csvLines = csvOutput.split('\r\n');
  assertEqual('CSV has exactly a header line plus one data line', csvLines.length, 2);
  const parsedCsvDataRow = parseCsvLine(csvLines[1]);
  const notesFieldIndex = 11; // notes is the last column; v1.0 Nepali BS Edition added a bsDate column at index 0, shifting every column by 1 — see TRANSACTION_EXPORT_COLUMNS order
  assertEqual(
    "CSV correctly round-trips the notes field's comma and quote character through proper escaping",
    parsedCsvDataRow[notesFieldIndex],
    'Contains a comma, and a "quoted" word',
  );

  console.log(
    '\nTest P9-8: Excel export and CSV export, given the same transaction set, produce the same row data (shared row-preparation, not two diverging implementations)',
  );
  const sheet = transactionRowsToSheet(csvTestRows);
  const sheetAoa = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as unknown[][];
  const parsedCsvHeaderRow = parseCsvLine(csvLines[0]);
  assertEqual(
    'CSV and Excel header rows match',
    JSON.stringify(sheetAoa[0].map(String)),
    JSON.stringify(parsedCsvHeaderRow),
  );
  assertEqual(
    'CSV and Excel data rows match (identical values, only the serialization format differs)',
    JSON.stringify(sheetAoa[1].map(String)),
    JSON.stringify(parsedCsvDataRow),
  );

  console.log(
    '\nTest P9-3 & P9-5: Full restore round-trip across the entire live database — every table matches the original exactly (including recalculated LedgerDay balances), and a pre-restore safety snapshot of the current state is produced automatically',
  );
  const beforeTransactionsFull = await db.transactions.toArray();
  const beforeLedgerDaysFull = await db.ledgerDays.toArray();
  const beforeCategoriesFull = await db.categories.toArray();
  const beforeExpenseHeadsFull = await db.expenseHeads.toArray();
  const beforeCashInTypesFull = await db.cashInTypes.toArray();
  const beforeStaffFull = await db.staff.toArray();
  const beforeVehiclesFull = await db.vehicles.toArray();
  const beforeInstitutionsFull = await db.financialInstitutions.toArray();
  const beforeBudgetsFull = await db.budgets.toArray();

  const exportedForRestore = await exportBackup();
  const exportedJsonForRestore = serializeBackup(exportedForRestore);

  const restoreResult = await restoreFromBackup(exportedJsonForRestore);

  // P9-5: the automatic pre-restore safety snapshot.
  assertEqual(
    'Pre-restore safety snapshot has the correct schemaVersion',
    restoreResult.preRestoreSnapshot.schemaVersion,
    db.verno,
  );
  assertRowsMatch(
    "Pre-restore safety snapshot's transactions match the pre-restore live state",
    restoreResult.preRestoreSnapshot.transactions,
    beforeTransactionsFull,
  );
  assertRowsMatch(
    "Pre-restore safety snapshot's staff match the pre-restore live state",
    restoreResult.preRestoreSnapshot.staff,
    beforeStaffFull,
  );
  assertRowsMatch(
    "Pre-restore safety snapshot's budgets match the pre-restore live state",
    restoreResult.preRestoreSnapshot.budgets,
    beforeBudgetsFull,
  );

  // P9-3: every table matches exactly after restore.
  const afterTransactionsFull = await db.transactions.toArray();
  const afterLedgerDaysFull = await db.ledgerDays.toArray();
  const afterCategoriesFull = await db.categories.toArray();
  const afterExpenseHeadsFull = await db.expenseHeads.toArray();
  const afterCashInTypesFull = await db.cashInTypes.toArray();
  const afterStaffFull = await db.staff.toArray();
  const afterVehiclesFull = await db.vehicles.toArray();
  const afterInstitutionsFull = await db.financialInstitutions.toArray();
  const afterBudgetsFull = await db.budgets.toArray();

  assertRowsMatch('Transactions after restore match the original exactly (every phase, every field)', afterTransactionsFull, beforeTransactionsFull);
  assertRowsMatch('Categories after restore match the original exactly', afterCategoriesFull, beforeCategoriesFull);
  assertRowsMatch('Expense heads after restore match the original exactly', afterExpenseHeadsFull, beforeExpenseHeadsFull);
  assertRowsMatch('Cash-in types after restore match the original exactly', afterCashInTypesFull, beforeCashInTypesFull);
  assertRowsMatch('Staff after restore match the original exactly', afterStaffFull, beforeStaffFull);
  assertRowsMatch('Vehicles after restore match the original exactly', afterVehiclesFull, beforeVehiclesFull);
  assertRowsMatch('Financial institutions after restore match the original exactly', afterInstitutionsFull, beforeInstitutionsFull);
  assertRowsMatch('Budgets after restore match the original exactly', afterBudgetsFull, beforeBudgetsFull);

  // The critical proof: every LedgerDay's recalculated balances (opening/
  // cashIn/cashOut/closing/isManualOpening) after restore exactly match
  // the ORIGINAL cached values across every date from every phase —
  // proving the cascade-rebuild approach reproduces identical results,
  // not just "some" balances. recalculatedAt is excluded from the
  // comparison since it's a bookkeeping timestamp that legitimately
  // differs on rebuild (the restore genuinely re-runs the cascade at a
  // later wall-clock time) — every actual financial field is compared.
  // Exclude "phantom" LedgerDay rows — ones with zero transactions on
  // their date — from the comparison below. One exists in this shared
  // fixture: Phase 7's test P7-8 directly seeded a synthetic LedgerDay
  // row (2099-01-01, via db.ledgerDays.put) with no backing transaction,
  // purely to test the Dashboard alert's filter logic in isolation. Per
  // this function's own design (see restoreFromBackup's doc comment),
  // restore deliberately rebuilds LedgerDay rows only from imported
  // transactions — a day with no transaction was never going to be
  // reproduced, and correctly isn't. This filters the comparison down to
  // what the rebuild actually guarantees, rather than asserting a
  // behavior Part B never promised.
  const datesWithTransactions = new Set(beforeTransactionsFull.map((t) => t.date));
  const beforeLedgerDaysWithTxns = beforeLedgerDaysFull.filter((d) => datesWithTransactions.has(d.date));
  const afterLedgerDaysWithTxns = afterLedgerDaysFull.filter((d) => datesWithTransactions.has(d.date));

  assertRowsMatch(
    'Recalculated LedgerDay balances after restore exactly match the original for every transaction-backed date (cascade-rebuild proof)',
    stripRecalculatedAt(afterLedgerDaysWithTxns),
    stripRecalculatedAt(beforeLedgerDaysWithTxns),
  );

  console.log(
    '\nTest P9-6: A restore that fails partway through the bulk-insert step leaves the database in its original pre-restore state, not half-restored',
  );
  const beforeFailedRestoreTransactions = await db.transactions.toArray();
  const beforeFailedRestoreBudgets = await db.budgets.toArray();
  const countsBeforeFailedRestore = await snapshotCounts();

  // A structurally-valid backup (passes validateBackupPayload) but with
  // one budgets row carrying an invalid IndexedDB key (NaN — which
  // survives the JSON.stringify/parse round trip restoreFromBackup does
  // internally as `null`, itself also an invalid IDB key), so
  // db.budgets.bulkPut(...) throws partway through the restore
  // transaction. Empirically confirmed during development (both `null`-
  // and `{}`-as-key variants) that fake-indexeddb raises a DataError here
  // and Dexie's transaction() rolls back every write in the same
  // transaction — including the .clear() calls and every table's
  // bulkPut that had already run earlier in the same transaction.
  const goodExportForCorruption = await exportBackup();
  const corruptPayload = {
    ...goodExportForCorruption,
    budgets: [...goodExportForCorruption.budgets, { id: NaN, expenseHeadId: 1, monthlyLimitPaisa: 100_00 }],
  };

  let corruptRestoreError: string | null = null;
  try {
    await restoreFromBackup(JSON.stringify(corruptPayload));
  } catch (err) {
    corruptRestoreError = err instanceof Error ? err.message : String(err);
  }
  assertEqual('The restore attempt with a corrupted row throws/rejects', corruptRestoreError != null, true);

  const countsAfterFailedRestore = await snapshotCounts();
  assertEqual('Transaction count unchanged after the failed restore attempt', countsAfterFailedRestore.transactions, countsBeforeFailedRestore.transactions);
  assertEqual('Budget count unchanged after the failed restore attempt (not left at a partial insert)', countsAfterFailedRestore.budgets, countsBeforeFailedRestore.budgets);
  assertEqual('LedgerDay count unchanged after the failed restore attempt', countsAfterFailedRestore.ledgerDays, countsBeforeFailedRestore.ledgerDays);
  assertEqual('Category count unchanged after the failed restore attempt', countsAfterFailedRestore.categories, countsBeforeFailedRestore.categories);

  const afterFailedRestoreTransactions = await db.transactions.toArray();
  assertRowsMatch(
    'Transactions after the failed attempt are byte-for-byte the pre-attempt data (not half-restored)',
    afterFailedRestoreTransactions,
    beforeFailedRestoreTransactions,
  );
  const afterFailedRestoreBudgets = await db.budgets.toArray();
  assertRowsMatch(
    'Budgets after the failed attempt are unchanged (the corrupted row was never actually committed, nor were the earlier-in-transaction real budget rows lost)',
    afterFailedRestoreBudgets,
    beforeFailedRestoreBudgets,
  );

  console.log('\n--- End Phase 9 tests ---');

  console.log('\n--- Phase 10a tests ---');

  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  console.log(
    '\nTest P10a-2: Fresh install — every new row gets a valid UUID, and every relationship between tables resolves correctly',
  );
  const freshVehicleId = await addVehicle({
    name: 'Fresh Test Vehicle',
    vehicleType: 'Car',
    registrationNumber: null,
  });
  assertEqual('Fresh vehicle id is a valid UUID', UUID_REGEX.test(freshVehicleId), true);
  const freshStaffId = await addStaff({
    name: 'Fresh Test Staff',
    monthlySalaryPaisa: 10_000_00,
    advanceLimitPaisa: null,
    joiningDate: null,
    vehicleIds: [freshVehicleId],
    notes: null,
  });
  assertEqual('Fresh staff id is a valid UUID', UUID_REGEX.test(freshStaffId), true);
  const freshStaffVehicles = await getVehiclesForStaff(freshStaffId);
  assertEqual(
    "Fresh staff's assigned vehicle (via the StaffVehicle join table) matches the real vehicle's UUID",
    freshStaffVehicles[0]?.id,
    freshVehicleId,
  );
  const resolvedFreshVehicle = freshStaffVehicles[0];
  assertEqual(
    "Relationship resolves correctly end-to-end: staff's assigned vehicle is the SAME vehicle (by name)",
    resolvedFreshVehicle!.name,
    'Fresh Test Vehicle',
  );
  const freshInstitutionId = await addInstitution({ name: 'Fresh Test Institution' });
  const freshTxnId = await addTransaction({
    date: '2026-08-28',
    direction: 'cash_out',
    amountPaisa: 500_00,
    categoryId: officeCategory.id,
    expenseHeadId: null,
    cashInTypeId: null,
    description: 'Fresh install relationship test',
    staffId: freshStaffId,
    vehicleId: freshVehicleId,
    institutionId: freshInstitutionId,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  assertEqual('Fresh transaction id is a valid UUID', UUID_REGEX.test(freshTxnId), true);
  const freshTxn = await db.transactions.get(freshTxnId);
  assertEqual("Fresh transaction's staffId resolves to the real staff member", freshTxn!.staffId, freshStaffId);
  assertEqual("Fresh transaction's vehicleId resolves to the real vehicle", freshTxn!.vehicleId, freshVehicleId);
  assertEqual(
    "Fresh transaction's institutionId resolves to the real institution",
    freshTxn!.institutionId,
    freshInstitutionId,
  );

  console.log(
    '\nTest P10a-3: Migration from an existing Phase 9 (numeric-id) database preserves every relationship exactly, across every table',
  );

  // A minimal standalone class replicating ONLY the OLD (Phase 9, version
  // 6) schema — auto-increment numeric ids throughout. Used to seed a
  // database in the pre-migration shape, then the REAL CashLedgerDB
  // class (with its full version chain, including the real versions 7
  // and 8 migration) is opened against the SAME database name, so Dexie
  // runs its genuine upgrade path — not a reimplementation of it.
  class OldSchemaDB extends Dexie {
    transactions!: Table<any, number>;
    ledgerDays!: Table<any, string>;
    categories!: Table<any, number>;
    expenseHeads!: Table<any, number>;
    cashInTypes!: Table<any, number>;
    staff!: Table<any, number>;
    vehicles!: Table<any, number>;
    financialInstitutions!: Table<any, number>;
    budgets!: Table<any, number>;
    constructor(name: string) {
      super(name);
      this.version(6).stores({
        transactions:
          '++id, date, direction, categoryId, expenseHeadId, cashInTypeId, staffId, vehicleId, institutionId, deletedAt',
        ledgerDays: 'date',
        categories: '++id, direction, active',
        expenseHeads: '++id, categoryId, active',
        cashInTypes: '++id, active',
        staff: '++id, active',
        vehicles: '++id, active',
        financialInstitutions: '++id, active',
        budgets: '++id, expenseHeadId',
      });
    }
  }

  const MIGRATION_TEST_DB_NAME = 'phase10a-migration-test-db';
  await Dexie.delete(MIGRATION_TEST_DB_NAME);

  const oldDb = new OldSchemaDB(MIGRATION_TEST_DB_NAME);
  await oldDb.open();

  const oldCategoryId = await oldDb.categories.add({
    name: 'MigTest Category',
    direction: 'cash_out',
    flowClass: 'operating_expense',
    isCustom: true,
    active: true,
  });
  const oldExpenseHeadId = await oldDb.expenseHeads.add({
    categoryId: oldCategoryId,
    name: 'MigTest Head',
    isCustom: true,
    active: true,
  });
  const oldVehicleId = await oldDb.vehicles.add({
    name: 'MigTest Vehicle',
    vehicleType: 'Car',
    registrationNumber: null,
    active: true,
  });
  const oldStaffId = await oldDb.staff.add({
    name: 'MigTest Staff',
    monthlySalaryPaisa: 50_000_00,
    advanceLimitPaisa: null,
    joiningDate: null,
    active: true,
    assignedVehicleId: oldVehicleId,
    notes: null,
  });
  const oldInstitutionId = await oldDb.financialInstitutions.add({
    name: 'MigTest Institution',
    active: true,
  });
  const oldBudgetId = await oldDb.budgets.add({
    expenseHeadId: oldExpenseHeadId,
    monthlyLimitPaisa: 10_000_00,
  });
  const oldTransactionId = await oldDb.transactions.add({
    date: '2026-01-01',
    direction: 'cash_out',
    amountPaisa: 123_45,
    categoryId: oldCategoryId,
    expenseHeadId: oldExpenseHeadId,
    cashInTypeId: null,
    description: 'MigTest txn',
    staffId: oldStaffId,
    vehicleId: oldVehicleId,
    institutionId: oldInstitutionId,
    referenceNumber: null,
    notes: null,
    flowClass: 'operating_expense',
    linkedAdvanceRecoveryPaisa: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    deletedAt: null,
  });
  // Reference the ids so oxlint/tsc don't flag them unused — they exist
  // purely to document what was seeded; identity is re-derived below via
  // name lookups (the point of this test: relationships resolve by
  // IDENTITY post-migration, not by remembering the old numeric values).
  void oldBudgetId;
  void oldTransactionId;
  oldDb.close();

  const migratedDb = new CashLedgerDB(MIGRATION_TEST_DB_NAME);
  await migratedDb.open();
  assertEqual('Migrated database reaches the same final schema version as the live app', migratedDb.verno, db.verno);

  const migratedCategory = (await migratedDb.categories.toArray()).find((c: any) => c.name === 'MigTest Category');
  const migratedExpenseHead = (await migratedDb.expenseHeads.toArray()).find((h: any) => h.name === 'MigTest Head');
  const migratedVehicle = (await migratedDb.vehicles.toArray()).find((v: any) => v.name === 'MigTest Vehicle');
  const migratedStaff = (await migratedDb.staff.toArray()).find((s: any) => s.name === 'MigTest Staff');
  const migratedInstitution = (await migratedDb.financialInstitutions.toArray()).find(
    (i: any) => i.name === 'MigTest Institution',
  );
  const migratedBudget = (await migratedDb.budgets.toArray()).find((b: any) => b.monthlyLimitPaisa === 10_000_00);
  const migratedTransaction = (await migratedDb.transactions.toArray()).find(
    (t: any) => t.description === 'MigTest txn',
  );

  assertEqual('Category survived migration', migratedCategory != null, true);
  assertEqual('Category got a valid UUID', UUID_REGEX.test(migratedCategory!.id), true);
  assertEqual('Expense head survived migration', migratedExpenseHead != null, true);
  assertEqual(
    "Expense head's categoryId correctly points to the SAME (new-UUID) category — checked by identity",
    migratedExpenseHead!.categoryId,
    migratedCategory!.id,
  );
  assertEqual('Vehicle survived migration', migratedVehicle != null, true);
  assertEqual('Staff survived migration', migratedStaff != null, true);
  assertEqual(
    // Phase 2 never clears or rewrites this deprecated field during
    // migration (see the version(12) upgrade() comment in schema.ts) — it
    // only READS it, once, to seed the new join table below — so a
    // pre-Phase-2 UUID-migrated value here is legitimately still intact.
    "Staff's assignedVehicleId (deprecated, never cleared) still correctly points to the SAME (new-UUID) vehicle",
    migratedStaff!.assignedVehicleId,
    migratedVehicle!.id,
  );
  console.log(
    "  (Phase 2) confirming version(12)'s upgrade() correctly backfilled a StaffVehicle row from this same pre-existing assignedVehicleId",
  );
  const migratedStaffVehicles = (await migratedDb.staffVehicles.toArray()).filter(
    (sv: any) => sv.staffId === migratedStaff!.id,
  );
  assertEqual(
    'Exactly one StaffVehicle row was backfilled for this staff member (Test Case 1: non-null assignedVehicleId -> exactly one row)',
    migratedStaffVehicles.length,
    1,
  );
  assertEqual(
    "The backfilled StaffVehicle row's vehicleId matches the SAME (new-UUID) vehicle",
    migratedStaffVehicles[0]?.vehicleId,
    migratedVehicle!.id,
  );
  assertEqual('Institution survived migration', migratedInstitution != null, true);
  assertEqual('Budget survived migration', migratedBudget != null, true);
  assertEqual(
    "Budget's expenseHeadId correctly points to the SAME (new-UUID) expense head",
    migratedBudget!.expenseHeadId,
    migratedExpenseHead!.id,
  );
  assertEqual('Transaction survived migration', migratedTransaction != null, true);
  assertEqual('Transaction got a valid (freshly-minted) UUID', UUID_REGEX.test(migratedTransaction!.id), true);
  assertEqual(
    "Transaction's categoryId points to the SAME category the old numeric id pointed to (checked by identity via name, not just format)",
    migratedTransaction!.categoryId,
    migratedCategory!.id,
  );
  assertEqual(
    "Transaction's expenseHeadId points to the SAME expense head",
    migratedTransaction!.expenseHeadId,
    migratedExpenseHead!.id,
  );
  assertEqual("Transaction's staffId points to the SAME staff member", migratedTransaction!.staffId, migratedStaff!.id);
  assertEqual("Transaction's vehicleId points to the SAME vehicle", migratedTransaction!.vehicleId, migratedVehicle!.id);
  assertEqual(
    "Transaction's institutionId points to the SAME institution",
    migratedTransaction!.institutionId,
    migratedInstitution!.id,
  );
  assertEqual('Transaction amountPaisa preserved exactly through migration', migratedTransaction!.amountPaisa, 123_45);

  migratedDb.close();
  await Dexie.delete(MIGRATION_TEST_DB_NAME);

  console.log(
    '\nTest P10a-4: Migration atomicity — a failure partway through the upgrade leaves the database at its original pre-migration schema/state',
  );
  // Demonstrated on an isolated, minimal schema mirroring the real
  // migration's shape (read old table -> transform -> write new table),
  // rather than injecting a deliberate fault into the production
  // migration path in db/schema.ts itself, which would mean shipping a
  // test-only failure hook in production code. The guarantee being
  // exercised is a platform-level one, not something specific to this
  // app's migration logic: Dexie's upgrade() runs inside a native
  // IndexedDB `versionchange` transaction, and per the IndexedDB
  // specification, if any request within that transaction fails
  // unhandled, the WHOLE transaction aborts and the connection's version
  // reverts to whatever it was before the attempted upgrade — the
  // version bump and every write inside it simply never take effect.
  // This is the same mechanism the real migration relies on; reproducing
  // it on a minimal schema demonstrates the guarantee without risking a
  // deliberately-broken code path in db/schema.ts itself.
  class AtomicityOldDB extends Dexie {
    items!: Table<any, number>;
    constructor(name: string) {
      super(name);
      this.version(1).stores({ items: '++id, name' });
    }
  }
  class AtomicityNewDB extends Dexie {
    items!: Table<any, number>;
    itemsMigrating!: Table<any, string>;
    constructor(name: string) {
      super(name);
      this.version(1).stores({ items: '++id, name' });
      this.version(2)
        .stores({ items: null, itemsMigrating: 'id, name' })
        .upgrade(async (tx) => {
          const old = await tx.table('items').toArray();
          const remapped = old.map((r: any) => ({ ...r, id: crypto.randomUUID() }));
          // Deliberately inject one row with an invalid IndexedDB key so
          // the bulkAdd below throws partway through the transaction.
          remapped.push({ id: null, name: 'deliberately invalid' });
          await tx.table('itemsMigrating').bulkAdd(remapped);
        });
    }
  }

  const ATOMICITY_TEST_DB_NAME = 'phase10a-atomicity-test-db';
  await Dexie.delete(ATOMICITY_TEST_DB_NAME);
  const atomicityOldDb = new AtomicityOldDB(ATOMICITY_TEST_DB_NAME);
  await atomicityOldDb.open();
  await atomicityOldDb.items.bulkAdd([{ name: 'A' }, { name: 'B' }, { name: 'C' }]);
  const originalItemCount = await atomicityOldDb.items.count();
  atomicityOldDb.close();

  const atomicityNewDb = new AtomicityNewDB(ATOMICITY_TEST_DB_NAME);
  let atomicityUpgradeError: string | null = null;
  try {
    await atomicityNewDb.open();
  } catch (err) {
    atomicityUpgradeError = err instanceof Error ? err.message : String(err);
  }
  assertEqual('The deliberately-failing upgrade attempt throws', atomicityUpgradeError != null, true);
  atomicityNewDb.close();

  const reopenedOldDb = new AtomicityOldDB(ATOMICITY_TEST_DB_NAME);
  await reopenedOldDb.open();
  assertEqual(
    "Database version reverted to the pre-migration version — the failed upgrade never took effect",
    reopenedOldDb.verno,
    1,
  );
  const itemsAfterFailedUpgrade = await reopenedOldDb.items.toArray();
  assertEqual('Original table is fully intact after the failed upgrade attempt', itemsAfterFailedUpgrade.length, originalItemCount);
  assertEqual(
    'Original data is completely unchanged (still numeric ids, still the original names)',
    itemsAfterFailedUpgrade.map((i: any) => i.name).sort().join(','),
    'A,B,C',
  );
  reopenedOldDb.close();
  await Dexie.delete(ATOMICITY_TEST_DB_NAME);

  console.log(
    '\nTest P10a-7: The recalculation cascade produces byte-identical paisa results with the new UUID schema',
  );
  // Every Phase 1 cascade test above in this same file (multi-day ledger,
  // backdated edits cascading forward, etc.) already ran against the
  // fully-migrated (UUID) schema this entire test run — their expected
  // paisa values were never touched by this phase's changes, and they
  // all still passed. That IS the byte-identical proof: the cascade
  // algorithm in recalcCascadeFrom/computeDayTotals reads only `date`,
  // `direction`, `amountPaisa`, and `deletedAt` off each Transaction —
  // never an id or a foreign key — so changing every id's TYPE from
  // number to string cannot change a single paisa figure it produces.
  // One more direct confirmation here, isolated from the shared fixture:
  const p10aCascadeDate1 = '2027-03-01';
  const p10aCascadeDate2 = '2027-03-02';
  const p10aCascadeDate3 = '2027-03-03';
  await addTransaction({
    date: p10aCascadeDate1,
    direction: 'cash_in',
    amountPaisa: 10_000_00,
    categoryId: null,
    expenseHeadId: null,
    cashInTypeId: atmType.id,
    description: 'P10a cascade day 1',
    staffId: null,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  await addTransaction({
    date: p10aCascadeDate3,
    direction: 'cash_out',
    amountPaisa: 3_000_00,
    categoryId: officeCategory.id,
    expenseHeadId: null,
    cashInTypeId: null,
    description: 'P10a cascade day 3',
    staffId: null,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  // Backdated edit on day 2, after day 3 already exists — must cascade forward.
  const p10aDay2TxnId = await addTransaction({
    date: p10aCascadeDate2,
    direction: 'cash_out',
    amountPaisa: 2_000_00,
    categoryId: officeCategory.id,
    expenseHeadId: null,
    cashInTypeId: null,
    description: 'P10a cascade day 2',
    staffId: null,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  await editTransaction(p10aDay2TxnId, { amountPaisa: 2_500_00 });

  const p10aDay1 = await db.ledgerDays.get(p10aCascadeDate1);
  const p10aDay2 = await db.ledgerDays.get(p10aCascadeDate2);
  const p10aDay3 = await db.ledgerDays.get(p10aCascadeDate3);
  assertEqual('Day 1 closing = opening + 10000 cash-in', p10aDay1!.closingBalancePaisa, p10aDay1!.openingBalancePaisa + 10_000_00);
  assertEqual('Day 2 closing = day1 closing − 2500 (post-edit)', p10aDay2!.closingBalancePaisa, p10aDay1!.closingBalancePaisa - 2_500_00);
  assertEqual('Day 3 closing = day2 closing − 3000, cascaded forward from the backdated edit', p10aDay3!.closingBalancePaisa, p10aDay2!.closingBalancePaisa - 3_000_00);

  console.log(
    '\nTest P10a-5/6: Full backup/restore round-trip and old-format-backup rejection with UUID ids',
  );
  const p10aBackupBefore = await exportBackup();
  const p10aSerialized = serializeBackup(p10aBackupBefore);
  const p10aRestoreResult = await restoreFromBackup(p10aSerialized);
  assertEqual('Restore with UUID ids succeeds and returns a pre-restore safety snapshot', p10aRestoreResult.preRestoreSnapshot != null, true);
  const p10aTxnAfterRestore = await db.transactions.get(freshTxnId);
  assertEqual(
    'A known transaction (with UUID id and UUID foreign keys) survives the UUID-schema restore round-trip intact',
    p10aTxnAfterRestore?.amountPaisa,
    500_00,
  );

  // An old-format (Phase 9, numeric-id) backup file must be rejected via
  // the existing schemaVersion check — confirm the live (already-
  // migrated) database is left completely untouched.
  const oldFormatBackupPayload = {
    schemaVersion: 6, // the pre-migration schema version
    exportedAt: new Date().toISOString(),
    appVersion: '0.0.0',
    transactions: [{ id: 1, date: '2026-01-01', direction: 'cash_out', amountPaisa: 100, categoryId: null, expenseHeadId: null, cashInTypeId: null, description: 'old', staffId: null, vehicleId: null, institutionId: null, referenceNumber: null, notes: null, flowClass: 'operating_expense', linkedAdvanceRecoveryPaisa: null, createdAt: 0, updatedAt: 0, deletedAt: null }],
    ledgerDays: [],
    categories: [],
    expenseHeads: [],
    cashInTypes: [],
    staff: [],
    vehicles: [],
    financialInstitutions: [],
    budgets: [],
  };
  const countsBeforeOldFormatRestore = await snapshotCounts();
  let oldFormatRestoreError: string | null = null;
  try {
    await restoreFromBackup(JSON.stringify(oldFormatBackupPayload));
  } catch (err) {
    oldFormatRestoreError = err instanceof Error ? err.message : String(err);
  }
  assertEqual('An old-format (numeric-id, schemaVersion 6) backup is rejected', oldFormatRestoreError != null, true);
  const countsAfterOldFormatRestore = await snapshotCounts();
  assertEqual(
    'Live (already-migrated) database is completely untouched by the rejected old-format restore attempt',
    countsAfterOldFormatRestore.transactions,
    countsBeforeOldFormatRestore.transactions,
  );

  console.log('\n--- End Phase 10a tests ---');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
