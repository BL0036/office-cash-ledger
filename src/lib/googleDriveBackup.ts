// OPTIONAL Google Drive backup: a second, independent, opt-in backup
// destination for the SAME JSON exportBackup() already produces — never a
// second backup format, never a parallel restore implementation. Follows
// the exact "bring your own credentials, opt-in, local-only secrets,
// graceful degradation" discipline lib/aiFallback.ts (Phase 6) already
// established for the Gemini fallback, applied here to Google Drive.
// Read that file's own header comment first if you haven't — this module
// deliberately mirrors its shape.
//
// ============================================================
// RESEARCH THIS WAS BASED ON (live web search, verified 2026-09-20 —
// see CHANGELOG for the full write-up; update this note, not just the
// code, the next time any of this needs re-verifying, for the same
// reason lib/aiFallback.ts's own "MODEL CURRENCY" note exists)
// ============================================================
// - OAuth flow: Google Identity Services (GIS) for Web — the CURRENT,
//   non-deprecated library (`https://accounts.google.com/gsi/client`),
//   NOT the old `gapi.auth2`/"Google Sign-In" library, which no longer
//   automatically loads and is not used anywhere in this file. For a
//   public/SPA client with no backend (this app), the correct flow is
//   the "token model": `google.accounts.oauth2.initTokenClient({
//   client_id, scope, callback })` returns a client whose
//   `.requestAccessToken(overrideConfig?)` triggers Google's own
//   popup-based consent UX and returns an access token to the fixed
//   `callback`. The alternative "code model" requires a BACKEND to
//   exchange the code for tokens — not applicable here, this app has
//   none.
// - NO silent/automatic token refresh exists for this flow. Google's own
//   docs state plainly: "Automatic refresh of expired access tokens has
//   been removed... After an access token expires your app must handle
//   Google API error responses, request, and obtain a new, valid access
//   token." There is no refresh token available to a pure client-side
//   app this way (refresh tokens only ever go to a backend via the code
//   model). Consequence for this app's design: the cached access token
//   (see lib/googleDriveSettingsStore.ts) is short-lived (~1 hour); a
//   background/auto-backup attempt NEVER calls requestAccessToken()
//   itself (that would mean an unprompted popup appearing during a
//   background timer, or silently failing in browsers that block it) —
//   it only proceeds if a still-valid cached token already exists, and
//   degrades gracefully (skips, records "reconnect needed") otherwise.
//   Only a genuine user gesture (Connect / Backup Now / Restore from
//   Drive, all real button clicks) is allowed to call
//   requestAccessToken() and show a popup if one turns out to be needed.
// - Drive API v3: `files.create` (folder: `mimeType:
//   'application/vnd.google-apps.folder'`; file: multipart upload with
//   metadata + content), `files.update` (PATCH, media upload) to update
//   the SAME file in place, `files.get?alt=media` to download raw
//   content, `files.list?q=...` to find an existing app-created
//   folder/file by name so this app never creates a duplicate on a
//   second run. All plain REST + `fetch()` with an `Authorization:
//   Bearer <token>` header — no separate client library needed.
// - Scope: `https://www.googleapis.com/auth/drive.file` — confirmed
//   STILL the correct minimal, NON-SENSITIVE scope for "only files this
//   app itself creates" (confirmed directly against
//   developers.google.com/drive/scopes): it requires no Google OAuth app
//   verification and no CASA security assessment, unlike the broader
//   `drive`/`drive.readonly` scopes (which are "restricted" and require
//   both). This app creates its own folder/file (never asks the owner to
//   pick a pre-existing one via the Picker API), which is exactly the
//   drive.file grant's core, most common use — everything this app
//   creates stays accessible to it across sessions using the same OAuth
//   client, with NO Drive-wide visibility beyond that.
// - Rate limits: even under Drive's newer (May 2026) unit-based quota
//   model, this app's opportunistic ~hourly backup (a handful of API
//   calls per attempt: one search-or-create for the folder, one for the
//   file, one upload) is many orders of magnitude below every documented
//   tier (historically ~20,000 requests/100s per user/project; Google's
//   own written guidance is only to avoid exceeding roughly 3 write
//   requests PER SECOND — this app does a small handful per HOUR).
// - The OAuth Client ID itself is NOT a secret the way an API key is —
//   confirmed still accurate: a public/SPA OAuth Client ID is designed
//   to be visible in client-side code (Google's own docs and samples
//   embed it directly in HTML/JS). It is still treated with the same
//   local-only, never-synced storage as the Gemini key for consistency
//   and because it's still device-specific setup the owner enters once,
//   not because it's confidential.
//
// Failure handling: every exported function here returns a plain result
// object (`{ok: false, reason}` or similar) instead of throwing, for
// every failure mode — network errors, an expired/revoked/401 token, a
// 429/quota response, a malformed Drive response, or GIS's own consent
// popup being closed/denied. Nothing in this file can block, slow down,
// or otherwise affect Fast Entry or any other part of the app — the
// upload/download calls here are entirely independent of the local
// Dexie-backed save path lib/ledger.ts already provides.

