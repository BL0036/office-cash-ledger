# Office Daily Cash Ledger v1.0

A local-first digital office cash ledger — a keyboard-first, professional
replacement for a paper cashbook. React + TypeScript + Vite + Tailwind
CSS, persisted locally with Dexie.js over IndexedDB. No backend and no
required login: everything works fully offline on a single device.
Multi-device Cloud Sync is available but entirely optional.

## What this is

Each day gets an opening balance, a list of Cash In / Cash Out entries,
and a closing balance that automatically becomes tomorrow's opening
balance (a cascade recalculation runs whenever an entry anywhere in the
past changes). On top of that core ledger, the app manages the
office's own staff, vehicles, expense heads, and savings/finance
institutions — all user-editable, nothing hard-coded — and offers
reporting, budgets, search, and backup/export.

## Main features

- Daily cash ledger with automatic opening → closing balance cascade
- **Fast Entry** — a single-row, keyboard-driven way to add a transaction
  in seconds, with smart description matching and auto-tagging
- Cash In / Cash Out, each with its own categories/sources
- Expense heads and per-head expense diaries (monthly, previous-month,
  YTD, and lifetime totals)
- Staff — salaries, salary payments, cash advances and outstanding
  advance tracking, assigned vehicles (many-to-many, Phase 2), employee
  ID/position/contact/photo fields with a printable ID card and profile
  summary (Phase 4)
- Vehicles — petrol tracking per vehicle, maintenance, monthly/YTD/
  lifetime totals
- Financial institutions — deposits, withdrawals, running totals
- Reports — monthly comparisons, expense-head breakdowns, petrol and
  advance summaries
- Budgets with monthly-limit alerts (approaching / reached / over)
- Search across all transactions by date range
- Backup — full JSON export/import, plus CSV and Excel export
- Optional Firebase Cloud Sync between devices
- Optional, on-demand Gemini API fallback for Fast Entry's Smart Entry
  (Phase 6) — off by default, never automatic, never auto-applied; see
  Settings → AI Fallback and "Known limitations" below
- Optional App Lock (Phase 7) — a PIN/password asked at open and after
  inactivity; off by default; see Settings → App Lock and "Known
  limitations" below
- Optional Google Drive backup — a second, independent, opt-in backup
  destination; off by default; see Settings → Google Drive Backup and
  "Known limitations" below
- Keyboard-first workflow (see Fast Entry shortcuts below)
- Responsive layout: sidebar navigation on desktop, a slide-in drawer on
  mobile

## Fast Entry — the daily workflow

Fast Entry sits at the top of the Daily Ledger screen, above the Cash In
/ Cash Out lists, next to the existing "+ Add" buttons that open the
detailed form. It writes through the exact same `addTransaction()` as the
detailed form — no separate table, no separate write path.

**Typical entry:** Description → Amount → Enter. For Cash Out, a Category
is required (pre-filled with a sensible default); an Expense Head
appears only when the chosen category has any. Staff, Vehicle,
Institution, Reference, and Notes live behind a collapsible "+ more
fields" section.

