# Google-account-linked App Lock recovery (optional, additional)

Implemented directly in this session (not handed to a separate builder
session), against the merged App Lock + Google Drive Backup build (see
`MERGE-NOTES-app-lock-and-drive-backup.md`). Adds a second, optional
recovery path for a forgotten App Lock PIN: signing into a previously-
linked Google account, instead of (or alongside) the existing written-
down recovery code.

## Why

The existing recovery code (Phase 7) requires writing something down and
keeping it safe - easy to lose. This adds a more convenient alternative:
link a Google account once, and a forgotten PIN can be reset by signing
into that same account later. **The recovery code path is untouched and
remains fully independently sufficient** - this is additive, never a
replacement, and never required.

## Design

- **A third, fully independent local-only secret store**
  (`officeCashLedger.googleAccountRecovery.v1`, in `lib/googleAccountRecovery.ts`
  - new file), alongside the existing three (`aiFallback`, `appLock`,
  `googleDriveBackup`). Verified directly (not assumed) with all four
  planted simultaneously: four distinct storage keys, zero collision,
  zero leakage into `exportBackup()`'s output, and `SYNC_TABLES`
  unchanged.
- **Deliberately separate from Google Drive Backup's own Google
  connection** - a different, narrower identity-only flow (Google
  Identity Services' ID-token model - `google.accounts.id.initialize` +
  `.prompt()`, verified live against current Google documentation before
  implementing), not the OAuth access-token model Drive Backup uses for
  `drive.file`. No shared import, storage, cached token, or scope between
  the two. An owner can link one without the other, both, or neither.
- **Only a salted hash is ever stored** - reuses `lib/appLock.ts`'s own
  `makeHashRecord`/`matchesHashRecord` (now exported for this reuse,
  rather than a second hashing implementation) to hash the linked
  account's `sub` claim (Google's own recommended stable identifier -
  never email, which can change). The raw `sub`, the ID token, and the
  account's email/name are never written anywhere. This is the one
  legitimate new importer of `lib/appLock.ts` beyond the UI files Phase
  7 already listed - documented and reflected in the existing structural-
  isolation test rather than left as an unexplained addition.
- **A new exported `resetViaExternalVerification(newPin)` in
  `lib/appLock.ts`** - mirrors `resetViaRecoveryCode()`'s shape (issues a
  fresh recovery code, doesn't unlock the session itself) but trusts that
  the caller has already confirmed identity through some other means.
  Clearly documented as such in its own header comment - it does not
  itself check anything, by design, so it must never be exposed as a
  general-purpose "reset the PIN" call.
- **No raw account info is ever displayed or logged**, and a failed
  sign-in and a *wrong* (non-matching) account both resolve to the exact
  same result shape (`no-match`/`sign-in-failed`, both surfaced with
  identical UI copy) - never reveals which account WAS linked to someone
  who signs into a different one.
- **UI**: Settings → App Lock gets a "Google account for recovery
  (optional)" block (Client ID input, Link/Unlink, linked-since date -
  never email/name) independent of PIN change/disable. The "Forgot your
  PIN?" screen (`LockScreen.tsx`) now offers "Reset with Google sign-in
  instead" alongside the recovery-code form whenever an account is
  linked; unlinked, the screen is completely unchanged from Phase 7.

## Bugs found and fixed while implementing (all in this session's own new code, not pre-existing)

1. **A dangling 60-second timer.** `requestGoogleIdentity()`'s
   fallback timeout (for an ignored/dismissed sign-in prompt) was never
   cleared when the sign-in resolved normally through the fast path -
   harmless in a real browser, but it silently kept the process alive
   for up to 60 extra seconds per attempt, which the automated test
   caught immediately (a `timeout`-guarded test run exited 124). Fixed by
   capturing and clearing the timeout handle as soon as the real callback
   fires.
2. **A TypeScript build error** from a Node-only `Buffer` fallback inside
   the browser-facing JWT decoder - removed; a real browser always has
   `atob` natively, and Node (used by the test suite) does too (v18+),
   so the fallback was dead code that only cost a clean build.
3. **A substring collision in an existing structural test.** Phase 7's
   own test asserts the literal `appLock` storage-key substring appears
   in exactly one file; the first draft of this feature's storage key
   (`...appLockGoogleRecovery...`) accidentally matched that check even
   though it's a fully distinct key. Renamed to
   `googleAccountRecovery` (no `appLock` substring) rather than loosen
   the test - cleaner anyway, since this module is a sibling concern, not
   part of App Lock's own storage namespace.
