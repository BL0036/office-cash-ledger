import type { CashInType, Category, ExpenseHead, FinancialInstitution, Staff, Transaction, Vehicle } from '../types';
import { formatAdIsoAsBS } from './bsCalendar';

// The single place paisa gets converted to a plain rupee string for
// export (besides the UI's own formatPaisaAsRupees, which adds a "Rs."
// prefix and thousands separators meant for on-screen display, not a
// value someone might want Excel to parse as a number). Two decimals,
// no currency symbol, no thousands separator.
function paisaToExportAmount(paisa: number): string {
  return (paisa / 100).toFixed(2);
}

export interface TransactionExportRow {
  /** v1.0 Nepali BS Edition (§24): the primary, human-facing date column — Nepali digits + Nepali month name, same formatting as everywhere else in the app. */
  bsDate: string;
  /** The internal ISO/Gregorian date, kept alongside the BS date rather than replaced by it (§24: "where technically useful") — a plain sortable/parseable value for anyone cross-referencing against the internal architecture or another system. */
  date: string;
  direction: 'Cash In' | 'Cash Out';
  description: string;
  amount: string;
  category: string;
  expenseHead: string;
  staffName: string;
  vehicleName: string;
  institutionName: string;
  referenceNumber: string;
  notes: string;
}

/** Every id -> name lookup buildTransactionExportRows() needs, built once by the caller (Search/Diary/Vehicle/Institution screens all already have hooks for these). */
export interface ExportLookups {
  categories: Map<string, Category>;
  expenseHeads: Map<string, ExpenseHead>;
  cashInTypes: Map<string, CashInType>;
  staff: Map<string, Staff>;
  vehicles: Map<string, Vehicle>;
  institutions: Map<string, FinancialInstitution>;
}

/**
 * The one row-preparation implementation shared by lib/csv.ts and
 * lib/excel.ts (Phase 9 Part D: "share the row-preparation code and only
 * differ in the final serialization step"). Resolves every id to a name
 * so the export is meaningful to a non-technical owner, and converts
 * amountPaisa to a plain rupee string here — the one place besides the
 * UI boundary this app converts paisa to a display value (Part C).
 *
 * Column set is exactly the one named in the spec: date, direction,
 * description, amount, category, expense head, staff name, vehicle name,
 * institution name, reference number, notes. No cash-in-type column —
 * the spec's column list doesn't include one, so a cash_in row's
 * "category" reads blank (categoryId is null for cash_in, the same
 * convention every other cash_in transaction in the app already
 * follows), rather than inventing an extra column to carry it.
 */
export function buildTransactionExportRows(
  transactions: Transaction[],
  lookups: ExportLookups,
): TransactionExportRow[] {
  return transactions.map((t) => ({
    bsDate: formatAdIsoAsBS(t.date),
    date: t.date,
    direction: t.direction === 'cash_in' ? 'Cash In' : 'Cash Out',
    description: t.description,
    amount: paisaToExportAmount(t.amountPaisa),
    category: t.categoryId != null ? (lookups.categories.get(t.categoryId)?.name ?? '') : '',
    expenseHead: t.expenseHeadId != null ? (lookups.expenseHeads.get(t.expenseHeadId)?.name ?? '') : '',
    staffName: t.staffId != null ? (lookups.staff.get(t.staffId)?.name ?? '') : '',
    vehicleName: t.vehicleId != null ? (lookups.vehicles.get(t.vehicleId)?.name ?? '') : '',
    institutionName:
      t.institutionId != null ? (lookups.institutions.get(t.institutionId)?.name ?? '') : '',
    referenceNumber: t.referenceNumber ?? '',
    notes: t.notes ?? '',
  }));
}

/** Column headers, in the same order buildTransactionExportRows() emits fields — shared by CSV and Excel so the two never drift apart. */
export const TRANSACTION_EXPORT_COLUMNS: { key: keyof TransactionExportRow; header: string }[] = [
  { key: 'bsDate', header: 'नेपाली मिति (BS Date)' },
  { key: 'date', header: 'Internal Date (AD)' },
  { key: 'direction', header: 'Direction' },
  { key: 'description', header: 'Description' },
  { key: 'amount', header: 'Amount (Rs.)' },
  { key: 'category', header: 'Category' },
  { key: 'expenseHead', header: 'Expense Head' },
  { key: 'staffName', header: 'Staff' },
  { key: 'vehicleName', header: 'Vehicle' },
  { key: 'institutionName', header: 'Institution' },
  { key: 'referenceNumber', header: 'Reference Number' },
  { key: 'notes', header: 'Notes' },
];
