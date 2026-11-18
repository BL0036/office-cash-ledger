# Phase 6 model-currency fix — stale Gemini model reference

Targeted fix, not a redesign: Phase 6's hardcoded `MODEL` constant in
`src/lib/aiFallback.ts` had gone stale (`gemini-2.5-flash-lite` is now
past its own listed earliest-shutdown date). Per this fix's own
instructions, nothing else in `aiFallback.ts`, `aiSettingsStore.ts`,
`FastEntryBar.tsx`'s AI wiring, or `SettingsView.tsx`'s AI section was
touched, and `fastEntrySuggestions.ts`/Rules 1-5/`sync.ts`/`backup.ts`
were not opened.

## Step 1 — verification performed (live web search, not training-data recall)

Checked `ai.google.dev/gemini-api/docs/models` and
`ai.google.dev/gemini-api/docs/deprecations` directly, via live web
search/fetch, on **2026-09-20**:

- **`gemini-2.5-flash-lite`** (the old value): its own deprecation entry
  lists **"Earliest shutdown: July 2026"** — confirmed already past as of
  the verification date. This matches the bug report exactly.
- The model lineup has moved to a **3.x generation** since Phase 6 was
  built. Two stable (GA, non-preview) lite-tier options exist as of the
  verification date:
  - `gemini-3.1-flash-lite` — stable, released 2026-05-07, but **already
    has an announced shutdown date: 2027-05-07** (~7.5 months of runway
    from the verification date).
  - `gemini-3.5-flash-lite` — stable, released 2026-07-21, **"No
    shutdown date announced"** as of the verification date (confirmed via
    two independent sources, one of which explicitly names it as
    `gemini-3.1-flash-lite`'s own successor).
- **Picked `gemini-3.5-flash-lite`** — the longer remaining runway of the
  two stable options, and still squarely a "lite" tier model (not
  reasoning/pro), exactly the tier this feature has always been scoped
  to. Not every lite-tier option currently has a near-term shutdown date
  already announced, so this wasn't a "pick the least-bad expiring
  option" situation — `gemini-3.5-flash-lite` genuinely has no announced
  end date yet.
- **Request/response shape**: confirmed **unchanged** for the new model —
  same `contents`/`parts` request body, same `x-goog-api-key` auth
  header, same `generationConfig.responseMimeType` +
  `responseSchema`-with-`enum` structured-output mechanism, same
  `candidates[0].content.parts[0].text` response field. Verified via a
  third-party API-docs mirror explicitly describing its `generateContent`
  endpoint as "fully compatible with Google's official request format,"
  cross-checked against Google's own Cloud/Firebase structured-output
  documentation for the same 3.5 model generation, which shows identical
  `responseMimeType`/`responseSchema` syntax to what this file already
  used.
- **CORS / direct browser calls**: still holds. This is a transport-level
  property of the classic `generateContent` endpoint itself (confirmed in
  Phase 6's own original research), not a per-model property, and nothing
  found during this verification suggests that's changed for the 3.x
  generation.
- **One observation, not acted on**: Google's own release notes for this
  model generation list `temperature`, `top_p`, and `top_k` as now-
  deprecated request parameters. This file's `generationConfig` already
  didn't set `top_p`/`top_k`, and still sets `temperature: 0`. Left as-is
  — deprecated is not the same as removed or broken, and this fix's scope
  is a targeted model-string swap, not a request-shape redesign. Worth
  revisiting the next time this file is touched for any other reason.

**Conclusion: no request/response shape change was needed.** Step 2.2
("if Step 1 found the shape needs adjustment...") did not apply.

## Step 2 — the fix

1. `src/lib/aiFallback.ts`: `MODEL` changed from `'gemini-2.5-flash-lite'`
   to `'gemini-3.5-flash-lite'`.
2. The file's header comment gained a new **"MODEL CURRENCY"** section
   recording exactly what was verified, when, and why
   `gemini-3.5-flash-lite` was picked over `gemini-3.1-flash-lite` — in
   the same documented style Phase 6 left for this fix, so the next
   person (or Claude) who has to do this again has the same trail. It
   explicitly tells that future reader to re-verify live rather than
   trust the dates in the comment, since stale trust in old research is
   exactly what caused this bug.
3. No other file was changed.

## Test coverage

- `scripts/test-ai-fallback.ts` gained **one** new assertion (44 → 45
  tests): the existing "exactly one network call fires" test case now
  also captures the request URL and asserts it targets
  `.../models/gemini-3.5-flash-lite:generateContent` — a direct
  regression guard against this exact class of bug (a stale/reverted
  model string) recurring silently in the future. No shape-change tests
  were needed since Step 1 found no shape change.
- All 44 pre-existing `test-ai-fallback.ts` assertions still pass
  unchanged with the new model string — as expected, since that suite
  mocks all networking; this confirms nothing else broke, not that the
  real model works (see Real-API verification below for that).

## Verification performed

- `npm run build` (`tsc -b && vite build`) — clean, no type errors, from
  a **fresh** `npm install` + extraction of the final ZIP.
- `npm run lint` (`oxlint`) — 0 errors, 20 warnings, unchanged.
- Every `test:*` script, rerun from the same fresh extraction — every
  pre-existing count exactly matches `CHANGELOG-phase-6.md`:

| Suite | Count |
|---|---|
| test:ledger | 327 |
| test:integration | 35 |
| test:staff-vehicles | 43 |
| test:staff-profile | 44 |
| test:owner-data | 55 |
| test:fastentry | 21 |
| test:fastentry-suggestions | 22 |
| test:fastentry-smart-entry | 88 |
| test:fastentry-enter | 42 |
| test:batch-entry | 44 |
| **test:ai-fallback** | **45 (was 44 — one new regression guard, see above)** |

### Real Gemini API — still UNVERIFIED
**Could not reach the real API in this environment**, same as Phase 6:
`curl https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent`
returns `403 Host not in allowlist: generativelanguage.googleapis.com`
from this sandbox's network egress proxy — re-tested directly for this
fix, not assumed from Phase 6's own note. No real Gemini API key was
available either. **A real "Ask AI" call with the new model string has
NOT been exercised end-to-end and remains UNVERIFIED** — the mocked test
suite proves the request is now built correctly and the response would
be parsed correctly against the (still-unchanged) expected shape, but
cannot prove Google's servers actually respond that way for this specific
model right now. **Recommend the same manual smoke test
`CHANGELOG-phase-6.md` already recommended**: with a real free Gemini API
key, type a genuinely ambiguous/unmatched description into Fast Entry,
click "Ask AI", and confirm a real, sensible suggestion comes back.

## Known limitations — unchanged, plus one addition

Everything in `CHANGELOG-phase-6.md`'s limitations list still applies.
Add:

10. **Model currency needs periodic re-verification.** Gemini model
    generations are moving fast (2.0 → 2.5 → 3.x within roughly a year),
    and even a currently-"no shutdown date announced" model
    (`gemini-3.5-flash-lite`, as of this fix) will eventually be
    superseded. This feature's fail-gracefully design means an expired
    model silently degrades to "AI suggestion unavailable" rather than
    breaking anything else — but that also means nobody will notice it's
    stale without either checking Settings' behavior directly or
    re-reading `aiFallback.ts`'s own "MODEL CURRENCY" comment
    periodically. No automated staleness check exists for this (would
    require its own network call this feature deliberately avoids making
    unprompted).
