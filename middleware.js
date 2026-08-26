// middleware.js  (project root — Vercel Edge Middleware)
//
// Gates /ai-notes/ and /api/ only. Everything else on the site is untouched.
//
// Returning undefined lets the request continue to its destination. This is the
// one behaviour to confirm on first deploy: if the five public tools 401 after
// deploying, the matcher is wrong — check it before anything else.
//
// Unauthenticated requests get a 401. Navigations get a 401 *with* an HTML
// passcode form as the body, so site-check.js sees an unambiguous status code
// and a human sees somewhere to type. No separate login page to keep noindexed.

import { verifyToken, readCookie } from './api/_session.mjs';

export const config = { matcher: ['/ai-notes/:path*', '/api/:path*'] };

// Paths that must stay reachable without a session.
const OPEN_PATHS = new Set([
  '/api/auth',        // otherwise there is no way to ever log in
  '/ai-notes/sw.js'   // service worker script; contains nothing, but registration
                      // must not depend on cookie freshness
]);

export default async function middleware(request) {
  const url = new URL(request.url);
  const { pathname } = url;

  if (OPEN_PATHS.has(pathname)) return;

  const token = readCookie(request.headers.get('cookie'));
  const ok = await verifyToken(process.env.SESSION_SECRET, token);
  if (ok) return;

  const wantsHtml = (request.headers.get('accept') || '').includes('text/html');

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

  return new Response(challengePage(), {
    status: 401,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
      'referrer-policy': 'no-referrer'
    }
  });
}

function challengePage() {
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>AI Notes</title>
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
  <h1>AI Notes</h1>
  <p>Enter the passcode to continue.</p>
  <label for="p">Passcode</label>
  <input id="p" name="passcode" type="password" inputmode="numeric" autocomplete="current-password" required autofocus>
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
        e.textContent = 'Not a passcode problem \u2014 the server has no passcode set. Add APP_PASSCODE and SESSION_SECRET in Vercel (Production scope), then redeploy.';
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
