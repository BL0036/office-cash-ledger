import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { AlertTriangle } from 'lucide-react';
import type { Staff, Transaction, Vehicle } from '../types';
import { formatDateDisplay, todayISO } from '../lib/dates';
import { BsDatePicker } from './BsDatePicker';
import { useLanguage } from '../lib/i18n';
import { useEscapeToClose } from '../hooks/useEscapeToClose';
import { formatPaisaAsRupees, parseRupeeInputToPaisa } from '../lib/money';
import { getStaffTotals } from '../lib/aggregation';
import { addTransaction } from '../lib/ledger';
import {
  addStaff,
  checkAdvanceLimit,
  checkRecoveryAmount,
  editStaff,
  getAdvanceReferenceIds,
  getOutstandingAdvance,
  getSalaryReferenceIds,
  setStaffActive,
  type OutstandingAdvance,
} from '../lib/staff';
import {
  assignVehicleToStaff,
  getVehiclesForStaff,
  unassignVehicleFromStaff,
} from '../lib/staffVehicles';
import { useActiveVehicles, useAllStaff, useStaffSalaryTransactions, useVehiclesForStaff } from '../hooks/useLedger';

// Phase 4: no company/office-name setting exists anywhere in this app
// (checked SettingsView.tsx and every other file — grepped for
// "office name"/"company"/"business name" across src/, found nothing) —
// per EXACT SCOPE's instruction to check before inventing a new setting,
// this deliberately does NOT add a new persistent settings field for it.
// The static app name (index.html's <title>, "Office Daily Cash Ledger")
// is used as a fallback heading on both print views instead. See
// CHANGELOG for this phase for the full note.
const APP_NAME = 'Office Daily Cash Ledger';

// --- Add / edit staff form ---

interface StaffFormProps {
  editing?: Staff | null;
  onClose: () => void;
}

