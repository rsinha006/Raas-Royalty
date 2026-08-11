import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { formatDateTime } from '../time';
import Loading from '../Loading';

/**
 * Access-code management — item 8.
 *
 * The screen is built around distribution rather than around the table: the
 * question an admin actually arrives with is "who still hasn't got a link" or
 * "kill this one, it's on a lost phone", not "show me the access_codes table".
 * Hence coverage at the top, the CSV export next to it, and per-row actions
 * that each take one click.
 */

interface Code {
  code: string;
  subjectType: 'team' | 'person' | 'role';
  subjectId: string;
  subjectLabel: string | null;
  roleLabel: string | null;
  teamName: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  orphaned: boolean;
  link: string;
}

interface MissingSubject {
  subjectType: 'team' | 'person' | 'role';
  subjectId: string;
  label: string;
}

interface CodesData {
  codes: Code[];
  missing: MissingSubject[];
  linkBase: string;
  summary: {
    live: number;
    revoked: number;
    neverUsed: number;
    orphaned: number;
    missing: number;
    teams: number;
    people: number;
    roles: number;
  };
}

type TypeFilter = '' | 'team' | 'person' | 'role';

export default function CodesPanel() {
  const [data, setData] = useState<CodesData | null>(null);
  const [showRevoked, setShowRevoked] = useState(false);
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async (revoked = showRevoked) => {
    setData(await api.get<CodesData>(`/api/admin/codes${revoked ? '?revoked=true' : ''}`));
  };

  useEffect(() => {
    load(showRevoked).catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showRevoked]);

  const act = async (fn: () => Promise<unknown>, message?: string) => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await fn();
      await load();
      if (message) setNotice(message);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work');
    } finally {
      setBusy(false);
    }
  };

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    return data.codes
      .filter((c) => !typeFilter || c.subjectType === typeFilter)
      .filter(
        (c) =>
          !q ||
          (c.subjectLabel ?? '').toLowerCase().includes(q) ||
          (c.teamName ?? '').toLowerCase().includes(q) ||
          (c.roleLabel ?? '').toLowerCase().includes(q) ||
          c.code.toLowerCase().includes(q)
      );
  }, [data, query, typeFilter]);

  if (!data) {
    return error ? (
      <div className="banner offline">{error}</div>
    ) : (
      <Loading label="Loading access codes…" />
    );
  }

  const { summary } = data;

  return (
    <>
      {error && <div className="banner offline" style={{ marginBottom: 12 }}>{error}</div>}
      {notice && <div className="banner good" style={{ marginBottom: 12 }}>{notice}</div>}

      <div className="card">
        <h3>Access codes</h3>
        <p className="small muted">
          One code per team, one per staff member. A code is a bearer token — anyone holding the
          link sees that subject's schedule and contact details.
        </p>
        <div className="stat-grid" style={{ marginTop: 12 }}>
          <div className="stat">
            <div className="n">{summary.live}</div>
            <div className="k">Live</div>
          </div>
          <div className="stat">
            <div className="n">{summary.teams}</div>
            <div className="k">Teams</div>
          </div>
          <div className="stat">
            <div className="n">{summary.people}</div>
            <div className="k">Staff</div>
          </div>
          <div className="stat">
            <div className="n">{summary.neverUsed}</div>
            <div className="k">Never used</div>
          </div>
          <div className="stat">
            <div className="n">{summary.missing}</div>
            <div className="k">Missing</div>
          </div>
        </div>

        <div className="row" style={{ marginTop: 14, flexWrap: 'wrap' }}>
          <a className="btn primary sm" href="/api/admin/codes/export.csv">
            Download links CSV
          </a>
          <a className="btn sm" href="/api/admin/codes/export.csv?type=team">
            Teams only
          </a>
          <a className="btn sm" href="/api/admin/codes/export.csv?type=person">
            Staff only
          </a>
        </div>
        <p className="tiny faint" style={{ marginTop: 8 }}>
          One row per live code, with the link already built. Links point at{' '}
          <code>{data.linkBase}</code> — set <code>PUBLIC_BASE_URL</code> if that isn't the address
          attendees use. There is no email column: nobody's own address is stored anywhere in this
          app, so join the file to your own contact list on the subject name.
        </p>
      </div>

      {summary.missing > 0 && (
        <div className="card">
          <div className="banner info">
            <span aria-hidden="true">⚠️</span>
            <span>
              {summary.missing} subject{summary.missing === 1 ? '' : 's'} with no code — they cannot
              reach their schedule at all.
            </span>
          </div>
          <div className="scroll-list" style={{ marginTop: 10, maxHeight: 180 }}>
            {data.missing.map((m) => (
              <div className="tiny faint" key={`${m.subjectType}:${m.subjectId}`}>
                {m.subjectType} · {m.label}
              </div>
            ))}
          </div>
          <button
            className="btn primary sm"
            style={{ marginTop: 10 }}
            disabled={busy}
            onClick={() =>
              act(
                () => api.post('/api/admin/codes/backfill'),
                `Issued ${summary.missing} code${summary.missing === 1 ? '' : 's'}.`
              )
            }
          >
            Issue the missing {summary.missing}
          </button>
        </div>
      )}

      {summary.orphaned > 0 && (
        <div className="card">
          <div className="banner offline">
            <span aria-hidden="true">⚠️</span>
            <span>
              {summary.orphaned} live code{summary.orphaned === 1 ? '' : 's'} point at someone no
              longer on the roster. Revoke them — they grant nothing, but they are still live
              credentials.
            </span>
          </div>
        </div>
      )}

      <div className="card">
        <div className="row" style={{ marginBottom: 10 }}>
          <input
            className="search"
            style={{ marginBottom: 0 }}
            placeholder="Search by name, team or code…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select
            className="search"
            style={{ marginBottom: 0, maxWidth: 140 }}
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as TypeFilter)}
          >
            <option value="">All types</option>
            <option value="team">Teams</option>
            <option value="person">Staff</option>
            <option value="role">Roles</option>
          </select>
        </div>
        <label className="tiny faint row" style={{ gap: 6 }}>
          <input
            type="checkbox"
            checked={showRevoked}
            onChange={(e) => setShowRevoked(e.target.checked)}
          />
          Show revoked codes ({summary.revoked})
        </label>

        <p className="tiny faint" style={{ marginTop: 10 }}>
          Showing {filtered.length} of {data.codes.length}
        </p>

        {filtered.map((c) => (
          <CodeRow key={c.code} code={c} busy={busy} act={act} />
        ))}
        {filtered.length === 0 && <p className="small muted">Nothing matches that.</p>}
      </div>

      <BulkRegenerate busy={busy} act={act} live={summary.live} />
    </>
  );
}

