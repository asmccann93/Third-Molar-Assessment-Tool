// api/_store.mjs
//
// Staff accounts, read side. Shared by middleware.js (Edge runtime) and the
// api/ handlers (Node runtime), so it uses only fetch, URL and the token code in
// _session.mjs: no node: imports. The Node-only half (passwords, codes, writes)
// is _accounts.mjs. Underscore prefix keeps both off the route table.
//
// WHERE THE ACCOUNTS LIVE
// A Vercel Global Config store (formerly Edge Config), one item per person:
//   user_<INITIALS> -> { email, initials, role, status, pw, invite, epoch, createdAt }
// It holds who may sign in and nothing about any patient. Nothing about a
// consultation is written anywhere by this code, and must not be.
//
// The connection string is GLOBAL_CONFIG (or the legacy EDGE_CONFIG):
//   https://global-config.vercel.com/<storeId>?token=<readToken>
//
// READS ARE METERED, so the list is kept in module scope for CACHE_MS. That is
// the staleness budget: a disabled colleague's session keeps working for up to
// CACHE_MS plus Vercel's own propagation (up to 10 s) after the admin presses
// Disable. Every place that lets a person in goes through resolveSession below,
// so that budget is the same everywhere.
//
// THE READ ALLOWANCE IS THE REAL LIMIT. Hobby includes 100,000 reads a month,
// and a Hobby feature that goes over is BLOCKED FOR 30 DAYS: nobody could sign
// in at all. So nothing an unauthenticated caller can send forces a read on
// its own. A junk setup token, an unknown email, a wrong password: all are
// answered from the cached list, which is re-read at most once per CACHE_MS
// per warm instance however much traffic there is. A fresh read happens only
// when the cached list says the request is genuine (a real invite, a real
// email whose password matched) or, for sessions, through one early re-read
// shared by the whole instance (REFRESH_GAP_MS). Worst case, traffic kept up
// around the clock against one warm instance costs about 2 reads a minute,
// roughly 86,000 a month; the admin page's own reads and the gate's are on top.
// If that is ever approached, raise CACHE_MS before anything else.
//
// NOT CONFIGURED means exactly what it did before accounts existed: APP_USERS
// passcodes, v1/v2 cookies, nothing else. SET BUT UNREADABLE (a mistyped
// connection string, a host that is not Vercel's) is NOT treated as "not
// configured": that would quietly re-open the passcode route after the owner
// had deliberately closed it. It fails closed and says so in the log.

import { readToken, readCookie } from './_session.mjs';

export const CACHE_MS = 30_000;
// How long a failed read may fall back on the last good list. An outage at
// Vercel should not sign the whole practice out in the middle of a clinic; a
// list older than this is too old to trust with a disabled colleague.
const STALE_OK_MS = 15 * 60_000;
// A change this instance wrote itself is laid over what the store returns for
// this long, because the store can take up to 10 s to show it. Without this, the
// admin page would show a colleague as still active straight after disabling
// them, and invite setup could be completed twice from the same instance.
const LOCAL_WRITE_MS = 15_000;
// A session newer than the cached list (someone who has just finished setting
// up, or whose new setup link was just used) triggers one early re-read, no
// more often than this per instance.
const REFRESH_GAP_MS = 5_000;

const HOSTS = new Set(['global-config.vercel.com', 'edge-config.vercel.com']);
export const KEY_RE = /^[A-Za-z0-9_-]+$/;
export const INITIALS_RE = /^[A-Z]{2,4}$/;
export const ROLES = ['admin', 'clinician'];
export const STATUSES = ['invited', 'active', 'disabled'];
export const userKey = (initials) => `user_${initials}`;
// Epochs are random and large (see _accounts.mjs nextEpoch), but still well
// inside what a JavaScript number holds exactly and what a v3 token carries.
export const MAX_EPOCH = 999_999_999_999_999;

let logged = '';
function logOnce(msg) {
  if (logged === msg) return;
  logged = msg;
  console.error(msg);
}

/* The connection string, taken apart. Returns
     { state: 'off' }                        neither variable set
     { state: 'broken', why }                set, but not something we will send a token to
     { state: 'ok', host, storeId, readToken, api }
   `api` is the management API path the writes go to: global-config for the new
   variable, edge-config for the legacy one. Vercel documents both. */
