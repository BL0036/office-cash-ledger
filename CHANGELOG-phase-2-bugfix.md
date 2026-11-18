# Phase 2 bugfix — StaffVehicle unassignment never propagated through sync

Fixes a bug in the Phase 2 staff<->vehicle work (see `CHANGELOG-phase-2.md`):
`unassignVehicleFromStaff()` hard-deleted the targeted row, but this app's
sync protocol (`lib/sync.ts`) is pure upsert-by-id with **no**
tombstone/deletion mechanism — `pushTable()` only pushes rows that still
exist locally, and `pullTable()` only inserts/overwrites, never deletes.
Phase 2 added `staffVehicles` to `SYNC_TABLES`, so that combination —
hard-delete on a synced table — meant an unassignment on one device never
propagated to another, and a device that later re-paired/restored could
even have the deleted assignment resurrected from Firestore.

Every other syncable table in this app already avoids this by
soft-deleting (`transactions` uses `deletedAt`; every master-data table —
`Staff`, `Vehicle`, `Category`, `ExpenseHead`, `CashInType`,
`FinancialInstitution` — uses `active: boolean`). `StaffVehicle` was the
only table that hard-deleted while also being synced. This fix converts
it to the same `active: boolean` convention the rest of the app already
uses.

## Files touched

- **`src/types.ts`** — added `active: boolean` to the `StaffVehicle`
  interface. Updated the interface's doc comment (previously explained
  *why* hard-delete was fine; now explains why it wasn't, and points at
  `lib/staffVehicles.ts` for the reactivate-on-reassign logic this
  requires).

