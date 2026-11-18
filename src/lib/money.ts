// Money is always stored and summed as an integer number of paisa.
// Rupee strings only ever exist at the UI boundary (display formatting and
// parsing raw form input) — never in calculation code.

import { toNepaliDigits } from './bsCalendar';

/**
 * Format integer paisa as a display string, e.g. 2048000 -> "रु २०,४८०".
 *
 * v1.0 Nepali BS Edition (§17/§18): one consistent Nepali-office currency
 * convention throughout the app — "रु" (no period, matching the brief's
 * own examples), Nepali digits, Indian/Nepali-style lakh/crore digit
 * grouping (unchanged from before — 'en-IN' already produced this
 * grouping; only the digits and prefix changed). Paisa (decimal) only
 * shows when the amount actually has a fractional-rupee component —
 * every brief example is a whole-rupee amount ("रु ५,०००"), but a real
 * half-rupee transaction, however rare in practice, must never be
 * silently rounded away from the display.
 */
export function formatPaisaAsRupees(paisa: number): string {
  const rupees = paisa / 100;
  const hasFraction = paisa % 100 !== 0;
  const formatted = rupees.toLocaleString('en-IN', {
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: 2,
  });
  return `रु ${toNepaliDigits(formatted)}`;
}

/**
 * Parse a raw rupee input string (from a form field, e.g. "2048.5" or
 * "2,048.50") into an integer number of paisa. Returns null if the input
 * isn't a valid non-negative number.
 */
export function parseRupeeInputToPaisa(input: string): number | null {
  const cleaned = input.replace(/,/g, '').trim();
  if (cleaned === '') return null;
  const rupees = Number(cleaned);
  if (!Number.isFinite(rupees) || rupees < 0) return null;
  return Math.round(rupees * 100);
}
