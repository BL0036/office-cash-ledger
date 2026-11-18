import { db } from '../db/schema';
import type { Staff, Vehicle } from '../types';

// Phase 2: the many-to-many staff<->vehicle relationship, superseding
// Staff.assignedVehicleId (see the DEPRECATED note on that field in
// types.ts).
//
// Phase 2 bugfix: StaffVehicle rows are soft-deactivated on unassign
// (`active: false`), NOT hard-deleted. This table is synced (see
// SYNC_TABLES in lib/sync.ts), and this app's sync protocol is pure
// upsert-by-id with no tombstone/deletion mechanism — pushTable() only
// pushes rows that still exist locally, and pullTable() only inserts or
// overwrites, never deletes. A hard-deleted row is therefore invisible to
// sync: another device would never learn the pairing was removed, and a
// device that later re-pairs/restores could even resurrect it from
// Firestore. Soft-deactivating (the same `active: boolean` convention
// every other master-data table here already uses — Staff, Vehicle,
// Category, ExpenseHead, CashInType, FinancialInstitution) makes the
// unassignment itself an ordinary syncable row change, exactly like every
// other table's deletes/deactivations.

/**
 * Link `staffId` to `vehicleId`. If that exact pair already has a row:
 * reactivates it (if it was previously deactivated) and returns its id,
 * rather than creating a duplicate — this both prevents duplicate
 * (staffId, vehicleId) rows (per the EXACT SCOPE requirement) and makes
 * re-assignment after an unassignment work correctly and propagate
 * through sync like any other change.
 */
export async function assignVehicleToStaff(staffId: string, vehicleId: string): Promise<string> {
  if (!staffId) throw new Error('Staff is required.');
  if (!vehicleId) throw new Error('Vehicle is required.');

  const existing = await db.staffVehicles
    .where('staffId')
    .equals(staffId)
    .and((sv) => sv.vehicleId === vehicleId)
    .first();
  if (existing) {
    if (existing.active === false) {
      await db.staffVehicles.update(existing.id, { active: true, updatedAt: Date.now() });
    }
    return existing.id;
  }

  const id = crypto.randomUUID();
  await db.staffVehicles.add({
    id,
    staffId,
    vehicleId,
    active: true,
    updatedAt: Date.now(),
  });
  return id;
}

/**
 * Remove the link between `staffId` and `vehicleId`, if one exists —
 * by deactivating it (`active: false`), never by deleting the row (see
 * the note above this file's functions for why). Leaves every other
 * assignment for that staff member, and every other staff-vehicle pair
 * for that vehicle, untouched.
 */
export async function unassignVehicleFromStaff(staffId: string, vehicleId: string): Promise<void> {
  const rows = await db.staffVehicles
    .where('staffId')
    .equals(staffId)
    .and((sv) => sv.vehicleId === vehicleId)
    .toArray();
  if (rows.length === 0) return;
  const now = Date.now();
  await Promise.all(rows.map((r) => db.staffVehicles.update(r.id, { active: false, updatedAt: now })));
}

/**
 * Every Vehicle currently ACTIVELY assigned to `staffId` — a deactivated
 * (unassigned) link is filtered out here so it disappears everywhere in
 * the UI and from Fast Entry's vehicle-default-suggestion logic. A
 * missing/undefined `active` (any row written before the Phase 2 bugfix
 * migration ran) is treated as active, defensively.
 */
export async function getVehiclesForStaff(staffId: string): Promise<Vehicle[]> {
  const links = (await db.staffVehicles.where('staffId').equals(staffId).toArray()).filter(
    (l) => l.active !== false,
  );
  if (links.length === 0) return [];
  const vehicles = await Promise.all(links.map((l) => db.vehicles.get(l.vehicleId)));
  return vehicles.filter((v): v is Vehicle => v != null);
}

/**
 * Every Staff member currently ACTIVELY assigned to `vehicleId` — same
 * `active !== false` filtering as getVehiclesForStaff() above, for the
 * same reason.
 */
export async function getStaffForVehicle(vehicleId: string): Promise<Staff[]> {
  const links = (await db.staffVehicles.where('vehicleId').equals(vehicleId).toArray()).filter(
    (l) => l.active !== false,
  );
  if (links.length === 0) return [];
  const staffRows = await Promise.all(links.map((l) => db.staff.get(l.staffId)));
  return staffRows.filter((s): s is Staff => s != null);
}
