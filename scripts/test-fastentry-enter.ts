// Phase 12f: Fast Entry Keyboard Correction — Enter decision tree,
// resolveUniqueMatch(), Part D focus landing, and the duplicate-save
// guard. Standalone, headless (fake-indexeddb) verification, same pattern
// as test-fastentry.ts / test-fastentry-suggestions.ts /
// test-fastentry-smart-entry.ts — this project has no DOM/React harness,
// so every step below calls the exact same underlying pure functions
// FastEntryBar.tsx calls (resolveUniqueMatch(), resolveDescriptionEnter(),
// applyFastEntryMatch(), createFastEntrySaveGuard(), validateFastEntry(),
// buildFastEntryTransactionInput(), addTransaction()) in the same order
// the component would, rather than driving the component itself.
//
// Usage: npx tsx scripts/test-fastentry-enter.ts

import 'fake-indexeddb/auto';
import { db, seedReferenceData } from '../src/db/schema';
import { addTransaction } from '../src/lib/ledger';
import { addStaff, checkAdvanceLimit, getAdvanceReferenceIds, resolveAssignedVehicleId } from '../src/lib/staff';
import { addVehicle, getPetrolExpenseHead } from '../src/lib/vehicles';
import { addInstitution, getDepositReferenceIds } from '../src/lib/institutions';
import { addExpenseHead } from '../src/lib/referenceData';
import {
  deriveSuggestions,
  resolveUniqueMatch,
  type SuggestionCandidatePool,
} from '../src/lib/fastEntrySuggestions';
import {
  applyFastEntryMatch,
  buildFastEntryTransactionInput,
  createFastEntrySaveGuard,
  emptyFastEntryValues,
  isFastEntryAdvanceEntry,
  resolveDescriptionEnter,
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

/** Same pool-building helper as test-fastentry-smart-entry.ts, straight off the live db. */
async function buildPool(direction: Direction): Promise<SuggestionCandidatePool> {
  const categories = await db.categories.toArray();
  const expenseHeads = await db.expenseHeads.toArray();
  const cashInTypes = await db.cashInTypes.toArray();
  const activeStaff = await db.staff.filter((s) => s.active).toArray();
  const activeInstitutions = await db.financialInstitutions.filter((i) => i.active).toArray();
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

  return {
    direction,
    expenseHeadCandidates: expenseHeads
      .filter((h) => h.active)
      .map((h) => ({ id: h.id, name: h.name, categoryId: h.categoryId })),
    cashInTypeCandidates: cashInTypes.filter((t) => t.active).map((t) => ({ id: t.id, name: t.name })),
    historyEntries: historyTransactions.map((t) => ({
      description: t.description,
      categoryOrTypeId: (direction === 'cash_in' ? t.cashInTypeId : t.categoryId) ?? '',
      expenseHeadId: t.expenseHeadId,
      createdAt: t.createdAt,
    })),
    institutionCandidates: activeInstitutions.map((i) => ({ id: i.id, name: i.name })),
    staffCandidates: activeStaff.map((s) => ({ id: s.id, name: s.name })),
    categoryNameById,
    expenseHeadNameById,
    cashInTypeNameById,
    savingsCategoryId: savingsCategory?.id ?? null,
    staffCategoryId: staffCategory?.id ?? null,
    staffAdvanceExpenseHeadId: staffAdvanceHead?.id ?? null,
  };
}

async function main() {
  await seedReferenceData();

  console.log('\n--- Phase 12f Enter-decision-tree tests ---\n');

  const categories = await db.categories.toArray();
  const travelCategory = categories.find((c) => c.name === 'Travel & Fuel')!;
  const stationeryCategory = categories.find((c) => c.name === 'Stationery')!;
  const stationeryHeadId = await addExpenseHead(stationeryCategory.id, 'Stationery');
  const petrolHead = (await getPetrolExpenseHead())!;
  const advanceRefs = (await getAdvanceReferenceIds())!;
  const depositRefs = (await getDepositReferenceIds())!;

  const pulsarId = await addVehicle({
    name: '220 Pulsar',
    vehicleType: 'Motorbike',
    registrationNumber: 'BA 12 PA 3456',
  });
  const sijanId = await addStaff({
    name: 'Sijan',
    monthlySalaryPaisa: 20_000_00,
    advanceLimitPaisa: null,
    joiningDate: null,
    vehicleIds: [pulsarId],
    notes: null,
  });
  const dhanodayaId = await addInstitution({ name: 'Dhanodaya' });

  // ===================================================================
  // Test case 2: resolveUniqueMatch() unit tests (Part A's exact 3-tier
  // priority), independent of any keyboard/DOM behavior.
  // ===================================================================
  {
    const pool = await buildPool('cash_out');

    const khaja = resolveUniqueMatch('Khaja', pool);
    assertTrue('"Khaja" (exact match, one candidate) resolves', !!khaja);
    assertEqual('"Khaja" resolves to the Khaja expense head', khaja?.description, 'Khaja');

    const kh = resolveUniqueMatch('Kh', pool);
    assertEqual('"Kh" (multiple partial matches, no exact match) -> null', kh, null);

    const dhanodaya = resolveUniqueMatch('Dhanodaya', pool);
    assertTrue(
      'A description exactly matching one FinancialInstitution name with no other partial match resolves',
      !!dhanodaya,
    );
    assertEqual('"Dhanodaya" resolves with the institution tagged', dhanodaya?.suggestedInstitutionId, dhanodayaId);

    // Exact match wins even though another candidate partially matches the
    // same text too (e.g. exact "Stationery" vs "Station wagon fuel" would
    // both partially match "Station" - here we confirm the simpler case:
    // an exact CashInType/ExpenseHead name beats a longer candidate that
    // merely contains it).
    const cashInTypes = await db.cashInTypes.toArray();
    const atmType = cashInTypes.find((t) => t.name === 'ATM')!;
    // Seed a longer historical description that merely CONTAINS "ATM" so a
    // partial-match competitor genuinely exists in the candidate pool.
    await addTransaction({
      date: '2026-08-01',
      direction: 'cash_in',
      amountPaisa: 100_00,
      categoryId: null,
      expenseHeadId: null,
      cashInTypeId: atmType.id,
      description: 'ATM withdrawal via mobile app',
      staffId: null,
      vehicleId: null,
      institutionId: null,
      referenceNumber: null,
      notes: null,
      linkedAdvanceRecoveryPaisa: null,
    });
    const cashInPoolAfter = await buildPool('cash_in');
    const atmExact = resolveUniqueMatch('ATM', cashInPoolAfter);
    assertTrue('Exact "ATM" resolves despite a longer candidate merely containing "ATM"', !!atmExact);
    assertEqual('Exact "ATM" resolves to the ATM cash-in type itself, not the longer candidate', atmExact?.description, 'ATM');
  }

  // ===================================================================
  // Test case 3: THE core acceptance test — an unambiguous match resolves
  // AND saves in one Enter once the entry is save-ready as tagged, using
  // resolveDescriptionEnter() exactly as FastEntryBar.tsx's
  // handleDescriptionEnter() would call it.
  // ===================================================================
  const DATE = '2026-08-20';

  async function fastEntrySaveViaDecisionTree(
    description: string,
    amountInput: string,
    extra: Partial<FastEntryFieldValues> = {},
  ) {
    const pool = await buildPool('cash_out');
    const values: FastEntryFieldValues = {
      ...emptyFastEntryValues('cash_out'),
      description,
      amountInput,
      ...extra,
    };
    const suggestions = deriveSuggestions(values.description, 'cash_out', pool)?.descriptionMatches ?? null;
    const autoMatch = resolveUniqueMatch(values.description, pool);
    const result = resolveDescriptionEnter(values, undefined, autoMatch, suggestions?.length ?? 0);
    if (result.focus !== 'save') {
      throw new Error(
        `Expected "${description}" + "${amountInput}" to resolve to 'save' in one Enter, got focus=${result.focus}`,
      );
    }
    const validation = validateFastEntry(result.values);
    // Phase 3 Part A: checkAdvanceLimit() is advisory only now — still
    // run here (mirroring FastEntryBar.tsx's handleSubmit()) but it can
    // no longer block this save; the actual over/under-limit
    // warning-vs-block behavior is covered by
    // test-fastentry-smart-entry.ts's dedicated test cases. This harness
    // only needs to confirm the decision tree's own save-in-one-Enter
    // behavior is unaffected by the check still running.
    if (result.values.staffId && isAdvanceEntry(result.values)) {
      await checkAdvanceLimit(result.values.staffId, validation.amountPaisa!);
    }
    const input = buildFastEntryTransactionInput(result.values, DATE, validation.amountPaisa!);
    await addTransaction(input);
    return result;
  }

  function isAdvanceEntry(v: FastEntryFieldValues): boolean {
    return (
      v.direction === 'cash_out' &&
      advanceRefs.staffCategory.id != null &&
      advanceRefs.advanceExpenseHead.id != null &&
      v.categoryId === advanceRefs.staffCategory.id &&
      v.expenseHeadId === advanceRefs.advanceExpenseHead.id &&
      v.staffId != null
    );
  }

  {
    const txBefore = await db.transactions.count();

    // "Khaja" + Tab + "300" + Enter -> ONE Enter total (Tab already
    // accepted the suggestion under the OLD code too; what's new here is
    // that pressing Enter directly resolves+saves once Amount is present).
    await fastEntrySaveViaDecisionTree('Khaja', '300');
    assertEqual('"Khaja" + amount saves in one Enter (exactly one new Transaction)', await db.transactions.count(), txBefore + 1);

    // "Petrol" + "220", no staff signal -> saves without blocking on the
    // optional Staff/Vehicle fields.
    const petrolResult = await fastEntrySaveViaDecisionTree('Petrol', '220');
    assertEqual('Petrol (no staff) saves with Category/ExpenseHead correct', petrolResult.values.expenseHeadId, petrolHead.id);
    assertEqual('Petrol (no staff) leaves Staff null (not required to save)', petrolResult.values.staffId, null);

    // "Petrol" completed with staff (Tab flow): Staff -> Vehicle via the
    // reused resolveAssignedVehicleId(), then saves.
    const assignedVehicleId = await resolveAssignedVehicleId(sijanId);
    const petrolWithStaff = await fastEntrySaveViaDecisionTree('Petrol', '220', {
      staffId: sijanId,
      vehicleId: assignedVehicleId,
    });
    assertEqual('Petrol + Sijan: Vehicle correctly auto-filled from the staff assignment', petrolWithStaff.values.vehicleId, pulsarId);

    // "Stationery" + "1000" -> saves in one Enter.
    await fastEntrySaveViaDecisionTree('Stationery', '1000');
    const stationeryTx = await db.transactions.filter((t) => t.description === 'Stationery').first();
    assertEqual('Stationery saved with the correct expense head', stationeryTx?.expenseHeadId, stationeryHeadId);

    // "Sijan Advance"-style description + "3000" -> saves in one Enter,
    // staffId correctly set, checkAdvanceLimit() still runs (under-limit
    // case; the over/under-limit warning behavior itself is covered by
    // test-fastentry-smart-entry.ts's existing test cases 6/7, unchanged
    // by this phase - resolveDescriptionEnter() never bypasses it, since
    // the limit check still runs in handleSubmit() AFTER resolving to
    // focus:'save', exactly as before - it just no longer blocks the save
    // as of Phase 3 Part A).
    const advanceResult = await fastEntrySaveViaDecisionTree('Advance - Sijan', '3000');
    assertEqual('Advance entry saves with staffId set', advanceResult.values.staffId, sijanId);

    assertEqual(
      'All five one-Enter saves this block produced exactly 5 new Transactions (no double-saves)',
      await db.transactions.count(),
      txBefore + 5,
    );
  }

  // ===================================================================
  // Dhanodaya / Part D: Expense Head still needs a manual pick, so Enter
  // must NOT save yet even though Amount is already present - it should
  // redirect focus to Expense Head instead (not Institution, and not a
  // premature save with expenseHeadId left null).
  // ===================================================================
  {
    const pool = await buildPool('cash_out');
    const values: FastEntryFieldValues = {
      ...emptyFastEntryValues('cash_out'),
      description: 'Deposit to Dhanodaya',
      amountInput: '5000',
    };
    const suggestions = deriveSuggestions(values.description, 'cash_out', pool)?.descriptionMatches ?? null;
    const autoMatch = resolveUniqueMatch(values.description, pool);
    const result = resolveDescriptionEnter(values, undefined, autoMatch, suggestions?.length ?? 0);
    assertEqual(
      'Dhanodaya + Amount already present still redirects to Expense Head, does NOT save prematurely',
      result.focus,
      'expenseHead',
    );
    assertEqual('Institution IS tagged by this point', result.values.institutionId, dhanodayaId);
    assertEqual('Expense Head is correctly still null (owner\'s manual pick)', result.values.expenseHeadId, null);

    // Once the owner manually picks Expense Head = Deposit, the entry is
    // fully valid and correct (this is what Expense Head's OWN Enter,
    // unchanged per Part C, would then save).
    const completed = { ...result.values, expenseHeadId: depositRefs.depositExpenseHead.id! };
    const validation = validateFastEntry(completed);
    assertTrue('After the manual Expense Head pick, the entry validates fine', validation.valid);
  }

  // ===================================================================
  // Test case 4: genuinely ambiguous input does NOT save on Enter - the
  // dropdown stays open (Part B step 5), zero Transactions created.
  // ===================================================================
  {
    const pool = await buildPool('cash_out');
    const values: FastEntryFieldValues = { ...emptyFastEntryValues('cash_out'), description: 'Kh', amountInput: '50' };
    const suggestions = deriveSuggestions(values.description, 'cash_out', pool)?.descriptionMatches ?? null;
    assertTrue('"Kh" produces 2+ real candidates (Khaja and Khana)', (suggestions?.length ?? 0) >= 2);
    const autoMatch = resolveUniqueMatch(values.description, pool);
    const txBefore = await db.transactions.count();
    const result = resolveDescriptionEnter(values, undefined, autoMatch, suggestions?.length ?? 0);
    assertTrue('Ambiguous "Kh" is flagged ambiguous - Enter does not save', result.ambiguous);
    assertEqual('Ambiguous "Kh" creates zero Transactions', await db.transactions.count(), txBefore);
  }

  // ===================================================================
  // Test case 5: arrow-navigated deliberate override - Enter accepts the
  // manually-highlighted suggestion, not the one that would auto-resolve,
  // and still saves in that same Enter.
  // ===================================================================
  {
    const pool = await buildPool('cash_out');
    const description = 'Khaja'; // exact-matches "Khaja" (tier 0) but also fuzzy-matches "Khana" (tier 2)
    const suggestions = deriveSuggestions(description, 'cash_out', pool)?.descriptionMatches ?? [];
    const khajaMatch = suggestions.find((s) => s.description === 'Khaja');
    const khanaMatch = suggestions.find((s) => s.description === 'Khana');
    assertTrue('"Khaja" dropdown includes both Khaja and Khana (a real override choice exists)', !!khajaMatch && !!khanaMatch);

    const autoMatch = resolveUniqueMatch(description, pool);
    assertEqual('Auto-resolution for "Khaja" picks Khaja (the exact match)', autoMatch?.description, 'Khaja');

    const values: FastEntryFieldValues = { ...emptyFastEntryValues('cash_out'), description, amountInput: '300' };
    const result = resolveDescriptionEnter(values, khanaMatch, autoMatch, suggestions.length);
    assertEqual('Arrow-highlighted Khana is accepted instead of auto-resolved Khaja', result.appliedMatch?.description, 'Khana');
    assertEqual('Manual override still resolves to save in the same Enter', result.focus, 'save');
    assertEqual('Saved entry is tagged with Khana\'s expense head, not Khaja\'s', result.values.expenseHeadId, khanaMatch!.suggestedExpenseHeadId);
  }

  // ===================================================================
  // Test case 6: duplicate-save guard - a rapid double-Enter/held-Enter on
  // a single valid entry must produce exactly ONE Transaction, not two.
  // ===================================================================
  {
    const guard = createFastEntrySaveGuard();
    assertTrue('First tryStart() succeeds', guard.tryStart());
    assertTrue('A second tryStart() while the first is still in flight is rejected', !guard.tryStart());
    guard.finish();
    assertTrue('tryStart() succeeds again after finish()', guard.tryStart());
    guard.finish();

    // Simulate FastEntryBar.tsx's actual handleSubmit() shape: the guard is
    // checked-and-set synchronously BEFORE the async addTransaction() call,
    // so two calls fired back-to-back (as a held-down Enter key repeating
    // would) can't both pass the gate even though neither has awaited yet.
    const raceGuard = createFastEntrySaveGuard();
    const txBefore = await db.transactions.count();
    async function simulatedSubmit(): Promise<'saved' | 'blocked'> {
      if (!raceGuard.tryStart()) return 'blocked';
      try {
        const values: FastEntryFieldValues = {
          ...emptyFastEntryValues('cash_out'),
          description: 'Duplicate guard test',
          amountInput: '150',
          categoryId: travelCategory.id,
        };
        const validation = validateFastEntry(values);
        const input = buildFastEntryTransactionInput(values, DATE, validation.amountPaisa!);
        await addTransaction(input);
        return 'saved';
      } finally {
        raceGuard.finish();
      }
    }
    const [firstOutcome, secondOutcome] = await Promise.all([simulatedSubmit(), simulatedSubmit()]);
    const outcomes = [firstOutcome, secondOutcome].sort();
    assertEqual('Exactly one of the two simultaneous Enter presses saves, the other is blocked', outcomes.join(','), 'blocked,saved');
    assertEqual('Exactly one Transaction was created by the double-Enter, not two', await db.transactions.count(), txBefore + 1);
  }

  // ===================================================================
  // Test case 7 (Phase 5): re-entrant submit guard on a Smart-Entry-
  // auto-tagged entry. This exercises a genuinely different code path
  // from Test case 6 above — the values passed to handleSubmit() here
  // already carry Institution+Category from an accepted suggestion
  // (exactly as pressing Enter on a highlighted/auto-matched suggestion
  // row would leave them), not built by hand field-by-field. The point
  // is that Smart Entry's auto-tagging happens BEFORE handleSubmit() is
  // ever called (on the earlier keystroke/Tab that accepted the
  // suggestion) and plays no part in the guard's own gate — so the same
  // "exactly one save" guarantee must hold for a tagged entry too.
  // ===================================================================
  {
    const guard = createFastEntrySaveGuard();
    const pool = await buildPool('cash_out');
    const dhanodayaMatch = resolveUniqueMatch('Dhanodaya', pool)!;
    const taggedValues = applyFastEntryMatch(emptyFastEntryValues('cash_out'), dhanodayaMatch);
    assertEqual('Fixture sanity: the tagged entry really does carry an institution before submit', taggedValues.institutionId, dhanodayaId);

    const txBefore = await db.transactions.count();
    async function simulatedTaggedSubmit(): Promise<'saved' | 'blocked'> {
      if (!guard.tryStart()) return 'blocked';
      try {
        // Description deliberately renamed before saving (kept distinct
        // from the literal "Dhanodaya" fixture text) so this save doesn't
        // become a NEW Rule-1 history hit for "Dhanodaya" itself and
        // silently change what later tests in this file resolve it to —
        // the institution/category tagging under test came from
        // applyFastEntryMatch() above, not from this saved description.
        const values: FastEntryFieldValues = { ...taggedValues, description: 'Dhanodaya smart-tag guard test', amountInput: '500' };
        const validation = validateFastEntry(values);
        if (!validation.valid || validation.amountPaisa == null) return 'blocked';
        const input = buildFastEntryTransactionInput(values, DATE, validation.amountPaisa);
        await addTransaction(input);
        return 'saved';
      } finally {
        guard.finish();
      }
    }
    const [tOutcome1, tOutcome2] = await Promise.all([simulatedTaggedSubmit(), simulatedTaggedSubmit()]);
    assertEqual(
      'Test case 7: a double-Enter on a Smart-Entry-tagged entry still saves exactly once',
      [tOutcome1, tOutcome2].sort().join(','),
      'blocked,saved',
    );
    assertEqual(
      'Test case 7: exactly one Transaction was created (auto-tagging never bypasses the guard)',
      await db.transactions.count(),
      txBefore + 1,
    );
    assertTrue('Test case 7: guard is free again afterward', guard.tryStart());
    guard.finish();
  }

  // ===================================================================
  // Test case 8 (Phase 5): re-entrant submit guard across the advisory
  // advance-limit check (Phase 3 Part A). This is the important
  // structural difference from Test case 6: FastEntryBar.tsx's real
  // handleSubmit() has an `await checkAdvanceLimit(...)` BETWEEN
  // guard.tryStart() and the eventual addTransaction() call whenever the
  // entry is an advance for a staff member with a limit (see the comment
  // in FastEntryBar.tsx above `setAdvanceLimitWarning`) — one more await
  // point than the plain-entry race in Test case 6 had, and exactly the
  // gap a held-down Enter key's second event-loop turn could land in.
  // The guard must still only ever let one of the two calls through, and
  // the (advisory, non-blocking) warning outcome must not itself skip or
  // short-circuit guard.finish().
  // ===================================================================
  {
    const overLimitStaffId = await addStaff({
      name: 'Over-Limit Test Staff',
      monthlySalaryPaisa: 10_000_00,
      advanceLimitPaisa: 5_000_00, // small limit, easy to exceed
      joiningDate: null,
      notes: null,
    });
    const advanceRefs = await getAdvanceReferenceIds();
    if (!advanceRefs) {
      failed++;
      console.log('  FAIL  Test case 8 setup: Staff/Advance reference ids not found');
    } else {
      const advanceValues: FastEntryFieldValues = {
        ...emptyFastEntryValues('cash_out'),
        description: 'Advance limit race test',
        amountInput: '8000', // exceeds the 5,000 limit -> triggers the warning path
        categoryId: advanceRefs.staffCategory.id,
        expenseHeadId: advanceRefs.advanceExpenseHead.id,
        staffId: overLimitStaffId,
      };
      assertTrue(
        'Fixture sanity: this really is a Fast-Entry advance entry (isFastEntryAdvanceEntry)',
        isFastEntryAdvanceEntry(advanceValues, advanceRefs.staffCategory.id, advanceRefs.advanceExpenseHead.id),
      );
      const preCheck = await checkAdvanceLimit(overLimitStaffId, 8000_00);
      assertTrue('Fixture sanity: this amount genuinely exceeds the limit (warning WILL fire)', !preCheck.withinLimit);

      const guard = createFastEntrySaveGuard();
      const txBefore = await db.transactions.count();
      // Mirrors FastEntryBar.handleSubmit()'s real shape exactly: guard
      // gate first (sync), THEN validate, THEN await checkAdvanceLimit()
      // (an extra await the plain-entry Test case 6 race doesn't have),
      // THEN save — guard.finish() only in the `finally`.
      async function simulatedAdvanceSubmit(): Promise<'saved' | 'blocked'> {
        if (!guard.tryStart()) return 'blocked';
        try {
          const validation = validateFastEntry(advanceValues);
          if (!validation.valid || validation.amountPaisa == null) return 'blocked';
          if (
            advanceValues.direction === 'cash_out' &&
            advanceValues.staffId &&
            isFastEntryAdvanceEntry(advanceValues, advanceRefs.staffCategory.id, advanceRefs.advanceExpenseHead.id)
          ) {
            await checkAdvanceLimit(advanceValues.staffId, validation.amountPaisa); // advisory only — result intentionally unused here, exactly like the real handler's non-blocking warning
          }
          const input = buildFastEntryTransactionInput(advanceValues, DATE, validation.amountPaisa);
          await addTransaction(input);
          return 'saved';
        } finally {
          guard.finish();
        }
      }
      const [aOutcome1, aOutcome2] = await Promise.all([simulatedAdvanceSubmit(), simulatedAdvanceSubmit()]);
      assertEqual(
        'Test case 8: a double-Enter across the advisory advance-limit await still saves exactly once',
        [aOutcome1, aOutcome2].sort().join(','),
        'blocked,saved',
      );
      assertEqual(
        'Test case 8: exactly one Transaction was created (the extra checkAdvanceLimit() await does not open a gap for a second save)',
        await db.transactions.count(),
        txBefore + 1,
      );
      assertTrue('Test case 8: guard is free again afterward — the advisory warning path still reaches finish()', guard.tryStart());
      guard.finish();
    }
  }

  // ===================================================================
  // applyFastEntryMatch() field-by-field application - direct unit check,
  // independent of the decision tree, confirming the ExpenseHead
  // null-vs-undefined distinction selectSuggestion() has always relied on.
  // ===================================================================
  {
    const base = emptyFastEntryValues('cash_out');
    const institutionMatch = resolveUniqueMatch('Dhanodaya', await buildPool('cash_out'))!;
    const applied = applyFastEntryMatch(base, institutionMatch);
    assertEqual('applyFastEntryMatch clears Expense Head for the institution pattern (null, not left alone)', applied.expenseHeadId, null);
    assertEqual('applyFastEntryMatch tags Institution', applied.institutionId, dhanodayaId);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
