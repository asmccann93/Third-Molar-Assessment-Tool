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
 * A third failure mode arrived with AI Notes, and it is silent in the other
 * direction: the private tool LEAKING into the public bar. AI Notes is
 * deliberately absent from all five public switchers and must stay that way,
 * so it is checked separately below rather than being added to TOOLS. Adding it
 * there would invert the rule - the cross-check would start demanding an
 * /ai-notes/ link on every public page, which is exactly what must not happen.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

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
  const m = sw && sw.match(/CACHE\s*=\s*"([^"]+)"/);
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
  if (!/<nav class="ostb"/.test(index)) {
    problems.push(`${tool.name}: the switcher bar is missing from index.html`);
  } else {
    for (const other of TOOLS) {
      const linked = new RegExp(`href="${other.href.replace(/\//g, "\\/")}"`).test(index);
      if (!linked) {
        problems.push(
          `${tool.name}: the switcher has no link to ${other.name} (${other.href}). ` +
            `That tool will vanish from the bar on this page only.`
        );
      }
    }
    const marked = index.match(/href="([^"]+)"\s+aria-current="page"/);
    if (!marked) problems.push(`${tool.name}: no switcher link is marked aria-current="page"`);
    else if (marked[1] !== tool.href) {
      problems.push(
        `${tool.name}: aria-current is on "${marked[1]}" but this page is "${tool.href}"`
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
  if (!/<nav class="ostb"/.test(gatedIndex)) {
    problems.push(`${GATED.name}: the switcher bar is missing from index.html`);
  } else {
    for (const other of TOOLS) {
      const linked = new RegExp(`href="${other.href.replace(/\//g, "\\/")}"`).test(gatedIndex);
      if (!linked) {
        problems.push(`${GATED.name}: the switcher has no link to ${other.name} (${other.href})`);
      }
    }
    const marked = gatedIndex.match(/href="([^"]+)"\s+aria-current="page"/);
    if (!marked) problems.push(`${GATED.name}: no switcher link is marked aria-current="page"`);
    else if (marked[1] !== GATED.href) {
      problems.push(`${GATED.name}: aria-current is on "${marked[1]}" but this page is "${GATED.href}"`);
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

/* --- 4. the private tool must not leak into the public bar ------------------
   The inverse of check 2. A stray link here would put a passcode-gated clinical
   tool in front of every visitor and every crawler. */
for (const tool of TOOLS) {
  const index = read(path.join(root, tool.dir, "index.html"));
  if (index && new RegExp(`href="${GATED.href.replace(/\//g, "\\/")}"`).test(index)) {
    problems.push(
      `${tool.name}: links to ${GATED.href}. That tool is private and must not appear ` +
        `in any public switcher. Remove the link.`
    );
  }
}

/* --- report --- */
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

console.log("\n  Site check passed: hub and four tools, switchers complete, caches in step,\n  AI Notes gated and storing nothing.\n");
process.exit(0);
