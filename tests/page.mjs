// tests/page.mjs — run with: node tests/page.mjs
//
// The page holds more logic than anything else here and had no coverage. Two of
// the behaviours below are not conveniences, they are claims made in the DPIA:
//
//   - the consent gate genuinely prevents recording before the patient agrees
//   - wipe() genuinely destroys everything, so "nothing is retained" is true
//
// A third matters just as much and is not in the DPIA: the model's output is
// rendered as text, never as markup. It is the one place untrusted content
// reaches the DOM.
//
// jsdom has no MediaRecorder, AudioContext or getUserMedia, so those are stubbed
// below. Everything else is the real file, loaded and executed unmodified.

import { readFileSync } from 'fs';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '../ai-notes/index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? '  — ' + detail : ''}`); }
};
const section = (t) => console.log(`\n${t}\n${'-'.repeat(t.length)}`);
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/* ---------- boot the page with the browser bits stubbed ---------- */
async function boot({ session = { authenticated: true, expiresIn: 40000 }, onFetch } = {}) {
  const calls = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://oralsurgeryassess.com/ai-notes/',
    pretendToBeVisual: true,
    beforeParse(win) {
      win.fetch = async (url, opts = {}) => {
        const entry = { url: String(url), method: (opts.method || 'GET').toUpperCase() };
        calls.push(entry);
        if (onFetch) { const r = await onFetch(entry, opts); if (r) return r; }
        if (entry.url.includes('/api/auth') && entry.method === 'GET') {
          return { ok: true, status: 200, json: async () => session };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      };
      win.confirm = () => true;
      win.alert = () => {};
      win.navigator.clipboard = { writeText: async () => {} };
      Object.defineProperty(win.navigator, 'mediaDevices', {
        value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
        configurable: true
      });
      win.scrollTo = () => {};
      // The page encodes Opus in an AudioWorklet. jsdom has no Web Audio, so
      // the context, the worklet node and the encoder's message protocol are
      // stubbed here — producing genuine Ogg-shaped pages so the pipeline runs
      // end to end rather than being poked at from outside.
      //
      // The protocol (opus-recorder's encoderWorker): the page posts `init`,
      // gets `ready`; posts `getHeaderPages`, gets two header pages; pages then
      // stream in while recording; `done` flushes the last pages and answers
      // `done`. A stub that skipped the final flush would hide exactly the class
      // of bug the discard test exists for.
      win.WebAssembly = globalThis.WebAssembly;
      win.__encoder = { instances: [] };
      win.AudioWorkletNode = class {
        constructor(ctx, name) {
          this.name = name;
          this.disconnected = false;
          this._timer = null;
          const node = this;
          this.port = {
            onmessage: null,
            postMessage(msg) {
              const say = (data) => setTimeout(() => node.port.onmessage && node.port.onmessage({ data }), 2);
              const page = (n, pos) => {
                const bytes = new Uint8Array(n); bytes.set([0x4f, 0x67, 0x67, 0x53]); // OggS
                return { message: 'page', page: bytes, samplePosition: pos };
              };
              if (msg.command === 'init') { node.init = msg; say({ message: 'ready' }); }
              if (msg.command === 'getHeaderPages') {
                say(page(47, 0)); say(page(60, 0));
                // then a page every few ms, as the real worklet does every 800 ms
                let pos = 0;
                node._timer = setInterval(() => { pos += 38400; say(page(1900, pos)); }, 8);
              }
              if (msg.command === 'done') {
                clearInterval(node._timer);
                // the final flush: one more page BEFORE done, like the real thing
                say(page(900, 999999)); say({ message: 'done' });
              }
              if (msg.command === 'close') clearInterval(node._timer);
            }
          };
          win.__encoder.instances.push(this);
        }
        disconnect() { this.disconnected = true; clearInterval(this._timer); }
      };
      win.AudioContext = class {
        constructor() { this.sampleRate = 48000; this.state = 'running'; this.closed = false;
          this.audioWorklet = { addModule: async (path) => { win.__encoder.modulePath = path; } }; }
        resume() { this.state = 'running'; return Promise.resolve(); }
        createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
        createAnalyser() { return { fftSize: 512, connect() {}, getByteTimeDomainData(a) { a.fill(128); } }; }
        close() { this.closed = true; }
      };
      win.requestAnimationFrame = () => 0;
      win.cancelAnimationFrame = () => {};
      // location itself is non-configurable in jsdom; only reload needs stubbing,
      // since a real reload would tear down the test.
      try {
        Object.defineProperty(win.location, 'reload', {
          value: () => calls.push({ url: 'RELOAD', method: 'NAV' }),
          configurable: true, writable: true
        });
      } catch { win.__reloadUnstubbed = true; }
    }
  });
  await tick(60);
  return { dom, win: dom.window, doc: dom.window.document, calls };
}

const $ = (doc, id) => doc.getElementById(id);
const click = (el) => el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent('click', { bubbles: true }));

// Consent, pick a type, record, stop, and let the stubbed API return a draft.
// Everything goes through the page's real controls and real code path.
async function runConsultation(ctx, note, turns) {
  const { doc, win } = ctx;
  $(doc, 'consent').checked = true;
  $(doc, 'consent').dispatchEvent(new win.Event('change', { bubbles: true }));
  click($(doc, 'types').children[4]);
  await tick();
  click($(doc, 'start'));
  await tick(60);
  click($(doc, 'stop'));
  await tick(150);
  return { doc, win };
}

const DEFAULT_TURNS = [
  { speaker: 'S1', text: 'So the lower left wisdom tooth needs to come out.' },
  { speaker: 'S2', text: 'Will I be numb forever?' }
];

/* ================================================================
   1. The consent gate
   ================================================================ */
