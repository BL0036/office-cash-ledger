import { TRANSACTION_EXPORT_COLUMNS, type TransactionExportRow } from './exportRows';

/**
 * RFC-4180-style CSV field escaping: a field is wrapped in double quotes
 * if it contains a comma, a double quote, or a newline (of either kind),
 * and any double quote inside it is doubled. Naive string concatenation
 * (just joining with commas) would silently corrupt a description or
 * note containing any of these — this is the one function every CSV
 * export in the app routes every field through, so the escaping logic
 * exists in exactly one place.
 */
export function escapeCsvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Serializes rows (with the shared column set) to a CSV string, CRLF line endings per RFC 4180. */
export function transactionRowsToCsv(rows: TransactionExportRow[]): string {
  const headerLine = TRANSACTION_EXPORT_COLUMNS.map((c) => escapeCsvField(c.header)).join(',');
  const lines = rows.map((row) =>
    TRANSACTION_EXPORT_COLUMNS.map((c) => escapeCsvField(String(row[c.key]))).join(','),
  );
  return [headerLine, ...lines].join('\r\n');
}
