/**
 * The offline app shell — item 10.
 *
 * A service worker is the easiest place in a web app to serve a stale answer
 * while looking live, and this project's premise is that a wrong schedule is
 * worse than an absent one. So most of what follows asserts what the worker
 * does *not* do: never touch `/api/*`, never keep a magic link, never cache a
 * captive portal's sign-in page as the app.
 *
 * The worker under test is the real generated artefact — `buildServiceWorker`
 * is the same function `vite-plugin-sw.js` calls at build time — evaluated in a
 * fake ServiceWorkerGlobalScope so the routing is exercised rather than read.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const { buildServiceWorker, shellManifest } = await import('../client/vite-plugin-sw.js');

const ORIGIN = 'https://royalty.example';

/** Stands in for a Vite bundle: one HTML entry, one JS chunk, one stylesheet. */
const BUNDLE = ['index.html', 'assets/index-CrhYWV1D.js', 'assets/index-5xQZJJuZ.css'];

/* ----------------------------- fake platform ----------------------------- */

const urlKey = (request) =>
  typeof request === 'string' ? new URL(request, ORIGIN).href : request.url;

class FakeCache {
  constructor(net) {
    this.store = new Map();
    this.net = net;
  }
  async addAll(urls) {
    // All-or-nothing, like the real one: fetch everything before storing any.
    const fetched = [];
    for (const url of urls) {
      const response = await this.net.fetch(new Request(new URL(url, ORIGIN)));
      if (!response || !response.ok) throw new TypeError(`addAll failed: ${url}`);
      fetched.push([new URL(url, ORIGIN).href, response]);
    }
    for (const [key, response] of fetched) this.store.set(key, response);
  }
  async put(request, response) {
    this.store.set(urlKey(request), response);
  }
  async match(request) {
    return this.store.get(urlKey(request));
  }
  async keys() {
    return [...this.store.keys()];
  }
}

class FakeCacheStorage {
  constructor(net) {
    this.caches = new Map();
    this.net = net;
  }
  async open(name) {
    if (!this.caches.has(name)) this.caches.set(name, new FakeCache(this.net));
    return this.caches.get(name);
  }
  async keys() {
    return [...this.caches.keys()];
  }
  async delete(name) {
    return this.caches.delete(name);
  }
  async match(request, options = {}) {
    const names = options.cacheName ? [options.cacheName] : [...this.caches.keys()];
    for (const name of names) {
      const hit = await this.caches.get(name)?.match(request);
      if (hit) return hit;
    }
    return undefined;
  }
}

/**
 * Loads the generated worker into its own realm and returns handles for
 * driving it: the lifecycle events, a fetch dispatcher, and the caches it
 * wrote to.
 */
function loadWorker({ fileNames = BUNDLE } = {}) {
  const source = buildServiceWorker(fileNames);
  const listeners = new Map();

  /** Swapped per test — `net.fetch` is the entire outside world. */
  const net = {
    fetch: async () => {
      throw new TypeError('Failed to fetch');
    },
    calls: [],
  };
  const trackedFetch = (input, init) => {
    net.calls.push(typeof input === 'string' ? input : input.url);
    return net.fetch(input, init);
  };

  const cacheStorage = new FakeCacheStorage({ fetch: (...args) => trackedFetch(...args) });
  let claimed = false;
  let skipped = false;

  const self = {
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    skipWaiting: async () => {
      skipped = true;
    },
    clients: {
      claim: async () => {
        claimed = true;
      },
    },
  };

  const sandbox = {
    self,
    caches: cacheStorage,
    fetch: trackedFetch,
    Request,
    Response,
    URL,
    setTimeout,
    clearTimeout,
    console,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, vm.createContext(sandbox), { filename: 'sw.js' });

  /** Runs the lifecycle handler and awaits whatever it passed to waitUntil. */
  const lifecycle = async (type) => {
    const pending = [];
    for (const handler of listeners.get(type) ?? []) {
      handler({ waitUntil: (promise) => pending.push(promise) });
    }
    await Promise.all(pending);
  };

  /**
   * Returns the response the worker produced, or `undefined` when it declined
   * to call respondWith — which is the meaningful outcome for `/api/*`,
   * because it means the request was never intercepted at all.
   */
  const dispatchFetch = (url, { mode = 'no-cors', method = 'GET' } = {}) => {
    const request = new Request(new URL(url, ORIGIN), { method });
    // `mode` is read-only on a real Request and always 'navigate' for a page
    // load, which the fetch constructor refuses to build.
    Object.defineProperty(request, 'mode', { value: mode, configurable: true });
    let responded;
    for (const handler of listeners.get('fetch') ?? []) {
      handler({ request, respondWith: (value) => (responded = value) });
    }
    return responded;
  };

  return {
    source,
    net,
    cacheStorage,
    lifecycle,
    dispatchFetch,
    shellCacheName: async () =>
      (await cacheStorage.keys()).find((name) => name.startsWith('royalty-shell-')),
    get claimed() {
      return claimed;
    },
    get skipped() {
      return skipped;
    },
  };
}

