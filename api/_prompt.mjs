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
      'risks the clinician named and whether temporary and permanent were distinguished. ' +
      'RADIOGRAPHS: where the clinician dictates radiographic findings, record the ' +
      'specific signs they named, in their words, rather than summarising them as ' +
      '"close to the nerve". The signs that matter are the relationship of the roots ' +
      'to the inferior alveolar canal — darkening of the root where the canal crosses ' +
      'it, interruption or loss of the canal\'s white lines, diversion or deflection ' +
      'of the canal, narrowing of the canal or of the root, a bifid root apex — ' +
      'together with the impaction (mesioangular, distoangular, horizontal, vertical), ' +
      'the depth, and the root morphology. Record only the signs actually named. Do ' +
      'NOT infer a sign from a warning, and do NOT infer a warning from a sign.',
  },
  'implant-consult': {
    label: 'Implant consult',
    emphasis:
      'Planning discussion for a dental implant. Expect staging and timeline, the ' +
      'possible need for grafting or a sinus lift, failure and peri-implantitis, ' +
      'maintenance for life, the full cost including the crown, any guarantee, and ' +
      'the alternatives of a denture, a bridge, or leaving the space. ' +
      'RADIOGRAPHS: where radiographic or CBCT findings are dictated, record the ' +
      'specific measurements and relationships named — available bone height and ' +
      'width, the position of the inferior alveolar canal or the mental foramen for ' +
      'a lower site, the sinus floor and any residual height for an upper one, bone ' +
      'quality, and the proximity of adjacent roots. Take the figures exactly as ' +
      'dictated and never round or convert them.',
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
    // A routine examination contains no consent discussion. There is no
    // procedure being weighed, so there are no alternatives, no material risks
    // and no decision — those fields are INAPPLICABLE, not missing, and must not
    // demand a gap. Getting this wrong made every recall fail to draft at all.
    // patientFactors joined in September 2026: it is defined as what makes a
    // RISK material to this patient, and a recall names no risks. The model
    // drew the same conclusion and left the key out altogether, which failed
    // every such recall at parseNote, deterministically.
    notApplicable: ['proposed', 'alternatives', 'risks', 'benefits', 'costs', 'patientFactors', 'decision'],
    emphasis:
      'There is usually NO consent discussion in a recall: no procedure proposed, no alternatives weighed, no risks or benefits named, no costs discussed, so no patient-specific factors making a risk material, and no decision taken. Leave those fields (proposed, alternatives, risks, benefits, costs, patientFactors, decision) null and do NOT add gaps for them — they do not apply to this kind of appointment. If a treatment WAS proposed and discussed, fill them normally. ' +
      'The other fields still apply to a recall — reason for attendance, medical history, the patient\'s own questions, information given and next step: if one of those is empty, leave it null AND add a gaps entry for it, as usual. ' +
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
  ['treatmentToday', 'Treatment carried out today (dictated)'],
  ['plan', 'Treatment plan (dictated)'],
];

/* Structured, for implant surgery only. Traceability: system, size, lot. */
export const IMPLANT_LOG_FIELDS = ['site', 'system', 'diameter', 'length', 'lot', 'torque', 'isq', 'graft', 'notes'];

/* Local anaesthetic given today (27 September 2026), one row per injection or
   per agent as dictated. Taken as dictated and never computed: no cartridges
   turned into millilitres or milligrams, no dose worked out or checked. */
export const LA_LOG_FIELDS = ['agent', 'strength', 'amount', 'technique', 'site', 'batch', 'notes'];

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

## WHICH TOOTH

Removing the wrong tooth is the one error in oral surgery that cannot be undone,
and the tooth reaches this note through a spoken conversation and a transcript.
"Lower left eight" and "lower right eight" differ by a single transcribed word.

- "teeth": every tooth the CLINICIAN identified as the subject of examination,
  treatment, or the treatment being proposed. FDI notation where numbers were
  used; keep their notation if they used Palmer. One entry per tooth.
- Teeth mentioned only in passing — a history of extractions, a tooth the
  patient asked about but which is not being treated — do NOT belong here.
- Never infer a tooth from the consult type. A third molar consultation does not
  mean the eights were named, and guessing which quadrant would be worse than
  saying nothing.
- Empty array if no tooth was identified. That is a real and useful answer; the
  clinician will see it and know the recording did not pin the site down.

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

