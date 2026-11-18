import { db } from '../db/schema';
import { recalcCascadeFrom } from './ledger';
import type {
  Budget,
  CashInType,
  Category,
  ExpenseHead,
  FinancialInstitution,
  LedgerDay,
  Staff,
  StaffVehicle,
  Transaction,
  Vehicle,
} from '../types';

// Tracks package.json's "version" field. Kept as a small local constant
// rather than importing package.json directly, since that file sits
// outside src/ and this project's tsconfig isn't set up for cross-
// boundary JSON module resolution.
// Keep in sync with package.json's "version" field - no automated link
// between the two (see CHANGELOG for why: importing package.json here
// was considered and deliberately deferred as a separate, bigger change).
const APP_VERSION = '1.0.0';

export interface BackupPayload {
  schemaVersion: number;
  exportedAt: string; // ISO 8601
  appVersion: string;
  transactions: Transaction[];
  ledgerDays: LedgerDay[];
  categories: Category[];
  expenseHeads: ExpenseHead[];
  cashInTypes: CashInType[];
  staff: Staff[];
  vehicles: Vehicle[];
  financialInstitutions: FinancialInstitution[];
  budgets: Budget[];
  // Phase 2: the new staff<->vehicle join table. Deliberately NOT added to
  // REQUIRED_TABLE_KEYS below — see the note on that constant — so a
  // pre-Phase-2 backup (no staffVehicles key at all) still validates and
  // restores; restoreFromBackup() falls back to an empty array when the
  // key is absent, per the EXACT SCOPE requirement.
  staffVehicles: StaffVehicle[];
}

// Every table a backup file must contain to be considered structurally
// valid. `staffVehicles` is intentionally excluded (see the field comment
// on BackupPayload above): the schemaVersion equality check just below
// already rejects any backup from a genuinely older app version on its
// own (that's a real, pre-existing, separately-flagged limitation — see
// the Phase 2 changelog — not something this table's addition should make
// worse), so requiring staffVehicles here on top of that would only add a
// SECOND, redundant reason for an old backup to fail, contradicting the
// "must still restore successfully, treating a missing key as an empty
// array" requirement Phase 2 was given.
const REQUIRED_TABLE_KEYS = [
  'transactions',
  'ledgerDays',
  'categories',
  'expenseHeads',
  'cashInTypes',
  'staff',
  'vehicles',
  'financialInstitutions',
  'budgets',
] as const;

/**
 * A full, faithful snapshot of every table — including soft-deleted
 * transactions (`toArray()` doesn't filter by `deletedAt`; a backup must
 * be a complete record, not a filtered view). `schemaVersion` is the
 * live Dexie database's current version number (`db.verno`), not a
 * separately-tracked constant, so it's always accurate to what was
 * actually exported.
 */
export async function exportBackup(): Promise<BackupPayload> {
  const [
    transactions,
    ledgerDays,
    categories,
    expenseHeads,
    cashInTypes,
    staff,
    vehicles,
    financialInstitutions,
    budgets,
    staffVehicles,
  ] = await Promise.all([
    db.transactions.toArray(),
    db.ledgerDays.toArray(),
    db.categories.toArray(),
    db.expenseHeads.toArray(),
    db.cashInTypes.toArray(),
    db.staff.toArray(),
    db.vehicles.toArray(),
    db.financialInstitutions.toArray(),
    db.budgets.toArray(),
    db.staffVehicles.toArray(),
  ]);

  return {
    schemaVersion: db.verno,
    exportedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    transactions,
    ledgerDays,
    categories,
    expenseHeads,
    cashInTypes,
    staff,
    vehicles,
    financialInstitutions,
    budgets,
    staffVehicles,
  };
}

export function serializeBackup(payload: BackupPayload): string {
  return JSON.stringify(payload, null, 2);
}