**Smart matching:** typing a description the app has seen before (e.g.
"Khaja", "Petrol", "Dhanodaya", a staff member's name for an advance)
surfaces a suggestion that can auto-fill the category/expense
head/institution/staff — never chosen silently without visible
confirmation when the match isn't confident.

**Batch entry:** after a save, the row clears and focus returns to
Description — but the selected direction (Cash In or Cash Out) is
**kept**, not reset. This means a whole batch of same-direction entries
(e.g. several Cash In deposits, then several Cash Out expenses) can be
typed back-to-back without re-selecting direction each time. Direction
only changes when you explicitly switch it — with the toggle buttons or
Alt+I/Alt+O — so mixed Cash In → Cash Out → Cash In sequences are
supported just as well as long same-direction runs.

### Shortcuts

| Key | Action |
|---|---|
| `Enter` | Validate and save; clears the row and refocuses Description |
| `Tab` / `Shift+Tab` | Move through the visible fields (wraps back to Description after the last one) |
| `Esc` | Clear the row. If two or more fields have real data in them, the first `Esc` shows a "press again to clear" confirmation instead of clearing immediately |
| `Alt+I` | Switch to Cash In |
| `Alt+O` | Switch to Cash Out |
| `Alt+M` | Open/close "+ more fields" |

## Installation

```
npm install
npm run dev       # http://localhost:5173 — local development
npm run build     # tsc -b && vite build -> dist/
npm run preview   # serve the production build locally
```

Non-developers: `START-HERE.bat` (Windows) automates install, build, and
optional Firebase deploy end-to-end — see `READ-ME-FIRST.txt`.

## Local use

Firebase/Cloud Sync is completely optional. With no `.env` file present,
the app runs entirely offline against the browser's local IndexedDB —
nothing is sent anywhere, and every feature except multi-device sync
works exactly the same.

## Cloud Sync

Optional, manual, two-way sync between devices that share the same
8-character **sync code**. The browser talks directly to Firestore via
the Firebase client SDK — there is no server of ours in the middle.

**Setup:** copy `.env.example` to `.env`, fill in your Firebase project's
web-app config values, deploy `firestore.rules`, then rebuild.

**Using it:** Settings → Cloud Sync → **Generate New Sync Code** on the
first device, **Join** with that same code on every other device that
should share this data, then **Sync Now** on any device to push local
changes and pull remote ones. There is no automatic background sync —
sync is always a manual, on-demand action.

**Security model — read before relying on it:** the sync code is the
*entire* access boundary. Every device signs in anonymously with no
password of its own; Firestore's rules only check that the request comes
from a signed-in session, not which sync group it belongs to at the
application level beyond the code itself. Anyone with the code and the
app can read and write everything in that sync group. **Treat a sync
code exactly like a shared Wi-Fi password** — share it only with devices
that should see this office's data.

**Conflict policy:** last-write-wins by timestamp, no merge UI. If the
same transaction is edited on two devices before either syncs, whichever
syncs second wins.

## Backup recommendation

Make regular JSON backups (Settings → Backup & Export → Export Backup).
The JSON export is the only backup format that can be fully restored;
CSV/Excel exports are for reporting and analysis, not for restoring data.
Cloud Sync is not a substitute for backups — it's real-time replication,
so a mistaken deletion on one device will sync everywhere else.

## AI Fallback (Phase 6, optional)

Fast Entry's Smart Entry is, and remains, a deterministic, local, offline,
free rule engine (Rules 1-5 in `lib/fastEntrySuggestions.ts`) — that has
not changed. This adds one narrow, opt-in exception: when that engine
finds nothing or a genuine ambiguity for what you typed, an **"Ask AI"**
button appears next to Description. Clicking it sends your typed text
plus your own category/staff/vehicle/institution *names* (never amounts,
never transaction history) to the Google Gemini API in a single request,
and shows the reply as one more selectable row in the same suggestion
dropdown — never auto-applied, never auto-saved.

**Off by default, fully inert with no key configured** — zero network
calls, zero new UI, in the normal Fast Entry flow.

**Setup:** Settings → AI Fallback (optional) → toggle it on, paste a free
Gemini API key (get one at
[aistudio.google.com/apikey](https://aistudio.google.com/apikey)). The
key is stored in this browser's `localStorage` only — see "Known
limitations" below for exactly what that means.

## App Lock (Phase 7, optional)

An optional PIN or password that the app asks for every time it opens,
and again after a period of inactivity (15 minutes by default; 1, 5, 15,
30 or 60 minutes to choose from). There is also a **Lock now** button in
the sidebar once it is on. It is meant to keep a casual visitor — someone
who picks up the device or sits at an unattended screen — out of your
books.

**Off by default.** With it off, the app opens and behaves exactly as it
always did.

**Setup:** Settings → App Lock (optional) → choose a PIN/password →
Turn on. You are then shown a one-time **recovery code** — write it on
paper. It cannot be shown again, and it is the *only* way back in if you
forget the PIN (there is no email reset, because this app has no server).
See "Known limitations" below for what the lock does and does not protect.

## Google Drive Backup (optional)

A second, independent, opt-in backup destination — completely separate
from Cloud Sync above and from the AI Fallback above; enabling one never
affects the others. Once connected (your own Google Cloud OAuth Client
ID, entered once in Settings → Google Drive Backup), it uploads the exact
same JSON "Backup & Export" already produces into one continuously-
updated file (`office-cash-ledger-backup.json`) inside one app-created
folder (`Office Cash Ledger Backups`) in your own Google Drive —
opportunistically (roughly hourly while a tab is open, and best-effort on
tab close/hide) and via a manual "Backup to Drive Now" button. "Restore
from Drive" downloads that same file and runs it through the exact same
restore path (and the same automatic pre-restore safety backup) as
restoring from a local file.

**Off by default, fully inert with nothing connected** — zero network
calls, zero new UI, in the normal app flow.

**Setup:** create an OAuth Client ID (Web application, "public/SPA
client") in your own Google Cloud Console, enable the Drive API, then
Settings → Google Drive Backup → paste the Client ID → Connect. The
Client ID isn't secret (public/SPA client IDs are designed to be visible
in client code), but the resulting access token is cached in this
browser's `localStorage` only — see "Known limitations" below.

## Keyboard-first, mobile-friendly

Every core screen is fully usable with a keyboard alone — visible focus
rings throughout, no keyboard traps, Escape closes every dialog and the
mobile navigation drawer. On a narrow screen, the sidebar becomes a
top bar with a slide-in menu; Fast Entry, transaction lists, and every
form remain fully usable at phone width.

## Known limitations

- Cloud Sync has no background/automatic sync (by design — see above)
  and no merge conflict resolution beyond last-write-wins.
- The production JS bundle is larger than ideal (~1.2MB before gzip),
  driven mostly by the Excel-export library; this doesn't affect regular
  daily use (Dashboard/Fast Entry/Ledger) but means the very first page
  load is heavier than a fully code-split app would be. Not yet split
  out — see the project's internal notes for a scoped follow-up.
- `npm run test:sync` requires the Firebase Local Emulator Suite, which
  needs a one-time internet download the first time it runs; in network-
  restricted environments this test cannot execute (it is not skipped or
  faked — it simply won't run there).
- **Backup restore requires an exact schema-version match.**
  `restoreFromBackup()` rejects any backup file whose `schemaVersion`
  doesn't exactly equal the app's current one — a backup taken on an
  older version of the app (before a later update added new fields or
  tables) cannot be restored into a newer install, even though the newer
  schema is a superset of the old one. The rejection itself is clean (a
  clear error, nothing partially imported), but there's currently no
  upgrade path for an old backup other than keeping the app itself
  up to date at the time each backup is taken. Widening this to accept
  and migrate older backups is a meaningfully larger, separately-scoped
  change, not something to expect from a patch release.
- **Fast Entry's "learned from history" matching (Rule 1) takes priority
  over its institution/staff/vehicle pattern matching (Rules 3-5) for any
  description that exactly repeats a PRIOR transaction's description**
  (case/whitespace-insensitive), by design — the most-recently-used
  tagging for identical text always wins, on the reasoning that it best
  reflects the owner's current habit. One consequence worth knowing: once
  a description has been recorded even once, retyping that exact text
  reuses whatever Category/Expense Head it was tagged with before, but
  does NOT re-populate Institution/Staff/Vehicle from the pattern rules
  the way a genuinely first-time typing of that phrase would — those
  three fields only ever come from Rules 3-5, which Rule 1 pre-empts.
  Practically: if a description was ever saved with the "wrong" tagging
  once, simply adding an institution/staff alias afterward will not fix
  future typings of that exact text — the fix is to correctly re-tag one
  new entry with that text, which becomes the new "most recent" match
  going forward.
- **AI Fallback (Phase 6) sends data to Google when explicitly triggered.**
  With it off (the default) nothing changes. With it on, clicking "Ask AI"
  sends the typed description and your own category/staff/vehicle/
  institution *names* — never amounts, never transaction history — to
  Google's Gemini API over the public internet, subject to Google's own
  terms and data-handling policies for that API. The API key is stored in
  this browser's `localStorage`, which means: it is per-browser-profile,
  not per-device (a different browser or a private/incognito window won't
  see it); it is never synced (not in `SYNC_TABLES`) and never included in
  a JSON backup (not in `BackupPayload`); and it is cleared if the owner
  clears this site's browsing data. There is no way to view/rotate/revoke
  it from within the app itself — do that at
  [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
  directly if a key is ever compromised. Real Gemini API calls have not
  been exercised end-to-end in this project (see CHANGELOG-phase-6.md) —
  only mocked in automated tests; a real key should be smoke-tested once
  before relying on this feature.
- **App Lock (Phase 7) is a lock screen, not encryption.** It keeps a
  casual visitor out; it does not protect the data from anyone technical.
  The ledger is stored in the browser exactly as before, unencrypted —
  anyone who can open the browser's developer tools can read it directly,
  or delete the one `localStorage` entry that holds the lock (which
  removes the lock without touching any data). The PIN is kept only as a
  salted PBKDF2-SHA-256 hash (600,000 iterations), never in plaintext.
  Like the AI key, the lock lives in this browser's `localStorage`: it is
  per-browser-profile, never synced (not in `SYNC_TABLES`), never in a
  JSON backup (not in `BackupPayload`), and is removed if the owner clears
  this site's browsing data — so restoring a backup on a new device does
  not bring a lock with it. **If you forget the PIN and lose the recovery
  code there is no way to reset it:** the last resort is clearing this
  site's data in the browser (or using a fresh browser profile) and
  restoring from a backup file (or re-pulling from Cloud Sync), so
  anything entered since your last backup that Cloud Sync doesn't hold
  would be lost. A wrong or forgotten PIN never deletes or changes data.
  Locking hides the whole app, so a half-typed, unsaved entry is lost if
  the idle lock fires before you save it. App Lock needs a secure context
  (`https://` or `localhost`); on plain `http://` from another address the
  Settings section says it is unavailable.
- **Google Drive Backup sends your full backup JSON to Google Drive when
  connected.** With it off (the default) nothing changes. With it on, the
  full backup content (every transaction, staff member, vehicle,
  institution, category, and budget) is uploaded to a folder Google Drive
  Backup itself creates in your own Google Drive, subject to Google's own
  terms for the Drive API. It uses the `drive.file` scope, so it can only
  ever see/modify files it created itself — never your other Drive files.
  The OAuth Client ID and cached access token live in this browser's
  `localStorage` only — same per-browser-profile, never-synced, never-
  backed-up treatment as the Gemini key above, and cleared the same way.
  There is no refresh token (Google's current Identity Services flow for
  a backend-less app deliberately doesn't issue one — see
  `lib/googleDriveBackup.ts`'s own header comment); the cached access
  token is short-lived (~1 hour), and auto-backup (the hourly-ish
  background attempt) never prompts for a new one — it simply skips
  gracefully if the cached token has expired, recording "reconnect
  needed." Only a real button click (Connect / Backup Now / Restore from
  Drive) can trigger a fresh sign-in prompt. Real Google OAuth/Drive API
  calls have not been exercised end-to-end in this project — only mocked
  in automated tests; a real connect+backup+restore cycle should be
  smoke-tested once before relying on this feature.

## Project structure

```
src/
  types.ts                # Transaction / LedgerDay / Category / etc. —
                           # every id is a string UUID; synced tables carry updatedAt
  db/schema.ts             # Dexie schema, versioned migrations, reference-data seeding
  lib/money.ts               # paisa <-> "Rs. x,xxx.xx" formatting/parsing
  lib/dates.ts                # date helpers
  lib/ledger.ts                 # the financial core: CRUD + recalculation cascade
  lib/referenceData.ts           # Category/ExpenseHead/CashInType management
  lib/staff.ts                    # Staff CRUD + advance limit/recovery checks
  lib/vehicles.ts                  # Vehicle CRUD + petrol expense-head lookup
  lib/institutions.ts               # Institution CRUD + deposit/withdrawal lookups
  lib/aggregation.ts                 # shared totals/rollup engine
  lib/reports.ts                      # read-only Reports/Dashboard data
  lib/budgets.ts                       # Budget CRUD + budget-status calculation
  lib/backup.ts                         # JSON backup export/validate/restore
  lib/exportRows.ts, csv.ts, excel.ts    # CSV/Excel export
  lib/download.ts                         # browser file-download helper
  lib/syncConfig.ts, firebaseClient.ts,    # Cloud Sync: local config, Firebase init,
      sync.ts                               # and the push/pull sync engine
  lib/fastEntry.ts                          # Fast Entry's pure validation/build logic
  lib/fastEntrySuggestions.ts                # Fast Entry smart-matching logic
  hooks/useLedger.ts                          # dexie-react-hooks live queries
  index.css                                    # design tokens + shared component classes
  components/                                   # DateNav, BalanceSummary, TransactionList,
                                                  # TransactionFormModal, FastEntryBar, SearchView,
                                                  # SettingsView, DiariesView, StaffView,
                                                  # VehiclesView, InstitutionsView, ReportsView,
                                                  # DashboardView, ExportButtons
  App.tsx                                        # sidebar shell + tab routing
scripts/                # headless test suites (fake-indexeddb, no DOM/React harness)
  test-ledger.ts           # 327 offline business-logic tests
  test-integration.ts      # cross-feature integration suite
  test-staff-vehicles.ts   # staff<->vehicle join table (Phase 2)
  test-staff-profile.ts    # staff profile fields + print views' data (Phase 4)
  test-fastentry*.ts       # Fast Entry logic, suggestions, smart-entry, keyboard Enter
  test-batch-entry.ts      # same-direction batch entry, mixed switching, 20-save loop
  test-bs-calendar.ts      # BS calendar conversion, navigation, month/year boundaries
  test-owner-data.ts       # Phase 5: reconstructed real-data end-to-end verification
  test-ai-fallback.ts      # Phase 6: AI fallback logic, all network calls mocked
  test-app-lock.ts         # Phase 7: App Lock (real Web Crypto, fake clock)
  test-drive-backup.ts     # Google Drive backup logic, all network/OAuth calls mocked
  test-sync.ts             # Cloud Sync, against the Firebase Local Emulator Suite
firestore.rules         # Cloud Sync security rules (deploy manually)
firebase.json / .firebaserc  # emulator config for test:sync only
.env.example             # Firebase config template
```

## Running the tests

```
npm run lint
npm run test:ledger
npm run test:integration
npm run test:staff-vehicles
npm run test:staff-profile
npm run test:fastentry
npm run test:fastentry-suggestions
npm run test:fastentry-smart-entry
npm run test:fastentry-enter
npm run test:batch-entry
npm run test:calendar
npm run test:owner-data
npm run test:ai-fallback
npm run test:app-lock
npm run test:drive-backup
npm run test:sync          # needs the Firebase emulator — see Known limitations
npm run test:all           # everything above, in order
```
