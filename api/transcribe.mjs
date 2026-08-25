// api/transcribe.mjs
//
// Audio in, diarised transcript out. The browser never touches Speechmatics —
// the key stays here and the site keeps its property of making zero third-party
// requests from the client.
//
//   POST   /api/transcribe            raw audio body -> submits, polls, returns turns
//   GET    /api/transcribe?jobId=...  resumes polling if the POST ran out of budget
//   DELETE /api/transcribe?jobId=...  best-effort cleanup, called by the Clear button
//
// Retention: Speechmatics keeps a completed job (audio + transcript) on their
// side until it is deleted or ages out. That is squarely against the zero
// retention claim in the DPIA, so every path here deletes the job explicitly.
// Confirm the account's default retention setting too — belt and braces.

export const config = {
  maxDuration: 300 // seconds. Requires Pro. On Hobby this silently caps at 60
                   // and long recordings will fail — see BUDGET_MS below.
};

const API_BASE = process.env.SPEECHMATICS_API_BASE || 'https://asr.api.speechmatics.com/v2';
const BUDGET_MS = 240_000;      // stop polling in time to return cleanly
const MAX_BYTES = 4.4 * 1024 * 1024;
const MIN_BYTES = 2000;        // matches the client-side floor; below this there
                               // is no recording, only container headers

// Tuning surface for R3. Speechmatics weights these towards recognition, and
// they are exactly the words a general model gets wrong in a dental surgery.
// Add to this list as testing turns up misrecognitions — it is cheap and it is
// the single highest-yield accuracy lever in the pipeline.
const ADDITIONAL_VOCAB = [
  { content: 'periodontitis' },
  { content: 'periodontal' },
  { content: 'gingivitis' },
  { content: 'pericoronitis' },
  { content: 'edentulous' },
  { content: 'apicectomy' },
  { content: 'alveolar' },
  { content: 'osteonecrosis' },
  { content: 'paraesthesia', sounds_like: ['parasthesia', 'para esthesia'] },
  { content: 'dysaesthesia' },
  { content: 'trismus' },
  { content: 'articaine' },
  { content: 'lidocaine' },
  { content: 'midazolam' },
  { content: 'chlorhexidine' },
  { content: 'bisphosphonate' },
  { content: 'denosumab' },
  { content: 'radiolucency' },
  { content: 'furcation' },
  { content: 'occlusal' },
  { content: 'interproximal' },
  { content: 'buccal' },
  { content: 'palatal' },
  { content: 'lingual' },
  { content: 'distal' },
  { content: 'mesial' },
  { content: 'coronectomy' },
  { content: 'apicoectomy' },
  { content: 'endodontic' },
  { content: 'pulpotomy' },
  { content: 'pulpectomy' },
  { content: 'composite' },
  { content: 'amalgam' },
  { content: 'onlay' },
  { content: 'inlay' },
  { content: 'crown' },
  { content: 'bridge' },
  { content: 'denture' },
  { content: 'implant' },
  { content: 'scaling' },
  { content: 'debridement' },
  { content: 'IDB', sounds_like: ['I D B'] },
  { content: 'OPG', sounds_like: ['O P G'] },
  { content: 'CBCT', sounds_like: ['C B C T'] },
  { content: 'RCT', sounds_like: ['R C T'] },
  { content: 'MRONJ', sounds_like: ['em ron j', 'M R O N J'] },
  { content: 'Montgomery' }
];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  const key = process.env.SPEECHMATICS_API_KEY;
  if (!key) {
    console.error('transcribe: SPEECHMATICS_API_KEY not set');
    return res.status(500).json({ error: 'server_misconfigured' });
  }

  try {
    if (req.method === 'DELETE') {
      const jobId = jobIdFrom(req);
      if (!jobId) {
        // Never report success for a delete that did not happen: this is the
        // path that keeps the zero-retention claim true, and a silent no-op
        // would make a broken Clear button look like a working one.
        return res.status(400).json({ error: 'missing_or_invalid_job_id' });
      }
      await deleteJob(key, jobId);
      return res.status(200).json({ ok: true, jobId });
    }

    if (req.method === 'GET') {
      const jobId = jobIdFrom(req);
      if (!jobId) return res.status(400).json({ error: 'missing_job_id' });
      return await pollToCompletion(key, jobId, res, BUDGET_MS);
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST, GET, DELETE');
      return res.status(405).json({ error: 'method_not_allowed' });
    }

    const audio = await readBody(req);
    if (!audio || audio.length < MIN_BYTES) {
      // Fail here rather than at Speechmatics: submitting a few bytes of
      // container header creates a job, costs a credit, and then has to be
      // cleaned up.
      return res.status(400).json({
        error: 'empty_audio',
        detail: 'No recording was received. Check the microphone and try again.'
      });
    }
    if (audio.length > MAX_BYTES) {
      return res.status(413).json({
        error: 'audio_too_large',
        detail: 'Recording exceeds the request body limit. Shorten it or lower the bitrate.'
      });
    }

    const contentType = req.headers['content-type'] || 'audio/webm';
    const jobId = await submitJob(key, audio, contentType);
    return await pollToCompletion(key, jobId, res, BUDGET_MS - 5000);
  } catch (err) {
    // Never log payloads — R11. Message only.
    console.error('transcribe failed:', err && err.message);
    return res.status(502).json({ error: 'transcription_failed', detail: safeMessage(err) });
  }
}

