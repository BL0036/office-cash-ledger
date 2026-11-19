import Dexie, { type Table } from 'dexie';
import {
  type Budget,
  type CashInType,
  type Category,
  type ExpenseHead,
  type FinancialInstitution,
  type FlowClass,
  type LedgerDay,
  type Staff,
  type StaffVehicle,
  type SyncConfig,
  type Transaction,
  type Vehicle,
} from '../types';

// Index strings for the 8 UUID-keyed tables (Phase 10a) — identical
// secondary indexes to before, just `id` instead of `++id` as the primary
// key. Shared between the "*Migrating" declarations (version 7) and the
// final reclaimed-name declarations (version 8) below, so the two can
// never drift apart.
const TRANSACTIONS_INDEXES =
  'id, date, direction, categoryId, expenseHeadId, cashInTypeId, staffId, vehicleId, institutionId, deletedAt';
const CATEGORIES_INDEXES = 'id, direction, active';
const EXPENSE_HEADS_INDEXES = 'id, categoryId, active';
const CASH_IN_TYPES_INDEXES = 'id, active';
const STAFF_INDEXES = 'id, active';
const VEHICLES_INDEXES = 'id, active';
const FINANCIAL_INSTITUTIONS_INDEXES = 'id, active';
const BUDGETS_INDEXES = 'id, expenseHeadId';

// Phase 10b (version 9): every synced table additionally indexes
// `updatedAt`, so lib/sync.ts's "find rows changed since lastSyncedAt"
// push query (`where('updatedAt').above(...)`) can use the index instead
// of a full table scan. Adding an index to an already-existing store is a
// normal, in-place Dexie version bump -- unlike the Phase 10a primary-key
// change above, this does NOT need the delete-store/"Migrating" dance,
// since IndexedDB allows adding new indexes to an existing object store.
const TRANSACTIONS_INDEXES_V9 = `${TRANSACTIONS_INDEXES}, updatedAt`;
const CATEGORIES_INDEXES_V9 = `${CATEGORIES_INDEXES}, updatedAt`;
const EXPENSE_HEADS_INDEXES_V9 = `${EXPENSE_HEADS_INDEXES}, updatedAt`;
const CASH_IN_TYPES_INDEXES_V9 = `${CASH_IN_TYPES_INDEXES}, updatedAt`;
const STAFF_INDEXES_V9 = `${STAFF_INDEXES}, updatedAt`;
const VEHICLES_INDEXES_V9 = `${VEHICLES_INDEXES}, updatedAt`;
const FINANCIAL_INSTITUTIONS_INDEXES_V9 = `${FINANCIAL_INSTITUTIONS_INDEXES}, updatedAt`;
const BUDGETS_INDEXES_V9 = `${BUDGETS_INDEXES}, updatedAt`;

// Version 10 adds a `name` index to every reference/master-data table that
// the UI sorts with `.orderBy('name')` (see hooks/useLedger.ts:
// useCategories, useExpenseHeads, useCashInTypes, useStaff, useVehicles,
// useFinancialInstitutions). Dexie's `.orderBy()` requires the keyPath it's
// given to actually be an index on the store -- these six tables always had
// a `name` field on their rows, but it was never added to the index string
// in any prior version, so every one of those live queries throws
// `SchemaError: KeyPath name on object store <table> is not indexed` as
// soon as the screen mounts. This is purely additive (new index on an
// existing store) so, like the updatedAt index in v9, it needs no
// .upgrade() -- IndexedDB backfills the new index from existing rows
// automatically. `expenseHeads` is included even though nothing currently
// calls .orderBy('name') on it, for consistency with its sibling reference
// tables and to pre-empt the same crash if that hook is added later.
// Index string for the new Phase 2 (`staffVehicles`) table — its own
// primary index plus `staffId`/`vehicleId` (the two lookup directions
// lib/staffVehicles.ts's getVehiclesForStaff/getStaffForVehicle query by)
// and `updatedAt` (so it can be synced exactly like every other table —
// see lib/sync.ts's `where('updatedAt')` push query).
const STAFF_VEHICLES_INDEXES = 'id, staffId, vehicleId, updatedAt';

const CATEGORIES_INDEXES_V10 = `${CATEGORIES_INDEXES_V9}, name`;
const EXPENSE_HEADS_INDEXES_V10 = `${EXPENSE_HEADS_INDEXES_V9}, name`;
const CASH_IN_TYPES_INDEXES_V10 = `${CASH_IN_TYPES_INDEXES_V9}, name`;
const STAFF_INDEXES_V10 = `${STAFF_INDEXES_V9}, name`;
const VEHICLES_INDEXES_V10 = `${VEHICLES_INDEXES_V9}, name`;
const FINANCIAL_INSTITUTIONS_INDEXES_V10 = `${FINANCIAL_INSTITUTIONS_INDEXES_V9}, name`;

export class CashLedgerDB extends Dexie {
  transactions!: Table<Transaction, string>;
  ledgerDays!: Table<LedgerDay, string>;
  categories!: Table<Category, string>;
  expenseHeads!: Table<ExpenseHead, string>;
  cashInTypes!: Table<CashInType, string>;
  staff!: Table<Staff, string>;
  vehicles!: Table<Vehicle, string>;
  financialInstitutions!: Table<FinancialInstitution, string>;
  budgets!: Table<Budget, string>;
  // Phase 2: many-to-many staff<->vehicle join table — see types.ts.
  staffVehicles!: Table<StaffVehicle, string>;
  // Phase 10b: local-only, never synced to Firestore (see lib/sync.ts and
  // lib/syncConfig.ts) — a single row holding whether/which sync code this
  // device is configured with.
  syncConfig!: Table<SyncConfig, string>;

