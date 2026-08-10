/**
 * Multi-role people and the running order — item 13.
 *
 * Two things are being proved. First that the migration moves a *populated*
 * database across without losing anyone, since by the time this ships there is
 * a roster in there and "it works on a fresh database" is not the interesting
 * case. Second that a captain's blocks actually reach the captain and nobody
 * else — which is the entire reason the join table exists, and which the old
 * single-`role_id` model made impossible.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'royalty-roles-test-'));
const TMP_DB = path.join(TMP_DIR, 'test.db');

/* ------------------------------------------------------------------ *
 * A pre-migration database, built by hand
 *
 * This is the shape the app shipped with through item 12: `people.role_id` as
 * a single column, no `person_roles`, no `teams.show_order`. Written before
 * db.js is imported so that its migrations run against real rows.
 * ------------------------------------------------------------------ */

const legacy = new Database(TMP_DB);
legacy.exec(`
  CREATE TABLE roles (
    id TEXT PRIMARY KEY, label TEXT NOT NULL,
    selector TEXT NOT NULL CHECK (selector IN ('team','person')),
    blurb TEXT, sort_order INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE contact_cards (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, title TEXT, phone TEXT, email TEXT, note TEXT
  );
  CREATE TABLE teams (
    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
    liaison_contact_id TEXT REFERENCES contact_cards(id) ON DELETE SET NULL
  );
  CREATE TABLE people (
    id TEXT PRIMARY KEY, name TEXT NOT NULL,
    role_id TEXT NOT NULL REFERENCES roles(id),
    team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
    contact_id TEXT REFERENCES contact_cards(id) ON DELETE SET NULL
  );
  CREATE INDEX idx_people_role ON people(role_id);

  -- Blocks and target versions as they shipped before item 18: a three-way
  -- CHECK that SQLite cannot widen in place, so migrate.js rebuilds both.
  CREATE TABLE event_days (
    key TEXT PRIMARY KEY, label TEXT NOT NULL, date TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE locations (
    id TEXT PRIMARY KEY, venue_name TEXT NOT NULL, sub_location TEXT
  );
  CREATE TABLE schedule_blocks (
    id TEXT PRIMARY KEY,
    day TEXT NOT NULL REFERENCES event_days(key),
    start_time TEXT NOT NULL, end_time TEXT NOT NULL,
    location_id TEXT REFERENCES locations(id) ON DELETE SET NULL,
    activity_label TEXT NOT NULL,
    applies_to_type TEXT NOT NULL CHECK (applies_to_type IN ('team', 'person', 'role')),
    applies_to_id TEXT NOT NULL,
    notes TEXT,
    source TEXT NOT NULL DEFAULT 'manual',
    source_key TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_change TEXT
  );
  CREATE INDEX idx_blocks_day ON schedule_blocks(day, start_time);
  CREATE INDEX idx_blocks_target ON schedule_blocks(applies_to_type, applies_to_id);
  CREATE UNIQUE INDEX idx_blocks_source_key
    ON schedule_blocks(source_key) WHERE source_key IS NOT NULL;
  CREATE TABLE target_versions (
    target_type TEXT NOT NULL CHECK (target_type IN ('team', 'person', 'role')),
    target_id TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (target_type, target_id)
  );

  -- The edit log as it shipped before item 17: prose, and nothing to reverse
  -- it with. The four columns undo needs are added by migrate.js.
  CREATE TABLE edit_log (
    id TEXT PRIMARY KEY, schedule_block_id TEXT, edited_by TEXT NOT NULL,
    source TEXT NOT NULL, timestamp TEXT NOT NULL, change_type TEXT NOT NULL,
    change_summary TEXT NOT NULL, audience_json TEXT
  );

  INSERT INTO roles (id,label,selector,sort_order,active) VALUES
    ('dancer','Dancer','team',1,1),
    ('judge','Judge','person',3,1),
    ('captain','Captain','person',9,1);
  INSERT INTO teams (id,name) VALUES ('team_a','Alpha Crew'),('team_b','Beta Crew');
  INSERT INTO people (id,name,role_id,team_id) VALUES
    ('p_alice','Alice Alpha','dancer','team_a'),
    ('p_amir','Amir Alpha','dancer','team_a'),
    ('p_bianca','Bianca Beta','dancer','team_b'),
    ('p_judge','Jordan Judge','judge',NULL);
  -- Friday, because the suite's own seedBlocks() adds Saturday later.
  INSERT INTO event_days (key,label,date,sort_order) VALUES ('Fri','Friday','2026-08-07',1);
  INSERT INTO locations (id,venue_name,sub_location) VALUES ('loc_1','Main Venue','Main Stage');
  INSERT INTO schedule_blocks
    (id,day,start_time,end_time,location_id,activity_label,applies_to_type,applies_to_id,
     notes,source,source_key,created_at,updated_at)
  VALUES ('blk_1','Fri','09:00','10:00','loc_1','Legacy Beta block','team','team_b',
          'Bring shoes','manual','sheet-row-1','2026-08-01T12:00:00.000Z','2026-08-01T12:00:00.000Z');
  INSERT INTO target_versions (target_type,target_id,updated_at)
    VALUES ('team','team_b','2026-08-01T12:00:00.000Z');
  INSERT INTO edit_log (id,schedule_block_id,edited_by,source,timestamp,change_type,change_summary)
    VALUES
      ('log_1','blk_1','Marcus','manual','2026-08-01T12:00:00.000Z','updated','Changed something'),
      ('log_2',NULL,'Marcus','admin','2026-08-01T12:05:00.000Z','roster','Renamed a team');
`);
legacy.close();

