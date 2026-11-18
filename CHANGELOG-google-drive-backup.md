# Google Drive Backup — optional, opt-in second backup destination

A new, genuinely additive feature, following the exact "bring your own
credentials, opt-in, local-only secrets, graceful degradation" discipline
Phase 6 (`CHANGELOG-phase-6.md`, `CHANGELOG-phase-6-model-fix.md`)
established for the Gemini fallback, applied here to Google Drive. This
is a SEPARATE, independent feature from Firebase Cloud Sync — `lib/sync.ts`
was not touched, and neither feature can enable or depend on the other.

## Research performed before writing any code

Per this task's own instruction (the same discipline that would have
caught Phase 6's later model-currency bug earlier), verified live against
Google's current documentation before implementing:

- **OAuth flow**: Google Identity Services (GIS) for Web —
  `https://accounts.google.com/gsi/client`, the current, non-deprecated
  library. NOT the old `gapi.auth2`/"Google Sign-In" library, which isn't
  loaded or referenced anywhere in this feature. For a public/SPA client
  with no backend (this app), the correct approach is GIS's **token
  model**: `google.accounts.oauth2.initTokenClient({client_id, scope,
  callback})` → `.requestAccessToken()`. The alternative "code model"
  requires a backend to exchange the authorization code for tokens — not
  applicable here.
- **No silent/automatic token refresh exists for this flow.** Confirmed
  directly against Google's own documentation, which states plainly:
  "Automatic refresh of expired access tokens has been removed... After
  an access token expires your app must handle Google API error
  responses, request, and obtain a new, valid access token." There is
  **no refresh token** available to a pure client-side app this way
  (refresh tokens only ever go to a backend via the code model). This
  directly shaped the design: the cached access token is short-lived
  (~1 hour); a background/auto-backup attempt **never** calls
  `requestAccessToken()` itself (that would mean an unprompted popup
  appearing during a background timer) — it only proceeds if a still-
  valid cached token already exists, and degrades gracefully (skips,
  records "reconnect needed") otherwise. Only a genuine user gesture
  (Connect / Backup Now / Restore from Drive — all real button clicks)
  is allowed to trigger a fresh sign-in prompt.
- **Drive API v3**: `files.create` (folder via `mimeType:
  'application/vnd.google-apps.folder'`; file via multipart upload),
  `files.update` (PATCH, media upload) to update the SAME file in place,
  `files.get?alt=media` to download raw content, `files.list?q=...` to
  find an existing app-created folder/file by name so a second run never
  creates a duplicate. All plain REST + `fetch()` with an `Authorization:
  Bearer <token>` header.
- **`drive.file` scope**: confirmed still the correct minimal,
  **non-sensitive** scope for "only files this app itself creates" —
  verified directly against `developers.google.com/drive/scopes`: it
  requires no Google OAuth app verification and no CASA security
  assessment, unlike the broader `drive`/`drive.readonly` scopes. This
  app creates its own folder/file and never asks the owner to pick a
  pre-existing one via the Picker API, which is exactly `drive.file`'s
  core, intended use.
- **Rate limits**: confirmed this app's opportunistic ~hourly backup (a
  handful of API calls per attempt) is many orders of magnitude below
  every documented Drive API quota tier, including the newer (May 2026)
  unit-based quota model — Google's own written guidance is only to avoid
  exceeding roughly 3 write requests per SECOND; this app does a small
  handful per HOUR.