/* ---------- Speechmatics ---------- */

async function submitJob(key, audio, contentType) {
  const config = {
    type: 'transcription',
    transcription_config: {
      language: 'en',
      operating_point: 'enhanced',
      diarization: 'speaker',
      speaker_diarization_config: { speaker_sensitivity: 0.5 },
      additional_vocab: ADDITIONAL_VOCAB,
      enable_entities: true
    }
  };

  const form = new FormData();
  form.append('config', JSON.stringify(config));
  form.append(
    'data_file',
    new Blob([audio], { type: contentType }),
    `consult${extensionFor(contentType)}`
  );

  const r = await fetch(`${API_BASE}/jobs`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form
  });

  if (!r.ok) throw new Error(`submit ${r.status}: ${await shortText(r)}`);
  const data = await r.json();
  if (!data.id) throw new Error('submit returned no job id');
  return data.id;
}

async function pollToCompletion(key, jobId, res, budgetMs) {
  const deadline = Date.now() + budgetMs;
  let waitMs = 1500;

  while (Date.now() < deadline) {
    const r = await fetch(`${API_BASE}/jobs/${jobId}`, {
      headers: { Authorization: `Bearer ${key}` }
    });
    if (!r.ok) throw new Error(`status ${r.status}: ${await shortText(r)}`);

    const status = (await r.json())?.job?.status;

    if (status === 'done') {
      const turns = await fetchTranscript(key, jobId);
      await deleteJob(key, jobId);
      return res.status(200).json({ status: 'done', turns });
    }
    if (status === 'rejected' || status === 'expired' || status === 'deleted') {
      await deleteJob(key, jobId);
      throw new Error(`job ${status}`);
    }

    await sleep(waitMs);
    waitMs = Math.min(waitMs * 1.3, 5000);
  }

  // Out of budget, job still running. Hand the id back so the client can resume
  // against the GET route rather than losing the recording.
  return res.status(202).json({ status: 'pending', jobId });
}

async function fetchTranscript(key, jobId) {
  const r = await fetch(`${API_BASE}/jobs/${jobId}/transcript?format=json-v2`, {
    headers: { Authorization: `Bearer ${key}` }
  });
  if (!r.ok) throw new Error(`transcript ${r.status}: ${await shortText(r)}`);
  return toTurns(await r.json());
}

async function deleteJob(key, jobId) {
  try {
    await fetch(`${API_BASE}/jobs/${jobId}?force=true`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${key}` }
    });
  } catch (err) {
    // Cleanup is best effort, but a persistent failure here is a DPIA problem
    // (R4), not a cosmetic one. Worth an alert if it ever shows up in logs.
    console.error('job delete failed:', jobId, err && err.message);
  }
}

/* ---------- transcript shaping ---------- */

// json-v2 gives a flat list of words and punctuation with a speaker label.
// Collapse to speaker turns, which is what the extraction prompt reads.
function toTurns(payload) {
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const turns = [];
  let current = null;

  for (const item of results) {
    const alt = item?.alternatives?.[0];
    if (!alt || typeof alt.content !== 'string') continue;

    const speaker = alt.speaker || 'UU';
    const isPunctuation = item.type === 'punctuation';

    if (!current || (!isPunctuation && current.speaker !== speaker)) {
      current = { speaker, text: '', start: item.start_time ?? null, end: item.end_time ?? null };
      turns.push(current);
    }

    current.text += (isPunctuation || current.text === '' ? '' : ' ') + alt.content;
    if (item.end_time != null) current.end = item.end_time;
  }

  return turns
    .map((t) => ({ speaker: t.speaker, text: t.text.trim(), start: t.start, end: t.end }))
    .filter((t) => t.text.length > 0);
}

/* ---------- helpers ---------- */

function jobIdFrom(req) {
  const url = new URL(req.url, 'https://placeholder.local');
  const id = url.searchParams.get('jobId');
  return id && /^[A-Za-z0-9_-]{4,64}$/.test(id) ? id : null;
}

async function readBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (req.body instanceof Uint8Array) return Buffer.from(req.body);
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function extensionFor(contentType) {
  const t = String(contentType).toLowerCase();
  if (t.includes('webm')) return '.webm';
  if (t.includes('mp4') || t.includes('m4a') || t.includes('aac')) return '.m4a';
  if (t.includes('ogg')) return '.ogg';
  if (t.includes('wav')) return '.wav';
  return '.webm';
}

async function shortText(r) {
  try { return (await r.text()).slice(0, 300); } catch { return '(no body)'; }
}

function safeMessage(err) {
  const m = err && err.message ? String(err.message) : 'unknown error';
  return m.slice(0, 300);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