import { exportBackup, restoreFromBackup, serializeBackup, type RestoreResult } from './backup';
import {
  getGoogleDriveBackupSettings,
  patchGoogleDriveBackupSettings,
  setGoogleDriveBackupSettings,
  isGoogleDriveConnected,
} from './googleDriveSettingsStore';

// drive.file: non-sensitive, no Google app verification / CASA required.
// See the research note above — never widen this "for flexibility".
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const GIS_SCRIPT_URL = 'https://accounts.google.com/gsi/client';
const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';
const BACKUP_FOLDER_NAME = 'Office Cash Ledger Backups';
const BACKUP_FILE_NAME = 'office-cash-ledger-backup.json';

// Single named constant per constraint #5 - not a magic number scattered
// around. Used BOTH as the auto-backup interval (App.tsx's setInterval)
// AND as the minimum-gap-since-last-attempt guard inside autoBackupTick()
// itself, so an interval tick, a visibilitychange, and a pagehide firing
// in quick succession can't spam Drive - only the first of any cluster of
// triggers within this window actually proceeds.
export const MIN_AUTO_BACKUP_INTERVAL_MS = 60 * 60 * 1000; // ~hourly

// A cached access token is treated as unusable this many ms before its
// real expiry, so a call already in flight doesn't get rejected by Drive
// for expiring mid-request.
const TOKEN_SAFETY_MARGIN_MS = 2 * 60 * 1000;

export type DriveBackupResult =
  | { ok: true; skipped?: false }
  | { ok: false; skipped: true; reason: string } // declined to even attempt (not connected, too soon, no valid cached token in a non-interactive context) - not an error
  | { ok: false; skipped?: false; reason: string }; // a real attempt was made and it failed

export interface DriveBackupStatus {
  lastBackupAt: number | null;
  lastError: string | null;
}

/** For the Settings UI status line (EXACT SCOPE item 1) and for callers that just want to know whether Drive-related UI/behavior should be active at all. */
export function isConnected(): boolean {
  return isGoogleDriveConnected();
}

export function getLastBackupStatus(): DriveBackupStatus {
  const s = getGoogleDriveBackupSettings();
  return { lastBackupAt: s.lastBackupAt, lastError: s.lastError };
}

// ---------------------------------------------------------------------
// GIS script loading + token client (module-level, lazy, cached by
// clientId so switching the Client ID re-initializes cleanly).
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

interface GisTokenResponse {
  access_token?: string;
  expires_in?: number; // seconds
  error?: string;
  error_description?: string;
}

interface GisTokenClient {
  requestAccessToken: (overrideConfig?: { prompt?: string }) => void;
}

interface GisGlobal {
  accounts: {
    oauth2: {
      initTokenClient: (config: {
        client_id: string;
        scope: string;
        callback: (response: GisTokenResponse) => void;
      }) => GisTokenClient;
      revoke: (token: string, callback: () => void) => void;
    };
  };
}

function getGis(): GisGlobal | null {
  return (window as unknown as { google?: GisGlobal }).google ?? null;
}

