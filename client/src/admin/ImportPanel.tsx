import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { formatDateTime } from '../time';

interface SchedulePreview {
  token: string;
  filename: string;
  headers: string[];
  /** The tab the rows came off — `Export` for the event template, null for a CSV. */
  sheetName: string | null;
  parsedRows: number;
  validRows: number;
  /** Rows carrying a single cell: the Export tab's own footnotes, skipped rather than reported. */
  noteRows: number;
  errors: { row: number; message: string }[];
  /** Why this file cannot be applied, or null. Set before Apply is ever pressed. */
  refusal: string | null;
  removeMissing: boolean;
  diff: {
    create: { label: string }[];
    update: { id: string; label: string; changes: string[] }[];
    delete: { id: string; label: string }[];
    unchanged: number;
    hasChanges: boolean;
  };
}

interface RosterPreview {
  token: string;
  filename: string;
  /** Both roster tabs, in the order they were read. */
  sheetNames: string[];
  parsedRows: number;
  validRows: number;
  errors: { row: number; sheet?: string | null; message: string }[];
  diff: {
    createTeams: { name: string }[];
    createContacts: { name: string | null }[];
    createPeople: { label: string }[];
    updatePeople: { label: string; changes: string[] }[];
    deletePeople: { label: string }[];
    unchanged: number;
    hasChanges: boolean;
  };
}

interface SyncStatus {
  activeId: string;
  activeLabel: string;
  kind: string;
  canPull: boolean;
  lastUpload: { filename: string; at: string } | null;
  lastSyncAt: string | null;
  pollSeconds: number;
}

/**
 * Interim mechanism: upload a spreadsheet, preview the diff, then confirm.
 * The commit path is identical to what the live sheet sync will call, so
 * switching to the API later changes nothing here.
 */
