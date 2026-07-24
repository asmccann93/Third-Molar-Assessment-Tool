/**
 * Third Molar Assessment Tool - regression suite
 *
 * Every test pins a bug that was found and fixed. A failure means it has come back.
 *
 *   node tests/regression.js            # against ../index.html
 *   node tests/regression.js path.html  # against a specific build
 *
 * Needs only the `playwright` package. Exits non-zero if anything fails, so it can
 * gate a deploy.
 */
const path = require("path");
const { chromium } = require("playwright");
const { describe, it, run, assert } = require("./harness");

const target = process.argv[2] || path.resolve(__dirname, "..", "index.html");
const APP = target.startsWith("file://") ? target : "file://" + path.resolve(target);
const STATE_KEY = "third-molar-assessment-state-v1";
const ASSESSOR_KEY = "third-molar-assessment-assessor-v1";
const HISTORY_KEY = "third-molar-assessment-history-v1";

/* Answers use the stable option ids, not the wording shown on screen. */
const BASE = {
  tooth: "48 (lower right)",
  ageGroup: "18 to 25",
  justification: "Yes",
  radiograph: "Yes",
  radiographImage: null,
  medicalHistory: "No",
  medicalItems: [],
  smoker: "No",
  alcohol: "No",
  alcoholOver14: null,
  rootMorphology: "straight",
  angulation: "vertical",
  depth: "depthA",
  spaceAvailable: "classI",
  sinusProximity: null,
  buccalPalatal: null,
  ianSigns: [],
  mouthOpening: "No",
  assessor: "",
};

/* A fresh, unanswered assessment. Seeding with BASE would count as work in
   progress and trigger the discard confirmation when opening history. */
const BLANK = Object.keys(BASE).reduce((acc, k) => {
  acc[k] = Array.isArray(BASE[k]) ? [] : k === "assessor" ? "" : null;
  return acc;
}, {});

const UPPER = { ...BASE, tooth: "18 (upper right)", spaceAvailable: null, sinusProximity: "sinusSeparate", buccalPalatal: "buccal" };

async function seed(page, answers, { step = 13, finished = true, history = null } = {}) {
  await page.goto(APP);
  await page.evaluate(
    ([state, hist, sk, hk]) => {
      localStorage.clear();
      localStorage.setItem(sk, JSON.stringify(state));
      if (hist) localStorage.setItem(hk, JSON.stringify(hist));
    },
    [{ step, halted: false, finished, openedFromHistory: false, started: true, answers }, history, STATE_KEY, HISTORY_KEY]
  );
  await page.reload();
  await page.waitForTimeout(450);
}

const text = (page) => page.evaluate(() => document.body.innerText);
const answersOf = (page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k)).answers, STATE_KEY);

/** Answer the first option of every question group on screen that is still blank. */
const answerBlankGroups = (page) =>
  page.evaluate(() => {
    const groups = new Map();
    document.querySelectorAll("button[aria-pressed]").forEach((b) => {
      if (!groups.has(b.parentElement)) groups.set(b.parentElement, []);
      groups.get(b.parentElement).push(b);
    });
    let n = 0;
    groups.forEach((btns) => {
      if (!btns.some((b) => b.getAttribute("aria-pressed") === "true")) { btns[0].click(); n++; }
    });
    return n;
  });

const HISTORY_ENTRY = {
  id: 99,
  date: "2026-01-05T10:00:00.000Z",
  tooth: "18 (upper right)",
  total: 5,
  category: "Moderate difficulty",
  version: "1.4.7",
  answers: { ...UPPER, sinusProximity: "sinusClose", assessor: "Mr A McCann" },
};

