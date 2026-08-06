import http from 'node:http';

import 'dotenv/config';
import { Server as SocketServer } from 'socket.io';

import { dbPath, scheduleUpdatedAt } from './db.js';
import { createApp } from './app.js';
import { clearChangeFlags } from './lib/mutations.js';
import { startPolling, syncStatus } from './sync/index.js';
import { usingDefaultPassword } from './lib/auth.js';
import { eventTimeState } from './lib/event-time.js';

const PORT = Number(process.env.PORT || 4000);

/**
 * Resolve the event timezone before anything serves a request, so a bad
 * EVENT_TIMEZONE stops the deploy instead of quietly shifting ~280 schedules.
 * It throws with the fix in the message; there is no fallback on purpose.
 */
const eventTime = eventTimeState();

/**
 * One broadcast channel for everyone. Payloads carry only the fact that
 * something changed — never schedule content — so an unauthenticated socket
 * learns that *a* change happened and nothing about it. Clients refetch their
 * own personalized slice through /api/schedule, which requires a session.
 */
let io;
function broadcast(event, payload) {
  io?.emit(event, { ...payload, at: new Date().toISOString() });
}

const app = createApp({ broadcast });
const server = http.createServer(app);

io = new SocketServer(server, { cors: { origin: true, credentials: true } });
io.on('connection', (socket) => {
  socket.emit('hello', { updatedAt: scheduleUpdatedAt() });
});

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
  console.log(
    `  Event time: ${eventTime.wallClock.replace('T', ' ')} ${eventTime.abbreviation} ` +
      `(${eventTime.timezone}, UTC${eventTime.utcOffset})`
  );
  console.log(`  Schedule source: ${status.activeLabel}${status.canPull ? ' (re-sync available)' : ''}`);
  if (usingDefaultPassword()) {
    console.log('  Admin password: royalty-admin  ← set ADMIN_PASSWORD before the event\n');
  } else {
    console.log('  Admin password: set via ADMIN_PASSWORD\n');
  }
});
