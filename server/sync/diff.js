import { db, newId, touchRosterVersion, touchScheduleVersion } from '../db.js';
import { describeTarget, listAllBlocks } from '../lib/queries.js';
import {
  createBlock,
  deleteBlock,
  deleteBlocksForTarget,
  ensureLocation,
  logEdit,
  updateBlock,
} from '../lib/mutations.js';

/**
 * Diffing is deliberately separated from applying: the admin preview step runs
 * the exact same computation the commit does, so what you approve is what lands.
 */

const locDisplay = (venue, sub) => (venue ? (sub ? `${venue} → ${sub}` : venue) : null);

function rowLabel(row) {
  return `${row.day} ${row.startTime}–${row.endTime} · ${row.activity} · ${describeTarget(
    row.appliesToType,
    row.appliesToId
  )}`;
}

/* ---------------------------- Schedule ---------------------------- */

/**
 * @param rows normalized ScheduleRows
 * @param removeMissing when true, managed blocks absent from the source are deleted
 */
export function computeScheduleDiff(rows, { removeMissing = true } = {}) {
  const existing = listAllBlocks().filter((b) => b.sourceKey);
  const byKey = new Map(existing.map((b) => [b.sourceKey, b]));

  const create = [];
  const update = [];
  let unchanged = 0;
  const seen = new Set();

  for (const row of rows) {
    seen.add(row.sourceKey);
    const prev = byKey.get(row.sourceKey);
    if (!prev) {
      create.push({ row, label: rowLabel(row) });
      continue;
    }

    const changes = [];
    if (prev.day !== row.day) changes.push(`day ${prev.day} → ${row.day}`);
    if (prev.startTime !== row.startTime || prev.endTime !== row.endTime) {
      changes.push(`time ${prev.startTime}–${prev.endTime} → ${row.startTime}–${row.endTime}`);
    }
    const nextLoc = locDisplay(row.venue, row.subLocation);
    if ((prev.location?.display ?? null) !== nextLoc) {
      changes.push(`location ${prev.location?.display ?? 'none'} → ${nextLoc ?? 'none'}`);
    }
    if (prev.activity !== row.activity) changes.push(`activity → "${row.activity}"`);
    if (
      prev.appliesTo.type !== row.appliesToType ||
      prev.appliesTo.id !== row.appliesToId
    ) {
      changes.push(
        `assigned ${describeTarget(prev.appliesTo.type, prev.appliesTo.id)} → ${describeTarget(
          row.appliesToType,
          row.appliesToId
        )}`
      );
    }
    if ((prev.notes ?? null) !== (row.notes ?? null)) changes.push('notes updated');

    if (changes.length) update.push({ id: prev.id, row, changes, before: prev, label: rowLabel(row) });
    else unchanged++;
  }

  const remove = removeMissing
    ? existing
        .filter((b) => !seen.has(b.sourceKey))
        .map((b) => ({
          id: b.id,
          label: `${b.day} ${b.startTime}–${b.endTime} · ${b.activity} · ${describeTarget(
            b.appliesTo.type,
            b.appliesTo.id
          )}`,
        }))
    : [];

  return {
    create,
    update,
    delete: remove,
    unchanged,
    total: rows.length,
    hasChanges: create.length + update.length + remove.length > 0,
  };
}

/**
 * Returns `{ updatedAt, targets }`. The targets are every block target the
 * import touched — an import that only moved one team's call time should wake
 * that team, not the whole event, and a re-sync that changed nothing at all
 * wakes nobody. See `server/lib/live.js` for how they become rooms.
 */
