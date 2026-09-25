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
    "mixLoad:mixLoad, headroom:headroom," +
    "parseWeight:typeof parseWeight === 'function' ? parseWeight : null," +
    "headroomParts:typeof headroomParts === 'function' ? headroomParts : null };");
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

/* The weight box is text, not type="number": a number field in some locales
   dropped a decimal comma, so "7,5" was used as 75. A comma or a point is a
   decimal separator; anything that is not one plain positive number is refused. */
var parseWeight = sandbox.parseWeight;
ok("the page reads the weight through parseWeight", typeof parseWeight === "function");
ok("the weight field is not type=number",
   !/id="weight"[^>]*type="number"|type="number"[^>]*id="weight"/.test(html));
if (parseWeight) {
  ok("a decimal comma is read as a decimal: 7,5 is 7.5", parseWeight("7,5") === 7.5, "got " + parseWeight("7,5"));
  ok("a decimal point is read: 7.5 is 7.5", parseWeight("7.5") === 7.5);
  ok("surrounding spaces are ignored", parseWeight(" 7.5 ") === 7.5);
  ok("an empty box is not a weight", parseWeight("") === null && parseWeight("  ") === null);
  ["7,5,1", "7.5.1", "7,5.1", "1e2", "70 kg", "7O", "-5", "+70", "abc", "0x20", "Infinity", "1,000", "1.000", "7,500"].forEach(function (t) {
    ok('"' + t + '" is refused, not read as a number', weightProblem(t) !== null, "parsed as " + parseWeight(t));
  });
  ok("7,5 passes the weight check", weightProblem("7,5") === null);
  ok("two decimal places are still read: 7.25 is 7.25", parseWeight("7,25") === 7.25);
  near("7,5 kg gives the 7.5 kg lidocaine limit, not 75 kg",
       anaestheticLimit(agent("lido2adr80"), parseWeight("7,5"), false).maxMg, 52.5, 0.001);
}

/* ---------- 6. solo limits, 70 kg adult ----------
   Lidocaine follows the BNF (500 mg) corroborated by NHS Highland (7 mg/kg). The
   remaining agents still follow dental school teaching and are flagged unverified in
   the interface. If any of them is re-signed against a source, its expectation here
   moves with it - that is the point of pinning them. */

near("lidocaine 70 kg is weight-limited at 490 mg",
     anaestheticLimit(agent("lido2adr80"), 70, false).maxMg, 490, 0.001);
near("lidocaine 100 kg is capped at the BNF 500 mg",
     anaestheticLimit(agent("lido2adr80"), 100, false).maxMg, 500, 0.001);
near("articaine 70 kg is weight-limited at 490 mg",
     anaestheticLimit(agent("artic4adr100"), 70, false).maxMg, 490, 0.001);
near("prilocaine 70 kg capped at 400 mg",
     anaestheticLimit(agent("prilo4plain"), 70, false).maxMg, 400, 0.001);
near("mepivacaine 70 kg capped at 300 mg",
     anaestheticLimit(agent("mepi3plain"), 70, false).maxMg, 300, 0.001);

ok("lidocaine 70 kg is weight-limited, not cap-limited",
   anaestheticLimit(agent("lido2adr80"), 70, false).cappedByAbsolute === false);
ok("lidocaine 100 kg is cap-limited",
   anaestheticLimit(agent("lido2adr80"), 100, false).cappedByAbsolute === true);
ok("articaine 70 kg is weight-limited, not cap-limited",
   anaestheticLimit(agent("artic4adr100"), 70, false).cappedByAbsolute === false);

/* ---------- 7. the additive mix ---------- */

var solo = mixLoad([{ agentId: "lido2adr80", cartridges: 11.1 }], 70, false, false);
near("lidocaine alone near its ceiling reads ~100%", solo.laFraction * 100, 99.6, 0.5);

/* The anaesthetic ceiling is no longer what a healthy adult meets first. */
var lidoAdr = mixLoad([{ agentId: "lido2adr80", cartridges: 7.3 }], 70, false, false);
ok("adrenaline, not lidocaine, governs in a healthy adult",
   lidoAdr.governedBy === "adrenaline");

var mixed = mixLoad([
  { agentId: "lido2adr80", cartridges: 5.57 },
  { agentId: "artic4adr100", cartridges: 2.75 }
], 70, false, false);
near("half lidocaine plus half articaine is a full dose", mixed.laFraction * 100, 99.6, 0.6);
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
/* Capped by the adrenaline ceiling (7.27 total), not by the 11.1 anaesthetic limit. */
near("headroom after 2 lidocaine leaves ~5.3 more", leftLido, 5.27, 0.1);

var full = mixLoad([{ agentId: "lido2adr80", cartridges: 11.2 }], 70, false, false);
AGENTS.forEach(function (a) {
  ok("no headroom remains once the limit is passed: " + a.id,
     headroom(a, 70, false, false, full) <= 0.001);
});

var cardiacRoom = headroom(agent("lido2adr80"), 70, false, true,
  mixLoad([{ agentId: "lido2adr80", cartridges: 1 }], 70, false, true));
ok("headroom respects the adrenaline ceiling, not just the anaesthetic",
   cardiacRoom < 1, "got " + cardiacRoom);

/* ---------- 10. what the page says about the figures it rests on ----------
   These drive the page's rendering, so they are checked in the source: the
   headroom card must mark rows resting on an unverified figure, the warning must
   name the (uncited) adrenaline ceiling, children's age notes must reach the
   headroom rows, and removing a row with cartridges given must ask first. */

var headroomParts = sandbox.headroomParts;
ok("headroom keeps its limits apart, so the page can say which one a row rests on", typeof headroomParts === "function");
if (headroomParts) {
  var fresh = mixLoad([{ agentId: "lido2adr80", cartridges: 0 }], 70, false, false);
  var lp = headroomParts(agent("lido2adr80"), 70, false, false, fresh);
  ok("healthy 70 kg adult, lidocaine: the adrenaline ceiling is what limits headroom",
     lp.byUg !== null && lp.byUg < lp.byLa, JSON.stringify(lp));
  ok("a plain agent has no adrenaline limit", headroomParts(agent("prilo4plain"), 70, false, false, fresh).byUg === null);
  near("headroomParts agrees with headroom", lp.left, headroom(agent("lido2adr80"), 70, false, false, fresh), 1e-12);
}
ok("the headroom card marks rows resting on an unverified figure", /hr-mark/.test(appScript));
ok("the unverified warning names the adrenaline ceiling", /"the adrenaline ceiling \("/.test(appScript));
ok("children's age notes are shown against headroom rows", /isChild && a\.childNote/.test(appScript));
ok("removing a row with cartridges given asks first",
   /else if \(drop\)[\s\S]{0,600}window\.confirm\(/.test(appScript));

/* ---------- report ---------- */

if (failures.length) {
  console.error("\nFAILED  " + failures.length + " of " + checks + " checks\n");
  failures.forEach(function (f) { console.error("  - " + f); });
  process.exit(1);
}
console.log("passed  " + checks + " checks  (" + path.basename(target) + ", v" + appVersion + ")");
