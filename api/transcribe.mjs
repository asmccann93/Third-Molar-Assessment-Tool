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
  // 120, the same as api/extract.mjs, which already deploys on this plan. It
  // was 60. Vercel kills a function that overruns with a 504, and its docs do
  // not say whether receiving the request body counts against the limit. A 4 MB
  // recording on a slow surgery upload, then resubmitted to Speechmatics, then
  // 35 s of polling, could pass 60 — and a killed POST loses the recording AND
  // orphans the job it had already created, since its id never reached the page.
  // POST_BUDGET_MS is now measured from when the request arrived, so the handler
  // hands a long job back as pending well inside this ceiling either way.
  maxDuration: 120
};

const API_BASE = process.env.SPEECHMATICS_API_BASE || 'https://eu1.asr.api.speechmatics.com/v2';
const EU_HOSTS = ['eu1.asr.api.speechmatics.com', 'eu2.asr.api.speechmatics.com'];

// Speechmatics publish a domain-tuned model alongside the general one. Medical
// is the closest fit to a dental consultation and should help on exactly the
// vocabulary the custom dictionary below is compensating for. It is unset-able
// via the environment, and — more importantly — a job rejected for the domain
// is retried once WITHOUT it, so an account that cannot use the medical model
// degrades to the general one rather than failing the consultation.
const DOMAIN = process.env.SPEECHMATICS_DOMAIN === '' ? null : (process.env.SPEECHMATICS_DOMAIN || 'medical');

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

import { readCookie, readToken, mintJobTicket, verifyJobTicket } from './_session.mjs';

/* Who is asking, and does this job belong to them?

   There is nowhere to record which session submitted a job — nothing is stored
   — so the binding travels with the client as a signed ticket. Without it, any
   valid cookie fetches any transcript given its id. With one clinician that is
   invisible; with a team it is one patient's consent discussion handed to the
   wrong colleague.

   A v1 cookie has no identity, so its tickets bind to "-". Those sessions are
   no worse off than before and expire within the day. */
async function holder(req) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return { secret: null, who: null };
  const claims = await readToken(secret, readCookie(req.headers.cookie));
  return { secret, who: (claims && claims.who) || null };
}

// The ticket is an HMAC over the job id AND its owner, and nothing records
// who that owner was. So try every owner it could be: the caller, a
// pre-multi-user session ("-"), and each clinician named in APP_USERS. The
// initials are read here rather than through auth.mjs's parseUsers, which
// logs about the passcodes; only the part before each colon matters.
async function ticketSignedForAnyone(secret, jobId, who, ticket) {
  const owners = new Set([who, null]);
  for (const part of String(process.env.APP_USERS || '').split(',')) {
    const i = part.indexOf(':');
    if (i > 0) owners.add(part.slice(0, i).trim());
  }
  for (const owner of owners) {
    if (await verifyJobTicket(secret, jobId, owner, ticket)) return true;
  }
  return false;
}

function ticketFrom(req) {
  const url = new URL(req.url, 'https://placeholder.local');
  const t = url.searchParams.get('ticket');
  return t && /^[a-f0-9]{64}$/.test(t) ? t : null;
}

export default async function handler(req, res) {
  const arrivedAt = Date.now();
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
    const { secret: sessionSecret, who } = await holder(req);

    if (req.method === 'DELETE') {
      const jobId = jobIdFrom(req);
      // Any genuine ticket will do here, not only the caller's own. Deleting
      // hands nobody a transcript, and insisting on the owner meant a job was
      // never deleted once the page asking was signed in as someone else (a
      // shared surgery computer, a re-sign-in): the audio then sat at
      // Speechmatics for a week. The ticket must still be one this server
      // signed, so an id guessed or copied from a log cannot delete a
      // colleague's job while it is still running.
      if (jobId && !(await ticketSignedForAnyone(sessionSecret, jobId, who, ticketFrom(req)))) {
        return res.status(403).json({ error: 'job_not_yours' });
      }
      if (!jobId) {
        // Never report success for a delete that did not happen: this is the
        // path that keeps the zero-retention claim true, and a silent no-op
        // would make a broken Clear button look like a working one.
        return res.status(400).json({ error: 'missing_or_invalid_job_id' });
      }
      if (!(await deleteJob(key, jobId))) {
        return res.status(502).json({ error: 'delete_failed', jobId });
      }
      return res.status(200).json({ ok: true, jobId });
    }

    if (req.method === 'GET') {
      const jobId = jobIdFrom(req);
      if (!jobId) return res.status(400).json({ error: 'missing_job_id' });
      // The gate proves they are a clinician here. This proves the transcript
      // is theirs.
      if (!(await verifyJobTicket(sessionSecret, jobId, who, ticketFrom(req)))) {
        return res.status(403).json({ error: 'job_not_yours' });
      }
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
    const ticket = await mintJobTicket(sessionSecret, jobId, who);
    // The budget runs from when the request arrived, not from here: the upload
    // and the resubmission to Speechmatics have already spent some of it.
    const budget = Math.max(0, POST_BUDGET_MS - (Date.now() - arrivedAt));
    return await pollOrCleanUp(key, jobId, res, budget, ticket);
  } catch (err) {
    // Never log payloads — R11. Message only.
    console.error('transcribe failed:', err && err.message);
    return res.status(502).json({ error: 'transcription_failed', detail: safeMessage(err) });
  }
}