type Act = (fn: () => Promise<unknown>, message?: string) => Promise<void>;

function CodeRow({ code, busy, act }: { code: Code; busy: boolean; act: Act }) {
  const [copied, setCopied] = useState<'link' | 'code' | null>(null);

  const copy = async (what: 'link' | 'code') => {
    try {
      await navigator.clipboard?.writeText(what === 'link' ? code.link : code.code);
      setCopied(what);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard is unavailable over plain http on some browsers; the text is on screen anyway */
    }
  };

  // A team or role code is shared by design; saying so here is the reminder an
  // admin needs before they treat it like someone's personal link.
  const detail =
    code.subjectType === 'person'
      ? [code.roleLabel, code.teamName].filter(Boolean).join(' · ')
      : code.subjectType === 'team'
        ? 'Team code — shared by everyone on the team'
        : 'Role code — shared by everyone in the role';

  return (
    <div className="list-row" style={{ display: 'block' }}>
      <div className="spread" style={{ gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div className="label">
            {code.subjectLabel ?? <em>deleted {code.subjectType}</em>}{' '}
            {code.revokedAt && <span className="badge soft">revoked</span>}
            {code.orphaned && !code.revokedAt && <span className="badge soft">orphaned</span>}
          </div>
          <div className="sub">{detail || code.subjectType}</div>
          <div className="sub">
            {code.revokedAt
              ? `Revoked ${formatDateTime(code.revokedAt)}`
              : code.lastUsedAt
                ? `Last opened ${formatDateTime(code.lastUsedAt)}`
                : 'Never opened'}
          </div>
        </div>
        <code className="code-chip">{code.code}</code>
      </div>

      {!code.revokedAt && (
        <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
          <button className="btn sm" onClick={() => copy('link')}>
            {copied === 'link' ? 'Copied ✓' : 'Copy link'}
          </button>
          <button className="btn sm ghost" onClick={() => copy('code')}>
            {copied === 'code' ? 'Copied ✓' : 'Copy code'}
          </button>
          {!code.orphaned && (
            <button
              className="btn sm"
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm(
                    `Regenerate the code for ${code.subjectLabel}?\n\nThe link already sent out stops working immediately.`
                  )
                )
                  act(
                    () => api.post(`/api/admin/codes/${code.code}/regenerate`),
                    `New code issued for ${code.subjectLabel}. Send them the new link.`
                  );
              }}
            >
              Regenerate
            </button>
          )}
          <button
            className="btn sm danger"
            disabled={busy}
            onClick={() => {
              if (
                window.confirm(
                  `Revoke the code for ${code.subjectLabel ?? code.subjectId}?\n\nAnyone signed in with it is locked out at once, and they get no replacement until you issue one.`
                )
              )
                act(
                  () => api.post(`/api/admin/codes/${code.code}/revoke`),
                  `Revoked ${code.code}.`
                );
            }}
          >
            Revoke
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Bulk rotation is the "a printed list of links walked off" button. It is
 * guarded by typing the word rather than a confirm dialog because the blast
 * radius — everyone at the event locked out simultaneously — is bigger than
 * anything else in this panel.
 */
function BulkRegenerate({ busy, act, live }: { busy: boolean; act: Act; live: number }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [scope, setScope] = useState('');

  return (
    <div className="card">
      <h3>Regenerate everything</h3>
      <p className="small muted">
        Rotates every live code at once. Every link already distributed stops working, so this is
        for a leak, not for tidying up. One subject at a time is the Regenerate button above.
      </p>
      {!open ? (
        <button className="btn sm danger" style={{ marginTop: 10 }} onClick={() => setOpen(true)}>
          I need to rotate all {live} codes
        </button>
      ) : (
        <div className="stack" style={{ marginTop: 10 }}>
          <div className="field">
            <label>Scope</label>
            <select value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="">Every code</option>
              <option value="team">Team codes only</option>
              <option value="person">Staff codes only</option>
              <option value="role">Role codes only</option>
            </select>
          </div>
          <div className="field">
            <label>Type REGENERATE to confirm</label>
            <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
          </div>
          <div className="row">
            <button
              className="btn danger"
              disabled={busy || typed !== 'REGENERATE'}
              onClick={() =>
                act(
                  () =>
                    api.post('/api/admin/codes/regenerate-all', {
                      confirm: typed,
                      subjectType: scope || null,
                    }),
                  'Every code in scope was rotated. Re-download the CSV and redistribute.'
                ).then(() => {
                  setTyped('');
                  setOpen(false);
                })
              }
            >
              Rotate
            </button>
            <button
              className="btn ghost"
              onClick={() => {
                setOpen(false);
                setTyped('');
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
