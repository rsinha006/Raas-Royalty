import crypto from 'node:crypto';
import express from 'express';
import multer from 'multer';

import { db, newId, touchScheduleVersion, touchRosterVersion, getMeta } from '../db.js';
import {
  checkPassword,
  clearSession,
  currentAdmin,
  editorName,
  issueSession,
  requireAdmin,
  resetThrottle,
  throttle,
  usingDefaultPassword,
} from '../lib/auth.js';
import {
  describeTarget,
  listAllBlocks,
  listContacts,
  listDays,
  listEditLog,
  listLocations,
  listPeople,
  listRoles,
  listTeams,
} from '../lib/queries.js';
import {
  blockIdsForTarget,
  createBlock,
  deleteBlock,
  deleteBlocksForTarget,
  ensureLocation,
  logEdit,
  updateBlock,
} from '../lib/mutations.js';
import { ingest, pullAndSync, syncStatus } from '../sync/index.js';
import { parseNamedSheets } from '../sync/parse.js';
import {
  ROSTER_SHEETS,
  ROSTER_TEMPLATE,
  SCHEDULE_TEMPLATE,
  normalizeRosterSheets,
} from '../sync/normalize.js';
import { applyRosterDiff, computeRosterDiff } from '../sync/diff.js';
import { uploadSource } from '../sync/sources.js';
import { adminCodesRouter } from './admin-codes.js';
import { adminOpsRouter } from './admin-ops.js';
import { previewFor } from '../lib/view-as.js';
import { applyUndo, listBatches, planUndo } from '../lib/undo.js';
import { listCodes, missingSubjects } from '../lib/access-codes.js';
import { eventTimeState } from '../lib/event-time.js';
import { roomsForTargets } from '../lib/live.js';
import {
  MAX_SHIFT_BLOCKS,
  MAX_SHIFT_MINUTES,
  describeShift,
  parseClock,
  planMoves,
  resolveShiftEntries,
  selectShiftCandidates,
} from '../lib/time-shift.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

/**
 * Uploaded files are held server-side between the preview and the confirm step
 * so that what an admin approved is byte-for-byte what gets applied.
 */
const pending = new Map();
const PENDING_TTL = 30 * 60_000;

function stashPending(kind, buffer, filename) {
  const token = crypto.randomBytes(12).toString('hex');
  pending.set(token, { kind, buffer, filename, at: Date.now() });
  for (const [k, v] of pending) if (Date.now() - v.at > PENDING_TTL) pending.delete(k);
  return token;
}

function takePending(token, kind) {
  const rec = pending.get(token);
  if (!rec || rec.kind !== kind) return null;
  pending.delete(token);
  return rec;
}

const csvEscape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