  // Accepts an optional database name so tests can exercise this exact
  // class (and its full, real version chain / migration logic) against
  // an isolated, disposable database rather than a hand-duplicated copy
  // of the schema — production code always uses the default.
  constructor(name: string = 'office-cash-ledger') {
    super(name);

    // Version 1: Phase 1 — Core Daily Ledger.
    // Staff/Vehicle/FinancialInstitution/Budget tables are declared now
    // (empty, unseeded) so later phases don't need a version bump just to
    // add these tables.
    this.version(1).stores({
      transactions: '++id, date, direction, categoryId, cashInTypeId, deletedAt',
      ledgerDays: 'date',
      categories: '++id, direction, active',
      expenseHeads: '++id, categoryId, active',
      cashInTypes: '++id, active',
      staff: '++id, active',
      vehicles: '++id, active',
      financialInstitutions: '++id, active',
      budgets: '++id, categoryId, periodMonth',
    });

    // Version 2: Phase 2 — Expense Master & Expense Diaries.
    // Adds an index on transactions.expenseHeadId so the diary screen's
    // per-head history query (`where('expenseHeadId').equals(...)`) can
    // use the index instead of a full table scan. This is the only
    // structural change; all other Phase 2 additions (CashInType.flowClass)
    // are unindexed fields that don't require bumping the version. Existing
    // rows are unaffected — Dexie backfills the new index automatically on
    // upgrade, and every other table/index is carried over unchanged.
    this.version(2).stores({
      transactions: '++id, date, direction, categoryId, expenseHeadId, cashInTypeId, deletedAt',
      ledgerDays: 'date',
      categories: '++id, direction, active',
      expenseHeads: '++id, categoryId, active',
      cashInTypes: '++id, active',
      staff: '++id, active',
      vehicles: '++id, active',
      financialInstitutions: '++id, active',
      budgets: '++id, categoryId, periodMonth',
    });

    // Version 3: Phase 3 — Staff & Salary.
    // Adds an index on transactions.staffId so the staff profile's salary
    // history query (`where('staffId').equals(...)`) can use the index
    // instead of a full table scan — the same reasoning as the Phase 2
    // expenseHeadId index above. The `staff` table's real fields
    // (monthlySalaryPaisa, advanceLimitPaisa, joiningDate, notes,
    // assignedVehicleId) are additive, unindexed properties — Dexie
    // doesn't require every field to appear in the index string, and
    // existing (empty) staff rows are unaffected either way.
    this.version(3).stores({
      transactions:
        '++id, date, direction, categoryId, expenseHeadId, cashInTypeId, staffId, deletedAt',
      ledgerDays: 'date',
      categories: '++id, direction, active',
      expenseHeads: '++id, categoryId, active',
      cashInTypes: '++id, active',
      staff: '++id, active',
      vehicles: '++id, active',
      financialInstitutions: '++id, active',
      budgets: '++id, categoryId, periodMonth',
    });

    // Version 4: Phase 5 — Vehicles & Petrol.
    // Adds an index on transactions.vehicleId so the vehicle profile's
    // transaction-history query (`where('vehicleId').equals(...)`) can use
    // the index instead of a full table scan — same reasoning as the
    // Phase 3 staffId index above. The `vehicles` table's real fields
    // (vehicleType, registrationNumber) are additive, unindexed properties,
    // same as Staff's real fields were in v3 — existing (empty) vehicle
    // rows are unaffected either way. `staff.assignedVehicleId` (also new
    // this phase) is likewise unindexed — it's only ever read by id via
    // db.staff.get(), never queried by value.
    this.version(4).stores({
      transactions:
        '++id, date, direction, categoryId, expenseHeadId, cashInTypeId, staffId, vehicleId, deletedAt',
      ledgerDays: 'date',
      categories: '++id, direction, active',
      expenseHeads: '++id, categoryId, active',
      cashInTypes: '++id, active',
      staff: '++id, active',
      vehicles: '++id, active',
      financialInstitutions: '++id, active',
      budgets: '++id, categoryId, periodMonth',
    });
    // Version 5: Phase 6 — Savings / Finance.
    // Adds an index on transactions.institutionId so the institution
    // profile's transaction-history query (`where('institutionId').equals(
    // ...)`) can use the index instead of a full table scan — same
    // reasoning as the staffId (v3) and vehicleId (v4) indexes above. The
    // `financialInstitutions` table's shape is unchanged this phase (still
    // just id/name/active, per the Part A architecture-doc check — no
    // field was missing, so nothing else needed bumping).
    this.version(5).stores({
      transactions:
        '++id, date, direction, categoryId, expenseHeadId, cashInTypeId, staffId, vehicleId, institutionId, deletedAt',
      ledgerDays: 'date',
      categories: '++id, direction, active',
      expenseHeads: '++id, categoryId, active',
      cashInTypes: '++id, active',
      staff: '++id, active',
      vehicles: '++id, active',
      financialInstitutions: '++id, active',
      budgets: '++id, categoryId, periodMonth',
    });

    // Version 6: Phase 8 — Budgets / Alerts.
    // The `budgets` table's actual shape at the start of this phase
    // (`{ id, categoryId, periodMonth, amountPaisa }`, unused anywhere in
    // the app — grep-confirmed zero consumers) didn't match what this
    // phase's Budget entity needs (`{ id, expenseHeadId,
    // monthlyLimitPaisa }`: a recurring per-head limit, not a value
    // pinned to one specific 'YYYY-MM' period). Since nothing ever wrote
    // or read a Budget row before this phase, there's no historical data
    // to migrate — the table is redefined outright rather than
    // additively extended, the one exception to every prior version
    // bump in this file being purely additive. Indexed on expenseHeadId
    // for the `where('expenseHeadId').equals(...)` lookup every budget
    // CRUD/status function uses. No `active` column — see
    // lib/budgets.ts's clearBudget() for why a budget row's mere
    // existence is its "active" state.
    this.version(6).stores({
      transactions:
        '++id, date, direction, categoryId, expenseHeadId, cashInTypeId, staffId, vehicleId, institutionId, deletedAt',
      ledgerDays: 'date',
      categories: '++id, direction, active',
      expenseHeads: '++id, categoryId, active',
      cashInTypes: '++id, active',
      staff: '++id, active',
      vehicles: '++id, active',
      financialInstitutions: '++id, active',
      budgets: '++id, expenseHeadId',
    });

    // Version 7 & 8: Phase 10a — migrate every entity table's primary key
    // from an auto-increment number (++id) to a string UUID
    // (crypto.randomUUID()), and rewrite every foreign-key field
    // throughout the database to point at the new UUIDs — cloud sync
    // (Phase 10b) needs ids that are globally unique across devices,
    // which auto-increment numbers can never be (two separate local
    // databases would each mint their own "transaction #1").
    //
    // This needs TWO version bumps, not one — empirically confirmed
    // during development, not assumed: Dexie does not support changing an
    // existing table's primary key definition in place (redeclaring the
    // same table name from '++id, ...' to 'id, ...' throws "Not yet
    // support for changing primary key"), because IndexedDB itself never
    // allows altering an object store's autoIncrement flag after
    // creation — the only way to change it is to delete the object store
    // and create a new one. Dexie's own documented workaround for this
    // exact scenario is to delete the old store and create a
    // *differently-named* one in the same version, migrate data across
    // in `.upgrade()`, then in a later version delete the temporary store
    // and reclaim the original name. Using a permanent different table
    // name instead (avoiding the second bump) was rejected: it would mean
    // renaming `db.transactions`/`db.categories`/etc. everywhere in the
    // app (every lib file, every hook, every component) to a
    // "...Migrating"-suffixed name forever, a far larger and riskier diff
    // than one extra, mechanical version() block here.
    //
    // Version 7 does the REAL work: for every affected table, delete the
    // old (numeric-keyed) store and create a "<name>Migrating" store with
    // the new (string-keyed) schema; in upgrade(), read every old row
    // (still fully present and readable at this point — verified
    // empirically), generate a fresh UUID per row, build an old-id ->
    // new-id map per table, then rewrite every row's own id AND every
    // foreign-key field it carries using those maps, before writing the
    // transformed rows into the "Migrating" stores. `ledgerDays` needs no
    // migration (still keyed by `date`) — audited: neither
    // recalcCascadeFrom nor computeDayTotals nor ensureLedgerDay reads or
    // writes any entity foreign key on a LedgerDay row; it only ever
    // touches `date`, the four paisa fields, `isManualOpening`, and
    // `recalculatedAt` — so it's carried over unchanged in both versions,
    // just to keep it present in every version's stores() declaration
    // (omitting a table from stores() means "delete it").
    //
    // Version 8 is purely mechanical: delete each "<name>Migrating" store
    // and recreate the ORIGINAL table name with the same (already-final)
    // schema, copying rows straight across with no further
    // transformation — every relationship was already correctly rewritten
    // in version 7. This means `db.transactions`, `db.categories`, etc.
    // are the exact same property/table names the rest of the app has
    // always used; nothing outside this file needs to know the migration
    // happened in two steps.
    this.version(7)
      .stores({
        transactions: null,
        transactionsMigrating: TRANSACTIONS_INDEXES,
        categories: null,
        categoriesMigrating: CATEGORIES_INDEXES,
        expenseHeads: null,
        expenseHeadsMigrating: EXPENSE_HEADS_INDEXES,
        cashInTypes: null,
        cashInTypesMigrating: CASH_IN_TYPES_INDEXES,
        staff: null,
        staffMigrating: STAFF_INDEXES,
        vehicles: null,
        vehiclesMigrating: VEHICLES_INDEXES,
        financialInstitutions: null,
        financialInstitutionsMigrating: FINANCIAL_INSTITUTIONS_INDEXES,
        budgets: null,
        budgetsMigrating: BUDGETS_INDEXES,
        ledgerDays: 'date',
      })
      .upgrade(async (tx) => {
        const genId = () => crypto.randomUUID();

        // Pass 1: read every old (numeric-id) row from every affected
        // table, and mint it a fresh UUID. Old->new maps built now, used
        // below to rewrite every foreign-key reference.
        const oldCategories = await tx.table('categories').toArray();
        const oldExpenseHeads = await tx.table('expenseHeads').toArray();
        const oldCashInTypes = await tx.table('cashInTypes').toArray();
        const oldStaff = await tx.table('staff').toArray();
        const oldVehicles = await tx.table('vehicles').toArray();
        const oldInstitutions = await tx.table('financialInstitutions').toArray();
        const oldBudgets = await tx.table('budgets').toArray();
        const oldTransactions = await tx.table('transactions').toArray();

        const categoryIdMap = new Map<number, string>(
          oldCategories.map((r: { id: number }) => [r.id, genId()]),
        );
        const expenseHeadIdMap = new Map<number, string>(
          oldExpenseHeads.map((r: { id: number }) => [r.id, genId()]),
        );
        const cashInTypeIdMap = new Map<number, string>(
          oldCashInTypes.map((r: { id: number }) => [r.id, genId()]),
        );
        const staffIdMap = new Map<number, string>(oldStaff.map((r: { id: number }) => [r.id, genId()]));
        const vehicleIdMap = new Map<number, string>(
          oldVehicles.map((r: { id: number }) => [r.id, genId()]),
        );
        const institutionIdMap = new Map<number, string>(
          oldInstitutions.map((r: { id: number }) => [r.id, genId()]),
        );
        const budgetIdMap = new Map<number, string>(oldBudgets.map((r: { id: number }) => [r.id, genId()]));

        // Remaps a nullable numeric FK to its new UUID via `map`. Throws
        // (aborting the whole upgrade transaction — nothing gets
        // committed) rather than silently dropping a relationship if an
        // old id doesn't resolve, since that would indicate real data
        // corruption, not an expected null.
        function remapNullable(map: Map<number, string>, oldId: number | null, label: string): string | null {
          if (oldId == null) return null;
          const newId = map.get(oldId);
          if (newId === undefined) {
            throw new Error(`Migration failed: ${label} ${oldId} has no matching new id.`);
          }
          return newId;
        }
        function remapRequired(map: Map<number, string>, oldId: number, label: string): string {
          const newId = map.get(oldId);
          if (newId === undefined) {
            throw new Error(`Migration failed: ${label} ${oldId} has no matching new id.`);
          }
          return newId;
        }

        // Pass 2: rewrite every row's own id and every foreign key it
        // carries, using the maps built above.
        const newCategories = oldCategories.map((r: { id: number }) => ({
          ...r,
          id: categoryIdMap.get(r.id)!,
        }));
        const newExpenseHeads = oldExpenseHeads.map((r: { id: number; categoryId: number }) => ({
          ...r,
          id: expenseHeadIdMap.get(r.id)!,
          categoryId: remapRequired(categoryIdMap, r.categoryId, 'category'),
        }));
        const newCashInTypes = oldCashInTypes.map((r: { id: number }) => ({
          ...r,
          id: cashInTypeIdMap.get(r.id)!,
        }));
        const newStaff = oldStaff.map((r: { id: number; assignedVehicleId: number | null }) => ({
          ...r,
          id: staffIdMap.get(r.id)!,
          assignedVehicleId: remapNullable(vehicleIdMap, r.assignedVehicleId, 'vehicle'),
        }));
        const newVehicles = oldVehicles.map((r: { id: number }) => ({
          ...r,
          id: vehicleIdMap.get(r.id)!,
        }));
        const newInstitutions = oldInstitutions.map((r: { id: number }) => ({
          ...r,
          id: institutionIdMap.get(r.id)!,
        }));
        const newBudgets = oldBudgets.map((r: { id: number; expenseHeadId: number }) => ({
          ...r,
          id: budgetIdMap.get(r.id)!,
          expenseHeadId: remapRequired(expenseHeadIdMap, r.expenseHeadId, 'expense head'),
        }));
        const newTransactions = oldTransactions.map(
          (r: {
            id: number;
            categoryId: number | null;
            expenseHeadId: number | null;
            cashInTypeId: number | null;
            staffId: number | null;
            vehicleId: number | null;
            institutionId: number | null;
          }) => ({
            ...r,
            id: genId(),
            categoryId: remapNullable(categoryIdMap, r.categoryId, 'category'),
            expenseHeadId: remapNullable(expenseHeadIdMap, r.expenseHeadId, 'expense head'),
            cashInTypeId: remapNullable(cashInTypeIdMap, r.cashInTypeId, 'cash-in type'),
            staffId: remapNullable(staffIdMap, r.staffId, 'staff'),
            vehicleId: remapNullable(vehicleIdMap, r.vehicleId, 'vehicle'),
            institutionId: remapNullable(institutionIdMap, r.institutionId, 'institution'),
          }),
        );

        await tx.table('categoriesMigrating').bulkAdd(newCategories);
        await tx.table('expenseHeadsMigrating').bulkAdd(newExpenseHeads);
        await tx.table('cashInTypesMigrating').bulkAdd(newCashInTypes);
        await tx.table('staffMigrating').bulkAdd(newStaff);
        await tx.table('vehiclesMigrating').bulkAdd(newVehicles);
        await tx.table('financialInstitutionsMigrating').bulkAdd(newInstitutions);
        await tx.table('budgetsMigrating').bulkAdd(newBudgets);
        await tx.table('transactionsMigrating').bulkAdd(newTransactions);
      });

    this.version(8)
      .stores({
        transactionsMigrating: null,
        transactions: TRANSACTIONS_INDEXES,
        categoriesMigrating: null,
        categories: CATEGORIES_INDEXES,
        expenseHeadsMigrating: null,
        expenseHeads: EXPENSE_HEADS_INDEXES,
        cashInTypesMigrating: null,
        cashInTypes: CASH_IN_TYPES_INDEXES,
        staffMigrating: null,
        staff: STAFF_INDEXES,
        vehiclesMigrating: null,
        vehicles: VEHICLES_INDEXES,
        financialInstitutionsMigrating: null,
        financialInstitutions: FINANCIAL_INSTITUTIONS_INDEXES,
        budgetsMigrating: null,
        budgets: BUDGETS_INDEXES,
        ledgerDays: 'date',
      })
      .upgrade(async (tx) => {
        // Purely mechanical: reclaim each original table name, copying
        // the already-fully-migrated rows straight across — no further
        // transformation needed, version 7 already did it.
        await tx.table('transactions').bulkAdd(await tx.table('transactionsMigrating').toArray());
        await tx.table('categories').bulkAdd(await tx.table('categoriesMigrating').toArray());
        await tx.table('expenseHeads').bulkAdd(await tx.table('expenseHeadsMigrating').toArray());
        await tx.table('cashInTypes').bulkAdd(await tx.table('cashInTypesMigrating').toArray());
        await tx.table('staff').bulkAdd(await tx.table('staffMigrating').toArray());
        await tx.table('vehicles').bulkAdd(await tx.table('vehiclesMigrating').toArray());
        await tx
          .table('financialInstitutions')
          .bulkAdd(await tx.table('financialInstitutionsMigrating').toArray());
        await tx.table('budgets').bulkAdd(await tx.table('budgetsMigrating').toArray());
      });

    // Version 9: Phase 10b — Cloud Sync.
    //
    // Two purely additive changes, both in-place (no store-rename dance
    // needed — that was only required in v7/v8 above because IndexedDB
    // can't change an existing store's primary-key/autoIncrement flag;
    // adding a new index or a brand-new table has no such restriction):
    //
    // 1. New `syncConfig` table (local-only; never synced itself).
    // 2. Every one of the 8 synced entity tables gains an `updatedAt`
    //    index. `transactions` already had the FIELD (since Phase 1) but
    //    not the index; the other 7 tables (categories, expenseHeads,
    //    cashInTypes, staff, vehicles, financialInstitutions, budgets)
    //    had neither, since nothing before Phase 10b needed to know when a
    //    reference/master-data row last changed. The upgrade() below
    //    backfills `updatedAt` on every existing row in those 7 tables
    //    (transactions rows already all have a real updatedAt from
    //    whichever add/edit call created them, so they're left untouched).
    //    Backfilling with "now" is a deliberate, documented choice: it
    //    means every pre-existing row looks freshly-changed to sync,
    //    which just means the very first "Sync Now" after upgrading push-
    //    -syncs the device's full existing dataset once — exactly the
    //    correct, safe behavior for a row sync has never seen before,
    //    with no way to know or need to know its true original edit time.
    this.version(9)
      .stores({
        transactions: TRANSACTIONS_INDEXES_V9,
        categories: CATEGORIES_INDEXES_V9,
        expenseHeads: EXPENSE_HEADS_INDEXES_V9,
        cashInTypes: CASH_IN_TYPES_INDEXES_V9,
        staff: STAFF_INDEXES_V9,
        vehicles: VEHICLES_INDEXES_V9,
        financialInstitutions: FINANCIAL_INSTITUTIONS_INDEXES_V9,
        budgets: BUDGETS_INDEXES_V9,
        ledgerDays: 'date',
        syncConfig: 'id',
      })
      .upgrade(async (tx) => {
        const now = Date.now();
        const tablesNeedingBackfill = [
          'categories',
          'expenseHeads',
          'cashInTypes',
          'staff',
          'vehicles',
          'financialInstitutions',
          'budgets',
        ] as const;
        for (const tableName of tablesNeedingBackfill) {
          const rows = await tx.table(tableName).toArray();
          await tx.table(tableName).bulkPut(
            rows.map((r: Record<string, unknown>) => ({ ...r, updatedAt: now })),
          );
        }
        // transactions: field already present on every row from Phase 1
        // onward — nothing to backfill, just the new index applies going
        // forward automatically.
      });

    // Version 10: fixes the missing `name` index described above the
    // *_INDEXES_V10 consts. Additive only (no upgrade() needed) -- every
    // row in these tables already has a `name` field from the day the
    // table was created, IndexedDB just needs to be told to index it.
    // `transactions`, `budgets`, `ledgerDays`, and `syncConfig` are
    // untouched, so they're omitted here; Dexie carries a table's schema
    // forward unchanged when a later version() call doesn't mention it.
    this.version(10).stores({
      categories: CATEGORIES_INDEXES_V10,
      expenseHeads: EXPENSE_HEADS_INDEXES_V10,
      cashInTypes: CASH_IN_TYPES_INDEXES_V10,
      staff: STAFF_INDEXES_V10,
      vehicles: VEHICLES_INDEXES_V10,
      financialInstitutions: FINANCIAL_INSTITUTIONS_INDEXES_V10,
    });

    // Version 11: Phase 12g — Smart Entry alias support. Adds
    // `aliases: string[]` to Staff, Vehicle, and FinancialInstitution
    // (types.ts), so the institution-name and staff-advance Fast Entry
    // patterns can match a typed short form/nickname against more than
    // just the one stored `name`.
    //
    // This field is never queried BY VALUE (only ever read directly off an
    // already-fetched row, the same way `notes`/`registrationNumber`
    // already are) — so, unlike the `name` index version 10 added above,
    // it needs no new index and every table's index string here is
    // identical to version 10's.
    //
    // What it DOES need, unlike version 10's index-only bump, is a real
    // `.upgrade()`: IndexedDB only lazily backfills a newly-*indexed*
    // field on old rows (that's what let version 10 skip .upgrade()
    // entirely) — it does not invent a value for a brand-new *field* that
    // predates it, so every institution/staff/vehicle created before this
    // phase would read back `aliases: undefined` instead of `[]` without
    // an explicit backfill. Verified directly against the version-9
    // upgrade() above (this file's other precedent for a plain backfill
    // loop, no store rename/delete dance) that a straightforward
    // toArray()/bulkPut() per table is sufficient here too — this is an
    // ordinary new field on an already-existing store, not the
    // primary-key-type change versions 7/8 had to work around.
    this.version(11)
      .stores({
        staff: STAFF_INDEXES_V10,
        vehicles: VEHICLES_INDEXES_V10,
        financialInstitutions: FINANCIAL_INSTITUTIONS_INDEXES_V10,
      })
      .upgrade(async (tx) => {
        const tablesNeedingAliasesBackfill = ['staff', 'vehicles', 'financialInstitutions'] as const;
        for (const tableName of tablesNeedingAliasesBackfill) {
          const rows = await tx.table(tableName).toArray();
          await tx.table(tableName).bulkPut(
            rows.map((r: Record<string, unknown>) => ({ ...r, aliases: r.aliases ?? [] })),
          );
        }
      });

    // Version 12: Phase 2 — flexible many-to-many staff<->vehicle
    // relationship. Adds the new `staffVehicles` join table (purely
    // additive — a brand-new store, so no store-rename dance like
    // versions 7/8 needed; same as `syncConfig` in version 9 above).
    //
    // Staff.assignedVehicleId itself is NOT removed from the `staff`
    // store's schema this phase (see the DEPRECATED note on that field in
    // types.ts) — its index string here is unchanged from version 10, so
    // it doesn't even need to be re-listed (Dexie carries a table's schema
    // forward unchanged when a later version() call doesn't mention it,
    // same reasoning version 10's own comment gives for omitting
    // `transactions`/`budgets`/etc.).
    //
    // The upgrade() migrates every existing single-vehicle assignment
    // into the new join table: for every Staff row that already has a
    // non-null assignedVehicleId, create exactly one StaffVehicle row
    // linking that staff to that vehicle, so every pre-Phase-2
    // relationship survives unchanged (Test Case 1 / the EXACT SCOPE
    // "do not break existing single-vehicle assignments" requirement).
    // Going forward, addStaff()/editStaff() (lib/staff.ts) never write to
    // assignedVehicleId again — new code reads/writes StaffVehicle only
    // (lib/staffVehicles.ts) — so this backfill is a one-time affair, not
    // an ongoing dual-write.
    this.version(12)
      .stores({
        staffVehicles: STAFF_VEHICLES_INDEXES,
      })
      .upgrade(async (tx) => {
        const now = Date.now();
        const staffRows = await tx.table('staff').toArray();
        const newLinks = staffRows
          .filter((s: { assignedVehicleId: string | null }) => s.assignedVehicleId != null)
          .map((s: { id: string; assignedVehicleId: string | null }) => ({
            id: crypto.randomUUID(),
            staffId: s.id,
            vehicleId: s.assignedVehicleId as string,
            updatedAt: now,
          }));
        if (newLinks.length > 0) {
          await tx.table('staffVehicles').bulkAdd(newLinks);
        }
      });

    // Version 13: Phase 2 bugfix — StaffVehicle switches from hard-delete
    // to the soft-delete (`active: boolean`) convention every other
    // master-data/relationship table here already uses, so that
    // unassigning a vehicle actually propagates through sync (pure
    // upsert-by-id has no way to represent a deleted row — see the note
    // on StaffVehicle in types.ts). Purely additive — no store rename/
    // delete, same shape as version 11's aliases backfill and version
    // 12's own bump above.
    //
    // `.upgrade()`: same reasoning as version 11's aliases backfill —
    // IndexedDB only lazily backfills a newly-*indexed* field on old
    // rows, it does not invent a value for a brand-new field, so every
    // StaffVehicle row created under version 12 (no `active` field at
    // all) needs an explicit backfill to `active: true` here, or it would
    // read back as `active: undefined` and fail the `active !== false`
    // check the rest of this fix relies on. The index string itself is
    // unchanged from version 12 (STAFF_VEHICLES_INDEXES doesn't index
    // `active`), so it doesn't need to be re-listed in `.stores()` — same
    // reasoning version 10's comment gives for omitting untouched tables.
    this.version(13)
      .stores({})
      .upgrade(async (tx) => {
        const rows = await tx.table('staffVehicles').toArray();
        await tx.table('staffVehicles').bulkPut(
          rows.map((r: Record<string, unknown>) => ({ ...r, active: r.active ?? true })),
        );
      });

    // Version 14: Phase 4 — small practical staff-profile fields
    // (employeeId, position, contactNumber, photoDataUrl) for the
    // printable ID card / summary view. Purely additive — no store/index
    // change (none of these four fields is ever queried BY VALUE, only
    // read directly off an already-fetched row, exactly like
    // `notes`/`registrationNumber` and version 11's own `aliases` addition
    // above) — so `staff`'s index string here is identical to version
    // 10's, and this version's `.stores({})` is empty for the same reason
    // version 13's is.
    //
    // Needs a real `.upgrade()` for the same reason version 11's aliases
    // backfill did: IndexedDB only lazily backfills a newly-*indexed*
    // field on old rows, it never invents a value for a brand-new *field*
    // — every Staff row created before this phase would otherwise read
    // back `employeeId`/`position`/`contactNumber`/`photoDataUrl` as
    // `undefined` instead of `null`.
    this.version(14)
      .stores({
        staff: STAFF_INDEXES_V10,
      })
      .upgrade(async (tx) => {
        const rows = await tx.table('staff').toArray();
        await tx.table('staff').bulkPut(
          rows.map((r: Record<string, unknown>) => ({
            ...r,
            employeeId: r.employeeId ?? null,
            position: r.position ?? null,
            contactNumber: r.contactNumber ?? null,
            photoDataUrl: r.photoDataUrl ?? null,
          })),
        );
      });
  }
}

