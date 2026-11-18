import {
  collection,
  doc,
  getDocs,
  query,
  where,
  writeBatch,
  type Firestore,
} from 'firebase/firestore';
import { db } from '../db/schema';
import { recalcCascadeFrom } from './ledger';
import { ensureSignedIn, getSyncFirestore } from './firebaseClient';
import { getSyncConfig, updateLastSyncedAt } from './syncConfig';

// Phase 10b Part B: the 8 entity tables synced via
// syncGroups/{syncCode}/{table}/{id}. `ledgerDays` is deliberately
// excluded — it's a derived cache (see db/schema.ts, lib/ledger.ts), never
// a synced source of truth. Every other table this app has is included.
// Phase 2: `staffVehicles` (the new many-to-many join table) added,
// following this exact same generic pattern — no special-cased sync
// strategy for it.
export const SYNC_TABLES = [
  'transactions',
  'categories',
  'expenseHeads',
  'cashInTypes',
  'staff',
  'vehicles',
  'financialInstitutions',
  'budgets',
  'staffVehicles',
] as const;

export type SyncTableName = (typeof SYNC_TABLES)[number];

// Generic shape sync only needs to know about — the real domain types
// (Transaction, Category, ...) all satisfy this. Firestore, not Dexie,
// enforces nothing else here (Part B: no server-side schema).
interface SyncableRow {
  id: string;
  updatedAt: number;
  [key: string]: unknown;
}

export interface SyncSummary {
  pushedCounts: Record<SyncTableName, number>;
  pulledCounts: Record<SyncTableName, number>;
  /** Rows pulled from Firestore that overwrote a local row (last-write-wins actually fired), vs. ones that were simply new locally. Informational only. */
  overwrittenCounts: Record<SyncTableName, number>;
  syncedAt: number;
}

