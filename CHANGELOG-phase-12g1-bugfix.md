# Phase 12g.1 — bugfix addendum: stricter token-set matching

Fixes a false-positive bug in the Phase 12g work described in
`CHANGELOG-phase-12g.md`. See that file first for the original alias/typo
work this sits on top of.

## The bug

`matchesCandidateNameOrAlias()`'s tier (iii) (per-token comparison)
counted a candidate as matching the moment **any single** input-token /
candidate-token pair matched, anywhere in either string, and never
checked what happened to the rest of what the owner typed. Two proven
false results against real data:

1. **"JOIN SAVING"** (should uniquely match "JOIN SAVING & CREDIT
   CO-OPERATIVE LIMITED") became AMBIGUOUS, because both "ZEST IDEOLOGY
   SAVING & CREDIT CO-OPERATIVE LTD (...)" institutions also "matched" —
   via the single word "SAVING" they happen to share, while "JOIN" itself
   matched nothing in either ZEST name and was never checked.
2. **"KUMAR DAI CASH"** (should match nothing — explicit test case 8 from
   the original brief) FALSELY and UNIQUELY auto-tagged "ZEST IDEOLOGY
   SAVING & CREDIT CO-OPERATIVE LTD (KUMDAR ACHARYA))", because "KUMAR"
   fuzzy-matches the single buried token "KUMDAR", and "DAI"/"CASH" were
   never checked against anything else in that name.

## The fix

`src/lib/fastEntrySuggestions.ts`:

- Added `everyElementMatchesDistinctPartner(mustCover, pool, matches)` — a
  generic bipartite matcher (standard Kuhn's augmenting-path algorithm,
  fine at token-list sizes): does every element of `mustCover` have its
  own distinct partner in `pool`? An unmatched `pool` element is fine;
  every `mustCover` element must land on a *different* `pool` element (no
  reusing one partner for two).
- Added `tokenSetsMatch(inputTokens, targetTokens)`, which replaces the
  old "any one pair" loop in tier (iii). A candidate now counts as
  matching when **either**:
  - every INPUT token is covered by a distinct candidate token (the fix
    the bug report asked for directly — "JOIN SAVING" needs exactly this
    against its own real institution, and per EXACT SCOPE the
    candidate's own *remaining* tokens still don't all need covering —
    that's what keeps "JOIN SAVING" legally matching a 6-token name), **or**
  - every one of the CANDIDATE's own tokens is covered by a distinct
    input token.

  The second condition was **not** in the literal bug-fix instructions —
  it's an addition I found necessary while implementing the first one
  literally. Doing *only* "every input token must match" breaks a
  pre-existing, still-actively-tested case: `"Deposit to Dhanodaya"`
  (and the equally pre-existing `"Advance - Sijan"` pattern) are
  free-form SENTENCES where "Deposit"/"to"/"Advance"/"-" are filler
  words never meant to be part of an institution/staff name — they don't
  match anything, by design, and were never supposed to. Structurally
  that's the *exact same shape* as the two bugs above (one word
  identifies the entity, the rest doesn't match) — so token-count alone
  cannot tell "wanted" (sentence-embedded reference) from "unwanted"
  (coincidental) apart on the input side. What *does* distinguish them:
  in both bugs, the false match only ever explains a small minority of
  the matched candidate's OWN 9-token name ("SAVING" is 1 of 9;
  "KUMDAR" is 1 of 9). In the genuine sentence-embedded cases, the
  matched name is short enough that the one token that matches is the
  candidate's ENTIRE name ("Dhanodaya" is 1 token, wholly covered;
  "Sijan" is 1 token, wholly covered). Requiring "every candidate token
  covered" as an alternative path captures exactly that — it's only
  reachable at all for short (few-token) candidate names, since it needs
  one distinct input token per candidate token — while still fully
  fixing both reported bugs, whose candidates are 9 tokens long. I
  verified this by running the actual suite: the literal single-direction
  fix broke `"Deposit to Dhanodaya"` (5 assertions, plus a knock-on crash
  further down the same test from an unexpected `null`); the symmetric
  version above passes everything, old and new.
