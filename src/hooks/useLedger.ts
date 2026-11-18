import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/schema';
import { getStaffForVehicle, getVehiclesForStaff } from '../lib/staffVehicles';
import type {
  Budget,
  CashInType,
  Category,
  ExpenseHead,
  FinancialInstitution,
  LedgerDay,
  Staff,
  Transaction,
  Vehicle,
} from '../types';

/** The LedgerDay row for `date`, if it's been created yet (undefined until first visit). */
export function useLedgerDay(date: string): LedgerDay | undefined {
  return useLiveQuery(() => db.ledgerDays.get(date), [date]);
}

/** Non-deleted transactions for `date`, newest first (by creation time — UUIDs aren't sortable chronologically). */
export function useDayTransactions(date: string): Transaction[] | undefined {
  return useLiveQuery(
    () =>
      db.transactions
        .where('date')
        .equals(date)
        .filter((t) => !t.deletedAt)
        .reverse()
        .sortBy('createdAt'),
    [date],
  );
}

export function useCashOutCategories(): Category[] | undefined {
  return useLiveQuery(
    () => db.categories.where('direction').equals('cash_out').and((c) => c.active).toArray(),
    [],
  );
}

export function useExpenseHeadsForCategory(categoryId: string | null): ExpenseHead[] | undefined {
  return useLiveQuery(() => {
    if (categoryId == null) return Promise.resolve<ExpenseHead[]>([]);
    return db.expenseHeads
      .where('categoryId')
      .equals(categoryId)
      .and((h) => h.active)
      .toArray();
  }, [categoryId]);
}

export function useCashInTypes(): CashInType[] | undefined {
  return useLiveQuery(() => db.cashInTypes.filter((t) => t.active).toArray(), []);
}

export function useTransactionsInRange(
  startDate: string,
  endDate: string,
): Transaction[] | undefined {
  return useLiveQuery(
    () =>
      db.transactions
        .where('date')
        .between(startDate, endDate, true, true)
        .filter((t) => !t.deletedAt)
        .reverse()
        .sortBy('date'),
    [startDate, endDate],
  );
}

export function useCategoryLookup(): Map<string, Category> {
  const categories = useLiveQuery(() => db.categories.toArray(), []);
  const map = new Map<string, Category>();
  (categories ?? []).forEach((c) => map.set(c.id!, c));
  return map;
}

export function useExpenseHeadLookup(): Map<string, ExpenseHead> {
  const heads = useLiveQuery(() => db.expenseHeads.toArray(), []);
  const map = new Map<string, ExpenseHead>();
  (heads ?? []).forEach((h) => map.set(h.id!, h));
  return map;
}

export function useCashInTypeLookup(): Map<string, CashInType> {
  const types = useLiveQuery(() => db.cashInTypes.toArray(), []);
  const map = new Map<string, CashInType>();
  (types ?? []).forEach((t) => map.set(t.id!, t));
  return map;
}

// --- Phase 2: Settings (all rows, active + inactive — deactivate-only UI) ---

export function useAllCategories(): Category[] | undefined {
  return useLiveQuery(() => db.categories.orderBy('name').toArray(), []);
}

export function useAllExpenseHeads(): ExpenseHead[] | undefined {
  return useLiveQuery(() => db.expenseHeads.orderBy('name').toArray(), []);
}

export function useAllCashInTypes(): CashInType[] | undefined {
  return useLiveQuery(() => db.cashInTypes.orderBy('name').toArray(), []);
}

// --- Phase 8: Budgets ---

/** All budget rows currently set (no "active" flag — a row's mere existence is its active state, see lib/budgets.ts). */
export function useAllBudgets(): Budget[] | undefined {
  return useLiveQuery(() => db.budgets.toArray(), []);
}

// --- Phase 2: Expense Diaries ---

