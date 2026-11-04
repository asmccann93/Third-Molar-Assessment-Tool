// api/_layouts.mjs
//
// Per-clinician note layouts, one per consult type (3 November 2026).
//
// A LAYOUT IS AN ARRANGEMENT, NOT A SCHEMA. It says which fields and blocks
// appear, in what order, under what headings. It never changes what was
// extracted, so switching between layouts cannot alter the content of a note.
// That is the same contract the three built-in layouts have had since
// September, and it is why this can be stored at all: a layout holds no
// clinical content and nothing about any patient. It is a list of field names
// and some headings the clinician chose.
//
// WHERE THEY LIVE. On the clinician's own account item in the Global Config
// store, as `layouts`. That is deliberate and not merely convenient:
//
//   READS ARE THE THING THIS PROJECT CANNOT AFFORD TO RUN OUT OF (see
//   _store.mjs). Hobby includes 100,000 a month and going over blocks the
//   feature for 30 days, which would mean nobody could sign in at all. A
//   layout on the account item is read by the account read that already
//   happens at sign-in, so this feature costs ZERO additional reads. A
//   separate item, or a separate store, would have cost one read per session.
//
//   WRITES ARE SCARCER STILL. Hobby includes 100 a month, then $1 per 100
//   (Vercel, Global Config limits, read 3 November 2026). So a layout is saved
//   when the clinician presses Save, never as they drag, and the write goes
//   through the same throttles as every other account write.
//
// KEYS, NEVER INDICES. A saved layout is a snapshot of the fields that existed
// the day it was saved, and this tool gained three new blocks in the week
// before this was written. Had a layout stored positions, adding a block would
// have shifted every later entry onto the wrong field, silently, in a clinical
// record. Keys cannot do that: an unknown key is dropped with a reason, and a
// key that did not exist when the layout was saved is APPENDED by repair()
// rather than lost. A field must never disappear from a note because of the
// order someone chose last month.
//
// KEYS, AND NOTHING ELSE (4 November 2026). A section was [heading, [[key,
// dictated], ...]] for one day. That second element was a second copy of
// something the field already knows, and the page READ it — for whether a
// field appeared at all, for the "Dictated" tag, and for the "(dictated)"
// suffix in the pasted record. So an arrangement could contradict the field
// and make a record claim the patient had not been told something they were
// told: ['risks', true] on a consent layout dropped the material risks out of
// the note entirely on every appointment with no dictation.
//
// A layout therefore states ORDER AND HEADINGS AND NOTHING ELSE. A section is
// [heading, [key, key, ...]]. The pair shape is still READ, so a layout saved
// on 3 November keeps working, and repair() writes the key-only shape back.
// Nothing downstream is told what is dictated by a layout, ever.

/* The canonical set is supplied by the caller rather than imported, because
   the server knows FIELDS and BLOCKS from different modules than the page
   does, and a layout is only ever valid against one stated set of keys. */

export const MAX_SECTIONS = 12;
export const MAX_HEADING = 40;
// Sixteen consult types; nobody needs a layout for a type that does not exist.
export const MAX_LAYOUTS = 16;