export function storeConfig(env = process.env) {
  const fromNew = typeof env.GLOBAL_CONFIG === 'string' && env.GLOBAL_CONFIG.trim();
  const raw = fromNew ? env.GLOBAL_CONFIG.trim() : (typeof env.EDGE_CONFIG === 'string' ? env.EDGE_CONFIG.trim() : '');
  if (!raw) return { state: 'off' };
  let u;
  try { u = new URL(raw); } catch { return { state: 'broken', why: 'the connection string is not a URL' }; }
  // The read token goes wherever this points, so it may only point at Vercel.
  if (u.protocol !== 'https:' || !HOSTS.has(u.hostname)) {
    return { state: 'broken', why: `the connection string points at ${u.hostname || 'nothing'}, not global-config.vercel.com` };
  }
  const storeId = u.pathname.replace(/^\/+|\/+$/g, '');
  const readToken = u.searchParams.get('token') || '';
  if (!KEY_RE.test(storeId) || !readToken) {
    return { state: 'broken', why: 'the connection string has no store id or no token' };
  }
  return { state: 'ok', host: u.hostname, storeId, readToken, api: fromNew ? 'global-config' : 'edge-config' };
}

export function storeState() {
  const cfg = storeConfig();
  if (cfg.state === 'broken') {
    logOnce(`accounts: GLOBAL_CONFIG/EDGE_CONFIG is set but unusable (${cfg.why}). ` +
            'Staff accounts are unavailable and the passcode route is NOT reopened because of it.');
  }
  return cfg.state;
}

/* APP_USERS initials, without touching the passcodes. The transition rules
   below turn on whether APP_USERS is set at all, and job tickets need the
   names; neither needs the secrets, and auth.mjs's parser logs about them. */
export function appUserInitials(env = process.env) {
  const out = new Set();
  for (const part of String(env.APP_USERS || '').split(',')) {
    const i = part.indexOf(':');
    if (i > 0) out.add(part.slice(0, i).trim().toUpperCase());
  }
  return out;
}
export const appUsersSet = (env = process.env) => appUserInitials(env).size > 0;

/* Whether the old ways in (APP_USERS passcodes, v1/v2 cookies) still work.
   Always, if there is no account store: that is today's behaviour, unchanged.
   With a store, only while APP_USERS is still set, so the owner cannot be
   locked out while moving across. Deleting APP_USERS is the switch that ends
   the transition: from then on only an account gets in. */
export function legacyAllowed() {
  return storeState() === 'off' || appUsersSet();
}

const listFrom = (value) => String(value || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);

// ADMIN_USERS only counts while APP_USERS is set: it is how the owner reaches
// the admin page to create the first account, and nothing more. Unset means
// nobody: an unset variable must never be the thing that opens a door.
function envAdmin(who) {
  if (!who || !appUsersSet()) return false;
  return listFrom(process.env.ADMIN_USERS).indexOf(String(who).toUpperCase()) !== -1;
}

/* ---------- reading the store ---------- */

// fetchedAt: when the list was last read successfully. failedAt: when a read
// last failed, so a store outage costs one failed read per FAIL_BACKOFF_MS,
// not one per request.
let cache = { users: null, fetchedAt: 0, failedAt: 0, bytes: 0 };
let inflight = null;
let lastForced = 0;
const FAIL_BACKOFF_MS = 5_000;
const localWrites = new Map(); // key -> { value (null = deleted), at }

// Tests need a cold cache per case; production never calls this.
export function _resetStore() {
  cache = { users: null, fetchedAt: 0, failedAt: 0, bytes: 0 };
  inflight = null;
  lastForced = 0;
  localWrites.clear();
  logged = '';
}

/* One stored value checked for shape. A record that does not look right is
   left out rather than half-trusted: a person missing from the list cannot
   sign in, which is found out at once; a person let in on a garbled record is
   found out never. */
