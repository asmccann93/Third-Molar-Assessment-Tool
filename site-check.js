#!/usr/bin/env node
/**
 * oralsurgeryassess.com - site check
 *
 *   node site-check.js <site-root>            verify
 *   node site-check.js <site-root> --record   accept the current state as the baseline
 *
 * The hub at / and four tools share this origin, each a self-contained index.html
 * with its own service worker. Two failure modes have already bitten this site, and both are
 * silent - the app looks fine, the damage shows up later on someone's device:
 *
 *   1. index.html changes but the service worker CACHE name does not, so
 *      browsers keep serving the old copy from cache indefinitely.
 *   2. A page is deployed carrying an out-of-date switcher, so one tool
 *      disappears from the bar on that page only.
 *
 * This checks for both across the hub and all four tools.
 *
 * AI Notes is the sixth entry in every switcher since 2 September 2026 (a
 * discoverability decision; the passcode gate is the control and is unchanged).
 * It is still checked separately rather than being added to TOOLS, because the
 * other rules do not apply to it: it has no cache and must have none, and it
 * must stay out of the sitemap. Checks 4 and 4a assert the link is present on every
 * public page, so it cannot vanish from one bar only.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const vm = require("vm");

const root = process.argv[2];
const record = process.argv.includes("--record");
/* CI compares cache bumps against git history instead, where the stored
   baseline is stale the moment anything is committed. */
const skipCache = process.argv.includes("--skip-cache");

if (!root) {
  console.error("usage: node site-check.js <site-root> [--record]");
  process.exit(2);
}

/* Each page: where it lives, and the link that should be marked as current. */
const TOOLS = [
  { name: "Overview", dir: ".", href: "/" },
  { name: "Third Molar", dir: "third-molar", href: "/third-molar/" },
  { name: "Sedation", dir: "sedation", href: "/sedation/" },
  { name: "Local Anaesthetic", dir: "local-anaesthetic", href: "/local-anaesthetic/" },
  { name: "ASA Assessment", dir: "asa-assessment", href: "/asa-assessment/" },
];

/* The private tool. Not a member of TOOLS on purpose - see the header note.
   Its sw.js has no CACHE name because it caches nothing, which is the point,
   so the cache-bump rule does not apply to it and the reverse is asserted. */
const GATED = { name: "AI Notes", dir: "ai-notes", href: "/ai-notes/" };

const FINGERPRINTS = path.join(root, "site-fingerprints.json");
const problems = [];
const notes = [];

const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null);

/** Hash the page ignoring nothing: any byte change counts as a content change. */
const hash = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);

/* Source with comments removed. The AI Notes checks below search for the NAMES
   of forbidden APIs, and those names legitimately appear in the comments that
   explain why they are absent. Without this, the file's own documentation
   fails the check. */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const cacheNameOf = (sw) => {
  // Either quote style: a worker that declared its cache with single quotes
  // used to read as having no cache at all, which is the wrong way round for
  // the tools that must not have one.
  const m = sw && sw.match(/CACHE\s*=\s*["']([^"']+)["']/);
  return m ? m[1] : null;
};

/* The switcher bar itself: the contents of <nav class="ostb">, with HTML
   comments removed. The link checks look ONLY here. They used to search the
   whole page, and the hub's cards carry the same hrefs, so a link could vanish
   from the hub's bar while the check stayed green. */
const navBar = (html) => {
  const m = html && html.replace(/<!--[\s\S]*?-->/g, "").match(/<nav class="ostb"[^>]*>([\s\S]*?)<\/nav>/);
  return m ? m[1] : null;
};
const barLinks = (bar, href) => bar.includes(`href="${href}"`);
const barCurrent = (bar) => {
  const m = bar.match(/href="([^"]+)"\s+aria-current="page"/);
  return m ? m[1] : null;
};

const previous = fs.existsSync(FINGERPRINTS) ? JSON.parse(read(FINGERPRINTS)) : {};
const current = {};

