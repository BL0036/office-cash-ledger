# Phase 12g — Smart Entry alias + typo tolerance

Fixes the deterministic Smart Entry resolver's institution-name and
staff-advance pattern rules, which previously required the owner's typed
text to literally CONTAIN the full stored master-data name
(`typedText.includes(masterName)`) — a check real short-typed input
("DHANODAYA") could essentially never satisfy against a long registered
name ("DHANONDAYA MULTIPURPOSE CO-OPERATIVE LTD"). Adds lightweight,
code-free alias support and typo tolerance so these matches actually work,
while preserving every existing safety rule (ask on genuine ambiguity,
never guess).

## Files touched

- **`src/types.ts`** — added `aliases: string[]` to `Staff`, `Vehicle`,
  and `FinancialInstitution`.

- **`src/db/schema.ts`** —
  - Added Dexie version 11: a purely additive migration that backfills
    `aliases: []` onto every existing Staff/Vehicle/FinancialInstitution
    row. No index changes (the field is only ever read off an
    already-fetched row, never queried by value), so every table's
    `stores()` string is identical to version 10's — but unlike version
    10's index-only bump, this needed a real `.upgrade()` since
    IndexedDB only lazily backfills new *indexes* on old rows, not new
    *fields*. Verified the plain per-table `toArray()`/`bulkPut()` loop
    (no store rename/delete dance) is sufficient by testing the upgrade
    path directly against a v10 fixture database.
  - Added `ensureVehicleServiceExpenseHead()`, seeding a new "Service"
    ExpenseHead under the existing "Vehicle Maintenance" category, using
    the exact same backfill-on-every-app-start pattern as
    `ensureSalaryExpenseHead()`/`ensureAdvanceExpenseHead()`/
    `ensureDepositExpenseHead()` — so existing databases pick it up
    automatically, no manual migration step.

- **`src/lib/institutions.ts`, `src/lib/staff.ts`, `src/lib/vehicles.ts`**
  — `NewInstitutionInput`/`NewStaffInput`/`NewVehicleInput` (and their
  editable-fields types) now accept an optional `aliases?: string[]`.
  Each file gained its own small `sanitizeAliases()` helper (trim each
  alias, drop empties, dedupe case-insensitively, first-seen casing
  wins) — kept local to each file rather than factored into a shared
  module, since EXACT SCOPE said not to change any other behavior in
  these files. `addInstitution`/`editInstitution`,
  `addStaff`/`editStaff`, and `addVehicle`/`editVehicle` all persist the
  sanitized array.

- **`src/lib/fastEntrySuggestions.ts`** — the core fix:
  - `InstitutionSuggestionCandidate` and `StaffSuggestionCandidate` now
    carry an optional `aliases?: string[]` (optional so pool-building
    code elsewhere that predates this phase keeps type-checking and
    behaving correctly — matching on `name` alone — without being
    touched).
  - Added `tokensMatch(inputToken, targetToken)`: exact match, then
    either-direction prefix, then a fuzzy check via the file's existing
    `isFuzzyMatch()`/`levenshteinDistance()` (reused as-is, not
    reimplemented). The fuzzy tier is additionally floored at 4
    characters on both tokens — beyond `isFuzzyMatch()`'s own 3-character
    floor — because at 3 characters its sliding window will happily
    "fuzzy-match" a common short word against a coincidental substring of
    an unrelated long name (verified: "DAI" was fuzzy-matching
    "DHANONDAYA" via its "day" run before this guard). A short word that
    genuinely abbreviates a candidate is already caught by the prefix
    tier, so nothing legitimate is lost.
  - Added `matchesCandidateNameOrAlias(inputLower, inputTokens, name,
    aliases)`: checks the typed input against a candidate's name AND
    every alias, tiered (i) exact whole-string match, (ii) whole-string
    prefix either direction OR a whole name/alias token being a prefix
    of the input, (iii) per-token comparison via `tokensMatch()` — the
    tier that lets a short abbreviation match a long multi-word name,
    since that can only ever work one token at a time.
  - Added `textMatchesAdvanceKeyword()`: the `ADVANCE_KEYWORD` ("advance")
    gate on rule 4 is now itself prefix/fuzzy-tolerant via `tokensMatch()`
    against the fixed keyword string, so "SIJAN ADV" gates the same way
    "SIJAN ADVANCE" always has (test case 6 requires this — without it,
    "ADV" would never even reach the staff-name check).
  - Rewrote `resolvePatternOnlyTags()`'s rule 3 (institution) and rule 4
    (staff-advance): both now `.filter()` every candidate for a match
    (instead of `.find()`-ing the first) and, on 2+ distinct matches,
    return `null` immediately — the same "never guess" ambiguity
    contract `resolveUniqueMatch()` already enforced elsewhere. Rules
    1/2 in `resolveTags()` are untouched.

