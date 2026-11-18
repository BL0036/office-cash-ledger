# Phase 12g.2 — bugfix addendum: removing tier (ii)'s over-loose whole-token prefix check

Fixes a false-positive/false-ambiguity bug in `matchesCandidateNameOrAlias()`,
the same frozen matcher `CHANGELOG-phase-12g.md` and
`CHANGELOG-phase-12g1-bugfix.md` built and hardened, and that
`CHANGELOG-phase-3.md`'s rule 5 (vehicle maintenance) reuses verbatim.
Read those three first — this sits directly on top of them, and resolves
Phase 3's own documented Test 6 deviation.

## The bug

`matchesCandidateNameOrAlias()`'s tier (ii) contained this line:

```ts
if (targetTokens.some((t) => inputLower.startsWith(t))) return true;
```

This asked "is ANY SINGLE token of the candidate's name a prefix of the
ENTIRE typed string?" — an extremely loose test that `return true`d
before the precise, per-token tier (iii) (the one Phase 12g.1 hardened)
ever ran. Two proven consequences against the owner's real master data:

1. **`"PULSAR 150 SERVICE"`** matched BOTH `"PULSAR 150"` and `"PULSAR
   220 SIJEN"`, purely on the shared first word "PULSAR" — so it
   resolved to NOTHING (false ambiguity). Tier (iii) would have
   correctly narrowed this to `"PULSAR 150"` alone via the "150" vs.
   "220"/"SIJEN" difference, but never got the chance. This is exactly
   Phase 3's documented deviation (its own Test 6 asserted the
   wrong-for-the-owner `null` outcome, with a full explanation of why).
2. The same loose path — not tier (iii) — was what actually matched
   ordinary real inputs like `"JOIN SAVING DEPOSIT"`, `"DHANONDAYA
   DEPOSIT"`, and (discovered while regression-testing this fix)
   `"SIJAN ADVANCE"` against a plain `"SIJAN RAI"` staff record with no
   alias. These landed on the right answer only because no competing
   candidate happened to share their first word — correct by luck, not
   by logic.

This line predates Phase 3 (it's Phase 12g's own tier (ii); Phase 12g.1
only hardened tier (iii)). Phase 3 correctly refused to touch it as out
of scope and documented the resulting Test 6 deviation instead of
fudging it.

## The fix

`src/lib/fastEntrySuggestions.ts` — removed the loose
`targetTokens.some((t) => inputLower.startsWith(t))` line from tier (ii)
entirely. Tier (ii) now contains ONLY the whole-string prefix check in
both directions:

```ts
if (targetLower.startsWith(inputLower) || inputLower.startsWith(targetLower)) return true;
```

Everything else falls straight through to tier (iii)'s
`tokenSetsMatch()`, unchanged. No replacement heuristic was added, tier
(iii) was not loosened, and no second matcher was written. Only the
inline doc comment above `matchesCandidateNameOrAlias()` was also
updated, to describe the fix and drop the reference to the removed
check.

`scripts/test-fastentry-smart-entry.ts` — Phase 3's own Test 6 (`"PULSAR
150 SERVICE"`) is rewritten: it now asserts the fix's headline result —
unique resolution to Vehicle Maintenance / Service / "PULSAR 150", Staff
unset — replacing the old "documented deviation" assertion and its
inline explanation with a short note that this phase's tier (ii) fix
resolved it.

## What broke when the line was removed, and how each case was handled

Per this phase's own instructions, nothing was patched around by
loosening tier (iii) or adding a new heuristic. Every case below was
verified directly against `matchesCandidateNameOrAlias()` (via a
throwaway Node/tsx probe script exercising the real function, not by
hand-reasoning about the algorithm) before any test was written or
changed.

### 1. Genuine regression in a pre-existing test — outcome updated, fully explained

**Phase 12g.1's own "Bugfix 5"** (`scripts/test-fastentry-smart-entry.ts`,
"Phase 12g.1 bugfix regression" section) asserted `"SIJAN ADVANCE"` and
`"SIJAN ADV"` uniquely resolve to a staff record named `"SIJAN RAI"`
with **no alias**. This was never actually exercising tier (iii) — it
was passing purely because token "sijan" is a prefix of the whole input
string "sijan advance"/"sijan adv", i.e. the exact loose tier (ii) line
this phase removes. Verified directly: with the line removed,
`matchesCandidateNameOrAlias('sijan advance', ['sijan','advance'],
'SIJAN RAI', undefined)` returns `false`. Tier (iii) genuinely cannot
match this pair: "advance" has no partner among {"sijan","rai"} (so not
every input token is covered), and "rai" is never typed, fuzzy or
otherwise (so not every candidate token is covered either) — neither of
`tokenSetsMatch()`'s two directions holds.

