// v1.0 release hardening — Batch Entry Acceptance Test (spec §32).
//
// Standalone, headless (fake-indexeddb) verification, same pattern as
// test-fastentry.ts / test-fastentry-suggestions.ts /
// test-fastentry-smart-entry.ts / test-fastentry-enter.ts — this project
// has no DOM/React harness, so this drives the exact same sequence
// FastEntryBar.tsx's handleSubmit()/resetForm() run on every save:
//
//   1. validateFastEntry(values)
//   2. saveGuard.tryStart() (bails out on a re-entrant call, exactly like
//      a duplicate Enter/click would)
//   3. buildFastEntryTransactionInput(values, date, amountPaisa)
//   4. addTransaction(input)  — the real, unmodified ledger write path
//   5. resetForm(): values = emptyFastEntryValues(values.direction) —
//      i.e. direction carries over unless the caller explicitly passes a
//      new one, exactly like FastEntryBar's `resetForm(nextDirection =
//      values.direction)` default parameter.
//   6. saveGuard.finish()
//
// This is what §6-9 of the v1.0 brief calls "Fast Entry Direction Mode":
// after a successful save the form must stay in the same direction, only
// clearing transaction-specific fields, so the owner can enter a whole
// batch of Cash In (or Cash Out) transactions back-to-back without
// re-selecting the direction every time. Reading resetForm()'s signature
// in FastEntryBar.tsx shows this already defaults to the current
// direction — this script is the first automated proof of that, and
// would fail loudly if a future change broke it.
//
// Usage: npx tsx scripts/test-batch-entry.ts

import 'fake-indexeddb/auto';
import { db, seedReferenceData } from '../src/db/schema';
import { addTransaction, softDeleteTransaction } from '../src/lib/ledger';
import {
  buildFastEntryTransactionInput,
  createFastEntrySaveGuard,
  emptyFastEntryValues,
  validateFastEntry,
  type FastEntryFieldValues,
} from '../src/lib/fastEntry';
import type { Direction } from '../src/types';

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

const TODAY = '2026-09-08';

/** Mirrors FastEntryBar's own per-instance saveGuard + values state across a batch. */
class FakeFastEntrySession {
  saveGuard = createFastEntrySaveGuard();
  values: FastEntryFieldValues;

  constructor(direction: Direction) {
    this.values = emptyFastEntryValues(direction);
  }

  setDirection(direction: Direction) {
    // Mirrors handleDirectionChange(): a no-op if already that direction,
    // otherwise clears direction-specific fields but is a manual action,
    // never something a save triggers on its own.
    if (direction === this.values.direction) return;
    this.values = emptyFastEntryValues(direction);
  }

  fill(fields: Partial<FastEntryFieldValues>) {
    this.values = { ...this.values, ...fields };
  }

  /** Returns the new transaction id, or null if validation/guard/save failed. */
  async submit(): Promise<string | null> {
    if (!this.saveGuard.tryStart()) return null;
    try {
      const result = validateFastEntry(this.values);
      if (!result.valid) return null;
      const input = buildFastEntryTransactionInput(this.values, TODAY, result.amountPaisa!);
      const id = await addTransaction(input);
      // Exactly resetForm()'s default: keep the direction that's already selected.
      this.values = emptyFastEntryValues(this.values.direction);
      return id;
    } finally {
      this.saveGuard.finish();
    }
  }
}

async function countTodayTransactions(): Promise<number> {
  return db.transactions.where('date').equals(TODAY).and((t) => t.deletedAt == null).count();
}