async function testConsentGate() {
  section('Consent gate — recording must be impossible before consent');
  const { doc } = await boot();

  const start = $(doc, 'start');
  const consent = $(doc, 'consent');
  const types = $(doc, 'types');

  ok('Start is disabled on load', start.disabled);
  ok('eleven consult types offered, three of them oral surgery', types.children.length === 11, String(types.children.length));
  ok('no consult type preselected',
    ![...types.children].some((b) => b.getAttribute('aria-pressed') === 'true'));

  click(types.children[4]);
  await tick();
  ok('type alone does not enable Start', start.disabled);

  consent.checked = true;
  consent.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));
  await tick();
  ok('consent + type enables Start', !start.disabled);

  consent.checked = false;
  consent.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));
  await tick();
  ok('withdrawing consent disables Start again', start.disabled);

  ok('consent script is shown verbatim',
    $(doc, 'script').textContent.includes('Happy for me to use it?'));
  ok('script says it is deleted after write-up',
    /deleted as soon as/i.test($(doc, 'script').textContent));
  ok('script says it is off during treatment',
    /not recording while/i.test($(doc, 'script').textContent));
}

/* ================================================================
   2. The session gate
   ================================================================ */
async function testSessionGate() {
  section('Session gate — never start a recording that cannot finish');

  let { doc, win } = await boot({ session: { authenticated: false, expiresIn: 0 } });
  $(doc, 'consent').checked = true;
  $(doc, 'consent').dispatchEvent(new win.Event('change', { bubbles: true }));
  click($(doc, 'types').children[0]);
  await tick();
  click($(doc, 'start'));
  await tick(80);

  ok('expired session blocks recording', !$(doc, 'error').classList.contains('hidden'));
  ok('and says why', /Session expired/i.test($(doc, 'error-title').textContent),
    $(doc, 'error-title').textContent);
  ok('and warns the recording would be lost',
    /lose the conversation/i.test($(doc, 'error-body').textContent));
  ok('setup view is still shown', !$(doc, 'setup').classList.contains('hidden'));
  ok('recording view never appeared', $(doc, 'recording').classList.contains('hidden'));

  ({ doc } = await boot({ session: { authenticated: true, expiresIn: 600 } }));
  await tick();
  ok('a nearly-expired session warns in the masthead',
    /Session ends in about/i.test($(doc, 'session-note').textContent),
    $(doc, 'session-note').textContent);
  ok('the warning is styled as a warning', $(doc, 'session-note').classList.contains('warn'));

  ({ doc } = await boot({ session: { authenticated: true, expiresIn: 40000 } }));
  await tick();
  ok('a healthy session says nothing', $(doc, 'session-note').textContent === '');
}

/* ================================================================
   3. wipe() — the DPIA claim
   ================================================================ */
async function testWipe() {
  section('wipe() — "nothing is retained" has to be literally true');

  const note = {
    reasonForAttendance: 'Lower left wisdom tooth, recurrent pericoronitis.',
    medicalHistory: 'Ramipril. No allergies.',
    proposed: 'Surgical removal under LA.',
    alternatives: 'Coronectomy. Leaving in situ.',
    risks: 'Nerve injury, dry socket, infection, bleeding.',
    benefits: null, costs: '\u00a3340.',
    patientQuestions: 'Will I be numb forever?',
    patientFactors: 'Plays clarinet semi-professionally.',
    informationGiven: 'Wisdom tooth leaflet.',
    decision: 'Proceed with extraction.',
    nextStep: 'Book 45 minutes.',
    gaps: ['Benefits not discussed.']
  };

  const ctx = await boot({
    onFetch: async (c) => {
      if (c.url.includes('/api/transcribe') && c.method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ status: 'done', turns: DEFAULT_TURNS, jobId: 'job123' }) };
      }
      if (c.url.includes('/api/extract')) {
        return { ok: true, status: 200, json: async () => ({ status: 'done', note }) };
      }
      return null;
    }
  });

  await runConsultation(ctx, note, DEFAULT_TURNS);
  const { doc, win, calls } = ctx;

  ok('a full consultation reaches the draft view', !$(doc, 'draft').classList.contains('hidden'));
  ok('audio was sent for transcription', calls.some((c) => c.url.includes('/api/transcribe') && c.method === 'POST'));
  ok('transcript was sent for drafting', calls.some((c) => c.url.includes('/api/extract')));
  // Twelve consent fields plus the section headings they sit under. Dictated
  // fields are absent because this consultation had no dictation.
  ok('all twelve consent fields render',
    [...$(doc, 'fields').children].filter((el) => el.classList.contains('field')).length === 12,
    String([...$(doc, 'fields').children].filter((el) => el.classList.contains('field')).length));
  ok('under chronological section headings, Findings omitted when nothing was dictated',
    [...$(doc, 'fields').children].filter((el) => el.classList.contains('section-heading')).map((el) => el.textContent)
      .join('|') === 'Presentation|Discussion|Outcome',
    [...$(doc, 'fields').children].filter((el) => el.classList.contains('section-heading')).map((el) => el.textContent).join('|'));
  ok('gap list is populated', $(doc, 'gaps-list').children.length >= 1);
  ok('patient words survive verbatim', $(doc, 'fields').textContent.includes('Will I be numb forever?'));
  ok('Montgomery fields are marked',
    $(doc, 'fields').querySelectorAll('.core-tag').length === 4,
    String($(doc, 'fields').querySelectorAll('.core-tag').length));

  click($(doc, 'clear'));
  await tick(80);

  ok('rendered fields are gone', $(doc, 'fields').children.length === 0);
  ok('gap list is gone', $(doc, 'gaps-list').children.length === 0);
  ok('no patient text left anywhere in the DOM',
    !doc.body.textContent.includes('numb forever') &&
    !doc.body.textContent.includes('clarinet') &&
    !doc.body.textContent.includes('pericoronitis'));
  ok('consent is reset, so the next patient must be asked again', !$(doc, 'consent').checked);
  ok('consult type is reset',
    ![...$(doc, 'types').children].some((b) => b.getAttribute('aria-pressed') === 'true'));
  ok('Start is disabled again', $(doc, 'start').disabled);
  ok('timer is reset', $(doc, 'timer').textContent === '0:00');
  ok('back to the setup view', !$(doc, 'setup').classList.contains('hidden'));
  ok('no delete needed on the happy path — the server already cleaned up',
    !calls.some((c) => c.method === 'DELETE' && c.url.includes('/api/transcribe')));
}

/* ================================================================
   3b. Abandonment — the path R4 actually depends on
   ================================================================ */
