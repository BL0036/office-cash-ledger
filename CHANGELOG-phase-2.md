# Phase 2 — Flexible many-to-many staff<->vehicle relationship

Replaces the old one-staff-to-one-vehicle model
(`Staff.assignedVehicleId: string | null`) with a many-to-many
`StaffVehicle` join table, without breaking existing data, sync, or the
Fast Entry vehicle-default-suggestion behavior. Every pre-Phase-2
single-vehicle assignment survives migration unchanged; a staff member
can now be assigned to any number of vehicles, and the same ask-don't-
guess rule Phase 12g/12g.1 already applies to institution/staff matching
now applies here too: exactly one assigned vehicle still auto-suggests
it, but two-or-more never guesses between them.

## Files touched

- **`src/types.ts`** — added the `StaffVehicle` interface (`id`,
  `staffId`, `vehicleId`, `updatedAt`), using the same id-generation and
  `updatedAt` conventions as every other table. Marked
  `Staff.assignedVehicleId` `// DEPRECATED (Phase 2)` in a code comment
  exactly as specified — kept in the schema, never written to again by
  application code. Updated the stale comment on `Vehicle` that used to
  describe `Staff.assignedVehicleId` as the single source of truth for
  staff<->vehicle assignment; it now points at `StaffVehicle` instead.

- **`src/db/schema.ts`** —
  - Added `STAFF_VEHICLES_INDEXES = 'id, staffId, vehicleId, updatedAt'`
    and a `staffVehicles!: Table<StaffVehicle, string>` property.
  - Added Dexie **version 12**, following the exact precedent version
    11's own additive-store bump set (a purely new store — no rename/
    delete dance). Its `.upgrade()` reads every existing `Staff` row and,
    for each one with a non-null `assignedVehicleId`, creates exactly one
    `StaffVehicle` row linking that staff to that vehicle. Zero writes to
    `assignedVehicleId` itself — it's read-only during this migration,
    which is why the pre-existing value survives migration completely
    unchanged (verified directly — see Verification below).

- **`src/lib/staffVehicles.ts`** (new) — `assignVehicleToStaff`,
  `unassignVehicleFromStaff`, `getVehiclesForStaff`,
  `getStaffForVehicle`. `assignVehicleToStaff` checks for an existing
  `(staffId, vehicleId)` pair before inserting (no duplicates).
  `unassignVehicleFromStaff` hard-deletes just the targeted row(s) for
  that exact pair, leaving every other assignment untouched. Follows this
  codebase's existing input-validation/error-throwing conventions (see
  `staff.ts`/`vehicles.ts`).

- **`src/lib/staff.ts`** —
  - `resolveAssignedVehicleId()` is now `async` and reads
    `getVehiclesForStaff()` instead of the deprecated field: exactly one
    assigned vehicle still returns it (unchanged pre-Phase-2 behavior);
    zero or two-or-more both return `null` (ask-don't-guess, newly
    extended to 2+ here). This is a **signature change** (sync → async) —
    every call site across the app and test suite was updated to `await`
    it (see below).
  - `NewStaffInput.assignedVehicleId` replaced with optional
    `vehicleIds?: string[]`. `addStaff()` now always writes
    `assignedVehicleId: null` (never the caller's value — "stop writing
    to it going forward," per spec) and, after insert, calls
    `assignVehicleToStaff()` once per id in `vehicleIds`.
  - Removed `assignedVehicleId` from `EditableStaffFields` — vehicle
    assignment editing goes exclusively through
    `assignVehicleToStaff`/`unassignVehicleFromStaff` now, never through
    `editStaff()`.

- **`src/hooks/useLedger.ts`** — added `useVehiclesForStaff(staffId)` and
  `useStaffForVehicle(vehicleId)`, thin `useLiveQuery` wrappers around the
  new lib functions, for the two profile-view UIs below.

- **`src/components/FastEntryBar.tsx`**, **`TransactionFormModal.tsx`** —
  both staff-select `onChange` handlers now `await
  resolveAssignedVehicleId(newStaffId)`. Behavior is unchanged when there
  is 0 or 1 assignment. With 2+, the handler simply does nothing further
  (no auto-fill) — the Vehicle `<select>` is already always visible and
  editable in both components' "more fields" area, so it doubles as the
  ask-don't-guess picker the spec calls for; no separate inline-picker
  component was built, since one wasn't needed.

- **`src/components/StaffView.tsx`** —
  - `StaffFormModal` (add **and** edit): replaced the single-vehicle
    `<select>` with a checkbox list of active vehicles
    (`vehicleIds: string[]` state). In edit mode, an effect loads the
    staff member's current assignments via `getVehiclesForStaff()` so the
    checkboxes start correctly pre-checked (Staff no longer carries this
    data itself). On submit: add mode passes `vehicleIds` straight to
    `addStaff()`; edit mode diffs the checked set against what was
    originally loaded and calls `assignVehicleToStaff`/
    `unassignVehicleFromStaff` only for what actually changed.
  - `StaffProfile`: replaced the single `assignedVehicle` lookup with a
    live list from `useVehiclesForStaff()` — each entry still links to
    that vehicle's view (unchanged), plus a per-vehicle "Unassign" button.
    Added an "Assign vehicle" dropdown (active vehicles not already
    assigned) + Assign button below the list.

- **`src/components/VehiclesView.tsx`** — `VehicleProfile` gained an
  "Assigned Staff" line using the new `useStaffForVehicle()` hook,
  listing every currently-assigned staff member's name. (Plain text, not
  a clickable link — there is no staff-navigation callback wired into
  this view via `App.tsx`, and adding one was outside this phase's exact
  scope of "staff<->vehicle relationship only.")

