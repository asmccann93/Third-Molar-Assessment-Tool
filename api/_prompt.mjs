/**
 * AI Notes — extraction prompt
 * oralsurgeryassess.com/ai-notes/
 *
 * Deploy to: api/_prompt.mjs   (see note on file extension in HANDOFF-NOTES.md)
 * The underscore prefix keeps this off Vercel's route table.
 *
 * This is the file you will change most. Everything else is plumbing.
 */

/* ------------------------------------------------------------------ *
 * Consult types
 * Emphasis hints only. The spine never changes.
 * ------------------------------------------------------------------ */

export const CONSULT_TYPES = {
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

/* ------------------------------------------------------------------ *
 * System prompt
 * ------------------------------------------------------------------ */

export function buildSystemPrompt(consultTypeKey) {
  const type = CONSULT_TYPES[consultTypeKey];

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

## GAPS

Every field you cannot fill from the transcript becomes an explicit gap. Never silently omit a field, and never soften a gap into vague prose.

Set the field to null and add a plain-English entry to the gaps array naming what is missing, e.g. "No alternatives discussed" or "Costs not mentioned".

The gap list is the most useful part of your output. It tells the dentist what to add before pasting. Be direct: it is better to flag a gap the dentist can dismiss than to let a real omission through.

If the transcript is too short, too garbled, or clearly not a clinical conversation, return all fields null with a single gap explaining why.

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
  "gaps": string[]
}`;
}

/* ------------------------------------------------------------------ *
 * User message
 * ------------------------------------------------------------------ */

export function buildUserMessage(transcript) {
  return `Transcript of the consultation:\n\n<transcript>\n${transcript}\n</transcript>\n\nReturn the JSON object.`;
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
  if (!Array.isArray(parsed.gaps)) throw new Error('Missing or invalid gaps array');

  // Any null field must be accounted for in gaps.
  const nulls = FIELDS.filter(([k]) => parsed[k] == null).length;
  if (nulls > 0 && parsed.gaps.length === 0) {
    throw new Error('Fields are null but no gaps were reported');
  }

  return parsed;
}
