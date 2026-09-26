// middleware.js  (project root — Vercel Edge Middleware)
//
// Gates /ai-notes/, /implant/ and /api/ only. Everything else on the site is
// untouched.
//
// /implant/ is gated more tightly than /ai-notes/: a valid session is not
// enough, the person behind it must be named in IMPLANT_USERS. The clinical
// figures in that tool are drafts, and until they are reviewed the clinical
// lead is the only one who should see them. If IMPLANT_USERS is unset the tool
// is closed to everybody, including him: an unset variable must never be the
// thing that opens a door.
//
// Returning undefined lets the request continue to its destination. This is the
// one behaviour to confirm on first deploy: if the five public tools 401 after
// deploying, the matcher is wrong — check it before anything else.
//
// Unauthenticated requests get a 401. Navigations get a 401 *with* an HTML
// sign-in form as the body, so site-check.js sees an unambiguous status code
// and a human sees somewhere to type. No separate login page to keep noindexed.
//
// "Signed in" means resolveSession in api/_store.mjs says so: a genuine cookie
// whose staff account is still active at the same epoch, or, while APP_USERS is
// still set (or there is no account store at all), a passcode-era cookie. The
// Node handlers ask the same question again with their own copy of the list.
//
// /ai-notes/admin/ is for admins only, and /ai-notes/setup/ is open: a
// colleague setting up their account has no session yet, and the invite token
// in the link is what lets them in (see api/account.mjs).

import { resolveSession, storeState, appUsersSet } from './api/_store.mjs';
import { readCookie } from './api/_session.mjs';

export const config = { matcher: ['/ai-notes/:path*', '/implant/:path*', '/api/:path*'] };

// "AM, SM" -> ['AM','SM']. Case and spacing are the author's business, not the
// reader's, so both are normalised before comparing.
const allowedFrom = (value) =>
  String(value || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);

// Pages that need more than a valid session.
const RESTRICTED = {
  '/implant/': {
    name: 'Implant Case Assessment',
    json: 'not_permitted',
    // Who signed in matters here, not just that someone did. The env var names
    // the people; unset means nobody.
    check: (session) => {
      const allowed = allowedFrom(process.env.IMPLANT_USERS);
      const who = String(session.who || '').toUpperCase();
      return allowed.length && who && allowed.indexOf(who) !== -1
        ? null
        : allowed.length ? 'This tool is not available to you at the moment.' : 'This tool is closed: no one is on its access list yet.';
    },
    blurb: 'It is a preview: every clinical figure in it is a draft awaiting review, so it is kept to its author until that review is done.'
  },
  '/ai-notes/admin/': {
    name: 'Staff accounts',
    json: 'not_permitted',
    check: (session) => (session.admin ? null : 'This page is for the practice\u2019s account administrator.'),
    blurb: 'Ask the practice owner if a colleague needs adding, or you need a new setup link.'
  }
};

// The bare path counts too. The matcher sends '/implant' (no slash) here and
// Vercel serves the same index.html for it, so checking only '/implant/...'
// let any signed-in clinician walk in by leaving the slash off.
// Always called with the NORMALISED path (see normalisePath).
const restrictionFor = (pathname) => {
  for (const prefix of Object.keys(RESTRICTED)) {
    if (pathname.indexOf(prefix) === 0 || pathname === prefix.slice(0, -1)) return RESTRICTED[prefix];
  }
  return null;
};

// Paths that must stay reachable without a session.
const OPEN_PATHS = new Set([
  '/api/auth',            // otherwise there is no way to ever log in
  '/api/account',         // account setup: the invite token is the key, and it
                          // is checked there (throttled, enumeration-safe)
  '/ai-notes/setup',      // the setup page: static, and the person using it
  '/ai-notes/setup/',     // cannot have a session yet
  '/ai-notes/setup/index.html',
  '/ai-notes/sw.js',      // service worker script; contains nothing, but registration
                          // must not depend on cookie freshness
  '/implant/sw.js',       // the replacement worker: it exists to evict the caching
                          // one installed before the tool was gated, so it must be
                          // fetchable by a browser that has no session
  '/ai-notes/encoder.js'  // the Opus encoder (opus-recorder, MIT). A public
                          // library with nothing of ours in it; the AudioWorklet
                          // module fetch must not depend on cookie handling.
]);

/* The path as the file system will see it, for deciding which rules apply.
   Comparing the raw path let spellings of the same place past the
   restrictions: /%69mplant/, /IMPLANT/, /ai-notes//admin/, /ai-notes/%61dmin/.
   Decoded, repeated slashes collapsed, dot segments resolved, lower-cased.
   Null if it cannot be decoded at all. Used only to decide MORE checks, never
   fewer: the open paths are still matched on the raw path, exactly. */
