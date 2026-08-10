/**
 * "View as" — item 16.
 *
 * The tool exists to answer "I don't see my warm-up", which means its one
 * unforgivable failure is agreeing with the admin's mental model while the
 * phone does something else. So the central test here does not check the
 * preview against expectations at all: it signs a real viewer in with a real
 * access code, fetches `/api/schedule` the way their phone would, and asserts
 * the preview is that same payload. Everything else is diagnosis — the target
 * list and the sign-in route, which are what turn "she can't see it" into a fix.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'royalty-view-as-')), 'test.db');
process.env.DB_PATH = TMP_DB;
process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'test-admin-password';
process.env.EVENT_TIMEZONE = 'America/Indiana/Indianapolis';

const { db } = await import('../server/db.js');
const { createApp } = await import('../server/app.js');
const { issueCode, subjectsNeedingCodes } = await import('../server/lib/access-codes.js');
const { previewFor, ROUTES } = await import('../server/lib/view-as.js');

let server;
let base;
let admin;
const codes = {};

const START = new Date('2026-08-01T12:00:00.000Z').toISOString();

/**
 * The fixture is built around the four people whose views differ for four
 * different reasons: a captain (two roles), a plain dancer on the same team,
 * a judge reached individually, and a dancer on no team — which item 14's
 * "deleting a team unassigns its dancers" makes a state the roster really
 * reaches.
 */
const BLOCKS = [
  ['b_team_a', 'Sat', '09:00', '10:00', 'Alpha warm-up', 'team', 'team_a'],
  ['b_team_b', 'Sat', '10:00', '11:00', 'Beta warm-up', 'team', 'team_b'],
  ['b_dancers', 'Sat', '12:00', '12:30', 'All-dancer briefing', 'role', 'dancer'],
  ['b_captains', 'Fri', '18:00', '18:30', 'Captains meeting', 'role', 'captain'],
  ['b_judges', 'Sat', '09:30', '10:00', 'Judges check-in', 'role', 'judge'],
  ['b_maya', 'Fri', '14:00', '15:00', 'Maya airport pickup', 'person', 'p_maya'],
];

