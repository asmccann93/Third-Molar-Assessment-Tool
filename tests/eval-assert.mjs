// tests/eval-assert.mjs
//
// THE ONE COPY of the fixture assertion logic.
//
// It used to exist twice: once in tests/prompt-eval.template.js, which is what
// actually runs against the live model, and once in tests/build-eval.mjs, which
// is what the self-tests exercise. The two were kept in step by a check that
// the template contained the string "notSaidMustMatch" — so the self-tests
// could pass while the thing that runs against the model did something else.
// A duplicated fact that can disagree is a defect waiting to be shipped.
//
// Now build-eval.mjs imports this and inlines its source into the pasteable
// file, and asserts that the inlined copy and the imported one give the same
// answers. There is one implementation and one set of self-tests over it.
//
// Everything in here must run in a browser console with no imports, so the
// function uses nothing but plain JavaScript.

export const FIELD_KEYS = [
  'reasonForAttendance', 'medicalHistory', 'proposed', 'alternatives',
  'risks', 'benefits', 'costs', 'patientQuestions', 'patientFactors',
  'informationGiven', 'decision', 'nextStep'
];

/* ASSESS_START — build-eval.mjs inlines everything between the markers. */
export function assess(note, expect) {
  const KEYS = [
    'reasonForAttendance', 'medicalHistory', 'proposed', 'alternatives',
    'risks', 'benefits', 'costs', 'patientQuestions', 'patientFactors',
    'informationGiven', 'decision', 'nextStep'
  ];
  const norm = (v) => (v == null ? '' : String(v)).toLowerCase();
  const whole = (n) => KEYS.map((k) => norm(n[k])).join(' \n ');

  /* ---- the structured records ----
     laLog, sedation, implantLog, diagnoses, planItems, optionsOffered, bpe and
     radiographs. Until 4 November 2026 the fixtures could say nothing about any
     of them, so the half of the output that carries doses, lot numbers and a
     diagnosis per tooth had no evidence behind it at all. */

  // A list as rows. An object record (sedation, bpe, radiographs) is one row.
  const rowsOf = (n, key) => {
    const v = n && n[key];
    if (Array.isArray(v)) return v.filter((r) => r && typeof r === 'object');
    if (v && typeof v === 'object') return [v];
    return [];
  };

  /* Empty means "the model recorded nothing here", which is what a record with
     nothing said about it must look like. quotes and named are bookkeeping, not
     content, so a record carrying only those is still empty. */
  const isEmpty = (n, key) => {
    const v = n && n[key];
    if (v == null) return true;
    if (Array.isArray(v)) return v.length === 0;
    if (typeof v === 'object') {
      return !Object.keys(v).some((k) => {
        if (k === 'quotes' || k === 'named' || k === 'source') return false;
        const val = v[k];
        if (Array.isArray(val)) return val.length > 0;
        return val != null && String(val).trim() !== '';
      });
    }
    return String(v).trim() === '';
  };

  /* The VALUES in a record, never its keys and never its quotes. Matching keys
     would let `listMustMention: { laLog: ['agent'] }` pass on an empty row, and
     matching quotes would let a mention test be satisfied by the patient's own
     words rather than by what the model recorded. */
  const textOf = (n, key) => {
    const out = [];
    const walk = (v, k) => {
      // Bookkeeping, not content — the same two isEmpty ignores.
      if (k === 'quotes' || k === 'named') return;
      if (v == null) return;
      if (Array.isArray(v)) { for (const x of v) walk(x, k); return; }
      if (typeof v === 'object') { for (const kk of Object.keys(v)) walk(v[kk], kk); return; }
      out.push(String(v));
    };
    walk(rowsOf(n, key), key);
    return out.join(' \n ').toLowerCase();
  };

  const bad = [];

  if (expect.allNull) {
    const filled = KEYS.filter((k) => note[k] != null && String(note[k]).trim() !== '');
    if (filled.length) bad.push(`invented content in: ${filled.join(', ')}`);
  }

  for (const k of expect.notNull || []) {
    if (note[k] == null || String(note[k]).trim() === '') bad.push(`${k} is empty but should be filled`);
  }

  for (const k of expect.mustBeNull || []) {
    if (note[k] != null && String(note[k]).trim() !== '') {
      bad.push(`${k} should be a gap, got: "${String(note[k]).slice(0, 70)}"`);
    }
  }

  // Checklist findings arrive separately from model gaps and mean the
  // opposite thing: "you did not say this", not "I could not find it".
  const notSaid = (note.notSaid || []).map(norm).join(' \n ');
  for (const n of expect.notSaidMustMatch || []) {
    if (!notSaid.includes(n.toLowerCase())) bad.push(`nothing in notSaid mentions "${n}"`);
  }
  for (const n of expect.notSaidMustNotMatch || []) {
    if (notSaid.includes(n.toLowerCase())) bad.push(`notSaid wrongly flags "${n}" as unsaid`);
  }
  if (expect.checklistMustApply && (note.notSaid || []).some((t) => /could not be applied/i.test(t))) {
    bad.push('the model did not report against the checklist at all');
  }

  for (const field of Object.keys(expect.mustMention || {})) {
    for (const n of expect.mustMention[field]) {
      if (!norm(note[field]).includes(n.toLowerCase())) bad.push(`${field} does not mention "${n}"`);
    }
  }

  for (const field of Object.keys(expect.mustNotMention || {})) {
    for (const n of expect.mustNotMention[field]) {
      if (norm(note[field]).includes(n.toLowerCase())) {
        bad.push(`${field} mentions "${n}" — that was not clinician-named`);
      }
    }
  }

  for (const n of expect.mustNotMentionAnywhere || []) {
    if (whole(note).includes(n.toLowerCase())) bad.push(`note contains "${n}" — nobody said it`);
  }

  const gaps = (note.gaps || []).map(norm).join(' \n ');
  for (const n of expect.gapsMustMatch || []) {
    if (!gaps.includes(n.toLowerCase())) bad.push(`no gap mentions "${n}"`);
  }
  for (const n of expect.decisionMustNotMatch || []) {
    if (norm(note.decision).includes(n.toLowerCase())) {
      bad.push(`decision claims "${n}" but none was made`);
    }
  }

  const g = (note.gaps || []).length;
  if (expect.gapsAtMost != null && g > expect.gapsAtMost) bad.push(`${g} gaps, expected at most ${expect.gapsAtMost}`);
  if (expect.gapsAtLeast != null && g < expect.gapsAtLeast) bad.push(`${g} gaps, expected at least ${expect.gapsAtLeast}`);

  /* ---- assertions about the structured records (4 November 2026) ---- */

  // The never-invent premise, for the half of the output that is not prose. A
  // consultation where no local anaesthetic was given must come back with an
  // EMPTY la log, not a plausible one.
  for (const key of expect.listsMustBeEmpty || []) {
    if (!isEmpty(note, key)) bad.push(`${key} should be empty, got ${JSON.stringify(note[key]).slice(0, 90)}`);
  }

  for (const key of Object.keys(expect.rowsAtLeast || {})) {
    const n = rowsOf(note, key).length;
    if (n < expect.rowsAtLeast[key]) bad.push(`${key} has ${n} rows, expected at least ${expect.rowsAtLeast[key]}`);
  }
  for (const key of Object.keys(expect.rowsAtMost || {})) {
    const n = rowsOf(note, key).length;
    if (n > expect.rowsAtMost[key]) bad.push(`${key} has ${n} rows, expected at most ${expect.rowsAtMost[key]}`);
  }

  for (const key of Object.keys(expect.listMustMention || {})) {
    for (const n of expect.listMustMention[key]) {
      if (!textOf(note, key).includes(n.toLowerCase())) bad.push(`${key} does not record "${n}"`);
    }
  }
  for (const key of Object.keys(expect.listMustNotMention || {})) {
    for (const n of expect.listMustNotMention[key]) {
      if (textOf(note, key).includes(n.toLowerCase())) bad.push(`${key} records "${n}" — nobody said it`);
    }
  }

  /* Every row in a list must say it came from somewhere we expect. A diagnosis
     the clinician dictated after the patient left must not be marked as
     discussed with them: that is a claim about the consultation, and the page
     shows it as one. */
  for (const key of Object.keys(expect.rowSourcesMustBe || {})) {
    const allowed = expect.rowSourcesMustBe[key];
    for (const row of rowsOf(note, key)) {
      const s = row.source == null || row.source === '' ? 'none' : String(row.source);
      if (!allowed.includes(s)) bad.push(`${key} has a row marked "${s}", expected one of ${allowed.join(' / ')}`);
    }
  }

  // The type table: which fields this kind of appointment does not have, so the
  // page can leave them blank rather than claiming they are missing.
  const na = Array.isArray(note.notApplicable) ? note.notApplicable : [];
  for (const k of expect.notApplicableMustInclude || []) {
    if (!na.includes(k)) bad.push(`notApplicable does not include ${k}`);
  }
  for (const k of expect.notApplicableMustNotInclude || []) {
    if (na.includes(k)) bad.push(`notApplicable wrongly includes ${k}`);
  }

  return bad;
}
/* ASSESS_END */
