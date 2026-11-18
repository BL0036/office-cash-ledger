import { db } from '../db/schema';
import type { ExpenseHead } from '../types';

// Vehicles are never deleted — only deactivated — same rule as every
// other master-data entity in this app (categories/expense heads/cash-in
// types/staff): a historical transaction may reference one and must keep
// resolving its name forever. "Delete" in the UI always means
// `active: false`.

export interface NewVehicleInput {
  name: string;
  vehicleType: string;
  registrationNumber: string | null;
  // Phase 12g: other spellings/short forms for this vehicle. Optional -
  // defaults to []. Not currently matched by any Fast Entry pattern rule
  // (there's no vehicle-name pattern), kept for consistency with
  // Staff/FinancialInstitution and future use.
  aliases?: string[];
}

/**
 * Trim each alias, drop empties, and dedupe case-insensitively (first-seen
 * casing wins) — Phase 12g's exact normalization rule for all three
 * aliasable entities (Institution/Staff/Vehicle). Not exported: each of
 * institutions.ts/staff.ts/vehicles.ts keeps its own copy per EXACT SCOPE
 * ("Do not change any other behavior in these files") rather than adding a
 * new shared module this phase wasn't scoped to touch.
 */
function sanitizeAliases(aliases: string[] | undefined): string[] {
  if (!aliases) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of aliases) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

export async function addVehicle(input: NewVehicleInput): Promise<string> {
  const name = input.name.trim();
  if (!name) throw new Error('Vehicle name is required.');
  const vehicleType = input.vehicleType.trim();
  if (!vehicleType) throw new Error('Vehicle type is required.');
  const id = crypto.randomUUID();
  await db.vehicles.add({
    id,
    name,
    vehicleType,
    registrationNumber: input.registrationNumber?.trim() || null,
    active: true,
    aliases: sanitizeAliases(input.aliases),
    updatedAt: Date.now(),
  });
  return id;
}

export type EditableVehicleFields = Partial<
  Pick<NewVehicleInput, 'name' | 'vehicleType' | 'registrationNumber' | 'aliases'>
>;

export async function editVehicle(id: string, changes: EditableVehicleFields): Promise<void> {
  const update: Partial<EditableVehicleFields> = { ...changes };
  if (update.name != null) {
    const trimmed = update.name.trim();
    if (!trimmed) throw new Error('Vehicle name is required.');
    update.name = trimmed;
  }
  if (update.vehicleType != null) {
    const trimmed = update.vehicleType.trim();
    if (!trimmed) throw new Error('Vehicle type is required.');
    update.vehicleType = trimmed;
  }
  if (update.aliases != null) {
    update.aliases = sanitizeAliases(update.aliases);
  }
  await db.vehicles.update(id, { ...update, updatedAt: Date.now() });
}

export async function setVehicleActive(id: string, active: boolean): Promise<void> {
  await db.vehicles.update(id, { active, updatedAt: Date.now() });
}

/**
 * Resolve the existing 'Petrol' expense head (seeded since Phase 1/2,
 * under 'Travel & Fuel') — the one every vehicle-profile Petrol total and
 * the Phase 5 Part E monthly comparison table filters on. No new expense
 * head is created this phase; Petrol already exists.
 */
export async function getPetrolExpenseHead(): Promise<ExpenseHead | null> {
  const categories = await db.categories.toArray();
  const travelCategory = categories.find((c) => c.name === 'Travel & Fuel');
  if (!travelCategory?.id) return null;

  const heads = await db.expenseHeads.where('categoryId').equals(travelCategory.id).toArray();
  return heads.find((h) => h.name === 'Petrol') ?? null;
}