// `db` is a `let`, not a `const`, ONLY so __setDbForTesting (below) can
// swap it for an isolated instance in scripts/test-sync.ts — Phase 10b's
// "two local databases both configured with the same sync code" test
// cases (5 and 6) need to run the app's REAL addTransaction/editTransaction/
// syncNow code paths against two independent local databases in the same
// process, not a re-implementation of them. Every consumer throughout the
// app (ledger.ts, staff.ts, sync.ts, ...) accesses `db.<table>` from
// inside a function body, never destructures it at module-load time, so
// this reassignment is a live ES-module binding update that's visible
// everywhere — completely inert for normal app usage (nothing outside
// tests ever calls __setDbForTesting), and touches none of those
// consumers' own logic.
export let db: CashLedgerDB = new CashLedgerDB();

/** TEST-ONLY. Swaps the live `db` binding to `instance`, returning whatever it was before (so a test can restore it). Never called by application code. */
export function __setDbForTesting(instance: CashLedgerDB): CashLedgerDB {
  const previous = db;
  db = instance;
  return previous;
}

// name -> seeded flowClass, per Phase 2 Part A.
const CASH_OUT_CATEGORY_SEED: Record<string, FlowClass> = {
  Food: 'operating_expense',
  'Travel & Fuel': 'operating_expense',
  Office: 'operating_expense',
  Stationery: 'operating_expense',
  'Medical & Supplies': 'operating_expense',
  'Vehicle Maintenance': 'operating_expense',
  Staff: 'staff_payment',
  'Savings & Financial': 'savings_financial',
};

