#!/usr/bin/env node
/**
 * Third Molar Assessment Tool - build
 *
 *   node build.js                 rebuild at the current version
 *   node build.js --bump patch    1.4.7 -> 1.4.8, then rebuild
 *   node build.js --bump minor    1.4.7 -> 1.5.0
 *   node build.js --set 2.0.0     set the version explicitly
 *   node build.js --skip-tests    build without running the regression suite
 *
 * The version lives in one place (APP_VERSION in the source). This script keeps
 * the service worker cache name in step with it, which previously had to be
 * remembered by hand: miss it and installed users keep serving a stale copy.
 *
 * It also checks the zip has no wrapping folder. A nested zip serves index.html
 * at / but leaves manifest.webmanifest under a subfolder, so the home-screen
 * icon fails silently - a bug that previously cost several rounds to find.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = __dirname;
const SOURCE = path.join(ROOT, "bundle_entry.jsx");
const SW = path.join(ROOT, "sw.js");
const HEAD = path.join(ROOT, "html_head.txt");
const TAIL = path.join(ROOT, "html_tail.txt");
const STATIC = path.join(ROOT, "static");
const OUT = path.join(ROOT, "dist");
const PKG = path.join(OUT, "third-molar-assessment");

/* The seven files Vercel serves, flat. */
const DEPLOY_FILES = [
  "index.html",
  "manifest.webmanifest",
  "sw.js",
  "icon-192.png",
  "icon-512.png",
  "icon-maskable-512.png",
  "apple-touch-icon.png",
];

const die = (msg) => {
  console.error("\n  BUILD FAILED: " + msg + "\n");
  process.exit(1);
};
const step = (msg) => console.log("  " + msg);

/* ---------- version ---------- */
function readVersion() {
  const m = fs.readFileSync(SOURCE, "utf8").match(/const APP_VERSION = "([^"]+)";/);
  if (!m) die("APP_VERSION not found in bundle_entry.jsx");
  return m[1];
}

function writeVersion(next) {
  const current = readVersion();
  const cacheName = "tma-v" + next.replace(/\./g, "-");

  let src = fs.readFileSync(SOURCE, "utf8");
  src = src.replace(`const APP_VERSION = "${current}";`, `const APP_VERSION = "${next}";`);
  fs.writeFileSync(SOURCE, src);

  let sw = fs.readFileSync(SW, "utf8");
  const swMatch = sw.match(/const CACHE = "([^"]+)";/);
  if (!swMatch) die("CACHE constant not found in sw.js");
  sw = sw.replace(`const CACHE = "${swMatch[1]}";`, `const CACHE = "${cacheName}";`);
  fs.writeFileSync(SW, sw);

  step(`version ${current} -> ${next}, service worker cache ${cacheName}`);
}

