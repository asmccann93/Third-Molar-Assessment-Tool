// api/_session.mjs
//
// Signed session tokens, shared by middleware.js (Edge runtime) and api/auth.mjs
// (Node runtime). Uses only Web Crypto and TextEncoder so the same code runs in
// both. Underscore prefix keeps it off the route table, same convention as
// _prompt.mjs.
//
// The cookie is NOT a boolean flag. It carries an expiry and an HMAC over that
// expiry, so it cannot be forged by anyone who does not hold SESSION_SECRET.

const enc = new TextEncoder();

export const COOKIE_NAME = 'ai_notes_session';
export const DEFAULT_TTL_SECONDS = 60 * 60 * 12; // 12 hours — one clinical day

function toHex(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

async function importKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

async function sign(secret, payload) {
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return toHex(sig);
}

// Length-independent, content-constant-time comparison of two hex strings.
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Token formats:
//   v1.<exp>.<hexHmac>                  one shared passcode, nobody identified
//   v2.<exp>.<who>.<hexHmac>            per-user passcode; <who> identifies the holder
//   v3.<exp>.<who>.<epoch>.<hexHmac>    staff account (email and password)
//
// v1 is still accepted, deliberately. A token format change that rejected live
// cookies would end every session the moment it deployed, and somebody would be
// halfway through a consent discussion when it did. v1 sessions simply have no
// identity and expire on their own within the day.
//
// This file only says whether a token is GENUINE. Whether it is still GOOD —
// whether v1/v2 are still honoured, whether a v3 holder's account is active and
// its epoch current — is decided in _store.mjs, which knows about the accounts.
// Call resolveSession there, not readToken here, to let someone in.
//
// v3 carries the account's epoch. The admin page bumps the epoch when it
// disables someone or issues them a new setup link, and every session minted
// under the old number stops working, without anything having to remember
// which sessions exist.
const WHO_RE = /^[A-Za-z0-9_-]{1,16}$/;
// Up to 15 digits: epochs are random and large (so a deleted account's old
// cookie cannot line up with a new account given the same initials), and
// still exact as a JavaScript number.
const EPOCH_RE = /^(0|[1-9][0-9]{0,14})$/;

export async function mintToken(secret, ttlSeconds = DEFAULT_TTL_SECONDS, who = null, epoch = null) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  // An account session that cannot carry its epoch must not quietly become a
  // passcode-era (v2) one: v2 is honoured by different rules. Refuse instead.
  if (epoch !== null && epoch !== undefined) {
    if (!who || !WHO_RE.test(who) || !Number.isSafeInteger(epoch) || !EPOCH_RE.test(String(epoch))) {
      throw new Error('mintToken: epoch or initials out of range for an account session');
    }
    const payload = `v3.${exp}.${who}.${epoch}`;
    return `${payload}.${await sign(secret, payload)}`;
  }
  if (who && WHO_RE.test(who)) {
    const payload = `v2.${exp}.${who}`;
    return `${payload}.${await sign(secret, payload)}`;
  }
  const payload = `v1.${exp}`;
  return `${payload}.${await sign(secret, payload)}`;
}

export async function verifyToken(secret, token) {
  return !!(await readToken(secret, token));
}

// Returns { v, exp, who, epoch } for a genuine token, or null. `who` is null
// for v1; `epoch` is null for v1 and v2.
export async function readToken(secret, token) {
  if (!secret || !token) return null;
  const parts = String(token).split('.');

  if (parts[0] === 'v3' && parts.length === 5) {
    const [, expRaw, who, epochRaw, sig] = parts;
    const exp = Number(expRaw);
    if (!Number.isFinite(exp)) return null;
    if (!WHO_RE.test(who) || !EPOCH_RE.test(epochRaw)) return null;
    if (Math.floor(Date.now() / 1000) >= exp) return null;
    if (!safeEqual(sig, await sign(secret, `v3.${expRaw}.${who}.${epochRaw}`))) return null;
    return { v: 3, exp, who, epoch: Number(epochRaw) };
  }

  if (parts[0] === 'v1' && parts.length === 3) {
    const [, expRaw, sig] = parts;
    const exp = Number(expRaw);
    if (!Number.isFinite(exp)) return null;
    if (Math.floor(Date.now() / 1000) >= exp) return null;
    if (!safeEqual(sig, await sign(secret, `v1.${expRaw}`))) return null;
    return { v: 1, exp, who: null, epoch: null };
  }

  if (parts[0] === 'v2' && parts.length === 4) {
    const [, expRaw, who, sig] = parts;
    const exp = Number(expRaw);
    if (!Number.isFinite(exp)) return null;
    if (!WHO_RE.test(who)) return null;
    if (Math.floor(Date.now() / 1000) >= exp) return null;
    if (!safeEqual(sig, await sign(secret, `v2.${expRaw}.${who}`))) return null;
    return { v: 2, exp, who, epoch: null };
  }

  return null;
}

/* A transcription job belongs to the session that submitted it.
   There is nowhere to record that — nothing is stored — so the binding is
   signed instead: the job ticket is an HMAC over the job id and the holder.
   Without it any valid cookie can fetch any transcript given its id, which
   with one user is invisible and with a team is a consent discussion handed
   to the wrong clinician. */
export async function mintJobTicket(secret, jobId, who) {
  return sign(secret, `job.${jobId}.${who || '-'}`);
}

export async function verifyJobTicket(secret, jobId, who, ticket) {
  if (!secret || !jobId || !ticket) return false;
  return safeEqual(String(ticket), await mintJobTicket(secret, jobId, who));
}

// Seconds remaining on a token, or 0 if absent, malformed or expired. Does NOT
// verify the signature — call verifyToken for that. This is only for telling the
// clinician how long they have left.
export function secondsRemaining(token) {
  if (!token) return 0;
  const parts = String(token).split('.');
  if (!(parts.length === 3 && parts[0] === 'v1') && !(parts.length === 4 && parts[0] === 'v2') &&
      !(parts.length === 5 && parts[0] === 'v3')) return 0;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp)) return 0;
  return Math.max(0, exp - Math.floor(Date.now() / 1000));
}

export function buildCookie(token, ttlSeconds = DEFAULT_TTL_SECONDS) {
  return [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    `Max-Age=${ttlSeconds}`
  ].join('; ');
}

export function clearCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export function readCookie(cookieHeader, name = COOKIE_NAME) {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}
