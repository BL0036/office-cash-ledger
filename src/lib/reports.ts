import { db } from '../db/schema';
import type { FlowClass } from '../types';
import { toISODate } from './dates';
import { bsMonthName, toNepaliDigits } from './bsCalendar';
import { getOutstandingAdvance, getSalaryReferenceIds } from './staff';
import { getPetrolExpenseHead } from './vehicles';
import { computeBudgetStatuses } from './budgets';
import {
  aggregateTransactions,
  extractGroupTotal,
  extractMonthlySeriesTotal,
  getFlowClassBreakdown,
  getMonthlySeriesTotals,
  lastNMonthsSpec,
  monthlyDateRanges,
  type MonthSpec,
} from './aggregation';

// This entire module is read-only reporting over data already written by
// every prior phase's write paths (addTransaction/editTransaction in
// ledger.ts, and the CRUD in staff.ts/vehicles.ts/institutions.ts). It
// introduces no new Transaction fields and no new write path — every
// function here only calls aggregateTransactions() (or its Part A
// extension, getMonthlySeriesTotals()) and existing staff.ts functions.

export interface MonthColumn extends MonthSpec {
  /** e.g. "Jun 2026" — for table headers. */
  label: string;
}

/**
 * v1.0 Nepali BS Edition: `MonthSpec` is now a BS year/month (see
 * lib/aggregation.ts), so its display label is the BS month name + BS
 * year in Nepali digits — e.g. "साउन २०८३" — not a Gregorian
 * "Aug 2026" label.
 */
function monthLabel({ year, month }: MonthSpec): string {
  return `${bsMonthName(month)} ${toNepaliDigits(year)}`;
}

function monthColumns(months: MonthSpec[]): MonthColumn[] {
  return months.map((m) => ({ ...m, label: monthLabel(m) }));
}

// --- Part B: Monthly Expense Table (§26) ---

export interface MonthlyExpenseRow {
  expenseHeadId: string;
  name: string;
  categoryName: string;
  /** Aligned with the returned `months` array, oldest first. */
  monthTotals: number[];
  yearToDatePaisa: number;
  lifetimePaisa: number;
}

export interface MonthlyExpenseTableData {
  months: MonthColumn[];
  rows: MonthlyExpenseRow[];
}

/**
 * Rows = active expense heads (Part B is explicit about active-only,
 * unlike Parts C/D below). Columns = last 3 months + YTD + lifetime.
 * A head with no transactions in a given month reads 0 there — every row
 * comes from mapping over `db.expenseHeads`, so there's nothing to
 * silently omit.
 */
export async function getMonthlyExpenseTableData(
  now: Date = new Date(),
): Promise<MonthlyExpenseTableData> {
  const monthSpecs = lastNMonthsSpec(3, now);
  const { yearStart, today } = monthlyDateRanges(now);

  const [series, ytdResults, lifetimeResults, heads, categories] = await Promise.all([
    getMonthlySeriesTotals({ groupBy: 'expenseHead', months: monthSpecs }),
    aggregateTransactions({ groupBy: 'expenseHead', dateFrom: yearStart, dateTo: today }),
    aggregateTransactions({ groupBy: 'expenseHead' }),
    db.expenseHeads.filter((h) => h.active).toArray(),
    db.categories.toArray(),
  ]);

  const categoryMap = new Map(categories.map((c) => [c.id!, c]));

  const rows: MonthlyExpenseRow[] = heads.map((h) => ({
    expenseHeadId: h.id,
    name: h.name,
    categoryName: categoryMap.get(h.categoryId)?.name ?? '—',
    monthTotals: monthSpecs.map((m) => extractMonthlySeriesTotal(series, m.year, m.month, h.id)),
    yearToDatePaisa: extractGroupTotal(ytdResults, h.id),
    lifetimePaisa: extractGroupTotal(lifetimeResults, h.id),
  }));

  return { months: monthColumns(monthSpecs), rows };
}

