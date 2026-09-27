// api/checklist.mjs
//
// The procedure checklist for one consult type, as the clinician reads it, so
// the AI Notes page can show it WHILE recording (27 September 2026): the
// clinician covers the items before pressing Stop rather than finding out
// afterwards from the "Not said" list.
//
// The wording is the reviewed checklist in _checklists.mjs, with the "Not
// mentioned:" lead-in taken off each line (checklistTopics). Nothing about any
// patient goes in or comes out: the consult type is the only input, and an
// unknown one simply has no checklist.
//
// Signed-in only. middleware.js gates every /api/ path; this re-checks, like
// the other handlers, in case the gate let the request in on an older copy of
// the staff list.

import { checklistTopics } from './_checklists.mjs';
import { sessionStillGood } from './_store.mjs';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!(await sessionStillGood(req))) {
    return res.status(401).json({ error: 'unauthenticated' });
  }

  let type = null;
  if (req.query && typeof req.query.type === 'string') type = req.query.type;
  else {
    try { type = new URL(req.url || '/', 'http://x').searchParams.get('type'); } catch { type = null; }
  }
  // Own-property lookup and a length cap happen in checklistFor; an unknown or
  // missing type is an empty list, not an error.
  return res.status(200).json({ items: checklistTopics(typeof type === 'string' ? type.slice(0, 64) : null) });
}
