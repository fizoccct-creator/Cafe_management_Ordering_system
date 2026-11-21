// Network-first with cache fallback: always fresh when online, still opens offline.
// Live sync traffic (/api/) is never cached.
const CACHE = 'cafeflow-v3';
const ASSETS = ['./', './index.html', './styles.css', './shared.js', './app.js', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/logo-blue.png', './icons/logo-white.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')) return;
  e.respondWith(
    fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy));
      return res;
    }).catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
  );
});