const CASH_IN_TYPE_NAMES = ['ATM', 'Owner Cash', 'Cash Received', 'Cash Returned', 'Other'];

// name -> [expense head names]
const EXPENSE_HEAD_SEED: Record<string, string[]> = {
  Food: ['Khaja', 'Khana'],
  'Travel & Fuel': ['Petrol'],
};

// The expense head Salary payments are filed under. Named separately from
// EXPENSE_HEAD_SEED (rather than added to the Staff entry there) because
// EXPENSE_HEAD_SEED only runs on a brand-new install (see seedReferenceData
// below) — a DB that was already seeded under Phase 1/2 needs this topped
// up too, on every app start, so upgrading users get it without a fresh
// install.
const SALARY_EXPENSE_HEAD_NAME = 'Salary';

// The expense head Advance-given transactions are filed under (Phase 4).
// Same reasoning and same backfill-on-every-app-start precedent as
// SALARY_EXPENSE_HEAD_NAME above — a DB seeded under Phase 1-3 needs this
// topped up too, without a fresh install.
const ADVANCE_EXPENSE_HEAD_NAME = 'Advance';

// The expense head Savings/Finance deposits are filed under (Phase 6).
// Same backfill-on-every-app-start precedent as Salary/Advance above.
const DEPOSIT_EXPENSE_HEAD_NAME = 'Deposit';