/* ---------- Speechmatics ---------- */

async function submitJob(key, audio, contentType, via, domain = DOMAIN) {
  const config = {
    type: 'transcription',
    transcription_config: {
      language: 'en',
      // UK spelling in the transcript ("anaesthetic", "haemorrhage"), which is
      // what the note, the checklist and the clinician all use. Without it the
      // global English model writes whichever spelling it likes.
      output_locale: 'en-GB',
      ...(domain ? { domain } : {}),

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
    const body = await shortText(r);

    // The account may not have the domain-tuned model. Losing a consultation
    // over an optional accuracy setting would be absurd, so drop it and try
    // once more on the general model.
    if (domain && r.status >= 400 && r.status < 500 && /domain|medical|not.*(enabled|available|permitted)/i.test(body)) {
      console.warn(`transcribe: domain "${domain}" rejected (${r.status}: ${body}); retrying on the general model`);
      return await submitJob(key, audio, contentType, via, null);
    }

    // Say what was actually sent. A bare "invalid audio" leaves nothing to act on.
    throw new Error(
      `submit ${r.status}: ${body} ` +
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
async function pollOrCleanUp(key, jobId, res, budgetMs, ticket) {
  try {
    return await pollToCompletion(key, jobId, res, budgetMs, ticket);
  } catch (err) {
    await deleteJob(key, jobId);
    throw err;
  }
}

// An answer the provider may well give differently in a moment: rate
// limiting, or a fault on their side. Anything else — a 404, a 401 — IS the
// answer, and asking again changes nothing.
function isTransient(status) {
  return status === 429 || status >= 500;
}

async function pollToCompletion(key, jobId, res, budgetMs, ticket) {
  const deadline = Date.now() + budgetMs;
  let waitMs = 1500;

  for (;;) {
    // One failed status check is not a failed job. This used to throw on ANY
    // non-OK answer, and the throw deletes the job — so a single 503 or a
    // rate-limit from Speechmatics destroyed a transcription that was running
    // perfectly well, and with it the only copy of the consultation. Several
    // clinicians stopping at once share one account; that is exactly when a
    // 429 arrives. A transient failure now leaves the job pending: the client
    // asks again, and deletes the job itself if it finally gives up.
    let r = null;
    try {
      r = await fetch(`${API_BASE}/jobs/${jobId}`, {
        headers: { Authorization: `Bearer ${key}` }
      });
    } catch (err) {
      console.warn('transcribe: status check could not reach the provider; job left pending:', jobId);
    }
    if (r && !r.ok && !isTransient(r.status)) throw new Error(`status ${r.status}: ${await shortText(r)}`);
    if (r && !r.ok) {
      await shortText(r);   // drain it; the text is not needed
      console.warn(`transcribe: status check returned ${r.status}; job left pending:`, jobId);
    }

    const status = r && r.ok ? (await r.json())?.job?.status : null;

    if (status === 'done') {
      // Collect, delete, THEN answer. If fetchTranscript throws — a network
      // blip, a 500 from the provider — the job is still deleted, or the audio
      // and transcript would sit on their side indefinitely. The delete must
      // also finish before the response goes: this used to answer first and
      // delete in a `finally`, and Vercel may freeze the function as soon as
      // the response is sent, leaving the delete never made.
      let turns;
      try {
        turns = await fetchTranscript(key, jobId);
      } catch (err) {
        await deleteJob(key, jobId);
        throw err;
      }
      // A failed delete is logged inside deleteJob (job id and status only)
      // and is not a reason to withhold the transcript: the clinician would
      // lose the consultation and the job would still be there.
      await deleteJob(key, jobId);
      return res.status(200).json({ status: 'done', turns });
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
  return res.status(202).json({ status: 'pending', jobId, ticket });
}

async function fetchTranscript(key, jobId) {
  // The job is DONE here: the transcript exists, and this is the one moment it
  // can be collected. A single transient failure used to fall straight through
  // to the delete in pollToCompletion's `finally`, destroying a transcript that
  // was sitting there finished. Ask a couple more times first. If it never
  // arrives, the delete still follows — zero retention is unchanged.
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(1000);
    let r;
    try {
      r = await fetch(`${API_BASE}/jobs/${jobId}/transcript?format=json-v2`, {
        headers: { Authorization: `Bearer ${key}` }
      });
    } catch (err) {
      lastErr = err;
      continue;
    }
    if (r.ok) return toTurns(await r.json());
    lastErr = new Error(`transcript ${r.status}: ${await shortText(r)}`);
    if (!isTransient(r.status)) break;
  }
  throw lastErr;
}

async function deleteJob(key, jobId) {
  // Cleanup is best effort, but a persistent failure here is a DPIA problem
  // (R4), not a cosmetic one. Worth an alert if it ever shows up in logs.
  //
  // fetch does not throw on an HTTP error, so a 401 or 500 from Speechmatics
  // used to pass as a successful delete: nothing logged, and the Clear route
  // reporting ok. 404 is success — the job is already gone.
  try {
    const r = await fetch(`${API_BASE}/jobs/${jobId}?force=true`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${key}` }
    });
    if (r.ok || r.status === 404) return true;
    console.error('job delete failed:', jobId, `HTTP ${r.status}`);
    return false;
  } catch (err) {
    console.error('job delete failed:', jobId, err && err.message);
    return false;
  }
}

/* ---------- transcript shaping ---------- */

// json-v2 gives a flat list of words and punctuation with a speaker label.
// Collapse to speaker turns, which is what the extraction prompt reads.
//
// A turn also ends at a silence of TURN_SILENCE_S or more, not only at a change
// of speaker. The clinician's goodbye and the dictation that follows it are the
// same voice, so Speechmatics labels them alike, and they used to come back as
// one turn starting before the moment Dictate was pressed. extract.mjs places
// the dictation marker in front of the first turn starting at or after that
// moment, so it landed after the dictation instead: dictated findings read as
// things said to the patient, and nothing said so.
//
// Each turn also carries `words`: where each word starts in the text (`at`, a
// character offset) and in the recording (`start`, seconds). A turn that still
// straddles the Dictate press or a pause can then be split at the right word
// rather than placed wholesale on one side of it.
const TURN_SILENCE_S = 1.5;

function toTurns(payload) {
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const turns = [];
  let current = null;
  let lastWordEnd = null;

  for (const item of results) {
    const alt = item?.alternatives?.[0];
    if (!alt || typeof alt.content !== 'string') continue;

    const speaker = alt.speaker || 'UU';
    const isPunctuation = item.type === 'punctuation';
    const start = Number.isFinite(item.start_time) ? item.start_time : null;
    const silence = !isPunctuation && start !== null && lastWordEnd !== null && start - lastWordEnd >= TURN_SILENCE_S;

    if (!current || (!isPunctuation && (current.speaker !== speaker || silence))) {
      current = { speaker, text: '', start: item.start_time ?? null, end: item.end_time ?? null, words: [] };
      turns.push(current);
    }

    const sep = isPunctuation || current.text === '' ? '' : ' ';
    if (!isPunctuation && start !== null) current.words.push({ at: current.text.length + sep.length, start });
    current.text += sep + alt.content;
    if (item.end_time != null) current.end = item.end_time;
    if (!isPunctuation && Number.isFinite(item.end_time)) lastWordEnd = item.end_time;
  }

  return turns
    .map((t) => {
      const lead = t.text.length - t.text.trimStart().length;
      const text = t.text.trim();
      const words = t.words.map((w) => ({ at: w.at - lead, start: w.start })).filter((w) => w.at >= 0 && w.at < text.length);
      return { speaker: t.speaker, text, start: t.start, end: t.end, words };
    })
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