process.env.DB_PATH = TMP_DB;
process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'test-admin-password';

// Importing db.js is what runs schema.sql and then the migrations.
const { db } = await import('../server/db.js');
const { createApp } = await import('../server/app.js');
const { issueCode } = await import('../server/lib/access-codes.js');
const { subjectsNeedingCodes } = await import('../server/lib/access-codes.js');
const { audienceForBlock } = await import('../server/lib/mutations.js');
const { resolveSession, listPeople, listTeams } = await import('../server/lib/queries.js');
const { resetRateLimiter } = await import('../server/lib/viewer-auth.js');
const { normalizeRosterRows } = await import('../server/sync/normalize.js');
const { computeRosterDiff, applyRosterDiff } = await import('../server/sync/diff.js');

let server;
let base;
const codes = {};

/* ------------------------------- fixture ------------------------------- */

function seedBlocks() {
  const now = new Date().toISOString();
  db.exec(`INSERT INTO event_days (key,label,date,sort_order) VALUES ('Sat','Saturday','2026-08-08',1);`);
  const block = db.prepare(
    `INSERT INTO schedule_blocks
       (id,day,start_time,end_time,activity_label,applies_to_type,applies_to_id,
        source,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,'test',?,?)`
  );
  block.run('b_dancers', 'Sat', '09:00', '09:30', 'All-dancer call', 'role', 'dancer', now, now);
  block.run('b_captains', 'Sat', '10:00', '10:30', "Captains' meeting", 'role', 'captain', now, now);
  block.run('b_team_a', 'Sat', '11:00', '12:00', 'Alpha warm-up', 'team', 'team_a', now, now);
  block.run('b_judge', 'Sat', '12:00', '17:00', 'Judging panel', 'person', 'p_judge', now, now);

  // Alice is promoted to captain: Dancer + Captain. Amir stays a plain dancer.
  db.prepare('INSERT INTO person_roles (person_id, role_id) VALUES (?, ?)').run('p_alice', 'captain');

  codes.teamA = issueCode({ subjectType: 'team', subjectId: 'team_a' }).code;
  codes.judge = issueCode({ subjectType: 'person', subjectId: 'p_judge' }).code;
}

function jar() {
  let cookies = {};
  return {
    header: () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; '),
    absorb(res) {
      for (const raw of res.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(';');
        const i = pair.indexOf('=');
        if (pair.slice(i + 1) === '') delete cookies[pair.slice(0, i)];
        else cookies[pair.slice(0, i)] = pair.slice(i + 1);
      }
    },
  };
}

