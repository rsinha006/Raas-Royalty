/**
 * Scoped broadcasts and the socket origin — item 11.
 *
 * Two claims are under test, and they are the two the item exists to make true.
 *
 * **Scoping.** A change reaches the people whose schedule contains it, and
 * nobody else. Most of what follows is therefore about who *didn't* get the
 * message — a suite that only checked delivery would pass against the old
 * broadcast-to-everyone code, which delivered to the right people by delivering
 * to all ~280 of them.
 *
 * **No audience on the wire.** The alternative design put `personIds` into the
 * payload for clients to filter on. There is a test that the payload still says
 * nothing about who is affected, because that is the property the origin
 * lockdown below is protecting, and it is easy to lose by accident later.
 *
 * The sockets are fakes, but everything above them is real: the real Express
 * app, real access codes, real signed cookies, the real hub, and room
 * membership derived by the real personalization query. What the fakes stand in
 * for is the network.
 */
import { test, before, after, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'royalty-live-test-')), 'test.db');
process.env.DB_PATH = TMP_DB;
process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'test-admin-password';

// Imported after DB_PATH is set — db.js resolves the path at import time.
const { db } = await import('../server/db.js');
const { createApp } = await import('../server/app.js');
const { issueCode, revokeCode } = await import('../server/lib/access-codes.js');
const { createLiveHub, originPolicy, parseCookieHeader, roomsForCookies, ADMIN_ROOM } =
  await import('../server/lib/live.js');

let server;
let base;
const codes = {};

/* ------------------------------- fixture ------------------------------- */

function seedFixture() {
  const now = new Date().toISOString();
  db.exec(`
    INSERT INTO roles (id,label,selector,sort_order,active) VALUES
      ('dancer','Dancer','team',1,1),
      ('judge','Judge','person',2,1),
      ('captain','Captain','person',9,1);
    INSERT INTO event_days (key,label,date,sort_order) VALUES ('Sat','Saturday','2026-08-08',1);
    INSERT INTO teams (id,name) VALUES ('team_a','Alpha Crew'),('team_b','Beta Crew');
    INSERT INTO people (id,name,team_id) VALUES
      ('p_alice','Alice Alpha','team_a'),
      ('p_amir','Amir Alpha','team_a'),
      ('p_bianca','Bianca Beta','team_b'),
      ('p_judge','Jordan Judge',NULL);
    INSERT INTO person_roles (person_id,role_id) VALUES
      ('p_alice','dancer'),('p_alice','captain'),
      ('p_amir','dancer'),
      ('p_bianca','dancer'),
      ('p_judge','judge');
  `);
  db.prepare(
    `INSERT INTO schedule_blocks
       (id,day,start_time,end_time,activity_label,applies_to_type,applies_to_id,
        source,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,'test',?,?)`
  ).run('b_team_a', 'Sat', '09:00', '10:00', 'Alpha warm-up', 'team', 'team_a', now, now);

  codes.teamA = issueCode({ subjectType: 'team', subjectId: 'team_a' }).code;
  codes.teamB = issueCode({ subjectType: 'team', subjectId: 'team_b' }).code;
  codes.judge = issueCode({ subjectType: 'person', subjectId: 'p_judge' }).code;
}

/* ------------------------------- helpers ------------------------------- */

/** Minimal cookie jar — fetch doesn't keep them. */
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
        const name = pair.slice(0, idx);
        const value = pair.slice(idx + 1);
        if (value === '') delete cookies[name];
        else cookies[name] = value;
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
    /* non-JSON bodies are fine to leave null */
  }
  return { status: res.status, body: json, text };
}

async function signIn(code) {
  const c = jar();
  const res = await call('POST', '/api/session', { body: { code }, cookies: c });
  assert.equal(res.status, 200, `expected sign-in to succeed for ${code}`);
  return c;
}

async function signInAdmin() {
  const c = jar();
  const res = await call('POST', '/api/admin/login', {
    body: { password: 'test-admin-password', name: 'Tester' },
    cookies: c,
  });
  assert.equal(res.status, 200);
  return c;
}

