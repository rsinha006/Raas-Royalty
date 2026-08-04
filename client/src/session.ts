import type { SchedulePayload, StoredSession } from './types';

/**
 * No accounts — "who am I" is just a selection kept in localStorage, plus the
 * last schedule we successfully loaded so the app still works on bad wifi.
 */

const SESSION_KEY = 'royalty.session.v1';
const cacheKey = (type: string, id: string) => `royalty.schedule.v1.${type}.${id}`;

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode / quota — the app still works, just without persistence */
  }
}

export function loadSession(): StoredSession | null {
  return read<StoredSession>(SESSION_KEY);
}

export function saveSession(session: StoredSession) {
  write(SESSION_KEY, session);
}

export function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

export function cacheSchedule(payload: SchedulePayload) {
  write(cacheKey(payload.session.type, payload.session.id), payload);
}

export function readCachedSchedule(type: string, id: string): SchedulePayload | null {
  return read<SchedulePayload>(cacheKey(type, id));
}
