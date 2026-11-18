import { db } from '../db/schema';
import type { Direction, Transaction } from '../types';
import { toISODate } from './dates';
import { adIsoToBS, bsMonthRangeIso, bsYearStartIso, lastNBsMonths, previousBsMonth } from './bsCalendar';

export type GroupBy =
  | 'expenseHead'
  | 'category'
  | 'cashInType'
  | 'staff'
  | 'vehicle'
  | 'institution'
  | 'flowClass';

export interface AggregateParams {
  groupBy: GroupBy;
  /** Inclusive, 'YYYY-MM-DD'. Omit for no lower bound. */
  dateFrom?: string;
  /** Inclusive, 'YYYY-MM-DD'. Omit for no upper bound. */
  dateTo?: string;
  /**
   * Optional further filter: only include rows whose expenseHeadId
   * matches. Lets a caller narrow a 'staff' (or 'category') grouping down
   * to one expense head — e.g. Advance-only totals per staff member,
   * distinct from Salary-only totals — without a separate hand-written
   * query (Phase 4).
   */
  expenseHeadId?: string;
  /**
   * Override which direction's rows are aggregated. Every groupBy has an
   * implicit direction (cash_out for everything except 'cashInType',
   * which is cash_in) — but 'institution' rows split both ways (deposits
   * are cash_out, withdrawals are cash_in), so a caller aggregating
   * institution withdrawals passes `direction: 'cash_in'` to override the
   * groupBy-implied default (Phase 6). Has no effect combined with a
   * groupBy whose rows are only ever one direction anyway.
   */
  direction?: Direction;
}

export interface AggregateGroupTotal {
  /** The category/expenseHead/cashInType/flowClass this group is keyed on — a string only for groupBy: 'flowClass', otherwise a number|null id. null groups untagged rows (e.g. cash_out with no expenseHeadId when grouping by expenseHead). */
  groupId: number | string | null;
  totalPaisa: number;
  transactionCount: number;
}

/**
 * The one core aggregation function every reporting screen (Expense
 * Diaries now; Staff/Savings/Reports in later phases) is expected to call
 * into. Sums non-deleted transactions in [dateFrom, dateTo], grouped by
 * whichever id field `groupBy` selects.
 *
 * `groupBy: 'expenseHead'` and `'category'` only look at cash_out
 * transactions (those are the only rows with a categoryId/expenseHeadId);
 * `'cashInType'` only looks at cash_in transactions. Money is summed as
 * integer paisa throughout — never converted to a float.
 */
export async function aggregateTransactions({
  groupBy,
  dateFrom,
  dateTo,
  expenseHeadId,
  direction,
}: AggregateParams): Promise<AggregateGroupTotal[]> {
  let collection = db.transactions.toCollection();
  if (dateFrom != null && dateTo != null) {
    collection = db.transactions.where('date').between(dateFrom, dateTo, true, true);
  } else if (dateFrom != null) {
    collection = db.transactions.where('date').aboveOrEqual(dateFrom);
  } else if (dateTo != null) {
    collection = db.transactions.where('date').belowOrEqual(dateTo);
  }

  const rows = await collection.toArray();
  const relevantDirection = direction ?? (groupBy === 'cashInType' ? 'cash_in' : 'cash_out');
  // groupBy: 'flowClass' (Phase 7) groups by the string FlowClass field
  // directly, rather than a numeric foreign-key id like every other
  // groupBy value — read separately below instead of folding into the
  // keyof-Transaction id lookup, since the two have different value types.
  const idField: keyof Transaction | null =
    groupBy === 'flowClass'
      ? null
      : groupBy === 'expenseHead'
        ? 'expenseHeadId'
        : groupBy === 'category'
          ? 'categoryId'
          : groupBy === 'staff'
            ? 'staffId'
            : groupBy === 'vehicle'
              ? 'vehicleId'
              : groupBy === 'institution'
                ? 'institutionId'
                : 'cashInTypeId';

  const totals = new Map<number | string | null, { totalPaisa: number; transactionCount: number }>();

  for (const t of rows) {
    if (t.deletedAt) continue;
    if (t.direction !== relevantDirection) continue;
    if (expenseHeadId != null && t.expenseHeadId !== expenseHeadId) continue;

    const groupId = idField == null ? t.flowClass : (t[idField] as string | null);
    const existing = totals.get(groupId) ?? { totalPaisa: 0, transactionCount: 0 };
    existing.totalPaisa += t.amountPaisa;
    existing.transactionCount += 1;
    totals.set(groupId, existing);
  }

  return Array.from(totals.entries()).map(([groupId, v]) => ({
    groupId,
    totalPaisa: v.totalPaisa,
    transactionCount: v.transactionCount,
  }));
}

