import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import { Server as SocketServer } from 'socket.io';

import { dbPath, scheduleUpdatedAt } from './db.js';
import { publicRouter } from './routes/public.js';
import { adminRouter } from './routes/admin.js';
import { clearChangeFlags } from './lib/mutations.js';
import { startPolling, syncStatus } from './sync/index.js';
import { usingDefaultPassword } from './lib/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4000);
const CLIENT_DIST = path.join(__dirname, '..', 'client', 'dist');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

const server = http.createServer(app);
const io = new SocketServer(server, {
  cors: { origin: true, credentials: true },
});

/**
 * One broadcast channel for everyone. Payloads carry only the fact that
 * something changed plus the affected block ids — clients refetch their own
 * personalized slice, so no one receives another person's schedule.
 */
function broadcast(event, payload) {
  io.emit(event, { ...payload, at: new Date().toISOString() });
}

io.on('connection', (socket) => {
  socket.emit('hello', { updatedAt: scheduleUpdatedAt() });
});

app.use('/api', publicRouter());
app.use('/api/admin', adminRouter({ broadcast }));

app.use((err, req, res, next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'That file is too large (8 MB limit).' });
  }
  console.error('[error]', err);
  res.status(500).json({ error: err.message || 'Unexpected server error' });
});

/* --------------------------- static client --------------------------- */

if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST, { index: false, maxAge: '1h' }));
  // SPA fallback — /admin and any deep link render the same bundle.
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  });
} else {
  app.get('/', (req, res) => {
    res
      .status(200)
      .type('text/plain')
      .send('API is running. Client not built yet — run `npm run build`, or `npm run dev` for the Vite dev server.');
  });
}

/* --------------------------- background --------------------------- */

// Changed-block highlights are short-lived; expire the stored flags.
setInterval(() => clearChangeFlags(30), 5 * 60_000).unref?.();

startPolling((result) => {
  broadcast('schedule:updated', { updatedAt: result.updatedAt, reason: 'sheet-sync' });
  console.log(
    `[sync] applied: +${result.diff.create.length} ~${result.diff.update.length} -${result.diff.delete.length}`
  );
});

server.listen(PORT, () => {
  const status = syncStatus();
  console.log(`\n  Royalty schedule server → http://localhost:${PORT}`);
  console.log(`  Database: ${dbPath}`);
  console.log(`  Schedule source: ${status.activeLabel}${status.canPull ? ' (re-sync available)' : ''}`);
  if (usingDefaultPassword()) {
    console.log('  Admin password: royalty-admin  ← set ADMIN_PASSWORD before the event\n');
  } else {
    console.log('  Admin password: set via ADMIN_PASSWORD\n');
  }
});
