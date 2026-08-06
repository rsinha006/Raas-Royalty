import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useLive, resyncSession } from '../live';
import Overview from './Overview';
import RosterPanel from './RosterPanel';
import SchedulePanel from './SchedulePanel';
import ImportPanel from './ImportPanel';
import LogPanel from './LogPanel';
import CodesPanel from './CodesPanel';

type Tab = 'overview' | 'schedule' | 'roster' | 'codes' | 'import' | 'log';

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'schedule', label: 'Schedule' },
  { id: 'roster', label: 'Roster' },
  { id: 'codes', label: 'Access codes' },
  { id: 'import', label: 'Import & Sync' },
  { id: 'log', label: 'Change log' },
];

interface SessionInfo {
  admin: { name: string } | null;
  defaultPassword: boolean;
}

export default function AdminApp() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(() => setRefreshKey((n) => n + 1), []);

  const loadSession = useCallback(async () => {
    try {
      setSession(await api.get<SessionInfo>('/api/admin/session'));
    } catch {
      setSession({ admin: null, defaultPassword: false });
    }
  }, []);

  useEffect(() => {
    loadSession();
  }, [loadSession]);

  // Keeps two admins working the same event in step with each other.
  const liveStatus = useLive(refresh);

  if (!session) {
    return (
      <div className="loading-screen">
        <span className="spinner" />
      </div>
    );
  }

  // The socket is handed its rooms from the cookie it connected with, so both
  // sides of an admin session change need a fresh handshake: signing in to
  // start hearing every team's edits, signing out to stop.
  if (!session.admin) {
    return (
      <Login
        onSuccess={() => {
          resyncSession();
          loadSession();
        }}
      />
    );
  }

  const logout = async () => {
    await api.post('/api/admin/logout');
    resyncSession();
    loadSession();
  };

  return (
    <div className="admin">
      <header className="topbar" style={{ marginLeft: -16, marginRight: -16 }}>
        <div className="spread">
          <div>
            <div className="topbar-title">Logistics panel</div>
            <div className="topbar-sub row">
              <span className={`status-dot ${liveStatus}`} aria-hidden="true" />
              Signed in as {session.admin.name}
            </div>
          </div>
          <button className="btn sm ghost" onClick={logout}>
            Sign out
          </button>
        </div>
      </header>

      {session.defaultPassword && (
        <div className="banner info" style={{ marginTop: 12 }}>
          <span aria-hidden="true">🔑</span>
          <span>
            Still using the default admin password. Set <code>ADMIN_PASSWORD</code> in the server
            environment before the event.
          </span>
        </div>
      )}

      <nav className="admin-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            className="admin-tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div style={{ paddingTop: 14 }}>
        {tab === 'overview' && <Overview key={refreshKey} onGoto={setTab} />}
        {tab === 'schedule' && <SchedulePanel key={refreshKey} onChanged={refresh} />}
        {tab === 'roster' && <RosterPanel key={refreshKey} onChanged={refresh} />}
        {tab === 'codes' && <CodesPanel key={refreshKey} />}
        {tab === 'import' && <ImportPanel onChanged={refresh} />}
        {tab === 'log' && <LogPanel key={refreshKey} />}
      </div>
    </div>
  );
}

function Login({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/admin/login', { password, name });
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="landing">
      <div className="crown">♛</div>
      <h1 style={{ fontSize: 26 }}>Logistics panel</h1>
      <p className="landing-sub">Shared admin password. Your name is recorded on every change.</p>
      <form onSubmit={submit} className="stack">
        <div className="field">
          <label htmlFor="admin-name">Your name</label>
          <input
            id="admin-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Marcus"
            autoComplete="name"
          />
        </div>
        <div className="field">
          <label htmlFor="admin-pass">Admin password</label>
          <input
            id="admin-pass"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </div>
        {error && <div className="banner offline">{error}</div>}
        <button className="btn primary block-w" disabled={busy || !password}>
          {busy ? 'Checking…' : 'Sign in'}
        </button>
      </form>
      <p className="tiny faint" style={{ marginTop: 20 }}>
        <a href="/">← Back to the schedule view</a>
      </p>
    </div>
  );
}
