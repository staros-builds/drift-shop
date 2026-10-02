/* Vendra service worker — app-shell cache ONLY.
 *
 * CLOUD-ONLY CONTRACT: this worker caches same-origin static files
 * (HTML/JS/CSS/icons and other app assets) so repeat opens are instant.
 * It never caches business data. API and database traffic runs on a
 * different origin (the shop's Supabase project), and the worker only
 * handles same-origin GETs — non-GETs, range requests (media streaming),
 * and the app-update probe (__driftshop_build) always go to the network.
 * With no connection the boot self-check refuses to open the app and shows
 * the honest cannot-reach screen — the cache can never serve a working
 * app, because every read and write needs the cloud.
 *
 * Bump CACHE_VERSION when shipping a new build so clients pick up fresh
 * assets (the build substitutes __BUILD_ID__ via vite.config.js).
 */

const CACHE_VERSION = 'driftshop-202610022156';
// Derive shell paths from the service worker's own scope so the app works
// when hosted under a subpath (e.g. /drift-shop/) instead of the domain root.
// self.registration.scope is like "https://host/drift-shop/" — strip the origin
// to get the base path.
const SCOPE_PATH = (() => {
  try {
    const scopeUrl = new URL(self.registration.scope);
    let p = scopeUrl.pathname;
    if (!p.endsWith('/')) p += '/';
    return p;
  } catch {
    return '/';
  }
})();
const SHELL = [
  SCOPE_PATH,
  SCOPE_PATH + 'index.html',
  SCOPE_PATH + 'manifest.webmanifest',
  SCOPE_PATH + 'icons/icon-192.png',
  SCOPE_PATH + 'icons/icon-512.png',
  SCOPE_PATH + 'icons/icon-maskable-512.png',
  SCOPE_PATH + 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => {
        // First install with no network: skip precaching, runtime caching
        // will fill in on later loads. Still activate.
        return self.skipWaiting();
      })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => (k.startsWith('driftshop-') || k.startsWith('drift-')) && k !== CACHE_VERSION).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

function isSameOrigin(url) {
  return url.origin === self.location.origin;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (!isSameOrigin(url)) return;
  // Media streaming uses byte ranges — let those through untouched.
  if (request.headers.has('range')) return;

  // Navigations: try the network first so a fresh index.html wins when
  // online; fall back to the cached shell when offline. The cache key must
  // include the scope path — under /drift-shop/ the shell lives at /drift-shop/index.html,
  // not the domain root.
  if (request.mode === 'navigate') {
    const shellKey = SCOPE_PATH + 'index.html';
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(shellKey, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(shellKey, { cacheName: CACHE_VERSION }))
    );
    return;
  }

  // Static assets: cache-first, populate on miss. The app-update probe
  // (index.html?__driftshop_build=…) must never be cached — it exists precisely
  // to bypass every cache and see the live bundle name.
  if (url.searchParams.has('__driftshop_build')) return;
  event.respondWith(
    caches.match(request, { cacheName: CACHE_VERSION }).then((hit) => {
      if (hit) return hit;
      return fetch(request).then((res) => {
        if (res && (res.status === 200 || res.status === 0)) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return res;
      });
    })
  );
});
