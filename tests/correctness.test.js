/**
 * Item 14 — the known correctness gaps.
 *
 * Each of these is a case where the app did something quietly wrong rather than
 * failing: an edit overwritten with no sign it happened, a dead link that looks
 * like a working one, blocks left pointing at a deleted person, a timestamp
 * telling 280 people their schedule changed when one team's did. Silent wrong
 * is the failure mode this whole project is trying to avoid, so the tests are
 * mostly about what *doesn't* happen.
 *
 * Runs against the real Express app on a throwaway database.
 */
import { test, before, after, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'royalty-correctness-')), 'test.db');
process.env.DB_PATH = TMP_DB;
process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'test-admin-password';

const { db } = await import('../server/db.js');
const { createApp } = await import('../server/app.js');
const { issueCode, revokeCode } = await import('../server/lib/access-codes.js');
const { resetRateLimiter } = await import('../server/lib/viewer-auth.js');
const { computeScheduleDiff } = await import('../server/sync/diff.js');

let server;
let base;
let admin;
const codes = {};

/* ------------------------------- fixture ------------------------------- */

function seedFixture() {
  const now = new Date('2026-08-01T12:00:00.000Z').toISOString();
  db.exec(`
    INSERT INTO roles (id,label,selector,sort_order,active) VALUES
      ('dancer','Dancer','team',1,1),
      ('judge','Judge','person',2,1);
    INSERT INTO event_days (key,label,date,sort_order) VALUES ('Sat','Saturday','2026-08-08',1);
    -- Gamma exists only to have its code killed, so revoking it can't strand a
    -- team the later timestamp tests still need to sign in as.
    INSERT INTO teams (id,name) VALUES
      ('team_a','Alpha Crew'),('team_b','Beta Crew'),('team_c','Gamma Crew');
    INSERT INTO people (id,name,team_id) VALUES
      ('p_alice','Alice Alpha','team_a'),
      ('p_bianca','Bianca Beta','team_b'),
      ('p_judge','Jordan Judge',NULL);
    INSERT INTO person_roles (person_id,role_id) VALUES
      ('p_alice','dancer'),
      ('p_bianca','dancer'),
      ('p_judge','judge');
  `);

  const block = db.prepare(
    `INSERT INTO schedule_blocks
       (id,day,start_time,end_time,activity_label,applies_to_type,applies_to_id,
        source,source_key,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  );
  block.run('b_team_a', 'Sat', '09:00', '10:00', 'Alpha warm-up', 'team', 'team_a', 'test', 'k_alpha', now, now);
  block.run('b_team_b', 'Sat', '09:00', '10:00', 'Beta warm-up', 'team', 'team_b', 'test', 'k_beta', now, now);
  block.run('b_alice', 'Sat', '07:00', '08:00', 'Alice airport pickup', 'person', 'p_alice', 'test', null, now, now);
  // Placeholder rows, exactly as the seed writes them: source 'seed', no key.
  block.run('b_seed_a', 'Sat', '15:00', '16:00', 'Placeholder rehearsal', 'team', 'team_a', 'seed', null, now, now);
  block.run('b_seed_role', 'Sat', '17:00', '18:00', 'Placeholder briefing', 'role', 'dancer', 'seed', null, now, now);

  db.prepare(
    `INSERT INTO target_versions (target_type,target_id,updated_at) VALUES
       ('team','team_a',?),('team','team_b',?),('person','p_alice',?),('role','dancer',?)`
  ).run(now, now, now, now);

  codes.teamA = issueCode({ subjectType: 'team', subjectId: 'team_a' }).code;
  codes.teamB = issueCode({ subjectType: 'team', subjectId: 'team_b' }).code;
  codes.judge = issueCode({ subjectType: 'person', subjectId: 'p_judge' }).code;
}

/* ------------------------------- helpers ------------------------------- */

function jar() {
  let cookies = {};
  return {
    header: () =>
      Object.entries(cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join('; '),
    absorb(res) {
      for (const raw of res.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(';');
        const idx = pair.indexOf('=');
        const value = pair.slice(idx + 1);
        if (value === '') delete cookies[pair.slice(0, idx)];
        else cookies[pair.slice(0, idx)] = value;
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
    /* redirects have no JSON body */
  }
  return { status: res.status, body: json, text, headers: res.headers };
}

const asAdmin = (method, url, body) => call(method, url, { body, cookies: admin });

async function signInAdmin() {
  const c = jar();
  const res = await call('POST', '/api/admin/login', {
    body: { password: 'test-admin-password', name: 'Marcus' },
    cookies: c,
  });
  assert.equal(res.status, 200);
  return c;
}

async function signIn(code) {
  resetRateLimiter();
  const c = jar();
  const res = await call('POST', '/api/session', { body: { code }, cookies: c });
  assert.equal(res.status, 200, `expected sign-in to succeed for ${code}`);
  return c;
}

/** The `updatedAt` this session is told, which is the whole point of item 14's fourth gap. */
async function updatedAtFor(cookies) {
  const res = await call('GET', '/api/schedule', { cookies });
  assert.equal(res.status, 200);
  return res.body.updatedAt;
}

const blockById = (id) => db.prepare('SELECT * FROM schedule_blocks WHERE id = ?').get(id);

before(async () => {
  seedFixture();
  server = createApp({ serveClient: false }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  admin = await signInAdmin();
});

after(() => {
  server?.close();
  db.close();
});

/* ------------------------------------------------------------------ *
 * Gap 1 — concurrent admin edits were last-write-wins
 * ------------------------------------------------------------------ */

describe('concurrent admin edits', () => {
  test('a second save against a stale version is refused, not applied', async () => {
    const before = await asAdmin('GET', '/api/admin/blocks?day=Sat');
    const stale = before.body.blocks.find((b) => b.id === 'b_team_a');

    // Admin one saves.
    const first = await asAdmin('PATCH', '/api/admin/blocks/b_team_a', {
      startTime: '09:30',
      expectedUpdatedAt: stale.updatedAt,
    });
    assert.equal(first.status, 200);

    // Admin two, still holding the version from before, saves something else.
    const second = await asAdmin('PATCH', '/api/admin/blocks/b_team_a', {
      activity: 'Alpha warm-up (moved to studio)',
      expectedUpdatedAt: stale.updatedAt,
    });
    assert.equal(second.status, 409);
    assert.equal(second.body.reason, 'conflict');

    const row = blockById('b_team_a');
    assert.equal(row.start_time, '09:30', "the first admin's change must survive");
    assert.equal(row.activity_label, 'Alpha warm-up', 'the stale write must not have landed');
  });

  test('the conflict response carries the current block, so the panel can say what changed', async () => {
    const row = blockById('b_team_a');
    const res = await asAdmin('PATCH', '/api/admin/blocks/b_team_a', {
      activity: 'Something else',
      expectedUpdatedAt: '2020-01-01T00:00:00.000Z',
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.current.id, 'b_team_a');
    assert.equal(res.body.current.activity, row.activity_label);
    assert.equal(res.body.current.updatedAt, row.updated_at);
  });

  test('deleting a block someone else just moved is refused too', async () => {
    const res = await call('DELETE', '/api/admin/blocks/b_team_a?expectedUpdatedAt=2020-01-01T00%3A00%3A00.000Z', {
      cookies: admin,
    });
    assert.equal(res.status, 409);
    assert.ok(blockById('b_team_a'), 'the block must still be there');
  });

  test('a fresh version still saves', async () => {
    const current = blockById('b_team_a');
    const res = await asAdmin('PATCH', '/api/admin/blocks/b_team_a', {
      notes: 'Bring water',
      expectedUpdatedAt: current.updated_at,
    });
    assert.equal(res.status, 200);
    assert.equal(blockById('b_team_a').notes, 'Bring water');
  });

  test('the guard is opt-in, so the importer is unaffected', async () => {
    // No `expectedUpdatedAt` at all — the pre-item-14 call shape.
    const res = await asAdmin('PATCH', '/api/admin/blocks/b_team_a', { notes: 'Bring two waters' });
    assert.equal(res.status, 200);
    assert.equal(blockById('b_team_a').notes, 'Bring two waters');
  });
});

/* ------------------------------------------------------------------ *
 * Gap 2 — a dead magic link opened while already signed in
 * ------------------------------------------------------------------ */

describe('a dead magic link opened while signed in', () => {
  test('redirects with a reason and leaves the working session alone', async () => {
    const cookies = await signIn(codes.teamA);
    const before = await call('GET', '/api/session', { cookies });
    assert.equal(before.body.subject.name, 'Alpha Crew');

    // Gamma's code is revoked, then someone taps Gamma's old link on a phone
    // that is already signed in as Alpha.
    const dead = issueCode({ subjectType: 'team', subjectId: 'team_c' }).code;
    revokeCode(dead);
    const res = await call('GET', `/s/${dead}`, { cookies });

    assert.equal(res.status, 302);
    assert.equal(
      res.headers.get('location'),
      '/?signin=revoked',
      'the reason has to survive the redirect — it is all the client has to explain itself with'
    );

    // And the session it arrived with is untouched, which is exactly why the
    // client cannot just show the code screen: there is nothing wrong with it.
    const after = await call('GET', '/api/session', { cookies });
    assert.equal(after.status, 200);
    assert.equal(after.body.subject.name, 'Alpha Crew');
  });

  test('an unknown code reports invalid rather than revoked', async () => {
    const cookies = await signIn(codes.teamA);
    const res = await call('GET', '/s/ZZZZZZZZ', { cookies });
    assert.equal(res.headers.get('location'), '/?signin=invalid');
  });
});

/* ------------------------------------------------------------------ *
 * Gap 3 — deleting a person or team orphaned their blocks
 * ------------------------------------------------------------------ */

describe('deleting a subject that still has blocks', () => {
  beforeEach(() => {
    db.exec(`
      DELETE FROM schedule_blocks WHERE id LIKE 'b_tmp%';
      DELETE FROM people WHERE id LIKE 'p_tmp%';
      DELETE FROM teams WHERE id LIKE 'team_tmp%';
    `);
  });

  const addPerson = (id, name, teamId = null) => {
    db.prepare('INSERT INTO people (id,name,team_id) VALUES (?,?,?)').run(id, name, teamId);
    db.prepare('INSERT INTO person_roles (person_id,role_id) VALUES (?,?)').run(id, 'dancer');
  };

  const addBlock = (id, type, targetId) => {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO schedule_blocks
         (id,day,start_time,end_time,activity_label,applies_to_type,applies_to_id,
          source,created_at,updated_at)
       VALUES (?,'Sat','11:00','12:00','Temp block',?,?,'test',?,?)`
    ).run(id, type, targetId, now, now);
  };

  test('is refused with the count rather than silently orphaning them', async () => {
    addPerson('p_tmp1', 'Temp Dancer', 'team_a');
    addBlock('b_tmp1', 'person', 'p_tmp1');

    const res = await asAdmin('DELETE', '/api/admin/people/p_tmp1');
    assert.equal(res.status, 409);
    assert.equal(res.body.reason, 'has-blocks');
    assert.equal(res.body.blockCount, 1);
    assert.ok(db.prepare('SELECT 1 FROM people WHERE id = ?').get('p_tmp1'), 'nothing deleted yet');
    assert.ok(blockById('b_tmp1'));
  });

  test('confirming removes the person and their blocks together', async () => {
    addPerson('p_tmp2', 'Temp Dancer Two', 'team_a');
    addBlock('b_tmp2', 'person', 'p_tmp2');

    const res = await call('DELETE', '/api/admin/people/p_tmp2?removeBlocks=1', { cookies: admin });
    assert.equal(res.status, 200);
    assert.equal(res.body.removedBlocks, 1);
    assert.equal(db.prepare('SELECT 1 FROM people WHERE id = ?').get('p_tmp2'), undefined);
    assert.equal(blockById('b_tmp2'), undefined, 'the block must go with them');
  });

  test('each removed block gets its own edit-log line, with the name still in it', async () => {
    addPerson('p_tmp3', 'Nadia Novak', 'team_a');
    addBlock('b_tmp3', 'person', 'p_tmp3');

    await call('DELETE', '/api/admin/people/p_tmp3?removeBlocks=1', { cookies: admin });
    const entry = db
      .prepare('SELECT * FROM edit_log WHERE schedule_block_id = ?')
      .get('b_tmp3');
    assert.ok(entry, 'a bulk DELETE would have left no trace of this block at all');
    assert.match(
      entry.change_summary,
      /Nadia Novak/,
      'the log has to name the person, which means deleting blocks before the roster row'
    );
    assert.ok(JSON.parse(entry.audience_json).personIds.includes('p_tmp3'));
  });

  test('someone with no blocks deletes without a second question', async () => {
    addPerson('p_tmp4', 'Temp Dancer Four', 'team_a');
    const res = await asAdmin('DELETE', '/api/admin/people/p_tmp4');
    assert.equal(res.status, 200);
    assert.equal(res.body.removedBlocks, 0);
  });

  test('a team takes its own blocks but leaves its dancers theirs', async () => {
    db.prepare('INSERT INTO teams (id,name) VALUES (?,?)').run('team_tmp', 'Temp Crew');
    addPerson('p_tmp5', 'Temp Dancer Five', 'team_tmp');
    addBlock('b_tmp5', 'team', 'team_tmp');
    addBlock('b_tmp6', 'person', 'p_tmp5');

    const refused = await asAdmin('DELETE', '/api/admin/teams/team_tmp');
    assert.equal(refused.status, 409);
    assert.equal(refused.body.blockCount, 1, 'only the team-targeted block counts');

    const res = await call('DELETE', '/api/admin/teams/team_tmp?removeBlocks=1', { cookies: admin });
    assert.equal(res.status, 200);
    assert.equal(res.body.removedBlocks, 1);
    assert.equal(blockById('b_tmp5'), undefined);
    // The dancer is unassigned, not deleted, so their own block still resolves.
    assert.ok(blockById('b_tmp6'), 'a personal block outlives the team');
    assert.equal(db.prepare('SELECT team_id FROM people WHERE id = ?').get('p_tmp5').team_id, null);
  });

  test('no block anywhere points at a subject that is gone', () => {
    const dangling = db
      .prepare(
        `SELECT b.id FROM schedule_blocks b
          WHERE (b.applies_to_type = 'person'
                 AND NOT EXISTS (SELECT 1 FROM people p WHERE p.id = b.applies_to_id))
             OR (b.applies_to_type = 'team'
                 AND NOT EXISTS (SELECT 1 FROM teams t WHERE t.id = b.applies_to_id))
             OR (b.applies_to_type = 'role'
                 AND NOT EXISTS (SELECT 1 FROM roles r WHERE r.id = b.applies_to_id))`
      )
      .all();
    assert.deepEqual(dangling, [], 'orphaned blocks are invisible to viewers and clean up never');
  });
});