for (const tool of TOOLS) {
  const dir = path.join(root, tool.dir);
  const indexPath = path.join(dir, "index.html");
  const swPath = path.join(dir, "sw.js");

  const index = read(indexPath);
  if (!index) {
    problems.push(`${tool.name}: no index.html at ${path.relative(root, indexPath)}`);
    continue;
  }
  const sw = read(swPath);
  const cache = cacheNameOf(sw);
  if (!cache) problems.push(`${tool.name}: could not read the CACHE name from sw.js`);

  current[tool.dir] = { hash: hash(index), cache };

  /* --- 1. content changed without a cache bump --- */
  const before = skipCache ? null : previous[tool.dir];
  if (before) {
    const changed = before.hash !== current[tool.dir].hash;
    const bumped = before.cache !== current[tool.dir].cache;
    if (changed && !bumped) {
      problems.push(
        `${tool.name}: index.html changed but the cache name is still "${cache}". ` +
          `Installed browsers will keep serving the old page. Bump it in ${tool.dir}/sw.js.`
      );
    }
    if (changed && bumped) notes.push(`${tool.name}: content changed, cache bumped to "${cache}"`);
    if (!changed && bumped) notes.push(`${tool.name}: cache bumped to "${cache}" with no content change`);
  }

  /* --- 2. switcher completeness and current-page marking --- */
  const bar = navBar(index);
  if (!bar) {
    problems.push(`${tool.name}: the switcher bar is missing from index.html`);
  } else {
    for (const other of TOOLS) {
      if (!barLinks(bar, other.href)) {
        problems.push(
          `${tool.name}: the switcher has no link to ${other.name} (${other.href}). ` +
            `That tool will vanish from the bar on this page only.`
        );
      }
    }
    const marked = barCurrent(bar);
    if (!marked) problems.push(`${tool.name}: no switcher link is marked aria-current="page"`);
    else if (marked !== tool.href) {
      problems.push(
        `${tool.name}: aria-current is on "${marked}" but this page is "${tool.href}"`
      );
    }
  }
}

/* --- 3. the private tool ---------------------------------------------------
   Absent is fine: this script still has to run against trees from before AI
   Notes existed, and against the four public tools on their own. Present means
   fully checked. */
const gatedIndexPath = path.join(root, GATED.dir, "index.html");
const gatedIndex = read(gatedIndexPath);

if (!gatedIndex) {
  notes.push(`${GATED.name}: not present in this tree, skipped`);
} else {
  current[GATED.dir] = { hash: hash(gatedIndex), cache: null };

  /* 3a. Its own switcher carries every public tool, and marks itself. This is
     the one page whose bar differs from the other five. */
  const gatedBar = navBar(gatedIndex);
  if (!gatedBar) {
    problems.push(`${GATED.name}: the switcher bar is missing from index.html`);
  } else {
    for (const other of TOOLS) {
      if (!barLinks(gatedBar, other.href)) {
        problems.push(`${GATED.name}: the switcher has no link to ${other.name} (${other.href})`);
      }
    }
    const marked = barCurrent(gatedBar);
    if (!marked) problems.push(`${GATED.name}: no switcher link is marked aria-current="page"`);
    else if (marked !== GATED.href) {
      problems.push(`${GATED.name}: aria-current is on "${marked}" but this page is "${GATED.href}"`);
    }
  }

  /* 3b. It must persist nothing. The other tools are checked for HAVING a cache;
     this one is checked for having none. An offline-first cache on a page that
     must keep nothing is the whole risk this tool was designed around. */
  const gatedSwRaw = read(path.join(root, GATED.dir, "sw.js"));
  const gatedSw = gatedSwRaw && stripComments(gatedSwRaw);
  if (!gatedSwRaw) {
    problems.push(`${GATED.name}: sw.js is missing. Without it the hub worker at scope "/" claims this path and will cache the page.`);
  } else {
    if (cacheNameOf(gatedSw)) {
      problems.push(`${GATED.name}: sw.js declares a CACHE name. This worker must be network-only.`);
    }
    if (/caches\s*\.\s*(open|match|keys|delete)/.test(gatedSw)) {
      problems.push(`${GATED.name}: sw.js uses the Cache API. This worker must store nothing.`);
    }
    if (/respondWith/.test(gatedSw)) {
      problems.push(`${GATED.name}: sw.js calls respondWith. It must hand every request straight back to the browser.`);
    }
  }

  /* 3c. No browser storage of any kind on the page itself. */
  const gatedCode = stripComments(gatedIndex);
  const storage = ["localStorage", "sessionStorage", "indexedDB"].filter((api) =>
    new RegExp(`\\b${api}\\b`).test(gatedCode)
  );
  for (const api of storage) {
    problems.push(`${GATED.name}: index.html references ${api}. Nothing may be persisted.`);
  }
}

