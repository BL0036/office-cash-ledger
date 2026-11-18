import { useState } from 'react';
import { addDaysISO, formatDateDisplay, todayISO } from '../lib/dates';
import { formatPaisaAsRupees } from '../lib/money';
import {
  useCashInTypeLookup,
  useCategoryLookup,
  useExpenseHeadLookup,
  useInstitutionLookup,
  useStaffLookup,
  useTransactionsInRange,
  useVehicleLookup,
} from '../hooks/useLedger';
import { ExportButtons } from './ExportButtons';
import { BsDatePicker } from './BsDatePicker';
import type { ExportLookups } from '../lib/exportRows';
import { useLanguage } from '../lib/i18n';

export function SearchView() {
  const { t: tr } = useLanguage();
  const [startDate, setStartDate] = useState(addDaysISO(todayISO(), -7));
  const [endDate, setEndDate] = useState(todayISO());

  const transactions = useTransactionsInRange(startDate, endDate);
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
      <h1 className="text-page-title">{tr('खोजी', 'Search')}</h1>
      <div className="card card-pad flex flex-col sm:flex-row gap-3 sm:items-end">
        <div className="flex-1 min-w-0">
          <label className="field-label">{tr('देखि', 'From')}</label>
          <BsDatePicker
            value={startDate}
            onChange={(iso) => iso <= endDate && setStartDate(iso)}
            className="w-full [&>select]:flex-1"
          />
        </div>
        <div className="flex-1 min-w-0">
          <label className="field-label">{tr('सम्म', 'To')}</label>
          <BsDatePicker
            value={endDate}
            onChange={(iso) => iso >= startDate && setEndDate(iso)}
            className="w-full [&>select]:flex-1"
          />
        </div>
      </div>

      {transactions && transactions.length > 0 && (
        <ExportButtons
          transactions={transactions}
          lookups={exportLookups}
          filenamePrefix={`search-${startDate}-to-${endDate}`}
        />
      )}

      <div className="card divide-y divide-line-100">
        {!transactions ? (
          <div className="empty-state flex items-center justify-center gap-2">
            <span className="spinner" aria-hidden="true" />
            {tr('लोड हुँदैछ…', 'Loading…')}
          </div>
        ) : transactions.length === 0 ? (
          <p className="empty-state">{tr('यो अवधिमा कुनै कारोबार छैन।', 'No transactions in this range.')}</p>
        ) : (
          transactions.map((t) => {
            const subtitle =
              t.direction === 'cash_in'
                ? (t.cashInTypeId != null && cashInTypeLookup.get(t.cashInTypeId)?.name) || ''
                : [
                    t.categoryId != null ? categoryLookup.get(t.categoryId)?.name : null,
                    t.expenseHeadId != null ? expenseHeadLookup.get(t.expenseHeadId)?.name : null,
                    t.staffId != null ? staffLookup.get(t.staffId)?.name : null,
                    t.vehicleId != null ? vehicleLookup.get(t.vehicleId)?.name : null,
                  ]
                    .filter(Boolean)
                    .join(' · ');

            return (
              <div key={t.id} className="p-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink-900 truncate">{t.description}</p>
                  <p className="text-xs text-ink-500 truncate">
                    {formatDateDisplay(t.date)}
                    {subtitle ? ` · ${subtitle}` : ''}
                  </p>
                </div>
                <span
                  className={`text-sm font-semibold shrink-0 ${
                    t.direction === 'cash_in' ? 'text-teal-700' : 'text-brick-700'
                  }`}
                >
                  {t.direction === 'cash_in' ? '+' : '−'} {formatPaisaAsRupees(t.amountPaisa)}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
