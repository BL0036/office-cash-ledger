// Phase 7: tests for the OPTIONAL app-level PIN/password lock
// (lib/appLock.ts) and the way it's wired in.
//
// Same conventions as scripts/test-ai-fallback.ts: headless (fake-indexeddb,
// an in-memory localStorage polyfill), so React components can't be
// rendered here. Where a test case describes UI behavior, this file
// exercises the exact lib functions the components call (LockScreen.tsx,
// AppLockGate.tsx and SettingsView.tsx are thin over lib/appLock.ts by
// design) and, where wiring matters, checks the component source
// statically.
//
// Crypto: real Web Crypto (Node's globalThis.crypto.subtle) is used
// throughout - nothing about hashing is faked. To keep this suite fast,
// most tests lower the PBKDF2 iteration count through the test-only
// __setPbkdf2IterationsForTests() hook; a dedicated test then runs the
// REAL production 600,000-iteration path end to end. Time is controlled
// by overriding Date.now() (rate-limit + idle timeout) and, for the idle
// watcher's real timers, tiny durations against a plain EventTarget.
//
// Usage: npx tsx scripts/test-app-lock.ts

import 'fake-indexeddb/auto';
import { db, seedReferenceData } from '../src/db/schema';
import { addTransaction, type NewTransactionInput } from '../src/lib/ledger';
import { SYNC_TABLES } from '../src/lib/sync';
import { exportBackup, restoreFromBackup, serializeBackup } from '../src/lib/backup';
import {
  APP_LOCK_STORAGE_KEY,
  DEFAULT_IDLE_MINUTES,
  FREE_FAILED_ATTEMPTS,
  PBKDF2_ITERATIONS,
  __resetSessionForTests,
  __setPbkdf2IterationsForTests,
  changePin,
  checkIdleAndLock,
  delayMsForFailures,
  disableLock,
  generateRecoveryCode,
  getAppLockState,
  getIdleMinutes,
  getRetryAfterMs,
  isAppLockSupported,
  isLockConfigured,
  lockNow,
  noteActivity,
  notifyAppLockStorageChanged,
  resetViaRecoveryCode,
  setIdleMinutes,
  setupLock,
  startIdleWatcher,
  subscribeAppLock,
  validateNewPin,
  verify,
  resetViaExternalVerification,
} from '../src/lib/appLock';
import {
  getGoogleRecoveryLinkedAt,
  getLinkedGoogleClientId,
  isGoogleRecoveryLinked,
  linkGoogleAccount,
  unlinkGoogleAccount,
  verifyGoogleAccountForRecovery,
  __resetForTests as __resetGoogleRecoveryForTests,
} from '../src/lib/googleAccountRecovery';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '../src');

let passed = 0;
let failed = 0;

