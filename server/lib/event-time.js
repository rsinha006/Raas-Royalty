/**
 * Event time — one timezone, held server-side, applied everywhere.
 *
 * The failure this module exists to prevent: block times are stored as a day
 * key plus `HH:MM`, with no zone. Until now the *phone* decided what those
 * meant, so a traveller whose device was still on London time saw Saturday's
 * 09:00 call rendered against a London clock and read the whole weekend five
 * hours out. Nothing on screen looked wrong — a shifted schedule and a correct
 * one are visually identical — which is what makes this worth being strict
 * about. See docs/decisions.md, "Event timezone is server-authoritative".
 *
 * So the server resolves every wall-clock time to an absolute instant before it
 * leaves the process, and the client only ever compares instants. The division
 * of labour is deliberate:
 *
 *   server — knows the zone, turns (date, HH:MM) into an instant. Needs no clock.
 *   client — knows the passing of time, compares instants and counts down.
 *            Needs no zone.
 *
 * Store the IANA zone name, never a fixed offset: Monroe County observes
 * daylight saving, so `EST` or `-05:00` would be an hour wrong for any event
 * between March and November — which is when this one is.
 */

/** Bloomington, Indiana. Overridable, because a venue change should be config. */
const DEFAULT_ZONE = 'America/Indiana/Indianapolis';

let cachedZone = null;

/**
 * Reject anything that isn't a real IANA region name.
 *
 * `Intl` accepts `EST`, `EST5EDT` and `+05:00` quite happily, and every one of
 * them is the mistake this module exists to prevent — a fixed offset renders
 * the entire event an hour off for half the year, silently. Region names all
 * contain a slash (`America/New_York`); `UTC` is the one legitimate exception.
 */
function assertZone(zone) {
  if (typeof zone !== 'string' || !zone.trim()) {
    throw new Error('EVENT_TIMEZONE is set but empty.');
  }
  if (!zone.includes('/') && zone !== 'UTC') {
    throw new Error(
      `EVENT_TIMEZONE="${zone}" is not an IANA zone name. Use a region name such as ` +
        `"${DEFAULT_ZONE}" — abbreviations and fixed offsets ("EST", "-05:00") ignore ` +
        'daylight saving and would render the whole schedule an hour out for half the year.'
    );
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch {
    throw new Error(
      `EVENT_TIMEZONE="${zone}" is not a timezone this system recognises. ` +
        `Check the spelling against the IANA database (the default is "${DEFAULT_ZONE}").`
    );
  }
  return zone;
}

/**
 * The configured event timezone.
 *
 * Throws on a bad value rather than falling back to the default. A fallback
 * here would be the exact silent failure the whole module is defending
 * against: the server would come up looking healthy and serve every one of
 * ~280 people a schedule shifted by an hour. This can only be hit by changing
 * config, which happens at deploy time with someone watching.
 */
export function eventTimezone() {
  if (cachedZone) return cachedZone;
  const configured = process.env.EVENT_TIMEZONE;
  cachedZone = configured ? assertZone(configured.trim()) : DEFAULT_ZONE;
  return cachedZone;
}

/** Test seam — config is read once and cached, so tests need a way to re-read it. */
export function resetTimezoneCache() {
  cachedZone = null;
}

const partsCache = new Map();

function formatter(zone) {
  let f = partsCache.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsCache.set(zone, f);
  }
  return f;
}

/** The wall-clock reading in `zone` at a given instant, as numbers. */
export function wallClockAt(instant, zone = eventTimezone()) {
  const parts = Object.fromEntries(
    formatter(zone)
      .formatToParts(instant)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, Number(p.value)])
  );
  return parts;
}

/**
 * How far ahead of UTC `zone` is at a given instant, in milliseconds.
 *
 * Measured against the instant floored to the second, because the formatted
 * wall-clock has no milliseconds and subtracting the two otherwise leaves the
 * instant's own sub-second remainder embedded in the "offset". Zone offsets are
 * whole minutes, so flooring loses nothing and keeps this exact.
 */
