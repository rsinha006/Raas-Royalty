/* ------------------------------------------------------------------ *
 * Royalty — the offline app shell.
 *
 * The problem this solves is narrow and specific: the schedule cache in
 * session.ts only helps a page that is *already loaded*. Pull-to-refresh on
 * dead venue wifi throws the whole thing away and shows a browser error — and
 * refreshing is exactly what someone does when the screen looks stale. So this
 * worker caches the shell (the HTML and the one JS/CSS pair the build emits)
 * and nothing else.
 *
 * "Nothing else" is the load-bearing half. This project's whole premise is that
 * a wrong schedule is worse than an absent one, and a service worker is the
 * easiest place in a web app to serve a stale answer while looking live. So:
 *
 *   /api/*        never touched. Not cached, not intercepted, not retried. The
 *                 app already has its own schedule cache, and that one is
 *                 rendered behind an "Offline · last known …" banner with the
 *                 timestamp it was captured at. A cached /api/schedule here
 *                 would come back through the normal code path and render as
 *                 live. That is the bug this project exists to prevent.
 *   /socket.io/*  same, and pointless offline besides.
 *   /s/:code      network only. Redeeming a code needs the server, and the
 *                 response sets a session cookie — not something to keep on a
 *                 shared phone. See signInNeedsNetwork() for why this cannot
 *                 fall back to the shell.
 *   /admin        network only. It is a write surface; an offline logistics
 *                 panel is an admin believing they saved something.
 *
 * What is left is the viewer shell, which is identical for all ~280 people and
 * contains nothing personal.
 * ------------------------------------------------------------------ */

/** Injected by the build — changes whenever any precached file changes. */
const BUILD_ID = '__BUILD_ID__';

const CACHE_PREFIX = 'royalty-shell-';
const CACHE_NAME = `${CACHE_PREFIX}${BUILD_ID}`;

/**
 * Every file the shell needs, listed by the build from the real bundle rather
 * than guessed at here. Vite content-hashes these names, so an entry is
 * immutable: a hit is always the right bytes, and a new build is a new list
 * under a new cache name.
 */
const PRECACHE = __PRECACHE_MANIFEST__;

/**
 * The shell is stored under one key regardless of the URL that fetched it, so
 * `/`, `/?now=2026-08-08T13:05` and a deep link don't each cache their own
 * copy of the same HTML.
 */
const SHELL_KEY = '/';

/**
 * How long a navigation waits for the network before the cached shell wins.
 *
 * The failure mode this number is for is not "no signal" — that rejects
 * immediately. It is venue wifi that is associated but not moving packets,
 * where the request hangs until the browser gives up, which is far longer than
 * anyone stands still for. The network response is still awaited in the
 * background and still refreshes the cache when it lands.
 */
const NAVIGATION_TIMEOUT_MS = 3500;

/* ------------------------------ lifecycle ------------------------------ */

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // addAll is all-or-nothing on purpose. A half-precached shell is a white
      // screen offline, which is worse than the browser error we started with;
      // failing the install leaves the old worker in charge and retries later.
      await cache.addAll(PRECACHE);
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

/* -------------------------------- routing -------------------------------- */

const isApi = (url) => url.pathname === '/api' || url.pathname.startsWith('/api/');
const isSocket = (url) => url.pathname.startsWith('/socket.io');
const isMagicLink = (url) => url.pathname === '/s' || url.pathname.startsWith('/s/');
const isAdmin = (url) => url.pathname === '/admin' || url.pathname.startsWith('/admin/');

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Anything that changes server state goes straight out, untouched.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Returning without calling respondWith leaves the request entirely alone —
  // no interception, no chance of a stale answer. See the header comment.
  if (isApi(url) || isSocket(url)) return;

  if (request.mode === 'navigate') {
    if (isMagicLink(url)) return event.respondWith(signInNeedsNetwork(request));
    if (isAdmin(url)) return event.respondWith(adminNeedsNetwork(request));
    return event.respondWith(navigate(request));
  }

  event.respondWith(shellAsset(request));
});

/* ------------------------------ strategies ------------------------------ */

/**
 * Navigations are network-first, and that direction matters more than it looks.
 *
 * Cache-first would mean a phone that installed this worker on Friday keeps
 * serving Friday's HTML — and therefore Friday's asset hashes — through every
 * refresh, so an emergency fix during the event would reach nobody who had
 * already opened the app. Network-first costs a round trip that the timeout
 * bounds, and buys "a reload always gets the current build when there is
 * signal".
 */
