// api/extract.mjs
//
// Diarised transcript in, structured draft note out.
//
// Shape and validation come from _prompt.mjs — buildSystemPrompt, buildUserMessage
// and parseNote. This file signs the request and gets out of the way. parseNote
// throws on malformed or incomplete output, and that throw is deliberately not
// caught into a partial note: a visible failure is safer than a note with fields
// quietly missing.
//
// SigV4 is signed by hand with Web Crypto rather than pulling in the AWS SDK. The
// repo has no package.json and no build step; adding one to a working static
// deploy is a bigger change than sixty lines of signing code.
//
// DATA RESIDENCY — enforced, not documented.
//
// Bedrock will not do UK-only for Claude. eu-west-2 (London) offers Global and
// EU endpoint types but is not an "in-region only" region, and every current
// Claude model requires an inference profile prefix — a bare model id returns
// HTTP 400 "on-demand throughput isn't supported". So the narrowest available
// footprint is the EU, via the eu. prefix, which UK adequacy covers.
//
// DATA_RESIDENCY encodes the DPIA decision in code so it cannot drift. Changing
// the model id later to a global. or us. profile would silently widen the
// processing footprint and invalidate DPIA section 2.7; this refuses instead.
// Fails closed: an unrecognised combination is rejected before any request is
// signed, not after.

import { buildSystemPrompt, buildUserMessage, parseNote, FIELDS, DICTATED_FIELDS,
         buildSummarySystemPrompt, parseSummary, buildAskSystemPrompt } from './_prompt.mjs';
import { checklistGaps } from './_checklists.mjs';

export const config = { maxDuration: 120 };

const REGION = process.env.AWS_REGION || 'eu-west-2';
const MODEL_ID = process.env.BEDROCK_MODEL_ID || 'eu.anthropic.claude-sonnet-4-5-20250929-v1:0';
const SERVICE = 'bedrock';
const MAX_TURNS = 4000;
const RESIDENCY = (process.env.DATA_RESIDENCY || 'eu').toLowerCase();

// Regions in which a request submitted to Bedrock stays within UK/EEA territory.
const EEA_UK_REGIONS = new Set([
  'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1', 'eu-central-2',
  'eu-north-1', 'eu-south-1', 'eu-south-2'
]);

/**
 * Returns null if the configuration matches the declared residency policy, or a
 * plain-English reason if it does not.
 */
