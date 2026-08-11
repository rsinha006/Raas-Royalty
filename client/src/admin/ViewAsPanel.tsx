import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api';
import { eventNow, eventZoneAbbreviation } from '../clock';
import { buildTimeline, formatDayDate, formatTimestamp, nextGroup } from '../time';
import { useTabStrip } from '../tabstrip';
import type { SchedulePayload, TargetType, TeamMember } from '../types';
import BlockCard from '../viewer/BlockCard';
import ContactCard from '../viewer/ContactCard';
import NowNext from '../viewer/NowNext';
import Loading from '../Loading';

/**
 * "View as" — item 16.
 *
 * Built around the question that brings someone here, which is never "show me
 * a schedule" — it is "she says she can't see her warm-up". So the schedule is
 * rendered with the viewer's own components, and next to it are the three
 * things that distinguish the four reasons that sentence is ever true: which
 * targets this view matches on, how the person reaches it, and (for a team)
 * that this is the pre-identity view with the real people one click away.
 */

interface Target {
  type: TargetType;
  id: string;
  label: string;
  group: string;
}

interface AccessSummary {
  route: 'own-code' | 'team-code' | 'team-code-then-name' | 'role-code' | 'no-route';
  code: {
    subjectType: TargetType;
    subjectId: string;
    label: string;
    live: boolean;
    lastUsedAt: string | null;
  } | null;
  note: string | null;
}

interface Preview {
  schedule: SchedulePayload;
  targets: { type: TargetType; id: string; label: string }[];
  access: AccessSummary;
  members: TeamMember[] | null;
}

const ROUTE_LABEL: Record<AccessSummary['route'], string> = {
  'own-code': 'Signs in with their own link',
  'team-code': 'Reached with the team’s link',
  'team-code-then-name': 'Reached with the team’s link, then picking their name',
  'role-code': 'Needs a role code',
  'no-route': 'Cannot sign in',
};

