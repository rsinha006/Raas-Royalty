/**
 * Undo — item 17.
 *
 * The edit log recorded everything and could reverse none of it, because what
 * it stored was prose: `Changed "Team warm-up": time 15:00–15:30 → 15:20–15:50`.
 * Parsing that back into fields would work until someone reworded a summary, and
 * then it would fail quietly. So the log now carries the block's prior state and
 * the version it ended up with, and this module replays it backwards.
 *
 * Three properties, each of which is the reason for a chunk of what follows:
 *
 * **Undo works on a batch, never on a row.** One admin action is one batch —
 * stamped per request by the admin router — so undoing a 17-block shift undoes
 * all 17. Undoing one of them would leave half a day 20 minutes from the other
 * half, which is exactly the state item 15 refuses to create.
 *
 * **Every precondition is checked before anything is written.** A block someone
 * else has edited since refuses the whole batch rather than being rolled back
 * over. Same stance as items 14 and 15: a refusal an admin can act on beats a
 * silent overwrite of work they never saw.
 *
 * **The reversal goes through the ordinary mutations.** `createBlock`,
 * `updateBlock` and `deleteBlock` do the writing, so an undo logs, broadcasts,
 * bumps `target_versions` and honours the concurrency guard exactly as a hand
 * edit does — and is itself a batch, so it can be undone in turn.
 */
import { db } from '../db.js';
import { getBlock } from './queries.js';
import { createBlock, deleteBlock, logEdit, updateBlock } from './mutations.js';

/**
 * Sources an undo will touch.
 *
 * Imports are deliberately absent, and not because the mechanism could not run
 * on them. An import owns its rows through `source_key`, which `updateBlock`
 * does not carry — so a reverted import would keep the file's ownership while
 * showing the old contents, and the next background poll would put it straight
 * back. An undo that silently re-does itself a minute later is worse than no
 * undo. The way to reverse an import is to fix the sheet and re-sync, which is
 * what the one-pipeline design is for. Roster imports go further still: they
 * delete people, which nothing logs and nothing here could restore.
 */
const UNDOABLE_SOURCES = new Set(['manual', 'admin']);

/**
 * Change types a row with no block id is allowed to have.
 *
 * A batch's summary line — the bulk shift's "18 blocks moved 20 minutes later",
 * the placeholder clear's count — is narration over block rows that are all
 * present in the same batch, so skipping it loses nothing. Any other blockless
 * row stands for work the log does not describe: `roster` accompanies a deleted
 * person, `code_revoked` a credential. Those make the whole batch irreversible,
 * which is the point of checking rather than assuming.
 */
const NARRATION_TYPES = new Set(['created', 'updated', 'deleted']);

const shapeRow = (r) => ({
  id: r.id,
  blockId: r.schedule_block_id || null,
  editedBy: r.edited_by,
  source: r.source,
  timestamp: r.timestamp,
  changeType: r.change_type,
  summary: r.change_summary,
  audience: r.audience_json ? JSON.parse(r.audience_json) : null,
  before: r.before_json ? JSON.parse(r.before_json) : null,
  afterVersion: r.after_version || null,
  batchId: r.batch_id,
  undoneAt: r.undone_at || null,
});

function rowsInBatch(batchId) {
  return db
    .prepare('SELECT * FROM edit_log WHERE batch_id = ? ORDER BY timestamp, rowid')
    .all(batchId)
    .map(shapeRow);
}

/* ------------------------------------------------------------------ *
 * Planning
 * ------------------------------------------------------------------ */

/**
 * What undoing this batch would do, and everything standing in the way.
 *
 * Returns null for a batch that does not exist. Otherwise always returns a
 * plan — `blockers` being empty is what makes it applicable, and the panel
 * shows the blockers rather than a bare "cannot undo".
 */
export function planUndo(batchId) {
  const rows = rowsInBatch(batchId);
  if (!rows.length) return null;

  const head = rows[0];
  const plan = {
    batchId,
    at: head.timestamp,
    editedBy: head.editedBy,
    source: head.source,
    summary: describeBatch(rows),
    steps: [],
    blockers: [],
    undoneAt: rows.find((r) => r.undoneAt)?.undoneAt ?? null,
  };

  if (plan.undoneAt) {
    plan.blockers.push({ reason: 'undone', label: 'This change has already been undone.' });
    return plan;
  }

  for (const row of rows) {
    if (!UNDOABLE_SOURCES.has(row.source)) {
      plan.blockers.push({
        reason: 'source',
        label:
          row.source === 'seed'
            ? 'Placeholder data is not undoable.'
            : 'Imports are reversed by fixing the spreadsheet and re-syncing, not here.',
      });
      continue;
    }

    if (!row.blockId) {
      if (!NARRATION_TYPES.has(row.changeType)) {
        plan.blockers.push({
          reason: 'irreversible',
          label: `This action also changed the roster ("${row.summary}"), which cannot be put back.`,
        });
      }
      continue; // narration
    }

    const step = planStep(row);
    if (step.blocker) plan.blockers.push(step.blocker);
    else plan.steps.push(step);
  }

  if (!plan.steps.length && !plan.blockers.length) {
    plan.blockers.push({ reason: 'nothing', label: 'Nothing in this entry can be put back.' });
  }
  return plan;
}

