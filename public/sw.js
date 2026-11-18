// Office Daily Cash Ledger - service worker.
//
// Purpose: let the app open with no internet after it has been opened once.
// It only caches the app's own files (and Google Fonts). It never touches
// ledger data (that lives in IndexedDB), and it ignores every other site:
// Firebase / Cloud Sync, Google sign-in and the Google Drive API all go
// straight to the network, untouched.
//
// Updates: the main page is fetched from the network first, so a new
// version published to GitHub is picked up on the next normal open. Built
// files have new names on every build, so old and new never get mixed.

const CACHE = 'ocl-v1';
const MAX_ENTRIES = 80;
const NAV_TIMEOUT_MS = 4000;
const ROOT = new URL('./', self.location).href; // the app's own address

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('ocl-') && k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

async function trim(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_ENTRIES; i++) await cache.delete(keys[i]);
}

async function put(cache, key, response) {
  try {
    await cache.put(key, response);
    await trim(cache);
  } catch {
    /* storage full or response not cacheable - the app still works */
  }
}

// Main page: network first (so updates arrive), cached copy when offline/slow.
async function handleNavigation(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await Promise.race([
      fetch(request),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), NAV_TIMEOUT_MS)),
    ]);
    if (response && response.ok) put(cache, ROOT, response.clone());
    return response;
  } catch {
    const cached = await cache.match(ROOT);
    if (cached) return cached;
    return fetch(request);
  }
}

// Everything else: cached copy first, refreshed in the background.
async function handleAsset(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  const refresh = fetch(request)
    .then((response) => {
      if (response && (response.ok || response.type === 'opaque')) put(cache, request, response.clone());
      return response;
    })
    .catch(() => null);
  if (cached) return cached;
  const fresh = await refresh;
  return fresh || Response.error();
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;
  const isFont = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (!sameOrigin && !isFont) return; // leave Firebase, Google sign-in and Drive alone
  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
    return;
  }
  event.respondWith(handleAsset(request));
});
