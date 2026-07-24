/**
 * A very small test harness, so the suite needs only the `playwright` package
 * and no test runner. Groups run in order; each test gets a fresh page.
 */
const assert = require("node:assert/strict");

const groups = [];
let current = null;

function describe(name, fn) {
  current = { name, tests: [] };
  groups.push(current);
  fn();
  current = null;
}

function it(name, fn) {
  if (!current) throw new Error("it() must be called inside describe()");
  current.tests.push({ name, fn });
}

async function run(makePage, closePage) {
  let passed = 0;
  const failures = [];
  for (const group of groups) {
    console.log("\n" + group.name);
    for (const t of group.tests) {
      const page = await makePage();
      const pageErrors = [];
      page.on("pageerror", (err) => pageErrors.push(err.message.split("\n")[0]));
      try {
        await t.fn(page);
        // A crash the error boundary swallows would otherwise pass unnoticed.
        if (pageErrors.length && !page.__allowPageErrors) {
          throw new Error("uncaught page error: " + pageErrors[0]);
        }
        console.log("  \u2713 " + t.name);
        passed++;
      } catch (err) {
        console.log("  \u2717 " + t.name);
        console.log("      " + String(err.message).split("\n")[0]);
        failures.push(`${group.name} > ${t.name}: ${String(err.message).split("\n")[0]}`);
      } finally {
        await closePage(page);
      }
    }
  }
  const total = passed + failures.length;
  console.log(`\n${passed}/${total} passed`);
  if (failures.length) {
    console.log("\nFailures:");
    failures.forEach((f) => console.log("  - " + f));
  }
  return failures.length === 0;
}

module.exports = { describe, it, run, assert };
