import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { Category, ExpenseHead } from '../types';
import { db } from '../db/schema';
import { addCategory, addExpenseHead } from '../lib/referenceData';
import { formatPaisaAsRupees } from '../lib/money';
import { formatDateDisplay } from '../lib/dates';
import { getExpenseHeadTotals } from '../lib/aggregation';
import {
  useActiveExpenseHeadsByCategory,
  useCashOutCategories,
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

// One small "type a name, press Enter or Add" form, used for new categories and
// new expense heads right on this page. Enter submits it (it is a normal form).
function InlineAdd({
  placeholder,
  buttonLabel,
  onAdd,
}: {
  placeholder: string;
  buttonLabel: string;
  onAdd: (name: string) => Promise<void>;
}) {
  const { t: tr } = useLanguage();
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const name = value.trim();
    if (!name || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onAdd(name);
      setValue('');
    } catch (err) {
      setError(err instanceof Error ? err.message : tr('थप्न सकिएन।', 'Could not add.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap gap-2 pt-2 items-center">
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="flex-1 min-w-[8rem] rounded-lg border border-line-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
      />
      <button type="submit" disabled={saving || !value.trim()} className="btn btn-teal btn-sm">
        {buttonLabel}
      </button>
      {error && <p className="text-xs text-brick-600 w-full">{error}</p>}
    </form>
  );
}

export function DiariesView() {
  const { t: tr } = useLanguage();
  const grouped = useActiveExpenseHeadsByCategory();
  const activeCategories = useCashOutCategories();
  const [selectedHead, setSelectedHead] = useState<ExpenseHead | null>(null);

  if (selectedHead) {
    return <ExpenseHeadDiary head={selectedHead} onBack={() => setSelectedHead(null)} />;
  }

  // Every active category is listed - including ones with no expense heads yet -
  // so a new category can be given heads right here. (Categories that were
  // switched off but still have active heads keep showing, as before.)
  const sections = new Map<string, { category: Category; heads: ExpenseHead[] }>();
  for (const g of grouped ?? []) sections.set(g.category.id!, g);
  for (const c of activeCategories ?? []) {
    if (!sections.has(c.id!)) sections.set(c.id!, { category: c, heads: [] });
  }
  const orderedSections = Array.from(sections.values()).sort((a, b) =>
    a.category.name.localeCompare(b.category.name),
  );
  const loaded = grouped !== undefined && activeCategories !== undefined;

  async function handleAddCategory(name: string) {
    const existing = await db.categories.toArray();
    if (existing.some((c) => c.name.trim().toLowerCase() === name.toLowerCase())) {
      throw new Error(
        tr(
          'यो नामको वर्ग पहिल्यै छ (सेटिङमा बन्द गरिएको हुन सक्छ)।',
          'A category with this name already exists (it may be switched off in Settings).',
        ),
      );
    }
    await addCategory(name);
  }

  async function handleAddHead(categoryId: string, name: string) {
    const existing = await db.expenseHeads.where('categoryId').equals(categoryId).toArray();
    if (existing.some((h) => h.name.trim().toLowerCase() === name.toLowerCase())) {
      throw new Error(
        tr(
          'यो वर्गमा यो नामको खर्च शीर्षक पहिल्यै छ (सेटिङमा बन्द गरिएको हुन सक्छ)।',
          'This category already has an expense head with this name (it may be switched off in Settings).',
        ),
      );
    }
    await addExpenseHead(categoryId, name);
  }

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6 py-5 space-y-4 pb-24">
      <h1 className="text-page-title">{tr('खर्च डायरी', 'Expense Diaries')}</h1>

      <section className="card card-pad">
        <h2 className="panel-title mb-1">{tr('नयाँ वर्ग थप्नुहोस्', 'Add a new category')}</h2>
        <InlineAdd
          placeholder={tr('नयाँ वर्गको नाम', 'New category name')}
          buttonLabel={tr('वर्ग थप्नुहोस्', 'Add category')}
          onAdd={handleAddCategory}
        />
      </section>

      {!loaded ? (
        <div className="empty-state flex items-center justify-center gap-2">
          <span className="spinner" aria-hidden="true" />
          {tr('लोड हुँदैछ…', 'Loading…')}
        </div>
      ) : orderedSections.length === 0 ? (
        <p className="empty-state">
          {tr('अहिलेसम्म कुनै सक्रिय वर्ग छैन। माथि थप्नुहोस्।', 'No active categories yet. Add one above.')}
        </p>
      ) : (
        orderedSections.map(({ category, heads }) => (
          <section key={category.id} className="card card-pad">
            <h2 className="panel-title mb-1">{category.name}</h2>
            {heads.length === 0 ? (
              <p className="text-sm text-ink-500 py-1.5">
                {tr('अहिलेसम्म कुनै खर्च शीर्षक छैन।', 'No expense heads yet.')}
              </p>
            ) : (
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
            )}
            <InlineAdd
              placeholder={tr('नयाँ खर्च शीर्षकको नाम', 'New expense head name')}
              buttonLabel={tr('शीर्षक थप्नुहोस्', 'Add head')}
              onAdd={(name) => handleAddHead(category.id!, name)}
            />
          </section>
        ))
      )}
    </div>
  );
}
