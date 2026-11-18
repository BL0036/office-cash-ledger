# Phase 5 (FINAL) — End-to-end verification, hardening, and release

This phase adds no product features. Its job was to prove the combined
result of Phases 1–4 is correct end-to-end, close any real regression
found, and produce a release-ready build. This document summarizes what
Phases 1–4 built, what this phase verified/found/fixed, and every
remaining known limitation.

## Cumulative summary of Phases 1–4

- **12g / 12g1-bugfix / 12g2-bugfix** — Fast Entry Smart Entry
  alias/typo-tolerant matching (institution, staff-advance, and
  vehicle-maintenance patterns), tiered exact → prefix → fuzzy token
  matching, and a "learned from history" rule that takes priority over
  all pattern rules.
- **2 / 2-bugfix** — the Staff↔Vehicle join table (`staffVehicles`,
  many-to-many, soft-deletable via `active`), replacing the old
  single-`assignedVehicleId` field.
- **3** — an advisory (non-blocking) advance-limit warning on Fast Entry
  staff-advance saves, plus a vehicle-maintenance resolver.
- **4** — four staff-profile fields (`employeeId`, `position`,
  `contactNumber`, `photoDataUrl`), the matching form/profile UI, and two
  new printable views (ID Card, Summary) via `window.print()` + a
  `.print-region`/`@media print` CSS mechanism.

## What this phase verified, found, and fixed

### Item 1 — full regression suite
Reran every `test:*` script individually and via `test:all`. Every count
matches what the changelogs report exactly:

| Suite | Count |
|---|---|
| test:ledger | 327 |
| test:integration | 35 |
| test:staff-vehicles | 43 |
| test:staff-profile | 44 |
| test:fastentry | 21 |
| test:fastentry-suggestions | 22 |
| test:fastentry-smart-entry | 88 |
| test:fastentry-enter | **42** (was 33 — see item 7) |
| test:batch-entry | 44 |
| test:calendar | 36 |
| test:owner-data | **55 (new — see item 3)** |

No failures were found in any pre-existing test. Nothing was weakened or
deleted to force a pass anywhere in this phase.

### Item 2 — `test:sync`
Still cannot run in this environment: the Firestore emulator's jar
download is blocked by this container's network egress allowlist
(`Error: download failed, status 403: Host not in allowlist:
storage.googleapis.com`), confirmed by running it directly, not assumed
from a prior phase's note. **Marked UNVERIFIED** in the release checklist
below, honestly, per the brief's own instruction.

### Item 3 — owner real-data verification
**Important note on the data used**: the brief names a specific file,
`cash-ledger-backup-2026-09-15.json`. That file was **not actually
delivered to this phase** — checked the uploads directory directly. This
is the same situation `CHANGELOG-phase-2.md` already documented for its
own real-data test case. New `scripts/test-owner-data.ts` (55 tests, `npm
run test:owner-data`, folded into `test:all`) reconstructs an
**equivalent, clearly-labeled stand-in dataset** using every specific
real name/fact actually given across every spec so far (staff SIJAN RAI
and SABIN ACHARYA; vehicles PULSAR 150 and PULSAR 220 SIJEN; all 4
institutions — DHANONDAYA MULTIPURPOSE CO-OPERATIVE LTD, JOIN SAVING &
CREDIT CO-OPERATIVE LIMITED, and both ZEST IDEOLOGY entries; and every
named transaction description), with every remaining slot needed to
reach the brief's stated counts (5 staff, 6 vehicles, 11 transactions)
filled by entries explicitly marked `RECONSTRUCTED (PLACEHOLDER)`. See
the file's own header comment for the full accounting.

