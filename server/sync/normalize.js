import { db } from '../db.js';
import { pick } from './parse.js';

/**
 * Turns loosely-typed spreadsheet rows into canonical ScheduleRow objects.
 * This is the only place that knows about the sheet template's column names —
 * swap the source, keep this.
 */

/**
 * The tabs the app reads out of `templates/royalty-schedule-template.xlsx`.
 *
 * ⚠️ The workbook has sixteen tabs and the app reads three of them. The other
 * thirteen — the day grids, Sequences, Slot Times, Checks — are how logistics
 * *builds* the weekend; Export is the flat answer they compute, and it is the
 * only schedule tab with any standing here. The first tab is Instructions, so
 * "just read the first sheet" reads prose.
 */
export const SCHEDULE_SHEETS = ['Export'];

/**
 * Both roster tabs, staff before dancers. They are two tabs rather than one
 * because they are filled in by different people from different sources, and
 * they carry different columns: People names a Type per row, Roster is dancers
 * throughout and says so by being the Roster tab.
 */
export const ROSTER_SHEETS = ['People', 'Roster'];

/**
 * The Roster tab is dancers by definition — the template's own instruction.
 * Keyed lowercase because the sheet name that comes back is the workbook's own
 * spelling, and a tab someone retyped as "roster" is the same tab.
 */
export const ROSTER_SHEET_DEFAULT_ROLE = { roster: 'dancer' };

