// Phase 7: OPTIONAL, local-only app-level PIN/password lock.
//
// WHAT THIS IS - AND IS NOT (read this before trusting it with anything):
// This is a client-side lock SCREEN. It keeps someone who casually picks up
// the device (or sits down at an unattended screen) from opening the app.
// It is NOT encryption: the ledger data in IndexedDB is stored exactly as
// it always was, in the clear. Anyone technical enough to open browser
// DevTools can read that data directly, or delete this one localStorage
// key and remove the lock entirely, without ever knowing the PIN. There is
// no backend in this app, so there is nothing else it could be.
//
// STORAGE ISOLATION (same pattern, and same reasoning, as
// lib/aiSettingsStore.ts from Phase 6):
// Everything here lives in plain browser `localStorage`, NOT in a Dexie
// table. lib/sync.ts (SYNC_TABLES) and lib/backup.ts (exportBackup()) work
// by iterating Dexie tables and neither file references `localStorage` or
// this module anywhere, so there is no code path by which the lock's
// salt/hash/recovery hash could reach Firestore or a backup file - not
// even through a future accidental omission from an allowlist. A lock set
// on one device therefore never appears on, or exports into, another.
//
// THIS MODULE NEVER TOUCHES THE DATA LAYER. It deliberately imports
// nothing from db/schema, ledger, backup, or sync (scripts/test-app-lock.ts
// verifies this statically). A wrong or forgotten PIN can only ever keep
// the UI closed; there is no code here that could read, write, corrupt,
// or delete a transaction.
//
// WHAT IS STORED: only { salt, hash, iterations } for the PIN and for the
// recovery code (PBKDF2-HMAC-SHA256 via Web Crypto), plus the idle-timeout
// setting and the failed-attempt counters. The raw PIN and raw recovery
// code are never written anywhere.
//
// ITERATION COUNT: 600,000, the OWASP Password Storage Cheat Sheet's
// current minimum for PBKDF2-HMAC-SHA256 (it was 310,000 in the 2021-2022
// editions; re-verified against the live cheat sheet when this phase was
// built). OWASP prefers Argon2id where available, but Web Crypto only
// offers PBKDF2, and adding a WASM Argon2 dependency to a single-user
// local lock screen would be over-engineering. The count is stored WITH
// each hash, so it can be raised later without invalidating existing
// locks. Unlocking costs one derivation (roughly a fraction of a second
// on a modern device, longer on a very old phone) - a one-off cost per
// unlock, not per keystroke.
//
// SESSION STATE (locked vs unlocked) is IN MEMORY ONLY - deliberately not
// persisted. Reloading the page always re-locks the app. Failed-attempt
// counters ARE persisted, so reloading the page does not reset the
// wrong-PIN delay.
//
// FAIL-OPEN ON A CORRUPT RECORD: if the stored lock record is unreadable
// or malformed (only possible via manual tampering; it is written
// atomically as one JSON string), it is treated as "no lock configured".
// The alternative - failing closed - would mean a damaged record locks the
// owner out of their own books permanently with no recovery path, which is
// a worse failure for this feature's purpose than a lock that silently
// isn't there.
//
// LAST RESORT if the PIN AND the recovery code are both lost: there is no
// server and no email to reset from. Clearing this site's data in the
// browser (or using a fresh browser profile) removes the lock, and the
// ledger can then be restored from a backup file (or re-pulled via Cloud
// Sync if that was set up). Anything entered since the last backup that
// Cloud Sync doesn't hold is lost in that case - which is why the setup UI
// says all of this plainly up front.

const STORAGE_KEY = 'officeCashLedger.appLock.v1';

/** Exposed so the `storage`-event listener in the UI layer can react to another tab changing the lock. */
export const APP_LOCK_STORAGE_KEY = STORAGE_KEY;

export const DEFAULT_IDLE_MINUTES = 15;
/** The presets Settings offers. The lib itself accepts any positive value (tests use tiny ones). */
export const IDLE_MINUTES_OPTIONS = [1, 5, 15, 30, 60] as const;
export const MIN_PIN_LENGTH = 4;
export const MAX_PIN_LENGTH = 128;