let cachedTokenClient: { clientId: string; client: GisTokenClient } | null = null;
let pendingTokenResolve: ((r: GisTokenResponse) => void) | null = null;

async function getTokenClient(clientId: string): Promise<GisTokenClient> {
  await loadGisScript();
  const gis = getGis();
  if (!gis) throw new Error('Google Identity Services did not load correctly.');
  if (cachedTokenClient && cachedTokenClient.clientId === clientId) return cachedTokenClient.client;
  const client = gis.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: DRIVE_SCOPE,
    callback: (response) => {
      // GIS's callback is fixed at init time, not per-call - resolving
      // whichever promise is currently "pending" is the standard pattern
      // for turning this into a per-call Promise-based API.
      if (pendingTokenResolve) {
        const resolve = pendingTokenResolve;
        pendingTokenResolve = null;
        resolve(response);
      }
    },
  });
  cachedTokenClient = { clientId, client };
  return client;
}

/**
 * Requests a fresh access token via a REAL user-gesture-triggered popup
 * (or a near-instant, still Google-UI-mediated grant if the owner already
 * has an active session + prior consent — GIS decides that, not this
 * code). ONLY ever called from an explicit Connect / Backup Now /
 * Restore from Drive button click — never from a background timer.
 */
async function requestAccessTokenInteractive(clientId: string): Promise<GisTokenResponse> {
  const client = await getTokenClient(clientId);
  return new Promise((resolve) => {
    pendingTokenResolve = resolve;
    client.requestAccessToken();
  });
}

/**
 * Returns a currently-valid access token, or null. In a non-interactive
 * context (auto-backup) this NEVER prompts — it only ever returns a
 * still-fresh cached token or nothing, per the "no silent refresh exists"
 * research note above. In an interactive context (a real button click)
 * it will request a fresh one via the popup flow if the cached one is
 * missing/stale.
 */
async function ensureFreshAccessToken(interactive: boolean): Promise<{ token: string } | { token: null; reason: string }> {
  const settings = getGoogleDriveBackupSettings();
  if (!settings.clientId) return { token: null, reason: 'No Google Cloud OAuth Client ID configured.' };
  const now = Date.now();
  if (settings.accessToken && settings.accessTokenExpiresAt && settings.accessTokenExpiresAt - TOKEN_SAFETY_MARGIN_MS > now) {
    return { token: settings.accessToken };
  }
  if (!interactive) {
    return { token: null, reason: 'No valid cached access token (reconnect needed) — skipped rather than prompting in the background.' };
  }
  try {
    const response = await requestAccessTokenInteractive(settings.clientId);
    if (!response.access_token) {
      return { token: null, reason: response.error_description || response.error || 'Google did not grant access.' };
    }
    const expiresAt = now + (response.expires_in ?? 3600) * 1000;
    patchGoogleDriveBackupSettings({ accessToken: response.access_token, accessTokenExpiresAt: expiresAt, connected: true });
    return { token: response.access_token };
  } catch (err) {
    return { token: null, reason: err instanceof Error ? err.message : 'Could not obtain a Google access token.' };
  }
}

// ---------------------------------------------------------------------
// Connect / disconnect
// ---------------------------------------------------------------------

export async function connect(clientId: string): Promise<DriveBackupResult> {
  const trimmed = clientId.trim();
  if (!trimmed) return { ok: false, reason: 'A Google Cloud OAuth Client ID is required.' };
  setGoogleDriveBackupSettings({
    ...getGoogleDriveBackupSettings(),
    clientId: trimmed,
  });
  const result = await ensureFreshAccessToken(true);
  if (result.token == null) {
    patchGoogleDriveBackupSettings({ lastError: result.reason });
    return { ok: false, reason: result.reason };
  }
  patchGoogleDriveBackupSettings({ lastError: null });
  return { ok: true };
}

