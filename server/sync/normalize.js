import { db } from '../db.js';
import { pick } from './parse.js';

/**
 * Turns loosely-typed spreadsheet rows into canonical ScheduleRow objects.
 * This is the only place that knows about the sheet template's column names —
 * swap the source, keep this.
 */

export const SCHEDULE_TEMPLATE = {
  columns: [
    { name: 'Day', required: true, note: 'Fri / Sat (or Friday / Saturday)' },
    { name: 'Start', required: true, note: '24h (14:30) or 12h (2:30 PM)' },
    { name: 'End', required: true, note: 'Same formats as Start' },
    { name: 'Location', required: true, note: 'Venue name, e.g. Main Venue' },
    { name: 'Sub-location', required: false, note: 'e.g. Green Room B' },
    { name: 'Activity', required: true, note: 'What is happening' },
    {
      name: 'Assigned Team/Person',
      required: true,
      note: 'Team name, person name, or "All <Role>" — prefix with Team:/Person:/Role: to force',
    },
    { name: 'Notes', required: false, note: 'Optional free text' },
    { name: 'ID', required: false, note: 'Optional stable row id; auto-derived if absent' },
  ],
};

export const ROSTER_TEMPLATE = {
  columns: [
    { name: 'Name', required: true, note: 'Full name' },
    { name: 'Role', required: true, note: 'Must match an existing role label' },
    { name: 'Team', required: false, note: 'Required for dancers; created if new' },
    {
      name: 'Captain?',
      required: false,
      note: 'Y / yes / true / 1 — adds the Captain role on top of their own',
    },
    {
      name: 'Contact Person/Method',
      required: false,
      note: 'e.g. "Jamie Rivera / 555-0102" or "jamie@example.com"',
    },
  ],
};

/** The role a `Captain?` column grants, on top of whatever the Role column says. */
export const CAPTAIN_ROLE_ID = 'captain';

const TRUTHY = new Set(['y', 'yes', 'true', '1', 'x', 'captain']);

/**
 * Reads the `Captain?` column. Deliberately strict about what counts as yes:
 * anything unrecognised is "no", because inventing captains adds people to a
 * meeting, while missing one is visible to the captain who checks their phone.
 */
export function isCaptainCell(raw) {
  return TRUTHY.has(String(raw ?? '').trim().toLowerCase());
}

/* ---------------------------- Scalars ---------------------------- */

const pad = (n) => String(n).padStart(2, '0');

/** Accepts Date (Excel time cells), 0–1 fractions, "2:30 PM", "14:30", "1430". */
export function normalizeTime(value) {
  if (value === null || value === undefined || value === '') return null;

  if (value instanceof Date) {
    // exceljs materializes time-only cells against the 1899 epoch in UTC.
    return `${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}`;
  }
  if (typeof value === 'number') {
    const frac = value % 1;
    const mins = Math.round(frac * 24 * 60);
    return `${pad(Math.floor(mins / 60) % 24)}:${pad(mins % 60)}`;
  }

  const s = String(value).trim().toLowerCase().replace(/\./g, '');
  let m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?$/);
  if (m) {
    let h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    if (m[3] === 'pm' && h < 12) h += 12;
    if (m[3] === 'am' && h === 12) h = 0;
    if (h > 23 || min > 59) return null;
    return `${pad(h)}:${pad(min)}`;
  }
  m = s.match(/^(\d{1,2})\s*(am|pm)$/);
  if (m) {
    let h = parseInt(m[1], 10);
    if (m[2] === 'pm' && h < 12) h += 12;
    if (m[2] === 'am' && h === 12) h = 0;
    return `${pad(h)}:00`;
  }
  m = s.match(/^(\d{3,4})$/);
  if (m) {
    const raw = m[1].padStart(4, '0');
    const h = parseInt(raw.slice(0, 2), 10);
    const min = parseInt(raw.slice(2), 10);
    if (h > 23 || min > 59) return null;
    return `${pad(h)}:${pad(min)}`;
  }
  return null;
}

/** Matches against event_days by key, label, or a leading-3-letter abbreviation. */
export function normalizeDay(value, days) {
  const s = String(value ?? '').trim().toLowerCase();
  if (!s) return null;
  for (const d of days) {
    if (d.key.toLowerCase() === s) return d.key;
    if (d.label.toLowerCase() === s) return d.key;
  }
  for (const d of days) {
    if (d.label.toLowerCase().startsWith(s) || s.startsWith(d.key.toLowerCase())) return d.key;
  }
  return null;
}

