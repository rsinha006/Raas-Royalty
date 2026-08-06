import { io, type Socket } from 'socket.io-client';
import { useEffect, useRef, useState } from 'react';

/**
 * One shared socket for the whole app. The server only ever announces *that*
 * something changed — each client refetches its own personalized slice.
 *
 * The server decides what reaches this socket, from the session cookie sent
 * with the handshake: a change to another team's schedule is never delivered
 * here at all, rather than delivered and filtered out. So there is no audience
 * information on the wire, and nothing to filter on this side.
 */
let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io({
      transports: ['websocket', 'polling'],
      withCredentials: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
    });
  }
  return socket;
}

/**
 * Re-handshake after signing in, identifying, or signing out.
 *
 * The server reads the session once, from the handshake, and a live socket
 * cannot be told about a new cookie — so the connection has to be made again.
 * Without this, someone who has just picked their name on the identity step
 * keeps hearing only their team's changes and misses their own airport pickup
 * moving. A no-op before anything has connected, which is what makes it safe
 * to call on the first session check of a page load.
 */
export function resyncSession(): void {
  if (!socket) return;
  socket.disconnect();
  socket.connect();
}

export type LiveStatus = 'connecting' | 'live' | 'offline';

/**
 * Subscribes to change announcements and reports connection health, which the
 * viewer surfaces as the live/offline indicator.
 */
export function useLive(onChange: () => void): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const handler = useRef(onChange);
  handler.current = onChange;

  useEffect(() => {
    const s = getSocket();
    const connected = () => setStatus('live');
    const changed = () => handler.current();
    // A dropped socket is a hint, not a verdict. Try a real fetch — if that
    // succeeds we were never actually offline, and if it fails the schedule
    // screen switches to its cached copy and shows the offline banner.
    const disconnected = () => {
      setStatus('offline');
      handler.current();
    };

    s.on('connect', connected);
    s.on('disconnect', disconnected);
    s.on('connect_error', disconnected);
    s.on('schedule:updated', changed);
    s.on('roster:updated', changed);
    if (s.connected) setStatus('live');

    // Coming back from a locked phone or a dead zone: refetch immediately.
    const onOnline = () => {
      s.connect();
      handler.current();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        if (!s.connected) s.connect();
        handler.current();
      }
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', disconnected);
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      s.off('connect', connected);
      s.off('disconnect', disconnected);
      s.off('connect_error', disconnected);
      s.off('schedule:updated', changed);
      s.off('roster:updated', changed);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', disconnected);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return status;
}

/** Re-render on a timer so "now / next" stays honest without a refresh. */
export function useTicker(intervalMs = 30_000): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return tick;
}
