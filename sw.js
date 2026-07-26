/* Root service worker — a kill switch, not a cache.
 *
 * The third molar tool used to live at the site root, so anyone who visited
 * before still has a service worker registered at scope "/". That scope covers
 * the whole domain, including /third-molar/ and /sedation/, and its offline
 * fallback resolves to the root index — so a sedation URL could serve the
 * third molar app when the connection drops.
 *
 * Browsers re-check this file automatically. Serving this version replaces the
 * old worker and unregisters it, after which each tool's own worker takes over
 * within its own folder.
 *
 * It deliberately does NOT touch caches. Caches are shared across the whole
 * origin, so clearing them here would destroy the caches belonging to the two
 * tools. Each tool cleans up its own versions, namespaced by prefix.
 *
 * It also does not force open tabs to reload. An assessment in progress is held
 * in memory, so a forced reload would discard the clinician's work.
 *
 * Keep this file here permanently. Removing it would 404 and leave the old
 * worker in place on any browser that has not yet updated.
 */

self.addEventListener("install", function () {
  self.skipWaiting();
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    self.registration.unregister().catch(function () { /* already gone */ })
  );
});