If a CONFIRMED MAPPING appears in the message below, the clinician has read your
previous attempt and corrected it. It is not a hint and it is not up for
reconsideration: use it exactly for every label it names, report those labels
back unchanged in "speakers", and set "speakerConfidence" to "high" if it names
every label in the transcript. They were in the room and you were not. A label it
does not name (a later recording's, for example) is still yours to work out, and
"speakerConfidence" is then your confidence in those.

## LENGTH

Write at this level of detail: ${lengthRule}

Length changes how much you write, never what you are allowed to write. Every
rule above still holds at every length: nothing invented, nothing implied, gaps
reported honestly.

## CHECKLIST
${checklist}

## DICTATION

The clinician may DICTATE after the patient has left. If so, a line reading
[DICTATION ...] appears in the transcript and everything after it — up to the next
[SEPARATE RECORDING ...] line, if there is one — is the clinician speaking alone:
examination findings, radiographic findings, the treatment carried out, the local
anaesthetic given, the plan, and — for implant surgery — the implant log.

- Dictated content fills ONLY examination, radiographicFindings, radiographs,
  treatmentToday, plan, implantLog and laLog. Record it as dictated; do not rewrite it into a
  consent discussion.
- The consent fields (proposed, alternatives, risks, benefits, costs,
  patientQuestions, patientFactors, informationGiven, decision) come ONLY from the
  conversation with the patient. Something the clinician dictated to the record
  was not said to the patient and must not appear as if it was.
- If there is no dictation, set examination, radiographicFindings,
  treatmentToday and plan to null, radiographs to null, and implantLog and
  laLog to [], and do NOT add gaps for them — they are optional.
- treatmentToday: the treatment CARRIED OUT at this appointment, taken ONLY from
  the dictation, and only where it is described as done — the procedure, the
  tooth, what was found and used, sutures, haemostasis, any complication, as
  dictated. NEVER from the conversation, and never from what was proposed,
  agreed or planned: "we'll take it out today" is a plan, not a treatment, and
  a note that records treatment that did not happen is a false record. Write
  only what was dictated: never add "no complications", "haemostasis achieved"
  or any other negative or routine step that was not said. Take every figure,
  material and count exactly as dictated. Local anaesthetic goes in laLog, not
  here; any other drug given (sedation, for example) stays here, as dictated.
  null if no treatment was dictated.
- laLog: LOCAL ANAESTHETIC ONLY. An array, one object per local anaesthetic
  statement as dictated, with the keys agent, strength, amount, technique, site,
  batch, notes — each a string or null — and "quotes": one or two word-for-word
  extracts from the dictation where it was said, each at least four words, under
  the same rules as SOURCES. Take every value exactly as dictated: never convert
  cartridges to millilitres or milligrams, never work out or comment on a dose,
  never divide an amount between rows, and never fill in a strength or a batch
  that was not said. ONLY from the dictation. Empty array if none.
- implantLog: an array, one object per implant placed, with the keys site, system,
  diameter, length, lot, torque, isq, graft, notes — each a string or null. Take
  values exactly as dictated. Empty array if none.

## PAUSED RECORDINGS

The clinician can pause the recording, typically to examine or treat the patient,
and resume for the post-operative discussion. When that has happened you are told
so before the transcript. Where the timing allows, a line beginning [PAUSED —
(for example [PAUSED — about 12 minutes not recorded]) marks the point in the
transcript where each gap falls; otherwise the gaps are listed by time.

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

## SEPARATE RECORDINGS

The clinician can make more than one recording in the same appointment — for
example one before a radiograph is taken and one after. When that has happened,
each later recording begins with a line reading [SEPARATE RECORDING ...].

- Time passed between the recordings that was not recorded. Never assert or imply
  a sequence or a single exchange across a SEPARATE RECORDING line.
- Speaker labels restart in each recording: the second recording's speakers are
  labelled R2-S1, R2-S2 and so on, and R2-S1 is not necessarily the same person as
  S1. Work out who each label is from what they say, and map EVERY label in
  "speakers".
- A dictation line applies only within its own recording.
- If a later recording changes something said in an earlier one (a different
  decision, a different tooth), record both, say which came later, and add a gaps
  entry so the clinician checks it. Never silently keep only one.

## A TRANSCRIPT WITH NO CONSULTATION IN IT

If the transcript is empty, or contains nothing that is recognisably a
consultation — a few stray words, one side of a greeting, background noise
transcribed as speech — do NOT invent a consultation and do NOT return a note
full of nulls with an empty gaps array. Set every field to null and put ONE
entry in gaps saying plainly that nothing usable was captured, for example
"Nothing usable was recorded — check the microphone and record again." That is a
complete and correct answer to a recording that did not work.

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

## SOURCES

The dentist checks your draft against the recording. Show where each sentence
came from, so that check takes seconds rather than a replay.

"sources" is an object keyed by field name. For every text field you filled
(reasonForAttendance through plan, treatmentToday included — not implantLog,
laLog, teeth, checklist, speakers or gaps), give an array with one entry per sentence or line you wrote in that field,
in the same order:

  { "start": "<the first six words of that sentence, copied exactly from your field>",
    "quotes": ["<words copied exactly from the transcript that support it>", ...] }

- One to three quotes per sentence, each under 25 words.
- Copy each quote WORD FOR WORD from the transcript, including any transcription
  mistakes. Do not tidy, paraphrase, shorten with "...", join separate places
  together, or add speaker labels. The dentist's page searches the transcript for
  your quote; a quote that is not there is shown to them as unsupported.
- Never write a quote that is not in the transcript. If nothing in the transcript
  supports a sentence, give "quotes": [] — that honestly tells the dentist to
  check it, which is the point.
- Leave out fields that are null.

## RADIOGRAPH REPORT

"radiographs": the report of any radiographs taken, taken ONLY from the dictation.
null if no radiograph was dictated.

  { "views": string | null, "justification": string | null,
    "quality": "A" | "N" | null, "fault": string | null,
    "quotes": ["<words copied exactly from the dictation where this was said>"] }

- views: which radiographs, as dictated ("bitewings left and right", "periapical 36", "OPT").
- justification: why they were taken, as dictated. Never supply a reason that was not said,
  and never work one out from the findings or the consult type.
- quality: "A" only if the image was dictated as diagnostically acceptable (or "A"); "N"
  only if dictated as not acceptable (or "N"); otherwise null. Never convert another
  grading (such as 1, 2 or 3) into A or N.
- fault: for an image rated N, the fault, its likely cause and whether it was repeated, as
  dictated. null otherwise.
- Each image is graded on its own. If the images were not all given the same grade, set
  quality to null and put each image's grade, as dictated, in fault.
- quotes: one or two, word for word, at least four words, under the same rules as SOURCES.
- What the radiographs SHOW stays in radiographicFindings, exactly as before; do not repeat
  it here.

## QUESTIONS FOR THE DENTIST

The dentist fills gaps from memory before pasting. Make that quick. For each
entry in "gaps" about something missing from one of the twelve fields below,
which the dentist could answer in a few words, give ONE question in "questions":

  { "gap": "<that gaps entry, copied exactly>", "field": "<the field it would go in>",
    "ask": "<the question, under 15 words>" }

- field is one of: reasonForAttendance, medicalHistory, proposed, alternatives,
  risks, benefits, costs, patientQuestions, patientFactors, informationGiven,
  decision, nextStep.
- Ask what happened, neutrally: "Were costs discussed? If so, what was said?"
  Never suggest the answer. Never name a risk, alternative, drug, figure or tooth
  that is not already in the transcript: the question must not put anything in
  the dentist's mind that the recording does not.
- No question for a gap about the recording itself (a pause, a separate
  recording, nothing usable captured).
- Empty array if there is no such gap.

## BPE

"bpe": the Basic Periodontal Examination scores, ONLY if the clinician stated
them. Otherwise null.

  { "UR": code, "UA": code, "UL": code, "LR": code, "LA": code, "LL": code,
    "named": true | false,
    "quotes": ["<words copied exactly from the transcript where the scores were said>"] }

- code is "0" to "4", with "*" added where a furcation was called ("3*"), "X"
  where a sextant was called as excluded or not scored, and null for a sextant
  whose score was not stated.
- UR, UA, UL, LR, LA, LL are upper right, upper anterior, upper left, lower
  right, lower anterior, lower left. Where six scores are said in a row without
  naming the sextants, take them in exactly that order and set "named" to false;
  set it to true only when every score was said with its sextant.
- Never work a score out from pocket depths, bleeding, or a remark such as "gums
  look healthy", and never fill a sextant that was not stated.
- quotes: one to three, word for word, under the same rules as SOURCES.
- Put the scores here and not also in examination: the page shows them as a grid
  and adds them to the note itself.

## TO DO

"actions": the follow-up tasks for the practice that were SAID in the recording,
by the clinician or dictated — an appointment to book, a referral or letter to
send, a radiograph or scan to arrange, lab work, a prescription to issue, a review.

  [ { "text": "<the task, short, starting with a verb, e.g. Book review in two weeks>",
      "quotes": ["<words copied exactly from the transcript where it was said>"] } ]

- Only tasks actually stated. Never add one because it usually follows this kind
  of appointment.
- Take any drug, dose, time or date exactly as said, and never add one.
- No names or other identifiers.
- Empty array if none.

## OUTPUT

Return a single JSON object and nothing else. No markdown fences, no explanation.
Every key below must appear, even where it does not apply to this appointment: use null, never leave a key out.

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
  "treatmentToday": string | null,
  "plan": string | null,
  "radiographs": { "views": string | null, "justification": string | null, "quality": "A" | "N" | null, "fault": string | null, "quotes": string[] } | null,
  "implantLog": object[],
  "laLog": [ { "agent": string | null, "strength": string | null, "amount": string | null, "technique": string | null, "site": string | null, "batch": string | null, "notes": string | null, "quotes": string[] } ],
  "teeth": string[],
  "checklist": { "<key>": string | null, ... },
  "speakers": { "S1": "clinician" | "patient" | "other", ... },
  "speakerConfidence": "high" | "medium" | "low",
  "sources": { "<field>": [ { "start": string, "quotes": string[] } ], ... },
  "gaps": string[],
  "questions": [ { "gap": string, "field": string, "ask": string } ],
  "bpe": { "UR": string | null, "UA": string | null, "UL": string | null, "LR": string | null, "LA": string | null, "LL": string | null, "named": boolean, "quotes": string[] } | null,
  "actions": [ { "text": string, "quotes": string[] } ]
}`;
}

function checklistSection(consultTypeKey) {
  const items = checklistFor(consultTypeKey);
  if (!items.length) {
    return 'No procedure checklist applies to this consult type. Return "checklist": {}.';
  }
  const lines = items.map((i) => `- "${i.key}": ${i.ask}`).join('\n');
  return `For this consult type, report against each item below. For each key, if the transcript contains it, give a SHORT quote or paraphrase (under 20 words) as evidence. If it does not, give null. This is the only place the model looks for what was NOT said; report honestly — a null here becomes a gap the dentist will see.

Rules: evidence must come from the CLINICIAN's speech unless the item says otherwise. An item that says "said or dictated" may be found in the conversation OR in the dictation; every other item only in the conversation. Do not treat the patient raising something as the clinician having named it. Do not infer: "we went through the risks" is null for every specific risk. Every key must appear.

If an item does not apply to this patient or tooth (the item says when), give exactly "Not applicable: " followed by the reason, e.g. "Not applicable: lower tooth". Never "N/A" alone: that reads as not found.

${lines}`;
}

/* ------------------------------------------------------------------ *
 * User message
 * ------------------------------------------------------------------ */

const minutes = (ms) => {
  const m = Math.round(ms / 60000);
  return m < 1 ? 'under a minute' : `${m} minute${m === 1 ? '' : 's'}`;
};

/* A diarised speaker label: S1, S2 ... in the first recording, and R2-S1,
   R3-S2 ... in the recordings after it. Anything else in a mapping is dropped. */
export const SPEAKER_LABEL = /^(?:R[2-9]-)?S\d{1,2}$/;

/* The line extract.mjs puts into the transcript where a pause falls. The
   transcript carries no times, so "paused at 1:35" told the model nothing it
   could find; a line in the transcript itself is where it reads. */
export function pauseMarker(forMs) {
  const m = minutes(forMs);
  return `[PAUSED — ${m === 'under a minute' ? m : 'about ' + m} not recorded]`;
}

/* The line extract.mjs puts in front of each recording after the first, when a
   clinician has recorded more than once in the same appointment. */
export function partMarker(index, count) {
  return `[SEPARATE RECORDING ${index} of ${count} — made later in the same appointment. Time passed that was not recorded. Speaker labels restart here (R${index}-S1 is not necessarily S1), and any dictation above has ended.]`;
}

/* `note: false` for the summary, post-op sheet, referral and Ask, whose system
   prompts have no PAUSED RECORDINGS section and no speakerConfidence to set:
   they get the one rule that matters in a line of its own. `json: false` for
   Ask, which answers in prose. */
export function buildUserMessage(transcript, pauses, speakerRoles, { note = true, json = true, parts = 1 } = {}) {
  // A mapping the clinician corrected by hand. Stated first so it is read
  // before the transcript that produced the wrong answer last time.
  const confirmed = speakerRoles && typeof speakerRoles === 'object' && !Array.isArray(speakerRoles)
    ? Object.entries(speakerRoles)
        .filter(([k, v]) => SPEAKER_LABEL.test(k) && /^(clinician|patient|other)$/.test(v))
        .map(([k, v]) => `${k} is the ${v}`)
    : [];
  const roles = confirmed.length
    ? `CONFIRMED MAPPING, corrected by the clinician who was present: ${confirmed.join('; ')}.\nUse it exactly.${note ? ' Report it back unchanged and set speakerConfidence to "high" if it names every label; any label it does not name is yours to work out.' : ''}\n\n`
    : '';
  const tail = json ? '\n\nReturn the JSON object.' : '';
  // Recorded in more than one go. The note prompt has the rules in full; the
  // other products get the two that matter in a line.
  const multi = parts > 1
    ? `This consultation was recorded in ${parts} SEPARATE RECORDINGS, joined in order; each after the first begins with a [SEPARATE RECORDING ...] line. ${note ? 'Apply the SEPARATE RECORDINGS rules.' : 'Speaker labels restart in each recording, and nothing either side of a SEPARATE RECORDING line was said one straight after the other.'}\n\n`
    : '';

  const list = Array.isArray(pauses) ? pauses.filter((p) => p && p.forMs > 1000) : [];
  if (!list.length) {
    return `${roles}${multi}Transcript of the consultation:\n\n<transcript>\n${transcript}\n</transcript>${tail}`;
  }
  const at = (ms) => {
    const t = Math.round(ms / 1000);
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  };
  // Marked in the transcript wherever it had the timings to do it. Where it
  // did not, the times are still worth giving: they are all there is.
  const marked = /^\[PAUSED — /m.test(String(transcript));
  const where = marked
    ? 'Each gap is marked in the transcript by a line reading [PAUSED — ...] at the point where it falls.'
    : list.map((p) => `- at ${at(p.atRecordedMs)} into the recording, paused for ${minutes(p.forMs)}`).join('\n');
  const rule = note
    ? 'Apply the PAUSED RECORDINGS rules.'
    : `Never present things either side of ${marked ? 'a PAUSED line' : 'a gap'} as said one after the other.`;
  return `${roles}${multi}This recording was PAUSED and resumed. The transcript is spliced: the audio either side of each gap ${marked ? '' : 'below '}is contiguous in the transcript but was not spoken contiguously.\n\n${where}\n\n${rule}\n\nTranscript of the consultation:\n\n<transcript>\n${transcript}\n</transcript>${tail}`;
}

/* ------------------------------------------------------------------ *
 * Response validation
 * Defensive: a malformed response must fail loudly, never silently
 * produce a note with missing fields.
 * ------------------------------------------------------------------ */

// Consent fields that do not apply to this kind of appointment. Empty for every
// type that involves a procedure, which is the safe default: a blank there is a
// gap and must be explained.
export function notApplicableFields(consultTypeKey) {
  const type = consultType(consultTypeKey);
  return Array.isArray(type && type.notApplicable) ? type.notApplicable : [];
}

// Valid JSON is not enough: the model can return a bare string, a number or an
// array. A string reached `key in parsed`, and V8's TypeError for that QUOTES THE
// STRING — so the model's prose about the patient went into the error, into the
// Vercel log (never log payloads, R11) and onto the screen. The three secondary
// parsers accepted a string outright and returned an all-blank document. The
// message here deliberately carries nothing from the response.
function parseObject(cleaned) {
  let parsed;
  try { parsed = JSON.parse(cleaned); } catch {
    // Words around the object ("Here is the note:" before it, "Let me know..."
    // after it, a code fence in the middle of a sentence) used to refuse the
    // note, identically on every retry. The object itself is taken from the
    // first "{" to the last "}" and must still parse whole; nothing outside it
    // is kept, and nothing inside it is changed.
    const from = cleaned.indexOf('{'), to = cleaned.lastIndexOf('}');
    if (from < 0 || to <= from) throw new Error('Model did not return valid JSON');
    try { parsed = JSON.parse(cleaned.slice(from, to + 1)); } catch { throw new Error('Model did not return valid JSON'); }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Model returned ${parsed === null ? 'null' : Array.isArray(parsed) ? 'an array' : 'a ' + typeof parsed}, not a JSON object`);
  }
  return parsed;
}

