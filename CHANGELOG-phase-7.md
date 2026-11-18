# Phase 7 — Optional App Lock (PIN / password)

A new, strictly opt-in feature. **Off by default; with it off the app
opens and behaves exactly as it did before this phase.** It follows the
Phase 6 AI-Fallback pattern: local-only storage, structurally excluded
from sync and backup, and degrading gracefully when something is
unavailable.

## What it is — and what it is not

This is a **lock screen**. It keeps a casual visitor — someone who picks
up the device or sits down at an unattended screen — out of the books.

It is **not encryption.** The ledger data in IndexedDB is stored exactly
as before, in the clear. Anyone technical enough to open the browser's
developer tools can read that data directly, or delete the single
`localStorage` entry that holds the lock (which removes the lock without
touching any data). There is no backend in this app, so there is nothing
stronger it could be. The Settings section, the setup flow, the lock
screen and the README all say this plainly.

## Research performed before writing any code

- **PBKDF2 iteration count.** Re-checked against the live OWASP Password
  Storage Cheat Sheet: the current minimum for PBKDF2-HMAC-SHA256 is
  **600,000 iterations** (it was 310,000 in the 2021–2022 editions).
  That is the count used. OWASP prefers Argon2id where available, but Web
  Crypto only offers PBKDF2, and a WASM Argon2 dependency would be
  over-engineering for a single-user local lock screen. The iteration
  count is stored *with* each hash, so it can be raised later without
  invalidating existing locks.
- **Idle detection.** The browser Idle Detection API is Chromium-only and
  needs a permission prompt (not supported in Firefox or Safari), so it
  was not used. Idle lock is built on plain input events + the Page
  Visibility API + a **timestamp comparison** (see "Idle auto-lock").
- **Web Crypto availability.** `crypto.subtle` only exists in secure
  contexts (`https://` or `localhost`). Handled explicitly — see
  "Graceful degradation".

## What was built

### 1. `src/lib/appLock.ts` (new — imports nothing at all)
- **Storage:** plain `localStorage`, key `officeCashLedger.appLock.v1`.
  Holds only `{ salt, hash, iterations }` for the PIN and for the
  recovery code, the idle-timeout setting, and the failed-attempt
  counters. The raw PIN and raw recovery code are never written anywhere.
- **Hashing:** PBKDF2-HMAC-SHA-256 via Web Crypto, 16-byte random salt
  per hash, 600,000 iterations, constant-time comparison. Text is
  NFC-normalised (so Nepali/accented passwords typed via different input
  methods match) and deliberately **not trimmed**.
- **PIN or password:** any 4–128 characters — digits, a passphrase,
  spaces, Devanagari all work.
- **Recovery code:** 20 symbols from a 32-symbol alphabet with no
  `I O 0 1` (100 bits), shown as `XXXX-XXXX-XXXX-XXXX-XXXX`. Matching is
  case/space/hyphen-insensitive so it can be typed from paper. Only its
  salted hash is stored.
- **API:** `setupLock`, `verify`, `disableLock`, `changePin`,
  `resetViaRecoveryCode`, `isLockConfigured`, `isAppLockSupported`,
  `getAppLockState`, `lockNow`, idle helpers (below). No function throws;
  every failure is a returned value.
- **Session state is in memory only.** Reloading always re-locks.
  Failed-attempt counters *are* persisted, so a reload cannot be used to
  skip a wrong-PIN wait.
