import { db } from '../db/schema';
import type { FlowClass, LedgerDay, Transaction } from '../types';

/**
 * Ensure a LedgerDay row exists for `date`, creating one if needed.
 * Must only be called from within an active db.transaction() — it does
 * not open its own.
 *
 * A brand-new day's initial opening/manual flag is a best-effort guess;
 * `recalcCascadeFrom` (called right after, in the same transaction) is
 * what actually makes the stored values correct by walking the whole
 * chain from this day forward.
 */
async function ensureLedgerDay(date: string): Promise<LedgerDay> {
  const existing = await db.ledgerDays.get(date);
  if (existing) return existing;

  const anyDayExists = (await db.ledgerDays.count()) > 0;
  const day: LedgerDay = {
    date,
    openingBalancePaisa: 0,
    cashInPaisa: 0,
    cashOutPaisa: 0,
    closingBalancePaisa: 0,
    // Day 1 = the very first LedgerDay row ever created for this ledger.
    // Every subsequent day (including ones created out of chronological
    // order — see README "Known limitations") is auto-computed.
    isManualOpening: !anyDayExists,
    recalculatedAt: Date.now(),
  };
  await db.ledgerDays.put(day);
  return day;
}

async function computeDayTotals(date: string): Promise<{ cashIn: number; cashOut: number }> {
  const rows = await db.transactions.where('date').equals(date).toArray();
  let cashIn = 0;
  let cashOut = 0;
  for (const t of rows) {
    if (t.deletedAt) continue;
    if (t.direction === 'cash_in') cashIn += t.amountPaisa;
    else cashOut += t.amountPaisa;
  }
  return { cashIn, cashOut };
}

/**
 * Recompute `date` and every LATER existing LedgerDay, in date order,
 * propagating openingBalancePaisa forward from each day's closing.
 * Must only be called from within an active db.transaction() covering
 * both `transactions` and `ledgerDays`.
 *
 * This single function implements both business rules 4 and 5: when
 * `date` is the latest existing day, the loop below runs exactly once
 * (no subsequent days to cascade into); when earlier days exist after
 * it, they're all walked and updated too.
 *
 * Exported as of Phase 9 so lib/backup.ts's restore path can rebuild
 * every LedgerDay from imported transactions using this exact same
 * trusted logic, rather than trusting a backup file's cached LedgerDay
 * values — see backup.ts for why.
 */
export async function recalcCascadeFrom(date: string): Promise<void> {
  await ensureLedgerDay(date);

  const allDays = await db.ledgerDays.orderBy('date').toArray();
  const startIndex = allDays.findIndex((d) => d.date === date);
  if (startIndex === -1) {
    // Should be unreachable — ensureLedgerDay just created/confirmed it.
    throw new Error(`LedgerDay for ${date} not found during recalculation`);
  }

  for (let i = startIndex; i < allDays.length; i++) {
    const day = allDays[i];
    const opening =
      i === 0
        ? day.isManualOpening
          ? day.openingBalancePaisa
          : 0
        : allDays[i - 1].closingBalancePaisa;

    const { cashIn, cashOut } = await computeDayTotals(day.date);
    const closing = opening + cashIn - cashOut;

    const updated: LedgerDay = {
      ...day,
      openingBalancePaisa: opening,
      cashInPaisa: cashIn,
      cashOutPaisa: cashOut,
      closingBalancePaisa: closing,
      recalculatedAt: Date.now(),
    };
    await db.ledgerDays.put(updated);
    allDays[i] = updated;
  }
}

/**
 * Resolve the flowClass a transaction should carry, from whichever
 * reference row it points to: the Category for cash_out, the CashInType
 * for cash_in. Falls back to 'other_movement' only if the referenced row
 * is somehow missing (shouldn't happen with a valid categoryId/
 * cashInTypeId, since Settings never deletes rows — only deactivates
 * them).
 */
async function resolveFlowClass(
  direction: Transaction['direction'],
  categoryId: string | null,
  cashInTypeId: string | null,
): Promise<FlowClass> {
  if (direction === 'cash_out' && categoryId != null) {
    const category = await db.categories.get(categoryId);
    if (category) return category.flowClass;
  }
  if (direction === 'cash_in' && cashInTypeId != null) {
    const cashInType = await db.cashInTypes.get(cashInTypeId);
    if (cashInType) return cashInType.flowClass;
  }
  return 'other_movement';
}

