// Bikram Sambat (BS) calendar layer — Nepali BS Edition.
//
// This module is the ONLY place in the app that knows how to convert
// between the internal Gregorian/ISO date architecture (unchanged —
// see lib/dates.ts, lib/ledger.ts) and the Nepali BS calendar the user
// actually sees. Every other file that needs a BS date goes through
// here rather than doing its own math, so there is exactly one place
// that could get the calendar wrong.
//
// CONVERSION SOURCE: `nepali-date-converter` (npm), a mature,
// dependency-free, actively-maintained library built on a real
// year-by-year BS month-length reference table (`dateConfigMap`,
// covering BS 2000–2090 — see isBsYearSupported below) — NOT a fixed
// 30-day-per-month assumption. Verified empirically before adoption:
// zero mismatches round-tripping AD -> BS -> AD across every single day
// from 2020-01-01 to 2032-01-01 (4,383 days), and identical results
// under UTC, Asia/Kathmandu, and America/Los_Angeles system timezones
// (see the "local midnight" note on jsDateFromIsoLocal below for why
// timezone can't leak into the conversion).
//
// This file deliberately does NOT reuse the library's own Nepali month
// names/formatting — it has its own English transliterations baked in
// (e.g. "Bhadra") that don't match the exact Nepali spellings this app
// uses (e.g. भदौ, not भाद्र). BS_MONTH_NAMES_NE below is this app's own
// single source of truth for month-name spelling, used everywhere a BS
// month name is displayed.

// `nepali-date-converter` ships as a UMD/CJS build with no `exports` map,
// so its `import Default from ...` interop is genuinely inconsistent
// across bundlers/runtimes — verified empirically (see this file's
// header comment) that under this project's test runner (tsx) the
// default export can come back wrapped in one, two, or three extra
// `.default` layers depending on the exact import syntax used, rather
// than a single predictable shape. Rather than hardcode an unwrap depth
// that might silently break the next time a bundler's interop behaves
// differently (e.g. the actual Vite browser build), this drills through
// however many `.default` layers exist until it finds the real class —
// identified by its own `fromAD` static method actually being callable,
// not by assuming a wrapper count — and throws a clear, loud error
// instead of a confusing downstream TypeError if the module's shape is
// ever genuinely unrecognizable.
import * as NepaliDateModule from 'nepali-date-converter';

type NepaliDateCtor = typeof import('nepali-date-converter').default;

function resolveNepaliDateClass(mod: unknown): NepaliDateCtor {
  let candidate = mod as { fromAD?: unknown; default?: unknown } | undefined;
  for (let i = 0; i < 5 && candidate && typeof candidate.fromAD !== 'function'; i++) {
    candidate = candidate.default as typeof candidate;
  }
  if (!candidate || typeof candidate.fromAD !== 'function') {
    throw new Error(
      'bsCalendar.ts: could not resolve the NepaliDate class from the nepali-date-converter module — its export shape may have changed.',
    );
  }
  return candidate as unknown as NepaliDateCtor;
}

const NepaliDate = resolveNepaliDateClass(NepaliDateModule);

function resolveDateConfigMap(mod: unknown): typeof import('nepali-date-converter').dateConfigMap {
  let candidate = mod as { dateConfigMap?: unknown; default?: unknown } | undefined;
  for (let i = 0; i < 5 && candidate && candidate.dateConfigMap == null; i++) {
    candidate = candidate.default as typeof candidate;
  }
  if (!candidate?.dateConfigMap) {
    throw new Error(
      'bsCalendar.ts: could not resolve dateConfigMap from the nepali-date-converter module — its export shape may have changed.',
    );
  }
  return candidate.dateConfigMap as typeof import('nepali-date-converter').dateConfigMap;
}

const dateConfigMap = resolveDateConfigMap(NepaliDateModule);

/** Index 0 = बैशाख (Baisakh, BS month 1) ... index 11 = चैत (Chaitra, BS month 12). */
export const BS_MONTH_NAMES_NE = [
  'बैशाख',
  'जेठ',
  'असार',
  'साउन',
  'भदौ',
  'असोज',
  'कात्तिक',
  'मंसिर',
  'पुष',
  'माघ',
  'फागुन',
  'चैत',
] as const;