/* ------------------------------------------------------------------ *
 * Gap 4 — "Last updated" was global
 * ------------------------------------------------------------------ */

describe('"last updated" is per subject', () => {
  test("one team's change does not move another team's timestamp", async () => {
    const alpha = await signIn(codes.teamA);
    const beta = await signIn(codes.teamB);

    const alphaBefore = await updatedAtFor(alpha);
    const betaBefore = await updatedAtFor(beta);

    const current = blockById('b_team_a');
    const res = await asAdmin('PATCH', '/api/admin/blocks/b_team_a', {
      startTime: '09:45',
      expectedUpdatedAt: current.updated_at,
    });
    assert.equal(res.status, 200);

    assert.notEqual(await updatedAtFor(alpha), alphaBefore, "Alpha's schedule did change");
    assert.equal(
      await updatedAtFor(beta),
      betaBefore,
      "Beta saw nothing change, so Beta must not be told anything changed"
    );
  });

  test('a deleted block still moves the timestamp of whoever lost it', async () => {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO schedule_blocks
         (id,day,start_time,end_time,activity_label,applies_to_type,applies_to_id,
          source,created_at,updated_at)
       VALUES ('b_del','Sat','13:00','14:00','Doomed block','team','team_b','test',?,?)`
    ).run(now, now);

    const beta = await signIn(codes.teamB);
    const before = await updatedAtFor(beta);

    const res = await call('DELETE', '/api/admin/blocks/b_del', { cookies: admin });
    assert.equal(res.status, 200);

    assert.notEqual(
      await updatedAtFor(beta),
      before,
      'a cancellation leaves no row behind, which is why this cannot be derived from the blocks'
    );
  });

  test('a role change reaches everyone holding that role', async () => {
    const alpha = await signIn(codes.teamA);
    const judge = await signIn(codes.judge);
    const alphaBefore = await updatedAtFor(alpha);
    const judgeBefore = await updatedAtFor(judge);

    const created = await asAdmin('POST', '/api/admin/blocks', {
      day: 'Sat',
      startTime: '19:00',
      endTime: '20:00',
      activity: 'All-dancer notes',
      appliesToType: 'role',
      appliesToId: 'dancer',
    });
    assert.equal(created.status, 200);

    assert.notEqual(await updatedAtFor(alpha), alphaBefore, 'a dancer session holds the dancer role');
    assert.equal(await updatedAtFor(judge), judgeBefore, 'a judge does not');
  });

  test('a target with no version row does not read as freshly changed', async () => {
    // The trap this guards: the last fallback used to be the global
    // `schedule_updated_at`, which every write bumps. A target missing a row
    // therefore read as "just updated by somebody else's edit" — the exact bug
    // the table replaces, restored silently through the back door.
    const { versionForTargets, touchScheduleVersion } = await import('../server/db.js');
    const orphanTarget = [{ type: 'team', id: 'team_never_touched' }];

    // With no roster floor either, so the last hop in the chain is the one under
    // test rather than something shadowing it.
    const savedFloor = db.prepare("SELECT value FROM meta WHERE key = 'roster_updated_at'").get();
    db.prepare("DELETE FROM meta WHERE key = 'roster_updated_at'").run();
    try {
      const before = versionForTargets(orphanTarget);
      touchScheduleVersion(); // an unrelated edit somewhere else at the event
      assert.equal(
        versionForTargets(orphanTarget),
        before,
        'an unrelated write must not move the timestamp of a target it never touched'
      );
      assert.ok(before, 'and it still has to be a renderable timestamp, not null');
    } finally {
      if (savedFloor) {
        db.prepare("INSERT INTO meta (key, value) VALUES ('roster_updated_at', ?)").run(savedFloor.value);
      }
    }
  });

  test('a roster change is a floor under everyone, because it has no audience', async () => {
    const alpha = await signIn(codes.teamA);
    const judge = await signIn(codes.judge);
    const judgeBefore = await updatedAtFor(judge);

    const res = await asAdmin('PATCH', '/api/admin/teams/team_a', { name: 'Alpha Crew Renamed' });
    assert.equal(res.status, 200);

    // No block changed, but a renamed team can change what unrelated schedules
    // render, and there is nothing to derive a narrower audience from.
    assert.notEqual(await updatedAtFor(judge), judgeBefore);
    assert.ok(await updatedAtFor(alpha));
  });
});

/* ------------------------------------------------------------------ *
 * Gap 5 — placeholder seed blocks and the import's managed set
 * ------------------------------------------------------------------ */

describe('placeholder blocks are outside every import\'s managed set', () => {
  test('an import with removeMissing cannot delete them', () => {
    // An import that manages `k_alpha` and nothing else. `removeMissing` is what
    // would sweep up anything the import believes it owns.
    const diff = computeScheduleDiff(
      [
        {
          sourceKey: 'k_alpha',
          day: 'Sat',
          startTime: '09:45',
          endTime: '10:00',
          activity: 'Alpha warm-up',
          appliesToType: 'team',
          appliesToId: 'team_a',
          venue: null,
          subLocation: null,
          notes: null,
        },
      ],
      { removeMissing: true }
    );

    const doomed = diff.delete.map((d) => d.id);
    assert.ok(!doomed.includes('b_seed_a'), 'a seed block must never be import-managed');
    assert.ok(!doomed.includes('b_seed_role'));
    assert.ok(
      !doomed.includes('b_alice'),
      'nor must a manually added block — both are unmanaged for the same reason: no source key'
    );
    assert.ok(doomed.includes('b_team_b'), 'a keyed row the file no longer has is the real case');
  });

  test('clearing them logs each removal rather than one unattributable line', async () => {
    const seedIds = db
      .prepare("SELECT id FROM schedule_blocks WHERE source = 'seed'")
      .all()
      .map((b) => b.id);
    assert.ok(seedIds.length >= 2, 'fixture should still have placeholder blocks');

    const res = await call('DELETE', '/api/admin/seed-data', { cookies: admin });
    assert.equal(res.status, 200);
    assert.equal(res.body.removed, seedIds.length);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM schedule_blocks WHERE source = 'seed'").get().n,
      0
    );

    for (const id of seedIds) {
      const entry = db.prepare('SELECT * FROM edit_log WHERE schedule_block_id = ?').get(id);
      assert.ok(entry, `block ${id} should have its own edit-log line`);
      assert.equal(entry.change_type, 'deleted');
    }
  });

  test('clearing them again is a no-op', async () => {
    const res = await call('DELETE', '/api/admin/seed-data', { cookies: admin });
    assert.equal(res.status, 200);
    assert.equal(res.body.removed, 0);
  });
});
