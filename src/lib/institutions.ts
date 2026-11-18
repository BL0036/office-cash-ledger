import { db } from '../db/schema';
import type { CashInType, ExpenseHead } from '../types';

// Institutions are never deleted — only deactivated — same rule as every
// other master-data entity in this app (categories/expense heads/cash-in
// types/staff/vehicles): a historical transaction may reference one and
// must keep resolving its name forever. "Delete" in the UI always means
// `active: false`.

export interface NewInstitutionInput {
  name: string;
  // Phase 12g: other spellings/short forms Fast Entry's institution-name
  // pattern (fastEntrySuggestions.ts rule 3) also matches against, in
  // addition to `name`. Optional - defaults to [].
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

export async function addInstitution(input: NewInstitutionInput): Promise<string> {
  const name = input.name.trim();
  if (!name) throw new Error('Institution name is required.');
  const id = crypto.randomUUID();
  await db.financialInstitutions.add({
    id,
    name,
    active: true,
    aliases: sanitizeAliases(input.aliases),
    updatedAt: Date.now(),
  });
  return id;
}

export type EditableInstitutionFields = Partial<Pick<NewInstitutionInput, 'name' | 'aliases'>>;

export async function editInstitution(
  id: string,
  changes: EditableInstitutionFields,
): Promise<void> {
  const update: Partial<EditableInstitutionFields> = { ...changes };
  if (update.name != null) {
    const trimmed = update.name.trim();
    if (!trimmed) throw new Error('Institution name is required.');
    update.name = trimmed;
  }
  if (update.aliases != null) {
    update.aliases = sanitizeAliases(update.aliases);
  }
  await db.financialInstitutions.update(id, { ...update, updatedAt: Date.now() });
}

export async function setInstitutionActive(id: string, active: boolean): Promise<void> {
  await db.financialInstitutions.update(id, { active, updatedAt: Date.now() });
}

/**
 * Resolve the Savings & Financial category and its 'Deposit' expense head
 * (seeded since Phase 6, backfilled on every app start) — what a deposit
 * transaction is filed under.
 */
export async function getDepositReferenceIds(): Promise<{
  savingsCategoryId: string;
  depositExpenseHead: ExpenseHead;
} | null> {
  const categories = await db.categories.toArray();
  const savingsCategory = categories.find((c) => c.name === 'Savings & Financial');
  if (!savingsCategory?.id) return null;

  const heads = await db.expenseHeads.where('categoryId').equals(savingsCategory.id).toArray();
  const depositExpenseHead = heads.find((h) => h.name === 'Deposit');
  if (!depositExpenseHead) return null;

  return { savingsCategoryId: savingsCategory.id, depositExpenseHead };
}

/**
 * Resolve the existing 'Financial Withdrawal' cash-in type (seeded since
 * Phase 6, backfilled on every app start) — what a withdrawal transaction
 * is filed under.
 */
export async function getFinancialWithdrawalCashInType(): Promise<CashInType | null> {
  const types = await db.cashInTypes.toArray();
  return types.find((t) => t.name === 'Financial Withdrawal') ?? null;
}
