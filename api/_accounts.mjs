// api/_accounts.mjs
//
// Staff accounts, the Node-only half: passwords, invite tokens, in-memory
// throttles, and writes to the store. The read side, which the Edge
// middleware also needs, is _store.mjs.
//
// Sign-in is email and password only: no second factor, by the practice
// owner's decision (26 September 2026). So the password carries the whole
// weight, and the per-account lock in api/auth.mjs is stricter to match.
//
// Everything here uses node:crypto. No npm dependency: the api has none, and a
// sign-in path is the last place to add one.
//
// WRITES ARE RATIONED. The Hobby plan includes 100 writes a month to the
// store (Vercel's Hobby page, September 2026), and a Hobby feature that goes
// over its allowance is blocked for 30 days. So nothing on a frequent path
// writes: not sign-in, not a failed attempt, not a lockout counter. Those live
// in memory, per warm instance, and are allowed to be imperfect. Only admin
// actions and finishing a setup write, and api/users.mjs caps its own.
//
// RECORDS ARE COMPACT. Vercel's pages disagree on the Hobby store size (1 MB
// in the migration guide, 8 KB on older pages), so the password hash is
// stored as one short string, and the admin page refuses to add anyone once
// the store would pass 7 KB.

import { scrypt as scryptCb, randomBytes, randomInt, timingSafeEqual, createHash } from 'node:crypto';
import { storeConfig, noteLocalWrite, KEY_RE, MAX_EPOCH } from './_store.mjs';

/* ---------- epochs ----------
   A session carries its account's epoch, and a change of epoch ends it. They
   used to start at 0 and go up by 1, which made them predictable: delete XY,
   add a new XY, and once the newcomer finished setting up (epoch 1) the
   LEAVER's old cookie (also epoch 1) worked again, with the newcomer's role.
   Now a new account starts at a random epoch and every bump adds a random
   amount, so an old cookie lines up with a new account by chance only
   (about one in a hundred million), and two setups of one link racing each
   other end on different epochs. */
export const firstEpoch = () => randomInt(1, 100_000_000);
export function nextEpoch(epoch) {
  const next = epoch + randomInt(1, 1_000_000);
  // Some fifty million years of bumps away; wrapping would reuse epochs.
  if (!Number.isSafeInteger(next) || next > MAX_EPOCH) throw new Error('epoch overflow');
  return next;
}

/* ---------- passwords ---------- */

// scrypt at N=2^14, r=8, p=1: about 16 MB and a few tens of milliseconds per
// attempt, which is the OWASP floor for scrypt and well inside a function's
// memory. The parameters are stored with each hash, so they can be raised
// later without invalidating anyone.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 1024;

function scrypt(password, salt, { N, r, p }, keylen) {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, { N, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

// NFC so the same password typed on a Mac and on Windows is the same bytes.
const pwBytes = (password) => Buffer.from(String(password).normalize('NFC'), 'utf8');

// Stored as one string: scrypt$N$r$p$<salt>$<hash>, base64url. The parameters
// travel with each hash, so they can be raised later without invalidating
// anyone.
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scrypt(pwBytes(password), salt, SCRYPT, SCRYPT.keylen);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPassword(password, rec) {
  const parts = typeof rec === 'string' ? rec.split('$') : [];
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  // Bounds on what a record may ask for, so a garbled one cannot make every
  // sign-in allocate a gigabyte.
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (![N, r, p].every(Number.isInteger) || N < 2 || N > 1 << 17 || (N & (N - 1)) !== 0 || r < 1 || r > 16 || p < 1 || p > 4) return false;
  const salt = Buffer.from(parts[4], 'base64url'), want = Buffer.from(parts[5], 'base64url');
  if (salt.length < 8 || want.length !== SCRYPT.keylen) return false;
  const got = await scrypt(pwBytes(password), salt, { N, r, p }, want.length);
  return timingSafeEqual(got, want);
}

// Compared against when there is no real hash to compare against: an unknown
// email, or an account with no password yet. Without it, "no such person"
// comes back in a millisecond and "wrong password" in forty, and the
// difference is a list of who works here.
let dummy = null;
export async function dummyVerify(password) {
  if (!dummy) dummy = await hashPassword(randomBytes(24).toString('base64'));
  await verifyPassword(password, dummy);
  return false;
}

/* The only rules: long enough, and not built from the person's own email.
   Composition rules (a digit, a symbol) push people towards Password1! and
   are no longer recommended (NCSC, NIST 800-63B). */
export function passwordProblem(password, email) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN) return 'password_too_short';
  if (password.length > PASSWORD_MAX) return 'password_too_long';
  const local = String(email || '').split('@')[0].toLowerCase();
  // A one- or two-letter local part ("am@") would forbid most passwords.
  if (local.length >= 3 && password.toLowerCase().indexOf(local) !== -1) return 'password_contains_email';
  return null;
}

/* ---------- invites ---------- */

export const INVITE_TTL_MS = 72 * 60 * 60 * 1000;
export const INVITE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

// The token goes to the admin once, in the setup link; only its hash is
// stored. Someone who can read the store cannot set up an account with it.
export function newInvite(now = Date.now()) {
  const token = randomBytes(32).toString('base64url');
  return { token, invite: { hash: sha256(token), expires: new Date(now + INVITE_TTL_MS).toISOString() } };
}

