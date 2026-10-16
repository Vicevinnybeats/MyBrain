/* MyBrain service worker: the app opens instantly and works offline with the
 * maps you've already viewed. The app shell is cached at install time; maps are
 * fetched fresh when online and fall back to the cached copy when offline. */
const VERSION = '__BUILD__';
const SHELL = ['./', 'index.html', 'app.css', 'app.js', 'graph.js', 'layout-worker.js',
  'vendor/d3-force-bundle.min.js', 'manifest.webmanifest', 'icons/icon.svg',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];
const SHELL_CACHE = 'mybrain-shell-' + VERSION;
const DATA_CACHE = 'mybrain-maps';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { credentials: 'same-origin' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys
    .filter(k => k.startsWith('mybrain-shell-') && k !== SHELL_CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.includes('/maps/')) {
    // network first, cached copy when offline
    e.respondWith(fetch(e.request).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(DATA_CACHE).then(c => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request)));
    return;
  }
  // app shell: network first (always the newest app when online), cached copy offline
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok && r.type === 'basic') { const copy = r.clone(); caches.open(SHELL_CACHE).then(c => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
