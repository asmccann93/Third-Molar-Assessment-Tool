/**
 * AI Notes — extraction prompt
 * oralsurgeryassess.com/ai-notes/
 *
 * Deploy to: api/_prompt.mjs   (see note on file extension in HANDOFF-NOTES.md)
 * The underscore prefix keeps this off Vercel's route table.
 *
 * This is the file you will change most. Everything else is plumbing.
 */

import { checklistFor } from './_checklists.mjs';

/* ------------------------------------------------------------------ *
 * Consult types
 * Emphasis hints only. The spine never changes.
 * ------------------------------------------------------------------ */

export const CONSULT_TYPES = {
  'third-molar': {
    label: 'Third molar surgery',
    emphasis:
      'Surgical removal of a wisdom tooth. Expect a specific discussion of nerve ' +
      'injury (lip, chin, tongue), the alternative of coronectomy or leaving the ' +
      'tooth, sedation options, and post-operative course. Capture exactly which ' +
      'risks the clinician named and whether temporary and permanent were distinguished.',
  },
  'implant-consult': {
    label: 'Implant consult',
    emphasis:
      'Planning discussion for a dental implant. Expect staging and timeline, the ' +
      'possible need for grafting or a sinus lift, failure and peri-implantitis, ' +
      'maintenance for life, the full cost including the crown, any guarantee, and ' +
      'the alternatives of a denture, a bridge, or leaving the space.',
  },
  'implant-surgery': {
    label: 'Implant surgery',
    emphasis:
      'The surgical appointment. The conversation is usually brief: re-confirming ' +
      'consent, post-operative instructions, review. The substance is DICTATED by ' +
      'the clinician afterwards — the implant log in particular.',
  },
  'exam-recall': {
    label: 'Exam / recall',
    emphasis:
      'Routine examination. Expect findings, oral hygiene advice, lifestyle advice ' +
      '(smoking, alcohol, diet), radiographic justification, and a recall interval.',
  },
  restorative: {
    label: 'Restorative',
    emphasis:
      'Expect discussion of restoration options, materials, longevity expectations, ' +
      'and the possibility of future endodontic treatment or extraction.',
  },
  perio: {
    label: 'Perio',
    emphasis:
      'Expect discussion of diagnosis, oral hygiene, smoking, the role of the patient ' +
      'in the outcome, and that treatment stabilises rather than cures.',
  },
  endo: {
    label: 'Endo',
    emphasis:
      'Expect discussion of success rates, number of visits, the alternative of ' +
      'extraction, and the need for a definitive restoration afterwards.',
  },
  'extraction-surgery': {
    label: 'Extraction / surgery',
    emphasis:
      'Expect discussion of specific surgical risks, post-operative course, and ' +
      'aftercare. Capture exactly which risks the clinician named — do not generalise.',
  },
  emergency: {
    label: 'Emergency',
    emphasis:
      'Expect a focused history, immediate management, and a plan for definitive ' +
      'treatment. The discussion may be short and the record correspondingly thin.',
  },
  'treatment-plan': {
    label: 'Treatment plan consult',
    emphasis:
      'Expect several options compared, sequencing, costs, and time to consider. ' +
      'Alternatives and costs are usually the substance of this appointment.',
  },
  sedation: {
    label: 'Sedation',
    emphasis:
      'Expect discussion of the sedation technique, escort arrangements, pre- and ' +
      'post-operative instructions, and fitness to be sedated.',
  },
};

/* ------------------------------------------------------------------ *
 * Output shape
 * ------------------------------------------------------------------ */

export const FIELDS = [
  ['reasonForAttendance', 'Reason for attendance / what is being discussed'],
  ['medicalHistory', 'Medical history relevant to this discussion, changes flagged'],
  ['proposed', 'What was proposed'],
  ['alternatives', 'Reasonable alternatives, including no treatment'],
  ['risks', 'Material risks named, per option'],
  ['benefits', 'Benefits and realistic expectations'],
  ['costs', 'Costs discussed'],
  ['patientQuestions', "Patient's own questions and concerns"],
  ['patientFactors', 'Patient-specific factors making a risk material to them'],
  ['informationGiven', 'Information given — leaflet, link, tool output, verbal aftercare'],
  ['decision', 'Decision, or deferred, and whether time to consider was offered'],
  ['nextStep', 'Next step'],
];