function normalisePath(pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  let resolved;
  try { resolved = new URL(decoded.replace(/\\/g, '/').replace(/\/{2,}/g, '/'), 'https://x.invalid').pathname; } catch { return null; }
  return resolved.toLowerCase();
}
const GUARDED = ['/ai-notes', '/implant', '/api'];
const underGuard = (p) => GUARDED.some((g) => p === g || p.indexOf(g + '/') === 0);
// Encoded slashes, backslashes and dots, or a doubled slash: no page or route
// here has a use for them, and each is a way of making one path look like
// another. Refused outright under the gated prefixes.
const SUSPECT = /%2f|%5c|%2e|\\|\/\//i;

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' };

export default async function middleware(request) {
  const url = new URL(request.url);
  const { pathname } = url;

  if (OPEN_PATHS.has(pathname)) return;

  const norm = normalisePath(pathname);
  if (norm === null || ((underGuard(norm) || underGuard(pathname.toLowerCase())) && SUSPECT.test(pathname))) {
    return new Response(JSON.stringify({ error: 'bad_path' }), { status: 400, headers: JSON_HEADERS });
  }

  // Deleting a transcription job must work even for a page whose session has
  // just ended: expired, or disabled from the admin page mid-consultation.
  // Otherwise the page's Clear cannot remove the job and the audio sits at
  // Speechmatics for a week, against the zero-retention claim. It needs the
  // job's ticket, which only this server can sign and which transcribe.mjs
  // checks; a ticket deletes a job and hands nobody anything.
  if (pathname === '/api/transcribe' && request.method === 'DELETE' &&
      /^[A-Za-z0-9_-]{4,64}$/.test(url.searchParams.get('jobId') || '') &&
      /^[a-f0-9]{64}$/.test(url.searchParams.get('ticket') || '')) return;

  const token = readCookie(request.headers.get('cookie'));
  const secret = process.env.SESSION_SECRET;
  const restricted = restrictionFor(norm);
  const wantsHtml = (request.headers.get('accept') || '').includes('text/html');
  const session = secret ? await resolveSession(secret, token) : null;

  if (session && !restricted) return;

  if (session && restricted) {
    const why = restricted.check(session);
    if (!why) return;
    // Signed in, but not this person (or the list is unset). A 403 says the
    // sign-in worked and the door is still shut, so nobody wastes an
    // afternoon retyping a password that was right all along.
    if (!wantsHtml) {
      return new Response(JSON.stringify({ error: restricted.json }), { status: 403, headers: JSON_HEADERS });
    }
    return new Response(deniedPage(restricted.name, why, restricted.blurb), {
      status: 403,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-robots-tag': 'noindex, nofollow',
        'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        'x-content-type-options': 'nosniff'
      }
    });
  }

  if (!wantsHtml) {
    return new Response(JSON.stringify({ error: 'unauthenticated' }), { status: 401, headers: JSON_HEADERS });
  }

  // Which sign-in forms to offer. No account store: the passcode form, exactly
  // as before accounts existed. A store: email and password, plus the
  // passcode form behind a link for as long as APP_USERS is set.
  const accounts = storeState() !== 'off';
  const passcodes = !accounts || appUsersSet();
  return new Response(challengePage(restricted ? restricted.name : 'AI Notes', { accounts, passcodes }), {
    status: 401,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
      'referrer-policy': 'no-referrer',
      // vercel.json headers do not reach this response: middleware short-circuits
      // before that layer. So the sign-in page, the one page carrying an inline
      // script and a password field, would otherwise be the only page on the
      // origin with no CSP at all. Set it here.
      'content-security-policy':
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
        "connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
      'permissions-policy': 'microphone=(), camera=(), geolocation=()'
    }
  });
}

