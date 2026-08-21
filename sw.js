const CACHE = "tma-hub-v5";

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(["./", "./index.html"])).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      // Only tidy up THIS page's old versions. Every tool shares this origin and
      // owns its own cache - deleting theirs breaks their offline support until
      // the user next opens them with a signal, which is exactly the situation
      // the offline support exists for. The trailing hyphen matters: "tma-" must
      // not match the third molar tool's "tm-" caches, and vice versa.
      //
      // This does clear "tma-v1-4-*", the caches of the third molar tool that
      // used to live here. That is intended: those installs are not being
      // migrated, and the tool now serves itself from /third-molar/ on "tm-".
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
        .catch(() =>
          caches.match(e.request).then((r) => {
            if (r) return r;
            // This worker's scope is the whole origin, so an offline navigation
            // to a tool page can land here before that tool's own worker has
            // ever run. Serving the hub in its place would look like the tool
            // had been replaced, so fail honestly instead.
            return new URL(e.request.url).pathname === "/"
              ? caches.match("./index.html")
              : Response.error();
          })
        )
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
