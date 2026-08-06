import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { useLive, useTicker } from '../live';
import { cacheSchedule, readAnyCachedSchedule } from '../session';
import type { Block, SchedulePayload } from '../types';
import {
  buildTimeline,
  formatDayDate,
  formatTimestamp,
  nextGroup,
} from '../time';
import { eventNow, eventZoneAbbreviation, isRehearsing, syncClock } from '../clock';
import BlockCard from './BlockCard';
import ContactCard from './ContactCard';
import NowNext from './NowNext';

/** Signature of everything a viewer would notice moving. */
function signature(b: Block) {
  return [b.day, b.startTime, b.endTime, b.activity, b.location?.display ?? '', b.notes ?? ''].join('|');
}

interface ChangeSet {
  ids: Set<string>;
  added: number;
  updated: number;
  removed: number;
}

const EMPTY: ChangeSet = { ids: new Set(), added: 0, updated: 0, removed: 0 };

function diffBlocks(prev: Block[], next: Block[]): ChangeSet {
  const prevMap = new Map(prev.map((b) => [b.id, b]));
  const nextMap = new Map(next.map((b) => [b.id, b]));
  const ids = new Set<string>();
  let added = 0;
  let updated = 0;
  for (const b of next) {
    const old = prevMap.get(b.id);
    if (!old) {
      ids.add(b.id);
      added++;
    } else if (signature(old) !== signature(b)) {
      ids.add(b.id);
      updated++;
    }
  }
  let removed = 0;
  for (const b of prev) if (!nextMap.has(b.id)) removed++;
  return { ids, added, updated, removed };
}