/* ---------------------------- Target resolution ---------------------------- */

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Resolve the "Assigned Team/Person" cell to one of the three targeting modes.
 * Ambiguity (a person and a team with the same name) is reported, not guessed.
 */
export function resolveAssignment(raw, index) {
  const value = String(raw ?? '').trim();
  if (!value) return { error: 'Assignment is blank' };

  let forced = null;
  let text = value;
  const prefix = value.match(/^(team|person|role)\s*:\s*(.+)$/i);
  if (prefix) {
    forced = prefix[1].toLowerCase();
    text = prefix[2].trim();
  }

  const key = norm(text);
  const roleKey = key.replace(/^all\s+/, '').replace(/s$/, '');

  const teamHit = index.teams.get(key);
  const personHits = index.people.get(key) || [];
  const roleHit = index.roles.get(key) || index.roles.get(roleKey);

  if (forced === 'team') {
    return teamHit ? { type: 'team', id: teamHit } : { error: `No team named "${text}"` };
  }
  if (forced === 'person') {
    if (personHits.length === 1) return { type: 'person', id: personHits[0] };
    if (personHits.length > 1) return { error: `More than one person named "${text}"` };
    return { error: `No person named "${text}"` };
  }
  if (forced === 'role') {
    return roleHit ? { type: 'role', id: roleHit } : { error: `No role named "${text}"` };
  }

  const candidates = [];
  if (teamHit) candidates.push({ type: 'team', id: teamHit });
  if (personHits.length === 1) candidates.push({ type: 'person', id: personHits[0] });
  if (roleHit) candidates.push({ type: 'role', id: roleHit });

  if (personHits.length > 1 && !teamHit && !roleHit) {
    return { error: `More than one person named "${text}" — prefix with "Person:" and a unique name` };
  }
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    return {
      error: `"${text}" matches a ${candidates
        .map((c) => c.type)
        .join(' and a ')} — prefix with Team:, Person:, or Role:`,
    };
  }
  return { error: `"${text}" is not a known team, person, or role` };
}

/** Name→id lookup tables built once per import. */
export function buildIndex() {
  const teams = new Map();
  for (const t of db.prepare('SELECT id, name FROM teams').all()) teams.set(norm(t.name), t.id);

  const people = new Map();
  for (const p of db.prepare('SELECT id, name FROM people').all()) {
    const k = norm(p.name);
    if (!people.has(k)) people.set(k, []);
    people.get(k).push(p.id);
  }

  const roles = new Map();
  for (const r of db.prepare('SELECT id, label FROM roles').all()) {
    roles.set(norm(r.label), r.id);
    roles.set(norm(r.label).replace(/s$/, ''), r.id);
    roles.set(norm(r.id), r.id);
  }

  return { teams, people, roles };
}

/* ---------------------------- Schedule rows ---------------------------- */