export function normaliseUser(key, v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  if (typeof v.initials !== 'string' || !INITIALS_RE.test(v.initials) || key !== userKey(v.initials)) return null;
  if (typeof v.email !== 'string' || !v.email || v.email !== v.email.toLowerCase()) return null;
  if (ROLES.indexOf(v.role) === -1 || STATUSES.indexOf(v.status) === -1) return null;
  if (!Number.isSafeInteger(v.epoch) || v.epoch < 0 || v.epoch > MAX_EPOCH) return null;
  return {
    initials: v.initials, email: v.email, role: v.role, status: v.status, epoch: v.epoch,
    // A compact string (see _accounts.mjs): the store may be as small as 8 KB.
    // Anything else a record carries (a leftover field from an earlier
    // design, say) is dropped here and never used.
    pw: typeof v.pw === 'string' && v.pw ? v.pw : null,
    invite: v.invite && typeof v.invite === 'object' && typeof v.invite.hash === 'string' ? v.invite : null,
    createdAt: typeof v.createdAt === 'string' ? v.createdAt : null
  };
}

async function fetchUsers(cfg) {
  const r = await fetch(`https://${cfg.host}/${cfg.storeId}/items`, {
    headers: { Authorization: `Bearer ${cfg.readToken}` }
  });
  if (!r.ok) throw new Error(`store read ${r.status}`);
  const text = await r.text();
  let items;
  try { items = JSON.parse(text); } catch { throw new Error('store read: not JSON'); }
  if (!items || typeof items !== 'object' || Array.isArray(items)) throw new Error('store read: not an object');
  const users = new Map();
  for (const [key, value] of Object.entries(items)) {
    if (key.indexOf('user_') !== 0) continue;
    const u = normaliseUser(key, value);
    if (u) users.set(u.initials, u);
    else console.warn('accounts: ignoring a malformed record:', key);
  }
  return { users, bytes: text.length };
}

// Roughly how big the store is, as last read: the admin page refuses to add
// someone who would push it past its safety margin.
export const storeBytes = () => cache.bytes;

function withLocalWrites(users, now) {
  const out = new Map(users);
  for (const [key, w] of localWrites) {
    if (now - w.at > LOCAL_WRITE_MS) { localWrites.delete(key); continue; }
    const initials = key.slice('user_'.length);
    if (w.value === null) out.delete(initials);
    else { const u = normaliseUser(key, w.value); if (u) out.set(initials, u); }
  }
  return out;
}

// Called by _accounts.mjs after a write succeeds.
export function noteLocalWrite(key, value) {
  localWrites.set(key, { value, at: Date.now() });
}

/* The user list, as a Map of initials -> record. Throws if the store is not
   configured or cannot be read.

   maxAgeMs: 0 forces a fresh read, for the few paths that must not act on a
   30-second-old list (confirming a sign-in or a setup, admin changes). Those
   paths only ever get there on a request the cached list already showed to be
   genuine, so the forced reads are bounded by real use, not by traffic.

   allowStale: when the store cannot be read, fall back on the last good list
   (up to STALE_OK_MS old) instead of failing. Only resolveSession asks for
   that: an outage at Vercel should not sign a clinic out mid-consultation.
   Everything that DECIDES something (sign-in, setup, admin changes) fails
   closed instead, because a 15-minute-old list can hold a replaced setup link
   or an admin who has since been disabled. */
export async function loadUsers({ maxAgeMs = CACHE_MS, allowStale = false } = {}) {
  const cfg = storeConfig();
  if (cfg.state !== 'ok') throw new Error(`accounts store ${cfg.state}`);
  const now = Date.now();
  if (cache.users && now - cache.fetchedAt < maxAgeMs) return withLocalWrites(cache.users, now);
  const staleOk = () => allowStale && cache.users && Date.now() - cache.fetchedAt < STALE_OK_MS;
  // A read failed a moment ago: do not hammer a store that is down.
  if (now - cache.failedAt < FAIL_BACKOFF_MS) {
    if (staleOk()) return withLocalWrites(cache.users, now);
    throw new Error('accounts store unreadable (recent failure)');
  }
  if (!inflight) {
    inflight = fetchUsers(cfg).then(
      ({ users, bytes }) => { cache = { users, fetchedAt: Date.now(), failedAt: 0, bytes }; },
      (err) => { cache.failedAt = Date.now(); console.error('accounts: could not read the store:', err && err.message); throw err; }
    ).finally(() => { inflight = null; });
  }
  try {
    await inflight;
  } catch (err) {
    if (staleOk()) return withLocalWrites(cache.users, Date.now());
    throw err;
  }
  return withLocalWrites(cache.users, Date.now());
}