export function checkResidency(modelId, region, policy) {
  const prefix = (String(modelId).match(/^(global|us|eu|jp|apac|au|in)\./) || [])[1] || null;

  if (!EEA_UK_REGIONS.has(region)) {
    return `AWS_REGION is "${region}", which is outside the UK and EEA. The DPIA declares ${policy.toUpperCase()} processing.`;
  }

  if (policy === 'uk') {
    // Deliberately unsatisfiable with any current Claude model, and that is the
    // point: it surfaces the constraint rather than quietly doing something else.
    if (prefix) {
      return `DATA_RESIDENCY=uk, but "${modelId}" is a "${prefix}." inference profile, which routes across a geography rather than staying in one country. ` +
             `Bedrock does not currently offer UK-only routing for Claude: eu-west-2 is not an in-region-only region, and every current model requires a profile prefix. ` +
             `Either set DATA_RESIDENCY=eu and record "UK and EU" in DPIA 2.7, or move the extraction step to a provider that can guarantee UK residency.`;
    }
    return null; // a bare id in eu-west-2 would be UK-only — Bedrock will reject it separately
  }

  if (policy === 'eu') {
    if (prefix === 'eu') return null;
    if (!prefix) return null; // bare id, single region, narrower than declared
    return `DATA_RESIDENCY=eu, but "${modelId}" is a "${prefix}." profile. ` +
           `Only the "eu." profile keeps processing within the EEA. A global. or us. profile would place patient audio outside the adequacy area and would need an IDTA plus a Transfer Risk Assessment.`;
  }

  return `DATA_RESIDENCY is "${policy}". Expected "uk" or "eu".`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const creds = {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    sessionToken: process.env.AWS_SESSION_TOKEN || null
  };
  if (!creds.accessKeyId || !creds.secretAccessKey) {
    console.error('extract: AWS credentials not set');
    return res.status(500).json({ error: 'server_misconfigured' });
  }

  const residencyProblem = checkResidency(MODEL_ID, REGION, RESIDENCY);
  if (residencyProblem) {
    // Refuse before signing anything. Patient audio must not leave the declared
    // territory because a configuration value was changed without the DPIA.
    console.error('extract: residency policy violation —', residencyProblem);
    return res.status(500).json({ error: 'residency_policy_violation', detail: residencyProblem });
  }

  try {
    const body = await readJson(req);
    const turns = Array.isArray(body?.turns) ? body.turns.slice(0, MAX_TURNS) : null;
    const consultType = typeof body?.consultType === 'string' ? body.consultType : null;
    // How much to write. Anything unrecognised falls back to standard in the
    // prompt builder, so a bad value cannot fail a draft.
    const length = typeof body?.length === 'string' ? body.length : 'standard';
    // Where the clinician paused. Shapes the prompt so the note cannot assert a
    // sequence across unrecorded time. Bounded and sanitised like everything else.
    const pauses = Array.isArray(body?.pauses)
      ? body.pauses
          .filter((p) => p && Number.isFinite(p.forMs) && Number.isFinite(p.atRecordedMs) && p.forMs > 1000)
          .slice(0, 20)
          .map((p) => ({ atRecordedMs: Math.max(0, p.atRecordedMs), forMs: Math.max(0, p.forMs) }))
      : [];

    if (!turns || turns.length === 0) {
      return res.status(400).json({ error: 'empty_transcript' });
    }

    // Where the clinician pressed Dictate, in seconds into the RECORDING. The
    // file's timeline is recorded time (paused time does not exist in it), and
    // Speechmatics gives each turn a start time on that same timeline, so the
    // marker goes in front of the first turn that starts at or after it.
    const dictationFromS = Number.isFinite(body?.dictationFromS) && body.dictationFromS >= 0
      ? Number(body.dictationFromS) : null;
    const MARKER = '[DICTATION \u2014 the clinician alone, after the patient left. Everything below is dictated to the record, not conversation.]';
    let markerPlaced = false;

    const lines = [];
    let sawTimes = false;
    for (const t of turns) {
      const text = String(t.text || '').trim();
      if (text.length <= 5) continue;
      if (Number.isFinite(t.start)) sawTimes = true;
      if (dictationFromS !== null && !markerPlaced && Number.isFinite(t.start) && t.start >= dictationFromS) {
        lines.push(MARKER);
        markerPlaced = true;
      }
      lines.push(`[${t.speaker || 'UU'}] ${text}`);
    }
    // Dictate pressed but every turn started before it (e.g. no speech after):
    // still say so, so the model does not look for dictation that is not there.
    if (dictationFromS !== null && !markerPlaced && sawTimes) lines.push(MARKER);
    const dictationLocated = dictationFromS === null || markerPlaced || sawTimes;
    const transcript = lines.join('\n');

    if (!transcript || lines.every((l) => l === MARKER)) return res.status(400).json({ error: 'empty_transcript' });

    // A question about this consultation, answered from the transcript only.
    if (body?.kind === 'ask') {
      const question = typeof body?.question === 'string' ? body.question.trim().slice(0, 500) : '';
      if (!question) return res.status(400).json({ error: 'empty_question' });
      const raw = await invokeModel({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 1024,
        temperature: 0,
        system: buildAskSystemPrompt(consultType),
        messages: [{ role: 'user', content: `${buildUserMessage(transcript, pauses)}\n\nThe dentist asks: ${question}` }]
      }, creds);
      if (raw?.stop_reason === 'max_tokens') {
        return res.status(502).json({ error: 'response_truncated', detail: 'The answer was cut off. Ask something narrower.' });
      }
      const answer = (raw?.content || []).filter((b) => b && b.type === 'text').map((b) => b.text).join('').trim();
      if (!answer) return res.status(502).json({ error: 'empty_answer', detail: 'No answer came back.' });
      return res.status(200).json({ status: 'done', answer });
    }

    // A second product from the same transcript: the take-home summary for the
    // patient. Same processor, same rules; no new data goes anywhere.
    if (body?.kind === 'summary') {
      const raw = await invokeModel({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 2048,
        temperature: 0,
        system: buildSummarySystemPrompt(consultType),
        messages: [{ role: 'user', content: buildUserMessage(transcript, pauses) }]
      }, creds);
      if (raw?.stop_reason === 'max_tokens') {
        return res.status(502).json({ error: 'response_truncated', detail: 'The summary was cut off. Try again.' });
      }
      const text = (raw?.content || []).filter((b) => b && b.type === 'text').map((b) => b.text).join('');
      return res.status(200).json({ status: 'done', summary: parseSummary(text) });
    }

    const payload = {
      anthropic_version: 'bedrock-2023-05-31',
      // Raised from 4096 when the checklist, dictated fields and implant log
      // were added to the response shape. A truncated draft is thrown away
      // whole, so the headroom is worth more than the tokens.
      max_tokens: 8192,
      temperature: 0,
      system: buildSystemPrompt(consultType, length),
      messages: [{ role: 'user', content: buildUserMessage(transcript, pauses) }]
    };

    const raw = await invokeModel(payload, creds);

    if (raw?.stop_reason === 'max_tokens') {
      return res.status(502).json({
        error: 'response_truncated',
        detail: 'The draft exceeded the token limit and was cut off. Nothing kept — record again, or raise max_tokens.'
      });
    }

    const text = (raw?.content || [])
      .filter((block) => block && block.type === 'text')
      .map((block) => block.text)
      .join('');

    const note = parseNote(text); // throws on malformed output
    assertShape(note);            // and on output of the wrong shape

    // The procedure checklist. The model reported what it FOUND; the wording
    // of what it did not find is the clinician's, from _checklists.mjs, so no
    // gap text is ever the model's invention. Appended after the model's own
    // gaps, deduplicated.
    // Kept separate from the model's own gaps. They mean different things: a
    // model gap is "the transcript did not tell me"; a checklist gap is "you
    // did not say this". Merging them into one list would attach the wrong
    // instruction to the wrong kind of gap — see the two leads on the page.
    note.notSaid = checklistGaps(consultType, note.checklist);
    delete note.checklist;        // internal; the gaps are the product

    // Dictation was requested but the transcript carried no timings, so the
    // split between conversation and dictation could not be made. Say so
    // loudly: the alternative is a note that presents dictated findings as
    // things said to the patient.
    if (dictationFromS !== null && !dictationLocated) {
      note.gaps.unshift('You pressed Dictate, but the transcript came back without timings, so the ' +
        'dictated part could not be separated from the conversation. Check that nothing you dictated ' +
        'has been recorded as if it were said to the patient.');
    }

    return res.status(200).json({ status: 'done', note });
  } catch (err) {
    // Never log payloads — R11. Message only.
    console.error('extract failed:', err && err.message);
    return res.status(502).json({
      error: 'extraction_failed',
      detail: String((err && err.message) || 'unknown error').slice(0, 1600)
    });
  }
}

