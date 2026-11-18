import { initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, signInAnonymously, onAuthStateChanged, connectAuthEmulator, type Auth } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator, type Firestore } from 'firebase/firestore';

// Phase 10b Part A: config comes from Vite env vars, never hardcoded. See
// .env.example for the full list and README for where to find each value
// in the Firebase console.
//
// CRITICAL: nothing in this file runs at module-import time beyond
// defining these functions — no Firebase SDK call happens, and therefore
// no network activity occurs, until something actually calls
// getFirebaseApp()/ensureSignedIn()/getDb() below. lib/sync.ts (the only
// caller) only does that when a sync code is configured. With no sync
// code configured, this module is imported (its functions exist) but
// never invoked — satisfying "zero Firebase SDK calls, zero network
// activity" for the no-sync-code case (Part A, Test Case 8).
interface FirebaseEnvConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
}

// Reads a VITE_-prefixed env var. In the real app this is always Vite's
// import.meta.env (statically replaced at build time). scripts/test-sync.ts
// (Part E) runs under plain Node/tsx, not Vite, so import.meta.env is
// unavailable there — it sets globalThis.__VITE_ENV__ instead before
// calling any sync function, and this falls back to reading that. Uses
// only import.meta (typed by vite/client) and globalThis (ES2023 lib) —
// no Node-specific globals, so this file still type-checks cleanly under
// the browser-only tsconfig the rest of src/ uses.
function readEnvVar(key: string): string | undefined {
  const metaEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  if (metaEnv && metaEnv[key] !== undefined && metaEnv[key] !== '') return metaEnv[key];
  const testEnv = (globalThis as unknown as { __VITE_ENV__?: Record<string, string | undefined> })
    .__VITE_ENV__;
  return testEnv?.[key];
}

function readEnvConfig(): FirebaseEnvConfig {
  const config: FirebaseEnvConfig = {
    apiKey: readEnvVar('VITE_FIREBASE_API_KEY') ?? '',
    authDomain: readEnvVar('VITE_FIREBASE_AUTH_DOMAIN') ?? '',
    projectId: readEnvVar('VITE_FIREBASE_PROJECT_ID') ?? '',
    storageBucket: readEnvVar('VITE_FIREBASE_STORAGE_BUCKET') ?? '',
    messagingSenderId: readEnvVar('VITE_FIREBASE_MESSAGING_SENDER_ID') ?? '',
    appId: readEnvVar('VITE_FIREBASE_APP_ID') ?? '',
  };
  const missing = Object.entries(config)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    throw new Error(
      `Cloud Sync is not configured: missing ${missing.join(', ')} in .env. See README's Cloud Sync setup section.`,
    );
  }
  return config;
}

let cachedApp: FirebaseApp | null = null;
let cachedAuth: Auth | null = null;
let cachedDb: Firestore | null = null;
let firestoreEmulatorConnected = false;
let authEmulatorConnected = false;

function getFirebaseApp(): FirebaseApp {
  if (!cachedApp) {
    cachedApp = initializeApp(readEnvConfig());
  }
  return cachedApp;
}

function getFirebaseAuth(): Auth {
  if (!cachedAuth) {
    cachedAuth = getAuth(getFirebaseApp());
    const authEmulatorHost = readEnvVar('VITE_AUTH_EMULATOR_HOST');
    if (authEmulatorHost && !authEmulatorConnected) {
      connectAuthEmulator(cachedAuth, `http://${authEmulatorHost}`, { disableWarnings: true });
      authEmulatorConnected = true;
    }
  }
  return cachedAuth;
}

/**
 * The Firestore instance. In the test/emulator environment
 * (VITE_FIRESTORE_EMULATOR_HOST set, only ever by scripts/test-sync.ts —
 * never in a real build), points at the local Firestore emulator instead
 * of the live project — Part E: tests must never touch a real Firebase
 * project.
 */
export function getSyncFirestore(): Firestore {
  if (!cachedDb) {
    cachedDb = getFirestore(getFirebaseApp());
    const emulatorHost = readEnvVar('VITE_FIRESTORE_EMULATOR_HOST');
    if (emulatorHost && !firestoreEmulatorConnected) {
      const [host, portStr] = emulatorHost.split(':');
      connectFirestoreEmulator(cachedDb, host, Number(portStr));
      firestoreEmulatorConnected = true;
    }
  }
  return cachedDb;
}

/**
 * Silently sign in with Firebase Anonymous Auth if not already signed in
 * (Part A: "no login UI, no prompt" — this is a lightweight write-guard
 * for firestore.rules, not real per-user authentication). Resolves once a
 * uid is available. Called by lib/sync.ts immediately before any sync
 * operation, and ONLY when a sync code is configured.
 */
export async function ensureSignedIn(): Promise<string> {
  const auth = getFirebaseAuth();
  if (auth.currentUser) return auth.currentUser.uid;

  return new Promise<string>((resolve, reject) => {
    const unsubscribe = onAuthStateChanged(
      auth,
      (user) => {
        if (user) {
          unsubscribe();
          resolve(user.uid);
        }
      },
      (err) => {
        unsubscribe();
        reject(err);
      },
    );
    signInAnonymously(auth).catch((err) => {
      unsubscribe();
      reject(err);
    });
  });
}