/** OWASP Password Storage Cheat Sheet minimum for PBKDF2-HMAC-SHA256. */
export const PBKDF2_ITERATIONS = 600_000;

// Wrong-attempt rate limit: the first FREE_FAILED_ATTEMPTS wrong tries in a
// row cost nothing (genuine typos shouldn't be punished). From the next
// failure on, the owner must wait BASE_DELAY_MS, doubling on each further
// failure up to MAX_DELAY_MS. A correct entry resets the counter. Persisted,
// so a page reload doesn't reset it.
export const FREE_FAILED_ATTEMPTS = 4;
const BASE_DELAY_MS = 5_000;
const MAX_DELAY_MS = 60_000;

/** Delay imposed after the Nth consecutive failure (0 = none yet). Exported for tests. */
export function delayMsForFailures(failedAttempts: number): number {
  if (failedAttempts <= FREE_FAILED_ATTEMPTS) return 0;
  const exponent = failedAttempts - FREE_FAILED_ATTEMPTS - 1;
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** exponent);
}

// ---------------------------------------------------------------------------
// Stored shape
// ---------------------------------------------------------------------------

/** Exported so a sibling module (Google-linked recovery) can hash a stable
 *  account identifier the exact same way a PIN is hashed, without a second
 *  hashing implementation. See googleAccountRecovery.ts. */
export interface HashRecord {
  algo: 'PBKDF2-SHA256';
  iterations: number;
  /** hex */
  salt: string;
  /** hex */
  hash: string;
}

interface StoredAppLock {
  version: 1;
  pin: HashRecord;
  recovery: HashRecord;
  idleMinutes: number;
  failedAttempts: number;
  /** epoch ms; 0 when no delay is active */
  lockedUntil: number;
}

const HEX_RE = /^[0-9a-f]+$/;

/** Exported for reuse by googleAccountRecovery.ts's own stored-record validation. */
export function isHashRecord(v: unknown): v is HashRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    r.algo === 'PBKDF2-SHA256' &&
    typeof r.iterations === 'number' &&
    Number.isInteger(r.iterations) &&
    r.iterations >= 1 &&
    r.iterations <= 10_000_000 &&
    typeof r.salt === 'string' &&
    r.salt.length >= 16 &&
    HEX_RE.test(r.salt) &&
    typeof r.hash === 'string' &&
    r.hash.length >= 32 &&
    HEX_RE.test(r.hash)
  );
}

function readStored(): StoredAppLock | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<StoredAppLock>;
    if (
      p.version !== 1 ||
      !isHashRecord(p.pin) ||
      !isHashRecord(p.recovery) ||
      typeof p.idleMinutes !== 'number' ||
      !Number.isFinite(p.idleMinutes) ||
      p.idleMinutes <= 0
    ) {
      return null; // fail-open on a malformed record - see header comment
    }
    return {
      version: 1,
      pin: p.pin,
      recovery: p.recovery,
      idleMinutes: p.idleMinutes,
      failedAttempts: typeof p.failedAttempts === 'number' && p.failedAttempts > 0 ? Math.floor(p.failedAttempts) : 0,
      lockedUntil: typeof p.lockedUntil === 'number' && p.lockedUntil > 0 ? p.lockedUntil : 0,
    };
  } catch {
    return null;
  }
}

// Cached idle timeout in ms, so the high-frequency activity listener never
// has to re-read/parse localStorage. undefined = not loaded yet; null = no
// lock configured. Invalidated on every write/removal here and on
// notifyAppLockStorageChanged() (another tab wrote the key).
let idleMsCache: number | null | undefined;

function invalidateCache(): void {
  idleMsCache = undefined;
}

function getIdleMs(): number | null {
  if (idleMsCache === undefined) {
    const s = readStored();
    idleMsCache = s ? s.idleMinutes * 60_000 : null;
  }
  return idleMsCache;
}

function writeStored(rec: StoredAppLock): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rec));
    invalidateCache();
    return true;
  } catch {
    invalidateCache();
    return false;
  }
}