4. **The same existing test's exact importer allowlist** needed
   `lib/googleAccountRecovery.ts` added, since it's now a real, intended
   importer of `lib/appLock.ts` (see "Design" above) - updated with an
   explanation in the test itself, not silently.
5. **My own first draft of the test suite** called `setupLock()` a
   second time while a lock already existed (that's `changePin()`'s job)
   and separately tried `linkGoogleAccount`/Drive-style `window.google`
   deletion without actually removing `window`/`document` themselves,
   plus a fake `document.createElement` that never fired `onload` -
   all caught by running the suite myself (twice hanging, twice a wrong
   assertion) before considering this done, not assumed correct from a
   clean typecheck alone.

## Test coverage

Extended `scripts/test-app-lock.ts` in place (this feature is
conceptually part of App Lock, not a separate concern) - 187 → **215**
assertions (28 new). Covers: default/unlinked state untouched; linking
stores only a hash (raw sub/email/token absent, Client ID present since
it's not a secret); a matching account succeeds; a different account and
a cancelled/failed sign-in both fail identically; `resetViaExternalVerification`
actually changes the PIN and issues a working new recovery code; the
original recovery-code path is completely unaffected whether or not
Google is linked; unlinking works; the four-secret storage-key
independence check; sync/backup exclusion (a planted real Client ID,
inspected in the actual exported JSON); and two distinct graceful-
degradation paths (no browser environment at all, and a script that
"loads" but never actually provides `window.google`) both leave normal
App Lock usage (`isLockConfigured()`, `verify()`) completely unaffected
immediately afterward.

Fake GIS ID-token global follows the exact same technique
`scripts/test-drive-backup.ts` already established for the OAuth token
model (pre-populate `window.google` so the real script-injection path is
never exercised) - no real network call or real Google account used
anywhere in the suite.

## Verification performed

- `npm run build` (`tsc -b && vite build`) - clean, no type errors.
- `npm run lint` (`oxlint`) - **0 errors, 20 warnings**, unchanged from
  every prior phase's baseline (confirmed after fixing a workspace setup
  issue on my own end - a `cp -r dir/*` glob silently skipped dotfiles
  including `.oxlintrc.json`, which briefly produced a nonsense
  24,641-file/54,925-warning lint result until the config was restored;
  noted here because it's the kind of thing worth knowing could happen,
  not because it reflects anything about the actual code).
- Every one of the 14 `test:*` suites passes with its established count,
  rerun individually: ledger 327, integration 35, staff-vehicles 43,
  staff-profile 44, owner-data 55, fastentry 21,
  fastentry-suggestions 22, fastentry-smart-entry 88,
  fastentry-enter 42, batch-entry 44, calendar 36, ai-fallback 45,
  **app-lock 215 (was 187)**, drive-backup 56.
- `test:app-lock` re-run 3 additional times (`timeout`-guarded) to
  confirm the dangling-timer fix genuinely resolved the hang, not just
  happened to pass once.
- Planted all FOUR local-only secrets simultaneously (Gemini key, App
  Lock PIN, Drive Backup Client ID, and this feature's linked-account
  Client ID + identity hash) and called the real `exportBackup()`:
  confirmed four fully distinct `localStorage` keys with zero collision,
  and zero trace of any of the four secrets - nor any AI/lock/Drive/
  Google-recovery-shaped field at all - anywhere in the exported JSON.
  `SYNC_TABLES` confirmed unchanged.
- **Real Google Identity Services sign-in - UNVERIFIED.** Same
  restriction every phase in this project has hit: no real network
  access to Google's endpoints in this environment. Only the mocked ID-
  token flow has been exercised. **Recommend a real smoke test**: link a
  real Google account in Settings, then deliberately trigger "Forgot PIN"
  → "Reset with Google sign-in" and confirm it actually works end to end
  before relying on it - the same standard every other optional feature
  in this project has been held to.

## Known limitations (added to the project's running list)

- Real Google sign-in for this specific flow has never been exercised
  end-to-end by anyone yet (see above).
- Like every other local secret in this app, linking is per-browser-
  profile - not synced, not backed up, and gone if the owner clears this
  site's data (along with the App Lock itself, and all local data).
- The stored account hash is compared only against a fresh sign-in's
  `sub` claim read directly from the ID token's payload, without
  cryptographic signature verification - a deliberate, documented
  simplification appropriate for this specific same-device, no-backend
  use case (see `lib/googleAccountRecovery.ts`'s own header comment for
  the reasoning), not an oversight.
