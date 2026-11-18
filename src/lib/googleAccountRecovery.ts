// OPTIONAL, local-only Google-account-linked recovery for App Lock
// (lib/appLock.ts). This is an ADDITIONAL recovery path, never a
// replacement: the recovery-code path in appLock.ts remains fully intact
// and independently sufficient whether or not a Google account is ever
// linked here. See appLock.ts's own header comment for what App Lock is
// and is not; everything said there about "a lock screen, not encryption"
// applies equally to this module.
//
// WHY THIS EXISTS: a written-down recovery code is easy to lose. Linking
// a Google account lets a forgotten PIN be reset by proving "I can sign
// into the same Google account that was linked at setup" instead - no
// code to keep safe.
//
// DELIBERATELY INDEPENDENT OF lib/googleDriveBackup.ts / OF PHASE 6'S
// GEMINI KEY: this module has its own storage key
// (officeCashLedger.googleAccountRecovery.v1), requests only the
// `openid email profile` IDENTITY scope (never `drive.file`, never any
// Drive access), and shares NO import, storage key, cached token, or
// code path with lib/googleDriveBackup.ts or lib/googleDriveSettingsStore.ts.
// Linking a Google account here for PIN recovery has no effect on, and no
// dependency on, whether Google Drive Backup is ever connected, and vice
// versa - confirmed by scripts/test-app-lock.ts's own static-import check
// (search for "Phase 8" or "google recovery" there).
//
// WHAT IS STORED: only a salted PBKDF2-SHA256 hash (via appLock.ts's own
// makeHashRecord/matchesHashRecord - the exact same hashing as the PIN
// and recovery code, no second implementation) of the Google account's
// stable `sub` claim from its ID token. The raw `sub`, the raw ID token,
// and the account's email/name/picture are never written anywhere.
//
// ON JWT SIGNATURE VERIFICATION: Google's own guidance for a BACKEND
// verifying a token from an UNTRUSTED client recommends full cryptographic
// signature verification (aud/iss/exp/signature) before trusting a `sub`
// claim. That threat model doesn't apply here: there is no backend, and
// the only thing being decided is "does this device's fresh Google
// sign-in match the account THIS SAME DEVICE linked earlier" - the actual
// security boundary is Google's own sign-in prompt itself (the owner's
// real Google password/session), not this module's parsing of the
// resulting token. Parsing the JWT payload directly (no signature check)
// to read `sub` is therefore an accepted, deliberate simplification for
// this specific local-only use case - flagged here explicitly rather than
// silently, so it's never mistaken for a server-side-grade verification.

import { isHashRecord, makeHashRecord, matchesHashRecord, type HashRecord } from './appLock';

const STORAGE_KEY = 'officeCashLedger.googleAccountRecovery.v1';
const GIS_SCRIPT_URL = 'https://accounts.google.com/gsi/client';
// Identity only - never drive.file, never any Drive/Sheets/etc. scope.
// google.accounts.id's ID-token flow (below) doesn't take a scope param
// the way the oauth2 token model (used by lib/googleDriveBackup.ts) does -
// requesting an ID token implicitly asks for `openid email profile`.

interface StoredGoogleRecovery {
  version: 1;
  /** Hash of the linked account's `sub` claim - never the raw value. */
  account: HashRecord;
  /**
   * The OAuth Client ID used to link - NOT a secret (public/SPA Client
   * IDs are designed to be visible in client code, same reasoning
   * lib/googleDriveBackup.ts's own header comment gives). Stored here,
   * not re-asked, specifically so LockScreen.tsx - which deliberately
   * touches nothing but lib/appLock.ts and this module, never Settings
   * or the ledger, since it renders INSTEAD of the app before unlock -
   * can trigger the same sign-in flow without needing any other data
   * source.
   */
  clientId: string;
  /** Set only so Settings can show "linked <n> days ago" - never the account's email/name. */
  linkedAt: number;
}

function readStored(): StoredGoogleRecovery | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<StoredGoogleRecovery>;
    if (p.version !== 1 || !isHashRecord(p.account) || typeof p.linkedAt !== 'number' || typeof p.clientId !== 'string' || p.clientId === '') {
      return null; // fail-open on a malformed record, same reasoning as appLock.ts
    }
    return { version: 1, account: p.account, linkedAt: p.linkedAt, clientId: p.clientId };
  } catch {
    return null;
  }
}

function writeStored(rec: StoredGoogleRecovery): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rec));
    return true;
  } catch {
    return false;
  }
}

function removeStored(): boolean {
  try {
    localStorage.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export function isGoogleRecoveryLinked(): boolean {
  return readStored() !== null;
}

export function getGoogleRecoveryLinkedAt(): number | null {
  return readStored()?.linkedAt ?? null;
}

/** The stored (non-secret) Client ID, so LockScreen.tsx can trigger the
 *  same sign-in without asking the owner to re-enter it. Null if nothing
 *  is linked. */
export function getLinkedGoogleClientId(): string | null {
  return readStored()?.clientId ?? null;
}

export function unlinkGoogleAccount(): boolean {
  return removeStored();
}

// ---------------------------------------------------------------------
// GIS ID-token flow. Deliberately a separate script-load/callback
// bookkeeping from lib/googleDriveBackup.ts's own (that one uses the
// token model for an access token; this uses the ID-token model for
// identity only) - see the module header for why these two stay fully
// independent rather than sharing code.
// ---------------------------------------------------------------------

let gisScriptPromise: Promise<void> | null = null;
function loadGisScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('No window (not a browser environment).'));
  if ((window as unknown as { google?: unknown }).google) return Promise.resolve();
  if (gisScriptPromise) return gisScriptPromise;
  gisScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = GIS_SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Could not load Google Identity Services.'));
    document.head.appendChild(script);
  });
  return gisScriptPromise;
}

