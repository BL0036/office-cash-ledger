import { useEffect, useMemo, useRef, useState } from 'react';
import { SlidersHorizontal, AlertTriangle, Sparkles } from 'lucide-react';
import type { Direction } from '../types';
import { addTransaction } from '../lib/ledger';
import { useLanguage } from '../lib/i18n';
import {
  applyFastEntryMatch,
  buildFastEntryTransactionInput,
  countMeaningfulFields,
  createFastEntrySaveGuard,
  emptyFastEntryValues,
  isFastEntryAdvanceEntry,
  resolveDescriptionEnter,
  validateFastEntry,
  type FastEntryFieldValues,
} from '../lib/fastEntry';
import {
  deriveSuggestions,
  resolveUniqueMatch,
  type FastEntrySuggestionMatch,
} from '../lib/fastEntrySuggestions';
import { useSuggestionCandidatePool } from '../hooks/useFastEntrySuggestions';
import { checkAdvanceLimit, resolveAssignedVehicleId } from '../lib/staff';
import { formatPaisaAsRupees } from '../lib/money';
import { isAiFallbackConfigured, requestAiFallbackSuggestion } from '../lib/aiFallback';
import {
  useActiveInstitutions,
  useActiveVehicles,
  useActiveStaff,
  useCashInTypes,
  useCashOutCategories,
  useExpenseHeadsForCategory,
} from '../hooks/useLedger';

interface Props {
  date: string;
  /** Opens the existing detailed TransactionFormModal for the given direction. */
  onOpenDetailed: (direction: Direction) => void;
}

const ESC_CONFIRM_WINDOW_MS = 3000;

