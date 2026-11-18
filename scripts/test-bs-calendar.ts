// v1.0 Nepali BS Edition — dedicated Bikram Sambat calendar tests (spec
// §26, cases A-I). Standalone, headless (fake-indexeddb) verification,
// same pattern as the other scripts/test-*.ts files.
//
// Usage: npx tsx scripts/test-bs-calendar.ts

import 'fake-indexeddb/auto';
import { db, seedReferenceData } from '../src/db/schema';
import { addTransaction } from '../src/lib/ledger';
import { toISODate, addDaysISO } from '../src/lib/dates';
import {
  adIsoToBS,
  bsToAdIso,
  daysInBsMonth,
  bsYearStartIso,
  previousBsMonth,
  nextBsMonth,
  isBsYearSupported,
  formatBSDate,
  toNepaliDigits,
  type BSDate,
} from '../src/lib/bsCalendar';
import { monthlyDateRanges, lastNMonthsSpec, getExpenseHeadTotals } from '../src/lib/aggregation';
import { addExpenseHead } from '../src/lib/referenceData';

let passed = 0;
let failed = 0;

function assertEqual(label: string, actual: unknown, expected: unknown) {
  const ok = actual === expected;
  if (ok) {
    passed++;
    console.log(`  PASS  ${label} (${JSON.stringify(actual)})`);
  } else {
    failed++;
    console.log(`  FAIL  ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertTrue(label: string, actual: boolean) {
  assertEqual(label, actual, true);
}

function bsEq(a: BSDate, b: BSDate): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

async function main() {
  await seedReferenceData();

  // ===================================================================
  // Test A — BS year start: बैशाख १ is correctly recognized as day 1 of
  // the BS year (month 1, day 1), and its Gregorian date is the
  // real, known Nepali New Year's Day (not an assumed fixed date —
  // Baisakh 1 actually falls on a different Gregorian date most years,
  // typically April 13 or 14).
  // ===================================================================
  console.log('\nTest A: BS year start (बैशाख १)');
  const baisakh1_2083 = adIsoToBS('2026-04-14');
  assertEqual('2026-04-14 is BS year 2083', baisakh1_2083.year, 2083);
  assertEqual('2026-04-14 is BS month 1 (बैशाख)', baisakh1_2083.month, 1);
  assertEqual('2026-04-14 is BS day 1', baisakh1_2083.day, 1);
  assertEqual('bsYearStartIso(2083) round-trips back to 2026-04-14', bsYearStartIso(2083), '2026-04-14');
  // A second, independently-known Baisakh 1 (2082 -> mid-April 2025), to
  // prove this isn't a coincidence of one specific year.
  const baisakh1_2082 = adIsoToBS(bsYearStartIso(2082));
  assertTrue('bsYearStartIso(2082) really does convert back to BS Baisakh 1', bsEq(baisakh1_2082, { year: 2082, month: 1, day: 1 }));

  // ===================================================================
  // Test B — month transition: the final day of बैशाख rolls into जेठ १,
  // using the REAL day count for that specific BS year (read from the
  // library's table, not assumed as 30 or 31).
  // ===================================================================
  console.log('\nTest B: Month transition (बैशाख final day -> जेठ १)');
  const baisakhDays2083 = daysInBsMonth(2083, 1);
  assertTrue('BS 2083 बैशाख has a real, specific day count (29-32), not a hardcoded 30', baisakhDays2083 >= 29 && baisakhDays2083 <= 32);
  const baisakhLastDayIso = bsToAdIso({ year: 2083, month: 1, day: baisakhDays2083 });
  const jesthaFirstIso = addDaysISO(baisakhLastDayIso, 1);
  const jesthaFirst = adIsoToBS(jesthaFirstIso);
  assertTrue(
    `बैशाख ${baisakhDays2083} (its real last day) + 1 day = जेठ १`,
    bsEq(jesthaFirst, { year: 2083, month: 2, day: 1 }),
  );

  // ===================================================================
  // Test C — year transition: the final day of चैत rolls into next BS
  // year's बैशाख १.
  // ===================================================================
  console.log('\nTest C: Year transition (चैत final day -> next year बैशाख १)');
  const chaitraDays2082 = daysInBsMonth(2082, 12);
  const chaitraLastDayIso = bsToAdIso({ year: 2082, month: 12, day: chaitraDays2082 });
  const nextNewYearIso = addDaysISO(chaitraLastDayIso, 1);
  const nextNewYear = adIsoToBS(nextNewYearIso);
  assertTrue(
    `2082 चैत ${chaitraDays2082} (its real last day) + 1 day = 2083 बैशाख १`,
    bsEq(nextNewYear, { year: 2083, month: 1, day: 1 }),
  );
  assertEqual('That date is the same one Test A already confirmed independently', nextNewYearIso, '2026-04-14');

  // ===================================================================
  // Test D — reverse conversion: BS -> AD -> BS returns the original BS
  // date, for every day across several representative years (not just
  // one hand-picked date) — including BS 2083 Asar, which Test B/§26
  // deliberately exercises because it's a 32-day month this year (see
  // bsCalendar.ts's header comment on why this matters).
  // ===================================================================
  console.log('\nTest D: Reverse conversion (BS -> AD -> BS)');
  let roundTripMismatches = 0;
  let roundTripChecked = 0;
  for (const year of [2080, 2081, 2082, 2083, 2084, 2085]) {
    for (let month = 1; month <= 12; month++) {
      const days = daysInBsMonth(year, month);
      for (const day of [1, Math.ceil(days / 2), days]) {
        const original: BSDate = { year, month, day };
        const iso = bsToAdIso(original);
        const back = adIsoToBS(iso);
        roundTripChecked++;
        if (!bsEq(original, back)) roundTripMismatches++;
      }
    }
  }
  assertEqual(`All ${roundTripChecked} spot-checked BS dates (2080-2085, first/middle/last day of every month) round-trip exactly`, roundTripMismatches, 0);

  // ===================================================================
  // Test E — transaction grouping: transactions entered on different BS
  // months appear in the correct BS monthly reports, even when their AD
  // dates fall in the SAME Gregorian month (proving grouping is real BS
  // grouping, not Gregorian grouping relabeled) — 2026-04-10 (BS Chaitra,
  // still 2082) and 2026-04-20 (BS Baisakh, already 2083) are both in AD
  // April 2026, but different BS years/months entirely.
  // ===================================================================
  console.log('\nTest E: Transaction grouping by real BS month (not Gregorian month)');
  const groupingHeadId = await addExpenseHead((await db.categories.toArray())[0].id!, 'BS Grouping Test Head');
  const chaitraSideIso = '2026-04-10';
  const baisakhSideIso = '2026-04-20';
  const chaitraSideBS = adIsoToBS(chaitraSideIso);
  const baisakhSideBS = adIsoToBS(baisakhSideIso);
  assertTrue(
    'Sanity: both dates are in the same Gregorian month (April 2026)',
    chaitraSideIso.slice(0, 7) === baisakhSideIso.slice(0, 7),
  );
  assertTrue(
    'But they are in different BS months/years (चैत 2082 vs बैशाख 2083)',
    chaitraSideBS.year !== baisakhSideBS.year || chaitraSideBS.month !== baisakhSideBS.month,
  );
  await addTransaction({
    date: chaitraSideIso,
    direction: 'cash_out',
    amountPaisa: 111_00,
    categoryId: (await db.categories.toArray())[0].id!,
    expenseHeadId: groupingHeadId,
    cashInTypeId: null,
    description: 'चैत-side entry',
    staffId: null,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  await addTransaction({
    date: baisakhSideIso,
    direction: 'cash_out',
    amountPaisa: 222_00,
    categoryId: (await db.categories.toArray())[0].id!,
    expenseHeadId: groupingHeadId,
    cashInTypeId: null,
    description: 'बैशाख-side entry',
    staffId: null,
    vehicleId: null,
    institutionId: null,
    referenceNumber: null,
    notes: null,
    linkedAdvanceRecoveryPaisa: null,
  });
  const groupingSeries = await lastNMonthsSpec(2, new Date(2026, 3, 20)); // "now" = 2026-04-20 = BS Baisakh
  assertEqual('lastNMonthsSpec(2, ...) returns exactly [चैत 2082, बैशाख 2083]', groupingSeries.length, 2);
  assertTrue('First of the 2 months is चैत 2082', groupingSeries[0].year === 2082 && groupingSeries[0].month === 12);
  assertTrue('Second (current) of the 2 months is बैशाख 2083', groupingSeries[1].year === 2083 && groupingSeries[1].month === 1);
  const groupingTotals = await getExpenseHeadTotals(groupingHeadId, new Date(2026, 3, 20));
  assertEqual('The बैशाख-side entry (222) is counted in "current month"', groupingTotals.currentMonthPaisa, 222_00);
  assertEqual('The चैत-side entry (111) is counted in "previous month", not lumped into current', groupingTotals.previousMonthPaisa, 111_00);

  // ===================================================================
  // Test F — YTD begins at बैशाख १, not January 1.
  // ===================================================================
  console.log('\nTest F: YTD begins at बैशाख १');
  const ytdRanges = monthlyDateRanges(new Date(2026, 10, 15)); // "now" = 2026-11-15
  const ytdNowBS = adIsoToBS(ytdRanges.today);
  assertEqual('"now" for this check is BS year 2083', ytdNowBS.year, 2083);
  assertEqual('monthlyDateRanges().yearStart is बैशाख १ 2083, not January 1', ytdRanges.yearStart, bsYearStartIso(2083));
  assertTrue('yearStart is NOT January 1 of the Gregorian year', !ytdRanges.yearStart.endsWith('-01-01'));
  const ytdStartBS = adIsoToBS(ytdRanges.yearStart);
  assertTrue('yearStart really is BS Baisakh 1', bsEq(ytdStartBS, { year: 2083, month: 1, day: 1 }));

  // ===================================================================
  // Test G — previous month correctly crosses बैशाख -> previous year's
  // चैत (not just "one Gregorian month back").
  // ===================================================================
  console.log('\nTest G: Previous month crosses बैशाख -> previous year चैत');
  const baisakhSpec = { year: 2083, month: 1 };
  const prevOfBaisakh = previousBsMonth(baisakhSpec);
  assertTrue('Previous month of 2083 बैशाख is 2082 चैत (year decrements, month wraps to 12)', prevOfBaisakh.year === 2082 && prevOfBaisakh.month === 12);
  // And the reverse: चैत's next month is next year's बैशाख.
  const chaitraSpec = { year: 2082, month: 12 };
  const nextOfChaitra = nextBsMonth(chaitraSpec);
  assertTrue('Next month of 2082 चैत is 2083 बैशाख', nextOfChaitra.year === 2083 && nextOfChaitra.month === 1);
  // A real monthlyDateRanges() check at the exact boundary: "now" on BS
  // Baisakh 5, previous month bounds must be all of the previous BS
  // year's Chaitra.
  const boundaryNowIso = bsToAdIso({ year: 2083, month: 1, day: 5 });
  const [by, bm, bd] = boundaryNowIso.split('-').map(Number);
  const boundaryRanges = monthlyDateRanges(new Date(by, bm - 1, bd));
  const prevFromBS = adIsoToBS(boundaryRanges.previous.from);
  const prevToBS = adIsoToBS(boundaryRanges.previous.to);
  assertTrue('previous.from is 2082 चैत 1', bsEq(prevFromBS, { year: 2082, month: 12, day: 1 }));
  assertTrue('previous.to is 2082 चैत\'s real last day', prevToBS.year === 2082 && prevToBS.month === 12 && prevToBS.day === daysInBsMonth(2082, 12));

  // ===================================================================
  // Test H — daily ledger day navigation works across every BS month
  // boundary, including the variable-length चैत/Asar boundaries.
  // ===================================================================
  console.log('\nTest H: Daily ledger day navigation across every BS month boundary in 2083 and into 2084');
  let navMismatches = 0;
  let cursor: BSDate = { year: 2083, month: 1, day: 1 };
  let cursorIso = bsToAdIso(cursor);
  for (let i = 0; i < 400; i++) {
    // "Next day" in this app is always addDaysISO on the internal ISO
    // date (DateNav.tsx never does BS-specific day arithmetic of its
    // own) — re-deriving the BS date from that new ISO date must always
    // match a plain +1-day BS expectation.
    const nextIso = addDaysISO(cursorIso, 1);
    const nextBS = adIsoToBS(nextIso);
    const expected: BSDate =
      cursor.day < daysInBsMonth(cursor.year, cursor.month)
        ? { year: cursor.year, month: cursor.month, day: cursor.day + 1 }
        : nextBsMonth(cursor).month === 1 && cursor.month === 12
          ? { year: cursor.year + 1, month: 1, day: 1 }
          : { ...nextBsMonth(cursor), day: 1 };
    if (!bsEq(nextBS, expected)) {
      navMismatches++;
      if (navMismatches <= 3) {
        console.log(`    mismatch at ${cursorIso}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(nextBS)}`);
      }
    }
    cursor = nextBS;
    cursorIso = nextIso;
  }
  assertEqual('400 consecutive day-navigation steps from 2083 Baisakh 1 all land on the correct BS date', navMismatches, 0);

  // ===================================================================
  // Test I — variable month lengths: several real BS months in several
  // real BS years, read from the library's actual table, are NOT all
  // 30 (proving no hardcoded assumption slipped in anywhere).
  // ===================================================================
  console.log('\nTest I: Real variable BS month lengths (not a hardcoded 30)');
  const observedLengths = new Set<number>();
  for (const year of [2081, 2082, 2083, 2084, 2085]) {
    for (let month = 1; month <= 12; month++) {
      observedLengths.add(daysInBsMonth(year, month));
    }
  }
  assertTrue(
    `Multiple distinct month lengths observed across 2081-2085 (${[...observedLengths].sort((a, b) => a - b).join(', ')}), not a single hardcoded value`,
    observedLengths.size > 1,
  );
  assertEqual('BS 2083 असार specifically has 32 days (a real, known long month)', daysInBsMonth(2083, 3), 32);
  assertEqual('BS 2083 मंसिर specifically has 29 days (a real, known short month)', daysInBsMonth(2083, 8), 29);

  // ===================================================================
  // Extra: supported-year guard, digit conversion, and display format —
  // small but real correctness surface not covered by A-I above.
  // ===================================================================
  console.log('\nExtra: supported-year guard, Nepali digit conversion, display formatting');
  assertTrue('BS 2083 is within the supported range', isBsYearSupported(2083));
  assertTrue('BS 1500 (far outside the table) is correctly reported as unsupported', !isBsYearSupported(1500));
  let threwForUnsupportedYear = false;
  try {
    daysInBsMonth(1500, 1);
  } catch {
    threwForUnsupportedYear = true;
  }
  assertTrue('daysInBsMonth throws (rather than silently guessing) for an unsupported year', threwForUnsupportedYear);
  assertEqual('toNepaliDigits converts ASCII digits only', toNepaliDigits('2083'), '२०८३');
  assertEqual('toNepaliDigits leaves non-digit characters untouched', toNepaliDigits('Rs. 2,083.50'), 'Rs. २,०८३.५०');
  assertEqual('formatBSDate renders "YYYY MonthName DD" with Nepali digits by default', formatBSDate({ year: 2083, month: 5, day: 24 }), '२०८३ भदौ २४');
  assertEqual('formatBSDate with digits:"en" uses English month names + ASCII digits', formatBSDate({ year: 2083, month: 5, day: 24 }, { digits: 'en' }), '2083 Bhadra 24');

  console.log(`\n--- BS Calendar Test Suite: ${passed} passed, ${failed} failed ---`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('Test script crashed:', err);
  process.exitCode = 1;
});
