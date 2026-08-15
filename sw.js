const CACHE = "tma-v1-4-23";

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(["./", "./index.html"])).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      // Only tidy up THIS tool's old versions. Other tools share this origin and
      // own their own caches - deleting theirs breaks their offline support until
      // the user next opens them with a signal, which is exactly the situation
      // the offline support exists for. Without the prefix test this removes
      // sedation-* and la-* on every deploy.
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k.indexOf("tma-") === 0 && k !== CACHE).map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;

  // Network-first for page loads: users always get the latest deployed
  // version when online, and the cached copy when offline.
  if (e.request.mode === "navigate") {
    e.respondWith(
      fetch(e.request)
        .then((resp) => {
          // Only cache a good response. A 404 or 500 - a bad deploy, a half
          // uploaded zip - would otherwise be pinned here and served from the
          // cache until the next version bump clears it.
          if (resp && resp.ok) {
            const copy = resp.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return resp;
        })
        .catch(() => caches.match(e.request).then((r) => r || caches.match("./index.html")))
    );
    return;
  }

  // Cache-first for static assets (icons, manifest).
  e.respondWith(
    caches.match(e.request).then(
      (cached) =>
        cached ||
        fetch(e.request).then((resp) => {
          // resp.ok is false for opaque cross-origin responses (the web fonts),
          // which are still worth keeping, so allow those through as well.
          if (resp && (resp.ok || resp.type === "opaque")) {
            const copy = resp.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return resp;
        })
    )
  );
});
