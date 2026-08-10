/**
 * Registering (and un-registering) the offline shell worker.
 *
 * The worker itself is `client/sw.js`, emitted to the build root by
 * `vite-plugin-sw.js`. What lives here is only the decision of whether this
 * page should have one at all.
 */
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  /**
   * Dev actively removes it rather than merely skipping registration. A worker
   * installed by a production build on the same origin — `localhost:4000` and
   * `localhost:5173` are different origins, but a phone testing against
   * `npm start` and then `npm run dev` on the same port is not — would go on
   * serving a precached bundle over every edit, and the symptom (changes that
   * do nothing) points nowhere near the cause.
   */
  if (!import.meta.env.PROD) {
    navigator.serviceWorker
      .getRegistrations()
      .then((registrations) => registrations.forEach((r) => r.unregister()))
      .catch(() => {
        /* nothing registered, or the browser refused — either way, carry on */
      });
    return;
  }

  /**
   * Not from the admin panel. Its scope would be `/` regardless of where it is
   * registered from, and the worker deliberately refuses to serve `/admin`
   * offline — so registering from there would install an offline shell for a
   * surface that has no offline behaviour, on the one device that never needs
   * it. The viewer is where a phone loses signal.
   */
  if (window.location.pathname.startsWith('/admin')) return;

  /**
   * After `load`, so precaching the shell competes with nothing on the first
   * visit — which for most people is a captain's link opened on venue wifi.
   *
   * There is no update prompt on purpose. Navigations are network-first, so a
   * reload with signal always gets the current build; an open page keeps the
   * bundle it started with until then, which is the same thing that happens
   * today without a worker. Item 27 freezes the code before the event anyway.
   */
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* private mode, an unsupported browser, or a build without sw.js */
    });
  });
}
