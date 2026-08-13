import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { reportHeld, useLive, useTicker } from '../live';
import { cacheSchedule, readAnyCachedSchedule } from '../session';
import type { Block, SchedulePayload } from '../types';
import {
  buildTimeline,
  formatDayDate,
  formatTimestamp,
  nextGroup,
} from '../time';
import { eventNow, eventZoneAbbreviation, isRehearsing, syncClock } from '../clock';
import { useTabStrip } from '../tabstrip';
import BlockCard from './BlockCard';
import ContactCard from './ContactCard';
import NowNext from './NowNext';
import Loading from '../Loading';

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
  notice,
  onSessionLost,
}: {
  onSwitch: () => void;
  switchLabel: string;
  /** Rendered with the other banners — e.g. a magic link that failed. */
  notice?: React.ReactNode;
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
      // Report what this screen is now showing, so the panel can answer
      // "did every phone get that?" without asking everyone in the room.
      reportHeld(data.updatedAt);
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
  const activeDayLabel = days.find((d) => d.key === activeDay)?.label ?? '';
  const { tablistProps, tabProps } = useTabStrip(
    days.map((d) => d.key),
    activeDay,
    setDay,
  );

  if (gone) {
    return (
      <div className="landing" role="main">
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
        <div className="landing" role="main">
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
    return <Loading label="Loading your schedule…" visible />;
  }

  const changedTotal = changes.added + changes.updated + changes.removed;
  const zoneLabel = eventZoneAbbreviation();

  return (
    <div className="app">
      <header className="topbar">
        <div className="spread">
          <div style={{ minWidth: 0 }}>
            {/* The one h1 on the screen. Whose schedule this is answers the
                question a screen reader user arrives with, and it is what the
                sighted eye lands on too — so it is the same element, not a
                hidden duplicate. */}
            <h1 className="topbar-title">{payload.subject.name}</h1>
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

      <main className="screen">
        {notice}

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

        {/* Both banners appear without anyone touching the screen — one when
            the signal drops, one when logistics moves something. A sighted
            user gets the colour and the flash; role="status" is how everyone
            else is told, and polite means it waits for a gap rather than
            cutting across whatever is being read. */}
        {stale && (
          <div className="banner offline" style={{ marginTop: 12 }} role="status">
            <span aria-hidden="true">⚠️</span>
            <span>
              You're offline — showing the last known schedule as of{' '}
              <strong>{formatTimestamp(payload.updatedAt)}</strong>. It will refresh automatically
              when you're back on wifi.
            </span>
          </div>
        )}

        {changedTotal > 0 && (
          <div className="banner change" style={{ marginTop: 12 }} role="status">
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

        <h2 className="vh">Full schedule</h2>
        <div className="daytabs" aria-label="Day" {...tablistProps}>
          {days.map((d) => (
            <button
              key={d.key}
              id={`daytab-${d.key}`}
              className="daytab"
              aria-controls="daypanel"
              {...tabProps(d.key)}
            >
              {d.label}
              <span className="daytab-date">{formatDayDate(d)}</span>
            </button>
          ))}
        </div>

        <div
          id="daypanel"
          className="daypanel"
          role="tabpanel"
          aria-labelledby={activeDay ? `daytab-${activeDay}` : undefined}
          tabIndex={0}
        >
          {dayBlocks.length ? (
            // A list, so a screen reader announces how many items the day
            // holds and where each one ends — otherwise the whole day is an
            // unbroken run of text with no boundaries in it.
            <ul className="stack plainlist" aria-label={`${activeDayLabel} schedule`}>
              {dayBlocks.map((b) => (
                <BlockCard
                  key={b.id}
                  block={b}
                  status={timeline.statusById[b.id] ?? 'upcoming'}
                  changed={changes.ids.has(b.id)}
                />
              ))}
            </ul>
          ) : (
            <div className="empty-day">Nothing scheduled for you on this day.</div>
          )}
        </div>

        <ContactCard contact={payload.contact} />

        <p className="tiny faint center" style={{ marginTop: 24 }}>
          Last updated {formatTimestamp(payload.updatedAt)} ·{' '}
          {stale ? 'reconnecting…' : liveStatus === 'live' ? 'live' : 'connecting…'}
        </p>
      </main>
    </div>
  );
}
