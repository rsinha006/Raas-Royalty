/**
 * Schema migrations for databases that already exist.
 *
 * `schema.sql` is all `CREATE TABLE IF NOT EXISTS`, which is enough to build a
 * fresh database and does nothing at all to a populated one. This file covers
 * the gap: the changes that have to be applied to a database with real rows in
 * it. Everything here is idempotent and runs on every boot, so the deploy step
 * is "restart" rather than "remember to run the migration".
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

  return applied;
}