**3a — schemaVersion mismatch**: confirmed `restoreFromBackup()` rejects
a schemaVersion-10 payload (matching the real file's stated version)
cleanly — a real `Error` with a clear message naming both versions, the
live database completely untouched, no partial import, no crash. This
is a **pre-existing, out-of-scope limitation, not fixed** (per the
brief's own DO NOT) — see the Known Limitations section below.

**3b — no silent reclassification**: a historical transaction literally
described "SIJAN ADVANCE" was recorded under Savings & Financial (not
Staff/Advance). Confirmed its `categoryId` and `staffId` are completely
unaffected by everything in Phases 1–4 and by this phase's own
backup/restore round-trip.

**3c — SABIN ACHARYA ↔ PULSAR 150**: confirmed via
`getVehiclesForStaff()` (the Phase 2 join table), exactly one assigned
vehicle, correctly PULSAR 150.

**3d — ledger-day reconciliation**: every `LedgerDay`'s
`opening + cashIn - cashOut === closing` holds, and every day's opening
balance chains correctly from the previous day's closing, across the
full 11-transaction date range.

**3e/3f/3g — Fast Entry resolution of new entries — IMPORTANT FINDING**:
this is the most significant result of this phase. See "Discovered
interaction" below — the short version is that several of these checks
do **not** produce the originally-expected result, for a real,
intentional, pre-existing reason unrelated to Phases 1–4, and the test
file documents this in detail rather than silently forcing the original
expectation.

### Item 4 — BS calendar boundaries
Verified by code review: `test-bs-calendar.ts` **already** covers
everything asked for — the Chaitra→Baishakh year boundary (Test C,
cross-checked against an independently-known real date), a real short BS
month (Mangsir 2083, 29 days, Test I) alongside a long one (Asar 2083, 32
days), monthly navigation across the same year boundary (Test G), and a
400-day continuous daily-navigation sweep across every month/year
boundary in range (Test H). No gap found; nothing added.

### Item 5 — edit/delete recalculation after Phases 1–4
`test-ledger.ts`'s existing P10a-7 cascade tests (part of the 327,
unchanged) already cover this generically. Additionally spot-checked
directly against the reconstructed owner dataset in
`test-owner-data.ts`: editing an early transaction's amount cascades the
exact delta forward through every later day; soft-deleting a transaction
reverses its contribution correctly; full-range reconciliation still
holds after both. No gap found in the core `recalcCascadeFrom()` path —
Phases 2–4 never touched `lib/ledger.ts`.

### Item 6 — full-schema backup/restore
Verified with the reconstructed dataset: exported backup includes
`staffVehicles` (Phase 2) and the four Phase 4 Staff fields; a full
current-schema round-trip preserves all of it, including the
never-reclassified historical "SIJAN ADVANCE" row. The old-schema
(schemaVersion 10) rejection is covered by item 3a above and, separately
and generically, by the existing P10a-6 test in `test-ledger.ts`.

### Item 7 — keyboard double-submit guard, extended
Found a genuine gap: the existing guard test (`test-fastentry-enter.ts`)
only covered a plain entry. Added two new test cases:
- A **Smart-Entry-auto-tagged** entry (institution already resolved
  before submit) — confirms tagging happening earlier in the flow can't
  create a second gap for the guard.
- An entry that **triggers the advisory advance-limit warning** — this
  is a real structural difference from the plain case: the actual
  `FastEntryBar.handleSubmit()` has an `await checkAdvanceLimit(...)`
  between `guard.tryStart()` and the eventual save whenever the entry is
  a staff advance, one more await point than the simple race had, and
  exactly where a held-Enter key's second event-loop turn could land.
  Confirmed the guard still lets exactly one save through, and that the
  (non-blocking) warning outcome doesn't skip `guard.finish()`.

Along the way, caught and fixed a genuine **test-isolation bug in this
phase's own first draft**: an early version of the Smart-Entry-tagged
test case saved a transaction with the literal description "Dhanodaya",
which polluted Fast Entry's own Rule-1 history-learning for a *later,
pre-existing* test in the same file that also typed "Dhanodaya" — a small
but real illustration of exactly the class of interaction item 3e's
finding below is about. Fixed by using a distinct saved description
while still exercising the same tagged-value code path.
`test:fastentry-enter` count: 33 → 42.

### Item 8 — build & lint
`tsc -b` clean, `npm run build` clean (no new type errors). `npm run
lint`: this phase's first draft of `test-owner-data.ts` briefly pushed
the warning count from 20 to 25 (5 unused imports/variables left in that
new file) — investigated, confirmed all 5 were self-inflicted and
none were pre-existing, and cleaned them up. Final count: **0 errors, 20
warnings**, unchanged from Phase 4's baseline (verified line-by-line: the
remaining 20 are the same pre-existing `react/set-state-in-effect` and a
handful of scripts'-own unused-import warnings Phase 3/4 already
reported).

