// Phase 12a: Fast Entry's validation + input-building logic, kept as pure
// functions separate from FastEntryBar.tsx so they're testable without a
// DOM/React harness (this project's test:ledger/test:integration suites
// run headless against fake-indexeddb, not jsdom — see README) and so the
// rules can never silently drift from TransactionFormModal's.
//
// Fast Entry has NO write path of its own: buildFastEntryTransactionInput
// produces exactly the same NewTransactionInput shape the detailed form
// builds, and the caller passes it to the existing lib/ledger.ts
// addTransaction() — same shared table, same recalculation cascade.

import type { Direction } from '../types';
import { parseRupeeInputToPaisa } from './money';
import type { NewTransactionInput } from './ledger';
import type { FastEntrySuggestionMatch } from './fastEntrySuggestions';

export interface FastEntryFieldValues {
  direction: Direction;
  description: string;
  amountInput: string;
  categoryId: string | null;
  expenseHeadId: string | null;
  cashInTypeId: string | null;
  staffId: string | null;
  vehicleId: string | null;
  institutionId: string | null;
  referenceNumber: string;
  notes: string;
}

export type FastEntryField = 'description' | 'amount' | 'category';

export interface FastEntryValidationResult {
  valid: boolean;
  amountPaisa: number | null;
  errors: Partial<Record<FastEntryField, string>>;
}

/**
 * Validate Fast Entry's current field values. Same rules the detailed
 * TransactionFormModal enforces (description present, amount > 0, category
 * required for cash_out, cash-in type required for cash_in) — kept in one
 * place so Fast Entry and the detailed form can never drift apart.
 */
export function validateFastEntry(values: FastEntryFieldValues): FastEntryValidationResult {
  const errors: Partial<Record<FastEntryField, string>> = {};
  const amountPaisa = parseRupeeInputToPaisa(values.amountInput);

  if (!values.description.trim()) {
    errors.description = 'विवरण आवश्यक छ।';
  }
  if (amountPaisa == null || amountPaisa <= 0) {
    errors.amount = 'शून्यभन्दा बढी रकम राख्नुहोस्।';
  }
  if (values.direction === 'cash_out' && values.categoryId == null) {
    errors.category = 'वर्ग छान्नुहोस्।';
  }
  if (values.direction === 'cash_in' && values.cashInTypeId == null) {
    errors.category = 'स्रोत छान्नुहोस्।';
  }

  return {
    valid: Object.keys(errors).length === 0,
    amountPaisa,
    errors,
  };
}

/**
 * Build the addTransaction() input from validated Fast Entry field values.
 * Only call once validateFastEntry(values).valid is true — amountPaisa is
 * passed in separately (already parsed) rather than re-parsed here.
 *
 * Staff/Vehicle stay cash_out-only (matching the domain rule already
 * encoded in types.ts's field comments: both are "general Cash Out only");
 * Institution is intentionally available on both directions per this
 * phase's "+ more fields" spec (deposits are cash_out, withdrawals are
 * cash_in).
 */
export function buildFastEntryTransactionInput(
  values: FastEntryFieldValues,
  date: string,
  amountPaisa: number,
): NewTransactionInput {
  const isCashIn = values.direction === 'cash_in';
  return {
    date,
    direction: values.direction,
    amountPaisa,
    description: values.description.trim(),
    categoryId: isCashIn ? null : values.categoryId,
    expenseHeadId: isCashIn ? null : values.expenseHeadId,
    cashInTypeId: isCashIn ? values.cashInTypeId : null,
    staffId: isCashIn ? null : values.staffId,
    vehicleId: isCashIn ? null : values.vehicleId,
    institutionId: values.institutionId,
    referenceNumber: values.referenceNumber.trim() || null,
    notes: values.notes.trim() || null,
    linkedAdvanceRecoveryPaisa: null,
  };
}

export function emptyFastEntryValues(direction: Direction): FastEntryFieldValues {
  return {
    direction,
    description: '',
    amountInput: '',
    categoryId: null,
    expenseHeadId: null,
    cashInTypeId: null,
    staffId: null,
    vehicleId: null,
    institutionId: null,
    referenceNumber: '',
    notes: '',
  };
}

/**
 * Count of fields the owner has actually put meaningful data into, used by
 * the Esc-to-clear confirm rule (Part B): "if the user has typed into 2 or
 * more fields ... show a brief confirm". Category/cash-in-type selection
 * is deliberately excluded — Fast Entry pre-fills a default selection on
 * mount (mirroring the detailed form), so a field the user never touched
 * shouldn't count as "typed into".
 */
