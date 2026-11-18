// All ledger dates are stored/compared as plain 'YYYY-MM-DD' strings so
// lexical ordering matches chronological ordering and there's never a
// timezone-conversion bug in balance calculations.

export function todayISO(): string {
  return toISODate(new Date());
}

export function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function addDaysISO(dateISO: string, days: number): string {
  const [y, m, d] = dateISO.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + days);
  return toISODate(date);
}

// v1.0 Nepali BS Edition: this is the single function nearly every screen
// in the app calls to turn an internal ISO/Gregorian date into what the
// user actually sees — so making it BS-first here is what makes BS the
// primary user-facing date "everywhere" (Dashboard, Daily Ledger, Fast
// Entry, transaction lists, diaries, reports, staff/vehicle/institution
// history, search, settings) without having to touch every call site
// individually. The internal ISO date this function receives is
// completely unchanged — see lib/bsCalendar.ts for the real BS<->AD
// conversion this wraps, and lib/ledger.ts (untouched) for why the
// internal architecture staying ISO/Gregorian matters for the balance
// cascade and Firebase sync.
import { formatAdIsoAsBS } from './bsCalendar';

const WEEKDAYS_NE = ['आइतबार', 'सोमबार', 'मंगलबार', 'बुधबार', 'बिहीबार', 'शुक्रबार', 'शनिबार'];

export function formatDateDisplay(dateISO: string): string {
  const [y, m, d] = dateISO.split('-').map(Number);
  const weekday = WEEKDAYS_NE[new Date(y, m - 1, d).getDay()];
  return formatAdIsoAsBS(dateISO, { weekday });
}

/** The BS date only, no weekday — for compact contexts (table cells, inline history rows) where a full weekday-prefixed string is too long. */
export function formatDateCompact(dateISO: string): string {
  return formatAdIsoAsBS(dateISO);
}

/** Format an epoch-ms timestamp as a short clock time, e.g. "9:41 AM" — used
 * by the transaction list (Phase 12d) to show when an entry was recorded. */
export function formatTimeDisplay(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });
}