// --- Part C: Monthly Petrol Table (§27), full multi-month version ---

export interface PetrolTableRow {
  vehicleId: string;
  name: string;
  active: boolean;
  monthTotals: number[];
  yearToDatePaisa: number;
}

export interface PetrolTableData {
  months: MonthColumn[];
  rows: PetrolTableRow[];
  /** Sum across every row above, per column — computed in memory from `rows`, not a separate query. */
  totalRow: { monthTotals: number[]; yearToDatePaisa: number };
}

/**
 * Rows = ALL vehicles, active AND inactive — a deactivated vehicle's
 * historical Petrol spend is still real spend that belongs in a
 * management report, unlike the entry-form dropdowns (Phase 5), which
 * correctly hide inactive vehicles from new-transaction pickers only.
 */
export async function getPetrolTableData(now: Date = new Date()): Promise<PetrolTableData> {
  const monthSpecs = lastNMonthsSpec(3, now);
  const { yearStart, today } = monthlyDateRanges(now);
  const petrolHead = await getPetrolExpenseHead();

  const [series, ytdResults, vehicles] = await Promise.all([
    getMonthlySeriesTotals({ groupBy: 'vehicle', months: monthSpecs, expenseHeadId: petrolHead?.id }),
    petrolHead
      ? aggregateTransactions({
          groupBy: 'vehicle',
          dateFrom: yearStart,
          dateTo: today,
          expenseHeadId: petrolHead.id,
        })
      : Promise.resolve([]),
    db.vehicles.toArray(),
  ]);

  const rows: PetrolTableRow[] = vehicles.map((v) => ({
    vehicleId: v.id,
    name: v.name,
    active: v.active,
    monthTotals: monthSpecs.map((m) => extractMonthlySeriesTotal(series, m.year, m.month, v.id)),
    yearToDatePaisa: extractGroupTotal(ytdResults, v.id),
  }));

  const totalRow = {
    monthTotals: monthSpecs.map((_, i) => rows.reduce((sum, r) => sum + r.monthTotals[i], 0)),
    yearToDatePaisa: rows.reduce((sum, r) => sum + r.yearToDatePaisa, 0),
  };

  return { months: monthColumns(monthSpecs), rows, totalRow };
}

// --- Part D: Financial Institution Report (§28) ---

export interface InstitutionReportRow {
  institutionId: string;
  name: string;
  active: boolean;
  depositMonthTotals: number[];
  withdrawalMonthTotals: number[];
  depositYtdPaisa: number;
  withdrawalYtdPaisa: number;
}

export interface InstitutionReportData {
  months: MonthColumn[];
  rows: InstitutionReportRow[];
}

/** Rows = ALL institutions, active AND inactive — same reasoning as Part C. */
export async function getInstitutionReportData(
  now: Date = new Date(),
): Promise<InstitutionReportData> {
  const monthSpecs = lastNMonthsSpec(3, now);
  const { yearStart, today } = monthlyDateRanges(now);

  const [depositSeries, withdrawalSeries, ytdDeposits, ytdWithdrawals, institutions] =
    await Promise.all([
      getMonthlySeriesTotals({ groupBy: 'institution', months: monthSpecs }),
      getMonthlySeriesTotals({ groupBy: 'institution', months: monthSpecs, direction: 'cash_in' }),
      aggregateTransactions({ groupBy: 'institution', dateFrom: yearStart, dateTo: today }),
      aggregateTransactions({
        groupBy: 'institution',
        dateFrom: yearStart,
        dateTo: today,
        direction: 'cash_in',
      }),
      db.financialInstitutions.toArray(),
    ]);

  const rows: InstitutionReportRow[] = institutions.map((i) => ({
    institutionId: i.id,
    name: i.name,
    active: i.active,
    depositMonthTotals: monthSpecs.map((m) =>
      extractMonthlySeriesTotal(depositSeries, m.year, m.month, i.id),
    ),
    withdrawalMonthTotals: monthSpecs.map((m) =>
      extractMonthlySeriesTotal(withdrawalSeries, m.year, m.month, i.id),
    ),
    depositYtdPaisa: extractGroupTotal(ytdDeposits, i.id),
    withdrawalYtdPaisa: extractGroupTotal(ytdWithdrawals, i.id),
  }));

  return { months: monthColumns(monthSpecs), rows };
}

