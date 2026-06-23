const CACHE = 'linjian-v1';
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(['/chat.html','/dashboard.html','/expense.html','/favicon.svg','/manifest.json'])));
  self.skipWaiting();
});
self.addEventListener('fetch', e => {
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
