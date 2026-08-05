import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { TeamMember } from '../types';

/**
 * "Which dancer are you?", shown once after a team code is redeemed.
 *
 * A team code alone cannot deliver a personal schedule, because the server has
 * no idea which of a team's 25 dancers is holding the phone — so airport
 * pickups and captain-only blocks would reach nobody. This step is what turns a
 * team session into a person session.
 *
 * It is not a security boundary and is not presented as one: anyone with the
 * team's code can pick any name on that team. That is already what sharing a
 * team code means.
 */
export default function IdentityPicker({
  teamName,
  onPicked,
  onUseDifferentCode,
}: {
  teamName: string;
  onPicked: () => void;
  onUseDifferentCode: () => void;
}) {
  const [people, setPeople] = useState<TeamMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [picking, setPicking] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .get<{ people: TeamMember[] }>('/api/session/roster')
      .then((d) => live && setPeople(d.people))
      .catch(() => live && setError("Couldn't load your team list. Check your connection."));
    return () => {
      live = false;
    };
  }, []);

  const shown = useMemo(() => {
    if (!people) return [];
    const q = filter.trim().toLowerCase();
    return q ? people.filter((p) => p.name.toLowerCase().includes(q)) : people;
  }, [people, filter]);

  const pick = async (id: string) => {
    setPicking(id);
    try {
      await api.post('/api/session/identify', { personId: id });
      onPicked();
    } catch {
      setError('That did not work. Try again.');
      setPicking(null);
    }
  };

  if (error && !people) {
    return (
      <div className="landing">
        <h1 style={{ fontSize: 24 }}>{teamName}</h1>
        <p className="landing-sub">{error}</p>
        <button className="btn primary block-w" onClick={() => window.location.reload()}>
          Try again
        </button>
        <button className="btn ghost block-w" onClick={onUseDifferentCode}>
          Use a different code
        </button>
      </div>
    );
  }

  if (!people) {
    return (
      <div className="loading-screen">
        <span className="spinner" />
        <span>Loading your team…</span>
      </div>
    );
  }

  return (
    <div className="landing" style={{ justifyContent: 'flex-start', paddingTop: 32 }}>
      <div className="crown">♛</div>
      <h1 style={{ fontSize: 26 }}>{teamName}</h1>
      <p className="landing-sub">
        Which one are you? Some things — airport pickups, captain meetings — are
        scheduled per person.
      </p>

      {people.length > 12 && (
        <input
          className="input"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search your name"
          aria-label="Search your name"
          autoCorrect="off"
          spellCheck={false}
        />
      )}

      {error && (
        <p className="tiny" style={{ color: 'var(--danger, #f87171)' }} role="alert">
          {error}
        </p>
      )}

      <div className="stack" style={{ width: '100%', marginTop: 8 }}>
        {shown.map((p) => (
          <button
            key={p.id}
            className="btn block-w"
            onClick={() => pick(p.id)}
            disabled={picking !== null}
            style={{ justifyContent: 'flex-start' }}
          >
            {picking === p.id ? 'Opening…' : p.name}
          </button>
        ))}
        {!shown.length && <div className="empty-day">No names match “{filter}”.</div>}
      </div>

      <button className="btn ghost block-w" onClick={onUseDifferentCode} style={{ marginTop: 20 }}>
        Use a different code
      </button>
    </div>
  );
}