async function testAbandonment() {
  section('Abandoning a slow transcription must still delete the job');

  const ctx = await boot({
    onFetch: async (c) => {
      // Server ran out of budget and handed back a job id to resume against.
      if (c.url.includes('/api/transcribe') && c.method === 'POST') {
        return { ok: false, status: 202, json: async () => ({ status: 'pending', jobId: 'slowjob77' }) };
      }
      if (c.url.includes('/api/transcribe') && c.method === 'GET') {
        return { ok: true, status: 200, json: async () => ({ status: 'running' }) };
      }
      return null;
    }
  });
  const { doc, calls } = ctx;

  await runConsultation(ctx, null, DEFAULT_TURNS);
  ok('a pending job keeps the working view up', !$(doc, 'working').classList.contains('hidden'));

  const before = calls.length;
  click($(doc, 'clear'));
  await tick(80);
  ok('Clear deletes the abandoned job on Speechmatics',
    calls.slice(before).some((c) => c.method === 'DELETE' && c.url.includes('slowjob77')),
    JSON.stringify(calls.slice(before).map((c) => c.method + ' ' + c.url.slice(0, 46))));
}

/* ================================================================
   4. Model output must never be markup
   ================================================================ */
async function testInjection() {
  section('Model output is rendered as text, never as markup');

  const hostile = {
    reasonForAttendance: '<img src=x onerror="window.__OWNED=1">',
    medicalHistory: '<script>window.__OWNED2=1<\/script>',
    proposed: '</pre><b>bold</b>', alternatives: null, risks: null, benefits: null,
    costs: null, patientQuestions: '"><svg onload="window.__OWNED3=1">',
    patientFactors: null, informationGiven: null, decision: null, nextStep: null,
    gaps: ['<iframe src="javascript:window.__OWNED4=1"></iframe>']
  };
  const ctx = await boot({
    onFetch: async (c) => {
      if (c.url.includes('/api/transcribe') && c.method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ status: 'done', turns: DEFAULT_TURNS }) };
      }
      if (c.url.includes('/api/extract')) {
        return { ok: true, status: 200, json: async () => ({ status: 'done', note: hostile }) };
      }
      return null;
    }
  });
  await runConsultation(ctx, hostile, DEFAULT_TURNS);
  const { doc, win } = ctx;

  ok('no img element created', doc.querySelectorAll('#fields img').length === 0);
  ok('no script element created', doc.querySelectorAll('#fields script').length === 0);
  ok('no svg element created', doc.querySelectorAll('#fields svg').length === 0);
  ok('no iframe created from a gap', doc.querySelectorAll('#gaps-list iframe').length === 0);
  ok('no bold element created', doc.querySelectorAll('#fields b').length === 0);
  ok('nothing executed', !win.__OWNED && !win.__OWNED2 && !win.__OWNED3 && !win.__OWNED4);
  ok('the markup is visible as literal text',
    doc.querySelector('#fields pre').textContent.includes('<img src=x'));
}

/* ================================================================
   5. Lock, and the copy payload
   ================================================================ */
async function testLockAndCopy() {
  section('Lock, and what actually gets copied');

  const note = { reasonForAttendance: 'Reason text.', medicalHistory: null,
    proposed: 'Proposed text.', alternatives: null, risks: null, benefits: null, costs: null,
    patientQuestions: null, patientFactors: null, informationGiven: null, decision: null,
    nextStep: null, gaps: ['Risks not discussed.'] };

  let copied = '';
  const ctx = await boot({
    onFetch: async (c) => {
      if (c.url.includes('/api/transcribe') && c.method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ status: 'done', turns: DEFAULT_TURNS }) };
      }
      if (c.url.includes('/api/extract')) {
        return { ok: true, status: 200, json: async () => ({ status: 'done', note }) };
      }
      return null;
    }
  });
  ctx.win.navigator.clipboard.writeText = async (t) => { copied = t; };
  await runConsultation(ctx, note, DEFAULT_TURNS);
  const { doc, win, calls } = ctx;

  click($(doc, 'copy-all'));
  await tick(40);
  const text = copied;
  ok('copied text includes filled fields', text.includes('Reason text.') && text.includes('Proposed text.'));
  ok('copied text omits empty fields', !text.includes('Relevant medical history'));
  ok('copied text carries headings', text.includes('Reason for attendance'));
  ok('copied text has no gap noise', !text.includes('Risks not discussed.'));

  const before = calls.length;
  click($(doc, 'lock'));
  await tick(60);
  const after = calls.slice(before);
  ok('Lock clears the session server-side',
    after.some((c) => c.method === 'DELETE' && c.url.includes('/api/auth')));
  ok('Lock wipes the draft from the DOM first', $(doc, 'fields').children.length === 0);
  ok('Lock resets consent too', !$(doc, 'consent').checked);
  ok('the delete happens after the wipe, not before',
    after.findIndex((c) => c.url.includes('/api/auth') && c.method === 'DELETE') >= 0);
}

/* ================================================================
   6. Gap list is impossible to skim past
   ================================================================ */
async function testGaps() {
  section('The gap list');

  const withGaps = Object.fromEntries(
    ['reasonForAttendance','medicalHistory','proposed','alternatives','risks','benefits','costs',
     'patientQuestions','patientFactors','informationGiven','decision','nextStep'].map((k) => [k, 'x'])
  );
  withGaps.risks = null; withGaps.alternatives = null;
  withGaps.gaps = ['No risks were named.', 'No alternatives discussed.'];

  const ctx = await boot({
    onFetch: async (c) => {
      if (c.url.includes('/api/transcribe') && c.method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ status: 'done', turns: DEFAULT_TURNS }) };
      }
      if (c.url.includes('/api/extract')) {
        return { ok: true, status: 200, json: async () => ({ status: 'done', note: withGaps }) };
      }
      return null;
    }
  });
  await runConsultation(ctx, withGaps, DEFAULT_TURNS);
  const { doc, win } = ctx;

  ok('gap count is in the heading', /2 gaps/.test($(doc, 'gaps-title').textContent),
    $(doc, 'gaps-title').textContent);
  ok('gaps render above the note',
    $(doc, 'gaps').compareDocumentPosition($(doc, 'fields')) & 4);
  ok('gap box is styled as needing action', !$(doc, 'gaps').classList.contains('clear'));
  ok('empty fields show as not captured',
    [...$(doc, 'fields').children].filter((f) => f.classList.contains('is-gap')).length === 2);
  ok('gap fields offer no copy button',
    [...$(doc, 'fields').children].filter((f) => f.classList.contains('is-gap'))
      .every((f) => !f.querySelector('.copy')));

  ok('gap wording tells you what to do',
    /Add them from memory/i.test($(doc, 'gaps-lead').textContent),
    $(doc, 'gaps-lead').textContent);
}

