// Opening balance: only the FIRST day of the ledger can have its opening set
// by hand, and what you type there must stick and flow to later days.
//
// Regression test for: "I edited the opening balance, pressed Save, and it did
// not save." Cause: the app showed an Edit button on a day that was flagged as
// the manual anchor but was no longer the earliest row (browsing to an earlier
// date creates an earlier row). The cascade ignored the typed value.
//
// Usage: npx tsx scripts/test-opening-anchor.ts

import 'fake-indexeddb/auto';
import { db, seedReferenceData } from '../src/db/schema';
import {
  addTransaction,
  getEarliestLedgerDate,
  getOrCreateLedgerDay,
  setManualOpeningBalance,
} from '../src/lib/ledger';
import { exportBackup, restoreFromBackup, serializeBackup } from '../src/lib/backup';

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

async function day(date: string) {
  const d = await db.ledgerDays.get(date);
  return d!;
}
async function clearAll() {
  await db.transactions.clear();
  await db.ledgerDays.clear();
}

async function main() {
  await seedReferenceData();
  const cashInType = (await db.cashInTypes.toArray())[0];
  const category = (await db.categories.toArray())[0];
  const D0 = '2026-11-16';
  const D1 = '2026-11-17';
  const D2 = '2026-11-18';
  const cashIn = (date: string, amountPaisa: number) =>
    addTransaction({
      date, direction: 'cash_in', amountPaisa, categoryId: null, expenseHeadId: null,
      cashInTypeId: cashInType.id!, description: 't', staffId: null, vehicleId: null,
      institutionId: null, referenceNumber: null, notes: null, linkedAdvanceRecoveryPaisa: null,
    });
  const cashOut = (date: string, amountPaisa: number) =>
    addTransaction({
      date, direction: 'cash_out', amountPaisa, categoryId: category.id!, expenseHeadId: null,
      cashInTypeId: null, description: 't', staffId: null, vehicleId: null,
      institutionId: null, referenceNumber: null, notes: null, linkedAdvanceRecoveryPaisa: null,
    });

  console.log('\n[1] Normal case: the first day is Day 1, set once, flows forward');
  await clearAll();
  await getOrCreateLedgerDay(D1);
  await getOrCreateLedgerDay(D2);
  assertEqual('earliest date is Day 1', await getEarliestLedgerDate(), D1);
  await cashIn(D1, 200_00);
  await cashOut(D1, 50_00);
  await setManualOpeningBalance(D1, 1000_00);
  assertEqual('Day 1 opening saved', (await day(D1)).openingBalancePaisa, 1000_00);
  assertEqual('Day 1 closing = 1000 + 200 - 50', (await day(D1)).closingBalancePaisa, 1150_00);
  assertEqual("Day 2 opening = Day 1 closing", (await day(D2)).openingBalancePaisa, 1150_00);
  await setManualOpeningBalance(D1, 2000_00);
  assertEqual('editing Day 1 again updates later days', (await day(D2)).openingBalancePaisa, 2150_00);

  console.log('\n[2] A later day cannot be given an opening by hand (and says so)');
  let message = '';
  try { await setManualOpeningBalance(D2, 5_00); } catch (e) { message = (e as Error).message; }
  assertEqual('refused with a clear message naming the first day', message.includes(D1), true);
  assertEqual('nothing changed on the later day', (await day(D2)).openingBalancePaisa, 2150_00);

  console.log('\n[3] THE BUG: an earlier date row appears after Day 1 already existed');
  await clearAll();
  await getOrCreateLedgerDay(D2);            // opened the app today: today became "Day 1"
  await getOrCreateLedgerDay(D1);            // clicked "previous day" once: an earlier row now exists
  assertEqual('earliest row is now yesterday', await getEarliestLedgerDate(), D1);
  assertEqual('yesterday is not flagged as the anchor yet', (await day(D1)).isManualOpening, false);
  await setManualOpeningBalance(D1, 50000_00); // the Edit button now lives on the earliest day
  assertEqual('yesterday opening saved and sticks', (await day(D1)).openingBalancePaisa, 50000_00);
  assertEqual('yesterday is now the anchor', (await day(D1)).isManualOpening, true);
  assertEqual('today is no longer an anchor', (await day(D2)).isManualOpening, false);
  assertEqual("today's opening = what was typed (no entries yesterday)", (await day(D2)).openingBalancePaisa, 50000_00);
  let stale = '';
  try { await setManualOpeningBalance(D2, 1_00); } catch (e) { stale = (e as Error).message; }
  assertEqual('the old "Edit on today" path is refused, not silently ignored', stale.length > 0, true);

  console.log('\n[4] Even earlier row created later: re-anchor moves again, balances stay consistent');
  await cashIn(D1, 100_00);
  await getOrCreateLedgerDay(D0);
  assertEqual('earliest row is now D0', await getEarliestLedgerDate(), D0);
  await setManualOpeningBalance(D0, 700_00);
  assertEqual('D0 opening saved', (await day(D0)).openingBalancePaisa, 700_00);
  assertEqual('D1 opening = D0 closing', (await day(D1)).openingBalancePaisa, 700_00);
  assertEqual('D1 closing = 700 + 100', (await day(D1)).closingBalancePaisa, 800_00);
  assertEqual('D2 opening = D1 closing', (await day(D2)).openingBalancePaisa, 800_00);
  const anchors = (await db.ledgerDays.toArray()).filter((d) => d.isManualOpening).map((d) => d.date);
  assertEqual('exactly one anchor exists, on the earliest day', anchors, [D0]);

  console.log('\n[5] Backup -> restore keeps the opening balance');
  const json = serializeBackup(await exportBackup());
  await restoreFromBackup(json);
  assertEqual('D0 opening survives restore', (await day(D0)).openingBalancePaisa, 700_00);
  await getOrCreateLedgerDay(D2); // restore only rebuilds days with entries; an empty day is recreated when opened
  assertEqual('D2 opening is right again after restore', (await day(D2)).openingBalancePaisa, 800_00);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
