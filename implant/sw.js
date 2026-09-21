// implant/sw.js
//
// Network-only service worker, scope /implant/.
//
// The tool is behind a passcode and restricted to its author while its clinical
// figures are drafts, so it keeps no offline copy: a cached page opens without
// the passcode, on any device that signed in once, for as long as the cache
// lives. This worker exists to be that absence, and to clear the caches the
// earlier caching worker left behind (prefix imp-).
//
// Do not add a cache here while the tool is gated.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.indexOf('imp-') === 0).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', () => {
  // Nothing intercepted, nothing stored: every request goes to the network,
  // and therefore through the gate.
  return;
});