- **`src/hooks/useFastEntrySuggestions.ts`** — the candidate-pool loader
  now includes `aliases` when mapping active institutions/staff into
  `InstitutionSuggestionCandidate`/`StaffSuggestionCandidate`.

- **`src/components/InstitutionsView.tsx`, `StaffView.tsx`,
  `VehiclesView.tsx`** — each add/edit form gained one new text input,
  "Aliases / other spellings (comma-separated)", parsed on submit into a
  string array and passed straight through to the existing
  add/edit calls. No new screen, no new nav item.

- **`scripts/test-fastentry-smart-entry.ts`** — extended the existing
  suite (not replaced) with a new "Phase 12g" section covering all 9
  required test cases:
  1. "DHANODAYA" → unique match on a long name with no alias (typo
     tolerance).
  2. Same, lowercase.
  3. "JOIN SAVING" → unique prefix match on a long name.
  4. "ZEST IDEOLOGY" → 2 distinct institutions both match → resolves to
     no unique match (`resolveUniqueMatch` returns `null`).
  5. "SIJAN ADVANCE" → unique staff match (the real case that failed
     before this phase).
  6. "SIJAN ADV" → still resolves (name-token + advance-keyword both
     prefix-tolerant).
  7. An institution whose real name shares nothing with "DHANODAYA",
     given that alias explicitly — proves the alias array is actually
     read, not just a fuzzy-match fallback via the name.
  8. "KUMAR DAI CASH" → no pattern match at all, regression-checked
     against every institution/staff introduced by tests 1–7.
  9. Every pre-existing test in this suite and in `test-fastentry.ts`,
     `test-fastentry-suggestions.ts`, `test-fastentry-enter.ts`,
     `test-ledger.ts`, `test-integration.ts`, `test-batch-entry.ts`,
     `test-bs-calendar.ts` still passes unchanged — verified by running
     the full suite before and after this phase's changes (identical
     pass counts on every file except this one, which gained exactly the
     9 new cases above).
  Also updated this file's own local `buildPool()` helper to pass
  `aliases` through into the candidate pool, and imported
  `resolveUniqueMatch`/`setInstitutionActive` for the new tests. Test
  fixtures are carefully sequenced (institutions/staff created and then
  deactivated in a specific order) so that fixture entities from earlier
  Phase 12c tests, and from one Phase 12g test case, don't produce
  incidental fuzzy-match collisions with a later test case's typed text.

## Verification performed

- `npm run build` (`tsc -b && vite build`) — passes, no type errors.
- `npm run test:ledger` — 315 passed, 0 failed (unchanged).
- `npm run test:integration` — 35 passed, 0 failed (unchanged).
- `npm run test:fastentry` — 21 passed, 0 failed (unchanged).
- `npm run test:fastentry-suggestions` — 22 passed, 0 failed (unchanged).
- `npm run test:fastentry-smart-entry` — 53 passed, 0 failed (44
  pre-existing + 9 new Phase 12g cases).
- `npm run test:fastentry-enter` — 33 passed, 0 failed (unchanged).
- `npm run test:batch-entry` — 44 passed, 0 failed (unchanged).
- `npm run test:calendar` — 36 passed, 0 failed (unchanged).
- A standalone script opening a fixture v10 database (no `aliases`
  field) through the real `CashLedgerDB` schema (with v11 present)
  confirmed the migration runs and backfills `aliases: []` onto every
  pre-existing institution/staff/vehicle row.
- **Not run in this environment:** `npm run test:sync` (the Firebase
  emulator test) — the sandbox this fix was built in blocks network
  egress to `storage.googleapis.com`, which the Firestore emulator jar
  download requires. No sync/backup/restore code was touched by this
  phase (out of scope per the brief), so this should be a pre-existing
  pass, but please run `npm run test:all` yourself to confirm the sync
  test specifically before shipping.

## Notes on deliberate design choices

- **Never guesses.** Both rule 3 and rule 4 now resolve to no match at
  all — not a first-found guess — the moment 2+ institutions or 2+ staff
  genuinely match the same typed text.
- **Fuzzy tier is conservative.** Fuzzy matching only fires token-to-token
  (never whole-string, since a 9-character abbreviation can never
  meaningfully fuzzy-match a 40-character name as one unit) and only
  between tokens of at least 4 characters each, to avoid short common
  words coincidentally matching inside long unrelated names.
- **No historical data touched.** Nothing about `Transaction`, the ledger
  cascade, the BS calendar, sync, or backup/restore was changed — a
  restored backup's already-filed `institutionId`/`staffId` on a
  historical row is untouched either way, since matching only ever runs
  on new Fast Entry input, never re-evaluated retroactively.