/**
 * parseNote checks that every field is PRESENT. assertShape in extract.mjs
 * checks that every field is the right TYPE, which is a different failure and a
 * worse one, and this is what it lays out.
 *
 * A field returned as an object used to pass parseNote, render as
 * "[object Object]", and, because it was not null, go unreported as a gap: a
 * risk that was genuinely discussed vanished while the note called itself
 * complete. So the wrong shape was refused, and the note with it.
 *
 * Since 21 September 2026 (the clinical lead's decision) the two shapes the
 * model actually produces are laid out as text instead, because the risks
 * field is labelled "per option" and invites exactly them:
 *   - a list of strings  -> one item per line, in the model's order;
 *   - an object whose values are strings -> one "option: text" line per key,
 *     so the option each risk belongs to is kept, in the model's words.
 * Nothing is added, reordered or reworded. Anything deeper (a list of objects,
 * an object of lists, numbers standing in for text) is still refused: laying
 * that out would mean choosing a structure the model did not give.
 *
 * Here rather than in extract.mjs since 25 September 2026, so the summary,
 * post-op and referral parsers lay out the same shapes by the same rules: a
 * post-op "avoid" given as a list used to refuse the whole sheet.
 */
export function asText(v) {
  if (Array.isArray(v)) {
    const items = v.filter((x) => x !== null && x !== undefined);
    if (!items.every((x) => typeof x === 'string')) return undefined;
    const lines = items.map((x) => x.trim()).filter(Boolean);
    return lines.length ? lines.join('\n') : null;
  }
  if (v && typeof v === 'object') {
    const entries = Object.entries(v).filter(([, x]) => x !== null && x !== undefined);
    if (!entries.every(([, x]) => typeof x === 'string')) return undefined;
    const lines = entries.map(([k, x]) => [String(k).trim(), x.trim()]).filter(([, x]) => x)
      .map(([k, x]) => (k ? `${k}: ${x}` : x));
    return lines.length ? lines.join('\n') : null;
  }
  return undefined;
}

