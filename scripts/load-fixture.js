/**
 * The database the load test runs against — item 20.
 *
 * Deliberately not `data/royalty.db`. The load test issues hundreds of writes,
 * a bulk shift and an announcement, so it needs a database it is allowed to
 * ruin; pointing it at the dev database would mean the numbers depend on
 * whatever was last hand-edited there.
 *
 * It is the ordinary seed, padded to the headcount the event is sized for
 * (280 — docs/decisions.md), because the seed is deliberately smaller. Padding
 * goes through the same schema and the same `backfillAccessCodes`, so a load
 * fixture cannot drift from what the app actually reads.
 *
 *   node scripts/load-fixture.js [--db data/load-test.db] [--people 280] [--blocks 350]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

export const DEFAULT_DB = path.join(ROOT, 'data', 'load-test.db');

/* -------------------- deterministic pseudo-random -------------------- */
let _seed = 6002026;
const rand = () => ((_seed = (_seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

const FIRST = [
  'Amara', 'Priya', 'Jordan', 'Maya', 'Devin', 'Sofia', 'Kai', 'Naomi', 'Elias', 'Zara',
  'Marcus', 'Lena', 'Theo', 'Imani', 'Rafael', 'Yuki', 'Owen', 'Camila', 'Nico', 'Aaliyah',
  'Hana', 'Julian', 'Reese', 'Ariana', 'Malik', 'Freya', 'Dante', 'Simone', 'Arjun', 'Nadia',
];
const LAST = [
  'Okafor', 'Nguyen', 'Alvarez', 'Chen', 'Patel', 'Rivera', 'Hassan', 'Kowalski', 'Bennett',
  'Osei', 'Sato', 'Moreau', 'Silva', 'Kimura', 'Adeyemi', 'Novak', 'Reyes', 'Ferrari',
];

/**
 * Build the fixture and return what is in it.
 *
 * @param dbPath   where to write. Removed first — a load fixture is disposable
 *                 by definition, and a half-padded database from an interrupted
 *                 run would quietly change the numbers.
 * @param people   headcount to pad up to. 280 is the sizing target.
 * @param blocks   schedule blocks to pad up to. The seed writes ~110; a real
 *                 weekend with authored dancer schedules (item 24) is larger,
 *                 and the personalized query's cost scales with this.
 */
export async function buildFixture({ dbPath = DEFAULT_DB, people = 280, blocks = 350, quiet = false } = {}) {
  const log = (...args) => !quiet && console.log(...args);

  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  // The real seed, in its own process: it runs top-level on import, and it must
  // pick up DB_PATH before server/db.js opens anything.
  const seeded = spawnSync(process.execPath, [path.join(ROOT, 'server', 'seed.js'), '--reset'], {
    env: { ...process.env, DB_PATH: dbPath },
    encoding: 'utf8',
  });
  if (seeded.status !== 0) {
    throw new Error(`seed failed:\n${seeded.stdout || ''}${seeded.stderr || ''}`);
  }
  log(`  seeded  ${seeded.stdout.trim().split('\n').pop()}`);

  process.env.DB_PATH = dbPath;
  const { db, newId, nowIso } = await import('../server/db.js');
  const { backfillAccessCodes } = await import('../server/lib/access-codes.js');
  const { backfillTargetVersions } = await import('../server/migrate.js');

  const teams = db.prepare('SELECT id, name, liaison_contact_id FROM teams ORDER BY name').all();
  const dayKeys = db.prepare('SELECT key FROM event_days ORDER BY sort_order').all().map((d) => d.key);
  const locations = db.prepare('SELECT id FROM locations').all().map((l) => l.id);

  /* -------------------- pad the roster -------------------- */

  const insPerson = db.prepare('INSERT INTO people (id, name, team_id, contact_id) VALUES (?, ?, ?, ?)');
  const insRole = db.prepare('INSERT INTO person_roles (person_id, role_id) VALUES (?, ?)');
  const taken = new Set(db.prepare('SELECT name FROM people').all().map((p) => p.name));

  const addedPeople = db.transaction(() => {
    let added = 0;
    let n = db.prepare('SELECT COUNT(*) AS n FROM people').get().n;
    while (n < people) {
      // Round-robin so the teams stay the same size as each other, which is what
      // makes a per-team edit's fan-out representative rather than lucky.
      const team = teams[added % teams.length];
      let name = `${pick(FIRST)} ${pick(LAST)}`;
      while (taken.has(name)) name = `${pick(FIRST)} ${pick(LAST)} ${added}`;
      taken.add(name);
      const id = newId('per');
      insPerson.run(id, name, team.id, team.liaison_contact_id);
      insRole.run(id, 'dancer');
      added++;
      n++;
    }
    return added;
  })();

  /* -------------------- pad the schedule -------------------- */

  // Person-targeted, because that is the shape the real event adds most of
  // (airport pickups, individual calls) and the shape that makes each session's
  // block list differ from its team-mates'.
  const insBlock = db.prepare(
    `INSERT INTO schedule_blocks
       (id, day, start_time, end_time, location_id, activity_label,
        applies_to_type, applies_to_id, notes, source, source_key, created_at, updated_at, last_change)
     VALUES (?, ?, ?, ?, ?, ?, 'person', ?, ?, 'seed', NULL, ?, ?, NULL)`
  );
  const roster = db.prepare('SELECT id FROM people ORDER BY id').all();
  const ts = nowIso();

  const addedBlocks = db.transaction(() => {
    let added = 0;
    let n = db.prepare('SELECT COUNT(*) AS n FROM schedule_blocks').get().n;
    while (n < blocks) {
      const person = roster[added % roster.length];
      const hour = 6 + Math.floor(rand() * 15);
      const start = `${String(hour).padStart(2, '0')}:${rand() < 0.5 ? '00' : '30'}`;
      const end = `${String(hour + 1).padStart(2, '0')}:${start.slice(3)}`;
      insBlock.run(
        newId('blk'),
        dayKeys[added % dayKeys.length],
        start,
        end,
        pick(locations),
        added % 2 ? 'Airport pickup' : 'Hotel shuttle',
        person.id,
        'Placeholder — load fixture.',
        ts,
        ts
      );
      added++;
      n++;
    }
    return added;
  })();

  // Same call the seed and every boot make: codes for teams and staff, no
  // per-dancer codes. The load test signs dancers in through their team's code
  // and the identity step, exactly as a phone does.
  const codes = backfillAccessCodes();
  backfillTargetVersions(db);

  const stats = {
    dbPath,
    people: db.prepare('SELECT COUNT(*) AS n FROM people').get().n,
    teams: teams.length,
    blocks: db.prepare('SELECT COUNT(*) AS n FROM schedule_blocks').get().n,
    codes: db.prepare('SELECT COUNT(*) AS n FROM access_codes WHERE revoked_at IS NULL').get().n,
    addedPeople,
    addedBlocks,
    issuedCodes: codes.created,
  };
  db.close();
  log(
    `  padded  +${addedPeople} people, +${addedBlocks} blocks → ` +
      `${stats.people} people, ${stats.teams} teams, ${stats.blocks} blocks, ${stats.codes} live codes`
  );
  return stats;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  const stats = await buildFixture({
    dbPath: path.resolve(arg('db', DEFAULT_DB)),
    people: Number(arg('people', 280)),
    blocks: Number(arg('blocks', 350)),
  });
  console.log(`\n  Load fixture ready at ${stats.dbPath}\n`);
}
