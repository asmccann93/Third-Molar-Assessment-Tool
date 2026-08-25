// api/auth.mjs
//
// Passcode in, httpOnly cookie out. Single user — deliberately not over-built.
//
// The throttle below is per warm instance, so it is not a real rate limiter:
// serverless spreads attempts across instances. It is enough to make scripted
// guessing tedious, and the passcode should be long enough that guessing is not
// the threat model. Use a passphrase, not four digits.

import { mintToken, buildCookie, clearCookie, safeEqual, DEFAULT_TTL_SECONDS } from './_session.mjs';

const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 8;
const attempts = []; // timestamps, this instance only

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', clearCookie());
    return res.status(200).json({ ok: true });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, DELETE');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const secret = process.env.SESSION_SECRET;
  const expected = process.env.APP_PASSCODE;
  if (!secret || !expected) {
    console.error('auth: SESSION_SECRET or APP_PASSCODE not set');
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
  const [a, b] = await Promise.all([digest(supplied), digest(expected)]);
  if (!safeEqual(a, b)) {
    await new Promise((r) => setTimeout(r, 400 + Math.random() * 300));
    return res.status(401).json({ error: 'invalid_passcode' });
  }

  attempts.length = 0;
  const token = await mintToken(secret, DEFAULT_TTL_SECONDS);
  res.setHeader('Set-Cookie', buildCookie(token, DEFAULT_TTL_SECONDS));
  return res.status(200).json({ ok: true, expiresIn: DEFAULT_TTL_SECONDS });
}

async function digest(value) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
