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

/**
 * Whether a table's stored DDL already permits the 'everyone' target.
 *
 * Reading `sqlite_master` is the only way to see a CHECK constraint — `PRAGMA
 * table_info` reports columns and types and says nothing about constraints. It
 * doubles as the idempotence guard: after the rebuild the new DDL contains the
 * word, so the next boot skips it.
 */
function tableAllowsEveryone(db, table) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  return !row || row.sql.includes("'everyone'");
}

/**
 * Rebuild a table under a widened constraint: create, copy, drop, rename,
 * re-index. The columns are copied by name from the old table, so this cannot
 * silently reorder or drop one.
 *
 * `foreign_keys` is toggled around the transaction rather than inside it —
 * SQLite ignores the pragma mid-transaction, and `schedule_blocks` is referenced
 * by nothing but references `event_days` and `locations`, which the rename would
 * otherwise trip over.
 */
function rebuild(db, { table, create, indexes }) {
  const columns = [...columnNames(db, table)].join(', ');
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(create);
      db.exec(`INSERT INTO ${table}_migrating (${columns}) SELECT ${columns} FROM ${table}`);
      db.exec(`DROP TABLE ${table}`);
      db.exec(`ALTER TABLE ${table}_migrating RENAME TO ${table}`);
      for (const index of indexes) db.exec(index);
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

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

  /* ---- people.email / people.phone — how a person is *reached* ---- */

  /**
   * A participant's own address, which nothing in this app held until item 25.
   *
   * ⚠️ This is deliberately not `people.contact_id`. That column is the card a
   * person should **call** — their liaison or coordinator — and it is shared:
   * in the seed every dancer on a team points at that team's liaison, and a
   * dozen exec board members point at the Event Director. Reading it as "where
   * to send this person's link" mails a dozen private access links to one
   * inbox, and the file looks perfectly plausible on the way past.
   *
   * `docs/decisions.md` deferred these columns until real per-person details
   * existed to put in them. The event template's People and Roster tabs carry
   * `Phone` and `Email`, so they now do.
   */
  for (const col of ['email', 'phone']) {
    if (!columnNames(db, 'people').has(col)) {
      db.exec(`ALTER TABLE people ADD COLUMN ${col} TEXT`);
      applied.push(`people.${col}`);
    }
  }

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

  /* ---- 'everyone' becomes a fourth block target ---- */

  /**
   * SQLite cannot alter a CHECK constraint, so widening one means rebuilding
   * the table — create, copy, drop, rename, re-index, which is the procedure
   * SQLite's own docs prescribe. Guarded on the stored DDL text rather than on
   * a version number, so it runs exactly once and a database created fresh from
   * `schema.sql` skips it entirely.
   *
   * Both rebuilds are inside a transaction. If either fails the server does not
   * start, which is the right direction to fail: a half-migrated schedule table
   * on the morning of the event is not something to discover later.
   */
  if (!tableAllowsEveryone(db, 'schedule_blocks')) {
    rebuild(db, {
      table: 'schedule_blocks',
      create: `
        CREATE TABLE schedule_blocks_migrating (
          id              TEXT PRIMARY KEY,
          day             TEXT NOT NULL REFERENCES event_days(key),
          start_time      TEXT NOT NULL,
          end_time        TEXT NOT NULL,
          location_id     TEXT REFERENCES locations(id) ON DELETE SET NULL,
          activity_label  TEXT NOT NULL,
          applies_to_type TEXT NOT NULL
            CHECK (applies_to_type IN ('team', 'person', 'role', 'everyone')),
          applies_to_id   TEXT NOT NULL
            CHECK (applies_to_type <> 'everyone' OR applies_to_id = 'all'),
          notes           TEXT,
          source          TEXT NOT NULL DEFAULT 'manual',
          source_key      TEXT,
          created_at      TEXT NOT NULL,
          updated_at      TEXT NOT NULL,
          last_change     TEXT
        )`,
      indexes: [
        'CREATE INDEX IF NOT EXISTS idx_blocks_day ON schedule_blocks(day, start_time)',
        'CREATE INDEX IF NOT EXISTS idx_blocks_target ON schedule_blocks(applies_to_type, applies_to_id)',
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_blocks_source_key
           ON schedule_blocks(source_key) WHERE source_key IS NOT NULL`,
      ],
    });
    applied.push('schedule_blocks: everyone target');
  }

  if (!tableAllowsEveryone(db, 'target_versions')) {
    rebuild(db, {
      table: 'target_versions',
      create: `
        CREATE TABLE target_versions_migrating (
          target_type TEXT NOT NULL
            CHECK (target_type IN ('team', 'person', 'role', 'everyone')),
          target_id   TEXT NOT NULL,
          updated_at  TEXT NOT NULL,
          PRIMARY KEY (target_type, target_id)
        )`,
      indexes: [],
    });
    applied.push('target_versions: everyone target');
  }

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
  ensureEventRoles(db);
  if (ensureWeekendDays(db)) applied.push('event_days: Thursday and Sunday');

  return applied;
}

/**
 * Add Thursday and Sunday to a database that was seeded with only Friday and
 * Saturday.
 *
 * The event is four days: the template has a grid for each, teams land on
 * Thursday and fly out on Sunday, and those arrivals and departures are
 * person-targeted blocks somebody reads standing in an airport. A block whose
 * `Day` has no `event_days` row is refused per row, so on a two-day database
 * every one of them is dropped — and the import reports it as skipped rows in a
 * list nobody rereads once the count stops going down.
 *
 * ⚠️ The dates are *derived, not invented*: Thursday is the day before Friday
 * and Sunday the day after Saturday, which is arithmetic on a contiguous
 * weekend and the same assumption `planEventDates` and the template's own
 * "Event Friday date" box both make. It runs only when Friday and Saturday are
 * genuinely adjacent — if someone has re-dated them into a shape this does not
 * understand, it does nothing rather than guessing, and `npm run days` is how
 * that gets fixed. `sort_order` is set outside the existing range rather than
 * renumbering, so nothing that already sorts moves.
 */
export function ensureWeekendDays(db) {
  const days = db.prepare('SELECT key, date, sort_order FROM event_days').all();
  if (!days.length) return false; // A fresh database; the seed owns this.
  const by = new Map(days.map((d) => [d.key, d]));
  const fri = by.get('Fri');
  const sat = by.get('Sat');
  if (!fri || !sat) return false;

  const DAY_MS = 86_400_000;
  const friAt = Date.parse(`${fri.date}T00:00:00Z`);
  const satAt = Date.parse(`${sat.date}T00:00:00Z`);
  if (!Number.isFinite(friAt) || satAt - friAt !== DAY_MS) return false;

  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  const wanted = [
    { key: 'Thu', label: 'Thursday', date: iso(friAt - DAY_MS), sort: fri.sort_order - 1 },
    { key: 'Sun', label: 'Sunday', date: iso(satAt + DAY_MS), sort: sat.sort_order + 1 },
  ].filter((d) => !by.has(d.key));
  if (!wanted.length) return false;

  const insert = db.prepare(
    'INSERT INTO event_days (key, label, date, sort_order) VALUES (?, ?, ?, ?)'
  );
  db.transaction(() => {
    for (const d of wanted) insert.run(d.key, d.label, d.date, d.sort);
  })();
  return true;
}

/**
 * The two positions the real roster has and the placeholder seed never did.
 *
 * Liaisons are most of last year's master schedule — the tab has five rows per
 * team plus five judge liaisons — and RAS reps get a row each because they move
 * independently. Without these, every one of those People rows fails its import
 * on `Role "liaison" is not a known role`, which is a stop at exactly the wrong
 * moment: the roster arrives late by construction (item 24), and the person
 * loading it is not the person who can decide what a role should be called.
 *
 * ⚠️ Roles stay data. This inserts two rows that were missing and asserts
 * nothing about the rest — `INSERT OR IGNORE`, so a label or selector changed
 * in the panel is never dragged back, and a role deleted on purpose stays
 * deleted only until the next boot, which is the price of not needing a deploy
 * to add one. Both are `person` selectors: they are reached by name and carry
 * their own access code, like every other staff position.
 */
export function ensureEventRoles(db) {
  const roles = [
    { id: 'liaison', label: 'Liaison', selector: 'person', blurb: 'Find your name', sort: 7 },
    { id: 'ras-rep', label: 'RAS Rep', selector: 'person', blurb: 'Find your name', sort: 8 },
  ];
  const insert = db.prepare(
    `INSERT OR IGNORE INTO roles (id, label, selector, blurb, sort_order, active)
     VALUES (?, ?, ?, ?, ?, 1)`
  );
  db.transaction(() => {
    for (const r of roles) insert.run(r.id, r.label, r.selector, r.blurb, r.sort);
  })();
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