/**
 * Where each sentence of the draft came from (27 September 2026). Advisory, like
 * the speaker mapping: a model that leaves it out, or gets its shape wrong, must
 * never cost the note. null means "not given" (the page says the check could not
 * be run); an object means it was given, field by field. Nothing here is trusted:
 * the page searches the transcript for every quote and believes only what it
 * finds. Lengths are capped so a runaway answer cannot bloat the page.
 */
export function cleanSources(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const [key] of [...FIELDS, ...DICTATED_FIELDS]) {
    const list = raw[key];
    if (!Array.isArray(list)) continue;
    out[key] = list.slice(0, 60)
      .filter((e) => e && typeof e === 'object' && !Array.isArray(e))
      .map((e) => {
        const q = Array.isArray(e.quotes) ? e.quotes : (typeof e.quotes === 'string' ? [e.quotes] : []);
        return {
          start: typeof e.start === 'string' ? e.start.trim().slice(0, 200) : '',
          quotes: q.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, 400)).slice(0, 5)
        };
      });
  }
  return out;
}

/* ---- 27 September 2026 (second batch): questions, BPE, to-do ----
   All three are advisory, like sources: a model that leaves one out, or gets its
   shape wrong, costs the note nothing. None of them is trusted: every quote is
   searched for on the page, a question must answer a gap that is really in the
   list, and a BPE code must be one that exists. */

