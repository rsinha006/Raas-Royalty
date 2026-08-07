import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api';
import type { Contact, Person, Role, Team } from '../types';

interface RosterData {
  roles: Role[];
  teams: Team[];
  people: Person[];
  contacts: Contact[];
}

type Section = 'people' | 'teams' | 'contacts' | 'roles';

export default function RosterPanel({
  refreshKey,
  onChanged,
}: {
  /** Bumped by a live event from another admin. Reloads without remounting. */
  refreshKey: number;
  onChanged: () => void;
}) {
  const [data, setData] = useState<RosterData | null>(null);
  const [section, setSection] = useState<Section>('people');
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setData(await api.get<RosterData>('/api/admin/roster'));
  };

  useEffect(() => {
    load().catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const mutate = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That change did not save');
    }
  };

  /**
   * Deleting someone who still has schedule blocks comes back as a 409 with the
   * count, rather than quietly leaving blocks pointing at nobody. Ask again
   * naming the number — it is the fact that decides the answer, and it is only
   * known at the moment of deletion, not from whatever the page loaded with.
   */
  const removeSubject = (path: string, subjectLabel: string) =>
    mutate(async () => {
      try {
        return await api.del(path);
      } catch (e) {
        const payload =
          e instanceof ApiError && e.status === 409
            ? (e.payload as { blockCount?: number } | null)
            : null;
        if (!payload?.blockCount) throw e;
        const ok = window.confirm(
          `${subjectLabel} still has ${payload.blockCount} schedule block(s).\n\n` +
            'Delete those blocks too? Anyone who could see them loses them immediately.\n\n' +
            'Cancel to keep everything and reassign the blocks first.'
        );
        if (!ok) return null;
        return await api.del(`${path}?removeBlocks=1`);
      }
    });

  if (!data) return <div className="loading-screen"><span className="spinner" /></div>;

  return (
    <>
      {error && <div className="banner offline" style={{ marginBottom: 12 }}>{error}</div>}

      <nav className="admin-tabs" style={{ position: 'static', borderBottom: 0, paddingTop: 0 }}>
        {(['people', 'teams', 'contacts', 'roles'] as Section[]).map((s) => (
          <button
            key={s}
            className="admin-tab"
            aria-selected={section === s}
            onClick={() => setSection(s)}
          >
            {s[0].toUpperCase() + s.slice(1)} (
            {s === 'people'
              ? data.people.length
              : s === 'teams'
                ? data.teams.length
                : s === 'contacts'
                  ? data.contacts.length
                  : data.roles.length}
            )
          </button>
        ))}
      </nav>

      {section === 'people' && <People data={data} mutate={mutate} remove={removeSubject} />}
      {section === 'teams' && <Teams data={data} mutate={mutate} remove={removeSubject} />}
      {section === 'contacts' && <Contacts data={data} mutate={mutate} />}
      {section === 'roles' && <Roles data={data} mutate={mutate} />}
    </>
  );
}

type Mutate = (fn: () => Promise<unknown>) => Promise<void>;
/** Delete a person or team, re-asking if schedule blocks would be orphaned. */
type Remove = (path: string, subjectLabel: string) => Promise<void>;

/* ------------------------------ people ------------------------------ */

/**
 * Roles are a set, so the editor is checkboxes rather than a dropdown. Almost
 * everyone holds exactly one; the case this exists for is captains, who hold
 * Dancer + Captain so the three captain-only blocks can be role-targeted.
 */