export function applyScheduleDiff(diff, ctx) {
  const source = ctx.source || 'import';
  const targets = [];
  const run = db.transaction(() => {
    for (const { row } of diff.create) {
      targets.push({ type: row.appliesToType, id: row.appliesToId });
      createBlock(
        {
          day: row.day,
          startTime: row.startTime,
          endTime: row.endTime,
          locationId: ensureLocation(row.venue, row.subLocation),
          activity: row.activity,
          appliesToType: row.appliesToType,
          appliesToId: row.appliesToId,
          notes: row.notes,
          sourceKey: row.sourceKey,
        },
        { ...ctx, source }
      );
    }
    for (const item of diff.update) {
      const result = updateBlock(
        item.id,
        {
          day: item.row.day,
          startTime: item.row.startTime,
          endTime: item.row.endTime,
          locationId: ensureLocation(item.row.venue, item.row.subLocation),
          activity: item.row.activity,
          appliesToType: item.row.appliesToType,
          appliesToId: item.row.appliesToId,
          notes: item.row.notes,
        },
        { ...ctx, source }
      );
      // Both sides of a reassignment, so a block that moved between teams
      // disappears from the old one's phones as well as landing on the new.
      targets.push(...(result?.targets ?? []));
      db.prepare('UPDATE schedule_blocks SET source = ?, source_key = ? WHERE id = ?').run(
        source,
        item.row.sourceKey,
        item.id
      );
    }
    for (const item of diff.delete) {
      const removed = deleteBlock(item.id, { ...ctx, source });
      if (removed) targets.push(removed.target);
    }

    logEdit({
      editedBy: ctx.editedBy,
      source,
      changeType: 'sync',
      summary: `${ctx.label || 'Spreadsheet import'}: ${diff.create.length} added, ${diff.update.length} changed, ${diff.delete.length} removed, ${diff.unchanged} unchanged`,
    });
    return touchScheduleVersion();
  });
  const updatedAt = run();
  return { updatedAt, targets };
}

/* ---------------------------- Roster ---------------------------- */

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

export function computeRosterDiff(rows, { removeMissing = false } = {}) {
  /**
   * `role_id` is the display role — the lowest-sorting role a person holds —
   * derived here because the column is gone. It is what identifies a person
   * across an import ("Jordan Alvarez the dancer" vs "Jordan Alvarez the
   * judge"), and using the *set* of roles as the key instead would make
   * promoting someone to captain look like deleting them and hiring a stranger.
   */
  const people = db
    .prepare(
      `SELECT p.*, t.name AS team_name,
              (SELECT r.id FROM person_roles pr
                 JOIN roles r ON r.id = pr.role_id
                WHERE pr.person_id = p.id
                ORDER BY r.sort_order, r.label LIMIT 1) AS role_id
         FROM people p LEFT JOIN teams t ON t.id = p.team_id`
    )
    .all();
  const teams = db.prepare('SELECT * FROM teams').all();
  const contacts = db.prepare('SELECT * FROM contact_cards').all();
  const heldRoles = new Map();
  for (const r of db.prepare('SELECT person_id, role_id FROM person_roles').all()) {
    if (!heldRoles.has(r.person_id)) heldRoles.set(r.person_id, new Set());
    heldRoles.get(r.person_id).add(r.role_id);
  }

  const peopleByName = new Map(people.map((p) => [`${norm(p.name)}|${p.role_id}`, p]));
  const teamsByName = new Map(teams.map((t) => [norm(t.name), t]));
  const contactsByName = new Map(contacts.map((c) => [norm(c.name), c]));

  const createTeams = [];
  const createContacts = [];
  const createPeople = [];
  const updatePeople = [];
  let unchanged = 0;
  const seenPeople = new Set();
  const pendingTeams = new Set();
  const pendingContacts = new Set();

  for (const row of rows) {
    if (row.teamName && !teamsByName.has(norm(row.teamName)) && !pendingTeams.has(norm(row.teamName))) {
      pendingTeams.add(norm(row.teamName));
      createTeams.push({ name: row.teamName });
    }
    if (row.contact?.name && !contactsByName.has(norm(row.contact.name)) && !pendingContacts.has(norm(row.contact.name))) {
      pendingContacts.add(norm(row.contact.name));
      createContacts.push(row.contact);
    }

    const key = `${norm(row.name)}|${row.roleId}`;
    seenPeople.add(key);
    const prev = peopleByName.get(key);
    if (!prev) {
      createPeople.push({
        row,
        label: `${row.name} · ${row.roleLabel}${row.teamName ? ` · ${row.teamName}` : ''}`,
      });
      continue;
    }
    const changes = [];
    if ((prev.team_name ?? null) !== (row.teamName ?? null)) {
      changes.push(`team ${prev.team_name ?? 'none'} → ${row.teamName ?? 'none'}`);
    }
    const wanted = row.roleIds ?? [row.roleId];
    const held = heldRoles.get(prev.id) ?? new Set();
    if (wanted.length !== held.size || wanted.some((r) => !held.has(r))) {
      changes.push(`roles ${[...held].sort().join('+') || 'none'} → ${[...wanted].sort().join('+')}`);
    }
    if (row.contact?.name) {
      const prevContact = contacts.find((c) => c.id === prev.contact_id);
      if (!prevContact || norm(prevContact.name) !== norm(row.contact.name)) {
        changes.push(`contact ${prevContact?.name ?? 'none'} → ${row.contact.name}`);
      }
    }
    if (changes.length) updatePeople.push({ id: prev.id, row, changes, label: row.name });
    else unchanged++;
  }

  const removePeople = removeMissing
    ? people
        .filter((p) => !seenPeople.has(`${norm(p.name)}|${p.role_id}`))
        .map((p) => ({ id: p.id, label: `${p.name} (${p.role_id})` }))
    : [];

  return {
    createTeams,
    createContacts,
    createPeople,
    updatePeople,
    deletePeople: removePeople,
    unchanged,
    total: rows.length,
    hasChanges:
      createTeams.length +
        createContacts.length +
        createPeople.length +
        updatePeople.length +
        removePeople.length >
      0,
  };
}