- **Rate limit:** the first 4 wrong tries in a row are free (genuine
  typos aren't punished); then 5 s, 10 s, 20 s, 40 s, then 60 s per
  further failure. A correct entry resets it. Wrong recovery codes share
  the same counter. During a wait even the correct PIN is refused. Lock
  operations are serialised, so a double-Enter or scripted parallel burst
  cannot get past the limiter (six parallel wrong tries record exactly
  five failures and refuse the sixth).

### 2. Lock screen and gate (new components)
- `AppLockGate.tsx` wraps `<AppShell />` in `App.tsx`. Unconfigured →
  returns `children` untouched. **Locked → the app is not mounted at
  all**, so no screen renders and no ledger read happens behind the lock
  screen. It is a gate on the UI only; the data layer is never touched.
- `LockScreen.tsx`: on-brand full-screen unlock (bilingual, with its own
  Nepali/EN switch), wrong-PIN messages, a live countdown during a
  rate-limit wait (resumes correctly after a reload), and the
  "Forgot your PIN?" recovery-code flow. The recovery screen states
  plainly that there is no other reset and describes the last resort.
- `AppLockParts.tsx`: shared PIN field (with the same show/hide eye as the
  AI-key field) and the `RecoveryCodePanel` that shows a code **exactly
  once**, with an explicit "will NOT be shown again / no email reset"
  warning, and won't enable **Done** until the owner ticks "I've written
  down my recovery code".
- Small support files: `hooks/useAppLock.ts`, `hooks/useRetryCountdown.ts`,
  `lib/appLockMessages.ts` (bilingual messages).

### 3. Settings → "App Lock (optional)" (in `SettingsView.tsx`)
Mirrors the AI Fallback section's styling. Off state: the plain limits
statement, PIN + confirm, idle-timeout select, **Turn on App Lock** →
one-time recovery-code panel. On state: an **On** badge, the idle-timeout
select (1 / 5 / 15 / 30 / 60 min, 15 default), **Lock now**, **Change
PIN**, **Turn off App Lock…** (both need the current PIN).

### 4. Idle auto-lock
`startIdleWatcher()` (in `appLock.ts`, DOM-free — it is handed `window` /
`document` by the gate) listens for `pointerdown`, `pointermove`,
`keydown`, `wheel`, `touchstart`, `scroll`, plus `visibilitychange` and
`pageshow`, and runs a 10 s backstop tick. It is **timestamp-based**
rather than "a `setTimeout` fires after N minutes", because browsers
throttle or freeze timers in background tabs and during sleep. One
important detail: `noteActivity()` checks for an *already-expired* idle
window **before** refreshing the timestamp — otherwise waking a sleeping
laptop and nudging the mouse would reset the clock and defeat the lock.
It only runs while a lock is configured and unlocked.

### 5. Other wiring
- `App.tsx`: the gate, plus a **Lock now** button in the sidebar/drawer
  footer that renders only when a lock is configured.
- `package.json`: `test:app-lock` added and folded into `test:all`
  (before `test:sync`).
- `README.md`: feature line, an "App Lock" section, the known-limitations
  entry, the test list.

## Decisions made beyond the four listed items (each small, easy to remove)

- **"Lock now" button** (sidebar/drawer + Settings). A lock you can't
  engage on demand is weak when walking away from a desk. Renders nothing
  with no lock configured.
- **Recovery code is single-use.** After it's used to reset the PIN, a
  fresh code is issued (shown once, same panel). The old code was just
  typed on screen. The reset does *not* unlock the session by itself: the
  screen then calls `verify(newPin)`, so the only way to unlock is ever a
  successful `verify()`.
- **Lost recovery code but PIN known?** Turn App Lock off and on again for
  a new one — stated in Settings, so no extra "regenerate" feature.
- **Corrupt/unreadable lock record → treated as "no lock" (fail-open).**
  It can only arise from manual tampering (it's written atomically as one
  JSON string). Failing closed would let a damaged record lock the owner
  out permanently with no recovery path, which is worse for this feature.
- **Setup verifies the write by reading it back** and only then hands out
  the recovery code — never a "you're protected" message for a lock that
  didn't persist.
- **An empty attempt is simply a wrong PIN** (Chromium's PBKDF2 refuses a
  zero-length key, which would otherwise surface as a confusing error).

## Constraint check

1. **Opt-in, off by default, no nag.** Nothing is created or prompted
   until the owner turns it on. Verified in a real browser and by test:
   with no lock, zero `localStorage` writes, no lock UI, no "Lock now".
2. **PIN never stored plaintext.** Only salt + hash. Verified by scanning
   the raw record, every `localStorage` key/value, every Dexie table row
   and the full backup JSON for the PIN and recovery code.
3. **Proper hashing.** PBKDF2-HMAC-SHA-256, per-hash salt, 600,000
   iterations (OWASP minimum, re-verified), constant-time compare. The
   real 600,000 path is exercised end to end (about 0.1–0.2 s per
   derivation in the sandbox; a very old phone may take noticeably longer
   per unlock).
4. **Local-only; not in `SYNC_TABLES`, not in `exportBackup()`.** See
   "Sync and backup exclusion" below.
5. **Recovery.** One-time code; the only reset path; the "no email reset,
   last resort is clear-site-data + restore from backup" language is on
   the setup panel, the recovery screen, in Settings and in the README.
6. **UI gate only; data untouched.** `appLock.ts` has no imports; the
   ledger DB was byte-identical before and after every wrong/blocked
   attempt, recovery, change and disable (unit tests and real browser).
7. **Web-search verified.** OWASP iteration count and idle-detection
   support re-checked (above).
8. **Idle auto-lock, ~15 min default, configurable.** Done and verified
   with real timers in a real browser.
9. **Rate limit.** Done, persisted across reloads, verified in a real
   browser.

## Sync and backup exclusion — verified the same way as Phase 6

- **Structural:** `lib/backup.ts` and `lib/sync.ts` never reference
  `localStorage` or `appLock` (statically asserted). `appLock.ts` itself
  has **no import statements at all** — no `db`, `ledger`, `backup`,
  `sync`, Dexie or Firebase (statically asserted, comments excluded). A
  static scan of all of `src/` shows exactly six files import it —
  `App.tsx`, `AppLockGate.tsx`, `LockScreen.tsx`, `SettingsView.tsx`,
  `hooks/useAppLock.ts`, `lib/appLockMessages.ts` — and none of the data
  layer (`ledger`, `staff`, `vehicles`, `institutions`, `referenceData`,
  `budgets`, `aggregation`, `reports`, `fastEntry*`, `aiFallback`,
  `aiSettingsStore`, `backup`, `sync`, `syncConfig`, `firebaseClient`,
  `db/schema`). The storage-key string appears in exactly one source file.
- **Behavioral:** with a real lock configured, `SYNC_TABLES` and the Dexie
  schema contain no lock-related table; the exported backup has **exactly
  the pre-existing top-level keys** (nothing added) and its JSON contains
  no PIN, recovery code, salt, hash, key name or lock field — and neither
  does the serialized backup *file* text. `restoreFromBackup()` leaves the
  device's lock exactly as it was (a backup neither carries a lock in nor
  wipes one).