async function call(method, url, { body, cookies } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(cookies ? { cookie: cookies.header() } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  cookies?.absorb(res);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, body: json, text };
}

async function signIn(code) {
  const c = jar();
  const res = await call('POST', '/api/session', { body: { code }, cookies: c });
  assert.equal(res.status, 200);
  return c;
}

async function adminJar() {
  const c = jar();
  await call('POST', '/api/admin/login', {
    body: { password: 'test-admin-password', name: 'Marcus' },
    cookies: c,
  });
  return c;
}

const labels = (payload) => payload.blocks.map((b) => b.activity).sort();

before(() => {
  seedBlocks();
  server = createApp({ serveClient: false }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  db.close();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

/* =========================== the actual tests =========================== */

describe('migrating a database that already has a roster', () => {
  test('the old column is gone and nobody lost their role', () => {
    const columns = db.prepare('PRAGMA table_info(people)').all().map((c) => c.name);
    assert.ok(!columns.includes('role_id'), 'people.role_id should have been dropped');

    // Every legacy person kept exactly the role they had.
    const held = db
      .prepare('SELECT person_id, role_id FROM person_roles ORDER BY person_id, role_id')
      .all();
    assert.deepEqual(
      held.filter((h) => h.person_id !== 'p_alice' || h.role_id !== 'captain'),
      [
        { person_id: 'p_alice', role_id: 'dancer' },
        { person_id: 'p_amir', role_id: 'dancer' },
        { person_id: 'p_bianca', role_id: 'dancer' },
        { person_id: 'p_judge', role_id: 'judge' },
      ]
    );
  });

  test('teams gained a nullable show_order, and it starts empty', () => {
    const columns = db.prepare('PRAGMA table_info(teams)').all();
    const showOrder = columns.find((c) => c.name === 'show_order');
    assert.ok(showOrder, 'teams.show_order should exist');
    assert.equal(showOrder.notnull, 0, 'it has to be nullable — the draw happens late');
    assert.deepEqual(listTeams().map((t) => t.showOrder), [null, null]);
  });

  test('running it again changes nothing', async () => {
    const { runMigrations } = await import('../server/migrate.js');
    assert.deepEqual(runMigrations(db), [], 'a second run should be a no-op');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM person_roles').get().n, 5);
  });

  /**
   * Item 17 added four columns to a table `schema.sql` had already created, so
   * this is the case that file cannot reach: an existing edit_log with rows in
   * it.
   */
  test('the edit log gains the columns undo needs, without losing its rows', () => {
    const columns = new Set(db.prepare('PRAGMA table_info(edit_log)').all().map((c) => c.name));
    for (const column of ['before_json', 'after_version', 'batch_id', 'undone_at']) {
      assert.ok(columns.has(column), `edit_log.${column} should exist`);
    }
    // The rows that were already there are still there, contents intact.
    const legacyRows = db
      .prepare("SELECT * FROM edit_log WHERE id IN ('log_1','log_2') ORDER BY id")
      .all();
    assert.equal(legacyRows.length, 2);
    assert.equal(legacyRows[0].change_summary, 'Changed something');
    assert.equal(legacyRows[0].before_json, null);
  });

  /**
   * Item 18 widened a CHECK constraint, which SQLite cannot do in place — so
   * migrate.js rebuilds both tables. The risk of a rebuild is losing or
   * reordering something, so this asserts the row came through whole.
   */
  test('the everyone target is accepted, and the rebuilt tables kept their rows', () => {
    const block = db.prepare('SELECT * FROM schedule_blocks WHERE id = ?').get('blk_1');
    assert.equal(block.activity_label, 'Legacy Beta block');
    assert.equal(block.notes, 'Bring shoes');
    assert.equal(block.location_id, 'loc_1');
    assert.equal(block.source_key, 'sheet-row-1');
    assert.equal(block.applies_to_type, 'team');

    // The indexes came back with it — losing the unique one would let an import
    // create a duplicate of a row it already owns.
    const indexes = db.prepare('PRAGMA index_list(schedule_blocks)').all().map((i) => i.name);
    assert.ok(indexes.includes('idx_blocks_source_key'));
    assert.ok(indexes.includes('idx_blocks_target'));

    assert.equal(
      db.prepare("SELECT updated_at FROM target_versions WHERE target_type='team' AND target_id='team_b'").get()
        .updated_at,
      '2026-08-01T12:00:00.000Z'
    );

    // And the point of the whole rebuild: an announcement now inserts.
    db.prepare(
      `INSERT INTO schedule_blocks
         (id,day,start_time,end_time,activity_label,applies_to_type,applies_to_id,
          source,created_at,updated_at)
       VALUES ('blk_all','Fri','13:00','13:15','Fire alarm','everyone','all','manual',?,?)`
    ).run('2026-08-01T12:00:00.000Z', '2026-08-01T12:00:00.000Z');
    assert.equal(
      db.prepare('SELECT applies_to_id FROM schedule_blocks WHERE id = ?').get('blk_all').applies_to_id,
      'all'
    );
    db.prepare("DELETE FROM schedule_blocks WHERE id = 'blk_all'").run();
  });

  test('rows written before batching get their own batch, and are not undoable', async () => {
    const { planUndo, listBatches } = await import('../server/lib/undo.js');

    const rows = db
      .prepare("SELECT id, batch_id FROM edit_log WHERE id IN ('log_1','log_2') ORDER BY id")
      .all();
    // Their own batch each: nothing recorded which of them were one action, and
    // inventing a grouping would be a reconstruction of history rather than a
    // reading of it.
    assert.equal(new Set(rows.map((r) => r.batch_id)).size, 2);
    assert.ok(rows.every((r) => r.batch_id));

    // And none of them can be reversed, because nothing recorded what they
    // overwrote — which is exactly what the null `before_json` says.
    const batches = listBatches();
    for (const row of rows) {
      assert.equal(batches.find((b) => b.batchId === row.batch_id).canUndo, false);
    }
    assert.equal(planUndo(rows[0].batch_id).blockers[0].reason, 'no-state');
  });
});

describe('a captain holds two roles', () => {
  test('the display role is Dancer, not Captain', () => {
    const alice = listPeople().find((p) => p.id === 'p_alice');
    assert.deepEqual(alice.roleIds.sort(), ['captain', 'dancer']);
    // Captain sorts last precisely so it never becomes the label on screen.
    assert.equal(alice.roleLabel, 'Dancer');
    assert.deepEqual(alice.roles.map((r) => r.label), ['Dancer', 'Captain']);
  });

  test('every role becomes a target, which is what makes this work', () => {
    const resolved = resolveSession({ type: 'person', id: 'p_alice' });
    const roleTargets = resolved.targets.filter((t) => t.type === 'role').map((t) => t.id).sort();
    assert.deepEqual(roleTargets, ['captain', 'dancer']);
  });

  test('the captain sees the captains-only block; a teammate does not', async () => {
    resetRateLimiter();
    const c = await signIn(codes.teamA);

    const asAlice = await call('POST', '/api/session/identify', {
      body: { personId: 'p_alice' },
      cookies: c,
    });
    assert.equal(asAlice.status, 200);
    assert.deepEqual(labels((await call('GET', '/api/schedule', { cookies: c })).body), [
      'All-dancer call',
      'Alpha warm-up',
      "Captains' meeting",
    ]);

    const asAmir = await call('POST', '/api/session/identify', {
      body: { personId: 'p_amir' },
      cookies: c,
    });
    assert.equal(asAmir.status, 200);
    const amir = await call('GET', '/api/schedule', { cookies: c });
    assert.deepEqual(labels(amir.body), ['All-dancer call', 'Alpha warm-up']);
    assert.ok(!amir.text.includes("Captains' meeting"), "a plain dancer must not see it");
  });

  test('a team session that has not identified anyone sees no captain block', async () => {
    resetRateLimiter();
    const c = await signIn(codes.teamA);
    const res = await call('GET', '/api/schedule', { cookies: c });
    // Before the identity step there is no way to know whose phone this is, and
    // showing it to all 25 dancers would have them all turn up to the meeting.
    assert.deepEqual(labels(res.body), ['All-dancer call', 'Alpha warm-up']);
  });

  test('a captain still gets no personal access code', () => {
    const needing = subjectsNeedingCodes().map((s) => s.subjectId);
    assert.ok(!needing.includes('p_alice'), 'captains reach their schedule via the team code');
    assert.ok(!needing.includes('p_amir'));
    assert.ok(needing.includes('p_judge'), 'staff still do');
  });

  test('a role audience counts everyone holding it, not just their display role', () => {
    const captains = audienceForBlock({ appliesToType: 'role', appliesToId: 'captain' });
    assert.deepEqual(captains.personIds, ['p_alice']);
    assert.deepEqual(captains.teamIds, ['team_a']);

    const dancers = audienceForBlock({ appliesToType: 'role', appliesToId: 'dancer' });
    assert.deepEqual(dancers.personIds.sort(), ['p_alice', 'p_amir', 'p_bianca']);
  });
});

describe('editing roles through the admin panel', () => {
  test('a person can be promoted and demoted, and the schedule follows', async () => {
    const admin = await adminJar();

    const promote = await call('PATCH', '/api/admin/people/p_amir', {
      body: { roleIds: ['dancer', 'captain'] },
      cookies: admin,
    });
    assert.equal(promote.status, 200);
    assert.ok(
      resolveSession({ type: 'person', id: 'p_amir' })
        .targets.some((t) => t.type === 'role' && t.id === 'captain')
    );

    const demote = await call('PATCH', '/api/admin/people/p_amir', {
      body: { roleIds: ['dancer'] },
      cookies: admin,
    });
    assert.equal(demote.status, 200);
    assert.ok(
      !resolveSession({ type: 'person', id: 'p_amir' })
        .targets.some((t) => t.type === 'role' && t.id === 'captain'),
      'demoting has to actually remove the role, not just add to it'
    );
  });

  test('a person cannot be left with no roles at all', async () => {
    const admin = await adminJar();
    const res = await call('PATCH', '/api/admin/people/p_amir', {
      body: { roleIds: [] },
      cookies: admin,
    });
    assert.equal(res.status, 400);
    assert.equal(listPeople().find((p) => p.id === 'p_amir').roleIds.length, 1);
  });

  test('an unknown role is refused rather than silently dropped', async () => {
    const admin = await adminJar();
    const res = await call('PATCH', '/api/admin/people/p_amir', {
      body: { roleIds: ['dancer', 'wizard'] },
      cookies: admin,
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /wizard/);
  });

  test('the single-role shorthand still works, for the importer and old callers', async () => {
    const admin = await adminJar();
    const res = await call('POST', '/api/admin/people', {
      body: { name: 'Nina New', roleId: 'judge' },
      cookies: admin,
    });
    assert.equal(res.status, 200);
    const nina = listPeople().find((p) => p.name === 'Nina New');
    assert.deepEqual(nina.roleIds, ['judge']);
    db.prepare('DELETE FROM people WHERE id = ?').run(nina.id);
  });

  test('deleting a person takes their role rows with them', async () => {
    const admin = await adminJar();
    const created = await call('POST', '/api/admin/people', {
      body: { name: 'Temp Person', roleIds: ['dancer', 'captain'], teamId: 'team_b' },
      cookies: admin,
    });
    const id = created.body.id;
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM person_roles WHERE person_id = ?').get(id).n, 2);

    await call('DELETE', `/api/admin/people/${id}`, { cookies: admin });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM person_roles WHERE person_id = ?').get(id).n, 0);
  });
});

describe('running order', () => {
  test('is set, cleared, and sorts the team list', async () => {
    const admin = await adminJar();
    assert.equal(
      (await call('PATCH', '/api/admin/teams/team_b', { body: { showOrder: 1 }, cookies: admin }))
        .status,
      200
    );
    assert.equal(
      (await call('PATCH', '/api/admin/teams/team_a', { body: { showOrder: 2 }, cookies: admin }))
        .status,
      200
    );
    assert.deepEqual(listTeams().map((t) => [t.name, t.showOrder]), [
      ['Beta Crew', 1],
      ['Alpha Crew', 2],
    ]);

    await call('PATCH', '/api/admin/teams/team_a', { body: { showOrder: null }, cookies: admin });
    // Unplaced teams sort last, by name, rather than vanishing or leading.
    assert.deepEqual(listTeams().map((t) => [t.name, t.showOrder]), [
      ['Beta Crew', 1],
      ['Alpha Crew', null],
    ]);
  });

  test('two teams cannot share a slot', async () => {
    const admin = await adminJar();
    await call('PATCH', '/api/admin/teams/team_b', { body: { showOrder: 1 }, cookies: admin });
    const clash = await call('PATCH', '/api/admin/teams/team_a', {
      body: { showOrder: 1 },
      cookies: admin,
    });
    assert.equal(clash.status, 409);
    assert.match(clash.body.error, /Beta Crew/);
    assert.equal(listTeams().find((t) => t.id === 'team_a').showOrder, null);
  });

  test('nonsense is refused', async () => {
    const admin = await adminJar();
    for (const showOrder of [0, -1, 2.5, 'third']) {
      const res = await call('PATCH', '/api/admin/teams/team_a', { body: { showOrder }, cookies: admin });
      assert.equal(res.status, 400, `${showOrder} should be refused`);
    }
  });
});

describe('the roster importer assigns the captain role', () => {
  /**
   * `normalizeRosterRows` consumes what `parseTabular` produces, whose keys are
   * lowercased and space-normalized — so the fixtures below use that shape
   * rather than the spreadsheet's own capitalisation.
   */
  const rosterRow = (name, captain, row) => ({
    name,
    role: 'Dancer',
    team: 'Alpha Crew',
    'captain?': captain,
    __row: row,
  });

  test('a Captain? column adds Captain on top of the row\'s own role', () => {
    const { rows, errors } = normalizeRosterRows([
      rosterRow('Cora Captain', 'Y', 2),
      rosterRow('Dana Dancer', '', 3),
    ]);
    assert.deepEqual(errors, []);
    assert.deepEqual(rows[0].roleIds.sort(), ['captain', 'dancer']);
    assert.deepEqual(rows[1].roleIds, ['dancer']);
  });

  test('only an explicit yes counts', () => {
    const { rows } = normalizeRosterRows(
      ['Y', 'yes', 'TRUE', '1', 'n', 'no', '', 'maybe', '*'].map((v, i) =>
        rosterRow(`Person ${i}`, v, i + 2)
      )
    );
    assert.deepEqual(
      rows.map((r) => r.isCaptain),
      [true, true, true, true, false, false, false, false, false]
    );
    // The asterisk is a food restriction on the roster, never a captain mark.
    assert.equal(rows[8].isCaptain, false);
  });

  test('importing promotes and demotes existing people', () => {
    const rows = normalizeRosterRows([
      { name: 'Bianca Beta', role: 'Dancer', team: 'Beta Crew', 'captain?': 'Y', __row: 2 },
    ]).rows;

    const diff = computeRosterDiff(rows);
    assert.equal(diff.createPeople.length, 0, 'she is already on the roster');
    assert.match(diff.updatePeople[0].changes.join(' '), /roles dancer → captain\+dancer/);

    applyRosterDiff(diff, { editedBy: 'test', source: 'import' });
    assert.deepEqual(
      listPeople().find((p) => p.id === 'p_bianca').roleIds.sort(),
      ['captain', 'dancer']
    );

    // And removing the mark takes the role away again.
    const back = normalizeRosterRows([
      { name: 'Bianca Beta', role: 'Dancer', team: 'Beta Crew', 'captain?': '', __row: 2 },
    ]).rows;
    applyRosterDiff(computeRosterDiff(back), { editedBy: 'test', source: 'import' });
    assert.deepEqual(listPeople().find((p) => p.id === 'p_bianca').roleIds, ['dancer']);
  });
});
