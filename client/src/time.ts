import type { Block, EventDay } from './types';
import { formatInZone } from './clock';

/**
 * All "now / next" reasoning lives here.
 *
 * Every function below compares *instants*. Blocks arrive with `startsAt` and
 * `endsAt` already resolved against the event timezone by the server, and the
 * current time comes from `clock.ts`, which corrects for a device whose clock
 * is wrong. Nothing here parses a date string or reads the device's timezone —
 * that is the whole point. This file used to do `new Date(`${day.date}T00:00`)`,
 * which is parsed in the *phone's* zone, so a traveller who hadn't changed
 * their clock saw the entire weekend shifted by their flight.
 *
 * `startsAt` is null only for a block on a day with no date row. Those keep
 * their place in the list and simply get no now/next status, because a
 * confidently wrong "Right now" is worse than none.
 */

export function blockStart(block: Block): Date | null {
  return block.startsAt ? new Date(block.startsAt) : null;
}

export function blockEnd(block: Block): Date | null {
  return block.endsAt ? new Date(block.endsAt) : null;
}

export type BlockStatus = 'past' | 'now' | 'next' | 'upcoming';

export interface Timeline {
  now: Block[];
  next: Block | null;
  statusById: Record<string, BlockStatus>;
  /** The day the app should open on: today if the event is running, else day one. */
  activeDay: string | null;
}

export function buildTimeline(blocks: Block[], days: EventDay[], at: Date): Timeline {
  const timed = blocks.filter((b) => b.startsAt);
  const sorted = [...timed].sort(
    (a, b) => new Date(a.startsAt!).getTime() - new Date(b.startsAt!).getTime()
  );

  const now: Block[] = [];
  let next: Block | null = null;
  const statusById: Record<string, BlockStatus> = {};

  for (const b of sorted) {
    const start = new Date(b.startsAt!).getTime();
    const end = b.endsAt ? new Date(b.endsAt).getTime() : start;
    const t = at.getTime();
    if (t >= start && t < end) {
      now.push(b);
      statusById[b.id] = 'now';
    } else if (t < start) {
      if (!next) {
        next = b;
        statusById[b.id] = 'next';
      } else {
        statusById[b.id] = 'upcoming';
      }
    } else {
      statusById[b.id] = 'past';
    }
  }

  // Anything starting at the same moment as "next" is equally next.
  if (next) {
    const nextStart = new Date(next.startsAt!).getTime();
    for (const b of sorted) {
      if (statusById[b.id] === 'upcoming' && new Date(b.startsAt!).getTime() === nextStart) {
        statusById[b.id] = 'next';
      }
    }
  }

  let activeDay: string | null = null;
  const ordered = [...days].sort((a, b) => a.sortOrder - b.sortOrder);
  for (const d of ordered) {
    if (!d.endsAt) continue;
    if (at.getTime() < new Date(d.endsAt).getTime()) {
      activeDay = d.key;
      break;
    }
  }
  if (!activeDay && ordered.length) activeDay = ordered[ordered.length - 1].key;

  return { now, next, statusById, activeDay };
}

/** Blocks that share the "next" start time, for the hero card. */
export function nextGroup(blocks: Block[], timeline: Timeline): Block[] {
  return blocks.filter((b) => timeline.statusById[b.id] === 'next');
}

/**
 * `HH:MM` → "1:05 PM". No timezone involved: the stored string already *is*
 * venue wall-clock, which is what everyone at the venue reads off a call sheet.
 */
export function formatTime(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hour} ${suffix}` : `${hour}:${String(m).padStart(2, '0')} ${suffix}`;
}

export function formatRange(start: string, end: string): string {
  return `${formatTime(start)} – ${formatTime(end)}`;
}

export function countdown(target: Date | null, at: Date): string {
  if (!target) return '';
  const ms = target.getTime() - at.getTime();
  if (ms <= 0) return 'now';
  const mins = Math.round(ms / 60000);
  if (mins < 1) return 'in under a minute';
  if (mins < 60) return `in ${mins} min`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours < 24) return rem ? `in ${hours}h ${rem}m` : `in ${hours}h`;
  const dayCount = Math.round(hours / 24);
  return `in ${dayCount} day${dayCount === 1 ? '' : 's'}`;
}

/* --------------------------------------------------------------------- *
 * Formatting real timestamps
 *
 * These take an absolute instant — "last updated", an edit-log entry — and
 * render it at the venue. A screen mixing venue block times with device-local
 * timestamps is telling a traveller two different times at once.
 * --------------------------------------------------------------------- */

export function formatTimestamp(iso: string | null | undefined): string {
  return formatInZone(iso, { hour: 'numeric', minute: '2-digit' });
}

export function formatDateTime(iso: string | null | undefined): string {
  return formatInZone(iso, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** A day tab's date, from the day's own midnight instant. */
export function formatDayDate(day: EventDay): string {
  if (!day.startsAt) return '';
  return formatInZone(day.startsAt, { month: 'short', day: 'numeric' });
}
