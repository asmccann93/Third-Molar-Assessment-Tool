// api/auth.mjs
//
// Two ways in, one httpOnly cookie out.
//
//   { email, password }        a staff account from the account store (see
//                              _store.mjs). The normal way in. There is no
//                              second factor, by the owner's decision, so the
//                              per-account lock below is the strict one.
//   { passcode }               one passcode per clinician, from APP_USERS;
//                              which passcode matched is who is signed in.
//                              Honoured only while APP_USERS is set, so the
//                              owner cannot be locked out while moving across.
//
// The throttles below are per warm instance, so they are not real rate
// limiters: serverless spreads attempts across instances. They make scripted
// guessing tedious; a long password, unique to this site, is what actually
// stops it.
//
// Nothing here writes to the account store. A write on every sign-in, or every
// failure, would spend the month's 100 writes in a day.

import {
  mintToken, buildCookie, clearCookie, safeEqual,
  readCookie, secondsRemaining, DEFAULT_TTL_SECONDS
} from './_session.mjs';
import { resolveSession, storeState, loadUsers, cachedUsers, refreshOnce, appUsersSet } from './_store.mjs';
import { verifyPassword, dummyVerify, makeThrottle, sameOrigin, PASSWORD_MAX } from './_accounts.mjs';

const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 8;
const MAX_CLIENTS = 1000;
// Failed attempts per client address, this instance only: address -> timestamps.
//
// It used to be one list for everyone, and a successful sign-in counted too.
// So eight wrong guesses from anyone, anywhere, locked every clinician out for
// a minute, and eight colleagues signing in at the start of a session locked
// out the ninth. Now only failures count, and only against the address they
// came from.
const attempts = new Map();
// Exposed so the tests can check the map stays bounded without making a
// thousand slow failed sign-ins.
export const _throttle = { attempts, MAX_CLIENTS };

// Failed sign-ins per account (by the email typed, whether or not anyone has
// it, so the limit itself says nothing about who exists). The per-address
// limit alone lets a botnet try one password per address against one person
// all day. Five failures in fifteen minutes LOCK that account for fifteen
// minutes from the fifth, from anywhere: a lock rather than a sliding window,
// because with no second factor the password is the only thing a guesser has
// to get through. A colleague locked out by someone else's guessing waits
// fifteen minutes at most, on one instance; that is the price. In memory
// only: a lockout written to the store would spend its writes.
const ACCOUNT_WINDOW_MS = 15 * 60_000;
const ACCOUNT_MAX = 5;
const ACCOUNT_LOCK_MS = 15 * 60_000;
const perAccount = makeThrottle({ windowMs: ACCOUNT_WINDOW_MS, max: ACCOUNT_MAX, lockMs: ACCOUNT_LOCK_MS });
export const _accountThrottle = perAccount;

// Vercel sets x-real-ip itself; x-forwarded-for is the fallback, first entry
// only (the client end of the chain).
function clientKey(req) {
  const h = req.headers || {};
  const real = typeof h['x-real-ip'] === 'string' ? h['x-real-ip'].trim() : '';
  if (real) return real;
  const fwd = typeof h['x-forwarded-for'] === 'string' ? h['x-forwarded-for'].split(',')[0].trim() : '';
  return fwd || 'unknown';
}

// Recent failures for this address, dropping any that have aged out, and any
// address with nothing left, so the map cannot grow without bound. If it is
// still over MAX_CLIENTS, the addresses heard from longest ago go first.
function recentFailures(key, now) {
  for (const [k, times] of attempts) {
    while (times.length && now - times[0] > WINDOW_MS) times.shift();
    if (!times.length) attempts.delete(k);
  }
  while (attempts.size > MAX_CLIENTS) attempts.delete(attempts.keys().next().value);
  return attempts.get(key) || [];
}

function recordFailure(key, now) {
  const times = attempts.get(key) || [];
  times.push(now);
  attempts.delete(key);        // re-insert, so the map stays oldest-first
  attempts.set(key, times);
}

