// tests/integration.mjs — run with: node tests/integration.mjs
//
// Exercises the real handlers against stubbed Speechmatics and Bedrock. The
// point is not coverage; it is the handful of behaviours that are expensive or
// dangerous to get wrong:
//
//   - the Speechmatics job is deleted on EVERY path (DPIA R4)
//   - a malformed model response fails loudly instead of yielding a partial note
//   - the gate opens for /api/auth and nothing else
//   - a forged cookie does not pass
//
// No network. No credentials. Safe to run anywhere.

import { mintToken, buildCookie, COOKIE_NAME } from '../api/_session.mjs';

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? '  — ' + detail : ''}`); }
};
const section = (t) => console.log(`\n${t}\n${'-'.repeat(t.length)}`);

/* ---------- mocks ---------- */

function mockRes() {
  const r = {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }
  };
  return r;
}

function mockReq({ method = 'POST', url = '/api/x', headers = {}, body = null } = {}) {
  const req = { method, url, headers, body };
  req[Symbol.asyncIterator] = async function* () {}; // empty stream
  return req;
}

// Records every call so we can assert on what was NOT called as well as what was.
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const entry = { url: String(url), method: (opts.method || 'GET').toUpperCase() };
    calls.push(entry);
    const res = await handler(entry, opts);
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      json: async () => res.body,
      text: async () => (typeof res.body === 'string' ? res.body : JSON.stringify(res.body ?? ''))
    };
  };
  return calls;
}

// A minimal but genuine WebM/Matroska header, so fixtures look like recordings.
const WEBM = (n) => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(Math.max(0, n - 4), 7)]);
// What Safari's MediaRecorder produced, and what Speechmatics accepts.
const M4A = (n) => Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42', 'latin1'), Buffer.alloc(Math.max(0, n - 12), 3)
]);
// What the page produces now: Opus in Ogg, encoded in the browser.
const OGG = (n) => Buffer.concat([Buffer.from('OggS', 'latin1'), Buffer.alloc(Math.max(0, n - 4), 5)]);

const TURNS_PAYLOAD = {
  results: [
    { type: 'word', start_time: 0, end_time: .4, alternatives: [{ content: 'Extraction', speaker: 'S1' }] },
    { type: 'word', start_time: .4, end_time: .8, alternatives: [{ content: 'today', speaker: 'S1' }] },
    { type: 'punctuation', alternatives: [{ content: '.', speaker: 'S1' }] },
    { type: 'word', start_time: 1, end_time: 1.4, alternatives: [{ content: 'Will', speaker: 'S2' }] },
    { type: 'word', start_time: 1.4, end_time: 1.8, alternatives: [{ content: 'it', speaker: 'S2' }] },
    { type: 'word', start_time: 1.8, end_time: 2.2, alternatives: [{ content: 'hurt', speaker: 'S2' }] },
    { type: 'punctuation', alternatives: [{ content: '?', speaker: 'S2' }] }
  ]
};

/* ================================================================
   1. transcribe.mjs — job deletion on every path
   ================================================================ */
async function testTranscribe() {
  section('transcribe.mjs — Speechmatics job lifecycle (DPIA R4)');
  process.env.SPEECHMATICS_API_KEY = 'test-key';
  const { default: handler } = await import('../api/transcribe.mjs');

  // --- happy path ---
  let calls = stubFetch(async (c) => {
    if (c.method === 'POST' && c.url.endsWith('/jobs')) return { status: 201, body: { id: 'job123' } };
    if (c.method === 'GET' && c.url.endsWith('/jobs/job123')) return { status: 200, body: { job: { status: 'done' } } };
    if (c.method === 'GET' && c.url.includes('/transcript')) return { status: 200, body: TURNS_PAYLOAD };
    if (c.method === 'DELETE') return { status: 200, body: {} };
    return { status: 404, body: {} };
  });

  let res = mockRes();
  await handler(mockReq({ headers: { 'content-type': 'audio/webm' }, body: M4A(5000) }), res);

  ok('completed job returns turns', res.statusCode === 200 && res.body?.status === 'done', `got ${res.statusCode}`);
  ok('turns are diarised and joined',
    res.body?.turns?.[0]?.text === 'Extraction today.' && res.body?.turns?.[1]?.text === 'Will it hurt?',
    JSON.stringify(res.body?.turns));
  ok('DELETE issued after success', calls.some((c) => c.method === 'DELETE' && c.url.includes('job123')));
  ok('DELETE uses force=true', calls.some((c) => c.method === 'DELETE' && c.url.includes('force=true')));
  ok('no transcript left in the response envelope', !JSON.stringify(res.body).includes('jobId'));

  // --- rejected job: the path where it would be easiest to leak ---
  calls = stubFetch(async (c) => {
    if (c.method === 'POST') return { status: 201, body: { id: 'job456' } };
    if (c.method === 'GET') return { status: 200, body: { job: { status: 'rejected' } } };
    if (c.method === 'DELETE') return { status: 200, body: {} };
    return { status: 404, body: {} };
  });
  res = mockRes();
  await handler(mockReq({ headers: { 'content-type': 'audio/webm' }, body: M4A(5000) }), res);
  ok('rejected job returns an error', res.statusCode === 502, `got ${res.statusCode}`);
  ok('DELETE issued even when rejected', calls.some((c) => c.method === 'DELETE' && c.url.includes('job456')));

  // --- the body must arrive as binary, and be recognisable as audio ---------
  // A WebM/Matroska header, so this looks like a real recording.
  const webmHeader = WEBM(6000);  // deliberately the unsupported one

  calls = stubFetch(async (c) => {
    if (c.method === 'POST' && c.url.endsWith('/jobs')) return { status: 201, body: { id: 'jobW' } };
    if (c.method === 'GET' && c.url.endsWith('/jobs/jobW')) return { status: 200, body: { job: { status: 'done' } } };
    if (c.method === 'GET' && c.url.includes('/transcript')) return { status: 200, body: TURNS_PAYLOAD };
    if (c.method === 'DELETE') return { status: 200, body: {} };
    return { status: 404, body: {} };
  });
  res = mockRes();
  await handler(mockReq({ headers: { 'content-type': 'audio/webm;codecs=opus' }, body: webmHeader }), res);
  ok('webm is refused with a specific reason, not a vague one',
    res.statusCode === 400 && res.body?.error === 'audio_format_unsupported', `got ${res.statusCode}`);
  ok('and no job is created for it', !calls.some((c) => c.method === 'POST'));

  // MP4: what the browser should now be producing.
  const MP4 = (n) => Buffer.concat([
    Buffer.from([0,0,0,0x18]), Buffer.from('ftypmp42', 'latin1'), Buffer.alloc(Math.max(0, n - 12), 3)
  ]);
  calls = stubFetch(async (c) => {
    if (c.method === 'POST' && c.url.endsWith('/jobs')) return { status: 201, body: { id: 'jobM' } };
    if (c.method === 'GET' && c.url.endsWith('/jobs/jobM')) return { status: 200, body: { job: { status: 'done' } } };
    if (c.method === 'GET' && c.url.includes('/transcript')) return { status: 200, body: TURNS_PAYLOAD };
    if (c.method === 'DELETE') return { status: 200, body: {} };
    return { status: 404, body: {} };
  });
  res = mockRes();
  await handler(mockReq({ headers: { 'content-type': 'audio/mp4' }, body: MP4(6000) }), res);
  ok('an mp4 container is accepted', res.statusCode === 200, `got ${res.statusCode} ${res.body?.detail || ''}`);

  // Bytes that reached the server but carry no container header.
  calls = stubFetch(async () => ({ status: 201, body: { id: 'shouldNotHappen' } }));
  res = mockRes();
  await handler(mockReq({ headers: { 'content-type': 'audio/webm' }, body: Buffer.alloc(6000, 0x41) }), res);
  ok('unrecognised audio is refused before a job is created',
    res.statusCode === 400 && res.body?.error === 'audio_not_readable', `got ${res.statusCode}`);
  ok('and no Speechmatics job was created', !calls.some((c) => c.method === 'POST'));
  ok('and the error names the byte count and container',
    /bytes, container "UNRECOGNISED"/.test(res.body?.detail || ''), res.body?.detail);
  ok('and reports how the body was read', /read via "/.test(res.body?.detail || ''));

  // The failure mode that produced "invalid audio": platform decoded to text.
  res = mockRes();
  await handler(mockReq({ headers: { 'content-type': 'audio/webm' }, body: 'A'.repeat(6000) }), res);
  ok('a text-decoded body is caught and explained',
    res.statusCode === 400 && /decoded the body as text/.test(res.body?.detail || ''), res.body?.detail);

  // --- the unhappy paths: zero retention has to hold when things fail --------
  // Transcript fetch fails after the job completed.
  calls = stubFetch(async (c) => {
    if (c.method === 'POST' && c.url.endsWith('/jobs')) return { status: 201, body: { id: 'jobA' } };
    if (c.method === 'GET' && c.url.endsWith('/jobs/jobA')) return { status: 200, body: { job: { status: 'done' } } };
    if (c.method === 'GET' && c.url.includes('/transcript')) return { status: 500, body: 'upstream exploded' };
    if (c.method === 'DELETE') return { status: 200, body: {} };
    return { status: 404, body: {} };
  });
  res = mockRes();
  await handler(mockReq({ headers: { 'content-type': 'audio/webm' }, body: M4A(5000) }), res);
  ok('transcript fetch failure still returns an error', res.statusCode === 502);
  ok('job deleted even when the transcript fetch fails',
    calls.some((c) => c.method === 'DELETE' && c.url.includes('jobA')));

  // Status poll fails outright.
  calls = stubFetch(async (c) => {
    if (c.method === 'POST' && c.url.endsWith('/jobs')) return { status: 201, body: { id: 'jobB' } };
    if (c.method === 'GET') return { status: 503, body: 'service unavailable' };
    if (c.method === 'DELETE') return { status: 200, body: {} };
    return { status: 404, body: {} };
  });
  res = mockRes();
  await handler(mockReq({ headers: { 'content-type': 'audio/webm' }, body: M4A(5000) }), res);
  ok('poll failure returns an error', res.statusCode === 502);
  ok('job deleted even when polling fails outright',
    calls.some((c) => c.method === 'DELETE' && c.url.includes('jobB')));

  // A body the platform handed over as a string rather than a Buffer.
  calls = stubFetch(async (c) => {
    if (c.method === 'POST' && c.url.endsWith('/jobs')) return { status: 201, body: { id: 'jobC' } };
    if (c.method === 'GET' && c.url.endsWith('/jobs/jobC')) return { status: 200, body: { job: { status: 'done' } } };
    if (c.method === 'GET' && c.url.includes('/transcript')) return { status: 200, body: TURNS_PAYLOAD };
    if (c.method === 'DELETE') return { status: 200, body: {} };
    return { status: 404, body: {} };
  });
  res = mockRes();
  await handler(mockReq({ headers: { 'content-type': 'audio/webm' }, body: M4A(5000).toString('latin1') }), res);
  ok('a latin1 string body still round-trips to valid audio', res.statusCode === 200, `got ${res.statusCode} ${res.body?.detail||''}`);

  // --- explicit cleanup route, used by the Clear button ---
  calls = stubFetch(async () => ({ status: 200, body: {} }));
  res = mockRes();
  await handler(mockReq({ method: 'DELETE', url: '/api/transcribe?jobId=abandoned9' }), res);
  ok('Clear button cleanup deletes the job', calls.some((c) => c.method === 'DELETE' && c.url.includes('abandoned9')));
  ok('cleanup returns ok', res.statusCode === 200);

  // --- guards ---
  calls = stubFetch(async () => ({ status: 201, body: { id: 'shouldnothappen' } }));
  res = mockRes();
  await handler(mockReq({ headers: { 'content-type': 'audio/webm' }, body: Buffer.alloc(10, 1) }), res);
  ok('a few bytes of audio is refused, not submitted', res.statusCode === 400, `got ${res.statusCode}`);
  ok('no job created for a non-recording', !calls.some((c) => c.method === 'POST'));

  res = mockRes();
  await handler(mockReq({ headers: { 'content-type': 'audio/webm' }, body: M4A(5 * 1024 * 1024) }), res);
  ok('oversized audio rejected with 413', res.statusCode === 413, `got ${res.statusCode}`);

  res = mockRes();
  await handler(mockReq({ method: 'DELETE', url: '/api/transcribe?jobId=../../etc/passwd' }), res);
  ok('malformed job id refused, not reported as ok', res.statusCode === 400, `got ${res.statusCode}`);

  res = mockRes();
  await handler(mockReq({ method: 'DELETE', url: '/api/transcribe' }), res);
  ok('delete with no job id refused', res.statusCode === 400, `got ${res.statusCode}`);

  res = mockRes();
  await handler(mockReq({ method: 'PUT' }), res);
  ok('unsupported method refused', res.statusCode === 405);

  res = mockRes();
  await handler(mockReq({ body: null }), res);
  ok('empty body refused', res.statusCode === 400);

  // --- no key configured ---
  const saved = process.env.SPEECHMATICS_API_KEY;
  delete process.env.SPEECHMATICS_API_KEY;
  res = mockRes();
  await handler(mockReq({ body: M4A(5000) }), res);
  ok('missing key fails closed, no payload logged', res.statusCode === 500 && res.body?.error === 'server_misconfigured');
  process.env.SPEECHMATICS_API_KEY = saved;

  ok('no-store set on every response', res.headers['cache-control']?.includes('no-store'));

  // --- region: the hostname IS the DPIA (§2.7 records EU1) -------------------
  calls = stubFetch(async (c) => {
    if (c.method === 'POST' && c.url.endsWith('/jobs')) return { status: 201, body: { id: 'jobR' } };
    if (c.method === 'GET' && c.url.endsWith('/jobs/jobR')) return { status: 200, body: { job: { status: 'done' } } };
    if (c.method === 'GET' && c.url.includes('/transcript')) return { status: 200, body: TURNS_PAYLOAD };
    if (c.method === 'DELETE') return { status: 200, body: {} };
    return { status: 404, body: {} };
  });
  res = mockRes();
  await handler(mockReq({ headers: { 'content-type': 'audio/ogg' }, body: OGG(5000) }), res);
  ok('every Speechmatics call goes to the EU1 endpoint',
    calls.length > 0 && calls.every((c) => c.url.startsWith('https://eu1.asr.api.speechmatics.com/')),
    calls.map((c) => c.url).join(' '));

  process.env.SPEECHMATICS_API_BASE = 'https://asr.api.speechmatics.com/v2';   // the old unregioned host
  const { default: nonEu } = await import('../api/transcribe.mjs?base=legacy');
  calls = stubFetch(async () => ({ status: 201, body: { id: 'mustnot' } }));
  res = mockRes();
  await nonEu(mockReq({ headers: { 'content-type': 'audio/ogg' }, body: OGG(5000) }), res);
  ok('a non-EU endpoint fails closed', res.statusCode === 500 && res.body?.error === 'server_misconfigured', `got ${res.statusCode}`);
  ok('and sends nothing anywhere', calls.length === 0);
  delete process.env.SPEECHMATICS_API_BASE;

  // --- Ogg Opus, which the page now produces ---------------------------------
  let submitted = null;
  calls = stubFetch(async (c, opts) => {
    if (c.method === 'POST' && c.url.endsWith('/jobs')) {
      submitted = opts.body;
      return { status: 201, body: { id: 'jobO' } };
    }
    if (c.method === 'GET' && c.url.endsWith('/jobs/jobO')) return { status: 200, body: { job: { status: 'done' } } };
    if (c.method === 'GET' && c.url.includes('/transcript')) return { status: 200, body: TURNS_PAYLOAD };
    if (c.method === 'DELETE') return { status: 200, body: {} };
    return { status: 404, body: {} };
  });
  res = mockRes();
  await handler(mockReq({ headers: { 'content-type': 'audio/ogg' }, body: OGG(5000) }), res);
  ok('an Ogg recording is accepted and transcribed', res.statusCode === 200, `got ${res.statusCode} ${res.body?.detail || ''}`);
  const oggPart = submitted && submitted.get && submitted.get('data_file');
  ok('and submitted with the .ogg filename Speechmatics keys on', !!oggPart && oggPart.name === 'consult.ogg', oggPart && oggPart.name);

  // --- long recordings: GET is one check, never a wait --------------------------
  calls = stubFetch(async (c) => {
    if (c.method === 'GET' && c.url.endsWith('/jobs/jobLong')) return { status: 200, body: { job: { status: 'running' } } };
    return { status: 404, body: {} };
  });
  res = mockRes();
  const t0 = Date.now();
  await handler(mockReq({ method: 'GET', url: '/api/transcribe?jobId=jobLong' }), res);
  ok('a still-running job comes back 202 with its id', res.statusCode === 202 && res.body?.jobId === 'jobLong', `got ${res.statusCode}`);
  ok('after exactly one status check, with no sleeping', calls.length === 1 && Date.now() - t0 < 1000, `${calls.length} calls, ${Date.now() - t0} ms`);
  ok('and the job is NOT deleted while it is still wanted', !calls.some((c) => c.method === 'DELETE'));

  // --- paused recordings reach the prompt ---------------------------------
  const { buildUserMessage } = await import('../api/_prompt.mjs');
  const plain = buildUserMessage('hello');
  ok('an unpaused recording gets no pause preamble', plain.startsWith('Transcript of the consultation:'));
  const spliced = buildUserMessage('hello', [{ atRecordedMs: 305000, forMs: 2400000 }]);
  ok('a paused recording is declared as spliced', /PAUSED and resumed/.test(spliced) && /not spoken contiguously/.test(spliced));
  ok('and the gap is located and measured', /at 5:05 into the recording, paused for 40 minutes/.test(spliced), spliced.slice(0, 200));
  ok('a sub-second blip is not reported as a pause', buildUserMessage('hello', [{ atRecordedMs: 1000, forMs: 400 }]).startsWith('Transcript'));
  const { buildSystemPrompt } = await import('../api/_prompt.mjs');
  const sys = buildSystemPrompt(null);
  ok('the system prompt forbids asserting sequence across a gap', /Never assert or imply a sequence across a gap/.test(sys));

  const { config: fnConfig } = await import('../api/transcribe.mjs');
  ok('maxDuration fits the Hobby plan cap, so no invocation can be killed mid-poll', fnConfig?.maxDuration <= 60, String(fnConfig?.maxDuration));
}

/* ================================================================
   2. extract.mjs — must fail loudly, never partially
   ================================================================ */
function t2(label, cond) { ok(label, cond); }

async function testExtract() {
  section('extract.mjs — model output handling');
  process.env.AWS_ACCESS_KEY_ID = 'AKIAtest';
  process.env.AWS_SECRET_ACCESS_KEY = 'secrettest';
  process.env.AWS_REGION = 'eu-west-2';
  const { default: handler } = await import('../api/extract.mjs');
  const { FIELDS } = await import('../api/_prompt.mjs');

  const goodNote = Object.fromEntries(FIELDS.map(([k]) => [k, 'Recorded.']));
  goodNote.risks = null;
  goodNote.gaps = ['No risks named by the clinician.'];

  const turns = [{ speaker: 'S1', text: 'We discussed taking the tooth out today.' },
                 { speaker: 'S2', text: 'Will it hurt afterwards?' }];

  const bedrockReturning = (text, extra = {}) => stubFetch(async () => ({
    status: 200,
    body: { content: [{ type: 'text', text }], stop_reason: 'end_turn', ...extra }
  }));

  // --- happy path ---
  let calls = bedrockReturning(JSON.stringify(goodNote));
  let res = mockRes();
  await handler(mockReq({ body: { turns, consultType: 'extraction-surgery' } }), res);
  ok('valid note returned', res.statusCode === 200 && res.body?.note?.reasonForAttendance === 'Recorded.', `got ${res.statusCode} ${JSON.stringify(res.body).slice(0,90)}`);
  ok('gap preserved, not filled in', res.body?.note?.risks === null && res.body?.note?.gaps?.length === 1);

  // --- pauses reach the model, sanitised ---
  let sentBody = null;
  stubFetch(async (c, opts) => { sentBody = JSON.parse(opts.body); return { status: 200, body: { content: [{ type: 'text', text: JSON.stringify(goodNote) }], stop_reason: 'end_turn' } }; });
  res = mockRes();
  await handler(mockReq({ body: { turns, consultType: 'extraction-surgery',
    pauses: [{ atRecordedMs: 60000, forMs: 1800000 }, { atRecordedMs: 5, forMs: 10 }] } }), res);
  let userMsg = sentBody?.messages?.[0]?.content || '';
  ok('a paused recording is declared to the model', /PAUSED and resumed/.test(userMsg), userMsg.slice(0, 100));
  ok('and the sub-second blip is dropped', (userMsg.match(/into the recording/g) || []).length === 1);

  stubFetch(async (c, opts) => { sentBody = JSON.parse(opts.body); return { status: 200, body: { content: [{ type: 'text', text: JSON.stringify(goodNote) }], stop_reason: 'end_turn' } }; });
  res = mockRes();
  await handler(mockReq({ body: { turns, consultType: 'extraction-surgery' } }), res);
  ok('an unpaused recording says nothing about pauses',
    !/PAUSED/.test(sentBody?.messages?.[0]?.content || ''));

  stubFetch(async () => ({ status: 200, body: { content: [{ type: 'text', text: JSON.stringify(goodNote) }], stop_reason: 'end_turn' } }));
  res = mockRes();
  await handler(mockReq({ body: { turns, pauses: 'not an array' } }), res);
  ok('a malformed pauses field is ignored, not fatal', res.statusCode === 200, `got ${res.statusCode}`);
  ok('signed request went to eu-west-2 bedrock', calls[0]?.url.includes('bedrock-runtime.eu-west-2.amazonaws.com'), calls[0]?.url);

  // The path must carry the model id verbatim. Percent-encoding the colon signs
  // a path that fetch then normalises before sending, and the signature fails.
  const savedModel2 = process.env.BEDROCK_MODEL_ID;
  process.env.BEDROCK_MODEL_ID = 'eu.anthropic.claude-sonnet-4-5-20250929-v1:0';
  const { default: datedHandler } = await import('../api/extract.mjs?dated=1');
  calls = bedrockReturning(JSON.stringify(goodNote));
  res = mockRes();
  await datedHandler(mockReq({ body: { turns } }), res);
  // The wire path carries the raw colon; the SIGNATURE covers the escaped form.
  // Pinned to the canonical string Bedrock itself returned on a mismatch:
  //   /model/eu.anthropic.claude-sonnet-4-5-20250929-v1%3A0/invoke
  ok('a dated model id is SENT with a raw colon',
    calls[0]?.url.endsWith('/model/eu.anthropic.claude-sonnet-4-5-20250929-v1:0/invoke'), calls[0]?.url);
  ok('the wire path is not percent-encoded', !(calls[0]?.url || '').includes('%3A'), calls[0]?.url);
  ok('but the canonical path IS, exactly as AWS asks',
    '/model/' + encodeURIComponent('eu.anthropic.claude-sonnet-4-5-20250929-v1:0') + '/invoke'
      === '/model/eu.anthropic.claude-sonnet-4-5-20250929-v1%3A0/invoke');
  ok('and it still returns a note', res.statusCode === 200, `got ${res.statusCode}`);
  if (savedModel2) process.env.BEDROCK_MODEL_ID = savedModel2; else delete process.env.BEDROCK_MODEL_ID;

  // --- the failure that matters: a note with a field silently missing ---
  const missingField = { ...goodNote };
  delete missingField.alternatives;
  bedrockReturning(JSON.stringify(missingField));
  res = mockRes();
  await handler(mockReq({ body: { turns, consultType: 'endo' } }), res);
  ok('missing field fails loudly, no partial note', res.statusCode === 502 && !res.body?.note, `got ${res.statusCode}`);

  // --- nulls with no gaps: the model quietly dropping content ---
  const nullNoGaps = { ...goodNote, decision: null, gaps: [] };
  bedrockReturning(JSON.stringify(nullNoGaps));
  res = mockRes();
  await handler(mockReq({ body: { turns } }), res);
  ok('null field with empty gaps rejected', res.statusCode === 502, `got ${res.statusCode}`);

  // --- model wraps in fences despite instructions ---
  bedrockReturning('```json\n' + JSON.stringify(goodNote) + '\n```');
  res = mockRes();
  await handler(mockReq({ body: { turns } }), res);
  ok('fenced JSON still parses', res.statusCode === 200, `got ${res.statusCode}`);

  // --- model refuses or chats ---
  bedrockReturning('I am unable to help with that request.');
  res = mockRes();
  await handler(mockReq({ body: { turns } }), res);
  ok('non-JSON response rejected', res.statusCode === 502);

  // --- truncated at max_tokens ---
  bedrockReturning(JSON.stringify(goodNote).slice(0, 200), { stop_reason: 'max_tokens' });
  res = mockRes();
  await handler(mockReq({ body: { turns } }), res);
  ok('truncation reported distinctly', res.statusCode === 502 && res.body?.error === 'response_truncated', res.body?.error);

  // --- wrong-shaped fields: present, so parseNote passes, but not text --------
  // The dangerous one is an object: it renders as "[object Object]", it is not
  // null so no gap is raised, and whatever it contained is silently lost.
  const shapes = {
    'an object in risks':      { ...goodNote, risks: { text: 'nerve injury' } },
    'an array in risks':       { ...goodNote, risks: ['nerve', 'bleeding'] },
    'a number in costs':       { ...goodNote, costs: 340 },
    'a boolean in decision':   { ...goodNote, decision: true },
    'a nested object in gaps': { ...goodNote, gaps: [{ why: 'none named' }] }
  };
  for (const [label, bad] of Object.entries(shapes)) {
    bedrockReturning(JSON.stringify(bad));
    res = mockRes();
    await handler(mockReq({ body: { turns } }), res);
    ok(`rejects ${label}`, res.statusCode === 502 && !res.body?.note, `got ${res.statusCode}`);
  }

  bedrockReturning(JSON.stringify({ ...goodNote, risks: { text: 'nerve injury' } }));
  res = mockRes();
  await handler(mockReq({ body: { turns } }), res);
  ok('and names the offending field', /risks/.test(res.body?.detail || ''), res.body?.detail);

  // A null field is still legitimate — that is a gap, not a shape error.
  bedrockReturning(JSON.stringify({ ...goodNote, risks: null, gaps: ['No risks named.'] }));
  res = mockRes();
  await handler(mockReq({ body: { turns } }), res);
  ok('a null field is still accepted as a gap', res.statusCode === 200, `got ${res.statusCode}`);

  // --- guards ---
  res = mockRes();
  await handler(mockReq({ body: { turns: [] } }), res);
  ok('empty transcript refused', res.statusCode === 400);

  res = mockRes();
  await handler(mockReq({ method: 'GET' }), res);
  ok('GET refused', res.statusCode === 405);

  // --- residency guard ---
  const { checkResidency } = await import('../api/extract.mjs');
  const R = (m, r, p) => checkResidency(m, r, p);

  t2('eu policy accepts an eu. profile', R('eu.anthropic.claude-sonnet-4-5-20250929-v1:0', 'eu-west-2', 'eu') === null);
  t2('eu policy refuses a global. profile', /global\./.test(R('global.anthropic.claude-opus-4-6-v1', 'eu-west-2', 'eu') || ''));
  t2('eu policy refuses a us. profile', (R('us.anthropic.claude-opus-4-6-v1', 'eu-west-2', 'eu') || '').includes('adequacy'));
  t2('any policy refuses a non-EEA region', (R('eu.anthropic.claude-sonnet-4-5-20250929-v1:0', 'us-west-2', 'eu') || '').includes('outside the UK and EEA'));
  t2('uk policy refuses an eu. profile and explains why',
     (R('eu.anthropic.claude-sonnet-4-5-20250929-v1:0', 'eu-west-2', 'uk') || '').includes('does not currently offer UK-only'));
  t2('unknown policy refused', (R('eu.anthropic.x', 'eu-west-2', 'global') || '').includes('Expected'));

  // and it must fire before any request is signed
  process.env.DATA_RESIDENCY = 'eu';
  const savedModel = process.env.BEDROCK_MODEL_ID;
  process.env.BEDROCK_MODEL_ID = 'us.anthropic.claude-opus-4-6-v1';
  const { default: freshHandler } = await import('../api/extract.mjs?residency=1');
  calls = stubFetch(async () => ({ status: 200, body: { content: [{ type: 'text', text: '{}' }] } }));
  res = mockRes();
  await freshHandler(mockReq({ body: { turns } }), res);
  t2('violating config is refused before signing', res.statusCode === 500 && res.body?.error === 'residency_policy_violation');
  t2('no request left the server', calls.length === 0);
  if (savedModel) process.env.BEDROCK_MODEL_ID = savedModel; else delete process.env.BEDROCK_MODEL_ID;

  const savedKey = process.env.AWS_SECRET_ACCESS_KEY;
  delete process.env.AWS_SECRET_ACCESS_KEY;
  res = mockRes();
  await handler(mockReq({ body: { turns } }), res);
  ok('missing credentials fail closed', res.statusCode === 500);
  process.env.AWS_SECRET_ACCESS_KEY = savedKey;
}

/* ================================================================
   3. middleware.js — the gate
   ================================================================ */
async function testMiddleware() {
  section('middleware.js — gate behaviour');
  process.env.SESSION_SECRET = 'secret-for-tests';
  const { default: middleware, config } = await import('../middleware.js');

  const req = (path, { cookie, accept = 'text/html' } = {}) => new Request(
    'https://oralsurgeryassess.com' + path,
    { headers: { accept, ...(cookie ? { cookie } : {}) } }
  );

  ok('matcher covers only the two paths',
    JSON.stringify(config.matcher) === JSON.stringify(['/ai-notes/:path*', '/api/:path*']),
    JSON.stringify(config.matcher));

  let r = await middleware(req('/ai-notes/'));
  ok('unauthenticated page gets 401', r?.status === 401, `got ${r?.status}`);
  ok('401 body is a passcode form', (await r.text()).includes('Passcode'));

  r = await middleware(req('/api/transcribe', { accept: 'application/json' }));
  ok('unauthenticated API gets 401 JSON', r?.status === 401 && r.headers.get('content-type').includes('json'));

  r = await middleware(req('/api/auth', { accept: 'application/json' }));
  ok('/api/auth is open (or login is impossible)', r === undefined, `got ${r?.status}`);

  r = await middleware(req('/ai-notes/sw.js', { accept: '*/*' }));
  ok('/ai-notes/sw.js is open so registration cannot fail', r === undefined, `got ${r?.status}`);

  r = await middleware(req('/ai-notes/encoder.js', { accept: '*/*' }));
  ok('/ai-notes/encoder.js is open so the worklet load cannot fail on cookies', r === undefined, `got ${r?.status}`);

  r = await middleware(req('/ai-notes/index.html', { accept: '*/*' }));
  ok('but the page itself is still gated', r?.status === 401, `got ${r?.status}`);

  const token = await mintToken(process.env.SESSION_SECRET, 3600);
  r = await middleware(req('/ai-notes/', { cookie: buildCookie(token).split(';')[0] }));
  ok('valid cookie passes through', r === undefined, `got ${r?.status}`);

  r = await middleware(req('/ai-notes/', { cookie: `${COOKIE_NAME}=1` }));
  ok('forged flag cookie rejected', r?.status === 401);

  const stale = await mintToken(process.env.SESSION_SECRET, -60);
  r = await middleware(req('/ai-notes/', { cookie: `${COOKIE_NAME}=${stale}` }));
  ok('expired cookie rejected', r?.status === 401);

  const wrong = await mintToken('a-different-secret', 3600);
  r = await middleware(req('/ai-notes/', { cookie: `${COOKIE_NAME}=${wrong}` }));
  ok('cookie signed with another secret rejected', r?.status === 401);

  r = await middleware(req('/ai-notes/'));
  ok('challenge is noindex and no-store',
    r.headers.get('x-robots-tag')?.includes('noindex') && r.headers.get('cache-control')?.includes('no-store'));
  ok('challenge carries its own CSP', (r.headers.get('content-security-policy') || '').includes("default-src 'none'"));
  ok('challenge CSP allows only same-origin fetch', (r.headers.get('content-security-policy') || '').includes("connect-src 'self'"));
  ok('challenge cannot be framed', (r.headers.get('content-security-policy') || '').includes("frame-ancestors 'none'"));
  ok('challenge denies the microphone', (r.headers.get('permissions-policy') || '').includes('microphone=()'));
}

/* ================================================================
   4. auth.mjs
   ================================================================ */
async function testAuth() {
  section('auth.mjs — passcode exchange');
  process.env.SESSION_SECRET = 'secret-for-tests';
  process.env.APP_PASSCODE = 'correct horse battery staple';
  const { default: handler } = await import('../api/auth.mjs');
  const { verifyToken } = await import('../api/_session.mjs');

  let res = mockRes();
  await handler(mockReq({ body: { passcode: 'correct horse battery staple' } }), res);
  ok('correct passcode accepted', res.statusCode === 200, `got ${res.statusCode}`);

  const setCookie = res.headers['set-cookie'] || '';
  ok('cookie is HttpOnly + Secure + SameSite=Strict',
    /HttpOnly/.test(setCookie) && /Secure/.test(setCookie) && /SameSite=Strict/.test(setCookie), setCookie);

  const token = setCookie.split('=')[1]?.split(';')[0];
  ok('issued token verifies', await verifyToken(process.env.SESSION_SECRET, token));
  ok('token is not the passcode', !setCookie.includes('correct horse'));

  res = mockRes();
  await handler(mockReq({ body: { passcode: 'wrong' } }), res);
  ok('wrong passcode rejected', res.statusCode === 401);
  ok('rejection sets no cookie', !res.headers['set-cookie']);

  res = mockRes();
  await handler(mockReq({ body: {} }), res);
  ok('missing passcode rejected', res.statusCode === 401);

  res = mockRes();
  await handler(mockReq({ method: 'DELETE' }), res);
  ok('logout clears the cookie', res.statusCode === 200 && /Max-Age=0/.test(res.headers['set-cookie']));

  // --- session status endpoint ---
  const { mintToken: mk, buildCookie: bc, COOKIE_NAME: CN } = await import('../api/_session.mjs');

  const good = await mk(process.env.SESSION_SECRET, 3600);
  res = mockRes();
  await handler(mockReq({ method: 'GET', headers: { cookie: `${CN}=${good}` } }), res);
  ok('status reports an authenticated session', res.statusCode === 200 && res.body?.authenticated === true);
  ok('status reports time remaining', res.body?.expiresIn > 3500 && res.body?.expiresIn <= 3600, String(res.body?.expiresIn));

  res = mockRes();
  await handler(mockReq({ method: 'GET', headers: {} }), res);
  ok('status with no cookie is unauthenticated', res.statusCode === 200 && res.body?.authenticated === false);
  ok('unauthenticated status leaks no time', res.body?.expiresIn === 0);

  res = mockRes();
  await handler(mockReq({ method: 'GET', headers: { cookie: `${CN}=v1.9999999999.deadbeef` } }), res);
  ok('forged token rejected by status', res.body?.authenticated === false);

  const stale = await mk(process.env.SESSION_SECRET, -60);
  res = mockRes();
  await handler(mockReq({ method: 'GET', headers: { cookie: `${CN}=${stale}` } }), res);
  ok('expired token rejected by status', res.body?.authenticated === false);

  const { secondsRemaining } = await import('../api/_session.mjs');
  ok('secondsRemaining on a fresh token', secondsRemaining(good) > 3500);
  ok('secondsRemaining on rubbish is 0', secondsRemaining('nonsense') === 0);
  ok('secondsRemaining on expired is 0', secondsRemaining(stale) === 0);

  // throttle: 8 attempts per warm instance
  let throttled = false;
  for (let i = 0; i < 12; i++) {
    const r = mockRes();
    await handler(mockReq({ body: { passcode: 'guess' + i } }), r);
    if (r.statusCode === 429) throttled = true;
  }
  ok('repeated guesses eventually throttle', throttled);
}

/* ---------- run ---------- */
const realFetch = globalThis.fetch;
try {
  await testTranscribe();
  await testExtract();
  await testMiddleware();
  await testAuth();
} finally {
  globalThis.fetch = realFetch;
}

console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}\n`);
process.exit(fail ? 1 : 0);