- **`src/lib/sync.ts`** — added `'staffVehicles'` to `SYNC_TABLES` and
  `db.staffVehicles` to the sync transaction's table list. No other
  change was needed: `pushTable`/`pullTable`/the local apply phase are
  all fully generic (`db.table<SyncableRow>(name)`), exactly the pattern
  the spec asked to follow rather than inventing something new.

- **`src/lib/backup.ts`** — added `staffVehicles: StaffVehicle[]` to
  `BackupPayload`, `exportBackup()`, and `restoreFromBackup()` (clear +
  `bulkPut(payload.staffVehicles ?? [])`, so a payload missing the key
  restores as an empty array rather than throwing). **Deliberately did
  NOT add `staffVehicles` to `REQUIRED_TABLE_KEYS`** — see "Deviation"
  below.

- **`package.json`** — added `test:staff-vehicles` and folded it into
  `test:all` (after `test:integration`, before the Fast Entry suites).

- **`scripts/test-staff-vehicles.ts`** (new) — Test Cases 2–7 and 9 from
  the spec (duplicate-pair prevention, ask-don't-guess at 1 vs 2+
  assignments, unassign scoping, pre-Phase-2-backup restore, full
  backup/restore round-trip, and the real-data migration regression).
  Test Case 1 (migration) is covered both here (folded into Test Case 9's
  seed — see below) and in `test-ledger.ts`'s extended P10a-3 migration
  test. Test Case 8 (cross-device sync) is in `test-sync.ts` (new Test
  Case 12) since it needs the emulator.

- **`scripts/test-ledger.ts`** — Test P5-2 rewritten: it used to assert
  `editStaff()` writes `Staff.assignedVehicleId` directly (the exact
  behavior Phase 2 deprecates), so it now asserts the *opposite* — that
  field stays `null` through both `addStaff()` and
  `assignVehicleToStaff()` — and instead verifies the real new behavior
  end-to-end via the join table and `resolveAssignedVehicleId()`. Added
  Test P5-2b for the 2-vehicle ask-don't-guess case and unassign scoping.
  Extended the P10a-3 migration test (which already migrates a full
  legacy numeric-id database through every version, now including the
  new version 12) with assertions that exactly one `StaffVehicle` row was
  backfilled and that it points at the correctly-migrated vehicle.
  Updated ~6 other `addStaff({..., assignedVehicleId: null, ...})` call
  sites to just drop the now-removed field.

- **`scripts/test-fastentry-smart-entry.ts`**,
  **`test-fastentry-suggestions.ts`**, **`test-fastentry-enter.ts`**,
  **`test-integration.ts`** — updated every `addStaff()` call site that
  used the old `assignedVehicleId` field (either dropped it, for a `null`
  value, or switched to `vehicleIds: [id]` for a real assignment), and
  added `await` at every `resolveAssignedVehicleId()` call site. Also
  fixed a regex in `test-fastentry-smart-entry.ts` that hardcoded
  `/export function resolveAssignedVehicleId/` and would have broken on
  the new `export async function`.

- **`scripts/test-sync.ts`** — updated its one `addStaff()` call site the
  same way, and added **Test Case 12**: a `StaffVehicle` row created on
  device A appears on device B after `Sync Now`, exercising the new
  table through the same generic `SYNC_TABLES` machinery as every other
  table.