This is structurally the same class of bug as items 1–2 above — a false
pass that "happened" to be correct only because of the removed line —
so per this phase's own instructions this is reported and the test's
expected outcome is corrected to `null`, not silently kept green. The
in-line comment explains the root cause and notes the by-design fix:
Phase 12g's own alias mechanism, already required for the structurally
identical case in Phase 3's Part B fixture (`"SIJAN RAI"` there
**does** carry a `"SIJAN"` alias, added specifically because "SIJAN
alone never covers RAI" under the frozen tier (iii)). Adding a `"SIJAN"`
alias to the real `"SIJAN RAI"` record would restore the match — a data
change for the owner to make, not a code change, and not something this
test can assume on its own.

### 2. This phase's own required test cases 4 & 5 do not hold as written — reported, not patched around

The task brief's required tests asked for:

- `"JOIN SAVING DEPOSIT"` → uniquely resolves to `JOIN SAVING & CREDIT
  CO-OPERATIVE LIMITED`, "but now via tier (iii), not the removed loose
  path."
- `"DHANONDAYA DEPOSIT"` → uniquely resolves to `DHANONDAYA MULTIPURPOSE
  CO-OPERATIVE LTD`.

Verified directly: both resolve to `null` after the fix, not to a
unique match. Root cause, confirmed by tracing the actual function
rather than assumed: `tokenSetsMatch()` requires EITHER (a) every input
token covered by a distinct candidate-name token, OR (b) every one of
the candidate's OWN tokens covered by a distinct input token.

- Direction (a) fails: "deposit" has no partner in either institution's
  name tokens (`join`/`saving`/`&`/`credit`/`co-operative`/`limited`, or
  `dhanondaya`/`multipurpose`/`co-operative`/`ltd`) — not exact, not a
  prefix, and not fuzzy-close enough (both institution names are long
  enough, and "deposit" different enough, that `isFuzzyMatch()`'s
  edit-distance-2 threshold at 7-character window length never fires).
- Direction (b) fails structurally regardless of what the words are:
  both institution names have 6 (JOIN SAVING...) and 4 (DHANONDAYA...)
  tokens respectively, but the typed input only supplies 2–3 tokens —
  a bipartite matching that needs one **distinct** input-token partner
  per candidate-name token cannot succeed when the candidate has more
  tokens than the input does, full stop.

This is a genuine, pre-existing gap in tier (iii)'s own design — it was
never built to handle "a long (multi-word) candidate name plus one
unrelated trailing word the owner also typed" — not a regression
introduced by removing the tier (ii) line. It was simply masked before
this fix by that same loose line matching on each institution's
distinctive first token ("join"/"dhanondaya" as a prefix of the whole
typed string) — precisely the "correct by luck, not by logic" pattern
this phase's own bug report warned about for these two exact examples.

Per this phase's explicit scope (tier (iii)/`tokenSetsMatch()` and
rules 1–5's own logic are out of bounds; no replacement heuristic; no
second matcher), this was **not** patched around. Both test cases are
written with their true, verified outcome (`null`), with a full
in-line explanation, following the same pattern Phase 3 itself used for
its own Test 6 deviation before this fix. As with the SIJAN ADVANCE
case, the practical mitigation — noted in the test comment, not
applied — is a `"JOIN SAVING"` / `"DHANONDAYA"` alias on the real
institution records, the same mechanism Phase 12g built for exactly
this shape of problem.

**If this outcome isn't acceptable**, the realistic paths forward are
the same shape as Phase 3 laid out for its own Test 6: either (a) treat
these two specific inputs as a known, accepted gap and rely on the
owner adding aliases to the real institution records, or (b) explicitly
authorize a further, separately-scoped hardening of `tokenSetsMatch()`
itself to recognize "candidate mostly covered, one unrelated filler
token typed" for longer candidate names — which needs its own full
regression pass against every existing rule 1–5 fixture, not just these
two institutions.

### 3. Comment-only fix (outcome unchanged, reasoning was wrong)

Phase 3's Test 7 (`"PULSAR SERVICE"`, no disambiguating model number) —
outcome remains `null`, but the reason changed and the old comment was
no longer accurate. Before this phase, it hit the same loose tier (ii)
line as the Test 6 bug, for BOTH Pulsar vehicles, so it was genuinely a
2-way ambiguity (2 matches → never guess → `null`). After the fix,
verified directly: **neither** vehicle matches at all (0 matches, not
2) — "service" has no token to pair with in either vehicle's name, and
neither vehicle's own tokens ("220"/"sijen" or "150") are present in the
input. The observable outcome is identical (no auto-tag), so the
assertion itself needed no change — only the comment, which is now
updated to describe 0-matches rather than a 2-way ambiguity.

## New tests added (required by this phase's brief)

