// tests/prompt-eval.template.js
//
// Assertion logic for the transcript fixtures. Not used directly — run
// `node tests/build-eval.mjs` to produce tests/prompt-eval.paste.js with the
// fixtures inlined, then paste that into the browser console.
//
// Why inlined rather than fetched: the CSP on /ai-notes/ is connect-src 'self',
// so the console cannot pull fixtures from anywhere external. Inlining sidesteps
// it, and means no test files have to be deployed to the live site.

(async function () {
  const FIXTURES = __FIXTURES__;

  const FIELD_KEYS = [
    'reasonForAttendance', 'medicalHistory', 'proposed', 'alternatives',
    'risks', 'benefits', 'costs', 'patientQuestions', 'patientFactors',
    'informationGiven', 'decision', 'nextStep'
  ];

  const norm = (v) => (v == null ? '' : String(v)).toLowerCase();
  const whole = (note) => FIELD_KEYS.map((k) => norm(note[k])).join(' \n ');

  function assess(note, expect) {
    const bad = [];

    if (expect.allNull) {
      const filled = FIELD_KEYS.filter((k) => note[k] != null && String(note[k]).trim() !== '');
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

    for (const [field, needles] of Object.entries(expect.mustMention || {})) {
      for (const n of needles) {
        if (!norm(note[field]).includes(n.toLowerCase())) bad.push(`${field} does not mention "${n}"`);
      }
    }

    for (const [field, needles] of Object.entries(expect.mustNotMention || {})) {
      for (const n of needles) {
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

    return bad;
  }

  const results = [];
  console.log(`\nRunning ${FIXTURES.length} fixtures against /api/extract\n`);

  for (const fx of FIXTURES) {
    process_start: {
      let note;
      try {
        const r = await fetch('/api/extract', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ turns: fx.turns, consultType: fx.consultType })
        });
        const data = await r.json();
        if (!r.ok) {
          console.log(`%c✗ ${fx.id}`, 'color:#a3241c;font-weight:600', `HTTP ${r.status} — ${data.detail || data.error}`);
          results.push({ id: fx.id, failures: [`request failed: ${data.error}`] });
          break process_start;
        }
        note = data.note;
      } catch (e) {
        console.log(`%c✗ ${fx.id}`, 'color:#a3241c;font-weight:600', String(e.message));
        results.push({ id: fx.id, failures: [String(e.message)] });
        break process_start;
      }

      const failures = assess(note, fx.expect);
      results.push({ id: fx.id, failures, note });

      if (failures.length === 0) {
        console.log(`%c✓ ${fx.id}`, 'color:#1f6f3f;font-weight:600');
      } else {
        console.groupCollapsed(`%c✗ ${fx.id}  (${failures.length})`, 'color:#a3241c;font-weight:600');
        for (const f of failures) console.log('   ' + f);
        console.log('%cprobes:', 'color:#666', fx.probes);
        console.log('note:', note);
        console.groupEnd();
      }
    }
  }

  const failed = results.filter((r) => r.failures.length);
  console.log(
    `\n%c${results.length - failed.length}/${results.length} fixtures passed`,
    failed.length ? 'color:#a3241c;font-weight:700' : 'color:#1f6f3f;font-weight:700'
  );
  if (failed.length) console.log('failing:', failed.map((f) => f.id).join(', '));
  window.__evalResults = results;
  console.log('%cfull results in window.__evalResults', 'color:#666');
})();
