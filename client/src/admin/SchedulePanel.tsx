import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api';
import { formatRange, formatDateTime } from '../time';
import type { AssignmentTarget, Block, BlockLocation, EventDay } from '../types';

interface Draft {
  id?: string;
  day: string;
  startTime: string;
  endTime: string;
  activity: string;
  venue: string;
  subLocation: string;
  target: string; // "type:id"
  notes: string;
  /**
   * The `updatedAt` this draft was opened against. Sent back on save so the
   * server can refuse to overwrite an edit that landed in between — two
   * logistics people on the same block is the normal case here, not the
   * exotic one.
   */
  expectedUpdatedAt?: string;
}

const emptyDraft = (day: string): Draft => ({
  day,
  startTime: '',
  endTime: '',
  activity: '',
  venue: '',
  subLocation: '',
  target: '',
  notes: '',
});

/** Last-minute changes without touching the source sheet. */
export default function SchedulePanel({
  refreshKey,
  onChanged,
}: {
  /** Bumped by a live event from another admin. Reloads without remounting. */
  refreshKey: number;
  onChanged: () => void;
}) {
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [locations, setLocations] = useState<BlockLocation[]>([]);
  const [targets, setTargets] = useState<AssignmentTarget[]>([]);
  const [days, setDays] = useState<EventDay[]>([]);
  const [day, setDay] = useState<string>('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** A block a delete lost the race to. The edit case is derived — see below. */
  const [staleDeleteId, setStaleDeleteId] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const load = async () => {
    const [b, t, r] = await Promise.all([
      api.get<{ blocks: Block[]; locations: BlockLocation[] }>('/api/admin/blocks'),
      api.get<{ targets: AssignmentTarget[] }>('/api/admin/targets'),
      api.get<{ days: EventDay[] }>('/api/admin/roster'),
    ]);
    setBlocks(b.blocks);
    setLocations(b.locations);
    setTargets(t.targets);
    setDays(r.days);
    setDay((d) => d || r.days[0]?.key || '');
  };

  useEffect(() => {
    load().catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  /**
   * The conflict banner is derived, not stored: it is simply "the open draft's
   * block, when the freshly-loaded copy no longer matches the version the draft
   * was opened against". `blocks` is always current — the `refreshKey` effect
   * reloads on any other admin's change, and both 409 handlers reload too — so
   * a stored copy would only be a second, staler answer to the same question.
   *
   * It also means the banner appears the moment the block moves underneath,
   * rather than waiting for Save to fail.
   */
  const conflict =
    blocks.find(
      (b) =>
        (draft?.id === b.id && draft.expectedUpdatedAt && b.updatedAt !== draft.expectedUpdatedAt) ||
        b.id === staleDeleteId
    ) ?? null;

  const targetLabel = useMemo(() => {
    const map = new Map(targets.map((t) => [`${t.type}:${t.id}`, t.label]));
    return (b: Block) => map.get(`${b.appliesTo.type}:${b.appliesTo.id}`) ?? '(unassigned)';
  }, [targets]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return blocks
      .filter((b) => b.day === day)
      .filter(
        (b) =>
          !q ||
          b.activity.toLowerCase().includes(q) ||
          targetLabel(b).toLowerCase().includes(q) ||
          (b.location?.display ?? '').toLowerCase().includes(q)
      );
  }, [blocks, day, query, targetLabel]);

  const startEdit = (b: Block) => {
    // Re-stamping `expectedUpdatedAt` from the current block is what clears the
    // derived conflict — there is no separate banner state to reset.
    setStaleDeleteId(null);
    setDraft({
      id: b.id,
      day: b.day,
      startTime: b.startTime,
      endTime: b.endTime,
      activity: b.activity,
      venue: b.location?.venue ?? '',
      subLocation: b.location?.subLocation ?? '',
      target: `${b.appliesTo.type}:${b.appliesTo.id}`,
      notes: b.notes ?? '',
      expectedUpdatedAt: b.updatedAt,
    });
  };

  /**
   * A 409 means someone else saved this block first. Reloading is enough to
   * raise the banner for an edit, because it is derived from `blocks`; a delete
   * has no draft to derive from, so it names the block explicitly.
   */
  const isConflict = (e: unknown) => e instanceof ApiError && e.status === 409;

  const save = async () => {
    if (!draft) return;
    const [type, id] = draft.target.split(':');
    if (!type || !id) return setError('Pick who this block is for.');
    setBusy(true);
    setError(null);
    const body = {
      day: draft.day,
      startTime: draft.startTime,
      endTime: draft.endTime,
      activity: draft.activity.trim(),
      venue: draft.venue.trim(),
      subLocation: draft.subLocation.trim(),
      appliesToType: type,
      appliesToId: id,
      notes: draft.notes.trim() || null,
      expectedUpdatedAt: draft.expectedUpdatedAt,
    };
    try {
      if (draft.id) await api.patch(`/api/admin/blocks/${draft.id}`, body);
      else await api.post('/api/admin/blocks', body);
      setDraft(null);
      setStaleDeleteId(null);
      await load();
      onChanged();
    } catch (e) {
      // The draft stays open and still holds the version it was written
      // against, so reloading is what makes the banner appear.
      if (isConflict(e)) await load();
      else setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (b: Block) => {
    if (!window.confirm(`Delete "${b.activity}" (${b.day} ${b.startTime})? Everyone assigned to it sees this immediately.`))
      return;
    setError(null);
    try {
      await api.del(
        `/api/admin/blocks/${b.id}?expectedUpdatedAt=${encodeURIComponent(b.updatedAt)}`
      );
      setStaleDeleteId(null);
    } catch (e) {
      if (isConflict(e)) setStaleDeleteId(b.id);
      else setError(e instanceof Error ? e.message : 'Delete failed');
      await load();
      return;
    }
    await load();
    onChanged();
  };

  const grouped = useMemo(() => {
    const groups = new Map<string, AssignmentTarget[]>();
    for (const t of targets) {
      if (!groups.has(t.group)) groups.set(t.group, []);
      groups.get(t.group)!.push(t);
    }
    return [...groups.entries()];
  }, [targets]);

  return (
    <>
      {error && <div className="banner offline" style={{ marginBottom: 12 }}>{error}</div>}

      {conflict && (
        <div className="banner offline" style={{ marginBottom: 12 }} role="alert">
          <span aria-hidden="true">⚠️</span>
          <span>
            <strong>Someone else changed this block while you had it open.</strong>
            <br />
            It now reads <strong>{conflict.activity}</strong>,{' '}
            {formatRange(conflict.startTime, conflict.endTime)} on {conflict.day}
            {conflict.location ? ` · ${conflict.location.display}` : ''} (saved{' '}
            {formatDateTime(conflict.updatedAt)}). Nothing of yours was saved.
            <br />
            <button
              className="btn sm"
              style={{ marginTop: 8 }}
              onClick={() => startEdit(conflict)}
            >
              Edit the current version
            </button>{' '}
            <button
              className="btn sm ghost"
              style={{ marginTop: 8 }}
              onClick={() => {
                setStaleDeleteId(null);
                setDraft(null);
              }}
            >
              Discard my change
            </button>
          </span>
        </div>
      )}

      <div className="daytabs">
        {days.map((d) => (
          <button
            key={d.key}
            className="daytab"
            aria-selected={day === d.key}
            onClick={() => setDay(d.key)}
          >
            {d.label}
            <span className="daytab-date">
              {blocks.filter((b) => b.day === d.key).length} blocks
            </span>
          </button>
        ))}
      </div>

      <div className="row" style={{ marginBottom: 12 }}>
        <input
          className="search"
          style={{ marginBottom: 0 }}
          placeholder="Filter by activity, team, or room…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="btn primary" onClick={() => setDraft(emptyDraft(day))}>
          + Add
        </button>
      </div>

      {draft && (
        <div className="card" style={{ borderColor: 'var(--gold-dim)', marginBottom: 12 }}>
          <h3>{draft.id ? 'Edit block' : 'New block'}</h3>
          <div className="stack" style={{ marginTop: 10 }}>
            <div className="field-row">
              <div className="field">
                <label>Day</label>
                <select value={draft.day} onChange={(e) => setDraft({ ...draft, day: e.target.value })}>
                  {days.map((d) => (
                    <option key={d.key} value={d.key}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Assigned to</label>
                <select
                  value={draft.target}
                  onChange={(e) => setDraft({ ...draft, target: e.target.value })}
                >
                  <option value="">Choose…</option>
                  {grouped.map(([group, items]) => (
                    <optgroup key={group} label={group}>
                      {items.map((t) => (
                        <option key={`${t.type}:${t.id}`} value={`${t.type}:${t.id}`}>
                          {t.label}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>
            </div>

            <div className="field-row">
              <div className="field">
                <label>Start</label>
                <input
                  type="time"
                  value={draft.startTime}
                  onChange={(e) => setDraft({ ...draft, startTime: e.target.value })}
                />
              </div>
              <div className="field">
                <label>End</label>
                <input
                  type="time"
                  value={draft.endTime}
                  onChange={(e) => setDraft({ ...draft, endTime: e.target.value })}
                />
              </div>
            </div>

            <div className="field">
              <label>Activity</label>
              <input
                value={draft.activity}
                onChange={(e) => setDraft({ ...draft, activity: e.target.value })}
                placeholder="e.g. Tech rehearsal"
              />
            </div>

            <div className="field-row">
              <div className="field">
                <label>Venue</label>
                <input
                  list="venues"
                  value={draft.venue}
                  onChange={(e) => setDraft({ ...draft, venue: e.target.value })}
                  placeholder="Main Venue"
                />
              </div>
              <div className="field">
                <label>Sub-location</label>
                <input
                  list="sublocations"
                  value={draft.subLocation}
                  onChange={(e) => setDraft({ ...draft, subLocation: e.target.value })}
                  placeholder="Green Room B"
                />
              </div>
            </div>
            <datalist id="venues">
              {[...new Set(locations.map((l) => l.venue))].map((v) => (
                <option key={v} value={v} />
              ))}
            </datalist>
            <datalist id="sublocations">
              {[...new Set(locations.map((l) => l.subLocation).filter(Boolean))].map((v) => (
                <option key={v as string} value={v as string} />
              ))}
            </datalist>

            <div className="field">
              <label>Notes (shown on the block)</label>
              <textarea
                value={draft.notes}
                onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
              />
            </div>

            <div className="row">
              <button
                className="btn primary"
                onClick={save}
                disabled={busy || !draft.activity || !draft.startTime || !draft.endTime || !draft.target}
              >
                {busy ? 'Saving…' : 'Save & push live'}
              </button>
              <button className="btn ghost" onClick={() => setDraft(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        {visible.length === 0 && <p className="muted small">No blocks match.</p>}
        {visible.map((b) => (
          <div className="list-row" key={b.id}>
            <div style={{ minWidth: 0 }}>
              <div className="label">
                {b.activity}{' '}
                {b.source !== 'manual' && <span className="badge soft">{b.source}</span>}
              </div>
              <div className="sub">
                {formatRange(b.startTime, b.endTime)} · {b.location?.display ?? 'No location'}
              </div>
              <div className="sub">→ {targetLabel(b)}</div>
            </div>
            <div className="row">
              <button className="btn sm" onClick={() => startEdit(b)}>
                Edit
              </button>
              <button className="btn sm danger" onClick={() => remove(b)}>
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