function bump(version, kind) {
  const [maj, min, pat] = version.split(".").map(Number);
  if (kind === "major") return `${maj + 1}.0.0`;
  if (kind === "minor") return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

/* ---------- build ---------- */
function findEsbuild() {
  const roots = [
    path.join(ROOT, "node_modules"),
    ...(process.env.NODE_PATH || "").split(path.delimiter).filter(Boolean),
    path.join(process.env.HOME || "", ".npm-global/lib/node_modules"),
    "/usr/local/lib/node_modules",
  ];
  const relative = [
    path.join(".bin", "esbuild"),
    path.join("esbuild", "bin", "esbuild"),
    path.join("tsx", "node_modules", "@esbuild", "linux-x64", "bin", "esbuild"),
    path.join("tsx", "node_modules", "esbuild", "bin", "esbuild"),
  ];
  for (const root of roots) {
    for (const rel of relative) {
      const candidate = path.join(root, rel);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return "esbuild"; // fall back to PATH
}

function bundle() {
  const nodePath = process.env.NODE_PATH || path.join(process.env.HOME || "", ".npm-global/lib/node_modules");
  execFileSync(
    findEsbuild(),
    [
      "bundle_entry.jsx",
      "--bundle",
      "--minify",
      "--format=iife",
      "--platform=browser",
      '--define:process.env.NODE_ENV="production"',
      "--outfile=bundle.js",
    ],
    { cwd: ROOT, env: { ...process.env, NODE_PATH: nodePath }, stdio: "pipe" }
  );

  const html =
    fs.readFileSync(HEAD, "utf8") + fs.readFileSync(path.join(ROOT, "bundle.js"), "utf8") + fs.readFileSync(TAIL, "utf8");
  fs.writeFileSync(path.join(ROOT, "index.html"), html);
  step(`index.html assembled (${(html.length / 1024 / 1024).toFixed(2)} MB)`);
  return html;
}

/* ---------- checks ---------- */
function verify(html, version) {
  if (!html.includes(version)) die(`index.html does not contain version ${version}`);

  const cache = fs.readFileSync(SW, "utf8").match(/const CACHE = "([^"]+)";/)[1];
  const expected = "tma-v" + version.replace(/\./g, "-");
  if (cache !== expected) die(`sw.js cache is "${cache}" but the version is ${version}. Installed users would keep a stale copy.`);

  const manifest = JSON.parse(fs.readFileSync(path.join(STATIC, "manifest.webmanifest"), "utf8"));
  if (!manifest.icons || !manifest.icons.length) die("manifest has no icons");

  // every diagram that is wired up must be a complete row, or a null src renders a broken image
  const src = fs.readFileSync(SOURCE, "utf8");
  const rows = {
    "lower angulation": ["ANGULATION_VERTICAL", "ANGULATION_MESIOANGULAR", "ANGULATION_DISTOANGULAR", "ANGULATION_HORIZONTAL"],
    "upper angulation": ["U_ANGULATION_VERTICAL", "U_ANGULATION_MESIOANGULAR", "U_ANGULATION_DISTOANGULAR", "U_ANGULATION_HORIZONTAL"],
    "upper depth": ["U_POSITION_A", "U_POSITION_B", "U_POSITION_C"],
    sinus: ["SINUS_SEPARATE_IMG", "SINUS_CLOSE_IMG", "SINUS_INTO_IMG"],
    "buccal/palatal": ["POS_BUCCAL_IMG", "POS_MID_IMG", "POS_PALATAL_IMG"],
  };
  for (const [name, consts] of Object.entries(rows)) {
    const set = consts.filter((c) => new RegExp(`const ${c} = "data:image`).test(src)).length;
    if (set !== 0 && set !== consts.length) {
      die(`the ${name} diagram row is ${set}/${consts.length} filled. Fill a row completely or not at all, or a null src renders a broken image.`);
    }
  }
  // the PDF drops any character outside this set, so both dashes must stay in it
  const charClass = src.match(/String\(t\)\.replace\(\/\[\^([^\]]+)\]/);
  if (!charClass) die("could not find the sanitizePdfText character class");
  for (const [name, esc] of [["en dash", "u2013"], ["em dash", "u2014"]]) {
    if (!charClass[1].includes(esc)) die(`sanitizePdfText no longer permits the ${name}; it would be replaced with "?" in exported PDFs`);
  }

  step("checks passed: version, cache name, manifest, diagram rows, PDF character set");
}

function tests() {
  try {
    execFileSync("node", [path.join(ROOT, "tests", "regression.js")], { cwd: ROOT, stdio: "inherit" });
  } catch (e) {
    die("regression suite failed - see above");
  }
}

/* ---------- package ---------- */
function packageZip(version) {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(PKG, { recursive: true });

  for (const f of DEPLOY_FILES) {
    const from = fs.existsSync(path.join(ROOT, f)) ? path.join(ROOT, f) : path.join(STATIC, f);
    if (!fs.existsSync(from)) die(`missing deploy file: ${f}`);
    fs.copyFileSync(from, path.join(PKG, f));
  }

  execFileSync("zip", ["-q", "-X", "-r", path.join(OUT, "third-molar-assessment.zip"), "."], { cwd: PKG });

  // the zip must be flat: a wrapping folder breaks the manifest and the icon
  const listing = execFileSync("unzip", ["-Z1", path.join(OUT, "third-molar-assessment.zip")], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const nested = listing.filter((n) => n.includes("/"));
  if (nested.length) die(`the zip has a wrapping folder (${nested[0]}). Vercel would 404 the manifest and the home-screen icon would fail silently.`);
  if (listing.length !== DEPLOY_FILES.length) die(`expected ${DEPLOY_FILES.length} files in the zip, found ${listing.length}`);

  step(`dist/third-molar-assessment.zip - ${listing.length} files, flat`);
  console.log(`\n  Ready to deploy v${version}\n`);
}

/* ---------- main ---------- */
(function main() {
  const args = process.argv.slice(2);
  const bumpIdx = args.indexOf("--bump");
  const setIdx = args.indexOf("--set");

  console.log("\nThird Molar Assessment Tool - build\n");

  let version = readVersion();
  if (setIdx !== -1) {
    version = args[setIdx + 1];
    if (!/^\d+\.\d+\.\d+$/.test(version || "")) die("--set needs a version like 2.0.0");
    writeVersion(version);
  } else if (bumpIdx !== -1) {
    version = bump(version, args[bumpIdx + 1] || "patch");
    writeVersion(version);
  } else {
    writeVersion(version); // still forces the cache name into step
  }

  const html = bundle();
  verify(html, version);
  if (!args.includes("--skip-tests")) tests();
  packageZip(version);
})();
