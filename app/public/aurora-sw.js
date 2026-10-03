/* Aurora service worker — NETWORK-FIRST for the app shell.
 *
 * The shell (the /aurora HTML plus its /ui/ CSS + JS) is fetched fresh on every
 * online load so server deploys take effect immediately; the cache is only an
 * offline fallback. A previous cache-first strategy meant updates didn't show
 * until a couple of reloads later — bump SHELL_CACHE whenever that behaviour
 * needs resetting (activate purges every other cache).
 * Media/thumbnails/API are never cached here. */
const SHELL_CACHE = 'aurora-shell-v6';
const SHELL_ASSETS = [
  '/aurora',
  '/aurora-manifest.json',
  '/aurora-icon-180.png',
  '/aurora-icon-192.png',
  '/aurora-icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Drop every old cache (incl. stale app shells), then take control now.
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first: always serve the freshest copy when online and refresh the
// cached copy in the background; fall back to the cache only when offline.
// /ui/ assets are requested with a ?v=<build> query, so the offline lookup
// ignores the query string (an old build's file beats no styling at all).
function networkFirst(request, ignoreSearch) {
  return fetch(request)
    .then((res) => {
      if (res && res.status === 200) {
        const copy = res.clone();
        caches.open(SHELL_CACHE).then((c) => c.put(request, copy)).catch(() => {});
      }
      return res;
    })
    .catch(() => caches.match(request, { ignoreSearch }));
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Never cache thumbnails, videos, or API data — always go to network.
  if (url.pathname.startsWith('/api/aurora/')) return;

  if (url.pathname === '/aurora' || SHELL_ASSETS.includes(url.pathname)) {
    event.respondWith(networkFirst(event.request, false));
  } else if (url.pathname.startsWith('/ui/')) {
    event.respondWith(networkFirst(event.request, true));
  }
});