function StaffFormModal({ editing, onClose }: StaffFormProps) {
  const { t: tr } = useLanguage();
  // v1.0 accessibility polish: Escape closes the dialog, matching every
  // other modal in the app and the Fast Entry bar's own Esc behavior.
  useEscapeToClose(onClose);
  const vehicles = useActiveVehicles();
  const [name, setName] = useState(editing?.name ?? '');
  const [salaryInput, setSalaryInput] = useState(
    editing ? String(editing.monthlySalaryPaisa / 100) : '',
  );
  const [advanceLimitInput, setAdvanceLimitInput] = useState(
    editing?.advanceLimitPaisa != null ? String(editing.advanceLimitPaisa / 100) : '',
  );
  const [joiningDate, setJoiningDate] = useState(editing?.joiningDate ?? '');
  // Phase 2: replaces the old single assignedVehicleId picker with a
  // multi-select of vehicle ids, backed by the StaffVehicle join table
  // (not Staff.assignedVehicleId — see types.ts's DEPRECATED note). In
  // edit mode, the initial selection is loaded (async) from the current
  // assignments below, since Staff itself no longer carries this data.
  const [vehicleIds, setVehicleIds] = useState<string[]>([]);
  const [notes, setNotes] = useState(editing?.notes ?? '');
  const [aliasesInput, setAliasesInput] = useState((editing?.aliases ?? []).join(', '));
  // Phase 4: small practical staff-profile fields — not an HR module,
  // exactly these four, all optional.
  const [employeeId, setEmployeeId] = useState(editing?.employeeId ?? '');
  const [position, setPosition] = useState(editing?.position ?? '');
  const [contactNumber, setContactNumber] = useState(editing?.contactNumber ?? '');
  const [photoDataUrl, setPhotoDataUrl] = useState<string | null>(editing?.photoDataUrl ?? null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function handlePhotoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') setPhotoDataUrl(reader.result);
    };
    reader.readAsDataURL(file);
  }

  // Load this staff member's current vehicle assignments (edit mode only)
  // so the multi-select starts pre-checked with what's actually assigned.
  useEffect(() => {
    if (!editing) return;
    let cancelled = false;
    getVehiclesForStaff(editing.id!).then((assigned) => {
      if (!cancelled) setVehicleIds(assigned.map((v) => v.id!));
    });
    return () => {
      cancelled = true;
    };
  }, [editing]);

  function toggleVehicle(vehicleId: string) {
    setVehicleIds((ids) =>
      ids.includes(vehicleId) ? ids.filter((id) => id !== vehicleId) : [...ids, vehicleId],
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError(tr('नाम आवश्यक छ।', 'Name is required.'));
      return;
    }
    const aliases = aliasesInput.split(',').map((a) => a.trim()).filter(Boolean);
    const monthlySalaryPaisa = parseRupeeInputToPaisa(salaryInput);
    if (monthlySalaryPaisa == null || monthlySalaryPaisa < 0) {
      setError(tr('मान्य मासिक तलब राख्नुहोस्।', 'Enter a valid monthly salary.'));
      return;
    }
    let advanceLimitPaisa: number | null = null;
    if (advanceLimitInput.trim() !== '') {
      advanceLimitPaisa = parseRupeeInputToPaisa(advanceLimitInput);
      if (advanceLimitPaisa == null || advanceLimitPaisa < 0) {
        setError(tr('मान्य पेश्की सीमा राख्नुहोस्, वा मासिक तलब नै प्रयोग गर्न खाली छोड्नुहोस्।', 'Enter a valid advance limit, or leave it blank to default to the monthly salary.'));
        return;
      }
    }

    setSaving(true);
    try {
      if (editing) {
        await editStaff(editing.id!, {
          name: name.trim(),
          monthlySalaryPaisa,
          advanceLimitPaisa,
          joiningDate: joiningDate || null,
          notes: notes.trim() || null,
          aliases,
          employeeId: employeeId.trim() || null,
          position: position.trim() || null,
          contactNumber: contactNumber.trim() || null,
          photoDataUrl,
        });
        // Reconcile vehicle assignments against what was originally
        // loaded: assign newly-checked vehicles, unassign newly-unchecked
        // ones. Untouched pairs are left alone (assignVehicleToStaff is a
        // no-op on an already-existing pair anyway).
        const originallyAssigned = await getVehiclesForStaff(editing.id!);
        const originalIds = new Set(originallyAssigned.map((v) => v.id!));
        const selectedIds = new Set(vehicleIds);
        for (const vehicleId of selectedIds) {
          if (!originalIds.has(vehicleId)) {
            await assignVehicleToStaff(editing.id!, vehicleId);
          }
        }
        for (const vehicleId of originalIds) {
          if (!selectedIds.has(vehicleId)) {
            await unassignVehicleFromStaff(editing.id!, vehicleId);
          }
        }
      } else {
        await addStaff({
          name: name.trim(),
          monthlySalaryPaisa,
          advanceLimitPaisa,
          joiningDate: joiningDate || null,
          vehicleIds,
          notes: notes.trim() || null,
          aliases,
          employeeId: employeeId.trim() || null,
          position: position.trim() || null,
          contactNumber: contactNumber.trim() || null,
          photoDataUrl,
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
            {editing ? tr('कर्मचारी सम्पादन', 'Edit Staff') : tr('कर्मचारी थप्नुहोस्', 'Add Staff')}
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
              autoFocus
            />
          </div>

          <div>
            <label className="field-label">
              {tr('मासिक तलब (रु)', 'Monthly Salary (Rs.)')}
            </label>
            <input
              type="text"
              inputMode="decimal"
              value={salaryInput}
              onChange={(e) => setSalaryInput(e.target.value)}
              className="field"
              placeholder="0.00"
            />
          </div>

          <div>
            <label className="field-label">
              {tr('पेश्की सीमा (रु)', 'Advance Limit (Rs.)')} <span className="text-ink-400 font-normal">({tr('वैकल्पिक', 'optional')})</span>
            </label>
            <input
              type="text"
              inputMode="decimal"
              value={advanceLimitInput}
              onChange={(e) => setAdvanceLimitInput(e.target.value)}
              className="field"
              placeholder={tr('मासिक तलब बराबर हुन्छ', 'Defaults to monthly salary')}
            />
          </div>

          <div>
            <label className="field-label">
              {tr('भर्ना मिति', 'Joining Date')} <span className="text-ink-400 font-normal">({tr('वैकल्पिक', 'optional')})</span>
            </label>
            <BsDatePicker
              value={joiningDate || todayISO()}
              onChange={(iso) => setJoiningDate(iso)}
              className="[&>select]:flex-1"
            />
          </div>

          <div>
            <label className="field-label">
              {tr('तोकिएका सवारी साधनहरू', 'Assigned Vehicles')} <span className="text-ink-400 font-normal">({tr('वैकल्पिक', 'optional')})</span>
            </label>
            <div className="field h-auto max-h-40 overflow-y-auto space-y-1.5 py-2">
              {(vehicles ?? []).length === 0 ? (
                <p className="text-xs text-ink-400">{tr('कुनै सवारी साधन छैन।', 'No vehicles yet.')}</p>
              ) : (
                (vehicles ?? []).map((v) => (
                  <label key={v.id} className="flex items-center gap-2 text-sm text-ink-900">
                    <input
                      type="checkbox"
                      className="checkbox"
                      checked={vehicleIds.includes(v.id!)}
                      onChange={() => toggleVehicle(v.id!)}
                    />
                    {v.name}
                  </label>
                ))
              )}
            </div>
            <p className="mt-1 text-xs text-ink-400">
              {tr(
                'ठ्याक्कै एउटा सवारी साधन तोकिएको भए त्यो नगद खर्च प्रविष्टिमा सुझावको रूपमा पहिले नै भरिन्छ; बढी भए प्रविष्टिको बेला छनौट गर्नुपर्छ।',
                'When exactly one vehicle is assigned, it pre-fills as a suggestion on Cash Out entries; with more than one, it must be picked at entry time.',
              )}
            </p>
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
              placeholder={tr('जस्तै: Sijan Rai, Sij', 'e.g. Sijan Rai, Sij')}
            />
          </div>

          <div>
            <label className="field-label">
              {tr('कर्मचारी परिचयपत्र नं.', 'Employee / Staff ID')}{' '}
              <span className="text-ink-400 font-normal">({tr('वैकल्पिक', 'optional')})</span>
            </label>
            <input
              type="text"
              value={employeeId}
              onChange={(e) => setEmployeeId(e.target.value)}
              className="field"
            />
          </div>

          <div>
            <label className="field-label">
              {tr('पद', 'Position / Designation')}{' '}
              <span className="text-ink-400 font-normal">({tr('वैकल्पिक', 'optional')})</span>
            </label>
            <input
              type="text"
              value={position}
              onChange={(e) => setPosition(e.target.value)}
              className="field"
            />
          </div>

          <div>
            <label className="field-label">
              {tr('सम्पर्क नम्बर', 'Contact Number')}{' '}
              <span className="text-ink-400 font-normal">({tr('वैकल्पिक', 'optional')})</span>
            </label>
            <input
              type="text"
              value={contactNumber}
              onChange={(e) => setContactNumber(e.target.value)}
              className="field"
            />
          </div>

          <div>
            <label className="field-label">
              {tr('फोटो', 'Photo')} <span className="text-ink-400 font-normal">({tr('वैकल्पिक', 'optional')})</span>
            </label>
            <div className="flex items-center gap-3">
              {photoDataUrl && (
                <img
                  src={photoDataUrl}
                  alt=""
                  className="h-12 w-12 rounded-full object-cover border border-line-200"
                />
              )}
              <input type="file" accept="image/*" onChange={handlePhotoChange} className="field" />
              {photoDataUrl && (
                <button
                  type="button"
                  onClick={() => setPhotoDataUrl(null)}
                  className="text-xs font-medium text-brick-600 hover:underline shrink-0"
                >
                  {tr('हटाउनुहोस्', 'Remove')}
                </button>
              )}
            </div>
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

// --- Pay Salary form ---

interface PaySalaryModalProps {
  staff: Staff;
  onClose: () => void;
}

function PaySalaryModal({ staff, onClose }: PaySalaryModalProps) {
  const { t: tr } = useLanguage();
  useEscapeToClose(onClose);
  const [amountInput, setAmountInput] = useState(String(staff.monthlySalaryPaisa / 100));
  const [recoveryInput, setRecoveryInput] = useState('');
  const [date, setDate] = useState(todayISO());
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const grossAmountPaisa = parseRupeeInputToPaisa(amountInput);
    if (grossAmountPaisa == null || grossAmountPaisa <= 0) {
      setError(tr('शून्यभन्दा बढी मान्य रकम राख्नुहोस्।', 'Enter a valid amount greater than zero.'));
      return;
    }

    let recoveryAmountPaisa = 0;
    if (recoveryInput.trim() !== '') {
      const parsed = parseRupeeInputToPaisa(recoveryInput);
      if (parsed == null || parsed < 0) {
        setError(tr('मान्य उठाउने रकम राख्नुहोस्।', 'Enter a valid recovery amount.'));
        return;
      }
      recoveryAmountPaisa = parsed;
    }

    setSaving(true);
    try {
      const refs = await getSalaryReferenceIds();
      if (!refs) {
        throw new Error(tr('तलब खर्च शीर्षक अझै सेटअप भएको छैन। एप पुनः खोल्ने प्रयास गर्नुहोस्।', 'Salary expense head is not set up yet. Try reopening the app.'));
      }
      if (recoveryAmountPaisa > 0) {
        const recoveryCheck = await checkRecoveryAmount(staff.id!, recoveryAmountPaisa, grossAmountPaisa);
        if (!recoveryCheck.allowed) {
          setError(recoveryCheck.error ?? tr('उठाउने रकम मान्य छैन।', 'Recovery amount is not valid.'));
          setSaving(false);
          return;
        }
      }
      await addTransaction({
        date,
        direction: 'cash_out',
        amountPaisa: grossAmountPaisa - recoveryAmountPaisa,
        categoryId: refs.staffCategory.id!,
        expenseHeadId: refs.salaryExpenseHead.id!,
        cashInTypeId: null,
        description: `Salary - ${staff.name}`,
        staffId: staff.id!,
        vehicleId: null,
        institutionId: null,
        referenceNumber: null,
        notes: notes.trim() || null,
        linkedAdvanceRecoveryPaisa: recoveryAmountPaisa > 0 ? recoveryAmountPaisa : null,
      });
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
          <h2 className="text-base font-semibold text-ink-900">{tr('तलब भुक्तानी', 'Pay Salary')} — {staff.name}</h2>
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
            <p className="mt-1 text-xs text-ink-400">
              {tr(
                'मासिक तलब बराबर हुन्छ — आंशिक भुक्तानीको लागि परिवर्तन गर्नुहोस्।',
                'Defaults to the monthly salary — edit for a partial payment.',
              )}
            </p>
          </div>

          <div>
            <label className="field-label">
              {tr('उठाउने रकम (रु)', 'Recovery Amount (Rs.)')} <span className="text-ink-400 font-normal">({tr('वैकल्पिक', 'optional')})</span>
            </label>
            <input
              type="text"
              inputMode="decimal"
              value={recoveryInput}
              onChange={(e) => setRecoveryInput(e.target.value)}
              className="field"
              placeholder="0.00"
            />
            <p className="mt-1 text-xs text-ink-400">
              {tr(
                'माथिको रकमबाट घटाइन्छ र बाँकी पेश्कीमा लागू हुन्छ। खुद नगद भुक्तानी = रकम − उठाउने रकम।',
                'Deducted from the amount above and applied against outstanding advance. Net cash paid = Amount − Recovery.',
              )}
            </p>
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
              className="btn btn-brick flex-1"
            >
              {saving ? tr('सुरक्षित हुँदैछ…', 'Saving…') : tr('तलब भुक्तानी गर्नुहोस्', 'Pay Salary')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// --- Give Advance form ---

interface GiveAdvanceModalProps {
  staff: Staff;
  onClose: () => void;
}

function GiveAdvanceModal({ staff, onClose }: GiveAdvanceModalProps) {
  const { t: tr } = useLanguage();
  useEscapeToClose(onClose);
  const [amountInput, setAmountInput] = useState('');
  const [date, setDate] = useState(todayISO());
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Phase 3 Part A: separate from `error` on purpose — an exceeded limit
  // is no longer a reason to reject the save (see checkAdvanceLimit's own
  // doc comment in lib/staff.ts), so it's never shown in the same
  // blocking-red styling as a genuine validation error. Set on a
  // successful over-limit save and left up (fields cleared instead of the
  // whole modal closing) so the two numbers stay visible until the owner
  // dismisses the modal themselves — see the EXACT SCOPE requirement that
  // this must never be silent or easy to miss.
  const [warning, setWarning] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setWarning(null);

    const amountPaisa = parseRupeeInputToPaisa(amountInput);
    if (amountPaisa == null || amountPaisa <= 0) {
      setError(tr('शून्यभन्दा बढी मान्य रकम राख्नुहोस्।', 'Enter a valid amount greater than zero.'));
      return;
    }

    setSaving(true);
    try {
      const refs = await getAdvanceReferenceIds();
      if (!refs) {
        throw new Error(tr('पेश्की खर्च शीर्षक अझै सेटअप भएको छैन। एप पुनः खोल्ने प्रयास गर्नुहोस्।', 'Advance expense head is not set up yet. Try reopening the app.'));
      }

      // Phase 3 Part A: checkAdvanceLimit() is advisory only now — its
      // result never blocks this save, it only decides whether a warning
      // is shown afterward. The save below always proceeds.
      const limitCheck = await checkAdvanceLimit(staff.id!, amountPaisa);

      await addTransaction({
        date,
        direction: 'cash_out',
        amountPaisa,
        categoryId: refs.staffCategory.id!,
        expenseHeadId: refs.advanceExpenseHead.id!,
        cashInTypeId: null,
        description: `Advance - ${staff.name}`,
        staffId: staff.id!,
        vehicleId: null,
        institutionId: null,
        referenceNumber: null,
        notes: notes.trim() || null,
        linkedAdvanceRecoveryPaisa: null,
      });

      if (!limitCheck.withinLimit) {
        const resultingOutstandingPaisa = limitCheck.currentOutstandingPaisa + amountPaisa;
        setWarning(
          tr(
            `यो सामान्य पेश्की सीमा ${formatPaisaAsRupees(limitCheck.limitPaisa)} भन्दा बढी हो। यो पेश्की पछि बाँकी रकम ${formatPaisaAsRupees(resultingOutstandingPaisa)} हुनेछ।`,
            `This exceeds the normal advance limit of ${formatPaisaAsRupees(limitCheck.limitPaisa)}. Outstanding after this advance will be ${formatPaisaAsRupees(resultingOutstandingPaisa)}.`,
          ),
        );
        // Saved successfully despite the warning — clear the fields so the
        // modal can't be accidentally re-submitted with the same amount,
        // but keep it open (see `warning` above) so the numbers stay visible.
        setAmountInput('');
        setNotes('');
      } else {
        onClose();
      }
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
          <h2 className="text-base font-semibold text-ink-900">{tr('पेश्की दिनुहोस्', 'Give Advance')} — {staff.name}</h2>
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

          {warning && (
            <div className="banner banner-warning items-start">
              <AlertTriangle size={16} className="text-amber-600 shrink-0 mt-0.5" />
              <p className="text-sm text-amber-700">{warning}</p>
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="btn btn-secondary flex-1"
            >
              {warning ? tr('बन्द गर्नुहोस्', 'Close') : tr('रद्द गर्नुहोस्', 'Cancel')}
            </button>
            <button
              type="submit"
              disabled={saving}
              className="btn btn-amber flex-1"
            >
              {saving ? tr('सुरक्षित हुँदैछ…', 'Saving…') : tr('पेश्की दिनुहोस्', 'Give Advance')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// --- Staff profile ---

// --- Phase 4: Print ID Card / Print Summary ---
//
// Both are rendered inside the same `.modal-overlay`/`.modal-panel` shell
// every other modal in this file uses, so they get identical on-screen
// chrome (Escape-to-close, backdrop, etc.) for free. The `.print-region`
// div (see index.css's `@media print` block, added this phase) is the
// ONLY thing that survives onto the printed page — everything else on
// screen, including this modal's own header/buttons (marked `.no-print`)
// and the rest of the app behind it, is hidden via `visibility` at print
// time, not removed from the DOM, so no separate print-mode render path
// is needed.

interface PrintIdCardProps {
  staff: Staff;
  vehicles: Vehicle[];
  onClose: () => void;
}

function PrintIdCard({ staff, vehicles, onClose }: PrintIdCardProps) {
  const { t: tr } = useLanguage();
  useEscapeToClose(onClose);

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal-panel max-w-md">
        <div className="modal-header no-print">
          <h2 className="text-base font-semibold text-ink-900">
            {tr('परिचयपत्र प्रिन्ट', 'Print ID Card')}
          </h2>
          <button
            onClick={onClose}
            className="text-ink-400 hover:text-ink-700 text-xl leading-none px-2 rounded-md hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
            aria-label={tr('बन्द गर्नुहोस्', 'Close')}
          >
            &times;
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Roughly credit-card proportions — not exact, per spec. */}
          <div
            className="print-region mx-auto w-[340px] rounded-xl border border-ink-200 p-4 bg-white text-ink-900 space-y-2"
            style={{ aspectRatio: '1.6' }}
          >
            <p
              className="text-center text-[11px] font-bold uppercase tracking-widest pb-1 border-b border-line-100"
              style={{ color: 'var(--color-primary-700)' }}
            >
              {APP_NAME}
            </p>
            <div className="flex items-center gap-3">
              {staff.photoDataUrl ? (
                <img
                  src={staff.photoDataUrl}
                  alt=""
                  className="h-16 w-16 rounded-lg object-cover border border-ink-200 shrink-0"
                />
              ) : (
                <div className="h-16 w-16 rounded-lg border border-dashed border-ink-300 shrink-0" />
              )}
              <div className="min-w-0">
                <p className="font-bold text-sm leading-tight truncate">{staff.name}</p>
                {staff.position && <p className="text-xs text-ink-600 truncate mt-0.5">{staff.position}</p>}
                {staff.employeeId && (
                  <p className="text-[11px] text-ink-500 mt-0.5">
                    {tr('परिचयपत्र नं.', 'ID')}: <span className="font-medium text-ink-700">{staff.employeeId}</span>
                  </p>
                )}
              </div>
            </div>
            <div className="text-xs text-ink-700 space-y-0.5">
              {staff.joiningDate && (
                <p>
                  <span className="text-ink-500">{tr('भर्ना', 'Joined')}: </span>
                  {formatDateDisplay(staff.joiningDate)}
                </p>
              )}
              {staff.contactNumber && (
                <p>
                  <span className="text-ink-500">{tr('सम्पर्क', 'Contact')}: </span>
                  {staff.contactNumber}
                </p>
              )}
              {vehicles.length > 0 && (
                <p className="truncate">
                  <span className="text-ink-500">{tr('सवारी साधन', 'Vehicle(s)')}: </span>
                  {vehicles.map((v) => v.name).join(', ')}
                </p>
              )}
            </div>
            <div className="pt-3 flex justify-end">
              <div className="text-[9px] text-ink-500 border-t border-ink-400 pt-1 w-28 text-center">
                {tr('अधिकृत हस्ताक्षर', 'Authorized Signature')}
              </div>
            </div>
          </div>

          <div className="flex gap-3 no-print">
            <button onClick={onClose} className="btn btn-secondary flex-1">
              {tr('बन्द गर्नुहोस्', 'Close')}
            </button>
            <button onClick={() => window.print()} className="btn btn-teal flex-1">
              {tr('प्रिन्ट', 'Print')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

interface PrintSummaryProps {
  staff: Staff;
  vehicles: Vehicle[];
  advance: OutstandingAdvance | undefined;
  payments: Transaction[] | undefined;
  onClose: () => void;
}

function PrintSummary({ staff, vehicles, advance, payments, onClose }: PrintSummaryProps) {
  const { t: tr } = useLanguage();
  useEscapeToClose(onClose);

  // Recent history only, same shape as the profile screen's own list —
  // this is a summary, not a full ledger export.
  const recentPayments = (payments ?? []).slice(0, 10);

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal-panel max-w-lg">
        <div className="modal-header no-print">
          <h2 className="text-base font-semibold text-ink-900">
            {tr('सारांश प्रिन्ट', 'Print Summary')}
          </h2>
          <button
            onClick={onClose}
            className="text-ink-400 hover:text-ink-700 text-xl leading-none px-2 rounded-md hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
            aria-label={tr('बन्द गर्नुहोस्', 'Close')}
          >
            &times;
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="print-region bg-white text-ink-900 p-4 space-y-4">
            <div className="flex items-center gap-4 border-b-2 pb-3" style={{ borderColor: 'var(--color-primary-700)' }}>
              {staff.photoDataUrl ? (
                <img
                  src={staff.photoDataUrl}
                  alt=""
                  className="h-16 w-16 rounded-lg object-cover border border-ink-200 shrink-0"
                />
              ) : null}
              <div>
                <p
                  className="text-xs font-bold uppercase tracking-widest"
                  style={{ color: 'var(--color-primary-700)' }}
                >
                  {APP_NAME}
                </p>
                <h3 className="text-lg font-bold leading-tight mt-0.5">{staff.name}</h3>
                {staff.position && <p className="text-sm text-ink-600 mt-0.5">{staff.position}</p>}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
              {staff.employeeId && (
                <p>
                  <span className="text-ink-500">{tr('परिचयपत्र नं.', 'Employee ID')}: </span>
                  {staff.employeeId}
                </p>
              )}
              {staff.contactNumber && (
                <p>
                  <span className="text-ink-500">{tr('सम्पर्क', 'Contact')}: </span>
                  {staff.contactNumber}
                </p>
              )}
              {staff.joiningDate && (
                <p>
                  <span className="text-ink-500">{tr('भर्ना मिति', 'Joining Date')}: </span>
                  {formatDateDisplay(staff.joiningDate)}
                </p>
              )}
              <p>
                <span className="text-ink-500">{tr('मासिक तलब', 'Monthly Salary')}: </span>
                {formatPaisaAsRupees(staff.monthlySalaryPaisa)}
              </p>
              {vehicles.length > 0 && (
                <p className="col-span-2">
                  <span className="text-ink-500">{tr('तोकिएका सवारी साधनहरू', 'Assigned Vehicles')}: </span>
                  {vehicles.map((v) => v.name).join(', ')}
                </p>
              )}
            </div>

            <div className="border-t border-ink-200 pt-2.5">
              <p className="text-xs font-bold uppercase tracking-widest text-ink-500 mb-1.5">
                {tr('कर्मचारी पेश्की', 'Staff Advance')}
              </p>
              <div className="grid grid-cols-3 gap-3 text-sm">
                <p>
                  <span className="text-ink-500">{tr('दिइएको', 'Given')}: </span>
                  {formatPaisaAsRupees(advance?.advancesGivenPaisa ?? 0)}
                </p>
                <p>
                  <span className="text-ink-500">{tr('उठाइएको', 'Recovered')}: </span>
                  {formatPaisaAsRupees(advance?.advancesRecoveredPaisa ?? 0)}
                </p>
                <p>
                  <span className="text-ink-500">{tr('बाँकी', 'Outstanding')}: </span>
                  {formatPaisaAsRupees(advance?.outstandingPaisa ?? 0)}
                </p>
              </div>
            </div>

            <div className="border-t border-ink-200 pt-2.5">
              <p className="text-xs font-bold uppercase tracking-widest text-ink-500 mb-1.5">
                {tr('हालैका तलब भुक्तानीहरू', 'Recent Salary Payments')}
              </p>
              {recentPayments.length === 0 ? (
                <p className="text-sm text-ink-400">{tr('अहिलेसम्म कुनै तलब भुक्तानी छैन।', 'No salary payments yet.')}</p>
              ) : (
                <table className="w-full text-sm">
                  <tbody>
                    {recentPayments.map((t) => (
                      <tr key={t.id} className="border-b border-ink-100 last:border-0">
                        <td className="py-1.5 pr-2 text-ink-500">{formatDateDisplay(t.date)}</td>
                        <td className="py-1.5 text-right font-medium">{formatPaisaAsRupees(t.amountPaisa)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="pt-4 flex justify-end">
              <div className="text-[10px] text-ink-500 border-t border-ink-400 pt-1 w-32 text-center">
                {tr('अधिकृत हस्ताक्षर', 'Authorized Signature')}
              </div>
            </div>
          </div>

          <div className="flex gap-3 no-print">
            <button onClick={onClose} className="btn btn-secondary flex-1">
              {tr('बन्द गर्नुहोस्', 'Close')}
            </button>
            <button onClick={() => window.print()} className="btn btn-teal flex-1">
              {tr('प्रिन्ट', 'Print')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function StaffProfile({
  staff,
  onBack,
  onNavigateToVehicle,
}: {
  staff: Staff;
  onBack: () => void;
  onNavigateToVehicle?: (vehicleId: string) => void;
}) {
  const { t: tr } = useLanguage();
  const [editing, setEditing] = useState(false);
  const [paying, setPaying] = useState(false);
  const [givingAdvance, setGivingAdvance] = useState(false);
  const [salaryHeadId, setSalaryHeadId] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [vehicleBusy, setVehicleBusy] = useState(false);
  // Phase 4: print-only ID card / summary views (see PrintIdCard /
  // PrintSummary below).
  const [showIdCard, setShowIdCard] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  // Phase 2: assigned vehicles now come from the StaffVehicle join table
  // (live), not the deprecated Staff.assignedVehicleId field.
  const assignedVehicles = useVehiclesForStaff(staff.id!);
  const allActiveVehicles = useActiveVehicles();
  const [pickerVehicleId, setPickerVehicleId] = useState('');

  useEffect(() => {
    let cancelled = false;
    getSalaryReferenceIds().then((refs) => {
      if (!cancelled) setSalaryHeadId(refs?.salaryExpenseHead.id);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const payments = useStaffSalaryTransactions(staff.id!, salaryHeadId);
  const totals = useLiveQuery(() => getStaffTotals(staff.id!), [staff.id]);
  const advance = useLiveQuery(() => getOutstandingAdvance(staff.id!), [staff.id]);

  const assignedVehicleIds = new Set((assignedVehicles ?? []).map((v) => v.id!));
  const assignableVehicles = (allActiveVehicles ?? []).filter((v) => !assignedVehicleIds.has(v.id!));

  async function toggleActive() {
    setBusy(true);
    try {
      await setStaffActive(staff.id!, !staff.active);
    } finally {
      setBusy(false);
    }
  }

  async function handleAssignVehicle() {
    if (!pickerVehicleId) return;
    setVehicleBusy(true);
    try {
      await assignVehicleToStaff(staff.id!, pickerVehicleId);
      setPickerVehicleId('');
    } finally {
      setVehicleBusy(false);
    }
  }

  async function handleUnassignVehicle(vehicleId: string) {
    setVehicleBusy(true);
    try {
      await unassignVehicleFromStaff(staff.id!, vehicleId);
    } finally {
      setVehicleBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6 py-5 space-y-4 pb-24">
      <button
        onClick={onBack}
        className="text-sm font-medium text-teal-700 hover:underline flex items-center gap-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
      >
        &#8249; {tr('सबै कर्मचारी', 'All Staff')}
      </button>

      <div className="card card-pad space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            {staff.photoDataUrl && (
              <img
                src={staff.photoDataUrl}
                alt=""
                className="h-14 w-14 rounded-full object-cover border border-line-200 shrink-0"
              />
            )}
            <div>
              <h2 className={`text-lg font-bold ${staff.active ? 'text-ink-900' : 'text-ink-400'}`}>
                {staff.name}
                {!staff.active && <span className="ml-2 text-xs font-medium text-ink-400">({tr('निष्क्रिय', 'inactive')})</span>}
              </h2>
              {staff.position && <p className="text-sm text-ink-500 mt-0.5">{staff.position}</p>}
              <p className="text-sm text-ink-500 mt-0.5">
                {tr('मासिक तलब', 'Monthly Salary')}: {formatPaisaAsRupees(staff.monthlySalaryPaisa)}
              </p>
              {staff.joiningDate && (
                <p className="text-sm text-ink-500">{tr('भर्ना', 'Joined')}: {formatDateDisplay(staff.joiningDate)}</p>
              )}
              {staff.employeeId && (
                <p className="text-sm text-ink-500">{tr('परिचयपत्र नं.', 'Employee ID')}: {staff.employeeId}</p>
              )}
              {staff.contactNumber && (
                <p className="text-sm text-ink-500">{tr('सम्पर्क', 'Contact')}: {staff.contactNumber}</p>
              )}
              {staff.notes && <p className="text-sm text-ink-500 mt-1">{staff.notes}</p>}
            </div>
          </div>
          <div className="flex flex-col items-end gap-2 shrink-0">
            <button
              onClick={() => setEditing(true)}
              className="text-xs font-medium text-ink-500 hover:text-ink-900"
            >
              {tr('सम्पादन', 'Edit')}
            </button>
            <div className="flex flex-wrap justify-end gap-2">
              <button
                onClick={() => setShowIdCard(true)}
                className="text-xs font-medium text-teal-700 hover:underline"
              >
                {tr('परिचयपत्र प्रिन्ट', 'Print ID Card')}
              </button>
              <button
                onClick={() => setShowSummary(true)}
                className="text-xs font-medium text-teal-700 hover:underline"
              >
                {tr('सारांश प्रिन्ट', 'Print Summary')}
              </button>
            </div>
          </div>
        </div>

        <div className="pt-2 border-t border-ink-100 space-y-1.5">
          <p className="text-xs font-semibold text-ink-500 uppercase tracking-wide">
            {tr('तोकिएका सवारी साधनहरू', 'Assigned Vehicles')}
          </p>
          {(assignedVehicles ?? []).length === 0 ? (
            <p className="text-sm text-ink-400">{tr('कुनै तोकिएको छैन।', 'None assigned.')}</p>
          ) : (
            <ul className="space-y-1">
              {(assignedVehicles ?? []).map((v) => (
                <li key={v.id} className="flex items-center justify-between gap-2 text-sm">
                  {onNavigateToVehicle ? (
                    <button
                      onClick={() => onNavigateToVehicle(v.id!)}
                      className="font-medium text-teal-700 hover:underline"
                    >
                      {v.name}
                    </button>
                  ) : (
                    <span className="font-medium text-ink-900">{v.name}</span>
                  )}
                  <button
                    onClick={() => handleUnassignVehicle(v.id!)}
                    disabled={vehicleBusy}
                    className="text-xs font-medium text-brick-600 hover:underline disabled:opacity-50"
                  >
                    {tr('हटाउनुहोस्', 'Unassign')}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {assignableVehicles.length > 0 && (
            <div className="flex items-center gap-2 pt-1">
              <select
                value={pickerVehicleId}
                onChange={(e) => setPickerVehicleId(e.target.value)}
                className="field flex-1 text-sm"
              >
                <option value="">{tr('सवारी साधन छान्नुहोस्…', 'Select a vehicle…')}</option>
                {assignableVehicles.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
              <button
                onClick={handleAssignVehicle}
                disabled={!pickerVehicleId || vehicleBusy}
                className="btn btn-secondary text-xs px-3 py-1.5 disabled:opacity-50"
              >
                {tr('थप्नुहोस्', 'Assign')}
              </button>
            </div>
          )}
        </div>

        <div className="flex gap-2 pt-1">
          {staff.active && (
            <button
              onClick={() => setPaying(true)}
              className="btn btn-brick btn-sm"
            >
              {tr('तलब भुक्तानी', 'Pay Salary')}
            </button>
          )}
          {staff.active && (
            <button
              onClick={() => setGivingAdvance(true)}
              className="btn btn-amber btn-sm"
            >
              {tr('पेश्की दिनुहोस्', 'Give Advance')}
            </button>
          )}
          <button
            onClick={toggleActive}
            disabled={busy}
            className={`text-xs font-medium rounded-full px-3 py-1.5 disabled:opacity-60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300 ${
              staff.active
                ? 'bg-line-100 text-ink-700 hover:bg-line-200'
                : 'bg-teal-50 text-teal-700 hover:bg-teal-100'
            }`}
          >
            {staff.active ? tr('निष्क्रिय गर्नुहोस्', 'Deactivate') : tr('सक्रिय गर्नुहोस्', 'Activate')}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
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
          <p className="panel-label">{tr('जम्मा (सबै समय)', 'Lifetime')}</p>
          <p className="mt-1 text-base font-semibold text-ink-900">
            {formatPaisaAsRupees(totals?.lifetimePaisa ?? 0)}
          </p>
        </div>
      </div>

      <div className="card card-pad">
        <p className="panel-label mb-2">
          {tr('कर्मचारी पेश्की', 'Staff Advance')}
        </p>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <p className="text-xs text-ink-400">{tr('दिइएको', 'Given')}</p>
            <p className="text-sm font-semibold text-ink-900">
              {formatPaisaAsRupees(advance?.advancesGivenPaisa ?? 0)}
            </p>
          </div>
          <div>
            <p className="text-xs text-ink-400">{tr('उठाइएको', 'Recovered')}</p>
            <p className="text-sm font-semibold text-ink-900">
              {formatPaisaAsRupees(advance?.advancesRecoveredPaisa ?? 0)}
            </p>
          </div>
          <div>
            <p className="text-xs text-ink-400">{tr('बाँकी', 'Outstanding')}</p>
            <p className="text-sm font-semibold text-amber-700">
              {formatPaisaAsRupees(advance?.outstandingPaisa ?? 0)}
            </p>
          </div>
        </div>
      </div>

      <div className="card divide-y divide-line-100">
        {!payments ? (
          <div className="empty-state flex items-center justify-center gap-2">
            <span className="spinner" aria-hidden="true" />
            {tr('लोड हुँदैछ…', 'Loading…')}
          </div>
        ) : payments.length === 0 ? (
          <p className="empty-state">{tr('अहिलेसम्म कुनै तलब भुक्तानी छैन।', 'No salary payments yet.')}</p>
        ) : (
          payments.map((t) => {
            const recoveryPaisa = t.linkedAdvanceRecoveryPaisa ?? 0;
            const grossPaisa = t.amountPaisa + recoveryPaisa;
            return (
              <div key={t.id} className="p-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink-900 truncate">{t.description}</p>
                  <p className="text-xs text-ink-500">{formatDateDisplay(t.date)}</p>
                  {recoveryPaisa > 0 && (
                    <p className="text-xs text-ink-400">
                      {tr('कुल', 'Gross')} {formatPaisaAsRupees(grossPaisa)} − {tr('उठाइएको', 'Recovery')}{' '}
                      {formatPaisaAsRupees(recoveryPaisa)}
                    </p>
                  )}
                </div>
                <span className="text-sm font-semibold text-brick-700 shrink-0">
                  − {formatPaisaAsRupees(t.amountPaisa)}
                </span>
              </div>
            );
          })
        )}
      </div>

      {editing && <StaffFormModal editing={staff} onClose={() => setEditing(false)} />}
      {paying && <PaySalaryModal staff={staff} onClose={() => setPaying(false)} />}
      {givingAdvance && <GiveAdvanceModal staff={staff} onClose={() => setGivingAdvance(false)} />}
      {showIdCard && (
        <PrintIdCard
          staff={staff}
          vehicles={assignedVehicles ?? []}
          onClose={() => setShowIdCard(false)}
        />
      )}
      {showSummary && (
        <PrintSummary
          staff={staff}
          vehicles={assignedVehicles ?? []}
          advance={advance}
          payments={payments}
          onClose={() => setShowSummary(false)}
        />
      )}
    </div>
  );
}

// --- Staff list ---

export function StaffView({
  onNavigateToVehicle,
}: {
  onNavigateToVehicle?: (vehicleId: string) => void;
}) {
  const { t: tr } = useLanguage();
  const staff = useAllStaff();
  const [selected, setSelected] = useState<Staff | null>(null);
  const [adding, setAdding] = useState(false);

  // Keep the selected staff row in sync with live query updates (e.g. after
  // editing name/salary or toggling active) instead of a stale snapshot.
  const liveSelected = selected ? (staff ?? []).find((s) => s.id === selected.id) ?? selected : null;

  if (liveSelected) {
    return (
      <StaffProfile
        staff={liveSelected}
        onBack={() => setSelected(null)}
        onNavigateToVehicle={onNavigateToVehicle}
      />
    );
  }

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6 py-5 space-y-4 pb-24">
      <div className="flex items-center justify-between">
        <h1 className="text-page-title">{tr('कर्मचारी', 'Staff')}</h1>
        <button
          onClick={() => setAdding(true)}
          className="btn btn-teal btn-sm"
        >
          + {tr('कर्मचारी थप्नुहोस्', 'Add Staff')}
        </button>
      </div>

      <div className="card divide-y divide-line-100">
        {!staff ? (
          <div className="empty-state flex items-center justify-center gap-2">
            <span className="spinner" aria-hidden="true" />
            {tr('लोड हुँदैछ…', 'Loading…')}
          </div>
        ) : staff.length === 0 ? (
          <p className="empty-state">{tr('अहिलेसम्म कुनै कर्मचारी छैन।', 'No staff yet.')}</p>
        ) : (
          staff.map((s) => (
            <button
              key={s.id}
              onClick={() => setSelected(s)}
              className="w-full text-left px-4 py-3 flex items-center justify-between hover:bg-surface-muted transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-300"
            >
              <span className={`text-sm ${s.active ? 'text-ink-900' : 'text-ink-400 line-through'}`}>
                {s.name}
              </span>
              <span className="text-xs text-ink-400">{formatPaisaAsRupees(s.monthlySalaryPaisa)}/{tr('महिना', 'mo')}</span>
            </button>
          ))
        )}
      </div>

      {adding && <StaffFormModal onClose={() => setAdding(false)} />}
    </div>
  );
}