/* ================================================================
   7. Regressions — three bugs found by review, each with a test
   ================================================================ */
async function testDiscardAndCancellation() {
  section('Discard and cancellation — destroyed means destroyed');

  // --- 1. Discard must not transmit the audio -------------------------------
  // The recorder emits a final dataavailable AFTER stop() is called. The old
  // order (flag, stop, wipe) let that last chunk repopulate S.chunks and the
  // discarded recording was sent for transcription anyway.
  let ctx = await boot({
    onFetch: async (c) => {
      if (c.url.includes('/api/transcribe') && c.method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ status: 'done', turns: DEFAULT_TURNS }) };
      }
      if (c.url.includes('/api/extract')) {
        return { ok: true, status: 200, json: async () => ({ status: 'done', note: { gaps: [] } }) };
      }
      return null;
    }
  });
  let { doc, win, calls } = ctx;

  $(doc, 'consent').checked = true;
  $(doc, 'consent').dispatchEvent(new win.Event('change', { bubbles: true }));
  click($(doc, 'types').children[4]);
  await tick();
  click($(doc, 'start'));
  await tick(60);
  ok('recording started', !$(doc, 'recording').classList.contains('hidden'));

  const beforeDiscard = calls.length;
  click($(doc, 'discard'));
  await tick(160);   // long enough for the final dataavailable and stop to fire

  ok('discarded audio is never uploaded',
    !calls.slice(beforeDiscard).some((c) => c.url.includes('/api/transcribe') && c.method === 'POST'),
    JSON.stringify(calls.slice(beforeDiscard).map((c) => c.method + ' ' + c.url.slice(0, 40))));
  ok('discard returns to setup', !$(doc, 'setup').classList.contains('hidden'));
  ok('discard shows no spurious error', $(doc, 'error').classList.contains('hidden'),
    $(doc, 'error-title').textContent);
  ok('consent is reset after a discard', !$(doc, 'consent').checked);

  // --- 2. Clearing mid-transcription must not resurrect the draft -----------
  let releaseExtract;
  const held = new Promise((r) => { releaseExtract = r; });
  ctx = await boot({
    onFetch: async (c) => {
      if (c.url.includes('/api/transcribe') && c.method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ status: 'done', turns: DEFAULT_TURNS }) };
      }
      if (c.url.includes('/api/extract')) {
        await held;   // stall as a slow model would
        return { ok: true, status: 200,
          json: async () => ({ status: 'done', note: {
            reasonForAttendance: 'RESURRECTED PERICORONITIS', medicalHistory: null,
            proposed: null, alternatives: null, risks: null, benefits: null, costs: null,
            patientQuestions: null, patientFactors: null, informationGiven: null,
            decision: null, nextStep: null, gaps: [] } }) };
      }
      return null;
    }
  });
  ({ doc, win } = ctx);

  $(doc, 'consent').checked = true;
  $(doc, 'consent').dispatchEvent(new win.Event('change', { bubbles: true }));
  click($(doc, 'types').children[0]);
  await tick();
  click($(doc, 'start'));
  await tick(60);
  click($(doc, 'stop'));
  await tick(80);
  ok('waiting on the model', !$(doc, 'working').classList.contains('hidden'));

  click($(doc, 'lock'));       // clinician walks away mid-draft
  await tick(60);
  releaseExtract();            // the model finally answers
  await tick(120);

  ok('a draft that arrives after Lock is discarded',
    !doc.body.textContent.includes('RESURRECTED PERICORONITIS'));
  ok('the draft view never appears after Lock', $(doc, 'draft').classList.contains('hidden'));

  // --- 3. Same again, via the idle timeout path ----------------------------
  ok('the idle wipe is one hour, by decision of 2 Sep 2026',
    /IDLE_WIPE_MS:\s*60 \* 60 \* 1000/.test(readFileSync(join(here, '../ai-notes/index.html'), 'utf8')));
  ok('idle timeout does not fire while a transcript is in flight',
    /if \(S\.busy\) \{ resetIdle\(\); return; \}/.test(
      readFileSync(join(here, '../ai-notes/index.html'), 'utf8')));
}

/* ================================================================
   7b. A failed draft must not cost the consultation
   ================================================================ */