/* ------------------------------------------------------------------ */
describe("Arch separation", () => {
  it("a lower tooth reports no maxillary findings", async (page) => {
    await seed(page, { ...BASE, sinusProximity: "sinusInto", buccalPalatal: "palatal" });
    const t = await text(page);
    assert.ok(!/antrum/i.test(t), "sinus finding leaked onto a lower tooth");
    assert.ok(!/lies palatally/i.test(t), "palatal finding leaked onto a lower tooth");
  });

  it("an upper tooth reports no IAN findings", async (page) => {
    await seed(page, { ...UPPER, ianSigns: ["darkRoot", "deflection"] }, { step: 11 });
    const t = await text(page);
    assert.ok(!/inferior alveolar nerve/i.test(t), "IAN finding leaked onto an upper tooth");
    assert.ok(!/coronectomy/i.test(t), "coronectomy suggested for an upper tooth");
  });

  it("switching arch clears the other arch's answers and keeps shared ones", async (page) => {
    await seed(page, { ...UPPER, sinusProximity: "sinusInto", buccalPalatal: "palatal", ianSigns: ["darkRoot"] }, { step: 0, finished: false });
    await page.getByRole("button", { name: /^48/ }).first().click();
    await page.waitForTimeout(400);
    const a = await answersOf(page);
    assert.equal(a.sinusProximity, null);
    assert.equal(a.buccalPalatal, null);
    assert.deepEqual(a.ianSigns, []);
    assert.equal(a.angulation, "vertical", "shared answers should survive an arch change");
  });
});

/* ------------------------------------------------------------------ */
describe("Scoring and referral", () => {
  const CASES = [
    [3, "vertical", "depthA", "classI", "Minimal", /general dental practitioner/],
    [4, "mesioangular", "depthA", "classI", "Minimal", /general dental practitioner/],
    [5, "horizontal", "depthA", "classI", "Moderate", /\(DWSI\) in Oral Surgery\./],
    [6, "distoangular", "depthA", "classI", "Moderate", /\(DWSI\) in Oral Surgery\./],
    [7, "distoangular", "depthB", "classI", "High", /or a Specialist Oral Surgeon/],
    [8, "distoangular", "depthC", "classI", "High", /or a Specialist Oral Surgeon/],
    [9, "distoangular", "depthC", "classII", "High", /Refer to a Specialist Oral Surgeon\./],
    [10, "distoangular", "depthC", "classIII", "High", /Refer to a Specialist Oral Surgeon\./],
  ];
  for (const [total, angulation, depth, spaceAvailable, category, referral] of CASES) {
    it(`score ${total} gives ${category} difficulty and the matching tier`, async (page) => {
      await seed(page, { ...BASE, angulation, depth, spaceAvailable });
      const t = await text(page);
      assert.ok(t.includes(`${category} difficulty`), `expected ${category} difficulty`);
      assert.ok(referral.test(t), "referral tier did not match the difficulty band");
    });
  }

  it("a medical factor escalates the tier and only the responsible factor is named", async (page) => {
    await seed(page, { ...BASE, angulation: "distoangular", depth: "depthC", spaceAvailable: "classI", medicalHistory: "Yes", medicalItems: ["bisphosphonates", "chemoRadio"] });
    const t = await text(page);
    assert.ok(/Refer to a Specialist Oral Surgeon\./.test(t));
    const note = (t.match(/Escalated above the surgical difficulty score due to:[^\n]*/) || [""])[0];
    assert.ok(/chemotherapy/i.test(note), "the escalating factor should be named");
    assert.ok(!/bisphosphonate/i.test(note), "a factor below the score tier should not be named");
  });

  it("a factor that changes nothing produces no escalation note", async (page) => {
    await seed(page, { ...BASE, medicalHistory: "Yes", medicalItems: ["diabetes"] });
    assert.ok(!/Escalated above/.test(await text(page)));
  });
});

