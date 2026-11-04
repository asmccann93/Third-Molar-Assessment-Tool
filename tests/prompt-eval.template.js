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

  /* assess() is inlined here from tests/eval-assert.mjs at build time. It is
     NOT written out twice any more: the self-tests in build-eval.mjs import
     that module and then check that this inlined copy gives the same answers,
     so the logic the self-tests exercise is the logic that runs against the
     model. */
  __ASSESS__

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