/** Same months, English transliteration — used only for non-Nepali contexts (e.g. CSV/Excel export's second "BS Date" column, log/debug text). */
export const BS_MONTH_NAMES_EN = [
  'Baisakh',
  'Jestha',
  'Asar',
  'Shrawan',
  'Bhadra',
  'Aswin',
  'Kartik',
  'Mangsir',
  'Poush',
  'Magh',
  'Falgun',
  'Chaitra',
] as const;

/** The exact keys `dateConfigMap` uses per year — same order as the arrays above. */
const CONFIG_MONTH_KEYS = [
  'Baisakh',
  'Jestha',
  'Asar',
  'Shrawan',
  'Bhadra',
  'Aswin',
  'Kartik',
  'Mangsir',
  'Poush',
  'Magh',
  'Falgun',
  'Chaitra',
] as const;

export interface BSDate {
  year: number;
  /** 1-12, Baisakh = 1 (human-facing — NOT the library's own 0-11 index). */
  month: number;
  /** 1-32. */
  day: number;
}

const MIN_BS_YEAR = 2000;
const MAX_BS_YEAR = 2090;

/** Whether `dateConfigMap` has real data for this BS year — see "Known limitations" in the README before assuming a year outside this range works. */
export function isBsYearSupported(year: number): boolean {
  return year >= MIN_BS_YEAR && year <= MAX_BS_YEAR && dateConfigMap[String(year)] != null;
}

/**
 * How many days BS `month` (1-12) actually has in BS `year` — read
 * directly from the library's real reference table, never assumed.
 * Nepali month lengths vary year to year (e.g. Asar has had both 31 and
 * 32 days across recent BS years) — this is exactly the data §the brief
 * warned against hardcoding.
 */
export function daysInBsMonth(year: number, month: number): number {
  const row = dateConfigMap[String(year)];
  if (!row) {
    throw new RangeError(
      `BS year ${year} is outside the supported calendar range (${MIN_BS_YEAR}-${MAX_BS_YEAR}).`,
    );
  }
  return row[CONFIG_MONTH_KEYS[month - 1]];
}

/**
 * Build a JS Date representing local midnight on this Y/M/D — deliberately
 * NOT `new Date(isoString)` (which parses as UTC midnight and can land on
 * the wrong local calendar day depending on the browser's timezone).
 * `nepali-date-converter` reads a JS Date's LOCAL getters internally, so
 * constructing via the local-time constructor and reading back via local
 * getters is what makes the whole round trip timezone-independent — this
 * was verified empirically (see this file's header comment) rather than
 * assumed.
 */
