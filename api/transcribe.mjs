// api/transcribe.mjs
//
// Audio in, diarised transcript out. The browser never touches Speechmatics —
// the key stays here and the site keeps its property of making zero third-party
// requests from the client.
//
//   POST   /api/transcribe            raw audio body -> submits, polls briefly, returns turns or a job id
//   GET    /api/transcribe?jobId=...  one status check; returns turns when done, 202 otherwise
//   DELETE /api/transcribe?jobId=...  best-effort cleanup, called by the Clear button
//
// Retention: Speechmatics keeps a completed job (audio + transcript) on their
// side until it is deleted or ages out at 7 days. That is squarely against the
// zero retention claim in the DPIA, so every path here deletes the job
// explicitly.
//
// Region: the DPIA (§2.7, signed 2 Sep 2026) says audio is processed in
// Speechmatics' EU1 region. Speechmatics determine the region SOLELY by the
// hostname called — the old `region` parameter is deprecated and has no effect —
// so the hostname is the DPIA. The guard below refuses to run against anything
// that is not an EU endpoint, so an environment-variable slip cannot quietly
// move patient audio to another jurisdiction.

export const config = {
  // Works on both Hobby (hard cap 60) and Pro. The handler never waits longer
  // than POST_BUDGET_MS in one invocation; a long transcription is handed back
  // to the client as a job id and finished through the GET route, one short
  // check per request. Nothing here needs a plan upgrade.
  maxDuration: 60
};

const API_BASE = process.env.SPEECHMATICS_API_BASE || 'https://eu1.asr.api.speechmatics.com/v2';
const EU_HOSTS = ['eu1.asr.api.speechmatics.com', 'eu2.asr.api.speechmatics.com'];

const POST_BUDGET_MS = 35_000;  // short recordings finish inside this; long ones go to GET
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
  if (!isEuEndpoint(API_BASE)) {
    // Refuse rather than proceed. The DPIA asserts EU1; this is how it stays true.
    console.error('transcribe: SPEECHMATICS_API_BASE is not an EU endpoint:', API_BASE);
    return res.status(500).json({
      error: 'server_misconfigured',
      detail: 'SPEECHMATICS_API_BASE must point at eu1.asr.api.speechmatics.com (or eu2). ' +
              'The DPIA records EU1 as the processing region; this server will not send audio anywhere else.'
    });
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
      // One check per request: the client paces itself, and no invocation
      // sits waiting long enough to hit a plan's duration cap.
      return await pollOrCleanUp(key, jobId, res, 0);
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST, GET, DELETE');
      return res.status(405).json({ error: 'method_not_allowed' });
    }

    const { buf: audio, via } = await readBody(req);
    const contentTypeRaw = req.headers['content-type'] || 'audio/webm';

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

    // Size first, then content. An oversized file should say so, not report an
    // unreadable container.
    {
      // Check the container before creating a job. A corrupted upload would
      // otherwise cost a Speechmatics job and come back as a vague rejection.
      const container = sniffContainer(audio);
      if (container === 'webm-UNSUPPORTED') {
        return res.status(400).json({
          error: 'audio_format_unsupported',
          detail:
            'The recording is WebM, which Speechmatics explicitly does not accept — their ' +
            'supported list (wav, mp3, aac, ogg, mpeg, amr, m4a, mp4, flac) is documented as ' +
            'exhaustive. The browser should be recording MP4 or Ogg. If this appears, the ' +
            'format preference in ai-notes/index.html is not taking effect.'
        });
      }
      if (container === 'UNRECOGNISED' || container === 'too-short') {
        return res.status(400).json({
          error: 'audio_not_readable',
          detail:
            `The recording did not arrive as valid audio, so it was not submitted. ` +
            `${audio.length} bytes, container "${container}", read via "${via}", ` +
            `declared type "${contentTypeRaw}", first bytes ${audio.slice(0, 12).toString('hex')}. ` +
            (via === 'string'
              ? 'Read via "string" means the platform decoded the body as text before this handler ran, which destroys binary audio. That is the fault.'
              : 'The bytes reached the server but do not carry a recognised container header.')
        });
      }
    }


    // Strip codec parameters: "audio/webm;codecs=opus" as a multipart part type
    // is not reliably accepted. The extension on the filename is what matters.
    const contentType = contentTypeRaw.split(';')[0].trim() || 'audio/webm';
    const jobId = await submitJob(key, audio, contentType, via);
    return await pollOrCleanUp(key, jobId, res, POST_BUDGET_MS);
  } catch (err) {
    // Never log payloads — R11. Message only.
    console.error('transcribe failed:', err && err.message);
    return res.status(502).json({ error: 'transcription_failed', detail: safeMessage(err) });
  }
}

/* ---------- Speechmatics ---------- */