/* Filled ONLY from a dictated section, never from the conversation. Optional:
   null here is not a gap, because most consultations have no dictation. */
export const DICTATED_FIELDS = [
  ['examination', 'Examination findings (dictated)'],
  ['radiographicFindings', 'Radiographic findings (dictated)'],
  ['plan', 'Treatment plan (dictated)'],
];

/* Structured, for implant surgery only. Traceability: system, size, lot. */
export const IMPLANT_LOG_FIELDS = ['site', 'system', 'diameter', 'length', 'lot', 'torque', 'isq', 'graft', 'notes'];

/* ------------------------------------------------------------------ *
 * System prompt
 * ------------------------------------------------------------------ */

function consultType(key) {
  if (typeof key !== 'string') return null;
  if (!Object.prototype.hasOwnProperty.call(CONSULT_TYPES, key)) return null;
  return CONSULT_TYPES[key];
}

export const NOTE_LENGTHS = {
  brief:    'BRIEF. One or two sentences per field, and only what is clinically necessary. Do not pad a field to fill it; null is better than filler.',
  standard: 'STANDARD. Enough detail that a colleague reading it later understands what was discussed and decided.',
  full:     'FULL. Capture the discussion thoroughly, including the patient\'s own phrasing where it matters. Still never add anything that was not said.'
};