export function applyRosterDiff(diff, ctx) {
  const run = db.transaction(() => {
    const teamId = (name) => {
      const found = db.prepare('SELECT id FROM teams WHERE lower(name) = lower(?)').get(name);
      if (found) return found.id;
      const id = newId('team');
      db.prepare('INSERT INTO teams (id, name) VALUES (?, ?)').run(id, name);
      return id;
    };
    const contactId = (contact) => {
      if (!contact?.name) return null;
      const found = db
        .prepare('SELECT id FROM contact_cards WHERE lower(name) = lower(?)')
        .get(contact.name);
      if (found) {
        db.prepare(
          'UPDATE contact_cards SET phone = COALESCE(?, phone), email = COALESCE(?, email) WHERE id = ?'
        ).run(contact.phone || null, contact.email || null, found.id);
        return found.id;
      }
      const id = newId('con');
      db.prepare(
        'INSERT INTO contact_cards (id, name, phone, email) VALUES (?, ?, ?, ?)'
      ).run(id, contact.name, contact.phone || null, contact.email || null);
      return id;
    };

    for (const t of diff.createTeams) teamId(t.name);
    for (const c of diff.createContacts) contactId(c);

    const setRoles = (personId, row) => {
      db.prepare('DELETE FROM person_roles WHERE person_id = ?').run(personId);
      const ins = db.prepare('INSERT INTO person_roles (person_id, role_id) VALUES (?, ?)');
      for (const roleId of row.roleIds ?? [row.roleId]) ins.run(personId, roleId);
    };

    for (const { row } of diff.createPeople) {
      const id = newId('per');
      db.prepare(
        'INSERT INTO people (id, name, team_id, contact_id) VALUES (?, ?, ?, ?)'
      ).run(id, row.name, row.teamName ? teamId(row.teamName) : null, contactId(row.contact));
      setRoles(id, row);
    }
    for (const item of diff.updatePeople) {
      db.prepare('UPDATE people SET team_id = ?, contact_id = COALESCE(?, contact_id) WHERE id = ?').run(
        item.row.teamName ? teamId(item.row.teamName) : null,
        contactId(item.row.contact),
        item.id
      );
      // Rewritten every time, so removing a `Captain?` mark actually demotes.
      setRoles(item.id, item.row);
    }
    for (const item of diff.deletePeople) {
      // Their blocks go with them, for the same reason the admin panel's delete
      // refuses to leave them: a block targeting a person who is no longer on
      // the roster is invisible to everyone and cleans itself up never. Same
      // helper as the panel — only the policy differs (it asks first, this
      // reconciles against a file and does not).
      deleteBlocksForTarget('person', item.id, { ...ctx, source: ctx.source || 'import' });
      db.prepare('DELETE FROM people WHERE id = ?').run(item.id);
    }

    logEdit({
      editedBy: ctx.editedBy,
      source: ctx.source || 'import',
      changeType: 'roster',
      summary: `Roster import: ${diff.createPeople.length} people added, ${diff.updatePeople.length} updated, ${diff.deletePeople.length} removed, ${diff.createTeams.length} teams created`,
    });
    // Roster-wide, like every other roster edit: teams and contact cards moving
    // can change what any schedule renders.
    touchRosterVersion();
    return touchScheduleVersion();
  });
  return run();
}