function RolePicker({
  roles,
  selected,
  onChange,
}: {
  roles: Role[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((r) => r !== id) : [...selected, id]);

  return (
    <div className="field">
      <label>Roles</label>
      <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
        {roles.map((r) => (
          <label key={r.id} className="small row" style={{ gap: 6, whiteSpace: 'nowrap' }}>
            <input type="checkbox" checked={selected.includes(r.id)} onChange={() => toggle(r.id)} />
            {r.label}
          </label>
        ))}
      </div>
      {!selected.length && <p className="tiny faint">Pick at least one.</p>}
    </div>
  );
}

function People({ data, mutate, remove }: { data: RosterData; mutate: Mutate; remove: Remove }) {
  const [query, setQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<{
    name: string;
    roleIds: string[];
    teamId: string;
    contactId: string;
  }>({ name: '', roleIds: [], teamId: '', contactId: '' });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return data.people
      .filter((p) => !roleFilter || p.roleIds.includes(roleFilter))
      .filter((p) => !q || p.name.toLowerCase().includes(q) || (p.teamName ?? '').toLowerCase().includes(q))
      .slice(0, 200);
  }, [data.people, query, roleFilter]);

  return (
    <>
      <div className="card">
        <div className="row" style={{ marginBottom: 10 }}>
          <input
            className="search"
            style={{ marginBottom: 0 }}
            placeholder="Search people…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button className="btn primary" onClick={() => setAdding((v) => !v)}>
            {adding ? 'Close' : '+ Add'}
          </button>
        </div>

        <select
          className="search"
          style={{ marginBottom: 0 }}
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value)}
        >
          <option value="">All roles</option>
          {data.roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>

        {adding && (
          <div className="stack" style={{ marginTop: 14 }}>
            <div className="field">
              <label>Name</label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <RolePicker
              roles={data.roles}
              selected={form.roleIds}
              onChange={(roleIds) => setForm({ ...form, roleIds })}
            />
            <div className="field">
              <label>Team</label>
              <select value={form.teamId} onChange={(e) => setForm({ ...form, teamId: e.target.value })}>
                <option value="">None</option>
                {data.teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Contact card</label>
              <select value={form.contactId} onChange={(e) => setForm({ ...form, contactId: e.target.value })}>
                <option value="">Inherit from team / default</option>
                {data.contacts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.title ? ` — ${c.title}` : ''}
                  </option>
                ))}
              </select>
            </div>
            <button
              className="btn primary"
              disabled={!form.name || !form.roleIds.length}
              onClick={() =>
                mutate(() => api.post('/api/admin/people', form)).then(() => {
                  setForm({ name: '', roleIds: [], teamId: '', contactId: '' });
                  setAdding(false);
                })
              }
            >
              Add person
            </button>
          </div>
        )}
      </div>

      <div className="card">
        <p className="tiny faint">
          Showing {filtered.length} of {data.people.length}
          {data.people.length > 200 ? ' (search to narrow)' : ''}
        </p>
        {filtered.map((p) => (
          <PersonRow key={p.id} person={p} data={data} mutate={mutate} remove={remove} />
        ))}
      </div>
    </>
  );
}

