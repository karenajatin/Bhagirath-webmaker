// Bhagiratha service worker — app shell offline. Data offline is handled by Firestore's own cache.
const V = 'bh-41767050';
const SHELL = ['./', './index.html', './app.js?v=41767050', './app.css?v=41767050', './firebase-config.js?v=41767050', './manifest.webmanifest', './icons/logo.svg', './icons/icon-192.png', './icons/icon-512.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;           // never touch Firebase traffic
  const networkFirst = e.request.mode === 'navigate' || u.pathname.endsWith('/firebase-config.js') || u.pathname.endsWith('/') || u.pathname.endsWith('/index.html');
  if (networkFirst) {
    e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open(V).then(x => x.put(e.request.mode === 'navigate' ? './' : e.request, c)); return r; })
      .catch(() => caches.match(e.request.mode === 'navigate' ? './' : e.request, { ignoreSearch: u.pathname.endsWith('/firebase-config.js') })));
  } else {
    e.respondWith(caches.match(e.request).then(m => m || fetch(e.request).then(r => { if (r.ok) { const c = r.clone(); caches.open(V).then(x => x.put(e.request, c)); } return r; })));
  }
});