function quoteList(q) {
  const a = Array.isArray(q) ? q : (typeof q === 'string' ? [q] : []);
  return a.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, 400)).slice(0, 5);
}

// Chart order: the top row read left to right, then the bottom row.
export const BPE_SEXTANTS = ['UR', 'UA', 'UL', 'LR', 'LA', 'LL'];
const BPE_CODE = /^(?:[0-4]\*?|X)$/;

function bpeCode(v) {
  if (typeof v === 'number' && Number.isInteger(v)) v = String(v);
  v = typeof v === 'string' ? v.replace(/\s+/g, '').toUpperCase() : '';
  return BPE_CODE.test(v) ? v : null;
}

/* The shape asked for is an object keyed by sextant. The two other shapes a
   model gives for six scores — a list of six, or a line such as "2 1 2 / 3* 2 2"
   — are read in chart order, which is the order the prompt fixes for scores said
   without their sextants, and are marked as not named so the page says so.
   Anything else that was not null comes back as { unreadable: true }, so the
   note can say scores were given and could not be read, rather than showing an
   empty chart as if none were said. */
export function cleanBpe(raw) {
  if (raw === null || raw === undefined) return null;
  let src = null, named = null, quotes = [];
  if (Array.isArray(raw)) {
    src = raw.length === 6 ? raw : null;
    named = false;
  } else if (typeof raw === 'string') {
    const codes = raw.toUpperCase().match(/[0-4]\s*\*?|X|-/g) || [];
    src = codes.length === 6 && !/[A-WYZ5-9]/.test(raw.toUpperCase().replace(/BPE|UR|UA|UL|LR|LA|LL/g, '')) ? codes : null;
    named = false;
  } else if (typeof raw === 'object') {
    const keyed = {};
    for (const [k, v] of Object.entries(raw)) keyed[String(k).toUpperCase()] = v;
    src = BPE_SEXTANTS.map((s) => keyed[s]);
    named = typeof raw.named === 'boolean' ? raw.named : null;
    quotes = quoteList(raw.quotes);
  }
  const out = {};
  let any = false;
  if (src) {
    BPE_SEXTANTS.forEach((s, i) => {
      out[s] = bpeCode(src[i]);
      if (out[s]) any = true;
    });
  }
  if (!any) {
    // Nothing that is a code. Silence (nulls, blanks, "none") is no BPE; anything
    // with content in it was something, and could not be read.
    const empty = (v) => v === null || v === undefined || (typeof v === 'string' && /^\s*(none|null|nil|n\/?a|not (stated|recorded|done|taken|given))?\.?\s*$/i.test(v));
    if (typeof raw === 'string') return empty(raw) ? null : { unreadable: true };
    if (Array.isArray(raw)) return raw.every(empty) ? null : { unreadable: true };
    if (typeof raw === 'object') {
      const other = Object.keys(raw).filter((k) => k !== 'quotes' && k !== 'named' && !empty(raw[k]));
      return other.length ? { unreadable: true } : null;
    }
    return { unreadable: true };
  }
  out.quotes = quotes;
  out.named = named;
  return out;
}

export function cleanActions(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 40).map((a) => {
    if (typeof a === 'string') return { text: a, quotes: [] };
    if (!a || typeof a !== 'object' || Array.isArray(a) || typeof a.text !== 'string') return null;
    return { text: a.text, quotes: quoteList(a.quotes) };
  }).filter((a) => a && a.text.trim())
    .map((a) => ({ text: a.text.trim().replace(/\s+/g, ' ').slice(0, 300), quotes: a.quotes }))
    .slice(0, 20);
}

// The backstop's own wording (parseNote, assertShape). A gap in this form names
// its field exactly, so its question needs no model.
const BLANK_GAP = /^(.+): left blank in the draft; check whether it came up$/;

/**
 * Questions for the gaps. Only for a gap that is really in the list (matched
 * exactly, so the question cannot drift from what it answers), only into one of
 * the twelve conversation fields, and not into one that does not apply to this
 * kind of appointment. One per gap. Run after every gap has been added.
 */
export function cleanQuestions(raw, gaps, consultTypeKey) {
  const list = Array.isArray(gaps) ? gaps.filter((g) => typeof g === 'string') : [];
  const skip = new Set(notApplicableFields(consultTypeKey));
  const allowed = new Set(FIELDS.map(([k]) => k).filter((k) => !skip.has(k)));
  const out = [];
  const done = new Set();
  for (const q of (Array.isArray(raw) ? raw.slice(0, 40) : [])) {
    if (!q || typeof q !== 'object' || Array.isArray(q)) continue;
    const gap = typeof q.gap === 'string' ? q.gap.trim() : '';
    const match = list.find((g) => g.trim() === gap);
    if (!gap || match === undefined || done.has(match)) continue;
    if (typeof q.field !== 'string' || !allowed.has(q.field)) continue;
    const ask = typeof q.ask === 'string' ? q.ask.trim().replace(/\s+/g, ' ') : '';
    // A figure in a question is the question supplying an answer ("the 1 in 10
    // risk"), which the prompt forbids; refused here rather than trusted.
    if (!ask || ask.length > 200 || /\d/.test(ask)) continue;
    done.add(match);
    out.push({ gap: match, field: q.field, ask });
  }
  for (const g of list) {
    if (done.has(g)) continue;
    const m = g.trim().match(BLANK_GAP);
    const f = m && FIELDS.find(([, label]) => label === m[1]);
    if (!f || !allowed.has(f[0])) continue;
    done.add(g);
    out.push({ gap: g, field: f[0], ask: 'Anything to add from memory?' });
  }
  return out.slice(0, 20);
}

