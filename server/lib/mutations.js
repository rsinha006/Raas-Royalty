import { db, newId, nowIso, touchScheduleVersion } from '../db.js';
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

export function logEdit({
  blockId = null,
  editedBy,
  source,
  changeType,
  summary,
  audience = null,
}) {
  const id = newId('log');
  db.prepare(
    `INSERT INTO edit_log
       (id, schedule_block_id, edited_by, source, timestamp, change_type, change_summary, audience_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    blockId,
    editedBy,
    source,
    nowIso(),
    changeType,
    summary,
    audience ? JSON.stringify(audience) : null
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
  });
  return id;
}

export function updateBlock(id, input, ctx) {
  const before = getBlock(id);
  if (!before) return null;

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

  if (!changes.length) return { id, changed: false };

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
    nowIso(),
    id
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
  });
  return { id, changed: true };
}

export function deleteBlock(id, ctx) {
  const before = getBlock(id);
  if (!before) return false;
  db.prepare('DELETE FROM schedule_blocks WHERE id = ?').run(id);
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
  });
  return true;
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
