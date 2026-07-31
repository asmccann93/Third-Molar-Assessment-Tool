/* Regression suite for the Local Anaesthetic Maximum Dose calculator.
 *
 *   node tests/regression.js              # against ../index.html
 *   node tests/regression.js some.html    # against a specific build
 *
 * The calculation lives inside index.html rather than in a module, so the suite
 * extracts the script block and evaluates it against a stub DOM. That keeps the
 * shipped file single and self-contained without leaving the arithmetic untested.
 */

"use strict";

var fs = require("fs");
var path = require("path");

var target = process.argv[2]
  ? path.resolve(process.cwd(), process.argv[2])
  : path.resolve(__dirname, "..", "index.html");

var html = fs.readFileSync(target, "utf8");
var swPath = path.resolve(path.dirname(target), "sw.js");
var sw = fs.existsSync(swPath) ? fs.readFileSync(swPath, "utf8") : null;

var failures = [];
var checks = 0;

function ok(label, condition, detail) {
  checks++;
  if (!condition) failures.push(label + (detail ? "  (" + detail + ")" : ""));
}

function near(label, actual, expected, tolerance) {
  checks++;
  var diff = Math.abs(actual - expected);
  if (!(diff <= tolerance)) {
    failures.push(label + "  (got " + actual + ", expected ~" + expected + ")");
  }
}

/* ---------- 1. the two version strings must agree ----------
   index.html holds APP_VERSION, sw.js holds the cache name. Nothing else keeps
   them in step, and a stale cache name leaves installed users on an old build. */

var appVersion = (html.match(/APP_VERSION\s*=\s*"([^"]+)"/) || [])[1];
ok("index.html declares APP_VERSION", !!appVersion);

if (sw && appVersion) {
  var cacheName = (sw.match(/CACHE\s*=\s*"([^"]+)"/) || [])[1];
  var expected = "la-v" + appVersion.replace(/\./g, "-");
  ok("sw.js cache name matches APP_VERSION", cacheName === expected,
     "sw.js has " + cacheName + ", expected " + expected);

  /* activate must only clear this tool's caches. The three tools share an origin,
     so a blanket delete takes out the other two. */
  ok("sw.js activate is scoped to this tool's caches",
     /indexOf\(\s*"la-"\s*\)\s*===\s*0/.test(sw),
     "no la- prefix guard found in activate");
}

/* ---------- 2. load the calculation out of the page ---------- */

var scripts = html.match(/<script>([\s\S]*?)<\/script>/g) || [];
var appScript = scripts[scripts.length - 1].replace(/^<script>/, "").replace(/<\/script>$/, "");

var stub = new Proxy({}, {
  get: function (t, p) {
    if (p === "textContent" || p === "innerHTML" || p === "value") return "";
    if (p === "style") return {};
    return function () { return stub; };
  },
  set: function () { return true; }
});
global.document = {
  getElementById: function () { return stub; },
  querySelectorAll: function () { return []; },
  addEventListener: function () {}
};
global.window = { print: function () {} };

var sandbox = {};
(function () {
  /* indirect eval so the script's var declarations land somewhere we can read */
  var exported = new Function(appScript + "\nreturn {" +
    "AGENTS:AGENTS, CARTRIDGE_ML:CARTRIDGE_ML, floorTo:floorTo," +
    "weightProblem:weightProblem, anaestheticLimit:anaestheticLimit," +
    "mixLoad:mixLoad, headroom:headroom };");
  sandbox = exported();
})();

var AGENTS = sandbox.AGENTS;
var floorTo = sandbox.floorTo;
var weightProblem = sandbox.weightProblem;
var anaestheticLimit = sandbox.anaestheticLimit;
var mixLoad = sandbox.mixLoad;
var headroom = sandbox.headroom;
var agent = function (id) {
  for (var i = 0; i < AGENTS.length; i++) if (AGENTS[i].id === id) return AGENTS[i];
  return null;
};

/* ---------- 3. the agent registry ---------- */

ok("cartridge volume is the UK 2.2 ml", sandbox.CARTRIDGE_ML === 2.2,
   "got " + sandbox.CARTRIDGE_ML);

var ids = {};
AGENTS.forEach(function (a) {
  ok("agent id is unique: " + a.id, !ids[a.id]);
  ids[a.id] = 1;
  ok(a.id + " declares a drug family", !!a.drug);
  ok(a.id + " has a positive concentration", a.mgPerMl > 0);
  ok(a.id + " has a positive mg/kg", a.mgPerKg > 0);
  ok(a.id + " has an absolute cap", a.capMg > 0);
});

/* Two presentations of one molecule must share one allowance. If their mg/kg or
   cap ever diverge, the additive model silently gives the patient two budgets. */
var byDrug = {};
AGENTS.forEach(function (a) { (byDrug[a.drug] = byDrug[a.drug] || []).push(a); });
Object.keys(byDrug).forEach(function (drug) {
  var group = byDrug[drug];
  for (var i = 1; i < group.length; i++) {
    ok(drug + ": presentations share one mg/kg", group[i].mgPerKg === group[0].mgPerKg);
    ok(drug + ": presentations share one cap", group[i].capMg === group[0].capMg);
    ok(drug + ": presentations share one paediatric mg/kg",
       group[i].childMgPerKg === group[0].childMgPerKg);
  }
});

