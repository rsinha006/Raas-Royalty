import { db, getMeta, scheduleUpdatedAt, versionForTargets } from '../db.js';
import { blockInstants, dayInstants, eventTimeState } from './event-time.js';

/* ------------------------------------------------------------------ *
 * Row shaping
 * ------------------------------------------------------------------ */

/**
 * The join onto `event_days` is what lets every block leave here with absolute
 * start and end instants. A block on its own knows only `Sat` and `09:00`;
 * resolving that pair against the event timezone is the server's job, and
 * doing it here means no caller can forget to.
 */
const BLOCK_SELECT = `
  SELECT b.id, b.day, b.start_time, b.end_time, b.activity_label, b.notes,
         b.applies_to_type, b.applies_to_id, b.source, b.source_key,
         b.created_at, b.updated_at, b.last_change,
         b.location_id, l.venue_name, l.sub_location, d.date AS day_date
    FROM schedule_blocks b
    LEFT JOIN locations l ON l.id = b.location_id
    LEFT JOIN event_days d ON d.key = b.day
`;

function shapeBlock(row) {
  const { startsAt, endsAt } = blockInstants(row.day_date, row.start_time, row.end_time);
  return {
    id: row.id,
    day: row.day,
    startTime: row.start_time,
    endTime: row.end_time,
    // Absolute, so the client never interprets a wall-clock time itself.
    // Null only when the day has no date row — the client shows the block
    // without a now/next status rather than guessing at one.
    startsAt: startsAt ? startsAt.toISOString() : null,
    endsAt: endsAt ? endsAt.toISOString() : null,
    activity: row.activity_label,
    notes: row.notes || null,
    location: row.location_id
      ? {
          id: row.location_id,
          venue: row.venue_name,
          subLocation: row.sub_location || null,
          display: row.sub_location ? `${row.venue_name} → ${row.sub_location}` : row.venue_name,
        }
      : null,
    appliesTo: { type: row.applies_to_type, id: row.applies_to_id },
    source: row.source,
    sourceKey: row.source_key || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastChange: row.last_change || null,
  };
}

function shapeContact(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    title: row.title || null,
    phone: row.phone || null,
    email: row.email || null,
    note: row.note || null,
  };
}

/* ------------------------------------------------------------------ *
 * Roster reads
 * ------------------------------------------------------------------ */

export function listRoles({ includeInactive = false } = {}) {
  const sql = includeInactive
    ? 'SELECT * FROM roles ORDER BY sort_order, label'
    : 'SELECT * FROM roles WHERE active = 1 ORDER BY sort_order, label';
  return db
    .prepare(sql)
    .all()
    .map((r) => ({
      id: r.id,
      label: r.label,
      selector: r.selector,
      blurb: r.blurb || null,
      sortOrder: r.sort_order,
      active: !!r.active,
    }));
}

export function listTeams() {
  return db
    .prepare(
      `SELECT t.id, t.name, t.liaison_contact_id, t.show_order,
              (SELECT COUNT(*) FROM people p WHERE p.team_id = t.id) AS member_count
         FROM teams t ORDER BY t.show_order IS NULL, t.show_order, t.name`
    )
    .all()
    .map((t) => ({
      id: t.id,
      name: t.name,
      liaisonContactId: t.liaison_contact_id || null,
      memberCount: t.member_count,
      /** Running order, 1–8. Null until the draw. */
      showOrder: t.show_order ?? null,
    }));
}

/**
 * Every role a person holds, ordered so the first is the one to display.
 *
 * "Display role" is derived from `roles.sort_order` rather than stored: a
 * captain holds Dancer + Captain and should read as a Dancer, and Captain sorts
 * last precisely because it is an overlay rather than a seat of its own.
 */
const ROLES_FOR_PEOPLE = `
  SELECT pr.person_id, r.id, r.label, r.selector, r.sort_order
    FROM person_roles pr
    JOIN roles r ON r.id = pr.role_id
   ORDER BY r.sort_order, r.label
`;