function jsDateFromIsoLocal(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Convert an internal ISO ('YYYY-MM-DD', Gregorian) date to BS. Throws RangeError outside the supported BS year range. */
export function adIsoToBS(iso: string): BSDate {
  const bs = NepaliDate.fromAD(jsDateFromIsoLocal(iso)).getBS();
  if (!isBsYearSupported(bs.year)) {
    throw new RangeError(
      `${iso} converts to BS year ${bs.year}, outside the supported range (${MIN_BS_YEAR}-${MAX_BS_YEAR}).`,
    );
  }
  return { year: bs.year, month: bs.month + 1, day: bs.date };
}

/** Convert a BS date to the internal ISO ('YYYY-MM-DD', Gregorian) date. Throws RangeError outside the supported BS year range. */
export function bsToAdIso(bs: BSDate): string {
  if (!isBsYearSupported(bs.year)) {
    throw new RangeError(
      `BS year ${bs.year} is outside the supported calendar range (${MIN_BS_YEAR}-${MAX_BS_YEAR}).`,
    );
  }
  const ad = new NepaliDate(bs.year, bs.month - 1, bs.day).getAD();
  return `${ad.year}-${pad2(ad.month + 1)}-${pad2(ad.date)}`;
}

/** Today's date, in BS. */
export function todayBS(): BSDate {
  const bs = NepaliDate.now().getBS();
  return { year: bs.year, month: bs.month + 1, day: bs.date };
}

// ---- Digits ----

const NEPALI_DIGITS = ['०', '१', '२', '३', '४', '५', '६', '७', '८', '९'];

/** "2083" -> "२०८३". Only touches ASCII digits — safe to call on already-Nepali or mixed text. */
export function toNepaliDigits(value: number | string): string {
  return String(value).replace(/[0-9]/g, (ch) => NEPALI_DIGITS[Number(ch)]);
}

// ---- Formatting ----

export function bsMonthName(month: number, lang: 'ne' | 'en' = 'ne'): string {
  const names = lang === 'ne' ? BS_MONTH_NAMES_NE : BS_MONTH_NAMES_EN;
  return names[month - 1] ?? '';
}

/**
 * "२०८३ साउन ४" — the app's standard full BS date display. Used
 * everywhere a date is shown to the user (Dashboard, Daily Ledger,
 * transaction lists, Staff/Vehicle/Institution history, Reports, Search,
 * Settings). Nepali digits by default per §18 — pass `digits: 'en'` for
 * the rare place ASCII digits are actually wanted (e.g. inside a CSV/
 * Excel export cell, so spreadsheet software still sorts/filters it as
 * expected).
 */
export function formatBSDate(
  bs: BSDate,
  opts: { digits?: 'ne' | 'en'; weekday?: string } = {},
): string {
  const { digits = 'ne' } = opts;
  const year = digits === 'ne' ? toNepaliDigits(bs.year) : String(bs.year);
  const day = digits === 'ne' ? toNepaliDigits(bs.day) : String(bs.day);
  const month = bsMonthName(bs.month, digits === 'ne' ? 'ne' : 'en');
  const weekdayPart = opts.weekday ? `${opts.weekday}, ` : '';
  return `${weekdayPart}${year} ${month} ${day}`;
}

/** Convenience: ISO date straight to the standard BS display string. */
export function formatAdIsoAsBS(iso: string, opts?: { digits?: 'ne' | 'en'; weekday?: string }): string {
  return formatBSDate(adIsoToBS(iso), opts);
}

/** "2083-04" — an internal (ASCII, non-display) BS year-month key, for grouping/lookup maps. Not for UI text — use formatBSDate/bsMonthName for that. */
export function bsMonthKey(bs: { year: number; month: number }): string {
  return `${bs.year}-${pad2(bs.month)}`;
}

// ---- Period arithmetic (used by lib/aggregation.ts's reporting engine) ----

export interface BSMonthSpec {
  year: number;
  /** 1-12. */
  month: number;
}

/** The BS month immediately before `spec` — wraps बैशाख back to the previous BS year's चैत, never a fixed "-1 Gregorian month" subtraction. */
export function previousBsMonth(spec: BSMonthSpec): BSMonthSpec {
  return spec.month === 1 ? { year: spec.year - 1, month: 12 } : { year: spec.year, month: spec.month - 1 };
}

/** The BS month immediately after `spec` — wraps चैत forward into next BS year's बैशाख. */
export function nextBsMonth(spec: BSMonthSpec): BSMonthSpec {
  return spec.month === 12 ? { year: spec.year + 1, month: 1 } : { year: spec.year, month: spec.month + 1 };
}

/** [start ISO, end ISO] (inclusive) spanning every day of this real BS month — end is `daysInBsMonth`, not an assumed 30. */
export function bsMonthRangeIso(spec: BSMonthSpec): { from: string; to: string } {
  const from = bsToAdIso({ year: spec.year, month: spec.month, day: 1 });
  const lastDay = daysInBsMonth(spec.year, spec.month);
  const to = bsToAdIso({ year: spec.year, month: spec.month, day: lastDay });
  return { from, to };
}

/** ISO date of बैशाख १ (BS New Year's Day) for `year` — the BS reporting-year start used for every "YTD" calculation in the app. */
export function bsYearStartIso(year: number): string {
  return bsToAdIso({ year, month: 1, day: 1 });
}

/** The last `n` BS months up to and including the BS month `now` falls in — oldest first. BS equivalent of "last N calendar months". */
export function lastNBsMonths(n: number, now: BSMonthSpec): BSMonthSpec[] {
  const specs: BSMonthSpec[] = [];
  let cursor: BSMonthSpec = { year: now.year, month: now.month };
  for (let i = 0; i < n; i++) {
    specs.unshift(cursor);
    cursor = previousBsMonth(cursor);
  }
  return specs;
}