/** Sum a single group's totalPaisa out of an aggregateTransactions() result (0 if the group had no matching rows). */
export function extractGroupTotal(results: AggregateGroupTotal[], groupId: number | string): number {
  return results.find((r) => r.groupId === groupId)?.totalPaisa ?? 0;
}

/**
 * v1.0 Nepali BS Edition: "month" everywhere in this file now means a real
 * BS (Bikram Sambat) calendar month, not a Gregorian one — see
 * lib/bsCalendar.ts for the conversion layer this wraps. This function's
 * signature and return shape are unchanged (still plain ISO 'from'/'to'
 * strings) so every caller below it, and aggregateTransactions() itself,
 * needed zero changes — only the two boundary calculations that feed it
 * (this function and monthlyDateRanges) changed what calendar system they
 * compute those boundaries in.
 */
function monthBounds(bsYear: number, bsMonth: number): { from: string; to: string } {
  return bsMonthRangeIso({ year: bsYear, month: bsMonth });
}

/**
 * The current-BS-month / previous-BS-month / BS-year-to-date bounds shared
 * by every "totals" function below (getExpenseHeadTotals, getStaffTotals,
 * getVehicleTotals, getInstitutionTotals) — pulled out in Phase 5 once a
 * third caller needed the identical calculation, rather than a fourth
 * copy. Exported as of Phase 7 so the Reports/Dashboard lib
 * (lib/reports.ts) can compute the same YTD/current-month bounds without a
 * fifth copy. `now` is injectable for testing.
 *
 * v1.0 Nepali BS Edition: "current month" is the BS month `now` falls in
 * (not the Gregorian month), "previous month" correctly crosses a BS year
 * boundary (बैशाख's previous month is the previous BS year's चैत, not
 * "one Gregorian month back"), and `yearStart` is बैशाख १ of the current
 * BS year (not January 1). `today` is unchanged — it's just `now`'s plain
 * ISO date, calendar-agnostic by construction.
 */
export function monthlyDateRanges(now: Date): {
  current: { from: string; to: string };
  previous: { from: string; to: string };
  yearStart: string;
  today: string;
} {
  const today = toISODate(now);
  const bsToday = adIsoToBS(today);

  const current = monthBounds(bsToday.year, bsToday.month);
  const prev = previousBsMonth(bsToday);
  const previous = monthBounds(prev.year, prev.month);
  const yearStart = bsYearStartIso(bsToday.year);

  return { current, previous, yearStart, today };
}

export interface ExpenseHeadTotals {
  currentMonthPaisa: number;
  previousMonthPaisa: number;
  yearToDatePaisa: number;
  lifetimePaisa: number;
}

/**
 * Current-month / previous-month / year-to-date / lifetime totals for one
 * expense head. Each is a thin call into aggregateTransactions() with a
 * different date range — no separate hand-written queries. `now` is
 * injectable for testing; defaults to the real current time.
 */
export async function getExpenseHeadTotals(
  expenseHeadId: string,
  now: Date = new Date(),
): Promise<ExpenseHeadTotals> {
  const { current, previous, yearStart, today } = monthlyDateRanges(now);

  const [currentMonthResults, previousMonthResults, ytdResults, lifetimeResults] = await Promise.all([
    aggregateTransactions({ groupBy: 'expenseHead', dateFrom: current.from, dateTo: current.to }),
    aggregateTransactions({ groupBy: 'expenseHead', dateFrom: previous.from, dateTo: previous.to }),
    aggregateTransactions({ groupBy: 'expenseHead', dateFrom: yearStart, dateTo: today }),
    aggregateTransactions({ groupBy: 'expenseHead' }),
  ]);

  return {
    currentMonthPaisa: extractGroupTotal(currentMonthResults, expenseHeadId),
    previousMonthPaisa: extractGroupTotal(previousMonthResults, expenseHeadId),
    yearToDatePaisa: extractGroupTotal(ytdResults, expenseHeadId),
    lifetimePaisa: extractGroupTotal(lifetimeResults, expenseHeadId),
  };
}

export interface StaffTotals {
  currentMonthPaisa: number;
  previousMonthPaisa: number;
  lifetimePaisa: number;
}

/**
 * Current-month / previous-month / lifetime Salary-payment totals for one
 * staff member. Same shape and reasoning as getExpenseHeadTotals above —
 * a thin call into aggregateTransactions() per date range, groupBy:
 * 'staff' — no YTD, since the Staff profile screen (Part C) only asks for
 * lifetime/this-month/previous-month. `now` is injectable for testing.
 */
