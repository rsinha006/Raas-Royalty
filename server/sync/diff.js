import { db, newId, touchScheduleVersion } from '../db.js';
import { describeTarget, listAllBlocks } from '../lib/queries.js';
import { createBlock, deleteBlock, ensureLocation, logEdit, updateBlock } from '../lib/mutations.js';

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

export function applyScheduleDiff(diff, ctx) {
  const source = ctx.source || 'import';
  const run = db.transaction(() => {
    for (const { row } of diff.create) {
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
      updateBlock(
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
      db.prepare('UPDATE schedule_blocks SET source = ?, source_key = ? WHERE id = ?').run(
        source,
        item.row.sourceKey,
        item.id
      );
    }
    for (const item of diff.delete) {
      deleteBlock(item.id, { ...ctx, source });
    }

    logEdit({
      editedBy: ctx.editedBy,
      source,
      changeType: 'sync',
      summary: `${ctx.label || 'Spreadsheet import'}: ${diff.create.length} added, ${diff.update.length} changed, ${diff.delete.length} removed, ${diff.unchanged} unchanged`,
    });
    return touchScheduleVersion();
  });
  return run();
}

/* ---------------------------- Roster ---------------------------- */

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

export function computeRosterDiff(rows, { removeMissing = false } = {}) {
  const people = db
    .prepare('SELECT p.*, t.name AS team_name FROM people p LEFT JOIN teams t ON t.id = p.team_id')
    .all();
  const teams = db.prepare('SELECT * FROM teams').all();
  const contacts = db.prepare('SELECT * FROM contact_cards').all();

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

    for (const { row } of diff.createPeople) {
      db.prepare(
        'INSERT INTO people (id, name, role_id, team_id, contact_id) VALUES (?, ?, ?, ?, ?)'
      ).run(
        newId('per'),
        row.name,
        row.roleId,
        row.teamName ? teamId(row.teamName) : null,
        contactId(row.contact)
      );
    }
    for (const item of diff.updatePeople) {
      db.prepare('UPDATE people SET team_id = ?, contact_id = COALESCE(?, contact_id) WHERE id = ?').run(
        item.row.teamName ? teamId(item.row.teamName) : null,
        contactId(item.row.contact),
        item.id
      );
    }
    for (const item of diff.deletePeople) {
      db.prepare('DELETE FROM people WHERE id = ?').run(item.id);
    }

    logEdit({
      editedBy: ctx.editedBy,
      source: ctx.source || 'import',
      changeType: 'roster',
      summary: `Roster import: ${diff.createPeople.length} people added, ${diff.updatePeople.length} updated, ${diff.deletePeople.length} removed, ${diff.createTeams.length} teams created`,
    });
    return touchScheduleVersion();
  });
  return run();
}
