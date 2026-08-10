import { db, newId, nowIso, touchScheduleVersion, touchTargets } from '../db.js';
import { describeTarget, getBlock } from './queries.js';

/* ------------------------------------------------------------------ *
 * Edit log
 * ------------------------------------------------------------------ */

/**
 * Who is affected by a change to this block. Stored on every log row so a future
 * push-notification layer can fan out "your 2pm moved" without re-deriving it.
 */
export function audienceForBlock({ appliesToType, appliesToId }) {
  if (appliesToType === 'person') {
    const p = db.prepare('SELECT team_id FROM people WHERE id = ?').get(appliesToId);
    return { personIds: [appliesToId], teamIds: p && p.team_id ? [p.team_id] : [] };
  }
  if (appliesToType === 'team') {
    const people = db.prepare('SELECT id FROM people WHERE team_id = ?').all(appliesToId);
    return { personIds: people.map((p) => p.id), teamIds: [appliesToId] };
  }
  // role — through the join table, so a captain counts in both the Dancer
  // audience and the Captain audience rather than only their display role.
  const people = db
    .prepare(
      `SELECT p.id, p.team_id FROM people p
         JOIN person_roles pr ON pr.person_id = p.id
        WHERE pr.role_id = ?`
    )
    .all(appliesToId);
  const teamIds = [...new Set(people.map((p) => p.team_id).filter(Boolean))];
  return { personIds: people.map((p) => p.id), teamIds };
}

/**
 * A batch id belongs on `ctx` — unlike `expectedUpdatedAt`, which the block
 * mutations take as their own argument precisely so it cannot ride along on a
 * spread context. The difference is that a version token is a precondition
 * belonging to one call, while "which admin action was this part of" is
 * provenance, exactly like `editedBy` and `source`, and *should* be shared
 * across every write the action makes.
 *
 * Defaulted rather than required, so a caller that does not care still produces
 * a well-formed batch of one and undo has a single shape to work with.
 */
export function batchIdFrom(ctx) {
  return ctx?.batchId || newId('batch');
}

/**
 * @param before the block as it stood, for changes that overwrote something.
 *   This is what makes the row reversible; `summary` is prose for a human and
 *   parsing it back would break the first time the wording changed.
 * @param afterVersion the `updated_at` the block ended up with — the token undo
 *   checks before touching anything, so a block edited since refuses instead of
 *   being silently rolled back over.
 */
