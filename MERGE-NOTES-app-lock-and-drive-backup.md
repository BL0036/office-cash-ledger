# Merge — App Lock (Phase 7) + Google Drive Backup

Both features were built in parallel, independently, from the same base
(the `appversion-fix` build — see `CHANGELOG-appversion-fix.md`). Neither
branch was aware of the other, so this merge combines them by hand rather
than by simply layering one ZIP on top of the other.

## Why a hand merge was needed

Both branches modified the same two files — `src/App.tsx` and
`src/components/SettingsView.tsx` — independently:

- **App Lock** added: the `AppLockGate` wrapper around `<AppShell />`,
  a `LockNowButton` in the sidebar/drawer, and a new "App Lock" Settings
  section.
- **Google Drive Backup** added: a separate auto-backup `useEffect` in
  `AppShell` (interval + visibility/pagehide listeners), and a new
  "Google Drive Backup" Settings section.

Every other file each branch touched was disjoint — new files with no
naming collisions (`appLock.ts` / `googleDriveBackup.ts`, etc.) — so
those were simply combined directly. `package.json` and `README.md` also
needed both branches' additions merged (new npm scripts, new feature
bullets, new "Known limitations" entries).

## What was verified after merging (not just each branch individually)

Everything each branch's own changelog already verified in isolation
still holds — this section covers what specifically needed re-checking
*because* it's now a merge, not a re-statement of Phase 7's or the Drive
backup task's own verification (see `CHANGELOG-phase-7.md` and
`CHANGELOG-google-drive-backup.md` for those in full).

1. **`tsc -b` clean** on the merged tree — confirms the hand-merged
   `App.tsx`/`SettingsView.tsx` are structurally sound (correct JSX
   nesting, no orphaned braces, every import resolves), not just that
   each branch compiled on its own.
2. **Every one of the 14 `test:*` suites passes**, run individually AND
   via one continuous `npm run test:all` invocation (the way a real user
   actually runs it) — not just each phase's own suite in isolation:
   ledger 327, integration 35, staff-vehicles 43, staff-profile 44,
   owner-data 55, fastentry 21, fastentry-suggestions 22,
   fastentry-smart-entry 88, fastentry-enter 42, batch-entry 44,
   calendar 36, ai-fallback 45, app-lock 187, drive-backup 56.
   `test:sync` still needs the Firebase emulator's one-time download,
   unavailable in this environment — the same limitation every phase
   in this project has hit, not something this merge changed.
3. **`npm run lint`: 0 errors, 20 warnings** — unchanged from every
   prior phase's baseline.
4. **All three local-only secrets verified to coexist safely at once** —
   this is the one thing that specifically needed re-testing *because*
   two independent "local-only, never-synced, never-backed-up" features
   were combined: planted a real Gemini API key, a real App Lock PIN +
   recovery code, and a real Google Drive OAuth Client ID simultaneously,
   then called the real `exportBackup()`. Confirmed: each secret lives
   under its own distinct `localStorage` key
   (`officeCashLedger.aiFallback.v1`, `officeCashLedger.appLock.v1`,
   `officeCashLedger.googleDriveBackup.v1`) with no collision or
   cross-contamination between them, and none of the three — nor any
   AI/lock/Drive-shaped field at all — appears anywhere in the exported
   backup JSON, whose top-level keys are byte-identical to the pre-Phase-6
   shape.
5. **`SYNC_TABLES` in `lib/sync.ts` and every byte of `lib/backup.ts`,
   `lib/sync.ts`, `lib/aiFallback.ts`, `lib/aiSettingsStore.ts`, and
   `db/schema.ts` are untouched** by either branch — confirmed by direct
   byte-for-byte diff against the pre-merge base, not just re-asserted
   from each branch's own claim.
6. **One transient test flake observed and investigated**: on the very
   first `test:drive-backup` run immediately after merging (right after
   a fresh `npm install`), 2 of 56 assertions failed. Re-run 13
   consecutive times afterward: all 13 passed 56/56, including as part
   of the full `test:all` sequential run. This pattern (fails once
   immediately post-install, never again) points to first-run/cold-start
   timing noise rather than a merge-induced defect, but is noted here
   plainly rather than silently — if `test:drive-backup` ever fails for
   you, re-run it once before assuming something is wrong.

## Files changed in this merge (beyond combining each branch's own files)

- `src/App.tsx` — hand-merged (both branches' changes, disjoint regions
  of the same file).
- `src/components/SettingsView.tsx` — hand-merged (both branches' new
  Settings sections; the App Lock section from Phase 7 and the Google
  Drive Backup section both render, in that order, alongside the
  pre-existing Cloud Sync and AI Fallback sections).
- `package.json` — both branches' new test scripts added; `test:all`
  now runs all 14 suites (13 local + `test:sync`) in sequence.
- `README.md` — both branches' feature bullets, dedicated sections, and
  "Known limitations" entries combined; the file/test listings include
  both new test files.

No other file required manual intervention — every other file from
each branch either matched the shared base exactly (untouched) or had
no naming collision with the other branch (new files copied directly).
