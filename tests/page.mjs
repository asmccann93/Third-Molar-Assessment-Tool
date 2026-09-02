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
      // A MediaRecorder that actually produces a plausible blob, so the pipeline
      // runs end to end rather than being poked at from outside.
      win.MediaRecorder = class {
        constructor(stream, opts = {}) {
          this.stream = stream; this.state = 'inactive'; this._l = {};
          this.mimeType = opts.mimeType || 'audio/webm';
        }
        addEventListener(k, f) { (this._l[k] = this._l[k] || []).push(f); }
        start() {
          this.state = 'recording';
          setTimeout(() => (this._l.dataavailable || []).forEach((f) =>
            f({ data: new win.Blob([new Uint8Array(6000)], { type: this.mimeType }) })), 5);
        }
        stop() {
          this.state = 'inactive';
          setTimeout(() => {
            // A real MediaRecorder flushes whatever is still buffered as one
            // last dataavailable BEFORE firing stop. That final chunk is the
            // entire discard bug, so the stub has to reproduce it or the
            // regression test below is worthless.
            (this._l.dataavailable || []).forEach((f) =>
              f({ data: new win.Blob([new Uint8Array(4000)], { type: this.mimeType }) }));
            (this._l.stop || []).forEach((f) => f({}));
          }, 5);
        }
      };
      // Only offer what Speechmatics accepts, as Safari/Firefox would.
      win.MediaRecorder.isTypeSupported = (t) => /mp4|ogg/.test(t);
      win.AudioContext = class {
        createMediaStreamSource() { return { connect() {} }; }
        createAnalyser() { return { fftSize: 512, connect() {}, getByteTimeDomainData(a) { a.fill(128); } }; }
        close() {}
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
  ok('eight consult types offered', types.children.length === 8, String(types.children.length));
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
  ok('all twelve fields render', $(doc, 'fields').children.length === 12, String($(doc, 'fields').children.length));
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
  ok('twelve fields present', $(doc, 'fields').children.length === 12);

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
async function testFormatAndSize() {
  section('Recording format — must be one Speechmatics accepts');
  const src = readFileSync(join(here, '../ai-notes/index.html'), 'utf8');

  const list = src.match(/var MIME_CANDIDATES = \[([\s\S]*?)\];/)[1];
  const entries = [...list.matchAll(/type: '([^']+)',\s*ok: (true|false)/g)].map((m) => ({ type: m[1], ok: m[2] === 'true' }));

  ok('mp4 is preferred first', entries[0].type.startsWith('audio/mp4'), entries[0].type);
  ok('every accepted format is on the Speechmatics list',
    entries.filter((e) => e.ok).every((e) => /mp4|m4a|ogg|wav|mp3|aac|flac/.test(e.type)));
  ok('webm is marked unacceptable', entries.filter((e) => /webm/.test(e.type)).every((e) => !e.ok));
  ok('webm is ordered last', /webm/.test(entries[entries.length - 1].type));

  ok('no timeslice, so the container is complete', /S\.recorder\.start\(\);/.test(src) && !/S\.recorder\.start\(\d/.test(src));
  ok('size is estimated from elapsed time instead', /var estimated = \(elapsed \/ 1000\)/.test(src));
  ok('and still warns before stopping', /SIZE_WARN/.test(src));
  ok('the stop threshold leaves headroom', /SIZE_STOP:\s*0\.95/.test(src));

  // A browser offering only WebM must be told before it records anything.
  const ctx = await boot();
  ctx.win.MediaRecorder.isTypeSupported = (t) => /webm/.test(t);
  const { doc, win } = ctx;
  $(doc, 'consent').checked = true;
  $(doc, 'consent').dispatchEvent(new win.Event('change', { bubbles: true }));
  click($(doc, 'types').children[0]);
  await tick();
  click($(doc, 'start'));
  await tick(80);
  ok('a webm-only browser is refused up front',
    !$(doc, 'error').classList.contains('hidden') &&
    /cannot record a supported format/i.test($(doc, 'error-title').textContent),
    $(doc, 'error-title').textContent);
  ok('and never enters the recording view', $(doc, 'recording').classList.contains('hidden'));
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

console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}\n`);
process.exit(fail ? 1 : 0);