export async function getStaffTotals(staffId: string, now: Date = new Date()): Promise<StaffTotals> {
  const { current, previous } = monthlyDateRanges(now);

  const [currentMonthResults, previousMonthResults, lifetimeResults] = await Promise.all([
    aggregateTransactions({ groupBy: 'staff', dateFrom: current.from, dateTo: current.to }),
    aggregateTransactions({ groupBy: 'staff', dateFrom: previous.from, dateTo: previous.to }),
    aggregateTransactions({ groupBy: 'staff' }),
  ]);

  return {
    currentMonthPaisa: extractGroupTotal(currentMonthResults, staffId),
    previousMonthPaisa: extractGroupTotal(previousMonthResults, staffId),
    lifetimePaisa: extractGroupTotal(lifetimeResults, staffId),
  };
}

export interface PeriodTotals {
  currentMonthPaisa: number;
  previousMonthPaisa: number;
  yearToDatePaisa: number;
  lifetimePaisa: number;
}

export interface VehicleTotals {
  overall: PeriodTotals;
  petrol: PeriodTotals;
}

/**
 * Current-month / previous-month / YTD / lifetime totals for one vehicle,
 * both overall (every expense head — Petrol, Vehicle Maintenance, etc.)
 * and Petrol-specific (Phase 5 Part D). Same thin-wrapper-over-
 * aggregateTransactions() shape as getExpenseHeadTotals/getStaffTotals
 * above, groupBy: 'vehicle', with the Petrol half additionally filtered
 * via the expenseHeadId param. `petrolExpenseHeadId` is resolved by the
 * caller (lib/vehicles.ts) rather than looked up by name in here, since
 * aggregation.ts doesn't otherwise know about specific expense-head names
 * — if it's not yet resolvable (reference data not seeded), the Petrol
 * half comes back all zeros rather than throwing. `now` is injectable for
 * testing.
 */
export async function getVehicleTotals(
  vehicleId: string,
  petrolExpenseHeadId: string | undefined,
  now: Date = new Date(),
): Promise<VehicleTotals> {
  const { current, previous, yearStart, today } = monthlyDateRanges(now);

  const [currentAll, previousAll, ytdAll, lifetimeAll] = await Promise.all([
    aggregateTransactions({ groupBy: 'vehicle', dateFrom: current.from, dateTo: current.to }),
    aggregateTransactions({ groupBy: 'vehicle', dateFrom: previous.from, dateTo: previous.to }),
    aggregateTransactions({ groupBy: 'vehicle', dateFrom: yearStart, dateTo: today }),
    aggregateTransactions({ groupBy: 'vehicle' }),
  ]);

  let currentPetrol: AggregateGroupTotal[] = [];
  let previousPetrol: AggregateGroupTotal[] = [];
  let ytdPetrol: AggregateGroupTotal[] = [];
  let lifetimePetrol: AggregateGroupTotal[] = [];
  if (petrolExpenseHeadId != null) {
    [currentPetrol, previousPetrol, ytdPetrol, lifetimePetrol] = await Promise.all([
      aggregateTransactions({
        groupBy: 'vehicle',
        dateFrom: current.from,
        dateTo: current.to,
        expenseHeadId: petrolExpenseHeadId,
      }),
      aggregateTransactions({
        groupBy: 'vehicle',
        dateFrom: previous.from,
        dateTo: previous.to,
        expenseHeadId: petrolExpenseHeadId,
      }),
      aggregateTransactions({
        groupBy: 'vehicle',
        dateFrom: yearStart,
        dateTo: today,
        expenseHeadId: petrolExpenseHeadId,
      }),
      aggregateTransactions({ groupBy: 'vehicle', expenseHeadId: petrolExpenseHeadId }),
    ]);
  }

  return {
    overall: {
      currentMonthPaisa: extractGroupTotal(currentAll, vehicleId),
      previousMonthPaisa: extractGroupTotal(previousAll, vehicleId),
      yearToDatePaisa: extractGroupTotal(ytdAll, vehicleId),
      lifetimePaisa: extractGroupTotal(lifetimeAll, vehicleId),
    },
    petrol: {
      currentMonthPaisa: extractGroupTotal(currentPetrol, vehicleId),
      previousMonthPaisa: extractGroupTotal(previousPetrol, vehicleId),
      yearToDatePaisa: extractGroupTotal(ytdPetrol, vehicleId),
      lifetimePaisa: extractGroupTotal(lifetimePetrol, vehicleId),
    },
  };
}

