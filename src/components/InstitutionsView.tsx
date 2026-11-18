import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEscapeToClose } from '../hooks/useEscapeToClose';
import type { FinancialInstitution } from '../types';
import { formatDateDisplay, todayISO } from '../lib/dates';
import { BsDatePicker } from './BsDatePicker';
import { useLanguage } from '../lib/i18n';
import { formatPaisaAsRupees, parseRupeeInputToPaisa } from '../lib/money';
import { getInstitutionTotals } from '../lib/aggregation';
import { addTransaction } from '../lib/ledger';
import {
  addInstitution,
  editInstitution,
  getDepositReferenceIds,
  getFinancialWithdrawalCashInType,
  setInstitutionActive,
} from '../lib/institutions';
import {
  useAllInstitutions,
  useCashInTypeLookup,
  useCategoryLookup,
  useExpenseHeadLookup,
  useInstitutionTransactions,
  useStaffLookup,
  useVehicleLookup,
} from '../hooks/useLedger';
import { ExportButtons } from './ExportButtons';
import type { ExportLookups } from '../lib/exportRows';

// Institutions are never deleted — only deactivated — same rule as every
// other master-data entity in this app.

// --- Add / edit institution form ---

interface InstitutionFormProps {
  editing?: FinancialInstitution | null;
  onClose: () => void;
}

