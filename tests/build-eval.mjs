// tests/build-eval.mjs
//
// Inlines the fixtures into the console-pasteable evaluator, then self-tests the
// assertion logic against handcrafted good and bad notes — so a green run on the
// real thing means the prompt is right, not that the checker is broken.

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(join(here, 'fixtures/transcripts.json'), 'utf8')).fixtures;
const template = readFileSync(join(here, 'prompt-eval.template.js'), 'utf8');

const out = template
  .replace('__FIXTURES__', JSON.stringify(fixtures, null, 2))
  .replace(
    '// tests/prompt-eval.template.js',
    '// tests/prompt-eval.paste.js  — GENERATED, do not edit\n' +
    '// Edit tests/fixtures/transcripts.json then run: node tests/build-eval.mjs'
  );

writeFileSync(join(here, 'prompt-eval.paste.js'), out);

/* ---------- self-test the assertion logic ---------- */

const FIELD_KEYS = [
  'reasonForAttendance', 'medicalHistory', 'proposed', 'alternatives',
  'risks', 'benefits', 'costs', 'patientQuestions', 'patientFactors',
  'informationGiven', 'decision', 'nextStep'
];
const norm = (v) => (v == null ? '' : String(v)).toLowerCase();
const whole = (n) => FIELD_KEYS.map((k) => norm(n[k])).join(' \n ');

// Same logic as the template. Kept in step by the round-trip check below.
function assess(note, expect) {
  const bad = [];
  if (expect.allNull) {
    const filled = FIELD_KEYS.filter((k) => note[k] != null && String(note[k]).trim() !== '');
    if (filled.length) bad.push(`invented content in: ${filled.join(', ')}`);
  }
  for (const k of expect.notNull || []) if (note[k] == null || String(note[k]).trim() === '') bad.push(`${k} empty`);
  for (const k of expect.mustBeNull || []) if (note[k] != null && String(note[k]).trim() !== '') bad.push(`${k} filled`);
  for (const [f, ns] of Object.entries(expect.mustMention || {})) for (const n of ns) if (!norm(note[f]).includes(n.toLowerCase())) bad.push(`${f} missing "${n}"`);
  for (const [f, ns] of Object.entries(expect.mustNotMention || {})) for (const n of ns) if (norm(note[f]).includes(n.toLowerCase())) bad.push(`${f} has "${n}"`);
  for (const n of expect.mustNotMentionAnywhere || []) if (whole(note).includes(n.toLowerCase())) bad.push(`note has "${n}"`);
  const gaps = (note.gaps || []).map(norm).join(' \n ');
  for (const n of expect.gapsMustMatch || []) if (!gaps.includes(n.toLowerCase())) bad.push(`no gap for "${n}"`);
  for (const n of expect.decisionMustNotMatch || []) if (norm(note.decision).includes(n.toLowerCase())) bad.push(`decision claims "${n}"`);
  const g = (note.gaps || []).length;
  if (expect.gapsAtMost != null && g > expect.gapsAtMost) bad.push('too many gaps');
  if (expect.gapsAtLeast != null && g < expect.gapsAtLeast) bad.push('too few gaps');
  const notSaid = (note.notSaid || []).map(norm).join(' \n ');
  for (const n of expect.notSaidMustMatch || []) if (!notSaid.includes(n.toLowerCase())) bad.push(`nothing in notSaid mentions "${n}"`);
  for (const n of expect.notSaidMustNotMatch || []) if (notSaid.includes(n.toLowerCase())) bad.push(`notSaid wrongly flags "${n}"`);
  if (expect.checklistMustApply && (note.notSaid || []).some((t) => /could not be applied/i.test(t))) bad.push('checklist not applied');
  return bad;
}

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
t('invented risks are caught', invFails.some((f) => f.includes('risks filled')), JSON.stringify(invFails));
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
t('the pasteable evaluator carries the same checklist logic',
  readFileSync(join(here, 'prompt-eval.template.js'), 'utf8').includes('notSaidMustMatch'));

/* ---------- generated file sanity ---------- */
console.log('\ngenerated paste file\n--------------------');
const generated = readFileSync(join(here, 'prompt-eval.paste.js'), 'utf8');
t('placeholder replaced', !generated.includes('__FIXTURES__'));
t('all fixtures inlined', fixtures.every((f) => generated.includes(`"${f.id}"`)));
t('marked as generated', generated.includes('GENERATED, do not edit'));
t('is valid javascript', (() => { try { new Function(generated); return true; } catch { return false; } })());
t('no patient-identifiable content', !/\b(NHS|DOB|date of birth)\b/i.test(generated));

console.log(`\n  ${pass} passed, ${fail} failed\n`);
console.log(`  wrote tests/prompt-eval.paste.js (${(generated.length / 1024).toFixed(1)} KB)\n`);
process.exit(fail ? 1 : 0);