/**
 * One row, reversed — and the reason it cannot be, if it cannot.
 *
 * The three cases are symmetric: a creation is undone by deleting, a deletion by
 * re-creating with the same id, an update by writing the prior fields back. Each
 * one first asserts the world is still as that row left it.
 */
function planStep(row) {
  const current = getBlock(row.blockId);
  const name = row.before?.activity ?? current?.activity ?? row.blockId;

  if (row.changeType === 'created') {
    if (!current) {
      return {
        blocker: {
          reason: 'missing',
          blockId: row.blockId,
          label: `"${name}" has already been deleted since.`,
        },
      };
    }
    if (current.updatedAt !== row.afterVersion) {
      return { blocker: changedSince(row.blockId, name) };
    }
    return { logId: row.id, blockId: row.blockId, action: 'delete', label: `Remove "${name}"` };
  }

  if (row.changeType === 'deleted') {
    if (!row.before) return { blocker: noState(row.blockId, name) };
    if (current) {
      return {
        blocker: {
          reason: 'exists',
          blockId: row.blockId,
          label: `"${name}" has been re-created since.`,
        },
      };
    }
    /**
     * A restored block carries its original `source_key` back with it, and that
     * column is uniquely indexed. If an import has since claimed the same key
     * for a different row, the insert would throw mid-transaction; naming it
     * here turns that into a refusal an admin can read.
     */
    if (row.before.sourceKey) {
      const holder = db
        .prepare('SELECT id FROM schedule_blocks WHERE source_key = ?')
        .get(row.before.sourceKey);
      if (holder) {
        return {
          blocker: {
            reason: 'source-key',
            blockId: row.blockId,
            label: `"${name}" cannot be restored — the spreadsheet row it came from is now a different block.`,
          },
        };
      }
    }
    return { logId: row.id, blockId: row.blockId, action: 'recreate', label: `Restore "${name}"` };
  }

  if (row.changeType === 'updated') {
    if (!row.before) return { blocker: noState(row.blockId, name) };
    if (!current) {
      return {
        blocker: {
          reason: 'missing',
          blockId: row.blockId,
          label: `"${name}" has been deleted since.`,
        },
      };
    }
    if (current.updatedAt !== row.afterVersion) {
      return { blocker: changedSince(row.blockId, name) };
    }
    return {
      logId: row.id,
      blockId: row.blockId,
      action: 'restore',
      label: `Put "${name}" back to ${row.before.day} ${row.before.startTime}–${row.before.endTime}`,
    };
  }

  return { blocker: noState(row.blockId, name) };
}

const changedSince = (blockId, name) => ({
  reason: 'changed',
  blockId,
  label: `"${name}" has been changed by someone else since. Nothing was put back.`,
});

const noState = (blockId, name) => ({
  reason: 'no-state',
  blockId,
  // Rows written before the log carried state — see migrate.js. Honest rather
  // than clever: nothing recorded what they overwrote. Kept short because on an
  // upgraded database this is every historical row, and the summary beside it
  // already names the block.
  label: 'No earlier version was recorded.',
  activity: name,
});

/**
 * A sentence for the batch, preferring its own summary line if it wrote one.
 *
 * A row with no block id *is* the summary line by construction — the shift's
 * "18 blocks moved", the roster delete's "Removed Maya and their 3 blocks" —
 * so it is the right headline whether or not the batch turns out to be
 * undoable. Especially then: the one an admin most needs to read is the one
 * they cannot reverse.
 */
function describeBatch(rows) {
  const summaryLine = rows.find((r) => !r.blockId);
  if (summaryLine) return summaryLine.summary;
  if (rows.length === 1) return rows[0].summary;
  return `${rows.length} changes by ${rows[0].editedBy}`;
}

/* ------------------------------------------------------------------ *
 * Applying
 * ------------------------------------------------------------------ */