// --- Part E: Category / Staff report views ---

export interface CategoryBreakdownRow {
  categoryId: string;
  name: string;
  flowClass: FlowClass;
  totalPaisa: number;
}

export interface CategoryBreakdownData {
  /** All cash_out categories with a this-month total, sorted by spend descending. */
  rows: CategoryBreakdownRow[];
  /** The same rows, grouped and subtotaled by flowClass (§16) — no new classification logic, flowClass is read as already stored on each Category. */
  byFlowClass: Record<FlowClass, { totalPaisa: number; rows: CategoryBreakdownRow[] }>;
}

const ALL_FLOW_CLASSES: FlowClass[] = [
  'operating_expense',
  'staff_payment',
  'savings_financial',
  'other_movement',
];

/** Current-month cash_out totals per category, grouped by flowClass. */
export async function getCategoryBreakdown(now: Date = new Date()): Promise<CategoryBreakdownData> {
  const { current } = monthlyDateRanges(now);
  const [results, categories] = await Promise.all([
    aggregateTransactions({ groupBy: 'category', dateFrom: current.from, dateTo: current.to }),
    db.categories.where('direction').equals('cash_out').toArray(),
  ]);

  const rows: CategoryBreakdownRow[] = categories
    .map((c) => ({
      categoryId: c.id!,
      name: c.name,
      flowClass: c.flowClass,
      totalPaisa: extractGroupTotal(results, c.id!),
    }))
    .sort((a, b) => b.totalPaisa - a.totalPaisa);

  const byFlowClass = {} as CategoryBreakdownData['byFlowClass'];
  for (const fc of ALL_FLOW_CLASSES) {
    const rowsForClass = rows.filter((r) => r.flowClass === fc);
    byFlowClass[fc] = {
      totalPaisa: rowsForClass.reduce((sum, r) => sum + r.totalPaisa, 0),
      rows: rowsForClass,
    };
  }

  return { rows, byFlowClass };
}

export interface StaffSummaryRow {
  staffId: string;
  name: string;
  active: boolean;
  salaryPaidThisMonthPaisa: number;
  outstandingAdvancePaisa: number;
}

/**
 * One row per staff member, active + inactive. `salaryPaidThisMonthPaisa`
 * is deliberately its own aggregateTransactions() call filtered to the
 * Salary expense head — the existing getStaffTotals() (staff.ts) mixes
 * Salary and Advance amounts together under the whole Staff category (a
 * known coupling documented since Phase 4/5), which is not what a
 * "salary paid" column should show. `outstandingAdvancePaisa` reuses
 * getOutstandingAdvance() from staff.ts directly, per the spec's "reuse
 * existing staff.ts functions, don't reimplement."
 */
export async function getStaffSummaryData(now: Date = new Date()): Promise<StaffSummaryRow[]> {
  const salaryRefs = await getSalaryReferenceIds();
  const { current } = monthlyDateRanges(now);

  const [salaryResults, staffList] = await Promise.all([
    salaryRefs
      ? aggregateTransactions({
          groupBy: 'staff',
          dateFrom: current.from,
          dateTo: current.to,
          expenseHeadId: salaryRefs.salaryExpenseHead.id,
        })
      : Promise.resolve([]),
    db.staff.toArray(),
  ]);

  return Promise.all(
    staffList.map(async (s) => {
      const outstanding = await getOutstandingAdvance(s.id);
      return {
        staffId: s.id,
        name: s.name,
        active: s.active,
        salaryPaidThisMonthPaisa: extractGroupTotal(salaryResults, s.id),
        outstandingAdvancePaisa: outstanding.outstandingPaisa,
      };
    }),
  );
}