function removeStored(): boolean {
  try {
    localStorage.removeItem(STORAGE_KEY);
    invalidateCache();
    return true;
  } catch {
    invalidateCache();
    return false;
  }
}

// ---------------------------------------------------------------------------
// Web Crypto helpers
// ---------------------------------------------------------------------------

function subtle(): SubtleCrypto | null {
  try {
    const c = globalThis.crypto;
    return c && c.subtle ? c.subtle : null;
  } catch {
    return null;
  }
}

/**
 * Web Crypto's SubtleCrypto only exists in secure contexts (https:// or
 * localhost). Opened over plain http:// from another machine's IP, it is
 * undefined - the Settings UI uses this to say so plainly instead of
 * failing mysteriously.
 */
export function isAppLockSupported(): boolean {
  try {
    return !!subtle() && typeof globalThis.crypto.getRandomValues === 'function' && typeof TextEncoder !== 'undefined';
  } catch {
    return false;
  }
}

// Test-only: production always uses PBKDF2_ITERATIONS. Lets the test suite
// run its many hash operations quickly while still exercising the real
// 600,000-iteration path in dedicated tests.
let iterationsOverride: number | null = null;
export function __setPbkdf2IterationsForTests(n: number | null): void {
  iterationsOverride = n;
}
function currentIterations(): number {
  return iterationsOverride ?? PBKDF2_ITERATIONS;
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function derive(secret: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const s = subtle();
  if (!s) throw new Error('Web Crypto unavailable');
  // NFC-normalize so the same Nepali/Devanagari (or accented) password
  // typed via different input methods derives the same key. Deliberately
  // NOT trimmed: a space can be a deliberate part of a password.
  const keyMaterial = await s.importKey('raw', new TextEncoder().encode(secret.normalize('NFC')), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await s.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, keyMaterial, 256);
  return new Uint8Array(bits);
}

async function makeHashRecord(secret: string): Promise<HashRecord> {
  const salt = new Uint8Array(16);
  globalThis.crypto.getRandomValues(salt);
  const iterations = currentIterations();
  const hash = await derive(secret, salt, iterations);
  return { algo: 'PBKDF2-SHA256', iterations, salt: toHex(salt), hash: toHex(hash) };
}

/** Exported for reuse by googleAccountRecovery.ts (same hashing, own storage). */
export { makeHashRecord };

async function matchesHashRecord(secret: string, rec: HashRecord): Promise<boolean> {
  const derived = await derive(secret, fromHex(rec.salt), rec.iterations);
  return constantTimeEqual(derived, fromHex(rec.hash));
}

/** Exported for reuse by googleAccountRecovery.ts (same hashing, own storage). */
export { matchesHashRecord };

// 32 symbols, no I/O/0/1 (easy to misread when copied off paper). Exactly
// 32 so `byte & 31` maps uniformly - no modulo bias. 20 symbols = 100 bits.
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Random 20-symbol code formatted XXXX-XXXX-XXXX-XXXX-XXXX. Exported for tests. */
export function generateRecoveryCode(): string {
  const bytes = new Uint8Array(20);
  globalThis.crypto.getRandomValues(bytes);
  let chars = '';
  for (const b of bytes) chars += RECOVERY_ALPHABET[b & 31];
  return chars.match(/.{4}/g)!.join('-');
}

/** Case/spacing/hyphen-insensitive, so "abcd efgh..." typed from paper still matches. */
export function normalizeRecoveryCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type AppLockFailureReason =
  | 'unsupported'
  | 'not-configured'
  | 'already-configured'
  | 'invalid-new-pin'
  | 'wrong-pin'
  | 'wrong-recovery-code'
  | 'rate-limited'
  | 'storage-unavailable'
  | 'error';

export interface AppLockFailure {
  ok: false;
  reason: AppLockFailureReason;
  /** Set when the caller must wait (rate-limited, or a wrong entry that just triggered a delay). */
  retryAfterMs?: number;
  /** Set on a wrong entry: how many more wrong tries are free before a delay starts. */
  attemptsBeforeDelay?: number;
}

export type AppLockResult<T extends object = object> = ({ ok: true } & T) | AppLockFailure;

/** null when acceptable, otherwise why not. */
export function validateNewPin(pin: string): 'too-short' | 'too-long' | null {
  const length = [...pin.normalize('NFC')].length;
  if (length < MIN_PIN_LENGTH) return 'too-short';
  if (length > MAX_PIN_LENGTH) return 'too-long';
  return null;
}

// ---------------------------------------------------------------------------
// Serialization: one lock operation at a time. Without this, two parallel
// wrong attempts could both pass the rate-limit check before either has
// recorded its failure (e.g. a double-Enter).
// ---------------------------------------------------------------------------

let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

// ---------------------------------------------------------------------------
// Session state (in memory only)
// ---------------------------------------------------------------------------

export type AppLockState = 'unconfigured' | 'locked' | 'unlocked';

let sessionUnlocked = false;
let lastActivityAt = Date.now();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of [...listeners]) {
    try {
      l();
    } catch {
      // a misbehaving subscriber must never break lock state changes
    }
  }
}