- Rewrote tier (iii) in `matchesCandidateNameOrAlias()` to call
  `tokenSetsMatch(inputTokens, targetTokens)` instead of the old
  any-pair loop. Tiers (i) and (ii) are untouched. The 4-character floor
  on the fuzzy sub-tier inside `tokensMatch()` (from Phase 12g) is
  untouched too.

## Regression tests added

`scripts/test-fastentry-smart-entry.ts` — a new "Phase 12g.1 bugfix
regression" section, seeded with the exact real institution/staff names
that exposed the bug (not simplified fixtures):

- `"ZEST IDEOLOGY SAVING & CREDIT CO-OPERATIVE LTD (SABIN ACHARYA)"`
- `"ZEST IDEOLOGY SAVING & CREDIT CO-OPERATIVE LTD (KUMDAR ACHARYA))"`
- `"JOIN SAVING & CREDIT CO-OPERATIVE LIMITED"`
- `"DHANONDAYA MULTIPURPOSE CO-OPERATIVE LTD"`
- Staff `"SIJAN RAI"`

Cases:
1. `"JOIN SAVING"` → resolves uniquely to JOIN SAVING & CREDIT
   CO-OPERATIVE LIMITED only.
2. `"KUMAR DAI CASH"` → resolves to no match at all.
3. `"ZEST IDEOLOGY"` → still correctly ambiguous between the two ZEST
   institutions.
4. `"DHANODAYA"` → still uniquely resolves to DHANONDAYA MULTIPURPOSE
   CO-OPERATIVE LTD.
5. `"SIJAN ADVANCE"` and `"SIJAN ADV"` → both still uniquely resolve to
   SIJAN RAI.
6. Every pre-existing test in this file and in `test-fastentry.ts`,
   `test-fastentry-suggestions.ts`, `test-fastentry-enter.ts`,
   `test-ledger.ts`, `test-integration.ts`, `test-batch-entry.ts`,
   `test-bs-calendar.ts` still passes, with identical pass counts to
   `CHANGELOG-phase-12g.md` — verified by running every `test:*` script
   before and after this fix. This file's own count went from 53 → 59
   (the 6 new assertions above; item 5 is 2 assertions).

Two pieces of existing test-fixture state needed deactivating before
this new section runs, to avoid the new fixtures colliding with earlier
Phase 12g fixtures that share a name/token and are still sitting active
in the same shared test database: the earlier section's own "JOIN
SAVING & CREDIT CO-OPERATIVE LIMITED" institution and "SUNRISE
COOPERATIVE" (alias "DHANODAYA") institution, plus the original single-
word "Sijan" staff fixture (its "sijan" token would otherwise tie with
the new "SIJAN RAI" for the same typed text). All three are deactivated
via the existing `setInstitutionActive()`/`setStaffActive()` — no
schema or production-code change involved, purely test-fixture hygiene.

## Verification performed

- `npm run build` (`tsc -b && vite build`) — passes, no type errors.
- Every `test:*` script (`test:ledger`, `test:integration`,
  `test:fastentry`, `test:fastentry-suggestions`,
  `test:fastentry-smart-entry`, `test:fastentry-enter`,
  `test:batch-entry`, `test:calendar`) — all green, same pass counts as
  `CHANGELOG-phase-12g.md` reports except `test:fastentry-smart-entry`
  (53 → 59, exactly the 6 new assertions above).
- A standalone Node script directly exercising `tokenSetsMatch()`'s
  underlying algorithm confirmed, before touching the test file, that:
  `"JOIN SAVING"` matches only its real institution and neither ZEST
  institution; `"KUMAR DAI CASH"` matches neither ZEST institution;
  `"ZEST IDEOLOGY"` still matches both ZEST institutions (ambiguity
  preserved).
- `npm run test:sync` (Firebase emulator) — not run in this sandboxed
  environment (blocks network egress to `storage.googleapis.com`,
  needed for the emulator jar download); this fix doesn't touch
  anything sync/backup-related, so it should be unaffected, but please
  confirm in your own environment before shipping.

## Files touched (fix only — same two files as scoped)

- `src/lib/fastEntrySuggestions.ts`
- `scripts/test-fastentry-smart-entry.ts`

Nothing outside these two files was touched.