/* ---------- 4. never round a maximum upwards ---------- */

ok("floorTo does not round up", floorTo(1.99, 1) === 1.9, "got " + floorTo(1.99, 1));
ok("floorTo handles exact values", floorTo(2.0, 1) === 2.0);
ok("floorTo to whole numbers", floorTo(6.99, 0) === 6);

/* ---------- 5. weight guards ---------- */

ok("empty weight is not an error", weightProblem("") === null);
ok("zero weight is rejected", weightProblem("0") !== null);
ok("negative weight is rejected", weightProblem("-5") !== null);
ok("non-numeric weight is rejected", weightProblem("abc") !== null);
ok("implausible weight is rejected", weightProblem("300") !== null);
ok("a normal adult weight passes", weightProblem("70") === null);

/* ---------- 6. solo limits, 70 kg adult ----------
   Figures follow standard UK dental school teaching. If the table is re-signed
   against a different source these expectations move with it. */

near("lidocaine 70 kg capped at 300 mg",
     anaestheticLimit(agent("lido2adr80"), 70, false).maxMg, 300, 0.001);
near("articaine 70 kg is weight-limited at 490 mg",
     anaestheticLimit(agent("artic4adr100"), 70, false).maxMg, 490, 0.001);
near("prilocaine 70 kg capped at 400 mg",
     anaestheticLimit(agent("prilo4plain"), 70, false).maxMg, 400, 0.001);
near("mepivacaine 70 kg capped at 300 mg",
     anaestheticLimit(agent("mepi3plain"), 70, false).maxMg, 300, 0.001);

ok("lidocaine 70 kg is cap-limited, not weight-limited",
   anaestheticLimit(agent("lido2adr80"), 70, false).cappedByAbsolute === true);
ok("articaine 70 kg is weight-limited, not cap-limited",
   anaestheticLimit(agent("artic4adr100"), 70, false).cappedByAbsolute === false);

/* ---------- 7. the additive mix ---------- */

var solo = mixLoad([{ agentId: "lido2adr80", cartridges: 6.8 }], 70, false, false);
near("lidocaine alone near its ceiling reads ~100%", solo.laFraction * 100, 99.7, 0.3);

var mixed = mixLoad([
  { agentId: "lido2adr80", cartridges: 3.4 },
  { agentId: "artic4adr100", cartridges: 2.75 }
], 70, false, false);
near("half lidocaine plus half articaine is a full dose", mixed.laFraction * 100, 99.3, 0.5);
ok("a mix is not treated as two separate budgets", mixed.laFraction > 0.9);

var sameDrug = mixLoad([
  { agentId: "artic4adr100", cartridges: 2.75 },
  { agentId: "artic4adr200", cartridges: 2.75 }
], 70, false, false);
near("two articaine presentations share one allowance", sameDrug.laFraction * 100, 98.8, 0.5);

/* ---------- 8. adrenaline governs where it should ---------- */

var cardiac = mixLoad([{ agentId: "lido2adr80", cartridges: 2 }], 70, false, true);
ok("cardiac patient is governed by adrenaline, not the anaesthetic",
   cardiac.governedBy === "adrenaline");
ok("cardiac patient exceeds the ceiling at two cartridges", cardiac.load > 1);
near("two cartridges of 1:80,000 is 55 ug adrenaline", cardiac.adrenalineUg, 55, 0.01);

var healthy = mixLoad([{ agentId: "lido2adr80", cartridges: 2 }], 70, false, false);
ok("the same dose is fine without cardiac disease", healthy.load < 1);

/* ---------- 9. headroom ---------- */

var after = mixLoad([{ agentId: "lido2adr80", cartridges: 2 }], 70, false, false);
var leftLido = headroom(agent("lido2adr80"), 70, false, false, after);
near("headroom after 2 lidocaine leaves ~4.8 more", leftLido, 4.8, 0.1);

var full = mixLoad([{ agentId: "lido2adr80", cartridges: 6.9 }], 70, false, false);
AGENTS.forEach(function (a) {
  ok("no headroom remains once the limit is passed: " + a.id,
     headroom(a, 70, false, false, full) <= 0.001);
});

var cardiacRoom = headroom(agent("lido2adr80"), 70, false, true,
  mixLoad([{ agentId: "lido2adr80", cartridges: 1 }], 70, false, true));
ok("headroom respects the adrenaline ceiling, not just the anaesthetic",
   cardiacRoom < 1, "got " + cardiacRoom);

/* ---------- report ---------- */

if (failures.length) {
  console.error("\nFAILED  " + failures.length + " of " + checks + " checks\n");
  failures.forEach(function (f) { console.error("  - " + f); });
  process.exit(1);
}
console.log("passed  " + checks + " checks  (" + path.basename(target) + ", v" + appVersion + ")");