/**
 * Revert a batch, or refuse it whole.
 *
 * `{ ok: false }` carries the plan so the caller can say which block is in the
 * way. On success the targets are what the broadcast needs — every side of
 * every reversal, including the one a reassignment moved a block away from.
 */
export function applyUndo(batchId, ctx) {
  const plan = planUndo(batchId);
  if (!plan) return { ok: false, reason: 'missing', plan: null };
  if (plan.blockers.length) return { ok: false, reason: plan.blockers[0].reason, plan };

  const rows = new Map(rowsInBatch(batchId).map((r) => [r.id, r]));
  const targets = [];
  const changedBlockIds = [];

  const run = db.transaction(() => {
    /**
     * Backwards. Within one batch a block is normally touched once, so the
     * order rarely matters — but when it is touched twice, replaying forwards
     * would restore the older state and then the newer one, landing exactly
     * where the batch started rather than where it began.
     */
    for (const step of [...plan.steps].reverse()) {
      const row = rows.get(step.logId);
      const result = reverse(step, row, ctx);
      // Unreachable given the checks above — better-sqlite3 is synchronous, so
      // nothing can land in between — but a throw rolls the whole batch back,
      // which is the direction to fail in.
      if (!result) throw new Error('A block changed mid-undo; nothing was put back.');
      targets.push(...result.targets);
      changedBlockIds.push(step.blockId);
    }
    /**
     * A summary line of its own, so the undo reads as one action in the log
     * rather than as N unexplained edits — and so undoing *it* has a headline
     * someone can recognise. Written after the reversals, like the bulk
     * shift's, and derived from what actually moved.
     */
    logEdit({
      editedBy: ctx.editedBy,
      source: ctx.source || 'admin',
      batchId: ctx.batchId,
      changeType: 'updated',
      summary: `Put back: ${plan.summary}`,
    });
    db.prepare('UPDATE edit_log SET undone_at = ? WHERE batch_id = ?').run(
      new Date().toISOString(),
      batchId
    );
  });
  run();

  return { ok: true, plan, targets, changedBlockIds, undone: plan.steps.length };
}

function reverse(step, row, ctx) {
  if (step.action === 'delete') {
    const removed = deleteBlock(step.blockId, ctx, { expectedUpdatedAt: row.afterVersion });
    if (!removed || removed.conflict) return null;
    return { targets: [removed.target] };
  }

  if (step.action === 'recreate') {
    const b = row.before;
    createBlock(
      {
        id: b.id,
        day: b.day,
        startTime: b.startTime,
        endTime: b.endTime,
        locationId: b.location?.id ?? null,
        activity: b.activity,
        appliesToType: b.appliesTo.type,
        appliesToId: b.appliesTo.id,
        notes: b.notes,
        sourceKey: b.sourceKey,
      },
      ctx
    );
    return { targets: [{ type: b.appliesTo.type, id: b.appliesTo.id }] };
  }

  const b = row.before;
  const result = updateBlock(
    step.blockId,
    {
      day: b.day,
      startTime: b.startTime,
      endTime: b.endTime,
      locationId: b.location?.id ?? null,
      activity: b.activity,
      appliesToType: b.appliesTo.type,
      appliesToId: b.appliesTo.id,
      notes: b.notes,
    },
    ctx,
    { expectedUpdatedAt: row.afterVersion }
  );
  if (!result || result.conflict) return null;
  return { targets: result.targets };
}

/* ------------------------------------------------------------------ *
 * Listing
 * ------------------------------------------------------------------ */

/**
 * Recent batches, newest first, each with whether it can be undone.
 *
 * The panel needs the verdict up front — an Undo button that only sometimes
 * works is worse than one that is visibly absent — so this plans every batch
 * rather than reporting a count and making the panel ask.
 */
export function listBatches({ limit = 40 } = {}) {
  const ids = db
    .prepare(
      `SELECT batch_id, MAX(timestamp) AS at
         FROM edit_log
        GROUP BY batch_id
        ORDER BY at DESC, batch_id DESC
        LIMIT ?`
    )
    .all(limit);

  return ids.map(({ batch_id: batchId }) => {
    const plan = planUndo(batchId);
    const rows = rowsInBatch(batchId);
    return {
      batchId,
      at: plan.at,
      editedBy: plan.editedBy,
      source: plan.source,
      summary: plan.summary,
      entries: rows.map((r) => ({
        id: r.id,
        summary: r.summary,
        changeType: r.changeType,
        timestamp: r.timestamp,
        audience: r.audience,
      })),
      undoneAt: plan.undoneAt,
      canUndo: plan.blockers.length === 0,
      blockers: plan.blockers,
      steps: plan.steps.length,
    };
  });
}
