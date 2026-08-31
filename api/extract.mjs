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

import { buildSystemPrompt, buildUserMessage, parseNote, FIELDS } from './_prompt.mjs';

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

    if (!turns || turns.length === 0) {
      return res.status(400).json({ error: 'empty_transcript' });
    }

    const transcript = turns
      .map((t) => `[${t.speaker || 'UU'}] ${String(t.text || '').trim()}`)
      .filter((line) => line.trim().length > 5)
      .join('\n');

    if (!transcript) return res.status(400).json({ error: 'empty_transcript' });

    const payload = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 4096,
      temperature: 0,
      system: buildSystemPrompt(consultType),
      messages: [{ role: 'user', content: buildUserMessage(transcript) }]
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
  for (const [key, label] of FIELDS) {
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

  // The model id goes into the path RAW, not percent-encoded.
  //
  // SigV4 requires the canonical string's path to be the escaped form of the
  // path actually sent. Model ids contain only alphanumerics, dots, hyphens and
  // colons, and a colon needs no escaping inside a path segment (RFC 3986 pchar
  // includes ':'). So encoding it to %3A signs one thing while fetch normalises
  // the URL and sends another — the signature then cannot match.
  //
  // This was invisible until now: the Claude 5 ids have no special characters,
  // so encodeURIComponent was a no-op and canonical == wire by accident. The
  // dated ids on earlier models (…-v1:0) are what exposed it.
  const path = `/model/${MODEL_ID}/invoke`;
  const bodyText = JSON.stringify(payload);

  const headers = await signRequest({
    method: 'POST',
    host,
    path,
    body: bodyText,
    region: REGION,
    service: SERVICE,
    creds,
    extraHeaders: { 'content-type': 'application/json', accept: 'application/json' }
  });

  const r = await fetch(`https://${host}${path}`, { method: 'POST', headers, body: bodyText });
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
    path,             // already encoded, and identical to the URL actually fetched
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
