import type { Block, EventDay } from '../types';
import { blockStart, countdown, formatRange, type Timeline } from '../time';

/**
 * The answer to "where do I need to be" — sized to be readable at a glance and
 * always above the fold, before any scrolling.
 */
export default function NowNext({
  timeline,
  nextBlocks,
  days,
  at,
}: {
  timeline: Timeline;
  nextBlocks: Block[];
  days: EventDay[];
  at: Date;
}) {
  const current = timeline.now;

  if (!current.length && !nextBlocks.length) {
    return (
      <div className="hero">
        <h2 className="hero-eyebrow">You're all set</h2>
        <div className="hero-empty" style={{ marginTop: 10 }}>
          Nothing else on your schedule.
        </div>
        <div className="muted small" style={{ marginTop: 8 }}>
          Check the full schedule below, or tap your contact if something's changed.
        </div>
      </div>
    );
  }

  if (current.length) {
    const [primary, ...also] = current;
    return (
      <div className="hero is-now">
        <div className="hero-stack">
          <div>
            {/* The hero is the answer to "where do I need to be", so it is the
                first thing under the h1 and the first heading to jump to. */}
            <h2 className="hero-eyebrow">
              <span className="pulse" aria-hidden="true" /> Right now
            </h2>
            <div className="hero-activity">{primary.activity}</div>
            <div className="hero-time">{formatRange(primary.startTime, primary.endTime)}</div>
            <Where block={primary} />
            {primary.notes && <div className="hero-note">{primary.notes}</div>}
          </div>

          {also.map((b) => (
            <div className="hero-also" key={b.id}>
              Also now: <strong>{b.activity}</strong>
              {b.location ? ` · ${b.location.display}` : ''}
            </div>
          ))}

          {nextBlocks.length > 0 && (
            <div className="hero-also">
              Next: <strong>{nextBlocks[0].activity}</strong> ·{' '}
              {countdown(blockStart(nextBlocks[0]), at)}
            </div>
          )}
        </div>
      </div>
    );
  }

  const [primary, ...also] = nextBlocks;
  const start = blockStart(primary);
  const dayLabel = days.find((d) => d.key === primary.day)?.label ?? primary.day;

  return (
    <div className="hero">
      <div className="hero-stack">
        <div>
          <h2 className="hero-eyebrow">Up next · {countdown(start, at)}</h2>
          <div className="hero-activity">{primary.activity}</div>
          <div className="hero-time">
            {dayLabel} · {formatRange(primary.startTime, primary.endTime)}
          </div>
          <Where block={primary} />
          {primary.notes && <div className="hero-note">{primary.notes}</div>}
        </div>
        {also.map((b) => (
          <div className="hero-also" key={b.id}>
            At the same time: <strong>{b.activity}</strong>
            {b.location ? ` · ${b.location.display}` : ''}
          </div>
        ))}
      </div>
    </div>
  );
}

function Where({ block }: { block: Block }) {
  if (!block.location) {
    return (
      <div className="hero-where">
        <span className="muted">Location TBC</span>
      </div>
    );
  }
  return (
    <div className="hero-where">
      {block.location.subLocation ?? block.location.venue}
      {block.location.subLocation && <span className="venue">{block.location.venue}</span>}
    </div>
  );
}
