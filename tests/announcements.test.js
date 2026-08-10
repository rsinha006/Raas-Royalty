/**
 * Event-wide announcements — item 18.
 *
 * "Fire alarm, evacuate" used to mean creating six near-identical blocks, one
 * per audience, each with its own chance of being forgotten. It is now one
 * block targeting `everyone`, which every session's target list contains.
 *
 * The decision that shapes these tests: `everyone` is a block *target* and
 * nothing else. It is never a session subject and never an access-code subject,
 * so nobody can sign in "as everyone" and no credential exists for it. Several
 * of the tests below exist only to hold that line, because the natural drift is
 * for a fourth target type to leak into the three-way lists that mean something
 * different.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'royalty-announce-')), 'test.db');
process.env.DB_PATH = TMP_DB;
process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'test-admin-password';
process.env.EVENT_TIMEZONE = 'America/Indiana/Indianapolis';

const { db } = await import('../server/db.js');
const { createApp } = await import('../server/app.js');
const { issueCode } = await import('../server/lib/access-codes.js');
const { EVERYONE, describeTarget, resolveSession } = await import('../server/lib/queries.js');
const { roomsForTargets } = await import('../server/lib/live.js');
const { audienceForBlock } = await import('../server/lib/mutations.js');
const { resolveAssignment } = await import('../server/sync/normalize.js');

let server;
let base;
let admin;
const codes = {};

const START = new Date('2026-08-01T12:00:00.000Z').toISOString();

function seedFixture() {
  db.exec(`
    INSERT INTO roles (id,label,selector,sort_order,active) VALUES
      ('dancer','Dancer','team',1,1),
      ('judge','Judge','person',3,1);
    INSERT INTO event_days (key,label,date,sort_order) VALUES
      ('Fri','Friday','2026-08-07',1),
      ('Sat','Saturday','2026-08-08',2);
    INSERT INTO teams (id,name) VALUES ('team_a','Alpha Crew'),('team_b','Beta Crew');
    INSERT INTO people (id,name,team_id) VALUES
      ('p_alice','Alice Alpha','team_a'),
      ('p_judge','Jo Judge',NULL),
      ('p_loose','Lee Unassigned',NULL);
    INSERT INTO person_roles (person_id,role_id) VALUES
      ('p_alice','dancer'),('p_judge','judge'),('p_loose','dancer');
    INSERT INTO schedule_blocks
      (id,day,start_time,end_time,activity_label,applies_to_type,applies_to_id,
       source,created_at,updated_at)
    VALUES ('b_alpha','Sat','09:00','10:00','Alpha warm-up','team','team_a','test','${START}','${START}');
  `);
  codes.teamA = issueCode({ subjectType: 'team', subjectId: 'team_a' }).code;
  codes.judge = issueCode({ subjectType: 'person', subjectId: 'p_judge' }).code;
}

/* ------------------------------- harness ------------------------------- */

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
  });
  cookies?.absorb(res);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not every response is JSON */
  }
  return { status: res.status, body: json };
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

/** A viewer's own schedule, fetched the way their phone would. */
async function scheduleFor(code, personId = null) {
  const c = jar();
  assert.equal((await call('POST', '/api/session', { body: { code }, cookies: c })).status, 200);
  if (personId) {
    const picked = await call('POST', '/api/session/identify', { body: { personId }, cookies: c });
    assert.equal(picked.status, 200, picked.body?.error);
  }
  const res = await call('GET', '/api/schedule', { cookies: c });
  assert.equal(res.status, 200, res.body?.error);
  return res.body;
}

const announce = (activity = 'Fire alarm — evacuate to the north car park', extra = {}) =>
  asAdmin('POST', '/api/admin/blocks', {
    day: 'Sat',
    startTime: '13:00',
    endTime: '13:15',
    activity,
    appliesToType: 'everyone',
    appliesToId: 'all',
    ...extra,
  });

