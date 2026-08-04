import { useMemo, useState } from 'react';
import type { Bootstrap, Role, StoredSession } from '../types';

/**
 * Step 1: which role are you. Step 2: which team (dancers) or which name
 * (everyone else). No passwords, no self-registration — you can only pick a
 * name that logistics already loaded.
 */
export default function Landing({
  bootstrap,
  onSelect,
}: {
  bootstrap: Bootstrap;
  onSelect: (session: StoredSession) => void;
}) {
  const [role, setRole] = useState<Role | null>(null);
  const [query, setQuery] = useState('');

  const options = useMemo(() => {
    if (!role) return [];
    if (role.selector === 'team') {
      return bootstrap.teams.map((t) => ({
        id: t.id,
        label: t.name,
        sub: `${t.memberCount} ${t.memberCount === 1 ? 'dancer' : 'dancers'}`,
      }));
    }
    return bootstrap.people
      .filter((p) => p.roleId === role.id)
      .map((p) => ({ id: p.id, label: p.name, sub: role.label }));
  }, [role, bootstrap]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query]);

  if (!role) {
    return (
      <div className="landing">
        <div className="crown">♛</div>
        <h1>{bootstrap.eventName}</h1>
        <p className="landing-sub">
          Pick your role to see your own schedule. It updates on its own — no refreshing.
        </p>
        <div className="stack">
          {bootstrap.roles.map((r) => (
            <button
              key={r.id}
              className="choice"
              onClick={() => {
                setRole(r);
                setQuery('');
              }}
            >
              <span>
                {r.label}
                {r.blurb && <span className="sub">{r.blurb}</span>}
              </span>
              <span className="chev" aria-hidden="true">
                ›
              </span>
            </button>
          ))}
        </div>
        <p className="tiny faint" style={{ marginTop: 28 }}>
          Not listed? Ask logistics to add you — the roster is managed centrally.
        </p>
      </div>
    );
  }

  const isTeam = role.selector === 'team';

  return (
    <div className="landing">
      <button className="backlink" onClick={() => setRole(null)}>
        ‹ Back to roles
      </button>
      <h1 style={{ fontSize: 26 }}>{isTeam ? 'Find your team' : 'Find your name'}</h1>
      <p className="landing-sub" style={{ marginBottom: 16 }}>
        {role.label}
      </p>

      <input
        className="search"
        type="search"
        inputMode="search"
        autoComplete="off"
        placeholder={isTeam ? 'Search teams…' : 'Search names…'}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      <div className="scroll-list">
        <div className="stack">
          {filtered.map((o) => (
            <button
              key={o.id}
              className="choice"
              onClick={() =>
                onSelect({
                  type: isTeam ? 'team' : 'person',
                  id: o.id,
                  roleId: role.id,
                  label: o.label,
                })
              }
            >
              <span>
                {o.label}
                <span className="sub">{o.sub}</span>
              </span>
              <span className="chev" aria-hidden="true">
                ›
              </span>
            </button>
          ))}
          {!filtered.length && (
            <div className="empty-day">
              {options.length
                ? `No ${isTeam ? 'teams' : 'names'} match “${query}”.`
                : `No ${isTeam ? 'teams' : 'names'} loaded for ${role.label} yet.`}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