const html = (body = '<!doctype html><title>Royalty</title>', init = {}) =>
  new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    ...init,
  });

const asset = (body = 'console.log(1)') =>
  new Response(body, { status: 200, headers: { 'Content-Type': 'application/javascript' } });

/** A network that serves the shell and the bundle, and nothing else. */
const onlineServer = async (request) => {
  const { pathname } = new URL(request.url);
  if (pathname.endsWith('.js') || pathname.endsWith('.css')) return asset(`/* ${pathname} */`);
  return html(`<!doctype html><title>Royalty</title><!-- ${pathname} -->`);
};

const offlineNetwork = async () => {
  throw new TypeError('Failed to fetch');
};

/* -------------------------------- manifest -------------------------------- */

describe('the generated worker', () => {
  test('precaches the shell entry and every hashed asset, but not the HTML file', () => {
    const manifest = shellManifest(BUNDLE);
    assert.deepEqual(manifest, [
      '/',
      '/assets/index-5xQZJJuZ.css',
      '/assets/index-CrhYWV1D.js',
    ]);
    // index.html is reached as '/', which is what the server serves and what
    // the navigation strategy falls back to. Caching both would mean two
    // copies of one document that can disagree.
    assert.ok(!manifest.includes('/index.html'));
  });

  test('leaves no placeholder unfilled', () => {
    const source = buildServiceWorker(BUNDLE);
    assert.ok(!source.includes('__PRECACHE_MANIFEST__'));
    assert.ok(!source.includes('__BUILD_ID__'));
  });

  test('the build id tracks the shell contents, so a deploy reaches phones', () => {
    const same = buildServiceWorker(BUNDLE);
    const rebuilt = buildServiceWorker([...BUNDLE].reverse());
    const changed = buildServiceWorker(['index.html', 'assets/index-NEWHASH1.js']);

    // A rebuild with identical output must not churn the cache…
    assert.equal(same, rebuilt);
    // …and a changed bundle must produce a byte-different worker, because a
    // byte-identical sw.js is ignored by the browser and nothing updates.
    assert.notEqual(same, changed);
  });
});

/* -------------------------------- lifecycle -------------------------------- */

describe('install and activate', () => {
  test('install precaches the whole shell and takes over immediately', async () => {
    const sw = loadWorker();
    sw.net.fetch = onlineServer;
    await sw.lifecycle('install');

    const cache = await sw.cacheStorage.open(await sw.shellCacheName());
    assert.deepEqual((await cache.keys()).sort(), [
      `${ORIGIN}/`,
      `${ORIGIN}/assets/index-5xQZJJuZ.css`,
      `${ORIGIN}/assets/index-CrhYWV1D.js`,
    ]);
    assert.equal(sw.skipped, true);
  });

  test('a shell that will not download fails the install rather than half-caching', async () => {
    const sw = loadWorker();
    sw.net.fetch = async (request) =>
      request.url.endsWith('.css') ? new Response('nope', { status: 500 }) : html();

    await assert.rejects(() => sw.lifecycle('install'));
    const cache = await sw.cacheStorage.open(await sw.shellCacheName());
    // Nothing stored: a shell missing its stylesheet is a white screen offline,
    // which is worse than the browser error this item exists to remove.
    assert.deepEqual(await cache.keys(), []);
  });

  test('activate drops older shells and claims open pages', async () => {
    const sw = loadWorker();
    sw.net.fetch = onlineServer;
    await sw.cacheStorage.open('royalty-shell-oldbuild0001');
    await sw.cacheStorage.open('something-else-entirely');

    await sw.lifecycle('install');
    await sw.lifecycle('activate');

    const names = await sw.cacheStorage.keys();
    assert.ok(!names.includes('royalty-shell-oldbuild0001'));
    // Only ours. A worker that deletes every cache on the origin is a worker
    // that breaks whatever else is deployed there later.
    assert.ok(names.includes('something-else-entirely'));
    assert.equal(sw.claimed, true);
  });
});