- **`README.md`** — one-line update to the feature-list bullet describing
  staff vehicle assignment ("an assigned vehicle" → "assigned vehicles
  (many-to-many, Phase 2)").

## Deviation from the literal spec text (documented, not silent)

The EXACT SCOPE section said to add `staffVehicles` to
`REQUIRED_TABLE_KEYS` in `lib/backup.ts` "following the same pattern as
every other table already there," but **also** said a backup missing the
key must still restore successfully, treating it as empty, never
throwing. These two sentences conflict as written: `REQUIRED_TABLE_KEYS`
validation rejects a payload if any listed key isn't present as an array,
so adding `staffVehicles` there would make a pre-Phase-2 backup fail
validation specifically because of that missing key — precisely the
outcome the very next sentence rules out.

I resolved this by **not** adding `staffVehicles` to
`REQUIRED_TABLE_KEYS`, and documented why inline in `backup.ts`: the
pre-existing strict `schemaVersion === db.verno` equality check already
rejects any backup from a genuinely older app version on its own (a real,
separately-flagged limitation the spec itself said not to fix this
phase) — so also gating on the `staffVehicles` key would only be a
second, redundant failure path. `restoreFromBackup()` treats a missing
key as `[]` regardless. This is covered explicitly by
`test-staff-vehicles.ts`'s Test Case 6, which constructs a backup payload
with the `staffVehicles` key deleted and confirms it both validates and
restores cleanly.

## Note on the supplied real-data file

Test Case 9 asks to seed real staff/vehicle names "from the supplied
`cash-ledger-backup-2026-09-15.json`," but no such file was actually
present in the delivered ZIP. Rather than silently substituting different
names, `test-staff-vehicles.ts`'s Test Case 9 seeds the exact names given
in the spec's own prose — staff "SABIN ACHARYA", vehicle "PULSAR 150" —
directly, via a minimal stand-in pre-Phase-2 schema database (same
technique `test-ledger.ts`'s own P10a-3 migration test already uses),
rather than reading a file that doesn't exist.

## Verification performed

- `npm run build` (`tsc -b && vite build`) — succeeds, no type errors.
- `npm run lint` (`oxlint`) — 0 errors, 21 warnings, all pre-existing
  (`react/set-state-in-effect` style warnings already present on the
  `main` branch before this phase — confirmed none are in code this
  phase touched; `git diff`-adjacent files introduce zero new warnings).
- `npm run test:ledger` — **327 passed, 0 failed** (315 pre-existing +
  12 new/rewritten Phase 2 assertions in P5-2/P5-2b and the extended
  P10a-3 migration test).
- `npm run test:integration` — 35 passed, 0 failed (unchanged).
- `npm run test:staff-vehicles` (new) — **24 passed, 0 failed**.
- `npm run test:fastentry` — 21 passed, 0 failed (unchanged).
- `npm run test:fastentry-suggestions` — 22 passed, 0 failed (unchanged).
- `npm run test:fastentry-smart-entry` — 59 passed, 0 failed (unchanged
  count — internal call sites updated for the new signature, no new
  cases added here since the equivalent coverage now lives in
  `test-staff-vehicles.ts` and `test-ledger.ts`).
- `npm run test:fastentry-enter` — 33 passed, 0 failed (unchanged).
- `npm run test:batch-entry` — 44 passed, 0 failed (unchanged).
- `npm run test:calendar` — 36 passed, 0 failed (unchanged).
- **Not run in this environment:** `npm run test:sync` (the Firebase
  emulator test, including the new Test Case 12 added this phase) — this
  sandbox blocks network egress to `storage.googleapis.com`, which the
  Firestore emulator jar download requires (`Error: download failed,
  status 403: Host not in allowlist: storage.googleapis.com`) — the exact
  same limitation noted in the Phase 12g.1 bugfix changelog. Unlike that
  fix, this phase *does* touch sync (adding `staffVehicles` to
  `SYNC_TABLES`), so please run `npm run test:sync` yourself before
  shipping — Test Case 12 in `test-sync.ts` specifically exercises the
  new table end-to-end across two simulated devices.

## Notes on deliberate design choices

- **No new picker component.** The spec suggested reusing "whatever
  component pattern FastEntryBar.tsx already uses for the '+ more
  fields' expansion" for the 2+-vehicle ask-don't-guess case. On
  inspection, the Vehicle `<select>` in both `FastEntryBar.tsx` and
  `TransactionFormModal.tsx` is already always rendered and always
  user-editable in that expanded area — it was never being
  conditionally hidden or disabled. So the correct minimal change is
  exactly what was made: stop auto-filling it when ambiguous, and let
  that already-existing, always-available control serve as the picker.
  Building a second, separate inline picker alongside it would have been
  redundant UI for the same field.
- **`Staff.assignedVehicleId` is truly dead code going forward** — every
  write path (`addStaff`, `editStaff`) has stopped touching it, per the
  deprecation note. It remains readable (and is read once, during the
  version 12 migration, and by nothing else) purely so existing
  historical rows aren't disturbed.
- **StaffVehicle rows are hard-deleted on unassign**, unlike the
  soft-deactivation pattern every master-data entity (`Staff`, `Vehicle`,
  etc.) uses elsewhere in this app. A pairing that no longer holds
  carries no historical meaning of its own — nothing else in the app
  ever references a `StaffVehicle` row's own `id` — so there's nothing
  worth preserving by deactivating instead of deleting it.
