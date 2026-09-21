# Implant Case Assessment — `/implant/`

**Status: preview, passcode-gated, author only.** Linked from the hub and every
switcher bar as "Implant (preview)", but since 21 September 2026 it sits behind the
same sign-in as AI Notes *and* an allow-list: `middleware.js` lets through only the
initials named in the `IMPLANT_USERS` environment variable (`AM`). Anyone else who
signs in gets a 403 page saying it is not available to them; if `IMPLANT_USERS` is
unset, nobody gets in. It keeps no offline copy while gated. `noindex`, out of the
sitemap, and every clinical figure in it is a draft awaiting the clinical lead's
review. `site-check.js` (check 5, and 3e for the hub worker) enforces all of this.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The assessment. Self-contained, no build step, like ASA. |
| `sw.js` | Network-only while the tool is gated: caches nothing, and deletes the `imp-` caches the earlier offline worker left behind. It must not declare a `CACHE` (site-check refuses one). Give it back its cache only when the gate comes off. |
| `viewer.js` | CBCT viewer core plus dicom-parser and a lossless JPEG decoder, built from `src/`. Loaded only when a scan is opened. |
| `src/viewer-core.js` | Source of the viewer core: loads a DICOM series in the browser (a folder of slices, or one multi-frame file; uncompressed or lossless JPEG), cuts planes through it, converts image points to millimetres. It never reads the scan for the clinician. |
| `src/viewer-entry.js` | Build entry. |

## Building `viewer.js`

```
npm install dicom-parser@1.8.21 jpeg-lossless-decoder-js@2.1.2 esbuild --no-save
npx esbuild implant/src/viewer-entry.js --bundle --format=esm --platform=browser \
  --minify --legal-comments=inline --outfile=implant/viewer.js
```

Then bump `CACHE` in `sw.js` and run `node tests/implant.mjs`.

## Tests

`tests/implant.mjs` covers the assessment logic and the page in jsdom. It also
builds a synthetic CBCT phantom with known geometry and measures it through
`viewer.js`: a 7.0 mm ridge at 30° to the scanner axes and a canal 13.5 mm
below the crest. The same phantom is also written as one multi-frame file,
uncompressed and as lossless JPEG (by an encoder in the test, written from
T.81), laid out as the Carestream CS 8100 3D exports. No scan of any person is
used or needed.

## Third-party

`viewer.js` includes [dicom-parser](https://github.com/cornerstonejs/dicomParser)
(MIT licence, © Chris Hafey) and
[jpeg-lossless-decoder-js](https://github.com/rii-mango/JPEGLosslessDecoderJS)
(MIT licence, © RII-UTHSCSA). Their licence banners are kept in the bundle.

The decoder stops a pixel or two early when the image's end marker falls inside
its read-ahead. `padBeforeEnd()` in the viewer core puts fill bits before the
marker so it never does; the tests fail without it.

## Launch checklist

1. Clinical content reviewed and signed off; `DRAFT` figures confirmed.
2. Take `/implant/` out of `RESTRICTED` in `middleware.js` (and out of its matcher, if it is to be public), delete `IMPLANT_USERS`, restore an offline `sw.js` with an `imp-` cache, and put `implant` back in the CI cache-bump loop (with its `viewer.js` rule).
3. Remove the preview banner and the `robots` meta; add the og and twitter tags.
4. Change the switcher label on every page from `Implant (preview)` to `Implant`
   (hub, four tools, AI Notes, 404 and the implant page itself), and drop the
   `Preview` tag from the hub card.
5. Move the entry from `PREVIEW` to `TOOLS` in `site-check.js`; add it to `sitemap.xml`. It is already on the hub; in the CI canary, move it from the must-stay-shut step to the must-stay-open one, and drop the `Sign-in required` tag from the hub card.
