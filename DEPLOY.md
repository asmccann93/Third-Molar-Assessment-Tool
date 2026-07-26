# Deploying to oralsurgeryassess.com — GitHub → Vercel

## What goes in the repo

The repository root should look exactly like this:

```
index.html                 landing page linking to both tools
sw.js                      retires the old root service worker — see below
vercel.json                required config — see below
apple-touch-icon.png
favicon-32.png
third-molar/               your existing tool, unchanged
sedation/                  the sedation pre-assessment
DEPLOY.md                  this file
```

No build step, no dependencies, no `package.json`. Vercel serves it as a static site.

Resulting URLs:

- `oralsurgeryassess.com/` — landing page
- `oralsurgeryassess.com/third-molar/`
- `oralsurgeryassess.com/sedation/`

## Two things that will break the site if skipped

### 1. `vercel.json` — `trailingSlash: true`

Vercel's default removes trailing slashes, serving the page at `/sedation`
rather than `/sedation/`. Both tools use relative paths, and the browser
resolves those against the page URL:

| Page URL     | `sw.js` resolves to    | Result                          |
|--------------|------------------------|---------------------------------|
| `/sedation/` | `/sedation/sw.js`      | correct                         |
| `/sedation`  | `/sw.js`               | registers the root kill switch  |

Without the trailing slash the manifest and icons 404 as well, so both tools
lose offline support and home screen install. `vercel.json` sets
`trailingSlash: true` and `cleanUrls: false` to prevent this. Do not remove it.

### 2. `sw.js` at the root — a deliberate kill switch

The third molar tool used to sit at the site root, so every previous visitor has
a service worker registered at scope `/`. That scope covers the whole domain,
including the two new folders. Its offline fallback resolves to the root index,
so someone opening `/sedation/` with no signal could be served the third molar
tool instead.

The root `sw.js` clears the old caches, unregisters itself, and reloads open
tabs. Each tool then registers its own worker, scoped to its own folder.

**Keep it there permanently.** If you delete it, it 404s and any browser that
has not yet updated keeps the old worker indefinitely.

## Steps

If you already have a repo connected to Vercel for the third molar tool, use it
— this is a restructure, not a new project.

1. **Move the existing tool into a folder.** In your repo, create `third-molar/`
   and move `index.html`, `sw.js`, `manifest.webmanifest` and the icons into it.
   `git mv` keeps the history.
2. **Add the new files** at the root: `index.html`, `sw.js`, `vercel.json`,
   `apple-touch-icon.png`, `favicon-32.png`, and the whole `sedation/` folder.
3. **Commit and push.**
   ```
   git add -A
   git commit -m "Restructure: landing page plus third-molar and sedation tools"
   git push
   ```
4. **Vercel deploys automatically** on push. If the project is not yet connected:
   Vercel → Add New → Project → import the repo. Framework preset **Other**,
   build command **empty**, output directory **empty**.
5. **Check the domain.** Vercel → Project → Settings → Domains should list
   `oralsurgeryassess.com`. Unchanged if the project already existed.

## Verifying the deploy

1. All three URLs load: `/`, `/third-molar/`, `/sedation/`.
2. The address bar keeps the trailing slash. If it strips to `/sedation`,
   `vercel.json` is not being picked up — confirm it is at the repo root.
3. On a device that used the old site: load it, wait a few seconds, reload.
   DevTools → Application → Service Workers should show workers for
   `/third-molar/` and `/sedation/` only, with none at `/`.
4. Offline test: open `/sedation/`, switch to airplane mode, reload. The sedation
   tool should reappear — not the third molar tool.

## Updating a tool later

Each tool caches itself, so a changed file will not reach returning users until
its cache name changes. When you edit a tool's `index.html`, bump the version on
the first line of that tool's `sw.js`:

- `third-molar/sw.js` → `const CACHE = "tma-v1-4-15";`
- `sedation/sw.js` → `var CACHE = "sedation-v2";`

Forgetting this is the usual reason a pushed change does not appear. The root
`sw.js` never needs a version bump — it holds no cache.

## Notes

- Vercel provides HTTPS automatically, which service workers require.
- Preview deployments get their own URL, so you can check a change on a branch
  before merging. Service workers are scoped per-origin, so a preview will not
  interfere with the live site.
- No backend and no database. Nothing the tools record leaves the device except
  the PDF you choose to save.
