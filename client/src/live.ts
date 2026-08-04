import { io, type Socket } from 'socket.io-client';
import { useEffect, useRef, useState } from 'react';

/**
 * One shared socket for the whole app. The server only ever announces *that*
 * something changed — each client refetches its own personalized slice.
 */
let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io({
      transports: ['websocket', 'polling'],
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
    });
  }
  return socket;
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
