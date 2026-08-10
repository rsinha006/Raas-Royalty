import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SW_SOURCE = path.join(__dirname, 'sw.js');

/**
 * Files worth having offline. Everything Vite emits for this app is one JS
 * bundle, one stylesheet, and whatever `public/` holds; the extension list is
 * an allow-list rather than a block-list so a future addition (a source map, a
 * large video) has to be added on purpose instead of silently doubling what
 * every phone downloads before it can be used offline.
 */
const PRECACHEABLE = /\.(js|css|woff2?|ttf|png|jpe?g|svg|webp|ico|webmanifest)$/i;

/**
 * The shell manifest for a set of built file names.
 *
 * Split out from the plugin so the tests can generate the exact worker the
 * build ships rather than a hand-written approximation of it — the routing
 * rules in sw.js are the part where a mistake is invisible until someone is
 * standing in a venue with no signal.
 */
export function shellManifest(fileNames) {
  const assets = fileNames
    .filter((name) => PRECACHEABLE.test(name))
    .map((name) => `/${name}`)
    .sort();
  // '/' first: it is the entry the navigation strategy falls back to, and
  // addAll being all-or-nothing means a missing shell fails the install loudly.
  return ['/', ...assets];
}

/**
 * Build the service worker source with its manifest and build id filled in.
 *
 * The id is derived from the manifest, and Vite content-hashes asset names, so
 * it changes when and only when the shell's contents change. That is what makes
 * a deploy reach a phone: a byte-identical sw.js is ignored by the browser, and
 * a different one triggers install → activate → a new cache.
 */
export function buildServiceWorker(fileNames, { source } = {}) {
  const manifest = shellManifest(fileNames);
  const buildId = createHash('sha256').update(manifest.join('\n')).digest('hex').slice(0, 12);
  return (source ?? readFileSync(SW_SOURCE, 'utf8'))
    .replace('__PRECACHE_MANIFEST__', JSON.stringify(manifest, null, 2))
    .replace('__BUILD_ID__', buildId);
}

/**
 * Emits `sw.js` at the root of the build output — root because a worker's
 * scope is its own directory, and this one has to see navigations to `/`.
 *
 * Build-only: a service worker in front of the Vite dev server serves yesterday's
 * bundle over today's edit, and the resulting hunt is memorable. `registerServiceWorker`
 * unregisters instead when it runs in dev.
 */
export function serviceWorkerPlugin() {
  return {
    name: 'royalty-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: buildServiceWorker(Object.keys(bundle)),
      });
    },
  };
}
