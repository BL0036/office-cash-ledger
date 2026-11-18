import { db } from '../db/schema';
import type { Category, ExpenseHead } from '../types';
import { aggregateTransactions } from './aggregation';
import { assignVehicleToStaff, getVehiclesForStaff } from './staffVehicles';

// Staff are never deleted — only deactivated — for the same reason as
// categories/expense heads/cash-in types (see referenceData.ts): a
// historical Salary transaction may reference one and must keep
// resolving its name forever. "Delete" in the UI always means
// `active: false`.

export interface NewStaffInput {
  name: string;
  monthlySalaryPaisa: number;
  // Optional per-staff advance ceiling (Phase 4). Null defaults to
  // monthlySalaryPaisa at check time — see checkAdvanceLimit below.
  advanceLimitPaisa: number | null;
  joiningDate: string | null;
  // Phase 2: zero or more Vehicles to assign this staff member to at
  // creation time, via the StaffVehicle join table (lib/staffVehicles.ts)
  // — replaces the old single `assignedVehicleId` field, which addStaff()
  // no longer writes to (see the DEPRECATED note on Staff.assignedVehicleId
  // in types.ts). Optional — defaults to no assignments.
  vehicleIds?: string[];
  notes: string | null;
  // Phase 12g: other spellings/short forms Fast Entry's staff-advance
  // pattern (fastEntrySuggestions.ts rule 4) also matches against, in
  // addition to `name`. Optional - defaults to [].
  aliases?: string[];
  // Phase 4: small practical staff-profile fields for the printable ID
  // card / summary view — not an HR module, exactly these four, all
  // optional. `contactNumber` is validated only as trimmed free text (no
  // phone-format enforcement — formats vary too much to usefully
  // validate). `photoDataUrl`, if provided, must actually be a
  // `data:image/...` URL — see the validation in addStaff/editStaff below.
  employeeId?: string | null;
  position?: string | null;
  contactNumber?: string | null;
  photoDataUrl?: string | null;
}

/**
 * Phase 4: `photoDataUrl` must be an actual `data:image/...` URL when
 * provided — this is a plain base64 field on the Staff row (no separate
 * blob/file storage subsystem), so anything that isn't a real data URL
 * (a remote http(s) link, a bare file path, garbage text) is rejected
 * with a clear error rather than silently stored.
 */