function withdrawFailure(key, at) {
  const times = attempts.get(key);
  const i = times ? times.lastIndexOf(at) : -1;
  if (i >= 0) times.splice(i, 1);
  if (times && !times.length) attempts.delete(key);
}

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
    // resolveSession, not just the signature: a colleague disabled from the
    // admin page must see "signed out" here, not a session that the next
    // request will refuse halfway through a consultation.
    const session = secret ? await resolveSession(secret, token) : null;
    // `who` rides along with the check the page already makes. Three clinicians
    // sharing a surgery computer need to see whose session is open before they
    // start, or the second one records under the first one's identity and
    // neither of them ever knows. Null for a pre-multi-user session.
    return res.status(200).json({
      authenticated: !!session,
      who: session ? session.who : null,
      admin: !!(session && session.admin),
      expiresIn: session ? secondsRemaining(token) : 0
    });
  }

  // Sign-in and sign-out must come from this site's own pages. Without this, a
  // form on any other site could post an attacker's details here and sign a
  // colleague into the ATTACKER's account (login CSRF): whatever they then
  // recorded would be filed under someone else. SameSite=Strict on the cookie
  // does not stop that, because the attack sets a cookie rather than using
  // one. A cross-site form cannot send application/json, and cannot fake
  // Origin. The sign-in page and AI Notes' Lock button both send both.
  if (req.method === 'POST' || req.method === 'DELETE') {
    if (!sameOrigin(req)) return res.status(403).json({ error: 'cross_origin' });
    if (req.method === 'POST' && !/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
      return res.status(415).json({ error: 'json_only' });
    }
  }

  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', clearCookie());
    return res.status(200).json({ ok: true });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  if (!body || typeof body !== 'object') body = {};

  if ('email' in body || 'password' in body) {
    return accountSignIn(req, res, body);
  }

  const secret = process.env.SESSION_SECRET;
  // Passcodes are only for the move across to accounts. With a store and no
  // APP_USERS, a passcode gets the same answer as any wrong sign-in.
  if (secret && !appUsersSet() && storeState() !== 'off') {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  const users = parseUsers(process.env.APP_USERS);
  // The old single shared passcode is no longer honoured, even if someone sets
  // it again: whoever signed in with it was nobody, and every note they made
  // carried no initials. It was deleted from Vercel on 17 September 2026.
  // Say so in the log, because otherwise re-adding it would look like a
  // mistyped passcode rather than a retired one.
  if (process.env.APP_PASSCODE) {
    console.warn('auth: APP_PASSCODE is set but is no longer used. Sign-in is by APP_USERS only.');
  }
  if (!secret || !users.length) {
    console.error('auth: SESSION_SECRET and APP_USERS must both be set');
    return res.status(500).json({ error: 'server_misconfigured' });
  }

  // Checked before the passcode is compared, so a throttled address learns
  // nothing from its next guess, right or wrong. The attempt is counted as a
  // failure straight away and withdrawn if it succeeds: counted only after the
  // comparison, a burst of guesses sent at once would all pass the check.
  const client = clientKey(req);
  const now = Date.now();
  if (recentFailures(client, now).length >= MAX_ATTEMPTS) {
    return res.status(429).json({ error: 'too_many_attempts' });
  }
  recordFailure(client, now);

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
  // Moving across to accounts: someone the admin page has disabled stays out,
  // even with a passcode that is still in APP_USERS. The gate would refuse the
  // cookie anyway; refusing here says so at the door rather than after it.
  if (matched && storeState() !== 'off') {
    try {
      const u = (await loadUsers()).get(String(who).toUpperCase());
      if (u && u.status === 'disabled') matched = false;
    } catch { /* store unreadable: APP_USERS is still the list that applies */ }
  }
  if (!matched) {
    await new Promise((r) => setTimeout(r, 400 + Math.random() * 300));
    return res.status(401).json({ error: 'invalid_passcode' });
  }

  withdrawFailure(client, now);
  const token = await mintToken(secret, DEFAULT_TTL_SECONDS, who);
  res.setHeader('Set-Cookie', buildCookie(token, DEFAULT_TTL_SECONDS));
  return res.status(200).json({ ok: true, expiresIn: DEFAULT_TTL_SECONDS });
}

/* Email and password. Every way this can fail gets the same answer, after the
   same amount of work: wrong password, no such email, an account disabled or
   not yet set up. Which of those it was is exactly what someone guessing
   wants to know. */
async function accountSignIn(req, res, body) {
  const secret = process.env.SESSION_SECRET;
  const state = storeState();
  if (!secret || state === 'off') {
    console.error('auth: account sign-in needs SESSION_SECRET and GLOBAL_CONFIG');
    return res.status(500).json({ error: 'server_misconfigured' });
  }

  const client = clientKey(req);
  const now = Date.now();
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase().slice(0, 254) : '';
  const password = typeof body.password === 'string' ? body.password.slice(0, PASSWORD_MAX + 1) : '';
  const accountKey = 'acct:' + email;

  // Both limits are checked before anything is compared, and the attempt is
  // counted as a failure up front and withdrawn if it succeeds (see the
  // passcode path below for why).
  if (recentFailures(client, now).length >= MAX_ATTEMPTS || perAccount.blocked(accountKey, now)) {
    return res.status(429).json({ error: 'too_many_attempts' });
  }
  recordFailure(client, now);
  perAccount.count(accountKey, now);

  // The cached list first: an unknown email or a wrong password costs no
  // store read, however many are sent (the read allowance is what a Hobby
  // project cannot afford to run out of; see _store.mjs). Two cases read:
  //   - details that check out against the cached record are confirmed
  //     against a fresh read before a session is issued, so a colleague
  //     disabled or reset in the last half-minute is not let back in;
  //   - an account the cached list shows as not yet active (most likely
  //     someone who has just finished setting up) gets the instance's shared
  //     early re-read, at most once per few seconds for the whole instance.
  // Neither falls back on an old copy of the list if the store is down.
  const find = (users) => {
    let found = null;
    for (const u of users.values()) if (email && u.email === email) found = u;
    return found;
  };
  // The password is checked with scrypt whether or not there is anyone to
  // check it against, so timing does not separate "no such email" from
  // "wrong password".
  const attempt = async (user) => {
    const pwOk = user && user.pw ? await verifyPassword(password, user.pw) : await dummyVerify(password);
    return pwOk && user.status === 'active';
  };

  let user, ok;
  try {
    user = find(await cachedUsers());
    ok = await attempt(user);
    if (!ok && user && user.status !== 'active') {
      const again = find(await refreshOnce());
      if (again && again.status === 'active') { user = again; ok = await attempt(user); }
    }
    if (ok) {
      const fresh = find(await loadUsers({ maxAgeMs: 2_000 }));
      ok = !!fresh && fresh.status === 'active' && fresh.epoch === user.epoch &&
           fresh.pw === user.pw && fresh.initials === user.initials;
    }
  } catch (err) {
    // Not their fault, so not held against them.
    withdrawFailure(client, now);
    perAccount.withdraw(accountKey, now);
    return res.status(503).json({ error: 'accounts_unavailable' });
  }

  if (!ok) {
    await new Promise((r) => setTimeout(r, 400 + Math.random() * 300));
    return res.status(401).json({ error: 'invalid_credentials' });
  }

  withdrawFailure(client, now);
  perAccount.withdraw(accountKey, now);
  const token = await mintToken(secret, DEFAULT_TTL_SECONDS, user.initials, user.epoch);
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