// The CashInType Savings/Finance withdrawals are filed under (Phase 6) —
// a dedicated seeded type (flowClass: 'savings_financial'), same
// reasoning as giving Salary/Advance their own expense heads rather than
// lumping them into a generic bucket, so withdrawals stay reportable
// distinctly from ordinary cash-in sources like 'ATM' or 'Owner Cash'.
const FINANCIAL_WITHDRAWAL_CASH_IN_TYPE_NAME = 'Financial Withdrawal';

// The expense head vehicle-servicing cash-out is filed under (Phase 12g),
// alongside the existing 'Petrol' head under the same 'Vehicle
// Maintenance' category. Same backfill-on-every-app-start precedent as
// Salary/Advance/Deposit above, so a DB seeded before this phase gets it
// too, without a fresh install.
const VEHICLE_SERVICE_EXPENSE_HEAD_NAME = 'Service';

/**
 * Seed the reference tables (categories, expense heads, cash-in types) on
 * first run only. Safe to call on every app start — it's a no-op once
 * seeded.
 */
export async function seedReferenceData(): Promise<void> {
  const categoryCount = await db.categories.count();
  const cashInTypeCount = await db.cashInTypes.count();

  if (categoryCount === 0) {
    await db.transaction('rw', db.categories, db.expenseHeads, async () => {
      for (const [name, flowClass] of Object.entries(CASH_OUT_CATEGORY_SEED)) {
        const categoryId = crypto.randomUUID();
        await db.categories.add({
          id: categoryId,
          name,
          direction: 'cash_out',
          flowClass,
          isCustom: false,
          active: true,
          updatedAt: Date.now(),
        });
        const heads = EXPENSE_HEAD_SEED[name];
        if (heads) {
          for (const headName of heads) {
            await db.expenseHeads.add({
              id: crypto.randomUUID(),
              categoryId,
              name: headName,
              isCustom: false,
              active: true,
              updatedAt: Date.now(),
            });
          }
        }
      }
    });
  }

  if (cashInTypeCount === 0) {
    await db.transaction('rw', db.cashInTypes, async () => {
      for (const name of CASH_IN_TYPE_NAMES) {
        // All Phase 2 seeded cash-in types map to 'other_movement' per spec.
        await db.cashInTypes.add({
          id: crypto.randomUUID(),
          name,
          flowClass: 'other_movement',
          isCustom: false,
          active: true,
          updatedAt: Date.now(),
        });
      }
    });
  }

  await ensureSalaryExpenseHead();
  await ensureAdvanceExpenseHead();
  await ensureDepositExpenseHead();
  await ensureFinancialWithdrawalCashInType();
  await ensureVehicleServiceExpenseHead();
  await ensureGoodsAndTransportOptions();
}

