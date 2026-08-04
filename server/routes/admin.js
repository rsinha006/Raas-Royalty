import crypto from 'node:crypto';
import express from 'express';
import multer from 'multer';

import { db, newId, touchScheduleVersion, getMeta } from '../db.js';
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
import { createBlock, deleteBlock, ensureLocation, logEdit, updateBlock } from '../lib/mutations.js';
import { ingest, pullAndSync, syncStatus } from '../sync/index.js';
import { parseTabular } from '../sync/parse.js';
import {
  ROSTER_TEMPLATE,
  SCHEDULE_TEMPLATE,
  normalizeRosterRows,
} from '../sync/normalize.js';
import { applyRosterDiff, computeRosterDiff } from '../sync/diff.js';
import { uploadSource } from '../sync/sources.js';

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

  /* ---------------------------------------------------------------- *
   * Overview
   * ---------------------------------------------------------------- */

  router.get('/overview', (req, res) => {
    const count = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    res.json({
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

  const rosterChanged = (req, summary) => {
    logEdit({ editedBy: editorName(req), source: 'admin', changeType: 'roster', summary });
    const ts = touchScheduleVersion();
    broadcast('roster:updated', { updatedAt: ts });
    return ts;
  };

  router.post('/people', (req, res) => {
    const { name, roleId, teamId, contactId } = req.body || {};
    if (!name || !roleId) return res.status(400).json({ error: 'name and roleId are required' });
    const id = newId('per');
    db.prepare('INSERT INTO people (id, name, role_id, team_id, contact_id) VALUES (?, ?, ?, ?, ?)').run(
      id,
      String(name).trim(),
      roleId,
      teamId || null,
      contactId || null
    );
    rosterChanged(req, `Added ${name} to the roster`);
    res.json({ ok: true, id });
  });

  router.patch('/people/:id', (req, res) => {
    const prev = db.prepare('SELECT * FROM people WHERE id = ?').get(req.params.id);
    if (!prev) return res.status(404).json({ error: 'Not found' });
    const next = {
      name: req.body.name ?? prev.name,
      roleId: req.body.roleId ?? prev.role_id,
      teamId: req.body.teamId !== undefined ? req.body.teamId || null : prev.team_id,
      contactId: req.body.contactId !== undefined ? req.body.contactId || null : prev.contact_id,
    };
    db.prepare('UPDATE people SET name = ?, role_id = ?, team_id = ?, contact_id = ? WHERE id = ?').run(
      next.name,
      next.roleId,
      next.teamId,
      next.contactId,
      req.params.id
    );
    rosterChanged(req, `Updated roster entry for ${next.name}`);
    res.json({ ok: true });
  });

  router.delete('/people/:id', (req, res) => {
    const prev = db.prepare('SELECT * FROM people WHERE id = ?').get(req.params.id);
    if (!prev) return res.status(404).json({ error: 'Not found' });
    const orphaned = db
      .prepare("SELECT COUNT(*) AS n FROM schedule_blocks WHERE applies_to_type = 'person' AND applies_to_id = ?")
      .get(req.params.id).n;
    db.prepare('DELETE FROM people WHERE id = ?').run(req.params.id);
    rosterChanged(
      req,
      `Removed ${prev.name} from the roster${orphaned ? ` (${orphaned} schedule block(s) still reference them)` : ''}`
    );
    res.json({ ok: true, orphanedBlocks: orphaned });
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
    db.prepare('UPDATE teams SET name = ?, liaison_contact_id = ? WHERE id = ?').run(
      name,
      liaison,
      req.params.id
    );
    rosterChanged(req, `Updated team ${name}`);
    res.json({ ok: true });
  });

  router.delete('/teams/:id', (req, res) => {
    const prev = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id);
    if (!prev) return res.status(404).json({ error: 'Not found' });
    const members = db.prepare('SELECT COUNT(*) AS n FROM people WHERE team_id = ?').get(req.params.id).n;
    db.prepare('DELETE FROM teams WHERE id = ?').run(req.params.id);
    rosterChanged(req, `Deleted team ${prev.name}${members ? ` (${members} dancers unassigned)` : ''}`);
    res.json({ ok: true, unassigned: members });
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

  const scheduleChanged = (extra = {}) => {
    const ts = touchScheduleVersion();
    broadcast('schedule:updated', { updatedAt: ts, ...extra });
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
      { editedBy: editorName(req), source: 'manual' }
    );
    const updatedAt = scheduleChanged({ changedBlockIds: [id] });
    res.json({ ok: true, id, updatedAt });
  });

  router.patch('/blocks/:id', (req, res) => {
    const b = req.body || {};
    const patch = { ...b };
    if (b.venue !== undefined || b.subLocation !== undefined) {
      patch.locationId = ensureLocation(b.venue, b.subLocation);
    }
    const result = updateBlock(req.params.id, patch, {
      editedBy: editorName(req),
      source: 'manual',
    });
    if (!result) return res.status(404).json({ error: 'Not found' });
    const updatedAt = result.changed ? scheduleChanged({ changedBlockIds: [req.params.id] }) : undefined;
    res.json({ ok: true, changed: result.changed, updatedAt });
  });

  router.delete('/blocks/:id', (req, res) => {
    const ok = deleteBlock(req.params.id, { editedBy: editorName(req), source: 'manual' });
    if (!ok) return res.status(404).json({ error: 'Not found' });
    const updatedAt = scheduleChanged({ removedBlockIds: [req.params.id] });
    res.json({ ok: true, updatedAt });
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
        source: 'import',
        label: `Import of ${rec.filename}`,
      });
      if (!result.ok) return res.status(400).json(result);
      uploadSource.remember(rec.buffer, rec.filename);
      broadcast('schedule:updated', { updatedAt: result.updatedAt, reason: 'import' });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  /** Fallback trigger for the live sheet connection (and re-runs the last upload today). */
  router.post('/schedule/resync', async (req, res) => {
    try {
      const result = await pullAndSync({ editedBy: editorName(req) });
      broadcast('schedule:updated', { updatedAt: result.updatedAt, reason: 'resync' });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  /**
   * Placeholder blocks aren't part of any import's managed set, so a first real
   * import would sit alongside them rather than replace them. This clears them
   * in one step once the real schedule has landed.
   */
  router.delete('/seed-data', (req, res) => {
    const rows = db.prepare("SELECT COUNT(*) AS n FROM schedule_blocks WHERE source = 'seed'").get().n;
    if (!rows) return res.json({ ok: true, removed: 0 });
    db.prepare("DELETE FROM schedule_blocks WHERE source = 'seed'").run();
    logEdit({
      editedBy: editorName(req),
      source: 'admin',
      changeType: 'deleted',
      summary: `Cleared ${rows} placeholder schedule block(s)`,
    });
    const updatedAt = scheduleChanged();
    res.json({ ok: true, removed: rows, updatedAt });
  });

  /* ---- Roster import: same two-step shape ---- */

  router.post('/roster/import/preview', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    try {
      const parsed = await parseTabular(req.file.buffer, req.file.originalname);
      const { rows, errors } = normalizeRosterRows(parsed.rows);
      const diff = computeRosterDiff(rows, { removeMissing: req.body.removeMissing === 'true' });
      const token = stashPending('roster', req.file.buffer, req.file.originalname);
      res.json({
        ok: true,
        token,
        filename: req.file.originalname,
        headers: parsed.headers,
        parsedRows: parsed.rows.length,
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
      const parsed = await parseTabular(rec.buffer, rec.filename);
      const { rows, errors } = normalizeRosterRows(parsed.rows);
      if (!rows.length) {
        return res.status(400).json({ error: 'Every row failed validation — nothing was applied.', errors });
      }
      const diff = computeRosterDiff(rows, { removeMissing: req.body.removeMissing === true });
      const updatedAt = applyRosterDiff(diff, { editedBy: editorName(req), source: 'import' });
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
        ? [['Jordan Alvarez', 'Dancer', 'Kinetic Motion', 'Sam Okafor / +1-555-0102']]
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

  /** Convenience for the manual editor: every possible assignment target. */
  router.get('/targets', (req, res) => {
    const targets = [
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
