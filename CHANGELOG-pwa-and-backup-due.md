# Installable app (PWA) + 24-hour Google Drive backup reminder

## What changed

**1. Installable app with offline opening**
- `public/manifest.webmanifest`, `public/sw.js`, app icons in `public/icons/`, new `favicon.svg`
  (the old one was the Vite template logo), extra tags in `index.html`, registration in `src/main.tsx`.
- The service worker caches only the app's own files and Google Fonts. It never touches ledger
  data (IndexedDB), and it ignores Firebase, Google sign-in and the Google Drive API completely.
- The main page is fetched from the network first, so a new version published to GitHub arrives on
  the next normal open. Built files change name every build, so old and new files never mix.
- Works under any base path (GitHub Pages sub-path or Firebase root) - `vite.config.ts` unchanged.

**2. Google Drive backup: 24-hour rule**
- New `lastSuccessAt` setting: the time a backup REALLY finished uploading.
- New `isBackupDue()` / `BACKUP_DUE_AFTER_MS` (24 h) in `lib/googleDriveBackup.ts`.
- New `components/DriveBackupDueBanner.tsx`, shown at the top of the app when Drive backup is
  connected and nothing has uploaded for 24 hours: one tap on "Back up now" (a real tap, so Google's
  sign-in window may appear). "Later" hides it until the next time the app is opened.
- The app now also tries one silent backup when it opens or comes back to the foreground.

**3. Bug fix found while doing this**
- Before: the Settings line "Last backup" used `lastBackupAt`, which the auto-backup wrote BEFORE
  trying. A silent attempt that was skipped (Google login expired) therefore made "Last backup"
  show a fresh time although nothing had been uploaded.
- Now: the Settings line says "Last successful backup" and reads `lastSuccessAt`. `lastBackupAt`
  is left as is, because it only throttles auto-backup (existing tests depend on it).

## What this does NOT do (honest limits)
- **It is not a background backup.** A web app cannot run while it is closed, and Google's login for
  this app lasts about one hour with no refresh token, so the app never opens a Google pop-up on its
  own. Unattended backup every 24 hours would need a small server component (not built).
- No push notifications. The banner appears when the app is opened.
- iPhone: an app added to the Home Screen keeps its own separate storage from Safari tabs (as far as
  known). Install first, then enter data - or move data with Export/Restore or Cloud Sync.

## Verified here
- `tsc -b` + `vite build` clean for base `/` and base `/office-cash-ledger/`; lint 0 errors, 20 warnings (unchanged).
- All local test suites pass; baselines unchanged: ledger 327, integration 35, staff-vehicles 43,
  staff-profile 44, fastentry 21, fastentry-suggestions 22, fastentry-smart-entry 88,
  fastentry-enter 42, batch-entry 44, calendar 36, owner-data 55, ai-fallback 45, app-lock 215,
  drive-backup 56. New: backup-due 19 (`npm run test:backup-due`).
- In headless Chromium served under `/office-cash-ledger/`: service worker became active and took
  control, app files were cached, the page reloaded and rendered with the network switched OFF,
  and browser storage survived. The banner appeared for "never" / "2 days old", stayed hidden for
  "not connected" / "2 hours old", "Later" hid it, and no Google network calls were made silently.
- NOT verified: `test:sync` (needs the Firebase emulator download), installing on a real phone,
  and a real Google Drive upload from the installed app.