export async function disconnect(): Promise<void> {
  const settings = getGoogleDriveBackupSettings();
  if (settings.accessToken) {
    try {
      const gis = getGis();
      if (gis) {
        await new Promise<void>((resolve) => {
          gis.accounts.oauth2.revoke(settings.accessToken!, () => resolve());
          // Best-effort: don't let a hung revoke callback block disconnect forever.
          setTimeout(resolve, 3000);
        });
      }
    } catch {
      // Revocation is best-effort - proceed to clear local state regardless.
    }
  }
  setGoogleDriveBackupSettings({
    clientId: settings.clientId, // keep, so the owner doesn't have to retype it
    connected: false,
    accessToken: null,
    accessTokenExpiresAt: null,
    folderId: null,
    fileId: null,
    lastBackupAt: settings.lastBackupAt,
    lastError: null,
  });
  cachedTokenClient = null;
}

// ---------------------------------------------------------------------
// Drive REST helpers
// ---------------------------------------------------------------------

async function driveRequest(path: string, token: string, init?: RequestInit): Promise<Response> {
  return fetch(`${DRIVE_API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${token}`,
    },
  });
}

function reasonForStatus(status: number): string {
  if (status === 401 || status === 403) return 'Google Drive access token is invalid or was revoked — reconnect in Settings.';
  if (status === 429) return 'Google Drive quota/rate limit reached — will try again later.';
  return `Google Drive returned an error (HTTP ${status}).`;
}

async function findFileId(token: string, query: string): Promise<string | null> {
  const res = await driveRequest(`/files?q=${encodeURIComponent(query)}&fields=files(id,name)&spaces=drive`, token);
  if (!res.ok) throw new Error(reasonForStatus(res.status));
  const data = (await res.json()) as { files?: Array<{ id: string; name: string }> };
  return data.files && data.files.length > 0 ? data.files[0].id : null;
}

async function findOrCreateFolderId(token: string): Promise<string> {
  const cached = getGoogleDriveBackupSettings().folderId;
  if (cached) return cached;
  const query = `mimeType='application/vnd.google-apps.folder' and name='${BACKUP_FOLDER_NAME}' and trashed=false`;
  const existing = await findFileId(token, query);
  if (existing) {
    patchGoogleDriveBackupSettings({ folderId: existing });
    return existing;
  }
  const res = await driveRequest('/files?fields=id', token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: BACKUP_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
  });
  if (!res.ok) throw new Error(reasonForStatus(res.status));
  const created = (await res.json()) as { id: string };
  patchGoogleDriveBackupSettings({ folderId: created.id });
  return created.id;
}

async function findExistingFileId(token: string, folderId: string): Promise<string | null> {
  const cached = getGoogleDriveBackupSettings().fileId;
  if (cached) return cached;
  const query = `'${folderId}' in parents and name='${BACKUP_FILE_NAME}' and trashed=false`;
  const existing = await findFileId(token, query);
  if (existing) patchGoogleDriveBackupSettings({ fileId: existing });
  return existing;
}

/** multipart upload body per Drive API v3's simple multipart-upload convention (metadata part + media part). */
function buildMultipartBody(metadata: Record<string, unknown>, content: string): { body: string; contentType: string } {
  const boundary = 'office_cash_ledger_backup_boundary';
  const body =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    'Content-Type: application/json\r\n\r\n' +
    `${content}\r\n` +
    `--${boundary}--`;
  return { body, contentType: `multipart/related; boundary=${boundary}` };
}

async function uploadBackupContent(token: string, folderId: string, existingFileId: string | null, content: string): Promise<string> {
  if (existingFileId) {
    // files.update: same file, content replaced in place - never a new dated file (constraint #8).
    const res = await fetch(`${DRIVE_UPLOAD_BASE}/files/${existingFileId}?uploadType=media`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: content,
    });
    if (!res.ok) throw new Error(reasonForStatus(res.status));
    return existingFileId;
  }
  const { body, contentType } = buildMultipartBody({ name: BACKUP_FILE_NAME, parents: [folderId] }, content);
  const res = await fetch(`${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=id`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
    body,
  });
  if (!res.ok) throw new Error(reasonForStatus(res.status));
  const created = (await res.json()) as { id: string };
  return created.id;
}