export function logEdit({
  blockId = null,
  editedBy,
  source,
  changeType,
  summary,
  audience = null,
  before = null,
  afterVersion = null,
  batchId = null,
}) {
  const id = newId('log');
  db.prepare(
    `INSERT INTO edit_log
       (id, schedule_block_id, edited_by, source, timestamp, change_type, change_summary,
        audience_json, before_json, after_version, batch_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    blockId,
    editedBy,
    source,
    nowIso(),
    changeType,
    summary,
    audience ? JSON.stringify(audience) : null,
    before ? JSON.stringify(before) : null,
    afterVersion,
    batchId || newId('batch')
  );
  return id;
}

/* ------------------------------------------------------------------ *
 * Locations
 * ------------------------------------------------------------------ */

/** Locations are created on demand by imports; venue+sub is the natural key. */
export function ensureLocation(venue, subLocation) {
  const v = (venue || '').trim();
  const s = (subLocation || '').trim() || null;
  if (!v) return null;
  const existing = db
    .prepare(
      `SELECT id FROM locations WHERE venue_name = ?
        AND (sub_location IS ? OR sub_location = ?)`
    )
    .get(v, s, s);
  if (existing) return existing.id;
  const id = newId('loc');
  db.prepare('INSERT INTO locations (id, venue_name, sub_location) VALUES (?, ?, ?)').run(id, v, s);
  return id;
}

/* ------------------------------------------------------------------ *
 * Schedule blocks
 * ------------------------------------------------------------------ */

const BLOCK_FIELDS = [
  'day',
  'startTime',
  'endTime',
  'locationId',
  'activity',
  'appliesToType',
  'appliesToId',
  'notes',
];

function timeLabel(b) {
  return `${b.day} ${b.startTime}–${b.endTime}`;
}

export function createBlock(input, ctx) {
  const id = input.id || newId('blk');
  const ts = nowIso();
  db.prepare(
    `INSERT INTO schedule_blocks
       (id, day, start_time, end_time, location_id, activity_label,
        applies_to_type, applies_to_id, notes, source, source_key,
        created_at, updated_at, last_change)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'created')`
  ).run(
    id,
    input.day,
    input.startTime,
    input.endTime,
    input.locationId || null,
    input.activity,
    input.appliesToType,
    input.appliesToId,
    input.notes || null,
    ctx.source || 'manual',
    input.sourceKey || null,
    ts,
    ts
  );

  // Bumped here rather than in the route so that every write path — manual
  // edit, import, background re-sync — moves the same timestamps without each
  // one having to remember to.
  touchTargets([{ type: input.appliesToType, id: input.appliesToId }], ts);

  logEdit({
    blockId: id,
    editedBy: ctx.editedBy,
    source: ctx.source || 'manual',
    changeType: 'created',
    summary: `Added "${input.activity}" (${timeLabel(input)}) for ${describeTarget(
      input.appliesToType,
      input.appliesToId
    )}`,
    audience: audienceForBlock(input),
    // Nothing was overwritten, so undoing a creation is a deletion and needs no
    // prior state — only the version to check it against.
    before: null,
    afterVersion: ts,
    batchId: batchIdFrom(ctx),
  });
  return id;
}

/**
 * @param opts.expectedUpdatedAt the `updatedAt` the editor was looking at. When
 *   supplied and no longer current, nothing is written and `{ conflict: true }`
 *   comes back with the block as it now stands. Omitted by the importer, which
 *   is reconciling against a file rather than against a screen someone read.
 *
 *   Deliberately its own argument rather than a field on `ctx`: `ctx` is
 *   provenance (who, from where) and gets built once and spread across a whole
 *   batch — `applyScheduleDiff` does exactly that. A precondition that belongs
 *   to one call must not be able to ride along on it.
 */
export function updateBlock(id, input, ctx, opts = {}) {
  const before = getBlock(id);
  if (!before) return null;
  if (opts.expectedUpdatedAt && opts.expectedUpdatedAt !== before.updatedAt) {
    return { id, conflict: true, current: before };
  }

  const merged = {
    day: input.day ?? before.day,
    startTime: input.startTime ?? before.startTime,
    endTime: input.endTime ?? before.endTime,
    locationId: input.locationId !== undefined ? input.locationId : before.location?.id ?? null,
    activity: input.activity ?? before.activity,
    appliesToType: input.appliesToType ?? before.appliesTo.type,
    appliesToId: input.appliesToId ?? before.appliesTo.id,
    notes: input.notes !== undefined ? input.notes : before.notes,
  };

  const changes = [];
  if (merged.day !== before.day) changes.push(`day ${before.day} → ${merged.day}`);
  if (merged.startTime !== before.startTime || merged.endTime !== before.endTime) {
    changes.push(`time ${before.startTime}–${before.endTime} → ${merged.startTime}–${merged.endTime}`);
  }
  if ((merged.locationId || null) !== (before.location?.id ?? null)) {
    const loc = merged.locationId
      ? db.prepare('SELECT venue_name, sub_location FROM locations WHERE id = ?').get(merged.locationId)
      : null;
    const to = loc ? [loc.venue_name, loc.sub_location].filter(Boolean).join(' → ') : 'no location';
    changes.push(`location ${before.location?.display ?? 'none'} → ${to}`);
  }
  if (merged.activity !== before.activity) changes.push(`activity → "${merged.activity}"`);
  if (
    merged.appliesToType !== before.appliesTo.type ||
    merged.appliesToId !== before.appliesTo.id
  ) {
    changes.push(
      `assigned ${describeTarget(before.appliesTo.type, before.appliesTo.id)} → ${describeTarget(
        merged.appliesToType,
        merged.appliesToId
      )}`
    );
  }
  if ((merged.notes || null) !== (before.notes || null)) changes.push('notes updated');

  if (!changes.length) return { id, changed: false, targets: [] };

  const ts = nowIso();
  db.prepare(
    `UPDATE schedule_blocks
        SET day = ?, start_time = ?, end_time = ?, location_id = ?, activity_label = ?,
            applies_to_type = ?, applies_to_id = ?, notes = ?, updated_at = ?, last_change = 'updated'
      WHERE id = ?`
  ).run(
    merged.day,
    merged.startTime,
    merged.endTime,
    merged.locationId,
    merged.activity,
    merged.appliesToType,
    merged.appliesToId,
    merged.notes || null,
    ts,
    id
  );

  // Both sides of a reassignment: the team that lost the block has had their
  // schedule change too, and their "last updated" has to say so.
  touchTargets(
    [
      { type: before.appliesTo.type, id: before.appliesTo.id },
      { type: merged.appliesToType, id: merged.appliesToId },
    ],
    ts
  );

  // Both the old and new audience need to know: someone may have lost the block.
  const audience = audienceForBlock(merged);
  const priorAudience = audienceForBlock({
    appliesToType: before.appliesTo.type,
    appliesToId: before.appliesTo.id,
  });
  logEdit({
    blockId: id,
    editedBy: ctx.editedBy,
    source: ctx.source || 'manual',
    changeType: 'updated',
    summary: `Changed "${merged.activity}": ${changes.join('; ')}`,
    audience: {
      personIds: [...new Set([...audience.personIds, ...priorAudience.personIds])],
      teamIds: [...new Set([...audience.teamIds, ...priorAudience.teamIds])],
    },
    before,
    afterVersion: ts,
    batchId: batchIdFrom(ctx),
  });
  // Both targets, for the same reason the audience above merges two: reassigning
  // a block means one side gained it and the other side lost it, and telling
  // only the new owner leaves a stale block on the old owner's phone.
  return {
    id,
    changed: true,
    targets: [
      { type: before.appliesTo.type, id: before.appliesTo.id },
      { type: merged.appliesToType, id: merged.appliesToId },
    ],
  };
}

/**
 * Returns the target that lost the block, so the broadcast can reach it.
 * Honours `opts.expectedUpdatedAt` the same way `updateBlock` does — deleting a
 * block someone else has just moved is the more expensive half of the race.
 */
export function deleteBlock(id, ctx, opts = {}) {
  const before = getBlock(id);
  if (!before) return null;
  if (opts.expectedUpdatedAt && opts.expectedUpdatedAt !== before.updatedAt) {
    return { id, conflict: true, current: before };
  }
  db.prepare('DELETE FROM schedule_blocks WHERE id = ?').run(id);
  // The block is gone, so nothing carries its updated_at any more. This row is
  // the only remaining record that the target's schedule changed at all.
  touchTargets([{ type: before.appliesTo.type, id: before.appliesTo.id }]);
  logEdit({
    blockId: id,
    editedBy: ctx.editedBy,
    source: ctx.source || 'manual',
    changeType: 'deleted',
    summary: `Removed "${before.activity}" (${before.day} ${before.startTime}–${before.endTime}) for ${describeTarget(
      before.appliesTo.type,
      before.appliesTo.id
    )}`,
    audience: audienceForBlock({
      appliesToType: before.appliesTo.type,
      appliesToId: before.appliesTo.id,
    }),
    before,
    // No "after": the block is gone, and undo's precondition is that it is
    // still gone rather than that it still carries a particular version.
    afterVersion: null,
    batchId: batchIdFrom(ctx),
  });
  return { id, target: { type: before.appliesTo.type, id: before.appliesTo.id } };
}

/**
 * The ids of every block aimed at one target.
 *
 * `applies_to_id` is a polymorphic reference with no foreign key — it points at
 * teams, people or roles depending on `applies_to_type` — so SQLite cannot
 * cascade and the rule has to live here. Ids only; `blocksForTargets` in
 * queries.js is the shaped-rows counterpart for the read path.
 */
export function blockIdsForTarget(type, id) {
  return db
    .prepare('SELECT id FROM schedule_blocks WHERE applies_to_type = ? AND applies_to_id = ?')
    .all(type, id)
    .map((b) => b.id);
}

/**
 * Remove every block aimed at a target that is going away, one `deleteBlock` at
 * a time so each gets its own edit-log line with an audience — "why did my
 * airport pickup vanish" has to stay answerable afterwards.
 *
 * One rule, one home. The admin panel refuses until an admin confirms and the
 * roster importer removes silently, but *what* deleting a subject does to its
 * blocks is the same in both, and it was written twice before this.
 *
 * Call before deleting the subject row: the log summaries read the subject's
 * name, and afterwards there would only be an id to report.
 */
export function deleteBlocksForTarget(type, id, ctx) {
  const targets = [];
  for (const blockId of blockIdsForTarget(type, id)) {
    const removed = deleteBlock(blockId, ctx);
    if (removed) targets.push(removed.target);
  }
  return targets;
}

/**
 * "Changed" highlights are transient. Clients compute their own per-user diff,
 * but the stored flag lets the admin list show what the last sync touched.
 */
export function clearChangeFlags(olderThanMinutes = 30) {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000).toISOString();
  db.prepare(
    'UPDATE schedule_blocks SET last_change = NULL WHERE last_change IS NOT NULL AND updated_at < ?'
  ).run(cutoff);
}

export { touchScheduleVersion, BLOCK_FIELDS };