export default function ViewAsPanel() {
  const [targets, setTargets] = useState<Target[]>([]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<{ type: TargetType; id: string } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get<{ targets: Target[] }>('/api/admin/targets')
      .then((d) => setTargets(d.targets))
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    api
      .get<Preview>(`/api/admin/view-as?type=${selected.type}&id=${encodeURIComponent(selected.id)}`)
      .then((data) => {
        setPreview(data);
        // Let the preview choose its own opening day rather than keeping the
        // last subject's — Friday for a videographer, Saturday for a dancer.
        setDay(null);
      })
      .catch((e) => {
        setPreview(null);
        setError(
          e instanceof ApiError && e.status === 404
            ? 'That subject is no longer in the roster.'
            : e.message
        );
      })
      .finally(() => setBusy(false));
  }, [selected]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return targets.slice(0, 12);
    return targets.filter((t) => t.label.toLowerCase().includes(q)).slice(0, 40);
  }, [targets, query]);

  const at = eventNow();
  const schedule = preview?.schedule ?? null;
  const blocks = schedule?.blocks ?? [];
  const days = schedule?.days ?? [];

  const timeline = useMemo(
    () => buildTimeline(blocks, days, at),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [blocks, days, at.getMinutes()]
  );
  const upcoming = useMemo(() => nextGroup(blocks, timeline), [blocks, timeline]);

  const activeDay = day ?? timeline.activeDay ?? days[0]?.key ?? null;
  const dayBlocks = blocks.filter((b) => b.day === activeDay);
  const zoneLabel = eventZoneAbbreviation();
  const { tablistProps, tabProps } = useTabStrip(
    days.map((d) => d.key),
    activeDay,
    setDay,
  );

  return (
    <div className="stack">
      <div className="card">
        <h3>View as</h3>
        <p className="muted small">
          Exactly what one team, person, or role sees — the same query their phone runs, so this
          screen and theirs cannot disagree.
        </p>
        <div className="field" style={{ marginTop: 12 }}>
          <label htmlFor="view-as-search">Who?</label>
          <input
            id="view-as-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search teams, people, roles…"
            autoComplete="off"
          />
        </div>
        <div className="chip-row">
          {matches.map((t) => (
            <button
              key={`${t.type}:${t.id}`}
              className={`chip${selected?.type === t.type && selected?.id === t.id ? ' is-on' : ''}`}
              onClick={() => setSelected({ type: t.type, id: t.id })}
            >
              {t.label}
              <span className="chip-kind">{t.group.replace(/s$/, '')}</span>
            </button>
          ))}
          {!matches.length && <span className="muted small">Nobody matches that.</span>}
        </div>
      </div>

      {error && <div className="banner offline">{error}</div>}
      {busy && !preview && <Loading label="Loading their schedule…" />}

      {preview && schedule && (
        <>
          <div className="card">
            <div className="spread">
              <div style={{ minWidth: 0 }}>
                <h3>{schedule.subject.name}</h3>
                <div className="muted small">
                  {schedule.subject.kind === 'team'
                    ? 'Team view'
                    : [schedule.subject.roleLabels?.join(' · '), schedule.subject.teamName]
                        .filter(Boolean)
                        .join(' · ')}
                </div>
              </div>
              <div className="tiny faint" style={{ textAlign: 'right' }}>
                Last updated
                <br />
                {formatTimestamp(schedule.updatedAt)} {zoneLabel}
              </div>
            </div>

            <AccessNote access={preview.access} />
          </div>

          {/* A team code lands on "which dancer are you?", so this is what
              somebody sees *before* they pick a name — no Captain blocks, no
              airport pickup. Saying so here is half the answer to "I don't see
              my warm-up", and the names make checking the other half one click. */}
          {preview.members && (
            <div className="card">
              <h3>Before picking a name</h3>
              <p className="muted small">
                A team link opens on the identity step. This is the team-wide view behind it —
                person-targeted blocks and captain blocks are not in it. Pick someone to see their
                own schedule.
              </p>
              <div className="chip-row" style={{ marginTop: 10 }}>
                {preview.members.map((m) => (
                  <button
                    key={m.id}
                    className="chip"
                    onClick={() => setSelected({ type: 'person', id: m.id })}
                  >
                    {m.name}
                  </button>
                ))}
                {!preview.members.length && (
                  <span className="muted small">Nobody is on this team.</span>
                )}
              </div>
            </div>
          )}

          <div className="card">
            <h3>Why these blocks</h3>
            <p className="muted small">
              A block reaches this view when it targets any one of these. If something is missing,
              compare its target against this list.
            </p>
            <div className="chip-row" style={{ marginTop: 10 }}>
              {preview.targets.map((t) => (
                <span key={`${t.type}:${t.id}`} className="chip is-static">
                  {t.label}
                  <span className="chip-kind">{t.type}</span>
                </span>
              ))}
            </div>
          </div>

          {/* From here down it is the viewer's own components against the
              viewer's own payload, so what an admin reads is what a phone
              renders — including which block counts as "now". */}
          <div className="viewer-frame">
            <NowNext timeline={timeline} nextBlocks={upcoming} days={days} at={at} />

            <div className="daytabs" aria-label="Day" {...tablistProps}>
              {days.map((d) => (
                <button key={d.key} className="daytab" {...tabProps(d.key)}>
                  {d.label}
                  <span className="daytab-date">{formatDayDate(d)}</span>
                </button>
              ))}
            </div>

            {dayBlocks.length ? (
              // A list, matching the viewer — BlockCard is an <li>, and the
              // point of this panel is that it renders the participant's own
              // components rather than a lookalike.
              <ul className="stack plainlist">
                {dayBlocks.map((b) => (
                  <BlockCard
                    key={b.id}
                    block={b}
                    status={timeline.statusById[b.id] ?? 'upcoming'}
                    changed={false}
                  />
                ))}
              </ul>
            ) : (
              <div className="empty-day">Nothing scheduled for them on this day.</div>
            )}

            <ContactCard contact={schedule.contact} />
          </div>
        </>
      )}
    </div>
  );
}

/**
 * How a real holder reaches this view. Two failures are worth shouting about:
 * no live code at all, and a dancer on no team — both mean the schedule below
 * is correct and completely unreachable, which no amount of staring at blocks
 * would ever reveal.
 */
function AccessNote({ access }: { access: AccessSummary }) {
  const unreachable = access.route === 'no-route' || (access.code && !access.code.live);
  return (
    <div className={`banner ${unreachable ? 'offline' : 'info'}`} style={{ marginTop: 12 }}>
      <span aria-hidden="true">{unreachable ? '⚠️' : '🔑'}</span>
      <span>
        <strong>{ROUTE_LABEL[access.route]}</strong>
        {access.code && (
          <>
            {' — '}
            {access.code.live ? (
              <>
                a live code for <strong>{access.code.label}</strong>,{' '}
                {access.code.lastUsedAt
                  ? `last used ${formatTimestamp(access.code.lastUsedAt)}`
                  : 'never used'}
              </>
            ) : (
              <>
                but <strong>{access.code.label}</strong> has no live code — issue one on the
                Access&nbsp;codes tab
              </>
            )}
          </>
        )}
        {access.note && <div className="tiny faint" style={{ marginTop: 4 }}>{access.note}</div>}
      </span>
    </div>
  );
}
