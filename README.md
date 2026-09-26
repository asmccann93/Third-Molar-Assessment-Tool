# oralsurgeryassess.com

Clinical decision-support tools for UK dentists, plus one private tool. Static
HTML, no build step, no dependencies, deployed on Vercel.

Developed by Aiden McCann.

---

## Layout

```
/                       Overview (hub)          index.html + sw.js
/third-molar/           Third Molar assessment  index.html + sw.js
/sedation/              Sedation                index.html + sw.js
/local-anaesthetic/     Local Anaesthetic       index.html + sw.js
/asa-assessment/        ASA Assessment          index.html + sw.js
/implant/               Implant Case Assessment — PREVIEW, passcode-gated, author only
/ai-notes/              AI Notes  — PRIVATE, sign-in gated
/ai-notes/admin/        Staff accounts — admins only (add, new setup link, disable, delete)
/ai-notes/setup/        One-time account setup from a setup link — open, no session
/api/                   Serverless routes, AI Notes only (auth, account, users,
                        transcribe, extract; _-prefixed files are helpers)
/fonts/                 Self-hosted IBM Plex + Source Serif
middleware.js           Edge gate for /ai-notes/, /implant/ and /api/
vercel.json             Headers and function limits, path-scoped
site-check.js           Pre-deploy checks
```

Each public tool is a self-contained `index.html` with its own service worker and
its own cache prefix. They share an origin but nothing else — no shared
stylesheet, no shared JS. Design tokens are duplicated per page on purpose:
copying a token block is cheaper than a build step.

### No build step, deliberately

There is no `package.json` and no bundler. Two consequences worth knowing:

- API routes use the **`.mjs`** extension. Without a `package.json` declaring
  `"type": "module"`, Node treats `.js` as CommonJS and `export` fails.
- A root `package.json` with `"type": "module"` **would break CI**, because
  `site-check.js` is CommonJS and uses `require`. If you ever add one, convert
  or rename that file in the same commit.

---

## Deploying

Files are uploaded through the GitHub web UI; there is no local clone. Every push
to `main` triggers a Vercel production deploy.

The uploader commits into whichever directory you are viewing, and it cannot
create directories. To add a file to a new folder, use **Add file → Create new
file** and type the path with a slash (`api/example.mjs`) — that creates the
folder — then upload the rest to `/upload/main/<folder>`.

**Ordering matters.** `vercel.json` declares a `functions` block naming specific
files. Vercel fails the build when a `functions` pattern matches nothing, so
config and the files it references must land together or config must land last.
A failed build does not break the site — Vercel keeps serving the previous
deployment — but it silently blocks every subsequent deploy until fixed.

After uploading, run:

```
node site-check.js .            # verify
node site-check.js . --record   # accept current state as the baseline
```

---

## The checks

`site-check.js` exists because three failure modes here are silent — the site
looks fine and the damage appears later on someone else's device.

1. **`index.html` changed, cache name didn't.** Installed browsers keep serving
   the old page indefinitely. Bump the `CACHE` constant in that tool's `sw.js`.
2. **A page deployed with a stale switcher.** One tool vanishes from the bar on
   that page only.
3. **AI Notes leaking into a public switcher, or starting to persist data.**
   Checked in the inverse direction from the others — see below.

CI runs the same script on every push, plus a git-history cache comparison. A
daily canary job hits production and asserts the five public tools return 200 and
`/ai-notes/` returns 401.

---

## AI Notes

A private tool that records a consent conversation, transcribes it, and drafts a
structured clinical note for the dentist to correct and paste into the record.
Not linked from anywhere. Passcode-gated. Governed by `DPIA-AI-Notes.md`.

### Routes

| Route | Runtime | Purpose |
|---|---|---|
| `/api/auth` | Node | Email + password (or, while `APP_USERS` is set, a passcode) in, signed session cookie out. **Ungated** — otherwise there is no way to log in. Same-origin JSON only. |
| `/api/account` | Node | Account setup from a one-time setup link. **Ungated**; the invite token is the key. |
| `/api/users` | Node | The admin page's API: list, add, new setup link, disable, enable, role, delete. Admins only. |
| `/api/transcribe` | Node | Speechmatics batch proxy, diarised. Submits, polls, returns turns, deletes the job. |
| `/api/extract` | Node | AWS Bedrock invocation, SigV4 signed by hand. Transcript in, structured note out. |
| `api/_session.mjs` | shared | HMAC session tokens. Underscore prefix keeps it off the route table. |
| `api/_store.mjs` | shared | Staff accounts, read side (Edge-safe): the store, its cache, and `resolveSession`, the one "is this session still good?" check. |
| `api/_accounts.mjs` | Node | Passwords (scrypt), epochs, invites, in-memory throttles, store writes. |
| `api/_prompt.mjs` | shared | The extraction prompt. The file that gets iterated. |

`middleware.js` gates `/ai-notes/` and `/api/` and nothing else. It returns 401
with an inline passcode form for navigations and 401 JSON for API requests.
`/api/auth` and `/ai-notes/sw.js` are explicitly open.

### Staff accounts

Sign-in is email + password. Accounts live in a Vercel Global Config store, one
small item per person, managed at `/ai-notes/admin/`; a colleague sets their
own password once, from a setup link the admin hands them (`/ai-notes/setup/`).
The store holds sign-in details only, nothing about any patient. Setup steps
and every variable are in `.env.example`.