export function adminRouter({ broadcast }) {
  const router = express.Router();

  /* ---------------------------------------------------------------- *
   * Session
   * ---------------------------------------------------------------- */

  router.post('/login', (req, res) => {
    const ip = req.ip || 'unknown';
    if (throttle(ip)) {
      return res.status(429).json({ error: 'Too many attempts. Wait a few minutes.' });
    }
    if (!checkPassword(req.body?.password)) {
      return res.status(401).json({ error: 'Incorrect password' });
    }
    resetThrottle(ip);
    const name = String(req.body?.name || '').trim() || 'admin';
    issueSession(res, { name });
    res.json({ ok: true, admin: { name }, defaultPassword: usingDefaultPassword() });
  });

  router.post('/logout', (req, res) => {
    clearSession(res);
    res.json({ ok: true });
  });

  router.get('/session', (req, res) => {
    const admin = currentAdmin(req);
    res.json({ admin: admin ? { name: admin.name } : null, defaultPassword: usingDefaultPassword() });
  });

  // Everything below requires a valid admin cookie.
  router.use(requireAdmin);

  /**
   * One request is one batch.
   *
   * Undo reverts a batch rather than a log row, because a bulk shift undone a
   * row at a time is the half-shifted day item 15 refuses to create. Stamping
   * it here rather than per route means every write a request makes shares it —
   * including the ones that are *not* reversible, which is the point: deleting
   * a person writes block-delete rows and a roster row into the same batch, and
   * undo refuses the batch because that roster row is in it. Threading the id
   * by hand would eventually miss one, and the failure would be restoring
   * blocks that point at a person who no longer exists.
   */
  router.use((req, res, next) => {
    req.batchId = newId('batch');
    next();
  });

  /**
   * Provenance for a write: who, from where, and which admin action.
   * `source` is 'manual' for a hand-edited block and 'admin' for a panel action
   * that moves several at once — a distinction the change log has always drawn.
   */
  const editorContext = (req, source = 'admin') => ({
    editedBy: editorName(req),
    source,
    batchId: req.batchId,
  });

  /* ---------------------------------------------------------------- *
   * Access codes
   * ---------------------------------------------------------------- */

  router.use('/codes', adminCodesRouter());

  /* ---------------------------------------------------------------- *
   * Ops — snapshots, errors, the alert path (item 23)
   * ---------------------------------------------------------------- */

  router.use('/ops', adminOpsRouter());

  /* ---------------------------------------------------------------- *
   * Overview
   * ---------------------------------------------------------------- */

  router.get('/overview', (req, res) => {
    const count = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    const liveCodes = listCodes();
    res.json({
      // Surfaced so the configured zone can be eyeballed against the venue at
      // deploy — a wrong one shifts every schedule silently.
      eventTime: eventTimeState(),
      codes: {
        live: liveCodes.length,
        neverUsed: liveCodes.filter((c) => !c.lastUsedAt).length,
        missing: missingSubjects().length,
      },
      counts: {
        people: count('people'),
        teams: count('teams'),
        contacts: count('contact_cards'),
        blocks: count('schedule_blocks'),
        roles: count('roles'),
        seedBlocks: db
          .prepare("SELECT COUNT(*) AS n FROM schedule_blocks WHERE source = 'seed'")
          .get().n,
      },
      updatedAt: getMeta('schedule_updated_at'),
      sync: syncStatus(),
      templates: { schedule: SCHEDULE_TEMPLATE, roster: ROSTER_TEMPLATE },
    });
  });

  /* ---------------------------------------------------------------- *
   * Roster reads
   * ---------------------------------------------------------------- */

  router.get('/roster', (req, res) => {
    res.json({
      roles: listRoles({ includeInactive: true }),
      teams: listTeams(),
      people: listPeople(),
      contacts: listContacts(),
      days: listDays(),
      locations: listLocations(),
    });
  });

  /* ---------------------------------------------------------------- *
   * Roster writes
   * ---------------------------------------------------------------- */

  /**
   * Roster changes go to everyone, and deliberately so: a renamed team, a
   * reassigned contact card or a new role changes what several unrelated
   * schedules render, and there is no block to derive an audience from.
   *
   * `refreshRooms` is the other half — moving a dancer between teams changes
   * which rooms their already-open socket belongs in, and without this they
   * would keep hearing their old team's changes until they reloaded.
   *
   * `touchRosterVersion` is the "last updated" counterpart: with no block to
   * derive an audience from, a roster edit raises the floor under everyone's
   * timestamp rather than any one target's.
   */
  const rosterChanged = (req, summary) => {
    logEdit({ ...editorContext(req), changeType: 'roster', summary });
    touchRosterVersion();
    const ts = touchScheduleVersion();
    broadcast('roster:updated', { updatedAt: ts }, { refreshRooms: true });
    return ts;
  };

  /**
   * Roles arrive as a set. `roleId` is still accepted as a one-element
   * shorthand, because a single role is the case for everyone except captains
   * and it keeps every existing caller — including the roster importer —
   * working unchanged.
   */
  const readRoleIds = (body) => {
    const raw = Array.isArray(body?.roleIds)
      ? body.roleIds
      : body?.roleId !== undefined
        ? [body.roleId]
        : null;
    if (!raw) return null;
    return [...new Set(raw.map((r) => String(r || '').trim()).filter(Boolean))];
  };

  /** Rejects unknown ids up front, so a typo can't leave someone role-less. */
  const unknownRoles = (roleIds) =>
    roleIds.filter((id) => !db.prepare('SELECT 1 FROM roles WHERE id = ?').get(id));

  const setPersonRoles = (personId, roleIds) => {
    db.prepare('DELETE FROM person_roles WHERE person_id = ?').run(personId);
    const ins = db.prepare('INSERT INTO person_roles (person_id, role_id) VALUES (?, ?)');
    for (const roleId of roleIds) ins.run(personId, roleId);
  };

  router.post('/people', (req, res) => {
    const { name, teamId, contactId } = req.body || {};
    const roleIds = readRoleIds(req.body);
    if (!name || !roleIds?.length) {
      return res.status(400).json({ error: 'name and at least one role are required' });
    }
    const unknown = unknownRoles(roleIds);
    if (unknown.length) return res.status(400).json({ error: `Unknown role(s): ${unknown.join(', ')}` });

    const id = newId('per');
    db.transaction(() => {
      db.prepare('INSERT INTO people (id, name, team_id, contact_id) VALUES (?, ?, ?, ?)').run(
        id,
        String(name).trim(),
        teamId || null,
        contactId || null
      );
      setPersonRoles(id, roleIds);
    })();
    rosterChanged(req, `Added ${name} to the roster`);
    res.json({ ok: true, id });
  });

  router.patch('/people/:id', (req, res) => {
    const prev = db.prepare('SELECT * FROM people WHERE id = ?').get(req.params.id);
    if (!prev) return res.status(404).json({ error: 'Not found' });

    const roleIds = readRoleIds(req.body);
    if (roleIds && !roleIds.length) {
      // Someone with no roles has no role-targeted blocks and no way to be
      // reached by one — a state worth refusing rather than saving.
      return res.status(400).json({ error: 'A person needs at least one role' });
    }
    if (roleIds) {
      const unknown = unknownRoles(roleIds);
      if (unknown.length) {
        return res.status(400).json({ error: `Unknown role(s): ${unknown.join(', ')}` });
      }
    }

    const next = {
      name: req.body.name ?? prev.name,
      teamId: req.body.teamId !== undefined ? req.body.teamId || null : prev.team_id,
      contactId: req.body.contactId !== undefined ? req.body.contactId || null : prev.contact_id,
    };
    db.transaction(() => {
      db.prepare('UPDATE people SET name = ?, team_id = ?, contact_id = ? WHERE id = ?').run(
        next.name,
        next.teamId,
        next.contactId,
        req.params.id
      );
      if (roleIds) setPersonRoles(req.params.id, roleIds);
    })();
    rosterChanged(req, `Updated roster entry for ${next.name}`);
    res.json({ ok: true });
  });

  /**
   * Deleting a subject used to leave its blocks behind, pointing at an id
   * nothing resolves. Those blocks are invisible to every participant — no
   * session has that target — but they still count in the admin totals, still
   * render as "Unknown person (per_xyz)", and would still be there at 1pm
   * Saturday when someone is trying to work out why the numbers don't add up.
   *
   * So the delete is refused, with the count, until the caller says what to do
   * about them. The count comes from the moment of deletion rather than from a
   * page load, which matters when the panel has been open for an hour.
   */
  const blocksPending = (subjectLabel, count) => ({
    error: `${subjectLabel} still has ${count} schedule block(s) assigned. Deleting leaves them pointing at nobody.`,
    reason: 'has-blocks',
    blockCount: count,
  });

  const confirmedCascade = (req) => req.query.removeBlocks === '1';

  router.delete('/people/:id', (req, res) => {
    const prev = db.prepare('SELECT * FROM people WHERE id = ?').get(req.params.id);
    if (!prev) return res.status(404).json({ error: 'Not found' });

    const blockIds = blockIdsForTarget('person', req.params.id);
    if (blockIds.length && !confirmedCascade(req)) {
      return res.status(409).json(blocksPending(prev.name, blockIds.length));
    }

    db.transaction(() => {
      deleteBlocksForTarget('person', req.params.id, editorContext(req));
      db.prepare('DELETE FROM people WHERE id = ?').run(req.params.id);
    })();

    // One broadcast, not two: `rosterChanged` already wakes every client and
    // re-derives socket rooms, which a deleted person needs anyway.
    rosterChanged(
      req,
      `Removed ${prev.name} from the roster${blockIds.length ? ` and their ${blockIds.length} schedule block(s)` : ''}`
    );
    res.json({ ok: true, removedBlocks: blockIds.length });
  });

  router.post('/teams', (req, res) => {
    const { name, liaisonContactId } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name is required' });
    const id = newId('team');
    try {
      db.prepare('INSERT INTO teams (id, name, liaison_contact_id) VALUES (?, ?, ?)').run(
        id,
        String(name).trim(),
        liaisonContactId || null
      );
    } catch {
      return res.status(409).json({ error: `A team named "${name}" already exists` });
    }
    rosterChanged(req, `Created team ${name}`);
    res.json({ ok: true, id });
  });

  router.patch('/teams/:id', (req, res) => {
    const prev = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id);
    if (!prev) return res.status(404).json({ error: 'Not found' });
    const name = req.body.name ?? prev.name;
    const liaison =
      req.body.liaisonContactId !== undefined
        ? req.body.liaisonContactId || null
        : prev.liaison_contact_id;

    let showOrder = prev.show_order;
    if (req.body.showOrder !== undefined) {
      const raw = req.body.showOrder;
      if (raw === null || raw === '') {
        showOrder = null;
      } else {
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 1) {
          return res.status(400).json({ error: 'Running order must be a whole number from 1, or blank' });
        }
        showOrder = n;
      }
    }

    try {
      db.prepare(
        'UPDATE teams SET name = ?, liaison_contact_id = ?, show_order = ? WHERE id = ?'
      ).run(name, liaison, showOrder, req.params.id);
    } catch (err) {
      // SQLite names the column, not the index, in a partial-unique violation.
      if (String(err.message).includes('teams.show_order')) {
        const clash = db
          .prepare('SELECT name FROM teams WHERE show_order = ? AND id != ?')
          .get(showOrder, req.params.id);
        return res
          .status(409)
          .json({ error: `${clash?.name ?? 'Another team'} is already ${showOrder} in the running order` });
      }
      throw err;
    }
    rosterChanged(req, `Updated team ${name}`);
    res.json({ ok: true });
  });

  router.delete('/teams/:id', (req, res) => {
    const prev = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id);
    if (!prev) return res.status(404).json({ error: 'Not found' });
    const members = db.prepare('SELECT COUNT(*) AS n FROM people WHERE team_id = ?').get(req.params.id).n;

    /**
     * Only the team's own blocks. Its dancers are unassigned rather than
     * deleted (`people.team_id` is ON DELETE SET NULL), so their
     * person-targeted blocks still resolve and still belong to them — an
     * airport pickup does not stop existing because the team was renamed
     * through a delete-and-recreate.
     */
    const blockIds = blockIdsForTarget('team', req.params.id);
    if (blockIds.length && !confirmedCascade(req)) {
      return res.status(409).json(blocksPending(prev.name, blockIds.length));
    }

    db.transaction(() => {
      deleteBlocksForTarget('team', req.params.id, editorContext(req));
      db.prepare('DELETE FROM teams WHERE id = ?').run(req.params.id);
    })();

    rosterChanged(
      req,
      `Deleted team ${prev.name}${members ? ` (${members} dancers unassigned)` : ''}${
        blockIds.length ? ` and its ${blockIds.length} schedule block(s)` : ''
      }`
    );
    res.json({ ok: true, unassigned: members, removedBlocks: blockIds.length });
  });

  router.post('/contacts', (req, res) => {
    const { name, title, phone, email, note } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name is required' });
    const id = newId('con');
    db.prepare(
      'INSERT INTO contact_cards (id, name, title, phone, email, note) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, String(name).trim(), title || null, phone || null, email || null, note || null);
    rosterChanged(req, `Added contact card for ${name}`);
    res.json({ ok: true, id });
  });

  router.patch('/contacts/:id', (req, res) => {
    const prev = db.prepare('SELECT * FROM contact_cards WHERE id = ?').get(req.params.id);
    if (!prev) return res.status(404).json({ error: 'Not found' });
    const f = (k, col) => (req.body[k] !== undefined ? req.body[k] || null : prev[col]);
    db.prepare(
      'UPDATE contact_cards SET name = ?, title = ?, phone = ?, email = ?, note = ? WHERE id = ?'
    ).run(
      req.body.name ?? prev.name,
      f('title', 'title'),
      f('phone', 'phone'),
      f('email', 'email'),
      f('note', 'note'),
      req.params.id
    );
    rosterChanged(req, `Updated contact card for ${req.body.name ?? prev.name}`);
    res.json({ ok: true });
  });

  router.delete('/contacts/:id', (req, res) => {
    const prev = db.prepare('SELECT * FROM contact_cards WHERE id = ?').get(req.params.id);
    if (!prev) return res.status(404).json({ error: 'Not found' });
    db.prepare('DELETE FROM contact_cards WHERE id = ?').run(req.params.id);
    rosterChanged(req, `Deleted contact card for ${prev.name}`);
    res.json({ ok: true });
  });

  /* ---- Roles are data: admins can add new ones without a deploy ---- */

  router.post('/roles', (req, res) => {
    const { id, label, selector, blurb, sortOrder } = req.body || {};
    if (!label || !['team', 'person'].includes(selector)) {
      return res.status(400).json({ error: 'label and selector ("team" or "person") are required' });
    }
    const roleId = (id || label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    try {
      db.prepare(
        'INSERT INTO roles (id, label, selector, blurb, sort_order, active) VALUES (?, ?, ?, ?, ?, 1)'
      ).run(roleId, label, selector, blurb || null, Number(sortOrder) || 99);
    } catch {
      return res.status(409).json({ error: `Role "${roleId}" already exists` });
    }
    rosterChanged(req, `Created role ${label}`);
    res.json({ ok: true, id: roleId });
  });

  router.patch('/roles/:id', (req, res) => {
    const prev = db.prepare('SELECT * FROM roles WHERE id = ?').get(req.params.id);
    if (!prev) return res.status(404).json({ error: 'Not found' });
    db.prepare(
      'UPDATE roles SET label = ?, selector = ?, blurb = ?, sort_order = ?, active = ? WHERE id = ?'
    ).run(
      req.body.label ?? prev.label,
      req.body.selector ?? prev.selector,
      req.body.blurb !== undefined ? req.body.blurb || null : prev.blurb,
      req.body.sortOrder !== undefined ? Number(req.body.sortOrder) : prev.sort_order,
      req.body.active !== undefined ? (req.body.active ? 1 : 0) : prev.active,
      req.params.id
    );
    rosterChanged(req, `Updated role ${req.body.label ?? prev.label}`);
    res.json({ ok: true });
  });

  /* ---- Event days ---- */

  router.patch('/days/:key', (req, res) => {
    const prev = db.prepare('SELECT * FROM event_days WHERE key = ?').get(req.params.key);
    if (!prev) return res.status(404).json({ error: 'Not found' });
    db.prepare('UPDATE event_days SET label = ?, date = ? WHERE key = ?').run(
      req.body.label ?? prev.label,
      req.body.date ?? prev.date,
      req.params.key
    );
    rosterChanged(req, `Updated ${prev.key} to ${req.body.date ?? prev.date}`);
    res.json({ ok: true });
  });

  /* ---------------------------------------------------------------- *
   * Schedule blocks — manual editing
   * ---------------------------------------------------------------- */

  /**
   * @param targets the block targets this change touched. Omitted means "could
   *   be anyone" and wakes every client — the pre-item-11 behaviour, now the
   *   exception rather than the rule.
   */
  const scheduleChanged = (extra = {}, targets = null) => {
    const ts = touchScheduleVersion();
    broadcast(
      'schedule:updated',
      { updatedAt: ts, ...extra },
      targets ? { rooms: roomsForTargets(targets) } : {}
    );
    return ts;
  };

  router.get('/blocks', (req, res) => {
    res.json({ blocks: listAllBlocks({ day: req.query.day || null }), locations: listLocations() });
  });

  router.post('/blocks', (req, res) => {
    const b = req.body || {};
    const missing = ['day', 'startTime', 'endTime', 'activity', 'appliesToType', 'appliesToId'].filter(
      (k) => !b[k]
    );
    if (missing.length) return res.status(400).json({ error: `Missing: ${missing.join(', ')}` });

    const locationId = b.locationId || ensureLocation(b.venue, b.subLocation);
    const id = createBlock(
      { ...b, locationId },
      editorContext(req, 'manual')
    );
    const updatedAt = scheduleChanged({ changedBlockIds: [id] }, [
      { type: b.appliesToType, id: b.appliesToId },
    ]);
    res.json({ ok: true, id, updatedAt });
  });

  /**
   * Two admins editing the same block used to be silently last-write-wins: the
   * second save overwrote the first with no sign either had happened, and the
   * only trace was two edit-log lines nobody was reading at the time.
   *
   * The editor sends the `updatedAt` it loaded; a mismatch means the block moved
   * under it. 409 with the block as it now stands, so the panel can say what it
   * would have overwritten rather than just refusing.
   *
   * Deliberately not applied to imports — those reconcile against a file, not
   * against a screen someone read, and `sourceKey` already decides what they own.
   */
  const conflict = (res, current) =>
    res.status(409).json({
      error: 'Someone else changed this block while you had it open.',
      reason: 'conflict',
      current,
    });

  router.patch('/blocks/:id', (req, res) => {
    const b = req.body || {};
    const patch = { ...b };
    delete patch.expectedUpdatedAt; // a concurrency token, not a block field
    if (b.venue !== undefined || b.subLocation !== undefined) {
      patch.locationId = ensureLocation(b.venue, b.subLocation);
    }
    const result = updateBlock(
      req.params.id,
      patch,
      editorContext(req, 'manual'),
      { expectedUpdatedAt: b.expectedUpdatedAt || null }
    );
    if (!result) return res.status(404).json({ error: 'Not found' });
    if (result.conflict) return conflict(res, result.current);
    const updatedAt = result.changed
      ? scheduleChanged({ changedBlockIds: [req.params.id] }, result.targets)
      : undefined;
    res.json({ ok: true, changed: result.changed, updatedAt });
  });

  router.delete('/blocks/:id', (req, res) => {
    const removed = deleteBlock(
      req.params.id,
      editorContext(req, 'manual'),
      // On the query string because DELETE request bodies are not reliably
      // sent by intermediaries.
      { expectedUpdatedAt: req.query.expectedUpdatedAt || null }
    );
    if (!removed) return res.status(404).json({ error: 'Not found' });
    if (removed.conflict) return conflict(res, removed.current);
    const updatedAt = scheduleChanged({ removedBlockIds: [req.params.id] }, [removed.target]);
    res.json({ ok: true, updatedAt });
  });

  /* ---------------------------------------------------------------- *
   * Schedule blocks — bulk time shift
   *
   * Two steps on purpose, the same shape as an import: preview what would
   * move, then apply the list that was actually looked at. The apply takes
   * explicit block ids rather than re-deriving them from the day and cutoff,
   * so a block someone else added in between cannot be swept into a change
   * nobody reviewed.
   * ---------------------------------------------------------------- */

  /** Returns the number, or a message saying why it isn't usable. */
  const readShiftMinutes = (raw) => {
    const minutes = Number(raw);
    if (!Number.isInteger(minutes) || minutes === 0) {
      return { error: 'Shift by a whole number of minutes, either direction.' };
    }
    if (Math.abs(minutes) > MAX_SHIFT_MINUTES) {
      return {
        error: `That is more than ${MAX_SHIFT_MINUTES / 60} hours. Re-import the day rather than shifting it.`,
      };
    }
    return { minutes };
  };

  router.post('/blocks/shift/preview', (req, res) => {
    const { day, fromTime } = req.body || {};
    const { minutes, error } = readShiftMinutes(req.body?.minutes);
    if (error) return res.status(400).json({ error });
    if (!day) return res.status(400).json({ error: 'Pick a day to shift.' });
    if (parseClock(fromTime) === null) {
      return res.status(400).json({ error: 'Give a start time to shift from, as HH:MM.' });
    }

    const candidates = selectShiftCandidates({ day, fromTime });
    if (candidates.length > MAX_SHIFT_BLOCKS) {
      return res.status(400).json({ error: `That selects more than ${MAX_SHIFT_BLOCKS} blocks.` });
    }
    const { moves, blocked } = planMoves(candidates, minutes);
    res.json({ ok: true, day, fromTime, minutes, moves, blocked });
  });

  router.post('/blocks/shift', (req, res) => {
    const { minutes, error } = readShiftMinutes(req.body?.minutes);
    if (error) return res.status(400).json({ error });

    const entries = Array.isArray(req.body?.blocks) ? req.body.blocks : [];
    if (!entries.length) return res.status(400).json({ error: 'No blocks selected.' });
    if (entries.length > MAX_SHIFT_BLOCKS) {
      return res.status(400).json({ error: `Shift at most ${MAX_SHIFT_BLOCKS} blocks at a time.` });
    }
    // Unconditional here, unlike a single block edit: every caller of this route
    // is a screen someone read a list off, and the whole point of the preview is
    // that what was approved is what gets applied.
    if (entries.some((e) => !e?.expectedUpdatedAt)) {
      return res.status(400).json({ error: 'Every block must carry the version it was previewed at.' });
    }

    /**
     * Every precondition is checked before anything is written. Half a day's
     * schedule 20 minutes away from the other half — with nothing on screen
     * saying which half is which — is worse than a refusal an admin can act on.
     */
    const { blocks, missing, conflicts } = resolveShiftEntries(entries);
    if (missing.length) {
      return res.status(409).json({
        error: `${missing.length} of those block(s) have been deleted since you previewed. Nothing was moved.`,
        reason: 'missing',
        missing,
      });
    }
    if (conflicts.length) {
      return res.status(409).json({
        error: `Someone else changed ${conflicts.length} of those block(s) while you were previewing. Nothing was moved.`,
        reason: 'conflict',
        conflicts,
      });
    }

    const { moves, blocked } = planMoves(blocks, minutes);
    if (blocked.length) {
      return res.status(409).json({
        error: `${blocked.length} of those block(s) cannot move by that much. Nothing was moved.`,
        reason: 'blocked',
        blocked,
      });
    }

    const ctx = editorContext(req);
    // One transaction, and each block through `updateBlock` — so every move gets
    // its own edit-log line with an audience and moves its target's timestamp.
    // "Why did my 3pm move" has to stay answerable per block, not just per batch.
    const targets = db.transaction(() =>
      moves.flatMap((m) => {
        const result = updateBlock(
          m.id,
          { day: m.to.day, startTime: m.to.startTime, endTime: m.to.endTime },
          ctx,
          { expectedUpdatedAt: m.updatedAt }
        );
        // Unreachable in practice — better-sqlite3 is synchronous, so nothing
        // can land between the check above and here — but a throw rolls the
        // whole shift back, which is the behaviour to fail towards.
        if (!result || result.conflict) throw new Error('A block changed mid-shift; nothing was moved.');
        return result.targets;
      })
    )();

    // The summary is what an admin scans the log for; the per-block lines above
    // are what they drill into once they have found it.
    logEdit({
      ...ctx,
      changeType: 'updated',
      summary: describeShift(moves, minutes),
    });

    const updatedAt = scheduleChanged({ changedBlockIds: moves.map((m) => m.id) }, targets);
    res.json({ ok: true, moved: moves.length, moves, updatedAt });
  });

  /* ---------------------------------------------------------------- *
   * Import + sync
   * ---------------------------------------------------------------- */

  router.get('/sync/status', (req, res) => res.json(syncStatus()));

  /** Step 1: upload and preview. Nothing is written. */
  router.post('/schedule/import/preview', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const removeMissing = req.body.removeMissing !== 'false';
    try {
      const result = await ingest(req.file.buffer, req.file.originalname, {
        dryRun: true,
        removeMissing,
      });
      if (!result.ok) return res.status(400).json(result);
      const token = stashPending('schedule', req.file.buffer, req.file.originalname);
      res.json({ ...result, token, filename: req.file.originalname, removeMissing });
    } catch (err) {
      res.status(400).json({ error: `Could not read that file: ${err.message}` });
    }
  });

  /** Step 2: apply the previewed file. */
  router.post('/schedule/import/commit', async (req, res) => {
    const rec = takePending(req.body?.token, 'schedule');
    if (!rec) return res.status(410).json({ error: 'That preview expired. Upload the file again.' });
    try {
      const result = await ingest(rec.buffer, rec.filename, {
        dryRun: false,
        removeMissing: req.body.removeMissing !== false,
        editedBy: editorName(req),
        batchId: req.batchId,
        source: 'import',
        label: `Import of ${rec.filename}`,
      });
      if (!result.ok) return res.status(400).json(result);
      uploadSource.remember(rec.buffer, rec.filename);
      broadcast(
        'schedule:updated',
        { updatedAt: result.updatedAt, reason: 'import' },
        { rooms: roomsForTargets(result.targets) }
      );
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  /** Fallback trigger for the live sheet connection (and re-runs the last upload today). */
  router.post('/schedule/resync', async (req, res) => {
    try {
      const result = await pullAndSync({ editedBy: editorName(req), batchId: req.batchId });
      broadcast(
        'schedule:updated',
        { updatedAt: result.updatedAt, reason: 'resync' },
        { rooms: roomsForTargets(result.targets) }
      );
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  /**
   * Placeholder blocks aren't part of any import's managed set, so a first real
   * import would sit alongside them rather than replace them. This clears them
   * in one step once the real schedule has landed.
   *
   * Why they are unmanaged, and why that is correct: an import owns exactly the
   * blocks carrying a `source_key`, and `computeScheduleDiff` starts from
   * `listAllBlocks().filter(b => b.sourceKey)`. Seed blocks are written with a
   * null key, so they are invisible to the diff — including to `removeMissing`,
   * which is the point. An import that adopted them would be an import that can
   * silently delete anything an admin added by hand, since manual blocks have no
   * key either. Pinned by a test; if item 12 ever starts writing keyed seed
   * rows, that test is what will say so.
   */
  router.delete('/seed-data', (req, res) => {
    const seeded = db.prepare("SELECT id FROM schedule_blocks WHERE source = 'seed'").all();
    if (!seeded.length) return res.json({ ok: true, removed: 0 });

    // Through `deleteBlock` rather than one DELETE statement, so each removal
    // lands in the edit log with its audience and moves its target's timestamp.
    // Clearing ~250 placeholder blocks is otherwise a single unattributable
    // line saying everyone's schedule emptied. ~18ms at 110 blocks, and this
    // runs once, before real data lands.
    const targets = db.transaction(() =>
      seeded
        .map((b) => deleteBlock(b.id, editorContext(req)))
        .filter(Boolean)
        .map((removed) => removed.target)
    )();

    logEdit({
      ...editorContext(req),
      changeType: 'deleted',
      summary: `Cleared ${seeded.length} placeholder schedule block(s)`,
    });
    // A count, not the ids: no client reads the id list, and shipping ~250 of
    // them to every affected socket is pure weight ahead of the refetch that
    // actually carries the change.
    const updatedAt = scheduleChanged({ removedCount: seeded.length }, targets);
    res.json({ ok: true, removed: seeded.length, updatedAt });
  });

  /* ---- Roster import: same two-step shape ---- */

  router.post('/roster/import/preview', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    try {
      const sheets = await parseNamedSheets(req.file.buffer, req.file.originalname, ROSTER_SHEETS);
      if (!sheets.length) {
        return res.status(400).json({
          error: `That workbook has no ${ROSTER_SHEETS.join(' or ')} tab. Upload the event template, or a single-sheet CSV.`,
        });
      }
      const { rows, errors } = normalizeRosterSheets(sheets);
      const diff = computeRosterDiff(rows, { removeMissing: req.body.removeMissing === 'true' });
      const token = stashPending('roster', req.file.buffer, req.file.originalname);
      res.json({
        ok: true,
        token,
        filename: req.file.originalname,
        sheetNames: sheets.map((s) => s.sheetName).filter(Boolean),
        headers: sheets[0].headers,
        parsedRows: sheets.reduce((n, s) => n + s.rows.length, 0),
        validRows: rows.length,
        errors,
        diff,
        removeMissing: req.body.removeMissing === 'true',
      });
    } catch (err) {
      res.status(400).json({ error: `Could not read that file: ${err.message}` });
    }
  });

  router.post('/roster/import/commit', async (req, res) => {
    const rec = takePending(req.body?.token, 'roster');
    if (!rec) return res.status(410).json({ error: 'That preview expired. Upload the file again.' });
    try {
      const sheets = await parseNamedSheets(rec.buffer, rec.filename, ROSTER_SHEETS);
      const { rows, errors } = normalizeRosterSheets(sheets);
      if (!rows.length) {
        return res.status(400).json({ error: 'Every row failed validation — nothing was applied.', errors });
      }
      const diff = computeRosterDiff(rows, { removeMissing: req.body.removeMissing === true });
      const updatedAt = applyRosterDiff(diff, {
        editedBy: editorName(req),
        source: 'import',
        batchId: req.batchId,
      });
      broadcast('roster:updated', { updatedAt });
      res.json({ ok: true, diff, errors, updatedAt });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  /* ---------------------------------------------------------------- *
   * Templates + log
   * ---------------------------------------------------------------- */

  router.get('/templates/:kind.csv', (req, res) => {
    const kind = req.params.kind;
    const tpl = kind === 'roster' ? ROSTER_TEMPLATE : SCHEDULE_TEMPLATE;
    const header = tpl.columns.map((c) => csvEscape(c.name)).join(',');
    const sample =
      kind === 'roster'
        ? [
            ['Jordan Alvarez', 'Dancer', 'Kinetic Motion', '', 'Sam Okafor / +1-555-0102'],
            ['Priya Raman', 'Dancer', 'Kinetic Motion', 'Y', 'Sam Okafor / +1-555-0102'],
          ]
        : [
            ['Sat', '13:00', '13:12', 'Main Venue', 'Main Stage', 'PERFORMANCE', 'Kinetic Motion', 'Hard cut at 12 min', ''],
            ['Sat', '09:00', '09:30', 'Main Venue', 'Main Stage', 'Call time & safety brief', 'All Dancers', '', ''],
          ];
    const body = sample.map((r) => r.map(csvEscape).join(',')).join('\n');
    res.type('text/csv').attachment(`royalty-${kind}-template.csv`).send(`${header}\n${body}\n`);
  });

  router.get('/log', (req, res) => {
    res.json({ entries: listEditLog({ limit: Number(req.query.limit) || 200 }) });
  });

  /* ---------------------------------------------------------------- *
   * Undo
   * ---------------------------------------------------------------- */

  /** Recent admin actions, newest first, each carrying whether it can be undone. */
  router.get('/undo', (req, res) => {
    res.json({ batches: listBatches({ limit: Number(req.query.limit) || 40 }) });
  });

  /**
   * What undoing this would do — the per-block reversals and anything in the
   * way. Same shape as item 15's shift preview and for the same reason: putting
   * a schedule back mid-event deserves a look before the leap, and the blockers
   * are more useful than a greyed-out button.
   */
  router.get('/undo/:batchId', (req, res) => {
    const plan = planUndo(req.params.batchId);
    if (!plan) return res.status(404).json({ error: 'No such change.' });
    res.json(plan);
  });

  router.post('/undo', (req, res) => {
    const batchId = String(req.body?.batchId || '');
    if (!batchId) return res.status(400).json({ error: 'Which change?' });

    const result = applyUndo(batchId, editorContext(req));
    if (!result.ok) {
      if (result.reason === 'missing' && !result.plan) {
        return res.status(404).json({ error: 'No such change.' });
      }
      // 409, not 400: the request was fine, the world moved. Same status the
      // block editor and the bulk shift return for the same situation.
      return res.status(409).json({
        error: result.plan.blockers[0].label,
        reason: result.reason,
        blockers: result.plan.blockers,
      });
    }

    const updatedAt = scheduleChanged(
      { changedBlockIds: result.changedBlockIds, reason: 'undo' },
      result.targets
    );
    res.json({ ok: true, undone: result.undone, summary: result.plan.summary, updatedAt });
  });

  /**
   * "View as" — the exact schedule one subject sees, plus why.
   *
   * This is the one admin read that takes a subject id from the caller, which
   * is fine because it sits behind `requireAdmin` and an admin can already read
   * every block and every person through `/roster` and `/blocks`. It discloses
   * nothing new; it assembles what is already reachable into the shape the
   * person on the phone is looking at.
   *
   * Deliberately no access *code* in the response. "Is there a live code" is
   * the diagnostic; producing the link is the Access codes tab's job, and
   * keeping one place that shows credentials is worth a tab switch.
   */
  router.get('/view-as', (req, res) => {
    const type = String(req.query.type || '');
    const id = String(req.query.id || '');
    if (!['team', 'person', 'role'].includes(type) || !id) {
      return res.status(400).json({ error: 'Expected type=team|person|role and id.' });
    }
    const preview = previewFor({ type, id });
    // "Nothing scheduled" and "no such person" are the two answers this tool
    // must never blur, so a missing subject is a 404 rather than an empty day.
    if (!preview) return res.status(404).json({ error: 'That subject is no longer in the roster.' });
    res.json(preview);
  });

  /** Convenience for the manual editor: every possible assignment target. */
  router.get('/targets', (req, res) => {
    const targets = [
      // First, because an announcement is the one target chosen under pressure.
      { type: 'everyone', id: 'all', label: 'Everyone at the event', group: 'Everyone' },
      ...listRoles().map((r) => ({ type: 'role', id: r.id, label: `All ${r.label}`, group: 'Roles' })),
      ...listTeams().map((t) => ({ type: 'team', id: t.id, label: t.name, group: 'Teams' })),
      ...listPeople().map((p) => ({
        type: 'person',
        id: p.id,
        label: p.teamName ? `${p.name} (${p.teamName})` : p.name,
        group: 'People',
      })),
    ];
    res.json({ targets });
  });

  return router;
}

export { describeTarget };
