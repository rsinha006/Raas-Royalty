/**
 * Access codes — generation, lookup, revocation, and roster backfill.
 *
 * This module owns codes as *data*. It does not enforce anything: nothing here
 * decides whether a request is allowed. That is item 6, and until it lands
 * these codes are decorative — `/api/schedule` is still open and
 * `/api/bootstrap` still returns the whole roster.
 *
 * Who gets a code, per docs/decisions.md:
 *
 *   teams   — one each, shared within the team by design. A dancer enters the
 *             team code and then picks their own name, which is what makes
 *             person-targeted blocks (airport pickups) reach them.
 *   staff   — one each: board, liaison, judge, videographer. Roles whose
 *             selector is 'person'.
 *   dancers — none. They reach their schedule through their team's code, so an
 *             individual dancer code would be ~190 extra live credentials
 *             nobody distributes and nobody revokes.
 *   roles   — supported but never issued automatically. A role code exposes
 *             every holder's schedule to anyone with it, so it is an explicit
 *             admin choice for a group with nothing personal on their schedule
 *             (sponsors), not a default.
 */
import crypto from 'node:crypto';
import { db, nowIso } from '../db.js';
import { logEdit } from './mutations.js';

/**
 * No 0/O, no 1/I/L — the pairs people mistype off a printed card. U is out too,
 * so a random run is less likely to spell something unfortunate. 30 characters.
 */
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * 30^8 ≈ 6.6e11. Longer than the "short, typeable" sketch in PLAN.md on
 * purpose: the code is normally delivered as a link and typed only when someone
 * is setting up a second device, so the extra two characters cost almost
 * nothing — and they mean a bug in the item 6 rate limiter is not by itself
 * enough to enumerate the roster.
 */
export const CODE_LENGTH = 8;

const SUBJECT_TYPES = new Set(['team', 'person', 'role']);

/** Cryptographically random. Math.random() here would be a real vulnerability. */
export function generateCode(length = CODE_LENGTH) {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  }
  return out;
}

/**
 * Canonical form of whatever the user typed, or null if it can't be one.
 *
 * Spaces and dashes are forgiven because people add them when reading a code
 * aloud or off paper. Anything else is rejected rather than stripped: silently
 * dropping an unexpected character turns a typo into a different valid-looking
 * code, and the user gets "not found" with no idea why.
 */
export function normalizeCode(input) {
  if (typeof input !== 'string') return null;
  const cleaned = input.trim().toUpperCase().replace(/[\s\-_]+/g, '');
  if (cleaned.length !== CODE_LENGTH) return null;
  for (const ch of cleaned) {
    if (!CODE_ALPHABET.includes(ch)) return null;
  }
  return cleaned;
}

function assertSubject(subjectType, subjectId) {
  if (!SUBJECT_TYPES.has(subjectType)) {
    throw new Error(`unknown subject type: ${subjectType}`);
  }
  if (!subjectId || typeof subjectId !== 'string') {
    throw new Error('subject id is required');
  }
}

/* ------------------------------------------------------------------ *
 * Lookup
 * ------------------------------------------------------------------ */

/**
 * Resolve a code to its subject. Returns revoked codes too, with `revokedAt`
 * set — the landing page has to tell "revoked" apart from "never existed", and
 * the caller decides what to do about it.
 */
export function lookupCode(input) {
  const code = normalizeCode(input);
  if (!code) return null;
  const row = db.prepare('SELECT * FROM access_codes WHERE code = ?').get(code);
  return row ? shape(row) : null;
}

export function codeForSubject(subjectType, subjectId) {
  assertSubject(subjectType, subjectId);
  const row = db
    .prepare(
      `SELECT * FROM access_codes
        WHERE subject_type = ? AND subject_id = ? AND revoked_at IS NULL`
    )
    .get(subjectType, subjectId);
  return row ? shape(row) : null;
}

/** Records that a code was actually used. Cheap, and it drives "never used" in item 8. */
export function touchCodeUsed(code) {
  db.prepare('UPDATE access_codes SET last_used_at = ? WHERE code = ?').run(nowIso(), code);
}

function shape(row) {
  return {
    code: row.code,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    note: row.note,
  };
}

/**
 * Every code with the subject's current display name resolved. `subjectLabel`
 * is null when the subject has been deleted — an orphan, which item 8 should
 * show and offer to clean up.
 */
export function listCodes({ includeRevoked = false } = {}) {
  const rows = db
    .prepare(
      `SELECT c.*,
              CASE c.subject_type
                WHEN 'team'   THEN t.name
                WHEN 'person' THEN p.name
                WHEN 'role'   THEN r.label
              END AS subject_label,
              pr.label AS person_role_label,
              pt.name  AS person_team_name
         FROM access_codes c
         LEFT JOIN teams  t  ON c.subject_type = 'team'   AND t.id = c.subject_id
         LEFT JOIN people p  ON c.subject_type = 'person' AND p.id = c.subject_id
         LEFT JOIN roles  r  ON c.subject_type = 'role'   AND r.id = c.subject_id
         LEFT JOIN roles  pr ON pr.id = p.role_id
         LEFT JOIN teams  pt ON pt.id = p.team_id
        ${includeRevoked ? '' : 'WHERE c.revoked_at IS NULL'}
        ORDER BY c.subject_type, subject_label`
    )
    .all();
  return rows.map((row) => ({
    ...shape(row),
    subjectLabel: row.subject_label,
    roleLabel: row.person_role_label,
    teamName: row.person_team_name,
    orphaned: row.subject_label === null,
  }));
}

