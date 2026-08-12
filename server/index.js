import http from 'node:http';

import 'dotenv/config';
import { Server as SocketServer } from 'socket.io';

import { db, dbPath } from './db.js';
import { createApp } from './app.js';
import { clearChangeFlags } from './lib/mutations.js';
import { startPolling, syncStatus } from './sync/index.js';
import { usingDefaultPassword } from './lib/auth.js';
import { eventTimeState } from './lib/event-time.js';
import { assertBootConfig } from './lib/deploy-config.js';
import { createLiveHub, originPolicy, roomsForTargets } from './lib/live.js';

const PORT = Number(process.env.PORT || 4000);

/**
 * Resolve the event timezone before anything serves a request, so a bad
 * EVENT_TIMEZONE stops the deploy instead of quietly shifting ~280 schedules.
 * It throws with the fix in the message; there is no fallback on purpose.
 */
const eventTime = eventTimeState();

/**
 * Same shape of gate, for the rest of the deploy configuration: refuse to come
 * up with the documented default admin password, or with the database sitting
 * on a filesystem the next deploy replaces. Both produce a server that passes
 * every health check it has. No-op outside production — see lib/deploy-config.js.
 *
 * Printed rather than thrown. This message is read off a `fly logs` tail by
 * someone under time pressure, and a Node stack trace above it buries the one
 * line that says what to set.
 */
let bootConfig;
try {
  bootConfig = assertBootConfig({ dbPath });
} catch (err) {
  console.error(`\n${err.message}\n`);
  process.exit(1);
}

/**
 * Broadcasts are scoped to the rooms a change actually affects, and payloads
 * still carry only the fact that something changed — never schedule content,
 * and never the list of who it affects. Clients refetch their own personalized
 * slice through /api/schedule, which requires a session. See lib/live.js.
 *
 * `hub` is assigned below; the indirection exists because the Express app is
 * built before the socket server it broadcasts through.
 */
let hub = null;
function broadcast(event, payload, opts) {
  hub?.broadcast(event, payload, opts);
}

const app = createApp({ broadcast });
const server = http.createServer(app);

/**
 * Keep idle connections open longer than the gap between refetches.
 *
 * Every phone holds one connection and uses it in bursts: nothing for minutes,
 * then a request the moment something changes. Node's 5-second default closes
 * the socket in that gap, and a client that reuses it in the same instant gets
 * ECONNRESET — which `ScheduleScreen` cannot tell from being offline, so it
 * renders the "Offline · last known" banner on a phone with full signal. The
 * item 20 load test reproduced exactly one of these per thousand refetches.
 *
 * `headersTimeout` must stay above `keepAliveTimeout`, or Node reintroduces the
 * race it is set to remove. Both are below the 75s idle timeout that ALBs and
 * most managed proxies default to; if the deploy in item 22 uses a proxy with a
 * *shorter* one, the proxy becomes the thing closing the socket and this needs
 * to come down to match it — which is why it is an env var rather than a
 * constant.
 */
const KEEP_ALIVE_MS = Number(process.env.KEEP_ALIVE_TIMEOUT_MS ?? 65_000);
server.keepAliveTimeout = KEEP_ALIVE_MS;
server.headersTimeout = KEEP_ALIVE_MS + 5_000;

/**
 * The origin check runs in `allowRequest` rather than only in `cors`, because
 * that is the one hook that sees the request itself — and comparing Origin
 * against the request's own Host is what makes same-origin work everywhere
 * without configuration. A rejected handshake gets a 403.
 */
const origins = originPolicy();
const io = new SocketServer(server, {
  cors: { origin: (origin, cb) => cb(null, origins.isAllowed(origin)), credentials: true },
  allowRequest: (req, cb) => cb(null, origins.isAllowed(req.headers.origin, req.headers.host)),
});
hub = createLiveHub(io);

/* --------------------------- background --------------------------- */

// Changed-block highlights are short-lived; expire the stored flags.
setInterval(() => clearChangeFlags(30), 5 * 60_000).unref?.();

startPolling((result) => {
  broadcast(
    'schedule:updated',
    { updatedAt: result.updatedAt, reason: 'sheet-sync' },
    { rooms: roomsForTargets(result.targets) }
  );
  console.log(
    `[sync] applied: +${result.diff.create.length} ~${result.diff.update.length} -${result.diff.delete.length}`
  );
});

server.listen(PORT, () => {
  const status = syncStatus();
  console.log(`\n  Royalty schedule server → http://localhost:${PORT}`);
  console.log(`  Database: ${dbPath}`);
  console.log(
    `  Event time: ${eventTime.wallClock.replace('T', ' ')} ${eventTime.abbreviation} ` +
      `(${eventTime.timezone}, UTC${eventTime.utcOffset})`
  );
  console.log(`  Schedule source: ${status.activeLabel}${status.canPull ? ' (re-sync available)' : ''}`);
  console.log(`  Socket origins: ${origins.describe()}`);
  if (usingDefaultPassword()) {
    console.log('  Admin password: royalty-admin  ← set ADMIN_PASSWORD before the event\n');
  } else {
    console.log('  Admin password: set via ADMIN_PASSWORD\n');
  }
  if (bootConfig.production) {
    const warned = bootConfig.warnings?.length ?? 0;
    console.log(`  Deploy checks: passing${warned ? ` with ${warned} warning${warned > 1 ? 's' : ''}` : ''}\n`);
  }
});

/* --------------------------- shutdown --------------------------- */

/**
 * Close on SIGTERM, which is what the platform sends to replace this machine.
 *
 * ⚠️ Node installs no default handler for SIGTERM when it is PID 1, which it is
 * inside the container — so without this the signal is *ignored*, every deploy
 * waits out the platform's kill timeout, and the process is then SIGKILLed with
 * the WAL unflushed. Closing the database explicitly checkpoints it, which is
 * also what makes the item 23 snapshot of a just-stopped machine coherent.
 *
 * `io.close()` disconnects every socket and closes the HTTP server under it, so
 * phones see a clean close and reconnect rather than hanging until their own
 * timeout. Ten seconds is the ceiling; past that, something is wedged and being
 * replaced quickly matters more than being replaced tidily.
 */
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n  ${signal} — closing sockets and checkpointing the database`);

  const forced = setTimeout(() => {
    console.warn('  Shutdown timed out after 10s; exiting anyway.');
    process.exit(1);
  }, 10_000);
  forced.unref?.();

  io.close(() => {
    try {
      db.close();
    } catch (err) {
      console.error('  Database did not close cleanly:', err.message);
    }
    clearTimeout(forced);
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
