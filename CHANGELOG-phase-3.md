# Phase 3 — Advance limit becomes advisory (Part A) + vehicle-maintenance Smart Entry rule (Part B)

Builds on `CHANGELOG-phase-12g.md`, `CHANGELOG-phase-12g1-bugfix.md`,
`CHANGELOG-phase-2.md`, and `CHANGELOG-phase-2-bugfix.md`.

## Part A — Advance limit is now advisory, never a block

### The problem
`checkAdvanceLimit()`'s `allowed` field was used by both StaffView.tsx's
Give-Advance form and FastEntryBar.tsx to hard-block the save with an
"Advance limit exceeded" error. A staff member may legitimately need an
advance larger than their limit in a special/authorized case, and the
system was preventing that entirely.

### The fix
- **`src/lib/staff.ts`** — `AdvanceLimitCheck.allowed` renamed to
  `withinLimit`. The arithmetic (`outstandingPaisa + amountPaisa <=
  limitPaisa`) is byte-for-byte unchanged — only the field name and the
  doc comments explaining how callers must react to `false` changed.
  `checkRecoveryAmount()` (and its `RecoveryCheck.allowed` field, a
  completely separate interface) is **untouched** — that's a genuine hard
  cash-flow constraint (net cash paid cannot go negative) and remains a
  hard block, per EXACT SCOPE item 4.

- **`src/components/StaffView.tsx`** (`GiveAdvanceModal`) — `handleSubmit`
  now always calls `addTransaction()`; `checkAdvanceLimit()`'s result no
  longer gates the save at all. When it reports `withinLimit: false`, a
  non-blocking amber warning banner appears (an `AlertTriangle` icon +
  text, styled to match `DashboardView.tsx`'s existing alert-banner
  pattern but recolored amber — the CSS's own "warnings/budget alerts"
  tone — rather than that banner's brick/error tone, since this is
  advisory, not a hard failure) stating both required numbers: the limit,
  and what outstanding will be after this advance. The modal
  deliberately does **not** auto-close when the warning fires — the
  amount/notes fields are cleared (so the modal can't be accidentally
  re-submitted with the same amount) but the modal stays open with the
  warning visible until the owner explicitly dismisses it (the Cancel
  button relabels to "Close" in that state), guaranteeing the numbers are
  seen every time, per EXACT SCOPE's explicit requirement.

- **`src/components/FastEntryBar.tsx`** — same treatment. A new
  `advanceLimitWarning` state (deliberately separate from the existing,
  genuinely-blocking `errors` state) holds the warning text. The
  early-return that used to reject the save is gone;
  `checkAdvanceLimit()` still runs (unchanged gating logic, via
  `isFastEntryAdvanceEntry()`), but its result now only decides whether
  to populate this warning, never whether to save. `addTransaction()`
  always runs. The warning renders as a compact amber row (same
  `AlertTriangle` + amber styling, scaled down for the inline bar) that
  survives `resetForm()` — deliberately excluded from what `resetForm()`
  clears — so it's still visible after the fields reset post-save, and
  is cleared at the very start of the *next* submit attempt (so it never
  lingers past the next unrelated entry). The existing double-submit
  guard (`saveGuardRef`) is untouched — still `.finish()`'d in every
  code path, including the new non-blocking one.

- **`src/lib/fastEntry.ts`** — `applyFastEntryMatch()` gains one line to
  apply `suggestedVehicleId` (see Part B); its `isFastEntryAdvanceEntry`
  doc comment updated to reflect that `checkAdvanceLimit()` no longer
  decides whether the save is *allowed*, only whether to surface a
  warning.

- **`src/lib/reports.ts`** — the Dashboard-alerts doc comment claimed
  "Advance-limit-exceeded is already enforced at entry time (blocks the
  save)" as the reason no retroactive Dashboard alert exists for it. That
  claim is no longer true, so the comment is corrected: an over-limit
  advance can now legitimately exist in the data, and a retroactive
  Dashboard alert for it would be a new alert type — explicitly out of
  scope for this phase, not built here.

