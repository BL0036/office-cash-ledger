// Standalone verification script for Phase 12b's smart autocomplete /
// auto-tagging logic (src/lib/fastEntrySuggestions.ts's deriveSuggestions,
// a pure function). Runs headless against fake-indexeddb, same pattern as
// test-fastentry.ts — this project has no DOM/React test harness (see
// README), so the actual dropdown keyboard/mouse wiring in
// FastEntryBar.tsx is verified manually (see the Phase 12b change
// summary); this script covers the matching/ranking/tagging algorithm
// itself, which is what test cases 2-6 and 11 need.
//
// Phase 12c note: deriveSuggestions() is the SAME function/file this
// script has always tested — Phase 12c extends (not replaces) it to also
// resolve suggestedInstitutionId/suggestedStaffId, so the two assertions
// that used to prove those fields stayed unset (Phase 12b's own scope
// boundary) have been updated in place to prove they're now set, rather
// than left asserting a boundary this phase deliberately moved. See
// scripts/test-fastentry-smart-entry.ts for Phase 12c's own dedicated
// coverage (institution/Petrol/staff-advance chains, the reused
// resolveAssignedVehicleId()/checkAdvanceLimit() functions, and the full
// §38 scenario driven through Fast Entry).
//
// Since deriveSuggestions() takes a SuggestionCandidatePool rather than
// querying Dexie directly (see fastEntrySuggestions.ts's module comment),
// this script builds pools by hand from seeded reference data + a handful
// of transactions, mirroring what hooks/useFastEntrySuggestions.ts's
// useSuggestionCandidatePool() assembles from live queries.
// Usage: npx tsx scripts/test-fastentry-suggestions.ts

import 'fake-indexeddb/auto';
import { db, seedReferenceData } from '../src/db/schema';
import { addTransaction } from '../src/lib/ledger';
import { addStaff } from '../src/lib/staff';
import { addInstitution } from '../src/lib/institutions';
import { deriveSuggestions, type SuggestionCandidatePool } from '../src/lib/fastEntrySuggestions';
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

