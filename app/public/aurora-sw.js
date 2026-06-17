/* Aurora service worker — NETWORK-FIRST for the app shell.
 *
 * The shell (the /aurora HTML) is fetched fresh on every online load so server
 * deploys take effect immediately; the cache is only an offline fallback. A
 * previous cache-first strategy meant updates didn't show until a couple of
 * reloads later — bump SHELL_CACHE whenever that behaviour needs resetting.
 * Media/thumbnails/API are never cached. */
const SHELL_CACHE = 'aurora-shell-v3';
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
  // Drop every old cache (incl. the stale v1 app shell), then take control now.
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;

  // Never cache thumbnails, videos, or API data — always go to network.
  if (url.pathname.startsWith('/api/aurora/')) return;

  // App shell: network-first. Always serve the freshest HTML/assets when online;
  // refresh the cache copy in the background; fall back to cache only offline.
  if (url.pathname === '/aurora' || SHELL_ASSETS.includes(url.pathname)) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(event.request, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(event.request))
    );
  }
});