### Test updates
- **`scripts/test-ledger.ts`** (Test P4-4/P4-5) — field renamed
  (`allowed` → `withinLimit`), assertion wording corrected from
  "blocked"/"succeeds" to "exceeds"/"stays within" (these tests only ever
  exercised the raw check's arithmetic, never an actual blocked save, so
  no assertions were added or removed — same 6 assertions, same count).
- **`scripts/test-fastentry-enter.ts`** — its local
  `fastEntrySaveViaDecisionTree()` harness (which mirrors
  FastEntryBar.tsx's handleSubmit()) had its own `throw new Error('Advance
  limit exceeded')` on `!limitCheck.allowed`. Removed entirely (renamed
  the call, kept `checkAdvanceLimit()` running to mirror the real
  component, but it can no longer throw) — this path was never actually
  exercised with an over-limit input in this file to begin with (per its
  own pre-existing comment, that case is covered in
  test-fastentry-smart-entry.ts), so this is a pure accuracy fix with no
  behavior change to what the file actually tests.
- **`scripts/test-fastentry-smart-entry.ts`** — this is where the real
  behavior change is verified. Test cases 6 & 7 (in the file's own
  numbering) are rewritten:
  - **Test 6** (over-limit): used to assert the save is BLOCKED (no
    Transaction created). Now asserts the save **succeeds** on **both**
    entry paths — a Fast-Entry-shaped save (Part A test case 3) and a
    separate Give-Advance-form-shaped save (Part A test case 1, same
    transaction description/shape `GiveAdvanceModal.handleSubmit` builds)
    — and that the reported `limitPaisa`/resulting-outstanding numbers
    match hand-computed expectations for each path (4,500 + 800 = 5,300
    for the Fast-Entry save; 5,300 + 800 = 6,100 for the Give-Advance-form
    save immediately after, since outstanding grew from the first save).
  - **Test 7** (within-limit): unchanged in substance — regression check
    that a within-limit advance still saves exactly as before, with the
    field rename applied. The staff member's limit is explicitly raised
    first so this is a genuine within-limit case (their original 5,000
    limit had already been exceeded twice by that point in the test).
  - `fastEntrySave()` (the local §38-scenario helper) — same rename +
    un-throw treatment as `test-fastentry-enter.ts`'s harness; this
    scenario never actually exercises an over-limit case either.

## Part B — Vehicle-maintenance Smart Entry rule (rule 5)

### What was built
One new pattern rule in `resolvePatternOnlyTags()`
(`src/lib/fastEntrySuggestions.ts`), placed **after** rules 3 (institution)
and 4 (staff-advance) so their first-match-wins priority is unchanged.
It fires for a `cash_out` description containing one of five fixed
keywords — `service`, `servicing`, `repair`, `maintenance`, `overhaul`
(no synonym expansion beyond this list, per EXACT SCOPE) — and resolves:

- **Category** = "Vehicle Maintenance"
- **ExpenseHead** = "Service" (the head Phase 12g's
  `ensureVehicleServiceExpenseHead()` seeds)
- **Vehicle** = the uniquely matched vehicle
- **Staff** = the uniquely matched staff member, if any (**optional** — a
  description naming only the vehicle, like "PULSAR 150 SERVICE", is
  valid input for this rule)

Same ask-don't-guess contract as every other rule in this file: 2+
matching vehicles, or 2+ matching staff for the optional staff portion,
resolves to **no match at all** — never a guess.