export function isLockConfigured(): boolean {
  return readStored() !== null;
}

/**
 * The single source of truth for the UI gate. 'unconfigured' => the app
 * renders exactly as it did before this feature existed.
 */
export function getAppLockState(): AppLockState {
  if (!isLockConfigured()) {
    sessionUnlocked = false; // a lock removed elsewhere must not leave a stale "unlocked" behind
    return 'unconfigured';
  }
  return sessionUnlocked ? 'unlocked' : 'locked';
}

export function subscribeAppLock(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Call when another tab may have changed the stored lock (a `storage` event on our key). */
export function notifyAppLockStorageChanged(): void {
  invalidateCache();
  emit();
}

function markUnlocked(): void {
  sessionUnlocked = true;
  lastActivityAt = Date.now();
  emit();
}

/** Lock the app right now (the "Lock now" button). No-op when no lock is configured. */
export function lockNow(): void {
  if (!isLockConfigured()) return;
  sessionUnlocked = false;
  emit();
}

/**
 * Re-locks if the idle limit has elapsed since the last recorded activity.
 * Returns true when it locked. Timestamp-based on purpose: browsers
 * throttle or freeze timers in background tabs and during device sleep,
 * so "a setTimeout will fire after N minutes" is not reliable - comparing
 * timestamps whenever we get to run (timer tick, tab becoming visible,
 * page restored, next input event) is.
 */
export function checkIdleAndLock(now: number = Date.now()): boolean {
  if (!sessionUnlocked) return false;
  const idleMs = getIdleMs();
  if (idleMs === null) return false;
  if (now < lastActivityAt) {
    lastActivityAt = now; // clock moved backwards; don't wait for it to catch up
    return false;
  }
  if (now - lastActivityAt >= idleMs) {
    sessionUnlocked = false;
    emit();
    return true;
  }
  return false;
}

/**
 * Record user activity. IMPORTANT: checks for an already-expired idle
 * window FIRST. Otherwise, waking a sleeping laptop and nudging the mouse
 * would refresh the timestamp before any timer tick got to notice the
 * elapsed hour, defeating the lock.
 */
export function noteActivity(now: number = Date.now()): void {
  if (!sessionUnlocked) return;
  if (checkIdleAndLock(now)) return;
  lastActivityAt = now;
}

export function getIdleMinutes(): number {
  return readStored()?.idleMinutes ?? DEFAULT_IDLE_MINUTES;
}

/** Changes the auto-lock period (minutes, > 0, <= 24h). Returns false if not configured or storage failed. */
export function setIdleMinutes(minutes: number): boolean {
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 24 * 60) return false;
  const s = readStored();
  if (!s) return false;
  return writeStored({ ...s, idleMinutes: minutes });
}

/** Milliseconds until the wrong-PIN delay ends (0 if none) - lets the lock screen resume its countdown after a reload. */
export function getRetryAfterMs(now: number = Date.now()): number {
  const s = readStored();
  return s && s.lockedUntil > now ? s.lockedUntil - now : 0;
}

