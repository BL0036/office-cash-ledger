# Phase 6 — Optional, on-demand Gemini API fallback for Smart Entry

A genuinely new feature, added after the original 5-phase plan completed
and was fully verified. This is a deliberate, narrow, owner-approved
reversal of ONE constraint from the original brief (no external AI/API
dependency) — every other constraint (minimal changes, preserve existing
behavior, ask-don't-guess, no feature bloat) still fully applies, and
Rules 1-5 of the deterministic Smart Entry engine are completely
untouched by this phase.

## Research performed before writing any code (constraint #7)

Verified against current documentation and independent corroborating
sources before implementing:

- **Endpoint**: the classic `generateContent` REST call
  (`POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`)
  remains fully supported by Google.
- **CORS / direct browser calls**: confirmed via multiple independent
  sources that classic `generateContent` supports direct browser-side
  fetch calls with general CORS (no special header needed) from an
  arbitrary origin. Google's newer "Interactions API" has a known browser
  CORS bug caused by a custom `Api-Revision` header its SDK sets — classic
  `generateContent` never sets that header, which is exactly why it works
  from a browser and the newer API doesn't. **This app has no backend to
  proxy through, and direct browser calls ARE viable** — so this phase did
  not need to stop and report a CORS blocker.
- **Model**: `gemini-2.5-flash-lite` — the current stable (non-preview),
  free-tier-friendliest model for a lightweight one-shot classification
  call like this one.
- **Auth**: `x-goog-api-key` header (current recommended approach).
- **Structured output**: `generationConfig.responseMimeType:
  "application/json"` + `responseSchema` with an `enum` constraint is
  supported, and used here so the model can only ever return one of the
  owner's own real candidate indices or the literal `"NONE"` — with the
  returned value still re-validated locally against the real candidate
  array as defense in depth (never trust schema compliance alone for
  something that could reach the owner's ledger).

## What was built

### 1. `src/lib/aiSettingsStore.ts` (new)
Local-only storage for the enabled flag + API key. **Deliberately not a
Dexie table** — stored in plain browser `localStorage`, a mechanism
`lib/sync.ts` and `lib/backup.ts` have never imported or referenced
anywhere in this codebase. This is a stronger guarantee than "a Dexie
table we remembered to exclude from two allowlists": it's structurally
impossible for a key stored here to reach `SYNC_TABLES` or
`BackupPayload`, since neither file's code has any path to `localStorage`
at all. Wrapped in try/catch throughout (a storage-layer hiccup here must
degrade as gracefully as a network failure does).

### 2. `src/lib/aiFallback.ts` (new)
- `buildAiCandidates(pool)`: flattens the SAME already-loaded
  `SuggestionCandidatePool` FastEntryBar.tsx already has (no extra Dexie
  access) into one list — expense-head combinations, institutions, staff
  (advance pattern), and vehicles (maintenance pattern) — each already
  carrying the exact `FastEntrySuggestionMatch` fields rules 2-5's own
  conventions would produce, so a picked candidate is immediately usable
  as a real suggestion. Only real owner data ever appears in this list;
  nothing is invented here or by the prompt.
- `requestAiFallbackSuggestion(description, direction, pool)`: the one
  function that makes the one network call. Returns
  `{ok:false, reason}` — never throws — for every failure mode: not
  configured, network error, timeout (15s, `AbortController`), non-2xx
  (429/401/403/5xx all specifically labeled), malformed JSON, empty
  response, or an out-of-range/hallucinated index. Returns
  `{ok:true, suggestion: null}` when the model itself confidently found
  nothing. Never imports or calls `addTransaction`/`editTransaction`/any
  write path — statically verified by `test-ai-fallback.ts` (greps this
  file's own source for those identifiers).

### 3. `fastEntrySuggestions.ts` — one additive field only
Added `source?: 'ai'` to `FastEntrySuggestionMatch`. Nothing else in this
file changed — `deriveSuggestions()`, `resolveUniqueMatch()`,
`resolvePatternOnlyTags()`, and Rules 1-5 themselves are byte-for-byte
untouched, confirmed by the full pre-existing test suite (327+35+43+
44+21+22+88+42+44+36+55 = 757 tests) passing unchanged.

### 4. `FastEntryBar.tsx` wiring
- `hasConfidentDeterministicMatch` — a fresh `resolveUniqueMatch()` call
  for the current text, completely separate from the existing Enter-key
  handler's own call to the same function (no shared cache, so nothing
  here can affect existing Enter-key behavior).
- `canAskAi` — true only when: configured (key + enabled) AND text ≥ 3
  chars AND no confident deterministic match. This is PURE local-state
  logic; computing it never itself makes a network call.
- The "Ask AI" button renders ONLY when `canAskAi` is true — with no key
  configured, `canAskAi` is always false and this entire block doesn't
  render, so there is zero new UI in the default/inert case.
- `handleAskAi()` is the ONLY place in this phase's code that can
  originate a network call, fired exclusively by the button's `onClick`.
  A stale AI answer is discarded if the owner kept typing while the
  request was in flight (compares the description at request-time vs.
  now before applying the result).
- The AI's result is appended to the SAME `suggestions` array the
  dropdown already renders (`[...deterministicSuggestions, aiSuggestion]`)
  — there is no second suggestion UI — and goes through the exact same
  `selectSuggestion()`/`applyMatchTagsSafely()` any deterministic match
  does. A small "AI" badge (Sparkles icon) renders on that one row only,
  via `s.source === 'ai'`.
- Editing the description (the `onChange` handler) immediately clears any
  stale `aiSuggestion`/`aiStatus`, and `resetForm()` does too.

### 5. `SettingsView.tsx` — new "AI Fallback (optional)" section
Matches the existing Cloud Sync section's card/heading/copy style: an
enable checkbox, a password-style key input with a show/hide eye-icon
toggle, an explanation of exactly what this does and does not do (mirrors
this changelog's own language), and a link to
`aistudio.google.com/apikey`. Off by default.

## Test coverage

New `scripts/test-ai-fallback.ts` (44 tests, `npm run test:ai-fallback`,
folded into `test:all`). All network calls and `localStorage` are mocked
— no real API key is required or used to run this suite. Covers every
numbered test case from the spec:

1. No key configured → `isAiFallbackConfigured()` false,
   `requestAiFallbackSuggestion()` refuses immediately with zero fetch
   calls, and the exact `canAskAi` condition FastEntryBar.tsx uses (
   mirrored here since a `.tsx` component can't be imported into this
   headless runner) evaluates false. Also checked the half-configured
   case (enabled but no key).
2. A key configured, "KHAJA" (which the deterministic engine already
   resolves) → `canAskAi` false, zero fetch calls even when the gated
   call path is exercised directly.
3. A key configured, genuinely novel text → `canAskAi` true, exactly one
   fetch call fires.
4. A successful mocked response naming a real candidate → returns a
   plain `FastEntrySuggestionMatch` data object (`source: 'ai'`), zero
   database writes from the call itself, and the module's own source is
   statically confirmed to never import a write path. Also confirmed an
   out-of-range/hallucinated index is treated as "no match", never
   guessed at.
5. Six distinct failure modes (network throw, 429, empty/malformed body,
   a `.json()` that itself throws, an `AbortError` timeout, and a 401
   invalid-key response) — each resolves to `{ok:false}` with a
   human-readable reason, and a REAL `addTransaction()` call immediately
   afterward is asserted to succeed every time, proving Fast Entry's
   save path is completely unaffected by any of them.
6. `SYNC_TABLES` contains no AI-related name; `exportBackup()`'s output
   contains no trace of the configured key value and no
   `aiSettings`/`apiKey`/`geminiKey` top-level field; `lib/backup.ts` and
   `lib/sync.ts` are statically confirmed to never import
   `aiSettingsStore`/`aiFallback` at all.
7. The existing double-submit save guard, replayed with the AI affordance
   genuinely visible (configured + no deterministic match) but never
   triggered — confirms it still saves exactly once, and confirms zero
   network calls happen purely from the save race.
8. Every pre-existing suite reruns with its exact prior count.

Two genuine self-inflicted test bugs were found and fixed while writing
this suite (not product bugs): two of my own "novel/unmatched" test
description strings accidentally contained a word one edit-distance away
from a test fixture institution's name ("TEXT" vs. "TEST", both times),
which Phase 12g's legitimate typo-tolerance correctly matched. Fixed by
choosing description text with no token overlap with any fixture name.

## Verification performed
- `npm run build` (`tsc -b && vite build`) — clean, no type errors, from
  a **fresh** `npm install` + extraction of the final ZIP.
- `npm run lint` (`oxlint`) — 0 errors, 20 warnings (unchanged from
  Phase 5's baseline; briefly went to 21 from one unused import in this
  phase's own new test file, found and fixed).
- Every `test:*` script, rerun from the same fresh extraction:

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
| test:calendar | 36 |
| **test:ai-fallback** | **44 (new)** |

All pre-existing counts exactly match `CHANGELOG-phase-5.md`. No test was
weakened or deleted to force a pass.

### API key exclusion from sync/backup — explicit confirmation
Confirmed three ways: (1) `SYNC_TABLES` in `lib/sync.ts` is an unmodified
array with no AI-related entry; (2) `exportBackup()`'s actual output was
inspected directly in the test and contains no trace of a configured key
value and no key-shaped top-level field; (3) `lib/backup.ts` and
`lib/sync.ts`'s own source text was read and confirmed to contain no
reference to `aiSettingsStore` or `aiFallback` at all — not "excluded by
convention", genuinely never imported.

### Real Gemini API — UNVERIFIED
**Could not reach the real API in this environment.** Directly tested:
`curl https://generativelanguage.googleapis.com/v1beta/models` returns
`403 Host not in allowlist: generativelanguage.googleapis.com` from this
sandbox's network egress proxy — the exact same class of restriction
prior phases hit with `storage.googleapis.com` (Firestore emulator) and a
Playwright Chromium download host. No real Gemini API key was available
or used either way. **Real-API behavior (a genuine ambiguous/unmatched
description, clicking "Ask AI", getting back a real suggestion pulled
from the owner's actual candidate names, and selecting it without
auto-saving) has NOT been verified end-to-end and is marked UNVERIFIED**,
per the acceptance criteria's own instruction not to claim this works on
the strength of the mocked tests alone. The mocked test suite (44 tests)
does verify the entire code path's logic — request construction,
response parsing, every failure mode, and the suggestion-only/never-
auto-applied guarantee — against a controlled fake response; it does not
and cannot verify that a real Gemini response actually arrives in the
shape this code expects. **Recommend a manual smoke test with a real free
Gemini API key before relying on this feature**: type a genuinely
ambiguous or unmatched description into Fast Entry, click "Ask AI", and
confirm a sensible suggestion appears and behaves as described here.

## Every known limitation, updated for this phase

Everything listed in `CHANGELOG-phase-5.md`'s own limitations list still
applies unchanged (schemaVersion exact-match restore, the Rule 1 history-
priority interaction, `test:sync`'s emulator-download requirement, the
7-vs-6 expense-head seed count, the bundle size, print views never
rendered in a real browser, and Firebase sync never run against a real
emulator). This phase adds:

8. **AI Fallback sends data to Google when explicitly triggered.** With
   it off (the default), nothing changes at all. With it on, each "Ask
   AI" click sends the typed description and the owner's own category/
   staff/vehicle/institution *names* (never amounts or transaction
   history) to Google's Gemini API over the public internet. The API key
   lives in this browser's `localStorage` only: per-browser-profile (not
   shared across browsers or devices even on the same machine), never
   synced, never backed up, and cleared if the owner clears this site's
   browsing data — with no in-app way to view/rotate/revoke it (do that
   at aistudio.google.com/apikey directly).
9. **Real Gemini API behavior is UNVERIFIED** — see above. Only mocked
   network responses have been exercised in this project so far.