export default function ImportPanel({ onChanged }: { onChanged: () => void }) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [message, setMessage] = useState<{ kind: 'good' | 'bad'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const [schedulePreview, setSchedulePreview] = useState<SchedulePreview | null>(null);
  const [rosterPreview, setRosterPreview] = useState<RosterPreview | null>(null);
  const [removeMissing, setRemoveMissing] = useState(true);
  const [pruneRoster, setPruneRoster] = useState(false);
  const [seedBlocks, setSeedBlocks] = useState(0);

  const scheduleFile = useRef<HTMLInputElement>(null);
  const rosterFile = useRef<HTMLInputElement>(null);

  const loadStatus = () => {
    api.get<SyncStatus>('/api/admin/sync/status').then(setStatus).catch(() => {});
    api
      .get<{ counts: { seedBlocks: number } }>('/api/admin/overview')
      .then((d) => setSeedBlocks(d.counts.seedBlocks))
      .catch(() => {});
  };
  useEffect(() => {
    loadStatus();
  }, []);

  const clearSeed = async () => {
    if (
      !window.confirm(
        `Delete all ${seedBlocks} placeholder schedule blocks? Imported and manually-added blocks are kept.`
      )
    )
      return;
    setBusy(true);
    try {
      const res = await api.del<{ removed: number }>('/api/admin/seed-data');
      setMessage({ kind: 'good', text: `Removed ${res.removed} placeholder blocks.` });
      loadStatus();
      onChanged();
    } catch (e) {
      setMessage({ kind: 'bad', text: e instanceof Error ? e.message : 'Could not clear' });
    } finally {
      setBusy(false);
    }
  };

  const uploadSchedule = async (file: File) => {
    setBusy(true);
    setMessage(null);
    setSchedulePreview(null);
    const form = new FormData();
    form.append('file', file);
    form.append('removeMissing', String(removeMissing));
    try {
      setSchedulePreview(await api.upload<SchedulePreview>('/api/admin/schedule/import/preview', form));
    } catch (e) {
      setMessage({ kind: 'bad', text: e instanceof Error ? e.message : 'Upload failed' });
    } finally {
      setBusy(false);
    }
  };

  const commitSchedule = async () => {
    if (!schedulePreview) return;
    setBusy(true);
    try {
      await api.post('/api/admin/schedule/import/commit', {
        token: schedulePreview.token,
        removeMissing,
      });
      setMessage({ kind: 'good', text: 'Schedule updated and pushed to everyone.' });
      setSchedulePreview(null);
      if (scheduleFile.current) scheduleFile.current.value = '';
      await loadStatus();
      onChanged();
    } catch (e) {
      setMessage({ kind: 'bad', text: e instanceof Error ? e.message : 'Import failed' });
    } finally {
      setBusy(false);
    }
  };

  const uploadRoster = async (file: File) => {
    setBusy(true);
    setMessage(null);
    setRosterPreview(null);
    const form = new FormData();
    form.append('file', file);
    form.append('removeMissing', String(pruneRoster));
    try {
      setRosterPreview(await api.upload<RosterPreview>('/api/admin/roster/import/preview', form));
    } catch (e) {
      setMessage({ kind: 'bad', text: e instanceof Error ? e.message : 'Upload failed' });
    } finally {
      setBusy(false);
    }
  };

  const commitRoster = async () => {
    if (!rosterPreview) return;
    setBusy(true);
    try {
      await api.post('/api/admin/roster/import/commit', {
        token: rosterPreview.token,
        removeMissing: pruneRoster,
      });
      setMessage({ kind: 'good', text: 'Roster updated.' });
      setRosterPreview(null);
      if (rosterFile.current) rosterFile.current.value = '';
      onChanged();
    } catch (e) {
      setMessage({ kind: 'bad', text: e instanceof Error ? e.message : 'Import failed' });
    } finally {
      setBusy(false);
    }
  };

  const resync = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await api.post<{ diff: SchedulePreview['diff'] }>('/api/admin/schedule/resync');
      const d = res.diff;
      setMessage({
        kind: 'good',
        text: `Re-sync complete: ${d.create.length} added, ${d.update.length} changed, ${d.delete.length} removed.`,
      });
      await loadStatus();
      onChanged();
    } catch (e) {
      setMessage({ kind: 'bad', text: e instanceof Error ? e.message : 'Re-sync failed' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {message && (
        <div className={`banner ${message.kind === 'good' ? 'good' : 'offline'}`} style={{ marginBottom: 12 }}>
          {message.text}
        </div>
      )}

      {seedBlocks > 0 && (
        <div className="banner info" style={{ marginBottom: 12 }}>
          <span aria-hidden="true">🌱</span>
          <span>
            {seedBlocks} placeholder blocks are still live. Imports only manage rows they created,
            so clear these once the real schedule is in — otherwise both show up on people's phones.
            <br />
            <button className="btn sm" style={{ marginTop: 8 }} onClick={clearSeed} disabled={busy}>
              Clear placeholder blocks
            </button>
          </span>
        </div>
      )}

      {/* ---------------- schedule ---------------- */}
      <div className="card">
        <h3>Import schedule from spreadsheet</h3>
        <p className="small muted">
          Upload a .csv or .xlsx using the schedule template. You'll see exactly what changes before
          anything goes live.
        </p>

        <label className="filedrop" style={{ marginTop: 12, display: 'block' }}>
          <input
            ref={scheduleFile}
            type="file"
            accept=".csv,.xlsx,.xlsm,text/csv"
            style={{ display: 'none' }}
            onChange={(e) => e.target.files?.[0] && uploadSchedule(e.target.files[0])}
          />
          <strong>Choose a schedule file</strong>
          <div className="tiny faint" style={{ marginTop: 4 }}>
            Day · Start · End · Location · Sub-location · Activity · Assigned Team/Person · Notes
          </div>
        </label>

        <label className="row tiny" style={{ marginTop: 12 }}>
          <input
            type="checkbox"
            checked={removeMissing}
            onChange={(e) => setRemoveMissing(e.target.checked)}
            style={{ width: 20, height: 20 }}
          />
          Remove previously-imported blocks that are no longer in the file (manual blocks are never
          touched)
        </label>

        {busy && !schedulePreview && (
          <p className="row small muted" style={{ marginTop: 10 }}>
            <span className="spinner" /> Working…
          </p>
        )}

        {schedulePreview && (
          <div style={{ marginTop: 16 }}>
            <h4 className="section-title">Preview — nothing has been applied yet</h4>
            <p className="small muted">
              {schedulePreview.filename}
              {schedulePreview.sheetName ? ` · ${schedulePreview.sheetName} tab` : ''} ·{' '}
              {schedulePreview.validRows} of {schedulePreview.parsedRows} rows valid ·{' '}
              {schedulePreview.diff.unchanged} unchanged
              {schedulePreview.noteRows > 0 ? ` · ${schedulePreview.noteRows} note rows ignored` : ''}
            </p>

            {schedulePreview.refusal && (
              <div className="banner warn" style={{ marginTop: 10 }}>
                <span aria-hidden="true">⛔</span>
                <span>{schedulePreview.refusal}</span>
              </div>
            )}

            {schedulePreview.errors.length > 0 && (
              <div className="banner info" style={{ marginTop: 10 }}>
                <span aria-hidden="true">⚠️</span>
                <span>
                  {schedulePreview.errors.length} row(s) will be skipped:
                  <ul style={{ margin: '6px 0 0 16px', padding: 0 }}>
                    {schedulePreview.errors.slice(0, 8).map((e) => (
                      <li key={e.row}>
                        Row {e.row}: {e.message}
                      </li>
                    ))}
                    {schedulePreview.errors.length > 8 && <li>…and {schedulePreview.errors.length - 8} more</li>}
                  </ul>
                </span>
              </div>
            )}

            <DiffGroup title="Add" cls="add" items={schedulePreview.diff.create.map((c) => ({ label: c.label }))} />
            <DiffGroup
              title="Change"
              cls="mod"
              items={schedulePreview.diff.update.map((u) => ({ label: u.label, why: u.changes.join('; ') }))}
            />
            <DiffGroup title="Remove" cls="del" items={schedulePreview.diff.delete.map((d) => ({ label: d.label }))} />

            {!schedulePreview.diff.hasChanges && (
              <p className="small muted" style={{ marginTop: 10 }}>
                No differences — the live schedule already matches this file.
              </p>
            )}

            <div className="row" style={{ marginTop: 14 }}>
              <button
                className="btn primary"
                disabled={busy || !schedulePreview.diff.hasChanges || Boolean(schedulePreview.refusal)}
                onClick={commitSchedule}
              >
                {busy ? 'Applying…' : 'Apply & push live'}
              </button>
              <button className="btn ghost" onClick={() => setSchedulePreview(null)}>
                Discard
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ---------------- re-sync ---------------- */}
      <div className="card">
        <h3>Force re-sync</h3>
        <p className="small muted">
          Pulls from the configured source and applies it immediately. Right now the source is{' '}
          <strong>{status?.activeLabel ?? '…'}</strong>
          {status?.activeId === 'upload' && status.lastUpload
            ? ` — this re-applies ${status.lastUpload.filename} (uploaded ${formatDateTime(status.lastUpload.at)}).`
            : '.'}
        </p>
        {status?.pollSeconds ? (
          <p className="tiny faint">Automatic polling is on, every {status.pollSeconds}s.</p>
        ) : (
          <p className="tiny faint">Automatic polling is off (set SYNC_POLL_SECONDS to enable).</p>
        )}
        <button
          className="btn"
          style={{ marginTop: 10 }}
          disabled={busy || !status?.canPull}
          onClick={resync}
        >
          {busy ? 'Syncing…' : 'Force re-sync now'}
        </button>
        {!status?.canPull && (
          <p className="tiny faint" style={{ marginTop: 8 }}>
            Nothing to pull yet — upload a spreadsheet, or configure a live source.
          </p>
        )}
      </div>

      {/* ---------------- roster ---------------- */}
      <div className="card">
        <h3>Import roster</h3>
        <p className="small muted">Columns: Name · Role · Team · Contact Person/Method.</p>

        <label className="filedrop" style={{ marginTop: 12, display: 'block' }}>
          <input
            ref={rosterFile}
            type="file"
            accept=".csv,.xlsx,.xlsm,text/csv"
            style={{ display: 'none' }}
            onChange={(e) => e.target.files?.[0] && uploadRoster(e.target.files[0])}
          />
          <strong>Choose a roster file</strong>
        </label>

        <label className="row tiny" style={{ marginTop: 12 }}>
          <input
            type="checkbox"
            checked={pruneRoster}
            onChange={(e) => setPruneRoster(e.target.checked)}
            style={{ width: 20, height: 20 }}
          />
          Remove people who aren't in this file (treat it as the complete roster)
        </label>

        {rosterPreview && (
          <div style={{ marginTop: 16 }}>
            <h4 className="section-title">Preview — nothing has been applied yet</h4>
            <p className="small muted">
              {rosterPreview.filename}
              {rosterPreview.sheetNames?.length ? ` · ${rosterPreview.sheetNames.join(' + ')} tab` : ''}
              {rosterPreview.sheetNames?.length > 1 ? 's' : ''} · {rosterPreview.validRows} of{' '}
              {rosterPreview.parsedRows} rows valid · {rosterPreview.diff.unchanged} unchanged
            </p>

            {rosterPreview.errors.length > 0 && (
              <div className="banner info" style={{ marginTop: 10 }}>
                <span>
                  {rosterPreview.errors.length} row(s) will be skipped:
                  <ul style={{ margin: '6px 0 0 16px', padding: 0 }}>
                    {rosterPreview.errors.slice(0, 8).map((e) => (
                      // Both tabs have a row 2, so the tab name is what makes
                      // "row 2" mean anything.
                      <li key={`${e.sheet ?? ''}:${e.row}`}>
                        {e.sheet ? `${e.sheet} row ${e.row}` : `Row ${e.row}`}: {e.message}
                      </li>
                    ))}
                    {rosterPreview.errors.length > 8 && (
                      <li>…and {rosterPreview.errors.length - 8} more</li>
                    )}
                  </ul>
                </span>
              </div>
            )}

            <DiffGroup
              title="New teams"
              cls="add"
              items={rosterPreview.diff.createTeams.map((t) => ({ label: t.name }))}
            />
            <DiffGroup
              title="New contact cards"
              cls="add"
              items={rosterPreview.diff.createContacts.map((c) => ({ label: c.name ?? '(unnamed)' }))}
            />
            <DiffGroup
              title="Add people"
              cls="add"
              items={rosterPreview.diff.createPeople.map((p) => ({ label: p.label }))}
            />
            <DiffGroup
              title="Update people"
              cls="mod"
              items={rosterPreview.diff.updatePeople.map((p) => ({
                label: p.label,
                why: p.changes.join('; '),
              }))}
            />
            <DiffGroup
              title="Remove people"
              cls="del"
              items={rosterPreview.diff.deletePeople.map((p) => ({ label: p.label }))}
            />

            <div className="row" style={{ marginTop: 14 }}>
              <button
                className="btn primary"
                disabled={busy || !rosterPreview.diff.hasChanges}
                onClick={commitRoster}
              >
                Apply roster changes
              </button>
              <button className="btn ghost" onClick={() => setRosterPreview(null)}>
                Discard
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <h3>Switching to live sheet sync</h3>
        <p className="small muted">
          The import pipeline is source-agnostic. To go live, set these on the server and restart —
          the upload flow keeps working as a fallback.
        </p>
        <div className="tablewrap" style={{ marginTop: 10 }}>
          <table className="tmpl">
            <tbody>
              <tr>
                <td><code>SCHEDULE_SOURCE=url</code></td>
                <td>Publish the sheet to the web as CSV, then set <code>SCHEDULE_SOURCE_URL</code>.</td>
              </tr>
              <tr>
                <td><code>SCHEDULE_SOURCE=google_sheets</code></td>
                <td>
                  Set <code>GOOGLE_SHEET_ID</code>, <code>GOOGLE_API_KEY</code>, and optionally{' '}
                  <code>GOOGLE_SHEET_RANGE</code>.
                </td>
              </tr>
              <tr>
                <td><code>SYNC_POLL_SECONDS=60</code></td>
                <td>Poll that source automatically and push changes to every open phone.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function DiffGroup({
  title,
  cls,
  items,
}: {
  title: string;
  cls: 'add' | 'mod' | 'del';
  items: { label: string; why?: string }[];
}) {
  if (!items.length) return null;
  return (
    <div className="diff-group">
      <h4 className="section-title">
        {title} ({items.length})
      </h4>
      {items.slice(0, 60).map((item, i) => (
        <div className={`diff-item ${cls}`} key={`${item.label}-${i}`}>
          {item.label}
          {item.why && <div className="why">{item.why}</div>}
        </div>
      ))}
      {items.length > 60 && <p className="tiny faint">…and {items.length - 60} more</p>}
    </div>
  );
}