async function navigate(request) {
  const cache = await caches.open(CACHE_NAME);
  const network = fetch(request).then(async (response) => {
    if (isStorableShell(response)) await cache.put(SHELL_KEY, response.clone());
    return response;
  });

  const cached = await cache.match(SHELL_KEY);
  if (!cached) {
    // Nothing to fall back to, so the network is the only possible answer —
    // wait for it however long it takes rather than inventing an offline page
    // for someone who has never successfully loaded the app.
    try {
      return await network;
    } catch {
      return offlinePage(
        'No connection',
        'Royalty could not be reached, and this device has not loaded it before.',
        'Reconnect and try again.'
      );
    }
  }

  // Whichever lands first: the network's answer, or null from a failure or the
  // timeout. The network keeps going either way and still refreshes the cache.
  const raced = await Promise.race([network.catch(() => null), sleep(NAVIGATION_TIMEOUT_MS)]);
  return raced ?? cached;
}

/**
 * Hashed assets are served from the cache and never written to it at runtime.
 *
 * Only what the build declared is ever stored, which is what keeps anything
 * personal — a redeemed link, a schedule response — out of a cache that
 * outlives the session and is shared by everyone who uses this phone. A miss
 * means an asset from a different build, and the network is the right answer.
 */
async function shellAsset(request) {
  const cached = await caches.match(request, { cacheName: CACHE_NAME });
  return cached ?? fetch(request);
}

/**
 * A magic link cannot be served the shell offline, and the reason is not
 * subtlety about correctness — it is a redirect loop. `/s/:code` is handled by
 * the server, so App.tsx treats the path as a build mismatch and calls
 * `location.replace(path)`. Answering that navigation from the cache means the
 * same shell, the same replace, forever, on a phone with no signal.
 */
function signInNeedsNetwork(request) {
  return passThrough(request, () =>
    offlinePage(
      'Signing in needs a connection',
      'Your access link has to be checked by the server, so it cannot be opened offline.',
      'Reconnect and tap your link again. If you have already used Royalty on this phone, ' +
        '<a href="/">open your saved schedule</a>.'
    )
  );
}

function adminNeedsNetwork(request) {
  return passThrough(request, () =>
    offlinePage(
      'The logistics panel needs a connection',
      'Every change here is written on the server, so there is nothing useful to show offline.',
      'Reconnect and reload.'
    )
  );
}

/** Straight to the network, with a written explanation instead of an error. */
async function passThrough(request, fallback) {
  try {
    return await fetch(request);
  } catch {
    return fallback();
  }
}

/* -------------------------------- helpers -------------------------------- */

/**
 * Whether a navigation response is safe to keep as the shell.
 *
 * The case worth naming is a captive portal: hotel and venue wifi answers every
 * request with 200 and its own sign-in page. Caching that as the shell would
 * hand every later offline reload a wifi login screen instead of a schedule,
 * and it would survive until the next successful load. A portal redirects to
 * its own host, so `redirected` catches it; the rest is ordinary hygiene.
 */
function isStorableShell(response) {
  return Boolean(
    response &&
      response.ok &&
      !response.redirected &&
      response.type !== 'opaque' &&
      (response.headers.get('content-type') || '').includes('text/html')
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(() => resolve(null), ms));

/**
 * Deliberately hand-written rather than a cached page: it has to work when the
 * shell is exactly what we cannot serve, and it is the only screen at this
 * event that appears without the app running.
 */
function offlinePage(title, body, action) {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0d0b14">
<title>${title} — Royalty</title>
<style>
  html { color-scheme: dark; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center;
    background: #0d0b14; color: #f5f2fa; padding: 24px;
    font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  main { max-width: 32rem; margin: 0 auto; }
  h1 { font-size: 24px; line-height: 1.25; margin: 0 0 12px; }
  p { color: #a89fbd; margin: 0 0 12px; }
  a { color: #f0c34a; }
</style>
</head>
<body>
  <main>
    <h1>${title}</h1>
    <p>${body}</p>
    <p>${action}</p>
  </main>
</body>
</html>`;
  return new Response(html, {
    status: 503,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
