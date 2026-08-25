// ai-notes/sw.js
//
// Network-only service worker, scope /ai-notes/.
//
// Its whole job is to be more specific than the hub SW at scope '/', so that it
// claims this path whatever version of the hub is sitting on the device. It
// caches nothing and it deletes nothing — the tma- prefix rule belongs to the
// hub and this SW must not touch it.
//
// Do not add a cache here later. An offline-first cache on a page that must
// persist nothing is exactly risk R7.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Claim clients so the first navigation is controlled by this SW rather than
  // waiting for a reload. No cache deletion: not our prefix, not our business.
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Returning without calling respondWith() hands the request straight back to
  // the browser. Nothing is intercepted, nothing is stored.
  return;
});