// Built-in options added for trading businesses. Fixed ids (not random) so that
// two devices using Cloud Sync each "create" the SAME row and sync merges them
// instead of showing every option twice.
const GOODS_SOLD_CASH_IN_TYPE_ID = 'builtin-cashin-goods-sold';
const GOODS_PURCHASE_CATEGORY_ID = 'builtin-category-goods-purchase';
const TRANSPORT_FARE_CATEGORY_ID = 'builtin-category-transport-fare';

/**
 * Make sure these exist, on every app start (same backfill precedent as the
 * ensure* functions below, so an already-installed app gets them too):
 *   - Cash In source  "Goods Sold"
 *   - Cash Out category "Goods Purchase"
 *   - Cash Out category "Transport Fare / Gadi Bhada"
 * Never duplicates: if a row with the same id OR the same name (any
 * capitalisation) already exists - including one the owner typed in Settings,
 * or one they switched off - nothing is added. Both new categories use
 * 'operating_expense', the same bucket as ordinary day-to-day cash-out.
 */
async function ensureGoodsAndTransportOptions(): Promise<void> {
  await db.transaction('rw', db.categories, db.cashInTypes, async () => {
    const allCategories = await db.categories.toArray();
    const allCashInTypes = await db.cashInTypes.toArray();
    const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

    const categoriesToEnsure: { id: string; name: string }[] = [
      { id: GOODS_PURCHASE_CATEGORY_ID, name: 'Goods Purchase' },
      { id: TRANSPORT_FARE_CATEGORY_ID, name: 'Transport Fare / Gadi Bhada' },
    ];
    for (const wanted of categoriesToEnsure) {
      const exists = allCategories.some((c) => c.id === wanted.id || sameName(c.name, wanted.name));
      if (exists) continue;
      await db.categories.add({
        id: wanted.id,
        name: wanted.name,
        direction: 'cash_out',
        flowClass: 'operating_expense',
        isCustom: false,
        active: true,
        updatedAt: Date.now(),
      });
    }

    const goodsSoldExists = allCashInTypes.some(
      (t) => t.id === GOODS_SOLD_CASH_IN_TYPE_ID || sameName(t.name, 'Goods Sold'),
    );
    if (!goodsSoldExists) {
      await db.cashInTypes.add({
        id: GOODS_SOLD_CASH_IN_TYPE_ID,
        name: 'Goods Sold',
        flowClass: 'other_movement',
        isCustom: false,
        active: true,
        updatedAt: Date.now(),
      });
    }
  });
}

