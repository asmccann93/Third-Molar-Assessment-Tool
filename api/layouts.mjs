// api/layouts.mjs
//
// Saving one note layout for one consult type (3 November 2026).
//
// READING is not here: layouts come back with GET /api/auth, out of the
// cached staff list, so they cost no Global Config reads. This endpoint is
// the write side only.
//
// WRITES ARE THE SCARCE THING. Hobby includes 100 Global Config writes a
// month, then $1 per 100 (Vercel, Global Config limits, read 3 November
// 2026). Account operations already draw on the same allowance. So this is a
// deliberate Save, throttled like every other account write, and the page
// must never call it as the clinician drags something.
//
// WHAT IS STORED is an arrangement: field names, headings, and whether each
// is dictated. No clinical content, nothing about any patient, nothing about
// a consultation. The premise the DPIA rests on is untouched.

import { resolveSession, storeState, loadUsers, userKey, storeBytes } from './_store.mjs';
import { readCookie } from './_session.mjs';
import { writeItems, writesConfigured, makeThrottle, sameOrigin, readJsonBody } from './_accounts.mjs';
import { layoutKeys, CONSULT_TYPES } from './_prompt.mjs';
import { validate, repair, bytesOf, MAX_LAYOUTS } from './_layouts.mjs';

/* The same ceiling users.mjs uses, raised on 3 November 2026. It was 7 KB
   because Vercel documented the store as 8 KB in older pages and 1 MB in
   newer ones, and 7 KB was safe against the worse reading. The current limits
   page gives 1 MB on every plan, Hobby included, so 64 KB is still only 6% of
   it and leaves the staff list all the room it will ever need.

   The guard stays because the store holds WHO MAY SIGN IN. An arrangement
   someone chose must never crowd that out. */
export const STORE_SAFE_BYTES = 64 * 1024;

// Saving a layout is a human pressing Save, not a loop.
const hourly = makeThrottle({ windowMs: 60 * 60_000, max: 12 });
const daily = makeThrottle({ windowMs: 24 * 60 * 60_000, max: 30 });
export const _writeLimit = { clear() { hourly.clear(); daily.clear(); }, hourly, daily };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  // Same reasoning as the sign-in route: a form on another site must not be
  // able to rearrange a clinician's note.
  if (!sameOrigin(req)) return res.status(403).json({ error: 'bad_origin' });

  const secret = process.env.SESSION_SECRET;
  const session = secret ? await resolveSession(secret, readCookie(req.headers.cookie)) : null;
  if (!session) return res.status(401).json({ error: 'unauthenticated' });
  // A passcode session has no account to save onto, and inventing one here
  // would be a silent upgrade of what a shared code entitles someone to.
  if (session.via !== 'account') return res.status(409).json({ error: 'no_account' });
  if (storeState() !== 'ok' || !writesConfigured()) return res.status(503).json({ error: 'store_unavailable' });

  const now = Date.now();
  if (hourly.blocked(session.who, now) || daily.blocked(session.who, now)) {
    return res.status(429).json({ error: 'write_limit' });
  }

  const body = await readJsonBody(req);
  const type = typeof body.type === 'string' ? body.type : '';
  if (!Object.prototype.hasOwnProperty.call(CONSULT_TYPES, type)) {
    return res.status(400).json({ error: 'bad_type' });
  }

  const keys = layoutKeys();
  let layouts;
  // Fresh, because this merges onto the record: a stale copy would write back
  // a status or a role that an admin has since changed. One read per save,
  // and a save is rare.
  let me;
  try {
    const users = await loadUsers({ maxAgeMs: 0 });
    me = users.get(session.who);
  } catch {
    return res.status(503).json({ error: 'store_unreadable' });
  }
  if (!me) return res.status(401).json({ error: 'unauthenticated' });

  const existing = me.layouts && typeof me.layouts === 'object' && !Array.isArray(me.layouts) ? me.layouts : {};

  if (body.layout === null) {
    layouts = { ...existing };
    delete layouts[type];
  } else {
    const v = validate(body.layout, keys);
    if (!v.ok) return res.status(400).json({ error: 'bad_layout', problems: v.problems.slice(0, 8) });
    // Stored repaired, so what comes back is already complete: a layout saved
    // today cannot be missing a field that exists today.
    const fixed = repair(body.layout, keys);
    layouts = { ...existing, [type]: { sections: fixed.sections } };
    if (Object.keys(layouts).length > MAX_LAYOUTS) return res.status(409).json({ error: 'too_many' });
  }

  const base = { email: me.email, initials: me.initials, role: me.role, status: me.status,
                 pw: me.pw, invite: me.invite, epoch: me.epoch, createdAt: me.createdAt };
  const value = Object.keys(layouts).length ? { ...base, layouts } : base;

  // What the store would grow to, measured as users.mjs measures it.
  const grown = bytesOf(layouts) - bytesOf(existing);
  if (grown > 0 && storeBytes() + grown > STORE_SAFE_BYTES) {
    return res.status(409).json({ error: 'store_full' });
  }

  hourly.count(session.who);
  daily.count(session.who);
  try {
    await writeItems([{ operation: 'update', key: userKey(me.initials), value }]);
  } catch (err) {
    console.error('layouts: store write failed for', me.initials, err && err.message);
    return res.status(502).json({ error: 'save_failed' });
  }
  return res.status(200).json({ ok: true, layouts });
}