/* ------------------------------------------------------------------ */
describe("Coronectomy prompt", () => {
  const countOccurrences = (t) => (t.match(/Coronectomy should be considered/g) || []).length;

  it("fires for multiple IAN signs even at a shallow depth", async (page) => {
    await seed(page, { ...BASE, depth: "depthA", ianSigns: ["darkRoot", "deflection"] });
    const t = await text(page);
    assert.ok(/Coronectomy should be considered/.test(t), "no coronectomy prompt for 2 signs");
    assert.ok(/Multiple radiographic signs/.test(t), "wording should not claim a deep impaction");
    assert.equal(countOccurrences(t), 1, "the prompt should appear once");
  });

  it("fires for a single sign at Position C", async (page) => {
    await seed(page, { ...BASE, depth: "depthC", ianSigns: ["darkRoot"] });
    const t = await text(page);
    assert.ok(/Deep impaction combined with/.test(t), "expected the deep-impaction wording");
    assert.equal(countOccurrences(t), 1, "the prompt should appear once");
  });

  it("appears only once when both triggers apply", async (page) => {
    await seed(page, { ...BASE, depth: "depthC", ianSigns: ["darkRoot", "deflection", "narrowing"] });
    const t = await text(page);
    assert.equal(countOccurrences(t), 1, "both triggers should still give a single prompt");
    assert.ok(/Deep impaction combined with/.test(t), "the deep-impaction wording should take precedence");
  });

  it("does not fire for a single sign at a shallow depth", async (page) => {
    await seed(page, { ...BASE, depth: "depthA", ianSigns: ["darkRoot"] });
    const t = await text(page);
    assert.ok(/One radiographic sign/.test(t), "the single-sign finding should still appear");
    assert.equal(countOccurrences(t), 0, "one sign at a shallow depth should not prompt coronectomy");
  });

  it("never fires on an upper tooth", async (page) => {
    await seed(page, { ...UPPER, depth: "depthC", ianSigns: ["darkRoot", "deflection"] }, { step: 11 });
    assert.equal(countOccurrences(await text(page)), 0);
  });
});

/* ------------------------------------------------------------------ */
describe("History", () => {
  it("reopening an upper entry returns to a maxillary question", async (page) => {
    await seed(page, BLANK, { step: 0, finished: false, history: [HISTORY_ENTRY] });
    await page.getByRole("button", { name: /^View$/ }).first().click();
    await page.waitForTimeout(400);
    await page.getByRole("button", { name: /Back to questions/i }).click();
    await page.waitForTimeout(400);
    const heading = await page.evaluate(() => document.querySelector("h2").innerText);
    assert.ok(/maxillary/i.test(heading), `landed on "${heading}" instead of a maxillary step`);
  });

  it("an assessment in progress is not discarded without asking", async (page) => {
    await seed(page, { ...BASE, tooth: "38 (lower left)", angulation: "horizontal", smoker: "Yes" }, { step: 0, finished: false, history: [HISTORY_ENTRY] });
    page.once("dialog", (d) => d.dismiss());
    await page.getByRole("button", { name: /^View$/ }).first().click();
    await page.waitForTimeout(350);
    assert.equal((await answersOf(page)).angulation, "horizontal", "cancelling should preserve work in progress");
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: /^View$/ }).first().click();
    await page.waitForTimeout(450);
    assert.equal((await answersOf(page)).angulation, "vertical", "confirming should load the entry");
  });

  it("a reopened entry is dated, and stops being dated once it is edited", async (page) => {
    await seed(page, BLANK, { step: 0, finished: false, history: [HISTORY_ENTRY] });
    await page.getByRole("button", { name: /^View$/ }).first().click();
    await page.waitForTimeout(400);
    let t = await text(page);
    assert.ok(/Previously recorded assessment/.test(t), "a past assessment should be labelled as one");
    assert.ok(!/\\u2013/.test(t) && !/\\u/.test(t), "an escape sequence is being printed literally");
    assert.ok(/5 January 2026/.test(t), "the recorded date should be shown");

    await page.getByRole("button", { name: /Back to questions/i }).click();
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: /^(Continue|View summary)/ }).first().click();
    await page.waitForTimeout(400);
    t = await text(page);
    assert.ok(!/Previously recorded assessment/.test(t), "an edited assessment must not keep the old date");
  });

  it("assess other side works in all four quadrants", async (page) => {
    const pairs = [
      ["18 (upper right)", "28 (upper left)"],
      ["28 (upper left)", "18 (upper right)"],
      ["38 (lower left)", "48 (lower right)"],
      ["48 (lower right)", "38 (lower left)"],
    ];
    for (const [from, to] of pairs) {
      const upper = /^[12]/.test(from);
      await seed(page, { ...(upper ? UPPER : BASE), tooth: from }, { step: upper ? 11 : 13 });
      await page.getByRole("button", { name: /Assess other side/i }).click();
      await page.waitForTimeout(400);
      assert.equal((await answersOf(page)).tooth, to, `${from} should offer ${to}`);
    }
  });
});

