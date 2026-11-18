import { db } from '../db/schema';
import type { FlowClass } from '../types';

// Categories/heads/types are never deleted — only deactivated — because a
// historical transaction may reference one and must keep displaying its
// name correctly forever (spec Part B). "Delete" in the UI always means
// `active: false`.

/**
 * Custom categories created via Settings default to 'operating_expense'.
 * The spec's Part A only assigns flowClass values to the 8 seeded
 * categories; it doesn't say what a brand-new custom category should get.
 * 'operating_expense' is the closest general-purpose bucket (ordinary
 * day-to-day cash-out), so new custom categories fall there unless/until
 * a later phase adds a flowClass picker to the Settings form.
 */
const DEFAULT_CUSTOM_CATEGORY_FLOW_CLASS: FlowClass = 'operating_expense';

/** Custom cash-in types default to 'other_movement', matching every seeded one. */
const DEFAULT_CUSTOM_CASH_IN_TYPE_FLOW_CLASS: FlowClass = 'other_movement';

export async function addCategory(name: string): Promise<string> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Category name is required.');
  const id = crypto.randomUUID();
  await db.categories.add({
    id,
    name: trimmed,
    direction: 'cash_out',
    flowClass: DEFAULT_CUSTOM_CATEGORY_FLOW_CLASS,
    isCustom: true,
    active: true,
    updatedAt: Date.now(),
  });
  return id;
}

export async function setCategoryActive(id: string, active: boolean): Promise<void> {
  await db.categories.update(id, { active, updatedAt: Date.now() });
}

export async function addExpenseHead(categoryId: string, name: string): Promise<string> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Expense head name is required.');
  const id = crypto.randomUUID();
  await db.expenseHeads.add({
    id,
    categoryId,
    name: trimmed,
    isCustom: true,
    active: true,
    updatedAt: Date.now(),
  });
  return id;
}

export async function setExpenseHeadActive(id: string, active: boolean): Promise<void> {
  await db.expenseHeads.update(id, { active, updatedAt: Date.now() });
}

export async function addCashInType(name: string): Promise<string> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Cash-in type name is required.');
  const id = crypto.randomUUID();
  await db.cashInTypes.add({
    id,
    name: trimmed,
    flowClass: DEFAULT_CUSTOM_CASH_IN_TYPE_FLOW_CLASS,
    isCustom: true,
    active: true,
    updatedAt: Date.now(),
  });
  return id;
}

export async function setCashInTypeActive(id: string, active: boolean): Promise<void> {
  await db.cashInTypes.update(id, { active, updatedAt: Date.now() });
}
