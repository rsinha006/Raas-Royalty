import { getMeta, setMeta } from '../db.js';
import { parseTabular } from './parse.js';
import { SCHEDULE_SHEETS, normalizeScheduleRows } from './normalize.js';
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

  const parsed = await parseTabular(buffer, filename, { prefer: SCHEDULE_SHEETS });
  if (!parsed.rows.length) {
    return {
      ok: false,
      error: 'No data rows found. Check that the first row is the header row.',
      headers: parsed.headers,
    };
  }

  const { rows, errors, notes } = normalizeScheduleRows(parsed.rows);
  const diff = computeScheduleDiff(rows, { removeMissing });

  /**
   * Why this file cannot be applied, or null. Computed for the preview as well
   * as the commit, so the panel can say so on the screen someone is reading
   * rather than only after they press Apply.
   *
   * ⚠️ The condition is "nothing importable came out", **not** "rows failed".
   * Those differ by exactly one case and it is a real one: a workbook whose
   * Export tab is all formulas with no calculated values in it reads as a few
   * note rows and *no errors at all*, because there is nothing there to be
   * wrong. Under `errors.length && !rows.length` that file was applied — an
   * empty row set against `removeMissing`, which is every managed block
   * deleted, silently, behind a green result. There is no file for which the
   * right outcome is "delete the whole schedule"; clearing the placeholder
   * blocks is its own action and it names what it is doing.
   */
  const refusal =
    rows.length > 0
      ? null
      : errors.length
        ? 'Every row failed validation — nothing was applied.'
        : `No importable rows${parsed.sheetName ? ` on the ${parsed.sheetName} tab` : ''} — ` +
          'nothing was applied. If this came from the event template, that tab is formulas ' +
          'with no calculated values in it: publish or export it from Google Sheets rather ' +
          'than sending the file the formulas were written in.';

  const result = {
    refusal,
    ok: true,
    dryRun,
    headers: parsed.headers,
    sheetName: parsed.sheetName,
    parsedRows: parsed.rows.length,
    validRows: rows.length,
    noteRows: notes,
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

  if (refusal) return { ...result, ok: false, error: refusal };

  const { updatedAt, targets } = applyScheduleDiff(diff, {
    editedBy,
    source,
    label: label || filename,
  });
  setMeta('last_sync_at', updatedAt);
  setMeta('last_sync_source', source);
  // `targets` is what the change gets broadcast to. It rides along on the
  // result rather than being re-derived, because the diff is the only place
  // that knows which blocks were actually touched.
  return { ...result, dryRun: false, updatedAt, targets };
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
