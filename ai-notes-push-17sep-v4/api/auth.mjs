// api/auth.mjs
//
// Passcode in, httpOnly cookie out. Single user — deliberately not over-built.
//
// The throttle below is per warm instance, so it is not a real rate limiter:
// serverless spreads attempts across instances. It is enough to make scripted
// guessing tedious, and the passcode should be long enough that guessing is not
// the threat model. Use a passphrase, not four digits.

import {
  mintToken, buildCookie, clearCookie, safeEqual, readToken,
  readCookie, secondsRemaining, DEFAULT_TTL_SECONDS
} from './_session.mjs';

const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 8;
const attempts = []; // timestamps, this instance only

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  // Session status. Open like the rest of this route, and deliberately says
  // nothing an unauthenticated caller could not already work out: whether the
  // cookie they are holding is good, and for how long.
  //
  // This exists because a twelve-hour session can lapse between pressing Stop
  // and the transcript coming back, and the recording is held only in memory.
  // Losing a consent conversation to an expired cookie would be indefensible,
  // so the page checks before it starts rather than discovering it afterwards.
  if (req.method === 'GET') {
    const secret = process.env.SESSION_SECRET;
    const token = readCookie(req.headers.cookie);
    const claims = secret ? await readToken(secret, token) : null;
    // `who` rides along with the check the page already makes. Three clinicians
    // sharing a surgery computer need to see whose session is open before they
    // start, or the second one records under the first one's identity and
    // neither of them ever knows. Null for a pre-multi-user session.
    return res.status(200).json({
      authenticated: !!claims,
      who: claims ? claims.who : null,
      expiresIn: claims ? secondsRemaining(token) : 0
    });
  }

  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', clearCookie());
    return res.status(200).json({ ok: true });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const secret = process.env.SESSION_SECRET;
  const users = parseUsers(process.env.APP_USERS);
  const shared = process.env.APP_PASSCODE;
  if (!secret || (!users.length && !shared)) {
    console.error('auth: SESSION_SECRET, and one of APP_USERS or APP_PASSCODE, not set');
    return res.status(500).json({ error: 'server_misconfigured' });
  }

  const now = Date.now();
  while (attempts.length && now - attempts[0] > WINDOW_MS) attempts.shift();
  if (attempts.length >= MAX_ATTEMPTS) {
    return res.status(429).json({ error: 'too_many_attempts' });
  }
  attempts.push(now);

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const supplied = body && typeof body.passcode === 'string' ? body.passcode : '';

  // Compare digests rather than raw strings so length is not leaked by timing.
  // EVERY candidate is checked, and the loop is not short-circuited on a match,
  // so the time taken does not reveal which passcode was tried or how many exist.
  const suppliedDigest = await digest(supplied);
  let who = null;
  let matched = false;
  for (const u of users) {
    if (safeEqual(suppliedDigest, await digest(u.passcode))) { matched = true; who = u.who; }
  }
  if (!matched && shared && safeEqual(suppliedDigest, await digest(shared))) {
    matched = true;   // the single-passcode fallback: nobody is identified
  }
  if (!matched) {
    await new Promise((r) => setTimeout(r, 400 + Math.random() * 300));
    return res.status(401).json({ error: 'invalid_passcode' });
  }

  attempts.length = 0;
  const token = await mintToken(secret, DEFAULT_TTL_SECONDS, who);
  res.setHeader('Set-Cookie', buildCookie(token, DEFAULT_TTL_SECONDS));
  return res.status(200).json({ ok: true, expiresIn: DEFAULT_TTL_SECONDS });
}

/* APP_USERS is "AM:passcode,MM:otherpasscode" — initials before the colon,
   passcode after, one pair per comma. It is deliberately an environment
   variable rather than anything stored: revoking a colleague is editing one
   line, and a leaver loses access without changing anyone else's code.

   A malformed entry is dropped rather than guessed at. Silently accepting a
   half-parsed passcode would be worse than refusing it. */
export function parseUsers(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const out = [];
  for (const part of raw.split(',')) {
    const i = part.indexOf(':');
    if (i <= 0) continue;
    const who = part.slice(0, i).trim();
    const passcode = part.slice(i + 1).trim();
    if (!/^[A-Za-z0-9_-]{1,16}$/.test(who) || passcode.length < 6) continue;
    out.push({ who, passcode });
  }
  // Two people given the same passcode would both be signed in as whichever
  // comes last, and every note either of them made would carry the wrong
  // initials. Refuse the pair outright: a colleague who cannot sign in finds
  // out at once, a misattributed record is found out never. Same for one set
  // of initials listed twice.
  const count = (k, v) => out.filter((u) => u[k] === v).length;
  const clean = out.filter((u) => count('passcode', u.passcode) === 1 && count('who', u.who) === 1);
  if (clean.length !== out.length) {
    console.error('auth: APP_USERS has a repeated passcode or initials; those entries are ignored');
  }
  return clean;
}

async function digest(value) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