// --- Part F: Dashboard ---

export interface DashboardToday {
  date: string;
  openingCashPaisa: number;
  cashInPaisa: number;
  operatingExpensesPaisa: number;
  staffPaymentsPaisa: number;
  savingsDepositsPaisa: number;
  closingCashPaisa: number;
  /** False on a day with no LedgerDay row yet — the figures above are then all 0, not "unknown". */
  hasLedgerDay: boolean;
}

export interface DashboardThisMonth {
  totalCashInPaisa: number;
  totalOperatingExpensesPaisa: number;
  totalStaffPaymentsPaisa: number;
  totalSavingsDepositsPaisa: number;
  totalCashOutPaisa: number;
  /** The most recent existing LedgerDay's closing balance; null if no LedgerDay exists at all yet. */
  closingCashPaisa: number | null;
  /** Summed across ACTIVE staff only — see getDashboardData's doc comment. */
  outstandingStaffAdvancesPaisa: number;
}

export interface DashboardTopExpenseHead {
  expenseHeadId: string;
  name: string;
  totalPaisa: number;
}

export interface DashboardBudgetAlert {
  expenseHeadId: string;
  name: string;
  percentage: number;
  /** 'under' never appears here — a head under 80% produces no alert. */
  tier: 'informational' | 'reached' | 'over';
}

export interface DashboardAlerts {
  negativeCashDays: { date: string; closingBalancePaisa: number }[];
  /** True only on a fresh install — no LedgerDay row exists at all yet. */
  missingOpeningBalance: boolean;
  /** Phase 8 Part C — additive to the two alerts above, not a replacement. Heads with no budget set never appear here. */
  budgetAlerts: DashboardBudgetAlert[];
}

export interface DashboardData {
  today: DashboardToday;
  thisMonth: DashboardThisMonth;
  /** Top 5 expense heads this month by amount — derived from Part B's own table data, not a fresh query. */
  topExpenseHeads: DashboardTopExpenseHead[];
  alerts: DashboardAlerts;
}

/**
 * §24's Dashboard figures. "This Month" `outstandingStaffAdvancesPaisa`
 * deliberately sums getOutstandingAdvance() across ACTIVE staff only —
 * an inactive staff member's outstanding advance is still visible on
 * their own profile (Phase 4), but this dashboard figure represents
 * current exposure among active staff, so an inactive staff member (who
 * presumably isn't accruing further salary to recover against) is
 * excluded from this particular sum.
 *
 * Only the alerts this phase can actually support are implemented:
 * negative cash (any LedgerDay with closingBalancePaisa < 0) and a
 * missing-opening-balance state (no LedgerDay exists at all — a fresh
 * install). Advance-limit-exceeded is deliberately NOT a Dashboard alert:
 * Phase 4's checkAdvanceLimit() still runs at entry time, but as of
 * Phase 3 it's advisory only (the owner sees the warning and can still
 * save — see StaffView.tsx's GiveAdvanceModal and FastEntryBar.tsx), so
 * an over-limit advance CAN legitimately exist in the data afterward. A
 * retroactive Dashboard alert for it would be a new alert type, out of
 * scope for this phase — not built here. Budget-exceeded alerts (Phase 8)
 * are additive on top of the two implemented alerts, via
 * computeBudgetStatuses() in lib/budgets.ts — see that file for the
 * threshold classification.
 */