function PersonRow({
  person,
  data,
  mutate,
  remove,
}: {
  person: Person;
  data: RosterData;
  mutate: Mutate;
  remove: Remove;
}) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    name: person.name,
    roleIds: person.roleIds,
    teamId: person.teamId ?? '',
    contactId: person.contactId ?? '',
  });

  if (!editing) {
    return (
      <div className="list-row">
        <div style={{ minWidth: 0 }}>
          <div className="label">{person.name}</div>
          <div className="sub">
            {person.roles.map((r) => r.label).join(' + ') || <em>no role</em>}
            {person.teamName ? ` · ${person.teamName}` : ''}
          </div>
        </div>
        <div className="row">
          <button className="btn sm" onClick={() => setEditing(true)}>
            Edit
          </button>
          <button
            className="btn sm danger"
            onClick={() => {
              if (window.confirm(`Remove ${person.name} from the roster?`))
                remove(`/api/admin/people/${person.id}`, person.name);
            }}
          >
            Remove
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="list-row" style={{ display: 'block' }}>
      <div className="stack">
        <div className="field">
          <label>Name</label>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <RolePicker
          roles={data.roles}
          selected={form.roleIds}
          onChange={(roleIds) => setForm({ ...form, roleIds })}
        />
        <div className="field">
          <label>Team</label>
          <select value={form.teamId} onChange={(e) => setForm({ ...form, teamId: e.target.value })}>
            <option value="">None</option>
            {data.teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Contact card</label>
          <select value={form.contactId} onChange={(e) => setForm({ ...form, contactId: e.target.value })}>
            <option value="">Inherit from team / default</option>
            {data.contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.title ? ` — ${c.title}` : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="row">
          <button
            className="btn primary sm"
            disabled={!form.roleIds.length}
            onClick={() => mutate(() => api.patch(`/api/admin/people/${person.id}`, form)).then(() => setEditing(false))}
          >
            Save
          </button>
          <button className="btn ghost sm" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ teams ------------------------------ */

function Teams({ data, mutate, remove }: { data: RosterData; mutate: Mutate; remove: Remove }) {
  const [name, setName] = useState('');

  return (
    <>
      <div className="card">
        <h3>Add a team</h3>
        <div className="row" style={{ marginTop: 10 }}>
          <input
            className="search"
            style={{ marginBottom: 0 }}
            placeholder="Team name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button
            className="btn primary"
            disabled={!name.trim()}
            onClick={() => mutate(() => api.post('/api/admin/teams', { name })).then(() => setName(''))}
          >
            Add
          </button>
        </div>
      </div>

      <div className="card">
        {data.teams.map((t) => (
          <div className="list-row" key={t.id}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="label">
                {t.showOrder ? <span className="badge soft">{t.showOrder}</span> : null} {t.name}
              </div>
              <div className="sub">{t.memberCount} dancers</div>
              <div className="field-row" style={{ marginTop: 8 }}>
                <div className="field">
                  <label>Liaison contact (what dancers on this team see)</label>
                  <select
                    value={t.liaisonContactId ?? ''}
                    onChange={(e) =>
                      mutate(() =>
                        api.patch(`/api/admin/teams/${t.id}`, { liaisonContactId: e.target.value })
                      )
                    }
                  >
                    <option value="">None</option>
                    {data.contacts.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                        {c.title ? ` — ${c.title}` : ''}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>Running order</label>
                  <input
                    type="number"
                    min={1}
                    inputMode="numeric"
                    placeholder="—"
                    defaultValue={t.showOrder ?? ''}
                    onBlur={(e) =>
                      mutate(() =>
                        api.patch(`/api/admin/teams/${t.id}`, {
                          showOrder: e.target.value === '' ? null : e.target.value,
                        })
                      )
                    }
                  />
                </div>
              </div>
            </div>
            <button
              className="btn sm danger"
              onClick={() => {
                if (window.confirm(`Delete ${t.name}? Its ${t.memberCount} dancers become unassigned.`))
                  remove(`/api/admin/teams/${t.id}`, t.name);
              }}
            >
              Delete
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

/* ------------------------------ contacts ------------------------------ */

function Contacts({ data, mutate }: { data: RosterData; mutate: Mutate }) {
  const [form, setForm] = useState({ name: '', title: '', phone: '', email: '', note: '' });

  return (
    <>
      <div className="card">
        <h3>Add a contact card</h3>
        <div className="stack" style={{ marginTop: 10 }}>
          <div className="field-row">
            <div className="field">
              <label>Name</label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="field">
              <label>Title</label>
              <input
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="Team Liaison"
              />
            </div>
          </div>
          <div className="field-row">
            <div className="field">
              <label>Phone</label>
              <input
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                inputMode="tel"
              />
            </div>
            <div className="field">
              <label>Email</label>
              <input
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                inputMode="email"
              />
            </div>
          </div>
          <button
            className="btn primary"
            disabled={!form.name.trim()}
            onClick={() =>
              mutate(() => api.post('/api/admin/contacts', form)).then(() =>
                setForm({ name: '', title: '', phone: '', email: '', note: '' })
              )
            }
          >
            Add contact
          </button>
        </div>
      </div>

      <div className="card">
        {data.contacts.map((c) => (
          <div className="list-row" key={c.id}>
            <div style={{ minWidth: 0 }}>
              <div className="label">{c.name}</div>
              <div className="sub">{[c.title, c.phone, c.email].filter(Boolean).join(' · ')}</div>
            </div>
            <button
              className="btn sm danger"
              onClick={() => {
                if (window.confirm(`Delete the contact card for ${c.name}?`))
                  mutate(() => api.del(`/api/admin/contacts/${c.id}`));
              }}
            >
              Delete
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

/* ------------------------------ roles ------------------------------ */

function Roles({ data, mutate }: { data: RosterData; mutate: Mutate }) {
  const [form, setForm] = useState({ label: '', selector: 'person', blurb: '' });

  return (
    <>
      <div className="card">
        <h3>Add a role</h3>
        <p className="small muted">
          Roles are data — new ones appear on the landing page immediately, no deploy needed.
        </p>
        <div className="stack" style={{ marginTop: 10 }}>
          <div className="field-row">
            <div className="field">
              <label>Label</label>
              <input
                value={form.label}
                onChange={(e) => setForm({ ...form, label: e.target.value })}
                placeholder="e.g. Volunteer"
              />
            </div>
            <div className="field">
              <label>After picking this role…</label>
              <select
                value={form.selector}
                onChange={(e) => setForm({ ...form, selector: e.target.value })}
              >
                <option value="person">Pick a name</option>
                <option value="team">Pick a team</option>
              </select>
            </div>
          </div>
          <button
            className="btn primary"
            disabled={!form.label.trim()}
            onClick={() =>
              mutate(() => api.post('/api/admin/roles', form)).then(() =>
                setForm({ label: '', selector: 'person', blurb: '' })
              )
            }
          >
            Add role
          </button>
        </div>
      </div>

      <div className="card">
        {data.roles.map((r) => (
          <div className="list-row" key={r.id}>
            <div>
              <div className="label">
                {r.label} {!r.active && <span className="badge soft">hidden</span>}
              </div>
              <div className="sub">
                <code>{r.id}</code> · picks a {r.selector}
              </div>
            </div>
            <button
              className="btn sm"
              onClick={() => mutate(() => api.patch(`/api/admin/roles/${r.id}`, { active: !r.active }))}
            >
              {r.active ? 'Hide' : 'Show'}
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