/**
 * Current-month / previous-month / YTD / lifetime totals for one
 * financial institution: deposits (cash_out), withdrawals (cash_in), and
 * net (deposits − withdrawals) for each period (Phase 6 Part C).
 *
 * Deposits and withdrawals are two separate aggregateTransactions() calls
 * — groupBy: 'institution' for both, with `direction: 'cash_in'` passed
 * for the withdrawal half to override the groupBy's cash_out default (see
 * the `direction` param on AggregateParams above). This was chosen over
 * extending aggregateTransactions to return both directions pre-split in
 * one call: it fits the function's existing shape (it already computes
 * `relevantDirection` internally; overriding it is a one-line change)
 * without the function needing to return direction-tagged rows or the
 * caller needing to post-filter a combined result set.
 */
export interface InstitutionTotals {
  deposits: PeriodTotals;
  withdrawals: PeriodTotals;
  net: PeriodTotals;
}

export async function getInstitutionTotals(
  institutionId: string,
  now: Date = new Date(),
): Promise<InstitutionTotals> {
  const { current, previous, yearStart, today } = monthlyDateRanges(now);

  const [depositsCurrent, depositsPrevious, depositsYtd, depositsLifetime] = await Promise.all([
    aggregateTransactions({ groupBy: 'institution', dateFrom: current.from, dateTo: current.to }),
    aggregateTransactions({ groupBy: 'institution', dateFrom: previous.from, dateTo: previous.to }),
    aggregateTransactions({ groupBy: 'institution', dateFrom: yearStart, dateTo: today }),
    aggregateTransactions({ groupBy: 'institution' }),
  ]);
  const [withdrawalsCurrent, withdrawalsPrevious, withdrawalsYtd, withdrawalsLifetime] =
    await Promise.all([
      aggregateTransactions({
        groupBy: 'institution',
        dateFrom: current.from,
        dateTo: current.to,
        direction: 'cash_in',
      }),
      aggregateTransactions({
        groupBy: 'institution',
        dateFrom: previous.from,
        dateTo: previous.to,
        direction: 'cash_in',
      }),
      aggregateTransactions({
        groupBy: 'institution',
        dateFrom: yearStart,
        dateTo: today,
        direction: 'cash_in',
      }),
      aggregateTransactions({ groupBy: 'institution', direction: 'cash_in' }),
    ]);

  const deposits: PeriodTotals = {
    currentMonthPaisa: extractGroupTotal(depositsCurrent, institutionId),
    previousMonthPaisa: extractGroupTotal(depositsPrevious, institutionId),
    yearToDatePaisa: extractGroupTotal(depositsYtd, institutionId),
    lifetimePaisa: extractGroupTotal(depositsLifetime, institutionId),
  };
  const withdrawals: PeriodTotals = {
    currentMonthPaisa: extractGroupTotal(withdrawalsCurrent, institutionId),
    previousMonthPaisa: extractGroupTotal(withdrawalsPrevious, institutionId),
    yearToDatePaisa: extractGroupTotal(withdrawalsYtd, institutionId),
    lifetimePaisa: extractGroupTotal(withdrawalsLifetime, institutionId),
  };
  const net: PeriodTotals = {
    currentMonthPaisa: deposits.currentMonthPaisa - withdrawals.currentMonthPaisa,
    previousMonthPaisa: deposits.previousMonthPaisa - withdrawals.previousMonthPaisa,
    yearToDatePaisa: deposits.yearToDatePaisa - withdrawals.yearToDatePaisa,
    lifetimePaisa: deposits.lifetimePaisa - withdrawals.lifetimePaisa,
  };

  return { deposits, withdrawals, net };
}

/**
 * Current-month Petrol total per vehicle, keyed by vehicleId — every id in
 * `vehicleIds` gets an entry (0 if that vehicle had no Petrol transactions
 * this month, never omitted). Built off one aggregateTransactions() call
 * filtered to the Petrol expense head (Phase 5 Part E's monthly comparison
 * table) — not a separate query per vehicle.
 */
export async function getCurrentMonthPetrolByVehicle(
  petrolExpenseHeadId: string | undefined,
  vehicleIds: string[],
  now: Date = new Date(),
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  for (const id of vehicleIds) map.set(id, 0);
  if (petrolExpenseHeadId == null) return map;

  const { current } = monthlyDateRanges(now);
  const results = await aggregateTransactions({
    groupBy: 'vehicle',
    dateFrom: current.from,
    dateTo: current.to,
    expenseHeadId: petrolExpenseHeadId,
  });
  for (const id of vehicleIds) {
    map.set(id, extractGroupTotal(results, id));
  }
  return map;
}