export default function ScheduleScreen({
  onSwitch,
  switchLabel,
  onSessionLost,
}: {
  onSwitch: () => void;
  switchLabel: string;
  onSessionLost: () => void;
}) {
  const [payload, setPayload] = useState<SchedulePayload | null>(null);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changes, setChanges] = useState<ChangeSet>(EMPTY);
  const [day, setDay] = useState<string | null>(null);
  const [gone, setGone] = useState(false);

  const payloadRef = useRef<SchedulePayload | null>(null);
  const changeTimer = useRef<number | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      // No parameters: the server derives the subject from the session cookie.
      const data = await api.get<SchedulePayload>('/api/schedule');
      // Re-measure the device's clock drift on every load, so a phone that
      // wakes up with the wrong time corrects itself at the next poll rather
      // than counting down to the wrong minute all weekend.
      syncClock(data.eventTime);
      const prev = payloadRef.current;
      if (prev) {
        const delta = diffBlocks(prev.blocks, data.blocks);
        if (delta.ids.size || delta.removed) {
          setChanges(delta);
          window.clearTimeout(changeTimer.current);
          changeTimer.current = window.setTimeout(() => setChanges(EMPTY), 25_000);
        }
      }
      payloadRef.current = data;
      setPayload(data);
      cacheSchedule(data);
      setStale(false);
      setError(null);
    } catch (err) {
      // 401 means the session died under us — most likely the code was revoked
      // mid-event. That needs the code screen, not an offline banner.
      if (err instanceof ApiError && err.status === 401) {
        onSessionLost();
        return;
      }
      // 404 means the roster no longer has this selection — that's not an
      // offline condition, it needs a re-pick.
      if (err instanceof ApiError && err.status === 404) {
        setGone(true);
        return;
      }
      if (!payloadRef.current) {
        const cached = readAnyCachedSchedule();
        if (cached) {
          // Take the timezone from the cache but not its clock — see syncClock.
          syncClock(cached.eventTime, { measureDrift: false });
          payloadRef.current = cached;
          setPayload(cached);
          setStale(true);
          return;
        }
        setError('Could not reach the schedule, and nothing is saved on this device yet.');
        return;
      }
      setStale(true);
    }
  }, [onSessionLost]);

  // Reset when the identity changes.
  useEffect(() => {
    payloadRef.current = null;
    setPayload(null);
    setChanges(EMPTY);
    setStale(false);
    setGone(false);
    load();
  }, [load]);

  const liveStatus = useLive(load);
  useTicker(30_000);

  const at = eventNow();
  const days = payload?.days ?? [];
  const blocks = payload?.blocks ?? [];

  const timeline = useMemo(() => buildTimeline(blocks, days, at), [blocks, days, at.getMinutes()]); // eslint-disable-line react-hooks/exhaustive-deps
  const nextBlocks = useMemo(() => nextGroup(blocks, timeline), [blocks, timeline]);

  const activeDay = day ?? timeline.activeDay ?? days[0]?.key ?? null;
  const dayBlocks = blocks.filter((b) => b.day === activeDay);

  if (gone) {
    return (
      <div className="landing">
        <h1 style={{ fontSize: 24 }}>That entry is no longer on the roster</h1>
        <p className="landing-sub">Logistics may have renamed or removed it. Pick again to continue.</p>
        <button className="btn primary block-w" onClick={onSwitch}>
          {switchLabel}
        </button>
      </div>
    );
  }

  if (!payload) {
    if (error) {
      return (
        <div className="landing">
          <h1 style={{ fontSize: 24 }}>Can't load your schedule</h1>
          <p className="landing-sub">{error}</p>
          <div className="stack">
            <button className="btn primary block-w" onClick={load}>
              Try again
            </button>
            <button className="btn ghost block-w" onClick={onSwitch}>
              {switchLabel}
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="loading-screen">
        <span className="spinner" />
        <span>Loading your schedule…</span>
      </div>
    );
  }

  const changedTotal = changes.added + changes.updated + changes.removed;
  const zoneLabel = eventZoneAbbreviation();

  return (
    <div className="app">
      <header className="topbar">
        <div className="spread">
          <div style={{ minWidth: 0 }}>
            <div className="topbar-title">{payload.subject.name}</div>
            <div className="topbar-sub">
              {payload.subject.kind === 'team'
                ? 'Team schedule'
                : [payload.subject.roleLabel, payload.subject.teamName].filter(Boolean).join(' · ')}
            </div>
          </div>
          <button className="btn sm ghost" onClick={onSwitch}>
            {switchLabel}
          </button>
        </div>
        <div className="row tiny faint" style={{ marginTop: 8 }}>
          <span className={`status-dot ${stale ? 'offline' : liveStatus}`} aria-hidden="true" />
          <span>
            {stale
              ? `Offline · last known ${formatTimestamp(payload.updatedAt)}`
              : `Last updated ${formatTimestamp(payload.updatedAt)}`}
            {/* Every time on this screen is venue time. Saying so once is what
                tells a traveller their phone's clock is not the reference. */}
            {zoneLabel ? ` ${zoneLabel}` : ''}
          </span>
        </div>
      </header>

      <div className="screen">
        {/* Without this, a rehearsal at a pinned time is indistinguishable from
            the live app — and someone would eventually act on it. */}
        {isRehearsing() && (
          <div className="banner info" style={{ marginTop: 12 }}>
            <span aria-hidden="true">🕐</span>
            <span>
              Showing <strong>{formatTimestamp(at.toISOString())}</strong>
              {zoneLabel ? ` ${zoneLabel}` : ''} — a rehearsal time from the URL, not the live
              clock. Remove <code>?now=</code> to follow real time.
            </span>
          </div>
        )}

        {stale && (
          <div className="banner offline" style={{ marginTop: 12 }}>
            <span aria-hidden="true">⚠️</span>
            <span>
              You're offline — showing the last known schedule as of{' '}
              <strong>{formatTimestamp(payload.updatedAt)}</strong>. It will refresh automatically
              when you're back on wifi.
            </span>
          </div>
        )}

        {changedTotal > 0 && (
          <div className="banner change" style={{ marginTop: 12 }}>
            <span aria-hidden="true">✨</span>
            <span>
              Your schedule just changed
              {changes.added ? ` · ${changes.added} added` : ''}
              {changes.updated ? ` · ${changes.updated} moved` : ''}
              {changes.removed ? ` · ${changes.removed} removed` : ''}
              . Updated items are highlighted.
            </span>
          </div>
        )}

        <NowNext timeline={timeline} nextBlocks={nextBlocks} days={days} at={at} />

        <div className="daytabs" role="tablist" aria-label="Day">
          {days.map((d) => (
            <button
              key={d.key}
              role="tab"
              className="daytab"
              aria-selected={activeDay === d.key}
              onClick={() => setDay(d.key)}
            >
              {d.label}
              <span className="daytab-date">{formatDayDate(d)}</span>
            </button>
          ))}
        </div>

        {dayBlocks.length ? (
          <div className="stack">
            {dayBlocks.map((b) => (
              <BlockCard
                key={b.id}
                block={b}
                status={timeline.statusById[b.id] ?? 'upcoming'}
                changed={changes.ids.has(b.id)}
              />
            ))}
          </div>
        ) : (
          <div className="empty-day">Nothing scheduled for you on this day.</div>
        )}

        <ContactCard contact={payload.contact} />

        <p className="tiny faint center" style={{ marginTop: 24 }}>
          Last updated {formatTimestamp(payload.updatedAt)} ·{' '}
          {stale ? 'reconnecting…' : liveStatus === 'live' ? 'live' : 'connecting…'}
        </p>
      </div>
    </div>
  );
}
