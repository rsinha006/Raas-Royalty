import { useEffect, useState } from 'react';
import { api } from '../api';
import { formatDateTime } from '../time';
import type { TemplateColumn } from '../types';

interface OverviewData {
  counts: Record<string, number>;
  updatedAt: string | null;
  sync: {
    activeId: string;
    activeLabel: string;
    kind: string;
    canPull: boolean;
    lastUpload: { filename: string; at: string } | null;
    lastSyncAt: string | null;
    lastSyncSource: string | null;
    pollSeconds: number;
    available: { id: string; label: string; kind: string; configured: boolean }[];
  };
  templates: {
    schedule: { columns: TemplateColumn[] };
    roster: { columns: TemplateColumn[] };
  };
}

export default function Overview({ onGoto }: { onGoto: (tab: 'import' | 'schedule') => void }) {
  const [data, setData] = useState<OverviewData | null>(null);

  useEffect(() => {
    api.get<OverviewData>('/api/admin/overview').then(setData).catch(() => setData(null));
  }, []);

  if (!data) return <div className="loading-screen"><span className="spinner" /></div>;

  const shareUrl = `${window.location.origin}/`;

  return (
    <>
      <div className="card">
        <h3>Event at a glance</h3>
        <p className="tiny faint">Last schedule change: {formatDateTime(data.updatedAt)}</p>
        <div className="stat-grid" style={{ marginTop: 12 }}>
          <div className="stat">
            <div className="n">{data.counts.people}</div>
            <div className="k">People</div>
          </div>
          <div className="stat">
            <div className="n">{data.counts.teams}</div>
            <div className="k">Teams</div>
          </div>
          <div className="stat">
            <div className="n">{data.counts.blocks}</div>
            <div className="k">Blocks</div>
          </div>
          <div className="stat">
            <div className="n">{data.counts.roles}</div>
            <div className="k">Roles</div>
          </div>
          <div className="stat">
            <div className="n">{data.counts.contacts}</div>
            <div className="k">Contacts</div>
          </div>
        </div>
      </div>

      <div className="card">
        <h3>The shared link</h3>
        <p className="small muted">Everyone uses the same URL and picks who they are.</p>
        <div className="row" style={{ marginTop: 10 }}>
          <code style={{ flex: 1, wordBreak: 'break-all' }}>{shareUrl}</code>
          <button
            className="btn sm"
            onClick={() => navigator.clipboard?.writeText(shareUrl)}
          >
            Copy
          </button>
        </div>
      </div>

      <div className="card">
        <h3>Schedule source</h3>
        <div className="list-row">
          <div>
            <div className="label">{data.sync.activeLabel}</div>
            <div className="sub">
              {data.sync.kind === 'pull'
                ? data.sync.pollSeconds
                  ? `Polling every ${data.sync.pollSeconds}s`
                  : 'Pull on demand (polling off)'
                : 'Interim: manual upload'}
            </div>
          </div>
          <button className="btn sm" onClick={() => onGoto('import')}>
            Open
          </button>
        </div>
        <div className="list-row">
          <div>
            <div className="label">Last sync</div>
            <div className="sub">
              {data.sync.lastSyncAt
                ? `${formatDateTime(data.sync.lastSyncAt)} · ${data.sync.lastSyncSource ?? ''}`
                : 'No import yet'}
            </div>
          </div>
        </div>
        <details style={{ marginTop: 10 }}>
          <summary className="tiny faint" style={{ cursor: 'pointer' }}>
            Available sources & how to switch
          </summary>
          <div className="tablewrap" style={{ marginTop: 8 }}>
            <table className="tmpl">
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Mode</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.sync.available.map((s) => (
                  <tr key={s.id}>
                    <td>
                      {s.label}
                      <br />
                      <code>SCHEDULE_SOURCE={s.id}</code>
                    </td>
                    <td>{s.kind}</td>
                    <td>{s.configured ? '✅ configured' : '— needs env vars'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="tiny faint" style={{ marginTop: 8 }}>
            Published-URL sync needs <code>SCHEDULE_SOURCE_URL</code>. Google Sheets API sync needs{' '}
            <code>GOOGLE_SHEET_ID</code> and <code>GOOGLE_API_KEY</code>. Set{' '}
            <code>SYNC_POLL_SECONDS</code> to poll automatically.
          </p>
        </details>
      </div>

      <div className="card">
        <h3>Spreadsheet templates</h3>
        <p className="small muted">Fixed columns. Extra columns are ignored.</p>

        <h4 className="section-title">Schedule</h4>
        <TemplateTable columns={data.templates.schedule.columns} />
        <a className="btn sm" href="/api/admin/templates/schedule.csv" style={{ marginTop: 8, display: 'inline-flex', alignItems: 'center' }}>
          Download schedule template
        </a>

        <h4 className="section-title">Roster</h4>
        <TemplateTable columns={data.templates.roster.columns} />
        <a className="btn sm" href="/api/admin/templates/roster.csv" style={{ marginTop: 8, display: 'inline-flex', alignItems: 'center' }}>
          Download roster template
        </a>
      </div>
    </>
  );
}

function TemplateTable({ columns }: { columns: TemplateColumn[] }) {
  return (
    <div className="tablewrap">
      <table className="tmpl">
        <thead>
          <tr>
            <th>Column</th>
            <th>Required</th>
            <th>Format</th>
          </tr>
        </thead>
        <tbody>
          {columns.map((c) => (
            <tr key={c.name}>
              <td>
                <code>{c.name}</code>
              </td>
              <td>{c.required ? 'Yes' : 'No'}</td>
              <td className="faint">{c.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