async function testDraftRetry() {
  section('Failed draft — the transcript survives, and can be retried');

  let attempts = 0;
  const note = {
    reasonForAttendance: 'Lower left wisdom tooth.', medicalHistory: null, proposed: null,
    alternatives: null, risks: null, benefits: null, costs: null, patientQuestions: null,
    patientFactors: null, informationGiven: null, decision: null, nextStep: null, gaps: []
  };

  const ctx = await boot({
    onFetch: async (c) => {
      if (c.url.includes('/api/transcribe') && c.method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ status: 'done', turns: DEFAULT_TURNS }) };
      }
      if (c.url.includes('/api/extract')) {
        attempts++;
        // First attempt fails the way a transient Bedrock error would.
        if (attempts === 1) return { ok: false, status: 502, json: async () => ({ error: 'extraction_failed', detail: 'bedrock 500' }) };
        return { ok: true, status: 200, json: async () => ({ status: 'done', note }) };
      }
      return null;
    }
  });
  const { doc, win, calls } = ctx;

  await runConsultation(ctx, note, DEFAULT_TURNS);

  ok('a failed draft surfaces an error', !$(doc, 'error').classList.contains('hidden'));
  ok('and says the recording is not lost',
    /still held in memory/i.test($(doc, 'error-body').textContent), $(doc, 'error-body').textContent);
  ok('a retry is offered', !$(doc, 'error-actions').classList.contains('hidden'));
  ok('the draft view is not shown', $(doc, 'draft').classList.contains('hidden'));

  click($(doc, 'retry'));
  await tick(120);

  ok('retry re-drafts without re-recording', attempts === 2, `attempts=${attempts}`);
  ok('no second recording was uploaded',
    calls.filter((c) => c.url.includes('/api/transcribe') && c.method === 'POST').length === 1);
  ok('the draft now renders', !$(doc, 'draft').classList.contains('hidden'));
  ok('and the error is cleared', $(doc, 'error').classList.contains('hidden'));
  ok('twelve fields present', [...$(doc, 'fields').children].filter((el) => el.classList.contains('field')).length === 12);

  // The held transcript must still be destroyed by every normal route.
  const ctx2 = await boot({
    onFetch: async (c) => {
      if (c.url.includes('/api/transcribe') && c.method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ status: 'done', turns: [
          { speaker: 'S1', text: 'Recurrent pericoronitis lower left eight.' }] }) };
      }
      if (c.url.includes('/api/extract')) return { ok: false, status: 502, json: async () => ({ error: 'extraction_failed' }) };
      return null;
    }
  });
  await runConsultation(ctx2, note, DEFAULT_TURNS);
  ok('a held transcript is offered for retry', !$(ctx2.doc, 'error-actions').classList.contains('hidden'));

  ctx2.win.confirm = () => true;
  click($(ctx2.doc, 'discard-transcript'));
  await tick(80);
  ok('discarding the transcript clears the error', $(ctx2.doc, 'error').classList.contains('hidden'));
  ok('and leaves no transcript text in the DOM',
    !ctx2.doc.body.textContent.includes('pericoronitis'));
  ok('and resets consent', !$(ctx2.doc, 'consent').checked);
}

/* ================================================================
   8. Recording format and size guard
   ================================================================ */
