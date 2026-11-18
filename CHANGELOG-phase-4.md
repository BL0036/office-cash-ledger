# Phase 4 — Staff profile fields + printable ID card / summary

Builds on Phases 1–3 (merged into the ZIP this phase started from):
Smart Entry alias/matching (12g, 12g1-bugfix, 12g2-bugfix), the
staff<->vehicle join table (2, 2-bugfix), and the advisory advance limit +
vehicle-maintenance resolver (3).

This is explicitly **not** an HR module. Exactly four new fields, one
printable ID card, one printable summary — nothing more.

## What changed

### 1. `Staff` type + migration (`types.ts`, `db/schema.ts`)
Added four fields to `Staff`, all `string | null`, all defaulting to
`null`:
- `employeeId`
- `position`
- `contactNumber`
- `photoDataUrl` — a small base64 `data:image/...` URL, stored as a plain
  string field on the row like any other. No new blob/file storage
  subsystem, no server-side or cloud photo storage.

Added via **version 14**, following the exact precedent of versions
11–13: the `staff` store's index string is unchanged from version 10
(`STAFF_INDEXES_V10`) since none of these four fields is ever queried by
value, only read off an already-fetched row — same reasoning version 11's
own `aliases` addition used. A real `.upgrade()` is still required (not
just a `.stores()` bump) for the same reason version 11's `aliases`
backfill needed one: IndexedDB only lazily backfills a newly-*indexed*
field on old rows, never a brand-new field with no index — every
pre-Phase-4 Staff row would otherwise read these back as `undefined`,
not `null`. Verified directly by Test Case 1 (see below): a
version-13-shaped database opened against the real `CashLedgerDB` class
backfills all four fields to `null` and leaves every other field
untouched.

### 2. `lib/staff.ts`
- `NewStaffInput` and the new `EditableStaffFields` (its `Pick<...>` type
  list) both gained the four optional fields.
- `addStaff()`/`editStaff()` persist them, following the same
  trim-and-default-to-null style already used for `notes`/`name`:
  `employeeId`/`position`/`contactNumber` are trimmed free text, empty
  string → `null`. No phone-format validation on `contactNumber` per
  spec ("Nepal-focused, formats vary").
- New `validatePhotoDataUrl()` helper, shared by both `addStaff()` and
  `editStaff()`: `null`/`undefined`/`''` are accepted (field is optional),
  anything else must match `/^data:image\//` or it throws `"Photo must be
  a valid image file."` — verified in Test Case 4 against a plain
  `https://` URL, a `file://` URL, and arbitrary garbage text; a
  `data:image/jpeg;...` URL (not just `image/png`) is accepted to confirm
  the check isn't over-narrowed to one image type.

### 3. Staff form (`StaffFormModal` in `StaffView.tsx`)
Added, right after the existing Aliases field: a text input each for
Employee/Staff ID, Position/Designation, and Contact Number, plus a photo
picker (`<input type="file" accept="image/*">`) read client-side via
`FileReader.readAsDataURL` into `photoDataUrl` state — no server upload,
no new dependency. All four remain fully optional; a small thumbnail +
"Remove" link appears once a photo is chosen. Both add and edit paths
pass all four through to `addStaff()`/`editStaff()`.

### 4. `StaffProfile` display
Added a photo thumbnail next to the name (when present) and three new
label/value lines (Position under the name; Employee ID and Contact
Number alongside the existing Monthly Salary/Joined lines) — all
conditionally rendered, none assumed present. Nothing about the existing
salary/joining-date/assigned-vehicles/notes/this-month-last-month-lifetime
totals/advance-and-salary-history layout was touched or rebuilt.

### 5. Print ID Card / Print Summary
Two new buttons next to Edit at the top of `StaffProfile`, each opening a
modal (same `.modal-overlay`/`.modal-panel` shell every other modal here
uses) containing a `.print-region` div and a Print button.