/* --- 3d. and it must not be in the sitemap --------------------------------- */
const sitemap = read(path.join(root, "sitemap.xml"));
if (sitemap && sitemap.includes(GATED.dir)) {
  problems.push(
    `sitemap.xml lists ${GATED.href}. That tool is private - submitting it to ` +
      `search engines is the opposite of what the 401 and the noindex header are for.`
  );
}

/* --- 4. the gated tool is in every public bar --------------------------------
   Same failure mode as check 2, for the one entry TOOLS does not cover: a page
   deployed with a five-entry bar drops AI Notes on that page only. Until
   2 September 2026 this check asserted the opposite. */
for (const tool of TOOLS) {
  const bar = navBar(read(path.join(root, tool.dir, "index.html")));
  if (bar && !barLinks(bar, GATED.href)) {
    problems.push(
      `${tool.name}: the switcher has no link to ${GATED.name} (${GATED.href}). ` +
        `That tool will vanish from the bar on this page only.`
    );
  }
}

const PREVIEW = [{ name: "Implant", dir: "implant", href: "/implant/", gate: "IMPLANT_USERS" }];

/* --- 3e. the hub's worker must not cache a gated tool, or the API -------------
   Its scope is the whole origin, so on the very first visit to a gated page,
   before that page's own worker has installed, the hub worker is the one that
   sees the request. Unless it steps aside, the signed-in page goes into its
   cache and opens without the passcode from then on. It skipped AI Notes; it
   did not skip the implant tool until 21 September 2026.

   This used to be a text search for startsWith("/ai-notes/"), which passed
   while the bare path "/ai-notes" and every /api/ request (a GET /api/auth
   session record, /api/transcribe polls) were still being cached. It now RUNS
   the worker in a sandbox with fake caches and a fake network, fires fetch
   events at it, and asserts on what it actually does. */
