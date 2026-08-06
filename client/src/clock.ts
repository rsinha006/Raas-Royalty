/**
 * The client's view of event time.
 *
 * Two device faults have to survive here, and they are different problems:
 *
 *   wrong timezone — the phone thinks 09:00 means something else. Fixed by not
 *     asking it: every block arrives from the server with absolute `startsAt` /
 *     `endsAt` instants already resolved against the venue's zone. Nothing in
 *     the client ever turns a wall-clock time into an instant.
 *   wrong clock — the phone disagrees about *now*. Fixed by measuring the
 *     drift: every payload carries the server's own `now`, and this module
 *     keeps the difference and applies it. A device an hour fast gets the same
 *     countdown as everyone else.
 *
 * What the device is still trusted for is the *passing* of time between
 * fetches, which is what makes the countdown tick without polling.
 */

export interface EventTimeState {
  timezone: string;
  now: string;
  wallClock: string;
  abbreviation: string;
  utcOffset: string;
  /** Only present when a rehearsal override was resolved. */
  resolvedAt?: string;
}

/** Difference between the server's clock and this device's, in ms. */
let skewMs = 0;
let zone: string | null = null;
let abbreviation: string | null = null;

/**
 * A frozen moment for rehearsal — `?now=2026-08-08T13:05`. Read as venue
 * wall-clock, resolved by the server so there is exactly one interpretation of
 * what "1:05pm on Saturday" means.
 */
let overrideAt: Date | null = null;

function overrideParam(): string | null {
  try {
    return new URLSearchParams(window.location.search).get('now');
  } catch {
    return null;
  }
}

/**
 * Ask the server what time it is. Called once before the app renders.
 *
 * Failure is survivable and deliberately quiet: with no answer the device's own
 * clock stands in, which is exactly where things were before this existed. The
 * first schedule fetch corrects the drift anyway, and offline that fetch is the
 * cache, which carries the server time from when it was written.
 */
export async function initClock(): Promise<void> {
  const wall = overrideParam();
  try {
    const res = await fetch(`/api/time${wall ? `?at=${encodeURIComponent(wall)}` : ''}`, {
      credentials: 'same-origin',
    });
    if (!res.ok) return;
    const state = (await res.json()) as EventTimeState;
    syncClock(state);
    if (state.resolvedAt) overrideAt = new Date(state.resolvedAt);
  } catch {
    /* offline at startup — the device clock is the fallback */
  }
}

/**
 * Re-measure drift from a payload's server time. Called on every schedule load.
 *
 * `measureDrift: false` is for a payload read out of the offline cache. Its
 * timezone is still good — a zone does not go stale — but its `now` is however
 * long ago the cache was written, and treating that as the current instant
 * would drag the whole app back to that moment. Left alone, the device's own
 * clock carries on ticking, which is the right answer when there is no server
 * to ask.
 */
export function syncClock(
  state: EventTimeState | undefined | null,
  { measureDrift = true } = {}
): void {
  if (!state) return;
  zone = state.timezone ?? zone;
  abbreviation = state.abbreviation ?? abbreviation;
  if (!measureDrift || !state.now) return;
  const serverNow = new Date(state.now).getTime();
  if (Number.isNaN(serverNow)) return;
  skewMs = serverNow - Date.now();
}

/** Now, at the venue — the only "current time" anything in the app should use. */
export function eventNow(): Date {
  return overrideAt ?? new Date(Date.now() + skewMs);
}

export function eventZone(): string | null {
  return zone;
}

export function eventZoneAbbreviation(): string | null {
  return abbreviation;
}

/** True when the app is pinned to a rehearsal time rather than following the clock. */
export function isRehearsing(): boolean {
  return overrideAt !== null;
}

/**
 * Format an instant in venue time.
 *
 * Everything a viewer reads has to be in one frame of reference. Rendering
 * block times at the venue and "last updated" on the device's clock would put
 * two contradictory times on the same screen — for a traveller, an hour or five
 * apart — and the schedule is the one that would look wrong.
 */
export function formatInZone(
  value: Date | string | null | undefined,
  options: Intl.DateTimeFormatOptions
): string {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString([], { ...options, ...(zone ? { timeZone: zone } : {}) });
}
