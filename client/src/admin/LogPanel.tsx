import { useEffect, useState } from 'react';
import { api } from '../api';
import { formatDateTime } from '../time';
import type { EditLogEntry } from '../types';

const SOURCE_LABEL: Record<string, string> = {
  admin: 'manual edit',
  import: 'spreadsheet import',
  sheet: 'synced from sheet',
  seed: 'placeholder data',
};

export default function LogPanel() {
  const [entries, setEntries] = useState<EditLogEntry[] | null>(null);

  useEffect(() => {
    api
      .get<{ entries: EditLogEntry[] }>('/api/admin/log')
      .then((d) => setEntries(d.entries))
      .catch(() => setEntries([]));
  }, []);

  if (!entries) return <div className="loading-screen"><span className="spinner" /></div>;

  return (
    <div className="card">
      <h3>Change log</h3>
      <p className="small muted">
        Every change — manual or synced — with who made it and who it affected.
      </p>
      {entries.length === 0 && <p className="muted small" style={{ marginTop: 12 }}>Nothing logged yet.</p>}
      <div style={{ marginTop: 8 }}>
        {entries.map((e) => (
          <div className="log-entry" key={e.id}>
            <div>{e.summary}</div>
            <div className="meta">
              {formatDateTime(e.timestamp)} · {e.editedBy} · {SOURCE_LABEL[e.source] ?? e.source}
              {e.audience?.personIds?.length
                ? ` · affects ${e.audience.personIds.length} ${
                    e.audience.personIds.length === 1 ? 'person' : 'people'
                  }`
                : ''}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