const activities = (payload) => payload.blocks.map((b) => b.activity);

before(async () => {
  seedFixture();
  server = createApp({ serveClient: false }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  admin = await signInAdmin();
});

after(() => {
  server?.close();
  try {
    fs.rmSync(path.dirname(TMP_DB), { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

/* ------------------------------ one block, everyone ------------------------------ */

describe('one block instead of six', () => {
  test('every kind of session sees it', async () => {
    const created = await announce();
    assert.equal(created.status, 200, created.body?.error);

    const team = await scheduleFor(codes.teamA);
    const dancer = await scheduleFor(codes.teamA, 'p_alice');
    const staff = await scheduleFor(codes.judge);

    for (const [who, payload] of [['team', team], ['dancer', dancer], ['staff', staff]]) {
      assert.ok(
        activities(payload).some((a) => a.startsWith('Fire alarm')),
        `${who} should see the announcement`
      );
    }
    // And it did not need six blocks to get there.
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM schedule_blocks WHERE applies_to_type = 'everyone'").get().n, 1);
  });

  test('including someone with no team and no personal code', async () => {
    // Lee holds Dancer but is on no team, which item 14's team delete produces.
    // Their schedule is otherwise empty; an evacuation still has to reach it.
    const resolved = resolveSession({ type: 'person', id: 'p_loose' });
    assert.deepEqual(resolved.targets, [
      { type: 'person', id: 'p_loose' },
      { type: 'role', id: 'dancer' },
      { type: 'everyone', id: 'all' },
    ]);
  });

  test('every session is in the one announcement room', () => {
    const roomsFor = (session) => roomsForTargets(resolveSession(session).targets);
    for (const session of [
      { type: 'team', id: 'team_a' },
      { type: 'person', id: 'p_alice' },
      { type: 'person', id: 'p_judge' },
      { type: 'role', id: 'judge' },
    ]) {
      assert.ok(roomsFor(session).includes('everyone:all'), JSON.stringify(session));
    }
  });

  test('the change log names the whole roster as the audience', () => {
    const audience = audienceForBlock({ appliesToType: 'everyone', appliesToId: 'all' });
    // Everyone, not just people on teams — Lee counts.
    assert.deepEqual(audience.personIds.sort(), ['p_alice', 'p_judge', 'p_loose']);
    assert.deepEqual(audience.teamIds.sort(), ['team_a', 'team_b']);
  });

  test('it reads as "Everyone" wherever a target is named', () => {
    assert.equal(describeTarget('everyone', 'all'), 'Everyone');
  });
});

/* ------------------------------ "last updated" ------------------------------ */

describe('an announcement moves everyone’s timestamp', () => {
  test('and that is the one change for which that is honest', async () => {
    const before = {
      team: (await scheduleFor(codes.teamA)).updatedAt,
      staff: (await scheduleFor(codes.judge)).updatedAt,
    };

    await new Promise((r) => setTimeout(r, 5));
    const created = await announce('Doors held 20 minutes — stay in the lobby');
    assert.equal(created.status, 200, created.body?.error);

    // Item 14 made "last updated" per-subject precisely so one team's edit did
    // not tell 280 people their day had changed. This is the exception that
    // proves it works: the timestamp moves for everyone because it is true.
    assert.notEqual((await scheduleFor(codes.teamA)).updatedAt, before.team);
    assert.notEqual((await scheduleFor(codes.judge)).updatedAt, before.staff);
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS n FROM target_versions WHERE target_type = 'everyone'")
        .get().n,
      1,
      'one announcement key, not one per session'
    );
  });
});

/* ------------------------------ the sentinel ------------------------------ */

describe('there is exactly one announcement audience', () => {
  test('a junk id is normalized rather than stored', async () => {
    const res = await announce('Water station moved', { appliesToId: 'team_a' });
    assert.equal(res.status, 200, res.body?.error);

    const row = db.prepare('SELECT applies_to_id FROM schedule_blocks WHERE id = ?').get(res.body.id);
    assert.equal(row.applies_to_id, EVERYONE.id);
  });

  test('retargeting an existing block to everyone drops the old id', async () => {
    const patched = await asAdmin('PATCH', '/api/admin/blocks/b_alpha', {
      appliesToType: 'everyone',
    });
    assert.equal(patched.status, 200, patched.body?.error);

    const row = db.prepare('SELECT * FROM schedule_blocks WHERE id = ?').get('b_alpha');
    assert.equal(row.applies_to_type, 'everyone');
    // Without normalizing on update this would still say `team_a`, which would
    // be a second announcement room nobody is in.
    assert.equal(row.applies_to_id, 'all');

    await asAdmin('PATCH', '/api/admin/blocks/b_alpha', {
      appliesToType: 'team',
      appliesToId: 'team_a',
    });
  });

  test('and the database refuses a second one even by raw SQL', () => {
    // The normalizer above is the convenience; this is the guarantee. A hand-run
    // fix at 2am during the event is exactly the path that skips the JS.
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO schedule_blocks
               (id,day,start_time,end_time,activity_label,applies_to_type,applies_to_id,
                source,created_at,updated_at)
             VALUES ('b_bad','Sat','10:00','10:30','Sneaky','everyone','team_a','test',?,?)`
          )
          .run(START, START),
      /CHECK constraint failed/
    );
  });
});

/* ------------------------------ what it is not ------------------------------ */

describe('everyone is a target, not a subject', () => {
  test('no access code can be issued for it', () => {
    assert.throws(() => issueCode({ subjectType: 'everyone', subjectId: 'all' }));
  });

  test('nobody can view as it', async () => {
    // Not a 404 but a 400: it is not a subject that might exist, it is not the
    // kind of thing a session is. Every session already contains it.
    const res = await asAdmin('GET', '/api/admin/view-as?type=everyone&id=all');
    assert.equal(res.status, 400);
  });

  test('it is offered as an assignment target, first', async () => {
    const { body } = await asAdmin('GET', '/api/admin/targets');
    assert.deepEqual(body.targets[0], {
      type: 'everyone',
      id: 'all',
      label: 'Everyone at the event',
      group: 'Everyone',
    });
  });
});

/* ------------------------------ the importer ------------------------------ */

describe('a spreadsheet can say it too', () => {
  const index = {
    teams: new Map([['alpha crew', 'team_a']]),
    people: new Map([['alice alpha', ['p_alice']]]),
    roles: new Map([['dancer', 'dancer']]),
  };

  for (const word of ['Everyone', 'everyone', 'All', 'EVERYBODY']) {
    test(`"${word}" resolves to the announcement target`, () => {
      assert.deepEqual(resolveAssignment(word, index), { type: 'everyone', id: 'all' });
    });
  }

  test('and it still resolves ordinary assignments', () => {
    assert.deepEqual(resolveAssignment('Alpha Crew', index), { type: 'team', id: 'team_a' });
    assert.deepEqual(resolveAssignment('Alice Alpha', index), { type: 'person', id: 'p_alice' });
  });
});

/* ------------------------------ and it undoes ------------------------------ */

describe('an announcement is an ordinary block', () => {
  test('so posting one can be taken back', async () => {
    const created = await announce('Posted by mistake');
    assert.equal(created.status, 200, created.body?.error);
    const id = created.body.id;

    const batch = (await asAdmin('GET', '/api/admin/undo')).body.batches[0];
    assert.equal(batch.canUndo, true);

    const undone = await asAdmin('POST', '/api/admin/undo', { batchId: batch.batchId });
    assert.equal(undone.status, 200, undone.body?.error);
    assert.equal(db.prepare('SELECT * FROM schedule_blocks WHERE id = ?').get(id), undefined);

    const team = await scheduleFor(codes.teamA);
    assert.ok(!activities(team).includes('Posted by mistake'));
  });
});