/* The cached list only: no read unless it is older than CACHE_MS anyway. What
   the unauthenticated paths (sign-in, setup) look things up in first. */
export const cachedUsers = () => loadUsers({ maxAgeMs: CACHE_MS });

/* One early re-read, shared by the whole instance and at most once per
   REFRESH_GAP_MS whoever asks. Returns the list, re-read or not. */
export async function refreshOnce() {
  const now = Date.now();
  if (now - lastForced > REFRESH_GAP_MS && cache.users && now - cache.fetchedAt > 1_000) {
    lastForced = now;
    return loadUsers({ maxAgeMs: 0 });
  }
  return loadUsers({ maxAgeMs: CACHE_MS });
}

/* ---------- is this session still good? ---------- */

const liveFor = (u, claims) => !!u && u.status === 'active' && u.epoch === claims.epoch && !!u.pw;

/* The one question every door asks. Returns null, or
     { who, role, admin, via: 'account' | 'passcode', exp }
   A token can be genuine (correctly signed, unexpired) and still not good:
   its account disabled, reset or deleted since, or it is a passcode session
   and passcodes have been switched off. */
export async function resolveSession(secret, token) {
  const claims = await readToken(secret, token);
  if (!claims) return null;
  const state = storeState();

  if (claims.v === 3) {
    // An account session means nothing without the accounts to check it against.
    if (state !== 'ok') return null;
    let users;
    try { users = await loadUsers({ allowStale: true }); } catch { return null; }
    let u = users.get(claims.who);
    // Newer than our copy of the list? One early re-read, shared by the whole
    // instance (refreshOnce). This is what lets someone who has just set up
    // their account (or been re-enabled) in straight away rather than after
    // the cache runs out. A token whose epoch is not above the list's is
    // simply stale and needs no re-read.
    //
    // Initials missing from the cached list do NOT trigger it: that is a
    // deleted account (a leaver's old cookie, perhaps replayed), and re-reading
    // for it would let one old cookie spend the read allowance. The only
    // genuine case it could delay is an account created AND set up AND signed
    // in within one cache window (30 s) on another instance, which a person
    // opening their link and choosing a password does not manage; if they did,
    // the cost is a wait of at most 30 s, never a lockout.
    const maybeNewer = !!u && (claims.epoch > u.epoch || (claims.epoch === u.epoch && u.status !== 'active'));
    if (!liveFor(u, claims) && maybeNewer) {
      try { users = await refreshOnce(); u = users.get(claims.who); } catch { return null; }
    }
    if (!liveFor(u, claims)) return null;
    return { who: u.initials, role: u.role, admin: u.role === 'admin' || envAdmin(u.initials), via: 'account', exp: claims.exp };
  }

  // v1 and v2: the passcode era.
  if (!legacyAllowed()) return null;
  if (state !== 'off') {
    // Moving across: only for someone still listed in APP_USERS (a v1 cookie
    // belongs to nobody, so it cannot be), and not for someone the admin page
    // has disabled. If the store cannot be read, APP_USERS is still the list
    // that let them in, so it stands.
    if (!claims.who || !appUserInitials().has(claims.who.toUpperCase())) return null;
    let users = null;
    try { users = await loadUsers({ allowStale: true }); } catch { users = null; }
    const u = users && users.get(claims.who.toUpperCase());
    if (u && u.status === 'disabled') return null;
  }
  return { who: claims.who, role: null, admin: envAdmin(claims.who), via: 'passcode', exp: claims.exp };
}

/* For the Node handlers. The middleware has already let this request through;
   this repeats the check with the handler's own copy of the list, so a
   colleague disabled a minute ago cannot keep transcribing on a gate whose
   cache happened to be older. With no account store there is nothing the
   middleware did not already know, and the handlers behave exactly as they
   always have. */
export async function sessionStillGood(req) {
  if (storeState() === 'off') return true;
  const cookie = req && req.headers ? req.headers.cookie : null;
  return !!(await resolveSession(process.env.SESSION_SECRET, readCookie(cookie)));
}
