/**
 * Bulk time shift — "everything from 3pm moves 20 minutes".
 *
 * Running late is the single most common live change at this event, and doing
 * it block by block across 8 teams is unusable under pressure: 40-odd edits,
 * each one a chance to fat-finger a time, while someone is standing in front of
 * you asking when they go on.
 *
 * The arithmetic lives here rather than in the route because the preview and
 * the apply must agree exactly — an admin who approves a list and then gets
 * something else applied is worse off than one who had no preview at all. Both
 * paths call `planMoves`.
 *
 * **The day key moves, the end time doesn't.** A block is stored as a day key
 * plus two `HH:MM` strings, and `blockInstants` already reads "end at or before
 * start" as "this block ran past midnight" — Friday 23:30 → Saturday 03:45 is a
 * real call time here. So shifting a block means:
 *
 *   start — shifted, and if it wraps, the block moves to the adjacent event day
 *   end   — shifted as a plain clock reading, mod 24h, day key untouched
 *
 * and the past-midnight relationship re-derives itself. 23:50–00:20 on Fri
 * shifted +20 becomes 00:10–00:40 on Sat: the start crossed midnight so the day
 * key advanced, and the end stopped being a next-day time by itself. Rolling the
 * end forward explicitly as well would double-count exactly that case.
 */
import { getBlock, listAllBlocks, listDays } from './queries.js';

const HHMM = /^(\d{1,2}):(\d{2})$/;
const DAY_MINUTES = 24 * 60;

/**
 * Twelve hours either way. Not paranoia about typos alone: the cap is what
 * guarantees a shift crosses at most one midnight, so "which event day does
 * this land on" is a single step to an adjacent day rather than a search. A
 * genuine half-day move is a re-import, not a running-late adjustment.
 */
export const MAX_SHIFT_MINUTES = 12 * 60;

/** Bounds the work one request can ask for; a day holds well under this. */
export const MAX_SHIFT_BLOCKS = 500;

/** `HH:MM` → minutes since midnight, or null if it isn't a clock reading. */
export function parseClock(hhmm) {
  const m = HHMM.exec(String(hhmm ?? '').trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

export function formatClock(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Shift a clock reading, reporting whether it crossed midnight.
 *
 * `Math.floor` rather than a truncating divide, so pulling 00:10 back by 20
 * minutes gives `{ '23:50', dayDelta: -1 }` rather than `{ '-00:10', 0 }`.
 */
export function shiftClock(hhmm, minutes) {
  const base = parseClock(hhmm);
  if (base === null) return null;
  const total = base + minutes;
  const dayDelta = Math.floor(total / DAY_MINUTES);
  return { time: formatClock(total - dayDelta * DAY_MINUTES), dayDelta };
}

/**
 * Calendar arithmetic on a `YYYY-MM-DD` string. Deliberately UTC: this is
 * counting days on a calendar, not naming an instant, so no timezone is
 * involved and none should be consulted. (`event-time.js` is where dates become
 * instants; that is the only place the venue's zone belongs.)
 */
function addCalendarDays(date, delta) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? ''));
  if (!m) return null;
  const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + delta));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(
    t.getUTCDate()
  ).padStart(2, '0')}`;
}

/**
 * "The event day `delta` calendar days from this one, if the event has one."
 *
 * Keyed on dates rather than on `sort_order`, because the neighbouring row in
 * sort order is not necessarily the next calendar day — a gap between a Thursday
 * arrivals day and a Saturday finals day would otherwise silently move a
 * midnight block a whole day.
 */
export function buildDayIndex(days) {
  const byKey = new Map(days.map((d) => [d.key, d]));
  const byDate = new Map();
  for (const d of days) if (d.date && !byDate.has(d.date)) byDate.set(d.date, d);
  return {
    shift(key, delta) {
      if (!delta) return key;
      const date = byKey.get(key)?.date;
      if (!date) return null;
      const moved = addCalendarDays(date, delta);
      return moved ? byDate.get(moved)?.key ?? null : null;
    },
  };
}

/** The blocks a shift would consider: this day, starting at or after the cutoff. */
export function selectShiftCandidates({ day, fromTime }) {
  const cutoff = parseClock(fromTime);
  if (cutoff === null) return [];
  return listAllBlocks({ day })
    .filter((b) => {
      const start = parseClock(b.startTime);
      return start !== null && start >= cutoff;
    })
    .sort((a, b) => parseClock(a.startTime) - parseClock(b.startTime));
}

/**
 * What moving these blocks by `minutes` would do to each of them.
 *
 * Split into `moves` and `blocked` rather than throwing on the first problem:
 * an admin under time pressure needs to see the whole picture at once, and the
 * route refuses the batch as a whole. A partly-applied time shift is the worst
 * outcome available here — half a day's schedule 20 minutes apart from the
 * other half, with nothing on screen saying so.
 */
export function planMoves(blocks, minutes, days = listDays()) {
  const index = buildDayIndex(days);
  const moves = [];
  const blocked = [];

  for (const block of blocks) {
    const base = {
      id: block.id,
      activity: block.activity,
      appliesTo: block.appliesTo,
      // Carried so the caller can hand it straight back as the concurrency
      // token: what an admin approved was this version of this block.
      updatedAt: block.updatedAt,
      from: { day: block.day, startTime: block.startTime, endTime: block.endTime },
    };

    const start = shiftClock(block.startTime, minutes);
    const end = shiftClock(block.endTime, minutes);
    if (!start || !end) {
      blocked.push({ ...base, blocked: 'unreadable' });
      continue;
    }

    const day = index.shift(block.day, start.dayDelta);
    if (!day) {
      // Crosses midnight into a day the event does not have. Guessing would
      // mean writing a time on a day key whose date is 24 hours out from what
      // the block now means — which renders as a perfectly normal-looking
      // block at the wrong time, the failure this project exists to avoid.
      blocked.push({ ...base, blocked: 'no-day', crosses: start.dayDelta });
      continue;
    }

    moves.push({ ...base, to: { day, startTime: start.time, endTime: end.time } });
  }

  return { moves, blocked };
}

/** Resolve an apply request's `[{ id, expectedUpdatedAt }]` against the database. */
export function resolveShiftEntries(entries) {
  const blocks = [];
  const missing = [];
  const conflicts = [];
  const seen = new Set();

  for (const entry of entries) {
    const id = String(entry?.id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const current = getBlock(id);
    if (!current) {
      missing.push(id);
    } else if (entry.expectedUpdatedAt !== current.updatedAt) {
      conflicts.push(current);
    } else {
      blocks.push(current);
    }
  }

  return { blocks, missing, conflicts };
}

/**
 * The edit-log line for a whole shift, derived from what actually moved rather
 * than from what was requested — the request's day and cutoff are what the admin
 * typed, and the log has to say what happened.
 */
export function describeShift(moves, minutes) {
  const days = [...new Set(moves.map((m) => m.from.day))];
  const earliest = moves.reduce(
    (min, m) => (min === null || parseClock(m.from.startTime) < parseClock(min) ? m.from.startTime : min),
    null
  );
  const signed = minutes > 0 ? `+${minutes}` : String(minutes);
  return `Moved ${moves.length} block(s) on ${days.join(', ')} from ${earliest} by ${signed} min`;
}
