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
// passcode form as the body, so site-check.js sees an unambiguous status code
// and a human sees somewhere to type. No separate login page to keep noindexed.

import { verifyToken, readToken, readCookie } from './api/_session.mjs';

export const config = { matcher: ['/ai-notes/:path*', '/implant/:path*', '/api/:path*'] };

// Tools that need more than a valid session: the env var names the people.
const RESTRICTED = { '/implant/': { env: 'IMPLANT_USERS', name: 'Implant Case Assessment' } };

const restrictionFor = (pathname) => {
  for (const prefix of Object.keys(RESTRICTED)) if (pathname.indexOf(prefix) === 0) return RESTRICTED[prefix];
  return null;
};

// "AM, SM" -> ['AM','SM']. Case and spacing are the author's business, not the
// reader's, so both are normalised before comparing.
const allowedFrom = (value) =>
  String(value || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);

// Paths that must stay reachable without a session.
const OPEN_PATHS = new Set([
  '/api/auth',            // otherwise there is no way to ever log in
  '/ai-notes/sw.js',      // service worker script; contains nothing, but registration
                          // must not depend on cookie freshness
  '/implant/sw.js',       // the replacement worker: it exists to evict the caching
                          // one installed before the tool was gated, so it must be
                          // fetchable by a browser that has no session
  '/ai-notes/encoder.js'  // the Opus encoder (opus-recorder, MIT). A public
                          // library with nothing of ours in it; the AudioWorklet
                          // module fetch must not depend on cookie handling.
]);

export default async function middleware(request) {
  const url = new URL(request.url);
  const { pathname } = url;

  if (OPEN_PATHS.has(pathname)) return;

  const token = readCookie(request.headers.get('cookie'));
  const secret = process.env.SESSION_SECRET;
  const restricted = restrictionFor(pathname);
  const wantsHtml = (request.headers.get('accept') || '').includes('text/html');

  if (restricted) {
    // Who signed in matters here, not just that someone did.
    const claims = await readToken(secret, token);
    if (claims) {
      const allowed = allowedFrom(process.env[restricted.env]);
      const who = String(claims.who || '').toUpperCase();
      if (allowed.length && who && allowed.indexOf(who) !== -1) return;
      // Signed in, but not this person (or the list is unset). A 403 says the
      // passcode worked and the door is still shut, so nobody wastes an
      // afternoon retyping a passcode that was right all along.
      const why = allowed.length
        ? 'This tool is not available to you at the moment.'
        : 'This tool is closed: no one is on its access list yet.';
      if (!wantsHtml) {
        return new Response(JSON.stringify({ error: 'not_permitted' }), {
          status: 403,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' }
        });
      }
      return new Response(deniedPage(restricted.name, why), {
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
  } else if (await verifyToken(secret, token)) {
    return;
  }

  if (!wantsHtml) {
    return new Response(JSON.stringify({ error: 'unauthenticated' }), {
      status: 401,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-robots-tag': 'noindex, nofollow'
      }
    });
  }

  return new Response(challengePage(restricted ? restricted.name : 'AI Notes'), {
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

function deniedPage(toolName, why) {
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
  <p>It is a preview: every clinical figure in it is a draft awaiting review, so it is kept to its author until that review is done.</p>
  <p><a href="/">Back to the other tools</a></p>
</div>
</body>
</html>`;
}

function challengePage(toolName) {
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
  h1 { margin: 0 0 4px; font-size: 1.05rem; letter-spacing: .01em; }
  p  { margin: 0 0 20px; font-size: .875rem; color: #5c5c56; }
  label { display: block; font-size: .8125rem; font-weight: 600; margin-bottom: 6px; }
  input {
    width: 100%; padding: 12px; font-size: 16px; font-family: inherit;
    border: 1px solid #c9c9c2; border-radius: 6px; background: #fff; color: inherit;
  }
  input:focus-visible, button:focus-visible { outline: 2px solid #1a1a1a; outline-offset: 2px; }
  button {
    width: 100%; margin-top: 14px; padding: 12px; font: inherit; font-weight: 600;
    border: 0; border-radius: 6px; background: #1a1a1a; color: #fff; cursor: pointer;
  }
  button:disabled { opacity: .55; cursor: default; }
  .err { margin: 14px 0 0; font-size: .8125rem; color: #a3241c; min-height: 1.2em; }
</style>
</head>
<body>
<form id="f" autocomplete="off">
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
         required autofocus>
  <button id="b" type="submit">Unlock</button>
  <p class="err" id="e" role="status" aria-live="polite"></p>
</form>
<script>
  var f = document.getElementById('f'), b = document.getElementById('b'), e = document.getElementById('e');
  f.addEventListener('submit', async function (ev) {
    ev.preventDefault();
    b.disabled = true; e.textContent = '';
    try {
      var r = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passcode: document.getElementById('p').value })
      });
      if (r.ok) { location.reload(); return; }
      // Distinguish the failure modes. Reporting "wrong passcode" for a server
      // that has no passcode configured sends you looking in the wrong place.
      if (r.status === 429) {
        e.textContent = 'Too many attempts. Wait a minute and try again.';
      } else if (r.status === 500) {
        e.textContent = 'Not a passcode problem \u2014 the server has no passcode set. Add APP_USERS and SESSION_SECRET in Vercel (Production scope), then redeploy.';
      } else if (r.status === 404 || r.status === 405) {
        e.textContent = 'The sign-in endpoint returned ' + r.status + '. The deployment may be mid-build.';
      } else {
        e.textContent = 'That passcode was not recognised.';
      }
    } catch (err) {
      e.textContent = 'Could not reach the server. Check the connection.';
    }
    b.disabled = false;
  });
</script>
</body>
</html>`;
}