function emptyCounts(): Record<SyncTableName, number> {
  const counts = {} as Record<SyncTableName, number>;
  for (const t of SYNC_TABLES) counts[t] = 0;
  return counts;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Firestore's writeBatch caps at 500 operations; stay comfortably under.
const BATCH_SIZE = 450;

/**
 * Part C — push every row in `table` changed after `sinceMs` and at-or-
 * before `cutoff` to `syncGroups/{syncCode}/{table}/{id}`, keyed by the
 * row's own UUID via `.set()`. `.set()` on a fixed id is what makes this
 * idempotent (Part C): calling it twice with the same data writes the
 * same document twice, never duplicating anything. Network-only — touches
 * no local (Dexie) state.
 *
 * v1.0 sync hardening: bounded by `cutoff` (not just `sinceMs` with no
 * upper bound) — see syncNow()'s docstring for why an unbounded query
 * here was the actual bug. `cutoff` is captured once, at the very start
 * of syncNow(), before this function (or anything else in the network
 * phase) ever runs.
 */
async function pushTable(
  firestore: Firestore,
  syncCode: string,
  table: SyncTableName,
  sinceMs: number | null,
  cutoff: number,
): Promise<number> {
  const dexieTable = db.table<SyncableRow, string>(table);
  const rows: SyncableRow[] =
    sinceMs == null
      ? await dexieTable.where('updatedAt').belowOrEqual(cutoff).toArray()
      : await dexieTable.where('updatedAt').between(sinceMs, cutoff, false, true).toArray();

  for (const rowsChunk of chunk(rows, BATCH_SIZE)) {
    const batch = writeBatch(firestore);
    for (const row of rowsChunk) {
      const ref = doc(firestore, 'syncGroups', syncCode, table, row.id);
      batch.set(ref, row);
    }
    await batch.commit();
  }
  return rows.length;
}

interface PulledTable {
  table: SyncTableName;
  /** Remote rows to insert (no local row with that id existed) or overwrite (remote.updatedAt > local.updatedAt) — everything else is left alone. */
  toApply: SyncableRow[];
  overwrittenCount: number;
  totalFetched: number;
}

/**
 * Part D — fetch every row in `table` changed after `sinceMs` and
 * at-or-before `cutoff` from Firestore, and decide (without writing
 * anything locally yet) which ones should be applied: new locally, or a
 * newer remote value than what's stored locally (last-write-wins by
 * updatedAt). A row whose LOCAL value is newer or equal is intentionally
 * left out of `toApply` — it'll be pushed by this same sync pass's
 * pushTable() call instead (Part D). Network-only (plus local READS to
 * compare) — no local WRITE happens here; see syncNow() for why that
 * separation matters for atomicity.
 *
 * v1.0 sync hardening: bounded above by `cutoff` for the same reason as
 * pushTable() — a remote row written by another device mid-sync, after
 * this query already ran, must remain eligible for the *next* sync
 * rather than being silently skipped forever because lastSyncedAt moved
 * past it without ever having actually fetched it.
 */
async function pullTable(
  firestore: Firestore,
  syncCode: string,
  table: SyncTableName,
  sinceMs: number | null,
  cutoff: number,
): Promise<PulledTable> {
  const colRef = collection(firestore, 'syncGroups', syncCode, table);
  const q =
    sinceMs == null
      ? query(colRef, where('updatedAt', '<=', cutoff))
      : query(colRef, where('updatedAt', '>', sinceMs), where('updatedAt', '<=', cutoff));
  const snapshot = await getDocs(q);

  const dexieTable = db.table<SyncableRow, string>(table);
  const toApply: SyncableRow[] = [];
  let overwrittenCount = 0;

  for (const docSnap of snapshot.docs) {
    const remote = docSnap.data() as SyncableRow;
    const local = await dexieTable.get(remote.id);
    if (!local) {
      toApply.push(remote);
    } else if (remote.updatedAt > local.updatedAt) {
      toApply.push(remote);
      overwrittenCount++;
    }
    // else: local is newer or equal — leave it; pushTable() will push it.
  }

  return { table, toApply, overwrittenCount, totalFetched: snapshot.size };
}

/**
 * Part D: after all pulled rows are applied, rebuild every affected
 * LedgerDay by re-running recalcCascadeFrom from the EARLIEST date among
 * any transaction inserted or changed this sync pass — never trust a
 * remote device's cached balance, same principle as Phase 9's restore
 * logic (see lib/backup.ts). Both a transaction's new date and (on an
 * edit-in-place from another device) its old local date are included,
 * since both days' totals may have changed.
 */
function collectAffectedDates(
  transactionsToApply: SyncableRow[],
  localTransactionsBeforeApply: Map<string, SyncableRow>,
): string[] {
  const dates = new Set<string>();
  for (const row of transactionsToApply) {
    if (typeof row.date === 'string') dates.add(row.date);
    const priorLocal = localTransactionsBeforeApply.get(row.id);
    if (priorLocal && typeof priorLocal.date === 'string') dates.add(priorLocal.date);
  }
  return Array.from(dates).sort();
}

/**
 * Part C + D — "Sync Now": push every locally-changed row, pull every
 * remotely-changed row, resolve conflicts last-write-wins by updatedAt,
 * and rebuild LedgerDays from the transactions that actually changed.
 *
 * ATOMICITY (Part D, Test Case 9): all network work (push AND the pull
 * fetch/compare) happens FIRST, before any local Dexie write. Only once
 * every push batch has committed and every pull query has resolved does
 * this function touch local data at all — and it does so in a single
 * Dexie transaction (pulled rows + the LedgerDay recalculation +
 * lastSyncedAt), which Dexie atomically commits or rolls back as one
 * unit. So: if push OR pull fails for any reason (network error,
 * Firestore unavailable), execution never reaches the local transaction
 * at all — local data and lastSyncedAt are left byte-for-byte unchanged,
 * and the thrown error is the one piece of new information the caller
 * gets. Because push is idempotent (`.set()` by stable UUID) and
 * lastSyncedAt is only advanced on full success, simply calling syncNow()
 * again after a failure is always safe and correct — it re-pushes
 * whatever already-succeeded-remotely rows again (a harmless no-op
 * overwrite) and retries whatever didn't.
 *
 * CONCURRENCY CUTOFF (v1.0 sync hardening): `cutoff` is captured once,
 * synchronously, as this function's very first statement — before
 * ensureSignedIn(), before any push, before any pull. Every push/pull
 * query this sync pass runs is bounded to rows with `sinceMs < updatedAt
 * <= cutoff`, and lastSyncedAt is set to `cutoff` itself, never to
 * Date.now() read again later. This matters because a sync pass takes
 * real time (multiple sequential network round trips across 8 tables,
 * twice each) — during that window the person using the app can keep
 * entering transactions with Fast Entry exactly as normal; nothing about
 * Sync Now blocks or pauses that.
 *
 * Previously, lastSyncedAt was set from Date.now() read AFTER all network
 * work finished, and push/pull queries were unbounded above (just
 * `updatedAt > sinceMs`, whatever that matched at the instant the query
 * ran). A row created mid-sync — after its table's query had already run,
 * but before the sync finished — was silently excluded from that sync's
 * push, and then the *next* sync's sinceMs (the stale end-of-sync
 * Date.now()) was already past that row's updatedAt, so it was excluded
 * from every future sync too: silent, permanent data loss from Cloud
 * Sync specifically (the row was never at risk locally). Capturing the
 * cutoff up front and never advancing lastSyncedAt past it fixes this: a
 * row created mid-sync always has `updatedAt > cutoff`, so this pass
 * correctly leaves it alone, and the next sync's sinceMs (this cutoff)
 * is still before it, so it's picked up next time without fail.
 */
// Phase 11 Part E bug fix: the Firestore Web SDK does not reliably reject
// its promises when the device is offline — by default it just keeps
// retrying its underlying stream with backoff, which means an unguarded
// getDocs()/batch.commit() call can hang indefinitely instead of failing.
// That's exactly the "hangs instead of showing a clear offline state"
// failure Part E's manual QA checklist calls out. Two guards below fix
// it: an upfront navigator.onLine check (fails instantly for the common
// case), and a hard timeout wrapped around the whole network phase
// (catches the remaining cases — flaky connections, captive portals, DNS
// that hangs rather than errors — where navigator.onLine can't be
// trusted).
const NETWORK_PHASE_TIMEOUT_MS = 20_000;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

const OFFLINE_ERROR_MESSAGE =
  "No internet connection — Cloud Sync is unavailable right now. Your data is safe locally; press Sync Now again once you're back online.";
const TIMEOUT_ERROR_MESSAGE =
  "Couldn't reach Cloud Sync (timed out) — check your connection. Your data is safe locally; press Sync Now again once you're back online.";

export async function syncNow(): Promise<SyncSummary> {
  // Captured first, before anything else — see the CONCURRENCY CUTOFF
  // note above.
  const cutoff = Date.now();

  const config = await getSyncConfig();
  if (!config) {
    throw new Error('No sync code configured. Set one up in Cloud Sync settings first.');
  }

  // Fails instantly for the common case instead of ever touching the
  // network. `navigator` doesn't exist under scripts/test-sync.ts's plain
  // Node/tsx environment, so this is guarded the same way — it simply
  // doesn't apply there, same as it wouldn't in any non-browser context.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new Error(OFFLINE_ERROR_MESSAGE);
  }

  const firestore = getSyncFirestore();
  const sinceMs = config.lastSyncedAt;

  const pushedCounts = emptyCounts();
  const pulledCounts = emptyCounts();
  const overwrittenCounts = emptyCounts();

  // --- Network phase: sign in, push, then pull-and-decide. No local
  // writes happen anywhere in here — see the ATOMICITY note on this
  // function's docstring below. Wrapped in a single timeout so a hung
  // connection surfaces as a clear, prompt error instead of an
  // indefinitely "syncing…" UI.
  const pulledByTable: PulledTable[] = await withTimeout(
    (async () => {
      await ensureSignedIn();
      for (const table of SYNC_TABLES) {
        pushedCounts[table] = await pushTable(firestore, config.syncCode, table, sinceMs, cutoff);
      }
      const pulled: PulledTable[] = [];
      for (const table of SYNC_TABLES) {
        const result = await pullTable(firestore, config.syncCode, table, sinceMs, cutoff);
        pulledCounts[table] = result.totalFetched;
        overwrittenCounts[table] = result.overwrittenCount;
        pulled.push(result);
      }
      return pulled;
    })(),
    NETWORK_PHASE_TIMEOUT_MS,
    TIMEOUT_ERROR_MESSAGE,
  );

  // --- Local phase: apply everything in one atomic Dexie transaction. ---
  const syncedAt = cutoff;
  await db.transaction(
    'rw',
    [
      db.transactions,
      db.ledgerDays,
      db.categories,
      db.expenseHeads,
      db.cashInTypes,
      db.staff,
      db.vehicles,
      db.financialInstitutions,
      db.budgets,
      db.staffVehicles,
      db.syncConfig,
    ],
    async () => {
      // Snapshot local transactions BEFORE applying pulled changes, so
      // collectAffectedDates can see an edited transaction's OLD date
      // too (Part D: both the day it moved from and the day it moved to
      // need their totals rebuilt).
      const priorLocalTransactions = new Map<string, SyncableRow>();
      const pulledTransactions = pulledByTable.find((p) => p.table === 'transactions');
      if (pulledTransactions && pulledTransactions.toApply.length > 0) {
        for (const row of pulledTransactions.toApply) {
          const existing = await db.transactions.get(row.id);
          if (existing) priorLocalTransactions.set(row.id, existing as unknown as SyncableRow);
        }
      }

      for (const pulled of pulledByTable) {
        if (pulled.toApply.length === 0) continue;
        const dexieTable = db.table<SyncableRow, string>(pulled.table);
        await dexieTable.bulkPut(pulled.toApply);
      }

      const affectedDates = pulledTransactions
        ? collectAffectedDates(pulledTransactions.toApply, priorLocalTransactions)
        : [];
      if (affectedDates.length > 0) {
        const earliest = affectedDates[0];
        await recalcCascadeFrom(earliest);
      }

      // Only reached on full success — see ATOMICITY note above.
      const currentConfig = await getSyncConfigInTx();
      if (currentConfig) {
        await db.syncConfig.put({ ...currentConfig, lastSyncedAt: syncedAt });
      }
    },
  );

  return { pushedCounts, pulledCounts, overwrittenCounts, syncedAt };
}

// Reads syncConfig from WITHIN the active db.transaction() above — going
// through getSyncConfig() (syncConfig.ts) would also work since Dexie
// table calls made during an active transaction automatically join it,
// but this local helper keeps that fact explicit at the call site rather
// than relying on syncConfig.ts's caller-agnostic implementation.
async function getSyncConfigInTx() {
  return db.syncConfig.get('singleton');
}

export { updateLastSyncedAt };
