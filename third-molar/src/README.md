# Third molar tool — source

`bundle_entry.jsx` is the source for `/third-molar/index.html`. Until 21 Aug 2026
only the built page was in the repo, which is how `html_head.txt` was able to
drift three commits out of date without anyone noticing.

## Build

```
npm install react@19.2.5 react-dom@19.2.5 pdf-lib esbuild@0.28.2

npx esbuild bundle_entry.jsx \
  --bundle --minify --format=iife \
  --loader:.jsx=jsx --jsx=automatic \
  --define:process.env.NODE_ENV='"production"' \
  --outfile=bundle.js

cat ../html_head.txt bundle.js ../html_tail.txt > ../index.html
```

React 19.2.5 is not a guess — it is the version embedded in the deployed bundle.
Building against a different major will produce a different runtime.

## Provenance — read before rebuilding

The file recovered from Aiden's machine was **v1.4.19**, six versions behind the
deployed **v1.4.25**. The difference was one behaviour change, ported back in on
21 Aug 2026 and verified against the live bundle:

- **1.4.19** restored saved progress automatically on load, dropping the user
  back mid-assessment, with a banner offering "Start again instead".
- **1.4.25** always shows the cover page. If saved progress exists, the cover
  offers "An unfinished assessment was found on this device." with a **Resume**
  button, and the main button reads "Start a new assessment" instead of
  "Begin assessment".

Three edits carried that across: `started` now initialises to `false` rather than
from the saved state, the cover page gained the resume prompt, and the main
button's label and handler became conditional. `VERSION` was set to 1.4.25.

## What was verified, and what was not

Rebuilding this source and comparing against the live bundle:

- **zero** differences in human-readable content, in either direction
- referral ladder strings byte-identical
- risk-level map identical: `chemoRadio:3, haemophilia:3, adrenal:3,
  bisphosphonates:1, cancerBisphosphonates:1`
- difficulty thresholds structurally identical (`<=4 → 0, <=6 → 1, <=8 → 2, else 3`)

The rebuilt bundle is 1,728,717 bytes against the deployed 1,730,430 — a 1,713
byte difference from esbuild's identifier naming, not from content.

**This source has never been deployed.** `/third-molar/index.html` is still the
original build. Before replacing it, click through a rebuilt copy against the live
tool — particularly the cover page with and without saved progress, and a full
assessment through to the PDF.
