#!/usr/bin/env node
/**
 * oralsurgeryassess.com - site check
 *
 *   node site-check.js <site-root>            verify
 *   node site-check.js <site-root> --record   accept the current state as the baseline
 *
 * Three tools share this origin, each a self-contained index.html with its own
 * service worker. Two failure modes have already bitten this site, and both are
 * silent - the app looks fine, the damage shows up later on someone's device:
 *
 *   1. index.html changes but the service worker CACHE name does not, so
 *      browsers keep serving the old copy from cache indefinitely.
 *   2. A page is deployed carrying an out-of-date switcher, so one tool
 *      disappears from the bar on that page only.
 *
 * This checks for both across all three tools.
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

/* Each tool: where it lives, and the link that should be marked as current. */
const TOOLS = [
  { name: "Third Molar", dir: ".", href: "/" },
  { name: "Sedation", dir: "sedation", href: "/sedation/" },
  { name: "Local Anaesthetic", dir: "local-anaesthetic", href: "/local-anaesthetic/" },
  { name: "ASA Assessment", dir: "asa-assessment", href: "/asa-assessment/" },
];

const FINGERPRINTS = path.join(root, "site-fingerprints.json");
const problems = [];
const notes = [];

const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null);

/** Hash the page ignoring nothing: any byte change counts as a content change. */
const hash = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);

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

console.log("\n  Site check passed: three tools, switchers complete, caches in step.\n");
process.exit(0);
