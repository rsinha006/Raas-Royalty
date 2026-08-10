/**
 * Schema migrations for databases that already exist.
 *
 * `schema.sql` is all `CREATE TABLE IF NOT EXISTS`, so it does reach an existing
 * database — a brand-new table can live there and will appear on the next boot.
 * What it cannot do is change a table that already exists, and it runs first, so
 * anything depending on a column it does not create would fail. That is the gap
 * this file covers: new columns, indexes over them, and backfills. Everything
 * here is idempotent and runs on every boot, so the deploy step is "restart"
 * rather than "remember to run the migration".
 *
 * Takes `db` as an argument rather than importing it, so that db.js can call it
 * during its own initialization without a circular import.
 */

const columnNames = (db, table) =>
  new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));

export function runMigrations(db) {
  const applied = [];

  /* ---- teams.show_order — the running order, 1–8, nullable until the draw ---- */

  if (!columnNames(db, 'teams').has('show_order')) {
    db.exec('ALTER TABLE teams ADD COLUMN show_order INTEGER');
    applied.push('teams.show_order');
  }

  /**
   * Two teams cannot both be third. Enforced rather than trusted, because the
   * running order gets read off a stage door and nobody re-checks it.
   *
   * Created here rather than in schema.sql because that file runs first, and on
   * a database that predates the column there would be nothing to index.
   */
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_teams_show_order
       ON teams(show_order) WHERE show_order IS NOT NULL`
  );

  /* ---- people.role_id → person_roles ---- */

  /**
   * Backfill then drop, in one transaction. Dropping the column is the point:
   * leaving it in place as a "primary role" alongside the join table would give
   * the same fact two homes, and the two would disagree the first time someone
   * edited a person through a path that only knew about one of them.
   *
   * A person's display role is now derived — the role they hold with the lowest
   * `sort_order` — which for a captain is Dancer, since Captain sorts last.
   */
  if (columnNames(db, 'people').has('role_id')) {
    db.transaction(() => {
      db.exec(`
        INSERT OR IGNORE INTO person_roles (person_id, role_id)
        SELECT id, role_id FROM people WHERE role_id IS NOT NULL
      `);
      // Indexes on a dropped column go with it; recreate what schema.sql wants.
      db.exec('DROP INDEX IF EXISTS idx_people_role');
      db.exec('ALTER TABLE people DROP COLUMN role_id');
    })();
    applied.push('people.role_id → person_roles');
  }

  /**
   * The Captain role itself.
   *
   * Roles are data and admins can add their own, but this one is referenced by
   * id from the roster importer's `Captain?` column, so an existing database
   * that has never seen it would reject every captain row with an error nobody
   * would know how to fix. Seeded rather than assumed.
   *
   * `selector: 'person'` reads as "reached individually" and is what keeps
   * captains off the personal-code list — that query excludes anyone holding a
   * team-selector role, and a captain still holds Dancer. Sorted last so it
   * never becomes anyone's display role.
   */
  if (db.prepare('SELECT COUNT(*) AS n FROM roles').get().n > 0) {
    const before = db.prepare("SELECT 1 FROM roles WHERE id = 'captain'").get();
    db.prepare(
      `INSERT OR IGNORE INTO roles (id, label, selector, blurb, sort_order, active)
       VALUES ('captain', 'Captain', 'person', 'Team captains', 9, 1)`
    ).run();
    if (!before) applied.push('captain role');
  }

  /* ---- edit_log gains enough state to be reversible ---- */

  /**
   * The log recorded what happened in prose and could reverse none of it.
   * `before_json` is the block as it stood; `after_version` is the `updated_at`
   * it ended up with, which undo checks before touching anything so that a
   * block someone has since edited refuses instead of being silently rolled
   * back over. `batch_id` groups one admin action — a 17-block shift undone a
   * row at a time is the half-shifted day item 15 exists to prevent.
   *
   * Existing rows keep NULLs and are simply not undoable, which is honest:
   * nothing recorded what they overwrote. `backfillEditLogBatches` gives them
   * batch ids anyway so the log still groups sensibly when read.
   */
  const logColumns = columnNames(db, 'edit_log');
  for (const [column, type] of [
    ['before_json', 'TEXT'],
    ['after_version', 'TEXT'],
    ['batch_id', 'TEXT'],
    ['undone_at', 'TEXT'],
  ]) {
    if (!logColumns.has(column)) {
      db.exec(`ALTER TABLE edit_log ADD COLUMN ${column} ${type}`);
      applied.push(`edit_log.${column}`);
    }
  }

  db.exec('CREATE INDEX IF NOT EXISTS idx_editlog_batch ON edit_log(batch_id)');

  backfillEditLogBatches(db);

  /**
   * ---- target_versions — per-target "last updated" ----
   *
   * Not reported in `applied`, and not conditional on anything: this is a data
   * backfill rather than a schema change, and it is the safety net for every
   * path that writes blocks without going through `createBlock` — the seed, a
   * future importer, a hand-run SQL fix at 2am during the event. Announcing it
   * on the boot line would make a routine self-heal look like a migration.
   */
  backfillTargetVersions(db);

  return applied;
}

/**
 * Give every target that already has blocks a baseline timestamp, and write the
 * epoch that a target with no row falls back to.
 *
 * Without this, an upgraded database would show every subject the epoch — a
 * single timestamp for the whole event, stuck at first boot — instead of when
 * their own schedule last moved. That is wrong but *visibly* wrong, which is the
 * deliberate trade in `versionForTargets`: the fallback is a value writes never
 * move, so a gap reads as stale rather than as a false "just updated".
 *
 * Idempotent by construction: it only inserts rows that are missing, so a
 * target whose real version has since moved on is never dragged backwards.
 * Exported because the seed has to do the same thing after writing its blocks.
 */
/**
 * Give pre-existing log rows a batch id so the log groups by action when read.
 *
 * Rows written before batching existed have no way to say which of them were
 * one action, so the grouping is per row — each becomes its own batch. That is
 * not a reconstruction of history and does not pretend to be: those rows carry
 * no `before_json`, so undo will not offer them either way. This exists so the
 * panel has one code path rather than two.
 */
function backfillEditLogBatches(db) {
  const orphans = db.prepare('SELECT id FROM edit_log WHERE batch_id IS NULL').all();
  if (!orphans.length) return;
  const stamp = db.prepare('UPDATE edit_log SET batch_id = ? WHERE id = ?');
  db.transaction(() => {
    for (const row of orphans) stamp.run(`batch_legacy_${row.id}`, row.id);
  })();
}

export function backfillTargetVersions(db) {
  // The floor a target with no row reads. Written once and never moved, so a
  // missed bump surfaces as a stuck timestamp rather than as a false "just
  // updated" — see `versionForTargets`.
  db.prepare(
    `INSERT INTO meta (key, value)
       SELECT 'target_versions_epoch', ?
        WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key = 'target_versions_epoch')`
  ).run(new Date().toISOString());

  db
    .prepare(
      `INSERT INTO target_versions (target_type, target_id, updated_at)
         SELECT applies_to_type, applies_to_id, MAX(updated_at)
           FROM schedule_blocks
          GROUP BY applies_to_type, applies_to_id
       ON CONFLICT(target_type, target_id) DO NOTHING`
    )
    .run();
}