- **The OAuth Client ID is not a secret**: confirmed still accurate — a
  public/SPA OAuth Client ID is designed to be visible in client-side
  code (Google's own samples embed it directly in HTML/JS). It's still
  given the same local-only, never-synced treatment as the Gemini key,
  for consistency and because it's still device-specific setup, not
  because it's confidential.

## What was built

### 1. `src/lib/googleDriveSettingsStore.ts` (new, sibling to `lib/aiSettingsStore.ts`)
Local-only storage (plain `localStorage`, not a Dexie table) for the
OAuth Client ID, connection state, cached access token + expiry, and the
app-created folder/file IDs. Same isolation reasoning as the Gemini key:
`lib/sync.ts` and `lib/backup.ts` have never imported or referenced
`localStorage` anywhere in this codebase, so nothing stored here has any
code path to reach `SYNC_TABLES` or `BackupPayload`.

### 2. `src/lib/googleDriveBackup.ts` (new)
- `connect(clientId)` / `disconnect()` / `isConnected()`.
- `backupNow()` — manual, interactive; uploads the current
  `exportBackup()` output (via the existing `serializeBackup()` — never a
  second backup format), creating the folder/file on first use and
  updating the SAME file in place thereafter (`files.update`, never a new
  dated file).
- `autoBackupTick(now?)` — opportunistic, rate-limited, non-interactive.
  Gated by a single named constant, `MIN_AUTO_BACKUP_INTERVAL_MS`
  (~hourly), used both as the interval period (see App.tsx wiring below)
  and as the minimum-gap-since-last-attempt guard inside the function
  itself, so rapid repeated triggers can't spam Drive. Never prompts for
  a new token — only uses an already-valid cached one, skipping
  gracefully otherwise. Accepts an optional `now` parameter specifically
  so `scripts/test-drive-backup.ts` can test the rate-limiting
  deterministically without real timers.
- `restoreFromDrive()` — downloads the file and routes its content
  through the **exact same** `restoreFromBackup()` every other restore
  path already uses (constraint #7) — not a parallel implementation. An
  old/incompatible `schemaVersion` in a Drive-downloaded file is rejected
  the identical way a local file upload already is.
- `getLastBackupStatus()` — for the Settings UI status line.
- Every function returns a plain result object instead of throwing, for
  every failure mode (network error, expired/revoked/401 token, 429
  quota, malformed response).

### 3. Auto-backup scheduling (`App.tsx`)
A **separate** `useEffect` from Cloud Sync's own silent sign-in effect
(deliberately not merged, per constraint #4) — a `setInterval` at
`MIN_AUTO_BACKUP_INTERVAL_MS`, plus a `visibilitychange` listener (fires
on tab hide/backgrounding) and a `pagehide` listener (fires on
navigation/close), both calling the same `autoBackupTick()`. With Drive
backup unconfigured, `autoBackupTick()`'s own `isConnected()` check
returns immediately — this effect creates a harmless no-op timer and two
no-op listeners, zero network calls (constraint #1).

### 4. `SettingsView.tsx` — new "Google Drive Backup (optional)" section
Matches the existing Cloud Sync / AI Fallback section styling: Client ID
input, Connect/Disconnect, a "Backup to Drive Now" button, a "Restore
from Drive…" button gated behind the **same kind of confirmation dialog**
(and the same automatic pre-restore safety-backup download) the existing
local restore flow (`BackupExportSection`) already uses, and a last-
backup-status line (time or error).

## Test coverage

New `scripts/test-drive-backup.ts` (56 tests, `npm run test:drive-backup`,
folded into `test:all`). All network calls, GIS/OAuth calls, and
`localStorage` are mocked — no real Google account or Client ID is
required to run this suite. Covers every numbered test case from the
spec:

1. Not connected → `isConnected()` false, `backupNow()`/`autoBackupTick()`
   both decline immediately with zero network AND zero GIS calls.
2. Connect flow (mocked GIS) → connection state confirmed absent from
   `exportBackup()`'s actual output and from `SYNC_TABLES`; `lib/backup.ts`
   and `lib/sync.ts` statically confirmed to never import the Drive
   settings store at all (same rigor as Phase 6's own check).
3. `backupNow()` with a mocked successful response → the uploaded content
   is confirmed JSON-equal to `exportBackup()`'s real current output
   (ignoring the few-ms-apart `exportedAt` timestamp between the two
   separate calls being compared); a second call is confirmed to `PATCH`
   the SAME file ID, never creating a second one.
4. Four failure modes (network throw, 401, 429, malformed/unparseable
   response) — each resolves gracefully, and a REAL local
   `addTransaction()` call immediately after each is asserted to still
   succeed.
5. `restoreFromDrive()` — an old (schemaVersion 10) mocked downloaded file
   is rejected with the same version-naming error text
   `restoreFromBackup()` produces locally; a valid current-schema file
   restores successfully and returns the same `RestoreResult` shape
   (`preRestoreSnapshot`) as every other restore path.
6. Auto-backup rate limiting — a burst of rapid repeated `autoBackupTick()`
   calls within `MIN_AUTO_BACKUP_INTERVAL_MS` makes no additional network
   calls beyond the first; a tick after the interval elapses attempts
   again; confirmed the non-interactive path never calls
   `requestAccessToken()` (never prompts in the background).
7. Every pre-existing suite reruns with its exact prior count (see below).

Three genuine bugs were found and fixed while writing this suite — all in
the test's own mocking, not the product code:
- A URL-substring routing check (`url.includes('folder')`) wrongly
  matched a file-search query because the folder's own ID (embedded in
  that query as a parent-id filter) happens to contain the substring
  "folder" — fixed by parsing the URL's actual `q` parameter instead of
  matching raw substrings.
- A multipart-body-parsing regex in the test greedily spanned both JSON
  parts of the request body as one match — fixed by splitting on the
  multipart boundary first.
- The "malformed response" failure-mode test accidentally hit a code path
  (`files.update`) that never calls `.json()` on the response at all
  (this app only checks `res.ok` there, since Drive's update-response
  body isn't used) — fixed by clearing the cached folder/file IDs first
  so the test genuinely exercises a `.json()`-parsing path.

## Verification performed

- `npm run build` (`tsc -b && vite build`) — clean, no type errors, from
  a **fresh** `npm install` + extraction of the final ZIP.
- `npm run lint` (`oxlint`) — 0 errors, 20 warnings, unchanged.
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
| test:ai-fallback | 45 |
| **test:drive-backup** | **56 (new)** |

All pre-existing counts exactly match `CHANGELOG-phase-6-model-fix.md`.
No test was weakened or deleted to force a pass.

### Token/Client-ID exclusion from sync/backup — explicit confirmation
Confirmed three ways, same rigor as Phase 6's Gemini-key check: (1)
`SYNC_TABLES` in `lib/sync.ts` contains no Drive-related entry; (2)
`exportBackup()`'s actual output was inspected directly in the test and
contains no trace of the configured Client ID or access token, and no
`googleDrive`/`clientId`/`accessToken`-shaped top-level field; (3)
`lib/backup.ts` and `lib/sync.ts`'s own source text was read and confirmed
to contain no reference to `googleDriveSettingsStore` or
`googleDriveBackup` at all — not "excluded by convention," genuinely
never imported.

### Real Google OAuth / Drive API — UNVERIFIED
**Could not reach the real endpoints in this environment.** Directly
tested: `curl https://accounts.google.com/gsi/client` and
`curl https://www.googleapis.com/drive/v3/files` both return `403 Host
not in allowlist` from this sandbox's network egress proxy — the exact
same class of restriction prior phases hit with
`generativelanguage.googleapis.com` (Gemini) and
`storage.googleapis.com` (Firestore emulator). No real Google account or
OAuth Client ID was available either way. **A real connect → backup →
restore cycle has NOT been exercised end-to-end and is marked
UNVERIFIED**, per the same standard Phase 6 set — the mocked test suite
(56 tests) verifies the entire code path's logic (request construction,
response parsing, every failure mode, the rate-limiting guard, and the
exact-same-restoreFromBackup() routing) against controlled fake
responses; it cannot verify that Google's real OAuth popup flow and Drive
REST endpoints actually behave this way in a live browser today.
**Recommend a manual smoke test with a real Google Cloud OAuth Client ID
before relying on this feature**: create the Client ID, enable the Drive
API, connect in Settings, click "Backup to Drive Now," confirm the file
appears in "Office Cash Ledger Backups" in Drive, then "Restore from
Drive" and confirm the data round-trips correctly.

## Known limitations — added to README

Everything in `CHANGELOG-phase-6-model-fix.md`'s own limitations list
still applies unchanged. This feature adds its own entry (see README's
"Known limitations" section for the full text): Google Drive Backup
sends the full backup JSON to Drive when connected (off by default); it
uses the non-sensitive `drive.file` scope (can only see files it created
itself); the Client ID and access token are local-only (same treatment as
the Gemini key); there is no refresh token by Google's own current design
for a backend-less app, so a background auto-backup attempt with an
expired cached token skips gracefully rather than prompting — only an
explicit button click can trigger a fresh sign-in; and real Google
OAuth/Drive behavior remains UNVERIFIED per the above.
