import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { ExpenseHead } from '../types';
import { formatPaisaAsRupees } from '../lib/money';
import { formatDateDisplay } from '../lib/dates';
import { getExpenseHeadTotals } from '../lib/aggregation';
import {
  useActiveExpenseHeadsByCategory,
  useCashInTypeLookup,
  useCategoryLookup,
  useExpenseHeadLookup,
  useExpenseHeadTransactions,
  useInstitutionLookup,
  useStaffLookup,
  useVehicleLookup,
} from '../hooks/useLedger';
import { ExportButtons } from './ExportButtons';
import type { ExportLookups } from '../lib/exportRows';
import { useLanguage } from '../lib/i18n';

function ExpenseHeadDiary({ head, onBack }: { head: ExpenseHead; onBack: () => void }) {
  const { t: tr } = useLanguage();
  const transactions = useExpenseHeadTransactions(head.id!);
  const totals = useLiveQuery(() => getExpenseHeadTotals(head.id!), [head.id]);
  const categoryLookup = useCategoryLookup();
  const expenseHeadLookup = useExpenseHeadLookup();
  const cashInTypeLookup = useCashInTypeLookup();
  const staffLookup = useStaffLookup();
  const vehicleLookup = useVehicleLookup();
  const institutionLookup = useInstitutionLookup();

  const exportLookups: ExportLookups = {
    categories: categoryLookup,
    expenseHeads: expenseHeadLookup,
    cashInTypes: cashInTypeLookup,
    staff: staffLookup,
    vehicles: vehicleLookup,
    institutions: institutionLookup,
  };

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6 py-5 space-y-4 pb-24">
      <button
        onClick={onBack}
        className="text-sm font-medium text-teal-700 hover:underline flex items-center gap-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
      >
        &#8249; {tr('सबै खर्च शीर्षक', 'All Expense Heads')}
      </button>

      <h1 className="text-page-title">{head.name}</h1>

      <div className="grid grid-cols-2 gap-3">
        <div className="card p-3">
          <p className="panel-label">{tr('यो महिना', 'This Month')}</p>
          <p className="mt-1 text-base font-semibold text-ink-900">
            {formatPaisaAsRupees(totals?.currentMonthPaisa ?? 0)}
          </p>
        </div>
        <div className="card p-3">
          <p className="panel-label">{tr('गत महिना', 'Last Month')}</p>
          <p className="mt-1 text-base font-semibold text-ink-900">
            {formatPaisaAsRupees(totals?.previousMonthPaisa ?? 0)}
          </p>
        </div>
        <div className="card p-3">
          <p className="panel-label">
            {tr('चालु वर्षसम्म', 'Year to Date')}
          </p>
          <p className="mt-1 text-base font-semibold text-ink-900">
            {formatPaisaAsRupees(totals?.yearToDatePaisa ?? 0)}
          </p>
        </div>
        <div className="card p-3">
          <p className="panel-label">{tr('जम्मा (सबै समय)', 'Lifetime')}</p>
          <p className="mt-1 text-base font-semibold text-ink-900">
            {formatPaisaAsRupees(totals?.lifetimePaisa ?? 0)}
          </p>
        </div>
      </div>

      {transactions && transactions.length > 0 && (
        <ExportButtons
          transactions={transactions}
          lookups={exportLookups}
          filenamePrefix={`diary-${head.name.toLowerCase().replace(/\s+/g, '-')}`}
        />
      )}

      <div className="card divide-y divide-line-100">
        {!transactions ? (
          <div className="empty-state flex items-center justify-center gap-2">
            <span className="spinner" aria-hidden="true" />
            {tr('लोड हुँदैछ…', 'Loading…')}
          </div>
        ) : transactions.length === 0 ? (
          <p className="empty-state">{tr('अहिलेसम्म कुनै कारोबार छैन।', 'No transactions yet.')}</p>
        ) : (
          transactions.map((t) => (
            <div key={t.id} className="p-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink-900 truncate">{t.description}</p>
                <p className="text-xs text-ink-500">{formatDateDisplay(t.date)}</p>
              </div>
              <span className="text-sm font-semibold text-brick-700 shrink-0">
                − {formatPaisaAsRupees(t.amountPaisa)}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export function DiariesView() {
  const { t: tr } = useLanguage();
  const grouped = useActiveExpenseHeadsByCategory();
  const [selectedHead, setSelectedHead] = useState<ExpenseHead | null>(null);

  if (selectedHead) {
    return <ExpenseHeadDiary head={selectedHead} onBack={() => setSelectedHead(null)} />;
  }

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6 py-5 space-y-4 pb-24">
      <h1 className="text-page-title">{tr('खर्च डायरी', 'Expense Diaries')}</h1>
      {!grouped ? (
        <div className="empty-state flex items-center justify-center gap-2">
          <span className="spinner" aria-hidden="true" />
          {tr('लोड हुँदैछ…', 'Loading…')}
        </div>
      ) : grouped.length === 0 ? (
        <p className="empty-state">
          {tr('अहिलेसम्म कुनै सक्रिय खर्च शीर्षक छैन। सेटिङमा थप्नुहोस्।', 'No active expense heads yet. Add one in Settings.')}
        </p>
      ) : (
        grouped.map(({ category, heads }) => (
          <section key={category.id} className="card card-pad">
            <h2 className="panel-title mb-1">{category.name}</h2>
            <ul className="divide-y divide-line-100">
              {heads.map((h) => (
                <li key={h.id}>
                  <button
                    onClick={() => setSelectedHead(h)}
                    className="w-full text-left py-2.5 text-sm text-ink-900 hover:text-teal-700 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
                  >
                    {h.name}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
