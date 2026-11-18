// Phase 12b: builds the SuggestionCandidatePool that lib/fastEntrySuggestions.ts's
// deriveSuggestions() (a pure function) matches/tags against. All Dexie
// access lives here, behind live (reactive) queries, so Fast Entry's
// candidate pool is loaded/cached once per direction rather than
// re-queried on every keystroke (see task Part A) - useLiveQuery keeps
// serving the last-known result while a re-subscribe (e.g. on direction
// toggle) is in flight, and updates it in place whenever the underlying
// tables change.

import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/schema';
import type { Direction } from '../types';
import type { SuggestionCandidatePool } from '../lib/fastEntrySuggestions';

export function useSuggestionCandidatePool(direction: Direction): SuggestionCandidatePool | undefined {
  const categories = useLiveQuery(() => db.categories.toArray(), []);
  const expenseHeads = useLiveQuery(() => db.expenseHeads.toArray(), []);
  const cashInTypes = useLiveQuery(() => db.cashInTypes.toArray(), []);
  const activeStaff = useLiveQuery(() => db.staff.filter((s) => s.active).toArray(), []);
  const activeInstitutions = useLiveQuery(
    () => db.financialInstitutions.filter((i) => i.active).toArray(),
    [],
  );
  // Phase 3: active vehicles, for rule 5's vehicle-maintenance pattern -
  // same shape/reasoning as activeStaff/activeInstitutions above.
  const activeVehicles = useLiveQuery(() => db.vehicles.filter((v) => v.active).toArray(), []);
  // Direction-scoped, non-deleted transaction history - the "past
  // Transaction.description values" source (Part A source 2).
  const historyTransactions = useLiveQuery(
    () =>
      db.transactions
        .where('direction')
        .equals(direction)
        .and((t) => t.deletedAt == null && t.description.trim() !== '')
        .toArray(),
    [direction],
  );

  return useMemo(() => {
    if (
      !categories ||
      !expenseHeads ||
      !cashInTypes ||
      !activeStaff ||
      !activeInstitutions ||
      !activeVehicles ||
      !historyTransactions
    ) {
      return undefined;
    }

    const categoryNameById = new Map(categories.map((c) => [c.id, c.name]));
    const expenseHeadNameById = new Map(expenseHeads.map((h) => [h.id, h.name]));
    const cashInTypeNameById = new Map(cashInTypes.map((t) => [t.id, t.name]));

    const expenseHeadCandidates = expenseHeads
      .filter((h) => h.active)
      .map((h) => ({ id: h.id, name: h.name, categoryId: h.categoryId }));
    const cashInTypeCandidates = cashInTypes
      .filter((t) => t.active)
      .map((t) => ({ id: t.id, name: t.name }));

    const historyEntries = historyTransactions
      .map((t) => ({
        description: t.description,
        categoryOrTypeId: (direction === 'cash_in' ? t.cashInTypeId : t.categoryId) ?? '',
        expenseHeadId: t.expenseHeadId,
        createdAt: t.createdAt,
      }))
      .filter((h) => h.categoryOrTypeId !== '');

    const savingsCategory = categories.find((c) => c.name === 'Savings & Financial');
    const staffCategory = categories.find((c) => c.name === 'Staff');
    const staffAdvanceHead = staffCategory
      ? expenseHeads.find((h) => h.categoryId === staffCategory.id && h.name === 'Advance')
      : undefined;
    // Phase 3: 'Vehicle Maintenance' / 'Service' - seeded by Phase 12g's
    // ensureVehicleServiceExpenseHead() - resolved the same way
    // staffCategory/staffAdvanceHead are above.
    const vehicleMaintenanceCategory = categories.find((c) => c.name === 'Vehicle Maintenance');
    const vehicleServiceHead = vehicleMaintenanceCategory
      ? expenseHeads.find((h) => h.categoryId === vehicleMaintenanceCategory.id && h.name === 'Service')
      : undefined;

    const pool: SuggestionCandidatePool = {
      direction,
      expenseHeadCandidates,
      cashInTypeCandidates,
      historyEntries,
      institutionCandidates: activeInstitutions.map((i) => ({ id: i.id, name: i.name, aliases: i.aliases })),
      staffCandidates: activeStaff.map((s) => ({ id: s.id, name: s.name, aliases: s.aliases })),
      vehicleCandidates: activeVehicles.map((v) => ({ id: v.id, name: v.name, aliases: v.aliases })),
      categoryNameById,
      expenseHeadNameById,
      cashInTypeNameById,
      savingsCategoryId: savingsCategory?.id ?? null,
      staffCategoryId: staffCategory?.id ?? null,
      staffAdvanceExpenseHeadId: staffAdvanceHead?.id ?? null,
      vehicleMaintenanceCategoryId: vehicleMaintenanceCategory?.id ?? null,
      vehicleServiceExpenseHeadId: vehicleServiceHead?.id ?? null,
    };
    return pool;
  }, [
    direction,
    categories,
    expenseHeads,
    cashInTypes,
    activeStaff,
    activeInstitutions,
    activeVehicles,
    historyTransactions,
  ]);
}