export function buildSystemPrompt(consultTypeKey, length) {
  const type = consultType(consultTypeKey);
  const checklist = checklistSection(consultTypeKey);
  const lengthRule = NOTE_LENGTHS[length] || NOTE_LENGTHS.standard;

  return `You extract a draft clinical note from a transcript of a dental consultation. A UK dentist will read your draft, correct it, and paste it into the patient's record.

You are a transcription and structuring tool. You are not a clinical decision aid.

## THE ONE RULE

Write only what was actually said in the transcript.

This is the rule the whole tool depends on, and the way you will most likely fail is by being helpful. You know what a dental consent discussion normally contains. You know the standard risks of an extraction, the usual alternatives to a crown, the customary post-operative advice. None of that knowledge may enter the note.

If the clinician did not say it, it did not happen, and it does not go in the record.

Concretely, you must never:
- add a risk to the risks field because it is a standard risk of that procedure
- add "no treatment" to alternatives unless the clinician actually raised it
- infer a diagnosis the clinician did not state
- infer that consent was valid, or that the patient understood
- convert a vague statement into a specific one ("I explained the risks" is not a list of risks — it is a gap)
- smooth over a thin discussion so it reads better

A note that honestly records a thin discussion is useful. A note that invents a thorough one is dangerous.

## SPEAKERS

The transcript is diarised. Work out from context who is the clinician, who is the patient, and who is the dental nurse.

- A risk counts as named only if the CLINICIAN named it. If the patient raises a risk and the clinician does not respond to it, that belongs in patientQuestions, not risks.
- NURSE speech is excluded from the note, with one exception: where the nurse gives post-operative or aftercare instructions, record that under informationGiven and attribute it to her.
- Where an accompanying adult speaks (parent, partner, carer), their contributions go in patientQuestions, marked as coming from the accompanying person.

## WHO IS WHO

The transcript labels speakers S1, S2 and so on. You work out which is the
clinician and which is the patient from what they say. Report that mapping so
the clinician can check it, because a swap is otherwise invisible and would put
the patient's words in the clinician's mouth.

- "speakers": an object mapping each label that appears to "clinician",
  "patient", or "other" (a nurse, relative, or interpreter).
- "speakerConfidence": "high", "medium" or "low". Say low when the roles are
  genuinely unclear — a short recording, or a transcript where both parties ask
  and answer in similar proportion. Do not be polite about this.
- If you are unsure, still map them, but say low. Never leave a label out.

## LENGTH

Write at this level of detail: ${lengthRule}

Length changes how much you write, never what you are allowed to write. Every
rule above still holds at every length: nothing invented, nothing implied, gaps
reported honestly.

## CHECKLIST
${checklist}

## DICTATION

The clinician may DICTATE after the patient has left. If so, a line reading
[DICTATION ...] appears in the transcript and everything after it is the clinician
speaking alone: examination findings, radiographic findings, the plan, and — for
implant surgery — the implant log.

- Dictated content fills ONLY examination, radiographicFindings, plan, and
  implantLog. Record it as dictated; do not rewrite it into a consent discussion.
- The consent fields (proposed, alternatives, risks, benefits, costs,
  patientQuestions, patientFactors, informationGiven, decision) come ONLY from the
  conversation with the patient. Something the clinician dictated to the record
  was not said to the patient and must not appear as if it was.
- If there is no dictation, set examination, radiographicFindings and plan to
  null and do NOT add gaps for them — they are optional.
- implantLog: an array, one object per implant placed, with the keys site, system,
  diameter, length, lot, torque, isq, graft, notes — each a string or null. Take
  values exactly as dictated. Empty array if none.

## PAUSED RECORDINGS

The clinician can pause the recording, typically to examine or treat the patient,
and resume for the post-operative discussion. When that has happened you are told
so before the transcript, with the point in the recording where each gap falls.

A paused recording is spliced. The audio either side of a gap is contiguous in the
transcript but was NOT spoken contiguously — minutes or an hour of unrecorded
appointment may sit between.

- Never assert or imply a sequence across a gap. Do not write that the patient
  agreed "after" being told something, or that advice "followed" a discussion,
  where the two sit on opposite sides of a gap.
- Do not treat a topic raised before a gap and answered after it as one exchange.
- Add a gaps entry naming what was not recorded, e.g. "Recording paused for the
  examination; anything discussed during it is not in this note."
- Everything else is unchanged: record only what was said, and attribute it
  normally. A gap is missing time, not a reason to hedge what IS on the recording.

## GAPS

Every field you cannot fill from the transcript becomes an explicit gap. Never silently omit a field, and never soften a gap into vague prose.

Set the field to null and add a plain-English entry to the gaps array naming what is missing, e.g. "No alternatives discussed" or "Costs not mentioned".

The gap list is the most useful part of your output. It tells the dentist what to add before pasting. Be direct: it is better to flag a gap the dentist can dismiss than to let a real omission through.

If the transcript is too short, too garbled, or clearly not a clinical conversation, return all fields null with a single gap explaining why.

Do not itemise individual missing risks or alternatives here — that is the checklist's job below, and the clinician would otherwise see the same omission twice, once in each list. A gap here should describe a FIELD with nothing usable in it (e.g. "No alternatives discussed", "Costs not mentioned"), not restate a single checklist item (do not write "Bleeding not mentioned as a risk" — the checklist already covers that).

## PATIENT QUESTIONS

Keep the patient's own words. Lightly tidy false starts and filler, but do not paraphrase into clinical language.

Good: "Will I be numb forever?"
Bad: "Patient expressed concern regarding the duration of altered sensation."

The patient's actual words are the most valuable thing in this note, and the thing you are most tempted to destroy.

## IDENTIFIERS

Do not write names, dates of birth, addresses or contact details into the note, even if they are spoken. The dentist matches the note to the patient by pasting it into the correct record. Write "the patient" throughout.

## STYLE

- UK dental English. Standard abbreviations are fine (MH, OHI, BPE, LA, RCT, XLA).
- FDI notation for teeth where the clinician uses numbers; keep their notation if they use Palmer.
- Concise clinical register — this is a record, not prose.
- Do not include headings, preamble, or commentary. The JSON fields are the structure.

## THIS APPOINTMENT

Type: ${type ? type.label : 'Not specified'}
${type ? type.emphasis : 'No emphasis hint — treat as a general consultation.'}

The type is a hint about what to listen for. It is not permission to assume any of it happened.

## OUTPUT

Return a single JSON object and nothing else. No markdown fences, no explanation.

{
  "reasonForAttendance": string | null,
  "medicalHistory": string | null,
  "proposed": string | null,
  "alternatives": string | null,
  "risks": string | null,
  "benefits": string | null,
  "costs": string | null,
  "patientQuestions": string | null,
  "patientFactors": string | null,
  "informationGiven": string | null,
  "decision": string | null,
  "nextStep": string | null,
  "examination": string | null,
  "radiographicFindings": string | null,
  "plan": string | null,
  "implantLog": object[],
  "checklist": { "<key>": string | null, ... },
  "speakers": { "S1": "clinician" | "patient" | "other", ... },
  "speakerConfidence": "high" | "medium" | "low",
  "gaps": string[]
}`;
}

