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

// Token format: v1.<expiryEpochSeconds>.<hexHmac>
export async function mintToken(secret, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `v1.${exp}`;
  const sig = await sign(secret, payload);
  return `${payload}.${sig}`;
}

export async function verifyToken(secret, token) {
  if (!secret || !token) return false;
  const parts = String(token).split('.');
  if (parts.length !== 3) return false;
  const [version, expRaw, sig] = parts;
  if (version !== 'v1') return false;

  const exp = Number(expRaw);
  if (!Number.isFinite(exp)) return false;
  if (Math.floor(Date.now() / 1000) >= exp) return false;

  const expected = await sign(secret, `v1.${expRaw}`);
  return safeEqual(sig, expected);
}

// Seconds remaining on a token, or 0 if absent, malformed or expired. Does NOT
// verify the signature — call verifyToken for that. This is only for telling the
// clinician how long they have left.
export function secondsRemaining(token) {
  if (!token) return 0;
  const parts = String(token).split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return 0;
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