function deniedPage(toolName, why, blurb) {
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${toolName}</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center; padding: 24px;
    background: #f7f7f5; color: #1a1a1a; font: 400 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  div { width: 100%; max-width: 360px; background: #fff; border: 1px solid #e2e2dd; border-radius: 10px; padding: 28px 24px; }
  h1 { margin: 0 0 8px; font-size: 1.05rem; }
  p { margin: 0 0 8px; font-size: .875rem; color: #5c5c56; }
  a { color: #1a1a1a; }
</style>
</head>
<body>
<div>
  <h1>${toolName}</h1>
  <p>${why}</p>
  <p>${blurb}</p>
  <p><a href="/">Back to the other tools</a></p>
</div>
</body>
</html>`;
}

/* The sign-in page. Up to two forms: the account form (email and password)
   when there is an account store, and the passcode form when passcodes still
   work. With both, the passcode one sits behind a link, so nobody new is
   taught the old way in. */
function challengePage(toolName, { accounts = false, passcodes = true } = {}) {
  const accountForm = `
<form id="fa" autocomplete="on"${accounts ? '' : ' hidden'}>
  <h1>${toolName}</h1>
  <p>Sign in with your email and password.</p>
  <label for="em">Email</label>
  <input id="em" name="email" type="email" autocomplete="username" autocapitalize="off" autocorrect="off" spellcheck="false" required${accounts ? ' autofocus' : ''}>
  <label for="pw">Password</label>
  <input id="pw" name="password" type="password" autocomplete="current-password" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="go" required>
  <button id="ba" type="submit">Sign in</button>
  <p class="err" id="ea" role="status" aria-live="polite"></p>
  ${passcodes ? '<p class="alt"><a href="#" id="toP">Sign in with a passcode instead</a></p>' : ''}
</form>`;
  const passcodeForm = `
<form id="fp" autocomplete="off"${accounts ? ' hidden' : ''}>
  <h1>${toolName}</h1>
  <p>Enter the passcode to continue.</p>
  <label for="p">Passcode</label>
  <!-- No inputmode="numeric" here. It was set on the assumption of a numeric PIN,
       which forces iOS to show the number pad and makes a passphrase literally
       impossible to type. The passcode is a passphrase precisely because the
       per-instance throttle cannot stop a determined guesser at four digits, so
       the field has to accept a full keyboard.
       autocapitalize/autocorrect off: iOS would otherwise capitalise the first
       word and autocorrect the rest, silently altering what you typed. -->
  <input id="p" name="passcode" type="password"
         autocomplete="current-password"
         autocapitalize="off" autocorrect="off" spellcheck="false"
         enterkeyhint="go"
         required${accounts ? '' : ' autofocus'}>
  <button id="b" type="submit">Unlock</button>
  <p class="err" id="e" role="status" aria-live="polite"></p>
  ${accounts ? '<p class="alt"><a href="#" id="toA">Sign in with email and password</a></p>' : ''}
</form>`;
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${toolName}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100dvh;
    display: grid; place-items: center; padding: 24px;
    background: #f7f7f5; color: #1a1a1a;
    font: 400 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  form {
    width: 100%; max-width: 340px;
    background: #fff; border: 1px solid #e2e2dd; border-radius: 10px;
    padding: 28px 24px;
  }
  form[hidden] { display: none; }
  h1 { margin: 0 0 4px; font-size: 1.05rem; letter-spacing: .01em; }
  p  { margin: 0 0 20px; font-size: .875rem; color: #5c5c56; }
  label { display: block; font-size: .8125rem; font-weight: 600; margin-bottom: 6px; }
  input {
    width: 100%; padding: 12px; font-size: 16px; font-family: inherit;
    border: 1px solid #c9c9c2; border-radius: 6px; background: #fff; color: inherit;
  }
  input + label { margin-top: 14px; }
  input:focus-visible, button:focus-visible, a:focus-visible { outline: 2px solid #1a1a1a; outline-offset: 2px; }
  button {
    width: 100%; margin-top: 14px; padding: 12px; font: inherit; font-weight: 600;
    border: 0; border-radius: 6px; background: #1a1a1a; color: #fff; cursor: pointer;
  }
  button:disabled { opacity: .55; cursor: default; }
  .err { margin: 14px 0 0; font-size: .8125rem; color: #a3241c; min-height: 1.2em; }
  .alt { margin: 10px 0 0; font-size: .8125rem; }
  .alt a { color: #1a1a1a; }
</style>
</head>
<body>
${accounts ? accountForm : ''}
${passcodes ? passcodeForm : ''}
<script>
  function $(id) { return document.getElementById(id); }
  function swap(show, hide) {
    $(hide).hidden = true; $(show).hidden = false;
    var first = $(show).querySelector('input'); if (first) first.focus();
  }
  if ($('toP')) $('toP').addEventListener('click', function (ev) { ev.preventDefault(); swap('fp', 'fa'); });
  if ($('toA')) $('toA').addEventListener('click', function (ev) { ev.preventDefault(); swap('fa', 'fp'); });

  // One sender for both forms. Distinguish the failure modes that are the
  // SERVER's: reporting "wrong password" for a server with nothing configured
  // sends you looking in the wrong place. The ones that are about what was
  // typed stay deliberately vague: which part was wrong is for nobody to know.
  async function send(form, button, out, payload, wrong) {
    button.disabled = true; out.textContent = '';
    try {
      var r = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (r.ok) { location.reload(); return; }
      if (r.status === 429) {
        out.textContent = 'Too many attempts. Wait fifteen minutes and try again.';
      } else if (r.status === 500) {
        out.textContent = 'Not a problem with what you typed — sign-in is not set up on the server. Check SESSION_SECRET and APP_USERS or GLOBAL_CONFIG in Vercel (Production scope), then redeploy.';
      } else if (r.status === 503) {
        out.textContent = 'Sign-in is unavailable: the staff list could not be read. Try again in a minute.';
      } else if (r.status === 404 || r.status === 405) {
        out.textContent = 'The sign-in endpoint returned ' + r.status + '. The deployment may be mid-build.';
      } else {
        out.textContent = wrong;
      }
    } catch (err) {
      out.textContent = 'Could not reach the server. Check the connection.';
    }
    button.disabled = false;
  }

  if ($('fa')) $('fa').addEventListener('submit', function (ev) {
    ev.preventDefault();
    send($('fa'), $('ba'), $('ea'),
      { email: $('em').value, password: $('pw').value },
      'That email and password were not recognised.');
  });
  if ($('fp')) $('fp').addEventListener('submit', function (ev) {
    ev.preventDefault();
    send($('fp'), $('b'), $('e'), { passcode: $('p').value }, 'That passcode was not recognised.');
  });
</script>
</body>
</html>`;
}