/**
 * Ensure the 'Salary' expense head exists under the 'Staff' category.
 * Runs on every app start (unlike the categoryCount===0-gated seeding
 * above) so it also backfills DBs that were already seeded before Phase 3.
 * No-op once the head exists.
 */
async function ensureSalaryExpenseHead(): Promise<void> {
  await db.transaction('rw', db.categories, db.expenseHeads, async () => {
    const allCategories = await db.categories.toArray();
    const staffCategory = allCategories.find((c) => c.name === 'Staff');
    if (!staffCategory?.id) return; // Staff category not seeded yet; nothing to attach to.

    const existing = await db.expenseHeads
      .where('categoryId')
      .equals(staffCategory.id)
      .and((h) => h.name === SALARY_EXPENSE_HEAD_NAME)
      .first();
    if (existing) return;

    await db.expenseHeads.add({
      id: crypto.randomUUID(),
      categoryId: staffCategory.id,
      name: SALARY_EXPENSE_HEAD_NAME,
      isCustom: false,
      active: true,
    
      updatedAt: Date.now(),
    });
  });
}

/**
 * Ensure the 'Advance' expense head exists under the 'Staff' category.
 * Runs on every app start, same precedent as ensureSalaryExpenseHead
 * above, so it also backfills DBs seeded before Phase 4. No-op once the
 * head exists.
 */
