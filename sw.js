const CACHE = "tma-hub-v15";

/* Paths this worker must never handle: the gated tools, bare or slashed, and
   the API. site-check.js runs this worker against these paths, bare, slashed
   and deeper, and fails if it answers any of them. */
const SKIP = ["/ai-notes", "/implant", "/api"];
const skipped = (path) => SKIP.some((p) => path === p || path.startsWith(p + "/"));

/* What the cache-first branch may store: the hub's own static files. */
const cacheableAsset = (path) =>
  /\.(png|ico|svg|webmanifest|woff2)$/.test(path);

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
      //
      // It must also clear "tma-hub-v14" and earlier: those versions cached GET
      // /api/auth (a session record) and could hold a gated page under its bare
      // path. That is why v15 is a bump and not just an edit.
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k.indexOf("tma-") === 0 && k !== CACHE).map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  // AI Notes is never cached. This worker's scope is the whole origin, so a
  // navigation to /ai-notes/ lands here first and the network-first branch below
  // would put the page in the cache. /ai-notes/sw.js is network-only and scoped
  // more specifically, but it cannot help on the very first visit, before it has
  // installed. Returning without calling respondWith() hands the request back to
  // the browser untouched.
  //
  // This must stay the first statement in the handler. Do not move it below the
  // method check: a non-GET request falls through to the browser anyway, but a
  // future edit that reorders these would silently reopen the hole.
  //
  // The implant tool is gated the same way since 21 September 2026 and is
  // skipped for the same reason: a copy cached here would open without the
  // passcode, on any device that had signed in once.
  //
  // The bare paths count too. "/ai-notes" without the slash is a navigation the
  // browser can make (typed, bookmarked, redirected), and a startsWith("/ai-notes/")
  // test does not match it - so the signed-in page was being cached under that
  // key and opened offline without the passcode.
  //
  // /api/ is never touched either. Those responses are per-session and live:
  // GET /api/auth is a session record, and /api/transcribe?jobId= is polled until
  // it finishes. Cached here, the first would leave a "signed in" record on a
  // device promised to keep nothing, and the second would never complete.
  const url = new URL(e.request.url);
  const path = url.pathname;
  if (skipped(path)) return;

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

  // Cache-first for the hub's own static assets (icons, manifest, fonts), and
  // nothing else. Anything this list does not name - another origin, a script,
  // an API, a data file - goes straight to the browser, uncached. An allowlist,
  // not a blocklist: a new dynamic route must not become cacheable by default.
  if (url.origin !== self.location.origin || !cacheableAsset(path)) return;

  e.respondWith(
    caches.match(e.request).then(
      (cached) =>
        cached ||
        fetch(e.request).then((resp) => {
          // Only a good, same-origin ("basic") response. Opaque cross-origin
          // responses used to be kept for the Google fonts; the fonts are
          // self-hosted since 21 August 2026, so nothing opaque belongs here.
          if (resp && resp.ok && resp.type === "basic") {
            const copy = resp.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return resp;
        })
    )
  );
});
