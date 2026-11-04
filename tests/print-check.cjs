// tests/print-check.cjs — run with: node tests/print-check.cjs
//
// WHAT REACHES PAPER, checked in a real browser.
//
// NOT part of the CI suite: it needs Chromium, and the workflow has no
// browser. Run it by hand after anything that touches the draft, the derived
// documents or the print rules. It takes about twenty seconds.
//
//   npm install playwright --no-save      (if it is not already there)
//   node tests/print-check.cjs
//
// WHY IT EXISTS. tests/page.mjs checks the print rules by reading the
// stylesheet, because jsdom has no CSS cascade and cannot answer "is this
// element on the paper". That is not the same question, and the difference has
// cost three defects:
//
//   .bpe-note        screen guidance printed onto a clinical record
//   .field.is-na     "not applicable" lines printed onto a clinical record
//   .src             (4 November 2026) "No sources came back for this field.
//                    Read it against What was recorded, on this page." under
//                    EVERY heading of the record — and, when sources did come
//                    back, the patient's verbatim words from the transcript
//
// Each of the first two was found by reading the rules. The third was found by
// printing the page to PDF and reading it, which is what this does.
//
// It drives the real flow: a real recording through the real Opus encoder, the
// real draft, and the real Print buttons. Only window.print is stubbed — the
// browser cannot open a print dialog headless, and printOnly() must still run
// exactly as the button runs it, because the class it sets is the whole
// mechanism.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8749;