/**
 * parseNote checks that every field is PRESENT. This checks that every field is
 * the right TYPE, which is a different failure and a worse one.
 *
 * A field returned as an object passes parseNote, renders as "[object Object]",
 * and — because it is not null — is not reported as a gap. So {"text": "nerve
 * injury"} in the risks field means a risk that was genuinely discussed vanishes
 * from the note while the note reports itself complete. Silent content loss in a
 * field a complaint would turn on.
 *
 * Rejecting rather than coercing, deliberately. Joining an array or stringifying
 * an object would be inventing structure the model did not produce, which is the
 * one thing this tool must not do. A visible failure is the correct outcome.
 */
function assertShape(note) {
  for (const [key, label] of [...FIELDS, ...DICTATED_FIELDS]) {
    const v = note[key];
    if (v === null || v === undefined) continue;
    if (typeof v !== 'string') {
      throw new Error(`Field "${key}" (${label}) came back as ${Array.isArray(v) ? 'an array' : typeof v}, not text`);
    }
  }
  if (!Array.isArray(note.gaps)) throw new Error('gaps is not an array');
  for (const g of note.gaps) {
    if (typeof g !== 'string') throw new Error(`A gap came back as ${typeof g}, not text`);
  }
}

/* ---------- Bedrock ---------- */