export const SCHEDULE_TEMPLATE = {
  columns: [
    {
      name: 'Day',
      required: true,
      // Matched against `event_days`, which the seed builds as Thursday to
      // Sunday. A day the database does not have is a per-row refusal, so this
      // list is the one in the database rather than a fixed pair.
      note: 'Thu / Fri / Sat / Sun (or Thursday / Friday / Saturday / Sunday)',
    },
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

/**
 * The People tab's `Type` vocabulary, which is the event's words rather than
 * ours. Roles stay data — this maps a spelling onto a role id, it does not
 * define the set. A `Type` with no entry here still resolves if it matches a
 * role's own label or id, so a role added in the panel needs no code change.
 */
export const ROLE_ALIASES = {
  board: 'exec',
  'board member': 'exec',
  'exec board': 'exec',
  executive: 'exec',
  director: 'exec',
  liaison: 'liaison',
  'head liaison': 'liaison',
  'judge liaison': 'liaison',
  judging: 'judge',
  video: 'videographer',
  videography: 'videographer',
  'ras rep': 'ras-rep',
  'ras representative': 'ras-rep',
};

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

/**
 * Zero-width and direction marks. They survive a copy-paste out of a browser
 * or a PDF, they are invisible in every spreadsheet, and they make an otherwise
 * identical name compare unequal — so a re-import creates a second person and
 * splits one dancer's schedule across two rows nobody can tell apart.
 */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g;

/**
 * `\s` already folds the non-breaking and en/em spaces that paste in from the
 * web; what it does not touch is the zero-width and direction range above, so
 * that has to go first — otherwise collapsing the whitespace leaves the mark
 * sitting inside a name that now looks identical to a different string.
 */
const clean = (value) =>
  String(value ?? '')
    .replace(INVISIBLE, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * A roster name as it should appear on that person's phone.
 *
 * ⚠️ The trailing `*` / `**` on last year's roster marks a **food restriction**,
 * not a captain — confirmed with the event director. Stripping it is this
 * function's only opinion; `Captain?` is the one thing that makes a captain.
 */
export function normalizeName(value) {
  return clean(value).replace(/[*†‡]+$/, '').trim();
}

/**
 * Digits are what a `tel:` link needs; the punctuation is for reading. Five
 * spellings appeared across the samples — `555-0100`, `(925) 430-8287`,
 * `(925)-430-8287`, `925.430.8287`, and a bare run of digits — so this returns
 * one canonical form for the four that carry a full number, and hands anything
 * else back cleaned but unchanged rather than mangling an extension or a note.
 */
export function normalizePhone(value) {
  const text = clean(value);
  if (!text) return null;
  const digits = text.replace(/\D/g, '');
  if (digits.length === 10) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (digits.length === 11 && digits[0] === '1') {
    return `+1-${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return text;
}

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

  /**
   * The event-wide announcement target — item 18. Matched before anything else
   * and by exact word, because it is the one assignment that cannot be a real
   * name: a team called "Everyone" would be ambiguous, and silently preferring
   * the team would post an evacuation notice to 25 people.
   */
  if (/^(everyone|all|everybody)$/i.test(value)) return { type: 'everyone', id: 'all' };

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
 * A row carrying one non-empty cell is a note, not a block.
 *
 * The Export tab ends with three lines of instructions to whoever maintains it
 * ("THIS IS THE TAB THE APP READS…"), sitting in the Day column with the other
 * eight blank. Read literally they are three unreadable blocks, so every import
 * of a correctly-filled workbook would report errors forever — and an import
 * that always shows errors is one whose errors stop being read, which is the
 * only thing standing between the wrong spreadsheet and an empty Saturday.
 * A block needs a day, a start, an end, an activity and an audience; one cell
 * can never be one.
 */
function isNoteRow(r) {
  const cells = Array.isArray(r.__cells)
    ? r.__cells
    : SCHEDULE_TEMPLATE.columns.map((c) => pick(r, [c.name]));
  return cells.filter((c) => String(c ?? '').trim() !== '').length <= 1;
}

/**
 * @returns {{rows: ScheduleRow[], errors: Array<{row:number,message:string}>, notes: number}}
 *   ScheduleRow: { sourceKey, day, startTime, endTime, venue, subLocation,
 *                  activity, appliesToType, appliesToId, notes }
 */
export function normalizeScheduleRows(rawRows) {
  const days = db.prepare('SELECT key, label FROM event_days ORDER BY sort_order').all();
  const index = buildIndex();
  const rows = [];
  const errors = [];
  const keyCounts = new Map();
  let notes = 0;

  for (const r of rawRows) {
    const lineNo = r.__row ?? rows.length + 2;
    const problems = [];

    if (isNoteRow(r)) {
      notes += 1;
      continue;
    }

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

  return { rows, errors, notes };
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

/**
 * The Roster tab splits a name across two columns; the CSV template and the
 * People tab carry it whole. Either way the result is one string, cleaned and
 * with the food-restriction mark taken off.
 */
function rosterName(r) {
  const whole = normalizeName(pick(r, ['Name', 'Full Name']));
  if (whole) return whole;
  const first = normalizeName(pick(r, ['First Name', 'First']));
  const last = normalizeName(pick(r, ['Last Name', 'Last', 'Surname']));
  return [first, last].filter(Boolean).join(' ');
}

/**
 * Split a roster row's two very different kinds of contact detail.
 *
 * ⚠️ These are not the same thing and conflating them is a real bug, which is
 * why they are separated here rather than downstream:
 *
 *   - **`self`** — this person's own phone and email, off the People and Roster
 *     tabs' `Phone` / `Email` columns. Used to *send them their access link*.
 *   - **`contact`** — the card they should *call*, which names somebody else:
 *     a dancer's team liaison, a judge's coordinator. This is what the viewer
 *     shows under "Your contact", and it is shared across many people.
 *
 * Item 24's first cut built a card out of the `Phone`/`Email` columns, which
 * made every imported person their own coordinator: 280 contact cards
 * duplicating the roster, every dancer shown their own number under "Your
 * contact", and no liaison reachable from any phone. The `Contact
 * Person/Method` cell is still read for the CSV template, but a bare method
 * with no name in it is that person's own details — so it becomes `self`, not
 * a card titled after them.
 */
function rosterContacts(r, name) {
  const self = {
    phone: normalizePhone(pick(r, ['Phone', 'Phone Number', 'Mobile', 'Cell'])),
    email: clean(pick(r, ['Email', 'Email Address'])).toLowerCase() || null,
  };

  const combined = pick(r, ['Contact Person/Method', 'Contact', 'Contact Method']);
  const parsed = String(combined ?? '').trim() ? parseContactCell(combined, name) : null;

  if (!parsed) return { self, contact: null };
  if (norm(parsed.name) === norm(name)) {
    // A bare method: their own details, written in the other column.
    return {
      self: {
        phone: self.phone || normalizePhone(parsed.phone),
        email: self.email || clean(parsed.email).toLowerCase() || null,
      },
      contact: null,
    };
  }
  return { self, contact: parsed };
}

/**
 * @param {string|null} [opts.defaultRoleId] the role for rows with no Role/Type
 *   cell. Set per *sheet*, never guessed per row: the Roster tab is dancers by
 *   definition, and a People row without a Type is a row somebody has not
 *   finished, which has to stay an error.
 */
export function normalizeRosterRows(rawRows, opts = {}) {
  const { defaultRoleId = null } = opts;
  const roles = db.prepare('SELECT id, label, selector FROM roles').all();
  const roleByKey = new Map();
  for (const r of roles) {
    roleByKey.set(norm(r.label), r);
    roleByKey.set(norm(r.label).replace(/s$/, ''), r);
    roleByKey.set(norm(r.id), r);
  }
  /** An alias only resolves if it lands on a role that exists. */
  const resolveRole = (raw) => {
    const key = norm(raw);
    if (!key) return null;
    return roleByKey.get(key) || roleByKey.get(norm(ROLE_ALIASES[key])) || null;
  };

  const rows = [];
  const errors = [];

  for (const r of rawRows) {
    const lineNo = r.__row ?? rows.length + 2;
    const sheet = r.__sheet || null;
    const problems = [];

    const name = rosterName(r);
    if (!name) problems.push('Name is blank');

    const roleRaw = clean(pick(r, ['Role', 'Type', 'Position']));
    const role = roleRaw ? resolveRole(roleRaw) : resolveRole(defaultRoleId);
    if (!role) {
      problems.push(
        roleRaw
          ? `Role "${roleRaw}" is not a known role`
          : 'Role is blank, and this sheet has no default role'
      );
    }

    const team = clean(pick(r, ['Team', 'Team Name']));
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
      errors.push({ row: lineNo, sheet, message: problems.join('; ') });
      continue;
    }

    const { self, contact } = rosterContacts(r, name);
    rows.push({
      name,
      roleId: role.id,
      roleLabel: role.label,
      roleIds: captainRole && captainRole.id !== role.id ? [role.id, captainRole.id] : [role.id],
      isCaptain: Boolean(captainRole),
      teamName: team || null,
      // Their own, for sending them their link (item 25).
      email: self.email,
      phone: self.phone,
      // Somebody else's, for them to call.
      contact,
      __row: lineNo,
      __sheet: sheet,
    });
  }

  return { rows, errors };
}

/**
 * Read a whole workbook's roster: the People tab and the Roster tab, normalized
 * into one list. A CSV, or a workbook with neither tab, comes back through the
 * same call as the single table it is — so the CSV template, last year's
 * spreadsheets and the real workbook are all one code path, which is what keeps
 * the tested path and the event-day path the same one.
 *
 * @param {Array<{rows: any[], sheetName: string|null}>} sheets from parseNamedSheets
 */
export function normalizeRosterSheets(sheets) {
  const rows = [];
  const errors = [];
  for (const sheet of sheets) {
    const defaultRoleId =
      ROSTER_SHEET_DEFAULT_ROLE[String(sheet.sheetName ?? '').trim().toLowerCase()] ?? null;
    const out = normalizeRosterRows(sheet.rows, { defaultRoleId });
    rows.push(...out.rows);
    errors.push(...out.errors);
  }
  return { rows, errors };
}