/* ------------------------------------------------------------------ */
describe("Saved data from earlier builds", () => {
  it("unknown medical or IAN ids do not blank the app", async (page) => {
    await seed(page, { ...BASE, medicalHistory: "Yes", medicalItems: ["diabetes", "warfarin_LEGACY_ID"], ianSigns: ["darkRoot", "legacy_sign"] });
    const t = await text(page);
    assert.ok(/Assessment summary/i.test(t), "app failed to render with unknown ids");
    assert.ok(/diabetes/i.test(t), "recognised items should still be listed");
  });

  it("answers stored as wording still score", async (page) => {
    await seed(page, {
      ...BASE,
      angulation: "Vertical",
      depth: "Level with or above the occlusal surface of the adjacent second molar",
      spaceAvailable: "Class I \u2014 adequate space between the ramus and the distal of the second molar",
      rootMorphology: "Curved / Dilacerated",
    });
    const t = await text(page);
    assert.ok(!/Provisional/i.test(t), "legacy wording should still produce a score");
    assert.ok(/Minimal difficulty/.test(t));
    assert.ok(/dilacerated/i.test(t), "the root morphology finding should still fire");
  });

  it("an option value that cannot be read is reported, not dropped in silence", async (page) => {
    await seed(page, { ...BASE, spaceAvailable: "Class IV \u2013 an option from some older build" });
    const t = await text(page);
    assert.ok(/could not be read/.test(t), "the summary should say an answer was lost");
    assert.ok(/Re-enter the affected steps/.test(t));
  });

  it("re-answering a step clears its unreadable warning", async (page) => {
    await seed(page, { ...BASE, spaceAvailable: "Class IV \u2013 an option from some older build" }, { step: 12 });
    assert.ok(/could not be read/.test(await text(page)), "the warning should appear first");

    await page.getByRole("button", { name: /Back to questions/i }).click();
    await page.waitForTimeout(300);
    await page.locator("button[aria-pressed]").first().click();
    await page.waitForTimeout(250);
    for (let i = 0; i < 5; i++) {
      const next = page.getByRole("button", { name: /^(Continue|View summary)/ }).first();
      if ((await next.count()) === 0 || (await next.isDisabled())) break;
      await next.click();
      await page.waitForTimeout(280);
      if (/Assessment summary/i.test(await text(page))) break;
    }
    const t = await text(page);
    assert.ok(/Assessment summary/i.test(t), "should be back on the summary");
    assert.ok(/difficulty/.test(t), "the score should be restored");
    assert.ok(!/could not be read/.test(t), "the warning must clear once the step is re-answered");
  });

  it("an unreadable flag alone is not work in progress", async (page) => {
    await seed(page, { ...BLANK, spaceAvailable: "Class IV \u2013 unreadable" }, { step: 0, finished: false, history: [HISTORY_ENTRY] });
    let prompted = false;
    page.once("dialog", (d) => { prompted = true; d.dismiss(); });
    await page.getByRole("button", { name: /^View$/ }).first().click();
    await page.waitForTimeout(500);
    assert.equal(prompted, false, "there is no work in progress to discard");
  });

  it("a restored step that these answers cannot show falls back", async (page) => {
    // step 9 is a radiographic, maxillary step; these answers are lower arch with no radiograph
    await seed(page, { ...BASE, radiograph: "No" }, { step: 9, finished: false });
    const heading = await page.evaluate(() => document.querySelector("h2").innerText);
    assert.ok(!/buccal|palatal|sinus|maxillary/i.test(heading), `showed "${heading}", a step this assessment skips`);
  });

  it("a corrupt saved state offers a way out instead of a blank page", async (page) => {
    page.__allowPageErrors = true; // this test provokes the crash on purpose
    await page.goto(APP);
    await page.evaluate((k) => {
      localStorage.clear();
      localStorage.setItem(k, JSON.stringify({ step: 2, halted: false, finished: false, openedFromHistory: false, started: true, answers: { tooth: { notAString: true }, medicalItems: [], ianSigns: [] } }));
    }, STATE_KEY);
    await page.reload();
    await page.waitForTimeout(600);
    assert.ok(/Something went wrong/.test(await text(page)), "no error boundary shown");
    await page.getByRole("button", { name: /Clear saved data and start again/i }).click();
    await page.waitForTimeout(800);
    assert.ok(/Third Molar Assessment Tool/.test(await text(page)), "recovery did not restore the app");
  });
});

