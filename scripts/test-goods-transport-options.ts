// Built-in options: Cash In "Goods Sold", Cash Out "Goods Purchase" and
// "Transport Fare / Gadi Bhada".
//
// Usage: npx tsx scripts/test-goods-transport-options.ts

import 'fake-indexeddb/auto';
import { db, seedReferenceData } from '../src/db/schema';
import { addCategory, addCashInType, setCategoryActive } from '../src/lib/referenceData';
import { addTransaction } from '../src/lib/ledger';

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
const countByName = async (table: 'categories' | 'cashInTypes', name: string) =>
  (await db[table].toArray()).filter((r) => r.name.trim().toLowerCase() === name.toLowerCase()).length;

async function main() {
  console.log('\n[1] A fresh install gets all three options');
  await seedReferenceData();
  const goodsPurchase = (await db.categories.toArray()).find((c) => c.name === 'Goods Purchase');
  const transport = (await db.categories.toArray()).find((c) => c.name === 'Transport Fare / Gadi Bhada');
  const goodsSold = (await db.cashInTypes.toArray()).find((t) => t.name === 'Goods Sold');
  assertEqual('Goods Purchase exists as a Cash Out category', goodsPurchase?.direction, 'cash_out');
  assertEqual('Transport Fare / Gadi Bhada exists as a Cash Out category', transport?.direction, 'cash_out');
  assertEqual('Goods Sold exists as a Cash In source', goodsSold != null, true);
  assertEqual('both new categories are active and built-in', [goodsPurchase?.active, goodsPurchase?.isCustom, transport?.active, transport?.isCustom], [true, false, true, false]);
  assertEqual('both new categories count as ordinary operating expense', [goodsPurchase?.flowClass, transport?.flowClass], ['operating_expense', 'operating_expense']);

  console.log('\n[2] Running the app start-up again never duplicates them');
  await seedReferenceData();
  await seedReferenceData();
  assertEqual('Goods Purchase still once', await countByName('categories', 'Goods Purchase'), 1);
  assertEqual('Transport Fare still once', await countByName('categories', 'Transport Fare / Gadi Bhada'), 1);
  assertEqual('Goods Sold still once', await countByName('cashInTypes', 'Goods Sold'), 1);

  console.log('\n[3] Fixed ids, so two synced devices do not each add their own copy');
  assertEqual('ids are fixed', [goodsPurchase?.id, transport?.id, goodsSold?.id], ['builtin-category-goods-purchase', 'builtin-category-transport-fare', 'builtin-cashin-goods-sold']);

  console.log('\n[4] They work in real entries');
  await addTransaction({
    date: '2026-11-18', direction: 'cash_in', amountPaisa: 2500_00, categoryId: null, expenseHeadId: null,
    cashInTypeId: goodsSold!.id!, description: 'Sold goods', staffId: null, vehicleId: null,
    institutionId: null, referenceNumber: null, notes: null, linkedAdvanceRecoveryPaisa: null,
  });
  await addTransaction({
    date: '2026-11-18', direction: 'cash_out', amountPaisa: 900_00, categoryId: goodsPurchase!.id!, expenseHeadId: null,
    cashInTypeId: null, description: 'Bought goods', staffId: null, vehicleId: null,
    institutionId: null, referenceNumber: null, notes: null, linkedAdvanceRecoveryPaisa: null,
  });
  await addTransaction({
    date: '2026-11-18', direction: 'cash_out', amountPaisa: 150_00, categoryId: transport!.id!, expenseHeadId: null,
    cashInTypeId: null, description: 'Gadi bhada', staffId: null, vehicleId: null,
    institutionId: null, referenceNumber: null, notes: null, linkedAdvanceRecoveryPaisa: null,
  });
  const day = await db.ledgerDays.get('2026-11-18');
  assertEqual('day totals: in 2500, out 1050, closing 1450', [day!.cashInPaisa, day!.cashOutPaisa, day!.closingBalancePaisa], [2500_00, 1050_00, 1450_00]);

  console.log('\n[5] Existing apps: a name the owner already created (any capitalisation) is not doubled');
  await db.categories.clear();
  await db.cashInTypes.clear();
  await addCategory('goods purchase');          // owner typed it in Settings earlier
  await addCashInType('GOODS SOLD');
  await seedReferenceData();
  assertEqual('no second Goods Purchase', await countByName('categories', 'Goods Purchase'), 1);
  assertEqual('no second Goods Sold', await countByName('cashInTypes', 'Goods Sold'), 1);

  console.log('\n[6] Switched-off options are not switched back on');
  await db.categories.clear();
  await db.cashInTypes.clear();
  await seedReferenceData();
  await setCategoryActive('builtin-category-transport-fare', false);
  await seedReferenceData();
  const transportAfter = await db.categories.get('builtin-category-transport-fare');
  assertEqual('Transport Fare stays switched off', transportAfter?.active, false);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
