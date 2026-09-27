// api/account.mjs
//
// Setting up an account from a setup link. Open to anyone, like /api/auth:
// the person using it has no session yet. What they have is the invite token
// from the link the admin handed them, and that token is the only key.
//
//   POST { token }
//        -> { email, initials }
//        Only checks the link, so the page can show whose account this is
//        (and a password manager can file the password under that email).
//        Nothing is written.
//   POST { token, password }
//        -> { ok: true }
//        Checks the link again and the password rules, then writes the
//        account as active with the password's scrypt hash. One write.
//
// POST, so the token travels in the body. In a query string it would sit in
// Vercel's request log; the page keeps it in the URL fragment, which browsers
// never send, for the same reason.
//
// READS. A token is looked up in the cached staff list first, and the store is
// read fresh only when that finds a live invite. A stream of junk tokens
// therefore costs no reads beyond the cache's own (see _store.mjs: the read
// allowance is what a Hobby project cannot afford to run out of). The price:
// a link made in the last half-minute on another instance may not be known
// here yet, which the setup page's message allows for. Neither read falls
// back on an old copy of the list if the store is down: setup fails closed.
//
// RACES THAT REMAIN (the store has no compare-and-swap, and takes up to 10 s
// to show a write everywhere):
//   - A link replaced by "New setup link" can still be completed on another
//     instance for up to ~10 s after the replacement. The admin page then
//     shows that person Active rather than Invited; issue another link.
//   - One link completed twice at once on two instances: the last write wins
//     and, because each completion adds its own random amount to the epoch,
//     only the winner's session survives. The loser finds they cannot sign in.
// Both need the setup link itself, which only the admin and the colleague hold.
//
// ENUMERATION. A token that is wrong, expired, already used, or belongs to an
// account that is not waiting to be set up all get the same answer. Only
// someone holding a live token hears anything more specific (a password too
// short), and that person is the colleague it was made for.

import { storeState, loadUsers, cachedUsers, userKey } from './_store.mjs';
import {
  INVITE_TOKEN_RE, sha256, hexEqual, passwordProblem, hashPassword, writeItems, writesConfigured,
  makeThrottle, clientKey, readJsonBody, nextEpoch
} from './_accounts.mjs';

// Failures per address: ten in fifteen minutes. A token is 256 bits, so this
// is not what makes guessing one hopeless; it is what keeps somebody's script
// from spending the store's metered reads.
const perIp = makeThrottle({ windowMs: 15 * 60_000, max: 10 });
// Invites finished on this instance. The store can take ten seconds to show
// the account as set up; in that time the same link must not work again here.
const finished = new Map(); // invite hash -> time
export const _throttles = { perIp, finished };

const GENERIC = { error: 'invalid_link' };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!process.env.SESSION_SECRET || storeState() !== 'ok' || !writesConfigured()) {
    console.error('account: setup needs SESSION_SECRET, GLOBAL_CONFIG and VERCEL_API_TOKEN');
    return res.status(503).json({ error: 'setup_unavailable' });
  }

  const client = clientKey(req);
  const now = Date.now();
  if (perIp.blocked(client, now)) return res.status(429).json({ error: 'too_many_attempts' });
  perIp.count(client, now);  // withdrawn below if this turns out to be a good request

  const body = await readJsonBody(req);
  const token = typeof body.token === 'string' ? body.token : '';
  if (!INVITE_TOKEN_RE.test(token)) return res.status(400).json(GENERIC);
  const inviteHash = sha256(token);

  for (const [h, at] of finished) if (now - at > 60_000) finished.delete(h);
  if (finished.has(inviteHash)) return res.status(400).json(GENERIC);

  // Every record is compared, and the loop is not cut short, so the time taken
  // says nothing about how many invites exist or where this one was.
  const find = (users) => {
    let user = null;
    for (const u of users.values()) {
      if (u.invite && hexEqual(u.invite.hash, inviteHash) && !user) user = u;
    }
    const expires = user && Date.parse(user.invite.expires);
    return user && user.status === 'invited' && Number.isFinite(expires) && now <= expires ? user : null;
  };

  // The cached list first: a miss costs no read. Only a hit is confirmed
  // against a fresh read, because acting on a 30-second-old list could accept
  // a link the admin has just replaced.
  let user;
  try {
    user = find(await cachedUsers());
    if (user) user = find(await loadUsers({ maxAgeMs: 0 }));
  } catch {
    perIp.withdraw(client, now);
    return res.status(503).json({ error: 'setup_unavailable' });
  }
  if (!user) return res.status(400).json(GENERIC);

  // A good link. From here nothing counts against the address.
  perIp.withdraw(client, now);

  if (body.password === undefined) {
    return res.status(200).json({ email: user.email, initials: user.initials });
  }

  const password = typeof body.password === 'string' ? body.password : '';
  const problem = passwordProblem(password, user.email);
  if (problem) return res.status(400).json({ error: problem });

  const value = {
    email: user.email,
    initials: user.initials,
    role: user.role,
    status: 'active',
    pw: await hashPassword(password),
    invite: null,
    // Bumped (by a random amount), so any session left over from before a
    // reset is dead, and the new ones minted after this are the only ones
    // that count.
    epoch: nextEpoch(user.epoch),
    createdAt: user.createdAt || new Date(now).toISOString().slice(0, 10)
  };
  try {
    await writeItems([{ operation: 'update', key: userKey(user.initials), value }]);
  } catch (err) {
    console.error('account: could not save the account:', err && err.message);
    return res.status(502).json({ error: 'save_failed' });
  }
  finished.set(inviteHash, now);
  console.log('account: setup completed for', user.initials);
  return res.status(200).json({ ok: true });
}
