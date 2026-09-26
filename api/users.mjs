// api/users.mjs
//
// The admin page's API: list staff, add someone, give them a new setup link,
// disable, enable, change role, delete. Admins only.
//
//   GET  /api/users                         -> { configured, users, me, ... }
//   POST /api/users { action, ... }         -> { ok, users, setupLink? }
//        action: add { email, initials, role } | reset | disable | enable
//                | role { role } | delete      (all but add take { initials })
//
// Every POST is one write to the account store, and the Hobby plan includes
// 100 a month (going over blocks the store for 30 days). So writes are capped
// here, per hour and per day, as well as being admin-only, and nothing else in
// the app writes except finishing a setup.
//
// RACES THAT REMAIN. The store has no compare-and-swap and takes up to 10 s to
// show a write everywhere, so two admins acting at once on different
// instances can each act on a list that does not yet show the other's change.
// The one that matters, two admins disabling (or deleting, or demoting) each
// other, is caught after the fact: an action that removes an active admin
// waits out the propagation delay, re-reads, and undoes itself if nobody
// active with the admin role is left. The others are cosmetic (a colleague
// added twice under different initials) or covered in api/account.mjs.
//
// A POST must come from this site's own pages: a same-origin Origin header and
// a JSON body. The session cookie is SameSite=Strict, which already stops a
// link on another site from carrying it; this is the second lock on the door,
// because the actions here decide who can open patient consultations.

import { readCookie } from './_session.mjs';
import {
  resolveSession, storeState, loadUsers, userKey, INITIALS_RE, ROLES, appUsersSet, storeBytes
} from './_store.mjs';
import {
  newInvite, writeItems, writesConfigured, makeThrottle, readJsonBody, sameOrigin, firstEpoch, nextEpoch
} from './_accounts.mjs';

// The undo check below waits out Vercel's propagation delay (up to 10 s).
export const config = { maxDuration: 60 };

// Five changes an hour and ten a day, per instance. Setting up a practice of
// twenty takes a few days at this rate (setups themselves are not counted
// here); a stuck button or a script cannot burn the month's 100.
const writeLimit = makeThrottle({ windowMs: 60 * 60_000, max: 5 });
const dailyLimit = makeThrottle({ windowMs: 24 * 60 * 60_000, max: 10 });
export const _writeLimit = {
  count() { writeLimit.count('writes'); dailyLimit.count('writes'); },
  clear() { writeLimit.clear(); dailyLimit.clear(); },
  hourly: writeLimit, daily: dailyLimit
};
// Tests set this to 0; in production it is Vercel's propagation delay plus a margin.
export const _timing = { settleMs: 11_000 };

// The store's size on Hobby is given as 1 MB in one place and 8 KB in older
// ones. Stay under 7 KB, which is safe either way (about twenty staff).
const STORE_SAFE_BYTES = 7 * 1024;
// What a record grows to once set up: the largest it will be.
const SIZE_PAD = { pw: 'scrypt$16384$8$1$' + 'x'.repeat(22) + '$' + 'x'.repeat(43),
                   invite: { hash: 'x'.repeat(64), expires: '2026-01-01T00:00:00.000Z' } };

const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;

// What the page is shown. Never the password hash or the
// invite hash: the admin page has no use for them, and a page that never
// receives them cannot leak them.
function publicUser(u) {
  return {
    initials: u.initials, email: u.email, role: u.role, status: u.status,
    createdAt: u.createdAt, inviteExpires: u.status === 'invited' && u.invite ? u.invite.expires : null,
    setUp: !!u.pw
  };
}
const listOf = (users) => [...users.values()].map(publicUser).sort((a, b) => a.initials.localeCompare(b.initials));

// The last active admin may not be disabled, deleted or demoted: with nobody
// left who can open this page, the only way back is redeploying with
// APP_USERS and ADMIN_USERS set again.
const activeAdmins = (users, except) =>
  [...users.values()].filter((u) => u.role === 'admin' && u.status === 'active' && u.initials !== except).length;

