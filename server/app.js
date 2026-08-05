import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import express from 'express';
import cookieParser from 'cookie-parser';

import { publicRouter } from './routes/public.js';
import { adminRouter } from './routes/admin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = path.join(__dirname, '..', 'client', 'dist');

/**
 * Express app, separated from the HTTP server and Socket.IO so the
 * authorization tests can exercise the real routing stack — same middleware
 * order, same cookie parsing, same routers — instead of a stand-in that could
 * pass while production fails.
 */
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

  app.use('/api', publicRouter());
  app.use('/api/admin', adminRouter({ broadcast }));

  app.use((err, req, res, next) => {
    if (err?.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'That file is too large (8 MB limit).' });
    }
    console.error('[error]', err);
    res.status(500).json({ error: err.message || 'Unexpected server error' });
  });

  if (!serveClient) return app;

  if (fs.existsSync(CLIENT_DIST)) {
    app.use(express.static(CLIENT_DIST, { index: false, maxAge: '1h' }));
    // SPA fallback — /admin, /s/:code and any deep link render the same bundle.
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api')) return next();
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