/**
 * A stand-in Socket.IO server: rooms, membership and fan-out for real, no
 * network. Room joining is done by the hub under test, not by this fake, so
 * what is being asserted is the hub's own logic.
 */
function fakeIo() {
  const sockets = new Map();
  let onConnection = () => {};
  let counter = 0;

  const deliverTo = (roomSet, event, body) => {
    for (const s of sockets.values()) {
      for (const room of s.rooms) {
        if (roomSet.has(room)) {
          s.inbox.push({ event, body });
          break;
        }
      }
    }
  };

  const io = {
    on(event, fn) {
      if (event === 'connection') onConnection = fn;
    },
    sockets: { sockets },
    to(rooms) {
      const set = new Set(Array.isArray(rooms) ? rooms : [rooms]);
      return { emit: (event, body) => deliverTo(set, event, body) };
    },
    emit(event, body) {
      for (const s of sockets.values()) s.inbox.push({ event, body });
    },
  };

  function connect(cookieHeader = '') {
    const socket = {
      id: `sock_${++counter}`,
      handshake: { headers: { cookie: cookieHeader } },
      rooms: new Set(),
      inbox: [],
      join(room) {
        this.rooms.add(room);
      },
      leave(room) {
        this.rooms.delete(room);
      },
      emit(event, body) {
        this.inbox.push({ event, body });
      },
    };
    socket.rooms.add(socket.id);
    sockets.set(socket.id, socket);
    onConnection(socket);
    return socket;
  }

  return { io, connect, sockets };
}

/** Change announcements only — the connection `hello` is not one. */
const changes = (socket) => socket.inbox.filter((m) => m.event.endsWith(':updated'));
const heard = (socket) => changes(socket).length > 0;
const drain = (...sockets) => sockets.forEach((s) => (s.inbox.length = 0));

let net;
let hub;
const seats = {};

