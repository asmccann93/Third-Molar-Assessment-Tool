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

// What a browser on this site sends: its own Origin, and JSON for an object
// body. /api/auth refuses anything else (login CSRF), so the defaults are the
// honest ones; a test about a cross-site request overrides them.
const SITE_HEADERS = { host: 'oralsurgeryassess.com', origin: 'https://oralsurgeryassess.com' };
function mockReq({ method = 'POST', url = '/api/x', headers = {}, body = null } = {}) {
  const json = body && typeof body === 'object' && !Buffer.isBuffer(body) && !(body instanceof Uint8Array) ? { 'content-type': 'application/json' } : {};
  const req = { method, url, headers: { ...SITE_HEADERS, ...json, ...headers }, body };
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

  // The delete has to be MADE before the answer goes back. Vercel may freeze
  // the function once the response is sent, so a delete left for a `finally`
  // after it may never reach Speechmatics, and the consultation stays there.
  {
    for (const [label, delStatus] of [['succeeds', 200], ['is refused', 500]]) {
      const order = [];
      stubFetch(async (c) => {
        order.push(`${c.method} ${c.url.includes('/transcript') ? 'transcript' : c.url.split('/').pop()}`);
        if (c.method === 'POST' && c.url.endsWith('/jobs')) return { status: 201, body: { id: 'jobO' } };
        if (c.method === 'GET' && c.url.endsWith('/jobs/jobO')) return { status: 200, body: { job: { status: 'done' } } };
        if (c.method === 'GET' && c.url.includes('/transcript')) return { status: 200, body: TURNS_PAYLOAD };
        if (c.method === 'DELETE') return { status: delStatus, body: {} };
        return { status: 404, body: {} };
      });
      res = mockRes();
      const sent = res.json.bind(res);
      res.json = (b) => { order.push('RESPONSE'); return sent(b); };
      const quiet = console.error; console.error = () => {};
      await handler(mockReq({ headers: { 'content-type': 'audio/webm' }, body: M4A(5000) }), res);
      console.error = quiet;
      const del = order.findIndex((e) => e.startsWith('DELETE'));
      ok(`when the delete ${label}, it is made before the transcript is sent back`,
        del !== -1 && del < order.indexOf('RESPONSE') && del > order.indexOf('GET transcript'), order.join(', '));
      ok(`and the clinician still gets the transcript when the delete ${label}`,
        res.statusCode === 200 && res.body?.turns?.[0]?.text === 'Extraction today.', `${res.statusCode}`);
    }
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
  // The backstop in assertShape skips the same fields parseNote does. A recall
  // whose risks came back as an empty list used to be told to check for risks.
  stubFetch(async () => ({ status: 200, body: { content: [{ type: 'text', text: JSON.stringify({ ...recallNote, risks: [], alternatives: [] }) }], stop_reason: 'end_turn' } }));
  res = mockRes();
  await handler(mockReq({ body: { turns, consultType: 'exam-recall' } }), res);
  ok('a recall with risks as an empty list drafts with no gap for a field that does not apply',
    res.statusCode === 200 && res.body?.note?.risks === null && res.body?.note?.alternatives === null &&
      !(res.body?.note?.gaps || []).some((g) => /^(Material risks|Reasonable alternatives)/.test(g)),
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

  // A single red flag given as a string, not a list, used to be dropped to an
  // empty list: the warning vanished. It is one flag.
  stubFetch(async () => ({ status: 200, body: { content: [{ type: 'text', text: JSON.stringify({ situation: 'x', background: null, assessment: null, recommendation: null, redFlags: 'trismus' }) }], stop_reason: 'end_turn' } }));
  res = mockRes();
  await handler(mockReq({ body: { turns, consultType: 'third-molar', kind: 'referral', note: { reasonForAttendance: 'Crowding.' } } }), res);
  ok('a redFlags value given as one string is kept as one flag, not dropped',
    res.statusCode === 200 && JSON.stringify(res.body?.referral?.redFlags) === '["trismus"]', JSON.stringify(res.body?.referral?.redFlags));

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
    // A failure late in the 300 s is reported, not retried into Vercel's kill:
    // that came back as a bare 504 with no JSON and no reason.
    {
      const realNow = Date.now;
      let late = 0;
      Date.now = () => realNow() + late;
      try {
        for (const [label, fail] of [['a 503', 503], ['a dropped connection', 'net']]) {
          late = 0;
          const calls = stubFetch(async () => {
            late = 250_000;   // this attempt took the request to 250 s
            if (fail === 'net') throw new Error('socket hang up');
            return { status: fail, body: { message: 'ServiceUnavailable' } };
          });
          res = mockRes();
          await handler(mockReq({ body: { turns, consultType: 'endo' } }), res);
          ok(`${label} at 250 s is not retried, and the real error comes back as JSON`,
            res.statusCode === 502 && calls.length === 1 &&
              (fail === 'net' ? /Could not reach the drafting service/ : /bedrock 503/).test(res.body?.detail || ''),
            `${res.statusCode} after ${calls.length} calls: ${String(res.body?.detail).slice(0, 60)}`);
        }
        late = 0;
        let n = 0;
        const calls = stubFetch(async () => {
          late = 30_000;
          return ++n === 1 ? { status: 503, body: {} } : { status: 200, body: { content: [{ type: 'text', text: JSON.stringify(goodNote) }], stop_reason: 'end_turn' } };
        });
        res = mockRes();
        await handler(mockReq({ body: { turns, consultType: 'endo' } }), res);
        ok('but a failure at 30 s is still retried', res.statusCode === 200 && calls.length === 2, `${res.statusCode} after ${calls.length} calls`);
      } finally {
        Date.now = realNow;
      }
    }
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

  // The matcher sends the bare path here too, and Vercel serves the tool's
  // index.html for it. Leaving the slash off must not be a way in.
  r = await middleware(req('/implant', { cookie: await asWho('SM') }));
  ok('/implant without the slash is shut to someone else as well', r?.status === 403, `got ${r?.status}`);
  r = await middleware(req('/implant', { accept: 'application/json', cookie: await asWho('SM') }));
  ok('and a non-page request for it too', r?.status === 403, `got ${r?.status}`);
  r = await middleware(req('/implant'));
  ok('/implant without the slash, not signed in: the passcode form, naming the tool',
    r?.status === 401 && (await r.clone().text()).includes('Implant Case Assessment'), `got ${r?.status}`);
  r = await middleware(req('/implant', { cookie: await asWho('AM') }));
  ok('/implant without the slash still opens for the named clinician', r === undefined, `got ${r?.status}`);
  r = await middleware(req('/implantation-notes'));
  ok('a path that only starts with the same letters is not treated as the tool', r?.status === 401 &&
    !(await r.clone().text()).includes('Implant Case Assessment'), `got ${r?.status}`);
  r = await middleware(req('/ai-notes'));
  ok('/ai-notes without the slash still needs a session', r?.status === 401, `got ${r?.status}`);
  r = await middleware(req('/ai-notes', { cookie: await asWho('SM') }));
  ok('and opens with one', r === undefined, `got ${r?.status}`);

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
  for (const shut of ['/implant/', '/implant', '/implant/viewer.js', '/ai-notes/', '/ai-notes', '/api/auth']) {
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

  // Deleting is different: it hands nobody a transcript. A job whose page is
  // now signed in as someone else must still be deletable, or it sits at
  // Speechmatics for a week. The ticket must still be one this server signed.
  {
    const savedUsers = process.env.APP_USERS;
    process.env.APP_USERS = 'AM:longenough1,MM:alsolongenough';
    const asAM = { cookie: 'ai_notes_session=' + (await mintToken(S, 3600, 'AM')) };
    let calls = stubFetch(async () => ({ status: 200, body: {} }));
    res = mockRes();
    await transcribe(mockReq({ method: 'DELETE', url: '/api/transcribe?jobId=job-9&ticket=' + theirs, headers: asAM }), res);
    ok('a colleague\'s signed ticket can delete the job',
      res.statusCode === 200 && calls.some((c) => c.method === 'DELETE' && c.url.includes('job-9')), `${res.statusCode} ${JSON.stringify(res.body)}`);
    const legacyTicket = await mintJobTicket(S, 'job-8', null);
    calls = stubFetch(async () => ({ status: 200, body: {} }));
    res = mockRes();
    await transcribe(mockReq({ method: 'DELETE', url: '/api/transcribe?jobId=job-8&ticket=' + legacyTicket, headers: asAM }), res);
    ok('so can a ticket from a pre-multi-user session',
      res.statusCode === 200 && calls.some((c) => c.method === 'DELETE' && c.url.includes('job-8')), `${res.statusCode}`);
    res = mockRes();
    await transcribe(mockReq({ method: 'GET', url: '/api/transcribe?jobId=job-9&ticket=' + theirs, headers: asAM }), res);
    ok('but that ticket still cannot fetch the colleague\'s transcript', res.statusCode === 403, `${res.statusCode}`);
    for (const [label, bad] of [['a forged ticket', 'f'.repeat(64)],
                                ['a ticket signed with another secret', await mintJobTicket('a-different-secret', 'job-9', 'MM')],
                                ['a ticket for another job', await mintJobTicket(S, 'job-7', 'MM')]]) {
      calls = stubFetch(async () => ({ status: 200, body: {} }));
      res = mockRes();
      await transcribe(mockReq({ method: 'DELETE', url: '/api/transcribe?jobId=job-9&ticket=' + bad, headers: asAM }), res);
      ok(`${label} still cannot delete a job`, res.statusCode === 403 && !calls.some((c) => c.method === 'DELETE'), `${res.statusCode}`);
    }
    if (savedUsers === undefined) delete process.env.APP_USERS; else process.env.APP_USERS = savedUsers;
  }

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

/* ================================================================
   Second review sweep, 25 September 2026: one block per finding.
   ================================================================ */
async function testSweep2() {
  section('Second review sweep — dictation split, pauses, parsers, throttle');
  process.env.SESSION_SECRET = 'secret-for-tests';
  process.env.SPEECHMATICS_API_KEY = 'test-key';
  process.env.AWS_ACCESS_KEY_ID = 'AKIAtest';
  process.env.AWS_SECRET_ACCESS_KEY = 'secrettest';
  const { default: transcribe } = await import('../api/transcribe.mjs');
  const { default: extract } = await import('../api/extract.mjs');
  const pm = await import('../api/_prompt.mjs');
  const { checklistGaps } = await import('../api/_checklists.mjs');
  const { FIELDS } = pm;
  const goodNote = Object.fromEntries(FIELDS.map(([k]) => [k, 'Recorded.']));
  goodNote.gaps = [];
  let sent = null;
  const bedrock = (text) => stubFetch(async (c, opts) => {
    sent = JSON.parse(opts.body);
    return { status: 200, body: { content: [{ type: 'text', text }], stop_reason: 'end_turn' } };
  });
  const userMsg = () => sent?.messages?.[0]?.content || '';
  const w = (c, st, en, sp) => ({ type: 'word', start_time: st, end_time: en, alternatives: [{ content: c, speaker: sp }] });
  const pn = (c, sp) => ({ type: 'punctuation', alternatives: [{ content: c, speaker: sp }] });

  // --- 1. the clinician's goodbye and the dictation after it are one voice ---
  // Conversation to 20 s; goodbye at 18-19 s; Dictate pressed at 21 s;
  // dictation from 24 s. Speechmatics labels it all S1.
  const results = [
    w('Any', 10, 10.3, 'S2'), w('other', 10.3, 10.6, 'S2'), w('questions', 10.6, 11, 'S2'), pn('?', 'S2'),
    w('No', 12, 12.3, 'S1'), pn(',', 'S1'), w('see', 18, 18.3, 'S1'), w('you', 18.3, 18.6, 'S1'), w('soon', 18.6, 19, 'S1'), pn('.', 'S1'),
    w('Lower', 24, 24.3, 'S1'), w('left', 24.3, 24.6, 'S1'), w('eight', 24.6, 25, 'S1'), w('mesioangular', 25, 26, 'S1'), pn('.', 'S1'),
  ];
  stubFetch(async (c) => {
    if (c.method === 'POST' && c.url.endsWith('/jobs')) return { status: 201, body: { id: 'jobSil' } };
    if (c.method === 'GET' && c.url.endsWith('/jobs/jobSil')) return { status: 200, body: { job: { status: 'done' } } };
    if (c.method === 'GET' && c.url.includes('/transcript')) return { status: 200, body: { results } };
    if (c.method === 'DELETE') return { status: 200, body: {} };
    return { status: 404, body: {} };
  });
  let res = mockRes();
  await transcribe(mockReq({ headers: { 'content-type': 'audio/ogg' }, body: OGG(5000) }), res);
  const turns = res.body?.turns || [];
  ok('a silence of 1.5 s or more ends a turn, even with the same speaker either side',
    turns.length === 4 && turns[2]?.text === 'see you soon.' && turns[3]?.text === 'Lower left eight mesioangular.',
    JSON.stringify(turns.map((t) => t.text)));
  ok('and every turn carries both its start and its end',
    turns.length > 0 && turns.every((t) => Number.isFinite(t.start) && Number.isFinite(t.end)) && turns[3]?.start === 24 && turns[3]?.end === 26,
    JSON.stringify(turns.map((t) => [t.start, t.end])));
  ok('and where each word starts, in the text and in the recording',
    JSON.stringify(turns[3]?.words?.slice(0, 2)) === '[{"at":0,"start":24},{"at":6,"start":24.3}]', JSON.stringify(turns[3]?.words));

  bedrock(JSON.stringify(goodNote));
  res = mockRes();
  await extract(mockReq({ body: { turns, consultType: 'third-molar', dictationFromS: 21 } }), res);
  let um = userMsg();
  ok('so the dictation marker lands between the goodbye and the dictation',
    um.indexOf('see you soon') > -1 && um.indexOf('see you soon') < um.indexOf('[DICTATION') && um.indexOf('[DICTATION') < um.indexOf('Lower left eight'),
    um.slice(um.indexOf('<transcript>'), um.indexOf('</transcript>')));

  // A turn that still straddles the Dictate press is split at the first word
  // at or after it, where the words came with the turn...
  const straddle = { speaker: 'S1', text: 'see you soon. Lower left eight.', start: 18, end: 20.5,
    words: [{ at: 0, start: 18 }, { at: 4, start: 18.3 }, { at: 8, start: 18.6 }, { at: 14, start: 19.8 }, { at: 20, start: 20 }, { at: 25, start: 20.2 }] };
  bedrock(JSON.stringify(goodNote));
  res = mockRes();
  await extract(mockReq({ body: { turns: [{ speaker: 'S2', text: 'Thanks.', start: 10, end: 11 }, straddle], consultType: 'third-molar', dictationFromS: 19.5 } }), res);
  um = userMsg();
  ok('a turn straddling the Dictate press is split at the first word after it',
    /\[S1\] see you soon\.\n\[DICTATION[^\n]*\]\n\[S1\] Lower left eight\./.test(um), um.slice(um.indexOf('<transcript>'), um.indexOf('</transcript>')));
  ok('and a split made at a word needs no warning', !res.body?.note?.gaps?.some((g) => /could not be placed exactly/.test(g)), JSON.stringify(res.body?.note?.gaps));

  // ...and without word timings the marker goes in front of the whole turn, and says so.
  bedrock(JSON.stringify(goodNote));
  res = mockRes();
  const { words: _drop, ...bare } = straddle;
  await extract(mockReq({ body: { turns: [{ speaker: 'S2', text: 'Thanks.', start: 10, end: 11 }, bare], consultType: 'third-molar', dictationFromS: 19.5 } }), res);
  um = userMsg();
  ok('without word timings, a straddling turn goes after the marker, not before it',
    um.indexOf('[DICTATION') > -1 && um.indexOf('[DICTATION') < um.indexOf('see you soon') && um.indexOf('Thanks.') < um.indexOf('[DICTATION'),
    um.slice(um.indexOf('<transcript>'), um.indexOf('</transcript>')));
  ok('and the gap list says the start of the dictation could not be placed exactly',
    /pressed Dictate part-way through[\s\S]*could not be placed exactly/.test(res.body?.note?.gaps?.[0] || ''), JSON.stringify(res.body?.note?.gaps));

  // --- 2. referral red flags in the wrong shape are kept, or refused, never dropped ---
  ok('a red flag given as a string is one flag',
    JSON.stringify(pm.parseReferral('{"situation":"x","redFlags":"Non-healing ulcer left lateral tongue, 4 weeks"}').redFlags) === '["Non-healing ulcer left lateral tongue, 4 weeks"]');
  ok('red flags given as objects are laid out as text',
    JSON.stringify(pm.parseReferral('{"situation":"x","redFlags":[{"quote":"lump in the neck"}]}').redFlags) === '["quote: lump in the neck"]');
  for (const bad of ['{"redFlags":42}', '{"redFlags":[7]}', '{"redFlags":[{"quote":["a"]}]}', '{"redFlags":{"quote":"lump"}}']) {
    let msg = null;
    try { pm.parseReferral(bad); } catch (e) { msg = e.message; }
    ok(`red flags as ${bad.slice(12, 24)} refuse the referral loudly rather than vanish`, msg !== null && /red ?flag/i.test(msg), String(msg));
  }

  // --- 3. pauses are marked in the transcript, where the model reads ---
  const paused = [
    { speaker: 'S1', text: 'I will just have a look now.', start: 80, end: 82 },
    { speaker: 'S1', text: 'That all looks fine.', start: 96, end: 98 },
  ];
  bedrock(JSON.stringify(goodNote));
  res = mockRes();
  await extract(mockReq({ body: { turns: paused, consultType: 'third-molar', pauses: [{ atRecordedMs: 95000, forMs: 600000 }] } }), res);
  um = userMsg();
  ok('a pause is marked by a PAUSED line before the first turn after it',
    /have a look now\.\n\[PAUSED — about 10 minutes not recorded\]\n\[S1\] That all looks fine\./.test(um), um.slice(um.indexOf('<transcript>'), um.indexOf('</transcript>')));
  ok('and the preamble points to that line instead of a time the transcript never shows',
    /marked in the transcript by a line reading \[PAUSED/.test(um) && !/into the recording/.test(um), um.slice(0, 300));
  ok('the note prompt\'s PAUSED RECORDINGS section refers to the marker line',
    /PAUSED RECORDINGS[\s\S]{0,400}a line beginning \[PAUSED —[\s\S]{0,200}otherwise the gaps are listed by time/.test(sent?.system || ''));
  // Speech running on across the pause point is split at the word, too.
  bedrock(JSON.stringify(goodNote));
  res = mockRes();
  await extract(mockReq({ body: { turns: [{ speaker: 'S1', text: 'Just a look. All fine.', start: 90, end: 97,
    words: [{ at: 0, start: 90 }, { at: 5, start: 90.4 }, { at: 7, start: 90.6 }, { at: 13, start: 95.2 }, { at: 17, start: 95.6 }] }],
    consultType: 'third-molar', pauses: [{ atRecordedMs: 95000, forMs: 600000 }] } }), res);
  ok('a turn running across a pause is split at the first word after it',
    /\[S1\] Just a look\.\n\[PAUSED[^\n]*\]\n\[S1\] All fine\./.test(userMsg()), userMsg().slice(userMsg().indexOf('<transcript>')));
  for (const kind of ['summary', 'postop', 'referral', 'ask']) {
    bedrock(kind === 'ask' ? 'It was not discussed.' : '{}');
    res = mockRes();
    await extract(mockReq({ body: { kind, question: 'Was dry socket mentioned?', turns: paused, consultType: 'third-molar', note: { proposed: 'XLA LL8' },
      pauses: [{ atRecordedMs: 95000, forMs: 600000 }] } }), res);
    um = userMsg();
    ok(`${kind}: the pause rule is given in a line, not by naming a section its prompt does not have`,
      !/Apply the PAUSED RECORDINGS rules/.test(um) && /Never present things either side of a PAUSED line as said one after the other/.test(um) && /\[PAUSED —/.test(um),
      um.slice(0, 300));
  }

  // --- 4. list- or object-valued fields in the other documents are laid out, not refused ---
  ok('asText is shared from _prompt.mjs', typeof pm.asText === 'function');
  let po = null;
  try { po = pm.parsePostop('{"avoid":["Smoking for 48 hours","Hot drinks today"],"pain":"Ibuprofen 400 mg"}'); } catch (e) { po = { err: e.message }; }
  ok('post-op: a list is laid out one item per line', po?.avoid === 'Smoking for 48 hours\nHot drinks today' && po?.pain === 'Ibuprofen 400 mg', JSON.stringify(po));
  let su = null;
  try { su = pm.parseSummary('{"whatToExpect":["Some swelling","Stiffness"],"whatWeDiscussed":[]}'); } catch (e) { su = { err: e.message }; }
  ok('summary: a list is laid out, and an empty one is blank', su?.whatToExpect === 'Some swelling\nStiffness' && su?.whatWeDiscussed === null, JSON.stringify(su));
  let rf = null;
  try { rf = pm.parseReferral('{"situation":{"problem":"pain LL8"}}'); } catch (e) { rf = { err: e.message }; }
  ok('referral: an object of strings is laid out as "key: text"', rf?.situation === 'problem: pain LL8', JSON.stringify(rf));
  let deep = null;
  try { pm.parsePostop('{"avoid":[{"what":"smoking"}]}'); } catch (e) { deep = e.message; }
  ok('and anything deeper is still refused, by field', /Post-op field "avoid"/.test(deep || ''), String(deep));
  bedrock('{"avoid":["Smoking","Straws"]}');
  res = mockRes();
  await extract(mockReq({ body: { kind: 'postop', turns: paused, consultType: 'third-molar', note: { proposed: 'XLA LL8' } } }), res);
  ok('through the handler, a listed "avoid" no longer costs the whole sheet',
    res.statusCode === 200 && res.body?.postop?.avoid === 'Smoking\nStraws', `${res.statusCode} ${JSON.stringify(res.body)}`);

  // --- 5. the sign-in throttle is per address and counts only failures ---
  process.env.APP_USERS = 'AM:correct-horse-battery,MM:battery-staple-horse';
  const authMod = await import('../api/auth.mjs');
  const auth = authMod.default;
  const signIn = async (passcode, headers) => { const r = mockRes(); await auth(mockReq({ body: { passcode }, headers }), r); return r.statusCode; };
  const statuses = [];
  for (let i = 0; i < 8; i++) statuses.push(await signIn('wrong-guess-' + i, { 'x-real-ip': '203.0.113.9' }));
  ok('eight wrong guesses from one address are each refused', statuses.every((s) => s === 401), statuses.join(','));
  ok('that address is then throttled, even with a correct passcode',
    (await signIn('correct-horse-battery', { 'x-real-ip': '203.0.113.9' })) === 429);
  ok('while a clinician at another address signs in as normal',
    (await signIn('correct-horse-battery', { 'x-real-ip': '198.51.100.7' })) === 200);
  ok('and x-forwarded-for is keyed by its first entry',
    (await signIn('battery-staple-horse', { 'x-forwarded-for': '198.51.100.8, 203.0.113.9' })) === 200);
  const many = [];
  for (let i = 0; i < 10; i++) many.push(await signIn(i % 2 ? 'correct-horse-battery' : 'battery-staple-horse', { 'x-real-ip': '198.51.100.20' }));
  ok('successful sign-ins do not count towards the limit', many.every((s) => s === 200), many.join(','));
  if (authMod._throttle) {
    const { attempts, MAX_CLIENTS } = authMod._throttle;
    const now = Date.now();
    for (let i = 0; i < MAX_CLIENTS + 200; i++) attempts.set('10.0.' + i, [now]);
    for (let i = 0; i < 50; i++) attempts.set('10.9.' + i, [now - 120_000]);
    await signIn('correct-horse-battery', { 'x-real-ip': '198.51.100.30' });
    ok('the record of failed attempts stays bounded', attempts.size <= MAX_CLIENTS && !attempts.has('10.9.0'), String(attempts.size));
    attempts.clear();
  } else ok('the record of failed attempts stays bounded', false, 'no _throttle export');

  // --- 6. the dentist's private remarks stay out of the patient's documents ---
  for (const [name, sp] of [['summary', pm.buildSummarySystemPrompt('third-molar')], ['post-op', pm.buildPostopSystemPrompt('third-molar')]]) {
    // The patient's documents carry only what was said to the patient, so the
    // dictation (said after they left) is kept out entirely, facts included.
    ok(`${name} prompt: nothing from the dictated section goes into a patient's document`,
      /\[DICTATION \.\.\.\][\s\S]{0,200}None of it was said to the patient, so nothing from it goes into this document/.test(sp));
  }

  // --- 7. Ask is not told to return JSON ---
  bedrock('It was not discussed.');
  res = mockRes();
  await extract(mockReq({ body: { kind: 'ask', question: 'Was dry socket mentioned?', turns: paused, consultType: 'third-molar' } }), res);
  ok('an Ask message does not end "Return the JSON object."', res.statusCode === 200 && !/Return the JSON object/.test(userMsg()), userMsg().slice(-120));
  ok('while the note still does', /Return the JSON object\.$/.test(pm.buildUserMessage('[S1] Hello')));

  // --- 8. a recall's inapplicable fields are all named in its prompt ---
  {
    const sp = pm.buildSystemPrompt('exam-recall', 'standard');
    const at = sp.indexOf('There is usually NO consent');
    const emphasis = sp.slice(at, sp.indexOf('The other fields still apply', at));
    const missing = pm.notApplicableFields('exam-recall').filter((f) => !emphasis.includes(f));
    ok('exam/recall: every field that does not apply is named among "do NOT add gaps"', at > -1 && missing.length === 0, missing.join(', '));
  }

  // --- 9. an item that does not apply is "Not applicable: <reason>", not a gap ---
  ok('the checklist prompt gives the exact wording for an item that does not apply',
    /exactly "Not applicable: " followed by the reason/.test(pm.buildSystemPrompt('third-molar')));
  const sinusGap = (v) => checklistGaps('third-molar', { 'pain-swelling': 'expect swelling', sinus: v }).some((g) => /sinus/.test(g));
  ok('"Not applicable: lower tooth" is not a gap', !sinusGap('Not applicable: lower tooth'));
  ok('a bare "Not applicable" gives no reason and is still a gap', sinusGap('Not applicable') && sinusGap('Not applicable:') && sinusGap('N/A'));
  bedrock(JSON.stringify({ ...goodNote, checklist: { 'pain-swelling': 'expect swelling', sinus: 'Not applicable: lower tooth' } }));
  res = mockRes();
  await extract(mockReq({ body: { turns: paused, consultType: 'third-molar' } }), res);
  ok('through the handler, the lower tooth gets no sinus line in "not said"',
    res.statusCode === 200 && !res.body?.note?.notSaid?.some((g) => /sinus/.test(g)) && res.body.note.notSaid.some((g) => /bleeding/.test(g)),
    JSON.stringify(res.body?.note?.notSaid));

  // --- 10. Bedrock's error body never reaches the browser, and its secrets never reach the log ---
  {
    const token = 'FwoGZXIvYXdzEXAMPLESESSIONTOKEN0123456789';
    const bodyText = `{"message":"The request signature we calculated does not match. The Canonical String for this request should have been 'POST\\n/model/x/invoke\\n\\nx-amz-security-token:${token}\\n' Authorization: AWS4-HMAC-SHA256 Credential=ASIAEXAMPLEKEY12345/20260925/eu-west-2/bedrock/aws4_request, SignedHeaders=host, Signature=abcdef0123456789"}`;
    stubFetch(async () => ({ status: 403, body: bodyText }));
    const logged = []; const quiet = console.error; console.error = (...a) => logged.push(a.join(' '));
    res = mockRes();
    await extract(mockReq({ body: { turns: paused, consultType: 'third-molar' } }), res);
    console.error = quiet;
    const detail = JSON.stringify(res.body);
    ok('a Bedrock refusal tells the page the status and nothing more',
      res.statusCode === 502 && /bedrock 403/.test(detail) && !/Canonical|signature we calculated|x-amz-security-token|ASIA/.test(detail), detail);
    const log = logged.join('\n');
    ok('the body is still logged, for diagnosis', /Canonical String/.test(log), log.slice(0, 200));
    ok('with the session token, credential and signature redacted',
      !log.includes(token) && !log.includes('ASIAEXAMPLEKEY12345') && !log.includes('abcdef0123456789') && /\[redacted\]/.test(log), log.slice(0, 400));
  }

  // --- 11. UK spelling from Speechmatics ---
  {
    let cfg = null;
    stubFetch(async (c, opts) => {
      if (c.method === 'POST' && c.url.endsWith('/jobs')) { cfg = JSON.parse(opts.body.get('config')); return { status: 201, body: { id: 'jobGB' } }; }
      if (c.method === 'GET' && c.url.endsWith('/jobs/jobGB')) return { status: 200, body: { job: { status: 'done' } } };
      if (c.method === 'GET' && c.url.includes('/transcript')) return { status: 200, body: TURNS_PAYLOAD };
      return { status: 200, body: {} };
    });
    res = mockRes();
    await transcribe(mockReq({ headers: { 'content-type': 'audio/ogg' }, body: OGG(5000) }), res);
    ok('the transcription asks for en-GB output', cfg?.transcription_config?.output_locale === 'en-GB' && cfg?.transcription_config?.language === 'en',
      JSON.stringify(cfg?.transcription_config?.output_locale));
  }

  // --- 12. a corrected speaker mapping reaches every product, whitelisted ---
  for (const kind of ['summary', 'postop', 'referral', 'ask']) {
    bedrock(kind === 'ask' ? 'It was not discussed.' : '{}');
    res = mockRes();
    await extract(mockReq({ body: { kind, question: 'Who spoke first?', turns: paused, consultType: 'third-molar', note: { proposed: 'XLA LL8' },
      speakerRoles: { S1: 'patient', S2: 'clinician', S3: 'boss', x: 'patient', S999: 'other' } } }), res);
    um = userMsg();
    ok(`${kind}: the corrected speaker mapping is passed on, whitelisted`,
      /CONFIRMED MAPPING[^\n]*S1 is the patient; S2 is the clinician\./.test(um) && !/boss|x is the|S999/.test(um) && !/speakerConfidence/.test(um),
      um.slice(0, 200));
  }
}

/* ================================================================
   Staff accounts (25 September 2026): email + password (no second factor,
   by the owner's decision, 26 September), stored in a Vercel Global Config
   store, managed from /ai-notes/admin/. The store is faked in memory below
   and enforces the two rules of the real one that matter here: the key
   pattern, and that a PATCH applies all of its operations or none. It counts
   reads and writes, because the Hobby plan includes 100 writes and 100,000
   reads a month and going over blocks the store for 30 days.
   ================================================================ */
const STORE_ID = 'ecfg_testaccounts';
const READ_TOKEN = 'read-token-xyz';
const API_TOKEN = 'vercel-api-token-abc';

function fakeStore() {
  const S = { items: {}, reads: 0, writes: 0, rejected: 0, lastWritePath: null, failWrites: false, failReads: false };
  S.handle = async (entry, opts = {}) => {
    const u = new URL(entry.url);
    const auth = (opts.headers && (opts.headers.Authorization || opts.headers.authorization)) || '';
    if (u.hostname === 'global-config.vercel.com' || u.hostname === 'edge-config.vercel.com') {
      if (auth !== `Bearer ${READ_TOKEN}`) return { status: 401, body: { error: { message: 'unauthorized' } } };
      if (S.failReads) return { status: 503, body: { error: { message: 'unavailable' } } };
      if (entry.method === 'GET' && u.pathname === `/${STORE_ID}/items`) { S.reads++; return { status: 200, body: JSON.parse(JSON.stringify(S.items)) }; }
      return { status: 404, body: {} };
    }
    if (u.hostname === 'api.vercel.com') {
      const m = u.pathname.match(/^\/v1\/(global-config|edge-config)\/([^/]+)\/items$/);
      if (!m || m[2] !== STORE_ID || entry.method !== 'PATCH') return { status: 404, body: { error: { message: 'not found' } } };
      if (auth !== `Bearer ${API_TOKEN}`) return { status: 403, body: { error: { message: 'forbidden' } } };
      S.lastWritePath = u.pathname + u.search;
      if (S.failWrites) { S.rejected++; return { status: 500, body: { error: { message: 'boom' } } }; }
      let body;
      try { body = JSON.parse(opts.body); } catch { S.rejected++; return { status: 400, body: { error: { message: 'bad json' } } }; }
      const next = JSON.parse(JSON.stringify(S.items));
      for (const it of body.items || []) {
        const bad = (msg) => ({ status: 400, body: { error: { message: msg } } });
        if (typeof it.key !== 'string' || !/^[A-Za-z0-9_-]+$/.test(it.key) || it.key.length > 256) { S.rejected++; return bad('invalid key'); }
        if (it.operation === 'create') { if (it.key in next) { S.rejected++; return bad('exists'); } next[it.key] = it.value; }
        else if (it.operation === 'update') { if (!(it.key in next)) { S.rejected++; return bad('missing'); } next[it.key] = it.value; }
        else if (it.operation === 'upsert') next[it.key] = it.value;
        else if (it.operation === 'delete') { if (!(it.key in next)) { S.rejected++; return bad('missing'); } delete next[it.key]; }
        else { S.rejected++; return bad('bad operation'); }
      }
      if (JSON.stringify(next).length > 1024 * 1024) { S.rejected++; return { status: 400, body: { error: { message: 'too large' } } }; }
      S.items = next;
      S.writes++;
      // Lets a test land "another instance's" change right after this one.
      if (S.afterWrite) { const f = S.afterWrite; S.afterWrite = null; f(S); }
      return { status: 200, body: { status: 'ok' } };
    }
    return null;
  };
  return S;
}

// Everything that is not the store goes to `other`, e.g. a stubbed Speechmatics.
function stubWithStore(store, other = async () => ({ status: 404, body: {} })) {
  return stubFetch(async (c, opts) => (await store.handle(c, opts)) || other(c, opts));
}

async function testAccounts() {
  section('Staff accounts — passwords, tokens and the connection string');
  process.env.SESSION_SECRET = 'secret-for-tests';
  const A = await import('../api/_accounts.mjs');
  const St = await import('../api/_store.mjs');
  const Se = await import('../api/_session.mjs');

  // --- scrypt ---
  const h = await A.hashPassword('correct horse battery staple');
  const hp = h.split('$');
  ok('passwords are hashed with scrypt N=16384 r=8 p=1, 32-byte key, random salt, stored compactly',
    hp[0] === 'scrypt' && hp[1] === '16384' && hp[2] === '8' && hp[3] === '1' && Buffer.from(hp[5], 'base64url').length === 32 &&
    Buffer.from(hp[4], 'base64url').length === 16 && h.length < 100, h);
  ok('and the hash is not the password', !JSON.stringify(h).includes('horse'));
  ok('the right password verifies', await A.verifyPassword('correct horse battery staple', h));
  ok('a wrong one does not', !(await A.verifyPassword('correct horse battery stapler', h)));
  ok('two hashes of one password differ (salted)', (await A.hashPassword('correct horse battery staple')) !== h);
  ok('a record asking for absurd scrypt cost is refused without running it',
    !(await A.verifyPassword('x', h.replace('$16384$', '$16777216$'))) && !(await A.verifyPassword('x', h.replace('$16384$', '$1000$'))));
  ok('the unknown-email path still runs scrypt and says no', (await A.dummyVerify('anything')) === false);

  // --- password rules ---
  ok('password: under 12 characters is refused', A.passwordProblem('short-pass1', 'am@example.com') === 'password_too_short');
  ok('password: 12 characters of anything is fine', A.passwordProblem('aaaaaaaaaaaa', 'am@example.com') === null);
  ok('password: containing the email\'s first part is refused, any case',
    A.passwordProblem('my-Aiden.McCann-rules', 'aiden.mccann@example.com') === 'password_contains_email');
  ok('password: a two-letter first part does not forbid those letters', A.passwordProblem('I am a long password', 'am@example.com') === null);

  // --- the per-account lock: a lock, not a sliding window ---
  {
    const t = A.makeThrottle({ windowMs: 15 * 60_000, max: 5, lockMs: 15 * 60_000 });
    const t0 = 1_900_000_000_000, min = 60_000;
    t.count('k', t0);
    for (let i = 0; i < 4; i++) t.count('k', t0 + 10 * min);
    ok('five failures lock the key', t.blocked('k', t0 + 10 * min + 1));
    ok('and it stays locked for 15 minutes from the fifth, after the first has aged out of the window', t.blocked('k', t0 + 16 * min));
    ok('then it opens', !t.blocked('k', t0 + 25 * min + 1));
    const w = A.makeThrottle({ windowMs: 15 * 60_000, max: 5 });
    w.count('k', t0); for (let i = 0; i < 4; i++) w.count('k', t0 + 10 * min);
    ok('(a plain window would already have let a guesser back in by then)', !w.blocked('k', t0 + 16 * min));
  }

  // --- the v3 session token ---
  const t3 = await Se.mintToken('secret-for-tests', 3600, 'AM', 4);
  const c3 = await Se.readToken('secret-for-tests', t3);
  ok('a v3 token carries initials and epoch, signed', t3.startsWith('v3.') && c3?.who === 'AM' && c3?.epoch === 4 && c3?.v === 3);
  ok('its epoch cannot be edited', (await Se.readToken('secret-for-tests', t3.replace('.AM.4.', '.AM.5.'))) === null);
  ok('secondsRemaining understands it', Se.secondsRemaining(t3) > 3500);

  // --- the connection string ---
  ok('GLOBAL_CONFIG is read', St.storeConfig({ GLOBAL_CONFIG: `https://global-config.vercel.com/${STORE_ID}?token=${READ_TOKEN}` }).state === 'ok');
  ok('the legacy EDGE_CONFIG is accepted too, and writes go to the edge-config API',
    St.storeConfig({ EDGE_CONFIG: `https://edge-config.vercel.com/${STORE_ID}?token=${READ_TOKEN}` }).api === 'edge-config');
  ok('GLOBAL_CONFIG wins when both are set',
    St.storeConfig({ GLOBAL_CONFIG: `https://global-config.vercel.com/a1?token=t`, EDGE_CONFIG: `https://edge-config.vercel.com/b2?token=t` }).storeId === 'a1');
  ok('a connection string pointing anywhere but Vercel is "broken", never used',
    St.storeConfig({ GLOBAL_CONFIG: `https://evil.example/${STORE_ID}?token=${READ_TOKEN}` }).state === 'broken' &&
    St.storeConfig({ GLOBAL_CONFIG: `http://global-config.vercel.com/${STORE_ID}?token=x` }).state === 'broken' &&
    St.storeConfig({ GLOBAL_CONFIG: `https://global-config.vercel.com/${STORE_ID}` }).state === 'broken');
  ok('unset is "off"', St.storeConfig({}).state === 'off');
}

async function testAccountFlows() {
  section('Staff accounts — sign-in, sessions, the gate, admin and setup');
  const S = 'secret-for-tests';
  process.env.SESSION_SECRET = S;
  const saved = { APP_USERS: process.env.APP_USERS, ADMIN_USERS: process.env.ADMIN_USERS, IMPLANT_USERS: process.env.IMPLANT_USERS };
  const A = await import('../api/_accounts.mjs');
  const St = await import('../api/_store.mjs');
  const Se = await import('../api/_session.mjs');
  const authMod = await import('../api/auth.mjs');
  const auth = authMod.default;
  const { default: users, _writeLimit, _timing } = await import('../api/users.mjs');
  _timing.settleMs = 0;
  const accountMod = await import('../api/account.mjs');
  const account = accountMod.default;
  const { default: middleware } = await import('../middleware.js');
  process.env.SPEECHMATICS_API_KEY = 'k';
  process.env.AWS_ACCESS_KEY_ID = 'AKIAtest';
  process.env.AWS_SECRET_ACCESS_KEY = 'secrettest';
  const { default: transcribe } = await import('../api/transcribe.mjs');
  const { default: extract } = await import('../api/extract.mjs');
  const quietWarn = console.warn, quietErr = console.error, quietLog = console.log;
  // The handlers log what they do (who changed what, a failed read); keep that
  // out of the report, but not the PASS/FAIL lines themselves.
  console.warn = () => {}; console.error = () => {};
  console.log = (...a) => { if (typeof a[0] === 'string' && /^ {2}(PASS|FAIL) /.test(a[0])) quietLog(...a); };
  const restoreConsole = () => { console.warn = quietWarn; console.error = quietErr; console.log = quietLog; };

  const resetAll = () => {
    St._resetStore();
    authMod._throttle.attempts.clear();
    authMod._accountThrottle.clear();
    accountMod._throttles.perIp.clear();
    accountMod._throttles.finished.clear();
    _writeLimit.clear();
  };
  const configure = () => {
    process.env.GLOBAL_CONFIG = `https://global-config.vercel.com/${STORE_ID}?token=${READ_TOKEN}`;
    process.env.VERCEL_API_TOKEN = API_TOKEN;
    delete process.env.EDGE_CONFIG;
    delete process.env.VERCEL_TEAM_ID;
  };
  const unconfigure = () => { delete process.env.GLOBAL_CONFIG; delete process.env.EDGE_CONFIG; delete process.env.VERCEL_API_TOKEN; };

  const passwords = {};
  async function seed(store, initials, { email, role = 'clinician', status = 'active', epoch = 1, setUp = true } = {}) {
    passwords[initials] = `a long password for ${initials}`;
    store.items[`user_${initials}`] = {
      email: email || `${initials.toLowerCase()}@practice.example`, initials, role, status,
      pw: setUp ? await A.hashPassword(passwords[initials]) : null,
      invite: null, epoch, createdAt: '2026-09-25T09:00:00.000Z'
    };
  }
  const cookieFor = async (who, epoch) => `${Se.COOKIE_NAME}=${await Se.mintToken(S, 3600, who, epoch)}`;
  const legacyCookie = async (who) => `${Se.COOKIE_NAME}=${await Se.mintToken(S, 3600, who)}`;
  const signIn = async (body, ip = '192.0.2.1') => { const r = mockRes(); await auth(mockReq({ body, headers: { 'x-real-ip': ip } }), r); return r; };
  const gate = (path, { cookie, accept = 'text/html' } = {}) => middleware(new Request('https://oralsurgeryassess.com' + path, { headers: { accept, ...(cookie ? { cookie } : {}) } }));
  const status = async (cookie) => { const r = mockRes(); await auth(mockReq({ method: 'GET', headers: { cookie } }), r); return r.body; };
  const SITE = { host: 'oralsurgeryassess.com', origin: 'https://oralsurgeryassess.com', 'content-type': 'application/json' };
  const admin = async (cookie, body, headers = SITE) => {
    const r = mockRes();
    await users(mockReq({ method: body ? 'POST' : 'GET', url: '/api/users', body, headers: { ...headers, cookie } }), r);
    return r;
  };
  const setup = async (body, ip = '198.51.100.50') => { const r = mockRes(); await account(mockReq({ body, headers: { 'x-real-ip': ip } }), r); return r; };
  // Transcribe and extract, stubbed behind the store: enough to see whether
  // the handler got past its session check.
  const speechmatics = async (c) => {
    if (c.method === 'POST' && c.url.endsWith('/jobs')) return { status: 201, body: { id: 'jobACC' } };
    if (c.method === 'GET' && c.url.endsWith('/jobs/jobACC')) return { status: 200, body: { job: { status: 'done' } } };
    if (c.method === 'GET' && c.url.includes('/transcript')) return { status: 200, body: TURNS_PAYLOAD };
    return { status: 200, body: {} };
  };
  const transcribeAs = async (cookie) => { const r = mockRes(); await transcribe(mockReq({ headers: { 'content-type': 'audio/ogg', cookie }, body: OGG(5000) }), r); return r.statusCode; };
  const extractAs = async (cookie) => { const r = mockRes(); await extract(mockReq({ headers: { cookie }, body: { turns: [] } }), r); return r.statusCode; };

  try {
    /* ---------- sign-in ---------- */
    let store = fakeStore();
    stubWithStore(store, speechmatics);
    configure();
    delete process.env.APP_USERS; delete process.env.ADMIN_USERS;
    resetAll();
    await seed(store, 'AM', { role: 'admin', email: 'am@practice.example' });
    await seed(store, 'MM');
    await seed(store, 'DD', { status: 'disabled' });
    await seed(store, 'II', { status: 'invited', setUp: false });
    store.items.user_II.invite = { hash: 'f'.repeat(64), expires: new Date(Date.now() + 3600e3).toISOString() };

    let r = await signIn({ email: 'am@practice.example', password: passwords.AM });
    const setCookie = r.headers['set-cookie'] || '';
    const tokenAM = setCookie.split(';')[0].split('=')[1] || '';
    ok('sign-in with email, password and code succeeds', r.statusCode === 200, `${r.statusCode} ${JSON.stringify(r.body)}`);
    ok('and issues a v3 session for those initials at the account\'s epoch',
      (await Se.readToken(S, tokenAM))?.v === 3 && (await Se.readToken(S, tokenAM))?.who === 'AM' && (await Se.readToken(S, tokenAM))?.epoch === 1, tokenAM.slice(0, 20));
    ok('with the same cookie flags as before', /HttpOnly/.test(setCookie) && /Secure/.test(setCookie) && /SameSite=Strict/.test(setCookie) && /Max-Age=43200/.test(setCookie));
    ok('the email is matched whatever its case and spacing',
      (await signIn({ email: '  MM@Practice.EXAMPLE ', password: passwords.MM })).statusCode === 200);

    const failures = {};
    resetAll();
    failures.password = await signIn({ email: 'am@practice.example', password: 'not the password at all' }, '192.0.2.10');
    failures.unknown = await signIn({ email: 'nobody@practice.example', password: passwords.AM }, '192.0.2.12');
    failures.disabled = await signIn({ email: 'dd@practice.example', password: passwords.DD }, '192.0.2.13');
    failures.invited = await signIn({ email: 'ii@practice.example', password: 'whatever it is' }, '192.0.2.14');
    failures.nothing = await signIn({ email: '', password: '' }, '192.0.2.15');
    const good = await signIn({ email: 'mm@practice.example', password: passwords.MM }, '192.0.2.16');
    ok('the right email and password work', good.statusCode === 200);
    for (const [why, res] of Object.entries(failures)) {
      ok(`sign-in refused (${why}) with the generic 401 and no cookie`,
        res.statusCode === 401 && JSON.stringify(res.body) === '{"error":"invalid_credentials"}' && !res.headers['set-cookie'], `${res.statusCode} ${JSON.stringify(res.body)}`);
    }
    ok('no sign-in, good or bad, wrote to the store', store.writes === 0, String(store.writes));

    // Timing: "no such email" must cost the same scrypt work as "wrong
    // password", or the time taken is a list of who works here. The delay
    // after a failure is a timer, not CPU, so CPU time isolates the hashing.
    {
      resetAll();
      const cpu = async (body, ip) => { const t = process.cpuUsage(); await signIn(body, ip); const d = process.cpuUsage(t); return d.user + d.system; };
      let known = 0, unknown = 0;
      for (let i = 0; i < 3; i++) {
        known += await cpu({ email: 'am@practice.example', password: 'wrong password ' + i }, '192.0.2.40');
        unknown += await cpu({ email: `ghost${i}@practice.example`, password: 'wrong password ' + i }, '192.0.2.41');
      }
      ok('an unknown email costs the same password-hashing work as a known one', unknown > known * 0.5, `known ${known}us, unknown ${unknown}us`);
    }

    // Per-address throttle, now across accounts too.
    resetAll();
    for (let i = 0; i < 8; i++) await signIn({ email: `guess${i}@practice.example`, password: 'x'.repeat(12) }, '203.0.113.77');
    r = await signIn({ email: 'am@practice.example', password: passwords.AM }, '203.0.113.77');
    ok('eight failures from one address throttle it, even with correct details', r.statusCode === 429 && !r.headers['set-cookie'], String(r.statusCode));

    // Per-account throttle: one account, many addresses.
    resetAll();
    for (let i = 0; i < 5; i++) await signIn({ email: 'am@practice.example', password: 'wrong wrong wrong ' + i }, '203.0.113.' + (100 + i));
    r = await signIn({ email: 'am@practice.example', password: passwords.AM }, '203.0.113.200');
    ok('five failures against one account lock that account from anywhere, even with the right password', r.statusCode === 429, String(r.statusCode));
    {
      const realNow = Date.now;
      try {
        Date.now = () => realNow() + 14 * 60_000;
        ok('still locked 14 minutes later', (await signIn({ email: 'am@practice.example', password: passwords.AM }, '203.0.113.210')).statusCode === 429);
        Date.now = () => realNow() + 16 * 60_000;
        ok('open again after 15 minutes', (await signIn({ email: 'am@practice.example', password: passwords.AM }, '203.0.113.211')).statusCode === 200);
      } finally { Date.now = realNow; }
    }
    // A lock, not a sliding window: one failure, then four more ten minutes
    // later. Six minutes after that the first has left the 15-minute window
    // (four remain), but the account stays locked until 15 minutes after the
    // fifth. A sliding window would let the guesser straight back in.
    {
      resetAll();
      const realNow = Date.now;
      let shift = 0;
      Date.now = () => realNow() + shift;
      try {
        await signIn({ email: 'mm@practice.example', password: 'wrong wrong wrong 0' }, '203.0.113.220');
        shift = 10 * 60_000;
        for (let i = 1; i < 5; i++) await signIn({ email: 'mm@practice.example', password: 'wrong wrong wrong ' + i }, '203.0.113.' + (220 + i));
        shift = 16 * 60_000;
        ok('the lock outlasts the window: still locked 16 minutes after the first failure',
          (await signIn({ email: 'mm@practice.example', password: passwords.MM }, '203.0.113.230')).statusCode === 429);
        shift = 25 * 60_000 + 1000;
        ok('and opens 15 minutes after the fifth', (await signIn({ email: 'mm@practice.example', password: passwords.MM }, '203.0.113.231')).statusCode === 200);
      } finally { Date.now = realNow; }
    }
    r = await signIn({ email: 'mm@practice.example', password: passwords.MM }, '203.0.113.200');
    ok('while a colleague at that address signs in as normal', r.statusCode === 200, String(r.statusCode));
    for (let i = 0; i < 5; i++) await signIn({ email: 'ghost@practice.example', password: 'wrong wrong wrong ' + i }, '203.0.113.' + (150 + i));
    r = await signIn({ email: 'ghost@practice.example', password: 'wrong wrong wrong' }, '203.0.113.201');
    ok('and an email nobody has throttles the same way, so the limit reveals nothing', r.statusCode === 429, String(r.statusCode));

    // The store unreadable: a server problem, not a failed guess.
    resetAll();
    store.failReads = true;
    r = await signIn({ email: 'am@practice.example', password: passwords.AM }, '192.0.2.60');
    ok('with the store unreadable, sign-in says so (503) rather than "wrong password"', r.statusCode === 503, String(r.statusCode));
    ok('and it is not counted against the address', !authMod._throttle.attempts.has('192.0.2.60'));
    store.failReads = false;

    /* ---------- sessions everywhere ---------- */
    resetAll();
    let amCookie = await cookieFor('AM', 1);
    const mmCookie = await cookieFor('MM', 1);
    ok('a v3 session opens AI Notes', (await gate('/ai-notes/', { cookie: amCookie })) === undefined);
    ok('and the API', (await gate('/api/transcribe', { cookie: amCookie, accept: 'application/json' })) === undefined);
    ok('the session check reports who, and that AM is an admin',
      JSON.stringify(await status(amCookie)).includes('"authenticated":true,"who":"AM","admin":true'), JSON.stringify(await status(amCookie)));
    ok('transcribe and extract accept it', (await transcribeAs(amCookie)) === 200 && (await extractAs(amCookie)) === 400);
    ok('a session from an older epoch is refused', (await gate('/ai-notes/', { cookie: await cookieFor('AM', 0) }))?.status === 401);
    ok('and one from an epoch the account has not reached', (await gate('/ai-notes/', { cookie: await cookieFor('AM', 7) }))?.status === 401);
    ok('a v3 session for initials with no account is refused', (await gate('/ai-notes/', { cookie: await cookieFor('ZZ', 1) }))?.status === 401);
    ok('a v3 session for a disabled account is refused', (await gate('/ai-notes/', { cookie: await cookieFor('DD', 1) }))?.status === 401);
    ok('and for an invited one', (await gate('/ai-notes/', { cookie: await cookieFor('II', 1) }))?.status === 401);

    // The list is cached for 30 s. A burst of requests is one read.
    resetAll();
    const before = store.reads;
    for (let i = 0; i < 10; i++) await gate('/ai-notes/', { cookie: amCookie });
    ok('ten requests inside the cache window make one store read', store.reads - before === 1, String(store.reads - before));

    // Disabled while signed in: every door refuses the live session once the
    // cache has turned over (the documented staleness: 30 s plus propagation).
    {
      const realNow = Date.now;
      let shift = 0;
      Date.now = () => realNow() + shift;
      try {
        ok('MM is in, before', (await gate('/ai-notes/', { cookie: mmCookie })) === undefined);
        store.items.user_MM = { ...store.items.user_MM, status: 'disabled', epoch: 2 };
        ok('within the cache window a just-disabled session may still pass (documented staleness)',
          (await gate('/ai-notes/', { cookie: mmCookie })) === undefined);
        shift = St.CACHE_MS + 1000;
        ok('after it, the gate refuses the disabled colleague\'s live session', (await gate('/ai-notes/', { cookie: mmCookie }))?.status === 401);
        ok('transcribe refuses it', (await transcribeAs(mmCookie)) === 401);
        ok('extract refuses it', (await extractAs(mmCookie)) === 401);
        ok('the session check reports it signed out', (await status(mmCookie))?.authenticated === false);
        ok('while the admin\'s session is untouched', (await gate('/ai-notes/', { cookie: amCookie })) === undefined && (await transcribeAs(amCookie)) === 200);
      } finally { Date.now = realNow; }
    }
    // Set up a moment ago: the session is newer than the cached list, so the
    // gate re-reads once rather than refusing for thirty seconds.
    resetAll();
    store.items.user_MM = { ...store.items.user_MM, status: 'invited', epoch: 2 };
    ok('(MM shown as invited in the cached list)', (await gate('/ai-notes/', { cookie: await cookieFor('MM', 3) }))?.status === 401);
    store.items.user_MM = { ...store.items.user_MM, status: 'active', epoch: 3 };
    {
      const realNow = Date.now;
      Date.now = () => realNow() + 6000;
      try {
        ok('a session newer than the cached list triggers one re-read and gets in',
          (await gate('/ai-notes/', { cookie: await cookieFor('MM', 3) })) === undefined);
      } finally { Date.now = realNow; }
    }

    /* ---------- the passcode route, only while APP_USERS is set ---------- */
    resetAll();
    process.env.APP_USERS = 'AM:owner-passcode-1,MM:colleague-code-2';
    process.env.ADMIN_USERS = 'AM';
    r = await signIn({ passcode: 'owner-passcode-1' }, '192.0.2.70');
    ok('while APP_USERS is set, the passcode still signs the owner in', r.statusCode === 200);
    const v2am = r.headers['set-cookie'].split(';')[0];
    ok('and that v2 session opens AI Notes', (await gate('/ai-notes/', { cookie: v2am })) === undefined);
    ok('and, via ADMIN_USERS, the admin page', (await gate('/ai-notes/admin/', { cookie: v2am })) === undefined);
    ok('a v2 session for initials no longer in APP_USERS is refused', (await gate('/ai-notes/', { cookie: await legacyCookie('XY') }))?.status === 401);
    ok('a v1 session (nobody) is refused once there is an account store', (await gate('/ai-notes/', { cookie: `${Se.COOKIE_NAME}=${await Se.mintToken(S, 3600)}` }))?.status === 401);
    process.env.APP_USERS = 'AM:owner-passcode-1,MM:colleague-code-2,DD:disabled-code-9';
    ok('a v2 session for someone disabled in the store is refused, though APP_USERS lists them',
      (await gate('/ai-notes/', { cookie: await legacyCookie('DD') }))?.status === 401);
    r = await signIn({ passcode: 'disabled-code-9' }, '192.0.2.71');
    ok('and a disabled colleague\'s passcode no longer signs them in', r.statusCode === 401, String(r.statusCode));
    let page = await (await gate('/ai-notes/')).text();
    ok('the sign-in page offers email and password, with the right autocomplete hints, and nothing else',
      /type="email" autocomplete="username"/.test(page) && /id="pw"[^>]*autocomplete="current-password"/.test(page) &&
      !/one-time-code|name="code"|authenticator/i.test(page));
    ok('and, while APP_USERS is set, a way to use a passcode instead', /Sign in with a passcode instead/.test(page) && /id="p" name="passcode"/.test(page));

    delete process.env.APP_USERS;
    resetAll();
    r = await signIn({ passcode: 'owner-passcode-1' }, '192.0.2.72');
    ok('once APP_USERS is removed, the passcode no longer works', r.statusCode === 401 && !r.headers['set-cookie'], String(r.statusCode));
    ok('and the v2 session it issued is refused by the gate', (await gate('/ai-notes/', { cookie: v2am }))?.status === 401);
    ok('by the admin page too, although ADMIN_USERS is still set', (await gate('/ai-notes/admin/', { cookie: v2am }))?.status === 401);
    ok('by transcribe', (await transcribeAs(v2am)) === 401);
    ok('and by the session check', (await status(v2am))?.authenticated === false);
    page = await (await gate('/ai-notes/')).text();
    ok('the sign-in page no longer offers a passcode', !/name="passcode"/.test(page) && !/Sign in with a passcode/.test(page) && /type="email"/.test(page));

    /* ---------- the admin gate ---------- */
    resetAll();
    r = await gate('/ai-notes/admin/');
    ok('admin page, signed out: 401 and the sign-in form', r?.status === 401 && (await r.text()).includes('Staff accounts'));
    r = await gate('/ai-notes/admin/', { cookie: await cookieFor('MM', 3) });
    ok('admin page, as a clinician: 403', r?.status === 403 && (await r.text()).includes('account administrator'), String(r?.status));
    r = await gate('/ai-notes/admin', { cookie: await cookieFor('MM', 3) });
    ok('and without the trailing slash', r?.status === 403, String(r?.status));
    ok('admin page, as an admin: allowed', (await gate('/ai-notes/admin/', { cookie: amCookie })) === undefined);
    for (const p of ['/ai-notes/setup/', '/ai-notes/setup', '/ai-notes/setup/index.html', '/api/account']) {
      ok(`${p} is reachable without a session`, (await gate(p, { accept: '*/*' })) === undefined);
    }
    ok('but not what is next to it (the QR library that was once there, say)', (await gate('/ai-notes/setup/qr.js', { accept: '*/*' }))?.status === 401 &&
      (await gate('/ai-notes/setup/other.js', { accept: '*/*' }))?.status === 401);

    /* ---------- the admin API ---------- */
    ok('users API: signed out is 401', (await admin('', null)).statusCode === 401);
    ok('users API: a clinician is 403', (await admin(await cookieFor('MM', 3), null)).statusCode === 403);
    r = await admin(amCookie, null);
    ok('users API: the admin gets the list', r.statusCode === 200 && r.body.configured === true && r.body.users.length === 4 && r.body.me === 'AM', JSON.stringify(r.body).slice(0, 200));
    ok('and the list carries no password hash or invite', !/"(pw|invite|hash)"|scrypt/.test(JSON.stringify(r.body)));

    const writes0 = store.writes;
    r = await admin(amCookie, { action: 'add', email: 'sm@practice.example', initials: 'sm', role: 'clinician' }, { host: SITE.host, origin: undefined, 'content-type': 'application/json' });
    ok('a POST with no Origin is refused', r.statusCode === 403 && r.body.error === 'cross_origin');
    r = await admin(amCookie, { action: 'add', email: 'sm@practice.example', initials: 'sm', role: 'clinician' }, { ...SITE, origin: 'https://evil.example' });
    ok('a POST from another origin is refused', r.statusCode === 403 && r.body.error === 'cross_origin');
    r = await admin(amCookie, { action: 'add', email: 'sm@practice.example', initials: 'sm', role: 'clinician' }, { ...SITE, 'content-type': 'text/plain' });
    ok('a POST that is not JSON is refused', r.statusCode === 415);
    ok('and none of those wrote anything', store.writes === writes0);

    r = await admin(amCookie, { action: 'add', email: ' SM@Practice.example ', initials: 'sm', role: 'clinician' });
    const link = r.body.setupLink || '';
    const inviteToken = link.split('#')[1] || '';
    ok('adding someone works, and returns a setup link with the token after the #',
      r.statusCode === 200 && /^https:\/\/oralsurgeryassess\.com\/ai-notes\/setup\/#[A-Za-z0-9_-]{43}$/.test(link), `${r.statusCode} ${link}`);
    const smRec = store.items.user_SM;
    ok('the new account is invited, lowercased, at a random (not 0 or 1) epoch, with no password yet',
      smRec?.status === 'invited' && smRec.email === 'sm@practice.example' && smRec.epoch > 1 && !smRec.pw, String(smRec?.epoch));
    const smEpoch0 = smRec?.epoch;
    ok('only the token\'s hash is stored, with a 72-hour expiry',
      smRec?.invite?.hash === A.sha256(inviteToken) && !JSON.stringify(store.items).includes(inviteToken) &&
      Math.abs(Date.parse(smRec.invite.expires) - Date.now() - 72 * 3600e3) < 60e3);
    ok('one add is one write', store.writes === writes0 + 1);
    ok('the list afterwards shows them, straight away', r.body.users.some((u) => u.initials === 'SM' && u.status === 'invited'));
    const w1 = store.writes;
    for (const [label, body, want] of [
      ['the same initials twice', { action: 'add', email: 'other@practice.example', initials: 'SM', role: 'clinician' }, 'initials_taken'],
      ['the same email twice', { action: 'add', email: 'sm@practice.example', initials: 'SX', role: 'clinician' }, 'email_taken'],
      ['bad initials', { action: 'add', email: 'x@practice.example', initials: 'S1', role: 'clinician' }, 'bad_initials'],
      ['a bad email', { action: 'add', email: 'not-an-email', initials: 'XY', role: 'clinician' }, 'bad_email'],
      ['a made-up role', { action: 'add', email: 'x@practice.example', initials: 'XY', role: 'owner' }, 'bad_role']
    ]) {
      r = await admin(amCookie, body);
      ok(`adding is refused for ${label}`, r.body.error === want, JSON.stringify(r.body));
    }
    ok('and refusals cost no writes', store.writes === w1);

    /* ---------- setup, from that link ---------- */
    const wBefore = store.writes;
    r = await setup({ token: inviteToken });
    ok('setup: the link alone shows whose account it is', r.statusCode === 200 && r.body.email === 'sm@practice.example' && r.body.initials === 'SM', JSON.stringify(r.body));
    ok('and hands back nothing else', JSON.stringify(Object.keys(r.body).sort()) === '["email","initials"]');
    ok('and writes nothing', store.writes === wBefore);

    const generic = [];
    // An active account still carrying an invite (it should not happen, but
    // if it did, its old link must not reopen setup).
    await seed(store, 'AC');
    const { token: activeTok, invite: activeInv } = A.newInvite();
    store.items.user_AC.invite = activeInv;
    St._resetStore();
    for (const [label, body] of [
      ['a random token', { token: A.newInvite().token }],
      ['a random token, with a password', { token: A.newInvite().token, password: 'a brand new long passphrase' }],
      ['a malformed token', { token: 'short' }],
      ['no token', { password: 'a brand new long passphrase' }],
      ['the old link of an account that is already active', { token: activeTok, password: 'a brand new long passphrase' }]
    ]) {
      const res = await setup(body, '198.51.100.' + (60 + generic.length));
      generic.push(JSON.stringify([res.statusCode, res.body]));
      ok(`setup with ${label} is refused`, res.statusCode === 400, `${res.statusCode}`);
    }
    ok('and every refusal is word for word the same, so nothing can be learnt from it', new Set(generic).size === 1, [...new Set(generic)].join(' | '));

    // An expired invite looks exactly the same.
    await seed(store, 'EX', { status: 'invited', setUp: false });
    const ex = A.newInvite(Date.now() - A.INVITE_TTL_MS - 1000);
    store.items.user_EX.invite = ex.invite;
    St._resetStore();
    r = await setup({ token: ex.token, password: 'a brand new long passphrase' }, '198.51.100.70');
    ok('an expired setup link gets the same answer', JSON.stringify([r.statusCode, r.body]) === generic[0], JSON.stringify(r.body));

    // Password rules, checked on the server too.
    r = await setup({ token: inviteToken, password: 'too short' }, '198.51.100.80');
    ok('setup refuses a password under 12 characters', r.body.error === 'password_too_short');
    r = await setup({ token: inviteToken, password: 'x'.repeat(1025) }, '198.51.100.80');
    ok('and an absurdly long one', r.body.error === 'password_too_long');
    ok('none of that wrote anything', store.writes === wBefore);

    St._resetStore();
    r = await setup({ token: inviteToken, password: 'a brand new long passphrase' }, '198.51.100.81');
    ok('setup finishes with a good password', r.statusCode === 200 && r.body.ok === true, JSON.stringify(r.body));
    const done = store.items.user_SM;
    ok('the account is now active, invite cleared, epoch moved on',
      done.status === 'active' && done.invite === null && done.epoch > smEpoch0);
    ok('with a scrypt hash of the new password, and nothing else secret',
      await A.verifyPassword('a brand new long passphrase', done.pw) && JSON.stringify(Object.keys(done).sort()) === '["createdAt","email","epoch","initials","invite","pw","role","status"]',
      JSON.stringify(Object.keys(done)));
    ok('in one write', store.writes === wBefore + 1);
    r = await setup({ token: inviteToken, password: 'another long passphrase!' }, '198.51.100.82');
    ok('the link cannot be used a second time', r.statusCode === 400 && r.body.error === 'invalid_link');
    St._resetStore();
    accountMod._throttles.finished.clear();
    r = await setup({ token: inviteToken }, '198.51.100.83');
    ok('not even to look, once the store shows it used', r.statusCode === 400 && r.body.error === 'invalid_link');
    ok('and the new colleague can sign in', (await signIn({ email: 'sm@practice.example', password: 'a brand new long passphrase' }, '192.0.2.90')).statusCode === 200);

    // A password containing the first part of the email (3+ letters).
    await seed(store, 'LP', { status: 'invited', setUp: false, email: 'lorna.p@practice.example' });
    const lp = A.newInvite();
    store.items.user_LP.invite = lp.invite;
    St._resetStore();
    r = await setup({ token: lp.token, password: 'my name is Lorna.P honestly' }, '198.51.100.84');
    ok('setup refuses a password containing the email\'s first part', r.body.error === 'password_contains_email', JSON.stringify(r.body));

    // Per-address throttle on setup.
    resetAll();
    const codes = [];
    for (let i = 0; i < 11; i++) codes.push((await setup({ token: A.newInvite().token }, '198.51.100.99')).statusCode);
    ok('setup: ten bad links from one address, then 429', codes.slice(0, 10).every((c) => c === 400) && codes[10] === 429, codes.join(','));

    /* ---------- admin actions ---------- */
    resetAll();
    const smEpoch1 = store.items.user_SM.epoch;
    const smCookie = await cookieFor('SM', smEpoch1);
    ok('(SM\'s session works)', (await gate('/ai-notes/', { cookie: smCookie })) === undefined);
    r = await admin(amCookie, { action: 'reset', initials: 'SM' });
    ok('a new setup link resets the account: invited, password cleared, epoch up',
      r.statusCode === 200 && /#[A-Za-z0-9_-]{43}$/.test(r.body.setupLink || '') && store.items.user_SM.status === 'invited' &&
      !store.items.user_SM.pw && store.items.user_SM.epoch > smEpoch1);
    ok('and SM\'s live session ends at once on this instance', (await gate('/ai-notes/', { cookie: smCookie }))?.status === 401);
    ok('the old link no longer works after a reset',
      (await setup({ token: inviteToken, password: 'a brand new long passphrase' }, '198.51.100.85')).body.error === 'invalid_link');
    ok('the old password no longer works either',
      (await signIn({ email: 'sm@practice.example', password: 'a brand new long passphrase' }, '192.0.2.95')).statusCode === 401);

    resetAll();
    await seed(store, 'MM', { epoch: 3 });
    const mm3 = await cookieFor('MM', 3);
    r = await admin(amCookie, { action: 'disable', initials: 'MM' });
    const mmDisabledEpoch = store.items.user_MM.epoch;
    ok('disable: status disabled, epoch up', r.statusCode === 200 && store.items.user_MM.status === 'disabled' && mmDisabledEpoch > 3);
    ok('and their session is refused', (await gate('/ai-notes/', { cookie: mm3 }))?.status === 401);
    r = await admin(amCookie, { action: 'enable', initials: 'MM' });
    ok('enable: back to active, epoch unchanged', r.statusCode === 200 && store.items.user_MM.status === 'active' && store.items.user_MM.epoch === mmDisabledEpoch);
    ok('the session from before the disable stays dead', (await gate('/ai-notes/', { cookie: mm3 }))?.status === 401);
    ok('but a new sign-in works', (await signIn({ email: 'mm@practice.example', password: passwords.MM }, '192.0.2.91')).statusCode === 200);
    r = await admin(amCookie, { action: 'role', initials: 'MM', role: 'admin' });
    ok('role: a clinician can be made an admin', r.statusCode === 200 && store.items.user_MM.role === 'admin');
    r = await admin(amCookie, { action: 'role', initials: 'MM', role: 'clinician' });
    ok('and back again', r.statusCode === 200 && store.items.user_MM.role === 'clinician');

    r = await admin(amCookie, { action: 'disable', initials: 'AM' });
    ok('an admin cannot disable themselves', r.statusCode === 409 && r.body.error === 'cannot_disable_self');
    r = await admin(amCookie, { action: 'delete', initials: 'AM' });
    ok('nor delete themselves', r.statusCode === 409 && r.body.error === 'cannot_delete_self');
    r = await admin(amCookie, { action: 'role', initials: 'AM', role: 'clinician' });
    ok('nor demote themselves', r.statusCode === 409);

    // The last active admin, approached by the transition admin (passcode + ADMIN_USERS).
    process.env.APP_USERS = 'TT:transition-code-1'; process.env.ADMIN_USERS = 'TT';
    resetAll();
    const tt = await legacyCookie('TT');
    const wLast = store.writes;
    r = await admin(tt, { action: 'disable', initials: 'AM' });
    ok('the last active admin cannot be disabled', r.statusCode === 409 && r.body.error === 'last_admin', JSON.stringify(r.body));
    r = await admin(tt, { action: 'delete', initials: 'AM' });
    ok('nor deleted', r.statusCode === 409 && r.body.error === 'last_admin');
    r = await admin(tt, { action: 'role', initials: 'AM', role: 'clinician' });
    ok('nor demoted', r.statusCode === 409 && r.body.error === 'last_admin');
    ok('and none of that wrote', store.writes === wLast);
    await admin(tt, { action: 'role', initials: 'MM', role: 'admin' });
    r = await admin(tt, { action: 'disable', initials: 'AM' });
    ok('with a second active admin, the first can be disabled', r.statusCode === 200);
    await admin(tt, { action: 'enable', initials: 'AM' });
    amCookie = await cookieFor('AM', store.items.user_AM.epoch);
    delete process.env.APP_USERS; delete process.env.ADMIN_USERS;

    resetAll();
    await seed(store, 'GG');
    const gg = await cookieFor('GG', 1);
    r = await admin(amCookie, { action: 'delete', initials: 'GG' });
    ok('delete removes the item from the store', r.statusCode === 200 && !('user_GG' in store.items));
    ok('and their session is refused', (await gate('/ai-notes/', { cookie: gg }))?.status === 401);
    ok('and deleting someone who is not there is a 404, not a write', (await admin(amCookie, { action: 'delete', initials: 'GG' })).statusCode === 404);

    // Write rate limit: twenty an hour, then refused before any write.
    resetAll();
    for (let i = 0; i < 20; i++) _writeLimit.count('writes');
    const wRate = store.writes;
    r = await admin(amCookie, { action: 'add', email: 'rate@practice.example', initials: 'RL', role: 'clinician' });
    ok('the 21st write in an hour is refused', r.statusCode === 429 && r.body.error === 'write_limit' && store.writes === wRate);
    _writeLimit.clear();

    // A store write that fails changes nothing and says so.
    resetAll();
    store.failWrites = true;
    r = await admin(amCookie, { action: 'disable', initials: 'MM' });
    ok('a failed store write is reported, not claimed as done', r.statusCode === 502 && store.items.user_MM.status === 'active');
    store.failWrites = false;

    // The fake store, and writeItems, hold to the real one's rules.
    resetAll();
    const itemsBefore = JSON.stringify(store.items);
    let threw = null;
    try {
      await A.writeItems([{ operation: 'upsert', key: 'user_QQ', value: { a: 1 } }, { operation: 'create', key: 'user_AM', value: {} }]);
    } catch (e) { threw = e.message; }
    ok('a request whose second operation fails applies neither', threw && JSON.stringify(store.items) === itemsBefore, String(threw));
    threw = null;
    try { await A.writeItems([{ operation: 'upsert', key: 'user AM!', value: 1 }]); } catch (e) { threw = e.message; }
    ok('a key outside [A-Za-z0-9_-] is never sent', /bad store key/.test(String(threw)));
    process.env.VERCEL_TEAM_ID = 'team_abc';
    await A.writeItems([{ operation: 'upsert', key: 'user_QQ', value: { a: 1 } }]);
    ok('writes go to the global-config API, with the team id when set', store.lastWritePath === `/v1/global-config/${STORE_ID}/items?teamId=team_abc`, store.lastWritePath);
    delete process.env.VERCEL_TEAM_ID;
    delete store.items.user_QQ;
    delete process.env.GLOBAL_CONFIG;
    process.env.EDGE_CONFIG = `https://edge-config.vercel.com/${STORE_ID}?token=${READ_TOKEN}`;
    St._resetStore();
    await A.writeItems([{ operation: 'upsert', key: 'user_QQ', value: { a: 1 } }]);
    ok('with the legacy EDGE_CONFIG, the edge-config API', store.lastWritePath === `/v1/edge-config/${STORE_ID}/items`, store.lastWritePath);
    ok('and reads work through it', (await gate('/ai-notes/', { cookie: amCookie })) === undefined);
    delete store.items.user_QQ;
    configure();

    // Job tickets: a colleague's ticket can still delete their job, for any
    // store account, whatever its status.
    resetAll();
    {
      const zz = await Se.mintJobTicket(S, 'jobZZ', 'DD');
      const calls = stubWithStore(store, async () => ({ status: 200, body: {} }));
      const res = mockRes();
      await transcribe(mockReq({ method: 'DELETE', url: '/api/transcribe?jobId=jobZZ&ticket=' + zz, headers: { cookie: amCookie } }), res);
      ok('a disabled account\'s job ticket still lets a colleague delete that job', res.statusCode === 200 && calls.some((c) => c.method === 'DELETE' && c.url.includes('jobZZ')), String(res.statusCode));
      // And the disabled colleague's own page can still clear its job: the
      // gate lets a ticketed DELETE through, and the handler checks the ticket.
      const ddCookie = await cookieFor('DD', 1);
      ok('a ticketed DELETE passes the gate without a live session',
        (await middleware(new Request('https://oralsurgeryassess.com/api/transcribe?jobId=jobZZ&ticket=' + zz, { method: 'DELETE', headers: { accept: '*/*', cookie: ddCookie } }))) === undefined);
      ok('an unticketed one does not', (await middleware(new Request('https://oralsurgeryassess.com/api/transcribe?jobId=jobZZ', { method: 'DELETE', headers: { accept: '*/*', cookie: ddCookie } })))?.status === 401);
      ok('nor does a GET with a ticket', (await middleware(new Request('https://oralsurgeryassess.com/api/transcribe?jobId=jobZZ&ticket=' + zz, { headers: { accept: '*/*', cookie: ddCookie } })))?.status === 401);
      const res2 = mockRes();
      const calls2 = stubWithStore(store, async () => ({ status: 200, body: {} }));
      await transcribe(mockReq({ method: 'DELETE', url: '/api/transcribe?jobId=jobZZ&ticket=' + zz, headers: { cookie: ddCookie } }), res2);
      ok('so a disabled colleague\'s page can still delete its own job (zero retention holds)', res2.statusCode === 200 && calls2.some((c) => c.method === 'DELETE' && c.url.includes('jobZZ')), String(res2.statusCode));
      const res3 = mockRes();
      await transcribe(mockReq({ method: 'DELETE', url: '/api/transcribe?jobId=jobZZ&ticket=' + 'f'.repeat(64), headers: { cookie: ddCookie } }), res3);
      ok('but a forged ticket still cannot', res3.statusCode === 403);
      stubWithStore(store, speechmatics);
    }

    /* ---------- a store that is set but broken ---------- */
    resetAll();
    process.env.GLOBAL_CONFIG = 'https://example.com/ecfg?token=x';
    process.env.APP_USERS = 'AM:owner-passcode-1';
    ok('a malformed store setting refuses v3 sessions', (await gate('/ai-notes/', { cookie: amCookie }))?.status === 401);
    delete process.env.APP_USERS;
    ok('and does not quietly reopen passcodes once APP_USERS is gone', (await gate('/ai-notes/', { cookie: v2am }))?.status === 401);
    ok('account setup reports itself unavailable', (await setup({ token: inviteToken }, '198.51.100.120')).statusCode === 503);

    /* ---------- no store at all: exactly as before ---------- */
    unconfigure();
    resetAll();
    process.env.APP_USERS = 'AM:owner-passcode-1';
    page = await (await gate('/ai-notes/')).text();
    ok('no store: the sign-in page is the passcode form alone', /Passcode/.test(page) && !/type="email"/.test(page));
    ok('no store: a v2 session passes, as before', (await gate('/ai-notes/', { cookie: v2am })) === undefined);
    delete process.env.APP_USERS;
    ok('no store: and even with APP_USERS unset, as before', (await gate('/ai-notes/', { cookie: v2am })) === undefined);
    ok('no store: a v3 session means nothing', (await gate('/ai-notes/', { cookie: amCookie }))?.status === 401);
    ok('no store: transcribe does not second-guess the gate', (await transcribeAs('')) === 200);
    ok('no store: account setup is unavailable', (await setup({ token: inviteToken }, '198.51.100.121')).statusCode === 503);
    r = await signIn({ email: 'am@practice.example', password: 'x' }, '192.0.2.99');
    ok('no store: an account sign-in is a configuration error, not a wrong password', r.statusCode === 500);
    process.env.APP_USERS = 'AM:owner-passcode-1'; process.env.ADMIN_USERS = 'AM';
    r = await admin(v2am, null);
    ok('no store: the admin page says accounts are not configured', r.statusCode === 200 && r.body.configured === false && r.body.state === 'off');
    r = await admin(v2am, { action: 'add', email: 'x@practice.example', initials: 'XY', role: 'clinician' });
    ok('and refuses changes', r.statusCode === 503);
  } finally {
    restoreConsole();
    unconfigure();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    resetAll();
  }
}


/* ================================================================
   Security review, 26 September 2026: one block per finding. Each was
   reproduced against the code before its fix (see the review's scripts).
   ================================================================ */
async function testReviewFixes() {
  section('Security review fixes — epochs, reads, stale lists, races, allowances, paths, CSRF, reserved initials');
  const S = 'secret-for-tests';
  process.env.SESSION_SECRET = S;
  const saved = { APP_USERS: process.env.APP_USERS, ADMIN_USERS: process.env.ADMIN_USERS, IMPLANT_USERS: process.env.IMPLANT_USERS };
  const A = await import('../api/_accounts.mjs');
  const St = await import('../api/_store.mjs');
  const Se = await import('../api/_session.mjs');
  const authMod = await import('../api/auth.mjs');
  const auth = authMod.default;
  const { default: users, _writeLimit, _timing } = await import('../api/users.mjs');
  _timing.settleMs = 0;
  const accountMod = await import('../api/account.mjs');
  const account = accountMod.default;
  const { default: middleware } = await import('../middleware.js');
  const quietWarn = console.warn, quietErr = console.error, quietLog = console.log;
  console.warn = () => {}; console.error = () => {};
  console.log = (...a) => { if (typeof a[0] === 'string' && /^ {2}(PASS|FAIL) /.test(a[0])) quietLog(...a); };

  const resetAll = () => {
    St._resetStore();
    authMod._throttle.attempts.clear();
    authMod._accountThrottle.clear();
    for (const t of ['perIp', 'finished']) accountMod._throttles[t].clear();
    _writeLimit.clear();
  };
  const store = fakeStore();
  stubWithStore(store);
  process.env.GLOBAL_CONFIG = `https://global-config.vercel.com/${STORE_ID}?token=${READ_TOKEN}`;
  process.env.VERCEL_API_TOKEN = API_TOKEN;
  delete process.env.EDGE_CONFIG; delete process.env.APP_USERS; delete process.env.ADMIN_USERS; delete process.env.IMPLANT_USERS;
  const passwords = {};
  async function seed(initials, { role = 'clinician', status = 'active', epoch = 1000 + initials.charCodeAt(0), email } = {}) {
    passwords[initials] = `a long password for ${initials}`;
    store.items[`user_${initials}`] = {
      email: email || `${initials.toLowerCase()}@practice.example`, initials, role, status,
      pw: await A.hashPassword(passwords[initials]),
      invite: null, epoch, createdAt: '2026-09-26'
    };
  }
  const cookieFor = async (who, epoch) => `${Se.COOKIE_NAME}=${await Se.mintToken(S, 3600, who, epoch)}`;
  const call = async (handler, { method = 'POST', body = null, cookie, ip = '192.0.2.200', headers = {} } = {}) => {
    const r = mockRes();
    await handler(mockReq({ method, body, headers: { 'x-real-ip': ip, ...(cookie ? { cookie } : {}), ...headers } }), r);
    return r;
  };
  const gate = (path, cookie, accept = 'text/html') => middleware(new Request('https://oralsurgeryassess.com' + path, { headers: { accept, ...(cookie ? { cookie } : {}) } }));
  const onboard = async (adminCookie, initials, email, password, ip) => {
    const add = await call(users, { cookie: adminCookie, body: { action: 'add', initials, email, role: 'clinician' } });
    const token = (add.body.setupLink || '').split('#')[1];
    const fin = await call(account, { body: { token, password }, ip });
    const si = await call(auth, { body: { email, password }, ip });
    return { add, fin, si, cookie: (si.headers['set-cookie'] || '').split(';')[0] };
  };

  try {
    resetAll();
    await seed('AM', { role: 'admin' });
    const am = await cookieFor('AM', store.items.user_AM.epoch);

    /* --- 1. a deleted person's cookie must not come back with a new account --- */
    const leaver = await onboard(am, 'XY', 'leaver@practice.example', 'correct-horse-111', '192.0.2.201');
    ok('(the leaver is set up and signed in)', leaver.si.statusCode === 200 && (await gate('/ai-notes/', leaver.cookie)) === undefined);
    await call(users, { cookie: am, body: { action: 'delete', initials: 'XY' } });
    ok('deleted: the leaver\'s cookie is refused', (await gate('/ai-notes/', leaver.cookie))?.status === 401);
    resetAll();
    const starter = await onboard(am, 'XY', 'starter@practice.example', 'battery-staple-222', '192.0.2.202');
    ok('(a new starter is given the same initials and set up)', starter.fin.statusCode === 200 && starter.si.statusCode === 200);
    ok('the leaver\'s old cookie does NOT come back to life with the new account', (await gate('/ai-notes/', leaver.cookie))?.status === 401);
    ok('while the new starter\'s works', (await gate('/ai-notes/', starter.cookie)) === undefined);
    const firsts = new Set(Array.from({ length: 20 }, () => A.firstEpoch()));
    ok('new accounts start at a random epoch, not 0', firsts.size === 20 && [...firsts].every((e) => e >= 1 && e < 100_000_000));
    const bumps = Array.from({ length: 20 }, () => A.nextEpoch(5000));
    ok('and each bump adds a random amount, so two setups racing from one epoch end apart', new Set(bumps).size === 20 && bumps.every((e) => e > 5000));
    for (const [label, bad] of [['negative', -1], ['fractional', 1.5], ['too large', 1e16], ['a string', '12']]) {
      let threw = false;
      try { await Se.mintToken(S, 3600, 'AM', bad); } catch { threw = true; }
      ok(`mintToken refuses a ${label} epoch rather than quietly issuing a passcode-era token`, threw);
    }
    const big = await Se.mintToken(S, 3600, 'AM', 999_999_999_999_999);
    ok('a 15-digit epoch round-trips', (await Se.readToken(S, big))?.epoch === 999_999_999_999_999);

    /* --- 2. nothing an outsider sends forces a store read --- */
    resetAll();
    await gate('/ai-notes/', am);   // warm this instance's list
    let reads = store.reads;
    for (let i = 0; i < 10; i++) await call(account, { body: { token: A.newInvite().token }, ip: '198.51.100.' + (140 + i) });
    ok('junk setup tokens are answered from the cached list: no reads', store.reads === reads, String(store.reads - reads));
    // Ten seconds on: inside the 30 s cache, past the 5 s the sign-in used to allow itself.
    { const realNow = Date.now; Date.now = () => realNow() + 10_000;
      try {
        reads = store.reads;
        for (let i = 0; i < 6; i++) await call(auth, { body: { email: `nobody${i}@practice.example`, password: 'x'.repeat(12) }, ip: '203.0.113.' + (10 + i) });
        for (let i = 0; i < 3; i++) await call(auth, { body: { email: 'am@practice.example', password: 'wrong password ' + i }, ip: '203.0.113.' + (30 + i) });
        ok('unknown emails and wrong passwords cost no reads', store.reads === reads, String(store.reads - reads));
      } finally { Date.now = realNow; } }
    reads = store.reads;
    const si = await call(auth, { body: { email: 'am@practice.example', password: passwords.AM }, ip: '203.0.113.40' });
    ok('a correct sign-in is confirmed with exactly one fresh read', si.statusCode === 200 && store.reads === reads + 1, `${si.statusCode} ${store.reads - reads}`);
    const inv = A.newInvite();
    await seed('IV', { status: 'invited' });
    Object.assign(store.items.user_IV, { pw: null, invite: inv.invite });
    St._resetStore(); await gate('/ai-notes/', am);
    reads = store.reads;
    const good = await call(account, { body: { token: inv.token }, ip: '198.51.100.160' });
    ok('a real setup link is confirmed with exactly one fresh read', good.statusCode === 200 && store.reads === reads + 1, `${good.statusCode} ${store.reads - reads}`);
    // Genuine cookies newer than the cached list share ONE early re-read per
    // instance; cookies for initials the list does not have get none.
    resetAll(); await gate('/ai-notes/', am);
    reads = store.reads;
    for (let i = 0; i < 8; i++) await gate('/ai-notes/', await cookieFor('AM', store.items.user_AM.epoch + 1 + i));
    ok('eight sessions "newer than the list" make at most one early re-read between them', store.reads - reads <= 1, String(store.reads - reads));
    resetAll(); await gate('/ai-notes/', am);
    { const realNow = Date.now; Date.now = () => realNow() + 6000;
      try {
        reads = store.reads;
        for (let i = 0; i < 5; i++) await gate('/ai-notes/', await cookieFor('GONE', 1234 + i));
        ok('a cookie for an account not in the list (a leaver\'s) triggers no re-read at all', store.reads === reads, String(store.reads - reads));
      } finally { Date.now = realNow; } }
    // ...and that cannot lock out someone who has just set up: the cached list
    // shows them invited, and their sign-in gets the shared re-read.
    resetAll();
    await seed('JS', { status: 'invited' });
    Object.assign(store.items.user_JS, { invite: { hash: 'e'.repeat(64), expires: new Date(Date.now() + 3600e3).toISOString() } });
    await gate('/ai-notes/', am);   // this instance now caches JS as invited
    await seed('JS', { epoch: store.items.user_JS.epoch + 77 });   // "another instance" finishes their setup
    { const realNow = Date.now; Date.now = () => realNow() + 6000;
      try {
        const r = await call(auth, { body: { email: 'js@practice.example', password: passwords.JS }, ip: '203.0.113.50' });
        ok('someone who has just finished setting up elsewhere can sign in at once', r.statusCode === 200, String(r.statusCode));
      } finally { Date.now = realNow; } }

    /* --- 3. a stale list is for sessions only; decisions fail closed --- */
    resetAll();
    const inv3 = A.newInvite();
    await seed('SX', { status: 'invited' });
    Object.assign(store.items.user_SX, { pw: null, invite: inv3.invite });
    await gate('/ai-notes/', am);   // a good list, cached
    store.failReads = true;
    { const realNow = Date.now; Date.now = () => realNow() + St.CACHE_MS + 5000;
      try {
        ok('during a store outage an existing session still works (last good list)', (await gate('/ai-notes/', am)) === undefined);
        ok('but setup does not proceed on the old list', (await call(account, { body: { token: inv3.token }, ip: '198.51.100.170' })).statusCode === 503);
        ok('nor does sign-in', (await call(auth, { body: { email: 'am@practice.example', password: passwords.AM }, ip: '203.0.113.60' })).statusCode === 503);
        ok('nor an admin change', (await call(users, { cookie: am, body: { action: 'disable', initials: 'SX' } })).statusCode === 503);
        const before = store.writes;
        ok('and nothing was written', store.writes === before);
      } finally { Date.now = realNow; } }
    store.failReads = false;

    /* --- 4. two admins disabling each other at the same moment --- */
    resetAll();
    await seed('AA', { role: 'admin' }); await seed('BB', { role: 'admin' });
    await call(users, { cookie: am, body: { action: 'role', initials: 'AM', role: 'clinician' } }); // (refused: own role)
    // Make AA and BB the only admins: demote AM directly in the store.
    store.items.user_AM.role = 'clinician';
    St._resetStore();
    const aa = await cookieFor('AA', store.items.user_AA.epoch);
    // BB's disable of AA lands on "another instance" straight after AA's
    // disable of BB: neither pre-check could see the other.
    store.afterWrite = (st) => { st.items.user_AA = { ...st.items.user_AA, status: 'disabled', epoch: st.items.user_AA.epoch + 9 }; };
    const r4 = await call(users, { cookie: aa, body: { action: 'disable', initials: 'BB' } });
    ok('an admin-removing change that turns out to leave no admin is undone', r4.statusCode === 409 && r4.body.error === 'last_admin_undone', JSON.stringify(r4.body));
    ok('and BB is active again', store.items.user_BB.status === 'active' && store.items.user_BB.role === 'admin');
    store.items.user_AA.status = 'active';
    store.items.user_AM.role = 'admin';

    /* --- 5. allowances: 5 an hour, 10 a day, and a 7 KB store --- */
    resetAll();
    const w0 = store.writes;
    for (let i = 0; i < 5; i++) await call(users, { cookie: am, body: { action: i % 2 ? 'enable' : 'disable', initials: 'SX' } });
    let r5 = await call(users, { cookie: am, body: { action: 'enable', initials: 'SX' } });
    ok('the sixth change in an hour is refused', r5.statusCode === 429 && store.writes === w0 + 5, `${r5.statusCode} ${store.writes - w0}`);
    _writeLimit.hourly.clear();
    for (let i = 0; i < 5; i++) _writeLimit.daily.count('writes');
    r5 = await call(users, { cookie: am, body: { action: 'enable', initials: 'SX' } });
    ok('and the eleventh in a day, even in a new hour', r5.statusCode === 429 && r5.body.error === 'write_limit');
    resetAll();
    ok('an active record is compact (under 350 bytes serialised)', JSON.stringify({ user_AM: store.items.user_AM }).length < 350,
      String(JSON.stringify({ user_AM: store.items.user_AM }).length));
    store.items.padding = 'x'.repeat(6600);
    const w1 = store.writes;
    r5 = await call(users, { cookie: am, body: { action: 'add', initials: 'FU', email: 'fu@practice.example', role: 'clinician' } });
    ok('adding someone who would take the store past 7 KB is refused', r5.statusCode === 409 && r5.body.error === 'store_full' && store.writes === w1, JSON.stringify(r5.body));
    delete store.items.padding;

    /* --- 6. other spellings of the gated paths --- */
    resetAll();
    process.env.IMPLANT_USERS = 'AM';
    await seed('CL');
    const cl = await cookieFor('CL', store.items.user_CL.epoch);
    for (const [p, want] of [
      ['/ai-notes/%61dmin/', 403], ['/Ai-Notes/Admin/', 403], ['/ai-notes/ADMIN', 403],
      ['/ai-notes//admin/', 400], ['/ai-notes/admin%2F', 400], ['/ai-notes/setup/%2e%2e/admin/', 403 /* the URL parser resolves %2e%2e itself */], ['/ai-notes/admin%5c', 400],
      ['/%69mplant/', 403], ['/IMPLANT/', 403], ['/implant%2F', 400], ['/%69mplant%2fviewer.js', 400], ['/api//users', 400]
    ]) {
      const r = await gate(p, cl);
      ok(`${p} as a clinician: ${want}`, r?.status === want, String(r?.status));
    }
    ok('the admin still gets in under an encoded spelling (the rule follows the place, not the spelling)', (await gate('/ai-notes/%61dmin/', am)) === undefined);
    ok('an open path spelled differently is gated, not opened (fail closed)', (await gate('/ai-notes/%73etup/'))?.status === 401);
    ok('a path that cannot be decoded is refused', (await gate('/ai-notes/%E0%A4%A', cl))?.status === 400);
    ok('the plain paths are unchanged', (await gate('/ai-notes/', cl)) === undefined && (await gate('/implant/', cl))?.status === 403 && (await gate('/implant/', am)) === undefined);

    /* --- 7. login CSRF --- */
    resetAll();
    const creds = { email: 'am@practice.example', password: passwords.AM };
    let r7 = await call(auth, { body: creds, headers: { origin: 'https://evil.example' }, ip: '203.0.113.70' });
    ok('a sign-in posted from another site is refused, and sets no cookie', r7.statusCode === 403 && !r7.headers['set-cookie']);
    r7 = await call(auth, { body: creds, headers: { origin: undefined }, ip: '203.0.113.71' });
    ok('so is one with no Origin', r7.statusCode === 403);
    r7 = await call(auth, { body: 'email=am%40practice.example&password=x', headers: { 'content-type': 'application/x-www-form-urlencoded' }, ip: '203.0.113.72' });
    ok('a form-encoded sign-in (what a cross-site form sends) is refused', r7.statusCode === 415);
    r7 = await call(auth, { body: JSON.stringify(creds), headers: { 'content-type': 'text/plain' }, ip: '203.0.113.73' });
    ok('and a text/plain one', r7.statusCode === 415 && !r7.headers['set-cookie']);
    r7 = await call(auth, { body: { passcode: 'anything' }, headers: { origin: 'https://evil.example' }, ip: '203.0.113.74' });
    ok('the passcode route too', r7.statusCode === 403);
    r7 = await call(auth, { method: 'DELETE', headers: { origin: 'https://evil.example' } });
    ok('a sign-out from another site is refused', r7.statusCode === 403 && !r7.headers['set-cookie']);
    r7 = await call(auth, { method: 'DELETE' });
    ok('while this site\'s Lock button (same origin, no body) still signs out', r7.statusCode === 200 && /Max-Age=0/.test(r7.headers['set-cookie'] || ''));
    r7 = await call(auth, { body: creds, ip: '203.0.113.75' });
    ok('and a same-origin JSON sign-in works', r7.statusCode === 200);
    const page = await (await gate('/ai-notes/')).text();
    ok('the sign-in page sends JSON, from both of its forms', /headers: \{ 'Content-Type': 'application\/json' \}/.test(page) && /JSON\.stringify\(payload\)/.test(page));

    /* --- 8. initials the environment already gives powers to --- */
    resetAll();
    process.env.IMPLANT_USERS = 'OW';
    await seed('BB', { role: 'admin' });
    const bb = await cookieFor('BB', store.items.user_BB.epoch);
    let r8 = await call(users, { cookie: bb, body: { action: 'add', initials: 'OW', email: 'someone@practice.example', role: 'clinician' } });
    ok('an admin cannot create an account with initials on IMPLANT_USERS', r8.statusCode === 409 && r8.body.error === 'initials_reserved', JSON.stringify(r8.body));
    process.env.IMPLANT_USERS = 'AM'; process.env.ADMIN_USERS = 'OW';
    r8 = await call(users, { cookie: bb, body: { action: 'add', initials: 'ow', email: 'someone@practice.example', role: 'clinician' } });
    ok('nor on ADMIN_USERS', r8.body.error === 'initials_reserved');
    process.env.ADMIN_USERS = ''; process.env.APP_USERS = 'OW:owner-passcode-9';
    r8 = await call(users, { cookie: bb, body: { action: 'add', initials: 'OW', email: 'someone@practice.example', role: 'clinician' } });
    ok('nor on APP_USERS', r8.body.error === 'initials_reserved');
    process.env.ADMIN_USERS = 'OW';
    const ow = `${Se.COOKIE_NAME}=${await Se.mintToken(S, 3600, 'OW')}`;
    r8 = await call(users, { cookie: ow, body: { action: 'add', initials: 'OW', email: 'owner@practice.example', role: 'admin' } });
    ok('but the owner, signed in under those initials, can create his own account', r8.statusCode === 200, JSON.stringify(r8.body));
  } finally {
    console.warn = quietWarn; console.error = quietErr; console.log = quietLog;
    delete process.env.GLOBAL_CONFIG; delete process.env.VERCEL_API_TOKEN;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    resetAll();
  }
}

/* ---------- run ---------- */
const realFetch = globalThis.fetch;
try {
  await testTranscribe();
  await testExtract();
  await testMiddleware();
  await testMultiUser();
await testAuth();
  await testSweep2();
  await testAccounts();
  await testAccountFlows();
  await testReviewFixes();
} finally {
  globalThis.fetch = realFetch;
}

console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}\n`);
process.exit(fail ? 1 : 0);
