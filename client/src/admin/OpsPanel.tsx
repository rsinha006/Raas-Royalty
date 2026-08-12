import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { formatDateTime } from '../time';
import Loading from '../Loading';

/**
 * Ops — item 23's half of the panel.
 *
 * The audience for this screen is one person, on the Saturday, who has been
 * told something is wrong and has no terminal. So it answers three questions in
 * that order: *is there a recent copy of the event*, *has anything been
 * failing*, and *does the thing that pages us actually work*. Anything that
 * needs `fly ssh` is out of scope here and lives in docs/ops.md.
 */

interface Snapshot {
  name: string;
  bytes: number;
  modified: string;
}

interface OpsData {
  backups: {
    enabled: boolean;
    intervalMs: number;
    dir: string;
    offBox: 'http' | 'command' | null;
    count: number;
    totalBytes: number;
    ageSeconds: number | null;
    verifiedAgeSeconds: number | null;
    stale: boolean;
    lastError: string | null;
    lastShippedAt: string | null;
    consecutiveFailures: number;
  };
  snapshots: Snapshot[];
  errors: {
    total: number;
    byScope: Record<string, number>;
    logPath: string;
    recent: { at: string; scope: string; message: string; path?: string }[];
  };
  alerts: {
    configured: boolean;
    sent: number;
    suppressed: number;
    last: { at: string; title: string; level: string } | null;
    lastError: { at: string; message: string } | null;
  };
  heartbeat: {
    configured: boolean;
    intervalMs: number;
    lastOkAt: string | null;
    lastError: string | null;
    failures: number;
  };
  uptimeSeconds: number;
  startedAt: string;
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/** "every 15s" / "every 5 min" — an interval under a minute rounded to minutes reads as 0. */
function every(ms: number): string {
  return ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)} min`;
}

function ago(seconds: number | null): string {
  if (seconds === null) return 'never';
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

export default function OpsPanel() {
  const [data, setData] = useState<OpsData | null>(null);
  const [busy, setBusy] = useState<'backup' | 'alert' | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'bad'; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get<OpsData>('/api/admin/ops'));
    } catch {
      setData(null);
    }
  }, []);

  useEffect(() => {
    load();
    // Slow on purpose: nothing here changes faster than the snapshot interval,
    // and this screen is often the one left open on a laptop all weekend.
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  if (!data) return <Loading label="Loading ops…" />;

  const { backups, errors, alerts, heartbeat } = data;

  const takeBackup = async () => {
    setBusy('backup');
    setNotice(null);
    try {
      const r = await api.post<{ unchanged: boolean; name: string; counts: { blocks: number } }>(
        '/api/admin/ops/backup',
      );
      setNotice({
        kind: 'ok',
        text: r.unchanged
          ? 'Nothing has changed since the last snapshot, so that one still stands.'
          : `Verified snapshot taken: ${r.name} (${r.counts.blocks} blocks).`,
      });
      load();
    } catch (e) {
      setNotice({ kind: 'bad', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const testAlert = async () => {
    setBusy('alert');
    setNotice(null);
    try {
      await api.post('/api/admin/ops/test-alert');
      setNotice({ kind: 'ok', text: 'Sent. Check that it arrived where the on-call person is.' });
      load();
    } catch (e) {
      setNotice({ kind: 'bad', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {notice && (
        <div className={`banner ${notice.kind === 'ok' ? 'good' : 'offline'}`} role="status">
          <span aria-hidden="true">{notice.kind === 'ok' ? '✅' : '⚠️'}</span>
          <span>{notice.text}</span>
        </div>
      )}

      <div className="card">
        <h3>Backups</h3>
        <p className="small muted">
          The event database is the one thing here that cannot be rebuilt from anything else. Each
          snapshot is re-opened and checked before it is kept, so a copy that appears in this list
          has been read back at least once.
        </p>

        <div className="list-row">
          <div>
            <div className="label">
              {backups.enabled
                ? `Last checked ${ago(backups.verifiedAgeSeconds)}`
                : 'Snapshots are off'}
            </div>
            <div className="sub">
              {backups.enabled
                ? `Every ${every(backups.intervalMs)} · newest copy ${ago(backups.ageSeconds)} · ` +
                  `${backups.count} kept · ${mb(backups.totalBytes)}`
                : 'Set BACKUP_INTERVAL_MS to turn them on.'}
            </div>
          </div>
          <button className="btn sm" onClick={takeBackup} disabled={busy !== null}>
            {busy === 'backup' ? 'Taking…' : 'Take one now'}
          </button>
        </div>

        {backups.stale && (
          <div className="banner info" style={{ marginTop: 10 }} role="status">
            <span aria-hidden="true">⚠️</span>
            <span>
              No verified snapshot recently
              {backups.lastError ? `: ${backups.lastError}` : '.'} The schedule is still being
              served — this is about what happens if the machine is lost.
            </span>
          </div>
        )}

        {!backups.offBox && backups.enabled && (
          <div className="banner info" style={{ marginTop: 10 }}>
            <span aria-hidden="true">⚠️</span>
            <span>
              Snapshots are being kept on the same volume as the database they copy. That covers a
              bad import; it does not cover losing the machine. Set <code>BACKUP_TARGET_URL</code>{' '}
              or <code>BACKUP_TARGET_CMD</code> — see <code>docs/ops.md</code>.
            </span>
          </div>
        )}

        {backups.offBox && (
          <p className="tiny faint" style={{ marginTop: 8 }}>
            Off-box via {backups.offBox}. Last shipped: {formatDateTime(backups.lastShippedAt)}.
          </p>
        )}

        {data.snapshots.length > 0 && (
          <details style={{ marginTop: 10 }}>
            <summary className="tiny faint" style={{ cursor: 'pointer' }}>
              {data.snapshots.length} most recent snapshot{data.snapshots.length === 1 ? '' : 's'}
            </summary>
            <div className="tablewrap" style={{ marginTop: 8 }}>
              <table className="tmpl">
                <thead>
                  <tr>
                    <th>Taken</th>
                    <th>Size</th>
                    <th>Download</th>
                  </tr>
                </thead>
                <tbody>
                  {data.snapshots.map((s) => (
                    <tr key={s.name}>
                      <td>{formatDateTime(s.modified)}</td>
                      <td>{mb(s.bytes)}</td>
                      <td>
                        <a className="btn sm ghost" href={`/api/admin/ops/snapshots/${s.name}`}>
                          Get a copy
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="tiny faint" style={{ marginTop: 8 }}>
              A downloaded snapshot is the whole event, access codes included. Restoring one is{' '}
              <code>npm run restore</code> with the server stopped — the procedure is in{' '}
              <code>docs/ops.md</code>.
            </p>
          </details>
        )}
      </div>

      <div className="card">
        <h3>Alerting</h3>
        <p className="small muted">
          Nobody will be reading server logs during the event, so the point of this section is that
          something reaches a phone. The heartbeat is the one that matters: a machine that has
          stopped cannot report anything about itself, so the alarm has to come from whatever
          notices the pings stopping.
        </p>

        <div className="list-row">
          <div>
            <div className="label">
              Heartbeat {heartbeat.configured ? 'configured' : 'not configured'}
            </div>
            <div className="sub">
              {heartbeat.configured
                ? heartbeat.lastOkAt
                  ? `Last acknowledged ${formatDateTime(heartbeat.lastOkAt)}`
                  : `No successful ping yet${heartbeat.lastError ? ` — ${heartbeat.lastError}` : ''}`
                : 'Set HEARTBEAT_URL to an uptime check that sends SMS when the pings stop.'}
            </div>
          </div>
        </div>

        <div className="list-row">
          <div>
            <div className="label">Error alerts {alerts.configured ? 'configured' : 'not configured'}</div>
            <div className="sub">
              {alerts.configured
                ? `${alerts.sent} sent, ${alerts.suppressed} suppressed as duplicates` +
                  (alerts.last ? ` · last: ${alerts.last.title}` : '')
                : 'Set ALERT_WEBHOOK_URL to a Slack or Discord webhook.'}
            </div>
          </div>
          <button className="btn sm" onClick={testAlert} disabled={busy !== null || !alerts.configured}>
            {busy === 'alert' ? 'Sending…' : 'Send a test'}
          </button>
        </div>

        {alerts.lastError && (
          <p className="tiny faint" style={{ marginTop: 8 }}>
            The last alert could not be delivered ({alerts.lastError.message}). A failing alert
            channel is never announced through the alert channel — that is what the heartbeat is
            for.
          </p>
        )}
      </div>

      <div className="card">
        <h3>Errors</h3>
        <p className="small muted">
          Server faults since this process started {formatDateTime(data.startedAt)}. They are also
          appended to <code>{errors.logPath}</code>, which survives a restart.
        </p>

        {errors.recent.length === 0 ? (
          <div className="list-row">
            <div>
              <div className="label">Nothing recorded</div>
              <div className="sub">No 500s, no unhandled errors.</div>
            </div>
          </div>
        ) : (
          <>
            <p className="tiny faint">
              {errors.total} total ·{' '}
              {Object.entries(errors.byScope)
                .map(([k, n]) => `${k}: ${n}`)
                .join(' · ')}
            </p>
            <ul className="plainlist" style={{ marginTop: 8 }}>
              {errors.recent.map((e, i) => (
                <li key={`${e.at}-${i}`} className="list-row">
                  <div>
                    <div className="label">{e.message}</div>
                    <div className="sub">
                      {formatDateTime(e.at)} · {e.scope}
                      {e.path ? ` · ${e.path}` : ''}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </>
  );
}
