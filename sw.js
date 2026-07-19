// Death Walk service worker
// Network-first, cache fallback only when offline. Never cache-first.

const CACHE_NAME = 'death-walk-v0.29.0';

// Install: activate immediately, no pre-caching.
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

// Activate: delete ALL caches, then take control of open clients.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

// Fetch: network-first. Cache successful GET responses as we go, and fall
// back to the cache only when the network is unavailable.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