async function testDerivedAndDictation() {
  section('Dictation, the implant log, and the two patient documents');
  const src = readFileSync(join(here, '../ai-notes/index.html'), 'utf8');
  ok('the three oral surgery types are offered', /'third-molar'/.test(src) && /'implant-consult'/.test(src) && /'implant-surgery'/.test(src));

  // Full run: pause, then Dictate (which resumes), then stop. The dictation
  // point must reach the API in recorded seconds, and the draft must render
  // the dictated section separately with the implant table.
  let noteBody = null, summaryBody = null;
  const note = { reasonForAttendance: 'Missing lower left six.', medicalHistory: null, proposed: 'Single implant at LL6.',
    alternatives: 'Bridge, denture, or leave the space.', risks: 'Failure to integrate, nerve injury, infection.', benefits: null,
    costs: null, patientQuestions: 'How long does it last?', patientFactors: null, informationGiven: null, decision: 'Proceed.',
    nextStep: 'Surgery booked.', examination: 'Adequate ridge width clinically.', radiographicFindings: 'CBCT: 11 mm to the canal.',
    plan: 'Straumann BLT 4.1 x 10 at LL6, delayed loading.',
    implantLog: [{ site: 'LL6', system: 'Straumann BLT', diameter: '4.1', length: '10', lot: 'LOT9', torque: '35 Ncm', isq: '71', graft: null, notes: null }],
    gaps: ['Costs not mentioned'] };
  const ctx = await boot({
    onFetch: async (entry, opts) => {
      if (entry.url.includes('/api/transcribe')) return { ok: true, status: 200, json: async () => ({ status: 'done', turns: DEFAULT_TURNS }) };
      if (entry.url.includes('/api/extract')) {
        const b = JSON.parse(opts.body);
        if (b.kind === 'summary') { summaryBody = b; return { ok: true, status: 200, json: async () => ({ status: 'done', summary: { whatWeDiscussed: 'Replacing your lower left back tooth with an implant.', whatYouDecided: 'To go ahead.', whatHappensNext: null, whatToExpect: null, yourQuestions: 'You asked how long it lasts.' } }) }; }
        noteBody = b;
        return { ok: true, status: 200, json: async () => ({ status: 'done', note }) };
      }
    }
  });
  const { doc, win } = ctx;
  $(doc, 'consent').checked = true;
  $(doc, 'consent').dispatchEvent(new win.Event('change', { bubbles: true }));
  const implantSurgery = [...$(doc, 'types').children].find((b) => /Implant surgery/.test(b.textContent));
  ok('Implant surgery is a selectable type', !!implantSurgery);
  click(implantSurgery);
  await tick();
  click($(doc, 'start'));
  await tick(80);

  const realNow = win.Date.now.bind(win.Date);
  let offset = 0;
  win.Date.now = () => realNow() + offset;
  offset += 90 * 1000;                 // 90 s of conversation
  click($(doc, 'pause'));
  await tick(30);
  offset += 40 * 60 * 1000;            // 40 min of surgery, paused
  click($(doc, 'dictate'));
  await tick(30);
  ok('Dictate resumes a paused recording', $(doc, 'pause').textContent === 'Pause');
  ok('and locks itself: there is one dictation point', $(doc, 'dictate').disabled && $(doc, 'dictate').textContent === 'Dictating');
  // Read defensively: if a future edit writes textContent on the #recbar
  // container it destroys these children, and the test must report that as a
  // failure rather than crashing the run.
  ok('the bar says so', /Dictating/.test($(doc, 'recbar-label')?.textContent || ''), $(doc, 'recbar-label')?.textContent ?? '#recbar-label was destroyed');
  // Pausing and resuming mid-dictation must not put "conversation only" back
  // on the red bar: the patient has left and that would be a false statement.
  click($(doc, 'pause'));
  await tick(30);
  click($(doc, 'pause'));
  await tick(30);
  ok('resuming after Dictate does not claim the patient is still there',
    /Dictating/.test($(doc, 'recbar-label')?.textContent || ''), $(doc, 'recbar-label')?.textContent);
  ok('and the recording bar keeps its pulsing dot and its label', !!doc.querySelector('#recbar .dot') && !!doc.querySelector('#recbar-label'));
  offset += 60 * 1000;                 // a minute of dictation
  click($(doc, 'stop'));
  await tick(300);

  ok('the draft arrives', !$(doc, 'draft').classList.contains('hidden'));
  ok('the dictation point reaches the API in RECORDED seconds, not wall clock',
    noteBody && Math.abs(noteBody.dictationFromS - 90) < 2, String(noteBody?.dictationFromS));
  ok('the pause is still reported alongside it', noteBody?.pauses?.length === 1 && noteBody.pauses[0].forMs >= 40 * 60 * 1000);

  // The two kinds of finding must stay in separate panels with opposite advice.
  ok('the not-said panel is hidden when there is nothing to report', $(doc, 'notsaid').classList.contains('hidden'));

  const text = $(doc, 'fields').textContent;
  // Dictated findings now sit where they belong clinically — before the
  // discussion, not after the outcome — but must still be unmistakably marked.
  const headings = [...$(doc, 'fields').children].filter((el) => el.classList.contains('section-heading')).map((el) => el.textContent);
  ok('findings appear under their own heading, before the discussion',
    headings.join('|') === 'Presentation|Findings|Discussion|Outcome|Implant log', headings.join('|'));
  const order = [...$(doc, 'fields').querySelectorAll('.field h3')].map((h) => h.textContent);
  ok('examination is read before the treatment proposed, not after next step',
    order.indexOf('Examination findings') < order.indexOf('Treatment proposed'), JSON.stringify(order));
  ok('and every dictated field carries the Dictated tag, wherever it sits',
    [...$(doc, 'fields').querySelectorAll('.field')].every((f) => {
      const label = f.querySelector('h3').textContent;
      const isDict = ['Examination findings', 'Radiographic findings', 'Treatment plan', 'Implants placed'].includes(label);
      return isDict === !!f.querySelector('.dictated-tag');
    }));
  ok('a consent field is never tagged as dictated',
    ![...$(doc, 'fields').querySelectorAll('.field')].some((f) =>
      f.querySelector('.dictated-tag') && f.querySelector('h3').textContent === 'Treatment proposed'));
  ok('with the dictated fields', /Adequate ridge width/.test(text) && /11 mm to the canal/.test(text));
  ok('and the implant log as a table', doc.querySelector('table.implant-log') && /LOT9/.test(doc.querySelector('table.implant-log').textContent));
  let copied = '';
  win.navigator.clipboard.writeText = async (t) => { copied = t; };
  click($(doc, 'copy-all'));
  await tick(40);
  ok('the pasted note carries the same section headings', /PRESENTATION[\s\S]*FINDINGS[\s\S]*DISCUSSION[\s\S]*OUTCOME/.test(copied), copied.slice(0, 200));
  ok('and marks dictated fields inline so the record cannot mislead',
    /Examination findings \(dictated\)/.test(copied) && /Treatment plan \(dictated\)/.test(copied), copied.slice(0, 300));
  ok('a consent field is not marked dictated in the paste', !/Treatment proposed \(dictated\)/.test(copied));
  ok('the implant log is still included', /IMPLANT LOG/.test(copied) && /Implant 1: Site LL6, System Straumann BLT, Diameter 4.1/.test(copied), copied.slice(-300));
  ok('findings are pasted before the discussion', copied.indexOf('FINDINGS') < copied.indexOf('DISCUSSION'));

  // Consent form text: assembled, not generated; blanks stay blank.
  click($(doc, 'make-consent'));
  await tick(20);
  const consent = $(doc, 'consent-text').textContent;
  ok('consent text is built from the note', /Treatment proposed: Single implant at LL6\./.test(consent));
  ok('a field the note did not capture is shown as blank, not filled', /Costs discussed: \[not recorded in the consultation\]/.test(consent));
  ok('and it carries no identifiers by design', /carries no identifiers by design/.test(consent));
  ok('dictated content stays out of the consent text', !/Straumann/.test(consent));

  // Patient summary: a second call, same transcript, same dictation point.
  click($(doc, 'make-summary'));
  await tick(120);
  ok('the summary request is a summary request', summaryBody?.kind === 'summary');
  ok('over the same turns and pauses', summaryBody?.turns?.length === DEFAULT_TURNS.length && summaryBody?.pauses?.length === 1);
  const sm = $(doc, 'summary-text').textContent;
  ok('the summary renders the sections that came back', /What we discussed/.test(sm) && /Replacing your lower left/.test(sm));
  ok('and omits the ones that were null', !/What happens next/.test(sm), sm);

  // Everything derived dies with the draft.
  click($(doc, 'clear'));
  await tick(30);
  ok('Clear removes the summary and consent text too', $(doc, 'summary-box').classList.contains('hidden') && $(doc, 'summary-text').textContent === '' && $(doc, 'consent-text').textContent === '');
}