/* ------------------------------------------------------------------ *
 * Issue and revoke
 * ------------------------------------------------------------------ */

export function revokeCode(code, ctx = {}) {
  const existing = db.prepare('SELECT * FROM access_codes WHERE code = ?').get(code);
  if (!existing || existing.revoked_at) return false;
  db.prepare('UPDATE access_codes SET revoked_at = ? WHERE code = ?').run(nowIso(), code);
  logEdit({
    editedBy: ctx.editedBy || 'system',
    source: ctx.source || 'access-codes',
    changeType: 'code_revoked',
    summary: `Revoked access code for ${existing.subject_type} ${existing.subject_id}`,
  });
  return true;
}

/**
 * Issue a code, replacing whatever that subject had. Revoke-then-insert rather
 * than update, so the old code stays on the table and a leaked-code question
 * ("was it used before we killed it?") is still answerable.
 *
 * Idempotent by default: a subject that already has a live code keeps it, so
 * re-running the backfill never invalidates links that have gone out already.
 * Pass `regenerate: true` for the one-click rotate in item 8.
 */
export function issueCode({ subjectType, subjectId, note = null, regenerate = false }, ctx = {}) {
  assertSubject(subjectType, subjectId);

  const current = codeForSubject(subjectType, subjectId);
  if (current && !regenerate) return current;
  if (current) revokeCode(current.code, ctx);

  const insert = db.prepare(
    `INSERT INTO access_codes (code, subject_type, subject_id, created_at, note)
     VALUES (?, ?, ?, ?, ?)`
  );

  // Retry on the vanishingly unlikely collision rather than trusting the odds.
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = generateCode();
    try {
      insert.run(code, subjectType, subjectId, nowIso(), note);
      logEdit({
        editedBy: ctx.editedBy || 'system',
        source: ctx.source || 'access-codes',
        changeType: regenerate ? 'code_regenerated' : 'code_issued',
        summary: `${regenerate ? 'Regenerated' : 'Issued'} access code for ${subjectType} ${subjectId}`,
      });
      return codeForSubject(subjectType, subjectId);
    } catch (err) {
      if (!String(err.message).includes('UNIQUE')) throw err;
      // A duplicate on `code` means try again; a duplicate on the one-active
      // index means someone raced us, and their code is as good as ours.
      if (String(err.message).includes('idx_access_codes_one_active')) {
        return codeForSubject(subjectType, subjectId);
      }
    }
  }
  throw new Error('could not generate a unique access code after 10 attempts');
}

/* ------------------------------------------------------------------ *
 * Backfill
 * ------------------------------------------------------------------ */

/**
 * Everyone who should hold a code: teams, plus people in roles that identify an
 * individual. Dancers are excluded by their role's `selector` being 'team' —
 * which is the same field the landing page uses, so adding a role needs no
 * change here.
 */
export function subjectsNeedingCodes({ includeDancers = false } = {}) {
  const teams = db
    .prepare('SELECT id, name FROM teams ORDER BY name')
    .all()
    .map((t) => ({ subjectType: 'team', subjectId: t.id, label: t.name }));

  const people = db
    .prepare(
      `SELECT p.id, p.name, r.label AS role_label
         FROM people p
         JOIN roles r ON r.id = p.role_id
        ${includeDancers ? '' : "WHERE r.selector = 'person'"}
        ORDER BY r.sort_order, p.name`
    )
    .all()
    .map((p) => ({
      subjectType: 'person',
      subjectId: p.id,
      label: `${p.name} (${p.role_label})`,
    }));

  return [...teams, ...people];
}

/**
 * Give every subject that should have a code one, without touching subjects
 * that already do. Safe to run on every boot and on an already-populated
 * database — which is what makes it the migration for the existing roster.
 */
export function backfillAccessCodes(opts = {}, ctx = {}) {
  const wanted = subjectsNeedingCodes(opts);
  const run = db.transaction(() => {
    let created = 0;
    let kept = 0;
    for (const s of wanted) {
      const before = codeForSubject(s.subjectType, s.subjectId);
      issueCode({ subjectType: s.subjectType, subjectId: s.subjectId }, ctx);
      if (before) kept++;
      else created++;
    }
    return { created, kept, total: wanted.length };
  });
  return run();
}

/** Live codes pointing at a subject that no longer exists. */
export function orphanedCodes() {
  return listCodes().filter((c) => c.orphaned);
}