const HEADING_OK = /^[A-Za-z0-9 ,.'()\/&-]{1,40}$/;

/* One entry of a section, as a key. A plain string is the shape a layout is
   saved in; a ['key', dictated] pair is the shape layouts saved on 3 November
   2026 hold, and its second element is DISCARDED rather than corrected,
   because nothing reads it any more. null means the entry is not an entry. */
export function keyOf(entry) {
  if (typeof entry === 'string') return entry;
  if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string') return entry[0];
  return null;
}

/* Is this a layout we are willing to store or use at all? Shape only: whether
   it covers the right keys is repair()'s business, because a layout that is
   merely OUT OF DATE is fixable and must not be thrown away. */
export function validate(layout, allKeys) {
  const problems = [];
  if (!layout || typeof layout !== 'object' || Array.isArray(layout)) {
    return { ok: false, problems: ['not an object'] };
  }
  const sections = layout.sections;
  if (!Array.isArray(sections) || !sections.length) {
    return { ok: false, problems: ['no sections'] };
  }
  if (sections.length > MAX_SECTIONS) problems.push(`more than ${MAX_SECTIONS} sections`);

  const known = new Set(allKeys);
  const seen = [];
  for (const sec of sections) {
    if (!Array.isArray(sec) || sec.length !== 2) { problems.push('a section is not [heading, keys]'); continue; }
    const [heading, keys] = sec;
    if (typeof heading !== 'string' || !HEADING_OK.test(heading)) {
      problems.push(`bad heading ${JSON.stringify(String(heading).slice(0, MAX_HEADING))}`);
    }
    if (!Array.isArray(keys)) { problems.push(`section "${heading}" has no key list`); continue; }
    for (const entry of keys) {
      const key = keyOf(entry);
      if (key === null) { problems.push('an entry is not a field or block name'); continue; }
      if (!known.has(key)) { problems.push(`unknown key ${JSON.stringify(String(key).slice(0, 40))}`); continue; }
      if (seen.indexOf(key) !== -1) problems.push(`key ${key} appears twice`);
      seen.push(key);
    }
  }
  return { ok: problems.length === 0, problems };
}

/* Bring a stored layout up to date against the keys that exist NOW.

   This is the whole safety argument for storing layouts at all. A clinician
   who saved an arrangement in October has a layout that knows nothing about
   the diagnosis list added on the 29th. The repair appends what it has never
   heard of, under a heading that says so, so the field is on screen and in the
   note. It is never dropped, and the clinician is told what moved.

   Keys that no longer exist are removed: a field deleted from the tool cannot
   be rendered, and carrying it would fail validate() forever. */
export function repair(layout, allKeys, { addedHeading = 'Added since you saved this' } = {}) {
  const known = new Set(allKeys);
  const kept = [];
  const seen = new Set();
  const removed = [];

  for (const sec of layout.sections) {
    const [heading, keys] = sec;
    const out = [];
    for (const entry of keys) {
      const key = keyOf(entry);
      if (key === null) continue;          // validate() rejects this; repair is forgiving
      if (!known.has(key)) { removed.push(key); continue; }
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(key);                       // keys only; see the header
    }
    if (out.length) kept.push([heading, out]);
  }

  const added = allKeys.filter((k) => !seen.has(k));
  if (added.length) {
    /* Appended, not inserted. Guessing where a new field belongs in someone
       else's arrangement is worse than putting it somewhere obvious and
       saying so: they can move it, and until they do it is visible rather
       than missing. */
    kept.push([addedHeading, added.slice()]);
  }

  return { sections: kept, added, removed, changed: added.length > 0 || removed.length > 0 };
}

/* Everything a clinician has saved, cleaned against the current key set.
   Anything unusable is left out rather than allowed to break the picker: a
   layout is a convenience, and no arrangement is worth a page that will not
   render a note. */
export function usable(layouts, allKeys, validTypes) {
  const out = {};
  const dropped = [];
  if (!layouts || typeof layouts !== 'object' || Array.isArray(layouts)) return { out, dropped };
  for (const type of Object.keys(layouts)) {
    if (validTypes && validTypes.indexOf(type) === -1) { dropped.push(type); continue; }
    const v = validate(layouts[type], allKeys);
    // A layout that is merely out of date fails on coverage, not on shape, so
    // shape is what disqualifies it here; repair() handles the rest.
    if (!v.ok) { dropped.push(type); continue; }
    out[type] = repair(layouts[type], allKeys);
  }
  return { out, dropped };
}

/* What a layout costs in the store, measured the way users.mjs measures a
   user record, so the caller can refuse a save that would crowd out the staff
   list. The store holds who may sign in; that must never lose to a layout. */
export function bytesOf(layouts) {
  try { return JSON.stringify(layouts || {}).length; } catch { return Infinity; }
}