async function invokeModel(payload, creds) {
  const host = `bedrock-runtime.${REGION}.amazonaws.com`;

  // TWO different paths, deliberately. This is the whole subtlety of SigV4 here.
  //
  // The canonical string's path must be the ESCAPED FORM of the path actually
  // sent — escaped, not identical. So the request goes out with a raw colon and
  // the signature is computed over the percent-encoded version.
  //
  // Confirmed against what Bedrock itself returns on a mismatch:
  //   The Canonical String for this request should have been
  //   'POST
  //   /model/eu.anthropic.claude-sonnet-4-5-20250929-v1%3A0/invoke
  //
  // Getting this wrong is silent until a model id contains a colon. Claude 5
  // ids (eu.anthropic.claude-opus-5) have no special characters, so encoding was
  // a no-op and any of the three variants appeared to work. The dated ids on
  // earlier models (…-v1:0) are what expose it.
  //
  // Both of the obvious wrong answers fail:
  //   send %3A, sign %3A  -> AWS receives %3A, escapes again, expects %253A
  //   send :,    sign :    -> AWS escapes to %3A, we signed :
  const wirePath = `/model/${MODEL_ID}/invoke`;
  const canonicalPath = `/model/${encodeURIComponent(MODEL_ID)}/invoke`;
  const bodyText = JSON.stringify(payload);

  const headers = await signRequest({
    method: 'POST',
    host,
    path: canonicalPath,
    body: bodyText,
    region: REGION,
    service: SERVICE,
    creds,
    extraHeaders: { 'content-type': 'application/json', accept: 'application/json' }
  });

  const r = await fetch(`https://${host}${wirePath}`, { method: 'POST', headers, body: bodyText });
  if (!r.ok) {
    // Generous limit on purpose. On a signature mismatch AWS returns the exact
    // canonical string it expected, which is the fastest way to find the
    // difference — and truncating at 300 characters threw that away twice.
    const detail = (await r.text().catch(() => '')).slice(0, 1500);
    throw new Error(`bedrock ${r.status}: ${detail}`);
  }
  return r.json();
}

/* ---------- SigV4 ---------- */

const encoder = new TextEncoder();

async function sha256Hex(input) {
  const data = typeof input === 'string' ? encoder.encode(input) : input;
  return hex(await crypto.subtle.digest('SHA-256', data));
}

async function hmac(keyBytes, message) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

function hex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function signRequest({ method, host, path, body, region, service, creds, extraHeaders }) {
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = await sha256Hex(body);

  const headers = {
    ...extraHeaders,
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate
  };
  if (creds.sessionToken) headers['x-amz-security-token'] = creds.sessionToken;

  const signedKeys = Object.keys(headers).map((k) => k.toLowerCase()).sort();
  const canonicalHeaders = signedKeys
    .map((k) => `${k}:${String(headers[k]).trim().replace(/\s+/g, ' ')}\n`)
    .join('');
  const signedHeaders = signedKeys.join(';');

  const canonicalRequest = [
    method,
    path,             // the ESCAPED form of the path being sent — see invokeModel
    '',               // no query string
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    await sha256Hex(canonicalRequest)
  ].join('\n');

  const kDate = await hmac(encoder.encode(`AWS4${creds.secretAccessKey}`), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, 'aws4_request');
  const signature = hex(await hmac(kSigning, stringToSign));

  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  delete headers.host; // fetch sets this itself and rejects an explicit one
  return headers;
}

/* ---------- helpers ---------- */

async function readJson(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  // Already parsed to a string by the platform; the stream is spent.
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(text); } catch { return null; }
}