/** Active expense heads, grouped by their (possibly inactive) category, for the diary list. */
export function useActiveExpenseHeadsByCategory():
  | { category: Category; heads: ExpenseHead[] }[]
  | undefined {
  const heads = useLiveQuery(
    () => db.expenseHeads.filter((h) => h.active).toArray(),
    [],
  );
  const categories = useLiveQuery(() => db.categories.toArray(), []);

  if (!heads || !categories) return undefined;

  const categoryMap = new Map<string, Category>();
  categories.forEach((c) => categoryMap.set(c.id!, c));

  const grouped = new Map<string, ExpenseHead[]>();
  for (const h of heads) {
    const list = grouped.get(h.categoryId) ?? [];
    list.push(h);
    grouped.set(h.categoryId, list);
  }

  return Array.from(grouped.entries())
    .map(([categoryId, headsForCategory]) => ({
      category: categoryMap.get(categoryId)!,
      heads: headsForCategory.sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .filter((g) => g.category != null)
    .sort((a, b) => a.category.name.localeCompare(b.category.name));
}

/** Non-deleted transactions for one expense head, newest first. */
export function useExpenseHeadTransactions(expenseHeadId: string): Transaction[] | undefined {
  return useLiveQuery(
    () =>
      db.transactions
        .where('expenseHeadId')
        .equals(expenseHeadId)
        .filter((t) => !t.deletedAt)
        .reverse()
        .sortBy('date'),
    [expenseHeadId],
  );
}

// --- Phase 3: Staff & Salary ---

/** All staff, active + inactive, for the Staff screen's deactivate-only list. */
export function useAllStaff(): Staff[] | undefined {
  return useLiveQuery(() => db.staff.orderBy('name').toArray(), []);
}

/** id -> Staff, so any view (ledger/search/diary) can resolve a staffId to a name. */
export function useStaffLookup(): Map<string, Staff> {
  const staff = useLiveQuery(() => db.staff.toArray(), []);
  const map = new Map<string, Staff>();
  (staff ?? []).forEach((s) => map.set(s.id!, s));
  return map;
}

/** Non-deleted Salary-payment transactions for one staff member, newest first. */
export function useStaffSalaryTransactions(
  staffId: string,
  salaryExpenseHeadId: string | undefined,
): Transaction[] | undefined {
  return useLiveQuery(() => {
    if (salaryExpenseHeadId == null) return Promise.resolve<Transaction[]>([]);
    return db.transactions
      .where('staffId')
      .equals(staffId)
      .filter((t) => !t.deletedAt && t.expenseHeadId === salaryExpenseHeadId)
      .reverse()
      .sortBy('date');
  }, [staffId, salaryExpenseHeadId]);
}

/** Active staff, for the general Cash Out form's Staff dropdown (Phase 5). */
export function useActiveStaff(): Staff[] | undefined {
  return useLiveQuery(() => db.staff.filter((s) => s.active).sortBy('name'), []);
}

// --- Phase 5: Vehicles & Petrol ---

/** All vehicles, active + inactive, for the Vehicles screen's deactivate-only list. */
export function useAllVehicles(): Vehicle[] | undefined {
  return useLiveQuery(() => db.vehicles.orderBy('name').toArray(), []);
}

/** Active vehicles, for the Cash Out form's and Staff form's Vehicle dropdowns. */
export function useActiveVehicles(): Vehicle[] | undefined {
  return useLiveQuery(() => db.vehicles.filter((v) => v.active).sortBy('name'), []);
}

/** id -> Vehicle, so any view (ledger/search/diary) can resolve a vehicleId to a name. */
export function useVehicleLookup(): Map<string, Vehicle> {
  const vehicles = useLiveQuery(() => db.vehicles.toArray(), []);
  const map = new Map<string, Vehicle>();
  (vehicles ?? []).forEach((v) => map.set(v.id!, v));
  return map;
}

/** Non-deleted transactions for one vehicle (every expense head, not just Petrol), newest first. */
export function useVehicleTransactions(vehicleId: string): Transaction[] | undefined {
  return useLiveQuery(
    () =>
      db.transactions
        .where('vehicleId')
        .equals(vehicleId)
        .filter((t) => !t.deletedAt)
        .reverse()
        .sortBy('date'),
    [vehicleId],
  );
}

// --- Phase 2: staff<->vehicle join table ---

/** Every Vehicle currently assigned to `staffId`, live-updating as assignments change. */
export function useVehiclesForStaff(staffId: string): Vehicle[] | undefined {
  return useLiveQuery(() => getVehiclesForStaff(staffId), [staffId]);
}

/** Every Staff member currently assigned to `vehicleId`, live-updating as assignments change. */
export function useStaffForVehicle(vehicleId: string): Staff[] | undefined {
  return useLiveQuery(() => getStaffForVehicle(vehicleId), [vehicleId]);
}

// --- Phase 6: Savings / Finance ---

/** All institutions, active + inactive, for the Savings/Finance screen's deactivate-only list. */
export function useAllInstitutions(): FinancialInstitution[] | undefined {
  return useLiveQuery(() => db.financialInstitutions.orderBy('name').toArray(), []);
}

/** Active institutions, for Fast Entry's "+ more fields" Institution dropdown (Phase 12a). */
export function useActiveInstitutions(): FinancialInstitution[] | undefined {
  return useLiveQuery(() => db.financialInstitutions.filter((i) => i.active).sortBy('name'), []);
}

/** id -> FinancialInstitution, so any export/view can resolve an institutionId to a name. */
export function useInstitutionLookup(): Map<string, FinancialInstitution> {
  const institutions = useLiveQuery(() => db.financialInstitutions.toArray(), []);
  const map = new Map<string, FinancialInstitution>();
  (institutions ?? []).forEach((i) => map.set(i.id!, i));
  return map;
}

/** Non-deleted deposit/withdrawal transactions for one institution, newest first. */
export function useInstitutionTransactions(institutionId: string): Transaction[] | undefined {
  return useLiveQuery(
    () =>
      db.transactions
        .where('institutionId')
        .equals(institutionId)
        .filter((t) => !t.deletedAt)
        .reverse()
        .sortBy('date'),
    [institutionId],
  );
}