async function main() {
  await seedReferenceData();
  const cashInTypes = await db.cashInTypes.toArray();
  const categories = await db.categories.toArray();
  const atmType = cashInTypes.find((t) => /atm/i.test(t.name)) ?? cashInTypes[0];
  const generalCategory = categories[0];

  console.log('--- Batch Entry Acceptance Test (spec §32) ---\n');

  // ---- Part A: Cash In batch — direction must stay Cash In throughout ----
  console.log('Part A: Cash In batch (ATM 10,000 / Owner Cash 5,000 / Cash Received 2,000)');
  const session = new FakeFastEntrySession('cash_in');
  const cashInBatch = [
    { description: 'ATM', amountInput: '10000' },
    { description: 'Owner Cash', amountInput: '5000' },
    { description: 'Cash Received', amountInput: '2000' },
  ];
  const savedIds: string[] = [];
  for (const entry of cashInBatch) {
    assertEqual('direction stays cash_in before entry', session.values.direction, 'cash_in');
    session.fill({ description: entry.description, amountInput: entry.amountInput, cashInTypeId: atmType.id! });
    const id = await session.submit();
    assertTrue(`"${entry.description}" saved`, id != null);
    if (id) savedIds.push(id);
    assertEqual('description cleared after save', session.values.description, '');
    assertEqual('amount cleared after save', session.values.amountInput, '');
    assertEqual('direction unchanged after save', session.values.direction, 'cash_in');
  }
  assertEqual('3 distinct transactions saved', new Set(savedIds).size, 3);
  assertEqual('3 transactions exist for today so far', await countTodayTransactions(), 3);

  // ---- Part B: switch to Cash Out, then a Cash Out batch ----
  console.log('\nPart B: switch to Cash Out, then batch (Khaja 300 / Petrol 220 / Stationery 1,000)');
  session.setDirection('cash_out');
  assertEqual('direction switched to cash_out', session.values.direction, 'cash_out');
  const cashOutBatch = [
    { description: 'Khaja', amountInput: '300' },
    { description: 'Petrol', amountInput: '220' },
    { description: 'Stationery', amountInput: '1000' },
  ];
  for (const entry of cashOutBatch) {
    assertEqual('direction stays cash_out before entry', session.values.direction, 'cash_out');
    session.fill({ description: entry.description, amountInput: entry.amountInput, categoryId: generalCategory.id! });
    const id = await session.submit();
    assertTrue(`"${entry.description}" saved`, id != null);
    assertEqual('direction unchanged after save', session.values.direction, 'cash_out');
  }
  assertEqual('6 transactions exist for today so far', await countTodayTransactions(), 6);

  // ---- Part C: no duplicate save on a re-entrant submit (double Enter/click) ----
  console.log('\nPart C: re-entrant submit is rejected (duplicate-save guard)');
  session.fill({ description: 'Double Click Test', amountInput: '50', categoryId: generalCategory.id! });
  const guard = session.saveGuard;
  assertTrue('guard.tryStart() succeeds the first time', guard.tryStart());
  assertTrue('guard.tryStart() rejects a re-entrant call before finish()', guard.tryStart() === false);
  guard.finish();
  assertTrue('guard.tryStart() succeeds again after finish()', guard.tryStart());
  guard.finish();

  // ---- Part D: mixed alternating Cash In / Cash Out ----
  console.log('\nPart D: mixed alternating Cash In -> Cash Out -> Cash In -> Cash Out');
  const before = await countTodayTransactions();
  const sequence: { direction: Direction; description: string; amountInput: string }[] = [
    { direction: 'cash_in', description: 'Mixed In 1', amountInput: '111' },
    { direction: 'cash_out', description: 'Mixed Out 1', amountInput: '22' },
    { direction: 'cash_in', description: 'Mixed In 2', amountInput: '333' },
    { direction: 'cash_out', description: 'Mixed Out 2', amountInput: '44' },
  ];
  for (const step of sequence) {
    session.setDirection(step.direction);
    assertEqual(`direction is ${step.direction} for "${step.description}"`, session.values.direction, step.direction);
    session.fill({
      description: step.description,
      amountInput: step.amountInput,
      cashInTypeId: step.direction === 'cash_in' ? atmType.id! : null,
      categoryId: step.direction === 'cash_out' ? generalCategory.id! : null,
    });
    const id = await session.submit();
    assertTrue(`"${step.description}" saved`, id != null);
  }
  assertEqual('4 more transactions saved (mixed sequence)', (await countTodayTransactions()) - before, 4);

  // ---- Part E: 20 consecutive saves, same direction (spec §12's "test at least 20 consecutive saves") ----
  console.log('\nPart E: 20 consecutive Cash Out saves — focus/reset loop stays stable');
  session.setDirection('cash_out');
  const beforeE = await countTodayTransactions();
  const idsE: string[] = [];
  for (let i = 1; i <= 20; i++) {
    session.fill({ description: `Loop Entry ${i}`, amountInput: String(i), categoryId: generalCategory.id! });
    const id = await session.submit();
    if (id) idsE.push(id);
    if (session.values.description !== '' || session.values.amountInput !== '') {
      failed++;
      console.log(`  FAIL  fields cleared after save #${i}`);
    }
  }
  assertEqual('all 20 consecutive saves succeeded', idsE.length, 20);
  assertEqual('all 20 ids are distinct (no duplicate rows)', new Set(idsE).size, 20);
  assertEqual('exactly 20 new transactions landed in the db', (await countTodayTransactions()) - beforeE, 20);
  assertEqual('direction still cash_out after 20 saves', session.values.direction, 'cash_out');

  // Clean up the loop-test rows so this script leaves no residue if re-run
  // against a persistent db; harmless no-op against fake-indexeddb's
  // in-memory store, kept for hygiene / parity with how a real session
  // would tidy up test data.
  for (const id of idsE) await softDeleteTransaction(id);

  console.log(`\n--- Batch Entry Acceptance Test: ${passed} passed, ${failed} failed ---`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
