// Standalone verification script for Phase 12a's Fast Entry logic (the
// validation/build-input functions in src/lib/fastEntry.ts) and its use of
// the shared addTransaction() write path. Runs headless against
// fake-indexeddb — this project has no DOM/React test harness (see
// README), so the keyboard/focus mechanics in FastEntryBar.tsx itself are
// verified manually (see the Phase 12a change summary); this script covers
// everything that doesn't require a real DOM.
// Usage: npx tsx scripts/test-fastentry.ts

import 'fake-indexeddb/auto';
import { db, seedReferenceData } from '../src/db/schema';
import { addTransaction } from '../src/lib/ledger';
import {
  buildFastEntryTransactionInput,
  countMeaningfulFields,
  emptyFastEntryValues,
  validateFastEntry,
  type FastEntryFieldValues,
} from '../src/lib/fastEntry';

let passed = 0;
let failed = 0;

function assertEqual(label: string, actual: unknown, expected: unknown) {
  const ok = actual === expected;
  if (ok) {
    passed++;
    console.log(`  PASS  ${label} (${JSON.stringify(actual)})`);
  } else {
    failed++;
    console.log(`  FAIL  ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertTrue(label: string, actual: boolean) {
  assertEqual(label, actual, true);
}

async function main() {
  await seedReferenceData();
  const categories = await db.categories.where('direction').equals('cash_out').toArray();
  const cashInTypes = await db.cashInTypes.toArray();
  const category = categories[0];
  const cashInType = cashInTypes[0];

  console.log('\n--- Phase 12a Fast Entry logic tests ---\n');

  // Test case 8 (part 1): empty description is rejected.
  {
    const values: FastEntryFieldValues = {
      ...emptyFastEntryValues('cash_out'),
      description: '',
      amountInput: '100',
      categoryId: category.id,
    };
    const result = validateFastEntry(values);
    assertTrue('Empty description is rejected', !result.valid);
    assertTrue('Empty description produces a description error', !!result.errors.description);
  }

  // Test case 8 (part 2): zero/negative amount is rejected.
  {
    const values: FastEntryFieldValues = {
      ...emptyFastEntryValues('cash_out'),
      description: 'Tea',
      amountInput: '0',
      categoryId: category.id,
    };
    const result = validateFastEntry(values);
    assertTrue('Zero amount is rejected', !result.valid);
    assertTrue('Zero amount produces an amount error', !!result.errors.amount);
  }
  {
    const values: FastEntryFieldValues = {
      ...emptyFastEntryValues('cash_out'),
      description: 'Tea',
      amountInput: '-50',
      categoryId: category.id,
    };
    const result = validateFastEntry(values);
    assertTrue('Negative amount is rejected', !result.valid);
  }

  // Test case 8 (part 3): missing required category (cash_out) / source (cash_in) is rejected.
  {
    const values: FastEntryFieldValues = {
      ...emptyFastEntryValues('cash_out'),
      description: 'Tea',
      amountInput: '100',
      categoryId: null,
    };
    const result = validateFastEntry(values);
    assertTrue('Missing category is rejected (cash_out)', !result.valid);
    assertTrue('Missing category produces a category error', !!result.errors.category);
  }
  {
    const values: FastEntryFieldValues = {
      ...emptyFastEntryValues('cash_in'),
      description: 'Sale',
      amountInput: '100',
      cashInTypeId: null,
    };
    const result = validateFastEntry(values);
    assertTrue('Missing source is rejected (cash_in)', !result.valid);
  }

  // Test case 2 & 7: a valid Fast Entry build creates exactly one
  // Transaction via the shared addTransaction() write path, and a later
  // backdated edit through the normal editTransaction()/recalc cascade
  // still works (already covered by test:ledger/test:integration — this
  // just confirms Fast Entry's input didn't create a divergent row shape).
  {
    const beforeCount = await db.transactions.count();
    const values: FastEntryFieldValues = {
      ...emptyFastEntryValues('cash_out'),
      description: 'Fast entry lunch',
      amountInput: '150.50',
      categoryId: category.id,
    };
    const result = validateFastEntry(values);
    assertTrue('Valid cash_out entry passes validation', result.valid);
    const input = buildFastEntryTransactionInput(values, '2026-09-04', result.amountPaisa!);
    const id = await addTransaction(input);
    const afterCount = await db.transactions.count();
    assertEqual('Exactly one Transaction row was created', afterCount - beforeCount, 1);
    const row = await db.transactions.get(id);
    assertEqual('Transaction amountPaisa matches parsed input', row?.amountPaisa, 15050);
    assertEqual('Transaction direction matches', row?.direction, 'cash_out');
    assertEqual('Transaction categoryId matches', row?.categoryId, category.id);
    assertTrue('Transaction got a UUID id (not a new/second id scheme)', typeof id === 'string' && id.length === 36);
  }

  // Cash In works identically (test case 6, logic half).
  {
    const beforeCount = await db.transactions.count();
    const values: FastEntryFieldValues = {
      ...emptyFastEntryValues('cash_in'),
      description: 'Fast entry cash sale',
      amountInput: '2000',
      cashInTypeId: cashInType.id,
    };
    const result = validateFastEntry(values);
    assertTrue('Valid cash_in entry passes validation', result.valid);
    const input = buildFastEntryTransactionInput(values, '2026-09-04', result.amountPaisa!);
    const id = await addTransaction(input);
    const afterCount = await db.transactions.count();
    assertEqual('Exactly one Transaction row was created (cash_in)', afterCount - beforeCount, 1);
    const row = await db.transactions.get(id);
    assertEqual('Cash-in transaction categoryId is null', row?.categoryId, null);
    assertEqual('Cash-in transaction cashInTypeId matches', row?.cashInTypeId, cashInType.id);
  }

  // Test case 5 (logic half): the 2-or-more-fields threshold for the
  // Esc confirm-to-clear behavior.
  {
    const empty = emptyFastEntryValues('cash_out');
    assertEqual('Untouched form counts 0 meaningful fields', countMeaningfulFields(empty), 0);

    const oneField = { ...empty, description: 'Tea' };
    assertEqual('Description only counts as 1 meaningful field', countMeaningfulFields(oneField), 1);

    const twoFields = { ...empty, description: 'Tea', amountInput: '50' };
    assertEqual(
      'Description + amount counts as 2 meaningful fields',
      countMeaningfulFields(twoFields),
      2,
    );
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