/* --------------------------- what is never cached --------------------------- */

describe('requests the worker refuses to touch', () => {
  let sw;

  beforeEach(async () => {
    sw = loadWorker();
    sw.net.fetch = onlineServer;
    await sw.lifecycle('install');
    await sw.lifecycle('activate');
  });

  for (const path of [
    '/api/schedule',
    '/api/session',
    '/api/time?at=2026-08-08T13:05',
    '/api/bootstrap',
  ]) {
    test(`${path} is not intercepted at all`, () => {
      // Not "fetched and not stored" — never handled, so there is no code path
      // in which a schedule from twenty minutes ago comes back looking live.
      // The app's own cache handles offline, behind its "last known" banner.
      assert.equal(sw.dispatchFetch(path), undefined);
    });
  }

  test('socket.io traffic is not intercepted', () => {
    assert.equal(sw.dispatchFetch('/socket.io/?EIO=4&transport=polling'), undefined);
  });

  test('non-GET requests are not intercepted', () => {
    assert.equal(sw.dispatchFetch('/api/session', { method: 'POST' }), undefined);
    assert.equal(sw.dispatchFetch('/', { method: 'POST', mode: 'navigate' }), undefined);
  });

  test('cross-origin requests are not intercepted', () => {
    assert.equal(sw.dispatchFetch('https://example.com/tracker.js'), undefined);
  });

  test('a magic link goes to the network and is never stored', async () => {
    const response = await sw.dispatchFetch('/s/K7M2QX8P', { mode: 'navigate' });
    assert.equal(response.status, 200);

    const cache = await sw.cacheStorage.open(await sw.shellCacheName());
    const keys = await cache.keys();
    // A redeemed link is a credential; the shell cache outlives the session and
    // is shared by everyone who uses the phone.
    assert.ok(!keys.some((key) => key.includes('/s/')));
  });
});

/* ------------------------------- navigation ------------------------------- */

describe('navigating with no signal', () => {
  let sw;

  beforeEach(async () => {
    sw = loadWorker();
    sw.net.fetch = onlineServer;
    await sw.lifecycle('install');
    await sw.lifecycle('activate');
  });

  test('a reload serves the cached shell instead of a browser error', async () => {
    sw.net.fetch = offlineNetwork;
    const response = await sw.dispatchFetch('/', { mode: 'navigate' });

    assert.equal(response.status, 200);
    assert.match(await response.text(), /Royalty/);
  });

  test('a deep link with a rehearsal override also lands on the shell', async () => {
    sw.net.fetch = offlineNetwork;
    const response = await sw.dispatchFetch('/?now=2026-08-08T13:05', { mode: 'navigate' });
    assert.equal(response.status, 200);
  });

  test('hashed assets come from the cache', async () => {
    sw.net.fetch = offlineNetwork;
    const response = await sw.dispatchFetch('/assets/index-CrhYWV1D.js');
    assert.equal(response.status, 200);
    assert.match(await response.text(), /index-CrhYWV1D\.js/);
  });

  test('a magic link explains itself instead of looping forever', async () => {
    sw.net.fetch = offlineNetwork;
    const response = await sw.dispatchFetch('/s/K7M2QX8P', { mode: 'navigate' });
    const body = await response.text();

    assert.equal(response.status, 503);
    assert.match(body, /Signing in needs a connection/);
    // The shell would be worse than an error page here: App.tsx sends any /s/
    // path back to the server with location.replace, so answering from the
    // cache is an infinite redirect on a phone with no signal.
    assert.doesNotMatch(body, /<div id="root">/);
    // …and it points at the schedule they already have.
    assert.match(body, /href="\/"/);
  });

  test('the admin panel says it needs a connection rather than pretending', async () => {
    sw.net.fetch = offlineNetwork;
    const response = await sw.dispatchFetch('/admin', { mode: 'navigate' });

    assert.equal(response.status, 503);
    assert.match(await response.text(), /logistics panel needs a connection/);
  });

  test('a first-ever visit with no cache and no network says so plainly', async () => {
    const fresh = loadWorker();
    fresh.net.fetch = offlineNetwork;
    const response = await fresh.dispatchFetch('/', { mode: 'navigate' });

    assert.equal(response.status, 503);
    assert.match(await response.text(), /has not loaded it before/);
  });
});