/* ------------------------------------------------------------------ */
describe("Journeys", () => {
  it("a full lower-arch assessment reaches the summary", async (page) => {
    await page.goto(APP);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForTimeout(400);
    await page.getByRole("button", { name: /Begin assessment/i }).click();
    await page.waitForTimeout(250);
    await page.getByRole("button", { name: /^48/ }).first().click();
    let reached = false;
    for (let i = 0; i < 16 && !reached; i++) {
      let next = page.getByRole("button", { name: /^(Continue|View summary)/ }).first();
      if ((await next.count()) === 0) break;
      for (let a = 0; a < 3 && (await next.isDisabled()); a++) {
        await answerBlankGroups(page);
        await page.waitForTimeout(200);
        next = page.getByRole("button", { name: /^(Continue|View summary)/ }).first();
      }
      assert.ok(!(await next.isDisabled()), "could not advance past a step");
      await next.click();
      await page.waitForTimeout(280);
      reached = /Assessment summary/i.test(await text(page));
    }
    assert.ok(reached, "never reached the summary");
  });

  it("no radiograph gives a provisional summary with no score", async (page) => {
    await seed(page, { ...BASE, radiograph: "No", rootMorphology: null, angulation: null, depth: null, spaceAvailable: null }, { step: 6 });
    const t = await text(page);
    assert.ok(/Provisional/i.test(t));
    assert.ok(!/Surgical Difficulty Score:/.test(t));
  });

  it("no justification halts the assessment", async (page) => {
    await seed(page, { ...BASE, justification: "No" }, { step: 1, finished: false });
    await page.getByRole("button", { name: /^Continue/ }).first().click();
    await page.waitForTimeout(400);
    assert.ok(/Extraction not currently justified/i.test(await text(page)));
  });
});

/* ------------------------------------------------------------------ */
describe("Screen changes", () => {
  it("moves focus to the new question heading", async (page) => {
    await seed(page, { ...BASE, angulation: null }, { step: 8, finished: false });
    const before = await page.evaluate(() => document.activeElement.tagName);
    await page.locator("button[aria-pressed]").first().click();
    await page.waitForTimeout(200);
    await page.getByRole("button", { name: /^(Continue|View summary)/ }).first().click();
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => ({
      tag: document.activeElement.tagName,
      text: (document.activeElement.innerText || "").trim().slice(0, 40),
      heading: document.querySelector("h2").innerText.slice(0, 40),
    }));
    assert.equal(after.tag, "H2", `focus stayed on ${before} instead of moving to the heading`);
    assert.equal(after.text, after.heading, "focus should be on the heading of the step now shown");
  });

  it("returns to the top of the page on a screen change", async (page) => {
    await seed(page, { ...BASE, medicalItems: [] }, { step: 4, finished: false });
    await page.evaluate(() => window.scrollTo(0, 400));
    await page.waitForTimeout(150);
    await page.locator("button[aria-pressed]").first().click();
    await page.waitForTimeout(200);
    await page.getByRole("button", { name: /^(Continue|View summary)/ }).first().click();
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => window.scrollY), 0, "the next question should start at the top");
  });

  it("does not steal focus on first load", async (page) => {
    await seed(page, { ...BASE, angulation: null }, { step: 8, finished: false });
    const tag = await page.evaluate(() => document.activeElement.tagName);
    assert.equal(tag, "BODY", `focus moved to ${tag} on load; it should stay on the document`);
  });

  it("moves focus to the summary heading when the assessment finishes", async (page) => {
    await seed(page, BASE, { step: 13, finished: false });
    await page.getByRole("button", { name: /^(Continue|View summary)/ }).first().click();
    await page.waitForTimeout(500);
    const focused = await page.evaluate(() => (document.activeElement.innerText || "").trim());
    assert.ok(/surgical risk profile/i.test(focused), `focus landed on "${focused}"`);
  });
});