// --- Phase 7: multi-month reporting ---

export interface MonthSpec {
  /** BS year (v1.0 Nepali BS Edition — was Gregorian before this edition). */
  year: number;
  /** BS month, 1-12 (बैशाख = 1). */
  month: number;
}

/**
 * The last `n` BS months, ending with (and including) the BS month `now`
 * falls in — oldest first. Used by every Reports table's "last 3 months"
 * columns (Phase 7 Parts B-D) so the window is computed once,
 * consistently.
 *
 * v1.0 Nepali BS Edition: walks BS months backward (via
 * bsCalendar.previousBsMonth, which correctly wraps बैशाख back into the
 * previous BS year's चैत) instead of Gregorian ones.
 */
export function lastNMonthsSpec(n: number, now: Date = new Date()): MonthSpec[] {
  return lastNBsMonths(n, adIsoToBS(toISODate(now)));
}

export interface MonthlySeriesResult {
  year: number;
  month: number;
  totals: AggregateGroupTotal[];
}

/**
 * Per-group totals for an arbitrary list of months — e.g. the Reports
 * screen's "Jun/Jul/Aug" columns (Phase 7 Part A). Implemented as one
 * aggregateTransactions() call per requested month, reusing monthBounds()
 * for each month's date range — the same "one call per period" shape
 * every *Totals function above (getExpenseHeadTotals, getStaffTotals,
 * getVehicleTotals, getInstitutionTotals) already uses for its
 * fixed current/previous/YTD/lifetime windows, just generalized to an
 * arbitrary list of windows. Chosen over fetching the whole table once
 * and bucketing by month in memory: that would mean re-implementing
 * aggregateTransactions' own date-filtering and grouping logic a second
 * time outside the function, for a query volume (a handful of months x a
 * handful of groups) where the per-month-call approach is already cheap.
 */
export async function getMonthlySeriesTotals({
  groupBy,
  months,
  expenseHeadId,
  direction,
}: {
  groupBy: GroupBy;
  months: MonthSpec[];
  expenseHeadId?: string;
  direction?: Direction;
}): Promise<MonthlySeriesResult[]> {
  return Promise.all(
    months.map(async ({ year, month }) => {
      const { from, to } = monthBounds(year, month);
      const totals = await aggregateTransactions({ groupBy, dateFrom: from, dateTo: to, expenseHeadId, direction });
      return { year, month, totals };
    }),
  );
}

/** Sum one group's totalPaisa for one specific month out of a getMonthlySeriesTotals() result (0 if no match). */
export function extractMonthlySeriesTotal(
  series: MonthlySeriesResult[],
  year: number,
  month: number,
  groupId: number | string | null,
): number {
  const entry = series.find((s) => s.year === year && s.month === month);
  if (!entry) return 0;
  return entry.totals.find((r) => r.groupId === groupId)?.totalPaisa ?? 0;
}

export interface FlowClassBreakdown {
  operatingExpensePaisa: number;
  staffPaymentPaisa: number;
  savingsFinancialPaisa: number;
  otherMovementPaisa: number;
}

/**
 * Totals for [dateFrom, dateTo], broken down by FlowClass — the §16/§24
 * cash-flow classification made queryable (Phase 7 Parts E/F). Built on
 * the new groupBy: 'flowClass' rather than a hand-written breakdown: this
 * is Part A's "extend the aggregation engine additively" instruction
 * applied to a dimension (flowClass) the engine couldn't group by before.
 * Defaults to `direction: 'cash_out'` (matching aggregateTransactions'
 * own default for any non-'cashInType' groupBy) since the Dashboard's
 * "operating expenses / staff payments / savings-deposits" figures are
 * all outflow-side per the master spec's §24 — pass `direction: 'cash_in'`
 * explicitly for a cash-in-side breakdown if ever needed.
 */
export async function getFlowClassBreakdown(
  dateFrom: string,
  dateTo: string,
  direction: Direction = 'cash_out',
): Promise<FlowClassBreakdown> {
  const results = await aggregateTransactions({ groupBy: 'flowClass', dateFrom, dateTo, direction });
  const get = (fc: string) => extractGroupTotal(results, fc);
  return {
    operatingExpensePaisa: get('operating_expense'),
    staffPaymentPaisa: get('staff_payment'),
    savingsFinancialPaisa: get('savings_financial'),
    otherMovementPaisa: get('other_movement'),
  };
}