function checklistSection(consultTypeKey) {
  const items = checklistFor(consultTypeKey);
  if (!items.length) {
    return 'No procedure checklist applies to this consult type. Return "checklist": {}.';
  }
  const lines = items.map((i) => `- "${i.key}": ${i.ask}`).join('\n');
  return `For this consult type, report against each item below. For each key, if the transcript contains it, give a SHORT quote or paraphrase (under 20 words) as evidence. If it does not, give null. This is the only place the model looks for what was NOT said; report honestly — a null here becomes a gap the dentist will see.

Rules: evidence must come from the CLINICIAN's speech unless the item says otherwise. Do not treat the patient raising something as the clinician having named it. Do not infer: "we went through the risks" is null for every specific risk. Every key must appear.

${lines}`;
}

/* ------------------------------------------------------------------ *
 * User message
 * ------------------------------------------------------------------ */

export function buildUserMessage(transcript, pauses) {
  const list = Array.isArray(pauses) ? pauses.filter((p) => p && p.forMs > 1000) : [];
  if (!list.length) {
    return `Transcript of the consultation:\n\n<transcript>\n${transcript}\n</transcript>\n\nReturn the JSON object.`;
  }
  const mins = (ms) => {
    const m = Math.round(ms / 60000);
    return m < 1 ? 'under a minute' : `${m} minute${m === 1 ? '' : 's'}`;
  };
  const at = (ms) => {
    const t = Math.round(ms / 1000);
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  };
  const lines = list.map((p) => `- at ${at(p.atRecordedMs)} into the recording, paused for ${mins(p.forMs)}`).join('\n');
  return `This recording was PAUSED and resumed. The transcript is spliced: the audio either side of each gap below is contiguous in the transcript but was not spoken contiguously.\n\n${lines}\n\nApply the PAUSED RECORDINGS rules.\n\nTranscript of the consultation:\n\n<transcript>\n${transcript}\n</transcript>\n\nReturn the JSON object.`;
}

/* ------------------------------------------------------------------ *
 * Response validation
 * Defensive: a malformed response must fail loudly, never silently
 * produce a note with missing fields.
 * ------------------------------------------------------------------ */