// ---------------------------------------------------------------------
// Public backup / restore operations
// ---------------------------------------------------------------------

async function performBackup(interactive: boolean): Promise<DriveBackupResult> {
  const tokenResult = await ensureFreshAccessToken(interactive);
  if (tokenResult.token == null) {
    if (!interactive) return { ok: false, skipped: true, reason: tokenResult.reason };
    patchGoogleDriveBackupSettings({ lastError: tokenResult.reason });
    return { ok: false, reason: tokenResult.reason };
  }
  const token = tokenResult.token;
  try {
    // EXACT SAME JSON exportBackup() already produces for every other
    // restore path (constraint #7) - never a second backup format.
    const payload = await exportBackup();
    const content = serializeBackup(payload);
    const folderId = await findOrCreateFolderId(token);
    const existingFileId = await findExistingFileId(token, folderId);
    const fileId = await uploadBackupContent(token, folderId, existingFileId, content);
    patchGoogleDriveBackupSettings({ fileId, lastBackupAt: Date.now(), lastError: null });
    return { ok: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'Google Drive backup failed.';
    patchGoogleDriveBackupSettings({ lastError: reason });
    return { ok: false, reason };
  }
}

/** Explicit manual "Backup to Drive Now" button — a real user gesture, so this may show a popup if the cached token has expired. */
export async function backupNow(): Promise<DriveBackupResult> {
  if (!isGoogleDriveConnected()) return { ok: false, skipped: true, reason: 'Google Drive backup is not connected.' };
  return performBackup(true);
}

/**
 * Opportunistic, rate-limited auto-backup (constraint #5). Safe to call
 * from an interval tick, a visibilitychange handler, AND a pagehide
 * handler without any extra coordination between them — whichever fires
 * first each window wins, and every other trigger within
 * MIN_AUTO_BACKUP_INTERVAL_MS of it is a no-op. Accepts `now` for
 * deterministic testing (scripts/test-drive-backup.ts) - defaults to the
 * real clock in the running app.
 */
export async function autoBackupTick(now: number = Date.now()): Promise<DriveBackupResult> {
  if (!isGoogleDriveConnected()) return { ok: false, skipped: true, reason: 'Google Drive backup is not connected.' };
  const settings = getGoogleDriveBackupSettings();
  const lastAttempt = settings.lastBackupAt ?? 0;
  if (now - lastAttempt < MIN_AUTO_BACKUP_INTERVAL_MS) {
    return { ok: false, skipped: true, reason: 'Too soon since the last backup attempt.' };
  }
  // Record the attempt time BEFORE the (possibly slow/failing) network
  // work below, so a slow or failing attempt can't itself be raced by a
  // second trigger that fires while the first is still in flight.
  patchGoogleDriveBackupSettings({ lastBackupAt: now });
  const result = await performBackup(false);
  return result;
}

export async function restoreFromDrive(): Promise<{ ok: true; result: RestoreResult } | { ok: false; reason: string }> {
  if (!isGoogleDriveConnected()) return { ok: false, reason: 'Google Drive backup is not connected.' };
  const tokenResult = await ensureFreshAccessToken(true);
  if (tokenResult.token == null) return { ok: false, reason: tokenResult.reason };
  const token = tokenResult.token;
  try {
    const folderId = await findOrCreateFolderId(token);
    const fileId = await findExistingFileId(token, folderId);
    if (!fileId) return { ok: false, reason: 'No backup file found on Google Drive yet — run "Backup Now" at least once first.' };
    const res = await driveRequest(`/files/${fileId}?alt=media`, token);
    if (!res.ok) throw new Error(reasonForStatus(res.status));
    const content = await res.text();
    // Routed through the EXACT SAME restoreFromBackup() every other
    // restore path uses (constraint #7) - not a parallel implementation.
    // Its own schemaVersion exact-match validation applies identically
    // here, so an old/incompatible Drive-downloaded file is rejected the
    // same way a local file upload already is.
    const result = await restoreFromBackup(content);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'Restore from Google Drive failed.' };
  }
}