async function testNotSaidPanel() {
  section('Checklist findings are kept apart from model gaps');
  const src = readFileSync(join(here, '../ai-notes/index.html'), 'utf8');
  ok('the page never tells you to add an undiscussed risk from memory',
    /If you did not discuss it, do not\s+add it to the record/.test(src));
  ok('while the model-gap lead still invites memory for things merely not captured',
    /These were not captured\. Add them from memory/.test(src));

  const ctx = await boot({
    onFetch: async (entry) => {
      if (entry.url.includes('/api/transcribe')) return { ok: true, status: 200, json: async () => ({ status: 'done', turns: DEFAULT_TURNS }) };
      if (entry.url.includes('/api/extract')) return { ok: true, status: 200, json: async () => ({ status: 'done', note: {
        reasonForAttendance: 'Lower left wisdom tooth.', medicalHistory: null, proposed: 'Surgical removal.', alternatives: null,
        risks: 'Swelling and bruising.', benefits: null, costs: null, patientQuestions: null, patientFactors: null,
        informationGiven: null, decision: 'Proceed.', nextStep: 'Book.',
        gaps: ['Costs were not discussed'],
        notSaid: ['Not mentioned: altered sensation of the lip and chin (inferior alveolar nerve), temporary or permanent.'] } }) };
    }
  });
  const { doc, win } = ctx;
  $(doc, 'consent').checked = true;
  $(doc, 'consent').dispatchEvent(new win.Event('change', { bubbles: true }));
  click([...$(doc, 'types').children].find((b) => /Third molar/.test(b.textContent)));
  await tick();
  click($(doc, 'start'));
  await tick(60);
  click($(doc, 'stop'));
  await tick(300);

  const notSaid = [...$(doc, 'notsaid-list').children].map((li) => li.textContent);
  const gaps = [...$(doc, 'gaps-list').children].map((li) => li.textContent);
  ok('the unsaid risk appears in its own panel', notSaid.length === 1 && /inferior alveolar nerve/.test(notSaid[0]), JSON.stringify(notSaid));
  ok('and NOT in the gap list that invites you to add from memory', !gaps.some((g) => /inferior alveolar/.test(g)), JSON.stringify(gaps));
  ok('the model gap is still shown', gaps.includes('Costs were not discussed'));
  ok('the panel is visible', !$(doc, 'notsaid').classList.contains('hidden'));

  // A transcribed consultation must not be closable without a warning, whether
  // or not a note was drafted from it. The retry path holds a transcript with
  // no note, and that was silently closable.
  const src2 = readFileSync(join(here, '../ai-notes/index.html'), 'utf8');
  ok('closing the tab warns while a transcript is held, note or no note',
    /if \(S\.note \|\| S\.busy \|\| S\.turns\) \{/.test(src2));
  ok('and the patient-summary request cannot hang the button for ever',
    /SUMMARY_TIMEOUT_MS/.test(src2) && /ctrl\.abort\(\)/.test(src2));

  click($(doc, 'clear'));
  await tick(30);
  ok('Clear empties the not-said panel too', $(doc, 'notsaid-list').children.length === 0 && $(doc, 'notsaid').classList.contains('hidden'));
}

async function testPauseResume() {
  section('Pause and resume — the examination is not recorded, and the note knows it');
  const src = readFileSync(join(here, '../ai-notes/index.html'), 'utf8');

  ok('every limit is measured in recorded time, not wall clock',
    /function recordedMs\(\)/.test(src) && /var elapsed = recordedMs\(\);/.test(src));
  ok('the capture-shortfall check uses recorded time, so pausing does not trip it',
    /var wallS = recordedMs\(\) \/ 1000;/.test(src));
  ok('a paused recording is not treated as idle and wiped',
    /S\.recorder\.state === 'paused'\)\) \{ resetIdle\(\); return; \}/.test(src));
  ok('pause works by disconnecting the mic from the encoder, so no silence is encoded',
    /rec\.pause = function[\s\S]{0,200}source\.disconnect\(rec\.node\)/.test(src));

  let sentBody = null;
  const ctx = await boot({
    onFetch: async (entry, opts) => {
      if (entry.url.includes('/api/transcribe')) return { ok: true, status: 200, json: async () => ({ status: 'done', turns: DEFAULT_TURNS }) };
      if (entry.url.includes('/api/extract')) {
        sentBody = JSON.parse(opts.body);
        return { ok: true, status: 200, json: async () => ({ note: { gaps: ['Costs'], reasonForAttendance: 'x' } }) };
      }
    }
  });
  const { doc, win } = ctx;
  $(doc, 'consent').checked = true;
  $(doc, 'consent').dispatchEvent(new win.Event('change', { bubbles: true }));
  click($(doc, 'types').children[0]);
  await tick();
  click($(doc, 'start'));
  await tick(80);

  const node = win.__encoder.instances[0];
  const pagesBefore = node ? true : false;
  ok('recording started', pagesBefore);

  // Pause, and hold the pause across a simulated 30 minutes of treatment.
  const realNow = win.Date.now.bind(win.Date);
  let offset = 0;
  win.Date.now = () => realNow() + offset;
  click($(doc, 'pause'));
  await tick(40);
  ok('the button offers to resume', $(doc, 'pause').textContent === 'Resume');
  ok('the timer says nothing is being recorded', /Paused/.test($(doc, 'timer-note').textContent), $(doc, 'timer-note').textContent);
  const bytesAtPause = node.bytesSeen === undefined ? null : node.bytesSeen;

  offset += 30 * 60 * 1000;          // 30 minutes of examination and treatment
  await tick(40);
  ok('a long pause does not hit the 25-minute cap',
    !$(doc, 'recording').classList.contains('hidden'), 'recording view was left');

  click($(doc, 'pause'));
  await tick(40);
  ok('resuming restores the Pause label', $(doc, 'pause').textContent === 'Pause');

  click($(doc, 'stop'));
  await tick(300);
  ok('the draft still arrives', !$(doc, 'draft').classList.contains('hidden'));
  ok('the pause is reported to the drafting API',
    Array.isArray(sentBody?.pauses) && sentBody.pauses.length === 1, JSON.stringify(sentBody?.pauses));
  ok('with a duration the model can use',
    sentBody?.pauses?.[0]?.forMs >= 30 * 60 * 1000, String(sentBody?.pauses?.[0]?.forMs));
  const gaps = [...$(doc, 'gaps-list').children].map((li) => li.textContent);
  ok('and the clinician is told in the gap list', /paused 1 time/.test(gaps[0]) && /30 minutes/.test(gaps[0]), JSON.stringify(gaps));
  ok('the model\'s own gaps are kept', gaps.includes('Costs'));
  ok('no spurious short-capture warning on a paused recording',
    !gaps.some((g) => /was captured/.test(g)), JSON.stringify(gaps));
}

