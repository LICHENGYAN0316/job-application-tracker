const CACHE_NAME = 'zhixu-static-v5';
const PRECACHE_URLS = [
  '/manifest.webmanifest',
  '/brand-mark.png',
  '/career-navigator-mark.png',
  '/favicon-32.png',
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))),
    ),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !PRECACHE_URLS.includes(url.pathname)) return;

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request)),
  );
});