/* ------------------------------------------------------------------ */
describe("History housekeeping and the clinician name", () => {
  const entries = [1, 2, 3].map((n) => ({
    ...HISTORY_ENTRY,
    id: n,
    date: `2026-01-0${n}T10:00:00.000Z`,
  }));

  it("clears the whole history, but only after confirming", async (page) => {
    await seed(page, BLANK, { step: 0, finished: false, history: entries });
    const count = () => page.evaluate(() => document.querySelectorAll("button").length);
    const stored = () => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || "[]").length, HISTORY_KEY);
    assert.equal(await stored(), 3);

    page.once("dialog", (d) => {
      assert.ok(/all 3 saved assessments/i.test(d.message()), `prompt read: ${d.message()}`);
      d.dismiss();
    });
    await page.getByRole("button", { name: /^Clear all$/ }).click();
    await page.waitForTimeout(300);
    assert.equal(await stored(), 3, "cancelling must keep the history");

    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: /^Clear all$/ }).click();
    await page.waitForTimeout(400);
    assert.equal(await stored(), 0, "confirming should remove every entry");
    assert.ok(!/Previous assessments/.test(await text(page)), "the panel should disappear when empty");
    assert.ok((await count()) > 0);
  });

  it("remembers the clinician name for the next assessment", async (page) => {
    await seed(page, BASE);
    await page.locator('input[type="text"]').first().fill("Mr A McCann");
    await page.waitForTimeout(300);
    assert.equal(
      await page.evaluate((k) => localStorage.getItem(k), ASSESSOR_KEY),
      "Mr A McCann",
      "the name should be recorded as it is typed"
    );

    await page.getByRole("button", { name: /Start new assessment/i }).click();
    await page.waitForTimeout(500);
    const carried = await page.evaluate(
      (k) => JSON.parse(localStorage.getItem(k)).answers.assessor,
      STATE_KEY
    );
    assert.equal(carried, "Mr A McCann", "a new assessment should start with the name filled in");

    // and it must not drag any of the clinical answers along with it
    const a = await answersOf(page);
    assert.equal(a.angulation, null);
    assert.equal(a.tooth, null);
  });

  it("a past assessment keeps whoever recorded it", async (page) => {
    await page.goto(APP);
    await page.evaluate(() => localStorage.setItem("third-molar-assessment-assessor-v1", "Ms B Current"));
    await seed(page, BLANK, {
      step: 0,
      finished: false,
      history: [{ ...HISTORY_ENTRY, answers: { ...HISTORY_ENTRY.answers, assessor: "Mr C Original" } }],
    });
    await page.evaluate(() => localStorage.setItem("third-molar-assessment-assessor-v1", "Ms B Current"));
    await page.getByRole("button", { name: /^View$/ }).first().click();
    await page.waitForTimeout(400);
    const value = await page.locator('input[type="text"]').first().inputValue();
    assert.equal(value, "Mr C Original", "a reopened assessment must not be reattributed");
  });
});

/* ------------------------------------------------------------------ */
describe("Layout and export", () => {
  it("diagrams wrap two-up on a phone", async (page) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await seed(page, { ...BASE, angulation: null }, { step: 8, finished: false });
    const layout = await page.evaluate(() => {
      const row = document.querySelector(".tma-diagrams");
      const kids = Array.from(row.children);
      return {
        widths: kids.map((k) => Math.round(k.getBoundingClientRect().width)),
        rows: new Set(kids.map((k) => Math.round(k.getBoundingClientRect().top))).size,
      };
    });
    assert.equal(layout.rows, 2, "angulation diagrams should wrap onto two rows");
    assert.ok(Math.min(...layout.widths) > 120, `cards too narrow: ${layout.widths.join("/")}px`);
  });

  it("a PDF exports from a reopened history entry", async (page) => {
    await seed(page, BLANK, { step: 0, finished: false, history: [HISTORY_ENTRY] });
    await page.getByRole("button", { name: /^View$/ }).first().click();
    await page.waitForTimeout(400);
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: /Download PDF summary/i }).click(),
    ]);
    assert.ok(/\.pdf$/.test(await download.suggestedFilename()));
  });
});

/* ------------------------------------------------------------------ */
(async () => {
  console.log("Testing " + APP);
  const browser = await chromium.launch();
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1200, height: 1300 } });
  const ok = await run(
    () => context.newPage(),
    (page) => page.close()
  );
  await browser.close();
  process.exit(ok ? 0 : 1);
})();