const ORIGIN = "https://oralsurgeryassess.com";
async function checkHubWorker() {
  const src = read(path.join(root, "sw.js"));
  if (!src) { problems.push("Hub sw.js is missing."); return; }
  const hubCache = cacheNameOf(src);

  const handlers = {};
  const puts = [];
  const deleted = [];
  let keys = [];
  const cacheObj = (name) => ({
    put: async (req) => { puts.push(`${name} ${req.url || req}`); },
    add: async () => {}, addAll: async () => {}, match: async () => undefined,
  });
  const caches = {
    open: async (name) => cacheObj(name),
    match: async () => undefined,
    keys: async () => keys.slice(),
    delete: async (k) => { deleted.push(k); return true; },
  };
  const response = (url) => {
    const same = new URL(url).origin === ORIGIN;
    return { ok: same, status: same ? 200 : 0, type: same ? "basic" : "opaque", url, clone() { return this; } };
  };
  const self = {
    addEventListener: (type, fn) => { handlers[type] = fn; },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
    location: new URL(ORIGIN + "/sw.js"),
    caches,
  };
  try {
    vm.runInNewContext(src, {
      self, caches, fetch: async (req) => response(req.url || String(req)),
      URL, Response, Request, Headers, Promise, console, setTimeout,
    }, { timeout: 2000 });
  } catch (err) {
    problems.push(`Hub sw.js could not be run for checking: ${err.message}`);
    return;
  }
  if (!handlers.fetch) { problems.push("Hub sw.js registers no fetch handler."); return; }
  const settle = () => new Promise((r) => setImmediate(r));

  /* One request through the handler: did it answer, and what did it store? */
  async function fire(url, mode) {
    const before = puts.length;
    let responded = null;
    const event = {
      request: { url, method: "GET", mode, headers: new Headers() },
      respondWith: (p) => { responded = Promise.resolve(p); },
      waitUntil: () => {},
    };
    handlers.fetch(event);
    if (responded) await responded.catch(() => {});
    for (let i = 0; i < 5; i++) await settle();
    return { responded: !!responded, stored: puts.slice(before) };
  }

  /* Must be left entirely to the browser: every gated tool, bare, slashed and
     deeper (a .png under it included, which the asset rule would otherwise
     take), and the whole of /api/. As a navigation and as a subresource. */
  const hands_off = [];
  for (const gated of [GATED].concat(PREVIEW)) {
    const bare = gated.href.replace(/\/$/, "");
    hands_off.push(bare, gated.href, gated.href + "index.html", gated.href + "icon.png", bare + "?x=1");
  }
  hands_off.push("/api", "/api/", "/api/auth", "/api/transcribe?jobId=J1", "/api/x.png");
  const handled = [];
  for (const p of hands_off) {
    const modes = [];
    for (const mode of ["navigate", "cors", "no-cors"]) {
      const r = await fire(ORIGIN + p, mode);
      if (r.responded || r.stored.length) modes.push(mode + (r.stored.length ? ", cached" : ""));
    }
    if (modes.length) handled.push(`${p} (${modes.join("; ")})`);
  }
  if (handled.length) {
    problems.push(
      `Hub sw.js handles requests it must leave alone: ${handled.join(", ")}. ` +
        `It must return before respondWith() for the gated tools, bare or slashed, and for /api/: ` +
        `a cached gated page opens without the passcode, and a cached API answer is a stale session.`
    );
  }

  /* The cache-first branch stores the hub's static files only: not an
     arbitrary same-origin route, not another origin. */
  for (const u of [ORIGIN + "/some-route?x=1", ORIGIN + "/data.json", "https://example.com/font.woff2"]) {
    const r = await fire(u, "no-cors");
    if (r.stored.length) problems.push(`Hub sw.js caches ${u}. The cache-first branch may only keep the hub's own static files.`);
  }

  /* And it still does its job, or the checks above prove nothing. */
  const home = await fire(ORIGIN + "/", "navigate");
  if (!home.responded || !home.stored.length) problems.push("Hub sw.js no longer caches the hub page on a navigation to /. The hub has lost its offline copy.");
  const icon = await fire(ORIGIN + "/icon-192.png", "no-cors");
  if (!icon.responded || !icon.stored.length) problems.push("Hub sw.js no longer caches /icon-192.png. The hub's static assets have lost their offline copy.");

  /* Activation clears every older hub cache (older ones may hold a cached
     /api/auth or a gated page) and nobody else's. */
  if (handlers.activate && hubCache) {
    keys = ["tma-hub-v1", "tma-hub-v14", hubCache, "tm-v1-4-25-g", "sedation-v11", "la-v0-14-2-i", "asa-v14"];
    let done = null;
    handlers.activate({ waitUntil: (p) => { done = Promise.resolve(p); } });
    if (done) await done.catch(() => {});
    for (let i = 0; i < 5; i++) await settle();
    for (const k of keys) {
      const hubOld = k.indexOf("tma-hub-") === 0 && k !== hubCache;
      if (hubOld && !deleted.includes(k)) problems.push(`Hub sw.js does not delete the old cache "${k}" on activation.`);
      if (!hubOld && deleted.includes(k)) problems.push(`Hub sw.js deletes "${k}" on activation. It may only clear its own old versions.`);
    }
  } else {
    problems.push("Hub sw.js registers no activate handler, so old hub caches are never cleared.");
  }
}

/* --- 4a. the 404 page carries the same bar -----------------------------------
   It is a page a colleague reaches by mistyping a URL, which is exactly when a
   complete bar is worth having, and nothing checked it until 20 September 2026
   (it had been missing AI Notes since 2 September). */