export function countMeaningfulFields(values: FastEntryFieldValues): number {
  let n = 0;
  if (values.description.trim() !== '') n++;
  if (values.amountInput.trim() !== '') n++;
  if (values.staffId != null) n++;
  if (values.vehicleId != null) n++;
  if (values.institutionId != null) n++;
  if (values.referenceNumber.trim() !== '') n++;
  if (values.notes.trim() !== '') n++;
  return n;
}

/**
 * Phase 12c Part C: whether the current Fast Entry values represent a
 * Staff Advance transaction (Category = Staff, Expense Head = Advance,
 * a Staff member selected) — the authoritative gate for when
 * `checkAdvanceLimit()` from `lib/staff.ts` (Phase 4, also used by
 * `StaffView.tsx`'s Give Advance form) MUST run so its result can be
 * surfaced to the owner before/around the save. Phase 3 Part A:
 * `checkAdvanceLimit()` no longer decides whether the transaction is
 * ALLOWED to save (it's advisory only now — see its own doc comment) —
 * this gate still decides whether to call it at all, exactly as before.
 * Pure and testable on its own: the actual limit check itself stays in
 * staff.ts and is called directly from FastEntryBar.tsx — this function
 * only decides *whether* to call it, never approximates what it decides.
 *
 * `staffCategoryId`/`advanceExpenseHeadId` are the app's resolved 'Staff'
 * category and 'Advance' expense head ids (see
 * hooks/useFastEntrySuggestions.ts's candidate pool, or
 * staff.ts's getAdvanceReferenceIds) — both null if that reference data
 * isn't seeded yet, in which case this always returns false (nothing to
 * gate against).
 */
/**
 * Phase 12f Part B: applies a resolved/selected suggestion's auto-tag to
 * Fast Entry's field values, exactly the same field-by-field rules
 * FastEntryBar.tsx's selectSuggestion() already used (Category/CashInType,
 * Institution, Staff, and the ExpenseHead `null` vs `undefined` distinction
 * - `null` means "tag the category but explicitly clear the head",
 * `undefined` means "no tag resolved, leave the head alone"). Pure and
 * synchronous, so it models the FINAL values a suggestion accept settles
 * on; FastEntryBar.tsx's own selectSuggestion() still defers the
 * expenseHeadId write one tick (via pendingExpenseHeadId) to dodge a real
 * React-only race where useExpenseHeadsForCategory's live query briefly
 * still returns the PREVIOUS category's heads right after categoryId
 * changes - a rendering-timing detail this pure function has no reason to
 * simulate.
 */
export function applyFastEntryMatch(
  values: FastEntryFieldValues,
  match: FastEntrySuggestionMatch,
): FastEntryFieldValues {
  const isCashIn = values.direction === 'cash_in';
  const next: FastEntryFieldValues = { ...values, description: match.description };
  if (isCashIn) {
    if (match.suggestedCategoryOrTypeId) next.cashInTypeId = match.suggestedCategoryOrTypeId;
  } else {
    if (match.suggestedCategoryOrTypeId) next.categoryId = match.suggestedCategoryOrTypeId;
    if (match.suggestedInstitutionId) next.institutionId = match.suggestedInstitutionId;
    if (match.suggestedStaffId) next.staffId = match.suggestedStaffId;
    // Phase 3 rule 5 only - see FastEntrySuggestionMatch.suggestedVehicleId's
    // doc comment for why this is the one rule that ever sets it.
    if (match.suggestedVehicleId) next.vehicleId = match.suggestedVehicleId;
    if (match.suggestedExpenseHeadId === null) next.expenseHeadId = null;
    else if (match.suggestedExpenseHeadId) next.expenseHeadId = match.suggestedExpenseHeadId;
  }
  return next;
}

/** Where focus should land after a Description-field Enter, per resolveDescriptionEnter(). */
export type DescriptionEnterFocus = 'save' | 'description' | 'amount' | 'category' | 'expenseHead';

export interface DescriptionEnterResult {
  /** Field values after any suggestion auto-tag from this Enter was applied (unchanged if none was). */
  values: FastEntryFieldValues;
  /** Part B step 5: genuinely ambiguous - caller should keep the dropdown open and do nothing else. */
  ambiguous: boolean;
  /** The suggestion actually applied this call, or null if none was (free text, or the ambiguous case). */
  appliedMatch: FastEntrySuggestionMatch | null;
  /** The SAME validateFastEntry() check, run against the (possibly tagged) `values`. */
  validation: FastEntryValidationResult;
  /** 'save' -> proceed via the existing addTransaction() path; otherwise the field that still needs input. */
  focus: DescriptionEnterFocus;
}