export function parseNote(raw) {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error('Model did not return valid JSON');
  }

  for (const [key] of FIELDS) {
    if (!(key in parsed)) throw new Error(`Missing field: ${key}`);
  }
  // Dictated fields are optional in the RESPONSE too — an older prompt, or a
  // model that omits them, must not fail the whole note. Absent means null.
  for (const [key] of DICTATED_FIELDS) {
    if (!(key in parsed)) parsed[key] = null;
  }
  if (!('implantLog' in parsed) || parsed.implantLog === null) parsed.implantLog = [];
  if (!Array.isArray(parsed.implantLog)) throw new Error('implantLog is not an array');
  parsed.implantLog = parsed.implantLog.map((row, i) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`implantLog row ${i} is not an object`);
    const out = {};
    for (const k of IMPLANT_LOG_FIELDS) {
      const v = row[k];
      if (v === undefined || v === null) { out[k] = null; continue; }
      if (typeof v !== 'string' && typeof v !== 'number') throw new Error(`implantLog row ${i} field ${k} is not text`);
      out[k] = String(v);
    }
    return out;
  });
  // Speaker mapping is advisory: a model that omits it must not cost the note.
  if (!parsed.speakers || typeof parsed.speakers !== 'object' || Array.isArray(parsed.speakers)) {
    parsed.speakers = null;
  } else {
    const clean = {};
    for (const [k, v] of Object.entries(parsed.speakers)) {
      if (typeof k === 'string' && typeof v === 'string' && /^(clinician|patient|other)$/i.test(v)) clean[k] = v.toLowerCase();
    }
    parsed.speakers = Object.keys(clean).length ? clean : null;
  }
  parsed.speakerConfidence = /^(high|medium|low)$/i.test(parsed.speakerConfidence || '')
    ? String(parsed.speakerConfidence).toLowerCase() : null;

  if (!('checklist' in parsed) || parsed.checklist === null) parsed.checklist = {};
  if (typeof parsed.checklist !== 'object' || Array.isArray(parsed.checklist)) throw new Error('checklist is not an object');
  if (!Array.isArray(parsed.gaps)) throw new Error('Missing or invalid gaps array');

  // Any null field must be accounted for in gaps.
  const nulls = FIELDS.filter(([k]) => parsed[k] == null).length;
  if (nulls > 0 && parsed.gaps.length === 0) {
    throw new Error('Fields are null but no gaps were reported');
  }

  return parsed;
}

/* ------------------------------------------------------------------ *
 * Patient summary
 * A second call over the same transcript. Plain English, second person,
 * and the same iron rule as the note: nothing that was not said.
 * ------------------------------------------------------------------ */

export const SUMMARY_FIELDS = [
  ['whatWeDiscussed', 'What we discussed'],
  ['whatYouDecided', 'What you decided'],
  ['whatHappensNext', 'What happens next'],
  ['whatToExpect', 'What to expect afterwards'],
  ['yourQuestions', 'Questions you asked, and what was said'],
];

export function buildSummarySystemPrompt(consultTypeKey) {
  const type = consultType(consultTypeKey);
  return `You write a short plain-English summary of a dental consultation FOR THE PATIENT to take home. A UK dentist will read it, correct it, and give or send it to the patient.

Write in the second person, to the patient ("you", "your tooth"). Warm, plain, no jargon: if a clinical term was used in the room and explained, use the explanation; if it was not explained, keep the term and do not explain it yourself.

THE RULE THAT MATTERS MOST: include only what was actually said in the consultation. Do not add reassurance, advice, risks, aftercare, or facts the dentist did not say. Do not soften or strengthen anything. If a section has nothing that was said, return null for it — an honest blank is better than a helpful invention.

- whatWeDiscussed: the problem and the options that were talked through, in the dentist's words made plain.
- whatYouDecided: the decision, or that no decision was made yet and why, and any time given to think.
- whatHappensNext: the next appointment, referral, or step, as stated.
- whatToExpect: only aftercare or expectations the dentist actually described.
- yourQuestions: the questions the patient asked, and what the dentist said in reply. Keep the patient's own wording where possible.

Never invent a name, date, cost, or number that was not spoken. Never say "your dentist recommends" unless the dentist did. If the recording was paused, do not imply that things either side of the pause happened one after the other.

Consult type: ${type ? type.label : 'Not specified'}

Return ONLY a JSON object with exactly these keys, each a string or null:
{
  "whatWeDiscussed": string | null,
  "whatYouDecided": string | null,
  "whatHappensNext": string | null,
  "whatToExpect": string | null,
  "yourQuestions": string | null
}`;
}