/* The LA log. Unlike the implant log, a row of the wrong shape does not cost
   the whole note: it is dropped and a gap says so, so the clinician enters it
   from what they dictated rather than finding it silently missing. */
/* The radiograph report (27 September 2026, second evening). Dictation only,
   like the other dictated fields; the findings stay in radiographicFindings.
   Quality is the A/N scale of the current UK guidance and nothing else: a
   grade that is not A or N is not converted, it is left blank for the
   clinician. Something that was given but cannot be read becomes a gap. */
export const XRAY_TEXT_FIELDS = ['views', 'justification', 'fault'];
const XRAY_NONE = /^\s*(none|null|nil|n\/?a|not (stated|taken|dictated|done))?\.?\s*$/i;

function xrayText1(v) {
  // A list of strings (views given one per image) is joined; anything else
  // that is not text is not read.
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) v = v.map((x) => x.trim()).filter(Boolean).join('; ');
  if (typeof v === 'number') return String(v);
  if (typeof v !== 'string' || !v.trim() || XRAY_NONE.test(v)) return null;
  return v.replace(/\s+/g, ' ').trim().slice(0, 300);
}

// N is tested first: "not acceptable" and "unacceptable" contain "acceptable".
function xrayQuality(q) {
  const s = String(q || '').trim();
  if (!s) return null;
  if (/^(n\b|not\b|un|diagnostically (not|un)|not diagnostically)/i.test(s)) return 'N';
  if (/^(a\b|acceptable|diagnostically acceptable)/i.test(s)) return 'A';
  return undefined;   // given, but not on the A/N scale
}

export function cleanRadiographs(raw) {
  if (raw === null || raw === undefined || raw === false) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    if (typeof raw === 'string' && XRAY_NONE.test(raw)) return null;
    if (Array.isArray(raw) && !raw.length) return null;
    return { unreadable: true };
  }
  const out = {};
  let any = false;
  for (const k of XRAY_TEXT_FIELDS) {
    out[k] = xrayText1(raw[k]);
    if (out[k]) any = true;
  }
  const q = xrayQuality(typeof raw.quality === 'string' ? raw.quality : '');
  out.quality = q || null;
  if (out.quality) any = true;
  // Content under keys it does not know, with nothing it does: something was
  // given and could not be read.
  const unknown = Object.keys(raw).some((k) => !['views', 'justification', 'fault', 'quality', 'quotes'].includes(k) &&
    raw[k] !== null && raw[k] !== undefined && raw[k] !== '' && !(typeof raw[k] === 'string' && XRAY_NONE.test(raw[k])));
  if (!any) return unknown ? { unreadable: true } : null;
  out.quotes = quoteList(raw.quotes);
  // A grade that is not A or N is left blank, and the clinician is told.
  if (q === undefined) out.offScale = String(raw.quality).trim().slice(0, 40);
  return out;
}

const LA_NONE = (v) => v === undefined || v === null || v === false || v === 0 ||
  (typeof v === 'string' && /^\s*(none|null|nil|n\/?a|not (stated|recorded|dictated|given|used))?\.?\s*$/i.test(v));

export function cleanLaLog(raw) {
  const gaps = [];
  if (LA_NONE(raw)) return { rows: [], gaps };
  const list = (Array.isArray(raw) ? raw : [raw]).filter((r) => !LA_NONE(r));
  const rows = [];
  let bad = 0;
  if (list.length > 12) bad++;
  for (const row of list.slice(0, 12)) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) { bad++; continue; }
    const out = {};
    let any = false, wrong = false;
    for (const k of LA_LOG_FIELDS) {
      const v = row[k];
      if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) { out[k] = null; continue; }
      if (typeof v !== 'string' && typeof v !== 'number') { wrong = true; out[k] = null; continue; }
      out[k] = String(v).replace(/\s+/g, ' ').trim().slice(0, 200);
      any = true;
    }
    // A row with content under keys it does not know ({drug, volume}) was
    // something, and could not be read.
    const unknown = Object.keys(row).some((k) => k !== 'quotes' && !LA_LOG_FIELDS.includes(k) && !LA_NONE(row[k]));
    if (wrong || (!any && unknown)) bad++;
    if (!any) continue;
    out.quotes = quoteList(row.quotes);
    rows.push(out);
  }
  if (bad) gaps.push('Part of the local anaesthetic record came back in a form that could not be read. Check it against what you dictated.');
  return { rows, gaps };
}