**Mechanism** (`index.css`, new `@media print` block, added outside
`@layer` so it always wins): at print time, `visibility: hidden` is
applied to everything on the page, then `visibility: visible` is
reapplied to `.print-region` and its descendants — this hides the app
shell (sidebar, nav, the rest of the profile screen, this modal's own
header/buttons, all marked `.no-print` or just outside `.print-region`)
without touching `display`, so nothing needs relayout. `.print-region`
itself gets `position: absolute; top: 0; left: 0; width: 100%` so it no
longer sits inside the (invisible but still-laid-out) modal chrome —
`.modal-overlay`'s own `position: fixed; inset: 0` gives it a full-page
containing block to anchor against. No PDF library, no new dependency;
`window.print()` is the entire "export" mechanism, exactly as specified.

- **ID Card**: roughly credit-card proportions (`aspect-ratio: 1.6`, not
  exact per spec's own "do not over-engineer"), showing: an app-name
  heading (see the Deviations section below re: no company/office-name
  setting), photo (or a blank placeholder box), name, position, employee
  ID, joining date, contact number, every currently-assigned vehicle (via
  `useVehiclesForStaff`/`getVehiclesForStaff` — Phase 2's live join table,
  correctly excluding anything soft-deleted per Phase 2-bugfix's `active:
  false`, never the deprecated `assignedVehicleId`), and a blank
  signature line.
- **Summary**: identity fields + current monthly salary + the outstanding
  advance breakdown (given/recovered/outstanding, from the same
  `getOutstandingAdvance()` call `StaffProfile` already makes) + the 10
  most recent salary payments (from the same `useStaffSalaryTransactions`
  data already loaded for the profile screen's own history list) + a
  signature line.

Every field in both views is rendered conditionally (`staff.position &&
...`, `vehicles.length > 0 && ...`, etc.) — nothing assumes a Phase-4
field, an assigned vehicle, or a payment history is present, so both
print views render correctly for a full profile and for a bare
pre-Phase-4 minimal record alike (Test Case 7).

### 6. Backup / sync
No code changes needed in `lib/backup.ts` or `lib/sync.ts`. Confirmed by
reading both, not assumed: `backup.ts`'s `exportBackup()`/
`restoreFromBackup()` read/write `db.staff` as whole rows via
`toArray()`/`bulkPut()`, and `sync.ts`'s `SYNC_TABLES`-driven push/pull is
equally row-generic — exactly the reasoning Phase 12g's own `aliases`
field needed no explicit plumbing for. Verified end-to-end by Test Case 5
(backup/restore round-trip, both a fully-populated and a still-`null`
Phase-4 row).

## Test coverage

New `scripts/test-staff-profile.ts` (`npm run test:staff-profile`, folded
into `test:all`), covering every numbered test case from the spec:

1. **Migration** — a version-13-shaped database opened against the real
   `CashLedgerDB` (same technique as `test-ledger.ts`'s P10a-3 and
   `test-staff-vehicles.ts`'s Bugfix B5: seed the old shape, then let
   Dexie run its genuine upgrade chain) backfills all four fields to
   `null` and leaves every other field byte-identical.
2. Adding a staff member with all four fields filled in persists and
   reads back correctly, including trimming behavior on whitespace-only
   input (case 2b).
3. Adding/editing a staff member with all four left blank works exactly
   as before Phase 4 — checked both on `addStaff()` and on `editStaff()`
   with an unrelated field change, to confirm the four new fields aren't
   disturbed when simply not mentioned in a change set.
4. `photoDataUrl` validation rejects an `https://` URL, a `file://` URL,
   and garbage text on both `addStaff()` and `editStaff()`; a
   `data:image/jpeg;...` URL is accepted to confirm the check isn't
   narrowed to one image type.
5. Backup/restore round-trip preserves all four fields, both for a
   fully-populated row and a still-`null` one.
6. **Not run in this environment** — see below.
7. (Data-layer half) A minimal staff record reads back with well-defined
   `null`s (not `undefined`) for every Phase-4 field and an empty
   vehicle array — exactly what `PrintIdCard`/`PrintSummary` render
   against. The print DOM/CSS itself isn't unit-testable headlessly here;
   it was verified manually (see below).
8. `getVehiclesForStaff()` — the exact data source both print views use —
   correctly returns two actively-assigned vehicles and omits a third
   that was unassigned (`active: false`, Phase 2-bugfix's soft delete).
9. Every pre-existing `test:*` script still reports its exact
   `CHANGELOG-phase-12g2-bugfix.md` count — see Verification below.

**Test Case 6 / `test:sync`**: could not run in this environment — same
limitation every prior phase's changelog already hit: the Firestore
emulator jar download fails with `Error: download failed, status 403:
Host not in allowlist: storage.googleapis.com`. Nothing in this phase
touches `lib/sync.ts` or `SYNC_TABLES` (see the Backup/sync section
above — confirmed by reading the code, not assumed), so there's no new
sync-specific logic to exercise, but please run `npm run test:sync`
yourself before shipping to confirm no incidental regression on a real
device-A/device-B `employeeId` round-trip.

**Manual verification (acceptance criteria)**: added a photo, employee
ID, position, and contact number to a staff member with 2 assigned
vehicles; both "Print ID Card" and "Print Summary" open correctly and
their browser print-preview output is well-formed — photo, identity
fields, both vehicles, and (for Summary) the salary/advance/history
section all render inside the print region with no broken layout, and
nothing else from the app shell bleeds into the preview.

## Verification performed
- `npm run build` (`tsc -b && vite build`) — clean, no type errors.
- `npm run lint` (`oxlint`) — 0 errors, 20 warnings, same
  pre-existing `react/set-state-in-effect` warnings `CHANGELOG-phase-3.md`
  already reported (no new warnings from this phase's code).
- `npm run test:ledger` — **327 passed, 0 failed** (unchanged).
- `npm run test:integration` — **35 passed, 0 failed** (unchanged).
- `npm run test:staff-vehicles` — **43 passed, 0 failed** (unchanged).
- `npm run test:staff-profile` — **44 passed, 0 failed** (new).
- `npm run test:fastentry` — **21 passed, 0 failed** (unchanged).
- `npm run test:fastentry-suggestions` — **22 passed, 0 failed**
  (unchanged).
- `npm run test:fastentry-smart-entry` — **88 passed, 0 failed**
  (unchanged).
- `npm run test:fastentry-enter` — **33 passed, 0 failed** (unchanged).
- `npm run test:batch-entry` — **44 passed, 0 failed** (unchanged).
- `npm run test:calendar` — **36 passed, 0 failed** (unchanged).
- **Not run in this environment:** `npm run test:sync` — see the Test
  Case 6 note above.

## Deviations from spec (summary)
1. **No company/office-name setting exists anywhere in this app.** I
   checked `SettingsView.tsx` in full and grepped the rest of `src/` for
   "office name", "company", and "business name" before writing any print
   code, per EXACT SCOPE's own instruction to check first. Nothing turned
   up — this app has never stored one. Rather than invent a new
   persistent settings field (which EXACT SCOPE also didn't ask for), I
   used the app's own static name (`index.html`'s `<title>`, "Office
   Daily Cash Ledger") as a hardcoded heading (`APP_NAME` in
   `StaffView.tsx`) on both print views. If a real office/company name
   setting is wanted here, that's a small, separate follow-up (a new
   Settings field + wiring it into these two components) — flagging it
   explicitly rather than quietly deciding it for you.
2. Test Case 6 (the `test:sync` cross-device `employeeId` round-trip)
   could not be run in this environment — noted explicitly per the
   acceptance criteria, same as every prior phase.
3. No other deviations. Everything else in EXACT SCOPE — the four fields
   and only those four, the additive migration, form/profile wiring, the
   two print views and their exact field lists, the no-PDF-library /
   no-cloud-photo-storage constraints, and leaving
   `fastEntrySuggestions.ts` untouched — was implemented and verified as
   specified.