const notFound = read(path.join(root, "404.html"));
const notFoundBar = navBar(notFound);
if (notFound && !notFoundBar) problems.push(`404.html: the switcher bar is missing.`);
if (notFoundBar) {
  for (const other of TOOLS.concat([GATED], PREVIEW)) {
    if (!barLinks(notFoundBar, other.href)) {
      problems.push(`404.html: the switcher has no link to ${other.name} (${other.href}).`);
    }
  }
}

/* --- 4b. both extra tools have a card on the hub ------------------------------
   The bar is easy to miss on a phone, where it scrolls. Since 20 September 2026
   the hub lists AI Notes and the preview tool as cards too, at the clinical
   lead's request. A card is a promise about what the tool is: the preview one
   must say so on its face. */
const hub = read(path.join(root, "index.html"));
// HTML comments removed first, as check 5 does for the robots tag: a card that
// has been commented out is not a card, and commenting a block out is the
// obvious way to roll something back in a repo edited through the web UI.
const hubLive = hub ? hub.replace(/<!--[\s\S]*?-->/g, "") : null;
function hubCard(href) {
  const m = hubLive && hubLive.match(new RegExp(`<a class="tool" href="${href}"[\\s\\S]*?<\\/a>`));
  return m ? m[0] : null;
}
if (hub && !hubCard(GATED.href)) {
  problems.push(`${GATED.name}: has no card on the hub. It is in the bar only, which scrolls out of sight on a phone.`);
}

/* --- 5. tools in preview ----------------------------------------------------
   A tool being built lives at its final path but is not yet a member of TOOLS.
   Since 20 September 2026 a preview tool IS linked from every switcher, at the
   clinical lead's request, and since that evening it is also GATED: a valid
   passcode plus a name on its own list. Listed but shut, in other words, which
   is why the link is allowed to exist at all. Absent is fine. Present means:
   noindex on, out of the sitemap, gated in middleware.js with its own list,
   headers in vercel.json, NO offline cache, nothing stored, a complete bar of
   its own, a link in every other bar, and a card on the hub carrying its tags.
   At launch, move the entry into TOOLS and delete it from here. */