export function offsetMsAt(instant, zone = eventTimezone()) {
  const w = wallClockAt(instant, zone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * A wall-clock reading in `zone` → the instant it names.
 *
 * Two passes, because the offset depends on the answer: guess with the offset
 * at the naive UTC instant, then re-check with the offset at the guess. That
 * second pass is what makes a time on a DST changeover day land correctly —
 * this event is in August, but "correct only in summer" is precisely the class
 * of bug being fixed here.
 */
export function instantFromWallClock({ year, month, day, hour = 0, minute = 0 }, zone = eventTimezone()) {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const firstGuess = naive - offsetMsAt(new Date(naive), zone);
  const refined = naive - offsetMsAt(new Date(firstGuess), zone);
  return new Date(refined);
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{1,2}):(\d{2})$/;

/**
 * `('2026-08-08', '09:00')` → the instant that is 9am at the venue that day.
 * Returns null on anything malformed, so a bad row degrades to "no now/next
 * status" rather than to a plausible-looking wrong time.
 */
export function instantFor(date, hhmm, { plusDays = 0 } = {}) {
  const d = DATE_RE.exec(String(date ?? ''));
  const t = TIME_RE.exec(String(hhmm ?? ''));
  if (!d || !t) return null;
  const hour = Number(t[1]);
  const minute = Number(t[2]);
  if (hour > 23 || minute > 59) return null;
  return instantFromWallClock(
    { year: Number(d[1]), month: Number(d[2]), day: Number(d[3]) + plusDays, hour, minute },
    eventTimezone()
  );
}

/**
 * Start and end instants for one block. An end time at or before the start
 * means the block ran past midnight — routine here, where Saturday's call time
 * is 03:45 and Friday's socials run into it.
 */
export function blockInstants(date, startTime, endTime) {
  const startsAt = instantFor(date, startTime);
  if (!startsAt) return { startsAt: null, endsAt: null };
  let endsAt = instantFor(date, endTime);
  if (endsAt && endsAt.getTime() <= startsAt.getTime()) {
    endsAt = instantFor(date, endTime, { plusDays: 1 });
  }
  return { startsAt, endsAt };
}

/** Midnight-to-midnight for one event day, used to decide which day to open on. */
export function dayInstants(date) {
  const startsAt = instantFor(date, '00:00');
  return {
    startsAt,
    endsAt: startsAt ? instantFor(date, '00:00', { plusDays: 1 }) : null,
  };
}

/**
 * Parse a rehearsal override — `?now=2026-08-08T13:05` — as venue wall-clock.
 * Read as the phone's local time it would defeat the point of the override,
 * which is to stand where an attendee stands at 1:05pm on Saturday.
 */
export function instantFromWallClockString(input) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?$/.exec(String(input ?? '').trim());
  if (!m) return null;
  return instantFromWallClock(
    {
      year: Number(m[1]),
      month: Number(m[2]),
      day: Number(m[3]),
      hour: Number(m[4] ?? 0),
      minute: Number(m[5] ?? 0),
    },
    eventTimezone()
  );
}

/** Short zone name at a given moment — "EDT" — for admin confirmation at deploy. */
export function zoneAbbreviation(instant = new Date(), zone = eventTimezone()) {
  const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' })
    .formatToParts(instant)
    .find((p) => p.type === 'timeZoneName');
  return part ? part.value : zone;
}

/** Everything the clients need to agree with the server about what time it is. */
export function eventTimeState(at = new Date()) {
  const zone = eventTimezone();
  const w = wallClockAt(at, zone);
  const offsetMinutes = offsetMsAt(at, zone) / 60_000;
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  return {
    timezone: zone,
    now: at.toISOString(),
    wallClock: `${String(w.year).padStart(4, '0')}-${String(w.month).padStart(2, '0')}-${String(
      w.day
    ).padStart(2, '0')}T${String(w.hour).padStart(2, '0')}:${String(w.minute).padStart(2, '0')}`,
    abbreviation: zoneAbbreviation(at, zone),
    utcOffset: `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`,
  };
}
