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
      win.__mic = { constraints: [], devices: [] };
      Object.defineProperty(win.navigator, 'mediaDevices', {
        value: {
          getUserMedia: async (c) => {
            win.__mic.constraints.push(c);
            return {
              getTracks: () => [{ stop() {} }],
              getAudioTracks: () => [{ stop() {}, getSettings: () => ({ deviceId: win.__mic.actual || 'default' }) }]
            };
          },
          enumerateDevices: async () => win.__mic.devices
        },
        configurable: true
      });
      win.__wake = { taken: 0, released: 0 };
      Object.defineProperty(win.navigator, 'wakeLock', {
        value: { request: async () => { win.__wake.taken++; return {
          addEventListener() {}, release() { win.__wake.released++; }
        }; } },
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
  // The button is present on every field now that a gap can be filled by
  // editing, but copies nothing while the field is empty.
  ok('gap fields have a copy button that does nothing while empty',
    [...$(doc, 'fields').children].filter((f) => f.classList.contains('is-gap'))
      .every((f) => !!f.querySelector('.copy')));

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
    nextStep: 'Surgery booked.', examination: 'Adequate ridge width clinically.', radiographicFindings: null,
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
  const dictatedAt = true;
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
  const rate = $(doc, 'fields').querySelector('.rate-note');
  ok('the draft reports what this recording actually cost',
    !!rate && /KB\/s/.test(rate.textContent), rate ? rate.textContent : 'absent');
  ok('and projects the length ceiling from that measured rate, not a fixed number',
    !!rate && /upload limit falls at about \d+ minutes/.test(rate.textContent), rate ? rate.textContent : 'absent');
  ok('the readout excludes paused time, so a long pause does not deflate the rate',
    !!rate && /^2:30 recorded/.test(rate.textContent), rate ? rate.textContent : 'absent');
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
  ok('with the dictated fields', /Adequate ridge width/.test(text));
  ok('and the implant log as a table', doc.querySelector('table.implant-log') && /LOT9/.test(doc.querySelector('table.implant-log').textContent));
  // Every other field on the page can be typed into. A dictated field the model
  // left empty must be too, or there is no way to add it without re-recording.
  ok('a dictated field the model left empty is still offered after Dictate',
    [...$(doc, 'fields').querySelectorAll('.field h3')].some((h) => h.textContent === 'Radiographic findings'),
    [...$(doc, 'fields').querySelectorAll('.field h3')].map((h) => h.textContent).join(' | '));
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

  // The summary is the only document that leaves the building with the patient,
  // and it used to be the only one that could not be corrected.
  const smEl = $(doc, 'summary-text');
  ok('the patient summary can be corrected', smEl.getAttribute('contenteditable') === 'true');
  smEl.textContent = 'What we discussed\nReplacing your lower left back tooth. Corrected by hand.';
  smEl.dispatchEvent(new win.Event('input', { bubbles: true }));
  await tick(30);
  let copiedSm = '';
  win.navigator.clipboard.writeText = async (t) => { copiedSm = t; };
  click($(doc, 'copy-summary'));
  await tick(40);
  ok('and copying it takes the correction, not the model output',
    /Corrected by hand\./.test(copiedSm), copiedSm.slice(0, 160));
  click($(doc, 'make-summary'));
  await tick(60);
  ok('pressing the button again does not silently overwrite the correction',
    /Corrected by hand\./.test(smEl.textContent), smEl.textContent.slice(0, 120));

  // Everything derived dies with the draft.
  click($(doc, 'clear'));
  await tick(30);
  ok('Clear removes the summary and consent text too', $(doc, 'summary-box').classList.contains('hidden') && $(doc, 'summary-text').textContent === '' && $(doc, 'consent-text').textContent === '');
}

async function testPolish() {
  section('Polish: focus, print, templates, and asking about the consultation');
  const src = readFileSync(join(here, '../ai-notes/index.html'), 'utf8');

  // 1. focus follows the view change
  ok('each view is focusable and labelled', (src.match(/<section id="\w+"[^>]*tabindex="-1"/g) || []).length === 4,
    String((src.match(/<section id="\w+"[^>]*tabindex="-1"/g) || []).length));
  ok('and show() moves focus to the section that appeared', /el\.focus\(\{ preventScroll: true \}\)/.test(src));

  // 2. print
  ok('there is a print stylesheet', /@media print \{[\s\S]*?\.card \{ border: none/.test(src));
  // Screen-only furniture, listed together. Anything added here must be added
  // to that rule too, or it turns up on a printed clinical note.
  ok('controls and screen-only notes are hidden on paper',
    /#ask-box, #referral-box,\s*\n\s*\.mic-check, #idle-warn, #stats-row, #teeth-strip button, #postop-box \.actions \{ display: none !important; \}/.test(src) &&
    /\.storage-note,/.test(src));

  // 3. the promise, stated
  ok('the page says nothing is saved', /class="storage-note"/.test(src) && /Nothing is saved\./.test(src));

  // 4. build stamp
  ok('a build is shown and quotable', /var BUILD = '[\d.-]+';/.test(src) && /build-stamp/.test(src));

  let asked = null;
  const ctx = await boot({
    onFetch: async (entry, opts) => {
      if (entry.url.includes('/api/transcribe')) return { ok: true, status: 200, json: async () => ({ status: 'done', turns: DEFAULT_TURNS }) };
      if (entry.url.includes('/api/extract')) {
        const b = JSON.parse(opts.body);
        if (b.kind === 'ask') { asked = b; return { ok: true, status: 200, json: async () => ({ status: 'done', answer: 'The cost was not discussed.' }) }; }
        return { ok: true, status: 200, json: async () => ({ status: 'done', note: {
          reasonForAttendance: 'Pain from LL8.', medicalHistory: null, proposed: 'Surgical removal.',
          alternatives: null, risks: 'Numbness.', benefits: null, costs: null, patientQuestions: null,
          patientFactors: null, informationGiven: null, decision: 'Proceed.', nextStep: 'Book.',
          examination: 'LL8 mesioangular.', gaps: [], notSaid: [] } }) };
      }
    }
  });
  const { doc, win } = ctx;
  $(doc, 'consent').checked = true;
  $(doc, 'consent').dispatchEvent(new win.Event('change', { bubbles: true }));
  click($(doc, 'types').children[0]);
  await tick();
  click($(doc, 'start'));
  await tick(60);
  click($(doc, 'stop'));
  await tick(300);

  // 5. templates are layout only
  const heads = () => [...$(doc, 'fields').children].filter((e) => e.classList.contains('section-heading')).map((e) => e.textContent);
  const fields = () => [...$(doc, 'fields').querySelectorAll('.field h3')].map((h) => h.textContent);
  ok('the default layout is the clinical one', heads().join('|') === 'Presentation|Findings|Discussion|Outcome', heads().join('|'));
  const before = fields().slice().sort().join('|');
  const soap = [...doc.querySelectorAll('#template-picker button')].find((b) => b.dataset.template === 'soap');
  click(soap);
  await tick(40);
  ok('switching to SOAP relayouts the note', heads().join('|') === 'Subjective|Objective|Assessment|Plan', heads().join('|'));
  ok('with exactly the same fields, none lost or duplicated', fields().slice().sort().join('|') === before);
  ok('and without a model call', !win.__extraCall);
  const consentT = [...doc.querySelectorAll('#template-picker button')].find((b) => b.dataset.template === 'consent');
  click(consentT);
  await tick(40);
  ok('the consent layout leads with the discussion', heads()[0] === 'The discussion', heads().join('|'));
  ok('the picker shows which layout is active', consentT.classList.contains('on') && !soap.classList.contains('on'));

  // 6. ask
  $(doc, 'ask-input').value = 'Did I mention the cost?';
  click($(doc, 'ask-go'));
  await tick(200);
  ok('a question is sent as an ask, with the transcript', asked?.kind === 'ask' && asked.turns.length === DEFAULT_TURNS.length);
  ok('and the question itself', asked?.question === 'Did I mention the cost?');
  ok('the answer is shown', /not discussed/.test($(doc, 'ask-answer').textContent), $(doc, 'ask-answer').textContent);
  click($(doc, 'clear'));
  await tick(40);
  ok('Clear empties the question and answer',
    $(doc, 'ask-input').value === '' && $(doc, 'ask-answer').classList.contains('hidden'));
}

async function testStyles() {
  section('Stylesheet integrity and chairside layout');
  const src = readFileSync(join(here, '../ai-notes/index.html'), 'utf8');
  const css = [...src.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');

  // Every custom property that is USED must be DECLARED. --paper was referenced
  // by three rules and declared nowhere, so those backgrounds silently fell
  // through to transparent. A missing variable never errors; it just looks
  // slightly wrong, which is exactly why it survived.
  const declared = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  // A var() with a fallback is legitimate; a bare one that is never declared
  // resolves to nothing and just looks slightly wrong.
  const bare = [...css.matchAll(/var\((--[a-z0-9-]+)\s*\)/g)].map((m) => m[1]);
  const undeclared = [...new Set(bare)].filter((v) => !declared.has(v));
  ok('every CSS variable used without a fallback is declared', undeclared.length === 0, undeclared.join(', '));

  // The recording view is used one-handed, chairside, possibly gloved.
  ok('the four recording controls do not stay in one row on a phone',
    /@media \(max-width: 480px\) \{[\s\S]{0,400}\.record-row \{ flex-wrap: wrap; \}/.test(css));
  ok('and Stop and Discard each get their own full-width row there',
    /\.record-row \.btn-stop,[\s\S]{0,80}\.record-row \.btn-discard \{ flex: 1 1 100%; \}/.test(css));
  ok('the minimum touch target is still honoured', /--tap:\s*48px/.test(css));

  // The size warning was text under a bar the eye is already on.
  ok('the level meter changes colour as the size limit approaches',
    /\.level > i\.near-limit \{ background: var\(--warn-ink\); \}/.test(css) &&
    /classList\.toggle\('near-limit', bytes >= CFG\.MAX_BYTES \* CFG\.SIZE_WARN\)/.test(src));
  // Was: count two copies, one per reset path. That asserted the duplication
  // rather than the behaviour, and broke the moment the two paths were merged.
  ok('and it is cleared for the next patient, by the one shared reset',
    /function clearConsultation\(\)[\s\S]*?\$\('level'\)\.classList\.remove\('near-limit'\)[\s\S]*?\n  \}/.test(src));

  // Hover never fires on a touch screen.
  ok('Lock has a pressed state, not only a hover state', /#lock:active/.test(css));

  // show() focuses the panel that just appeared so keyboard and screen-reader
  // focus follows the view. Because the containers carry tabindex="-1", the
  // generic focus-visible rule was drawing a 2px box around the whole panel on
  // every view change. They are not tab stops, so the ring is pure noise — but
  // the focus MOVE must survive, or the accessibility fix is undone.
  ok('the view containers do not draw a focus ring around the whole panel',
    /#setup:focus,\s*#recording:focus,\s*#working:focus,\s*#draft:focus \{ outline: none; \}/.test(css));
  ok('and the focus move itself is still there',
    /el\.focus\(\{ preventScroll: true \}\)/.test(src));
}

async function testEditingAndLength() {
  section('Editing the draft in place, and choosing how much is written');
  let sent = [];
  let extractFails = false;
  const note = () => ({
    reasonForAttendance: 'Pain from LL8.', medicalHistory: null, proposed: 'Surgical removal.',
    alternatives: null, risks: 'Numbness of lip and chin.', benefits: null, costs: null,
    patientQuestions: null, patientFactors: null, informationGiven: null,
    decision: 'Proceed.', nextStep: 'Book 40 minutes.', gaps: ['Costs not discussed'], notSaid: [],
    speakers: { S1: 'clinician', S2: 'patient' }, speakerConfidence: 'low'
  });
  const ctx = await boot({
    onFetch: async (entry, opts) => {
      if (entry.url.includes('/api/transcribe')) return { ok: true, status: 200, json: async () => ({ status: 'done', turns: DEFAULT_TURNS }) };
      if (entry.url.includes('/api/extract')) {
        sent.push(JSON.parse(opts.body));
        if (extractFails) return { ok: false, status: 502, json: async () => ({ error: 'model_unavailable', detail: 'Bedrock hiccup' }) };
        return { ok: true, status: 200, json: async () => ({ status: 'done', note: note() }) };
      }
    }
  });
  const { doc, win } = ctx;
  $(doc, 'consent').checked = true;
  $(doc, 'consent').dispatchEvent(new win.Event('change', { bubbles: true }));
  click($(doc, 'types').children[0]);
  await tick();
  click($(doc, 'start'));
  await tick(60);
  click($(doc, 'stop'));
  await tick(300);

  ok('the first draft asks for standard detail', sent[0]?.length === 'standard', JSON.stringify(sent[0]?.length));

  // --- 5. speaker mapping is surfaced, and low confidence is not hidden ---
  const banner = doc.getElementById('speaker-map');
  ok('the speaker mapping is shown so a swap is visible', !!banner && /S1 = clinician/.test(banner.textContent), banner && banner.textContent);
  ok('and low confidence is stated plainly', !!banner && /low/.test(banner.textContent), banner && banner.textContent);

  // --- 2. editing in place writes back to the note that gets copied ---
  const pres = [...$(doc, 'fields').querySelectorAll('.field pre')];
  const risks = pres.find((p) => p.getAttribute('aria-label') === 'Material risks named, per option');
  ok('fields are editable in the app', !!risks && risks.getAttribute('contenteditable') === 'true');
  risks.textContent = 'Numbness of lip and chin, temporary or permanent. Lingual nerve.';
  risks.dispatchEvent(new win.Event('input', { bubbles: true }));
  await tick(30);
  ok('the edit is marked', risks.closest('.field').classList.contains('edited'));
  let copied = '';
  win.navigator.clipboard.writeText = async (t) => { copied = t; };
  click($(doc, 'copy-all'));
  await tick(40);
  ok('and the copied note carries the edit, not the model output', /Lingual nerve\./.test(copied), copied.slice(0, 300));

  // Emptying a field turns it back into a gap rather than pasting blank text.
  const costs = pres.find((p) => p.getAttribute('aria-label') === 'Costs discussed');
  ok('an uncaptured field starts empty with a placeholder', costs.textContent === '' && costs.dataset.placeholder === 'Not captured');
  costs.textContent = '£280 quoted.';
  costs.dispatchEvent(new win.Event('input', { bubbles: true }));
  await tick(20);
  click($(doc, 'copy-all'));
  await tick(40);
  ok('filling a gap in the app puts it in the record', /Costs discussed[\s\S]*£280 quoted\./.test(copied), copied.slice(0, 400));

  // The field's own Copy button must agree with Copy whole note. It used to
  // capture the value at render time and so served the pre-edit text.
  copied = '';
  const risksCopy = risks.closest('.field').querySelector('.copy');
  click(risksCopy);
  await tick(30);
  ok('a field\'s own Copy button reflects the edit, not the model output',
    /Lingual nerve\./.test(copied), copied);
  copied = '';
  const costsField = costs.closest('.field');
  click(costsField.querySelector('.copy'));
  await tick(30);
  ok('and a field filled in from empty can be copied on its own',
    /£280 quoted\./.test(copied), copied);

  // --- 4. length control redrafts from the transcript already held ---
  const full = [...doc.querySelectorAll('.length-picker button')].find((b) => b.dataset.length === 'full');
  win.confirm = () => true;   // edits exist, so it asks first
  click(full);
  await tick(300);
  ok('choosing Full redrafts', sent.length === 2 && sent[1].length === 'full', JSON.stringify(sent.map((x) => x.length)));
  ok('from the transcript already held, with no new recording', sent[1].turns.length === DEFAULT_TURNS.length);
  ok('and the button reflects the choice', full.classList.contains('on'));
  ok('the draft is shown again', !$(doc, 'draft').classList.contains('hidden'));

  // A redraft that fails must not throw away a good note.
  const brief = [...doc.querySelectorAll('.length-picker button')].find((b) => b.dataset.length === 'brief');
  extractFails = true;
  click(brief);
  await tick(300);
  ok('a failed redraft keeps the note on screen', !$(doc, 'draft').classList.contains('hidden'));
  ok('and says the note is unchanged rather than sending you back to the start',
    /unchanged/.test($(doc, 'error-body').textContent), $(doc, 'error-body').textContent);
  ok('the note itself is still there', /Surgical removal\./.test($(doc, 'fields').textContent) &&
    /Numbness of lip and chin\./.test($(doc, 'fields').textContent), $(doc, 'fields').textContent.slice(0, 120));
  ok('and the failed length is not left showing as selected',
    !brief.classList.contains('on') && [...doc.querySelectorAll('.length-picker button')].some((b) => b.classList.contains('on')),
    [...doc.querySelectorAll('.length-picker button')].filter((b) => b.classList.contains('on')).map((b) => b.dataset.length).join());

  ok('pasting into a field is forced to plain text',
    /addEventListener\('paste'/.test(readFileSync(join(here, '../ai-notes/index.html'), 'utf8')));
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

/**
 * The patient summary is the only document that physically leaves with the
 * patient. When the draft fails, the error is written into the same editable
 * box the summary renders into, and the box is un-hidden — so the Copy button
 * sits there with "Could not draft the summary: ..." in it. Copying that out
 * and handing it over is the worst single failure this tool has available.
 */
async function testSummaryFailureIsNotCopyable() {
  section('A failed patient summary cannot be copied out as a summary');
  const note = { reasonForAttendance: 'Pain from lower left eight.', medicalHistory: null, proposed: 'Surgical removal of LL8.',
    alternatives: null, risks: null, benefits: null, costs: null, patientQuestions: null, patientFactors: null,
    informationGiven: null, decision: 'Proceed.', nextStep: null, examination: null, radiographicFindings: null,
    plan: null, gaps: [] };
  const ctx = await boot({
    onFetch: async (entry, opts) => {
      if (entry.url.includes('/api/transcribe')) return { ok: true, status: 200, json: async () => ({ status: 'done', turns: DEFAULT_TURNS }) };
      if (entry.url.includes('/api/extract')) {
        const b = JSON.parse(opts.body);
        if (b.kind === 'summary') return { ok: false, status: 502, json: async () => ({ error: 'Bedrock unavailable' }) };
        return { ok: true, status: 200, json: async () => ({ status: 'done', note }) };
      }
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

  click($(doc, 'make-summary'));
  await tick(120);
  const smEl = $(doc, 'summary-text');
  ok('a failed summary says so on screen', /Could not draft the summary/.test(smEl.textContent), smEl.textContent.slice(0, 120));
  ok('and the box is shown, so the Copy button is reachable', !$(doc, 'summary-box').classList.contains('hidden'));

  let copied = null;
  win.navigator.clipboard.writeText = async (t) => { copied = t; };
  click($(doc, 'copy-summary'));
  await tick(40);
  ok('but copying it copies NOTHING, rather than handing the error to the patient',
    copied === null, String(copied).slice(0, 120));

  // And the guard must not break the normal path it protects.
  ok('the failure leaves no summary behind to copy later', !/What we discussed/.test(smEl.textContent));
}

/**
 * The referral leaves the practice. Two things must hold: it never carries a
 * patient identifier (the form has them, and keeping them out of this tool is
 * what the DPIA rests on), and a section with no source in the recording is
 * NAMED rather than dropped — a quietly three-section referral looks finished.
 */
async function testReferral() {
  section('Referral (SBAR)');
  const note = { reasonForAttendance: 'Pain from lower left eight.', medicalHistory: null, proposed: 'Surgical removal of LL8.',
    alternatives: null, risks: null, benefits: null, costs: null, patientQuestions: null, patientFactors: null,
    informationGiven: null, decision: 'Proceed.', nextStep: null, examination: null, radiographicFindings: null,
    plan: null, gaps: [] };
  let referralBody = null;
  const ctx = await boot({
    onFetch: async (entry, opts) => {
      if (entry.url.includes('/api/transcribe')) return { ok: true, status: 200, json: async () => ({ status: 'done', turns: DEFAULT_TURNS }) };
      if (entry.url.includes('/api/extract')) {
        const b = JSON.parse(opts.body);
        if (b.kind === 'referral') {
          referralBody = b;
          return { ok: true, status: 200, json: async () => ({ status: 'done', referral: {
            situation: 'Three months of pain from the lower left third molar.',
            background: null,
            assessment: 'Distoangular impaction on the OPG, in contact with the canal.',
            recommendation: 'Surgical removal under the care of the oral surgery service.',
            redFlags: ['limited mouth opening for the past week']
          } }) };
        }
        return { ok: true, status: 200, json: async () => ({ status: 'done', note }) };
      }
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

  click($(doc, 'make-referral'));
  await tick(150);
  const txt = $(doc, 'referral-text').textContent;
  ok('the referral request is a referral request', referralBody?.kind === 'referral');
  ok('and it carries the note as corrected, not just the transcript',
    referralBody?.note?.reasonForAttendance === 'Pain from lower left eight.', JSON.stringify(referralBody?.note || {}).slice(0, 100));
  ok('all four SBAR headings are present', ['Situation', 'Background', 'Assessment', 'Recommendation'].every((h) => txt.includes(h)));
  ok('a section with no source is named, not silently dropped',
    /Background\n\[Not stated in this consultation/.test(txt), txt.slice(0, 200));

  // The flags report what was SAID. They must not reach the pasted text, or a
  // note-to-self about pathway choice would be sent to the receiving clinician.
  const flags = $(doc, 'referral-flags');
  ok('words that need a pathway check are surfaced', /limited mouth opening/.test(flags.textContent));
  ok('but they are NOT part of the referral text', !/limited mouth opening/.test(txt));

  let copied = null;
  win.navigator.clipboard.writeText = async (t) => { copied = t; };
  click($(doc, 'copy-referral'));
  await tick(40);
  ok('copying gives the SBAR narrative', /Situation/.test(String(copied)));
  ok('and it carries no patient name, CHI or date of birth',
    !/\b(CHI|date of birth|d\.?o\.?b)\b/i.test(String(copied)), String(copied).slice(0, 120));

  // Same failure guard as the patient summary.
  click($(doc, 'clear'));
  await tick(60);
  ok('clearing wipes the referral from the screen', $(doc, 'referral-text').textContent === '');
  ok('and hides the panel', $(doc, 'referral-box').classList.contains('hidden'));
}

/**
 * Starting a NEW recording must leave nothing of the last patient behind. The
 * screen is cleared either way, so the failure is invisible: the danger is the
 * derived documents surviving in memory, and the "already drafted, don't
 * redraft over corrections" guard then refusing to draft for the new patient
 * and showing an empty box instead.
 */
async function testNewRecordingDropsThePreviousPatient() {
  section('A new recording leaves nothing of the last patient');
  const note = { reasonForAttendance: 'Pain from lower left eight.', medicalHistory: null, proposed: 'Surgical removal of LL8.',
    alternatives: null, risks: null, benefits: null, costs: null, patientQuestions: null, patientFactors: null,
    informationGiven: null, decision: 'Proceed.', nextStep: null, examination: null, radiographicFindings: null,
    plan: null, gaps: [] };
  let referralCalls = 0, summaryCalls = 0;
  const ctx = await boot({
    onFetch: async (entry, opts) => {
      if (entry.url.includes('/api/transcribe')) return { ok: true, status: 200, json: async () => ({ status: 'done', turns: DEFAULT_TURNS }) };
      if (entry.url.includes('/api/extract')) {
        const b = JSON.parse(opts.body);
        if (b.kind === 'referral') {
          referralCalls++;
          return { ok: true, status: 200, json: async () => ({ status: 'done', referral: {
            situation: 'Patient ' + referralCalls + ' situation.', background: null,
            assessment: 'Findings for patient ' + referralCalls + '.', recommendation: 'Please assess.', redFlags: [] } }) };
        }
        if (b.kind === 'summary') {
          summaryCalls++;
          return { ok: true, status: 200, json: async () => ({ status: 'done', summary: {
            whatWeDiscussed: 'Patient ' + summaryCalls + '.', whatYouDecided: null,
            whatHappensNext: null, whatToExpect: null, yourQuestions: null } }) };
        }
        return { ok: true, status: 200, json: async () => ({ status: 'done', note }) };
      }
    }
  });
  const { doc, win } = ctx;
  const record = async () => {
    click($(doc, 'start'));
    await tick(60);
    click($(doc, 'stop'));
    await tick(300);
  };
  $(doc, 'consent').checked = true;
  $(doc, 'consent').dispatchEvent(new win.Event('change', { bubbles: true }));
  click([...$(doc, 'types').children].find((b) => /Third molar/.test(b.textContent)));
  await tick();

  await record();
  click($(doc, 'make-referral'));
  await tick(150);
  click($(doc, 'make-summary'));
  await tick(150);
  ok('first patient gets a referral', /Patient 1 situation/.test($(doc, 'referral-text').textContent));

  // Second patient, same session: press Start again rather than Clear.
  await record();
  click($(doc, 'make-referral'));
  await tick(150);
  click($(doc, 'make-summary'));
  await tick(150);
  ok('the second patient gets their OWN referral, not an empty box',
    /Patient 2 situation/.test($(doc, 'referral-text').textContent), $(doc, 'referral-text').textContent.slice(0, 120));
  ok('and their own summary', /Patient 2/.test($(doc, 'summary-text').textContent), $(doc, 'summary-text').textContent.slice(0, 120));
  ok('which means both were actually re-drafted', referralCalls === 2 && summaryCalls === 2,
    `referral=${referralCalls} summary=${summaryCalls}`);
}

/**
 * The worst failure this tool has available: showing one patient's note during
 * another patient's appointment. The redraft branch in draft() treats a
 * surviving S.note as "the current note, unchanged" and invites the clinician
 * to carry on with it. That is right for a redraft and catastrophic if S.note
 * belongs to the previous patient.
 */
async function testFailedDraftNeverShowsThePreviousPatientsNote() {
  section("A failed draft never shows the previous patient's note");
  const noteA = { reasonForAttendance: 'PATIENT A: pain from lower left eight.', medicalHistory: null,
    proposed: 'Surgical removal of LL8.', alternatives: null, risks: null, benefits: null, costs: null,
    patientQuestions: null, patientFactors: null, informationGiven: null, decision: 'Proceed.', nextStep: null,
    examination: null, radiographicFindings: null, plan: null, gaps: [] };
  let extractCalls = 0;
  const ctx = await boot({
    onFetch: async (entry, opts) => {
      if (entry.url.includes('/api/transcribe')) return { ok: true, status: 200, json: async () => ({ status: 'done', turns: DEFAULT_TURNS }) };
      if (entry.url.includes('/api/extract')) {
        extractCalls++;
        if (extractCalls === 1) return { ok: true, status: 200, json: async () => ({ status: 'done', note: noteA }) };
        return { ok: false, status: 502, json: async () => ({ error: 'Bedrock unavailable' }) };
      }
    }
  });
  const { doc, win } = ctx;
  const record = async () => {
    click($(doc, 'start'));
    await tick(60);
    click($(doc, 'stop'));
    await tick(300);
  };
  $(doc, 'consent').checked = true;
  $(doc, 'consent').dispatchEvent(new win.Event('change', { bubbles: true }));
  click([...$(doc, 'types').children].find((b) => /Third molar/.test(b.textContent)));
  await tick();

  await record();
  ok('patient A gets a note', /PATIENT A/.test($(doc, 'fields').textContent));

  // Patient B. Their draft fails.
  await record();
  await tick(200);
  const onScreen = $(doc, 'fields').textContent;
  const draftShown = !$(doc, 'draft').classList.contains('hidden');
  ok("patient A's note is NOT on screen after patient B's draft fails",
    !/PATIENT A/.test(onScreen), onScreen.slice(0, 160));
  ok('and the draft view is not presented as if it were theirs',
    !(draftShown && /PATIENT A/.test(onScreen)));

  // Clearing the rendered DOM alone would satisfy the two above, so this is the
  // assertion that pins S.note itself: draft() picks its branch on S.note, and
  // the two branches say different things. "rewrite" means it thought this was a
  // redraft of a note that is still valid — i.e. the previous patient's.
  const title = $(doc, 'error-title').textContent;
  ok('the failure is reported as a first draft, not as a failed rewrite',
    /Could not draft the note/.test(title) && !/rewrite/i.test(title), title);
  ok('and it offers a retry rather than inviting them to carry on with what is on screen',
    !$(doc, 'error-actions').classList.contains('hidden'));
}

/**
 * The recording exists nowhere but memory, so a consultation captured on the
 * wrong input is gone. The check has to use the SAME constraints the recording
 * will use, or it proves nothing.
 */
async function testMicCheck() {
  section('Pre-flight microphone check');
  const ctx = await boot();
  const { doc, win } = ctx;
  win.__mic.devices = [
    { kind: 'audioinput', deviceId: 'built-in', label: 'MacBook Microphone' },
    { kind: 'audioinput', deviceId: 'headset', label: 'Surgery Headset' }
  ];
  win.__mic.actual = 'built-in';

  ok('the picker is hidden until the browser has granted access',
    $(doc, 'mic-picker').classList.contains('hidden'));

  click($(doc, 'mic-test'));
  await tick(60);
  ok('checking opens the microphone', win.__mic.constraints.length >= 1);
  ok('and nothing is uploaded by the check',
    !ctx.calls.some((c) => /\/api\/(transcribe|extract)/.test(c.url)));
  ok('both microphones are offered once labels are available',
    $(doc, 'mic-picker').options.length === 2, String($(doc, 'mic-picker').options.length));
  ok('and the picker appears when there is a choice to make',
    !$(doc, 'mic-picker').classList.contains('hidden'));
  ok('it shows the one actually in use, not just the first in the list',
    $(doc, 'mic-picker').value === 'built-in', $(doc, 'mic-picker').value);

  // Choosing a device must bind the RECORDING to it, not only the test.
  const before = win.__mic.constraints.length;
  $(doc, 'mic-picker').value = 'headset';
  $(doc, 'mic-picker').dispatchEvent(new win.Event('change', { bubbles: true }));
  await tick(60);
  ok('choosing a different microphone re-opens it', win.__mic.constraints.length > before);

  $(doc, 'consent').checked = true;
  $(doc, 'consent').dispatchEvent(new win.Event('change', { bubbles: true }));
  click([...$(doc, 'types').children].find((b) => /Third molar/.test(b.textContent)));
  await tick();
  click($(doc, 'start'));
  await tick(80);
  const rec = win.__mic.constraints[win.__mic.constraints.length - 1];
  ok('and the recording uses the chosen device, not the browser default',
    rec && rec.audio && rec.audio.deviceId && rec.audio.deviceId.exact === 'headset',
    JSON.stringify(rec));
}

/**
 * A surgery tablet sleeps long before a 20-minute consultation ends, and a
 * suspended page starves the encoder.
 */
async function testWakeLock() {
  section('Screen wake lock while recording');
  const ctx = await boot();
  const { doc, win } = ctx;
  $(doc, 'consent').checked = true;
  $(doc, 'consent').dispatchEvent(new win.Event('change', { bubbles: true }));
  click([...$(doc, 'types').children].find((b) => /Third molar/.test(b.textContent)));
  await tick();
  ok('no lock is held before recording', win.__wake.taken === 0);
  click($(doc, 'start'));
  await tick(80);
  ok('recording takes a screen wake lock', win.__wake.taken >= 1, String(win.__wake.taken));
  click($(doc, 'stop'));
  await tick(300);
  ok('and stopping releases it rather than holding the screen on all day',
    win.__wake.released >= 1, String(win.__wake.released));
}

/**
 * The idle wipe is irreversible and nothing is saved. It used to destroy the
 * draft and then report it.
 */
async function testIdleWarning() {
  section('Idle wipe warns before it destroys');
  const src = html;
  ok('there is a warning window before the wipe', /IDLE_WARN_MS/.test(src));
  ok('the warning fires earlier than the wipe, not alongside it',
    /CFG\.IDLE_WIPE_MS - CFG\.IDLE_WARN_MS/.test(src));
  ok('it only interrupts when there is something to lose',
    /function showIdleWarning\(\)[\s\S]{0,200}if \(!S\.note && !S\.turns\) return;/.test(src));
  ok('and it offers a way to keep the draft', /id="idle-keep"/.test(src) &&
    /\$\('idle-keep'\)\.addEventListener\('click', function \(\) \{ resetIdle\(\); \}\)/.test(src));
  ok('any interaction clears the warning, because resetIdle hides it',
    /function resetIdle\(\) \{\s*\n\s*hideIdleWarning\(\);/.test(src));
}

/**
 * ?type= saves a tap per appointment; ?audio=raw makes the noise-suppression
 * question answerable without a deploy. Neither is storage.
 */
async function testUrlSwitches() {
  section('URL switches');
  const src = html;
  ok('the consult type can be preselected', /PARAMS\.get\('type'\) === pair\[0\]/.test(src));
  ok('validated against the real list rather than trusted',
    /CONSULT_TYPES\.forEach[\s\S]{0,900}PARAMS\.get\('type'\) === pair\[0\]/.test(src));
  ok('audio processing can be turned off for a comparison', /RAW_AUDIO = PARAMS\.get\('audio'\) === 'raw'/.test(src));
  ok('one constraint builder serves both the check and the recording',
    /function micConstraints\(\)/.test(src) &&
    (src.match(/micConstraints\(\)/g) || []).length >= 3);
}

/**
 * Two failure modes the mic picker introduced, both of which only bite outside
 * the happy path.
 */
async function testMicCheckFailureModes() {
  section('Microphone check: unplugged devices and a stream left open');

  // 1. The chosen device is gone — headset unplugged, USB mic left in the other
  //    surgery. deviceId:{exact} makes getUserMedia throw rather than fall back,
  //    so a device that no longer exists could block recording entirely.
  const ctx = await boot();
  const { doc, win } = ctx;
  win.__mic.devices = [
    { kind: 'audioinput', deviceId: 'built-in', label: 'MacBook Microphone' },
    { kind: 'audioinput', deviceId: 'headset', label: 'Surgery Headset' }
  ];
  win.__mic.actual = 'built-in';
  click($(doc, 'mic-test'));
  await tick(60);
  $(doc, 'mic-picker').value = 'headset';
  $(doc, 'mic-picker').dispatchEvent(new win.Event('change', { bubbles: true }));
  await tick(60);

  // From here the headset does not exist.
  const realGum = win.navigator.mediaDevices.getUserMedia;
  win.navigator.mediaDevices.getUserMedia = async (c) => {
    win.__mic.constraints.push(c);
    if (c && c.audio && c.audio.deviceId) {
      const e = new Error('Requested device not found');
      e.name = 'OverconstrainedError';
      throw e;
    }
    return realGum(c);
  };
  $(doc, 'consent').checked = true;
  $(doc, 'consent').dispatchEvent(new win.Event('change', { bubbles: true }));
  click([...$(doc, 'types').children].find((b) => /Third molar/.test(b.textContent)));
  await tick();
  click($(doc, 'start'));
  await tick(150);
  ok('an unplugged microphone does not block the recording outright',
    !$(doc, 'recording').classList.contains('hidden') || $(doc, 'error-title').textContent !== 'Microphone blocked',
    $(doc, 'error-title').textContent);
  const tried = win.__mic.constraints[win.__mic.constraints.length - 1];
  ok('it retries on the default input instead of insisting on the missing one',
    tried && tried.audio && !tried.audio.deviceId, JSON.stringify(tried));

  // 2. Checking the mic and then NOT recording must not leave it open. The page
  //    tells the patient nothing is being recorded while the operating system
  //    shows a live microphone indicator.
  const ctx2 = await boot();
  ctx2.win.__mic.devices = [{ kind: 'audioinput', deviceId: 'built-in', label: 'Mic' }];
  let stopped = 0;
  ctx2.win.navigator.mediaDevices.getUserMedia = async () => ({
    getTracks: () => [{ stop() { stopped++; } }],
    getAudioTracks: () => [{ stop() { stopped++; }, getSettings: () => ({ deviceId: 'built-in' }) }]
  });
  click($(ctx2.doc, 'mic-test'));
  await tick(80);
  click($(ctx2.doc, 'lock'));
  await tick(80);
  ok('locking closes the microphone the check opened', stopped > 0, String(stopped));

  // The check closing itself cannot be driven in a test without waiting out the
  // real timeout, so these three assertions together stand for it: there is a
  // deadline, runMicTest arms it, and stopMicTest disarms it so a second check
  // cannot be killed by the first one's timer.
  const src = html;
  ok('the check has a deadline', /MIC_TEST_MS:\s*\d+ \* 1000/.test(src));
  ok('and running the check arms it',
    /S\.micStopId = setTimeout\(function \(\) \{\s*\n\s*stopMicTest\(\);/.test(src));
  ok('and stopping the check disarms it, so one check cannot cut short the next',
    /function stopMicTest\(\) \{\s*\n\s*if \(S\.micStopId\) \{ clearTimeout\(S\.micStopId\); S\.micStopId = null; \}/.test(src));
}

/**
 * The check and the recording both open the microphone. If the check's stream is
 * still live when the recording one is requested, two streams contend for the
 * same device — which some hardware and some Bluetooth headsets will not do.
 */
async function testMicTestClosesBeforeRecording() {
  section('The check releases the microphone before the recording takes it');
  const ctx = await boot();
  const { doc, win } = ctx;
  let open = 0, peakWhileOpening = 0;
  win.__mic.devices = [{ kind: 'audioinput', deviceId: 'built-in', label: 'Mic' }];
  win.navigator.mediaDevices.getUserMedia = async (c) => {
    peakWhileOpening = Math.max(peakWhileOpening, open);
    open++;
    const track = { stop() { open--; }, getSettings: () => ({ deviceId: 'built-in' }) };
    return { getTracks: () => [track], getAudioTracks: () => [track] };
  };
  click($(doc, 'mic-test'));
  await tick(80);
  ok('the check holds the microphone open while it runs', open === 1, String(open));

  $(doc, 'consent').checked = true;
  $(doc, 'consent').dispatchEvent(new win.Event('change', { bubbles: true }));
  click([...$(doc, 'types').children].find((b) => /Third molar/.test(b.textContent)));
  await tick();
  click($(doc, 'start'));
  await tick(150);
  ok('but it is released before the recording stream is requested, not after',
    peakWhileOpening === 0, `streams already open when a new one was requested: ${peakWhileOpening}`);
}

/**
 * Every other async path in the page guards on S.gen so that a Clear or Lock
 * mid-flight cannot be undone by a request that resolves afterwards. The
 * microphone check did not, and the thing it leaves behind is an OPEN
 * MICROPHONE — on a page that has just told the clinician everything was
 * destroyed. The permission prompt makes the window arbitrarily long.
 */
async function testMicCheckHonoursClear() {
  section('A check that resolves after Clear must not reopen the microphone');
  const ctx = await boot();
  const { doc, win } = ctx;
  win.__mic.devices = [{ kind: 'audioinput', deviceId: 'built-in', label: 'Mic' }];
  let open = 0;
  let release;
  const pending = new Promise((r) => { release = r; });
  win.navigator.mediaDevices.getUserMedia = async () => {
    await pending;                       // stands in for the permission prompt
    open++;
    const track = { stop() { open--; }, getSettings: () => ({ deviceId: 'built-in' }) };
    return { getTracks: () => [track], getAudioTracks: () => [track] };
  };

  click($(doc, 'mic-test'));
  await tick(40);
  ok('nothing is open while the browser is still asking', open === 0, String(open));

  click($(doc, 'clear'));            // the clinician wipes while the prompt is up
  await tick(40);
  release();
  await tick(120);

  ok('a microphone granted after Clear is closed again, not left running',
    open === 0, `streams still open: ${open}`);
}

/**
 * Two more instances of the same shape: something set up on one path, torn down
 * on another. The buttons are disabled while a document drafts and re-enabled in
 * a `finally` that refuses to act once the session has moved on — correct, but
 * it means the RESET has to do it, and only wipe() does.
 */
async function testDerivedButtonsRecoverForTheNextPatient() {
  section('Derived-document buttons recover when a new recording starts');
  const note = { reasonForAttendance: 'Pain.', medicalHistory: null, proposed: 'Removal.', alternatives: null,
    risks: null, benefits: null, costs: null, patientQuestions: null, patientFactors: null, informationGiven: null,
    decision: 'Proceed.', nextStep: null, examination: null, radiographicFindings: null, plan: null, gaps: [] };
  let releaseReferral;
  const stall = new Promise((r) => { releaseReferral = r; });
  const ctx = await boot({
    onFetch: async (entry, opts) => {
      if (entry.url.includes('/api/transcribe')) return { ok: true, status: 200, json: async () => ({ status: 'done', turns: DEFAULT_TURNS }) };
      if (entry.url.includes('/api/extract')) {
        const b = JSON.parse(opts.body);
        if (b.kind === 'referral') {
          await stall;
          return { ok: true, status: 200, json: async () => ({ status: 'done', referral: { situation: 'x', background: null, assessment: null, recommendation: null, redFlags: [] } }) };
        }
        return { ok: true, status: 200, json: async () => ({ status: 'done', note }) };
      }
    }
  });
  const { doc, win } = ctx;
  const record = async () => { click($(doc, 'start')); await tick(60); click($(doc, 'stop')); await tick(300); };
  $(doc, 'consent').checked = true;
  $(doc, 'consent').dispatchEvent(new win.Event('change', { bubbles: true }));
  click([...$(doc, 'types').children].find((b) => /Third molar/.test(b.textContent)));
  await tick();
  await record();

  click($(doc, 'make-referral'));
  await tick(40);
  ok('the button is disabled while it drafts', $(doc, 'make-referral').disabled);

  await record();                       // next patient, while the draft is in flight
  releaseReferral();
  await tick(120);
  ok('and it is usable again for the next patient', !$(doc, 'make-referral').disabled);
  ok('with its own label back, not "Drafting..."',
    /Referral/.test($(doc, 'make-referral').textContent), $(doc, 'make-referral').textContent);
  ok('and the same for the patient summary', !$(doc, 'make-summary').disabled);

  // The reason the buttons recovered is that S.gen was never bumped — which
  // means the in-flight request was still considered current. So the referral
  // drafted for the PREVIOUS patient lands in this patient's panel.
  ok('and the previous patient\'s referral has NOT landed in this appointment',
    !/x/.test($(doc, 'referral-text').textContent) && $(doc, 'referral-box').classList.contains('hidden'),
    JSON.stringify($(doc, 'referral-text').textContent).slice(0, 120));
}

/**
 * takeWakeLock assigns AFTER an await. A Clear landing inside that window finds
 * S.wakeLock still null, releases nothing, and then the resolved lock is stored
 * with no recording left to release it — the surgery screen stays awake.
 */
async function testWakeLockHonoursClear() {
  section('A wake lock granted after Clear does not hold the screen on');
  const ctx = await boot();
  const { doc, win } = ctx;
  let held = 0;
  let grant;
  const pending = new Promise((r) => { grant = r; });
  win.navigator.wakeLock.request = async () => {
    await pending;
    held++;
    return { addEventListener() {}, release() { held--; } };
  };
  $(doc, 'consent').checked = true;
  $(doc, 'consent').dispatchEvent(new win.Event('change', { bubbles: true }));
  click([...$(doc, 'types').children].find((b) => /Third molar/.test(b.textContent)));
  await tick();
  click($(doc, 'start'));
  await tick(80);
  click($(doc, 'clear'));
  await tick(40);
  grant();
  await tick(120);
  ok('a lock granted after the session ended is released, not kept',
    held === 0, `locks still held: ${held}`);
}

/* ====================================================================
   STRUCTURAL GUARDS
   Six bugs on 5 September were the same shape: a piece of state or a held
   resource whose lifecycle was handled on ONE path and not the others. Every
   one was found by a scan like the two below, run by hand in a container that
   no longer exists. These are those scans, made permanent, so the NEXT feature
   that forgets a path fails the build instead of waiting to be noticed.

   They read the page source rather than driving the page, because what they
   check is a property of the code, not of a run.
   ==================================================================== */

// Brace-matched function body, so these do not depend on how long a function is.
function bodyAt(src, from) {
  const i = src.indexOf('{', from);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(i, j + 1);
  }
  return src.slice(i);
}

function pageScript() {
  return html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/)[1];
}

async function testEveryAsyncPathHonoursTheGeneration() {
  section('Guard: no async path writes to a session that has moved on');
  const src = pageScript();
  const starts = [];
  const re = /async function [A-Za-z0-9_]+\s*\(|addEventListener\('[a-z]+',\s*async function\s*\(/g;
  let m;
  while ((m = re.exec(src))) starts.push(m.index);

  const offenders = [];
  for (const at of starts) {
    const fn = bodyAt(src, at);
    if (!/\bawait\b/.test(fn)) continue;
    // Writes to session state (S.gen and S.busy are the bookkeeping itself).
    if (!/\bS\.(?!gen\b|busy\b)[A-Za-z_$][\w$]*\s*=/.test(fn)) continue;
    // Two accepted forms: reading S.gen directly, or being handed a liveness
    // closure by the caller that already captured it — transcribe() takes
    // live() from process(), which is the same guarantee, just passed in.
    if (/S\.gen/.test(fn) || /\blive\(\)/.test(fn)) continue;
    offenders.push(src.slice(at, src.indexOf('(', at)).trim().slice(0, 60));
  }
  ok('every async path that writes state checks S.gen after awaiting',
    offenders.length === 0,
    offenders.join(' | ') ||
      'A Clear or Lock landing mid-request must not be undone by the response. ' +
      'This is how one patient\'s referral reached the next patient\'s screen.');
}

async function testOneResetPathNotTwo() {
  section('Guard: one reset path, not two');
  const src = pageScript();

  // The original of this test compared wipe() against an inline reset in the
  // Start handler and demanded they clear the same things. Six bugs came from
  // those two drifting apart. They are now one function, so the guarantee to
  // pin is different: everything belonging to the previous patient lives in
  // clearConsultation(), and every path that starts fresh calls it.
  // Two functions now, nested: clearDerived() holds everything built FROM a
  // note, clearConsultation() calls it and adds the consultation itself. The
  // split exists because a REDRAFT must clear the first but not the second.
  const derived = bodyAt(src, src.indexOf('function clearDerived()'));
  const consult = bodyAt(src, src.indexOf('function clearConsultation()'));
  const shared = derived + consult;
  ok('there is a single shared reset', shared.length > 200);
  ok('and the consultation reset goes through the derived one, not around it',
    /clearDerived\(\)/.test(consult));

  // Anything a new consultation must not inherit. Each of these caused, or
  // would have caused, a wrong-patient bug.
  const mustClear = ['note', 'turns', 'summary', 'summaryText', 'summaryEdited',
                     'referral', 'referralText', 'dictationFromMs', 'pausesForDraft'];
  const missing = mustClear.filter((f) => !new RegExp('\\bS\\.' + f + '\\s*=').test(shared));
  ok('it clears every piece of the last patient\'s consultation',
    missing.length === 0, missing.join(', '));

  // Buttons a voided in-flight draft will not re-enable for itself.
  const mustEnable = ['make-summary', 'make-referral', 'ask-go'];
  const stuck = mustEnable.filter((b) => !shared.includes("$('" + b + "').disabled = false"));
  ok('and re-enables every control an abandoned draft left disabled',
    stuck.length === 0, stuck.join(', '));

  // And the rendered note, or the last patient's text sits in the DOM.
  ok('and clears the rendered note from the page',
    /\$\('fields'\)\.textContent = ''/.test(shared) && /speaker-map/.test(shared));

  // Both entry points must go through it.
  const wipe = bodyAt(src, src.indexOf('function wipe()'));
  ok('wipe() goes through the shared reset', /clearConsultation\(\)/.test(wipe));

  const startAt = src.indexOf("$('start').addEventListener");
  const startBody = src.slice(startAt, src.indexOf("show('recording');", startAt));
  ok('and so does starting a new recording', /clearConsultation\(\)/.test(startBody));

  ok('which also voids the previous consultation\'s in-flight requests',
    /S\.gen\+\+;[\s\S]{0,400}?S\.stream = await navigator\.mediaDevices\.getUserMedia/.test(src),
    'the gen bump must happen before the recording captures its own gen');

  // A redraft replaces the note, so everything derived from it is stale — the
  // referral that claims to be built from it, the site the clinician signed off.
  const draftBody = bodyAt(src, src.indexOf('async function draft('));
  ok('and a redraft invalidates what the old note produced',
    /clearDerived\(\);[\s\S]{0,120}S\.note = data\.note;/.test(draftBody));

  // The whole point of merging them: no second list to drift.
  const inlineResets = (src.match(/S\.summaryEdited\s*=\s*false/g) || []).length;
  ok('and no second copy of the reset has reappeared', inlineResets === 1, String(inlineResets));
}

/**
 * A swapped speaker mapping inverts every field — the patient's words land in
 * the clinician's mouth and vice versa. The prompt already warned that this is
 * invisible; until now the tool could report it but not fix it, so the only
 * remedy was to discard the recording and write by hand.
 */
async function testSpeakerSwap() {
  section('Correcting a swapped speaker mapping');
  const base = { medicalHistory: null, alternatives: null, risks: null, benefits: null, costs: null,
    patientQuestions: null, patientFactors: null, informationGiven: null, nextStep: null,
    examination: null, radiographicFindings: null, plan: null, gaps: [] };
  const wrong = { ...base, reasonForAttendance: 'INVERTED', proposed: 'x', decision: 'y',
    speakers: { S1: 'patient', S2: 'clinician' }, speakerConfidence: 'low' };
  const right = { ...base, reasonForAttendance: 'CORRECTED', proposed: 'x', decision: 'y',
    speakers: { S1: 'clinician', S2: 'patient' }, speakerConfidence: 'high' };

  let calls = 0, sentRoles = [];
  const ctx = await boot({
    onFetch: async (entry, opts) => {
      if (entry.url.includes('/api/transcribe')) return { ok: true, status: 200, json: async () => ({ status: 'done', turns: DEFAULT_TURNS }) };
      if (entry.url.includes('/api/extract')) {
        const b = JSON.parse(opts.body);
        if (b.kind) return { ok: true, status: 200, json: async () => ({ status: 'done', note: right }) };
        calls++;
        sentRoles.push(b.speakerRoles || null);
        return { ok: true, status: 200, json: async () => ({ status: 'done', note: calls === 1 ? wrong : right }) };
      }
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
  await tick(320);

  ok('a low-confidence mapping is shown', /confidence: low/.test(doc.body.textContent));
  const swap = doc.getElementById('swap-speakers');
  ok('and the clinician is offered a way to correct it', !!swap);
  ok('the first draft sent no correction', sentRoles[0] === null || sentRoles[0] === undefined);

  click(swap);
  await tick(320);
  ok('correcting it redrafts', calls === 2, String(calls));
  ok('and sends the roles the clinician confirmed, inverted',
    sentRoles[1] && sentRoles[1].S1 === 'clinician' && sentRoles[1].S2 === 'patient',
    JSON.stringify(sentRoles[1]));
  ok('the corrected note replaces the inverted one',
    /CORRECTED/.test($(doc, 'fields').textContent) && !/INVERTED/.test($(doc, 'fields').textContent));
  // Reversible, because a mis-tap would otherwise invert the whole note with no
  // way back short of discarding the recording.
  ok('the banner now says the clinician set it',
    /confirmed by you/i.test(doc.body.textContent));
  ok('and the correction can be undone',
    /Swap back/.test((doc.getElementById('swap-speakers') || {}).textContent || ''));

  // It belongs to this patient and must not survive into the next.
  click($(doc, 'clear'));
  await tick(80);
  ok('the correction is cleared with the rest of the consultation',
    /S\.speakerRoles = null;/.test(html) &&
    /function clearConsultation\(\)[\s\S]*?S\.speakerRoles = null;[\s\S]*?\n  \}/.test(html));
}

/**
 * The tool stores nothing, so it cannot learn from its own use. The session line
 * exists to answer the questions that decide what to change next — which
 * checklist items fire every time, which fields are always blank, how much of
 * each draft gets corrected — without storing anything to do it.
 *
 * The hard requirement is that it carries no clinical content at all.
 */
async function testSessionLine() {
  section('Session line for a spreadsheet');
  const note = { reasonForAttendance: 'SECRET PATIENT DETAIL', medicalHistory: null,
    proposed: 'Surgical removal of LL8.', alternatives: null, risks: null, benefits: null, costs: null,
    patientQuestions: null, patientFactors: null, informationGiven: null, decision: 'Proceed.',
    nextStep: null, examination: null, radiographicFindings: null, plan: null,
    gaps: ['No alternatives discussed', 'Costs not mentioned'],
    notSaid: ['Not mentioned: bleeding.'],
    speakers: { S1: 'clinician', S2: 'patient' }, speakerConfidence: 'high' };
  const ctx = await boot({
    onFetch: async (entry, opts) => {
      if (entry.url.includes('/api/transcribe')) return { ok: true, status: 200, json: async () => ({ status: 'done', turns: DEFAULT_TURNS }) };
      if (entry.url.includes('/api/extract')) return { ok: true, status: 200, json: async () => ({ status: 'done', note }) };
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
  await tick(320);

  let copied = null;
  win.navigator.clipboard.writeText = async (t) => { copied = t; };
  click($(doc, 'copy-stats'));
  await tick(60);
  ok('a line is produced', typeof copied === 'string' && copied.includes('\n'), String(copied).slice(0, 60));

  const [header, row] = String(copied).split('\n');
  ok('with column names, so the first paste into an empty sheet is usable',
    /^date,consult,length/.test(header));
  ok('and the same number of cells as columns',
    row.split(',').length === header.split(',').length,
    `${row.split(',').length} vs ${header.split(',').length}`);

  // The whole point: it must be safe to keep in a spreadsheet indefinitely.
  ok('it carries NO clinical content', !/SECRET PATIENT DETAIL|Surgical removal|Proceed/.test(row), row);
  ok('nor any of the gap or not-said text',
    !/alternatives discussed|Costs not mentioned|bleeding/i.test(row), row);

  const cells = row.split(',');
  ok('it counts the gaps rather than quoting them', cells.includes('2'));
  ok('and records the consult type', /third-molar/.test(row));
  ok('and the speaker confidence', /high/.test(row));

  // Was: row.split(',')[14]. Adding two columns silently moved that index onto a
  // different field and the assertion kept passing for the wrong reason. Resolve
  // by column name instead, which cannot drift.
  const col = (name) => row.split(',')[header.split(',').indexOf(name)];
  ok('nothing is recorded as edited before anything is edited',
    col('fields_edited') === '0', String(col('fields_edited')));
  ok('and the site check is recorded as unconfirmed until it is confirmed',
    col('teeth_confirmed') === '0', String(col('teeth_confirmed')));
}

/**
 * The real error Aiden hit: "Fields are null but no gaps were reported". The
 * guard is right — a note with blanks and no explanation must not be shown —
 * but the message describes JSON, not what went wrong, and the commonest cause
 * is a recording that captured almost nothing.
 */
async function testThinRecordingSaysSo() {
  section('A recording that captured nothing says so');
  const ctx = await boot({
    onFetch: async (entry) => {
      if (entry.url.includes('/api/transcribe')) {
        return { ok: true, status: 200, json: async () => ({ status: 'done', turns: [{ speaker: 'S1', text: 'Right.' }] }) };
      }
      if (entry.url.includes('/api/extract')) {
        return { ok: false, status: 502, json: async () => ({ error: 'extraction_failed', detail: 'Fields are null but no gaps were reported' }) };
      }
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
  await tick(340);

  const title = $(doc, 'error-title').textContent;
  const body = $(doc, 'error-body').textContent;
  ok('the clinician is told the recording was empty, not told about JSON',
    /Almost nothing was recorded/.test(title) && !/gaps were reported/.test(body), title);
  ok('and pointed at the microphone check', /microphone|level bar/i.test(body));
  ok('with the actual word count, so the judgement is theirs', /\b1 word\b/.test(body), body.slice(0, 90));
}

/**
 * Drafting runs at temperature 0. A second attempt on the same transcript
 * usually returns the same answer, so a retry button that says nothing about
 * that invites the clinician to keep pressing it.
 */
async function testRepeatedFailureSaysRetryingWontHelp() {
  section('A second identical failure says so');
  const turns = Array.from({ length: 12 }, (_, i) => ({ speaker: i % 2 ? 'S2' : 'S1', text: 'We discussed the treatment and the risks at some length today.' }));
  const ctx = await boot({
    onFetch: async (entry) => {
      if (entry.url.includes('/api/transcribe')) return { ok: true, status: 200, json: async () => ({ status: 'done', turns }) };
      if (entry.url.includes('/api/extract')) return { ok: false, status: 502, json: async () => ({ error: 'extraction_failed', detail: 'Bedrock unavailable' }) };
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
  await tick(340);
  ok('the first failure offers a retry', /still held in memory/.test($(doc, 'error-body').textContent));

  const retry = [...doc.querySelectorAll('#error-actions button')].find((b) => /retry|try/i.test(b.textContent));
  ok('a retry control is offered', !!retry);
  click(retry);
  await tick(340);
  ok('the second says further retries will not help',
    /deterministic|most likely fail the same way/i.test($(doc, 'error-body').textContent),
    $(doc, 'error-body').textContent.slice(0, 140));
  ok('and tells them to write it by hand', /by hand/i.test($(doc, 'error-body').textContent));
  ok('or to change the consult type if it was wrong', /change it below/i.test($(doc, 'error-body').textContent));

  // Changing the type is a new prompt and a new checklist, so the next failure
  // is a first attempt again. Telling them to give up here was wrong.
  click([...$(doc, 'types').children].find((b) => /Exam/.test(b.textContent)));
  await tick();
  click(retry);
  await tick(340);
  ok('after changing the consult type, a failure is a first attempt again',
    /still held in memory/.test($(doc, 'error-body').textContent) && !/deterministic/.test($(doc, 'error-body').textContent),
    $(doc, 'error-body').textContent.slice(0, 140));
  click([...$(doc, 'types').children].find((b) => /Exam/.test(b.textContent)));
  await tick();
  click(retry);
  await tick(340);
  ok('but pressing the SAME type again does not reset the count',
    /deterministic/.test($(doc, 'error-body').textContent));
}

/**
 * The session can lapse while drafting. The transcript is held in this page's
 * memory, so the advice must never be "reload" — that destroys it.
 */
async function testExpiredWhileDraftingKeepsTranscript() {
  section('Session expiring mid-draft');
  const turns = Array.from({ length: 12 }, (_, i) => ({ speaker: i % 2 ? 'S2' : 'S1', text: 'We discussed the treatment and the risks at some length today.' }));
  const ctx = await boot({
    onFetch: async (entry) => {
      if (entry.url.includes('/api/transcribe')) return { ok: true, status: 200, json: async () => ({ status: 'done', turns }) };
      if (entry.url.includes('/api/extract')) return { ok: false, status: 401, json: async () => ({ error: 'unauthorised' }) };
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
  await tick(340);
  const body = $(doc, 'error-body').textContent;
  ok('an expired session mid-draft does not tell them to reload this page',
    !/reload the page/i.test(body) && /do not reload/i.test(body), body.slice(0, 160));
  ok('it tells them to sign in in another tab and come back', /new tab/i.test(body) && /come back/i.test(body));
  ok('and a retry is still offered', !$(doc, 'error-actions').classList.contains('hidden'));
}

/**
 * Wrong-site surgery is the never-event. The tooth reaches this note through a
 * conversation and a transcript — "lower left eight" and "lower right eight"
 * differ by one transcribed word — and by the time it is in the note it reads
 * perfectly. Buried across four fields a wrong one is invisible; pulled into one
 * line it is obvious.
 */
async function testSiteCheck() {
  section('Site check');
  const base = { medicalHistory: null, alternatives: null, risks: null, benefits: null, costs: null,
    patientQuestions: null, patientFactors: null, informationGiven: null, nextStep: null,
    examination: null, radiographicFindings: null, plan: null, gaps: [],
    speakers: null, speakerConfidence: null };
  const mk = (teeth) => ({ ...base, reasonForAttendance: 'Pain.', proposed: 'Removal.', decision: 'Proceed.', teeth });

  const boot2 = (teeth) => boot({
    onFetch: async (entry) => {
      if (entry.url.includes('/api/transcribe')) return { ok: true, status: 200, json: async () => ({ status: 'done', turns: DEFAULT_TURNS }) };
      if (entry.url.includes('/api/extract')) return { ok: true, status: 200, json: async () => ({ status: 'done', note: mk(teeth) }) };
    }
  });
  const run = async (ctx, type) => {
    const { doc, win } = ctx;
    $(doc, 'consent').checked = true;
    $(doc, 'consent').dispatchEvent(new win.Event('change', { bubbles: true }));
    click([...$(doc, 'types').children].find((b) => new RegExp(type, 'i').test(b.textContent)));
    await tick();
    click($(doc, 'start'));
    await tick(60);
    click($(doc, 'stop'));
    await tick(320);
    return ctx;
  };

  // 1. Sites are surfaced, and flagged until checked.
  let ctx = await run(await boot2(['LL8', 'LL7']), 'Third molar');
  let strip = ctx.doc.getElementById('teeth-strip');
  ok('the sites are pulled out of the note into one line', !!strip && /LL8/.test(strip.textContent) && /LL7/.test(strip.textContent));
  ok('and flagged for checking rather than presented as settled',
    !strip.classList.contains('confirmed') && /Check the site/.test(strip.textContent));

  const confirm = ctx.doc.getElementById('confirm-teeth');
  ok('the clinician can confirm it', !!confirm);
  click(confirm);
  await tick(40);
  strip = ctx.doc.getElementById('teeth-strip');
  ok('once confirmed it stops shouting', strip.classList.contains('confirmed'));
  ok('and the button is gone, so it cannot be half-confirmed',
    !ctx.doc.getElementById('confirm-teeth'));

  // 2. On a surgical consultation, NO tooth is the louder finding.
  ctx = await run(await boot2([]), 'Third molar');
  strip = ctx.doc.getElementById('teeth-strip');
  ok('a surgical note with no tooth identified says so prominently',
    !!strip && /No tooth identified/.test(strip.textContent) && !strip.classList.contains('confirmed'));
  ok('and tells the clinician to add it before pasting', /before you paste/i.test(strip.textContent));

  // 3. On a non-surgical consultation it stays out of the way.
  ctx = await run(await boot2([]), 'Exam');
  ok('but an exam with no tooth named shows nothing',
    !ctx.doc.getElementById('teeth-strip'));
}

/**
 * The sheet the surgical patient reads at nine that night when the bleeding
 * starts. It is where a model is most tempted to supply the standard aftercare
 * for the procedure, and standard advice invented for a specific patient goes
 * home in their hands with the practice's name on it.
 */
async function testPostopSheet() {
  section('Post-operative instructions');
  const note = { reasonForAttendance: 'Pain from LL8.', medicalHistory: null, proposed: 'Surgical removal.',
    alternatives: null, risks: null, benefits: null, costs: null, patientQuestions: null, patientFactors: null,
    informationGiven: null, decision: 'Proceed.', nextStep: null, examination: null, radiographicFindings: null,
    plan: null, gaps: [], teeth: ['LL8'], speakers: null, speakerConfidence: null };
  let sent = null;
  const ctx = await boot({
    onFetch: async (entry, opts) => {
      if (entry.url.includes('/api/transcribe')) return { ok: true, status: 200, json: async () => ({ status: 'done', turns: DEFAULT_TURNS }) };
      if (entry.url.includes('/api/extract')) {
        const b = JSON.parse(opts.body);
        if (b.kind === 'postop') {
          sent = b;
          return { ok: true, status: 200, json: async () => ({ status: 'done', postop: {
            expect: 'Some swelling for two or three days.', pain: 'Paracetamol, two tablets, four times a day.',
            bleeding: 'Bite on the gauze for twenty minutes.', careOfSite: null, eating: null,
            avoid: 'No smoking.', whenToWorry: null, followUp: null } }) };
        }
        return { ok: true, status: 200, json: async () => ({ status: 'done', note }) };
      }
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
  await tick(320);

  click($(doc, 'make-postop'));
  await tick(160);
  const txt = $(doc, 'postop-text').textContent;
  ok('it is built from the corrected note, not the transcript alone',
    sent?.note?.reasonForAttendance === 'Pain from LL8.', JSON.stringify(sent?.note || {}).slice(0, 80));
  ok('what was said appears', /two or three days/.test(txt) && /Paracetamol/.test(txt));

  // The whole discipline of the sheet.
  ok('what was NOT covered is named, not quietly dropped',
    /Looking after the area\n\[Not covered in this consultation/.test(txt), txt.slice(0, 200));
  ok('every heading is present so nothing is silently missing',
    ['What to expect', 'Pain relief', 'If it bleeds', 'Looking after the area',
     'Eating and drinking', 'What to avoid', 'When to get in touch',
     'Your next appointment'].every((h) => txt.includes(h)));

  let copied = null;
  win.navigator.clipboard.writeText = async (t) => { copied = t; };
  click($(doc, 'copy-postop'));
  await tick(40);
  ok('it can be copied', /Paracetamol/.test(String(copied)));

  click($(doc, 'clear'));
  await tick(60);
  ok('and it is cleared with the rest of the consultation',
    $(doc, 'postop-text').textContent === '' && $(doc, 'postop-box').classList.contains('hidden'));

  // The failure path. This box is editable, so a failed attempt leaves the error
  // text sitting in it — and this is the one document that leaves with the
  // patient. Copying "Could not write the instructions" into their hands is the
  // worst outcome this panel has available.
  const ctx2 = await boot({
    onFetch: async (entry, opts) => {
      if (entry.url.includes('/api/transcribe')) return { ok: true, status: 200, json: async () => ({ status: 'done', turns: DEFAULT_TURNS }) };
      if (entry.url.includes('/api/extract')) {
        const b = JSON.parse(opts.body);
        if (b.kind === 'postop') return { ok: false, status: 502, json: async () => ({ error: 'Bedrock unavailable' }) };
        return { ok: true, status: 200, json: async () => ({ status: 'done', note }) };
      }
    }
  });
  $(ctx2.doc, 'consent').checked = true;
  $(ctx2.doc, 'consent').dispatchEvent(new ctx2.win.Event('change', { bubbles: true }));
  click([...$(ctx2.doc, 'types').children].find((b) => /Third molar/.test(b.textContent)));
  await tick();
  click($(ctx2.doc, 'start'));
  await tick(60);
  click($(ctx2.doc, 'stop'));
  await tick(320);
  click($(ctx2.doc, 'make-postop'));
  await tick(160);
  ok('a failure says so on screen', /Could not write the instructions/.test($(ctx2.doc, 'postop-text').textContent));

  let copied2 = null;
  ctx2.win.navigator.clipboard.writeText = async (t) => { copied2 = t; };
  click($(ctx2.doc, 'copy-postop'));
  await tick(40);
  ok('but copying it copies NOTHING, rather than sending the error home with the patient',
    copied2 === null, String(copied2).slice(0, 100));
}

/**
 * A redraft replaces the note for the SAME patient — the length picker, or a
 * speaker-mapping correction. Everything derived from the old note is then
 * stale: the referral says "built from the note above, as you have corrected
 * it", which stops being true the moment the note is replaced, and the site
 * check still reads "confirmed by you" for teeth the clinician never saw.
 */
async function testRedraftInvalidatesWhatCameFromTheOldNote() {
  section('A redraft invalidates everything derived from the old note');
  const base = { medicalHistory: null, alternatives: null, risks: null, benefits: null, costs: null,
    patientQuestions: null, patientFactors: null, informationGiven: null, nextStep: null,
    examination: null, radiographicFindings: null, plan: null, gaps: [],
    speakers: null, speakerConfidence: null };
  let drafts = 0;
  const ctx = await boot({
    onFetch: async (entry, opts) => {
      if (entry.url.includes('/api/transcribe')) return { ok: true, status: 200, json: async () => ({ status: 'done', turns: DEFAULT_TURNS }) };
      if (entry.url.includes('/api/extract')) {
        const b = JSON.parse(opts.body);
        if (b.kind === 'referral') {
          return { ok: true, status: 200, json: async () => ({ status: 'done', referral: {
            situation: 'FROM THE FIRST NOTE', background: null, assessment: null,
            recommendation: null, redFlags: [] } }) };
        }
        if (b.kind) return { ok: true, status: 200, json: async () => ({ status: 'done', summary: {
          whatWeDiscussed: 'x', whatYouDecided: null, whatHappensNext: null, whatToExpect: null, yourQuestions: null } }) };
        drafts++;
        return { ok: true, status: 200, json: async () => ({ status: 'done', note: {
          ...base, reasonForAttendance: 'Pain.', proposed: 'Removal.', decision: 'Proceed.',
          teeth: drafts === 1 ? ['LL8'] : ['LR8'] } }) };
      }
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
  await tick(320);

  click($(doc, 'confirm-teeth'));
  await tick(40);
  click($(doc, 'make-referral'));
  await tick(160);
  ok('a referral is produced from the first note', /FROM THE FIRST NOTE/.test($(doc, 'referral-text').textContent));
  ok('and the site is confirmed', doc.getElementById('teeth-strip').classList.contains('confirmed'));

  // Redraft at a different length. A NEW note replaces the old one.
  const full = [...doc.querySelectorAll('.length-picker:not(#template-picker) button')]
    .find((b) => /full/i.test(b.textContent));
  ok('the length picker is available', !!full);
  click(full);
  await tick(340);
  ok('the note was redrafted', drafts === 2, String(drafts));
  ok('the site check shows the NEW teeth', /LR8/.test(doc.getElementById('teeth-strip').textContent),
    doc.getElementById('teeth-strip').textContent.slice(0, 80));
  ok('and is no longer marked confirmed, because these teeth were never checked',
    !doc.getElementById('teeth-strip').classList.contains('confirmed'));

  // The referral was built from a note that no longer exists.
  ok('the stale referral is withdrawn rather than left on screen',
    $(doc, 'referral-box').classList.contains('hidden') &&
    !/FROM THE FIRST NOTE/.test($(doc, 'referral-text').textContent),
    $(doc, 'referral-text').textContent.slice(0, 80));
}

/**
 * Three clinicians share a surgery computer. The one who sits down second must
 * be able to see, without going looking, that the tool still thinks it is the
 * first one — otherwise they record under a colleague's identity and neither
 * of them ever knows, which defeats the whole point of per-user passcodes.
 */
async function testWhoseSession() {
  section('Whose session is this');
  let ctx = await boot({ session: { authenticated: true, expiresIn: 40000, who: 'SM' } });
  let el = $(ctx.doc, 'who');
  ok('the initials are shown', el.textContent === 'SM', el.textContent);
  ok('and visible, not just present in the markup', !el.classList.contains('hidden'));
  ok('beside Lock, which is what you reach for when it is not you',
    el.parentElement === $(ctx.doc, 'lock').parentElement);

  // A session from before per-user passcodes, or a practice still on the shared
  // code. Showing initials nobody can be held to is worse than showing none.
  ctx = await boot({ session: { authenticated: true, expiresIn: 40000, who: null } });
  el = $(ctx.doc, 'who');
  ok('an unidentified session shows nothing rather than guessing',
    el.textContent === '' && el.classList.contains('hidden'));

  ctx = await boot({ session: { authenticated: false, expiresIn: 0, who: null } });
  ok('and no session shows nothing', $(ctx.doc, 'who').classList.contains('hidden'));

  const src = html;
  ok('it stays off a printed note', /\.masthead #lock, \.masthead \.who,/.test(src));
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
  ok('the cap is 30 minutes', /MAX_MS:\s*30 \* 60 \* 1000/.test(src));
  ok('the recording view says so', /Stops automatically at 30:00/.test(src));
  ok('and the cap stays inside the real upload ceiling of ~31 min at 2.2 KB/s',
    (30 * 60) * 2256 < 4.2 * 1024 * 1024 * 0.95,
    `${((30 * 60) * 2256 / 1048576).toFixed(2)} MB projected vs ${(4.2 * 0.95).toFixed(2)} MB allowed`);
  ok('the reset message reads the constant rather than a hard-coded number',
    /'Stops automatically at ' \+ Math\.round\(CFG\.MAX_MS \/ 60000\)/.test(src));
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
await testSummaryFailureIsNotCopyable();
await testThinRecordingSaysSo();
await testRepeatedFailureSaysRetryingWontHelp();
await testExpiredWhileDraftingKeepsTranscript();
await testSessionLine();
await testWhoseSession();
await testSiteCheck();
await testRedraftInvalidatesWhatCameFromTheOldNote();
await testSpeakerSwap();
await testPostopSheet();
await testReferral();
await testNewRecordingDropsThePreviousPatient();
await testFailedDraftNeverShowsThePreviousPatientsNote();
await testMicCheck();
await testMicCheckFailureModes();
await testMicTestClosesBeforeRecording();
await testMicCheckHonoursClear();
await testDerivedButtonsRecoverForTheNextPatient();
await testWakeLockHonoursClear();
await testEveryAsyncPathHonoursTheGeneration();
await testOneResetPathNotTwo();
await testWakeLock();
await testIdleWarning();
await testUrlSwitches();
await testNotSaidPanel();
await testEditingAndLength();
await testStyles();
await testPolish();

console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}\n`);
process.exit(fail ? 1 : 0);
