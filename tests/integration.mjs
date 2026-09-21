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
  // A job now belongs to the session that submitted it, proved by a signed
  // ticket rather than anything stored. Requests without one are refused.
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'secret-for-tests';
  const { mintJobTicket } = await import('../api/_session.mjs');
  const ticketFor = async (id) => mintJobTicket(process.env.SESSION_SECRET, id, null);
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

  // A status check that fails TRANSIENTLY is not a failed job. This used to
  // delete the job on any non-OK answer, so one 503 — or a 429 when several
  // clinicians stop at once on one account — destroyed a transcription that was
  // running perfectly well, and with it the only copy of the consultation.
  // The clock is moved inside the stub so the 35 s budget lapses at once.
  {
    const realNow = Date.now;
    let shift = 0;
    Date.now = () => realNow() + shift;
    const quiet = console.warn; console.warn = () => {};
    calls = stubFetch(async (c) => {
      if (c.method === 'POST' && c.url.endsWith('/jobs')) return { status: 201, body: { id: 'jobB' } };
      if (c.method === 'GET') { shift += 60_000; return { status: 503, body: 'service unavailable' }; }
      if (c.method === 'DELETE') return { status: 200, body: {} };
      return { status: 404, body: {} };
    });
    res = mockRes();
    await handler(mockReq({ headers: { 'content-type': 'audio/webm' }, body: M4A(5000) }), res);
    Date.now = realNow; console.warn = quiet;
    ok('a status check that keeps failing transiently hands the job back as pending',
      res.statusCode === 202 && res.body?.jobId === 'jobB' && /^[a-f0-9]{64}$/.test(res.body?.ticket || ''),
      `${res.statusCode} ${JSON.stringify(res.body).slice(0, 80)}`);
    ok('and does NOT delete it: the client is coming back for it',
      !calls.some((c) => c.method === 'DELETE'));
  }

  // The POST's polling budget runs from when the request ARRIVED. A slow upload
  // and resubmission used to leave the full 35 s still to spend afterwards, so
  // the function could overrun its ceiling, be killed with a 504, and take the
  // recording and the id of the job it had just created with it.
  {
    const realNow = Date.now;
    let shift = 0;
    Date.now = () => realNow() + shift;
    let checks = 0;
    calls = stubFetch(async (c) => {
      if (c.method === 'POST' && c.url.endsWith('/jobs')) { shift += 40_000; return { status: 201, body: { id: 'jobSlow' } }; }
      if (c.method === 'GET' && c.url.endsWith('/jobs/jobSlow')) { checks++; return { status: 200, body: { job: { status: 'running' } } }; }
      if (c.method === 'DELETE') return { status: 200, body: {} };
      return { status: 404, body: {} };
    });
    res = mockRes();
    const t0 = realNow();
    await handler(mockReq({ headers: { 'content-type': 'audio/webm' }, body: M4A(5000) }), res);
    Date.now = realNow;
    ok('after a 40 s upload and submit, the job is handed back as pending at once',
      res.statusCode === 202 && res.body?.jobId === 'jobSlow' && checks === 1 && realNow() - t0 < 2000,
      `${res.statusCode}, ${checks} checks, ${realNow() - t0} ms`);
    const { config: tconfig } = await import('../api/transcribe.mjs');
    ok('and the function\'s ceiling leaves room above the budget for the upload itself',
      tconfig.maxDuration >= 120, String(tconfig.maxDuration));
  }

  // A permanent answer is still final, and still cleaned up.
  calls = stubFetch(async (c) => {
    if (c.method === 'POST' && c.url.endsWith('/jobs')) return { status: 201, body: { id: 'jobB4' } };
    if (c.method === 'GET') return { status: 404, body: 'no such job' };
    if (c.method === 'DELETE') return { status: 200, body: {} };
    return { status: 404, body: {} };
  });
  res = mockRes();
  await handler(mockReq({ headers: { 'content-type': 'audio/webm' }, body: M4A(5000) }), res);
  ok('a permanent status failure still returns an error', res.statusCode === 502, `got ${res.statusCode}`);
  ok('and the job is still deleted on that path',
    calls.some((c) => c.method === 'DELETE' && c.url.includes('jobB4')));

  // One bad check, then a good one, inside the same request: just a transcript.
  {
    const quiet = console.warn; console.warn = () => {};
    let checks = 0;
    calls = stubFetch(async (c) => {
      if (c.method === 'POST' && c.url.endsWith('/jobs')) return { status: 201, body: { id: 'jobB5' } };
      if (c.method === 'GET' && c.url.endsWith('/jobs/jobB5')) {
        checks++;
        return checks === 1 ? { status: 503, body: 'blip' } : { status: 200, body: { job: { status: 'done' } } };
      }
      if (c.method === 'GET' && c.url.includes('/transcript')) return { status: 200, body: TURNS_PAYLOAD };
      if (c.method === 'DELETE') return { status: 200, body: {} };
      return { status: 404, body: {} };
    });
    res = mockRes();
    await handler(mockReq({ headers: { 'content-type': 'audio/webm' }, body: M4A(5000) }), res);
    console.warn = quiet;
    ok('a single failed status check no longer costs the transcript',
      res.statusCode === 200 && Array.isArray(res.body?.turns), `got ${res.statusCode}`);
    ok('and the finished job is deleted as usual', calls.some((c) => c.method === 'DELETE' && c.url.includes('jobB5')));
  }

  // The GET route is one check. Transient there means "still pending", too.
  for (const [label, reply] of [['a 503', { status: 503, body: 'x' }], ['a 429', { status: 429, body: 'slow down' }], ['a network failure', 'THROW']]) {
    const quiet = console.warn; console.warn = () => {};
    calls = stubFetch(async (c) => {
      if (c.method === 'GET' && c.url.endsWith('/jobs/jobG')) {
        if (reply === 'THROW') throw new TypeError('fetch failed');
        return reply;
      }
      if (c.method === 'DELETE') return { status: 200, body: {} };
      return { status: 404, body: {} };
    });
    res = mockRes();
    await handler(mockReq({ method: 'GET', url: '/api/transcribe?jobId=jobG&ticket=' + (await ticketFor('jobG')) }), res);
    console.warn = quiet;
    ok(`a poll that meets ${label} reports the job still pending`, res.statusCode === 202 && res.body?.jobId === 'jobG', `got ${res.statusCode}`);
    ok(`and leaves it alone after ${label}`, !calls.some((c) => c.method === 'DELETE'));
  }
  calls = stubFetch(async (c) => {
    if (c.method === 'GET' && c.url.endsWith('/jobs/jobG4')) return { status: 404, body: 'gone' };
    if (c.method === 'DELETE') return { status: 200, body: {} };
    return { status: 404, body: {} };
  });
  res = mockRes();
  await handler(mockReq({ method: 'GET', url: '/api/transcribe?jobId=jobG4&ticket=' + (await ticketFor('jobG4')) }), res);
  ok('but a poll that meets a 404 is final', res.statusCode === 502, `got ${res.statusCode}`);
  ok('and that job is deleted', calls.some((c) => c.method === 'DELETE' && c.url.includes('jobG4')));

  // The job is DONE and the transcript exists: one failed fetch of it must not
  // hand the finished transcript to the delete.
  {
    let pulls = 0;
    calls = stubFetch(async (c) => {
      if (c.method === 'POST' && c.url.endsWith('/jobs')) return { status: 201, body: { id: 'jobT' } };
      if (c.method === 'GET' && c.url.endsWith('/jobs/jobT')) return { status: 200, body: { job: { status: 'done' } } };
      if (c.method === 'GET' && c.url.includes('/transcript')) {
        pulls++;
        return pulls === 1 ? { status: 502, body: 'bad gateway' } : { status: 200, body: TURNS_PAYLOAD };
      }
      if (c.method === 'DELETE') return { status: 200, body: {} };
      return { status: 404, body: {} };
    });
    res = mockRes();
    await handler(mockReq({ headers: { 'content-type': 'audio/webm' }, body: M4A(5000) }), res);
    ok('a finished transcript survives one failed fetch of it',
      res.statusCode === 200 && Array.isArray(res.body?.turns) && pulls === 2, `got ${res.statusCode}, ${pulls} fetches`);
    ok('and is deleted once collected', calls.filter((c) => c.method === 'DELETE' && c.url.includes('jobT')).length === 1);
  }

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
  await handler(mockReq({ method: 'DELETE', url: '/api/transcribe?jobId=abandoned9&ticket=' + (await ticketFor('abandoned9')) }), res);
  ok('Clear button cleanup deletes the job', calls.some((c) => c.method === 'DELETE' && c.url.includes('abandoned9')));
  ok('cleanup returns ok', res.statusCode === 200);

  // fetch does not throw on an HTTP error. A refused delete must not pass as done.
  {
    const errs = []; const quiet = console.error; console.error = (...a) => errs.push(a.join(' '));
    calls = stubFetch(async () => ({ status: 500, body: {} }));
    res = mockRes();
    await handler(mockReq({ method: 'DELETE', url: '/api/transcribe?jobId=stuck1&ticket=' + (await ticketFor('stuck1')) }), res);
    ok('a delete the provider refuses is reported as failed, not ok', res.statusCode === 502, `${res.statusCode}`);
    ok('and it is logged', errs.some((e) => /job delete failed: stuck1 HTTP 500/.test(e)));
    calls = stubFetch(async () => ({ status: 404, body: {} }));
    res = mockRes();
    await handler(mockReq({ method: 'DELETE', url: '/api/transcribe?jobId=gone1&ticket=' + (await ticketFor('gone1')) }), res);
    console.error = quiet;
    ok('a job that is already gone counts as deleted', res.statusCode === 200, `${res.statusCode}`);
  }

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
  await handler(mockReq({ method: 'GET', url: '/api/transcribe?jobId=jobLong&ticket=' + (await ticketFor('jobLong')) }), res);
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

  // --- the medical model, and what happens when an account cannot use it ---
  let sentCfgs = [];
  calls = stubFetch(async (c, opts) => {
    if (c.method === 'POST' && c.url.endsWith('/jobs')) {
      const cfg = JSON.parse(opts.body.get('config'));
      sentCfgs.push(cfg.transcription_config);
      return { status: 201, body: { id: 'jobD' } };
    }
    if (c.method === 'GET' && c.url.endsWith('/jobs/jobD')) return { status: 200, body: { job: { status: 'done' } } };
    if (c.method === 'GET' && c.url.includes('/transcript')) return { status: 200, body: TURNS_PAYLOAD };
    if (c.method === 'DELETE') return { status: 200, body: {} };
    return { status: 404, body: {} };
  });
  res = mockRes();
  await handler(mockReq({ headers: { 'content-type': 'audio/ogg' }, body: OGG(5000) }), res);
  ok('the medical domain model is requested', sentCfgs[0]?.domain === 'medical', JSON.stringify(sentCfgs[0]?.domain));
  ok('alongside the enhanced model and the dental dictionary',
    sentCfgs[0]?.model === 'enhanced' && Array.isArray(sentCfgs[0]?.additional_vocab) && sentCfgs[0].additional_vocab.length > 20,
    `${sentCfgs[0]?.model} / ${sentCfgs[0]?.additional_vocab?.length} terms`);

  sentCfgs = [];
  let attempt = 0;
  calls = stubFetch(async (c, opts) => {
    if (c.method === 'POST' && c.url.endsWith('/jobs')) {
      const cfg = JSON.parse(opts.body.get('config'));
      sentCfgs.push(cfg.transcription_config);
      attempt += 1;
      if (attempt === 1) return { status: 400, body: { error: 'domain medical is not enabled for this account' } };
      return { status: 201, body: { id: 'jobE' } };
    }
    if (c.method === 'GET' && c.url.endsWith('/jobs/jobE')) return { status: 200, body: { job: { status: 'done' } } };
    if (c.method === 'GET' && c.url.includes('/transcript')) return { status: 200, body: TURNS_PAYLOAD };
    if (c.method === 'DELETE') return { status: 200, body: {} };
    return { status: 404, body: {} };
  });
  res = mockRes();
  await handler(mockReq({ headers: { 'content-type': 'audio/ogg' }, body: OGG(5000) }), res);
  ok('an account without the medical model does NOT lose the consultation', res.statusCode === 200, `${res.statusCode} ${res.body?.detail || ''}`);
  ok('it retries once on the general model', sentCfgs.length === 2 && sentCfgs[0].domain === 'medical' && sentCfgs[1].domain === undefined,
    JSON.stringify(sentCfgs.map((c) => c.domain)));
  ok('keeping the dictionary and diarisation on the retry',
    sentCfgs[1].additional_vocab?.length > 20 && sentCfgs[1].diarization === 'speaker');

  // A failure that is nothing to do with the domain must not be retried away.
  sentCfgs = [];
  calls = stubFetch(async (c, opts) => {
    if (c.method === 'POST' && c.url.endsWith('/jobs')) { sentCfgs.push(1); return { status: 400, body: { error: 'invalid audio file' } }; }
    return { status: 404, body: {} };
  });
  res = mockRes();
  await handler(mockReq({ headers: { 'content-type': 'audio/ogg' }, body: OGG(5000) }), res);
  ok('an unrelated rejection is reported, not retried', sentCfgs.length === 1 && res.statusCode >= 400, `${sentCfgs.length} attempts, ${res.statusCode}`);

  // A found risk missing from the model's OWN gap list must not also be
  // restated as a separate itemised gap, duplicating the checklist's job.
  const sysNoDup = buildSystemPrompt('third-molar', 'standard');
  ok('the prompt tells the model not to itemise checklist items in its own gaps',
    /Do not itemise individual missing risks or alternatives here/.test(sysNoDup));

  // This used to pin 60 as "the Hobby plan cap". Vercel's limits have since
  // risen (300 s with Fluid compute), and api/extract.mjs has deployed at 120
  // on this very project throughout. The invariant worth pinning is that the
  // transcription ceiling never exceeds one already proven to deploy here — a
  // value the plan refused would fail the build and silently block every later
  // deploy.
  const { config: fnConfig } = await import('../api/transcribe.mjs');
  const { config: exConfig } = await import('../api/extract.mjs');
  ok('the transcription ceiling is no higher than drafting\'s, which is known to deploy on this plan',
    fnConfig?.maxDuration <= exConfig?.maxDuration, `${fnConfig?.maxDuration} vs ${exConfig?.maxDuration}`);
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
  ok('gap preserved, not filled in', res.body?.note?.risks === null && res.body?.note?.gaps?.[0] === 'No risks named by the clinician.', JSON.stringify(res.body?.note?.gaps));
  ok('a model that reports no checklist at all does NOT produce a wall of false "not mentioned" lines',
    res.body?.note?.notSaid?.length === 1 && /could not be applied/.test(res.body.notSaid?.[0] ?? res.body.note.notSaid[0]),
    JSON.stringify(res.body?.note?.notSaid));
  ok('and checklist findings never land in the model gap list',
    !res.body?.note?.gaps?.some((g) => /^Not mentioned:|^Not asked about:/.test(g)), JSON.stringify(res.body?.note?.gaps));
  ok('the raw checklist report is not passed to the client', !('checklist' in (res.body?.note || {})));

  // --- checklist: found items produce no gap; nulls do; unknown keys are ignored ---
  const withChecklist = { ...goodNote, checklist: { bleeding: 'you may bleed a little tonight', infection: null, 'made-up-key': 'x' } };
  bedrockReturning(JSON.stringify(withChecklist));
  res = mockRes();
  await handler(mockReq({ body: { turns, consultType: 'extraction-surgery' } }), res);
  ok('a checklist item with evidence is not reported', !res.body?.note?.notSaid?.includes('Not mentioned: bleeding.'), JSON.stringify(res.body?.note?.notSaid));
  ok('a checklist item reported null is reported as not said', res.body?.note?.notSaid?.includes('Not mentioned: infection or dry socket.'));
  ok('a key the checklist does not know cannot create an entry', !res.body?.note?.notSaid?.some((g) => /made-up/.test(g)));

  // The prompt asks for null, but a model that writes "not discussed" instead
  // must not have that read as evidence — the gap would silently disappear.
  for (const negative of ['null', 'None', 'n/a', 'not discussed', 'Not mentioned.', '\u2014', 'No evidence']) {
    bedrockReturning(JSON.stringify({ ...goodNote, checklist: { bleeding: negative, infection: 'dry socket explained' } }));
    res = mockRes();
    await handler(mockReq({ body: { turns, consultType: 'extraction-surgery' } }), res);
    ok(`checklist evidence of "${negative}" counts as not said`,
      res.body?.note?.notSaid?.includes('Not mentioned: bleeding.'), JSON.stringify(res.body?.note?.notSaid));
  }
  // A real quote that merely begins with a negative is still evidence.
  bedrockReturning(JSON.stringify({ ...goodNote, checklist: { bleeding: "No, it shouldn't bleed much after the first night", infection: null } }));
  res = mockRes();
  await handler(mockReq({ body: { turns, consultType: 'extraction-surgery' } }), res);
  // Seen live: a real recall came back with plan: "". The page renders "" and
  // null identically, so the guard has to treat them identically too.
  {
    const pm = await import('../api/_prompt.mjs');
    const blanked = { ...goodNote, plan: '   ', gaps: ['Medical history not discussed'] };
    const parsedBlank = pm.parseNote(JSON.stringify(blanked), 'exam-recall');
    ok('a whitespace-only field is normalised to null', parsedBlank.plan === null);
    // Since 21 September 2026 this no longer refuses on any consult type: the
    // blank is listed for the clinician to check (the clinical lead's decision).
    let surgBlank = { gaps: [] };
    try { surgBlank = pm.parseNote(JSON.stringify({ ...goodNote, plan: '', gaps: [] }), 'third-molar'); } catch (e) { surgBlank = { gaps: [], err: e.message }; }
    ok('an empty field with no gap reported now drafts on a surgical consultation too',
      Array.isArray(surgBlank.gaps) && surgBlank.gaps.length === 1, JSON.stringify(surgBlank.gaps));
    ok('and the blank risks field is the one listed, for the clinician to check',
      /^Material risks named, per option: left blank in the draft; check whether it came up$/.test(surgBlank.gaps[0]), surgBlank.gaps[0]);
  }

  ok('a quote that starts with "No" is still evidence',
    !res.body?.note?.notSaid?.includes('Not mentioned: bleeding.'), JSON.stringify(res.body?.note?.notSaid));
  bedrockReturning(JSON.stringify(withChecklist));
  res = mockRes();
  await handler(mockReq({ body: { turns, consultType: 'restorative' } }), res);
  ok('a consult type with no checklist reports nothing as not said', res.body?.note?.notSaid?.length === 0, JSON.stringify(res.body?.note?.notSaid));

  // --- dictation: the marker lands before the first turn at or after the timestamp ---
  let sentBody2 = null;
  stubFetch(async (c, opts) => { sentBody2 = JSON.parse(opts.body); return { status: 200, body: { content: [{ type: 'text', text: JSON.stringify(goodNote) }], stop_reason: 'end_turn' } }; });
  res = mockRes();
  const timedTurns = [
    { speaker: 'S1', text: 'We discussed taking the tooth out today.', start: 0.5 },
    { speaker: 'S2', text: 'Will it hurt afterwards?', start: 12.0 },
    { speaker: 'S1', text: 'Examination: lower left eight partially erupted, mesioangular.', start: 400.2 },
  ];
  await handler(mockReq({ body: { turns: timedTurns, consultType: 'third-molar', dictationFromS: 380 } }), res);
  let um = sentBody2?.messages?.[0]?.content || '';
  const idxMarker = um.indexOf('[DICTATION');
  const idxExam = um.indexOf('Examination: lower left');
  const idxQ = um.indexOf('Will it hurt');
  ok('the dictation marker is placed before the dictated turn', idxMarker > -1 && idxMarker < idxExam, `${idxMarker} ${idxExam}`);
  ok('and after the conversation', idxQ > -1 && idxQ < idxMarker);
  ok('the system prompt tells the model dictation cannot fill consent fields', /come ONLY from the[\s\S]{0,40}conversation with the patient/.test(sentBody2?.system || ''));

  stubFetch(async (c, opts) => { sentBody2 = JSON.parse(opts.body); return { status: 200, body: { content: [{ type: 'text', text: JSON.stringify(goodNote) }], stop_reason: 'end_turn' } }; });
  res = mockRes();
  await handler(mockReq({ body: { turns: timedTurns, consultType: 'third-molar' } }), res);
  ok('no marker without Dictate', !/\[DICTATION/.test(sentBody2?.messages?.[0]?.content || ''));

  // A transcript with no timings cannot be split. The worst outcome would be
  // dictated findings silently presented as things said to the patient.
  const untimed = [
    { speaker: 'S1', text: 'We discussed taking the tooth out today.' },
    { speaker: 'S1', text: 'Examination: lower left eight partially erupted.' }
  ];
  stubFetch(async (c, opts) => { sentBody2 = JSON.parse(opts.body); return { status: 200, body: { content: [{ type: 'text', text: JSON.stringify(goodNote) }], stop_reason: 'end_turn' } }; });
  res = mockRes();
  await handler(mockReq({ body: { turns: untimed, consultType: 'third-molar', dictationFromS: 30 } }), res);
  ok('an untimed transcript places no misleading dictation marker', !/\[DICTATION/.test(sentBody2?.messages?.[0]?.content || ''));
  ok('and the failure is reported at the top of the gap list, not hidden',
    /pressed Dictate/.test(res.body?.note?.gaps?.[0] || ''), JSON.stringify(res.body?.note?.gaps?.[0]));
  ok('the note is still returned rather than lost', res.statusCode === 200);

  // --- dictated fields and implant log survive the shape check ---
  const dictated = { ...goodNote, examination: 'LL8 partially erupted', radiographicFindings: null, plan: 'Surgical removal under LA',
    implantLog: [{ site: '36', system: 'Straumann BLT', diameter: '4.1', length: '10', lot: 'X123', torque: '35', isq: '72', graft: null, notes: null }] };
  bedrockReturning(JSON.stringify(dictated));
  res = mockRes();
  await handler(mockReq({ body: { turns, consultType: 'implant-surgery' } }), res);
  ok('dictated fields are returned', res.body?.note?.examination === 'LL8 partially erupted' && res.body?.note?.plan === 'Surgical removal under LA');
  ok('the implant log is returned as structured rows', res.body?.note?.implantLog?.[0]?.lot === 'X123', JSON.stringify(res.body?.note?.implantLog));
  bedrockReturning(JSON.stringify({ ...goodNote, implantLog: 'Straumann 4.1x10' }));
  res = mockRes();
  await handler(mockReq({ body: { turns, consultType: 'implant-surgery' } }), res);
  ok('an implant log that is not an array fails loudly', res.statusCode === 502 && /implantLog/.test(res.body?.detail || ''), `${res.statusCode} ${res.body?.detail}`);

  // --- patient summary: second product, same transcript, own prompt ---
  stubFetch(async (c, opts) => { sentBody2 = JSON.parse(opts.body); return { status: 200, body: { content: [{ type: 'text', text: JSON.stringify({ whatWeDiscussed: 'Your lower wisdom tooth.', whatYouDecided: null, whatHappensNext: 'A review in two weeks.', whatToExpect: null, yourQuestions: null }) }], stop_reason: 'end_turn' } }; });
  res = mockRes();
  await handler(mockReq({ body: { turns, consultType: 'third-molar', kind: 'summary' } }), res);
  ok('a summary request returns a summary, not a note', res.statusCode === 200 && res.body?.summary?.whatWeDiscussed === 'Your lower wisdom tooth.' && !res.body?.note, JSON.stringify(res.body).slice(0, 120));
  ok('using the patient-facing prompt', /FOR THE PATIENT to take home/.test(sentBody2?.system || ''));
  ok('which forbids invention as firmly as the note does', /include only what was actually said/.test(sentBody2?.system || ''));
  ok('absent summary sections come back null, not filled', res.body?.summary?.whatToExpect === null);

  // A malformed teeth value must fail loudly. A note whose site list is quietly
  // dropped would show "No tooth identified" on a note that named one.
  stubFetch(async () => ({ status: 200, body: { content: [{ type: 'text', text: JSON.stringify({ ...goodNote, teeth: '48' }) }], stop_reason: 'end_turn' } }));
  res = mockRes();
  await handler(mockReq({ body: { turns, consultType: 'third-molar' } }), res);
  ok('a teeth value that is not an array is rejected, not silently dropped',
    res.statusCode === 502 && /teeth is not an array/.test(JSON.stringify(res.body)),
    `${res.statusCode} ${JSON.stringify(res.body).slice(0, 90)}`);

  // A recording that captured nothing is a real answer, not a parser error. The
  // model must say so in gaps rather than return nulls with an empty gaps array,
  // which is what produced the failure Aiden hit on 8 September.
  let sentSys = null;
  stubFetch(async (c, opts) => { sentSys = JSON.parse(opts.body); return { status: 200, body: { content: [{ type: 'text', text: JSON.stringify(goodNote) }], stop_reason: 'end_turn' } }; });
  res = mockRes();
  await handler(mockReq({ body: { turns, consultType: 'third-molar' } }), res);
  const sys = sentSys?.system || '';
  const sys0 = sys;

  // The patient's one-word answer is often the consent itself. It must reach
  // the model; a length filter used to drop anything of five characters or less.
  {
    let sentUser = '';
    stubFetch(async (c, opts) => { sentUser = JSON.parse(opts.body).messages[0].content; return { status: 200, body: { content: [{ type: 'text', text: JSON.stringify(goodNote) }], stop_reason: 'end_turn' } }; });
    const shortTurns = [
      { speaker: 'S1', text: 'Are you happy to go ahead with taking the tooth out today?' },
      { speaker: 'S2', text: 'No.' },
      { speaker: 'S1', text: 'Did you want to think about the alternatives first?' },
      { speaker: 'S2', text: 'Yes.' },
      { speaker: 'S1', text: 'Okay.' },
      { speaker: 'S2', text: '...' }
    ];
    const r2 = mockRes();
    await handler(mockReq({ body: { turns: shortTurns, consultType: 'third-molar' } }), r2);
    ok('a patient\'s one-word "No." reaches the model', /\[S2\] No\./.test(sentUser), sentUser.slice(0, 200));
    ok('and so do "Yes." and "Okay."', /\[S2\] Yes\./.test(sentUser) && /\[S1\] Okay\./.test(sentUser));
    ok('while a turn with no words in it is still dropped', !/\[S2\] \.\.\./.test(sentUser));
  }

  // Radiographic findings for a third molar. "Close to the nerve" is a
  // conclusion; the signs behind it are what a Montgomery challenge examines and
  // what the receiving surgeon needs.
  ok('the third molar prompt asks for the specific radiographic signs',
    /darkening of the root/.test(sys0) && /interruption or loss of the canal/.test(sys0) &&
    /diversion or deflection/.test(sys0), 'sign vocabulary missing');
  ok('and the impaction and root morphology',
    /mesioangular, distoangular, horizontal, vertical/.test(sys0));
  ok('and forbids reasoning in either direction between sign and warning',
    /do NOT infer a sign from a warning, and do NOT infer a warning from a sign/i.test(sys0));

  // A routine recall has no consent discussion in it — nothing proposed, no
  // alternatives weighed, no decision. Demanding a gap for those made EVERY
  // exam/recall fail to draft, deterministically, and the retry button could
  // never help because drafting runs at temperature 0.
  const recallNote = { ...goodNote, gaps: [] };
  for (const k of ['proposed', 'alternatives', 'risks', 'benefits', 'costs', 'decision']) recallNote[k] = null;
  stubFetch(async () => ({ status: 200, body: { content: [{ type: 'text', text: JSON.stringify(recallNote) }], stop_reason: 'end_turn' } }));
  res = mockRes();
  await handler(mockReq({ body: { turns, consultType: 'exam-recall' } }), res);
  ok('a recall with no consent discussion drafts normally',
    res.statusCode === 200 && res.body?.note, `${res.statusCode} ${JSON.stringify(res.body).slice(0, 120)}`);
  ok('and the inapplicable fields stay null rather than being invented',
    res.body?.note?.risks === null && res.body?.note?.decision === null);

  // Seen live, September 2026: on a recall the model LEFT OUT patientFactors
  // rather than returning null, and every retry failed with "Missing field".
  const { notApplicableFields } = await import('../api/_prompt.mjs');
  const recallOmits = { ...recallNote };
  delete recallOmits.patientFactors;
  delete recallOmits.risks;
  stubFetch(async () => ({ status: 200, body: { content: [{ type: 'text', text: JSON.stringify(recallOmits) }], stop_reason: 'end_turn' } }));
  res = mockRes();
  await handler(mockReq({ body: { turns, consultType: 'exam-recall' } }), res);
  ok('a recall that leaves out an inapplicable field still drafts',
    res.statusCode === 200 && res.body?.note, `${res.statusCode} ${res.body?.detail || ''}`);
  ok('and the left-out fields come back as null, not undefined',
    res.body?.note?.patientFactors === null && res.body?.note?.risks === null);
  ok('patient-specific factors do not apply to a recall',
    notApplicableFields('exam-recall').includes('patientFactors'));
  ok('but still apply to every consult type that names risks',
    ['third-molar', 'extraction-surgery', 'implant-consult', 'implant-surgery', 'endo', 'restorative', 'perio', 'emergency', 'treatment-plan', 'sedation']
      .every((k) => !notApplicableFields(k).includes('patientFactors')));
  res = mockRes();
  await handler(mockReq({ body: { turns, consultType: 'third-molar' } }), res);
  // Since 21 September 2026 a left-out field is a blank field, on every type.
  ok('the SAME left-out fields on a surgical consultation now draft, each listed for checking',
    res.statusCode === 200 && (res.body?.note?.gaps || []).some((g) => /^Material risks.*left blank in the draft/.test(g)),
    `${res.statusCode} ${JSON.stringify(res.body?.note?.gaps)}`);
  const recallOmitsApplicable = { ...recallNote };
  delete recallOmitsApplicable.reasonForAttendance;
  stubFetch(async () => ({ status: 200, body: { content: [{ type: 'text', text: JSON.stringify(recallOmitsApplicable) }], stop_reason: 'end_turn' } }));
  res = mockRes();
  await handler(mockReq({ body: { turns, consultType: 'exam-recall' } }), res);
  ok('and a recall that leaves out a field that DOES apply drafts, with that field listed',
    res.statusCode === 200 && res.body?.note?.reasonForAttendance === null &&
      (res.body?.note?.gaps || []).some((g) => /^Reason for attendance.*left blank in the draft/.test(g)),
    `${res.statusCode} ${JSON.stringify(res.body?.note?.gaps)}`);
  ok('the model is told never to leave a key out',
    /Every key below must appear[^\n]*never leave a key out/.test(sys0));

  // Seen live, 21 September 2026: a recall with one field that DOES apply left
  // blank, and no gaps at all. Failed to draft, twice, on the same transcript.
  // It now drafts, and the blank is listed for the clinician to check.
  for (const field of ['patientQuestions', 'medicalHistory', 'informationGiven']) {
    const recallBlank = { ...recallNote, [field]: null, gaps: [] };
    stubFetch(async () => ({ status: 200, body: { content: [{ type: 'text', text: JSON.stringify(recallBlank) }], stop_reason: 'end_turn' } }));
    res = mockRes();
    await handler(mockReq({ body: { turns, consultType: 'exam-recall' } }), res);
    const g = res.body?.note?.gaps || [];
    ok(`a recall with ${field} blank and no gaps drafts, instead of failing`, res.statusCode === 200, `${res.statusCode} ${JSON.stringify(res.body).slice(0, 120)}`);
    ok(`and ${field} is listed as a gap for the clinician to check`,
      g.length === 1 && /left blank in the draft; check whether it came up/.test(g[0]), JSON.stringify(g));
  }
  {
    const pm = await import('../api/_prompt.mjs');
    let two = { gaps: [] };
    try { two = pm.parseNote(JSON.stringify({ ...recallNote, patientQuestions: null, nextStep: '', gaps: [] }), 'exam-recall'); } catch (e) { two = { gaps: [] }; }
    ok('every blank that applies gets its own gap, and none for the fields that do not apply',
      two.gaps.length === 2 && two.gaps.every((x) => /left blank in the draft/.test(x)) && !two.gaps.some((x) => /risk|alternative|decision/i.test(x)),
      JSON.stringify(two.gaps));
    ok('the added gaps never say something was not discussed, only that the draft is blank',
      !two.gaps.some((x) => /not discussed|not mentioned|not said/i.test(x)));
    const kept = pm.parseNote(JSON.stringify({ ...recallNote, patientQuestions: null, gaps: ['No questions asked'] }), 'exam-recall');
    ok('where the model did report gaps, its own wording is kept untouched', JSON.stringify(kept.gaps) === '["No questions asked"]', JSON.stringify(kept.gaps));
    ok('the model is still told to add gaps itself (the backstop is not the plan)',
      /add a plain-English entry to the gaps array naming what is missing/.test(sys0));
  }

  // The rule still bites where it matters. Same payload, surgical type.
  stubFetch(async () => ({ status: 200, body: { content: [{ type: 'text', text: JSON.stringify(recallNote) }], stop_reason: 'end_turn' } }));
  res = mockRes();
  await handler(mockReq({ body: { turns, consultType: 'third-molar' } }), res);
  ok('the SAME blanks on a surgical consultation now draft too, every blank listed',
    res.statusCode === 200 && (res.body?.note?.gaps || []).length > 0 &&
      res.body.note.gaps.every((x) => /left blank in the draft; check whether it came up$/.test(x)),
    `${res.statusCode} ${JSON.stringify(res.body?.note?.gaps)}`);
  ok('and on a surgical consultation the consent fields are among them (nothing excused there)',
    (res.body?.note?.gaps || []).some((x) => /^Material risks/.test(x)) && (res.body?.note?.gaps || []).some((x) => /^Decision/.test(x)),
    JSON.stringify(res.body?.note?.gaps));
  {
    const pm = await import('../api/_prompt.mjs');
    for (const type of ['emergency', 'implant-surgery', 'sedation', 'restorative', 'perio', 'endo', 'extraction-surgery', 'treatment-plan', 'implant-consult', 'third-molar']) {
      let out = null, err = null;
      try { out = pm.parseNote(JSON.stringify({ ...recallNote, gaps: [] }), type); } catch (e) { err = e.message; }
      ok(`${type}: blanks with no gaps draft instead of failing`, out && out.gaps.length > 0 && !err, err || JSON.stringify(out && out.gaps));
    }
  }

  // Which tooth. The never-event, arriving through a transcript.
  ok('the model is told to report which teeth were identified',
    /## WHICH TOOTH/.test(sys0) && /"teeth": string\[\]/.test(sys0));
  ok('and told not to infer one from the consult type',
    /Never infer a tooth from the consult type/.test(sys0));
  ok('and that an empty list is a real answer, not a failure',
    /Empty array if no tooth was identified/.test(sys0));

  ok('the model is told what to do with a transcript containing no consultation',
    /A TRANSCRIPT WITH NO CONSULTATION IN IT/.test(sys));
  ok('and told explicitly not to return nulls with an empty gaps array',
    /do NOT return a note[\s\S]{0,60}full of nulls with an empty gaps array/i.test(sys));
  ok('and told to say plainly that nothing usable was captured',
    /Nothing usable was recorded/.test(sys));

  // --- a speaker mapping the clinician corrected by hand ---
  let sentRoles = null;
  stubFetch(async (c, opts) => { sentRoles = JSON.parse(opts.body); return { status: 200, body: { content: [{ type: 'text', text: JSON.stringify(goodNote) }], stop_reason: 'end_turn' } }; });
  res = mockRes();
  await handler(mockReq({ body: { turns, consultType: 'third-molar',
    speakerRoles: { S1: 'clinician', S2: 'patient', S3: 'other', evil: 'clinician', S4: 'dentist' } } }), res);
  let msg = sentRoles?.messages?.[0]?.content || '';
  ok('a corrected mapping is put to the model as confirmed, not as a hint',
    /CONFIRMED MAPPING, corrected by the clinician who was present/.test(msg), msg.slice(0, 120));
  ok('valid labels and roles are carried through',
    /S1 is the clinician/.test(msg) && /S2 is the patient/.test(msg) && /S3 is the other/.test(msg));
  ok('a junk label is dropped', !/evil/.test(msg));
  ok('and a role that is not one of the three is dropped', !/dentist/.test(msg));

  // Both layers filter, so the two above hold even without the handler's
  // whitelist. The label length cap is the handler's alone — this is the
  // assertion that fails if its sanitising is removed.
  res = mockRes();
  await handler(mockReq({ body: { turns, consultType: 'third-molar',
    speakerRoles: { S1: 'clinician', S99999999: 'patient' } } }), res);
  msg = sentRoles?.messages?.[0]?.content || '';
  ok('an implausibly long speaker label is dropped by the handler',
    /S1 is the clinician/.test(msg) && !/S99999999/.test(msg), msg.slice(0, 140));
  ok('the model is told to stop second-guessing it',
    /Use it exactly[\s\S]{0,80}speakerConfidence to "high"/.test(msg));

  // No correction means no mention of one, or the model is primed with a
  // mapping nobody confirmed.
  res = mockRes();
  await handler(mockReq({ body: { turns, consultType: 'third-molar' } }), res);
  ok('and an ordinary draft says nothing about a confirmed mapping',
    !/CONFIRMED MAPPING/.test(sentRoles?.messages?.[0]?.content || ''));

  // --- post-op sheet: goes home in the patient's hands ---
  let sentPo = null;
  stubFetch(async (c, opts) => { sentPo = JSON.parse(opts.body); return { status: 200, body: { content: [{ type: 'text', text: JSON.stringify({ expect: 'Swelling.', pain: null, bleeding: null, careOfSite: null, eating: null, avoid: null, whenToWorry: null, followUp: null }) }], stop_reason: 'end_turn' } }; });
  res = mockRes();
  await handler(mockReq({ body: { turns, consultType: 'third-molar', kind: 'postop', note: { reasonForAttendance: 'Pain.' } } }), res);
  ok('a post-op request returns instructions, not a note',
    res.statusCode === 200 && res.body?.postop?.expect === 'Swelling.' && !res.body?.note, JSON.stringify(res.body).slice(0, 100));
  ok('an area that was not covered stays null rather than being filled in',
    res.body?.postop?.pain === null);
  ok('the model is forbidden from supplying the standard aftercare',
    /do NOT supply the standard aftercare for the procedure/i.test(sentPo?.system || ''));
  ok('and told why: it goes home with the practice\'s name on it',
    /goes home in the patient's hands with the practice's name on it/.test(sentPo?.system || ''));
  ok('doses are taken exactly as given',
    /never adjust, round or add one/i.test(sentPo?.system || ''));
  ok('and nothing may be invented — no number, dose or timescale',
    /Never invent a phone number, an opening time, a drug, a dose, or a timescale/.test(sentPo?.system || ''));

  res = mockRes();
  await handler(mockReq({ body: { turns, consultType: 'third-molar', kind: 'postop' } }), res);
  ok('instructions with no note behind them are refused',
    res.statusCode === 400 && res.body?.error === 'empty_postop_source', `${res.statusCode}`);

  // --- referral: third product, leaves the practice, so the strictest rules ---
  let sentBody3 = null;
  stubFetch(async (c, opts) => { sentBody3 = JSON.parse(opts.body); return { status: 200, body: { content: [{ type: 'text', text: JSON.stringify({ situation: 'Pain from the lower left third molar.', background: null, assessment: 'Distoangular impaction on the OPG.', recommendation: 'Surgical removal.', redFlags: ['trismus for a week'] }) }], stop_reason: 'end_turn' } }; });
  res = mockRes();
  await handler(mockReq({ body: { turns, consultType: 'third-molar', kind: 'referral',
    note: { reasonForAttendance: 'Crowding.', examination: 'Moderate crowding upper arch, posterior crossbite.' },
    context: 'Child, mixed dentition.' } }), res);
  ok('a referral request returns a referral, not a note or a summary',
    res.statusCode === 200 && res.body?.referral?.situation === 'Pain from the lower left third molar.' && !res.body?.note && !res.body?.summary,
    JSON.stringify(res.body).slice(0, 120));
  ok('laid out as SBAR', /Situation, Background, Assessment, Recommendation/.test(sentBody3?.system || ''));
  ok('and told to keep patient identifiers out, because the form already has them',
    /NEVER include the patient's name, date of birth, CHI number/.test(sentBody3?.system || ''));
  ok('absence of mention is explicitly not a negative finding',
    /absence of mention is NOT a negative finding/i.test(sentBody3?.system || ''));
  ok('but a stated negative is carried through rather than suppressed',
    /If any source SAYS the patient is medically fit and well, write that/.test(sentBody3?.system || ''));
  ok('the corrected note outranks the transcript',
    /THE CORRECTED NOTE. The clinician has already read this note and fixed it/.test(sentBody3?.system || '') &&
    /Prefer it over the transcript wherever the two differ/.test(sentBody3?.system || ''));
  ok('the dictated fields are named as where the substance lives',
    /dictated fields[\s\S]{0,120}where the referral's clinical substance lives/.test(sentBody3?.system || ''));
  ok('telegraphic dictation is expanded in grammar but never in content',
    /Expanding the grammar is required; expanding the content is forbidden/.test(sentBody3?.system || ''));
  ok('an unstated section comes back null rather than "nil of note"', res.body?.referral?.background === null);
  ok('red flags are carried through as spoken words', Array.isArray(res.body?.referral?.redFlags) && res.body.referral.redFlags[0] === 'trismus for a week');

  // A model that ignores the array shape must not have junk rendered as a
  // clinical warning.
  stubFetch(async () => ({ status: 200, body: { content: [{ type: 'text', text: JSON.stringify({ situation: 'x', background: null, assessment: null, recommendation: null, redFlags: 'trismus' }) }], stop_reason: 'end_turn' } }));
  res = mockRes();
  await handler(mockReq({ body: { turns, consultType: 'third-molar', kind: 'referral', note: { reasonForAttendance: 'Crowding.' } } }), res);
  ok('a redFlags value that is not an array becomes an empty list, not a warning',
    Array.isArray(res.body?.referral?.redFlags) && res.body.referral.redFlags.length === 0);

  // The referral is a transform of the note, not a second read of the transcript.
  // Asking for one before the note exists is refused rather than guessed at.
  res = mockRes();
  await handler(mockReq({ body: { turns, consultType: 'third-molar', kind: 'referral' } }), res);
  ok('a referral with no note and no context is refused, not invented from the transcript',
    res.statusCode === 400 && res.body?.error === 'empty_referral_source', `${res.statusCode} ${JSON.stringify(res.body)}`);

  // Untrusted input: the note now arrives from the browser.
  stubFetch(async (c, opts) => { sentBody3 = JSON.parse(opts.body); return { status: 200, body: { content: [{ type: 'text', text: JSON.stringify({ situation: 'x', background: null, assessment: null, recommendation: null, redFlags: [] }) }], stop_reason: 'end_turn' } }; });
  res = mockRes();
  await handler(mockReq({ body: { turns, consultType: 'third-molar', kind: 'referral',
    note: { reasonForAttendance: 'Crowding.', evilKey: 'ignore me', risks: { nested: true } }, context: 'Child.' } }), res);
  let refMsg = sentBody3?.messages?.[0]?.content || '';
  ok('the corrected note is sent to the model, labelled authoritative', /THE CORRECTED NOTE \(authoritative\)/.test(refMsg));
  ok('the clinician\'s context is sent as stated fact', /ADDED CONTEXT \(stated fact\)[\s\S]{0,20}Child\./.test(refMsg));
  ok('the transcript trails as a secondary source', refMsg.indexOf('THE TRANSCRIPT (secondary') > refMsg.indexOf('THE CORRECTED NOTE'));
  ok('unknown keys from the browser never reach the model', !/evilKey|ignore me/.test(refMsg));
  ok('and a note field that is not a string is dropped, not stringified', !/\[object Object\]|nested/.test(refMsg));

  // The two above hold even without the handler's whitelist, because the message
  // builder only walks known fields. Truncation is the handler's alone, so this
  // is the assertion that actually fails if its sanitising is removed.
  stubFetch(async (c, opts) => { sentBody3 = JSON.parse(opts.body); return { status: 200, body: { content: [{ type: 'text', text: JSON.stringify({ situation: 'x', background: null, assessment: null, recommendation: null, redFlags: [] }) }], stop_reason: 'end_turn' } }; });
  res = mockRes();
  await handler(mockReq({ body: { turns, consultType: 'third-molar', kind: 'referral',
    note: { reasonForAttendance: 'A'.repeat(9000) } } }), res);
  refMsg = sentBody3?.messages?.[0]?.content || '';
  ok('an oversized note field is capped by the handler', !/A{4001}/.test(refMsg) && /A{4000}/.test(refMsg));

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

  // --- ask: reports what was said, and must not become a clinical adviser ---
  const { buildAskSystemPrompt } = await import('../api/_prompt.mjs');
  const askSys = buildAskSystemPrompt('third-molar');
  ok('the ask prompt is bound to the transcript', /Answer ONLY from the transcript/.test(askSys));
  ok('and explicitly refuses to advise',
    /never give clinical advice/.test(askSys) && /never suggest a diagnosis or a treatment/.test(askSys));
  ok('and refuses to judge the consultation', /never comment on the standard of the consultation/.test(askSys));
  ok('and will not infer from a generality', /is not evidence that a specific risk was named/.test(askSys));
  ok('and is told the transcript may be spliced', /spliced/.test(askSys));

  let askBody = null;
  stubFetch(async (c, opts) => { askBody = JSON.parse(opts.body); return { status: 200, body: { content: [{ type: 'text', text: 'The cost was not discussed.' }], stop_reason: 'end_turn' } }; });
  res = mockRes();
  await handler(mockReq({ body: { kind: 'ask', question: 'Did I mention the cost?', turns, consultType: 'third-molar' } }), res);
  ok('an ask returns a plain answer, not a note',
    res.statusCode === 200 && res.body?.answer === 'The cost was not discussed.' && !res.body?.note, JSON.stringify(res.body).slice(0, 120));
  ok('using the ask prompt', /checking the draft note against the transcript/.test(askBody?.system || ''));
  ok('with the question attached to the transcript', /The dentist asks: Did I mention the cost\?/.test(askBody?.messages?.[0]?.content || ''));

  res = mockRes();
  await handler(mockReq({ body: { kind: 'ask', question: '   ', turns } }), res);
  ok('an empty question is refused rather than sent', res.statusCode === 400 && res.body?.error === 'empty_question', `${res.statusCode}`);

  stubFetch(async (c, opts) => { askBody = JSON.parse(opts.body); return { status: 200, body: { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' } }; });
  res = mockRes();
  await handler(mockReq({ body: { kind: 'ask', question: 'x'.repeat(900), turns } }), res);
  const askedText = (askBody?.messages?.[0]?.content || '').split('The dentist asks: ')[1] || '';
  ok('an over-long question is truncated, not rejected',
    res.statusCode === 200 && askedText.length === 500, `${res.statusCode}, question length ${askedText.length}`);

  stubFetch(async () => ({ status: 200, body: { content: [{ type: 'text', text: '' }], stop_reason: 'end_turn' } }));
  res = mockRes();
  await handler(mockReq({ body: { kind: 'ask', question: 'anything', turns } }), res);
  ok('an empty answer is reported rather than shown as blank', res.statusCode === 502 && res.body?.error === 'empty_answer');

  // --- who is who: advisory, sanitised, and never fatal ---
  const { parseNote: pn } = await import('../api/_prompt.mjs');
  const bare = { ...goodNote };
  ok('a clean speaker mapping survives',
    JSON.stringify(pn(JSON.stringify({ ...bare, speakers: { S1: 'clinician', S2: 'PATIENT' }, speakerConfidence: 'HIGH' })).speakers)
      === '{"S1":"clinician","S2":"patient"}');
  ok('confidence is normalised', pn(JSON.stringify({ ...bare, speakerConfidence: 'HIGH' })).speakerConfidence === 'high');
  ok('an invented role is discarded rather than shown to the clinician',
    pn(JSON.stringify({ ...bare, speakers: { S1: 'dentist' } })).speakers === null);
  ok('a mapping of the wrong shape is discarded', pn(JSON.stringify({ ...bare, speakers: ['S1'] })).speakers === null);
  ok('and a model that omits it entirely still yields a note',
    pn(JSON.stringify(bare)).speakers === null && pn(JSON.stringify(bare)).speakerConfidence === null);

  // --- length reaches the prompt ---
  let sysSent = null;
  stubFetch(async (c, opts) => { sysSent = JSON.parse(opts.body).system; return { status: 200, body: { content: [{ type: 'text', text: JSON.stringify(goodNote) }], stop_reason: 'end_turn' } }; });
  res = mockRes();
  await handler(mockReq({ body: { turns, consultType: 'third-molar', length: 'brief' } }), res);
  ok('a brief note is asked for briefly', /BRIEF\./.test(sysSent || ''), (sysSent || '').slice(0, 80));
  stubFetch(async (c, opts) => { sysSent = JSON.parse(opts.body).system; return { status: 200, body: { content: [{ type: 'text', text: JSON.stringify(goodNote) }], stop_reason: 'end_turn' } }; });
  res = mockRes();
  await handler(mockReq({ body: { turns, consultType: 'third-molar', length: 'nonsense' } }), res);
  ok('an unrecognised length falls back to standard rather than failing',
    res.statusCode === 200 && /STANDARD\./.test(sysSent || ''));
  ok('and length never relaxes the rules', /Length changes how much you write, never what you are allowed to write/.test(sysSent || ''));

  // consultType comes from the client. An inherited property name used to reach
  // Object.prototype and throw before the model was called, losing the note.
  for (const bad of ['constructor', '__proto__', 'toString']) {
    bedrockReturning(JSON.stringify(goodNote));
    res = mockRes();
    await handler(mockReq({ body: { turns, consultType: bad } }), res);
    ok(`consultType "${bad}" does not destroy the draft`, res.statusCode === 200, `got ${res.statusCode} ${res.body?.detail || ''}`);
  }
  bedrockReturning(JSON.stringify(goodNote));
  res = mockRes();
  await handler(mockReq({ body: { turns, consultType: 'not-a-real-type' } }), res);
  ok('an unknown consult type is simply treated as having no checklist',
    res.statusCode === 200 && res.body?.note?.notSaid?.length === 0, `${res.statusCode} ${JSON.stringify(res.body?.note?.notSaid)}`);

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
  // Since 21 September 2026: drafts, and the missing field is blank and listed.
  // goodNote already reports a gap of its own, so the model's gap stands and the
  // field is simply null; the page shows a null field as a gap regardless.
  ok('a missing field drafts as a blank field, never as invented content',
    res.statusCode === 200 && res.body?.note?.alternatives === null, `got ${res.statusCode}`);
  bedrockReturning(JSON.stringify({ ...missingField, gaps: [] }));
  res = mockRes();
  await handler(mockReq({ body: { turns, consultType: 'endo' } }), res);
  ok('and with no gaps of its own, the missing field is listed for checking',
    res.statusCode === 200 && (res.body?.note?.gaps || []).some((g) => /^Reasonable alternatives.*left blank in the draft/.test(g)),
    JSON.stringify(res.body?.note?.gaps));

  // --- nulls with no gaps: the model possibly dropping content ---
  // Until 21 September 2026 this refused the note. It now drafts, and every
  // blank is listed so the clinician checks it: nothing is silently dropped.
  const nullNoGaps = { ...goodNote, decision: null, gaps: [] };
  bedrockReturning(JSON.stringify(nullNoGaps));
  res = mockRes();
  await handler(mockReq({ body: { turns } }), res);
  ok('null field with empty gaps drafts, and the blanks are listed for checking',
    res.statusCode === 200 && (res.body?.note?.gaps || []).some((x) => /^Decision, or deferred.*: left blank in the draft; check whether it came up$/.test(x)) &&
      (res.body?.note?.gaps || []).some((x) => /^Material risks/.test(x)),
    `got ${res.statusCode} ${JSON.stringify(res.body?.note?.gaps)}`);

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

  // --- a busy or briefly unavailable service is retried (21 September 2026) ---
  {
    const ex = await import('../api/extract.mjs');
    ex._retry.sleepMs = 0;
    const seq = (codes) => { let i = 0; return stubFetch(async () => {
      const c = codes[Math.min(i++, codes.length - 1)];
      if (c === 'net') throw new Error('socket hang up');
      return c === 200 ? { status: 200, body: { content: [{ type: 'text', text: JSON.stringify(goodNote) }], stop_reason: 'end_turn' } }
                       : { status: c, body: { message: 'ThrottlingException' } };
    }); };
    for (const code of [429, 503, 500]) {
      const calls = seq([code, 200]);
      res = mockRes();
      await handler(mockReq({ body: { turns, consultType: 'endo' } }), res);
      ok(`a ${code} from the service is retried and the note drafts`, res.statusCode === 200 && calls.length === 2, `${res.statusCode} after ${calls.length} calls`);
    }
    let calls = seq(['net', 200]);
    res = mockRes();
    await handler(mockReq({ body: { turns, consultType: 'endo' } }), res);
    ok('a dropped connection is retried too', res.statusCode === 200 && calls.length === 2, `${res.statusCode} after ${calls.length} calls`);
    calls = seq([503, 503, 200]);
    res = mockRes();
    await handler(mockReq({ body: { turns, consultType: 'endo' } }), res);
    ok('two failures then success still drafts', res.statusCode === 200 && calls.length === 3, `${res.statusCode} after ${calls.length} calls`);
    calls = seq([429]);
    res = mockRes();
    await handler(mockReq({ body: { turns, consultType: 'endo' } }), res);
    ok('it gives up after three attempts, and says so', res.statusCode === 502 && calls.length === 3 && /bedrock 429/.test(res.body?.detail || ''), `${res.statusCode} after ${calls.length} calls`);
    calls = seq([400]);
    res = mockRes();
    await handler(mockReq({ body: { turns, consultType: 'endo' } }), res);
    ok('a refusal of the request itself is not retried (it would fail the same way)', res.statusCode === 502 && calls.length === 1, `${calls.length} calls`);
    calls = seq([403]);
    res = mockRes();
    await handler(mockReq({ body: { turns, consultType: 'endo' } }), res);
    ok('nor is a permissions error', calls.length === 1, `${calls.length} calls`);
    let firstAuth = null, secondAuth = null, n = 0;
    stubFetch(async (e, opts) => { n++; if (n === 1) { firstAuth = opts.headers.authorization; return { status: 503, body: {} }; }
      secondAuth = opts.headers.authorization; return { status: 200, body: { content: [{ type: 'text', text: JSON.stringify(goodNote) }], stop_reason: 'end_turn' } }; });
    res = mockRes();
    await handler(mockReq({ body: { turns, consultType: 'endo' } }), res);
    ok('a retry still carries a valid signature', res.statusCode === 200 && typeof secondAuth === 'string' && /^AWS4-HMAC-SHA256 /.test(secondAuth), String(secondAuth).slice(0, 40));
    ex._retry.sleepMs = null;
    ok('the function has room for a long draft and its retries (300 s)', ex.config.maxDuration === 300, String(ex.config.maxDuration));
  }

  // --- truncated at max_tokens ---
  bedrockReturning(JSON.stringify(goodNote).slice(0, 200), { stop_reason: 'max_tokens' });
  res = mockRes();
  await handler(mockReq({ body: { turns } }), res);
  ok('truncation reported distinctly', res.statusCode === 502 && res.body?.error === 'response_truncated', res.body?.error);
  ok('and tells the clinician what to do: choose Brief', /Choose Brief/.test(res.body?.detail || ''), res.body?.detail);

  // --- wrong-shaped fields: present, so parseNote passes, but not text --------
  // The dangerous one is an object: it renders as "[object Object]", it is not
  // null so no gap is raised, and whatever it contained is silently lost.
  // Since 21 September 2026 the two shapes the model actually produces for a
  // "per option" field are laid out as text, in its own words and order; the
  // rest are still refused.
  const laidOut = {
    'a list of risks':           [{ ...goodNote, risks: ['Nerve injury', 'Dry socket'] }, 'risks', 'Nerve injury\nDry socket'],
    'risks given per option':    [{ ...goodNote, risks: { Extraction: 'Nerve injury', Coronectomy: 'Root migration' } }, 'risks', 'Extraction: Nerve injury\nCoronectomy: Root migration'],
    'a gap given as an object':  [{ ...goodNote, gaps: [{ field: 'costs', note: 'not discussed' }] }, null, null]
  };
  for (const [label, [bad, key, want]] of Object.entries(laidOut)) {
    bedrockReturning(JSON.stringify(bad));
    res = mockRes();
    await handler(mockReq({ body: { turns } }), res);
    ok(`${label}: drafts, laid out as text`, res.statusCode === 200 && (key === null || res.body?.note?.[key] === want),
      `${res.statusCode} ${JSON.stringify(key ? res.body?.note?.[key] : res.body?.note?.gaps)}`);
  }
  ok('a gap given as an object keeps the model\'s own words', (res.body?.note?.gaps || []).includes('field: costs; note: not discussed'),
    JSON.stringify(res.body?.note?.gaps));
  bedrockReturning(JSON.stringify({ ...goodNote, risks: [] }));
  res = mockRes();
  await handler(mockReq({ body: { turns } }), res);
  ok('an empty list is a blank field, and is listed for checking',
    res.statusCode === 200 && res.body?.note?.risks === null && (res.body?.note?.gaps || []).some((g) => /^Material risks.*left blank/.test(g)),
    JSON.stringify(res.body?.note));
  const stillRefused = {
    'a number in costs':          { ...goodNote, costs: 340 },
    'a boolean in decision':      { ...goodNote, decision: true },
    'a list of objects in risks': { ...goodNote, risks: [{ option: 'Extraction', risk: 'Nerve injury' }] },
    'an object of lists in risks':{ ...goodNote, risks: { Extraction: ['Nerve injury', 'Pain'] } },
  };
  for (const [label, bad] of Object.entries(stillRefused)) {
    bedrockReturning(JSON.stringify(bad));
    res = mockRes();
    await handler(mockReq({ body: { turns } }), res);
    ok(`still refuses ${label} (laying it out would mean inventing a structure)`, res.statusCode === 502 && !res.body?.note, `got ${res.statusCode}`);
    ok(`and says which section, in words (${label})`, /came back as/.test(res.body?.detail || '') && /Field "/.test(res.body?.detail || ''), res.body?.detail);
  }
  bedrockReturning(JSON.stringify({ ...goodNote, risks: [{ option: 'Extraction', risk: 'Nerve injury' }] }));
  res = mockRes();
  await handler(mockReq({ body: { turns } }), res);
  ok('and names the offending field', /risks/.test(res.body?.detail || ''), res.body?.detail);

  // Words around the note, and a missing gaps list.
  const wrapped = {
    'a sentence before':          'Here is the note:\n' + JSON.stringify(goodNote),
    'a sentence after':           JSON.stringify(goodNote) + '\n\nLet me know if you need changes.',
    'a code fence mid-sentence':  'Here you go:\n```json\n' + JSON.stringify(goodNote) + '\n```\nDone.',
  };
  for (const [label, text] of Object.entries(wrapped)) {
    bedrockReturning(text);
    res = mockRes();
    await handler(mockReq({ body: { turns } }), res);
    ok(`words around the note (${label}) are ignored, and the note drafts unchanged`,
      res.statusCode === 200 && res.body?.note?.reasonForAttendance === 'Recorded.' && !/Here|Let me know|Done/.test(JSON.stringify(res.body?.note)),
      `${res.statusCode} ${JSON.stringify(res.body).slice(0, 100)}`);
  }
  bedrockReturning('I could not produce a note for this transcript.');
  res = mockRes();
  await handler(mockReq({ body: { turns } }), res);
  ok('an answer with no note in it at all is still refused', res.statusCode === 502 && /valid JSON/.test(res.body?.detail || ''), res.body?.detail);
  bedrockReturning('Here: {"reasonForAttendance": "x", ');
  res = mockRes();
  await handler(mockReq({ body: { turns } }), res);
  ok('and so is a note that is cut off part-way', res.statusCode === 502, `got ${res.statusCode}`);
  const noGaps = { ...goodNote, risks: 'Nerve injury.' }; delete noGaps.gaps;
  bedrockReturning(JSON.stringify(noGaps));
  res = mockRes();
  await handler(mockReq({ body: { turns } }), res);
  ok('no gaps list at all means nothing missing, not a refusal', res.statusCode === 200 && Array.isArray(res.body?.note?.gaps), `${res.statusCode}`);
  bedrockReturning(JSON.stringify({ ...goodNote, gaps: 'No risks named by the clinician.' }));
  res = mockRes();
  await handler(mockReq({ body: { turns } }), res);
  ok('a single gap given as a string is kept as one gap', res.statusCode === 200 && (res.body?.note?.gaps || []).includes('No risks named by the clinician.'), JSON.stringify(res.body?.note?.gaps));

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

  ok('matcher covers the gated tools and the API, and nothing else',
    JSON.stringify(config.matcher) === JSON.stringify(['/ai-notes/:path*', '/implant/:path*', '/api/:path*']),
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


  /* ---- the implant preview: a session is not enough, it must be his ---- */
  const asWho = async (who) => buildCookie(await mintToken(process.env.SESSION_SECRET, 3600, who)).split(';')[0];
  process.env.IMPLANT_USERS = 'AM';

  r = await middleware(req('/implant/'));
  ok('implant, not signed in: the passcode form, naming the tool', r?.status === 401 && (await r.clone().text()).includes('Implant Case Assessment'), `got ${r?.status}`);

  r = await middleware(req('/implant/', { cookie: await asWho('AM') }));
  ok('implant, signed in as the named clinician: allowed through', r === undefined, `got ${r?.status}`);

  r = await middleware(req('/implant/', { cookie: await asWho('SM') }));
  ok('implant, signed in as someone else: 403, not 401', r?.status === 403, `got ${r?.status}`);
  ok('and the 403 says the passcode was fine, the tool is not open to them',
    (await r.clone().text()).includes('not available to you'));

  r = await middleware(req('/implant/', { cookie: await asWho('am') }));
  ok('the list is not case-sensitive', r === undefined, `got ${r?.status}`);

  process.env.IMPLANT_USERS = ' AM , SM ';
  r = await middleware(req('/implant/', { cookie: await asWho('SM') }));
  ok('spaces around a name in the list do not lock that person out', r === undefined, `got ${r?.status}`);

  delete process.env.IMPLANT_USERS;
  r = await middleware(req('/implant/', { cookie: await asWho('AM') }));
  ok('with no list set, the tool is closed to everyone, author included', r?.status === 403, `got ${r?.status}`);
  process.env.IMPLANT_USERS = 'AM';

  const preToken = await mintToken(process.env.SESSION_SECRET, 3600);
  r = await middleware(req('/implant/', { cookie: buildCookie(preToken).split(';')[0] }));
  ok('a session from before per-user sign-in cannot open it either', r?.status === 403, `got ${r?.status}`);

  r = await middleware(req('/implant/viewer.js', { accept: '*/*', cookie: await asWho('SM') }));
  ok('the viewer bundle is gated too, not just the page', r?.status === 403, `got ${r?.status}`);

  r = await middleware(req('/implant/sw.js', { accept: '*/*' }));
  ok('but its service worker stays reachable, so the caching one can be evicted', r === undefined, `got ${r?.status}`);

  r = await middleware(req('/implant/', { accept: 'application/json', cookie: await asWho('SM') }));
  ok('a non-page request gets JSON, not an HTML page', r?.status === 403 && r.headers.get('content-type').includes('json'));

  // The open tools are protected by the matcher, not by this function: the
  // function 401s anything it is handed, which is why the matcher is the thing
  // to assert. A stray prefix here would take the whole site off the air.
  const covered = (p) => config.matcher.some((m) => new RegExp('^' + m.replace('/:path*', '(/.*)?$')).test(p));
  for (const open of ['/', '/third-molar/', '/sedation/', '/local-anaesthetic/', '/asa-assessment/', '/404.html']) {
    ok(`the matcher leaves ${open} alone`, !covered(open));
  }
  for (const shut of ['/implant/', '/implant/viewer.js', '/ai-notes/', '/api/auth']) {
    ok(`the matcher covers ${shut}`, covered(shut));
  }

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
/**
 * With one clinician and one shared passcode, nobody is identified and any
 * valid cookie can fetch any transcript given its id. With colleagues, that is
 * one patient's consent discussion handed to the wrong clinician.
 */
async function testMultiUser() {
  section('Per-user passcodes and job ownership');
  process.env.SESSION_SECRET = 'secret-for-tests';
  const S = process.env.SESSION_SECRET;
  const { mintToken, readToken, verifyToken, mintJobTicket, verifyJobTicket } = await import('../api/_session.mjs');
  const { parseUsers } = await import('../api/auth.mjs');

  // Identity in the token.
  const t = await mintToken(S, 3600, 'AM');
  const claims = await readToken(S, t);
  ok('a per-user session records who it belongs to', claims && claims.who === 'AM', JSON.stringify(claims));
  ok('and the identity is signed, not just carried',
    !(await verifyToken(S, t.replace('.AM.', '.MM.'))));

  // Existing sessions must survive the deploy. Somebody will be mid-recording.
  const legacy = await mintToken(S, 3600);
  ok('a session minted before this change still works', await verifyToken(S, legacy));
  ok('it simply has no identity', (await readToken(S, legacy)).who === null);

  // Job ownership.
  const mine = await mintJobTicket(S, 'job-1', 'AM');
  ok('a job ticket proves the job is this session\'s', await verifyJobTicket(S, 'job-1', 'AM', mine));
  ok('a colleague cannot use it', !(await verifyJobTicket(S, 'job-1', 'MM', mine)));
  ok('nor can it be reused for another job', !(await verifyJobTicket(S, 'job-2', 'AM', mine)));
  ok('and a missing ticket is refused, not waved through',
    !(await verifyJobTicket(S, 'job-1', 'AM', null)));

  // The route itself.
  process.env.SPEECHMATICS_API_KEY = 'k';
  process.env.SPEECHMATICS_API_BASE = 'https://eu1.asr.api.speechmatics.com/v2';
  const { default: transcribe } = await import('../api/transcribe.mjs');
  const theirs = await mintJobTicket(S, 'job-9', 'MM');
  let res = mockRes();
  await transcribe(mockReq({ method: 'GET', url: '/api/transcribe?jobId=job-9&ticket=' + theirs,
    headers: { cookie: 'ai_notes_session=' + (await mintToken(S, 3600, 'AM')) } }), res);
  ok('one clinician cannot poll another\'s transcript',
    res.statusCode === 403 && res.body?.error === 'job_not_yours', `${res.statusCode} ${JSON.stringify(res.body)}`);

  res = mockRes();
  await transcribe(mockReq({ method: 'GET', url: '/api/transcribe?jobId=job-9',
    headers: { cookie: 'ai_notes_session=' + (await mintToken(S, 3600, 'AM')) } }), res);
  ok('and a request with no ticket at all is refused', res.statusCode === 403, String(res.statusCode));

  // The page has to be able to SEE whose session it is, or the initials exist
  // only inside a signed cookie nobody can read.
  process.env.SESSION_SECRET = S;
  const { default: auth } = await import('../api/auth.mjs');
  const askWho = async (cookie) => {
    const r = mockRes();
    await auth(mockReq({ method: 'GET', url: '/api/auth', headers: { cookie } }), r);
    return r.body;
  };
  let body = await askWho('ai_notes_session=' + (await mintToken(S, 3600, 'SM')));
  ok('the session check reports who it belongs to', body?.authenticated && body?.who === 'SM', JSON.stringify(body));
  body = await askWho('ai_notes_session=' + (await mintToken(S, 3600)));
  ok('a pre-multi-user session reports no identity rather than a wrong one',
    body?.authenticated === true && body?.who === null, JSON.stringify(body));
  body = await askWho('');
  ok('and no session reports neither', body?.authenticated === false && body?.who === null, JSON.stringify(body));

  // Passcode parsing — a malformed entry must be dropped, never half-accepted.
  ok('per-user passcodes parse', parseUsers('AM:longenough1,MM:alsolongenough').length === 2);
  {
    const pm = await import('../api/_prompt.mjs');
    const secret = '"Mrs Example declined removal of the lower left eight"';
    for (const [name, fn] of [['note', (r) => pm.parseNote(r, 'third-molar')], ['summary', pm.parseSummary], ['post-op', pm.parsePostop], ['referral', pm.parseReferral]]) {
      for (const raw of [secret, 'null', '[1,2]', '42']) {
        let msg = null;
        try { fn(raw); } catch (e) { msg = e.message; }
        ok(`${name}: ${raw.slice(0, 6)} is refused as not an object, without quoting the response`,
          msg !== null && /not a JSON object/.test(msg) && !/Example|lower left/.test(msg), String(msg).slice(0, 100));
      }
    }
  }
  ok('a too-short passcode is dropped rather than accepted', parseUsers('AM:short').length === 0);
  ok('and a malformed label is dropped', parseUsers('A M!:longenough1').length === 0);
  {
    const quiet = console.error; console.error = () => {};
    const shared = parseUsers('AM:samepasscode1,SM:samepasscode1,NOC:different99');
    const twice = parseUsers('AM:firstcode11,AM:secondcode22,SM:thirdcode33');
    console.error = quiet;
    ok('two people given the same passcode are both refused, not misattributed',
      shared.length === 1 && shared[0].who === 'NOC', JSON.stringify(shared.map((u) => u.who)));
    ok('and the same initials listed twice are both refused',
      twice.length === 1 && twice[0].who === 'SM', JSON.stringify(twice.map((u) => u.who)));
  }
}

async function testAuth() {
  section('auth.mjs — passcode exchange');
  process.env.SESSION_SECRET = 'secret-for-tests';
  process.env.APP_USERS = 'AM:correct horse battery staple';
  delete process.env.APP_PASSCODE;
  const { default: handler } = await import('../api/auth.mjs');
  const { verifyToken, readToken } = await import('../api/_session.mjs');

  // The old single shared passcode is retired, not merely unset. Re-adding it
  // must not quietly bring back sign-ins that belong to nobody.
  {
    const warned = []; const quiet = console.warn; console.warn = (...a) => warned.push(a.join(' '));
    const quietErr = console.error; console.error = () => {};
    const savedUsers = process.env.APP_USERS;
    delete process.env.APP_USERS;
    process.env.APP_PASSCODE = 'the old shared code';
    let r = mockRes();
    await handler(mockReq({ body: { passcode: 'the old shared code' } }), r);
    ok('with only the old shared passcode set, nobody can sign in',
      r.statusCode === 500 && r.body?.error === 'server_misconfigured' && !r.headers['set-cookie'], `${r.statusCode}`);
    process.env.APP_USERS = savedUsers;
    r = mockRes();
    await handler(mockReq({ body: { passcode: 'the old shared code' } }), r);
    ok('and alongside the per-user codes, the old shared one is refused',
      r.statusCode === 401 && !r.headers['set-cookie'], `${r.statusCode}`);
    ok('and the log says why, rather than looking like a mistyped code',
      warned.some((w) => /APP_PASSCODE is set but is no longer used/.test(w)));
    delete process.env.APP_PASSCODE;
    console.warn = quiet; console.error = quietErr;
  }

  let res = mockRes();
  await handler(mockReq({ body: { passcode: 'correct horse battery staple' } }), res);
  ok('correct passcode accepted', res.statusCode === 200, `got ${res.statusCode}`);

  const setCookie = res.headers['set-cookie'] || '';
  ok('cookie is HttpOnly + Secure + SameSite=Strict',
    /HttpOnly/.test(setCookie) && /Secure/.test(setCookie) && /SameSite=Strict/.test(setCookie), setCookie);

  const token = setCookie.split('=')[1]?.split(';')[0];
  ok('issued token verifies', await verifyToken(process.env.SESSION_SECRET, token));
  ok('and says whose it is', (await readToken(process.env.SESSION_SECRET, token))?.who === 'AM');
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
  await testMultiUser();
await testAuth();
} finally {
  globalThis.fetch = realFetch;
}

console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}\n`);
process.exit(fail ? 1 : 0);