export const sha256 = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex');

export function hexEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/* ---------- in-memory throttles ----------
   Per warm instance, so not a real rate limiter: serverless spreads requests
   across instances. Enough to make scripted guessing tedious; a long password
   is what actually stops it. Bounded, oldest keys dropped first.

   lockMs: once `max` failures are in the window, the key stays blocked for
   lockMs from the last of them, even as the earlier ones age out. Without it
   the limit is a sliding window, and a patient guesser gets a fresh try every
   time the oldest failure expires. */
export function makeThrottle({ windowMs, max, maxKeys = 1000, lockMs = 0 }) {
  const hits = new Map();
  const locks = new Map(); // key -> { until, at: the failure that set it }
  const prune = (now) => {
    for (const [k, times] of hits) {
      while (times.length && now - times[0] > windowMs) times.shift();
      if (!times.length) hits.delete(k);
    }
    for (const [k, lock] of locks) if (lock.until <= now) locks.delete(k);
    while (hits.size > maxKeys) hits.delete(hits.keys().next().value);
    while (locks.size > maxKeys) locks.delete(locks.keys().next().value);
  };
  return {
    hits,
    locks,
    blocked(key, now = Date.now()) {
      prune(now);
      const lock = locks.get(key);
      if (lock && lock.until > now) return true;
      return (hits.get(key) || []).length >= max;
    },
    // The lock is set by the failure that reaches `max`, so it runs from that
    // failure however the window slides afterwards.
    count(key, now = Date.now()) {
      const times = hits.get(key) || [];
      times.push(now);
      hits.delete(key); hits.set(key, times); // re-insert, so the map stays oldest-first
      if (lockMs && times.length >= max) locks.set(key, { until: now + lockMs, at: now });
    },
    // An attempt counted up front and then found to be good is taken back,
    // and so is any lock that attempt set.
    withdraw(key, at) {
      const times = hits.get(key);
      const i = times ? times.lastIndexOf(at) : -1;
      if (i >= 0) times.splice(i, 1);
      if (times && !times.length) hits.delete(key);
      const lock = locks.get(key);
      if (lock && lock.at === at) locks.delete(key);
    },
    clear() { hits.clear(); locks.clear(); }
  };
}

// Vercel sets x-real-ip itself; x-forwarded-for is the fallback, first entry
// only (the client end of the chain). Same rule as auth.mjs.
export function clientKey(req) {
  const h = req.headers || {};
  const real = typeof h['x-real-ip'] === 'string' ? h['x-real-ip'].trim() : '';
  if (real) return real;
  const fwd = typeof h['x-forwarded-for'] === 'string' ? h['x-forwarded-for'].split(',')[0].trim() : '';
  return fwd || 'unknown';
}

/* A same-origin request: the Origin header names this host. Browsers send
   Origin on every POST and DELETE, and a page on another site cannot forge
   it. Used on every route that changes something for a signed-in person. */
export function sameOrigin(req) {
  const h = req.headers || {};
  const origin = h.origin, host = h.host;
  if (typeof origin !== 'string' || typeof host !== 'string' || !origin || !host) return false;
  try { return new URL(origin).host === host; } catch { return false; }
}

export async function readJsonBody(req) {
  let body = req.body;
  if (body === undefined || body === null) {
    const chunks = [];
    try { for await (const c of req) chunks.push(Buffer.from(c)); } catch { /* already consumed */ }
    body = chunks.length ? Buffer.concat(chunks).toString('utf8') : '';
  }
  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  if (typeof body === 'string') {
    if (body.length > 20_000) return {};
    try { body = JSON.parse(body); } catch { return {}; }
  }
  return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
}

/* ---------- writing to the store ----------
   One PATCH, one or more operations; Vercel applies all of them or none. The
   management token (VERCEL_API_TOKEN) can change the whole Vercel team, so it
   is read in this function only, and only api/users.mjs and api/account.mjs
   call it. It is never logged, and neither is the request body (it carries
   password hashes). */
export function writesConfigured() {
  return storeConfig().state === 'ok' && !!process.env.VERCEL_API_TOKEN;
}

export async function writeItems(items) {
  const cfg = storeConfig();
  const token = process.env.VERCEL_API_TOKEN;
  if (cfg.state !== 'ok' || !token) throw new Error('store writes are not configured');
  for (const it of items) {
    if (!KEY_RE.test(it.key) || it.key.length > 256) throw new Error('bad store key');
  }
  const team = process.env.VERCEL_TEAM_ID ? `?teamId=${encodeURIComponent(process.env.VERCEL_TEAM_ID)}` : '';
  const r = await fetch(`https://api.vercel.com/v1/${cfg.api}/${cfg.storeId}/items${team}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ items })
  });
  let reply = null;
  try { reply = await r.json(); } catch { reply = null; }
  if (!r.ok || !reply || reply.status !== 'ok') {
    const why = reply && reply.error && typeof reply.error.message === 'string' ? reply.error.message.slice(0, 200) : '';
    throw new Error(`store write ${r.status}${why ? ': ' + why : ''}`);
  }
  for (const it of items) noteLocalWrite(it.key, it.operation === 'delete' ? null : it.value);
  return true;
}
