import { useState } from 'react';
import type {
  CashInType,
  Category,
  ExpenseHead,
  FinancialInstitution,
  Staff,
  Transaction,
  Vehicle,
} from '../types';
import { formatPaisaAsRupees } from '../lib/money';
import { formatTimeDisplay } from '../lib/dates';
import { softDeleteTransaction } from '../lib/ledger';
import { useLanguage } from '../lib/i18n';

interface Props {
  transactions: Transaction[];
  categoryLookup: Map<string, Category>;
  expenseHeadLookup: Map<string, ExpenseHead>;
  cashInTypeLookup: Map<string, CashInType>;
  staffLookup?: Map<string, Staff>;
  vehicleLookup?: Map<string, Vehicle>;
  institutionLookup?: Map<string, FinancialInstitution>;
  onEdit: (t: Transaction) => void;
}

export function TransactionList({
  transactions,
  categoryLookup,
  expenseHeadLookup,
  cashInTypeLookup,
  staffLookup,
  vehicleLookup,
  institutionLookup,
  onEdit,
}: Props) {
  const { t: tr } = useLanguage();
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function handleDelete(id: string) {
    setDeletingId(id);
    try {
      await softDeleteTransaction(id);
    } finally {
      setDeletingId(null);
      setConfirmingDeleteId(null);
    }
  }

  if (transactions.length === 0) {
    return <p className="empty-state">{tr('अहिलेसम्म कुनै प्रविष्टि छैन।', 'No entries yet.')}</p>;
  }

  return (
    <ul className="divide-y divide-line-100">
      {transactions.map((t) => {
        // Phase 12d Part B field priority, always visible (both widths):
        // time, description, amount + direction — the minimum needed to
        // recognize an entry at a glance.
        //
        // "What kind of entry" — category/expense head (cash_out) or cash-in
        // type — stays on its own compact line, visible at every width,
        // since it's usually the next thing the owner looks for.
        const primaryTag =
          t.direction === 'cash_in'
            ? (t.cashInTypeId != null && cashInTypeLookup.get(t.cashInTypeId)?.name) || ''
            : [
                t.categoryId != null ? categoryLookup.get(t.categoryId)?.name : null,
                t.expenseHeadId != null ? expenseHeadLookup.get(t.expenseHeadId)?.name : null,
              ]
                .filter(Boolean)
                .join(' · ');

        // "Who/what else this relates to" — staff, vehicle, institution.
        // Lower priority: shown as a compact line on wider screens only,
        // so a narrow phone list isn't cluttered with three extra names on
        // every single row.
        const relatedTag = [
          t.staffId != null ? staffLookup?.get(t.staffId)?.name : null,
          t.vehicleId != null ? vehicleLookup?.get(t.vehicleId)?.name : null,
          t.institutionId != null ? institutionLookup?.get(t.institutionId)?.name : null,
        ]
          .filter(Boolean)
          .join(' · ');

        return (
          <li key={t.id} className="group py-2.5 -mx-1 px-1 flex flex-col gap-1 rounded-lg hover:bg-surface-muted transition-colors">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 flex items-baseline gap-2">
                <span className="text-[11px] text-ink-400 figures shrink-0">
                  {formatTimeDisplay(t.createdAt)}
                </span>
                <p className="text-sm font-medium text-ink-900 truncate">{t.description}</p>
              </div>
              <span
                className={`text-sm font-semibold shrink-0 figures ${
                  t.direction === 'cash_in' ? 'text-teal-700' : 'text-brick-700'
                }`}
              >
                {t.direction === 'cash_in' ? '+' : '−'} {formatPaisaAsRupees(t.amountPaisa)}
              </span>
            </div>

            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                {primaryTag && <p className="text-xs text-ink-500 truncate">{primaryTag}</p>}
                {relatedTag && (
                  <p className="hidden sm:block text-xs text-ink-400 truncate">{relatedTag}</p>
                )}
                {t.referenceNumber && (
                  <p className="text-xs text-ink-400 truncate">{tr('सन्दर्भ', 'Ref')}: {t.referenceNumber}</p>
                )}
              </div>

              <div className="flex items-center gap-1 shrink-0">
                {confirmingDeleteId === t.id ? (
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => handleDelete(t.id)}
                      disabled={deletingId === t.id}
                      className="btn btn-brick btn-sm"
                    >
                      {deletingId === t.id ? '…' : tr('पक्का गर्नुहोस्', 'Confirm')}
                    </button>
                    <button
                      onClick={() => setConfirmingDeleteId(null)}
                      className="text-xs font-medium text-ink-500 px-2 py-1.5 hover:underline rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
                    >
                      {tr('रद्द गर्नुहोस्', 'Cancel')}
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => onEdit(t)}
                      className="text-xs font-medium text-ink-500 hover:text-ink-900 px-1.5 py-1.5 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
                      aria-label={tr('सम्पादन', 'Edit')}
                    >
                      {tr('सम्पादन', 'Edit')}
                    </button>
                    <button
                      onClick={() => setConfirmingDeleteId(t.id)}
                      className="text-xs font-medium text-ink-400 hover:text-brick-600 px-1.5 py-1.5 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
                      aria-label={tr('मेटाउनुहोस्', 'Delete')}
                    >
                      {tr('मेटाउनुहोस्', 'Delete')}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