function InstitutionFormModal({ editing, onClose }: InstitutionFormProps) {
  const { t: tr } = useLanguage();
  useEscapeToClose(onClose);
  const [name, setName] = useState(editing?.name ?? '');
  const [aliasesInput, setAliasesInput] = useState((editing?.aliases ?? []).join(', '));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError(tr('नाम आवश्यक छ।', 'Name is required.'));
      return;
    }
    const aliases = aliasesInput.split(',').map((a) => a.trim()).filter(Boolean);

    setSaving(true);
    try {
      if (editing) {
        await editInstitution(editing.id!, { name: name.trim(), aliases });
      } else {
        await addInstitution({ name: name.trim(), aliases });
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : tr('केही गडबड भयो।', 'Something went wrong.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal-panel">
        <div className="modal-header">
          <h2 className="text-base font-semibold text-ink-900">
            {editing ? tr('संस्था सम्पादन', 'Edit Institution') : tr('संस्था थप्नुहोस्', 'Add Institution')}
          </h2>
          <button
            onClick={onClose}
            className="text-ink-400 hover:text-ink-700 text-xl leading-none px-2 rounded-md hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
            aria-label={tr('बन्द गर्नुहोस्', 'Close')}
          >
            &times;
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div>
            <label className="field-label">{tr('नाम', 'Name')}</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="field"
              placeholder={tr('जस्तै: NIC Asia Bank', 'e.g. NIC Asia Bank')}
              autoFocus
            />
          </div>

          <div>
            <label className="field-label">
              {tr('उपनाम / अन्य हिज्जे (अल्पविरामले छुट्याइएको)', 'Aliases / other spellings (comma-separated)')}{' '}
              <span className="text-ink-400 font-normal">({tr('वैकल्पिक', 'optional')})</span>
            </label>
            <input
              type="text"
              value={aliasesInput}
              onChange={(e) => setAliasesInput(e.target.value)}
              className="field"
              placeholder={tr('जस्तै: Dhanodaya, DMCL', 'e.g. Dhanodaya, DMCL')}
            />
          </div>

          {error && <p className="text-sm text-brick-600">{error}</p>}

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="btn btn-secondary flex-1"
            >
              {tr('रद्द गर्नुहोस्', 'Cancel')}
            </button>
            <button
              type="submit"
              disabled={saving}
              className="btn btn-teal flex-1"
            >
              {saving ? tr('सुरक्षित हुँदैछ…', 'Saving…') : editing ? tr('परिवर्तन सुरक्षित गर्नुहोस्', 'Save Changes') : tr('थप्नुहोस्', 'Add')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// --- Record deposit / withdrawal forms ---

interface MovementModalProps {
  institution: FinancialInstitution;
  kind: 'deposit' | 'withdrawal';
  onClose: () => void;
}

function MovementModal({ institution, kind, onClose }: MovementModalProps) {
  const { t: tr } = useLanguage();
  useEscapeToClose(onClose);
  const [amountInput, setAmountInput] = useState('');
  const [date, setDate] = useState(todayISO());
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const isDeposit = kind === 'deposit';

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const amountPaisa = parseRupeeInputToPaisa(amountInput);
    if (amountPaisa == null || amountPaisa <= 0) {
      setError(tr('शून्यभन्दा बढी मान्य रकम राख्नुहोस्।', 'Enter a valid amount greater than zero.'));
      return;
    }

    setSaving(true);
    try {
      if (isDeposit) {
        // A deposit is real cash leaving the office into the institution —
        // an ordinary cash_out Transaction under Savings & Financial
        // (Phase 6 Part B).
        const refs = await getDepositReferenceIds();
        if (!refs) {
          throw new Error(tr('जम्मा खर्च शीर्षक अझै सेटअप भएको छैन। एप पुनः खोल्ने प्रयास गर्नुहोस्।', 'Deposit expense head is not set up yet. Try reopening the app.'));
        }
        await addTransaction({
          date,
          direction: 'cash_out',
          amountPaisa,
          categoryId: refs.savingsCategoryId,
          expenseHeadId: refs.depositExpenseHead.id!,
          cashInTypeId: null,
          description: `Deposit - ${institution.name}`,
          staffId: null,
          vehicleId: null,
          institutionId: institution.id!,
          referenceNumber: null,
          notes: notes.trim() || null,
          linkedAdvanceRecoveryPaisa: null,
        });
      } else {
        // A withdrawal is real cash coming back into the office from the
        // institution — an ordinary cash_in Transaction (Phase 6 Part B).
        const withdrawalType = await getFinancialWithdrawalCashInType();
        if (!withdrawalType) {
          throw new Error(tr('वित्तीय झिक्ने प्रकार अझै सेटअप भएको छैन। एप पुनः खोल्ने प्रयास गर्नुहोस्।', 'Financial Withdrawal cash-in type is not set up yet. Try reopening the app.'));
        }
        await addTransaction({
          date,
          direction: 'cash_in',
          amountPaisa,
          categoryId: null,
          expenseHeadId: null,
          cashInTypeId: withdrawalType.id!,
          description: `Withdrawal - ${institution.name}`,
          staffId: null,
          vehicleId: null,
          institutionId: institution.id!,
          referenceNumber: null,
          notes: notes.trim() || null,
          linkedAdvanceRecoveryPaisa: null,
        });
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : tr('केही गडबड भयो।', 'Something went wrong.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal-panel">
        <div className="modal-header">
          <h2 className="text-base font-semibold text-ink-900">
            {isDeposit ? tr('जम्मा रेकर्ड गर्नुहोस्', 'Record Deposit') : tr('झिक्ने रेकर्ड गर्नुहोस्', 'Record Withdrawal')} — {institution.name}
          </h2>
          <button
            onClick={onClose}
            className="text-ink-400 hover:text-ink-700 text-xl leading-none px-2 rounded-md hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
            aria-label={tr('बन्द गर्नुहोस्', 'Close')}
          >
            &times;
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div>
            <label className="field-label">{tr('रकम (रु)', 'Amount (Rs.)')}</label>
            <input
              type="text"
              inputMode="decimal"
              value={amountInput}
              onChange={(e) => setAmountInput(e.target.value)}
              className="field"
              placeholder="0.00"
              autoFocus
            />
          </div>

          <div>
            <label className="field-label">{tr('मिति', 'Date')}</label>
            <BsDatePicker
              value={date}
              onChange={(iso) => setDate(iso)}
              className="[&>select]:flex-1"
            />
          </div>

          <div>
            <label className="field-label">
              {tr('टिप्पणी', 'Notes')} <span className="text-ink-400 font-normal">({tr('वैकल्पिक', 'optional')})</span>
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="field"
            />
          </div>

          {error && <p className="text-sm text-brick-600">{error}</p>}

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="btn btn-secondary flex-1"
            >
              {tr('रद्द गर्नुहोस्', 'Cancel')}
            </button>
            <button
              type="submit"
              disabled={saving}
              className={`flex-1 rounded-lg py-2 font-medium text-white disabled:opacity-60 ${
                isDeposit ? 'bg-brick-600 hover:bg-brick-700' : 'bg-teal-600 hover:bg-teal-700'
              }`}
            >
              {saving ? tr('सुरक्षित हुँदैछ…', 'Saving…') : isDeposit ? tr('जम्मा रेकर्ड गर्नुहोस्', 'Record Deposit') : tr('झिक्ने रेकर्ड गर्नुहोस्', 'Record Withdrawal')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// --- Institution profile ---

function InstitutionProfile({
  institution,
  onBack,
}: {
  institution: FinancialInstitution;
  onBack: () => void;
}) {
  const { t: tr } = useLanguage();
  const [editing, setEditing] = useState(false);
  const [movement, setMovement] = useState<'deposit' | 'withdrawal' | null>(null);
  const [busy, setBusy] = useState(false);

  const transactions = useInstitutionTransactions(institution.id!);
  const totals = useLiveQuery(() => getInstitutionTotals(institution.id!), [institution.id]);
  const categoryLookup = useCategoryLookup();
  const expenseHeadLookup = useExpenseHeadLookup();
  const cashInTypeLookup = useCashInTypeLookup();
  const staffLookup = useStaffLookup();
  const vehicleLookup = useVehicleLookup();

  const exportLookups: ExportLookups = {
    categories: categoryLookup,
    expenseHeads: expenseHeadLookup,
    cashInTypes: cashInTypeLookup,
    staff: staffLookup,
    vehicles: vehicleLookup,
    institutions: new Map([[institution.id!, institution]]),
  };

  async function toggleActive() {
    setBusy(true);
    try {
      await setInstitutionActive(institution.id!, !institution.active);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6 py-5 space-y-4 pb-24">
      <button
        onClick={onBack}
        className="text-sm font-medium text-teal-700 hover:underline flex items-center gap-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
      >
        &#8249; {tr('सबै संस्था', 'All Institutions')}
      </button>

      <div className="card card-pad space-y-2">
        <div className="flex items-start justify-between gap-3">
          <h2
            className={`text-lg font-bold ${institution.active ? 'text-ink-900' : 'text-ink-400'}`}
          >
            {institution.name}
            {!institution.active && (
              <span className="ml-2 text-xs font-medium text-ink-400">({tr('निष्क्रिय', 'inactive')})</span>
            )}
          </h2>
          <button
            onClick={() => setEditing(true)}
            className="text-xs font-medium text-ink-500 hover:text-ink-900 shrink-0 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
          >
            {tr('सम्पादन', 'Edit')}
          </button>
        </div>

        <div className="flex flex-wrap gap-2 pt-1">
          {institution.active && (
            <button
              onClick={() => setMovement('deposit')}
              className="btn btn-brick btn-sm"
            >
              {tr('जम्मा रेकर्ड गर्नुहोस्', 'Record Deposit')}
            </button>
          )}
          {institution.active && (
            <button
              onClick={() => setMovement('withdrawal')}
              className="btn btn-teal btn-sm"
            >
              {tr('झिक्ने रेकर्ड गर्नुहोस्', 'Record Withdrawal')}
            </button>
          )}
          <button
            onClick={toggleActive}
            disabled={busy}
            className={`text-xs font-medium rounded-full px-3 py-1.5 disabled:opacity-60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300 ${
              institution.active
                ? 'bg-line-100 text-ink-700 hover:bg-line-200'
                : 'bg-teal-50 text-teal-700 hover:bg-teal-100'
            }`}
          >
            {institution.active ? tr('निष्क्रिय गर्नुहोस्', 'Deactivate') : tr('सक्रिय गर्नुहोस्', 'Activate')}
          </button>
        </div>
      </div>

      <div className="card card-pad">
        <p className="panel-label mb-2">{tr('खुद चलन', 'Net Movement')}</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 gap-y-3">
          <div>
            <p className="text-xs text-ink-400">{tr('यो महिना', 'This Month')}</p>
            <p className="text-sm font-semibold text-ink-900">
              {formatPaisaAsRupees(totals?.net.currentMonthPaisa ?? 0)}
            </p>
          </div>
          <div>
            <p className="text-xs text-ink-400">{tr('गत महिना', 'Last Month')}</p>
            <p className="text-sm font-semibold text-ink-900">
              {formatPaisaAsRupees(totals?.net.previousMonthPaisa ?? 0)}
            </p>
          </div>
          <div>
            <p className="text-xs text-ink-400">{tr('चालु वर्षसम्म', 'YTD')}</p>
            <p className="text-sm font-semibold text-ink-900">
              {formatPaisaAsRupees(totals?.net.yearToDatePaisa ?? 0)}
            </p>
          </div>
          <div>
            <p className="text-xs text-ink-400">{tr('जम्मा', 'Lifetime')}</p>
            <p className="text-sm font-semibold text-ink-900">
              {formatPaisaAsRupees(totals?.net.lifetimePaisa ?? 0)}
            </p>
          </div>
        </div>
      </div>

      <div className="card card-pad">
        <p className="panel-label mb-2">{tr('जम्मा', 'Deposits')}</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 gap-y-3">
          <div>
            <p className="text-xs text-ink-400">{tr('यो महिना', 'This Month')}</p>
            <p className="text-sm font-semibold text-brick-700">
              {formatPaisaAsRupees(totals?.deposits.currentMonthPaisa ?? 0)}
            </p>
          </div>
          <div>
            <p className="text-xs text-ink-400">{tr('गत महिना', 'Last Month')}</p>
            <p className="text-sm font-semibold text-brick-700">
              {formatPaisaAsRupees(totals?.deposits.previousMonthPaisa ?? 0)}
            </p>
          </div>
          <div>
            <p className="text-xs text-ink-400">{tr('चालु वर्षसम्म', 'YTD')}</p>
            <p className="text-sm font-semibold text-brick-700">
              {formatPaisaAsRupees(totals?.deposits.yearToDatePaisa ?? 0)}
            </p>
          </div>
          <div>
            <p className="text-xs text-ink-400">{tr('जम्मा', 'Lifetime')}</p>
            <p className="text-sm font-semibold text-brick-700">
              {formatPaisaAsRupees(totals?.deposits.lifetimePaisa ?? 0)}
            </p>
          </div>
        </div>
      </div>

      <div className="card card-pad">
        <p className="panel-label mb-2">{tr('झिक्ने', 'Withdrawals')}</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 gap-y-3">
          <div>
            <p className="text-xs text-ink-400">{tr('यो महिना', 'This Month')}</p>
            <p className="text-sm font-semibold text-teal-700">
              {formatPaisaAsRupees(totals?.withdrawals.currentMonthPaisa ?? 0)}
            </p>
          </div>
          <div>
            <p className="text-xs text-ink-400">{tr('गत महिना', 'Last Month')}</p>
            <p className="text-sm font-semibold text-teal-700">
              {formatPaisaAsRupees(totals?.withdrawals.previousMonthPaisa ?? 0)}
            </p>
          </div>
          <div>
            <p className="text-xs text-ink-400">{tr('चालु वर्षसम्म', 'YTD')}</p>
            <p className="text-sm font-semibold text-teal-700">
              {formatPaisaAsRupees(totals?.withdrawals.yearToDatePaisa ?? 0)}
            </p>
          </div>
          <div>
            <p className="text-xs text-ink-400">{tr('जम्मा', 'Lifetime')}</p>
            <p className="text-sm font-semibold text-teal-700">
              {formatPaisaAsRupees(totals?.withdrawals.lifetimePaisa ?? 0)}
            </p>
          </div>
        </div>
      </div>

      {transactions && transactions.length > 0 && (
        <ExportButtons
          transactions={transactions}
          lookups={exportLookups}
          filenamePrefix={`institution-${institution.name.toLowerCase().replace(/\s+/g, '-')}`}
        />
      )}

      <div className="card divide-y divide-line-100">
        {!transactions ? (
          <div className="empty-state flex items-center justify-center gap-2">
            <span className="spinner" aria-hidden="true" />
            {tr('लोड हुँदैछ…', 'Loading…')}
          </div>
        ) : transactions.length === 0 ? (
          <p className="empty-state">{tr('अहिलेसम्म कुनै जम्मा वा झिक्ने छैन।', 'No deposits or withdrawals yet.')}</p>
        ) : (
          transactions.map((t) => {
            const isDepositTxn = t.direction === 'cash_out';
            return (
              <div key={t.id} className="p-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink-900 truncate">
                    <span
                      className={`inline-block text-[10px] font-semibold uppercase tracking-wide rounded px-1.5 py-0.5 mr-1.5 ${
                        isDepositTxn ? 'bg-brick-50 text-brick-700' : 'bg-teal-50 text-teal-700'
                      }`}
                    >
                      {isDepositTxn ? tr('जम्मा', 'Deposit') : tr('झिक्ने', 'Withdrawal')}
                    </span>
                    {t.description}
                  </p>
                  <p className="text-xs text-ink-500">{formatDateDisplay(t.date)}</p>
                </div>
                <span
                  className={`text-sm font-semibold shrink-0 ${
                    isDepositTxn ? 'text-brick-700' : 'text-teal-700'
                  }`}
                >
                  {isDepositTxn ? '−' : '+'} {formatPaisaAsRupees(t.amountPaisa)}
                </span>
              </div>
            );
          })
        )}
      </div>

      {editing && <InstitutionFormModal editing={institution} onClose={() => setEditing(false)} />}
      {movement && (
        <MovementModal institution={institution} kind={movement} onClose={() => setMovement(null)} />
      )}
    </div>
  );
}

// --- Institutions list ---

export function InstitutionsView() {
  const { t: tr } = useLanguage();
  const institutions = useAllInstitutions();
  const [selected, setSelected] = useState<FinancialInstitution | null>(null);
  const [adding, setAdding] = useState(false);

  // Keep the selected institution row in sync with live query updates
  // instead of a stale snapshot — same reasoning as StaffView/VehiclesView.
  const liveSelected = selected
    ? (institutions ?? []).find((i) => i.id === selected.id) ?? selected
    : null;

  if (liveSelected) {
    return <InstitutionProfile institution={liveSelected} onBack={() => setSelected(null)} />;
  }

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6 py-5 space-y-4 pb-24">
      <div className="flex items-center justify-between">
        <h1 className="text-page-title">{tr('बचत / वित्त', 'Savings / Finance')}</h1>
        <button
          onClick={() => setAdding(true)}
          className="btn btn-teal btn-sm"
        >
          + {tr('संस्था थप्नुहोस्', 'Add Institution')}
        </button>
      </div>

      <div className="card divide-y divide-line-100">
        {!institutions ? (
          <div className="empty-state flex items-center justify-center gap-2">
            <span className="spinner" aria-hidden="true" />
            {tr('लोड हुँदैछ…', 'Loading…')}
          </div>
        ) : institutions.length === 0 ? (
          <p className="empty-state">{tr('अहिलेसम्म कुनै संस्था छैन।', 'No institutions yet.')}</p>
        ) : (
          institutions.map((i) => (
            <button
              key={i.id}
              onClick={() => setSelected(i)}
              className="w-full text-left px-4 py-3 hover:bg-surface-muted transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-300"
            >
              <span className={`text-sm ${i.active ? 'text-ink-900' : 'text-ink-400 line-through'}`}>
                {i.name}
              </span>
            </button>
          ))
        )}
      </div>

      {adding && <InstitutionFormModal onClose={() => setAdding(false)} />}
    </div>
  );
}