function seedFixture() {
  db.exec(`
    INSERT INTO roles (id,label,selector,sort_order,active) VALUES
      ('dancer','Dancer','team',1,1),
      ('judge','Judge','person',3,1),
      ('captain','Captain','person',9,1);
    INSERT INTO event_days (key,label,date,sort_order) VALUES
      ('Fri','Friday','2026-08-07',1),
      ('Sat','Saturday','2026-08-08',2);
    INSERT INTO teams (id,name) VALUES ('team_a','Alpha Crew'),('team_b','Beta Crew');
    INSERT INTO people (id,name,team_id) VALUES
      ('p_maya','Maya Captain','team_a'),
      ('p_nina','Nina Dancer','team_a'),
      ('p_judge','Jo Judge',NULL),
      ('p_orphan','Ollie Unassigned',NULL);
    INSERT INTO person_roles (person_id,role_id) VALUES
      ('p_maya','dancer'),('p_maya','captain'),
      ('p_nina','dancer'),
      ('p_judge','judge'),
      ('p_orphan','dancer');
  `);

  const insert = db.prepare(
    `INSERT INTO schedule_blocks
       (id,day,start_time,end_time,activity_label,applies_to_type,applies_to_id,
        source,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,'test',?,?)`
  );
  for (const b of BLOCKS) insert.run(...b, START, START);

  codes.teamA = issueCode({ subjectType: 'team', subjectId: 'team_a' }).code;
  codes.teamB = issueCode({ subjectType: 'team', subjectId: 'team_b' }).code;
  codes.judge = issueCode({ subjectType: 'person', subjectId: 'p_judge' }).code;
  // team_b deliberately keeps its code; p_orphan and the roles get none.
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

/** Sign a viewer in with a real code, optionally picking a name afterwards. */
async function asViewer(code, personId = null) {
  const c = jar();
  const signIn = await call('POST', '/api/session', { body: { code }, cookies: c });
  assert.equal(signIn.status, 200, signIn.body?.error);
  if (personId) {
    const picked = await call('POST', '/api/session/identify', {
      body: { personId },
      cookies: c,
    });
    assert.equal(picked.status, 200, picked.body?.error);
  }
  const schedule = await call('GET', '/api/schedule', { cookies: c });
  assert.equal(schedule.status, 200, schedule.body?.error);
  return schedule.body;
}

const viewAs = async (type, id) => asAdmin('GET', `/api/admin/view-as?type=${type}&id=${id}`);

/**
 * Everything about a payload that is not the moment it was produced.
 * `fetchedAt` and the server's `now` differ between two calls by construction;
 * comparing them would fail on a correct implementation.
 */
function stable(payload) {
  const { fetchedAt, eventTime, identified, ...rest } = payload;
  // The zone still has to match — it is the one part of `eventTime` that is a
  // property of the event rather than of the moment the payload was built.
  return { ...rest, timezone: eventTime.timezone };
}

const activities = (payload) => payload.blocks.map((b) => b.activity).sort();

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

/* ------------------------------- fidelity ------------------------------- */

describe('the preview is the viewer’s own payload', () => {
  test('a team code before the identity step', async () => {
    const phone = await asViewer(codes.teamA);
    const preview = await viewAs('team', 'team_a');

    assert.equal(preview.status, 200);
    assert.deepEqual(stable(preview.body.schedule), stable(phone));
  });

  test('a dancer who has picked her name', async () => {
    const phone = await asViewer(codes.teamA, 'p_maya');
    const preview = await viewAs('person', 'p_maya');

    assert.equal(preview.status, 200);
    assert.deepEqual(stable(preview.body.schedule), stable(phone));
  });

  test('a staff member with their own code', async () => {
    const phone = await asViewer(codes.judge);
    const preview = await viewAs('person', 'p_judge');

    assert.equal(preview.status, 200);
    assert.deepEqual(stable(preview.body.schedule), stable(phone));
  });
});

/* ---------------------------- what each view holds ---------------------------- */

describe('the four views that get confused for each other', () => {
  test('a captain sees her team, all dancers, the captains meeting and her own pickup', async () => {
    const { body } = await viewAs('person', 'p_maya');
    assert.deepEqual(activities(body.schedule), [
      'All-dancer briefing',
      'Alpha warm-up',
      'Captains meeting',
      'Maya airport pickup',
    ]);
  });

  test('a teammate who is not a captain sees neither the meeting nor the pickup', async () => {
    const { body } = await viewAs('person', 'p_nina');
    assert.deepEqual(activities(body.schedule), ['All-dancer briefing', 'Alpha warm-up']);
  });

  test('the pre-identity team view holds no person or captain blocks at all', async () => {
    // This is the answer to "I don't see my warm-up" more often than anything
    // else on this page: she is looking at the team view and has not tapped
    // her name, so nothing targeted at *her* is in it.
    const { body } = await viewAs('team', 'team_a');
    assert.deepEqual(activities(body.schedule), ['All-dancer briefing', 'Alpha warm-up']);
    assert.deepEqual(
      body.members.map((m) => m.name),
      ['Maya Captain', 'Nina Dancer']
    );
  });

  test('a role view holds only that role’s blocks', async () => {
    const { body } = await viewAs('role', 'judge');
    assert.deepEqual(activities(body.schedule), ['Judges check-in']);
    assert.equal(body.members, null);
  });
});

describe('why these blocks', () => {
  test('the target list is what the schedule query ORs over, labelled', async () => {
    const { body } = await viewAs('person', 'p_maya');
    assert.deepEqual(body.targets, [
      { type: 'person', id: 'p_maya', label: 'Maya Captain' },
      { type: 'role', id: 'dancer', label: 'All Dancer' },
      { type: 'role', id: 'captain', label: 'All Captain' },
      { type: 'team', id: 'team_a', label: 'Alpha Crew' },
    ]);
  });

  test('a missing block is explained by a target the view does not hold', async () => {
    // The workflow the panel is built for: the captains meeting is absent from
    // Nina's view, and the reason is visible without reading any code — the
    // block targets `role:captain` and her targets do not include it.
    const nina = await viewAs('person', 'p_nina');
    const held = nina.body.targets.map((t) => `${t.type}:${t.id}`);

    assert.ok(!activities(nina.body.schedule).includes('Captains meeting'));
    assert.ok(!held.includes('role:captain'));
    assert.deepEqual(held, ['person:p_nina', 'role:dancer', 'team:team_a']);
  });
});

/* ------------------------------- how they sign in ------------------------------- */

describe('how a real person reaches the view', () => {
  test('staff use their own code', async () => {
    const { body } = await viewAs('person', 'p_judge');
    assert.equal(body.access.route, ROUTES.OWN);
    assert.equal(body.access.code.subjectType, 'person');
    assert.equal(body.access.code.live, true);
  });

  test('a captain is behind her team’s code and the identity step', async () => {
    // The trap: a captain holds a person-selector role (Captain), so asking
    // "does she hold a person-selector role?" would send us hunting for a
    // personal code she is never issued. She is reached through her team.
    const { body } = await viewAs('person', 'p_maya');
    assert.equal(body.access.route, ROUTES.TEAM_THEN_NAME);
    assert.equal(body.access.code.subjectId, 'team_a');
    assert.equal(body.access.code.live, true);
  });

  test('a dancer on no team cannot sign in at all, and the view says so', async () => {
    const { body } = await viewAs('person', 'p_orphan');
    assert.equal(body.access.route, ROUTES.NONE);
    assert.equal(body.access.code, null);
    assert.match(body.access.note, /on no team/);
    // The schedule itself is perfectly fine — which is exactly why this is
    // worth surfacing. Staring at the blocks would never reveal it.
    assert.deepEqual(activities(body.schedule), ['All-dancer briefing']);
  });

  test('a subject with no live code is reported as unreachable, not as empty', async () => {
    const { body } = await viewAs('role', 'captain');
    assert.equal(body.access.route, ROUTES.ROLE);
    assert.equal(body.access.code.live, false);
    assert.deepEqual(activities(body.schedule), ['Captains meeting']);
  });

  test('the sign-in route agrees with who actually gets a personal code', () => {
    // A drift guard rather than a behaviour test. Both this module and
    // `subjectsNeedingCodes` decide "is this person reached individually", and
    // if they ever disagree the panel will confidently name the wrong link.
    const individually = new Set(
      subjectsNeedingCodes()
        .filter((s) => s.subjectType === 'person')
        .map((s) => s.subjectId)
    );
    const people = db.prepare('SELECT id FROM people').all();
    assert.ok(people.length >= 4);

    for (const { id } of people) {
      const { access } = previewFor({ type: 'person', id });
      assert.equal(
        access.route === ROUTES.OWN,
        individually.has(id),
        `${id}: view-as says ${access.route}, subjectsNeedingCodes says ${
          individually.has(id) ? 'own code' : 'not individually reached'
        }`
      );
    }
  });
});

/* --------------------------------- guards --------------------------------- */

describe('what the route refuses', () => {
  test('an unknown subject is a 404, not an empty schedule', async () => {
    const res = await viewAs('person', 'p_nobody');
    assert.equal(res.status, 404);
    // "Nothing scheduled" and "no such person" are two different conversations
    // at a check-in desk; a 200 with zero blocks would blur them.
    assert.equal(res.body.schedule, undefined);
  });

  test('an unknown subject type is refused', async () => {
    const res = await asAdmin('GET', '/api/admin/view-as?type=contact&id=c_1');
    assert.equal(res.status, 400);
  });

  test('a missing id is refused', async () => {
    const res = await asAdmin('GET', '/api/admin/view-as?type=person');
    assert.equal(res.status, 400);
  });

  test('it is not reachable without an admin session', async () => {
    const res = await call('GET', '/api/admin/view-as?type=person&id=p_maya');
    assert.equal(res.status, 401);
  });

  test('no access code string is ever in the response', async () => {
    // Deliberate: "is there a live code" is the diagnostic, but minting and
    // showing links stays in one place — the Access codes tab.
    const { body } = await viewAs('person', 'p_judge');
    assert.ok(!JSON.stringify(body).includes(codes.judge));
    assert.equal(body.access.code.code, undefined);
  });
});