export async function getDashboardData(now: Date = new Date()): Promise<DashboardData> {
  const todayDate = toISODate(now);
  const { current } = monthlyDateRanges(now);

  const [
    todayDay,
    todayFlowClass,
    monthFlowClass,
    monthCashInResults,
    allDays,
    activeStaff,
    expenseTable,
    budgetRows,
  ] = await Promise.all([
    db.ledgerDays.get(todayDate),
    getFlowClassBreakdown(todayDate, todayDate),
    getFlowClassBreakdown(current.from, current.to),
    aggregateTransactions({ groupBy: 'cashInType', dateFrom: current.from, dateTo: current.to }),
    db.ledgerDays.orderBy('date').toArray(),
    db.staff.filter((s) => s.active).toArray(),
    getMonthlyExpenseTableData(now),
    db.budgets.toArray(),
  ]);

  const today: DashboardToday = {
    date: todayDate,
    openingCashPaisa: todayDay?.openingBalancePaisa ?? 0,
    cashInPaisa: todayDay?.cashInPaisa ?? 0,
    operatingExpensesPaisa: todayFlowClass.operatingExpensePaisa,
    staffPaymentsPaisa: todayFlowClass.staffPaymentPaisa,
    savingsDepositsPaisa: todayFlowClass.savingsFinancialPaisa,
    closingCashPaisa: todayDay?.closingBalancePaisa ?? 0,
    hasLedgerDay: todayDay != null,
  };

  // Total cash in for the month = every cash_in row regardless of type,
  // summed across every 'cashInType' group aggregateTransactions returns
  // (the groups are exhaustive over every cash_in row that month).
  const totalCashInPaisa = monthCashInResults.reduce((sum, r) => sum + r.totalPaisa, 0);
  const totalCashOutPaisa =
    monthFlowClass.operatingExpensePaisa +
    monthFlowClass.staffPaymentPaisa +
    monthFlowClass.savingsFinancialPaisa +
    monthFlowClass.otherMovementPaisa;
  const mostRecentDay = allDays.length > 0 ? allDays[allDays.length - 1] : null;

  const outstandingAdvances = await Promise.all(activeStaff.map((s) => getOutstandingAdvance(s.id)));
  const outstandingStaffAdvancesPaisa = outstandingAdvances.reduce(
    (sum, o) => sum + o.outstandingPaisa,
    0,
  );

  const thisMonth: DashboardThisMonth = {
    totalCashInPaisa,
    totalOperatingExpensesPaisa: monthFlowClass.operatingExpensePaisa,
    totalStaffPaymentsPaisa: monthFlowClass.staffPaymentPaisa,
    totalSavingsDepositsPaisa: monthFlowClass.savingsFinancialPaisa,
    totalCashOutPaisa,
    closingCashPaisa: mostRecentDay ? mostRecentDay.closingBalancePaisa : null,
    outstandingStaffAdvancesPaisa,
  };

  const topExpenseHeads: DashboardTopExpenseHead[] = expenseTable.rows
    .map((r) => ({
      expenseHeadId: r.expenseHeadId,
      name: r.name,
      // The current month is always the last column (months are oldest first).
      totalPaisa: r.monthTotals[r.monthTotals.length - 1],
    }))
    .sort((a, b) => b.totalPaisa - a.totalPaisa)
    .slice(0, 5);

  const negativeCashDays = allDays
    .filter((d) => d.closingBalancePaisa < 0)
    .map((d) => ({ date: d.date, closingBalancePaisa: d.closingBalancePaisa }));

  // Reuses the expenseTable already fetched above for topExpenseHeads —
  // computeBudgetStatuses is pure/synchronous, so this is not a second
  // query (Phase 8 Part C, additive to the two Phase 7 alerts above).
  const budgetAlerts: DashboardBudgetAlert[] = computeBudgetStatuses(budgetRows, expenseTable.rows)
    .filter((s) => s.tier !== 'under')
    .map((s) => ({
      expenseHeadId: s.expenseHeadId,
      name: s.name,
      percentage: s.percentage,
      tier: s.tier as 'informational' | 'reached' | 'over',
    }));

  const alerts: DashboardAlerts = {
    negativeCashDays,
    missingOpeningBalance: allDays.length === 0,
    budgetAlerts,
  };

  return { today, thisMonth, topExpenseHeads, alerts };
}