/** e.g. "cash-ledger-backup-2026-08-30.json" — the date is pulled from the payload's own exportedAt, not the caller's clock, so the name always matches what's inside. */
export function backupFileName(payload: BackupPayload): string {
  return `cash-ledger-backup-${payload.exportedAt.slice(0, 10)}.json`;
}

export type BackupValidationResult = { valid: true } | { valid: false; error: string };

/**
 * Structural validation ONLY — correct top-level shape, a recognized
 * schemaVersion, every expected table key present as an array. Row-level
 * validity (e.g. a transaction's categoryId actually existing) is not
 * checked here; IndexedDB itself has no foreign-key constraints to
 * violate, and the live app's own write paths are what keep data
 * consistent going forward. This function's only job is to make sure
 * restoreFromBackup() never touches the live database on a file that
 * isn't even shaped like a backup.
 */
export function validateBackupPayload(data: unknown): BackupValidationResult {
  if (typeof data !== 'object' || data === null) {
    return { valid: false, error: 'This file is not a valid backup (not a JSON object).' };
  }
  const obj = data as Record<string, unknown>;

  if (typeof obj.schemaVersion !== 'number') {
    return { valid: false, error: 'This file is missing a valid schemaVersion.' };
  }
  if (obj.schemaVersion !== db.verno) {
    return {
      valid: false,
      error: `Unrecognized backup schema version ${obj.schemaVersion} (this app is on version ${db.verno}).`,
    };
  }

  for (const key of REQUIRED_TABLE_KEYS) {
    if (!Array.isArray(obj[key])) {
      return { valid: false, error: `This file is missing the required "${key}" table.` };
    }
  }

  return { valid: true };
}

export interface RestoreResult {
  /** A full export of the live database taken right before the destructive replace — the safety-net snapshot (Part B), always produced on a successful restore. */
  preRestoreSnapshot: BackupPayload;
}

/**
 * Validates, then destructively replaces every table with the backup's
 * contents, EXCEPT `ledgerDays` — which is deliberately never restored
 * from the file. Instead, every LedgerDay is rebuilt from scratch by
 * re-running the same recalcCascadeFrom() every live write path already
 * trusts, once per distinct transaction date (ascending), so the
 * restored balances are guaranteed internally consistent with the
 * imported transactions rather than whatever numbers happened to be
 * cached in the old export. A backup's LedgerDay rows are a snapshot of
 * a *derived* value, not a source of truth — trusting them directly
 * would let a corrupted or manually-edited export silently reintroduce
 * wrong balances that no longer match the transactions that produced
 * them. recalcCascadeFrom(date) only ever creates/recomputes ONE day
 * plus walks forward through whatever LedgerDay rows already exist after
 * it — it doesn't invent rows for every date on its own — which is why
 * this calls it once per distinct date in the imported data (ascending),
 * mirroring exactly how the live system built these rows up one
 * transaction at a time in the first place, rather than a single call
 * "from the earliest date" that would only ever produce one row.
 *
 * Throws (and touches nothing) if validation fails. On success, the
 * whole clear-and-restore runs inside one Dexie transaction() so a
 * failure partway through — e.g. a corrupted row IndexedDB itself
 * rejects — aborts and rolls back every change made so far, leaving the
 * database exactly as it was before the attempt.
 */