function rolesByPerson(personIds = null) {
  const rows = db.prepare(ROLES_FOR_PEOPLE).all();
  const wanted = personIds ? new Set(personIds) : null;
  const map = new Map();
  for (const r of rows) {
    if (wanted && !wanted.has(r.person_id)) continue;
    if (!map.has(r.person_id)) map.set(r.person_id, []);
    map.get(r.person_id).push({ id: r.id, label: r.label, selector: r.selector });
  }
  return map;
}

/** The roles one person holds, display order first. */
export function rolesForPerson(personId) {
  return db
    .prepare(
      `SELECT r.id, r.label, r.selector
         FROM person_roles pr
         JOIN roles r ON r.id = pr.role_id
        WHERE pr.person_id = ?
        ORDER BY r.sort_order, r.label`
    )
    .all(personId);
}

export function listPeople({ roleId = null } = {}) {
  const rows = roleId
    ? db
        .prepare(
          `SELECT p.*, t.name AS team_name FROM people p
             LEFT JOIN teams t ON t.id = p.team_id
             JOIN person_roles pr ON pr.person_id = p.id AND pr.role_id = ?
            ORDER BY p.name`
        )
        .all(roleId)
    : db
        .prepare(
          `SELECT p.*, t.name AS team_name FROM people p
             LEFT JOIN teams t ON t.id = p.team_id ORDER BY p.name`
        )
        .all();
  const roles = rolesByPerson(rows.map((p) => p.id));
  return rows.map((p) => {
    const held = roles.get(p.id) ?? [];
    return {
      id: p.id,
      name: p.name,
      roles: held,
      roleIds: held.map((r) => r.id),
      // The display role. Kept as `roleId` because that is what it means to
      // every screen that shows one role next to a name.
      roleId: held[0]?.id ?? null,
      roleLabel: held[0]?.label ?? null,
      teamId: p.team_id || null,
      teamName: p.team_name || null,
      contactId: p.contact_id || null,
    };
  });
}

export function listContacts() {
  return db.prepare('SELECT * FROM contact_cards ORDER BY name').all().map(shapeContact);
}

export function listLocations() {
  return db
    .prepare('SELECT * FROM locations ORDER BY venue_name, sub_location')
    .all()
    .map((l) => ({
      id: l.id,
      venue: l.venue_name,
      subLocation: l.sub_location || null,
      display: l.sub_location ? `${l.venue_name} → ${l.sub_location}` : l.venue_name,
    }));
}

export function listDays() {
  return db
    .prepare('SELECT * FROM event_days ORDER BY sort_order, key')
    .all()
    .map((d) => {
      const { startsAt, endsAt } = dayInstants(d.date);
      return {
        key: d.key,
        label: d.label,
        date: d.date,
        sortOrder: d.sort_order,
        // Midnight to midnight at the venue. The client picks which day to open
        // on by comparing instants, so a phone on the wrong timezone cannot
        // land someone on Saturday's tab while it is still Friday at the venue.
        startsAt: startsAt ? startsAt.toISOString() : null,
        endsAt: endsAt ? endsAt.toISOString() : null,
      };
    });
}

/**
 * Everything the landing page needs to let someone identify themselves.
 * Small enough to cache offline in full.
 */
export function getBootstrap() {
  // Deliberately almost empty. This used to return every role, every team and
  // every person's name and id — enough to enumerate the entire roster with one
  // unauthenticated GET, and enough to then pull any of their schedules. The
  // landing page needs the event's name to render and nothing else; everything
  // identifying now arrives only after a code is redeemed.
  return {
    eventName: getMeta('event_name', 'Royalty Dance Competition'),
    updatedAt: scheduleUpdatedAt(),
  };
}

/**
 * Names on one team, for the "which dancer are you?" step. The narrowest
 * enumeration the product needs: it is reachable only with that team's code,
 * and it exposes nothing the code did not already entitle the holder to.
 */
