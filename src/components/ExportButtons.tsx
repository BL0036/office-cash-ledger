import { Download } from 'lucide-react';
import type { Transaction } from '../types';
import { buildTransactionExportRows, type ExportLookups } from '../lib/exportRows';
import { transactionRowsToCsv } from '../lib/csv';
import { transactionRowsToWorkbook, workbookToBlob } from '../lib/excel';
import { downloadBlob, downloadTextFile } from '../lib/download';
import { useLanguage } from '../lib/i18n';

/**
 * The one CSV/Excel export trigger used by every screen that offers it
 * (Search, each Expense Diary, each Vehicle/Institution profile) — both
 * buttons build rows via the same buildTransactionExportRows() and only
 * differ in the final serialization call (Phase 9 Part C/D).
 */
export function ExportButtons({
  transactions,
  lookups,
  filenamePrefix,
}: {
  transactions: Transaction[];
  lookups: ExportLookups;
  filenamePrefix: string;
}) {
  const { t: tr } = useLanguage();
  function handleCsv() {
    const rows = buildTransactionExportRows(transactions, lookups);
    downloadTextFile(transactionRowsToCsv(rows), `${filenamePrefix}.csv`, 'text/csv');
  }

  function handleExcel() {
    const rows = buildTransactionExportRows(transactions, lookups);
    const workbook = transactionRowsToWorkbook(rows, 'Transactions');
    downloadBlob(workbookToBlob(workbook), `${filenamePrefix}.xlsx`);
  }

  if (transactions.length === 0) return null;

  return (
    <div className="flex gap-2">
      <button
        onClick={handleCsv}
        className="btn btn-secondary btn-sm"
      >
        <Download size={12} /> {tr('CSV निर्यात', 'Export CSV')}
      </button>
      <button
        onClick={handleExcel}
        className="btn btn-secondary btn-sm"
      >
        <Download size={12} /> {tr('Excel निर्यात', 'Export Excel')}
      </button>
    </div>
  );
}