- **`src/db/schema.ts`** — added Dexie **version 13** (purely additive —
  `.stores({})`, no store/index change, following the same shape as
  version 11's aliases backfill). Its `.upgrade()` reads every existing
  `staffVehicles` row and sets `active: r.active ?? true`, so every row
  created under version 12 (which has no `active` field at all) comes out
  backfilled to `active: true`. Version 12's own block is untouched.

- **`src/lib/staffVehicles.ts`** —
  - `assignVehicleToStaff()`: when an existing `(staffId, vehicleId)` row
    is found and it's currently `active: false`, it's now reactivated
    (`active: true`, `updatedAt` bumped) via `db.staffVehicles.update()`
    rather than returned untouched. A brand-new row is created with
    `active: true`. This still guarantees no duplicate pairs, and now
    also makes re-assignment after an unassignment work correctly — and,
    crucially, makes the reactivation itself an ordinary syncable row
    change.
  - `unassignVehicleFromStaff()`: sets `active: false` and bumps
    `updatedAt` via `db.staffVehicles.update()` per matched row, instead
    of `bulkDelete`. Never hard-deletes. (In practice at most one row
    matches a given `(staffId, vehicleId)` pair, per the no-duplicates
    guarantee above, but the function still handles the defensive
    multi-row case the same way the original did.)
  - `getVehiclesForStaff()` / `getStaffForVehicle()`: both now filter
    their raw `staffVehicles` rows to `active !== false` before resolving
    the joined Vehicle/Staff rows, so a deactivated link disappears from
    the UI and from Fast Entry's vehicle-default-suggestion logic. A
    missing/undefined `active` (any row written before the version 13
    migration, in the unlikely case it's read before migration runs) is
    treated as active — defensive, matches the migration's own `?? true`
    fallback.
  - Updated the top-of-file comment block to explain the soft-delete
    rationale (superseding the old hard-delete rationale it previously
    documented).

- **No other file needed a code change.** Every other read of
  `db.staffVehicles` in the app already goes through
  `getVehiclesForStaff()`/`getStaffForVehicle()` (grepped `staffVehicles`
  across `src/` to confirm) — including `resolveAssignedVehicleId()`
  (`lib/staff.ts`), `StaffView.tsx`'s assign/unassign reconciliation, and
  `useVehiclesForStaff`/`useStaffForVehicle` (`hooks/useLedger.ts`) — so
  fixing the two functions above fixes every call site transitively.
  `lib/fastEntrySuggestions.ts` was left untouched, as instructed — it
  never reads `staffVehicles` directly, only comments on
  `resolveAssignedVehicleId()`.
  - `lib/sync.ts` needed no change: it's fully generic over
    `SyncableRow`, so a `StaffVehicle` row's new `active` field is just
    another opaque field it pushes/pulls like `staffId`/`vehicleId`. No
    tombstone mechanism was added to the sync protocol itself — out of
    scope, per the spec.
  - `lib/backup.ts` needed no structural change: `staffVehicles` rows
    carry their own `active` field now, and `exportBackup()`/
    `restoreFromBackup()` already round-trip whatever fields a row has via
    plain `toArray()`/`bulkPut()`. A pre-fix-shaped row with no `active`
    key restores as-is and is then treated as active by the `active !==
    false` filter at read time (verified — see Bugfix Test Case B6
    below).

- **`scripts/test-staff-vehicles.ts`** — added six new cases
  (**Bugfix Test Cases B1–B6**), inserted alongside the existing Phase 2
  cases:
  - **B1** — `unassignVehicleFromStaff()` leaves the row present with
    `active: false` (direct table read, not hard-deleted).
  - **B2** — both `getVehiclesForStaff()` and `getStaffForVehicle()`
    omit a deactivated pairing.
  - **B3** — re-assigning a previously-unassigned pair reactivates the
    *same* row (asserts the row id is unchanged, and exactly one row
    still exists for that pair — no duplicate created).
  - **B4** — a staff member with one active + one deactivated assignment:
    `resolveAssignedVehicleId()` still auto-suggests the single active
    vehicle (does not treat the deactivated row as a second candidate and
    fall back to "ambiguous").
  - **B5** — migration: a row seeded in a version-12-shaped database (no
    `active` field at all — the exact shape version 12's own `bulkAdd`
    produces) comes out of the version 13 migration with `active: true`.
  - **B6** — backup/restore round-trip preserves `active: false` on a
    deactivated link, and a payload whose row has its `active` key
    stripped entirely (not just the whole `staffVehicles` key, which
    Test Case 6 already covered) restores it, and it reads back as
    active via the filter.

- **`scripts/test-sync.ts`** — added **Test Case 13**: device A assigns a
  vehicle to a staff member, both sync, device B sees it; device A then
  **unassigns** it, both sync; asserts device B no longer sees the
  pairing via `getVehiclesForStaff()`. This is the exact
  deletion-propagation scenario Phase 2's Test Case 12 didn't cover
  (Test Case 12 only exercised the create/assign direction).

## Verification performed

- `npm run build` (`tsc -b && vite build`) — succeeds, no type errors.
- `npm run lint` (`oxlint`) — 0 errors, 20 warnings, all pre-existing
  `react/set-state-in-effect` style warnings already present before this
  fix (none in any file this bugfix touched).
- `npm run test:staff-vehicles` — **43 passed, 0 failed** (24
  pre-existing + 19 new assertions across Bugfix Test Cases B1–B6).
- `npm run test:ledger` — 327 passed, 0 failed (unchanged).
- `npm run test:integration` — 35 passed, 0 failed (unchanged).
- `npm run test:fastentry` — 21 passed, 0 failed (unchanged).
- `npm run test:fastentry-suggestions` — 22 passed, 0 failed (unchanged).
- `npm run test:fastentry-smart-entry` — 59 passed, 0 failed (unchanged).
- `npm run test:fastentry-enter` — 33 passed, 0 failed (unchanged).
- `npm run test:batch-entry` — 44 passed, 0 failed (unchanged).
- `npm run test:calendar` — 36 passed, 0 failed (unchanged).
- **Not run in this environment:** `npm run test:sync` (the Firebase
  emulator test, including the new Test Case 13 added by this bugfix) —
  this sandbox blocks network egress to `storage.googleapis.com`, which
  the Firestore emulator jar download requires:
  `Error: download failed, status 403: Host not in allowlist:
  storage.googleapis.com`. This is the exact same limitation Phase 2's
  own changelog noted. Please run `npm run test:sync` yourself before
  shipping — Test Case 13 in `test-sync.ts` specifically exercises the
  bug this fix addresses (deletion propagation across two simulated
  devices) end-to-end against the real emulator.

## Notes on deliberate design choices

- **`unassignVehicleFromStaff()` still handles multiple matched rows**,
  even though the no-duplicates guarantee in `assignVehicleToStaff()`
  means at most one row should ever match a given `(staffId, vehicleId)`
  pair. Kept the defensive multi-row handling the original hard-delete
  version had, just converted to per-row `update()` calls instead of a
  single `bulkDelete()`.
- **Used `db.staffVehicles.update()` rather than `bulkPut()`** for both
  the reactivate and deactivate paths, to match this codebase's existing
  convention for toggling a boolean `active` field (see
  `setStaffActive()`/`setVehicleActive()` in `lib/staff.ts`/
  `lib/vehicles.ts`, which both use `.update(id, { active, updatedAt })`)
  rather than reconstructing and overwriting the whole row.
- **Version 13's `.stores({})` is empty on purpose** — this is a pure
  data migration with no index change (`STAFF_VEHICLES_INDEXES` doesn't
  index `active`), the same reasoning version 10's own comment gives for
  omitting tables a version bump doesn't otherwise touch.
