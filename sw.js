// Service worker for the store + shop panel — offline shell. Data offline is handled by Firestore's cache (panel)
// and a saved copy of the catalog (store).
const V = 'ls-07920665';
const R = (p) => new URL(p, self.location).href;
const SHELL = ['./', './store.js?v=07920665', './store.css?v=07920665', './firebase-config.js?v=07920665', './panel/', './panel/app.js?v=07920665', './panel/app.css?v=07920665',
  './panel/manifest.webmanifest', './icons/logo.svg', './icons/icon-192.png'].map(R);
self.addEventListener('install', (e) => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const req = e.request; const u = new URL(req.url);
  if (req.method !== 'GET' || u.origin !== location.origin) return;          // never touch Firebase / Firestore traffic
  const root = R('./');
  const isNav = req.mode === 'navigate';
  if (isNav || u.pathname.endsWith('/firebase-config.js') || u.pathname.endsWith('.xml') || u.pathname.endsWith('.txt')) {
    e.respondWith(fetch(req).then(r => { if (r.ok && isNav) { const c = r.clone(); caches.open(V).then(x => x.put(req, c)); } return r; })
      .catch(async () => (await caches.match(req, { ignoreSearch: true })) ||
        (await caches.match(u.href.startsWith(R('./panel/')) ? R('./panel/') : root)) || Response.error()));
    return;
  }
  e.respondWith(caches.match(req).then(m => m || fetch(req).then(r => { if (r.ok && (u.search.includes('v=') || u.pathname.includes('/img/') || u.pathname.includes('/icons/'))) { const c = r.clone(); caches.open(V).then(x => x.put(req, c)); } return r; })));
});