for (const tool of PREVIEW) {
  const index = read(path.join(root, tool.dir, "index.html"));
  if (!index) { notes.push(`${tool.name}: not present in this tree, skipped`); continue; }
  // HTML comments removed first: a robots tag that has been commented out is not a robots tag.
  const live = index.replace(/<!--[\s\S]*?-->/g, "");
  if (!/<meta name="robots" content="noindex/.test(live)) {
    problems.push(`${tool.name}: is in preview but has no noindex meta tag. It would be indexed before its content is reviewed.`);
  }
  if (sitemap && sitemap.includes(tool.href)) {
    problems.push(`${tool.name}: is in preview but listed in sitemap.xml.`);
  }
  /* Gated since 20 September 2026, so it is checked the way AI Notes is: it
     must keep NO offline copy. A cached page opens without the passcode on any
     device that signed in once, which would quietly undo the gate. */
  const swRaw = read(path.join(root, tool.dir, "sw.js"));
  const sw = swRaw && stripComments(swRaw);
  if (!swRaw) {
    problems.push(`${tool.name}: sw.js is missing. Without it the hub worker at scope "/" claims this path and will cache the page.`);
  } else {
    if (cacheNameOf(sw)) problems.push(`${tool.name}: sw.js declares a CACHE name. While the tool is gated this worker must be network-only.`);
    if (/respondWith/.test(sw)) problems.push(`${tool.name}: sw.js calls respondWith. It must hand every request straight back to the browser.`);
    if (/caches\s*\.\s*(open|match|put|add)/.test(sw)) problems.push(`${tool.name}: sw.js fills a cache. While the tool is gated it may only delete.`);
  }
  // And the gate itself: the matcher is the only thing standing in front of it.
  const mw = read(path.join(root, "middleware.js"));
  if (mw) {
    if (!mw.includes(`'${tool.href}:path*'`)) {
      problems.push(`${tool.name}: middleware.js does not gate ${tool.href}. The preview would be open to anyone with the link.`);
    }
    if (!mw.includes(tool.gate)) {
      problems.push(`${tool.name}: middleware.js no longer names ${tool.gate}, so nothing restricts which signed-in person may open it.`);
    }
  }
  const headers = read(path.join(root, "vercel.json"));
  if (headers && !headers.includes(`"/implant/:path*"`)) {
    problems.push(`${tool.name}: vercel.json has no header block for ${tool.href}; the gated page would be cacheable and indexable by header.`);
  }

  const code = stripComments(index);
  for (const api of ["localStorage", "sessionStorage", "indexedDB"]) {
    if (new RegExp(`\\b${api}\\b`).test(code)) problems.push(`${tool.name}: index.html references ${api}. It promises to store nothing.`);
  }
  const ownBar = navBar(index);
  if (!ownBar) problems.push(`${tool.name}: the switcher bar is missing from index.html`);
  for (const other of ownBar ? TOOLS.concat([GATED, tool]) : []) {
    if (!barLinks(ownBar, other.href)) {
      problems.push(`${tool.name}: its switcher has no link to ${other.name} (${other.href}).`);
    }
  }
  if (ownBar && barCurrent(ownBar) !== tool.href) problems.push(`${tool.name}: its own switcher link is not marked aria-current="page".`);
  // Linked from every other bar, exactly like a launched tool: the same
  // failure mode as check 4, so it is checked the same way.
  for (const other of TOOLS.concat([GATED])) {
    const otherBar = navBar(read(path.join(root, other.dir, "index.html")));
    if (otherBar && !barLinks(otherBar, tool.href)) {
      problems.push(`${other.name}: the switcher has no link to ${tool.name} (${tool.href}). That tool will vanish from the bar on this page only.`);
    }
  }
  // The banner is what tells a colleague the figures are drafts. It is the
  // whole reason the tool can be listed at all while it is in preview.
  const banner = live.match(/<div class="preview"[^>]*>([\s\S]*?)<\/div>/);
  if (!banner || !/not for clinical use/i.test(banner[1]) || !/draft/i.test(banner[1])) {
    problems.push(`${tool.name}: is linked from every bar but its preview banner is gone. Restore it, or launch the tool properly (move it into TOOLS).`);
  }
  const card = hubCard(tool.href);
  if (hub && !card) {
    problems.push(`${tool.name}: has no card on the hub. It is in the bar only, which scrolls out of sight on a phone.`);
  } else if (card && !/class="tool-tag preview"/.test(card)) {
    problems.push(`${tool.name}: its hub card does not carry the Preview tag, so it reads as a finished tool.`);
  } else if (card && !/Sign-in required/.test(card)) {
    problems.push(`${tool.name}: its hub card does not say a sign-in is required, so the passcode prompt will look like a fault.`);
  }
  notes.push(`${tool.name}: in preview, gated (noindex, not in the sitemap, no offline copy, linked from every bar, tagged on the hub)`);
}

/* --- report --- */
checkHubWorker().then(report, (err) => {
  problems.push(`Hub sw.js check crashed: ${err && err.stack}`);
  report();
});

function report() {
  console.log("");
  for (const n of notes) console.log("  " + n);

  if (record) {
    fs.writeFileSync(FINGERPRINTS, JSON.stringify(current, null, 2) + "\n");
    console.log(`\n  Baseline recorded in ${path.basename(FINGERPRINTS)}:`);
    for (const [dir, v] of Object.entries(current)) {
      console.log(`    ${dir.padEnd(20)} ${v.hash}  ${v.cache}`);
    }
    console.log("");
    process.exit(0);
  }

  if (problems.length) {
    console.log("\n  SITE CHECK FAILED\n");
    for (const p of problems) console.log("  - " + p);
    console.log("");
    process.exit(1);
  }

  console.log("\n  Site check passed: hub and four tools, switchers complete, caches in step,\n  AI Notes and the implant preview listed on the hub and in every bar, gated and storing nothing.\n");
  process.exit(0);
}
