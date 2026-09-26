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

import { buildSystemPrompt, buildUserMessage, parseNote, FIELDS, DICTATED_FIELDS, notApplicableFields,
         buildSummarySystemPrompt, parseSummary, buildAskSystemPrompt,
         buildReferralSystemPrompt, buildReferralUserMessage, parseReferral,
         buildPostopSystemPrompt, parsePostop, asText, pauseMarker } from './_prompt.mjs';
import { checklistGaps } from './_checklists.mjs';
import { sessionStillGood } from './_store.mjs';

// 300 s, raised from 120 on 21 September 2026: a long implant or treatment-plan
// consultation on the Full length can take longer than two minutes to draft,
// and the retries below need room. 300 s is the maximum on every Vercel plan
// under Fluid compute, which is the default.
export const config = { maxDuration: 300 };

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
  // When the request arrived, so a retry can tell how much of the 300 s is left.
  const arrivedAt = Date.now();
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // Same as transcribe.mjs: the gate may have let this in on an older copy of
  // the staff list. A disabled colleague's session stops here. (No-op without
  // an account store.)
  if (!(await sessionStillGood(req))) {
    return res.status(401).json({ error: 'unauthenticated' });
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

    // Each pause goes into the transcript the same way, as a line of its own
    // where it fell: the model reads lines, not times. In recording order; at
    // the same point, the pause before the dictation (sort is stable).
    const marks = [
      ...pauses.map((p) => ({ atS: p.atRecordedMs / 1000, line: pauseMarker(p.forMs), dictation: false })),
      ...(dictationFromS !== null ? [{ atS: dictationFromS, line: MARKER, dictation: true }] : [])
    ].sort((a, b) => a.atS - b.atS);
    const markLines = new Set(marks.map((m) => m.line));
    let next = 0;               // the first marker not yet placed
    let dictationInexact = false;

    const hasWords = (s) => /[\p{L}\p{N}]/u.test(s);
    const lines = [];
    let sawTimes = false;
    for (const t of turns) {
      const text = String(t.text || '').trim();
      // Skip only turns with nothing in them. A length cut-off (this was once
      // "<= 5 characters") silently removed "Yes.", "No.", "Okay." and "Sure."
      // — in a consent discussion, very often the patient's actual answer. A
      // dropped "No." reads to the model as the clinician carrying straight on.
      if (!hasWords(text)) continue;
      const speaker = t.speaker || 'UU';
      const start = Number.isFinite(t.start) ? t.start : null;
      const end = Number.isFinite(t.end) ? t.end : null;
      if (start !== null) sawTimes = true;
      while (next < marks.length && start !== null && start >= marks[next].atS) lines.push(marks[next++].line);

      // A marker that falls INSIDE this turn: speech runs on across the Dictate
      // press or the pause. Split the turn at the first word starting at or
      // after it, where the word timings came with the turn. Without them, the
      // marker goes in front of the whole turn: for the dictation that is the
      // side that never presents dictated findings as said to the patient, and
      // it is said in the gaps, because it can move the end of the
      // conversation along with it.
      const words = wordStarts(t.words, text);
      let from = 0;
      while (next < marks.length && start !== null && end !== null && marks[next].atS < end) {
        const m = marks[next];
        if (words) {
          const w = words.find((x) => x.at >= from && x.start >= m.atS);
          if (!w) break;   // every word left began before it: it goes before the next turn
          const head = text.slice(from, w.at).trim();
          if (hasWords(head)) lines.push(`[${speaker}] ${head}`);
          from = w.at;
        } else if (m.dictation) {
          dictationInexact = true;
        }
        lines.push(m.line);
        next++;
      }
      const rest = text.slice(from).trim();
      if (hasWords(rest)) lines.push(`[${speaker}] ${rest}`);
    }
    // Dictate pressed, or a pause taken, after every turn had started (e.g. no
    // speech after): still say so, so the model does not look for dictation
    // that is not there.
    if (sawTimes) while (next < marks.length) lines.push(marks[next++].line);
    const dictationLocated = dictationFromS === null || sawTimes;
    const transcript = lines.join('\n');

    if (!transcript || lines.every((l) => markLines.has(l))) return res.status(400).json({ error: 'empty_transcript' });

    // A speaker mapping the clinician corrected by hand. Untrusted input:
    // labels and roles are both whitelisted, and a mapping that survives that
    // is passed through verbatim. Every product takes it, not only the note:
    // a summary that puts the patient's words in the dentist's mouth is the
    // same error on a page the patient takes home.
    const rawRoles = body?.speakerRoles;
    const speakerRoles = {};
    if (rawRoles && typeof rawRoles === 'object' && !Array.isArray(rawRoles)) {
      for (const [k, v] of Object.entries(rawRoles)) {
        if (/^S\d{1,2}$/.test(k) && (v === 'clinician' || v === 'patient' || v === 'other')) {
          speakerRoles[k] = v;
        }
      }
    }
    const roles = Object.keys(speakerRoles).length ? speakerRoles : null;

    // A question about this consultation, answered from the transcript only.
    if (body?.kind === 'ask') {
      const question = typeof body?.question === 'string' ? body.question.trim().slice(0, 500) : '';
      if (!question) return res.status(400).json({ error: 'empty_question' });
      const raw = await invokeModel({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 1024,
        temperature: 0,
        system: buildAskSystemPrompt(consultType),
        messages: [{ role: 'user', content: `${buildUserMessage(transcript, pauses, roles, { note: false, json: false })}\n\nThe dentist asks: ${question}` }]
      }, creds, arrivedAt);
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
        messages: [{ role: 'user', content: buildUserMessage(transcript, pauses, roles, { note: false }) }]
      }, creds, arrivedAt);
      if (raw?.stop_reason === 'max_tokens') {
        return res.status(502).json({ error: 'response_truncated', detail: 'The summary was cut off. Try again.' });
      }
      const text = (raw?.content || []).filter((b) => b && b.type === 'text').map((b) => b.text).join('');
      return res.status(200).json({ status: 'done', summary: parseSummary(text) });
    }

    // The sheet the surgical patient takes home. Built from the corrected note
    // like the referral, and for the same reason: the clinician has already
    // checked it, so the instructions inherit checked content.
    if (body?.kind === 'postop') {
      const incoming = body?.note && typeof body.note === 'object' && !Array.isArray(body.note) ? body.note : {};
      const note = {};
      for (const [key] of [...FIELDS, ...DICTATED_FIELDS]) {
        const v = incoming[key];
        if (typeof v === 'string' && v.trim()) note[key] = v.trim().slice(0, 4000);
      }
      if (!Object.keys(note).length) {
        return res.status(400).json({ error: 'empty_postop_source', detail: 'Draft the note first — the instructions are built from it.' });
      }
      const raw = await invokeModel({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 2048,
        temperature: 0,
        system: buildPostopSystemPrompt(consultType),
        messages: [{ role: 'user', content: buildReferralUserMessage(note, '', buildUserMessage(transcript, pauses, roles, { note: false })) }]
      }, creds, arrivedAt);
      if (raw?.stop_reason === 'max_tokens') {
        return res.status(502).json({ error: 'response_truncated', detail: 'The instructions were cut off. Try again.' });
      }
      const text = (raw?.content || []).filter((b) => b && b.type === 'text').map((b) => b.text).join('');
      return res.status(200).json({ status: 'done', postop: parsePostop(text) });
    }

    // A third product, and the only one built from the CORRECTED note rather
    // than from the transcript alone: the clinician has already read and fixed
    // the note, so the referral inherits checked content instead of re-deriving
    // it from raw speech. Carries no patient identifiers — the referral form
    // already has them, and keeping them out of here is what the DPIA rests on.
    if (body?.kind === 'referral') {
      // The note arrives from the browser, so it is untrusted input: take only
      // the known field keys, only as strings, and cap the length.
      const incoming = body?.note && typeof body.note === 'object' && !Array.isArray(body.note) ? body.note : {};
      const note = {};
      for (const [key] of [...FIELDS, ...DICTATED_FIELDS]) {
        const v = incoming[key];
        if (typeof v === 'string' && v.trim()) note[key] = v.trim().slice(0, 4000);
      }
      const context = typeof body?.context === 'string' ? body.context.trim().slice(0, 2000) : '';
      if (!Object.keys(note).length && !context) {
        return res.status(400).json({ error: 'empty_referral_source', detail: 'Draft the note first — the referral is built from it.' });
      }
      const raw = await invokeModel({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 2048,
        temperature: 0,
        system: buildReferralSystemPrompt(consultType),
        messages: [{ role: 'user', content: buildReferralUserMessage(note, context, buildUserMessage(transcript, pauses, roles, { note: false })) }]
      }, creds, arrivedAt);
      if (raw?.stop_reason === 'max_tokens') {
        return res.status(502).json({ error: 'response_truncated', detail: 'The referral was cut off. Try again.' });
      }
      const text = (raw?.content || []).filter((b) => b && b.type === 'text').map((b) => b.text).join('');
      return res.status(200).json({ status: 'done', referral: parseReferral(text) });
    }

    const payload = {
      anthropic_version: 'bedrock-2023-05-31',
      // Raised from 4096 when the checklist, dictated fields and implant log
      // were added to the response shape, and from 8192 to 16000 on
      // 21 September 2026 for long consultations on the Full length. A
      // truncated draft is thrown away whole, so the headroom is worth more
      // than the tokens: they are only spent when the note is that long.
      max_tokens: 16000,
      temperature: 0,
      system: buildSystemPrompt(consultType, length),
      messages: [{ role: 'user', content: buildUserMessage(transcript, pauses, roles) }]
    };

    const raw = await invokeModel(payload, creds, arrivedAt);

    if (raw?.stop_reason === 'max_tokens') {
      return res.status(502).json({
        error: 'response_truncated',
        detail: 'The note came out longer than the limit and was cut off, so nothing was kept. Choose Brief under note length and press Try drafting again.'
      });
    }

    const text = (raw?.content || [])
      .filter((block) => block && block.type === 'text')
      .map((block) => block.text)
      .join('');

    const note = parseNote(text, consultType); // throws on malformed output
    assertShape(note, consultType); // and on output of the wrong shape

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
    } else if (dictationInexact) {
      note.gaps.unshift('You pressed Dictate part-way through a stretch of speech, so the start of the ' +
        'dictated part could not be placed exactly. Check that nothing said to the patient has been ' +
        'treated as dictated, and nothing dictated as said to the patient.');
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

/* asText lays out a list or an object of strings as text; see _prompt.mjs. */
function assertShape(note, consultType) {
  // The same fields parseNote leaves out of its blank check. A recall's
  // `risks: []` is not a risk left blank, it is a field that does not apply;
  // listing it told the clinician to check for something that was never due.
  const skip = new Set(notApplicableFields(consultType));
  for (const [key, label] of [...FIELDS, ...DICTATED_FIELDS]) {
    const v = note[key];
    if (v === null || v === undefined) continue;
    if (typeof v === 'string') continue;
    const laid = asText(v);
    if (laid === undefined) {
      throw new Error(`Field "${key}" (${label}) came back as ${Array.isArray(v) ? 'an array' : typeof v}, not text`);
    }
    note[key] = laid;
    // Laid out as nothing (an empty list, say): blank, so it must be listed.
    if (laid === null && !skip.has(key)) note.gaps.push(`${label}: left blank in the draft; check whether it came up`);
  }
  if (!Array.isArray(note.gaps)) throw new Error('gaps is not an array');
  note.gaps = note.gaps.map((g) => {
    if (typeof g === 'string') return g;
    const laid = asText(g);
    if (typeof laid === 'string') return laid.replace(/\n/g, '; ');
    throw new Error(`A gap came back as ${typeof g}, not text`);
  });
}

/* ---------- Bedrock ---------- */

async function invokeModel(payload, creds, arrivedAt = Date.now()) {
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

  // A busy or briefly unavailable service used to fail the draft outright, and
  // the clinician had to press Try drafting again. Now it is retried here: up
  // to two more attempts, 2 s then 6 s apart, and only for the answers that
  // mean "try again" (throttled, 5xx, or no answer at all). A refusal about the
  // request itself (4xx other than 429) is not retried: it would fail the same
  // way. Each attempt is signed afresh, because the signature carries the time.
  //
  // But only while there is time for the retry to finish. A long draft that
  // failed at 250 s used to be retried anyway; Vercel killed the function at
  // 300 s, and the page got a bare 504 with no JSON in place of the real error.
  // After RETRY_CUTOFF_MS the first failure is reported as it is: a full draft
  // can take a couple of minutes, and 120 s plus a wait still leaves that.
  const RETRY = new Set([429, 500, 502, 503, 504]);
  const waits = [2000, 6000];
  const RETRY_CUTOFF_MS = 120_000;
  const timeToRetry = (attempt) =>
    attempt < waits.length && Date.now() - arrivedAt + waits[attempt] <= RETRY_CUTOFF_MS;
  let r;
  for (let attempt = 0; ; attempt++) {
    const h = attempt === 0 ? headers : await signRequest({
      method: 'POST', host, path: canonicalPath, body: bodyText, region: REGION, service: SERVICE, creds,
      extraHeaders: { 'content-type': 'application/json', accept: 'application/json' }
    });
    try {
      r = await fetch(`https://${host}${wirePath}`, { method: 'POST', headers: h, body: bodyText });
    } catch (e) {
      if (timeToRetry(attempt)) { await sleep(waits[attempt]); continue; }
      throw new Error('Could not reach the drafting service: ' + String((e && e.message) || e).slice(0, 200));
    }
    if (r.ok || !RETRY.has(r.status) || !timeToRetry(attempt)) break;
    console.warn('extract: bedrock', r.status, '- retrying');
    await sleep(waits[attempt]);
  }
  if (!r.ok) {
    // Generous limit on purpose. On a signature mismatch AWS returns the exact
    // canonical string it expected, which is the fastest way to find the
    // difference — and truncating at 300 characters threw that away twice.
    //
    // But that canonical string carries the x-amz-security-token header, and
    // this body used to go back to the browser whole, and into the log. It now
    // goes only to the log, with anything that looks like a credential
    // redacted; the page is told the status and nothing else.
    const detail = (await r.text().catch(() => '')).slice(0, 1500);
    console.error(`extract: bedrock ${r.status}:`, redactCredentials(detail));
    throw new Error(`bedrock ${r.status}: the drafting service returned an error`);
  }
  return r.json();
}

// The session token's value, the access key id in a Credential= scope, a
// Signature=, and any bare AWS access key id. The shape of the request stays
// readable; the secrets do not.
export function redactCredentials(text) {
  return String(text)
    .replace(/(x-amz-security-token\s*[:=]\s*)[^\s'",;&]+/gi, '$1[redacted]')
    .replace(/(Credential=)[^\s'",;&]+/gi, '$1[redacted]')
    .replace(/(Signature=)[^\s'",;&]+/gi, '$1[redacted]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{12,}\b/g, '[redacted]');
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

// Word timings from transcribe.mjs, where the turn carries them. From the
// browser, so untrusted: only offsets inside this turn's text, with a time.
function wordStarts(words, text) {
  if (!Array.isArray(words)) return null;
  const out = words.filter((w) => w && Number.isInteger(w.at) && w.at >= 0 && w.at < text.length && Number.isFinite(w.start));
  return out.length ? out : null;
}

// Overridable so the tests do not wait for real seconds.
export const _retry = { sleepMs: null };
const sleep = (ms) => new Promise((res) => setTimeout(res, _retry.sleepMs === null ? ms : _retry.sleepMs));

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