describe('navigating with signal', () => {
  let sw;

  beforeEach(async () => {
    sw = loadWorker();
    sw.net.fetch = onlineServer;
    await sw.lifecycle('install');
    await sw.lifecycle('activate');
  });

  test('the network wins, so a new build is picked up on the next reload', async () => {
    sw.net.fetch = async () => html('<!doctype html><title>Royalty</title><!-- build 2 -->');
    const response = await sw.dispatchFetch('/', { mode: 'navigate' });

    assert.match(await response.text(), /build 2/);
  });

  test('a successful navigation refreshes the cached shell', async () => {
    sw.net.fetch = async () => html('<!doctype html><title>Royalty</title><!-- build 2 -->');
    await sw.dispatchFetch('/', { mode: 'navigate' });

    sw.net.fetch = offlineNetwork;
    const offline = await sw.dispatchFetch('/', { mode: 'navigate' });
    assert.match(await offline.text(), /build 2/);
  });

  test('every navigation refreshes one shell entry, not one per URL', async () => {
    await sw.dispatchFetch('/?now=2026-08-08T13:05', { mode: 'navigate' });
    await sw.dispatchFetch('/', { mode: 'navigate' });

    const cache = await sw.cacheStorage.open(await sw.shellCacheName());
    const shells = (await cache.keys()).filter((key) => !key.includes('/assets/'));
    assert.deepEqual(shells, [`${ORIGIN}/`]);
  });

  test('a captive portal is shown but never becomes the app', async () => {
    // Venue and hotel wifi answer every request with 200 and their own sign-in
    // page. Caching that as the shell would hand every later offline reload a
    // wifi login screen, and it would stay until the next successful load.
    const portal = html('<!doctype html><title>Hotel WiFi</title>');
    Object.defineProperty(portal, 'redirected', { value: true });
    sw.net.fetch = async () => portal;

    const live = await sw.dispatchFetch('/', { mode: 'navigate' });
    assert.match(await live.text(), /Hotel WiFi/);

    sw.net.fetch = offlineNetwork;
    const offline = await sw.dispatchFetch('/', { mode: 'navigate' });
    assert.match(await offline.text(), /Royalty/);
  });

  test('a server error is shown rather than papered over with the cache', async () => {
    sw.net.fetch = async () => new Response('boom', { status: 500 });
    const response = await sw.dispatchFetch('/', { mode: 'navigate' });

    // Honesty again: a 500 is a real answer from a reachable server, and
    // showing yesterday's shell would hide a broken deploy from whoever can fix
    // it. It is also not stored.
    assert.equal(response.status, 500);
    const cache = await sw.cacheStorage.open(await sw.shellCacheName());
    assert.match(await (await cache.match('/')).text(), /Royalty/);
  });

  test('wifi that is connected but dead falls back to the shell', async () => {
    // The case the timeout exists for: associated, not moving packets, the
    // request hanging until the browser gives up long after anyone has stopped
    // waiting. Nothing rejects, so only elapsed time distinguishes it.
    sw.net.fetch = () => new Promise(() => {});
    const started = Date.now();
    const response = await sw.dispatchFetch('/', { mode: 'navigate' });

    assert.equal(response.status, 200);
    assert.match(await response.text(), /Royalty/);
    assert.ok(Date.now() - started < 10_000, 'fell back well before the browser would');
  });
});