**There is no second factor**, by the owner's decision (26 September 2026). The
password is the only thing between a guesser and a colleague's account, so each
password should be long (12 characters minimum is enforced) and unique to this
site, never one reused from elsewhere. To make up some of the difference, five
failed sign-ins on one account lock it for fifteen minutes (in memory, per
instance; nothing is written).

**The Hobby allowances are small, and going over one blocks the store for 30
days**, which would stop everyone signing in: 100 writes and 100,000 reads a
month, store size 1 MB (8 KB on older Vercel pages). So sign-in never writes;
the admin page allows 5 changes an hour and 10 a day per instance and refuses
to add anyone past 7 KB (about twenty staff); and nothing an outsider sends
forces a store read (junk setup links, unknown emails and wrong passwords are
answered from a list cached for 30 s). Check Usage now and then.

**Known races** (the store has no compare-and-swap and takes up to 10 s to show
a write everywhere):

- A disabled colleague stays signed in for up to about 40 s.
- A setup link replaced by "New setup link" can still be completed on another
  server for about 10 s afterwards; the admin page then shows that person
  Active, not Invited. Issue another link.
- One link completed twice at once: the last write wins, and only its session
  survives (each completion moves the epoch by its own random amount).
- Two admins disabling, deleting or demoting each other at the same moment: each
  change re-checks after ~11 s and undoes itself if no active admin is left.
- The throttles and the sign-in lock (sign-in, setup, admin writes) are per
  warm instance.

### Environment variables

Set in the Vercel dashboard, **Production scope only**. A preview deployment
otherwise runs the same code against the same keys on a URL nobody is watching.

| Variable | Notes |
|---|---|
| `APP_USERS` | Per-user passcodes as `AM:passcode,SM:passcode,NOC:passcode`. The initials are how the tool identifies who is signed in. Each passcode a passphrase, not four digits — the throttle is per warm instance and will not stop a determined guesser. |
| `IMPLANT_USERS` | Who may open `/implant/`, on top of a valid passcode: initials from `APP_USERS`, commas between (`AM`). **Unset means closed to everyone.** Anyone else signed in gets a 403 page saying it is not available to them. |
| `APP_PASSCODE` | **Do not set.** The old shared code. No longer honoured by `api/auth.mjs` (since 19 September 2026); if it is set, it is ignored and the function log says so. Deleted from Vercel on 17 September 2026. |
| `SESSION_SECRET` | Signs the session cookie. `openssl rand -hex 32`. |
| `SPEECHMATICS_API_KEY` | |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | IAM user scoped to `bedrock:InvokeModel` only. |
| `AWS_REGION` | `eu-west-2`. |
| `BEDROCK_MODEL_ID` | A leading `eu.` is a cross-region inference profile — EU-wide, not London-only. That changes the data residency claim in the DPIA. |

`.env.example` lists these with no values. **This repo is public**, so never put
a real `.env` in an upload folder — `.gitignore` protects `git add`, not the web
uploader.

### Rotating a key

1. Create the replacement at the provider first.
2. Update the variable in Vercel, Production scope.
3. Redeploy — environment changes do not take effect until the next deployment.
4. Confirm `/ai-notes/` still unlocks and a test recording still completes.
5. Only then revoke the old key.

Rotating `SESSION_SECRET` invalidates every live session immediately, which is
the intended behaviour if a device is lost.

### Two things that look like bugs and are not

**Every switcher has seven entries. The sixth is the implant tool (a preview, passcode-gated and open only to the names in `IMPLANT_USERS`), and the seventh, AI Notes, also leads to a passcode prompt.**
AI Notes has been linked from every public bar since 2 September 2026. A
visitor who taps it sees a 401 sign-in page and nothing else; the gate, not
the link's absence, is the control. `site-check.js` now asserts the link is
present on every public page, so it cannot vanish from one bar only. The tool
is still kept out of `sitemap.xml`, and that is still enforced.

**`ai-notes/sw.js` has no `CACHE` constant and caches nothing.** Every other
service worker here is offline-first. This one is network-only, and
`site-check.js` asserts the *absence* of a cache for that path, along with the
absence of `localStorage`, `sessionStorage` and `indexedDB` in the page. The
tool must persist nothing; an offline cache would defeat it entirely. For the
same reason `ai-notes` is deliberately excluded from the cache-bump loop in CI —
adding it there would fail every time the page is edited.

### Testing

```
node tests/integration.mjs      # 94 assertions — API handlers
node tests/page.mjs             # 88 assertions — the page (needs: npm i jsdom)
node tests/build-eval.mjs       # 13 assertions — rebuilds the prompt evaluator
```

No network, no credentials, safe to run anywhere. Speechmatics and Bedrock are
stubbed.

`integration.mjs` covers what is expensive or dangerous to get wrong server-side:
the Speechmatics job being deleted on every path, a malformed model response
failing loudly rather than yielding a partial note, a forged or expired cookie
being refused, and the residency guard rejecting a widening model id before any
request is signed.

`page.mjs` drives the real page in jsdom through its own controls — consent,
record, stop, draft, clear — with no test hooks in the production file. Three of
its assertions are DPIA claims rather than conveniences:

- recording is impossible before consent is ticked **and** a consult type chosen
- after Clear, no patient text survives anywhere in the DOM, consent is reset,
  and an abandoned transcription job is deleted server-side
- model output is rendered as text and never as markup — hostile content
  returned by the API creates no elements and executes nothing

Note that `S` and the other internals are not reachable from outside the page's
IIFE, deliberately. Tests must go through observable behaviour, which is the
right constraint: it means they exercise what actually happens rather than what
the code looks like.

No real patient audio until every box in DPIA Step 7 is ticked.