export function parseSummary(raw) {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  let parsed;
  try { parsed = JSON.parse(cleaned); } catch { throw new Error('Model did not return valid JSON'); }
  const out = {};
  for (const [key, label] of SUMMARY_FIELDS) {
    const v = parsed[key];
    if (v === undefined || v === null) { out[key] = null; continue; }
    if (typeof v !== 'string') throw new Error(`Summary field "${key}" (${label}) came back as ${typeof v}, not text`);
    out[key] = v;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Referral (SBAR)
 * A third product from the same transcript: the clinical narrative for a
 * referral, laid out as Situation / Background / Assessment /
 * Recommendation, for the clinician to paste into the free-text field of
 * an e-referral form.
 *
 * It deliberately carries NO patient identifiers. SCI Gateway already has
 * the demographics from the practice system, and keeping names, CHI
 * numbers and dates of birth out of this tool is the property the DPIA
 * rests on. Never add a header, an address block, or a salutation.
 *
 * A referral leaves the practice, so the never-invent rule bites harder
 * here than anywhere else in the tool. A note with a gap is completed by
 * the person who wrote it; a referral with an invented negative is a false
 * clinical statement read by someone who cannot check it.
 * ------------------------------------------------------------------ */

export const REFERRAL_FIELDS = [
  ['situation', 'Situation'],
  ['background', 'Background'],
  ['assessment', 'Assessment'],
  ['recommendation', 'Recommendation'],
];

export function buildReferralSystemPrompt(consultTypeKey) {
  const type = consultType(consultTypeKey);
  return `You draft the clinical narrative of a dental referral for a UK clinician to check, correct and paste into an e-referral form. Write it in SBAR: Situation, Background, Assessment, Recommendation.

YOUR SOURCES, IN ORDER OF AUTHORITY:

1. THE CORRECTED NOTE. The clinician has already read this note and fixed it. It is the authoritative account of the consultation. Prefer it over the transcript wherever the two differ — a difference means the clinician corrected something, and the correction wins.
2. THE CLINICIAN'S ADDED CONTEXT, if present. This is the clinician writing directly to you about this patient. Treat it as stated fact, exactly as if it had been dictated.
3. THE TRANSCRIPT. Secondary. Use it only for detail the note and context do not carry — a duration, a phrase the patient used, something said but not written up. Never contradict the note with it.

THE RULE THAT MATTERS MOST: absence of mention is NOT a negative finding. If any source SAYS the patient is medically fit and well, write that — a stated negative is a finding and belongs in the referral. If the medical history simply never came up, the Background is null, and you must NOT write "no relevant medical history", "fit and well", "nil of note", "no medications" or any equivalent. The same goes for allergies, smoking, anticoagulants, oral hygiene and previous treatment. The test is always the same: did someone say it? Say nothing rather than say nothing-was-found.

The note's dictated fields — examination, radiographic findings and plan — are usually where the referral's clinical substance lives, because the conversation with the patient rarely contains it. Use them in full.

- situation: why this patient is being referred now — the presenting problem and, if stated, its duration and any urgency. Not a diagnosis unless the clinician gave one.
- background: relevant history ACTUALLY STATED — medical history, medications, previous treatment or attempts, oral hygiene, social factors affecting the referral. Null if none was stated.
- assessment: examination and radiographic findings as described, and the working diagnosis ONLY if the clinician gave one. Do not derive a diagnosis from the findings yourself.
- recommendation: what is being asked of the receiving service, and what the patient has been told to expect, as stated.

REGISTER. Write as one clinician writes to another: third person about the patient, complete sentences, unhurried but not padded. Note fields and dictation are telegraphic and your job is to make them read properly WITHOUT adding anything — "moderate crowding upper arch, posterior crossbite, OH good" becomes "There is moderate crowding in the upper arch and a posterior crossbite. Oral hygiene is good." Expanding the grammar is required; expanding the content is forbidden. Put the ask plainly and courteously, in the form "Please could you see this patient for an orthodontic assessment." Do not use headings inside a section, do not use bullet points, and do not begin every section with "The patient".

Write nothing that is not in one of the three sources. No salutation, no sign-off, no letterhead. NEVER include the patient's name, date of birth, CHI number, address, or the practice's details — the referral form carries those already. If a name appears in any source, write "the patient".

Do not grade urgency yourself and do not choose a destination service or specialty.

redFlags: quote briefly anything in the sources that the clinician should check against urgent-pathway criteria before sending — for example unexplained ulceration, a red or mixed red-and-white patch, a neck lump, or systemic signs of spreading infection such as trismus, difficulty swallowing or breathing, or voice change. Report the words used; do NOT say what they might mean, do not name a pathway, and do not suggest a diagnosis. Empty array if there are none. Never add a red flag that is not in a source.

If the recording was paused, the transcript is spliced: do not imply that things either side of a gap happened in sequence.

Consult type: ${type ? type.label : 'Not specified'}

Return ONLY a JSON object with exactly these keys:
{
  "situation": string | null,
  "background": string | null,
  "assessment": string | null,
  "recommendation": string | null,
  "redFlags": string[]
}`;
}

/* The note the clinician corrected leads; their added context follows; the
   transcript trails as backup. Order on the page is order of authority, and the
   system prompt says so explicitly. */
export function buildReferralUserMessage(note, context, transcriptMessage) {
  const parts = ['THE CORRECTED NOTE (authoritative):'];
  const all = [...FIELDS, ...DICTATED_FIELDS];
  let any = false;
  for (const [key, label] of all) {
    const v = note && note[key];
    if (typeof v !== 'string' || !v.trim()) continue;
    any = true;
    parts.push(`${label}: ${v.trim()}`);
  }
  if (!any) parts.push('(The note is empty. Work from the context and transcript below.)');
  if (context && context.trim()) {
    parts.push('', "THE CLINICIAN'S ADDED CONTEXT (stated fact):", context.trim());
  }
  parts.push('', 'THE TRANSCRIPT (secondary — for detail the note does not carry):', transcriptMessage);
  return parts.join('\n');
}

export function parseReferral(raw) {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  let parsed;
  try { parsed = JSON.parse(cleaned); } catch { throw new Error('Model did not return valid JSON'); }
  const out = {};
  for (const [key, label] of REFERRAL_FIELDS) {
    const v = parsed[key];
    if (v === undefined || v === null) { out[key] = null; continue; }
    if (typeof v !== 'string') throw new Error(`Referral field "${key}" (${label}) came back as ${typeof v}, not text`);
    out[key] = v;
  }
  // A non-array, or entries that are not strings, means the model ignored the
  // shape. Drop them rather than render junk as a clinical warning.
  out.redFlags = Array.isArray(parsed.redFlags)
    ? parsed.redFlags.filter((f) => typeof f === 'string' && f.trim()).map((f) => f.trim())
    : [];
  return out;
}

/* ------------------------------------------------------------------ *
 * Ask
 * A question about THIS consultation, answered from the transcript and
 * from nothing else. Deliberately not a clinical assistant: it reports
 * what was said, it does not advise on what should have been.
 * ------------------------------------------------------------------ */

export function buildAskSystemPrompt(consultTypeKey) {
  const type = consultType(consultTypeKey);
  return `A UK dentist has just recorded a consultation and is checking the draft note against the transcript. Answer their question about what was said.

You have one source: the transcript below. You are not a clinical decision aid and you must not become one.

- Answer ONLY from the transcript. If it is not there, say plainly that it was not discussed, or that the transcript does not show it.
- Quote the relevant words where that answers the question better than a paraphrase. Attribute them: the clinician said, the patient asked.
- Never say what SHOULD have been discussed, never give clinical advice, never suggest a diagnosis or a treatment, and never comment on the standard of the consultation. If the question asks for any of that, answer only the factual part and say you cannot advise on the rest.
- Never infer. "We covered the risks" is not evidence that a specific risk was named.
- If the recording was paused, remember that the transcript is spliced and things either side of a gap were not necessarily said in sequence.
- Be short. Two or three sentences is usually enough.

Consult type: ${type ? type.label : 'Not specified'}

Reply as plain prose. No JSON, no headings, no preamble.`;
}
