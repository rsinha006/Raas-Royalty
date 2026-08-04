import { getMeta, setMeta } from '../db.js';
import { parseTabular } from './parse.js';
import { normalizeScheduleRows } from './normalize.js';
import { applyScheduleDiff, computeScheduleDiff } from './diff.js';
import { getActiveSource, sourceStatus, uploadSource } from './sources.js';

/**
 * The one pipeline every schedule change flows through:
 *
 *   bytes → parseTabular → normalizeScheduleRows → computeScheduleDiff → apply
 *
 * Upload, Force Re-sync, and background polling all call `ingest`. When the live
 * Sheets connection is switched on, nothing here changes.
 */

export async function ingest(buffer, filename, opts = {}) {
  const { dryRun = true, removeMissing = true, editedBy = 'admin', source = 'import', label } =
    opts;

  const parsed = await parseTabular(buffer, filename);
  if (!parsed.rows.length) {
    return {
      ok: false,
      error: 'No data rows found. Check that the first row is the header row.',
      headers: parsed.headers,
    };
  }

  const { rows, errors } = normalizeScheduleRows(parsed.rows);
  const diff = computeScheduleDiff(rows, { removeMissing });

  const result = {
    ok: true,
    dryRun,
    headers: parsed.headers,
    parsedRows: parsed.rows.length,
    validRows: rows.length,
    errors,
    diff: {
      create: diff.create.map((c) => ({ label: c.label })),
      update: diff.update.map((u) => ({ id: u.id, label: u.label, changes: u.changes })),
      delete: diff.delete,
      unchanged: diff.unchanged,
      hasChanges: diff.hasChanges,
    },
  };

  if (dryRun) return result;

  // Refuse to wipe the board because of a malformed file.
  if (errors.length && rows.length === 0) {
    return { ...result, ok: false, error: 'Every row failed validation — nothing was applied.' };
  }

  const updatedAt = applyScheduleDiff(diff, { editedBy, source, label: label || filename });
  setMeta('last_sync_at', updatedAt);
  setMeta('last_sync_source', source);
  return { ...result, dryRun: false, updatedAt };
}

/** Force Re-sync / poll tick. Always applies; never a dry run. */
export async function pullAndSync({ editedBy = 'admin', removeMissing = true } = {}) {
  const src = getActiveSource();
  if (!src.canPull()) {
    throw new Error(
      src.id === 'upload'
        ? 'Nothing to re-sync yet — upload a spreadsheet first.'
        : `${src.label} is not configured.`
    );
  }
  const { buffer, filename, label } = await src.pull();
  const res = await ingest(buffer, filename, {
    dryRun: false,
    removeMissing,
    editedBy,
    source: src.id === 'upload' ? 'import' : 'sheet',
    label,
  });
  return { ...res, sourceId: src.id, sourceLabel: src.label };
}

export function syncStatus() {
  return {
    ...sourceStatus(),
    lastSyncAt: getMeta('last_sync_at'),
    lastSyncSource: getMeta('last_sync_source'),
    pollSeconds: Number(process.env.SYNC_POLL_SECONDS || 0),
  };
}

/**
 * Background polling for pull-capable sources. Off unless SYNC_POLL_SECONDS is
 * set, so the interim upload flow never surprises anyone with a re-sync.
 */
export function startPolling(onChange) {
  const seconds = Number(process.env.SYNC_POLL_SECONDS || 0);
  const src = getActiveSource();
  if (!seconds || src.kind !== 'pull' || !src.canPull()) return null;

  console.log(`[sync] polling ${src.label} every ${seconds}s`);
  const timer = setInterval(async () => {
    try {
      const res = await pullAndSync({ editedBy: 'synced from sheet' });
      if (res.ok && res.diff.hasChanges) onChange(res);
    } catch (err) {
      console.warn('[sync] poll failed:', err.message);
    }
  }, seconds * 1000);
  timer.unref?.();
  return timer;
}

export { uploadSource };