async function submitJob(key, audio, contentType, via) {
  const config = {
    type: 'transcription',
    transcription_config: {
      language: 'en',

      // "model", not "operating_point". The latter was the old field name and
      // appears nowhere in current documentation. An unrecognised field is not
      // necessarily rejected — it may simply be ignored — which would silently
      // leave every transcript on the standard model. That would show up as poor
      // accuracy on dental terminology and be blamed on the tool rather than on
      // one wrong word here.
      model: 'enhanced',

      diarization: 'speaker',

      speaker_diarization_config: {
        // 0.5 is the documented default; stated explicitly because it is the
        // first thing to tune if the clinician and patient are being merged or
        // one person is being split across labels. Higher yields more speakers.
        speaker_sensitivity: 0.5

        // prefer_current_speaker is deliberately NOT enabled.
        //
        // It reduces false switches between similar-sounding speakers, which
        // sounds desirable — but the documented cost is that "shorter speaker
        // turn changes between similar speakers" get missed. In this room the
        // short turn is almost always the patient interjecting a question, and
        // absorbing that into the clinician's speech is precisely the failure
        // the whole tool is built to prevent: a risk the patient raised being
        // recorded as one the clinician named.
        //
        // The safer error here is splitting one speaker in two. The clinician
        // sees that immediately. A merge is invisible.
      },

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

  if (!r.ok) {
    // Say what was actually sent. A bare "invalid audio" leaves nothing to act on.
    throw new Error(
      `submit ${r.status}: ${await shortText(r)} ` +
      `[sent ${audio.length} bytes, container ${sniffContainer(audio)}, ` +
      `type ${contentType}, filename consult${extensionFor(contentType)}, read via ${via}]`
    );
  }
  const data = await r.json();
  if (!data.id) throw new Error('submit returned no job id');
  return data.id;
}

/**
 * pollToCompletion, but guaranteeing the job is deleted if anything goes wrong.
 *
 * A failed status poll used to abandon the job entirely: the request returned
 * 502 and the audio stayed on the provider's side. Zero retention has to hold on
 * the unhappy paths too, or it is not a property, only an intention.
 *
 * The one path that must NOT delete is the 202 pending return — the client is
 * coming back for that job.
 */
async function pollOrCleanUp(key, jobId, res, budgetMs) {
  try {
    return await pollToCompletion(key, jobId, res, budgetMs);
  } catch (err) {
    await deleteJob(key, jobId);
    throw err;
  }
}

async function pollToCompletion(key, jobId, res, budgetMs) {
  const deadline = Date.now() + budgetMs;
  let waitMs = 1500;

  for (;;) {
    const r = await fetch(`${API_BASE}/jobs/${jobId}`, {
      headers: { Authorization: `Bearer ${key}` }
    });
    if (!r.ok) throw new Error(`status ${r.status}: ${await shortText(r)}`);

    const status = (await r.json())?.job?.status;

    if (status === 'done') {
      // finally, not sequential. If fetchTranscript throws — a network blip, a
      // 500 from the provider — the old code returned an error and left the
      // audio and transcript sitting on their side indefinitely.
      try {
        const turns = await fetchTranscript(key, jobId);
        return res.status(200).json({ status: 'done', turns });
      } finally {
        await deleteJob(key, jobId);
      }
    }
    if (status === 'rejected' || status === 'expired' || status === 'deleted') {
      await deleteJob(key, jobId);
      throw new Error(`job ${status}`);
    }

    if (Date.now() + waitMs >= deadline) break;
    await sleep(waitMs);
    waitMs = Math.min(waitMs * 1.3, 5000);
  }

  // Out of budget, job still running. Hand the id back so the client can carry
  // on against the GET route rather than losing the recording.
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

function isEuEndpoint(base) {
  try { return EU_HOSTS.includes(new URL(base).hostname); } catch { return false; }
}

function jobIdFrom(req) {
  const url = new URL(req.url, 'https://placeholder.local');
  const id = url.searchParams.get('jobId');
  return id && /^[A-Za-z0-9_-]{4,64}$/.test(id) ? id : null;
}

/**
 * Audio is binary, so the raw stream is the only lossless source. Read it FIRST.
 *
 * The previous version checked req.body first and, if the platform had decoded
 * the body to a string, did Buffer.from(str, 'binary') — which cannot recover
 * anything the decode already destroyed. That yields a file of roughly the right
 * size that no decoder can read, which is exactly what "Job rejected due to
 * invalid audio" looks like.
 *
 * Returns which path was used so a failure can say so rather than leaving it to
 * be guessed at.
 */
async function readBody(req) {
  const chunks = [];
  try {
    for await (const chunk of req) chunks.push(chunk);
  } catch { /* already consumed */ }
  if (chunks.length) return { buf: Buffer.concat(chunks), via: 'stream' };

  if (Buffer.isBuffer(req.body)) return { buf: req.body, via: 'buffer' };
  if (req.body instanceof Uint8Array) return { buf: Buffer.from(req.body), via: 'uint8array' };
  if (typeof req.body === 'string') return { buf: Buffer.from(req.body, 'binary'), via: 'string' };
  return { buf: Buffer.alloc(0), via: 'none' };
}

/** Identify the container from its magic bytes, so corruption is visible. */
function sniffContainer(buf) {
  if (buf.length < 12) return 'too-short';
  const b = buf;
  // WebM is recognisable but NOT accepted by Speechmatics — their supported list
  // (wav, mp3, aac, ogg, mpeg, amr, m4a, mp4, flac) is documented as exhaustive.
  // Naming it specifically turns a vague "invalid audio" into an actionable one.
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'webm-UNSUPPORTED';
  if (b.slice(4, 8).toString('latin1') === 'ftyp') return 'mp4';
  if (b.slice(0, 4).toString('latin1') === 'OggS') return 'ogg';
  if (b.slice(0, 4).toString('latin1') === 'RIFF') return 'wav';
  return 'UNRECOGNISED';
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
