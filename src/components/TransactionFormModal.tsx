import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { type Direction, type Transaction } from '../types';
import { addTransaction, editTransaction, type NewTransactionInput } from '../lib/ledger';
import { parseRupeeInputToPaisa } from '../lib/money';
import { resolveAssignedVehicleId } from '../lib/staff';
import {
  useActiveStaff,
  useActiveVehicles,
  useCashInTypes,
  useCashOutCategories,
  useExpenseHeadsForCategory,
} from '../hooks/useLedger';
import { useLanguage } from '../lib/i18n';
import { useEscapeToClose } from '../hooks/useEscapeToClose';

interface Props {
  date: string;
  direction: Direction;
  /** When set, the form edits this existing transaction instead of creating a new one. */
  editing?: Transaction | null;
  onClose: () => void;
}

export function TransactionFormModal({ date, direction, editing, onClose }: Props) {
  const { t: tr } = useLanguage();
  const isCashIn = direction === 'cash_in';
  useEscapeToClose(onClose);

  const categories = useCashOutCategories();
  const cashInTypes = useCashInTypes();
  const activeStaff = useActiveStaff();
  const activeVehicles = useActiveVehicles();

  const [description, setDescription] = useState(editing?.description ?? '');
  const [amountInput, setAmountInput] = useState(
    editing ? String(editing.amountPaisa / 100) : '',
  );
  const [categoryId, setCategoryId] = useState<string | null>(editing?.categoryId ?? null);
  const [expenseHeadId, setExpenseHeadId] = useState<string | null>(
    editing?.expenseHeadId ?? null,
  );
  const [cashInTypeId, setCashInTypeId] = useState<string | null>(editing?.cashInTypeId ?? null);
  const [staffId, setStaffId] = useState<string | null>(editing?.staffId ?? null);
  const [vehicleId, setVehicleId] = useState<string | null>(editing?.vehicleId ?? null);
  const [referenceNumber, setReferenceNumber] = useState(editing?.referenceNumber ?? '');
  const [notes, setNotes] = useState(editing?.notes ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // A ref (not just the `saving` state) so two Enter presses in the same instant
  // can never both get past the guard and save the entry twice.
  const savingLockRef = useRef(false);
  const descriptionRef = useRef<HTMLInputElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);

  const expenseHeads = useExpenseHeadsForCategory(categoryId);

  // When a staff member with an assigned vehicle is picked, pre-fill the
  // Vehicle field with it (Phase 5 Part C, via the shared
  // resolveAssignedVehicleId() helper — Phase 12c's Fast Entry Staff
  // select calls the identical function) — a default suggestion only:
  // this fires once, on the staff dropdown's own onChange, and never
  // fights back against the user's subsequent edits to Vehicle.
  //
  // Phase 2: resolveAssignedVehicleId now reads the StaffVehicle join
  // table (async) and only ever suggests when the staff member has
  // EXACTLY one assigned vehicle — with zero or 2+, it resolves to null
  // and this leaves Vehicle as-is, same as before.
  async function handleStaffChange(value: string) {
    const newStaffId = value === '' ? null : value;
    setStaffId(newStaffId);
    if (newStaffId != null) {
      const assignedVehicleId = await resolveAssignedVehicleId(newStaffId);
      if (assignedVehicleId != null) {
        setVehicleId(assignedVehicleId);
      }
    }
  }

  // Default the dropdown selections once reference data loads (add mode only).
  useEffect(() => {
    if (editing) return;
    if (!isCashIn && categoryId == null && categories && categories.length > 0) {
      setCategoryId(categories[0].id!);
    }
    if (isCashIn && cashInTypeId == null && cashInTypes && cashInTypes.length > 0) {
      setCashInTypeId(cashInTypes[0].id!);
    }
  }, [editing, isCashIn, categories, cashInTypes, categoryId, cashInTypeId]);

  // Reset expense head when category changes away from what it belonged to.
  useEffect(() => {
    if (!expenseHeads) return;
    if (expenseHeadId != null && !expenseHeads.some((h) => h.id === expenseHeadId)) {
      setExpenseHeadId(null);
    }
  }, [expenseHeads, expenseHeadId]);

  // Enter works like Tab: it moves to the next field, and on the LAST field it
  // saves. (Without this, Enter inside Description or Amount saved the form
  // straight away, half filled.) Buttons keep their normal Enter behaviour, and
  // Shift+Enter still starts a new line inside Notes.
  function handleFormKeyDown(e: React.KeyboardEvent<HTMLFormElement>) {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    const target = e.target as HTMLElement;
    const tag = target.tagName;
    if (tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA') return;
    if (tag === 'TEXTAREA' && e.shiftKey) return;
    e.preventDefault();
    const fields = Array.from(
      e.currentTarget.querySelectorAll<HTMLElement>('input, select, textarea'),
    ).filter((el) => !el.hasAttribute('disabled') && el.tabIndex !== -1 && el.offsetParent !== null);
    const index = fields.indexOf(target);
    if (index >= 0 && index < fields.length - 1) {
      const next = fields[index + 1];
      next.focus();
      if (next instanceof HTMLInputElement && next.type === 'text') next.select();
    } else if (!savingLockRef.current) {
      e.currentTarget.requestSubmit();
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (savingLockRef.current) return; // a quick double Enter / double click must not save twice
    setError(null);

    const amountPaisa = parseRupeeInputToPaisa(amountInput);
    if (amountPaisa == null || amountPaisa <= 0) {
      setError(tr('शून्यभन्दा बढी मान्य रकम राख्नुहोस्।', 'Enter a valid amount greater than zero.'));
      amountRef.current?.focus();
      return;
    }
    if (!description.trim()) {
      setError(tr('विवरण आवश्यक छ।', 'Description is required.'));
      descriptionRef.current?.focus();
      return;
    }
    if (!isCashIn && categoryId == null) {
      setError(tr('वर्ग छान्नुहोस्।', 'Select a category.'));
      return;
    }
    if (isCashIn && cashInTypeId == null) {
      setError(tr('स्रोत छान्नुहोस्।', 'Select a source.'));
      return;
    }

    savingLockRef.current = true;
    setSaving(true);
    try {
      if (editing) {
        await editTransaction(editing.id, {
          amountPaisa,
          description: description.trim(),
          categoryId: isCashIn ? null : categoryId,
          expenseHeadId: isCashIn ? null : expenseHeadId,
          cashInTypeId: isCashIn ? cashInTypeId : null,
          staffId: isCashIn ? null : staffId,
          vehicleId: isCashIn ? null : vehicleId,
          referenceNumber: referenceNumber.trim() || null,
          notes: notes.trim() || null,
        });
      } else {
        const input: NewTransactionInput = {
          date,
          direction,
          amountPaisa,
          description: description.trim(),
          categoryId: isCashIn ? null : categoryId,
          expenseHeadId: isCashIn ? null : expenseHeadId,
          cashInTypeId: isCashIn ? cashInTypeId : null,
          staffId: isCashIn ? null : staffId,
          vehicleId: isCashIn ? null : vehicleId,
          institutionId: null,
          referenceNumber: referenceNumber.trim() || null,
          notes: notes.trim() || null,
          linkedAdvanceRecoveryPaisa: null,
        };
        await addTransaction(input);
      }
      onClose();
    } catch (err) {
      // Only a FAILED save unlocks the form again. After a successful save the
      // popup is closing, and it must stay locked until it is gone so that extra
      // quick Enter presses cannot save the same entry a second time.
      savingLockRef.current = false;
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
            {isCashIn ? tr('नगद आम्दानी', 'Cash In') : tr('नगद खर्च', 'Cash Out')} {editing ? tr('सम्पादन', 'Edit') : tr('थप्नुहोस्', 'Add')}
          </h2>
          <button
            onClick={onClose}
            className="text-ink-400 hover:text-ink-700 p-1 -mr-1 rounded-md hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
            aria-label={tr('बन्द गर्नुहोस्', 'Close')}
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} onKeyDown={handleFormKeyDown} className="modal-body">
          <div>
            <label className="field-label">{tr('विवरण', 'Description')}</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="field"
              placeholder={tr('जस्तै: कर्मचारीको लागि खाजा', 'e.g. Lunch for staff')}
              autoFocus
              ref={descriptionRef}
            />
          </div>

          <div>
            <label className="field-label">{tr('रकम (रु)', 'Amount (Rs.)')}</label>
            <input
              type="text"
              inputMode="decimal"
              value={amountInput}
              onChange={(e) => setAmountInput(e.target.value)}
              className="field figures"
              placeholder="0.00"
              ref={amountRef}
            />
          </div>

          {isCashIn ? (
            <div>
              <label className="field-label">{tr('स्रोत', 'Source')}</label>
              <select
                value={cashInTypeId ?? ''}
                onChange={(e) => setCashInTypeId(e.target.value)}
                className="field"
              >
                {(cashInTypes ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <>
              <div>
                <label className="field-label">{tr('वर्ग', 'Category')}</label>
                <select
                  value={categoryId ?? ''}
                  onChange={(e) => setCategoryId(e.target.value)}
                  className="field"
                >
                  {(categories ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>

              {expenseHeads && expenseHeads.length > 0 && (
                <div>
                  <label className="field-label">
                    {tr('खर्च शीर्षक', 'Expense Head')} <span className="text-ink-400 font-normal">({tr('वैकल्पिक', 'optional')})</span>
                  </label>
                  <select
                    value={expenseHeadId ?? ''}
                    onChange={(e) =>
                      setExpenseHeadId(e.target.value === '' ? null : e.target.value)
                    }
                    className="field"
                  >
                    <option value="">{tr('कुनै पनि होइन', 'None')}</option>
                    {expenseHeads.map((h) => (
                      <option key={h.id} value={h.id}>
                        {h.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div>
                <label className="field-label">
                  {tr('कर्मचारी', 'Staff')} <span className="text-ink-400 font-normal">({tr('वैकल्पिक', 'optional')})</span>
                </label>
                <select
                  value={staffId ?? ''}
                  onChange={(e) => handleStaffChange(e.target.value)}
                  className="field"
                >
                  <option value="">{tr('कुनै पनि होइन', 'None')}</option>
                  {(activeStaff ?? []).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="field-label">
                  {tr('सवारी साधन', 'Vehicle')} <span className="text-ink-400 font-normal">({tr('वैकल्पिक', 'optional')})</span>
                </label>
                <select
                  value={vehicleId ?? ''}
                  onChange={(e) =>
                    setVehicleId(e.target.value === '' ? null : e.target.value)
                  }
                  className="field"
                >
                  <option value="">{tr('कुनै पनि होइन', 'None')}</option>
                  {(activeVehicles ?? []).map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="field-label">
                  {tr('सन्दर्भ नम्बर', 'Reference Number')} <span className="text-ink-400 font-normal">({tr('वैकल्पिक', 'optional')})</span>
                </label>
                <input
                  type="text"
                  value={referenceNumber}
                  onChange={(e) => setReferenceNumber(e.target.value)}
                  className="field"
                />
              </div>
            </>
          )}

          <div>
            <label className="field-label">
              {tr('टिप्पणी', 'Notes')} <span className="text-ink-400 font-normal">({tr('वैकल्पिक', 'optional')})</span>
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="field resize-none"
            />
          </div>

          {error && <p className="text-sm text-brick-600">{error}</p>}

          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose} className="btn btn-secondary flex-1">
              {tr('रद्द गर्नुहोस्', 'Cancel')}
            </button>
            <button
              type="submit"
              disabled={saving}
              className={`btn flex-1 ${isCashIn ? 'btn-teal' : 'btn-brick'}`}
            >
              {saving ? tr('सुरक्षित हुँदैछ…', 'Saving…') : editing ? tr('परिवर्तन सुरक्षित गर्नुहोस्', 'Save Changes') : tr('थप्नुहोस्', 'Add')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