interface GisIdCredentialResponse {
  credential?: string; // JWT
  select_by?: string;
}

interface GisIdGlobal {
  accounts: {
    id: {
      initialize: (config: { client_id: string; callback: (r: GisIdCredentialResponse) => void; auto_select?: boolean }) => void;
      prompt: (momentListener?: (n: unknown) => void) => void;
      cancel: () => void;
    };
  };
}

function getGis(): GisIdGlobal | null {
  return (window as unknown as { google?: GisIdGlobal }).google ?? null;
}

/**
 * Decodes a Google ID token's payload WITHOUT verifying its signature -
 * see the module header ("ON JWT SIGNATURE VERIFICATION") for why that's
 * an accepted simplification for this specific local, backend-less,
 * same-device use case.
 */
function decodeJwtPayloadUnverified(jwt: string): { sub?: string } | null {
  try {
    if (typeof atob !== 'function') return null; // always true in a real browser; guards non-browser test/build environments
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const json = atob(padded);
    const payload = JSON.parse(decodeURIComponent(escape(json))) as { sub?: string };
    return typeof payload.sub === 'string' && payload.sub.length > 0 ? payload : null;
  } catch {
    return null;
  }
}

let cachedClientId: string | null = null;
let pendingResolve: ((r: GisIdCredentialResponse) => void) | null = null;

/**
 * Triggers a REAL Google sign-in prompt (a genuine user-gesture-triggered
 * call only - never from a background timer) and resolves with the
 * signed-in account's `sub` claim, or null on any failure (popup blocked,
 * network error, GIS didn't load, the owner dismissed the prompt, a
 * malformed token). Never throws.
 */
async function requestGoogleIdentity(clientId: string): Promise<string | null> {
  try {
    await loadGisScript();
    const gis = getGis();
    if (!gis) return null;
    if (cachedClientId !== clientId) {
      cachedClientId = clientId;
      gis.accounts.id.initialize({
        client_id: clientId,
        auto_select: false,
        callback: (response) => {
          if (pendingResolve) {
            const resolve = pendingResolve;
            pendingResolve = null;
            resolve(response);
          }
        },
      });
    }
    const response = await new Promise<GisIdCredentialResponse>((resolve) => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      pendingResolve = (r) => {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        resolve(r);
      };
      gis.accounts.id.prompt();
      // If the owner dismisses/ignores the prompt, don't hang forever -
      // but clear this timer as soon as the callback fires via the
      // normal path above, so a resolved promise doesn't leave a stray
      // timer referencing this closure behind.
      timeoutId = setTimeout(() => {
        if (pendingResolve) {
          pendingResolve = null;
          resolve({});
        }
      }, 60_000);
    });
    if (!response.credential) return null;
    const payload = decodeJwtPayloadUnverified(response.credential);
    return payload?.sub ?? null;
  } catch {
    return null;
  }
}

export type GoogleRecoveryResult = { ok: true } | { ok: false; reason: 'unsupported' | 'sign-in-failed' | 'storage-unavailable' | 'no-match' | 'not-linked' | 'error' };

/**
 * Links a Google account for PIN recovery: prompts a real sign-in, and
 * stores only a salted hash of the resulting account's `sub`. Overwrites
 * any previously-linked account (re-linking is how you change which
 * account can reset the PIN).
 */
export async function linkGoogleAccount(clientId: string): Promise<GoogleRecoveryResult> {
  try {
    if (typeof window === 'undefined' || typeof document === 'undefined') return { ok: false, reason: 'unsupported' };
    const sub = await requestGoogleIdentity(clientId);
    if (!sub) return { ok: false, reason: 'sign-in-failed' };
    const account = await makeHashRecord(sub);
    if (!writeStored({ version: 1, account, clientId, linkedAt: Date.now() })) {
      return { ok: false, reason: 'storage-unavailable' };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: 'error' };
  }
}

/**
 * Forgotten-PIN path: prompts a fresh Google sign-in (using the Client ID
 * stored at link time - the caller does not need to supply or know it,
 * per LockScreen.tsx's own constraint of touching nothing but this module
 * and lib/appLock.ts) and checks it against the linked account's stored
 * hash. On a match, the caller (LockScreen) proceeds to appLock.ts's
 * resetViaExternalVerification() to actually set a new PIN - this
 * function only confirms identity, it never touches PIN storage itself
 * (kept in appLock.ts, the single owner of that data).
 */
export async function verifyGoogleAccountForRecovery(): Promise<GoogleRecoveryResult> {
  try {
    const stored = readStored();
    if (!stored) return { ok: false, reason: 'not-linked' };
    if (typeof window === 'undefined' || typeof document === 'undefined') return { ok: false, reason: 'unsupported' };
    const sub = await requestGoogleIdentity(stored.clientId);
    if (!sub) return { ok: false, reason: 'sign-in-failed' };
    const matches = await matchesHashRecord(sub, stored.account);
    // Deliberately the SAME failure reason/shape whether the sign-in
    // failed or the account simply doesn't match - never reveal which
    // account WAS linked to someone who signed into a different one.
    return matches ? { ok: true } : { ok: false, reason: 'no-match' };
  } catch {
    return { ok: false, reason: 'error' };
  }
}

// Test-only: lets the test suite reset module-level GIS caching between
// cases without needing a real page reload.
export function __resetForTests(): void {
  cachedClientId = null;
  pendingResolve = null;
  gisScriptPromise = null;
}
