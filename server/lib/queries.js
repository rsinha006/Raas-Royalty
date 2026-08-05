import { db, getMeta, scheduleUpdatedAt } from '../db.js';

/* ------------------------------------------------------------------ *
 * Row shaping
 * ------------------------------------------------------------------ */

const BLOCK_SELECT = `
  SELECT b.id, b.day, b.start_time, b.end_time, b.activity_label, b.notes,
         b.applies_to_type, b.applies_to_id, b.source, b.source_key,
         b.created_at, b.updated_at, b.last_change,
         b.location_id, l.venue_name, l.sub_location
    FROM schedule_blocks b
    LEFT JOIN locations l ON l.id = b.location_id
`;

function shapeBlock(row) {
  return {
    id: row.id,
    day: row.day,
    startTime: row.start_time,
    endTime: row.end_time,
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
      `SELECT t.id, t.name, t.liaison_contact_id,
              (SELECT COUNT(*) FROM people p WHERE p.team_id = t.id) AS member_count
         FROM teams t ORDER BY t.name`
    )
    .all()
    .map((t) => ({
      id: t.id,
      name: t.name,
      liaisonContactId: t.liaison_contact_id || null,
      memberCount: t.member_count,
    }));
}

export function listPeople({ roleId = null } = {}) {
  const rows = roleId
    ? db
        .prepare(
          `SELECT p.*, t.name AS team_name FROM people p
             LEFT JOIN teams t ON t.id = p.team_id
            WHERE p.role_id = ? ORDER BY p.name`
        )
        .all(roleId)
    : db
        .prepare(
          `SELECT p.*, t.name AS team_name FROM people p
             LEFT JOIN teams t ON t.id = p.team_id ORDER BY p.name`
        )
        .all();
  return rows.map((p) => ({
    id: p.id,
    name: p.name,
    roleId: p.role_id,
    teamId: p.team_id || null,
    teamName: p.team_name || null,
    contactId: p.contact_id || null,
  }));
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
    .map((d) => ({ key: d.key, label: d.label, date: d.date, sortOrder: d.sort_order }));
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
 * Resolve a session (a role + a team or a person) into the set of block targets
 * that session should see, plus the contact card to surface.
 *
 * Matching is three-way per the data model: a block can target a team, a single
 * person, or an entire role. A dancer's team session sees team blocks plus
 * all-dancer role blocks; an individual sees their own blocks, their role's
 * blocks, and their team's blocks if they have one.
 */
export function resolveSession({ type, id }) {
  if (type === 'team') {
    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(id);
    if (!team) return null;
    const dancerRole = db
      .prepare("SELECT id FROM roles WHERE selector = 'team' ORDER BY sort_order LIMIT 1")
      .get();
    const targets = [{ type: 'team', id: team.id }];
    if (dancerRole) targets.push({ type: 'role', id: dancerRole.id });
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
        `SELECT p.*, r.label AS role_label, t.name AS team_name, t.liaison_contact_id
           FROM people p
           JOIN roles r ON r.id = p.role_id
           LEFT JOIN teams t ON t.id = p.team_id
          WHERE p.id = ?`
      )
      .get(id);
    if (!person) return null;

    const targets = [
      { type: 'person', id: person.id },
      { type: 'role', id: person.role_id },
    ];
    if (person.team_id) targets.push({ type: 'team', id: person.team_id });

    // Their own contact card, else their team liaison, else the event-wide fallback.
    const contactId =
      person.contact_id || person.liaison_contact_id || getMeta('default_contact_id');
    return {
      kind: 'person',
      subject: {
        id: person.id,
        name: person.name,
        kind: 'person',
        roleLabel: person.role_label,
        teamName: person.team_name || null,
      },
      roleId: person.role_id,
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
      targets: [{ type: 'role', id: role.id }],
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
    updatedAt: scheduleUpdatedAt(),
    fetchedAt: new Date().toISOString(),
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