// ---------------------------------------------------------------------------
// Idle watcher (wiring). Takes its event targets as parameters so this
// module stays DOM-free (and testable in plain Node): the app passes
// `window` / `document`.
// ---------------------------------------------------------------------------

export interface IdleWatcherOptions {
  /** Where input events are observed (`window`). */
  activityTarget: EventTarget;
  /** Where `visibilitychange` fires (`document`). */
  visibilityTarget: EventTarget;
  isHidden: () => boolean;
  /** How often to compare timestamps as a backstop. Default 10s. */
  checkIntervalMs?: number;
}

const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll'] as const;

/**
 * Starts listening for genuine user activity and re-locks after the
 * configured idle period. Returns a stop function. The browser's own Idle
 * Detection API is deliberately not used: it is Chromium-only and needs a
 * permission prompt (Firefox and Safari don't support it), so plain input
 * events + the Page Visibility API + a timestamp comparison is the
 * portable approach.
 */
export function startIdleWatcher(opts: IdleWatcherOptions): () => void {
  const onActivity = () => noteActivity();
  // Coming back to the tab / restoring from the back-forward cache is NOT
  // activity: only check whether the limit already lapsed while away.
  const onResume = () => {
    if (!opts.isHidden()) checkIdleAndLock();
  };
  const listenerOpts = { passive: true, capture: true } as const;
  for (const ev of ACTIVITY_EVENTS) opts.activityTarget.addEventListener(ev, onActivity, listenerOpts);
  opts.visibilityTarget.addEventListener('visibilitychange', onResume);
  opts.activityTarget.addEventListener('pageshow', onResume);
  const timer = setInterval(() => {
    checkIdleAndLock();
  }, opts.checkIntervalMs ?? 10_000);
  return () => {
    for (const ev of ACTIVITY_EVENTS) opts.activityTarget.removeEventListener(ev, onActivity, listenerOpts);
    opts.visibilityTarget.removeEventListener('visibilitychange', onResume);
    opts.activityTarget.removeEventListener('pageshow', onResume);
    clearInterval(timer);
  };
}

// ---------------------------------------------------------------------------
// Attempt checking with rate-limit (shared by verify / change / disable / recovery)
// ---------------------------------------------------------------------------

type CheckOutcome = { ok: true; stored: StoredAppLock } | { ok: false; failure: AppLockFailure };

async function checkSecret(kind: 'pin' | 'recovery', attempt: string): Promise<CheckOutcome> {
  const stored = readStored();
  if (!stored) return { ok: false, failure: { ok: false, reason: 'not-configured' } };

  const now = Date.now();
  if (stored.lockedUntil > now) {
    // Still inside a delay: refuse without even hashing, and don't count it as another failure.
    return { ok: false, failure: { ok: false, reason: 'rate-limited', retryAfterMs: stored.lockedUntil - now } };
  }

  // An empty attempt is simply wrong (and PBKDF2 refuses a zero-length key
  // in some browsers, which would otherwise surface as a confusing 'error').
  const matches = attempt.length > 0 && (await matchesHashRecord(attempt, kind === 'pin' ? stored.pin : stored.recovery));
  if (matches) {
    if (stored.failedAttempts > 0 || stored.lockedUntil > 0) {
      const reset = { ...stored, failedAttempts: 0, lockedUntil: 0 };
      writeStored(reset); // best-effort: a failed counter reset must not turn a correct entry into a failure
      return { ok: true, stored: reset };
    }
    return { ok: true, stored };
  }

  const failedAttempts = stored.failedAttempts + 1;
  const delay = delayMsForFailures(failedAttempts);
  const failedAt = Date.now();
  writeStored({ ...stored, failedAttempts, lockedUntil: delay > 0 ? failedAt + delay : 0 });
  return {
    ok: false,
    failure: {
      ok: false,
      reason: kind === 'pin' ? 'wrong-pin' : 'wrong-recovery-code',
      ...(delay > 0 ? { retryAfterMs: delay } : {}),
      attemptsBeforeDelay: Math.max(0, FREE_FAILED_ATTEMPTS - failedAttempts),
    },
  };
}