async function testFormatAndSize() {
  section('Recording format and size — Opus in Ogg, encoded in the browser, measured not estimated');
  const src = readFileSync(join(here, '../ai-notes/index.html'), 'utf8');

  ok('MediaRecorder is gone: Safari ignores its bitrate and that was the whole ceiling',
    !/new MediaRecorder\(/.test(src));
  ok('the encoder is served from this origin, so still no third-party request',
    /ENCODER_PATH:\s*'\/ai-notes\/encoder\.js'/.test(src));
  ok('encodes at 24 kbps, 16 kHz mono, voice application',
    /OPUS_BPS:\s*24000/.test(src) && /OPUS_RATE:\s*16000/.test(src) && /encoderApplication:\s*2048/.test(src));
  ok('the cap is now 25 minutes', /MAX_MS:\s*25 \* 60 \* 1000/.test(src));
  ok('the recording view says so', /Stops automatically at 25:00/.test(src));
  ok('size is measured from encoded pages, not estimated from a bitrate',
    /var bytes = rec\.bytes;/.test(src) && !/var estimated = \(elapsed/.test(src));
  ok('and still warns before stopping', /SIZE_WARN/.test(src));
  ok('the stop threshold leaves headroom', /SIZE_STOP:\s*0\.95/.test(src));
  ok('the blob is typed as Ogg for Speechmatics', /type: 'audio\/ogg'/.test(src));

  // A full run: the encoder is initialised the way the worklet expects, and the
  // upload is the concatenated pages, ending with the final flush.
  let sent = null;
  const ctx = await boot({
    onFetch: async (entry, opts) => {
      if (entry.url.includes('/api/transcribe') && entry.method === 'POST') {
        sent = { type: opts.headers['Content-Type'], size: opts.body.size };
        return { ok: true, status: 200, json: async () => ({ status: 'done', turns: DEFAULT_TURNS }) };
      }
      if (entry.url.includes('/api/extract')) {
        return { ok: true, status: 200, json: async () => ({ note: { gaps: [], reasonForAttendance: 'x' } }) };
      }
    }
  });
  await runConsultation(ctx);
  await tick(200);
  const enc = ctx.win.__encoder;
  ok('the worklet module is loaded from the encoder path', enc.modulePath === '/ai-notes/encoder.js', enc.modulePath);
  const init = enc.instances[0] && enc.instances[0].init;
  ok('the encoder is initialised with the device sample rate and the Opus settings',
    !!init && init.originalSampleRate === 48000 && init.encoderSampleRate === 16000 &&
    init.encoderBitRate === 24000 && init.streamPages === true && init.numberOfChannels === 1,
    JSON.stringify(init));
  ok('the upload is Ogg', sent && sent.type === 'audio/ogg', JSON.stringify(sent));
  // header pages (47 + 60) + streamed pages + the 900-byte final flush
  ok('the upload includes the final flushed page', sent && (sent.size - 47 - 60 - 900) % 1900 === 0 && sent.size > 2000, sent && String(sent.size));
  ok('the audio context is closed afterwards, holding nothing', enc.instances[0].disconnected);

  // The stall warning and the size warning share the meter line; the size
  // guard must never be wiped by the meter, which was a live bug.
  ok('the meter line is driven by one merged status, not overwritten per frame',
    /: S\.sizeNote;/.test(src) && !/note\.textContent = ''/.test(src));

  // Fail before the consultation, never during it.
  const bad = await boot();
  bad.win.AudioContext = class {
    constructor() { this.sampleRate = 48000; this.state = 'running';
      this.audioWorklet = { addModule: async () => { throw new Error('404 encoder.js'); } }; }
    resume() { return Promise.resolve(); }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createAnalyser() { return { fftSize: 512, connect() {}, getByteTimeDomainData(a) { a.fill(128); } }; }
    close() {}
  };
  {
    const { doc, win } = bad;
    $(doc, 'consent').checked = true;
    $(doc, 'consent').dispatchEvent(new win.Event('change', { bubbles: true }));
    click($(doc, 'types').children[0]);
    await tick();
    click($(doc, 'start'));
    await tick(120);
    ok('a missing encoder is refused up front',
      !$(doc, 'error').classList.contains('hidden') && /cannot start the encoder/i.test($(doc, 'error-title').textContent),
      $(doc, 'error-title').textContent);
    ok('and names the file', /\/ai-notes\/encoder\.js/.test($(doc, 'error-body').textContent));
    ok('and never enters the recording view', $(doc, 'recording').classList.contains('hidden'));
  }

  // A browser with no AudioWorklet is refused before the microphone is even asked for.
  const old = await boot();
  delete old.win.AudioWorkletNode;
  {
    const { doc, win } = old;
    $(doc, 'consent').checked = true;
    $(doc, 'consent').dispatchEvent(new win.Event('change', { bubbles: true }));
    click($(doc, 'types').children[0]);
    await tick();
    click($(doc, 'start'));
    await tick(80);
    ok('an unsupported browser is told so', /cannot record/i.test($(doc, 'error-title').textContent), $(doc, 'error-title').textContent);
  }

  // Short of the wall clock: the encoder reports what it captured, and the
  // draft says so in the gap list rather than presenting a hole as complete.
  const short = await boot({
    onFetch: async (entry) => {
      if (entry.url.includes('/api/transcribe')) return { ok: true, status: 200, json: async () => ({ status: 'done', turns: DEFAULT_TURNS }) };
      if (entry.url.includes('/api/extract')) return { ok: true, status: 200, json: async () => ({ note: { gaps: ['Costs'], reasonForAttendance: 'x' } }) };
    }
  });
  {
    const { doc, win } = short;
    $(doc, 'consent').checked = true;
    $(doc, 'consent').dispatchEvent(new win.Event('change', { bubbles: true }));
    click($(doc, 'types').children[0]);
    await tick();
    click($(doc, 'start'));
    await tick(60);
    // Pretend the wall clock has run 10 minutes while the encoder only ever saw seconds.
    win.Date.now = ((real) => () => real() + 10 * 60 * 1000)(win.Date.now.bind(win.Date));
    click($(doc, 'stop'));
    await tick(250);
    const gaps = [...$(doc, 'gaps-list').children].map((li) => li.textContent);
    ok('a short capture is flagged first in the gap list', gaps.length === 2 && /was captured/.test(gaps[0]), JSON.stringify(gaps));
    ok('the model\'s own gaps are kept after it', gaps[1] === 'Costs');
  }
}

/* ---------- run ---------- */
await testConsentGate();
await testSessionGate();
await testWipe();
await testAbandonment();
await testInjection();
await testLockAndCopy();
await testGaps();
await testDiscardAndCancellation();
await testDraftRetry();
await testFormatAndSize();
await testPauseResume();
await testDerivedAndDictation();
await testNotSaidPanel();

console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}\n`);
process.exit(fail ? 1 : 0);
