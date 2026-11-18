import { Fragment, useEffect, useState } from 'react';
import { formatPaisaAsRupees } from '../lib/money';
import {
  getCategoryBreakdown,
  getInstitutionReportData,
  getMonthlyExpenseTableData,
  getPetrolTableData,
  getStaffSummaryData,
  type CategoryBreakdownData,
  type InstitutionReportData,
  type MonthlyExpenseTableData,
  type PetrolTableData,
  type StaffSummaryRow,
} from '../lib/reports';
import { useLanguage } from '../lib/i18n';

const FLOW_CLASS_LABELS: Record<string, { ne: string; en: string }> = {
  operating_expense: { ne: 'सञ्चालन खर्च', en: 'Operating Expenses' },
  staff_payment: { ne: 'कर्मचारी भुक्तानी', en: 'Staff Payments' },
  savings_financial: { ne: 'बचत तथा वित्त', en: 'Savings & Financial' },
  other_movement: { ne: 'अन्य', en: 'Other Movements' },
};

// This screen is entirely read-only — every table here is a view over
// data already written by other screens' write paths. No add/edit/delete
// actions live here.

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card card-pad overflow-x-auto thin-scroll">
      <p className="panel-title mb-3">{title}</p>
      {children}
    </div>
  );
}

// --- Part B: Monthly Expense Table ---