const NOTE = {
  reasonForAttendance: 'Pain from the lower left third molar.',
  medicalHistory: 'Ramipril. No allergies reported.',
  proposed: 'Surgical removal of LL8 under local anaesthetic.',
  alternatives: 'Leave it, or a coronectomy.',
  risks: 'Numbness of the lip and chin, swelling, infection, dry socket.',
  benefits: 'Resolution of the pain.', costs: 'NHS band 2.',
  patientQuestions: 'Asked if numbness is permanent.', patientFactors: 'Physical job.',
  informationGiven: 'Written instructions on the day.', decision: 'Proceed.',
  nextStep: 'Book through reception.', examination: null, radiographicFindings: null,
  treatmentToday: 'Surgical removal of LL8.', plan: null, gaps: [], notSaid: [],
  // Sources present, so the per-field panels render their quote lists: those
  // quotes are the patient's own words and must not reach any paper.
  sources: { proposed: ['the lower left wisdom tooth needs to come out'] }
};
const SUMMARY = {
  whatWeDiscussed: 'We talked about the lower left wisdom tooth.',
  whatYouDecided: 'You decided to go ahead with having it taken out.',
  whatHappensNext: 'Reception will book you a surgical appointment.',
  whatToExpect: 'Swelling and soreness for a few days.',
  yourQuestions: 'You asked whether numbness can be permanent.'
};
const POSTOP = {
  expect: 'Some swelling and soreness for two to three days.',
  pain: 'Paracetamol and ibuprofen together if you can take both.',
  bleeding: 'Bite firmly on a clean damp gauze for twenty minutes.',
  careOfSite: 'Warm salty mouthwashes after meals from tomorrow.',
  eating: 'Soft food today.', avoid: 'No smoking or alcohol for 24 hours.',
  whenToWorry: 'Ring the practice if the bleeding does not settle.',
  followUp: 'A review in one week.'
};

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? '\n          ' + detail : ''}`); }
};

async function text(page) {
  // What a reader would see: innerText of everything still rendered.
  return page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim());
}

(async () => {
  const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
    { cwd: ROOT, stdio: 'ignore' });
  const stop = () => { try { server.kill(); } catch {} };
  process.on('exit', stop);
  await new Promise((r) => setTimeout(r, 1200));

  const browser = await chromium.launch({
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']
  });
  try {
    const ctx = await browser.newContext({ viewport: { width: 900, height: 1200 }, permissions: ['microphone'] });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.addInitScript(() => { window.__printed = 0; window.print = () => { window.__printed++; }; });

    await page.route('**/api/auth*', (r) => r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ authenticated: true, who: 'AM', expiresIn: 40000, canSaveLayouts: false, layouts: null }) }));
    await page.route('**/api/checklist*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }));
    await page.route('**/api/transcribe*', (r) => r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ status: 'done', turns: [
        { speaker: 'S1', text: 'The lower left wisdom tooth needs to come out.' },
        { speaker: 'S2', text: 'Will I be numb forever?' }] }) }));
    await page.route('**/api/extract*', async (r) => {
      let kind = '';
      try { kind = JSON.parse(r.request().postData() || '{}').kind || ''; } catch {}
      const body = kind === 'summary' ? { status: 'done', summary: SUMMARY }
        : kind === 'postop' ? { status: 'done', postop: POSTOP }
        : { status: 'done', note: NOTE };
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });

    console.log('\nA real recording, through the real encoder\n------------------------------------------');
    await page.goto(`http://127.0.0.1:${PORT}/ai-notes/index.html`);
    await page.waitForTimeout(900);
    await page.check('#consent');
    await page.click('#types button:has-text("Third molar")');
    await page.click('#start');
    await page.waitForTimeout(2200);
    await page.click('#stop');
    await page.waitForSelector('#draft:not(.hidden)', { timeout: 60000 });
    await page.waitForTimeout(800);
    ok('the draft arrives from a genuinely encoded recording',
      await page.$eval('#fields', (e) => e.textContent.includes('Surgical removal')));
    ok('and the page raised no errors getting there', errors.length === 0, errors.join(' | '));

    console.log('\nThe clinical record on paper\n----------------------------');
    await page.emulateMedia({ media: 'print' });
    const record = await text(page);
    await page.emulateMedia({ media: 'screen' });
    ok('the record itself is on it', /Material risks named/.test(record), record.slice(0, 200));
    /* The rule, stated in the stylesheet since 31 October: WHAT THE COPY
       OMITS, THE PRINT OMITS. Each of these is a line noteAsText has never
       produced. */
    for (const [what, re] of [
      ['per-field source notes', /No sources came back for this field/],
      ['instructions pointing at the screen', /Read it against What was recorded, on this page/],
      ['the "not applicable to this appointment" lines', /Not applicable to this appointment/],
      ['the transcript panel', /What was recorded[\s\S]{0,40}Speaker/]
    ]) {
      ok(`the printed record does not carry ${what}`, !re.test(record),
        (record.match(re) || [''])[0]);
    }
    ok('and carries no verbatim words of the patient',
      !/numb forever/i.test(record), (record.match(/.{40}numb forever.{40}/i) || [''])[0]);

    console.log('\nThe two sheets that go home with the patient\n--------------------------------------------');
    for (const [make, box, printBtn, title] of [
      ['#make-summary', '#summary-box', '#print-summary', 'Patient summary'],
      ['#make-postop', '#postop-box', '#print-postop', 'Post-op instructions']
    ]) {
      await page.click(make);
      await page.waitForSelector(`${box}:not(.hidden)`, { timeout: 40000 });
      await page.waitForTimeout(400);
      await page.click(printBtn);          // the real button: it sets the class
      const armed = await page.evaluate(() => ({ n: window.__printed, cls: document.body.className }));
      ok(`${title}: the Print button asks the browser to print`, armed.n > 0, JSON.stringify(armed));
      await page.emulateMedia({ media: 'print' });
      const sheet = await text(page);
      await page.emulateMedia({ media: 'screen' });
      await page.evaluate(() => document.body.classList.remove('print-summary', 'print-postop'));

      ok(`${title}: the sheet itself is on the paper`, sheet.includes(title), sheet.slice(0, 120));
      /* THE POINT OF THE WHOLE MECHANISM. Handing a patient their post-op
         sheet must not hand them the clinical record with it. */
      for (const [what, needle] of [
        ['the medical history', 'Ramipril'],
        ['the material risks discussion', 'Material risks named'],
        ['what it cost', 'NHS band 2'],
        ['the clinical record heading', 'Draft note'],
        ["the patient's own recorded words", 'numb forever'],
        ['the gap and source panels', 'before you paste']
      ]) {
        ok(`${title}: and not ${what}`, !sheet.includes(needle),
          sheet.includes(needle) ? '…' + sheet.slice(Math.max(0, sheet.indexOf(needle) - 60), sheet.indexOf(needle) + 60) + '…' : '');
      }
      // The other sheet is not on it either: one document per print.
      const other = title === 'Patient summary' ? 'Post-op instructions' : 'Patient summary';
      ok(`${title}: and not the ${other.toLowerCase()}`, !sheet.includes(other));
    }
  } finally {
    await browser.close();
    stop();
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
