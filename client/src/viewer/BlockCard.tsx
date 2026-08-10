import type { Block } from '../types';
import type { BlockStatus } from '../time';
import { formatTime } from '../time';

export default function BlockCard({
  block,
  status,
  changed,
}: {
  block: Block;
  status: BlockStatus;
  changed: boolean;
}) {
  const cls = [
    'block',
    status === 'now' ? 'is-now' : '',
    status === 'past' ? 'is-past' : '',
    changed ? 'is-changed' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={cls}>
      <div className="block-time">
        {formatTime(block.startTime)}
        <span className="end">to {formatTime(block.endTime)}</span>
      </div>
      <div>
        <div className="block-activity">
          {block.activity}{' '}
          {status === 'now' && <span className="badge now">Now</span>}
          {changed && status !== 'now' && <span className="badge changed">Changed</span>}
          {/* Whose item is this? Every other block on the screen is here
              because it is yours; an announcement is here because it is
              everyone's, and "is this just me" is the first thing someone
              asks when an evacuation notice appears on their schedule. */}
          {block.appliesTo.type === 'everyone' && (
            <span className="badge soft">Everyone</span>
          )}
        </div>
        {block.location && (
          <div className="block-loc">
            {block.location.subLocation ? (
              <>
                {block.location.subLocation}
                <span className="faint"> · {block.location.venue}</span>
              </>
            ) : (
              block.location.venue
            )}
          </div>
        )}
        {block.notes && <div className="block-note">{block.notes}</div>}
      </div>
    </div>
  );
}
