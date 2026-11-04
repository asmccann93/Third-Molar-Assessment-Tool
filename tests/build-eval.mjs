// tests/build-eval.mjs
//
// Inlines the fixtures AND the assertion logic into the console-pasteable
// evaluator, then self-tests that logic against handcrafted good and bad notes
// — so a green run on the real thing means the prompt is right, not that the
// checker is broken.
//
// assess() lives in tests/eval-assert.mjs and is written out ONCE. It used to
// exist twice, here and in the template, kept in step by a check that the
// template contained a particular string — so these self-tests could pass
// while the code that actually runs against the model did something else.
// Now this file imports the real function, inlines its source, and checks that
// the inlined copy answers identically.

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { assess } from './eval-assert.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(join(here, 'fixtures/transcripts.json'), 'utf8')).fixtures;
const template = readFileSync(join(here, 'prompt-eval.template.js'), 'utf8');

/* The function's source, between the markers, with `export ` removed: the
   pasted file is one IIFE in a console and cannot import anything. */
const assertSrc = readFileSync(join(here, 'eval-assert.mjs'), 'utf8');
const between = assertSrc.slice(
  assertSrc.indexOf('/* ASSESS_START'),
  assertSrc.indexOf('/* ASSESS_END */')
);
const assessSource = between.slice(between.indexOf('export function assess')).replace('export function assess', 'function assess').trim();
if (!/^function assess\(note, expect\) \{/.test(assessSource)) {
  console.error('could not read assess() out of eval-assert.mjs');
  process.exit(1);
}

const out = template
  .replace('__FIXTURES__', JSON.stringify(fixtures, null, 2))
  .replace('__ASSESS__', assessSource.split('\n').join('\n  '))
  .replace(
    '// tests/prompt-eval.template.js',
    '// tests/prompt-eval.paste.js  — GENERATED, do not edit\n' +
    '// Edit tests/fixtures/transcripts.json or tests/eval-assert.mjs,\n' +
    '// then run: node tests/build-eval.mjs'
  );

writeFileSync(join(here, 'prompt-eval.paste.js'), out);

const FIELD_KEYS = [
  'reasonForAttendance', 'medicalHistory', 'proposed', 'alternatives',
  'risks', 'benefits', 'costs', 'patientQuestions', 'patientFactors',
  'informationGiven', 'decision', 'nextStep'
];

/* ---------- self-test the assertion logic ---------- */

const empty = () => Object.fromEntries(FIELD_KEYS.map((k) => [k, null]));
let pass = 0, fail = 0;
const t = (label, cond, d = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${d ? '  — ' + d : ''}`); }
};

console.log('\nassertion logic self-test\n-------------------------');

const vague = fixtures.find((f) => f.id === 'extraction-vague');

// A model that behaved correctly on the vague fixture.
const goodVague = {
  ...empty(),
  reasonForAttendance: 'Broken upper right molar.',
  proposed: 'Extraction of the broken upper right tooth.',
  costs: '£210 for the extraction.',
  decision: 'Patient agreed to proceed; to be booked via reception.',
  gaps: ['No specific risks were named in this discussion.', 'No alternatives to extraction were discussed.']
};
t('correct answer on the vague fixture passes', assess(goodVague, vague.expect).length === 0,
  JSON.stringify(assess(goodVague, vague.expect)));

// The exact failure the prompt exists to prevent: helpful invention.
const inventedRisks = { ...goodVague, risks: 'Bleeding, infection, dry socket and damage to adjacent teeth.', gaps: [] };
const invFails = assess(inventedRisks, vague.expect);
/* "risks filled" was the wording of the COPY of assess() that used to live in
   this file. The function that actually runs against the model says "risks
   should be a gap", so this assertion was checking a message no real run could
   produce. There is one implementation now, and this reads its words. */
t('invented risks are caught', invFails.some((f) => /^risks should be a gap/.test(f)), JSON.stringify(invFails));
t('invented risk terms caught by the anywhere rule', invFails.some((f) => f.includes('dry socket')), JSON.stringify(invFails));

const attribution = fixtures.find((f) => f.id === 'patient-raises-risk');
const goodAttr = {
  ...empty(),
  reasonForAttendance: 'Lower right tooth for extraction.',
  proposed: 'Extraction of the lower right tooth under local anaesthetic.',
  patientQuestions: 'Asked whether she would be left with a numb lip, as her sister had been after an extraction. Not answered.',
  decision: 'Booked for Thursday.',
  gaps: ['No risks were named by the clinician.', "The patient's question about numbness was not addressed."]
};
t('correct attribution passes', assess(goodAttr, attribution.expect).length === 0,
  JSON.stringify(assess(goodAttr, attribution.expect)));

const misattributed = { ...goodAttr, risks: 'Risk of numbness to the lip discussed.', gaps: [] };
t('patient-raised risk filed as clinician-named is caught',
  assess(misattributed, attribution.expect).length > 0);

const nonsense = fixtures.find((f) => f.id === 'not-a-consultation');
t('all-null passes the failsafe fixture',
  assess({ ...empty(), gaps: ['Not a clinical conversation.'] }, nonsense.expect).length === 0);
t('a note manufactured from small talk is caught',
  assess({ ...empty(), reasonForAttendance: 'Routine examination.', gaps: ['x'] }, nonsense.expect).length > 0);

const undecided = fixtures.find((f) => f.id === 'undecided-with-partner');
t('a fabricated decision is caught',
  assess({ ...empty(), decision: 'Patient consented to the implant.', gaps: [] }, undecided.expect)
    .some((f) => f.includes('consented to')));

/* ---------- checklist assertions ---------- */
// The checklist is the most safety-relevant thing the prompt does, and until
// now the only harness that runs against the real model ignored it entirely.

t('a checklist finding that is present satisfies notSaidMustMatch',
  assess({ ...empty(), gaps: [], notSaid: ['Not mentioned: bleeding.'] }, { notSaidMustMatch: ['bleeding'] }).length === 0);
t('a missing checklist finding is caught',
  assess({ ...empty(), gaps: [], notSaid: [] }, { notSaidMustMatch: ['bleeding'] }).length === 1);
t('a risk wrongly flagged as unsaid is caught',
  assess({ ...empty(), gaps: [], notSaid: ['Not mentioned: bleeding.'] }, { notSaidMustNotMatch: ['bleeding'] }).length === 1);
t('a model that ignored the checklist is caught',
  assess({ ...empty(), gaps: [], notSaid: ['The procedure checklist could not be applied to this transcript.'] },
    { checklistMustApply: true }).length === 1);
t('and a model that applied it passes',
  assess({ ...empty(), gaps: [], notSaid: ['Not mentioned: bleeding.'] }, { checklistMustApply: true }).length === 0);
/* ---------- the structured records (4 November 2026) ----------
   Until now a fixture could say nothing about the la log, the sedation record,
   the implant log or the three itemised lists — half of what the model returns,
   and the half carrying doses, lot numbers and a diagnosis per tooth. */

const blank = () => ({ ...empty(), gaps: [] });

t('an empty la log satisfies listsMustBeEmpty',
  assess({ ...blank(), laLog: [] }, { listsMustBeEmpty: ['laLog'] }).length === 0);
t('an invented la row is caught',
  assess({ ...blank(), laLog: [{ agent: 'Articaine', amount: '2 cartridges' }] },
    { listsMustBeEmpty: ['laLog'] }).some((f) => /^laLog should be empty/.test(f)));
/* The object records, not just the arrays: a sedation record is one object, and
   quotes and named are bookkeeping rather than content. */
t('a sedation record holding nothing but bookkeeping is still empty',
  assess({ ...blank(), sedation: { technique: null, increments: [], quotes: ['x'] } },
    { listsMustBeEmpty: ['sedation'] }).length === 0);
t('an invented sedation technique is caught',
  assess({ ...blank(), sedation: { technique: 'IV midazolam', increments: [] } },
    { listsMustBeEmpty: ['sedation'] }).length === 1);
t('an invented increment is caught even with every text field empty',
  assess({ ...blank(), sedation: { technique: null, increments: [{ time: '10:00', dose: '2mg' }] } },
    { listsMustBeEmpty: ['sedation'] }).length === 1);
t('a BPE the model made up is caught',
  assess({ ...blank(), bpe: { UR: '2', UA: null, UL: null, LR: null, LA: null, LL: null, quotes: [] } },
    { listsMustBeEmpty: ['bpe'] }).length === 1);

t('rowsAtLeast counts rows', assess({ ...blank(), diagnoses: [{ diagnosis: 'Caries' }] },
  { rowsAtLeast: { diagnoses: 2 } }).length === 1);
t('rowsAtMost counts rows', assess({ ...blank(), planItems: [{ treatment: 'a' }, { treatment: 'b' }] },
  { rowsAtMost: { planItems: 1 } }).length === 1);

t('listMustMention reads the values a row carries',
  assess({ ...blank(), diagnoses: [{ tooth: '38', diagnosis: 'Pericoronitis' }] },
    { listMustMention: { diagnoses: ['pericoronitis'] } }).length === 0);
/* Keys are not content. Matching them would let a mention test pass against a
   row that recorded nothing at all. */
t('and not the key names',
  assess({ ...blank(), diagnoses: [{ tooth: null, diagnosis: null }] },
    { listMustMention: { diagnoses: ['diagnosis'] } }).length === 1);
/* Nor the quotes: those are the patient's own words, so a mention test
   satisfied by one would pass on a row the model never filled in. */
t('nor the quoted transcript behind a row',
  assess({ ...blank(), diagnoses: [{ diagnosis: null, quotes: ['it is pericoronitis'] }] },
    { listMustMention: { diagnoses: ['pericoronitis'] } }).length === 1);
/* A BPE carries `named: false`, which is bookkeeping. Without excluding it,
   listMustNotMention: { bpe: ['false'] } would fire on every chart. */
t('nor the record\'s own bookkeeping flags',
  assess({ ...blank(), bpe: { UR: '2', UA: null, UL: null, LR: null, LA: null, LL: null, named: false, quotes: [] } },
    { listMustNotMention: { bpe: ['false'] } }).length === 0);
t('listMustNotMention catches an invented entry',
  assess({ ...blank(), planItems: [{ tooth: '38', treatment: 'Implant placement' }] },
    { listMustNotMention: { planItems: ['implant'] } }).length === 1);

/* A diagnosis dictated after the patient left must not come back marked as
   discussed with them. The page shows that distinction as a claim about the
   consultation, so a fixture has to be able to assert it. */
t('a row marked as discussed when it was dictated is caught',
  assess({ ...blank(), diagnoses: [{ diagnosis: 'Pericoronitis', source: 'discussed' }] },
    { rowSourcesMustBe: { diagnoses: ['dictated'] } }).some((f) => /marked "discussed"/.test(f)));
t('and a row with no source at all is caught',
  assess({ ...blank(), diagnoses: [{ diagnosis: 'Pericoronitis', source: null }] },
    { rowSourcesMustBe: { diagnoses: ['dictated'] } }).some((f) => /marked "none"/.test(f)));
t('a correctly sourced row passes',
  assess({ ...blank(), diagnoses: [{ diagnosis: 'Pericoronitis', source: 'dictated' }] },
    { rowSourcesMustBe: { diagnoses: ['dictated', 'discussed'] } }).length === 0);

t('notApplicable can be asserted both ways',
  assess({ ...blank(), notApplicable: ['risks', 'alternatives'] },
    { notApplicableMustInclude: ['risks'], notApplicableMustNotInclude: ['costs'] }).length === 0 &&
  assess({ ...blank(), notApplicable: ['risks'] },
    { notApplicableMustInclude: ['decision'] }).length === 1);

/* ---------- one implementation, proved ----------
   The old check here was that the template contained the string
   "notSaidMustMatch". It passed while this file's own copy of assess() said
   "risks filled" and the real one said "risks should be a gap" — so the
   self-tests above were exercising wording no real run could produce.

   This runs the GENERATED file's assess() and the imported one over the same
   cases and requires identical answers. */
{
  const gen = readFileSync(join(here, 'prompt-eval.paste.js'), 'utf8');
  const body = gen.slice(gen.indexOf('function assess(note, expect) {'));
  const src = body.slice(0, body.indexOf('\n  }\n') + 4);
  let inlined = null;
  try { inlined = new Function(`${src}; return assess;`)(); } catch (e) { inlined = null; }
  t('the generated file contains a usable assess()', typeof inlined === 'function');
  const cases = [
    [{ ...blank(), risks: 'Bleeding.' }, { mustBeNull: ['risks'], mustNotMentionAnywhere: ['bleeding'] }],
    [{ ...blank(), notSaid: ['Not mentioned: bleeding.'] }, { notSaidMustMatch: ['bleeding'], checklistMustApply: true }],
    [{ ...blank(), laLog: [{ agent: 'Articaine' }] }, { listsMustBeEmpty: ['laLog'] }],
    [{ ...blank(), diagnoses: [{ diagnosis: 'Pericoronitis', source: 'discussed' }] },
     { rowSourcesMustBe: { diagnoses: ['dictated'] }, listMustMention: { diagnoses: ['pericoronitis'] } }],
    [{ ...blank(), notApplicable: ['risks'] }, { notApplicableMustInclude: ['decision'] }],
    [{ ...blank(), gaps: ['a', 'b', 'c'] }, { gapsAtMost: 1, gapsAtLeast: 5 }]
  ];
  const same = inlined && cases.every(([note, expect]) =>
    JSON.stringify(inlined(note, expect)) === JSON.stringify(assess(note, expect)));
  t('and it answers identically to the one these self-tests exercise', !!same,
    inlined ? JSON.stringify(cases.map(([n, e]) => [inlined(n, e), assess(n, e)])).slice(0, 300) : 'not a function');
  // A case that produces findings, or the comparison above is all empty arrays.
  t('(and the comparison is over cases that actually produce findings)',
    cases.some(([n, e]) => assess(n, e).length > 0));
}

/* ---------- generated file sanity ---------- */
console.log('\ngenerated paste file\n--------------------');
const generated = readFileSync(join(here, 'prompt-eval.paste.js'), 'utf8');
t('placeholder replaced', !generated.includes('__FIXTURES__'));
t('all fixtures inlined', fixtures.every((f) => generated.includes(`"${f.id}"`)));
t('marked as generated', generated.includes('GENERATED, do not edit'));
t('is valid javascript', (() => { try { new Function(generated); return true; } catch { return false; } })());
/* The identifiers, not the service. The old form of this was
   /\b(NHS|DOB|date of birth)\b/, which fired on "it's within your NHS course" —
   an ordinary sentence in a practice that is mostly NHS, so every realistic
   fixture would have had to be written around it. What must never be here is
   an NHS NUMBER, a date of birth, or a date that could be one. Each pattern
   below is proved to fire on the thing it is for. */
const IDENTIFIERS = [
  [/\bNHS\s*(?:number|no\b|no\.|#)/i, 'an NHS number'],
  [/\bDOB\b/i, 'a DOB'],
  [/\bdate of birth\b/i, 'a date of birth'],
  [/\b\d{3}[ -]?\d{3}[ -]?\d{4}\b/, 'a ten-digit number'],
  [/\b\d{1,2}[/.-]\d{1,2}[/.-](?:19|20)\d{2}\b/, 'a full date']
];
const found = IDENTIFIERS.filter(([re]) => re.test(generated)).map(([, what]) => what);
t('no patient-identifiable content', found.length === 0, found.join(', '));
// Each pattern catches what it is for — or the check above is decoration.
for (const [sample, what] of [
  ['NHS number 943 476 5919', 'an NHS number'], ['DOB 12 March', 'a DOB'],
  ['date of birth given', 'a date of birth'], ['9434765919', 'a ten-digit number'],
  ['born 12/03/1974', 'a full date']
]) {
  t(`the identifier check catches ${what}`,
    IDENTIFIERS.some(([re, w]) => w === what && re.test(sample)), sample);
}
t('and does not fire on ordinary clinical English',
  !IDENTIFIERS.some(([re]) => re.test('It is within your NHS course, so there is no extra charge.')));

console.log(`\n  ${pass} passed, ${fail} failed\n`);
console.log(`  wrote tests/prompt-eval.paste.js (${(generated.length / 1024).toFixed(1)} KB)\n`);
process.exit(fail ? 1 : 0);