export type NewTransactionInput = Omit<
  Transaction,
  'id' | 'createdAt' | 'updatedAt' | 'deletedAt' | 'flowClass'
>;

export async function addTransaction(input: NewTransactionInput): Promise<string> {
  return db.transaction(
    'rw',
    db.transactions,
    db.ledgerDays,
    db.categories,
    db.cashInTypes,
    async () => {
      const now = Date.now();
      const flowClass = await resolveFlowClass(input.direction, input.categoryId, input.cashInTypeId);
      const id = crypto.randomUUID();
      await db.transactions.add({
        ...input,
        id,
        flowClass,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });
      await recalcCascadeFrom(input.date);
      return id;
    },
  );
}

export type EditableTransactionFields = Partial<
  Pick<
    Transaction,
    | 'amountPaisa'
    | 'categoryId'
    | 'expenseHeadId'
    | 'cashInTypeId'
    | 'description'
    | 'referenceNumber'
    | 'notes'
    | 'date'
    | 'staffId'
    | 'vehicleId'
  >
>;

export async function editTransaction(
  id: string,
  changes: EditableTransactionFields,
): Promise<void> {
  await db.transaction(
    'rw',
    db.transactions,
    db.ledgerDays,
    db.categories,
    db.cashInTypes,
    async () => {
      const existing = await db.transactions.get(id);
      if (!existing) throw new Error(`Transaction ${id} not found`);

      const originalDate = existing.date;

      // If the category/cash-in-type is changing, the flowClass copied
      // onto the transaction at creation time (Part A) needs to move with
      // it — additive to the existing edit flow, doesn't touch the
      // recalculation cascade below.
      let flowClassUpdate: { flowClass: FlowClass } | Record<string, never> = {};
      if ('categoryId' in changes || 'cashInTypeId' in changes) {
        const newCategoryId = 'categoryId' in changes ? changes.categoryId! : existing.categoryId;
        const newCashInTypeId =
          'cashInTypeId' in changes ? changes.cashInTypeId! : existing.cashInTypeId;
        const flowClass = await resolveFlowClass(existing.direction, newCategoryId, newCashInTypeId);
        flowClassUpdate = { flowClass };
      }

      await db.transactions.update(id, { ...changes, ...flowClassUpdate, updatedAt: Date.now() });

      const newDate = changes.date ?? originalDate;
      // Recalculate from whichever date is earlier, so both the old day's
      // totals (amount moved away) and the new day's totals (amount moved
      // in) — and everything after both — end up correct.
      const earliest = originalDate < newDate ? originalDate : newDate;
      await recalcCascadeFrom(earliest);
      if (newDate !== earliest) {
        await recalcCascadeFrom(newDate);
      }
    },
  );
}

export async function softDeleteTransaction(id: string): Promise<void> {
  await db.transaction('rw', db.transactions, db.ledgerDays, async () => {
    const existing = await db.transactions.get(id);
    if (!existing) throw new Error(`Transaction ${id} not found`);
    await db.transactions.update(id, { deletedAt: Date.now(), updatedAt: Date.now() });
    await recalcCascadeFrom(existing.date);
  });
}

/** Set the manual opening balance for Day 1 (only valid while isManualOpening). */
export async function setManualOpeningBalance(date: string, openingPaisa: number): Promise<void> {
  await db.transaction('rw', db.transactions, db.ledgerDays, async () => {
    const day = await db.ledgerDays.get(date);
    if (!day) throw new Error(`LedgerDay for ${date} not found`);
    if (!day.isManualOpening) {
      throw new Error('Only Day 1 (isManualOpening) can have its opening balance edited directly');
    }
    await db.ledgerDays.put({ ...day, openingBalancePaisa: openingPaisa });
    await recalcCascadeFrom(date);
  });
}

/** Load (creating if necessary) the LedgerDay for `date`. */
export async function getOrCreateLedgerDay(date: string): Promise<LedgerDay> {
  return db.transaction('rw', db.transactions, db.ledgerDays, async () => {
    const existing = await db.ledgerDays.get(date);
    if (existing) return existing;
    await recalcCascadeFrom(date);
    const created = await db.ledgerDays.get(date);
    if (!created) throw new Error(`Failed to create LedgerDay for ${date}`);
    return created;
  });
}
