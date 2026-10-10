// CulinAction service worker.
// Caches ONLY the static app shell (HTML, JS, CSS, icons) so the app opens quickly.
// API responses (private business data) are never cached; they always go to the network.
// Offline limitation: without a connection to the server, data cannot be loaded or saved.
const CACHE = 'culinaction-shell-v2';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/api/')
  )
    return;
  const isAsset = url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/');
  if (isAsset) {
    // hashed build assets: cache-first
    event.respondWith(
      caches.match(event.request).then(
        (hit) =>
          hit ||
          fetch(event.request).then((res) => {
            if (res.ok) caches.open(CACHE).then((c) => c.put(event.request, res.clone()));
            return res;
          }),
      ),
    );
  } else if (event.request.mode === 'navigate') {
    // app shell: network-first, fall back to cached shell
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          if (res.ok) caches.open(CACHE).then((c) => c.put('/', res.clone()));
          return res;
        })
        // offline: serve the cached shell; if none is cached yet, retry the network once
        .catch(() => caches.match('/').then((hit) => hit || fetch(event.request))),
    );
  }
});
