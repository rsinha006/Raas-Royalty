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

/** Item 28's half: the pack that gets printed, and whether it covers everybody. */
interface CallSheetSummary {
  generatedAt: string;
  onCall: { name: string | null; phone: string | null; set: boolean };
  coverage: {
    sheets: number;
    people: number;
    placed: number;
    unplaced: { name: string; why: string }[];
    unprinted: { day: string; time: string; activity: string; target: string }[];
    withoutCode: number;
  };
}

/** Item 26: who is connected, and what their screen is holding. */
interface Presence {
  at: string;
  phones: {
    id: string;
    subjectType: string;
    subjectId: string;
    label: string;
    connectedAt: string;
    held: string | null;
    current: string | null;
    state: 'current' | 'stale' | 'silent';
    reportedSecondsAgo: number | null;
  }[];
  teamsPresent: string[];
  counts: {
    phones: number;
    current: number;
    stale: number;
    silent: number;
    panels: number;
    anonymous: number;
  };
}

/** Item 26: the same report `npm run rehearsal` prints. */
interface Readiness {
  at: string;
  baseUrl: string;
  checks: {
    key: string;
    level: 'blocker' | 'warn' | 'ok';
    title: string;
    detail: string | null;
    fix: string | null;
    items: string[];
  }[];
  blockers: number;
  warnings: number;
  ready: boolean;
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
  const [paper, setPaper] = useState<CallSheetSummary | null>(null);
  const [presence, setPresence] = useState<Presence | null>(null);
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [busy, setBusy] = useState<'backup' | 'alert' | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'bad'; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get<OpsData>('/api/admin/ops'));
    } catch {
      setData(null);
    }
    try {
      setPaper(await api.get<CallSheetSummary>('/api/admin/call-sheets/summary'));
    } catch {
      setPaper(null);
    }
    try {
      setReadiness(await api.get<Readiness>('/api/admin/ops/readiness'));
    } catch {
      setReadiness(null);
    }
  }, []);

  useEffect(() => {
    load();
    // Slow on purpose: nothing here changes faster than the snapshot interval,
    // and this screen is often the one left open on a laptop all weekend.
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  /**
   * Presence polls far faster than the rest, because it is read during the one
   * step where somebody has just pressed Save and is watching to see whether
   * fifteen phones follow. A minute of lag there is the difference between an
   * answer and a shrug.
   */
  useEffect(() => {
    const pull = () =>
      api
        .get<Presence>('/api/admin/ops/presence')
        .then(setPresence)
        .catch(() => setPresence(null));
    pull();
    const t = setInterval(pull, 5_000);
    return () => clearInterval(t);
  }, []);

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

      {/* Item 26. The rehearsal's central question — "did every phone get
          that?" — otherwise gets answered by asking fifteen people, and a phone
          quietly holding a twenty-minute-old time answers yes. */}
      <div className="card">
        <h3>Phones connected</h3>
        <p className="small muted">
          What each connected screen is currently showing, compared against what that person’s own
          schedule says it should be. Press Save on a change and watch this go green — a phone that
          stays behind is one nobody in the room can spot, because a stale schedule looks exactly
          like a correct one.
        </p>

        {!presence ? (
          <div className="list-row">
            <div>
              <div className="label">Not available</div>
              <div className="sub">The panel could not reach the live channel.</div>
            </div>
          </div>
        ) : (
          <>
            <div className="list-row">
              <div>
                <div className="label">
                  {presence.counts.phones === 0
                    ? 'No phones connected'
                    : `${presence.counts.current} of ${presence.counts.phones} up to date`}
                </div>
                <div className="sub">
                  {presence.counts.stale > 0 && `${presence.counts.stale} behind · `}
                  {presence.counts.silent > 0 && `${presence.counts.silent} not reporting · `}
                  {presence.teamsPresent.length} team
                  {presence.teamsPresent.length === 1 ? '' : 's'} represented ·{' '}
                  {presence.counts.panels} panel{presence.counts.panels === 1 ? '' : 's'}
                </div>
              </div>
            </div>

            {presence.counts.phones > 0 && (
              <div className="tablewrap" style={{ marginTop: 8 }}>
                <table className="tmpl">
                  <thead>
                    <tr>
                      <th>Who</th>
                      <th>Showing</th>
                      <th>Reported</th>
                    </tr>
                  </thead>
                  <tbody>
                    {presence.phones.map((p) => (
                      <tr key={p.id}>
                        <td>{p.label}</td>
                        <td>
                          {p.state === 'current'
                            ? 'up to date'
                            : p.state === 'stale'
                              ? `behind — showing ${formatDateTime(p.held)}`
                              : 'has not reported yet'}
                        </td>
                        <td>
                          {p.reportedSecondsAgo === null ? '—' : ago(p.reportedSecondsAgo)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <p className="tiny faint" style={{ marginTop: 8 }}>
              Nothing here is stored — it is the sockets that are open right now, and it starts
              empty after a restart. A phone with the app closed does not appear at all, which is
              the normal state for most of the weekend.
            </p>
          </>
        )}
      </div>

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

      {/* Item 28. Everything above assumes the app comes back. This is the page
          for when it does not: print it before the doors open, because a
          printer is the one thing a venue never has when it is needed. */}
      <div className="card">
        <h3>Printed fallback</h3>
        <p className="small muted">
          One sheet per team and per staff role, built from the same query the phones run — so
          paper and screen cannot disagree about who is where. Print it before the event: if the
          app is down at 1pm Saturday, this is the schedule.
        </p>

        <div className="list-row">
          <div>
            <div className="label">
              {paper
                ? `${paper.coverage.sheets} sheets · ${paper.coverage.placed} of ${paper.coverage.people} people`
                : 'Call sheets'}
            </div>
            <div className="sub">
              Every block is stamped with the time it was printed, and says the phone wins.
            </div>
          </div>
          <div className="row">
            <a className="btn sm" href="/api/admin/call-sheets?scope=handout" target="_blank" rel="noreferrer">
              Print the pack
            </a>
            <a
              className="btn sm ghost"
              href="/api/admin/call-sheets?scope=desk"
              target="_blank"
              rel="noreferrer"
            >
              Print the desk index
            </a>
          </div>
        </div>

        <p className="tiny faint" style={{ marginTop: 8 }}>
          ⚠️ The desk index lists live access codes, which are passwords in a link. It stays behind
          the check-in desk; the pack is the one that gets handed out.
        </p>

        {paper && !paper.onCall.set && (
          <div className="banner info" style={{ marginTop: 10 }}>
            <span aria-hidden="true">⚠️</span>
            <span>
              Nobody is named as on call for the app — the desk sheet prints a blank line where the
              number should be. Set <code>ON_CALL_NAME</code> and <code>ON_CALL_PHONE</code>, and
              not to somebody who is also running a camera.
            </span>
          </div>
        )}

        {paper && paper.coverage.unplaced.length > 0 && (
          <div className="banner info" style={{ marginTop: 10 }}>
            <span aria-hidden="true">⚠️</span>
            <span>
              {paper.coverage.unplaced.length} on the roster reach no sheet at all:{' '}
              {paper.coverage.unplaced.map((p) => p.name).join(', ')}. They are on no team and hold
              no role, so nothing knows where to print them.
            </span>
          </div>
        )}

        {paper && paper.coverage.unprinted.length > 0 && (
          <div className="banner info" style={{ marginTop: 10 }}>
            <span aria-hidden="true">⚠️</span>
            <span>
              {paper.coverage.unprinted.length} block
              {paper.coverage.unprinted.length === 1 ? '' : 's'} appear on no sheet — usually a role
              nobody holds. First:{' '}
              <em>
                {paper.coverage.unprinted[0].activity} → {paper.coverage.unprinted[0].target}
              </em>
              . These reach no phone either.
            </span>
          </div>
        )}

        {paper && paper.coverage.withoutCode > 0 && (
          <p className="tiny faint" style={{ marginTop: 8 }}>
            {paper.coverage.withoutCode} on the roster have no live access code and cannot open the
            app at all. The desk index names them; issue codes in <strong>Access codes</strong>.
          </p>
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

      {/* Item 26. Read before the rehearsal and again at the freeze: a green
          rehearsal against the placeholder looks identical to a green one
          against the weekend. */}
      {readiness && (
        <div className="card">
          <h3>Event readiness</h3>
          <p className="small muted">
            Whether a rehearsal now would mean anything. The seed data passes every test this app
            has — dates that have already happened, nobody real on the roster, and two empty days
            all render as a perfectly ordinary schedule. Same report as{' '}
            <code>npm run rehearsal</code>.
          </p>

          <div className="list-row">
            <div>
              <div className="label">
                {readiness.ready
                  ? readiness.warnings
                    ? `Ready, with ${readiness.warnings} gap${readiness.warnings === 1 ? '' : 's'}`
                    : 'Ready'
                  : `${readiness.blockers} blocker${readiness.blockers === 1 ? '' : 's'}`}
              </div>
              <div className="sub">
                {readiness.ready
                  ? 'The rehearsal can run against this data.'
                  : 'A rehearsal now would be a rehearsal of the placeholder.'}
              </div>
            </div>
          </div>

          <ul className="plainlist" style={{ marginTop: 8 }}>
            {readiness.checks.map((c) => (
              <li key={c.key} className="list-row">
                <div>
                  <div className="label">
                    <span aria-hidden="true">
                      {c.level === 'blocker' ? '✗' : c.level === 'warn' ? '!' : '✓'}
                    </span>{' '}
                    <span className="vh">
                      {c.level === 'blocker' ? 'Blocker: ' : c.level === 'warn' ? 'Warning: ' : 'Passing: '}
                    </span>
                    {c.title}
                  </div>
                  {c.detail && <div className="sub">{c.detail}</div>}
                  {c.items.slice(0, 4).map((item) => (
                    <div className="sub" key={item}>
                      · {item}
                    </div>
                  ))}
                  {c.items.length > 4 && (
                    <div className="sub">· …and {c.items.length - 4} more.</div>
                  )}
                  {c.fix && (
                    <div className="tiny faint">
                      Fix: <code>{c.fix}</code>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>

          <p className="tiny faint" style={{ marginTop: 8 }}>
            The rehearsal itself is <code>docs/dress-rehearsal.md</code> — the script, and the list
            of things to break on purpose.
          </p>
        </div>
      )}

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
