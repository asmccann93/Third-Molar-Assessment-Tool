# Implant Case Assessment — `/implant/`

**Status: preview.** Not linked from the site, `noindex`, and every clinical
figure in it is a draft awaiting the clinical lead's review. `site-check.js`
(check 5) enforces the preview rules.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The assessment. Self-contained, no build step, like ASA. |
| `sw.js` | Offline cache, prefix `imp-`. Bump `CACHE` whenever `index.html` or `viewer.js` changes (CI checks both). |
| `viewer.js` | CBCT viewer core plus dicom-parser, built from `src/`. Loaded only when a scan is opened. |
| `src/viewer-core.js` | Source of the viewer core: loads a DICOM series in the browser, cuts planes through it, converts image points to millimetres. It never reads the scan for the clinician. |
| `src/viewer-entry.js` | Build entry. |

## Building `viewer.js`

```
npm install dicom-parser@1.8.21 esbuild --no-save
npx esbuild implant/src/viewer-entry.js --bundle --format=esm --platform=browser \
  --minify --legal-comments=inline --outfile=implant/viewer.js
```

Then bump `CACHE` in `sw.js` and run `node tests/implant.mjs`.

## Tests

`tests/implant.mjs` covers the assessment logic and the page in jsdom. It also
builds a synthetic CBCT phantom with known geometry and measures it through
`viewer.js`: a 7.0 mm ridge at 30° to the scanner axes and a canal 13.5 mm
below the crest. No scan of any person is used or needed.

## Third-party

`viewer.js` includes [dicom-parser](https://github.com/cornerstonejs/dicomParser)
(MIT licence, © Chris Hafey). Its licence banner is kept in the bundle.

## Launch checklist

1. Clinical content reviewed and signed off; `DRAFT` figures confirmed.
2. Remove the preview banner and the `robots` meta; add the og and twitter tags.
3. Add `<a href="/implant/">Implant</a>` to the switcher on every page, AI Notes included.
4. Move the entry from `PREVIEW` to `TOOLS` in `site-check.js`; add it to `sitemap.xml`, the hub, and the canary list in CI.