async function ensureAdvanceExpenseHead(): Promise<void> {
  await db.transaction('rw', db.categories, db.expenseHeads, async () => {
    const allCategories = await db.categories.toArray();
    const staffCategory = allCategories.find((c) => c.name === 'Staff');
    if (!staffCategory?.id) return; // Staff category not seeded yet; nothing to attach to.

    const existing = await db.expenseHeads
      .where('categoryId')
      .equals(staffCategory.id)
      .and((h) => h.name === ADVANCE_EXPENSE_HEAD_NAME)
      .first();
    if (existing) return;

    await db.expenseHeads.add({
      id: crypto.randomUUID(),
      categoryId: staffCategory.id,
      name: ADVANCE_EXPENSE_HEAD_NAME,
      isCustom: false,
      active: true,
    
      updatedAt: Date.now(),
    });
  });
}

/**
 * Ensure the 'Deposit' expense head exists under the 'Savings & Financial'
 * category (Phase 6). Same backfill-on-every-app-start precedent as
 * ensureSalaryExpenseHead/ensureAdvanceExpenseHead above. No-op once the
 * head exists.
 */
async function ensureDepositExpenseHead(): Promise<void> {
  await db.transaction('rw', db.categories, db.expenseHeads, async () => {
    const allCategories = await db.categories.toArray();
    const savingsCategory = allCategories.find((c) => c.name === 'Savings & Financial');
    if (!savingsCategory?.id) return; // Category not seeded yet; nothing to attach to.

    const existing = await db.expenseHeads
      .where('categoryId')
      .equals(savingsCategory.id)
      .and((h) => h.name === DEPOSIT_EXPENSE_HEAD_NAME)
      .first();
    if (existing) return;

    await db.expenseHeads.add({
      id: crypto.randomUUID(),
      categoryId: savingsCategory.id,
      name: DEPOSIT_EXPENSE_HEAD_NAME,
      isCustom: false,
      active: true,
    
      updatedAt: Date.now(),
    });
  });
}

/**
 * Ensure the 'Service' expense head exists under the 'Vehicle Maintenance'
 * category (Phase 12g), alongside the existing seeded 'Petrol' head under
 * the same category. Same backfill-on-every-app-start precedent as
 * ensureSalaryExpenseHead/ensureAdvanceExpenseHead/ensureDepositExpenseHead
 * above. No-op once the head exists.
 */
async function ensureVehicleServiceExpenseHead(): Promise<void> {
  await db.transaction('rw', db.categories, db.expenseHeads, async () => {
    const allCategories = await db.categories.toArray();
    const vehicleMaintenanceCategory = allCategories.find((c) => c.name === 'Vehicle Maintenance');
    if (!vehicleMaintenanceCategory?.id) return; // Category not seeded yet; nothing to attach to.

    const existing = await db.expenseHeads
      .where('categoryId')
      .equals(vehicleMaintenanceCategory.id)
      .and((h) => h.name === VEHICLE_SERVICE_EXPENSE_HEAD_NAME)
      .first();
    if (existing) return;

    await db.expenseHeads.add({
      id: crypto.randomUUID(),
      categoryId: vehicleMaintenanceCategory.id,
      name: VEHICLE_SERVICE_EXPENSE_HEAD_NAME,
      isCustom: false,
      active: true,
      updatedAt: Date.now(),
    });
  });
}

/**
 * Ensure the 'Financial Withdrawal' cash-in type exists (Phase 6), with
 * flowClass: 'savings_financial' so a withdrawal's flowClass resolves
 * correctly at write time (see resolveFlowClass in lib/ledger.ts) — unlike
 * the Phase 2 CASH_IN_TYPE_NAMES seed, which are all 'other_movement'.
 * Runs on every app start (not gated by cashInTypeCount === 0 like the
 * initial seed), same backfill precedent as the expense-head ensure-
 * functions above, so it also backfills DBs seeded before Phase 6.
 */
async function ensureFinancialWithdrawalCashInType(): Promise<void> {
  await db.transaction('rw', db.cashInTypes, async () => {
    const existing = await db.cashInTypes
      .filter((t) => t.name === FINANCIAL_WITHDRAWAL_CASH_IN_TYPE_NAME)
      .first();
    if (existing) return;

    await db.cashInTypes.add({
      id: crypto.randomUUID(),
      name: FINANCIAL_WITHDRAWAL_CASH_IN_TYPE_NAME,
      flowClass: 'savings_financial',
      isCustom: false,
      active: true,
    
      updatedAt: Date.now(),
    });
  });
}
