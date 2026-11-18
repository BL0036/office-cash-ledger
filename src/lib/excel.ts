import * as XLSX from 'xlsx';
import { TRANSACTION_EXPORT_COLUMNS, type TransactionExportRow } from './exportRows';

// This module only ever WRITES .xlsx files (XLSX.write / XLSX.utils.*
// sheet builders) — never XLSX.read on user-supplied input. Excel/CSV
// import is explicitly out of scope this phase (see README), so the
// known parsing-side vulnerabilities in the npm-registry build of xlsx
// (prototype pollution / ReDoS, both in the read path) aren't reachable
// through this app's usage.

/** One sheet, built from the same TransactionExportRow[] csv.ts serializes — the only thing that differs from CSV is this function's output format. */
export function transactionRowsToSheet(rows: TransactionExportRow[]): XLSX.WorkSheet {
  const aoa = [
    TRANSACTION_EXPORT_COLUMNS.map((c) => c.header),
    ...rows.map((row) => TRANSACTION_EXPORT_COLUMNS.map((c) => row[c.key])),
  ];
  return XLSX.utils.aoa_to_sheet(aoa);
}

/** A single-sheet workbook for one screen's "Export as Excel" action (Search/Diary/Vehicle/Institution). */
export function transactionRowsToWorkbook(rows: TransactionExportRow[], sheetName: string): XLSX.WorkBook {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, transactionRowsToSheet(rows), sheetName);
  return workbook;
}

/** Serializes a workbook to a Blob suitable for a browser download. */
export function workbookToBlob(workbook: XLSX.WorkBook): Blob {
  const arrayBuffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
  return new Blob([arrayBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

/** A generic key/value or tabular sheet for the Backup & Export section's full-workbook export (Part D) — one sheet per major table. */
export function objectRowsToSheet<T extends object>(rows: T[]): XLSX.WorkSheet {
  return XLSX.utils.json_to_sheet(rows);
}
