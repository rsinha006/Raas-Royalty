import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { formatDateTime } from '../time';

/**
 * The change log, and undo — item 17.
 *
 * Rebuilt around batches rather than rows. One admin action is one entry, so a
 * bulk shift reads as "18 blocks moved 20 minutes later" with its per-block
 * lines folded underneath, and the Undo button next to it puts back all
 * eighteen. Offering undo per row would let someone move half a day back and
 * leave the other half — the state item 15 goes out of its way to prevent.
 *
 * A batch that cannot be reversed says why in place of the button. That is the
 * more useful half: "this also removed Maya from the roster, which cannot be
 * put back" is a sentence someone can act on, where a greyed-out button is not.
 */

interface LogEntry {
  id: string;
  summary: string;
  changeType: string;
  timestamp: string;
  audience: { personIds: string[]; teamIds: string[] } | null;
}

interface Blocker {
  reason: string;
  blockId?: string;
  label: string;
}

interface Batch {
  batchId: string;
  at: string;
  editedBy: string;
  source: string;
  summary: string;
  entries: LogEntry[];
  undoneAt: string | null;
  canUndo: boolean;
  blockers: Blocker[];
  steps: number;
}

const SOURCE_LABEL: Record<string, string> = {
  admin: 'panel action',
  manual: 'manual edit',
  import: 'spreadsheet import',
  sheet: 'synced from sheet',
  seed: 'placeholder data',
};

export default function LogPanel({
  refreshKey,
  onChanged,
}: {
  /**
   * Bumped by any live event. Taken as a prop rather than as a `key` for the
   * same reason the editing panels do: remounting would throw away the confirm
   * step mid-click, and the result of an undo the moment it lands — which is
   * precisely when another admin's socket event arrives, because the undo is
   * what caused it.
   */
  refreshKey?: number;
  onChanged?: () => void;
}) {
  const [batches, setBatches] = useState<Batch[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ batches: Batch[] }>('/api/admin/undo');
      setBatches(data.batches);
    } catch {
      setBatches([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const undo = async (batch: Batch) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.post<{ undone: number; summary: string }>('/api/admin/undo', {
        batchId: batch.batchId,
      });
      setNotice(
        `Put back ${result.undone} block${result.undone === 1 ? '' : 's'}. You can undo this too.`
      );
      setConfirming(null);
      await load();
      // The schedule moved, so every other panel's data is stale.
      onChanged?.();
    } catch (e) {
      // 409 is the interesting one: someone else got there first, and nothing
      // was written. The server's message names the block.
      setError(
        e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'That did not work'
      );
      setConfirming(null);
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (!batches) {
    return (
      <div className="loading-screen">
        <span className="spinner" />
      </div>
    );
  }

  return (
    <div className="card">
      <h3>Change log</h3>
      <p className="small muted">
        Every change — manual or synced — with who made it and who it affected. Recent panel
        actions can be put back.
      </p>

      {error && (
        <div className="banner offline" style={{ marginTop: 12 }}>
          <span aria-hidden="true">⚠️</span>
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <div className="banner good" style={{ marginTop: 12 }}>
          <span aria-hidden="true">↩️</span>
          <span>{notice}</span>
        </div>
      )}

      {batches.length === 0 && (
        <p className="muted small" style={{ marginTop: 12 }}>
          Nothing logged yet.
        </p>
      )}

      <div style={{ marginTop: 8 }}>
        {batches.map((batch) => (
          <div className="log-entry" key={batch.batchId}>
            <div className="spread" style={{ gap: 12, alignItems: 'flex-start' }}>
              <div style={{ minWidth: 0 }}>
                <div className={batch.undoneAt ? 'is-undone' : undefined}>{batch.summary}</div>
                <div className="meta">
                  {formatDateTime(batch.at)} · {batch.editedBy} ·{' '}
                  {SOURCE_LABEL[batch.source] ?? batch.source}
                  {batch.entries.length > 1 && (
                    <>
                      {' · '}
                      <button className="linkish" onClick={() => setOpen(open === batch.batchId ? null : batch.batchId)}>
                        {open === batch.batchId
                          ? 'hide detail'
                          : `${batch.entries.length} entries`}
                      </button>
                    </>
                  )}
                </div>
              </div>

              <UndoControl
                batch={batch}
                busy={busy}
                confirming={confirming === batch.batchId}
                onAsk={() => setConfirming(batch.batchId)}
                onCancel={() => setConfirming(null)}
                onConfirm={() => undo(batch)}
              />
            </div>

            {open === batch.batchId && (
              <div className="log-detail">
                {batch.entries.map((e) => (
                  <div key={e.id} className="tiny">
                    {e.summary}
                    {e.audience?.personIds?.length ? (
                      <span className="faint">
                        {' '}
                        · affects {e.audience.personIds.length}{' '}
                        {e.audience.personIds.length === 1 ? 'person' : 'people'}
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The button, the confirm step, or the reason there is neither.
 *
 * Undo is confirmed rather than immediate because this is a live event: the
 * blocks it puts back are on ~280 phones a second later, and "I meant to click
 * the one above" is a real Saturday afternoon.
 */
function UndoControl({
  batch,
  busy,
  confirming,
  onAsk,
  onCancel,
  onConfirm,
}: {
  batch: Batch;
  busy: boolean;
  confirming: boolean;
  onAsk: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (batch.undoneAt) {
    return <span className="tiny faint nowrap">undone {formatDateTime(batch.undoneAt)}</span>;
  }

  if (!batch.canUndo) {
    return (
      <span className="tiny faint undo-why" title={batch.blockers[0]?.label}>
        {batch.blockers[0]?.label ?? 'Cannot be undone.'}
      </span>
    );
  }

  if (confirming) {
    return (
      <span className="row nowrap" style={{ gap: 6 }}>
        <button className="btn sm danger" disabled={busy} onClick={onConfirm}>
          Put back {batch.steps}
        </button>
        <button className="btn sm ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </span>
    );
  }

  return (
    <button className="btn sm ghost nowrap" disabled={busy} onClick={onAsk}>
      Undo
    </button>
  );
}
