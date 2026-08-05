import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { clearSession, loadSession } from '../session';
import type { Bootstrap, StoredSession } from '../types';
import ScheduleScreen from './ScheduleScreen';

const BOOTSTRAP_CACHE = 'royalty.bootstrap.v1';

/**
 * Sessions used to be a locally-stored "I picked this team" with no server
 * involvement. They are now issued by the server against an access code, so any
 * pre-existing selection is meaningless and its schedule requests would 401.
 * Drop it once, on load, rather than letting a returning visitor land on an
 * error screen they cannot get out of.
 */
function discardPreCodeSession(): StoredSession | null {
  const stored = loadSession();
  if (!stored) return null;
  clearSession();
  try {
    localStorage.removeItem(BOOTSTRAP_CACHE);
  } catch {
    /* ignore */
  }
  return null;
}

export default function Viewer() {
  const [session, setSession] = useState<StoredSession | null>(discardPreCodeSession);
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
        <span>Loading…</span>
      </div>
    );
  }

  // Placeholder, not the finished screen. The server now requires an access
  // code for every schedule read, and the code-entry and magic-link flow that
  // replaces the old role picker is the next piece of work. Deliberately says
  // nothing about who is on the roster.
  return (
    <div className="landing">
      <div className="crown">♛</div>
      <h1>{bootstrap.eventName}</h1>
      <p className="landing-sub">
        Schedules are private to each team and staff member. Open the personal
        link you were sent to see yours.
      </p>
      <p className="landing-sub" style={{ opacity: 0.7, fontSize: 13 }}>
        Lost your link? Ask at the check-in desk.
      </p>
    </div>
  );
}