All added to the existing "Phase 3 Part B" section in
`scripts/test-fastentry-smart-entry.ts` (renumbered Test 11–14), which
already had every needed institution fixture active in its pool (the
"Phase 12g.1 bugfix regression" section's ZEST/JOIN SAVING/DHANONDAYA
institutions, deactivated only after Part B runs) and already had its
own scoped staff/vehicle candidates:

- **Test 11**: `"SPLENDER SERVICE"` → uniquely resolves to `SPLENDER`
  (single-token vehicle name, regression-checked directly).
- **Test 12**: `"VAN REPAIR"` → uniquely resolves to `VAN` (new vehicle
  fixture added: `VAN`, alongside a `CAR` fixture per the brief's
  vehicle list, though no test currently exercises `CAR` directly beyond
  it existing in the pool as a genuine unrelated-candidate check).
- **Test 13, 14**: the documented `"JOIN SAVING DEPOSIT"` /
  `"DHANONDAYA DEPOSIT"` gap cases described above.

`scripts/test-fastentry-smart-entry.ts`'s own `bugfixSijanRaiId`
variable (Phase 12g.1's fixture, now referenced only by its declaration
since Bugfix 5 no longer asserts against its id) was renamed to
`_bugfixSijanRaiId` to keep it lint-clean at the pre-existing warning
count, per the codebase's existing unused-variable convention.

## Verification performed

- `npm run build` (`tsc -b && vite build`) — clean, no type errors.
- `npm run lint` (`oxlint`) — **0 errors, 20 warnings** — identical count
  to `CHANGELOG-phase-3.md`'s report; all pre-existing
  `react/set-state-in-effect` warnings, none new (confirmed by renaming
  the now-unused `bugfixSijanRaiId` fixture).
- `npm run test:ledger` — **327 passed, 0 failed** (unchanged).
- `npm run test:integration` — **35 passed, 0 failed** (unchanged).
- `npm run test:staff-vehicles` — **43 passed, 0 failed** (unchanged).
- `npm run test:fastentry` — **21 passed, 0 failed** (unchanged).
- `npm run test:fastentry-suggestions` — **22 passed, 0 failed** (unchanged).
- `npm run test:fastentry-smart-entry` — **88 passed, 0 failed** (up
  from 78: Bugfix 5's two assertions were simplified from 2
  id-comparisons to 2 null-comparisons — no net change there — and 12
  new assertions were added across Tests 6, 7, 11, 12, 13, 14; every
  pre-existing assertion that didn't need to change for this fix still
  passes unchanged).
- `npm run test:fastentry-enter` — **33 passed, 0 failed** (unchanged).
- `npm run test:batch-entry` — **44 passed, 0 failed** (unchanged).
- `npm run test:calendar` — **36 passed, 0 failed** (unchanged).
- **Not run in this environment:** `npm run test:sync` — same
  limitation every prior phase's changelog reports: the Firestore
  emulator jar download fails (`Error: download failed, status 403:
  Host not in allowlist: storage.googleapis.com`). Nothing in this
  phase touches `lib/sync.ts` or any sync-related code, so this should
  be a pre-existing pass, but please run it yourself before shipping.

## List of every test whose expectation or comment changed, and why

1. **Test 6** (`"PULSAR 150 SERVICE"`, Phase 3 Part B) — expectation
   changed from `null` to a full unique match. This is the fix's own
   headline case, explicitly required by this phase's brief.
2. **Test 7** (`"PULSAR SERVICE"`, Phase 3 Part B) — expectation
   unchanged (`null`); comment corrected from "2-way ambiguity" to
   "0 matches", verified directly.
3. **Bugfix 5** (`"SIJAN ADVANCE"` / `"SIJAN ADV"` vs. bare `"SIJAN
   RAI"`, Phase 12g.1 regression section) — expectation changed from a
   unique-match id comparison to `null`. Root cause: this assertion was
   only ever passing via the same loose tier (ii) line this phase
   removes, not via tier (iii). See "Genuine regression" above.
4. **Test 13, 14 (new)** (`"JOIN SAVING DEPOSIT"`, `"DHANONDAYA
   DEPOSIT"`) — added per this phase's brief with their true, verified
   outcome (`null`), which differs from the brief's own anticipated
   outcome (a unique match). See "required test cases do not hold"
   above for the full root-cause trace and why this was reported rather
   than patched around.

## Files touched

- `src/lib/fastEntrySuggestions.ts` — the tier (ii) fix and its doc
  comment.
- `scripts/test-fastentry-smart-entry.ts` — Test 6 rewritten, Test 7
  comment corrected, Bugfix 5 corrected, Tests 11–14 added, `VAN`/`CAR`
  vehicle fixtures added to Part B's pool, `bugfixSijanRaiId` renamed to
  `_bugfixSijanRaiId`.

Nothing outside these two files was touched. `lib/staffVehicles.ts`,
`lib/sync.ts`, `lib/backup.ts`, and Part A (the advisory advance-limit
work) were not touched, per this phase's explicit scope.