function assertEqual(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  PASS  ${label} (${JSON.stringify(actual)})`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertTrue(label: string, actual: boolean) {
  assertEqual(label, actual, true);
}

// ---- Minimal in-memory localStorage polyfill (Node has none by default) ----
class MemoryStorage {
  store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
  get length(): number {
    return this.store.size;
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
}
const memory = new MemoryStorage();
(globalThis as unknown as { localStorage: Storage }).localStorage = memory as unknown as Storage;

// ---- Controllable clock (only Date.now; real timers stay real) ----
const realNow = Date.now.bind(Date);
let fakeNow = 0;
function freezeClock(start = realNow()) {
  fakeNow = start;
  Date.now = () => fakeNow;
}
function advance(ms: number) {
  fakeNow += ms;
}
function restoreClock() {
  Date.now = realNow;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const RECOVERY_CODE_RE = /^([A-HJ-NP-Z2-9]{4}-){4}[A-HJ-NP-Z2-9]{4}$/;

function rawLock(): string | null {
  return memory.getItem(APP_LOCK_STORAGE_KEY);
}
function parsedLock(): Record<string, any> {
  return JSON.parse(rawLock() ?? 'null');
}

async function dumpDb(): Promise<string> {
  const out: Record<string, unknown[]> = {};
  for (const table of db.tables) out[table.name] = await table.toArray();
  return JSON.stringify(out);
}

/**
 * Like dumpDb(), minus ledgerDays[].recalculatedAt. restoreFromBackup()
 * legitimately re-runs the balance cascade, which restamps that one
 * bookkeeping field with "now" - pre-existing restore behavior, unrelated
 * to the lock - so post-restore comparisons must ignore it. Everything
 * else (every transaction, category, head, type, ...) is still compared.
 */
async function dumpDbStable(): Promise<string> {
  const out: Record<string, unknown[]> = {};
  for (const table of db.tables) {
    const rows = await table.toArray();
    out[table.name] = table.name === 'ledgerDays' ? rows.map((r: any) => ({ ...r, recalculatedAt: 0 })) : rows;
  }
  return JSON.stringify(out);
}

function allSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...allSourceFiles(p));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(p);
  }
  return out;
}

/** Source with comments removed, so "does this code use X" checks aren't fooled by prose that merely mentions X. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), 'utf-8');
}

async function main() {
  // Fast hashing for the bulk of the suite; the production count is
  // exercised by its own test below.
  __setPbkdf2IterationsForTests(1000);

  await seedReferenceData();
  const categories = await db.categories.toArray();
  const officeCategory = categories.find((c) => c.name === 'Office')!;
  for (let i = 1; i <= 3; i++) {
    const input: NewTransactionInput = {
      date: '2026-09-0' + i,
      direction: 'cash_out',
      amountPaisa: i * 100_00,
      categoryId: officeCategory.id,
      expenseHeadId: null,
      cashInTypeId: null,
      description: `lock-suite seed entry ${i}`,
      staffId: null,
      vehicleId: null,
      institutionId: null,
      referenceNumber: null,
      notes: null,
      linkedAdvanceRecoveryPaisa: null,
    };
    await addTransaction(input);
  }
  const dbBefore = await dumpDb();
  const dbBeforeStable = await dumpDbStable();
  const txCountBefore = await db.transactions.count();

  // ===================================================================
  // Test case 1: no lock configured -> app behaves exactly as today
  // ===================================================================
  console.log('\nTest case 1: no lock configured');
  assertEqual('isLockConfigured() is false by default', isLockConfigured(), false);
  assertEqual("getAppLockState() is 'unconfigured' (the gate renders children untouched)", getAppLockState(), 'unconfigured');
  assertEqual('getIdleMinutes() reports the 15-minute default', getIdleMinutes(), DEFAULT_IDLE_MINUTES);
  assertEqual('...and the default really is 15', DEFAULT_IDLE_MINUTES, 15);
  lockNow();
  assertEqual('lockNow() is a no-op with no lock configured', getAppLockState(), 'unconfigured');
  assertEqual('checkIdleAndLock() never locks with no lock configured', checkIdleAndLock(Date.now() + 10 * 3_600_000), false);
  noteActivity();
  assertEqual('noteActivity() is a harmless no-op', getAppLockState(), 'unconfigured');
  assertEqual("verify() reports 'not-configured' (nothing to check)", (await verify('anything')) as unknown, { ok: false, reason: 'not-configured' });
  assertEqual("disableLock() reports 'not-configured'", (await disableLock('anything')) as unknown, { ok: false, reason: 'not-configured' });
  assertEqual('getRetryAfterMs() is 0', getRetryAfterMs(), 0);
  assertEqual('None of the above wrote anything to localStorage', memory.length, 0);
  assertTrue('None of it touched the ledger database either', (await dumpDb()) === dbBefore);
  {
    // The idle watcher does nothing observable when no lock is configured.
    const activity = new EventTarget();
    const visibility = new EventTarget();
    const stop = startIdleWatcher({ activityTarget: activity, visibilityTarget: visibility, isHidden: () => false, checkIntervalMs: 5 });
    activity.dispatchEvent(new Event('keydown'));
    visibility.dispatchEvent(new Event('visibilitychange'));
    await sleep(20);
    stop();
    assertEqual('An idle watcher with no lock configured changes nothing', getAppLockState(), 'unconfigured');
  }
  {
    const gateSource = readSrc('components/AppLockGate.tsx');
    assertTrue(
      "AppLockGate renders <LockScreen/> ONLY for state 'locked' and otherwise returns children untouched (statically verified)",
      /if \(state === 'locked'\) return <LockScreen \/>;\s*return <>\{children\}<\/>;/.test(gateSource),
    );
    assertTrue("AppLockGate only starts the idle watcher for state 'unlocked' (statically verified)", /if \(state !== 'unlocked'\) return;\s*return startIdleWatcher\(/.test(gateSource));
    const appSource = readSrc('App.tsx');
    assertTrue('App.tsx wraps <AppShell /> in <AppLockGate> inside LanguageProvider (statically verified)', /<LanguageProvider>\s*<AppLockGate>\s*<AppShell \/>\s*<\/AppLockGate>\s*<\/LanguageProvider>/.test(appSource));
    assertTrue("The sidebar 'Lock now' button renders null when unconfigured (statically verified)", /if \(lockState === 'unconfigured'\) return null;/.test(appSource));
  }
  assertTrue('Web Crypto is available in this environment (needed by everything below)', isAppLockSupported());

  // ===================================================================
  // Test case 2: setup stores ONLY salt + hash, never plaintext, anywhere
  // ===================================================================
  console.log('\nTest case 2: setup stores only salt+hash');
  assertEqual('validateNewPin rejects too-short entries', validateNewPin('123'), 'too-short');
  assertEqual('validateNewPin accepts a 4-character PIN', validateNewPin('1234'), null);
  assertEqual("setupLock() with a too-short PIN is refused ('invalid-new-pin')", (await setupLock('12')) as unknown, { ok: false, reason: 'invalid-new-pin' });
  assertEqual('...and stored nothing', memory.length, 0);

  const PIN = '739155';
  const setup = await setupLock(PIN, { idleMinutes: 15 });
  assertTrue('setupLock() succeeds', setup.ok);
  const recoveryCode = setup.ok ? setup.recoveryCode : '';
  assertTrue('It returns a recovery code in the XXXX-XXXX-XXXX-XXXX-XXXX format (32-symbol alphabet, no I/O/0/1)', RECOVERY_CODE_RE.test(recoveryCode));
  assertEqual("The session is left unlocked right after setup (the owner just set the PIN)", getAppLockState(), 'unlocked');
  assertEqual('isLockConfigured() is now true', isLockConfigured(), true);

  const stored = parsedLock();
  assertEqual('Exactly ONE localStorage entry was written', memory.length, 1);
  assertEqual('The stored record has exactly the expected fields (no pin/plaintext field)', Object.keys(stored).sort(), ['failedAttempts', 'idleMinutes', 'lockedUntil', 'pin', 'recovery', 'version']);
  assertEqual('pin record holds only algo/iterations/salt/hash', Object.keys(stored.pin).sort(), ['algo', 'hash', 'iterations', 'salt']);
  assertEqual('recovery record holds only algo/iterations/salt/hash', Object.keys(stored.recovery).sort(), ['algo', 'hash', 'iterations', 'salt']);
  assertTrue('pin salt is 16 random bytes (32 hex chars) and hash is 32 bytes (64 hex chars)', /^[0-9a-f]{32}$/.test(stored.pin.salt) && /^[0-9a-f]{64}$/.test(stored.pin.hash));
  assertTrue('The PIN and recovery code use DIFFERENT salts', stored.pin.salt !== stored.recovery.salt);
  const rawText = rawLock()!;
  assertTrue('The raw stored JSON contains NO trace of the PIN', !rawText.includes(PIN));
  assertTrue('...nor of the recovery code (with or without hyphens, either case)', !rawText.includes(recoveryCode) && !rawText.includes(recoveryCode.replace(/-/g, '')) && !rawText.toLowerCase().includes(recoveryCode.replace(/-/g, '').toLowerCase()));
  {
    // Every localStorage key AND value, and every Dexie table row, and the
    // full backup JSON: none may contain the PIN or the recovery code.
    let leaked = false;
    for (let i = 0; i < memory.length; i++) {
      const k = memory.key(i)!;
      const v = memory.getItem(k)!;
      if (k.includes(PIN) || v.includes(PIN) || v.includes(recoveryCode) || v.includes(recoveryCode.replace(/-/g, ''))) leaked = true;
    }
    assertTrue('No localStorage key or value anywhere holds the PIN or recovery code', !leaked);
    const dbText = await dumpDb();
    assertTrue('No Dexie table row anywhere holds the PIN or recovery code', !dbText.includes(PIN) && !dbText.includes(recoveryCode));
  }
  assertEqual("Web Crypto's real derived hash matches what was stored (verify() round-trips)", (await verify(PIN)).ok, true);

  assertEqual('A second setupLock() while already configured is refused', (await setupLock('another-pin')) as unknown, { ok: false, reason: 'already-configured' });
  assertTrue('...and did not disturb the existing lock', rawLock() === rawText);

  // Salting: the same PIN set up twice yields different salts and hashes.
  assertEqual('disableLock with the right PIN succeeds (used here to reset for the salting check)', (await disableLock(PIN)).ok, true);
  const setup2 = await setupLock(PIN);
  const stored2 = parsedLock();
  assertTrue('Setting up the SAME PIN again produces a different salt AND a different hash (salting works)', stored2.pin.salt !== stored.pin.salt && stored2.pin.hash !== stored.pin.hash);
  const recoveryCode2 = setup2.ok ? setup2.recoveryCode : '';
  assertTrue('...and a different recovery code', recoveryCode2 !== recoveryCode && RECOVERY_CODE_RE.test(recoveryCode2));

  // Password (not just digits), spaces and Devanagari, NFC equivalence.
  assertEqual('disableLock (re-set for the password check)', (await disableLock(PIN)).ok, true);
  const PASSWORD = 'पासवर्ड १२३ correct horse';
  const setup3 = await setupLock(PASSWORD);
  assertTrue('A passphrase with spaces and Devanagari characters is accepted', setup3.ok);
  assertTrue('...and is not stored in plaintext either', !rawLock()!.includes('correct horse') && !rawLock()!.includes('पासवर्ड'));
  assertEqual('...verifies with the exact passphrase', (await verify(PASSWORD)).ok, true);
  assertEqual('...is case-sensitive', (await verify(PASSWORD.toUpperCase())).ok, false);
  assertEqual('...is NOT trimmed (a trailing space is part of it, so this fails)', (await verify(PASSWORD + ' ')).ok, false);
  assertEqual('disableLock (reset for NFC check)', (await disableLock(PASSWORD)).ok, true);
  const composed = 'caf\u00e9-pin'; // é as one code point
  const decomposed = 'cafe\u0301-pin'; // e + combining acute
  await setupLock(composed);
  assertEqual('The same text typed with a different Unicode composition (NFC vs NFD) still unlocks', (await verify(decomposed)).ok, true);
  await disableLock(composed);

  // Generated recovery codes: alphabet + uniqueness sanity.
  {
    const codes = new Set<string>();
    let allValid = true;
    for (let i = 0; i < 200; i++) {
      const c = generateRecoveryCode();
      codes.add(c);
      if (!RECOVERY_CODE_RE.test(c)) allValid = false;
    }
    assertTrue('200 generated recovery codes are all well-formed', allValid);
    assertEqual('...and all distinct (100 bits of randomness)', codes.size, 200);
  }

  // The real production iteration count, end to end.
  {
    __setPbkdf2IterationsForTests(null);
    const t0 = realNow();
    const real = await setupLock('real-iterations-pin');
    const setupMs = realNow() - t0;
    assertTrue('setupLock() works at the REAL production iteration count', real.ok);
    assertEqual('The stored iteration count is 600,000 (OWASP minimum for PBKDF2-HMAC-SHA256)', parsedLock().pin.iterations, 600_000);
    assertEqual('...and matches the exported PBKDF2_ITERATIONS constant', PBKDF2_ITERATIONS, 600_000);
    assertEqual('...for the recovery hash too', parsedLock().recovery.iterations, 600_000);
    __resetSessionForTests();
    const t1 = realNow();
    const okReal = await verify('real-iterations-pin');
    const verifyMs = realNow() - t1;
    assertTrue('verify() with the correct PIN works at the real iteration count', okReal.ok);
    assertEqual('verify() with a wrong PIN fails at the real iteration count', (await verify('wrong-pin-here')).ok, false);
    console.log(`  (info) real-iteration timing in this sandbox: setup (2 hashes) ${setupMs}ms, one verify ${verifyMs}ms`);
    assertEqual('disable (cleanup)', (await disableLock('real-iterations-pin')).ok, true);
    __setPbkdf2IterationsForTests(1000);
  }

  // Failure to persist must never masquerade as success.
  {
    const realStorage = (globalThis as unknown as { localStorage: Storage }).localStorage;
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => memory.getItem(k),
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: (k: string) => memory.removeItem(k),
    } as unknown as Storage;
    const failedSetup = await setupLock('some-pin-1234');
    assertEqual("setupLock() reports 'storage-unavailable' when localStorage can't be written", failedSetup as unknown, { ok: false, reason: 'storage-unavailable' });
    assertEqual('...no recovery code is handed out for a lock that did not persist', 'recoveryCode' in failedSetup, false);
    assertEqual('...and the app is NOT locked', getAppLockState(), 'unconfigured');
    (globalThis as unknown as { localStorage: Storage }).localStorage = realStorage;
  }

  // Web Crypto unavailable (e.g. plain http:// on a LAN address).
  {
    const desc = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true });
    assertEqual('isAppLockSupported() is false when Web Crypto is missing', isAppLockSupported(), false);
    assertEqual("setupLock() reports 'unsupported' instead of throwing", (await setupLock('some-pin-1234')) as unknown, { ok: false, reason: 'unsupported' });
    assertEqual('...and stored nothing', memory.length, 0);
    Object.defineProperty(globalThis, 'crypto', desc!);
    assertTrue('Web Crypto is back for the rest of the suite', isAppLockSupported());
  }

  // Corrupt / tampered record -> fail OPEN (never a permanent lockout).
  {
    memory.setItem(APP_LOCK_STORAGE_KEY, '{not json');
    assertEqual('A corrupt lock record is treated as "no lock" (fail-open, never a permanent lockout)', isLockConfigured(), false);
    memory.setItem(APP_LOCK_STORAGE_KEY, JSON.stringify({ version: 1, pin: { algo: 'PBKDF2-SHA256' } }));
    assertEqual('A structurally incomplete record is also treated as "no lock"', isLockConfigured(), false);
    memory.removeItem(APP_LOCK_STORAGE_KEY);
  }

  // ===================================================================
  // Test case 3: correct PIN unlocks, wrong PIN doesn't, rate-limit delay
  // ===================================================================
  console.log('\nTest case 3: unlock, wrong PIN, and the rate-limit delay');
  assertEqual('delayMsForFailures: no delay for the first 4 failures', [1, 2, 3, 4].map(delayMsForFailures), [0, 0, 0, 0]);
  assertEqual('delayMsForFailures: 5th=5s, 6th=10s, 7th=20s, 8th=40s, then capped at 60s', [5, 6, 7, 8, 9, 10, 50].map(delayMsForFailures), [5000, 10000, 20000, 40000, 60000, 60000, 60000]);
  assertEqual('FREE_FAILED_ATTEMPTS is 4', FREE_FAILED_ATTEMPTS, 4);

  await setupLock(PIN);
  __resetSessionForTests(); // == a page reload: session state is memory-only
  assertEqual('After a "reload" the app is locked again', getAppLockState(), 'locked');
  assertEqual("...but the lock config itself persisted", isLockConfigured(), true);

  freezeClock();
  const w1 = await verify('000000');
  assertEqual('An incorrect PIN does not unlock', w1.ok, false);
  assertEqual("...the reason is 'wrong-pin' with 3 free tries left and no delay yet", { reason: (w1 as any).reason, left: (w1 as any).attemptsBeforeDelay, delay: (w1 as any).retryAfterMs ?? null }, { reason: 'wrong-pin', left: 3, delay: null });
  assertEqual('...and the app is still locked', getAppLockState(), 'locked');
  const w2 = await verify('111111');
  const w3 = await verify('222222');
  const w4 = await verify('333333');
  assertEqual('Wrong tries 2-4 are also free (genuine typos are not punished): no delay yet', [w2, w3, w4].map((r) => (r as any).retryAfterMs ?? null), [null, null, null]);
  assertEqual('attemptsBeforeDelay counts down 3,2,1,0', [w1, w2, w3, w4].map((r) => (r as any).attemptsBeforeDelay), [3, 2, 1, 0]);
  const w5 = await verify('444444');
  assertEqual('The 5th consecutive wrong try triggers a 5-second delay', (w5 as any).retryAfterMs, 5000);
  const blocked = await verify(PIN);
  assertEqual('During the delay even the CORRECT PIN is refused (rate-limited), with the remaining wait reported', { ok: blocked.ok, reason: (blocked as any).reason, wait: (blocked as any).retryAfterMs }, { ok: false, reason: 'rate-limited', wait: 5000 });
  assertEqual('...and the app is still locked', getAppLockState(), 'locked');
  assertEqual('getRetryAfterMs() reports the remaining wait', getRetryAfterMs(), 5000);
  __resetSessionForTests(); // reload mid-delay
  assertEqual('A page reload does NOT reset the delay (it is persisted)', getRetryAfterMs(), 5000);
  advance(4999);
  assertEqual('1ms before the delay ends the correct PIN is still refused', ((await verify(PIN)) as any).reason, 'rate-limited');
  advance(2);
  const okAfterWait = await verify(PIN);
  assertEqual('After the delay elapses the correct PIN unlocks', okAfterWait.ok, true);
  assertEqual('...the app is unlocked', getAppLockState(), 'unlocked');
  assertEqual('...and the failure counter was reset', { failed: parsedLock().failedAttempts, until: parsedLock().lockedUntil }, { failed: 0, until: 0 });

  // Escalation
  __resetSessionForTests();
  const delays: number[] = [];
  for (let i = 1; i <= 10; i++) {
    const r = await verify('wrong-' + i);
    delays.push((r as any).retryAfterMs ?? 0);
    advance((r as any).retryAfterMs ? (r as any).retryAfterMs + 1 : 0);
  }
  assertEqual('Ten wrong tries in a row escalate 0,0,0,0,5s,10s,20s,40s,60s,60s', delays, [0, 0, 0, 0, 5000, 10000, 20000, 40000, 60000, 60000]);
  assertEqual('The correct PIN still works after all of that (a lockout is only ever a wait, never permanent)', (await verify(PIN)).ok, true);

  // A typo followed by success does not accumulate toward a delay later.
  __resetSessionForTests();
  await verify('typo-1');
  await verify('typo-2');
  assertEqual('Two typos then the correct PIN unlocks normally', (await verify(PIN)).ok, true);
  assertEqual('...and resets the counter (so a later single typo is again fully free)', ((await verify('x')) as any).attemptsBeforeDelay, 3);
  await verify(PIN);

  // Rapid parallel submits (double Enter / scripted) can't skip the limiter.
  __resetSessionForTests();
  {
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => verify('parallel-' + i)));
    const reasons = results.map((r) => (r as any).reason);
    assertEqual('Six wrong tries fired IN PARALLEL are processed one at a time: 5 counted failures + 1 refused by the delay', reasons, ['wrong-pin', 'wrong-pin', 'wrong-pin', 'wrong-pin', 'wrong-pin', 'rate-limited']);
    assertEqual('...exactly 5 failures were recorded (the refused 6th is not counted)', parsedLock().failedAttempts, 5);
  }
  advance(6000);
  assertEqual('...and the correct PIN works after the wait', (await verify(PIN)).ok, true);

  // Empty entry
  __resetSessionForTests();
  assertEqual('An empty entry is simply a wrong PIN', ((await verify('')) as any).reason, 'wrong-pin');
  await verify(PIN);

  // Wrong PINs can never affect data (constraint #6).
  assertTrue('After every wrong/blocked attempt above, the ledger database is byte-for-byte unchanged', (await dumpDb()) === dbBefore);
  assertEqual('...and the transaction count is unchanged', await db.transactions.count(), txCountBefore);

  // disableLock / changePin
  console.log('\nTest case 3b: change PIN and disable require the current PIN');
  assertEqual('changePin with a WRONG current PIN is refused', ((await changePin('nope-nope', 'brand-new-pin')) as any).reason, 'wrong-pin');
  assertEqual('changePin with a too-short NEW PIN is refused without burning a wrong-attempt', { reason: ((await changePin(PIN, '1')) as any).reason, failed: parsedLock().failedAttempts }, { reason: 'invalid-new-pin', failed: 1 });
  // (failed:1 above = the single wrong attempt from the previous line)
  const rcBeforeChange = parsedLock().recovery;
  assertEqual('changePin with the correct current PIN succeeds', (await changePin(PIN, 'brand-new-pin')).ok, true);
  assertEqual('...the recovery record is untouched by a PIN change', parsedLock().recovery, rcBeforeChange);
  __resetSessionForTests();
  assertEqual('...the OLD PIN no longer unlocks', (await verify(PIN)).ok, false);
  assertEqual('...the NEW PIN does', (await verify('brand-new-pin')).ok, true);
  assertEqual('disableLock with a WRONG PIN is refused and the lock stays', { reason: ((await disableLock('nope-nope')) as any).reason, configured: isLockConfigured() }, { reason: 'wrong-pin', configured: true });
  assertEqual('disableLock with the correct PIN turns the lock off', (await disableLock('brand-new-pin')).ok, true);
  assertEqual('...the stored record is gone entirely', rawLock(), null);
  assertEqual("...and the app state is 'unconfigured' again", getAppLockState(), 'unconfigured');
  assertTrue('...the ledger data is untouched by disabling', (await dumpDb()) === dbBefore);
  restoreClock();

  // ===================================================================
  // Test case 4: recovery code
  // ===================================================================
  console.log('\nTest case 4: recovery-code flow');
  const s4 = await setupLock(PIN);
  const RC = s4.ok ? s4.recoveryCode : '';
  __resetSessionForTests();
  freezeClock();

  assertEqual("A WRONG recovery code is refused ('wrong-recovery-code')", ((await resetViaRecoveryCode('AAAA-BBBB-CCCC-DDDD-EEEE', 'fresh-pin-1')) as any).reason, 'wrong-recovery-code');
  assertEqual('...and the old PIN is unchanged (still works)', (await verify(PIN)).ok, true);
  __resetSessionForTests();
  assertEqual("A too-short NEW PIN is refused ('invalid-new-pin') even with the right code...", ((await resetViaRecoveryCode(RC, '12')) as any).reason, 'invalid-new-pin');
  assertEqual('...and does not consume a wrong-attempt', parsedLock().failedAttempts, 0);

  const reset = await resetViaRecoveryCode(RC.toLowerCase().replace(/-/g, ' '), 'fresh-pin-1');
  assertTrue('The CORRECT recovery code (typed lowercase, spaces instead of hyphens) lets the owner set a new PIN', reset.ok);
  const RC2 = reset.ok ? reset.recoveryCode : '';
  assertEqual('resetViaRecoveryCode() by itself does NOT unlock the session (only a successful verify() ever does)', getAppLockState(), 'locked');
  assertTrue('A NEW recovery code is issued (the old one was just typed on screen: single-use)', RECOVERY_CODE_RE.test(RC2) && RC2 !== RC);
  assertEqual('The OLD PIN no longer works', (await verify(PIN)).ok, false);
  assertEqual('The NEW PIN works', (await verify('fresh-pin-1')).ok, true);
  __resetSessionForTests();
  assertEqual('The OLD recovery code no longer works (single-use)', ((await resetViaRecoveryCode(RC, 'another-pin-2')) as any).reason, 'wrong-recovery-code');
  await verify('fresh-pin-1');
  __resetSessionForTests();
  assertTrue('The NEW recovery code works', (await resetViaRecoveryCode(RC2, 'third-pin-3')).ok);
  assertEqual('...and sets the pin it was given', (await verify('third-pin-3')).ok, true);
  {
    const rawNow = rawLock()!;
    assertTrue('After resets, the stored record still contains no plaintext of any PIN or recovery code', !['fresh-pin-1', 'third-pin-3', PIN, RC, RC2, RC.replace(/-/g, ''), RC2.replace(/-/g, '')].some((s) => rawNow.includes(s)));
  }

  // Wrong recovery codes are rate-limited too (they share the counter).
  __resetSessionForTests();
  {
    const reasons: string[] = [];
    for (let i = 0; i < 6; i++) reasons.push(((await resetViaRecoveryCode('ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZ2' + i, 'whatever-pin')) as any).reason);
    assertEqual('Repeated wrong recovery codes hit the same rate limit', reasons, ['wrong-recovery-code', 'wrong-recovery-code', 'wrong-recovery-code', 'wrong-recovery-code', 'wrong-recovery-code', 'rate-limited']);
  }
  advance(6000);
  assertEqual('...and the correct PIN works again after the wait', (await verify('third-pin-3')).ok, true);
  assertTrue('The ledger database is untouched by every recovery attempt', (await dumpDb()) === dbBefore);
  await disableLock('third-pin-3');
  restoreClock();

  // ===================================================================
  // Test case 5: absent from exportBackup() output and SYNC_TABLES
  // ===================================================================
  console.log('\nTest case 5: excluded from backup and sync');
  const s5 = await setupLock('backup-check-pin');
  const RC5 = s5.ok ? s5.recoveryCode : '';
  const lockRecord = parsedLock();
  assertTrue('SYNC_TABLES contains no lock-related table name', !SYNC_TABLES.some((t) => /lock|pin|recovery|passw/i.test(t)));
  assertTrue('The Dexie schema has no lock-related table either', !db.tables.some((t) => /lock|pin|recovery|passw/i.test(t.name)));
  const backup = await exportBackup();
  const backupJson = JSON.stringify(backup);
  assertEqual(
    'The exported backup has EXACTLY the pre-existing top-level keys (nothing lock-related was added)',
    Object.keys(backup).sort(),
    ['appVersion', 'budgets', 'cashInTypes', 'categories', 'exportedAt', 'expenseHeads', 'financialInstitutions', 'ledgerDays', 'schemaVersion', 'staff', 'staffVehicles', 'transactions', 'vehicles'].sort(),
  );
  assertTrue('The exported backup JSON contains no trace of the PIN', !backupJson.includes('backup-check-pin'));
  assertTrue('...nor the recovery code', !backupJson.includes(RC5) && !backupJson.includes(RC5.replace(/-/g, '')));
  assertTrue("...nor the lock's stored salt or hash values", !backupJson.includes(lockRecord.pin.salt) && !backupJson.includes(lockRecord.pin.hash) && !backupJson.includes(lockRecord.recovery.salt) && !backupJson.includes(lockRecord.recovery.hash));
  assertTrue('...nor the storage key name or any appLock field', !/appLock|officeCashLedger\.appLock|idleMinutes|failedAttempts|lockedUntil/.test(backupJson));
  const serialized = serializeBackup(backup);
  assertTrue('The serialized backup FILE text is equally clean', !serialized.includes(lockRecord.pin.hash) && !serialized.includes('backup-check-pin'));
  {
    // A restore must neither carry a lock in, nor wipe the local one.
    const rawBefore = rawLock();
    await restoreFromBackup(serialized);
    assertTrue('restoreFromBackup() leaves this device\'s lock exactly as it was (a backup neither carries nor erases it)', rawLock() === rawBefore);
    assertTrue('...and the restored data is identical to what was exported (ledgerDays.recalculatedAt aside - see dumpDbStable)', (await dumpDbStable()) === dbBeforeStable);
  }
  {
    const files = allSourceFiles(SRC);
    const importers = files
      .filter((f) => /from\s+['"][^'"]*appLock(Messages)?['"]/.test(fs.readFileSync(f, 'utf-8')))
      .map((f) => path.relative(SRC, f).split(path.sep).join('/'))
      .sort();
    assertEqual('ONLY the UI files (plus lib/googleAccountRecovery.ts, which deliberately reuses appLock.ts\'s own hashing rather than duplicating it - see that file\'s header comment) import lib/appLock (statically verified across all of src/)', importers, [
      'App.tsx', 'components/AppLockGate.tsx', 'components/LockScreen.tsx', 'components/SettingsView.tsx', 'hooks/useAppLock.ts', 'lib/appLockMessages.ts', 'lib/googleAccountRecovery.ts',
    ]);
    const dataLayer = ['lib/backup.ts', 'lib/sync.ts', 'lib/syncConfig.ts', 'lib/firebaseClient.ts', 'lib/ledger.ts', 'lib/staff.ts', 'lib/vehicles.ts', 'lib/institutions.ts', 'lib/referenceData.ts', 'lib/budgets.ts', 'lib/aggregation.ts', 'lib/reports.ts', 'lib/fastEntry.ts', 'lib/fastEntrySuggestions.ts', 'lib/aiFallback.ts', 'lib/aiSettingsStore.ts', 'db/schema.ts'];
    for (const f of dataLayer) {
      assertTrue(`${f} never references appLock (statically verified)`, !/appLock|AppLock/.test(readSrc(f)));
    }
    assertTrue('lib/backup.ts and lib/sync.ts never touch localStorage at all (so no path from it to a backup file or Firestore)', !/localStorage/.test(readSrc('lib/backup.ts')) && !/localStorage/.test(readSrc('lib/sync.ts')));
    const lockSource = stripComments(readSrc('lib/appLock.ts'));
    assertTrue('lib/appLock.ts has NO import statements at all - no db, ledger, backup or sync (statically verified, comments excluded)', !/^\s*import\s/m.test(lockSource));
    assertTrue('lib/appLock.ts stores via localStorage, not a Dexie table (statically verified, comments excluded)', /localStorage/.test(lockSource) && !/\bdb\./.test(lockSource) && !/Dexie/.test(lockSource));
    const keyLiteralFiles = files.filter((f) => fs.readFileSync(f, 'utf-8').includes('officeCashLedger.appLock')).map((f) => path.relative(SRC, f).split(path.sep).join('/'));
    assertEqual('The storage key literal appears in exactly one source file', keyLiteralFiles, ['lib/appLock.ts']);
  }
  await disableLock('backup-check-pin');

  // ===================================================================
  // Test case 6: idle timeout re-locks
  // ===================================================================
  console.log('\nTest case 6: idle auto-lock');
  await setupLock(PIN, { idleMinutes: 15 });
  assertEqual('The configured idle period is 15 minutes', getIdleMinutes(), 15);
  const MIN = 60_000;
  freezeClock();
  __resetSessionForTests();
  await verify(PIN);
  assertEqual('Unlocked', getAppLockState(), 'unlocked');
  advance(14 * MIN);
  assertEqual('After 14 minutes idle the app is still unlocked', checkIdleAndLock(), false);
  noteActivity();
  advance(14 * MIN);
  assertEqual('Activity resets the clock: 14 more minutes after it is still unlocked', checkIdleAndLock(), false);
  advance(1 * MIN);
  assertEqual('At 15 minutes since the last activity the app RE-LOCKS', checkIdleAndLock(), true);
  assertEqual("...state is 'locked' and the PIN is required again", getAppLockState(), 'locked');
  assertEqual('...the PIN unlocks it again', (await verify(PIN)).ok, true);

  // Waking a sleeping machine: the first mouse move must not refresh the clock.
  advance(2 * 60 * MIN);
  noteActivity();
  assertEqual('If the machine slept for 2 hours, the FIRST input event locks instead of refreshing the timestamp', getAppLockState(), 'locked');

  // Clock moved backwards
  await verify(PIN);
  advance(-60 * MIN);
  assertEqual('A clock that jumps backwards does not lock or break anything', checkIdleAndLock(), false);
  assertEqual('...still unlocked', getAppLockState(), 'unlocked');

  // Configurable period
  assertEqual('setIdleMinutes(1) persists', setIdleMinutes(1), true);
  assertEqual('...getIdleMinutes() reports it', getIdleMinutes(), 1);
  assertEqual('...and it is stored in the lock record', parsedLock().idleMinutes, 1);
  noteActivity();
  advance(59_000);
  assertEqual('With a 1-minute period, 59s idle does not lock', checkIdleAndLock(), false);
  advance(1_000);
  assertEqual('...60s idle does', checkIdleAndLock(), true);
  assertEqual('setIdleMinutes rejects 0, negatives, NaN and >24h', [0, -5, NaN, 24 * 60 + 1].map(setIdleMinutes), [false, false, false, false]);
  assertEqual('...leaving the stored value alone', getIdleMinutes(), 1);
  restoreClock();

  // Real timers + real event flow through startIdleWatcher, with a tiny period.
  {
    __resetSessionForTests();
    await verify(PIN);
    assertTrue('setIdleMinutes(0.0025) (150ms, test-only tiny period)', setIdleMinutes(0.0025));
    const activity = new EventTarget();
    const visibility = new EventTarget();
    let hidden = false;
    const stop = startIdleWatcher({ activityTarget: activity, visibilityTarget: visibility, isHidden: () => hidden, checkIntervalMs: 10 });
    noteActivity();
    for (let i = 0; i < 12; i++) {
      await sleep(20);
      activity.dispatchEvent(new Event(i % 2 ? 'keydown' : 'pointermove'));
    }
    assertEqual('Continuous input events (keydown/pointermove) across ~240ms keep a 150ms lock from firing', getAppLockState(), 'unlocked');
    await sleep(450);
    assertEqual('With no input for 450ms the watcher\'s own timer re-locks the app (real timers)', getAppLockState(), 'locked');
    stop();

    // visibilitychange path, with the interval effectively disabled
    __resetSessionForTests();
    await verify(PIN);
    const stop2 = startIdleWatcher({ activityTarget: activity, visibilityTarget: visibility, isHidden: () => hidden, checkIntervalMs: 3_600_000 });
    await sleep(300);
    assertEqual('Idle past the period but no timer tick has run: still (stale) unlocked', getAppLockState(), 'unlocked');
    hidden = true;
    visibility.dispatchEvent(new Event('visibilitychange'));
    assertEqual('visibilitychange while the tab is HIDDEN does not lock (nobody is looking)', getAppLockState(), 'unlocked');
    hidden = false;
    visibility.dispatchEvent(new Event('visibilitychange'));
    assertEqual('When the tab becomes VISIBLE again after the idle period, the app locks before the user can use it', getAppLockState(), 'locked');
    stop2();

    // After stop(), events no longer reach the lock logic.
    __resetSessionForTests();
    await verify(PIN);
    setIdleMinutes(0.0025);
    const stop3 = startIdleWatcher({ activityTarget: activity, visibilityTarget: visibility, isHidden: () => false, checkIntervalMs: 3_600_000 });
    stop3();
    await sleep(300);
    visibility.dispatchEvent(new Event('visibilitychange'));
    assertEqual('After stop(), the watcher is fully detached (no timer, no listeners)', getAppLockState(), 'unlocked');
    setIdleMinutes(15);
  }

  // Manual lock
  __resetSessionForTests();
  await verify(PIN);
  lockNow();
  assertEqual("lockNow() locks immediately and the app returns to the PIN screen", getAppLockState(), 'locked');

  // Subscription + cross-tab
  {
    let calls = 0;
    const unsub = subscribeAppLock(() => {
      calls++;
    });
    await verify(PIN);
    assertTrue('Subscribers are notified when the lock state changes', calls >= 1);
    const callsBefore = calls;
    notifyAppLockStorageChanged();
    assertEqual('notifyAppLockStorageChanged() (a `storage` event from another tab) notifies subscribers', calls, callsBefore + 1);
    unsub();
    // Lock removed elsewhere while this tab is unlocked, then re-added elsewhere:
    const raw = rawLock()!;
    memory.removeItem(APP_LOCK_STORAGE_KEY);
    assertEqual("A lock removed by another tab shows this tab as 'unconfigured'", getAppLockState(), 'unconfigured');
    memory.setItem(APP_LOCK_STORAGE_KEY, raw);
    notifyAppLockStorageChanged();
    assertEqual("...and a lock re-added later does NOT resurrect a stale 'unlocked' session - the PIN is required", getAppLockState(), 'locked');
  }
  await verify(PIN);
  await disableLock(PIN);

  // ===================================================================
  // Google-account-linked recovery (lib/googleAccountRecovery.ts) - an
  // ADDITIONAL, optional recovery path alongside the recovery code above,
  // never a replacement. See that file's own header comment.
  // ===================================================================
  console.log('\nGoogle-account-linked PIN recovery');
  {
    // The previous test block ends with the lock disabled - this section
    // needs a fresh PIN configured to reset.
    await setupLock(PIN, { idleMinutes: 15 });

    // ---- Controllable fake GIS ID-token global -----------------------
    // Same technique scripts/test-drive-backup.ts already uses for the
    // OAuth token model, applied to the ID-token model instead: pre-
    // populating `window.google` makes loadGisScript() resolve without
    // ever touching document.createElement - see that function's own
    // "if ((window).google) return Promise.resolve()" fast path. No real
    // network call or real Google account is used anywhere in this file.
    let nextSub: string | null = 'mock-sub-owner-account-111';
    let promptCallCount = 0;
    (globalThis as unknown as { window: typeof globalThis }).window = globalThis;
    (globalThis as unknown as { document: unknown }).document = {
      createElement: () => {
        const fakeScript: { onload: (() => void) | null; onerror: (() => void) | null; src: string; async: boolean; defer: boolean } = {
          onload: null,
          onerror: null,
          src: '',
          async: false,
          defer: false,
        };
        // Simulate the script "loading" instantly - real loadGisScript()
        // sets src then relies on the onload callback firing; nothing
        // here actually fetches a URL, so fire onload as soon as it's
        // been assigned (next microtask) rather than never, which would
        // otherwise leave loadGisScript()'s promise hanging forever.
        Promise.resolve().then(() => fakeScript.onload?.());
        return fakeScript;
      },
      head: { appendChild: () => {} },
    };
    let capturedIdCallback: ((r: { credential?: string }) => void) | null = null;
    function installFakeGisId() {
      promptCallCount = 0;
      (globalThis as unknown as { google: unknown }).google = {
        accounts: {
          id: {
            initialize: (config: { callback: (r: { credential?: string }) => void }) => {
              capturedIdCallback = config.callback;
            },
            prompt: () => {
              promptCallCount++;
              // A real Google ID token is a signed 3-part JWT; this test
              // never verifies the signature (see googleAccountRecovery.ts's
              // own "ON JWT SIGNATURE VERIFICATION" comment for why that's
              // fine here) so a fake header+signature is fine - only the
              // payload's `sub` claim is ever read.
              const payload = nextSub === null ? {} : { sub: nextSub };
              const fakeJwt = `fakeheader.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.fakesig`;
              Promise.resolve().then(() => capturedIdCallback?.(nextSub === null ? {} : { credential: fakeJwt }));
            },
            cancel: () => {},
          },
        },
      };
    }
    function uninstallGis() {
      delete (globalThis as unknown as { google?: unknown }).google;
      __resetGoogleRecoveryForTests();
    }

    // Case 1: default (nothing linked)
    installFakeGisId();
    assertEqual('isGoogleRecoveryLinked() is false by default', isGoogleRecoveryLinked(), false);
    assertEqual('getLinkedGoogleClientId() is null by default', getLinkedGoogleClientId(), null);
    const verifyNoneLinked = await verifyGoogleAccountForRecovery();
    assertEqual('verifyGoogleAccountForRecovery() with nothing linked refuses immediately', verifyNoneLinked, { ok: false, reason: 'not-linked' });
    assertEqual('...and never even calls prompt()', promptCallCount, 0);

    // Case 2: link a mocked identity - stored value has only a hash
    nextSub = 'mock-sub-owner-account-111';
    const CLIENT_ID = '111-fake.apps.googleusercontent.com';
    const linkResult = await linkGoogleAccount(CLIENT_ID);
    assertEqual('linkGoogleAccount() with a valid mocked identity succeeds', linkResult, { ok: true });
    assertTrue('isGoogleRecoveryLinked() is now true', isGoogleRecoveryLinked());
    assertEqual('getLinkedGoogleClientId() returns the Client ID used to link', getLinkedGoogleClientId(), CLIENT_ID);
    assertTrue('getGoogleRecoveryLinkedAt() is a recent timestamp', Math.abs((getGoogleRecoveryLinkedAt() ?? 0) - Date.now()) < 5000);
    const rawGoogleRecord = memory.getItem('officeCashLedger.googleAccountRecovery.v1')!;
    assertTrue('The stored record contains no trace of the raw sub, email, or ID token', !rawGoogleRecord.includes('mock-sub-owner-account-111') && !rawGoogleRecord.includes('fakeheader'));
    assertTrue('The stored record DOES contain the Client ID (not a secret - see the file\'s own header comment) so LockScreen can reuse it without re-asking', rawGoogleRecord.includes(CLIENT_ID));

    // Case 3: correct/matching account
    const okReset = await verifyGoogleAccountForRecovery();
    assertEqual('verifyGoogleAccountForRecovery() with the SAME account succeeds', okReset, { ok: true });

    // Case 4: a different Google account signs in
    nextSub = 'someone-elses-sub-999';
    const wrongAccount = await verifyGoogleAccountForRecovery();
    assertEqual('verifyGoogleAccountForRecovery() with a DIFFERENT account is refused', wrongAccount, { ok: false, reason: 'no-match' });

    // Case 5: sign-in itself fails/cancelled (no credential returned)
    nextSub = null;
    const cancelled = await verifyGoogleAccountForRecovery();
    assertEqual('A cancelled/failed sign-in resolves the same shape as a wrong account (never reveals which account WAS linked)', cancelled, { ok: false, reason: 'sign-in-failed' });
    nextSub = 'mock-sub-owner-account-111';

    // Case 6: resetViaExternalVerification actually changes the PIN
    const resetOutcome = await resetViaExternalVerification('9876');
    assertTrue('resetViaExternalVerification() succeeds and issues a fresh recovery code', resetOutcome.ok && RECOVERY_CODE_RE.test((resetOutcome as { recoveryCode: string }).recoveryCode));
    const afterReset = await verify('9876');
    assertEqual('The new PIN set via Google verification actually works', afterReset.ok, true);
    assertEqual('The OLD PIN no longer works', (await verify(PIN)).ok, false);
    await verify('9876'); // leave unlocked state consistent for what follows

    // Case 7: the ORIGINAL recovery-code path is completely unaffected by
    // any of the above - still fully independently sufficient. Reuses the
    // recovery code resetViaExternalVerification() itself just issued
    // (setupLock() can't be called again here - a lock already exists;
    // that's changePin()'s job, not setup's - this still proves the
    // recovery-code path works standalone with Google also linked).
    const rcCode = (resetOutcome as { recoveryCode: string }).recoveryCode;
    const rcReset = await resetViaRecoveryCode(rcCode, '1357');
    assertTrue('Recovery-code path: still works completely unchanged whether or not Google is linked', rcReset.ok);
    await verify('1357');

    // Case 8: unlink
    assertTrue('unlinkGoogleAccount() succeeds', unlinkGoogleAccount());
    assertEqual('isGoogleRecoveryLinked() is false again after unlinking', isGoogleRecoveryLinked(), false);
    const afterUnlink = await verifyGoogleAccountForRecovery();
    assertEqual('verifyGoogleAccountForRecovery() after unlinking refuses immediately again', afterUnlink, { ok: false, reason: 'not-linked' });

    // Case 9 (re-link for the exclusion + independence checks below)
    await linkGoogleAccount(CLIENT_ID);

    // Case 9: sync/backup exclusion - same rigor as every prior local secret
    const backupWithGoogleLink = await exportBackup();
    const backupWithGoogleLinkJson = JSON.stringify(backupWithGoogleLink);
    assertTrue('exportBackup() output contains no trace of the linked account Client ID', !backupWithGoogleLinkJson.includes(CLIENT_ID));
    assertTrue('...nor any googleAccountRecovery-shaped field', !/googleaccountrecovery|googlerecovery/i.test(backupWithGoogleLinkJson));
    assertEqual('SYNC_TABLES contains no Google-recovery-related entry', SYNC_TABLES.some((t) => /google/i.test(t)), false);

    // Case 10: storage key independence from the other two local-secret stores
    const allKeys = Array.from(memory.store.keys());
    const relevantKeys = allKeys.filter((k) => /aiFallback|googleDriveBackup|googleAccountRecovery|appLock/i.test(k));
    assertTrue('The Google-recovery storage key is distinct from lib/appLock.ts\'s own key and from any AI/Drive-backup key (no collision)', new Set(relevantKeys).size === relevantKeys.length);

    // Case 11: graceful degradation - no browser environment at all
    uninstallGis();
    delete (globalThis as unknown as { window?: unknown }).window;
    delete (globalThis as unknown as { document?: unknown }).document;
    const noBrowser = await linkGoogleAccount(CLIENT_ID);
    assertEqual('linkGoogleAccount() with no window/document at all degrades gracefully', noBrowser, { ok: false, reason: 'unsupported' });
    // Restore the browser-like globals (but not `google` itself) to test
    // the OTHER failure mode: a script that "loads" but never actually
    // provides window.google (network blocked partway, CSP, etc.).
    (globalThis as unknown as { window: typeof globalThis }).window = globalThis;
    (globalThis as unknown as { document: unknown }).document = {
      createElement: () => {
        const fakeScript: { onload: (() => void) | null; onerror: (() => void) | null; src: string; async: boolean; defer: boolean } = { onload: null, onerror: null, src: '', async: false, defer: false };
        Promise.resolve().then(() => fakeScript.onload?.());
        return fakeScript;
      },
      head: { appendChild: () => {} },
    };
    __resetGoogleRecoveryForTests();
    const scriptLoadsButNoGis = await linkGoogleAccount(CLIENT_ID);
    assertEqual('linkGoogleAccount() when the script "loads" but window.google never appears degrades gracefully too (never hangs)', scriptLoadsButNoGis, { ok: false, reason: 'sign-in-failed' });
    installFakeGisId(); // restore a fully-working fake GIS for the checks below
    assertTrue('A real isLockConfigured() call succeeds immediately after a Google-recovery failure (proves normal App Lock usage is unaffected)', await isLockConfigured());
    assertTrue('A real verify() call with the current PIN also still succeeds right after', (await verify('1357')).ok);
    uninstallGis();

    await disableLock('1357');
    unlinkGoogleAccount();
    memory.clear();
  }

  // ===================================================================
  // Final: the data layer was never affected by any of the above
  // ===================================================================
  console.log('\nData integrity across the whole suite');
  assertTrue('The ledger data is identical to how it started (no lock operation ever touched it; only the restore step re-stamped ledgerDays.recalculatedAt)', (await dumpDbStable()) === dbBeforeStable);
  assertEqual('No lock state is left behind in localStorage after the last disable', memory.length, 0);

  console.log('\n--- End Phase 7 App Lock tests ---\n');
  console.log(`${passed} passed, ${failed} failed`);
  restoreClock();
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