- **Unchanged files:** `aiFallback.ts`, `aiSettingsStore.ts`, `backup.ts`,
  `sync.ts` and `db/schema.ts` are byte-identical to the previous ZIP. The
  only existing files modified are `App.tsx`, `SettingsView.tsx`,
  `package.json` and `README.md`.

## Graceful degradation

- **No Web Crypto** (plain `http://` from another machine's address):
  `isAppLockSupported()` is false; Settings says App Lock is unavailable
  there instead of failing mysteriously; setup returns `unsupported`.
- **`localStorage` not writable:** setup reports failure, hands out no
  recovery code, and the app stays unlocked.
- **Another tab** turns the lock on/off/changes it: this tab re-evaluates
  via the `storage` event. A lock re-added elsewhere never resurrects a
  stale "unlocked" session.

## Verification

- **`npm run build`:** clean (TypeScript strict + Vite).
- **`npm run lint`:** 20 warnings, 0 errors — the same 20 pre-existing
  warnings; none from the new files.
- **`npm run test:app-lock`:** **187 assertions, all passing**, stable over
  repeated and parallel runs. Real Web Crypto throughout (nothing about
  hashing is faked); an in-memory `localStorage`; a controllable clock for
  rate-limit and idle logic; real timers + a plain `EventTarget` for the
  idle watcher. Covers the nine cases in the brief: no-lock zero-change;
  salt+hash-only storage (incl. Devanagari/NFC and same-PIN-twice
  salting, and the real 600,000-iteration path); correct/wrong PIN and the
  full 0/0/0/0/5/10/20/40/60/60 s escalation incl. across reload and
  parallel bursts; recovery (wrong code, weak new PIN, lowercase/spaces,
  single-use rotation, shared limiter); backup/sync exclusion; idle
  re-lock (15 min, activity reset, sleep/wake, clock-backwards,
  configurable, visibility, `stop()`); change/disable needing the PIN;
  corrupt-record fail-open; storage-write and Web-Crypto failure.
- **All pre-existing suites unchanged, exact counts:** ledger 327,
  integration 35, staff-vehicles 43, staff-profile 44, owner-data 55,
  fastentry 21, fastentry-suggestions 22, fastentry-smart-entry 88,
  fastentry-enter 42, batch-entry 44, calendar 36, ai-fallback 45.
- **Real-browser verification (a strength over Phase 6, which could not
  reach the real Gemini API).** Headless Chromium 153 against the
  production build served over `localhost` (a secure context, so real
  `crypto.subtle`): **48 checks, all passing** — 40 in the functional
  flow and 8 in the idle flow:
  - default: no lock UI, no "Lock now", nothing in `localStorage`;
  - setup via Settings: mismatched confirmation rejected; recovery code
    shown once; **Done** disabled until the checkbox; code gone from the
    page afterwards; stored record has 600,000 iterations, salt+hash only;
  - **reload → lock screen with none of the app rendered behind it**;
  - wrong PIN error; 5 wrong PINs → a live "try again in Ns" wait, Unlock
    disabled, **survives a reload**, works again after the wait;
  - a real Fast-Entry transaction and the reference data **byte-identical**
    after all of the above;
  - Lock now; the whole recovery flow (wrong code refused; lowercase code
    with spaces accepted; new code issued; old code and old PIN dead; new
    PIN works); Change PIN and Turn off with wrong-then-right PINs; after
    turning off, a reload opens straight into the app;
  - Nepali UI on a 390×844 mobile viewport (Settings section, recovery
    panel and lock screen all render correctly);
  - **idle lock with real timers and real input events:** 42 s of
    continued mouse/keyboard activity kept a 15 s period from firing;
    with no input it re-locked at 18 s (15 s + up to the 10 s check tick);
    the PIN unlocked it again; and a mouse nudge after the period had
    lapsed locked rather than refreshing the timer. (The idle period was
    shortened to 15 s by editing only the timeout number in the stored
    record so the real watcher could be observed in reasonable time; the
    Settings presets 1/5/15/30/60 min were separately confirmed to persist
    from both the setup form and Settings.)
  - Screenshots were inspected: the lock screen, recovery panel and
    Settings section match the app's existing look. The only console noise
    was a pre-existing Google Fonts request returning HTTP 403 because the
    build sandbox blocks that host — unrelated to this phase.

  The browser was a Chromium bundled in an npm package, installed in a
  scratch folder **outside** the project; nothing browser-related is added
  to `package.json` or the ZIP.
- **`npm run test:sync`** still needs the Firebase Local Emulator Suite
  (as before this phase) and was not part of these runs; App Lock has no
  interaction with sync by design (see exclusion evidence above).

## Known limitations

- **Deters casual access only.** It does not encrypt; DevTools can read
  the data or remove the lock (see top). Don't describe it as security
  against a determined or technical person.
- **No email/server reset — by design.** Forgotten PIN + lost recovery
  code → the last resort is clearing this site's data (or a fresh browser
  profile) and restoring from a backup file or Cloud Sync. Anything
  entered since the last backup that Cloud Sync doesn't hold would be
  lost. (A technical helper can instead delete the one `localStorage`
  entry, which keeps all data.) A wrong or forgotten PIN never deletes
  data.
- **Locking hides the whole app,** so a half-typed, unsaved entry is lost
  if the idle lock fires before it's saved. An async operation already in
  flight (e.g. a restore) still completes, but its on-screen result is not
  shown.
- **Per browser profile, not per device:** a different browser, or a
  private window, has no lock and sees no data either; clearing this
  site's browsing data removes the lock (and the local data).
- **Secure context required** (`https://` or `localhost`).
- **Recovery code is not recoverable.** Only its hash is stored; that's
  the point. Lost code but known PIN → turn the lock off and on again.
- **Older phones:** unlocking costs one 600,000-iteration derivation, and
  setup/recovery a few; fast on a modern device, slower on a very old one.