export function listTeamMembers(teamId) {
  return db
    .prepare('SELECT id, name FROM people WHERE team_id = ? ORDER BY name')
    .all(teamId)
    .map((p) => ({ id: p.id, name: p.name }));
}

/* ------------------------------------------------------------------ *
 * Personalization
 * ------------------------------------------------------------------ */

/**
 * The event-wide announcement target — item 18.
 *
 * "Fire alarm, evacuate" used to mean creating six near-identical blocks, one
 * per audience, each with its own edit-log line and its own chance of being
 * missed. This is one block that every session's target list contains.
 *
 * The id is pinned rather than passed, so there is exactly one announcement
 * room (`everyone:all`), one `target_versions` key, and no way for two callers
 * to invent different sentinels. The database enforces it too.
 *
 * ⚠️ A block *target*, never a session subject and never an access-code
 * subject. Nobody signs in "as everyone"; every session already includes this
 * in its targets, which is what makes one block reach all ~280 people.
 */
export const EVERYONE = Object.freeze({ type: 'everyone', id: 'all' });

/**
 * Resolve a session (a role + a team or a person) into the set of block targets
 * that session should see, plus the contact card to surface.
 *
 * Matching is three-way per the data model: a block can target a team, a single
 * person, or an entire role. A dancer's team session sees team blocks plus
 * all-dancer role blocks; an individual sees their own blocks, *every* role
 * they hold, and their team's blocks if they have one.
 */
export function resolveSession({ type, id }) {
  if (type === 'team') {
    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(id);
    if (!team) return null;
    /**
     * A team session that hasn't identified anyone yet gets the team-wide role
     * only — the one whose members are reached through a team code. Notably it
     * does *not* get Captain: before the identity step there is no way to know
     * whether the phone belongs to a captain, and showing the Captains Meeting
     * to all 25 dancers would have them turn up to it.
     */
    const dancerRole = db
      .prepare("SELECT id FROM roles WHERE selector = 'team' ORDER BY sort_order LIMIT 1")
      .get();
    const targets = [{ type: 'team', id: team.id }];
    if (dancerRole) targets.push({ type: 'role', id: dancerRole.id });
    targets.push({ ...EVERYONE });
    return {
      kind: 'team',
      subject: { id: team.id, name: team.name, kind: 'team' },
      roleId: dancerRole ? dancerRole.id : null,
      targets,
      contact: shapeContact(
        db.prepare('SELECT * FROM contact_cards WHERE id = ?').get(team.liaison_contact_id)
      ),
    };
  }

  if (type === 'person') {
    const person = db
      .prepare(
        `SELECT p.*, t.name AS team_name, t.liaison_contact_id
           FROM people p
           LEFT JOIN teams t ON t.id = p.team_id
          WHERE p.id = ?`
      )
      .get(id);
    if (!person) return null;

    /**
     * Every role, not one. This is the line that makes a captain's three blocks
     * reach them: they hold Dancer + Captain, so both role targets go into the
     * OR list and `blocksForTargets` needs no change at all.
     */
    const roles = rolesForPerson(person.id);
    const targets = [
      { type: 'person', id: person.id },
      ...roles.map((r) => ({ type: 'role', id: r.id })),
    ];
    if (person.team_id) targets.push({ type: 'team', id: person.team_id });
    targets.push({ ...EVERYONE });

    // Their own contact card, else their team liaison, else the event-wide fallback.
    const contactId =
      person.contact_id || person.liaison_contact_id || getMeta('default_contact_id');
    return {
      kind: 'person',
      subject: {
        id: person.id,
        name: person.name,
        kind: 'person',
        // The display role is the first by sort order — Dancer for a captain,
        // since Captain is an overlay on it rather than a separate seat.
        roleLabel: roles[0]?.label ?? null,
        roleLabels: roles.map((r) => r.label),
        teamName: person.team_name || null,
      },
      roleId: roles[0]?.id ?? null,
      targets,
      contact: shapeContact(db.prepare('SELECT * FROM contact_cards WHERE id = ?').get(contactId)),
    };
  }

  if (type === 'role') {
    // Role-code sessions: one shared code for a group whose schedule holds
    // nothing personal. Never issued automatically — see docs/decisions.md.
    const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(id);
    if (!role) return null;
    return {
      kind: 'role',
      subject: { id: role.id, name: role.label, kind: 'role', roleLabel: role.label },
      roleId: role.id,
      targets: [{ type: 'role', id: role.id }, { ...EVERYONE }],
      contact: shapeContact(
        db.prepare('SELECT * FROM contact_cards WHERE id = ?').get(getMeta('default_contact_id'))
      ),
    };
  }

  return null;
}