### Item 9 — print views, real browser rendering
**UNVERIFIED.** Attempted to install Playwright + a Chromium binary in
this environment specifically to get real rendering; the browser
download is blocked by the same network allowlist as `test:sync`
(`Host not in allowlist: cdn.playwright.dev`). No headless browser is
reachable here, matching every prior phase's own limitation for
`test:sync`. The Playwright package was removed again after confirming
this — it is not part of the delivered project. As a partial substitute,
did a manual code-level review of the print CSS mechanism (the
`visibility`-toggle + `position: absolute` trick in `index.css`,
confirmed against `.modal-overlay`'s `position: fixed` establishing the
right containing block) and confirmed every field in both print
components is rendered conditionally, so neither view can throw for a
minimal (no photo, no vehicles, no history) staff record — but this is
static analysis, not actual rendered output, and is marked accordingly.

### Item 10 — README
Updated: the staff feature line now mentions the Phase 4 fields and
print views; the test-count and scripts listing now include
`test-staff-vehicles.ts`, `test-staff-profile.ts`, `test-bs-calendar.ts`,
and the new `test-owner-data.ts`; "Running the tests" lists every current
`npm run test:*` script; and two new **Known Limitations** entries were
added — the schemaVersion exact-match restore limitation (item 3a) and
the Rule-1-history-priority finding (below). Also made a small
mobile-safety improvement to the Phase 4 profile header (the two new
print buttons now wrap with `flex-wrap` instead of a fixed single row) —
found during a code review for the "mobile layout not broken" checklist
item, since no live device/browser was available to test it directly.

## Discovered interaction (not a Phase 1–4 regression) — please read

Building `test-owner-data.ts` surfaced a real, previously-undocumented
interaction between two **pre-existing, intentional** pieces of Fast
Entry logic, both predating this 5-phase plan:

- **Rule 1** ("learned from history" — exact description-text match,
  most-recent usage wins) always runs and returns **before** Rules 3–5
  (institution / staff-advance / vehicle-maintenance pattern matching)
  ever get a chance to look at the typed text, whenever *any* prior
  transaction shares the exact same description (case/whitespace
  normalized).
- Rule 1's own tag only ever carries Category + Expense Head — never
  Institution, Staff, or Vehicle (that's simply not information Rule 1's
  learned-history data has to offer).

The practical consequence: **once a description has been recorded even
once, retyping that exact text reuses whatever Category/Expense Head it
was tagged with before, but does not re-populate Institution/Staff/
Vehicle** the way a genuinely first-time typing of that phrase would.
This directly affected several of item 3e's checks in
`test-owner-data.ts` — e.g. adding a "SIJAN" alias to SIJAN RAI does
**not** make a new "SIJAN ADVANCE" entry resolve to Staff/Advance if a
prior "SIJAN ADVANCE" transaction already exists tagged some other way
(such as the Savings & Financial one item 3b itself requires) — Rule 1's
existing history hit wins regardless of the alias. Every one of these
findings is documented with a full explanation directly in
`test-owner-data.ts`'s assertions (search for "FINDING"), not silently
worked around, and the underlying pattern rules themselves were
separately confirmed intact using genuinely novel phrasings with no
prior history.