export async function restoreFromBackup(fileContents: string): Promise<RestoreResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fileContents);
  } catch {
    throw new Error('This file is not valid JSON.');
  }

  const validation = validateBackupPayload(parsed);
  if (!validation.valid) {
    throw new Error(validation.error);
  }
  const payload = parsed as BackupPayload;

  // Safety snapshot of the CURRENT live database, taken now that
  // validation has passed and we're actually about to perform the
  // destructive replace (Part B: automatic, not optional).
  const preRestoreSnapshot = await exportBackup();

  await db.transaction(
    'rw',
    [
      db.transactions,
      db.ledgerDays,
      db.categories,
      db.expenseHeads,
      db.cashInTypes,
      db.staff,
      db.vehicles,
      db.financialInstitutions,
      db.budgets,
      db.staffVehicles,
    ],
    async () => {
      await Promise.all([
        db.transactions.clear(),
        db.ledgerDays.clear(),
        db.categories.clear(),
        db.expenseHeads.clear(),
        db.cashInTypes.clear(),
        db.staff.clear(),
        db.vehicles.clear(),
        db.financialInstitutions.clear(),
        db.budgets.clear(),
        db.staffVehicles.clear(),
      ]);

      // Master/reference data, then transactions. No functional ordering
      // requirement — IndexedDB enforces no foreign-key constraints — this
      // just mirrors how the app conceptually groups the data.
      await db.categories.bulkPut(payload.categories);
      await db.expenseHeads.bulkPut(payload.expenseHeads);
      await db.cashInTypes.bulkPut(payload.cashInTypes);
      await db.staff.bulkPut(payload.staff);
      await db.vehicles.bulkPut(payload.vehicles);
      await db.financialInstitutions.bulkPut(payload.financialInstitutions);
      await db.budgets.bulkPut(payload.budgets);
      // Missing key (pre-Phase-2 backup) → treat as no assignments, per
      // the EXACT SCOPE requirement — never throw over this alone.
      await db.staffVehicles.bulkPut(payload.staffVehicles ?? []);
      await db.transactions.bulkPut(payload.transactions);

      // Rebuild every LedgerDay — see this function's doc comment above.
      //
      // One subtlety recalcCascadeFrom's own "first row ever created
      // becomes Day 1" rule (in ensureLedgerDay) can't handle on its
      // own: WHICH date was originally Day 1 is a matter of chronological
      // *creation* order, not necessarily the chronologically *earliest*
      // transaction date — a transaction can be backdated to before an
      // already-established Day 1 (see README "Backdating before Day
      // 1"), and Day 1 correctly keeps its manual flag when that
      // happens. Rebuilding purely in ascending date order would instead
      // hand "Day 1" to whichever date happens to be earliest among the
      // *imported* transactions, silently reassigning it. The manual-
      // opening flag and its exact opening balance are themselves source
      // data (the owner's deliberate anchor choice), not a derived
      // financial value — the one thing about the backup's ledgerDays
      // this function does read directly, rather than trusting the
      // whole row as-is.
      const originalManualDay = payload.ledgerDays.find((d) => d.isManualOpening);
      const distinctDates = Array.from(new Set(payload.transactions.map((t) => t.date))).sort();

      // Create the original Day 1's row FIRST (even if it has no
      // transactions of its own) so ensureLedgerDay's "first row ever
      // created" rule assigns the manual flag to the right date.
      if (originalManualDay) {
        await recalcCascadeFrom(originalManualDay.date);
      }
      for (const date of distinctDates) {
        if (date === originalManualDay?.date) continue; // already processed above
        await recalcCascadeFrom(date);
      }

      // Re-apply the original manual anchor's exact opening balance and
      // re-cascade once more. If this date is still the true first row,
      // this correctly restores its manually-set opening value (which
      // ensureLedgerDay would otherwise have defaulted to 0). If a
      // still-earlier date was also imported, recalcCascadeFrom's own
      // i===0-only rule means this explicit value is immediately
      // superseded by the cascade from that earlier day's closing —
      // exactly matching the documented "Day 1 keeps its manual flag,
      // but its displayed opening now cascades from the newly-earlier
      // day" behavior, not a special case this code needs to detect.
      if (originalManualDay) {
        const day = await db.ledgerDays.get(originalManualDay.date);
        if (day) {
          await db.ledgerDays.put({
            ...day,
            isManualOpening: true,
            openingBalancePaisa: originalManualDay.openingBalancePaisa,
          });
        }
        await recalcCascadeFrom(originalManualDay.date);
      }
    },
  );

  return { preRestoreSnapshot };
}
