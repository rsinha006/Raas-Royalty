import type { SchedulePayload } from './types';

/**
 * Local storage for the viewer.
 *
 * "Who am I" no longer lives here — that is a signed, httpOnly cookie the
 * server issues against an access code, and this file must never try to
 * reconstruct it. What stays local is the last schedule we successfully
 * loaded, so the app is useful on venue wifi that has stopped working, plus a
 * single flag recording that a session once existed.
 */

/**
 * v2: cached payloads gained absolute `startsAt` / `endsAt` instants when the
 * event timezone became server-authoritative. A v1 payload has no way to say
 * when its blocks actually happen, and guessing on the phone's behalf is the
 * bug that change removed — so old caches are dropped rather than adapted.
 */
const SCHEDULE_PREFIX = 'royalty.schedule.v2.';
const LEGACY_SCHEDULE_PREFIX = 'royalty.schedule.v1.';
const SEEN_KEY = 'royalty.seen.v1';

/** Written by an older build, before codes existed. Removed on sight. */
const LEGACY_KEYS = ['royalty.session.v1', 'royalty.bootstrap.v1'];

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

const cacheKey = (type: string, id: string) => `${SCHEDULE_PREFIX}${type}.${id}`;

export function cacheSchedule(payload: SchedulePayload) {
  write(cacheKey(payload.session.type, payload.session.id), payload);
}

export function readCachedSchedule(type: string, id: string): SchedulePayload | null {
  return read<SchedulePayload>(cacheKey(type, id));
}

/** The most recently cached schedule, whoever it belongs to. */
export function readAnyCachedSchedule(): SchedulePayload | null {
  try {
    const payloads: SchedulePayload[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(SCHEDULE_PREFIX)) {
        const value = read<SchedulePayload>(key);
        if (value) payloads.push(value);
      }
    }
    payloads.sort((a, b) => (a.fetchedAt < b.fetchedAt ? 1 : -1));
    return payloads[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Signing out has to take the schedules with it. The cookie is gone either way,
 * but a cached schedule is a list of one person's movements and phone numbers,
 * and leaving it on a borrowed phone would undo the point of the exercise.
 */
export function clearCachedSchedules() {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(SCHEDULE_PREFIX)) doomed.push(key);
    }
    doomed.forEach((k) => localStorage.removeItem(k));
  } catch {
    /* ignore */
  }
}

/**
 * Lets the code screen tell "you've never been here" from "your sign-in ran
 * out", which are the same 401 to the server and two different sentences to a
 * person standing in a lobby.
 */
export function markSeen() {
  write(SEEN_KEY, true);
}

export function hasBeenSeen(): boolean {
  return read<boolean>(SEEN_KEY) === true;
}

export function forgetEverything() {
  clearCachedSchedules();
  try {
    localStorage.removeItem(SEEN_KEY);
    LEGACY_KEYS.forEach((k) => localStorage.removeItem(k));
  } catch {
    /* ignore */
  }
}

export function purgeLegacyKeys() {
  try {
    LEGACY_KEYS.forEach((k) => localStorage.removeItem(k));
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(LEGACY_SCHEDULE_PREFIX)) doomed.push(key);
    }
    doomed.forEach((k) => localStorage.removeItem(k));
  } catch {
    /* ignore */
  }
}