function unexpected(): AppLockFailure {
  return { ok: false, reason: 'error' };
}

// ---------------------------------------------------------------------------
// Public operations. None of these ever throws; every failure is a value.
// ---------------------------------------------------------------------------

/**
 * Turns the lock ON. Returns the one-time recovery code - the caller MUST
 * show it to the owner exactly once; only its salted hash is stored, so it
 * can never be shown again. The current session is left unlocked (the
 * owner just set the PIN).
 */
export function setupLock(
  pin: string,
  options: { idleMinutes?: number } = {},
): Promise<AppLockResult<{ recoveryCode: string }>> {
  return serialized(async () => {
    try {
      if (!isAppLockSupported()) return { ok: false, reason: 'unsupported' } as const;
      if (validateNewPin(pin)) return { ok: false, reason: 'invalid-new-pin' } as const;
      if (isLockConfigured()) return { ok: false, reason: 'already-configured' } as const;
      const idleMinutes =
        options.idleMinutes !== undefined && Number.isFinite(options.idleMinutes) && options.idleMinutes > 0
          ? options.idleMinutes
          : DEFAULT_IDLE_MINUTES;
      const recoveryCode = generateRecoveryCode();
      const [pinRecord, recoveryRecord] = await Promise.all([
        makeHashRecord(pin),
        makeHashRecord(normalizeRecoveryCode(recoveryCode)),
      ]);
      const wrote = writeStored({
        version: 1,
        pin: pinRecord,
        recovery: recoveryRecord,
        idleMinutes,
        failedAttempts: 0,
        lockedUntil: 0,
      });
      // Read back: never tell the owner they're protected (and hand them a
      // recovery code) unless the lock verifiably persisted.
      if (!wrote || !isLockConfigured()) {
        removeStored();
        return { ok: false, reason: 'storage-unavailable' } as const;
      }
      markUnlocked();
      return { ok: true, recoveryCode } as const;
    } catch {
      return unexpected();
    }
  });
}

/**
 * Checks an unlock attempt against the stored PIN/password. On success this
 * unlocks the current session. Rate-limited after repeated failures.
 */
export function verify(attempt: string): Promise<AppLockResult> {
  return serialized(async () => {
    try {
      if (!isAppLockSupported()) return { ok: false, reason: 'unsupported' } as const;
      const outcome = await checkSecret('pin', attempt);
      if (!outcome.ok) {
        if (outcome.failure.reason === 'not-configured') emit(); // lock vanished (other tab): let the gate re-evaluate
        return outcome.failure;
      }
      markUnlocked();
      return { ok: true } as const;
    } catch {
      return unexpected();
    }
  });
}

/** Turns the lock OFF. Requires the current PIN - a stranger at an unlocked screen can't silently remove it. */
export function disableLock(currentPin: string): Promise<AppLockResult> {
  return serialized(async () => {
    try {
      if (!isAppLockSupported()) return { ok: false, reason: 'unsupported' } as const;
      const outcome = await checkSecret('pin', currentPin);
      if (!outcome.ok) return outcome.failure;
      if (!removeStored()) return { ok: false, reason: 'storage-unavailable' } as const;
      sessionUnlocked = false;
      emit();
      return { ok: true } as const;
    } catch {
      return unexpected();
    }
  });
}

/** Changes the PIN/password (requires the current one). The recovery code is unchanged. */
export function changePin(currentPin: string, newPin: string): Promise<AppLockResult> {
  return serialized(async () => {
    try {
      if (!isAppLockSupported()) return { ok: false, reason: 'unsupported' } as const;
      // Validate the new PIN first so a too-short entry doesn't burn a rate-limit attempt.
      if (validateNewPin(newPin)) return { ok: false, reason: 'invalid-new-pin' } as const;
      const outcome = await checkSecret('pin', currentPin);
      if (!outcome.ok) return outcome.failure;
      const pin = await makeHashRecord(newPin);
      if (!writeStored({ ...outcome.stored, pin, failedAttempts: 0, lockedUntil: 0 })) {
        return { ok: false, reason: 'storage-unavailable' } as const;
      }
      return { ok: true } as const;
    } catch {
      return unexpected();
    }
  });
}

