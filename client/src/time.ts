import type { Block, EventDay } from './types';

/**
 * All "now / next" reasoning lives here. Block times are stored as a day key
 * plus HH:MM; the event_days table supplies the real date, so the app knows
 * whether 14:30 Saturday is in the past.
 */

/** `?now=2026-08-08T13:05` lets you rehearse the live view outside the event. */
export function currentTime(): Date {
  const override = new URLSearchParams(window.location.search).get('now');
  if (override) {
    const d = new Date(override);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

export function blockStart(block: Block, days: EventDay[]): Date {
  const day = days.find((d) => d.key === block.day);
  const [h, m] = block.startTime.split(':').map(Number);
  const base = day ? new Date(`${day.date}T00:00:00`) : new Date();
  base.setHours(h, m, 0, 0);
  return base;
}

export function blockEnd(block: Block, days: EventDay[]): Date {
  const day = days.find((d) => d.key === block.day);
  const [h, m] = block.endTime.split(':').map(Number);
  const base = day ? new Date(`${day.date}T00:00:00`) : new Date();
  base.setHours(h, m, 0, 0);
  // An end time earlier than the start means it ran past midnight.
  const start = blockStart(block, days);
  if (base < start) base.setDate(base.getDate() + 1);
  return base;
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
  const sorted = [...blocks].sort(
    (a, b) => blockStart(a, days).getTime() - blockStart(b, days).getTime()
  );

  const now: Block[] = [];
  let next: Block | null = null;
  const statusById: Record<string, BlockStatus> = {};

  for (const b of sorted) {
    const start = blockStart(b, days);
    const end = blockEnd(b, days);
    if (at >= start && at < end) {
      now.push(b);
      statusById[b.id] = 'now';
    } else if (at < start) {
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
    const nextStart = blockStart(next, days).getTime();
    for (const b of sorted) {
      if (statusById[b.id] === 'upcoming' && blockStart(b, days).getTime() === nextStart) {
        statusById[b.id] = 'next';
      }
    }
  }

  let activeDay: string | null = null;
  const ordered = [...days].sort((a, b) => a.sortOrder - b.sortOrder);
  for (const d of ordered) {
    const dayEnd = new Date(`${d.date}T00:00:00`);
    dayEnd.setDate(dayEnd.getDate() + 1);
    if (at < dayEnd) {
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

export function formatTime(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hour} ${suffix}` : `${hour}:${String(m).padStart(2, '0')} ${suffix}`;
}

export function formatRange(start: string, end: string): string {
  return `${formatTime(start)} – ${formatTime(end)}`;
}

export function countdown(target: Date, at: Date): string {
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

export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