export function parseNote(raw, consultTypeKey) {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  const parsed = parseObject(cleaned);

  // A field left out is the same answer as null. Until 21 September 2026 that
  // was only accepted for fields that do not apply to the consult type.
  // Since then a field that applies but was left out is treated
  // exactly like one returned as null: it is blank, and the backstop below
  // lists it for the clinician to check. Refusing it cost the whole note, the
  // same way on every retry, over an answer ("nothing to put here") that is
  // no different from null (the clinical lead's decision).
  for (const [key] of FIELDS) {
    if (!(key in parsed)) parsed[key] = null;
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
  // Teeth. A model that omits them costs nothing — the page then says no tooth
  // was identified, which is itself worth seeing on a surgical consultation.
  if (!('teeth' in parsed) || parsed.teeth === null) parsed.teeth = [];
  if (!Array.isArray(parsed.teeth)) throw new Error('teeth is not an array');
  parsed.teeth = parsed.teeth
    .filter((t) => (typeof t === 'string' || typeof t === 'number'))
    .map((t) => String(t).trim())
    .filter((t) => t && t.length <= 12)
    .slice(0, 32);

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

  parsed.sources = cleanSources(parsed.sources);
  // The parser's own gaps (a record it could not read). Added AFTER the blank
  // backstop below, which runs only when the model reported no gaps of its
  // own: added before, one of these would switch the backstop off and a blank
  // risks field would go unlisted.
  const parserGaps = [];
  {
    const la = cleanLaLog(parsed.laLog);
    parsed.laLog = la.rows;
    parserGaps.push(...la.gaps);
  }
  parsed.radiographs = cleanRadiographs(parsed.radiographs);
  if (parsed.radiographs && parsed.radiographs.unreadable) {
    parsed.radiographs = null;
    parserGaps.push('The radiograph details came back in a form that could not be read. Check the radiograph report against what was said.');
  }
  if (parsed.radiographs && parsed.radiographs.offScale) {
    parserGaps.push(`An image quality was given that is not on the A/N scale ("${parsed.radiographs.offScale}"), so it was left blank. Record A or N.`);
    delete parsed.radiographs.offScale;
  }
  parsed.bpe = cleanBpe(parsed.bpe);
  if (parsed.bpe && parsed.bpe.unreadable) {
    parsed.bpe = null;
    // Said, but not in a form that could be read: never shown as "none heard".
    parserGaps.push('BPE scores came back in a form that could not be read. Enter them on the chart from what you recorded.');
  }
  parsed.actions = cleanActions(parsed.actions);
  // Checked against the final gap list by cleanQuestions, in extract.mjs, once
  // every gap is in it. Anything that is not a list is no questions.
  if (!Array.isArray(parsed.questions)) parsed.questions = [];

  if (!('checklist' in parsed) || parsed.checklist === null) parsed.checklist = {};
  if (typeof parsed.checklist !== 'object' || Array.isArray(parsed.checklist)) throw new Error('checklist is not an object');
  // No gaps key at all is "nothing missing", and a single string is one gap.
  // Both used to refuse the note. Anything else in that place is still refused.
  if (parsed.gaps === undefined || parsed.gaps === null) parsed.gaps = [];
  if (typeof parsed.gaps === 'string') parsed.gaps = parsed.gaps.trim() ? [parsed.gaps] : [];
  if (!Array.isArray(parsed.gaps)) throw new Error('Missing or invalid gaps array');

  // Any null field must be accounted for in gaps — but only where the field
  // APPLIES. A routine recall has no procedure being weighed, so alternatives,
  // risks and a decision are not missing, they are irrelevant. Demanding a gap
  // for them made every exam/recall fail to draft, deterministically, with a
  // message about null fields that told the clinician nothing.
  //
  // An empty or whitespace-only string is the same thing as null here: the page
  // renders both as a gap, so a response of "" used to slip past this guard and
  // leave a silently blank field with nothing reported. Seen live on 17
  // September, when a real recall came back with plan: "".
  const skip = new Set(notApplicableFields(consultTypeKey));
  const blank = (v) => v == null || (typeof v === 'string' && v.trim() === '');
  for (const [k] of [...FIELDS, ...DICTATED_FIELDS]) {
    if (typeof parsed[k] === 'string' && parsed[k].trim() === '') parsed[k] = null;
  }
  const blanks = FIELDS.filter(([k]) => blank(parsed[k]) && !skip.has(k));
  if (blanks.length > 0 && parsed.gaps.length === 0) {
    // Blank fields that apply, and no gaps reported. This used to refuse the
    // whole note, and at temperature 0 it refused it identically on every
    // retry: seen live on 21 September 2026, twice on one recall transcript,
    // where the prompt's "do NOT add gaps" for the recall's inapplicable fields
    // was carried over to fields that do apply. The clinician was left writing
    // the note by hand mid-clinic.
    //
    // Now, for every consult type (the clinical lead's decision, 21 September
    // 2026), the blanks are listed for the clinician here instead, worded so
    // they claim nothing about the conversation: the field is empty in the
    // draft, and whether it came up is for them to check. On a consent
    // consultation a blank "risks" may be the model dropping something that was
    // said; that is exactly what this wording asks them to check, and every
    // note is reviewed before it is used. A flagged blank is more use than no
    // note at all.
    parsed.gaps = blanks.map(([, label]) => `${label}: left blank in the draft; check whether it came up`);
  }
  parsed.gaps.push(...parserGaps);

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

If a line reading [DICTATION ...] appears in the transcript, everything after it is the dentist's own notes, dictated after the patient left. None of it was said to the patient, so nothing from it goes into this document — not the facts, and never the dentist's remarks, impressions or opinions about the patient.

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
  const parsed = parseObject(cleaned);
  const out = {};
  for (const [key, label] of SUMMARY_FIELDS) {
    const v = parsed[key];
    if (v === undefined || v === null) { out[key] = null; continue; }
    const text = typeof v === 'string' ? v : asText(v);
    if (text === undefined) throw new Error(`Summary field "${key}" (${label}) came back as ${Array.isArray(v) ? 'an array' : typeof v}, not text`);
    out[key] = text;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Post-operative instructions
 *
 * The document the surgical patient actually needs: the one they take home
 * and read at nine o'clock that night when the bleeding starts again.
 *
 * It is built from the corrected note, like the referral, and it inherits the
 * same discipline. A post-operative sheet is exactly where a model would be
 * most tempted to supply the standard advice for the procedure, and standard
 * advice invented for a specific patient is neither the clinician's nor the
 * practice's. What was not said is named as a blank for the clinician to fill,
 * not quietly filled in.
 * ------------------------------------------------------------------ */

export const POSTOP_FIELDS = [
  ['expect', 'What to expect'],
  ['pain', 'Pain relief'],
  ['bleeding', 'If it bleeds'],
  ['careOfSite', 'Looking after the area'],
  ['eating', 'Eating and drinking'],
  ['avoid', 'What to avoid'],
  ['whenToWorry', 'When to get in touch'],
  ['followUp', 'Your next appointment'],
];

export function buildPostopSystemPrompt(consultTypeKey) {
  const type = consultType(consultTypeKey);
  return `You write the post-operative instruction sheet a UK dental patient takes home after oral surgery. The clinician will read it, correct it, and give it to the patient.

YOUR ONLY SOURCE is the note below, as the clinician has already corrected it, and the transcript behind it. Everything on this sheet must be something that was actually said to this patient.

THE RULE THAT MATTERS MOST: do NOT supply the standard aftercare for the procedure. You will be tempted to, because post-operative advice is largely the same every time and the sheet looks incomplete without it. Advice this patient was never given is not advice the clinician has approved, and it goes home in the patient's hands with the practice's name on it. If an area was not covered, return null for it. The clinician will see the blank and fill it.

Write in the second person, to the patient ("you", "your tooth"). Short sentences. Plain English, no jargon: if a clinical term was used in the room and explained, use the explanation. Aim for something readable by an anxious person who is not concentrating.

- expect: what is normal in the days afterwards — swelling, bruising, stiffness, discomfort — as described to them.
- pain: what to take, how much, how often, as stated. Take any dose, drug name or frequency EXACTLY as it was given and never adjust, round or add one.
- bleeding: what to do if it bleeds, as described.
- careOfSite: cleaning, rinsing, mouthwash, not disturbing the area.
- eating: food and drink afterwards.
- avoid: smoking, alcohol, exercise, straws, hot food — whatever was actually named.
- whenToWorry: the signs that should prompt them to make contact, and how to make it.
- followUp: the review or next stage, as arranged.

Never invent a phone number, an opening time, a drug, a dose, or a timescale. If the clinician said "ring the practice" without saying when, write that and no more.

If a line reading [DICTATION ...] appears in the transcript, everything after it is the dentist's own notes, dictated after the patient left. None of it was said to the patient, so nothing from it goes into this document — not the facts, and never the dentist's remarks, impressions or opinions about the patient.

Consult type: ${type ? type.label : 'Not specified'}

Return ONLY a JSON object with exactly these keys:
{
  "expect": string | null,
  "pain": string | null,
  "bleeding": string | null,
  "careOfSite": string | null,
  "eating": string | null,
  "avoid": string | null,
  "whenToWorry": string | null,
  "followUp": string | null
}`;
}

export function parsePostop(raw) {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const parsed = parseObject(cleaned);
  const out = {};
  for (const [key, label] of POSTOP_FIELDS) {
    const v = parsed[key];
    if (v === undefined || v === null) { out[key] = null; continue; }
    const text = typeof v === 'string' ? v : asText(v);
    if (text === undefined) throw new Error(`Post-op field "${key}" (${label}) came back as ${Array.isArray(v) ? 'an array' : typeof v}, not text`);
    out[key] = text;
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

The note's dictated fields — examination, radiographic findings, treatment carried out today and plan — are usually where the referral's clinical substance lives, because the conversation with the patient rarely contains it. Use them in full.

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
export const PMPR_LINE = 'Full mouth professional mechanical plaque removal (PMPR) carried out.';

export function buildReferralUserMessage(note, context, transcriptMessage, { dictated = true } = {}) {
  const parts = ['THE CORRECTED NOTE (authoritative):'];
  const all = [...FIELDS, ...DICTATED_FIELDS];
  let any = false;
  for (const [key, label] of all) {
    const v = note && note[key];
    if (typeof v !== 'string' || !v.trim()) continue;
    any = true;
    // With nothing dictated, a dictated field can only have been typed.
    parts.push(`${dictated ? label : label.replace(/ \(dictated\)$/, '')}: ${v.trim()}`);
  }
  // The clinician's PMPR tick: the fixed line, and nothing else, is accepted.
  if (note && note.pmpr === PMPR_LINE) {
    any = true;
    parts.push(`Recorded by the clinician: ${PMPR_LINE}`);
  }
  // BPE scores the clinician checked on the grid, as one line (27 Sep 2026).
  if (note && typeof note.bpe === 'string' && note.bpe.trim()) {
    any = true;
    parts.push(`BPE: ${note.bpe.trim()}`);
  }
  if (!any) parts.push('(The note is empty. Work from the context and transcript below.)');
  if (context && context.trim()) {
    parts.push('', "THE CLINICIAN'S ADDED CONTEXT (stated fact):", context.trim());
  }
  parts.push('', 'THE TRANSCRIPT (secondary — for detail the note does not carry):', transcriptMessage);
  return parts.join('\n');
}

/* Red flags used to be dropped to [] whenever they were not a list of strings,
   so one returned as a single string, or as {"quote": "..."} objects, vanished
   and the referral showed no warning at all. A missing warning on an
   urgent-pathway check is the worst way for this to fail. Now a string is one
   flag, an object is laid out as text by asText, and anything else refuses the
   referral rather than dropping what it might have said. */
function redFlagList(v) {
  if (v === undefined || v === null) return [];
  if (typeof v === 'string') return v.trim() ? [v.trim()] : [];
  if (!Array.isArray(v)) throw new Error(`Referral redFlags came back as ${typeof v}, not a list`);
  return v.filter((f) => f !== null && f !== undefined).map((f) => {
    const text = typeof f === 'string' ? f : asText(f);
    if (text === undefined) throw new Error(`A referral red flag came back as ${Array.isArray(f) ? 'an array' : typeof f}, not text`);
    return (text || '').replace(/\n/g, '; ').trim();
  }).filter(Boolean);
}

export function parseReferral(raw) {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const parsed = parseObject(cleaned);
  const out = {};
  for (const [key, label] of REFERRAL_FIELDS) {
    const v = parsed[key];
    if (v === undefined || v === null) { out[key] = null; continue; }
    const text = typeof v === 'string' ? v : asText(v);
    if (text === undefined) throw new Error(`Referral field "${key}" (${label}) came back as ${Array.isArray(v) ? 'an array' : typeof v}, not text`);
    out[key] = text;
  }
  out.redFlags = redFlagList(parsed.redFlags);
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