/**
 * Forgotten-PIN path: the correct recovery code lets the owner set a new
 * PIN. The recovery code is SINGLE-USE - it has just been typed on screen,
 * so a fresh one is generated and returned (show it once, same as at
 * setup); the old one stops working. This does NOT unlock the session:
 * the caller finishes by calling verify(newPin), so the only way to
 * unlock is ever a successful verify() (or setupLock() from an already-
 * unlocked app).
 */
export function resetViaRecoveryCode(
  recoveryCodeAttempt: string,
  newPin: string,
): Promise<AppLockResult<{ recoveryCode: string }>> {
  return serialized(async () => {
    try {
      if (!isAppLockSupported()) return { ok: false, reason: 'unsupported' } as const;
      if (validateNewPin(newPin)) return { ok: false, reason: 'invalid-new-pin' } as const;
      const outcome = await checkSecret('recovery', normalizeRecoveryCode(recoveryCodeAttempt));
      if (!outcome.ok) return outcome.failure;
      const recoveryCode = generateRecoveryCode();
      const [pin, recovery] = await Promise.all([makeHashRecord(newPin), makeHashRecord(normalizeRecoveryCode(recoveryCode))]);
      if (!writeStored({ ...outcome.stored, pin, recovery, failedAttempts: 0, lockedUntil: 0 })) {
        return { ok: false, reason: 'storage-unavailable' } as const;
      }
      return { ok: true, recoveryCode } as const;
    } catch {
      return unexpected();
    }
  });
}

/**
 * Forgotten-PIN path, ALTERNATIVE to resetViaRecoveryCode(): lets the owner
 * set a new PIN after their identity has already been confirmed through
 * some OTHER trusted means outside this module (currently: a fresh Google
 * Sign-In matching the account linked at setup time - see
 * googleAccountRecovery.ts's verifyGoogleAccountForRecovery()). This
 * function does NOT perform that verification itself and does NOT accept
 * a recovery code or PIN to check - the caller is trusted to have already
 * confirmed identity before calling this. It exists so a second, more
 * convenient recovery path can be offered without ever weakening or
 * bypassing the existing recovery-code path, which remains fully separate
 * and independently sufficient on its own (see resetViaRecoveryCode
 * above). Like resetViaRecoveryCode, a fresh recovery code is issued (the
 * old one - now stale relative to a new PIN - is still valid for a wholly
 * separate future reset, so this rotates it here too for consistency) and
 * this does NOT unlock the session itself; the caller finishes with
 * verify(newPin).
 */
export function resetViaExternalVerification(newPin: string): Promise<AppLockResult<{ recoveryCode: string }>> {
  return serialized(async () => {
    try {
      if (!isAppLockSupported()) return { ok: false, reason: 'unsupported' } as const;
      if (validateNewPin(newPin)) return { ok: false, reason: 'invalid-new-pin' } as const;
      const stored = readStored();
      if (!stored) return { ok: false, reason: 'not-configured' } as const;
      const recoveryCode = generateRecoveryCode();
      const [pin, recovery] = await Promise.all([makeHashRecord(newPin), makeHashRecord(normalizeRecoveryCode(recoveryCode))]);
      if (!writeStored({ ...stored, pin, recovery, failedAttempts: 0, lockedUntil: 0 })) {
        return { ok: false, reason: 'storage-unavailable' } as const;
      }
      return { ok: true, recoveryCode } as const;
    } catch {
      return unexpected();
    }
  });
}

// Test-only: clears in-memory session state so a test can simulate a fresh
// page load (which is exactly what a reload does - session state is never
// persisted). Does not touch storage.
export function __resetSessionForTests(): void {
  sessionUnlocked = false;
  lastActivityAt = Date.now();
  invalidateCache();
  listeners.clear();
}