/**
 * Phase 12f Part B: the single decision tree replacing the old two-branch
 * Enter handling, for Enter pressed with focus in the Description field.
 * Pure and DOM-independent (FastEntryBar.tsx's handleKeyDown supplies
 * `highlighted`/`autoMatch`/`suggestionCount` from its own dropdown/
 * suggestions state and applies the result) so the whole decision - not
 * just resolveUniqueMatch() in isolation - is directly unit-testable
 * without a DOM/React harness.
 *
 * @param values current Fast Entry field values (untagged or already
 *   partially filled - e.g. Amount typed before Description).
 * @param highlighted the dropdown row currently arrow-key-highlighted, if
 *   the dropdown is open and focus is in Description; undefined otherwise.
 * @param autoMatch resolveUniqueMatch(values.description, pool) - the
 *   candidate Enter would auto-resolve to absent any manual override.
 * @param suggestionCount how many rows the dropdown is currently showing
 *   (0 when nothing matches at all, so "no suggestion" is never confused
 *   with "genuinely ambiguous").
 */
export function resolveDescriptionEnter(
  values: FastEntryFieldValues,
  highlighted: FastEntrySuggestionMatch | undefined,
  autoMatch: FastEntrySuggestionMatch | null,
  suggestionCount: number,
): DescriptionEnterResult {
  let next = values;
  let appliedMatch: FastEntrySuggestionMatch | null = null;

  if (highlighted && highlighted.description !== autoMatch?.description) {
    // Step 1: the owner arrow-navigated to a DIFFERENT suggestion than the
    // one that would auto-resolve - deliberate intent, accept it outright
    // and continue in the SAME Enter press (no ambiguity check needed;
    // they already made the decision).
    next = applyFastEntryMatch(values, highlighted);
    appliedMatch = highlighted;
  } else if (autoMatch) {
    // Step 2: apply the unique auto-resolved match.
    next = applyFastEntryMatch(values, autoMatch);
    appliedMatch = autoMatch;
  } else if (suggestionCount >= 2) {
    // Step 5: resolveUniqueMatch() returned null AND there are genuinely 2+
    // candidates on screen (not just "nothing matched at all") - real
    // ambiguity the owner hasn't resolved yet. Keep the dropdown open, do
    // nothing else.
    return {
      values,
      ambiguous: true,
      appliedMatch: null,
      validation: validateFastEntry(values),
      focus: 'description',
    };
  }
  // else: no suggestion at all (free text with 0 matching candidates) -
  // fall through and validate/save the form exactly as typed, same as
  // Fast Entry's original dropdown-closed Enter behavior (Part C - this
  // correction only changes what happens when a SUGGESTION is in play).

  // Part D: the pattern's own reported next-focus field takes priority
  // over the generic validation check specifically for Expense Head,
  // since validateFastEntry() never requires one - only the institution
  // pattern itself knows that field still needs a manual pick before this
  // entry is really save-ready (Dhanodaya example).
  if (appliedMatch?.nextFocusHint === 'expenseHead' && !next.expenseHeadId) {
    return {
      values: next,
      ambiguous: false,
      appliedMatch,
      validation: validateFastEntry(next),
      focus: 'expenseHead',
    };
  }

  const validation = validateFastEntry(next);
  if (validation.valid) {
    // Step 3: save-ready as tagged - proceed to save in this SAME Enter.
    return { values: next, ambiguous: false, appliedMatch, validation, focus: 'save' };
  }
  // Step 4: not valid - move focus to whichever field is genuinely
  // missing, don't show a blocking error for a merely in-progress entry.
  const focus: DescriptionEnterFocus = validation.errors.description
    ? 'description'
    : validation.errors.amount
      ? 'amount'
      : 'category';
  return { values: next, ambiguous: false, appliedMatch, validation, focus };
}

/**
 * Phase 12f Part E: a synchronous re-entrancy guard so a single Enter
 * action (including a genuine double keypress or a held-down key
 * repeating) can never result in two Transaction rows. Deliberately a
 * plain ref-backed flag rather than React state - state updates are
 * batched/async, so a second call in the same tick could still read the
 * pre-update value; a plain mutable flag is checked-and-set synchronously.
 * FastEntryBar.tsx holds one instance for its whole lifetime (useRef) and
 * calls tryStart() at the very top of handleSubmit(), before validation
 * even runs, bailing out immediately if a save is already in flight;
 * finish() is called once addTransaction() settles (success or error).
 */
export function createFastEntrySaveGuard() {
  let inFlight = false;
  return {
    tryStart(): boolean {
      if (inFlight) return false;
      inFlight = true;
      return true;
    },
    finish(): void {
      inFlight = false;
    },
  };
}

export function isFastEntryAdvanceEntry(
  values: FastEntryFieldValues,
  staffCategoryId: string | null,
  advanceExpenseHeadId: string | null,
): boolean {
  return (
    values.direction === 'cash_out' &&
    staffCategoryId != null &&
    advanceExpenseHeadId != null &&
    values.categoryId === staffCategoryId &&
    values.expenseHeadId === advanceExpenseHeadId &&
    values.staffId != null
  );
}