### Files touched
- **`src/lib/fastEntrySuggestions.ts`**:
  - `VehicleSuggestionCandidate` interface added (mirrors
    `StaffSuggestionCandidate`/`InstitutionSuggestionCandidate`).
  - `SuggestionCandidatePool` gains **optional** `vehicleCandidates`,
    `vehicleMaintenanceCategoryId`, `vehicleServiceExpenseHeadId` fields.
    Made optional deliberately (mirroring the precedent Phase 12g set for
    `aliases`) so the pool-builders in
    `scripts/test-fastentry-suggestions.ts` and
    `scripts/test-fastentry-enter.ts` — which have no reason to exercise
    rule 5 — needed **zero changes** and keep type-checking.
  - `MAINTENANCE_KEYWORDS` (the fixed five-word list) and
    `textMatchesMaintenanceKeyword()` added — same tiered shape
    (whole-string substring, else token-tolerant) as the existing
    `textMatchesAdvanceKeyword()`.
  - Rule 5 itself, added after rule 4's block, reusing
    `matchesCandidateNameOrAlias()` — the exact Phase-12g.1-hardened
    matcher rules 3/4 already use — **verbatim**. No second matcher was
    written; nothing about the existing tiers was loosened or tightened.
  - `ResolvedTag` gains `vehicleId?: string`, set only by rule 5.
  - `buildSuggestionMatch()` now forwards `suggestedVehicleId` from the
    resolved tag. The doc comment on
    `FastEntrySuggestionMatch.suggestedVehicleId` (which stated it was
    "deliberately NEVER set" by this file, referring to rules 1-4's own
    scope) is updated to name rule 5 as the single exception and explain
    why, per EXACT SCOPE item 3 — not deleted.
- **`src/hooks/useFastEntrySuggestions.ts`** — extended to load active
  vehicles (`db.vehicles.filter(v => v.active)`) and resolve the "Vehicle
  Maintenance"/"Service" reference ids, mirroring exactly how
  `activeStaff`/`staffCategoryId`/`staffAdvanceExpenseHeadId` are already
  built.
- **`src/lib/fastEntry.ts`** — `applyFastEntryMatch()` gains
  `if (match.suggestedVehicleId) next.vehicleId = match.suggestedVehicleId;`
  in the cash_out branch — without this, rule 5 could resolve a vehicle
  but the Fast Entry form would never actually receive it. The Vehicle
  `<select>` in FastEntryBar.tsx is a fully independent field (not gated
  behind picking Staff first), so this works correctly even when rule 5
  resolves a vehicle with no staff (test case 6).
- **`src/components/FastEntryBar.tsx`** — the stale comment in
  `selectSuggestion()` claiming `suggestedVehicleId` is never set is
  corrected to name rule 5 as the exception.
- **Untouched, as instructed**: `lib/fastEntrySuggestions.ts` rules 1-4's
  own logic, `lib/staffVehicles.ts`, `lib/sync.ts`, `lib/backup.ts`, the
  BS calendar, the ledger cascade, the accounting model. No new UI/
  workflow was built — this stays entirely inside the existing Fast Entry
  description-typing flow, exactly as EXACT SCOPE required.