/** Build a SuggestionCandidatePool straight from the live (fake-indexeddb) db, direction-scoped. */
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

  const categories = await db.categories.toArray();
  const expenseHeads = await db.expenseHeads.toArray();
  const foodCategory = categories.find((c) => c.name === 'Food')!;
  const khajaHead = expenseHeads.find((h) => h.name === 'Khaja')!;
  const khanaHead = expenseHeads.find((h) => h.name === 'Khana')!;
  const travelCategory = categories.find((c) => c.name === 'Travel & Fuel')!;
  const petrolHead = expenseHeads.find((h) => h.name === 'Petrol')!;
  const staffCategory = categories.find((c) => c.name === 'Staff')!;
  const advanceHead = expenseHeads.find((h) => h.categoryId === staffCategory.id && h.name === 'Advance')!;

  const sijanId = await addStaff({
    name: 'Sijan',
    monthlySalaryPaisa: 25_000_00,
    advanceLimitPaisa: null,
    joiningDate: '2024-01-01',
    notes: null,
  });
  const dhanodayaId = await addInstitution({ name: 'Dhanodaya' });

  console.log('\n--- Phase 12b Fast Entry suggestion engine tests ---\n');

  // Test case 11: below the minimum input length, no suggestions at all.
  {
    const pool = await buildPool('cash_out');
    const result = deriveSuggestions('K', 'cash_out', pool);
    assertEqual('Single-character input produces no suggestions (min length not met)', result, null);
  }

  // Test case 2 (part 1): "Kh" against a pool containing "Khaja"/"Khana" —
  // both returned, starts-with tier.
  {
    const pool = await buildPool('cash_out');
    const result = deriveSuggestions('Kh', 'cash_out', pool);
    const names = (result?.descriptionMatches ?? []).map((m) => m.description);
    assertTrue('"Kh" returns "Khaja"', names.includes('Khaja'));
    assertTrue('"Kh" returns "Khana"', names.includes('Khana'));
  }

  // Test case 2 (part 2): "Pet" against a pool containing "Petrol" —
  // returned in the starts-with tier ahead of any contains-only match.
  // "Carpet" is seeded as a one-off historical description so there's a
  // genuine contains-only competitor to rank behind "Petrol".
  {
    await addTransaction({
      date: '2026-01-05',
      direction: 'cash_out',
      amountPaisa: 50_00,
      categoryId: foodCategory.id,
      expenseHeadId: khajaHead.id,
      cashInTypeId: null,
      description: 'Carpet cleaning',
      staffId: null,
      vehicleId: null,
      institutionId: null,
      referenceNumber: null,
      notes: null,
      linkedAdvanceRecoveryPaisa: null,
    });
    const pool = await buildPool('cash_out');
    const result = deriveSuggestions('Pet', 'cash_out', pool);
    const names = (result?.descriptionMatches ?? []).map((m) => m.description);
    const petrolIdx = names.indexOf('Petrol');
    const carpetIdx = names.indexOf('Carpet cleaning');
    assertTrue('"Pet" returns "Petrol"', petrolIdx >= 0);
    assertTrue(
      '"Petrol" (starts-with) ranks ahead of "Carpet cleaning" (contains-only)',
      carpetIdx === -1 || petrolIdx < carpetIdx,
    );
  }

  // Test case 3: historical-usage priority. Seed a description previously
  // tagged with a specific (non-obvious) head, confirm a new entry of that
  // same description auto-tags to that same head — ahead of any generic
  // name-match rule that would otherwise apply.
  {
    await addTransaction({
      date: '2026-01-06',
      direction: 'cash_out',
      amountPaisa: 150_00,
      categoryId: foodCategory.id,
      expenseHeadId: khanaHead.id, // deliberately Khana, not Khaja
      cashInTypeId: null,
      description: 'Tea break',
      staffId: null,
      vehicleId: null,
      institutionId: null,
      referenceNumber: null,
      notes: null,
      linkedAdvanceRecoveryPaisa: null,
    });
    const pool = await buildPool('cash_out');
    const result = deriveSuggestions('Tea break', 'cash_out', pool);
    const match = (result?.descriptionMatches ?? []).find((m) => m.description === 'Tea break');
    assertTrue('"Tea break" produces a suggestion', !!match);
    assertEqual("Learned-history tag: categoryId matches the historical entry's category", match?.suggestedCategoryOrTypeId, foodCategory.id);
    assertEqual("Learned-history tag: expenseHeadId matches the historical entry's head (Khana, not a generic guess)", match?.suggestedExpenseHeadId, khanaHead.id);
  }

  // Test case 3 (recency tie-break): re-tag the SAME description under a
  // different head later — confirm the most-recent usage wins, not the
  // most-frequent (there's only one instance of each here, so this
  // exercises the reduce-to-most-recent path directly with two entries).
  {
    await addTransaction({
      date: '2026-01-07',
      direction: 'cash_out',
      amountPaisa: 150_00,
      categoryId: foodCategory.id,
      expenseHeadId: khajaHead.id, // now re-tagged to Khaja, more recently
      cashInTypeId: null,
      description: 'Tea break',
      staffId: null,
      vehicleId: null,
      institutionId: null,
      referenceNumber: null,
      notes: null,
      linkedAdvanceRecoveryPaisa: null,
    });
    const pool = await buildPool('cash_out');
    const result = deriveSuggestions('Tea break', 'cash_out', pool);
    const match = (result?.descriptionMatches ?? []).find((m) => m.description === 'Tea break');
    assertEqual('Most-recent usage (Khaja) wins over the earlier (Khana) tagging', match?.suggestedExpenseHeadId, khajaHead.id);
  }

  // Test case 4: direct name match. Entering "Petrol" and selecting the
  // suggestion auto-tags Category = Travel & Fuel, Expense Head = Petrol —
  // exact ids, not just "something was tagged".
  {
    const pool = await buildPool('cash_out');
    const result = deriveSuggestions('Petrol', 'cash_out', pool);
    const match = (result?.descriptionMatches ?? []).find((m) => m.description === 'Petrol');
    assertTrue('"Petrol" produces a suggestion', !!match);
    assertEqual('Direct name match: Category = Travel & Fuel', match?.suggestedCategoryOrTypeId, travelCategory.id);
    assertEqual('Direct name match: Expense Head = Petrol', match?.suggestedExpenseHeadId, petrolHead.id);
  }

  // Test case 5: institution pattern. Entering "Dhanodaya" and selecting
  // the suggestion tags Category = Savings & Financial. Phase 12b scoped
  // this to category-only (no institution id); Phase 12c extends this
  // SAME rule to also resolve suggestedInstitutionId (see
  // test-fastentry-smart-entry.ts for the full Phase 12c coverage) - this
  // assertion is updated accordingly rather than left asserting the now-
  // superseded 12b-only boundary.
  {
    const savingsCategory = categories.find((c) => c.name === 'Savings & Financial')!;
    const pool = await buildPool('cash_out');
    const result = deriveSuggestions('Dhanodaya', 'cash_out', pool);
    const match = (result?.descriptionMatches ?? []).find((m) => m.description === 'Dhanodaya');
    assertTrue('"Dhanodaya" produces a suggestion (typed-text pattern injection)', !!match);
    assertEqual('Institution pattern: Category = Savings & Financial', match?.suggestedCategoryOrTypeId, savingsCategory.id);
    assertEqual('Institution pattern (Phase 12c): suggestedInstitutionId IS set to Dhanodaya', match?.suggestedInstitutionId, dhanodayaId);
  }

  // Test case 6: staff-advance pattern. Entering "Sijan Advance" and
  // selecting the suggestion tags Category = Staff, Expense Head =
  // Advance. Phase 12b scoped this to category/head-only (no staff id);
  // Phase 12c extends this SAME rule to also resolve suggestedStaffId
  // (see test-fastentry-smart-entry.ts for the full Phase 12c coverage).
  {
    const pool = await buildPool('cash_out');
    const result = deriveSuggestions('Sijan Advance', 'cash_out', pool);
    const match = (result?.descriptionMatches ?? []).find((m) => m.description === 'Sijan Advance');
    assertTrue('"Sijan Advance" produces a suggestion (typed-text pattern injection)', !!match);
    assertEqual('Staff-advance pattern: Category = Staff', match?.suggestedCategoryOrTypeId, staffCategory.id);
    assertEqual('Staff-advance pattern: Expense Head = Advance', match?.suggestedExpenseHeadId, advanceHead.id);
    assertEqual('Staff-advance pattern (Phase 12c): suggestedStaffId IS set to Sijan', match?.suggestedStaffId, sijanId);
  }

  // Cap check: never more than 5 suggestions, even with many matches.
  {
    const pool = await buildPool('cash_out');
    const result = deriveSuggestions('a', 'cash_out', pool); // still below min length by itself
    assertEqual('Single-char "a" still produces no suggestions', result, null);
    const result2 = deriveSuggestions('e', 'cash_out', pool);
    // 'e' alone is 1 char - use a 2-char broad query instead to check the cap.
    void result2;
    const broad = deriveSuggestions('a ', 'cash_out', pool); // trims to 1 char 'a' -> still null
    assertEqual('"a " trims to below min length -> no suggestions', broad, null);
    const broadReal = deriveSuggestions('an', 'cash_out', pool);
    assertTrue('Broad match never exceeds the 5-suggestion cap', (broadReal?.descriptionMatches.length ?? 0) <= 5);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