function validatePhotoDataUrl(photoDataUrl: string | null | undefined): void {
  if (photoDataUrl == null || photoDataUrl === '') return;
  if (!/^data:image\//.test(photoDataUrl)) {
    throw new Error('Photo must be a valid image file.');
  }
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

/**
 * The Phase 5 Part C staff→vehicle suggestion rule, extracted (Phase 12c)
 * so `TransactionFormModal` and Fast Entry share this literal one-liner
 * instead of each keeping their own copy inline — "pick this staff
 * member's assigned vehicle as a Vehicle default, if they have one" is a
 * single fact about a Staff record, not logic worth duplicating.
 *
 * Phase 2: now reads the StaffVehicle join table (async) instead of the
 * deprecated Staff.assignedVehicleId field, and extends the same
 * ask-don't-guess rule Phase 12g/12g.1 already applies to
 * institution/staff matching: with exactly ONE assigned vehicle, keep
 * auto-suggesting it exactly as before; with zero OR two-or-more, return
 * null (no suggestion) rather than ever guessing among several.
 */
export async function resolveAssignedVehicleId(
  staffId: string | null | undefined,
): Promise<string | null> {
  if (!staffId) return null;
  const vehicles = await getVehiclesForStaff(staffId);
  return vehicles.length === 1 ? vehicles[0].id : null;
}

export async function addStaff(input: NewStaffInput): Promise<string> {
  const name = input.name.trim();
  if (!name) throw new Error('Staff name is required.');
  if (!Number.isInteger(input.monthlySalaryPaisa) || input.monthlySalaryPaisa < 0) {
    throw new Error('Enter a valid monthly salary.');
  }
  if (
    input.advanceLimitPaisa != null &&
    (!Number.isInteger(input.advanceLimitPaisa) || input.advanceLimitPaisa < 0)
  ) {
    throw new Error('Enter a valid advance limit.');
  }
  validatePhotoDataUrl(input.photoDataUrl);
  const id = crypto.randomUUID();
  await db.staff.add({
    id,
    name,
    monthlySalaryPaisa: input.monthlySalaryPaisa,
    advanceLimitPaisa: input.advanceLimitPaisa,
    joiningDate: input.joiningDate,
    active: true,
    // DEPRECATED (Phase 2): never written to anymore — see the note on
    // Staff.assignedVehicleId in types.ts. Vehicle assignment now goes
    // through StaffVehicle (below), not this field.
    assignedVehicleId: null,
    notes: input.notes,
    aliases: sanitizeAliases(input.aliases),
    employeeId: input.employeeId?.trim() || null,
    position: input.position?.trim() || null,
    contactNumber: input.contactNumber?.trim() || null,
    photoDataUrl: input.photoDataUrl || null,
    updatedAt: Date.now(),
  });
  for (const vehicleId of input.vehicleIds ?? []) {
    await assignVehicleToStaff(id, vehicleId);
  }
  return id;
}

export type EditableStaffFields = Partial<
  Pick<
    NewStaffInput,
    | 'name'
    | 'monthlySalaryPaisa'
    | 'advanceLimitPaisa'
    | 'joiningDate'
    | 'notes'
    | 'aliases'
    | 'employeeId'
    | 'position'
    | 'contactNumber'
    | 'photoDataUrl'
  >
>;

export async function editStaff(id: string, changes: EditableStaffFields): Promise<void> {
  const update: Partial<EditableStaffFields> = { ...changes };
  if (update.name != null) {
    const trimmed = update.name.trim();
    if (!trimmed) throw new Error('Staff name is required.');
    update.name = trimmed;
  }
  if (
    update.monthlySalaryPaisa != null &&
    (!Number.isInteger(update.monthlySalaryPaisa) || update.monthlySalaryPaisa < 0)
  ) {
    throw new Error('Enter a valid monthly salary.');
  }
  if (
    update.advanceLimitPaisa != null &&
    (!Number.isInteger(update.advanceLimitPaisa) || update.advanceLimitPaisa < 0)
  ) {
    throw new Error('Enter a valid advance limit.');
  }
  if (update.aliases != null) {
    update.aliases = sanitizeAliases(update.aliases);
  }
  if ('photoDataUrl' in update) {
    validatePhotoDataUrl(update.photoDataUrl);
  }
  if ('employeeId' in update) {
    update.employeeId = update.employeeId?.trim() || null;
  }
  if ('position' in update) {
    update.position = update.position?.trim() || null;
  }
  if ('contactNumber' in update) {
    update.contactNumber = update.contactNumber?.trim() || null;
  }
  await db.staff.update(id, { ...update, updatedAt: Date.now() });
}

export async function setStaffActive(id: string, active: boolean): Promise<void> {
  await db.staff.update(id, { active, updatedAt: Date.now() });
}

/**
 * Resolve the Staff category and its Salary expense head — the two
 * reference rows every Salary payment transaction needs (categoryId,
 * expenseHeadId). Both are seeded by db/schema.ts (the latter backfilled
 * for pre-Phase-3 databases via ensureSalaryExpenseHead), so a null
 * result here would mean reference data hasn't seeded yet.
 */
export async function getSalaryReferenceIds(): Promise<{
  staffCategory: Category;
  salaryExpenseHead: ExpenseHead;
} | null> {
  const categories = await db.categories.toArray();
  const staffCategory = categories.find((c) => c.name === 'Staff');
  if (!staffCategory?.id) return null;

  const heads = await db.expenseHeads.where('categoryId').equals(staffCategory.id).toArray();
  const salaryExpenseHead = heads.find((h) => h.name === 'Salary');
  if (!salaryExpenseHead) return null;

  return { staffCategory, salaryExpenseHead };
}

/**
 * Resolve the Staff category and its Advance expense head (Phase 4) — the
 * same shape/reasoning as getSalaryReferenceIds above, kept as a sibling
 * function rather than folded together so existing Salary-only callers
 * (PaySalaryModal, the staff profile's salary-history hook) are untouched.
 */
export async function getAdvanceReferenceIds(): Promise<{
  staffCategory: Category;
  advanceExpenseHead: ExpenseHead;
} | null> {
  const categories = await db.categories.toArray();
  const staffCategory = categories.find((c) => c.name === 'Staff');
  if (!staffCategory?.id) return null;

  const heads = await db.expenseHeads.where('categoryId').equals(staffCategory.id).toArray();
  const advanceExpenseHead = heads.find((h) => h.name === 'Advance');
  if (!advanceExpenseHead) return null;

  return { staffCategory, advanceExpenseHead };
}

export interface OutstandingAdvance {
  advancesGivenPaisa: number;
  advancesRecoveredPaisa: number;
  outstandingPaisa: number;
}

/**
 * Outstanding advance for one staff member = Σ(their non-deleted Advance
 * transactions) − Σ(linkedAdvanceRecoveryPaisa across their non-deleted
 * Salary transactions). A read-time calculation, not a stored/cached
 * field (Phase 4 Part B).
 *
 * The "advances given" half reuses aggregateTransactions() (groupBy:
 * 'staff', filtered to the Advance expense head) rather than a
 * hand-written Dexie query, per the same reasoning getStaffTotals already
 * follows. The "recovered" half sums linkedAdvanceRecoveryPaisa directly
 * — aggregateTransactions only sums amountPaisa, not an arbitrary field,
 * so there's no existing thin wrapper to reuse for that part.
 */
export async function getOutstandingAdvance(staffId: string): Promise<OutstandingAdvance> {
  const advanceRefs = await getAdvanceReferenceIds();
  const salaryRefs = await getSalaryReferenceIds();

  let advancesGivenPaisa = 0;
  if (advanceRefs) {
    const results = await aggregateTransactions({
      groupBy: 'staff',
      expenseHeadId: advanceRefs.advanceExpenseHead.id!,
    });
    advancesGivenPaisa = results.find((r) => r.groupId === staffId)?.totalPaisa ?? 0;
  }

  let advancesRecoveredPaisa = 0;
  if (salaryRefs) {
    const salaryTxns = await db.transactions
      .where('staffId')
      .equals(staffId)
      .filter((t) => !t.deletedAt && t.expenseHeadId === salaryRefs.salaryExpenseHead.id)
      .toArray();
    advancesRecoveredPaisa = salaryTxns.reduce(
      (sum, t) => sum + (t.linkedAdvanceRecoveryPaisa ?? 0),
      0,
    );
  }

  return {
    advancesGivenPaisa,
    advancesRecoveredPaisa,
    outstandingPaisa: advancesGivenPaisa - advancesRecoveredPaisa,
  };
}

/**
 * Phase 3 Part A: renamed from `allowed` to `withinLimit` to make the
 * advisory-only semantics unambiguous at every call site — exceeding the
 * limit is no longer a reason to block the save (see checkAdvanceLimit's
 * own doc comment below), so a field named `allowed` was actively
 * misleading. The arithmetic this computes is UNCHANGED — only the name,
 * and how callers are now expected to react to `false`, changed.
 */
export interface AdvanceLimitCheck {
  withinLimit: boolean;
  currentOutstandingPaisa: number;
  limitPaisa: number;
}

/**
 * Whether giving `amountPaisa` more advance to `staffId` would stay within
 * their limit: staff.advanceLimitPaisa if set, else staff.monthlySalaryPaisa
 * (the null-defaults-to-salary rule — Phase 4 Part C). Lives here rather
 * than in the UI so the Give-Advance form just calls this and displays the
 * result.
 *
 * Phase 3 Part A: `withinLimit: false` is ADVISORY ONLY — a staff member
 * may legitimately receive an advance larger than their limit in a
 * special/authorized case, so neither StaffView.tsx's Give-Advance form
 * nor FastEntryBar.tsx block the save on it any more. Both still call
 * this and MUST still surface a clear, non-blocking warning with the
 * limit and the resulting outstanding total whenever it's `false` — see
 * GiveAdvanceModal in StaffView.tsx and the advance-limit warning in
 * FastEntryBar.tsx. checkRecoveryAmount() below is a genuinely different
 * case (a hard cash-flow constraint, not a policy ceiling) and is
 * unaffected by this change.
 */
export async function checkAdvanceLimit(
  staffId: string,
  amountPaisa: number,
): Promise<AdvanceLimitCheck> {
  const staffMember = await db.staff.get(staffId);
  if (!staffMember) throw new Error(`Staff ${staffId} not found`);

  const { outstandingPaisa } = await getOutstandingAdvance(staffId);
  const limitPaisa = staffMember.advanceLimitPaisa ?? staffMember.monthlySalaryPaisa;

  return {
    withinLimit: outstandingPaisa + amountPaisa <= limitPaisa,
    currentOutstandingPaisa: outstandingPaisa,
    limitPaisa,
  };
}

export interface RecoveryCheck {
  allowed: boolean;
  outstandingPaisa: number;
  error?: string;
}

/**
 * Whether `recoveryAmountPaisa` is valid for a Salary payment of
 * `grossSalaryAmountPaisa`: it must not exceed the gross salary amount
 * (net cash paid can't go negative) nor the staff member's current
 * outstanding advance (Phase 4 Part D). Same pattern/reasoning as
 * checkAdvanceLimit above — lives here so the Pay-Salary form just calls
 * this and displays the result, rather than duplicating the check inline.
 */
export async function checkRecoveryAmount(
  staffId: string,
  recoveryAmountPaisa: number,
  grossSalaryAmountPaisa: number,
): Promise<RecoveryCheck> {
  if (recoveryAmountPaisa > grossSalaryAmountPaisa) {
    return {
      allowed: false,
      outstandingPaisa: 0,
      error: 'Recovery amount cannot exceed the salary amount.',
    };
  }

  const { outstandingPaisa } = await getOutstandingAdvance(staffId);
  if (recoveryAmountPaisa > outstandingPaisa) {
    return {
      allowed: false,
      outstandingPaisa,
      error: 'Recovery amount cannot exceed the outstanding advance.',
    };
  }

  return { allowed: true, outstandingPaisa };
}