### Real-data fixtures and aliases — verified empirically, not assumed
Per EXACT SCOPE's own instruction to seed the exact real names and state
precisely which aliases the case depends on, I ran the actual matcher
against the literal fixtures before writing any test assertions (see
`scripts/test-fastentry-smart-entry.ts`'s new "Phase 3 Part B" section):

- **Vehicle**: "220 BIKE PULSAR SIJAN SERVICING" resolves to
  "PULSAR 220 SIJEN" with **no vehicle alias needed at all**. This
  surprised me — EXACT SCOPE's own text suggested I'd likely need to add
  something like a "PULSAR 220" or "220 BIKE" alias. Empirically that
  turned out to be unnecessary: `tokenSetsMatch()`'s bipartite matching is
  order-independent (so "220 BIKE PULSAR" matches the master data's
  "PULSAR 220..." token-for-token regardless of order) and its fuzzy tier
  absorbs the one-character "SIJEN"/"SIJAN" typo (edit distance 1, well
  under the tier's threshold). I verified this directly against the code
  before committing to a test assertion, rather than assuming either the
  spec's suggested aliases or my own hand-analysis were correct.
- **Staff**: the same input needs a **staff alias**, `"SIJAN"`, added to
  "SIJAN RAI" — this one genuinely is required. The typed text never
  mentions "RAI" at all, and `matchesCandidateNameOrAlias()`'s tiers
  require *every* one of a candidate's own name/alias tokens to be
  covered by the typed text before a partial match succeeds — "SIJAN"
  alone can never cover "RAI". Without this alias, rule 5 correctly
  resolves the vehicle but leaves Staff unset for this input (verified:
  I ran it both ways). A real owner typing just a first name for this
  case would need the same alias added to get Staff auto-tagged too.

### Deviation from spec — Test case 6 does not resolve as EXACT SCOPE anticipated
EXACT SCOPE's test case 6 states: `"PULSAR 150 SERVICE"` (no staff named)
should cleanly resolve Category + ExpenseHead + Vehicle, with Staff left
unset. **This does not happen**, and I want to be fully transparent about
why rather than quietly work around it or fudge the test.

Empirically, `"PULSAR 150 SERVICE"` is **ambiguous** between "PULSAR 150"
and "PULSAR 220 SIJEN" under the existing, unmodified
`matchesCandidateNameOrAlias()`. Root cause: that matcher's tier (ii) —
"is any ONE of a candidate's own name tokens a prefix of the *entire*
typed string" — fires on the shared word "PULSAR" alone, for *either*
vehicle, and short-circuits with `return true` before the more precise
token-set tier (iii) (which *would* correctly narrow to just "PULSAR 150"
by the "150" vs. "220"/"SIJEN" difference) ever runs. This is a
pre-existing property of the Phase-12g.1-hardened matcher — it also
applies equally to rules 3/4 — not something introduced by rule 5. I
confirmed this with a direct debug trace against the actual function
before concluding it, not by inference alone.

I could not find a way to satisfy this test case without either (a)
writing a second/loosened matcher specifically for rule 5, or (b) editing
the frozen `matchesCandidateNameOrAlias()` itself — **both explicitly
forbidden** by EXACT SCOPE item 1 ("reusing the EXISTING token-matching
helpers... do not write a second matcher, and do not loosen them").
Vehicle aliases can't fix this either: an alias only ever *adds* a new way
to match, it can never *prevent* "PULSAR 220 SIJEN" from separately
matching via its own bare name's shared first token.

Given the explicit constraint, I judged that faithfully reusing the
frozen matcher and preserving its ask-don't-guess contract — even where
it produces a "no match" for real vehicle master data that happens to
share a first word — is more correct than fudging a test to force a
false pass. `scripts/test-fastentry-smart-entry.ts`'s Test 6 asserts the
**true, verified** outcome (`null`/no match) with a full explanation
inline. Test 7 (EXACT SCOPE's own explicit "2+ vehicles match → resolve
nothing" case, using `"PULSAR SERVICE"`) shares this exact root cause and
passes as specified — the two tests together show this is the matcher's
consistent, by-design behavior, not an inconsistency in rule 5.

If this outcome isn't acceptable, the two realistic paths forward are (a)
change EXACT SCOPE to accept this specific pair of real vehicle names as
a known ambiguous case, or (b) explicitly authorize hardening
`matchesCandidateNameOrAlias()`'s tier (ii) itself (e.g., requiring a
minimum specificity, or checking the token-set tier first) as a new,
scoped change — which is a bigger change than this phase's stated EXACT
SCOPE allows and would need its own regression pass against every
existing rule 1-4 fixture, not just rule 5's.

### Test additions (`scripts/test-fastentry-smart-entry.ts`, "Phase 3 Part B" section)
This section builds its own scoped candidate pool (`staffCandidates`/
`vehicleCandidates` set explicitly to just its own fixtures) rather than
reusing the file's shared `buildPool()` helper unmodified, specifically
to avoid cross-contamination from earlier fixtures already accumulated in
the same file (in particular the Phase 12g.1 bugfix section's own
"SIJAN RAI" a few lines up, and this file's own original single-token
"Sijan"/"220 Pulsar" fixtures near the top — several of which would
introduce *spurious* ambiguity of their own if left in the pool, e.g. two
different staff members both matching on "Sijan"). Everything else on
the pool (institution candidates, expense-head/cash-in-type candidates,
history, the resolved reference ids) still comes from the shared
`buildPool()`, which was itself extended to build `vehicleCandidates`/
`vehicleMaintenanceCategoryId`/`vehicleServiceExpenseHeadId` (mirroring
Phase 12g's own precedent of updating this file's local pool-builder
alongside the real hook).

- **Test 5**: "220 BIKE PULSAR SIJAN SERVICING" → full resolution
  (Category/ExpenseHead/Vehicle/Staff, `expandMoreFields`), using the
  required staff alias above.
- **Test 6**: "PULSAR 150 SERVICE" → documented deviation, see above.
- **Test 7**: "PULSAR SERVICE" → ambiguous, resolves to nothing.
- **Test 8**: "SIJAN ADVANCE" → still resolves via rule 4, unaffected by
  vehicleCandidates now being present in the pool (a stronger version of
  the pre-existing Bugfix-5 check, which never had any vehicles in its
  pool at all).
- **Test 9**: "KHAJA" (rule 2, cash_out) / "ATM" (rule 2, cash_in — its
  own cash_in pool, since ATM is a cash-in type) both still resolve
  exactly as before.
- **Test 10**: "KUMAR DAI CASH" still resolves to nothing, confirming the
  Phase 12g.1 regression fix isn't reopened by the new vehicle pool
  (trivially guaranteed here since rule 5's own keyword gate never fires
  on this text, but verified directly anyway).

## Verification performed
- `npm run build` (`tsc -b && vite build`) — clean, no type errors.
- `npm run lint` (`oxlint`) — 0 errors, 20 warnings, all pre-existing
  `react/set-state-in-effect` warnings already present before this phase
  (same count as `CHANGELOG-phase-2-bugfix.md` reported).
- `npm run test:ledger` — **327 passed, 0 failed** (unchanged).
- `npm run test:integration` — **35 passed, 0 failed** (unchanged).
- `npm run test:staff-vehicles` — **43 passed, 0 failed** (unchanged).
- `npm run test:fastentry` — **21 passed, 0 failed** (unchanged).
- `npm run test:fastentry-suggestions` — **22 passed, 0 failed** (unchanged).
- `npm run test:fastentry-smart-entry` — **78 passed, 0 failed** (up from
  59 — the increase is entirely new Phase 3 assertions: Part A's
  Give-Advance-form-path/Fast-Entry-path warning tests replacing the old
  blocking assertions, plus Part B's 6 new test cases; every pre-existing
  assertion in this file that didn't need to change for the new advisory
  behavior still passes unchanged).
- `npm run test:fastentry-enter` — **33 passed, 0 failed** (unchanged).
- `npm run test:batch-entry` — **44 passed, 0 failed** (unchanged).
- `npm run test:calendar` — **36 passed, 0 failed** (unchanged).
- **Not run in this environment:** `npm run test:sync` — same limitation
  Phases 2 and 2-bugfix both hit: the Firestore emulator jar download
  fails with `Error: download failed, status 403: Host not in allowlist:
  storage.googleapis.com`. Nothing in this phase touches `lib/sync.ts` or
  `SYNC_TABLES`, so there is no new sync-specific behavior to verify, but
  please run it yourself before shipping to confirm no incidental
  regression.

## Deviations from spec (summary)
1. **Test case 6 (Part B)** does not resolve as literally specified — see
   the full explanation above. This is the only place I deviated from a
   stated test case's expected outcome; I chose to preserve the frozen
   matcher's ask-don't-guess contract and real-data fidelity over forcing
   a false pass.
2. No other deviations. Everything else in EXACT SCOPE — the rename, the
   non-blocking warnings on both entry paths, rule 5's placement/priority/
   ambiguity handling, the candidate-pool wiring, and the DO NOT list —
   was implemented and verified as specified.