function MonthlyExpenseTable({ data }: { data: MonthlyExpenseTableData }) {
  const { t: tr } = useLanguage();
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs text-ink-400 border-b border-line-100">
          <th className="py-1.5 pr-2 font-medium">{tr('खर्च शीर्षक', 'Expense Head')}</th>
          {data.months.map((m) => (
            <th key={`${m.year}-${m.month}`} className="py-1.5 px-2 font-medium text-right">
              {m.label}
            </th>
          ))}
          <th className="py-1.5 px-2 font-medium text-right">{tr('चालु वर्षसम्म', 'YTD')}</th>
          <th className="py-1.5 pl-2 font-medium text-right">{tr('जम्मा', 'Lifetime')}</th>
        </tr>
      </thead>
      <tbody>
        {data.rows.length === 0 ? (
          <tr>
            <td colSpan={data.months.length + 3} className="py-3 text-center text-ink-400">
              {tr('कुनै सक्रिय खर्च शीर्षक छैन।', 'No active expense heads.')}
            </td>
          </tr>
        ) : (
          data.rows.map((r) => (
            <tr key={r.expenseHeadId} className="border-b border-line-100 last:border-0">
              <td className="py-1.5 pr-2 text-ink-900">{r.name}</td>
              {r.monthTotals.map((v, i) => (
                <td key={i} className="py-1.5 px-2 text-right text-ink-700">
                  {formatPaisaAsRupees(v)}
                </td>
              ))}
              <td className="py-1.5 px-2 text-right text-ink-700">
                {formatPaisaAsRupees(r.yearToDatePaisa)}
              </td>
              <td className="py-1.5 pl-2 text-right text-ink-500">
                {formatPaisaAsRupees(r.lifetimePaisa)}
              </td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}

// --- Part C: Monthly Petrol Table ---

function PetrolTable({ data }: { data: PetrolTableData }) {
  const { t: tr } = useLanguage();
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs text-ink-400 border-b border-line-100">
          <th className="py-1.5 pr-2 font-medium">{tr('सवारी साधन', 'Vehicle')}</th>
          {data.months.map((m) => (
            <th key={`${m.year}-${m.month}`} className="py-1.5 px-2 font-medium text-right">
              {m.label}
            </th>
          ))}
          <th className="py-1.5 pl-2 font-medium text-right">{tr('चालु वर्षसम्म', 'YTD')}</th>
        </tr>
      </thead>
      <tbody>
        {data.rows.length === 0 ? (
          <tr>
            <td colSpan={data.months.length + 2} className="py-3 text-center text-ink-400">
              {tr('कुनै सवारी साधन छैन।', 'No vehicles yet.')}
            </td>
          </tr>
        ) : (
          <>
            {data.rows.map((r) => (
              <tr key={r.vehicleId} className="border-b border-line-100 last:border-0">
                <td className="py-1.5 pr-2 text-ink-900">
                  {r.name}
                  {!r.active && <span className="ml-1 text-xs text-ink-400">({tr('निष्क्रिय', 'inactive')})</span>}
                </td>
                {r.monthTotals.map((v, i) => (
                  <td key={i} className="py-1.5 px-2 text-right text-ink-700">
                    {formatPaisaAsRupees(v)}
                  </td>
                ))}
                <td className="py-1.5 pl-2 text-right text-ink-700">
                  {formatPaisaAsRupees(r.yearToDatePaisa)}
                </td>
              </tr>
            ))}
            <tr className="font-semibold text-ink-900">
              <td className="py-1.5 pr-2">{tr('कुल पेट्रोल', 'Total Petrol')}</td>
              {data.totalRow.monthTotals.map((v, i) => (
                <td key={i} className="py-1.5 px-2 text-right">
                  {formatPaisaAsRupees(v)}
                </td>
              ))}
              <td className="py-1.5 pl-2 text-right">
                {formatPaisaAsRupees(data.totalRow.yearToDatePaisa)}
              </td>
            </tr>
          </>
        )}
      </tbody>
    </table>
  );
}

// --- Part D: Financial Institution Report ---

function InstitutionReportTable({ data }: { data: InstitutionReportData }) {
  const { t: tr } = useLanguage();
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs text-ink-400 border-b border-line-100">
          <th rowSpan={2} className="py-1.5 pr-2 font-medium align-bottom">
            {tr('संस्था', 'Institution')}
          </th>
          {data.months.map((m) => (
            <th key={`${m.year}-${m.month}`} colSpan={2} className="py-1.5 px-2 font-medium text-center">
              {m.label}
            </th>
          ))}
          <th colSpan={2} className="py-1.5 pl-2 font-medium text-center">
            {tr('चालु वर्षसम्म', 'YTD')}
          </th>
        </tr>
        <tr className="text-left text-xs text-ink-400 border-b border-line-100">
          {data.months.map((m) => (
            <Fragment key={`${m.year}-${m.month}`}>
              <th className="py-1 px-2 font-normal text-right">{tr('जम्मा', 'Deposit')}</th>
              <th className="py-1 px-2 font-normal text-right">{tr('झिक्ने', 'Withdrawal')}</th>
            </Fragment>
          ))}
          <th className="py-1 px-2 font-normal text-right">{tr('जम्मा', 'Deposit')}</th>
          <th className="py-1 pl-2 font-normal text-right">{tr('झिक्ने', 'Withdrawal')}</th>
        </tr>
      </thead>
      <tbody>
        {data.rows.length === 0 ? (
          <tr>
            <td colSpan={data.months.length * 2 + 3} className="py-3 text-center text-ink-400">
              {tr('कुनै संस्था छैन।', 'No institutions yet.')}
            </td>
          </tr>
        ) : (
          data.rows.map((r) => (
            <tr key={r.institutionId} className="border-b border-line-100 last:border-0">
              <td className="py-1.5 pr-2 text-ink-900">
                {r.name}
                {!r.active && <span className="ml-1 text-xs text-ink-400">({tr('निष्क्रिय', 'inactive')})</span>}
              </td>
              {r.depositMonthTotals.map((v, i) => (
                <Fragment key={i}>
                  <td className="py-1.5 px-2 text-right text-brick-700">{formatPaisaAsRupees(v)}</td>
                  <td className="py-1.5 px-2 text-right text-teal-700">
                    {formatPaisaAsRupees(r.withdrawalMonthTotals[i])}
                  </td>
                </Fragment>
              ))}
              <td className="py-1.5 px-2 text-right text-brick-700">
                {formatPaisaAsRupees(r.depositYtdPaisa)}
              </td>
              <td className="py-1.5 pl-2 text-right text-teal-700">
                {formatPaisaAsRupees(r.withdrawalYtdPaisa)}
              </td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}

// --- Part E: Category / Staff report views ---

function CategoryBreakdownSection({ data }: { data: CategoryBreakdownData }) {
  const { language } = useLanguage();
  return (
    <div className="space-y-4">
      {(['operating_expense', 'staff_payment', 'savings_financial', 'other_movement'] as const).map(
        (fc) => {
          const bucket = data.byFlowClass[fc];
          if (bucket.rows.length === 0) return null;
          return (
            <div key={fc}>
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs font-semibold text-ink-500 uppercase tracking-wide">
                  {FLOW_CLASS_LABELS[fc][language]}
                </p>
                <p className="text-xs font-semibold text-ink-700">
                  {formatPaisaAsRupees(bucket.totalPaisa)}
                </p>
              </div>
              <div className="divide-y divide-line-100">
                {bucket.rows.map((r) => (
                  <div key={r.categoryId} className="py-1 flex items-center justify-between text-sm">
                    <span className="text-ink-700">{r.name}</span>
                    <span className="text-ink-900">{formatPaisaAsRupees(r.totalPaisa)}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        },
      )}
    </div>
  );
}

function StaffSummaryTable({ rows }: { rows: StaffSummaryRow[] }) {
  const { t: tr } = useLanguage();
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs text-ink-400 border-b border-line-100">
          <th className="py-1.5 pr-2 font-medium">{tr('कर्मचारी', 'Staff')}</th>
          <th className="py-1.5 px-2 font-medium text-right">{tr('तलब भुक्तानी (यो महिना)', 'Salary Paid (This Month)')}</th>
          <th className="py-1.5 pl-2 font-medium text-right">{tr('बाँकी पेश्की', 'Outstanding Advance')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td colSpan={3} className="py-3 text-center text-ink-400">
              {tr('कुनै कर्मचारी छैन।', 'No staff yet.')}
            </td>
          </tr>
        ) : (
          rows.map((r) => (
            <tr key={r.staffId} className="border-b border-line-100 last:border-0">
              <td className="py-1.5 pr-2 text-ink-900">
                {r.name}
                {!r.active && <span className="ml-1 text-xs text-ink-400">({tr('निष्क्रिय', 'inactive')})</span>}
              </td>
              <td className="py-1.5 px-2 text-right text-ink-700">
                {formatPaisaAsRupees(r.salaryPaidThisMonthPaisa)}
              </td>
              <td className="py-1.5 pl-2 text-right text-amber-700">
                {formatPaisaAsRupees(r.outstandingAdvancePaisa)}
              </td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}

// --- Screen ---

export function ReportsView() {
  const { t: tr } = useLanguage();
  const [expenseTable, setExpenseTable] = useState<MonthlyExpenseTableData | null>(null);
  const [petrolTable, setPetrolTable] = useState<PetrolTableData | null>(null);
  const [institutionReport, setInstitutionReport] = useState<InstitutionReportData | null>(null);
  const [categoryBreakdown, setCategoryBreakdown] = useState<CategoryBreakdownData | null>(null);
  const [staffSummary, setStaffSummary] = useState<StaffSummaryRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      getMonthlyExpenseTableData(),
      getPetrolTableData(),
      getInstitutionReportData(),
      getCategoryBreakdown(),
      getStaffSummaryData(),
    ]).then(([expense, petrol, institution, category, staff]) => {
      if (cancelled) return;
      setExpenseTable(expense);
      setPetrolTable(petrol);
      setInstitutionReport(institution);
      setCategoryBreakdown(category);
      setStaffSummary(staff);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6 py-5 space-y-4 pb-24">
      <h1 className="text-page-title">{tr('प्रतिवेदन', 'Reports')}</h1>

      <SectionCard title={tr('शीर्षक अनुसार मासिक खर्च', 'Monthly Expenses by Head')}>
        {expenseTable ? (
          <MonthlyExpenseTable data={expenseTable} />
        ) : (
          <div className="empty-state flex items-center justify-center gap-2">
            <span className="spinner" aria-hidden="true" />
            {tr('लोड हुँदैछ…', 'Loading…')}
          </div>
        )}
      </SectionCard>

      <SectionCard title={tr('सवारी साधन अनुसार मासिक पेट्रोल', 'Monthly Petrol by Vehicle')}>
        {petrolTable ? (
          <PetrolTable data={petrolTable} />
        ) : (
          <div className="empty-state flex items-center justify-center gap-2">
            <span className="spinner" aria-hidden="true" />
            {tr('लोड हुँदैछ…', 'Loading…')}
          </div>
        )}
      </SectionCard>

      <SectionCard title={tr('वित्तीय संस्था', 'Financial Institutions')}>
        {institutionReport ? (
          <InstitutionReportTable data={institutionReport} />
        ) : (
          <div className="empty-state flex items-center justify-center gap-2">
            <span className="spinner" aria-hidden="true" />
            {tr('लोड हुँदैछ…', 'Loading…')}
          </div>
        )}
      </SectionCard>

      <SectionCard title={tr('यो महिना वर्ग अनुसार', 'This Month by Category')}>
        {categoryBreakdown ? (
          <CategoryBreakdownSection data={categoryBreakdown} />
        ) : (
          <div className="empty-state flex items-center justify-center gap-2">
            <span className="spinner" aria-hidden="true" />
            {tr('लोड हुँदैछ…', 'Loading…')}
          </div>
        )}
      </SectionCard>

      <SectionCard title={tr('कर्मचारी सारांश', 'Staff Summary')}>
        {staffSummary ? (
          <StaffSummaryTable rows={staffSummary} />
        ) : (
          <div className="empty-state flex items-center justify-center gap-2">
            <span className="spinner" aria-hidden="true" />
            {tr('लोड हुँदैछ…', 'Loading…')}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
