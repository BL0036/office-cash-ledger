import { db } from '../db/schema';
import type { Budget } from '../types';
import { getMonthlyExpenseTableData, type MonthlyExpenseRow } from './reports';

// Budgets are configuration, not a named entity any Transaction ever
// references — no `budgetId` exists anywhere in the schema. That's what
// makes the real-delete exception below safe: every other master-data
// entity in this app (categories/expense heads/cash-in types/staff/
// vehicles/institutions) is deactivate-only specifically because a
// historical Transaction can point to it by id and must keep resolving
// its name forever. A Budget row has no such downstream reference, so
// "no budget set" and "no budget row exists" are simply the same state
// by design — clearing a budget really does mean removing the row.

export async function getBudgetForHead(expenseHeadId: string): Promise<Budget | null> {
  return (await db.budgets.where('expenseHeadId').equals(expenseHeadId).first()) ?? null;
}

/** Create or update the budget for one expense head (one budget per head, enforced here). */
export async function setBudget(expenseHeadId: string, monthlyLimitPaisa: number): Promise<void> {
  if (!Number.isInteger(monthlyLimitPaisa) || monthlyLimitPaisa <= 0) {
    throw new Error('Enter a valid monthly budget limit greater than zero.');
  }
  const existing = await getBudgetForHead(expenseHeadId);
  if (existing) {
    await db.budgets.update(existing.id, { monthlyLimitPaisa, updatedAt: Date.now() });
  } else {
    await db.budgets.add({
      id: crypto.randomUUID(),
      expenseHeadId,
      monthlyLimitPaisa,
      updatedAt: Date.now(),
    });
  }
}

/**
 * Removes the budget row entirely (see the file-level comment above for
 * why this is safe, unlike every other entity's deactivate-only rule).
 * No-op if no budget is set for this head.
 *
 * Phase 10b NOTE (sync limitation, documented in README "Known issues"):
 * this is a real hard delete, unlike every other entity's deactivate-only
 * rule. Cloud Sync's push (lib/sync.ts) finds changed rows by diffing
 * `updatedAt` against `lastSyncedAt` — a row that's been deleted leaves no
 * row behind to diff, so a cleared budget does NOT propagate to other
 * synced devices. This function's local behavior is unchanged from Phase
 * 8 (spec: don't touch it / don't add per-call sync hooks — Part C is
 * explicit that sync must stay a single batched pass, not scattered calls
 * into each write function like this one).
 */
export async function clearBudget(expenseHeadId: string): Promise<void> {
  const existing = await getBudgetForHead(expenseHeadId);
  if (existing) {
    await db.budgets.delete(existing.id);
  }
}

export type BudgetStatusTier = 'under' | 'informational' | 'reached' | 'over';

export interface BudgetStatus {
  expenseHeadId: string;
  name: string;
  spentPaisa: number;
  limitPaisa: number;
  /** spentPaisa / limitPaisa * 100 — for display only; tier classification below never compares this float directly. */
  percentage: number;
  tier: BudgetStatusTier;
}

/**
 * Exactly the three named thresholds from the master spec, no invented
 * fourth tier: 80% = informational, 100% = reached, >100% = over,
 * anything below 80% = under (no warning). Classified via integer paisa
 * comparison rather than the computed float percentage, so "exactly
 * 100%" can never misfire on a floating-point rounding artifact.
 */
function classifyBudgetTier(spentPaisa: number, limitPaisa: number): BudgetStatusTier {
  if (spentPaisa === limitPaisa) return 'reached';
  if (spentPaisa > limitPaisa) return 'over';
  // spentPaisa < limitPaisa here: spent/limit >= 0.8 <=> spent*100 >= limit*80.
  if (spentPaisa * 100 >= limitPaisa * 80) return 'informational';
  return 'under';
}

/**
 * The shared core: given already-fetched budget rows and expense-table
 * rows (Part B's "current-month expense-head total, don't requery"),
 * compute each budgeted head's status. Pure/synchronous so both call
 * sites — getBudgetStatuses() below (Settings screen) and
 * getDashboardData() (reports.ts, Phase 7's Dashboard, which already has
 * its own getMonthlyExpenseTableData() result in scope) — produce
 * identical numbers from one calculation, never two diverging
 * implementations.
 */
export function computeBudgetStatuses(
  budgetRows: Budget[],
  expenseTableRows: MonthlyExpenseRow[],
): BudgetStatus[] {
  const rowByHead = new Map(expenseTableRows.map((r) => [r.expenseHeadId, r]));

  return budgetRows.map((b) => {
    const row = rowByHead.get(b.expenseHeadId);
    // The current month is always the last column (months are oldest first).
    const spentPaisa = row ? row.monthTotals[row.monthTotals.length - 1] : 0;
    const percentage = b.monthlyLimitPaisa > 0 ? (spentPaisa / b.monthlyLimitPaisa) * 100 : 0;
    return {
      expenseHeadId: b.expenseHeadId,
      name: row?.name ?? '',
      spentPaisa,
      limitPaisa: b.monthlyLimitPaisa,
      percentage,
      tier: classifyBudgetTier(spentPaisa, b.monthlyLimitPaisa),
    };
  });
}

/** Budget status for every expense head with a budget currently set, for the given month (defaults to now). */
export async function getBudgetStatuses(now: Date = new Date()): Promise<BudgetStatus[]> {
  const [budgetRows, expenseTable] = await Promise.all([
    db.budgets.toArray(),
    getMonthlyExpenseTableData(now),
  ]);
  return computeBudgetStatuses(budgetRows, expenseTable.rows);
}

/** Budget status for one specific expense head, or null if no budget is set for it — a head with no budget never has a status. */
export async function getBudgetStatusForHead(
  expenseHeadId: string,
  now: Date = new Date(),
): Promise<BudgetStatus | null> {
  const all = await getBudgetStatuses(now);
  return all.find((s) => s.expenseHeadId === expenseHeadId) ?? null;
}