export function FastEntryBar({ date, onOpenDetailed }: Props) {
  const { t: tr } = useLanguage();
  const [values, setValues] = useState<FastEntryFieldValues>(() =>
    emptyFastEntryValues('cash_out'),
  );
  const [moreOpen, setMoreOpen] = useState(false);
  const [errors, setErrors] = useState<ReturnType<typeof validateFastEntry>['errors']>({});
  const [saving, setSaving] = useState(false);
  const [escPending, setEscPending] = useState(false);
  // Phase 3 Part A: advisory-only advance-limit warning. Deliberately
  // separate from `errors` (which is reserved for genuinely blocking
  // validation) and NOT reset by resetForm() below, so it stays visible
  // after a successful over-limit save clears the rest of the form — the
  // EXACT SCOPE requirement that the two numbers must never be silent or
  // easy to miss. Cleared at the start of the next save attempt instead.
  const [advanceLimitWarning, setAdvanceLimitWarning] = useState<string | null>(null);

  // Phase 12b Part D: autocomplete dropdown state.
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  // A category was just auto-tagged and we're waiting for that category's
  // own expense-head list to load before applying the matching head - see
  // the effect below for why this two-step dance avoids clobbering the
  // auto-tag with the "reset expense head when category changes" effect's
  // stale (previous-category) data.
  const [pendingExpenseHeadId, setPendingExpenseHeadId] = useState<string | null>(null);

  // Phase 6: optional, on-demand Gemini fallback state. `aiSuggestion` is
  // spliced into the SAME suggestion list the dropdown already renders
  // (see `suggestions` below) - there is no second suggestion UI.
  // `aiStatus` drives the small affordance next to Description; it is
  // reset whenever the owner edits the text (a stale AI answer for OLD
  // text must never linger as if it applied to what's typed now).
  const [aiSuggestion, setAiSuggestion] = useState<FastEntrySuggestionMatch | null>(null);
  const [aiStatus, setAiStatus] = useState<'idle' | 'loading' | 'no-match' | 'unavailable'>('idle');
  const [aiStatusMessage, setAiStatusMessage] = useState<string | null>(null);

  const categories = useCashOutCategories();
  const cashInTypes = useCashInTypes();
  const expenseHeads = useExpenseHeadsForCategory(values.categoryId);
  const activeStaff = useActiveStaff();
  const activeVehicles = useActiveVehicles();
  const activeInstitutions = useActiveInstitutions();
  const candidatePool = useSuggestionCandidatePool(values.direction);

  const isCashIn = values.direction === 'cash_in';
  const showExpenseHead = !isCashIn && !!expenseHeads && expenseHeads.length > 0;

  const containerRef = useRef<HTMLDivElement>(null);
  const cashInBtnRef = useRef<HTMLButtonElement>(null);
  const cashOutBtnRef = useRef<HTMLButtonElement>(null);
  const descriptionRef = useRef<HTMLInputElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const categoryRef = useRef<HTMLSelectElement>(null);
  const cashInTypeRef = useRef<HTMLSelectElement>(null);
  const expenseHeadRef = useRef<HTMLSelectElement>(null);
  const moreToggleRef = useRef<HTMLButtonElement>(null);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const staffRef = useRef<HTMLSelectElement>(null);
  const institutionRef = useRef<HTMLSelectElement>(null);
  const escTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Phase 12f Part E: one guard instance for this bar's whole lifetime -
  // synchronous re-entrancy check so a genuine double keypress or a
  // held-down Enter repeating can never produce two Transaction rows.
  const saveGuardRef = useRef(createFastEntrySaveGuard());

  // Default the category/cash-in-type selection once reference data loads,
  // same pattern TransactionFormModal already uses — a default suggestion
  // only, never fights the user's own subsequent choice.
  useEffect(() => {
    if (!isCashIn && values.categoryId == null && categories && categories.length > 0) {
      setValues((v) => (v.categoryId == null ? { ...v, categoryId: categories[0].id } : v));
    }
    if (isCashIn && values.cashInTypeId == null && cashInTypes && cashInTypes.length > 0) {
      setValues((v) => (v.cashInTypeId == null ? { ...v, cashInTypeId: cashInTypes[0].id } : v));
    }
  }, [isCashIn, categories, cashInTypes, values.categoryId, values.cashInTypeId]);

  // Reset expense head when the category changes away from what it belonged to.
  useEffect(() => {
    if (!expenseHeads) return;
    if (values.expenseHeadId != null && !expenseHeads.some((h) => h.id === values.expenseHeadId)) {
      setValues((v) => ({ ...v, expenseHeadId: null }));
    }
  }, [expenseHeads, values.expenseHeadId]);

  // Phase 12b Part B/C: ranked, tagged autocomplete suggestions for the
  // current description text. Purely derived (no Dexie access itself) -
  // the candidate pool is already loaded/cached by useSuggestionCandidatePool.
  // Phase 6: this is STILL the deterministic engine's own untouched output
  // (deriveSuggestions() itself was not modified) - the AI suggestion, if
  // any, is appended afterward as a plain array concat below, never mixed
  // into deriveSuggestions()'s own ranking logic.
  const deterministicSuggestions = useMemo(() => {
    if (!candidatePool) return null;
    return deriveSuggestions(values.description, values.direction, candidatePool)?.descriptionMatches ?? null;
  }, [candidatePool, values.description, values.direction]);

  // Phase 6 constraint #2: the AI affordance is only reachable once Rules
  // 1-5 (via resolveUniqueMatch(), completely untouched by this phase)
  // have already run for the CURRENT text and found no confident unique
  // match. Recomputed the same way handleSubmit()/handleDescriptionEnter
  // already compute their own `autoMatch` below - this is a separate call
  // (candidatePool + current text are both cheap/pure), not a shared
  // cache, so nothing here can affect the existing Enter-key behavior.
  const hasConfidentDeterministicMatch = useMemo(() => {
    if (!candidatePool) return false;
    return resolveUniqueMatch(values.description, candidatePool) != null;
  }, [candidatePool, values.description]);

  // Phase 6 constraint #3: on-demand only. This becomes true purely from
  // local state (configured? long enough? no confident deterministic
  // match already?) - it never itself causes a network call; only
  // handleAskAi() (fired exclusively by an explicit click) does that.
  const canAskAi =
    isAiFallbackConfigured() &&
    values.description.trim().length >= 3 &&
    !hasConfidentDeterministicMatch &&
    !!candidatePool;

  // Phase 6 constraint #4: the AI's result is appended to the SAME list
  // the dropdown already renders (below) and goes through the exact same
  // selectSuggestion()/applyMatchTagsSafely() as any deterministic match -
  // there is no separate "apply AI suggestion" code path, and nothing
  // here auto-applies it. `source: 'ai'` (set by lib/aiFallback.ts, never
  // by deriveSuggestions()) is what the dropdown row below uses to render
  // the small "AI" badge distinguishing it from a deterministic match.
  const suggestions = useMemo(() => {
    if (aiSuggestion && aiSuggestion.description.trim().toLowerCase() === values.description.trim().toLowerCase()) {
      return [...(deterministicSuggestions ?? []), aiSuggestion];
    }
    return deterministicSuggestions;
  }, [deterministicSuggestions, aiSuggestion, values.description]);

  const showDropdown = dropdownOpen && !!suggestions && suggestions.length > 0;

  // Keep the highlighted row in range as the suggestion list itself
  // changes shape (e.g. live reference-data edits from another tab).
  useEffect(() => {
    if (!suggestions || suggestions.length === 0) return;
    setHighlightedIndex((idx) => (idx >= suggestions.length ? 0 : idx));
  }, [suggestions]);

  // Applies a just-auto-tagged expense head only once the Expense Head
  // list for the (just-changed) category has actually loaded and contains
  // it. useExpenseHeadsForCategory's live query keeps returning the
  // PREVIOUS category's heads for a moment after categoryId changes, and
  // the "reset expense head when category changes" effect below would
  // otherwise see our new head missing from that stale list and wipe it
  // before the correct list arrives. Deferring the write until the head is
  // confirmed present sidesteps that race entirely.
  useEffect(() => {
    if (pendingExpenseHeadId == null || !expenseHeads) return;
    if (expenseHeads.some((h) => h.id === pendingExpenseHeadId)) {
      setValues((v) => ({ ...v, expenseHeadId: pendingExpenseHeadId }));
      setPendingExpenseHeadId(null);
    }
  }, [pendingExpenseHeadId, expenseHeads]);

  useEffect(() => {
    return () => {
      if (escTimerRef.current) clearTimeout(escTimerRef.current);
    };
  }, []);

  function resetForm(nextDirection: Direction = values.direction) {
    setValues(emptyFastEntryValues(nextDirection));
    setMoreOpen(false);
    setErrors({});
    setEscPending(false);
    setDropdownOpen(false);
    setHighlightedIndex(0);
    setPendingExpenseHeadId(null);
    setAiSuggestion(null);
    setAiStatus('idle');
    setAiStatusMessage(null);
    if (escTimerRef.current) clearTimeout(escTimerRef.current);
    // Focus after the clear so the next entry can start typing immediately.
    requestAnimationFrame(() => descriptionRef.current?.focus());
  }

  // Phase 6: the ONLY place a Gemini network call can originate - fired
  // exclusively by an explicit click on the "Ask AI" affordance below,
  // never from a keystroke, a timer, or any effect. Exactly one request
  // per click (lib/aiFallback.ts itself never retries automatically).
  async function handleAskAi() {
    if (!candidatePool || aiStatus === 'loading') return;
    setAiStatus('loading');
    setAiStatusMessage(null);
    const typedAtRequestTime = values.description;
    const result = await requestAiFallbackSuggestion(typedAtRequestTime, values.direction, candidatePool);
    // The owner may have kept typing while the request was in flight - if
    // the text has since changed, this answer no longer applies to
    // anything on screen, so drop it silently rather than surprising them
    // with a suggestion for text they've already moved past.
    if (values.description !== typedAtRequestTime) return;
    if (!result.ok) {
      setAiStatus('unavailable');
      setAiStatusMessage(result.reason);
      return;
    }
    if (result.suggestion == null) {
      setAiStatus('no-match');
      return;
    }
    setAiSuggestion(result.suggestion);
    setAiStatus('idle');
    setDropdownOpen(true);
  }

  // Phase 12b Part C / 12c Parts A-D: applies a selected suggestion's
  // description text and auto-tag (Category+ExpenseHead/CashInType, plus
  // Institution/Staff where Phase 12c's rules resolve them) in one go, and
  // auto-expands "+ more fields" via one shared flag (match.expandMoreFields)
  // rather than three separate checks for the institution/Petrol/staff-
  // advance patterns. A DEFAULT only - manually changing any of these
  // fields afterward works exactly like it does on an untagged entry (12b
  // test case 10, unchanged this phase); nothing here locks the fields.
  function selectSuggestion(match: FastEntrySuggestionMatch) {
    // suggestedVehicleId is set only by rule 5 (Phase 3's vehicle-
    // maintenance pattern) - see FastEntrySuggestionMatch's doc comment.
    // Every other pattern still leaves Vehicle to the Staff <select>'s own
    // onChange below, once the owner actually picks a Staff member.
    applyMatchTagsSafely(match);
    focusFieldFor(match);
  }

  // Phase 12f Part B: applies a match's tags the same race-safe way
  // selectSuggestion always did - Category/CashInType/Institution/Staff
  // synchronously via applyFastEntryMatch, Expense Head deferred one tick
  // via pendingExpenseHeadId so the "reset expense head when category
  // changes" effect never wipes it before useExpenseHeadsForCategory's
  // live query catches up to the new category. Shared by selectSuggestion
  // (click/Tab accept) and handleDescriptionEnter (Phase 12f's new
  // Enter decision tree) so both apply a match identically.
  function applyMatchTagsSafely(match: FastEntrySuggestionMatch) {
    setValues((v) => applyFastEntryMatch(v, { ...match, suggestedExpenseHeadId: undefined }));
    if (!isCashIn) {
      if (match.suggestedExpenseHeadId === null) {
        setValues((v) => ({ ...v, expenseHeadId: null }));
        setPendingExpenseHeadId(null);
      } else if (match.suggestedExpenseHeadId) {
        setPendingExpenseHeadId(match.suggestedExpenseHeadId);
      }
    }
    if (match.expandMoreFields) setMoreOpen(true);
    setDropdownOpen(false);
    setHighlightedIndex(0);
  }

  /** Phase 12f Part D: focuses whichever field a match's nextFocusHint identifies as still needing input. */
  function focusFieldFor(match: FastEntrySuggestionMatch) {
    requestAnimationFrame(() => {
      if (match.nextFocusHint === 'expenseHead') expenseHeadRef.current?.focus();
      else amountRef.current?.focus();
    });
  }

  // Phase 12f Part B: the single decision tree for Enter pressed with
  // focus in the Description field, replacing the old two-branch handling
  // (dropdown-open-selects vs dropdown-closed-saves). The actual decision
  // logic lives in resolveDescriptionEnter() (lib/fastEntry.ts) so it's
  // unit-testable without a DOM/React harness; this function only wires
  // that decision into component state and focus.
  function handleDescriptionEnter(highlighted: FastEntrySuggestionMatch | undefined) {
    const autoMatch = candidatePool ? resolveUniqueMatch(values.description, candidatePool) : null;
    const result = resolveDescriptionEnter(values, highlighted, autoMatch, suggestions?.length ?? 0);

    if (result.ambiguous) {
      // Step 5: genuinely ambiguous - keep the dropdown open, do nothing else.
      return;
    }

    if (result.appliedMatch) {
      if (result.focus === 'save') {
        // Steps 1/2 then 3, same Enter press: apply + save immediately.
        // Pass the already-tagged values explicitly rather than relying on
        // setValues() + the `values` closure (which wouldn't reflect this
        // tag until the next render) - handleSubmit validates/saves
        // exactly what this Enter resolved to, with no stale read.
        setDropdownOpen(false);
        setHighlightedIndex(0);
        void handleSubmit(result.values);
        return;
      }
      // Steps 1/2 resolved a tag, but step 3's check found it's not
      // save-ready yet (or Part D's Expense-Head-still-needed case) -
      // apply the tag the same race-safe way selectSuggestion does.
      applyMatchTagsSafely(result.appliedMatch);
    }
    // else: no suggestion applied at all (free text) - values are
    // unchanged, validated/focused exactly as originally typed.

    // Step 4: not valid yet - redirect focus to whatever still needs
    // input, without a blocking error for a merely in-progress entry.
    requestAnimationFrame(() => {
      if (result.focus === 'amount') amountRef.current?.focus();
      else if (result.focus === 'expenseHead') expenseHeadRef.current?.focus();
      else if (result.focus === 'category') (isCashIn ? cashInTypeRef : categoryRef).current?.focus();
      // 'description' - stay put, nothing to redirect to.
    });
  }

  function handleDirectionChange(direction: Direction) {
    if (direction === values.direction) return;
    setDropdownOpen(false);
    setPendingExpenseHeadId(null);
    // Switching direction clears direction-specific selections (category/
    // expense-head/cash-in-type/staff/vehicle) but keeps description and
    // amount — the owner may have already typed those before realizing
    // they picked the wrong direction.
    setValues((v) => ({
      ...v,
      direction,
      categoryId: null,
      expenseHeadId: null,
      cashInTypeId: null,
      staffId: null,
      vehicleId: null,
    }));
  }

  // Phase 12f Part B: accepts an explicit `overrideValues` so
  // handleDescriptionEnter() can save the values a decision just resolved
  // to (already-tagged) without relying on the `values` closure, which
  // wouldn't reflect a same-Enter setValues() until the next render. Every
  // other caller (Amount/Category/ExpenseHead's own Enter, unchanged per
  // Part C) still calls this with no argument and gets the current state.
  async function handleSubmit(overrideValues?: FastEntryFieldValues) {
    // Phase 12f Part E: bail out immediately if a save from an earlier
    // Enter/keypress in this same burst is still in flight - checked
    // before anything else (even validation) so a rapid double-Enter or a
    // held-down Enter key can never reach addTransaction() twice.
    if (!saveGuardRef.current.tryStart()) return;

    const current = overrideValues ?? values;
    const result = validateFastEntry(current);
    setErrors(result.errors);
    if (!result.valid || result.amountPaisa == null) {
      if (result.errors.description) descriptionRef.current?.focus();
      else if (result.errors.amount) amountRef.current?.focus();
      else if (result.errors.category) (isCashIn ? cashInTypeRef : categoryRef).current?.focus();
      saveGuardRef.current.finish();
      return;
    }

    // Phase 12c Part C / Phase 3 Part A: calls staff.ts's
    // checkAdvanceLimit() directly - the SAME function StaffView.tsx's
    // Give Advance form calls - so the two entry paths can never drift
    // apart into two different rules. Runs on the Enter that actually
    // submits, never on the Enter that merely accepts a suggestion.
    //
    // Phase 3 Part A: advisory only now — `withinLimit: false` no longer
    // blocks the save (see checkAdvanceLimit's own doc comment in
    // lib/staff.ts). Computed BEFORE the save so the warning message can
    // still use the pre-save outstanding total; the save itself always
    // proceeds below regardless of the result.
    setAdvanceLimitWarning(null);
    let pendingAdvanceLimitWarning: string | null = null;
    if (
      current.direction === 'cash_out' &&
      current.staffId &&
      candidatePool &&
      isFastEntryAdvanceEntry(current, candidatePool.staffCategoryId, candidatePool.staffAdvanceExpenseHeadId)
    ) {
      const limitCheck = await checkAdvanceLimit(current.staffId, result.amountPaisa);
      if (!limitCheck.withinLimit) {
        const resultingOutstandingPaisa = limitCheck.currentOutstandingPaisa + result.amountPaisa;
        pendingAdvanceLimitWarning = tr(
          `यो सामान्य पेश्की सीमा ${formatPaisaAsRupees(limitCheck.limitPaisa)} भन्दा बढी हो। यो पेश्की पछि बाँकी रकम ${formatPaisaAsRupees(resultingOutstandingPaisa)} हुनेछ।`,
          `This exceeds the normal advance limit of ${formatPaisaAsRupees(limitCheck.limitPaisa)}. Outstanding after this advance will be ${formatPaisaAsRupees(resultingOutstandingPaisa)}.`,
        );
      }
    }

    setSaving(true);
    try {
      const input = buildFastEntryTransactionInput(current, date, result.amountPaisa);
      await addTransaction(input);
      resetForm();
      // Set AFTER resetForm() - resetForm() doesn't touch this state, but
      // ordering it last here keeps the "warning survives the reset"
      // behavior obviously intentional rather than incidental.
      if (pendingAdvanceLimitWarning) setAdvanceLimitWarning(pendingAdvanceLimitWarning);
    } catch (err) {
      if (overrideValues) setValues(overrideValues);
      setErrors({ description: err instanceof Error ? err.message : 'Something went wrong.' });
    } finally {
      setSaving(false);
      saveGuardRef.current.finish();
    }
  }

  function handleEscape() {
    const meaningful = countMeaningfulFields(values);
    if (meaningful >= 2 && !escPending) {
      setEscPending(true);
      if (escTimerRef.current) clearTimeout(escTimerRef.current);
      escTimerRef.current = setTimeout(() => setEscPending(false), ESC_CONFIRM_WINDOW_MS);
      return;
    }
    resetForm();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement;
    const isInMoreSection = target.dataset.fastEntrySection === 'more';
    const isDescriptionField = target === descriptionRef.current;
    const highlighted =
      showDropdown && isDescriptionField && suggestions ? suggestions[highlightedIndex] : undefined;

    // Phase 12b Part D: Arrow Down/Up move the highlighted suggestion
    // within the open dropdown without changing focus out of Description.
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && showDropdown && isDescriptionField) {
      e.preventDefault();
      const count = suggestions!.length;
      setHighlightedIndex((idx) => (e.key === 'ArrowDown' ? (idx + 1) % count : (idx - 1 + count) % count));
      return;
    }

    if (e.key === 'Enter') {
      // Phase 12f Part B: Description's Enter now runs through one
      // decision tree (resolveDescriptionEnter) instead of the old two
      // separate branches (dropdown-open-selects vs dropdown-closed-
      // saves) - an unambiguous match resolves AND saves in one Enter
      // when the entry is already save-ready as tagged.
      if (isDescriptionField) {
        e.preventDefault();
        handleDescriptionEnter(highlighted);
        return;
      }
      // Part C: Enter's behavior everywhere else (Amount, Category,
      // Expense Head, "+ more fields") is unchanged by this phase - it
      // still runs the same validateFastEntry()-gated save attempt below.
      // Native buttons (direction toggle, "+ more fields") already handle
      // their own Enter activation — don't hijack it into a save.
      if (target.tagName === 'BUTTON') return;
      if (isInMoreSection) {
        // Inside "+ more fields", Enter behaves like Tab (move to the next
        // field) rather than submitting — these are optional detail
        // fields, not the "type and go" primary flow.
        e.preventDefault();
        const focusable = Array.from(
          containerRef.current?.querySelectorAll<HTMLElement>(
            '[data-fast-entry-section="more"] input, [data-fast-entry-section="more"] select, [data-fast-entry-section="more"] textarea',
          ) ?? [],
        );
        const idx = focusable.indexOf(target);
        if (idx >= 0 && idx < focusable.length - 1) {
          focusable[idx + 1].focus();
        } else {
          descriptionRef.current?.focus();
        }
        return;
      }
      e.preventDefault();
      void handleSubmit();
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      // Phase 12b Part D: Escape's behavior now has two tiers — close JUST
      // the dropdown first if it's open, without touching Phase 12a's
      // whole-form clear/confirm logic; only fall through to that existing
      // handleEscape() once the dropdown is already closed.
      if (showDropdown) {
        setDropdownOpen(false);
        return;
      }
      handleEscape();
      return;
    }

    if (e.altKey && (e.key === 'i' || e.key === 'I')) {
      e.preventDefault();
      handleDirectionChange('cash_in');
      return;
    }
    if (e.altKey && (e.key === 'o' || e.key === 'O')) {
      e.preventDefault();
      handleDirectionChange('cash_out');
      return;
    }
    if (e.altKey && (e.key === 'm' || e.key === 'M')) {
      e.preventDefault();
      setMoreOpen((open) => !open);
      return;
    }

    if (e.key === 'Tab' && !e.shiftKey) {
      // Phase 12b Part D: Tab with a highlighted suggestion accepts it
      // (same effect as Enter-select) AND THEN proceeds to move focus to
      // Amount, matching 12a's existing Tab-advances behavior — so this is
      // deliberately NOT preventDefault()'d; the accept happens, then the
      // browser's natural Tab still advances focus in the same keystroke.
      if (highlighted) {
        selectSuggestion(highlighted);
      }
      // Phase 12d Part C: which field is "last" now depends on viewport, not
      // just moreOpen — Staff/Vehicle/Institution are always visible (and
      // tabbable) on desktop regardless of moreOpen, but stay behind the
      // toggle on mobile (see the fieldClass/visibility comment below). A
      // static moreOpen-only ternary can no longer say which field is last,
      // so this finds it directly: the last actually-visible (not
      // display:none'd) focusable element in the bar, in DOM order. This
      // stays correct automatically as the responsive layout changes
      // between mobile and desktop, instead of needing separate hardcoded
      // "last field" refs kept in sync with every future layout tweak.
      const focusableInBar = Array.from(
        containerRef.current?.querySelectorAll<HTMLElement>('input, select, textarea, button') ?? [],
      ).filter((el) => el.offsetParent !== null);
      const lastField = focusableInBar[focusableInBar.length - 1];
      if (target === lastField) {
        e.preventDefault();
        descriptionRef.current?.focus();
      }
    }
  }

  // Phase 12d Part D: py-2.5 on mobile / py-2 on desktop gives every field a
  // slightly taller, more comfortable touch target on a phone without
  // changing the compact desktop sizing from prior phases.
  const fieldClass =
    'w-full rounded-lg border px-3 py-2.5 sm:py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-400 transition-colors';
  const borderClass = (hasError: boolean) => (hasError ? 'border-brick-400' : 'border-line-300');

  return (
    <div
      ref={containerRef}
      onKeyDown={handleKeyDown}
      className="card p-3 sm:p-4 space-y-2.5 border-t-2 border-t-primary-600"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="panel-title">{tr('छिटो प्रविष्टि', 'Fast Entry')}</h2>
          <span className="hidden sm:inline text-[11px] text-ink-400">
            {tr('Enter=सुरक्षित · Tab=अर्को · Esc=रद्द', 'Enter Save · Tab Navigate · Esc Cancel')}
          </span>
        </div>
        <button
          type="button"
          onClick={() => onOpenDetailed(values.direction)}
          className="link-teal flex items-center gap-1"
        >
          <SlidersHorizontal size={12} />
          {tr('विस्तृत प्रविष्टि', 'Detailed entry')}
        </button>
      </div>

      {/* Phase 12d Part D: this row is a column on narrow/touch viewports —
          each control gets its own full-width line with larger tap targets
          — and reflows into the original dense single-line desktop layout
          at sm and up. DOM order is unchanged either way, so Tab order and
          every keyboard handler above keeps working identically; only the
          CSS layout (flex-direction, widths) differs by viewport. */}
      <div className="flex flex-col sm:flex-row gap-2 sm:items-start">
        <div className="flex flex-col sm:shrink-0">
          <div
            className="flex sm:inline-flex rounded-lg border border-line-300 overflow-hidden"
            role="group"
            aria-label={tr('दिशा', 'Direction')}
          >
            <button
              ref={cashInBtnRef}
              type="button"
              onClick={() => handleDirectionChange('cash_in')}
              className={`flex-1 sm:flex-none px-3 py-3 sm:py-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-500 ${
                isCashIn ? 'bg-teal-600 text-white' : 'bg-white text-ink-500 hover:bg-surface-muted'
              }`}
              aria-pressed={isCashIn}
            >
              {tr('नगद आम्दानी', 'Cash In')}
            </button>
            <button
              ref={cashOutBtnRef}
              type="button"
              onClick={() => handleDirectionChange('cash_out')}
              className={`flex-1 sm:flex-none px-3 py-3 sm:py-2 text-xs font-medium border-l border-line-300 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brick-500 ${
                !isCashIn ? 'bg-brick-600 text-white' : 'bg-white text-ink-500 hover:bg-surface-muted'
              }`}
              aria-pressed={!isCashIn}
            >
              {tr('नगद खर्च', 'Cash Out')}
            </button>
          </div>
          {/* Alt+I/Alt+O only mean anything with a physical keyboard, so the
              hint is desktop-only — showing it on a touch device would just
              be clutter with no corresponding shortcut to use (§39/Part E). */}
          <p className="hidden sm:block text-[10px] text-ink-400 mt-0.5 whitespace-nowrap">
            Alt+I / Alt+O
          </p>
        </div>

        <div className="w-full sm:flex-1 sm:min-w-0 relative">
          <input
            ref={descriptionRef}
            type="text"
            value={values.description}
            onChange={(e) => {
              setValues((v) => ({ ...v, description: e.target.value }));
              setDropdownOpen(true);
              setHighlightedIndex(0);
              // Phase 6: a stale AI answer for the PREVIOUS text must
              // never be shown as if it applies to what's typed now.
              setAiSuggestion(null);
              setAiStatus('idle');
              setAiStatusMessage(null);
            }}
            role="combobox"
            aria-expanded={showDropdown}
            aria-controls="fast-entry-suggestions"
            aria-autocomplete="list"
            placeholder={tr('विवरण', 'Description')}
            className={`${fieldClass} ${borderClass(!!errors.description)} ${canAskAi ? 'pr-16' : ''}`}
          />
          {/* Phase 6 constraint #3: this button is the ONLY way a Gemini
              call can fire - it only renders at all once Rules 1-5 have
              already found nothing/ambiguous for the CURRENT text, a key
              is configured, and the text is long enough. With no key
              configured, canAskAi is always false and this entire block
              doesn't render - zero new UI in the default/inert case. */}
          {canAskAi && (
            <button
              type="button"
              onClick={handleAskAi}
              disabled={aiStatus === 'loading'}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-1 rounded-md bg-primary-50 px-2 py-1 text-[11px] font-medium text-primary-700 hover:bg-primary-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300 disabled:opacity-60"
              title={tr(
                'गुगल जेमिनीलाई यो विवरणको लागि सुझाव सोध्नुहोस् (वैकल्पिक, नेटवर्क आवश्यक)',
                'Ask Google Gemini for a suggestion for this description (optional, needs network)',
              )}
            >
              <Sparkles size={12} className={aiStatus === 'loading' ? 'animate-pulse' : ''} />
              {aiStatus === 'loading' ? tr('सोध्दै…', 'Asking…') : tr('AI सोध्नुहोस्', 'Ask AI')}
            </button>
          )}
          {errors.description && (
            <p className="field-hint">{tr('विवरण आवश्यक छ।', 'Description is required.')}</p>
          )}
          {!errors.description && aiStatus === 'no-match' && (
            <p className="field-hint text-ink-400">
              {tr('AI ले कुनै भरपर्दो मिल्दोजुल्दो फेला पारेन।', 'AI found no confident match.')}
            </p>
          )}
          {!errors.description && aiStatus === 'unavailable' && (
            <p className="field-hint text-ink-400">
              {tr('AI सुझाव उपलब्ध छैन।', 'AI suggestion unavailable.')}
              {aiStatusMessage ? ` (${aiStatusMessage})` : ''}
            </p>
          )}
          {showDropdown && (
            <ul
              id="fast-entry-suggestions"
              role="listbox"
              className="dropdown-pop absolute z-10 mt-1 w-full max-h-56 overflow-auto thin-scroll rounded-lg border border-line-200 bg-white text-sm shadow-lg"
            >
              {suggestions!.map((s, idx) => (
                <li
                  key={`${s.description}-${idx}-${s.source ?? 'rule'}`}
                  role="option"
                  aria-selected={idx === highlightedIndex}
                  // onMouseDown (not onClick) fires before the input blurs,
                  // so the selection lands before focus would otherwise move.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    selectSuggestion(s);
                  }}
                  onMouseEnter={() => setHighlightedIndex(idx)}
                  className={`cursor-pointer px-3 py-2.5 sm:py-1.5 transition-colors duration-100 flex items-center gap-1.5 border-l-2 ${
                    idx === highlightedIndex
                      ? 'bg-primary-50 text-primary-800 border-l-primary-400'
                      : 'text-ink-700 border-l-transparent hover:bg-surface-muted'
                  }`}
                >
                  {/* Phase 6 constraint #4: visually distinguish an
                      AI-sourced suggestion from a deterministic one, so
                      the owner always knows which kind of match this is -
                      selection itself (selectSuggestion above) treats
                      both identically otherwise. */}
                  {s.source === 'ai' && (
                    <span
                      className="inline-flex items-center gap-0.5 rounded bg-primary-100 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-primary-700 shrink-0"
                      title={tr('गुगल जेमिनीको सुझाव', 'Suggested by Google Gemini')}
                    >
                      <Sparkles size={9} /> AI
                    </span>
                  )}
                  <span className="truncate">{s.label}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Amount + Category/Cash-In-Type are paired into one row on
            mobile (grid-cols-2) to keep the touch layout from turning into
            a long column of full-width fields; `sm:contents` makes this
            wrapper disappear at desktop widths so each child goes back to
            being its own flex item with its original fixed width, exactly
            like the pre-12d layout. */}
        <div className="grid grid-cols-2 gap-2 sm:contents">
          <div className="sm:w-28 sm:shrink-0">
            <input
              ref={amountRef}
              type="text"
              inputMode="decimal"
              value={values.amountInput}
              onChange={(e) => setValues((v) => ({ ...v, amountInput: e.target.value }))}
              placeholder={tr('रकम', 'Amount')}
              className={`${fieldClass} ${borderClass(!!errors.amount)}`}
            />
            {errors.amount && <p className="field-hint">{tr('शून्यभन्दा बढी रकम राख्नुहोस्।', 'Enter an amount greater than zero.')}</p>}
          </div>

          <div className="sm:w-36 sm:shrink-0">
            {isCashIn ? (
              <select
                ref={cashInTypeRef}
                value={values.cashInTypeId ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, cashInTypeId: e.target.value }))}
                className={`${fieldClass} ${borderClass(!!errors.category)}`}
              >
                {(cashInTypes ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            ) : (
              <select
                ref={categoryRef}
                value={values.categoryId ?? ''}
                onChange={(e) => {
                  setPendingExpenseHeadId(null);
                  setValues((v) => ({ ...v, categoryId: e.target.value }));
                }}
                className={`${fieldClass} ${borderClass(!!errors.category)}`}
              >
                {(categories ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
            {errors.category && (
              <p className="field-hint">
                {isCashIn
                  ? tr('स्रोत छान्नुहोस्।', 'Select a source.')
                  : tr('वर्ग छान्नुहोस्।', 'Select a category.')}
              </p>
            )}
          </div>
        </div>

        {showExpenseHead && (
          <div className="w-full sm:w-36 sm:shrink-0">
            <select
              ref={expenseHeadRef}
              value={values.expenseHeadId ?? ''}
              onChange={(e) =>
                setValues((v) => ({
                  ...v,
                  expenseHeadId: e.target.value === '' ? null : e.target.value,
                }))
              }
              className={`${fieldClass} border-line-300`}
            >
              <option value="">{tr('खर्च शीर्षक', 'Expense head')}</option>
              {(expenseHeads ?? []).map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <button
          ref={moreToggleRef}
          type="button"
          onClick={() => setMoreOpen((open) => !open)}
          className="w-full sm:w-auto shrink-0 rounded-lg text-xs font-medium text-ink-500 hover:text-ink-700 hover:bg-surface-muted px-2 py-2.5 sm:py-2 text-center sm:text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
        >
          {moreOpen ? tr('− कम फिल्ड', '− fewer fields') : tr('+ थप फिल्ड', '+ more fields')}
        </button>
      </div>

      {/*
        Phase 12d Part C decision: now that Institution/Staff/Vehicle
        auto-expand on suggestion accept (12c), gating them behind a manual
        toggle no longer earns its keystroke on DESKTOP — they move into
        the primary layout there, always visible, still empty/optional when
        not applicable. This section stays ALWAYS MOUNTED (never
        conditionally removed from the DOM) so its refs/data-attributes are
        stable; only its CSS visibility differs:
          - sm and up (desktop): always shown (`sm:grid`), independent of
            moreOpen — this is the "move into the primary layout" decision.
          - below sm (mobile/touch): still gated behind "+ more fields"
            (`hidden` unless moreOpen) — Part D's call that screen space is
            tighter on a phone than on desktop, so these three stay
            collapsed by default there, same as before 12d.
        Reference/Notes are lower-frequency fields with no auto-fill tied to
        them, so they keep the simple "behind the toggle on every viewport"
        treatment in the separate block below — Part C's decision is scoped
        to Institution/Staff/Vehicle specifically, not everything that used
        to live in "+ more fields".
        Because this section is never removed from the DOM, Alt+M is NOT
        dead on desktop: it still reveals/hides Reference+Notes there, and
        keeps its full original job on mobile. No shortcut needed removing.
      */}
      <div
        className={`${moreOpen ? 'grid grid-cols-1' : 'hidden sm:grid'} ${
          isCashIn ? 'sm:grid-cols-1' : 'sm:grid-cols-3'
        } gap-2 pt-2 mt-1 border-t border-line-100`}
      >
        {!isCashIn && (
          <>
            <select
              ref={staffRef}
              data-fast-entry-section="more"
              value={values.staffId ?? ''}
              onChange={async (e) => {
                const newStaffId = e.target.value === '' ? null : e.target.value;
                // Phase 12c Part B: reuse Phase 5's exact staff→vehicle
                // assignment rule (resolveAssignedVehicleId, also used by
                // TransactionFormModal.tsx) - not a separate/new
                // vehicle-suggestion mechanism. Mirrors that component's
                // handleStaffChange exactly: only touches Vehicle when
                // there IS an assignment, otherwise leaves it as-is.
                //
                // Phase 2: resolveAssignedVehicleId now reads the
                // StaffVehicle join table (async) and only ever suggests
                // when the staff member has EXACTLY one assigned vehicle
                // - with zero or 2+, it returns null and this deliberately
                // does nothing further, leaving the Vehicle select below
                // (always visible in this "more fields" section) as the
                // ask-don't-guess picker the EXACT SCOPE calls for.
                const assignedVehicleId = await resolveAssignedVehicleId(newStaffId);
                setValues((v) => ({
                  ...v,
                  staffId: newStaffId,
                  ...(assignedVehicleId != null ? { vehicleId: assignedVehicleId } : {}),
                }));
              }}
              className={`${fieldClass} border-line-300`}
            >
              <option value="">{tr('कर्मचारी', 'Staff')}</option>
              {(activeStaff ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>

            <select
              data-fast-entry-section="more"
              value={values.vehicleId ?? ''}
              onChange={(e) =>
                setValues((v) => ({
                  ...v,
                  vehicleId: e.target.value === '' ? null : e.target.value,
                }))
              }
              className={`${fieldClass} border-line-300`}
            >
              <option value="">{tr('सवारी साधन', 'Vehicle')}</option>
              {(activeVehicles ?? []).map((veh) => (
                <option key={veh.id} value={veh.id}>
                  {veh.name}
                </option>
              ))}
            </select>
          </>
        )}

        <div>
          <select
            ref={institutionRef}
            data-fast-entry-section="more"
            value={values.institutionId ?? ''}
            onChange={(e) =>
              setValues((v) => ({
                ...v,
                institutionId: e.target.value === '' ? null : e.target.value,
              }))
            }
            className={`${fieldClass} border-line-300`}
          >
            <option value="">{tr('संस्था', 'Institution')}</option>
            {(activeInstitutions ?? []).map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
          {values.institutionId && (
            // Phase 12c Part A: a plain label clarifying what the
            // existing direction+institution combination already means
            // (cash_out = Deposit, cash_in = Withdrawal) - not new
            // business logic, just making that established convention
            // visible so the owner has a clear confirmation before saving.
            <p className="text-[11px] text-ink-500 mt-0.5">
              {values.direction === 'cash_out' ? tr('जम्मा — ', 'Deposit into ') : tr('झिक्ने — ', 'Withdrawal from ')}
              {(activeInstitutions ?? []).find((i) => i.id === values.institutionId)?.name ?? ''}
            </p>
          )}
        </div>
      </div>

      {moreOpen && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
          <input
            data-fast-entry-section="more"
            type="text"
            value={values.referenceNumber}
            onChange={(e) => setValues((v) => ({ ...v, referenceNumber: e.target.value }))}
            placeholder={tr('सन्दर्भ', 'Reference')}
            className={`${fieldClass} border-line-300`}
          />

          <textarea
            ref={notesRef}
            data-fast-entry-section="more"
            value={values.notes}
            onChange={(e) => setValues((v) => ({ ...v, notes: e.target.value }))}
            placeholder={tr('टिप्पणी', 'Notes')}
            rows={1}
            className={`${fieldClass} border-line-300 resize-none`}
          />
        </div>
      )}

      {escPending && (
        <p className="text-[11px] text-amber-700">{tr('यो प्रविष्टि खाली गर्न फेरि Esc थिच्नुहोस्।', 'Press Esc again to clear this entry.')}</p>
      )}
      {/*
        Phase 3 Part A: non-blocking advance-limit warning. Kept visible
        after the save (see the state's own comment above) rather than
        auto-dismissing, and given its own icon+row (rather than folded
        into the escPending line's plain text) precisely because it must
        never be silent or easy to miss — the amber tone matches
        DashboardView.tsx's alert banner (recolored from that banner's
        brick/error tone since this is advisory, not a hard block).
      */}
      {advanceLimitWarning && (
        <div className="banner banner-warning items-start py-1.5 px-2">
          <AlertTriangle size={13} className="text-amber-600 shrink-0 mt-0.5" />
          <p className="text-[11px] text-amber-700">{advanceLimitWarning}</p>
        </div>
      )}
      {saving && <p className="text-[11px] text-ink-400">{tr('सुरक्षित हुँदैछ…', 'Saving…')}</p>}
    </div>
  );
}
