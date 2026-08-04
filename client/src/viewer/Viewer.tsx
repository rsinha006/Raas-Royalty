import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { clearSession, loadSession, saveSession } from '../session';
import type { Bootstrap, StoredSession } from '../types';
import Landing from './Landing';
import ScheduleScreen from './ScheduleScreen';

const BOOTSTRAP_CACHE = 'royalty.bootstrap.v1';

export default function Viewer() {
  const [session, setSession] = useState<StoredSession | null>(() => loadSession());
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);

  const fetchBootstrap = useCallback(async () => {
    try {
      const data = await api.get<Bootstrap>('/api/bootstrap');
      setBootstrap(data);
      setBootError(null);
      try {
        localStorage.setItem(BOOTSTRAP_CACHE, JSON.stringify(data));
      } catch {
        /* ignore quota */
      }
    } catch {
      // The roster is small and rarely changes — a cached copy is enough to let
      // someone identify themselves on a dead connection.
      try {
        const cached = localStorage.getItem(BOOTSTRAP_CACHE);
        if (cached) {
          setBootstrap(JSON.parse(cached) as Bootstrap);
          return;
        }
      } catch {
        /* ignore */
      }
      setBootError("Can't reach the event server. Check your connection and try again.");
    }
  }, []);

  // Only needed when nobody is selected yet; a returning user goes straight
  // to their schedule.
  useEffect(() => {
    if (!session) fetchBootstrap();
  }, [session, fetchBootstrap]);

  const handleSelect = (next: StoredSession) => {
    saveSession(next);
    setSession(next);
  };

  const handleSwitch = () => {
    clearSession();
    setSession(null);
    setBootstrap(null);
    fetchBootstrap();
  };

  if (session) return <ScheduleScreen session={session} onSwitch={handleSwitch} />;

  if (bootError) {
    return (
      <div className="landing">
        <div className="crown">♛</div>
        <h1 style={{ fontSize: 24 }}>Offline</h1>
        <p className="landing-sub">{bootError}</p>
        <button className="btn primary block-w" onClick={fetchBootstrap}>
          Try again
        </button>
      </div>
    );
  }

  if (!bootstrap) {
    return (
      <div className="loading-screen">
        <span className="spinner" />
        <span>Loading the roster…</span>
      </div>
    );
  }

  return <Landing bootstrap={bootstrap} onSelect={handleSelect} />;
}
