import path from 'node:path';
import fs from 'node:fs';

import express from 'express';
import cookieParser from 'cookie-parser';

import { publicRouter } from './routes/public.js';
import { adminRouter } from './routes/admin.js';
import { magicLinkRouter } from './routes/magic-link.js';
import { recordError } from './lib/ops.js';
import { CLIENT_DIST } from './lib/deploy-config.js';

/**
 * Express app, separated from the HTTP server and Socket.IO so the
 * authorization tests can exercise the real routing stack — same middleware
 * order, same cookie parsing, same routers — instead of a stand-in that could
 * pass while production fails.
 */
/**
 * The last stop for anything that throws.
 *
 * Exported so the tests can exercise the real one rather than a copy of it —
 * this is the code path that decides whether an error during the event is
 * written down anywhere, and a stand-in could pass while production loses it.
 *
 * ⚠️ Only *server* faults are recorded. A malformed request body raises an
 * error with a 4xx status on it, and recording those would fill the panel's
 * error list — the one place someone looks when something is wrong — with
 * things that are not wrong with the server.
 */
export function errorHandler(err, req, res, next) {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'That file is too large (8 MB limit).' });
  }

  const status = Number(err?.status || err?.statusCode || 500);
  if (status >= 400 && status < 500) {
    return res.status(status).json({ error: err.message || 'Bad request' });
  }

  /**
   * Every 500 the app produces lands in the ring buffer and the error file
   * beside the database, because `fly logs` only shows what happened while
   * someone had a terminal open — and during the event nobody does. See
   * lib/ops.js.
   */
  recordError('http', err, { method: req.method, path: req.path });
  res.status(500).json({ error: err.message || 'Unexpected server error' });
}

export function createApp({ broadcast = () => {}, serveClient = true } = {}) {
  const app = express();

  /**
   * How many proxy hops to trust when deriving `req.ip`, which is what both
   * rate limiters key on. Correct behind the single load balancer this deploys
   * behind (item 22); set TRUST_PROXY=0 if the process is ever exposed directly,
   * because otherwise a client can set X-Forwarded-For and appear as a new IP on
   * every request.
   *
   * Note this is defence in depth, not the wall: an 8-character code from a
   * 30-character alphabet is ~6.6e11 possibilities, so even completely
   * unthrottled guessing does not get anywhere. The reason the default trusts a
   * hop rather than none is that getting it wrong the other way is worse during
   * an event — with no proxy trusted, every attendee shares the balancer's IP
   * and ten fumbled codes would lock the whole roster out of signing in.
   */
  app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 1));
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());

  // `serveClient` reaches the health check: an app that was never going to
  // serve the bundle must not report itself unhealthy for not having one.
  app.use('/api', publicRouter({ serveClient }));
  app.use('/api/admin', adminRouter({ broadcast }));
  // Before the SPA fallback: /s/:code must sign in and redirect, not render.
  app.use('/s', magicLinkRouter());

  app.use(errorHandler);

  if (!serveClient) return app;

  if (fs.existsSync(CLIENT_DIST)) {
    app.use(
      express.static(CLIENT_DIST, {
        index: false,
        maxAge: '1h',
        setHeaders(res, filePath) {
          /**
           * The service worker must revalidate on every check. Under the hour
           * that every other asset gets, a phone could keep serving a worker
           * an hour after an emergency fix was deployed — and the worker is the
           * thing that decides which build the phone loads. `no-cache` still
           * 304s off the ETag, so the cost is one conditional request.
           */
          if (path.basename(filePath) === 'sw.js') {
            res.setHeader('Cache-Control', 'no-cache');
          }
        },
      })
    );
    // SPA fallback — /admin, /s/:code and any deep link render the same bundle.
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api')) return next();
      /**
       * Never answer /sw.js with the HTML shell. If the build predates the
       * worker, the honest answer is 404 — registration fails and the app runs
       * exactly as it did before. Serving index.html instead would register a
       * worker whose script is a web page, which fails in a much stranger way.
       */
      if (req.path === '/sw.js') return res.status(404).type('text/plain').send('Not found');
      res.sendFile(path.join(CLIENT_DIST, 'index.html'));
    });
  } else {
    app.get('/', (req, res) => {
      res
        .status(200)
        .type('text/plain')
        .send(
          'API is running. Client not built yet — run `npm run build`, or `npm run dev` for the Vite dev server.'
        );
    });
  }

  return app;
}