function slug(s) {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * @returns {{rows: ScheduleRow[], errors: Array<{row:number,message:string}>}}
 *   ScheduleRow: { sourceKey, day, startTime, endTime, venue, subLocation,
 *                  activity, appliesToType, appliesToId, notes }
 */
export function normalizeScheduleRows(rawRows) {
  const days = db.prepare('SELECT key, label FROM event_days ORDER BY sort_order').all();
  const index = buildIndex();
  const rows = [];
  const errors = [];
  const keyCounts = new Map();

  for (const r of rawRows) {
    const lineNo = r.__row ?? rows.length + 2;
    const problems = [];

    const day = normalizeDay(pick(r, ['Day']), days);
    if (!day) problems.push(`Day "${pick(r, ['Day'])}" is not one of ${days.map((d) => d.key).join(', ')}`);

    const startTime = normalizeTime(pick(r, ['Start', 'Start Time']));
    if (!startTime) problems.push(`Start time "${pick(r, ['Start', 'Start Time'])}" is unreadable`);

    const endTime = normalizeTime(pick(r, ['End', 'End Time']));
    if (!endTime) problems.push(`End time "${pick(r, ['End', 'End Time'])}" is unreadable`);

    if (startTime && endTime && endTime < startTime) {
      problems.push(`End time ${endTime} is before start time ${startTime}`);
    }

    const activity = String(pick(r, ['Activity', 'Activity Label']) ?? '').trim();
    if (!activity) problems.push('Activity is blank');

    const venue = String(pick(r, ['Location', 'Venue', 'Venue Name']) ?? '').trim();
    const subLocation = String(pick(r, ['Sub-location', 'Sub location', 'Sublocation']) ?? '').trim();

    const assignmentRaw = pick(r, ['Assigned Team/Person', 'Assigned', 'Assigned To', 'Applies To']);
    const assignment = resolveAssignment(assignmentRaw, index);
    if (assignment.error) problems.push(assignment.error);

    if (problems.length) {
      errors.push({ row: lineNo, message: problems.join('; '), raw: assignmentRaw });
      continue;
    }

    // Stable identity across syncs. Time and location are the mutable parts, so
    // they stay out of the key — that makes a moved block an update, not a
    // delete + create, which keeps the edit log meaningful.
    const explicitId = String(pick(r, ['ID', 'Block ID']) ?? '').trim();
    let sourceKey =
      explicitId || `${day}|${assignment.type}:${assignment.id}|${slug(activity)}`;
    const seen = (keyCounts.get(sourceKey) || 0) + 1;
    keyCounts.set(sourceKey, seen);
    if (seen > 1) sourceKey = `${sourceKey}#${seen}`;

    rows.push({
      sourceKey,
      day,
      startTime,
      endTime,
      venue,
      subLocation: subLocation || null,
      activity,
      appliesToType: assignment.type,
      appliesToId: assignment.id,
      notes: String(pick(r, ['Notes', 'Note']) ?? '').trim() || null,
      __row: lineNo,
    });
  }

  return { rows, errors };
}

/* ---------------------------- Roster rows ---------------------------- */

/**
 * "Jamie Rivera / 555-0102" → { name: 'Jamie Rivera', phone: '555-0102' }.
 * A bare method with no name is taken to be the row's own contact details, so
 * the card is titled after that person rather than after their email address.
 *
 * @param fallbackName the Name column of the same row
 */
export function parseContactCell(raw, fallbackName = null) {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  const parts = value.split(/\s*[/|]\s*/);
  let name = null;
  let method = null;
  if (parts.length >= 2) {
    name = parts[0].trim();
    method = parts.slice(1).join(' ').trim();
  } else if (/@/.test(value) || /\d{3}/.test(value)) {
    method = value;
  } else {
    name = value;
  }

  const email = method && method.includes('@') ? method : null;
  const phone = method && !email ? method : null;
  return { name: name || fallbackName || method, phone, email };
}

export function normalizeRosterRows(rawRows) {
  const roles = db.prepare('SELECT id, label, selector FROM roles').all();
  const roleByKey = new Map();
  for (const r of roles) {
    roleByKey.set(norm(r.label), r);
    roleByKey.set(norm(r.label).replace(/s$/, ''), r);
    roleByKey.set(norm(r.id), r);
  }

  const rows = [];
  const errors = [];

  for (const r of rawRows) {
    const lineNo = r.__row ?? rows.length + 2;
    const problems = [];

    const name = String(pick(r, ['Name', 'Full Name']) ?? '').trim();
    if (!name) problems.push('Name is blank');

    const roleRaw = String(pick(r, ['Role']) ?? '').trim();
    const role = roleByKey.get(norm(roleRaw));
    if (!role) problems.push(`Role "${roleRaw}" is not a known role`);

    const team = String(pick(r, ['Team', 'Team Name']) ?? '').trim();
    if (role && role.selector === 'team' && !team) {
      problems.push(`${role.label} rows need a Team`);
    }

    // A captain's second role, from the template's own column. The importer's
    // only job here is to add the role; it never infers one from a name suffix
    // — the `*` on a roster name marks a food restriction, not a captain.
    const captain = isCaptainCell(pick(r, ['Captain?', 'Captain']));
    const captainRole = captain ? roleByKey.get(CAPTAIN_ROLE_ID) : null;
    if (captain && !captainRole) {
      problems.push(`Marked as a captain, but there is no "${CAPTAIN_ROLE_ID}" role`);
    }

    if (problems.length) {
      errors.push({ row: lineNo, message: problems.join('; ') });
      continue;
    }

    rows.push({
      name,
      roleId: role.id,
      roleLabel: role.label,
      roleIds: captainRole && captainRole.id !== role.id ? [role.id, captainRole.id] : [role.id],
      isCaptain: Boolean(captainRole),
      teamName: team || null,
      contact: parseContactCell(
        pick(r, ['Contact Person/Method', 'Contact', 'Contact Method']),
        name
      ),
      __row: lineNo,
    });
  }

  return { rows, errors };
}