This is **not a bug and not something this phase changed** — Rule 1's
priority is deliberate, documented, pre-existing behavior from the
12g/12c era ("it's the owner's own actual usage, the strongest signal
available"). It's flagged here because it's a real, useful thing for the
owner to know: if a description was ever saved with the "wrong" tagging
once, the fix is to manually re-tag **one** new entry with that exact
text correctly — that becomes the new "most recent" match, and Smart
Entry will follow suit from then on. Now documented in README's Known
Limitations.

## Verification performed
- `npm run build` (`tsc -b && vite build`) — clean, no type errors, from
  a **fresh** `npm install` + extraction of the final ZIP, not just the
  working copy.
- `npm run lint` (`oxlint`) — 0 errors, 20 warnings (unchanged from
  Phase 4).
- Every `test:*` script passes with the counts in the Item 1 table above,
  reconfirmed from the same fresh extraction.
- `npm run test:sync` — **UNVERIFIED**, network-blocked in this
  environment (see item 2).
- Print views — **UNVERIFIED** via real browser rendering, network-
  blocked in this environment (see item 9); reviewed at the code level
  only.

## Final release checklist

- [x] Daily entry (keyboard-first Fast Entry), no duplicate-Enter
      regressions, including with the advisory advance-limit warning —
      verified, including two new test cases added this phase
- [x] Cash balance / ledger cascade correct after edits and deletes —
      verified generically (test:ledger) and against the reconstructed
      owner dataset
- [x] Smart Entry: DHANODAYA/JOIN SAVING/SIJAN ADVANCE (with alias)/
      vehicle-service examples all resolve correctly; genuine ambiguity
      (ZEST IDEOLOGY) and genuine non-matches (KUMAR DAI CASH) still
      work — verified, **with one important documented finding**: see
      "Discovered interaction" above for exactly which of these behave
      differently than originally expected, and why it's correct
- [x] Staff: profile fields, multiple vehicles, advisory advance limit
      all working — verified
- [x] Vehicle expenses independent of staff salary (spot-checked) —
      verified via the reconstructed dataset (Petrol/Service entries
      with and without a staffId)
- [x] Institutions: alias matching + ambiguity detection working —
      verified (existing 88-test suite, still passing; ambiguity
      detection itself untouched by Phases 1-4)
- [x] Expense diaries / reports correct and BS-month-aware — untouched
      by Phases 1-4; existing coverage unchanged and passing
- [x] BS calendar: month and year boundaries correct — verified, already
      comprehensively covered (see item 4)
- [ ] Printing: ID card and summary render cleanly — **UNVERIFIED**, no
      headless browser reachable in this environment (see item 9);
      code-reviewed only
- [x] Backup export/import: current-schema round-trip works; old-schema
      backup fails cleanly (documented limitation, not silently broken)
      — verified
- [ ] Firebase sync: push/pull verified via emulator — **UNVERIFIED**,
      emulator download blocked in this environment (see item 2)
- [x] Offline mode fully functional — architecturally unchanged by
      Phases 1-4 (everything routes through the same local Dexie/
      IndexedDB layer); no code path introduced a network dependency
- [ ] Mobile layout not broken by Phase 1-4 UI additions — **partially
      verified**: code-reviewed (flex/shrink-0/wrap patterns consistent
      with the rest of the app; one small `flex-wrap` fix applied to the
      Phase 4 profile header's button row during this review), but not
      tested on a real device or browser viewport — marking this
      UNVERIFIED for the visual result specifically, done for the code
      pattern
- [x] `tsc -b` clean, `npm run build` clean, `npm run lint` warning count
      unchanged/explained — verified (see item 8)
- [x] `npm run test:all` fully green with documented pass counts —
      verified except `test:sync` (see below)
- [x] Real backup data: restore correctly rejected (documented
      limitation), manually-reconstructed equivalent data round-trips
      with zero silent reclassification — verified; see item 3 for the
      important caveat that the real file itself was never available to
      any phase

## Every known limitation, for the owner

1. **Backup restore requires an exact schema-version match.** A backup
   taken on an older app version cannot be restored into a newer install
   — including the real `cash-ledger-backup-2026-09-15.json` file itself,
   which is schemaVersion 10 while the app is now on schemaVersion 14.
   The rejection is clean (clear error, nothing partially imported), but
   there's no upgrade path yet. Explicitly out of scope for this 5-phase
   plan; would need its own scoped change.
2. **Rule 1 (history) suppresses Rule 3-5 (institution/staff/vehicle)
   auto-fill for any repeated exact description.** See "Discovered
   interaction" above. Not a bug; worth knowing about.
3. `npm run test:sync` needs the Firebase Local Emulator Suite's one-time
   jar download, which fails in network-restricted environments
   (including every sandbox used across all 5 phases so far) — it simply
   won't run there, not skipped or faked.
4. The app's own default reference-data seeding produces **7** expense
   heads (Khaja, Khana, Petrol, Salary, Advance, Service, and an always-
   seeded but currently-unused "Deposit" head), not the 6 this phase's
   brief described — flagged during dataset reconstruction (item 3) since
   the real file wasn't available to check which is actually true of the
   owner's real data.
5. The production JS bundle is ~1.2MB before gzip (pre-existing, noted in
   README already), driven mostly by the Excel-export library. Not
   addressed by this phase (no new product features, and this predates
   the 5-phase plan).
6. Print views (Print ID Card, Print Summary) have never been rendered
   in a real browser across any phase of this project — only code-
   reviewed and exercised via jsdom-free logic tests. Recommend a manual
   check in an actual browser before relying on them for a real printed
   ID card.
7. Firebase Cloud Sync push/pull has never actually run against the
   emulator across any phase of this project, for the same network
   reason as #3 — recommend running `npm run test:sync` yourself in an
   unrestricted environment before shipping.
