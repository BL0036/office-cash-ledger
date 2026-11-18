import { useEffect } from 'react';

/**
 * Shared "Escape closes this" behavior, previously copy-pasted as an
 * identical `useEffect` in 9 modal/drawer components (InstitutionsView x2,
 * TransactionFormModal, StaffView x5, VehiclesView) plus two near-identical
 * variants with their own extra guard condition (App.tsx's mobile nav
 * drawer, DateNav.tsx's date picker popover). Consolidated here in the
 * redesign Step 3 "global shell" pass — behavior is unchanged, this is a
 * pure extraction: same event ('keydown'), same key check ('Escape'), same
 * listener attach/cleanup on window.
 *
 * `enabled` defaults to true (the 9 always-mounted-while-open modal call
 * sites don't need a guard). Pass `enabled={false}` while the thing this
 * would close isn't actually open, to skip attaching the listener — this
 * is what App.tsx (mobileNavOpen) and DateNav.tsx (pickerOpen) need, and
 * is exactly equivalent to their prior early `if (!x) return;` guard.
 */
export function useEscapeToClose(onClose: () => void, enabled: boolean = true) {
  useEffect(() => {
    if (!enabled) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, enabled]);
}