export function blocksForTargets(targets) {
  if (!targets.length) return [];
  const clause = targets.map(() => '(b.applies_to_type = ? AND b.applies_to_id = ?)').join(' OR ');
  const params = targets.flatMap((t) => [t.type, t.id]);
  return db
    .prepare(`${BLOCK_SELECT} WHERE ${clause} ORDER BY b.day, b.start_time, b.end_time`)
    .all(...params)
    .map(shapeBlock);
}

/**
 * The single payload the viewer renders from — and the exact shape it caches to
 * localStorage for offline use.
 */
export function getPersonalizedSchedule(session) {
  const resolved = resolveSession(session);
  if (!resolved) return null;
  return {
    session: { type: session.type, id: session.id },
    subject: resolved.subject,
    contact: resolved.contact,
    days: listDays(),
    blocks: blocksForTargets(resolved.targets),
    // This session's own targets, not the event's. A global timestamp meant a
    // change to one team told all ~280 phones "Last updated a moment ago" —
    // alarming, and untrue for all but one of them.
    updatedAt: versionForTargets(resolved.targets),
    fetchedAt: new Date().toISOString(),
    // The server's own clock, carried on every payload. The client measures its
    // drift from this and counts down from the corrected value, so a phone with
    // the wrong time set still sees the right "in 20 min". Cached with the rest
    // of the payload, which is what keeps now/next honest offline.
    eventTime: eventTimeState(),
  };
}

/* ------------------------------------------------------------------ *
 * Admin reads
 * ------------------------------------------------------------------ */

export function listAllBlocks({ day = null } = {}) {
  const rows = day
    ? db.prepare(`${BLOCK_SELECT} WHERE b.day = ? ORDER BY b.start_time`).all(day)
    : db.prepare(`${BLOCK_SELECT} ORDER BY b.day, b.start_time`).all();
  return rows.map(shapeBlock);
}

export function getBlock(id) {
  const row = db.prepare(`${BLOCK_SELECT} WHERE b.id = ?`).get(id);
  return row ? shapeBlock(row) : null;
}

export function listEditLog({ limit = 200 } = {}) {
  return db
    .prepare('SELECT * FROM edit_log ORDER BY timestamp DESC, rowid DESC LIMIT ?')
    .all(limit)
    .map((r) => ({
      id: r.id,
      blockId: r.schedule_block_id || null,
      editedBy: r.edited_by,
      source: r.source,
      timestamp: r.timestamp,
      changeType: r.change_type,
      summary: r.change_summary,
      audience: r.audience_json ? JSON.parse(r.audience_json) : null,
    }));
}

/**
 * Human label for a target, used in edit summaries and the admin block list.
 */
export function describeTarget(type, id) {
  if (type === 'everyone') return 'Everyone';
  if (type === 'team') {
    const t = db.prepare('SELECT name FROM teams WHERE id = ?').get(id);
    return t ? t.name : `Unknown team (${id})`;
  }
  if (type === 'person') {
    const p = db.prepare('SELECT name FROM people WHERE id = ?').get(id);
    return p ? p.name : `Unknown person (${id})`;
  }
  const r = db.prepare('SELECT label FROM roles WHERE id = ?').get(id);
  return r ? `All ${r.label}` : `Unknown role (${id})`;
}