before(async () => {
  seedFixture();
  net = fakeIo();
  hub = createLiveHub(net.io);
  server = createApp({ serveClient: false, broadcast: hub.broadcast }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;

  // One socket per kind of person at the event, each holding a real cookie.
  const teamA = await signIn(codes.teamA);
  const alice = await signIn(codes.teamA);
  await call('POST', '/api/session/identify', { body: { personId: 'p_alice' }, cookies: alice });
  const teamB = await signIn(codes.teamB);
  const judge = await signIn(codes.judge);
  const admin = await signInAdmin();

  seats.jars = { teamA, alice, teamB, judge, admin };
  seats.teamA = net.connect(teamA.header());
  seats.alice = net.connect(alice.header());
  seats.teamB = net.connect(teamB.header());
  seats.judge = net.connect(judge.header());
  seats.admin = net.connect(admin.header());
  seats.anon = net.connect('');
});

after(() => {
  server?.close();
  db.close();
  fs.rmSync(path.dirname(TMP_DB), { recursive: true, force: true });
});

beforeEach(() => drain(...Object.values(seats).filter((s) => s?.inbox)));

/* =========================== room membership =========================== */

describe('who a socket is', () => {
  test('a team code joins the team room and the team-wide role, nothing else', () => {
    assert.deepEqual([...seats.teamA.rooms].filter((r) => r !== seats.teamA.id).sort(), [
      'role:dancer',
      'team:team_a',
    ]);
  });

  test('identifying adds the person room and every role they hold', () => {
    const rooms = [...seats.alice.rooms].filter((r) => r !== seats.alice.id).sort();
    // A captain holds Dancer + Captain, so both role rooms — this is the same
    // multi-role list that puts the Captains Meeting on their schedule.
    assert.deepEqual(rooms, ['person:p_alice', 'role:captain', 'role:dancer', 'team:team_a']);
  });

  test('an unidentified team session is deliberately not in the Captain room', () => {
    assert.equal(seats.teamA.rooms.has('role:captain'), false);
  });

  test('a socket with no cookie joins nothing', () => {
    assert.deepEqual([...seats.anon.rooms], [seats.anon.id]);
  });

  test('a socket with a garbage cookie joins nothing rather than failing', () => {
    const junk = net.connect('royalty_session=not-a-token; broken');
    assert.deepEqual([...junk.rooms], [junk.id]);
    net.sockets.delete(junk.id);
  });

  test('an admin cookie joins the admin room', () => {
    assert.equal(seats.admin.rooms.has(ADMIN_ROOM), true);
  });

  test('a revoked code is worth no rooms at all', async () => {
    const doomed = issueCode({ subjectType: 'team', subjectId: 'team_b' }).code;
    const cookies = await signIn(doomed);
    revokeCode(doomed);
    assert.deepEqual(roomsForCookies(parseCookieHeader(cookies.header())), []);
    // Restore team_b's live code for the tests that follow.
    codes.teamB = issueCode({ subjectType: 'team', subjectId: 'team_b' }).code;
  });
});

/* ============================ scoped changes ============================ */

describe('a change reaches its audience and stops there', () => {
  test('a team block wakes that team, identified or not — and not the other team', async () => {
    const res = await call('POST', '/api/admin/blocks', {
      cookies: seats.jars.admin,
      body: {
        day: 'Sat',
        startTime: '11:00',
        endTime: '12:00',
        activity: 'Alpha stage check',
        appliesToType: 'team',
        appliesToId: 'team_a',
      },
    });
    assert.equal(res.status, 200);

    assert.equal(heard(seats.teamA), true, 'the team code should hear it');
    assert.equal(heard(seats.alice), true, 'a dancer on that team should hear it');
    assert.equal(heard(seats.admin), true, 'the panel should always hear it');
    assert.equal(heard(seats.teamB), false, 'the other team should not');
    assert.equal(heard(seats.judge), false, 'a judge should not');
    assert.equal(heard(seats.anon), false, 'a socket with no session should not');
  });

  test('a person block wakes only that person', async () => {
    const res = await call('POST', '/api/admin/blocks', {
      cookies: seats.jars.admin,
      body: {
        day: 'Sat',
        startTime: '06:00',
        endTime: '07:00',
        activity: 'Alice airport pickup',
        appliesToType: 'person',
        appliesToId: 'p_alice',
      },
    });
    assert.equal(res.status, 200);

    assert.equal(heard(seats.alice), true);
    assert.equal(heard(seats.admin), true);
    // Her own team's code does not show her airport pickup, so it has no
    // reason to refetch on account of it.
    assert.equal(heard(seats.teamA), false, 'the team code does not see person blocks');
    assert.equal(heard(seats.teamB), false);
    assert.equal(heard(seats.judge), false);
  });

  test('a role block wakes everyone holding that role', async () => {
    const res = await call('POST', '/api/admin/blocks', {
      cookies: seats.jars.admin,
      body: {
        day: 'Sat',
        startTime: '08:00',
        endTime: '08:30',
        activity: 'All-dancer safety brief',
        appliesToType: 'role',
        appliesToId: 'dancer',
      },
    });
    assert.equal(res.status, 200);

    assert.equal(heard(seats.teamA), true);
    assert.equal(heard(seats.alice), true);
    assert.equal(heard(seats.teamB), true);
    assert.equal(heard(seats.judge), false, 'a judge holds no dancer role');
  });

  test('moving a block between teams wakes both — the loser as well as the gainer', async () => {
    const created = await call('POST', '/api/admin/blocks', {
      cookies: seats.jars.admin,
      body: {
        day: 'Sat',
        startTime: '14:00',
        endTime: '14:30',
        activity: 'Contested studio slot',
        appliesToType: 'team',
        appliesToId: 'team_a',
      },
    });
    drain(...Object.values(seats).filter((s) => s?.inbox));

    const res = await call('PATCH', `/api/admin/blocks/${created.body.id}`, {
      cookies: seats.jars.admin,
      body: { appliesToType: 'team', appliesToId: 'team_b' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.changed, true);

    assert.equal(heard(seats.teamB), true, 'the new owner needs the block');
    assert.equal(
      heard(seats.teamA),
      true,
      'the old owner needs to drop it — telling only the new owner leaves it stale on their phone'
    );
    assert.equal(heard(seats.judge), false);
  });

  test('deleting a block wakes the target that lost it', async () => {
    const created = await call('POST', '/api/admin/blocks', {
      cookies: seats.jars.admin,
      body: {
        day: 'Sat',
        startTime: '15:00',
        endTime: '15:30',
        activity: 'Cancelled run-through',
        appliesToType: 'team',
        appliesToId: 'team_b',
      },
    });
    drain(...Object.values(seats).filter((s) => s?.inbox));

    const res = await call('DELETE', `/api/admin/blocks/${created.body.id}`, {
      cookies: seats.jars.admin,
    });
    assert.equal(res.status, 200);
    assert.equal(heard(seats.teamB), true);
    assert.equal(heard(seats.teamA), false);
  });

  test('an edit that changes nothing wakes nobody', async () => {
    const res = await call('PATCH', '/api/admin/blocks/b_team_a', {
      cookies: seats.jars.admin,
      body: { activity: 'Alpha warm-up' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.changed, false);
    assert.equal(heard(seats.teamA), false);
    assert.equal(heard(seats.admin), false);
  });

  test('a revoked code stops hearing its team once rooms are refreshed', async () => {
    const cookies = await signIn(codes.teamB);
    const seat = net.connect(cookies.header());
    assert.equal(seat.rooms.has('team:team_b'), true);

    revokeCode(codes.teamB);
    hub.refreshRooms();
    assert.equal(seat.rooms.has('team:team_b'), false);

    drain(seat);
    await call('POST', '/api/admin/blocks', {
      cookies: seats.jars.admin,
      body: {
        day: 'Sat',
        startTime: '16:00',
        endTime: '16:30',
        activity: 'Beta notes',
        appliesToType: 'team',
        appliesToId: 'team_b',
      },
    });
    assert.equal(heard(seat), false, 'revoke has to reach an already-open socket');

    net.sockets.delete(seat.id);
    codes.teamB = issueCode({ subjectType: 'team', subjectId: 'team_b' }).code;
  });
});

/* ============================== imports ============================== */

describe('a spreadsheet import', () => {
  /** Upload through the real two-step preview/commit endpoints. */
  async function importCsv(csv) {
    const form = new FormData();
    form.set('file', new Blob([csv], { type: 'text/csv' }), 'schedule.csv');
    // Managed rows only ever come from an import, and this fixture's blocks are
    // hand-inserted without a source key, so nothing existing is at risk.
    form.set('removeMissing', 'false');

    const preview = await fetch(`${base}/api/admin/schedule/import/preview`, {
      method: 'POST',
      headers: { cookie: seats.jars.admin.header() },
      body: form,
    });
    const previewed = await preview.json();
    assert.equal(preview.status, 200, JSON.stringify(previewed));

    return call('POST', '/api/admin/schedule/import/commit', {
      cookies: seats.jars.admin,
      body: { token: previewed.token, removeMissing: false },
    });
  }

  const HEADER = 'Day,Start,End,Location,Sub-location,Activity,Assigned Team/Person,Notes,ID';

  test('wakes only the teams whose rows it touched', async () => {
    const res = await importCsv(
      `${HEADER}\nSat,13:00,13:20,Main Venue,Main Stage,Imported Alpha slot,Team: Alpha Crew,,imp-1\n`
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);

    assert.equal(heard(seats.teamA), true, 'Alpha had a row in the file');
    assert.equal(heard(seats.alice), true);
    assert.equal(heard(seats.admin), true);
    assert.equal(heard(seats.teamB), false, 'Beta was not in the file');
    assert.equal(heard(seats.judge), false);
  });

  test('re-importing an unchanged file wakes nobody but the panel', async () => {
    // The board is rewritten from the same spreadsheet several times an hour
    // during setup. A no-op re-sync must not cost 280 refetches.
    const res = await importCsv(
      `${HEADER}\nSat,13:00,13:20,Main Venue,Main Stage,Imported Alpha slot,Team: Alpha Crew,,imp-1\n`
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.diff.hasChanges, false);
    assert.equal(heard(seats.teamA), false);
    assert.equal(heard(seats.teamB), false);
  });
});

/* ======================= what is on the wire ======================= */

describe('the payload', () => {
  test('says that something changed and nothing about who it affects', async () => {
    await call('POST', '/api/admin/blocks', {
      cookies: seats.jars.admin,
      body: {
        day: 'Sat',
        startTime: '17:00',
        endTime: '17:30',
        activity: 'Alpha debrief',
        appliesToType: 'team',
        appliesToId: 'team_a',
      },
    });

    const [message] = changes(seats.teamA);
    assert.ok(message, 'the team should have been told');
    assert.deepEqual(Object.keys(message.body).sort(), ['at', 'changedBlockIds', 'updatedAt']);

    // The design this replaced would have shipped personIds/teamIds to every
    // connected socket. Nothing identifying may appear here.
    const serialized = JSON.stringify(message.body);
    for (const leak of ['personIds', 'teamIds', 'p_alice', 'team_a', 'Alpha']) {
      assert.equal(serialized.includes(leak), false, `payload leaked ${leak}`);
    }
  });
});

/* ========================= roster changes ========================= */

describe('roster changes', () => {
  test('wake everyone, because there is no block to scope them by', async () => {
    const res = await call('PATCH', '/api/admin/teams/team_a', {
      cookies: seats.jars.admin,
      body: { name: 'Alpha Crew' },
    });
    assert.equal(res.status, 200);
    for (const key of ['teamA', 'alice', 'teamB', 'judge', 'admin', 'anon']) {
      assert.equal(heard(seats[key]), true, `${key} should hear a roster change`);
    }
  });

  test('move an open socket into its new team', async () => {
    // A personal code, so the session survives the transfer and the room has
    // to follow it. (The team-code case below is the one that does not.)
    const amirCode = issueCode({ subjectType: 'person', subjectId: 'p_amir' }).code;
    const cookies = await signIn(amirCode);
    const amir = net.connect(cookies.header());
    assert.equal(amir.rooms.has('team:team_a'), true);

    // Amir transfers to Beta. His socket has been open since before the change.
    await call('PATCH', '/api/admin/people/p_amir', {
      cookies: seats.jars.admin,
      body: { teamId: 'team_b', roleIds: ['dancer'] },
    });

    assert.equal(amir.rooms.has('team:team_b'), true, 'joined the new team');
    assert.equal(amir.rooms.has('team:team_a'), false, 'and left the old one');

    drain(amir, seats.teamA);
    await call('POST', '/api/admin/blocks', {
      cookies: seats.jars.admin,
      body: {
        day: 'Sat',
        startTime: '18:00',
        endTime: '18:30',
        activity: 'Beta call',
        appliesToType: 'team',
        appliesToId: 'team_b',
      },
    });
    assert.equal(heard(amir), true, 'hears his new team');
    assert.equal(heard(seats.teamA), false, 'his old team is unaffected');

    net.sockets.delete(amir.id);
    // Put him back on Alpha for anything that follows.
    await call('PATCH', '/api/admin/people/p_amir', {
      cookies: seats.jars.admin,
      body: { teamId: 'team_a', roleIds: ['dancer'] },
    });
    revokeCode(amirCode);
  });

  test('strand a team-code socket whose dancer left the team', async () => {
    // Item 6 invalidates a team-code session whose identified person no longer
    // belongs to that team, and the rooms follow it rather than second-guessing
    // it: the same lookup decides both, so a socket can never outlive the
    // session that earned it.
    const cookies = await signIn(codes.teamA);
    await call('POST', '/api/session/identify', { body: { personId: 'p_amir' }, cookies });
    const seat = net.connect(cookies.header());
    assert.equal(seat.rooms.has('team:team_a'), true);

    await call('PATCH', '/api/admin/people/p_amir', {
      cookies: seats.jars.admin,
      body: { teamId: 'team_b', roleIds: ['dancer'] },
    });

    assert.deepEqual([...seat.rooms], [seat.id], 'no rooms for a session that no longer resolves');
    assert.equal(
      (await call('GET', '/api/schedule', { cookies })).status,
      401,
      'and the HTTP side agrees'
    );

    net.sockets.delete(seat.id);
    await call('PATCH', '/api/admin/people/p_amir', {
      cookies: seats.jars.admin,
      body: { teamId: 'team_a', roleIds: ['dancer'] },
    });
  });
});

/* ============================== origins ============================== */

describe('socket origin policy', () => {
  const prod = () =>
    originPolicy({ publicBaseUrl: 'https://royalty.example', extra: '', allowLocal: false });

  test('the app is allowed against its own host, with no configuration at all', () => {
    const policy = originPolicy({ publicBaseUrl: '', extra: '', allowLocal: false });
    assert.equal(policy.isAllowed('https://royalty.example', 'royalty.example'), true);
    assert.equal(policy.isAllowed('http://royalty.example:4000', 'royalty.example:4000'), true);
  });

  test('another site is refused even while it names the right host', () => {
    // The shape of the attack the old `{ origin: true }` allowed: a page on
    // evil.com opening a socket to this server carrying the visitor's cookie.
    assert.equal(prod().isAllowed('https://evil.example', 'royalty.example'), false);
    assert.equal(
      prod().isAllowed('https://royalty.example.evil.test', 'royalty.example'),
      false,
      'a suffix of the real origin is not the real origin'
    );
  });

  test('the configured public origin is allowed from anywhere', () => {
    assert.equal(prod().isAllowed('https://royalty.example', 'internal-lb'), true);
  });

  test('extra origins come from SOCKET_ORIGINS', () => {
    const policy = originPolicy({
      publicBaseUrl: 'https://royalty.example',
      extra: 'https://ops.example, https://screens.example',
      allowLocal: false,
    });
    assert.equal(policy.isAllowed('https://ops.example', 'royalty.example'), true);
    assert.equal(policy.isAllowed('https://screens.example', 'royalty.example'), true);
    assert.equal(policy.isAllowed('https://other.example', 'royalty.example'), false);
  });

  test('a request with no Origin header is allowed', () => {
    // Browsers always send one cross-site, so no header means a non-browser
    // client — which carries no cookie and therefore joins no rooms. Refusing
    // it would break same-origin polling, where browsers omit the header.
    assert.equal(prod().isAllowed(undefined, 'royalty.example'), true);
    assert.equal(prod().isAllowed('', 'royalty.example'), true);
  });

  test('a malformed Origin is refused, not treated as absent', () => {
    assert.equal(prod().isAllowed('not-a-url', 'royalty.example'), false);
  });

  test('dev allows the Vite server and a phone on the same wifi', () => {
    const dev = originPolicy({ publicBaseUrl: '', extra: '', allowLocal: true });
    assert.equal(dev.isAllowed('http://localhost:5173', 'localhost:4000'), true);
    assert.equal(dev.isAllowed('http://192.168.1.40:5173', '192.168.1.40:4000'), true);
    assert.equal(dev.isAllowed('https://evil.example', 'localhost:4000'), false);
  });

  test('production does not allow localhost', () => {
    assert.equal(prod().isAllowed('http://localhost:5173', 'royalty.example'), false);
  });
});

/* ============================== cookies ============================== */

describe('handshake cookie parsing', () => {
  test('reads the pairs Socket.IO hands over as a raw header', () => {
    const parsed = parseCookieHeader('royalty_session=abc.def; royalty_admin=ghi.jkl');
    assert.deepEqual(parsed, { royalty_session: 'abc.def', royalty_admin: 'ghi.jkl' });
  });

  test('survives an empty or malformed header', () => {
    assert.deepEqual(parseCookieHeader(''), {});
    assert.deepEqual(parseCookieHeader(undefined), {});
    assert.deepEqual(parseCookieHeader('nonsense'), {});
  });
});
