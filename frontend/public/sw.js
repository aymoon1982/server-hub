const CACHE_NAME = 'server-hub-v2';
const ASSETS = [
  '/',
  '/index.html',
  '/favicon.svg',
  '/manifest.json'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  // Only handle GET requests and ignore API calls and websockets
  if (e.request.method !== 'GET' || e.request.url.includes('/api/') || e.request.url.includes('/ws/')) {
    return;
  }

  const isNavigation = e.request.mode === 'navigate' || new URL(e.request.url).pathname === '/index.html';

  // Network-first for the app shell so deploys are picked up immediately;
  // cache-first would pin users to the first index.html they ever loaded.
  if (isNavigation) {
    e.respondWith(
      fetch(e.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('/index.html', responseToCache));
        }
        return networkResponse;
      }).catch(() => caches.match('/index.html').then((c) => c || Response.error()))
    );
    return;
  }

  // Cache-first for hashed static assets (immutable by filename)
  e.respondWith(
    caches.match(e.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(e.request).then((networkResponse) => {
        if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
          return networkResponse;
        }
        // Cache new static assets dynamically
        const responseToCache = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(e.request, responseToCache);
        });
        return networkResponse;
      }).catch(() => Response.error());
    })
  );
});