// Initials that the environment already gives powers to. A colleague created
// with the owner's initials, before the owner has an account of his own,
// would walk straight into the implant preview and (while APP_USERS is set)
// the admin page. Only the person already signed in under those initials may
// create an account with them: the owner adding himself.
function reservedInitials() {
  const out = new Set();
  for (const name of ['APP_USERS', 'ADMIN_USERS', 'IMPLANT_USERS']) {
    for (const part of String(process.env[name] || '').split(',')) {
      const who = (name === 'APP_USERS' ? part.split(':')[0] : part).trim().toUpperCase();
      if (who) out.add(who);
    }
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setupLink(req, token) {
  const proto = req.headers['x-forwarded-proto'] === 'http' ? 'http' : 'https';
  // The token goes after the #: browsers never send the fragment, so it
  // cannot end up in a request log, a Referer header or a proxy.
  return `${proto}://${req.headers.host}/ai-notes/setup/#${token}`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  const session = await resolveSession(process.env.SESSION_SECRET, readCookie(req.headers.cookie));
  if (!session) return res.status(401).json({ error: 'unauthenticated' });
  if (!session.admin) return res.status(403).json({ error: 'not_permitted' });

  const state = storeState();
  const context = {
    me: session.who,
    via: session.via,
    passcodesStillOn: appUsersSet(),
    writable: writesConfigured()
  };

  if (req.method === 'GET') {
    if (state !== 'ok') {
      return res.status(200).json({ configured: false, state, users: [], ...context });
    }
    try {
      return res.status(200).json({ configured: true, state, users: listOf(await loadUsers({ maxAgeMs: 0 })), ...context });
    } catch {
      return res.status(503).json({ error: 'store_unreadable', configured: true, state, users: [], ...context });
    }
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!sameOrigin(req)) return res.status(403).json({ error: 'cross_origin' });
  if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
    return res.status(415).json({ error: 'json_only' });
  }
  if (state !== 'ok' || !writesConfigured()) {
    return res.status(503).json({ error: 'store_not_configured', state });
  }

  const body = await readJsonBody(req);
  const action = typeof body.action === 'string' ? body.action : '';
  const initials = typeof body.initials === 'string' ? body.initials.trim().toUpperCase() : '';

  let users;
  try { users = await loadUsers({ maxAgeMs: 0 }); } catch { return res.status(503).json({ error: 'store_unreadable' }); }

  // Work out the one write this action needs, or refuse it, before touching
  // the rate limit: a refusal costs no write, so it should cost no allowance.
  let op = null, link = null;
  const now = Date.now();
  const target = users.get(initials);

  if (action === 'add') {
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const role = ROLES.indexOf(body.role) !== -1 ? body.role : null;
    if (!INITIALS_RE.test(initials)) return res.status(400).json({ error: 'bad_initials' });
    if (!EMAIL_RE.test(email) || email.length > 254) return res.status(400).json({ error: 'bad_email' });
    if (!role) return res.status(400).json({ error: 'bad_role' });
    // Initials are the identity everywhere (job tickets, IMPLANT_USERS, the
    // session), and an email is the sign-in name. Two people sharing either
    // would be signed in as each other.
    if (target) return res.status(409).json({ error: 'initials_taken' });
    if ([...users.values()].some((u) => u.email === email)) return res.status(409).json({ error: 'email_taken' });
    if (reservedInitials().has(initials) && session.who.toUpperCase() !== initials) {
      return res.status(409).json({ error: 'initials_reserved' });
    }
    const { token, invite } = newInvite(now);
    link = setupLink(req, token);
    // A random first epoch: see _accounts.mjs firstEpoch for why not 0.
    op = { operation: 'create', key: userKey(initials), value: {
      email, initials, role, status: 'invited', pw: null, invite, epoch: firstEpoch(), createdAt: new Date(now).toISOString().slice(0, 10)
    } };
    const grown = JSON.stringify({ [op.key]: { ...op.value, ...SIZE_PAD } }).length + 1;
    if (storeBytes() + grown > STORE_SAFE_BYTES) return res.status(409).json({ error: 'store_full' });
  } else if (['reset', 'disable', 'enable', 'role', 'delete'].indexOf(action) !== -1) {
    if (!target) return res.status(404).json({ error: 'no_such_user' });
    const self = target.initials === session.who;
    const wasActiveAdmin = target.role === 'admin' && target.status === 'active';
    const base = { email: target.email, initials: target.initials, role: target.role, status: target.status,
                   pw: target.pw, invite: target.invite, epoch: target.epoch, createdAt: target.createdAt };

    if (action === 'reset') {
      // A new setup link: they choose a new password. The old one is cleared
      // and the epoch moves, so every session they hold ends now. Allowed on
      // yourself (a forgotten password), and the link comes back to you.
      const { token, invite } = newInvite(now);
      link = setupLink(req, token);
      op = { operation: 'update', key: userKey(target.initials), value: { ...base, status: 'invited', pw: null, invite, epoch: nextEpoch(target.epoch) } };
    } else if (action === 'disable') {
      if (self) return res.status(409).json({ error: 'cannot_disable_self' });
      if (wasActiveAdmin && activeAdmins(users, target.initials) === 0) return res.status(409).json({ error: 'last_admin' });
      if (target.status === 'disabled') return res.status(409).json({ error: 'already_disabled' });
      op = { operation: 'update', key: userKey(target.initials), value: { ...base, status: 'disabled', invite: null, epoch: nextEpoch(target.epoch) } };
    } else if (action === 'enable') {
      if (target.status !== 'disabled') return res.status(409).json({ error: 'not_disabled' });
      // Back to where they were: active if they had finished setting up, and
      // otherwise invited, with a fresh link needed (the old one was cleared).
      op = { operation: 'update', key: userKey(target.initials), value: { ...base, status: target.pw ? 'active' : 'invited' } };
    } else if (action === 'role') {
      const role = ROLES.indexOf(body.role) !== -1 ? body.role : null;
      if (!role) return res.status(400).json({ error: 'bad_role' });
      if (role === target.role) return res.status(409).json({ error: 'no_change' });
      if (self) return res.status(409).json({ error: 'cannot_change_own_role' });
      if (wasActiveAdmin && role !== 'admin' && activeAdmins(users, target.initials) === 0) return res.status(409).json({ error: 'last_admin' });
      op = { operation: 'update', key: userKey(target.initials), value: { ...base, role } };
    } else if (action === 'delete') {
      if (self) return res.status(409).json({ error: 'cannot_delete_self' });
      if (wasActiveAdmin && activeAdmins(users, target.initials) === 0) return res.status(409).json({ error: 'last_admin' });
      op = { operation: 'delete', key: userKey(target.initials) };
    }
  } else {
    return res.status(400).json({ error: 'bad_action' });
  }

  if (writeLimit.blocked('writes', now) || dailyLimit.blocked('writes', now)) return res.status(429).json({ error: 'write_limit' });
  _writeLimit.count();
  try {
    await writeItems([op]);
  } catch (err) {
    console.error('users: store write failed:', action, initials, err && err.message);
    return res.status(502).json({ error: 'save_failed' });
  }
  console.log(`users: ${session.who} did "${action}" for ${op.key.slice(5)}`);

  // Removing an active admin (disable, delete, demote): make sure one is
  // still left once every instance's changes have landed, and undo this one
  // if not. The pre-check above cannot see another admin's change made a
  // moment ago on another instance; this can, after the wait.
  const removedAdmin = target && target.role === 'admin' && target.status === 'active' &&
    (action === 'disable' || action === 'delete' || (action === 'role' && op.value.role !== 'admin'));
  if (removedAdmin) {
    await sleep(_timing.settleMs);
    let left = null;
    try { left = activeAdmins(await loadUsers({ maxAgeMs: 0 })); } catch { left = null; }
    if (left === 0) {
      const original = { email: target.email, initials: target.initials, role: target.role, status: target.status,
                         pw: target.pw, invite: target.invite, epoch: target.epoch, createdAt: target.createdAt };
      try {
        await writeItems([{ operation: 'upsert', key: op.key, value: original }]);
        console.error(`users: undid "${action}" for ${op.key.slice(5)}: it left no active admin (another admin acted at the same moment?)`);
        return res.status(409).json({ error: 'last_admin_undone' });
      } catch (err) {
        console.error('users: COULD NOT UNDO a change that left no active admin:', op.key, err && err.message);
        return res.status(502).json({ error: 'no_admin_left' });
      }
    }
    if (left === null) console.error('users: could not re-read the store to confirm an admin is left after', action, op.key);
  }

  let after;
  try { after = listOf(await loadUsers({ maxAgeMs: 60_000 })); } catch { after = null; }
  return res.status(200).json({ ok: true, users: after, ...(link ? { setupLink: link } : {}) });
}
