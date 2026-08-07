/**
 * Bulk time shift — item 15.
 *
 * "Everything from 3pm moves 20 minutes" is the most common live change at this
 * event, and the thing that makes it dangerous is that a *partly* applied shift
 * looks exactly like a correct one: half a day 20 minutes away from the other
 * half, with nothing on screen saying which half is which. So most of what
 * follows is about what does *not* happen — blocks before the cutoff staying
 * put, a stale version refusing the whole batch, a block that cannot cross
 * midnight taking the batch down with it rather than being quietly skipped.
 *
 * The arithmetic is tested directly, and then again through the real Express
 * app on a throwaway database, because the preview and the apply agreeing is
 * the property an admin is trusting when they hit the button.
 */
import { test, before, after, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'royalty-shift-')), 'test.db');
process.env.DB_PATH = TMP_DB;
process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'test-admin-password';
process.env.EVENT_TIMEZONE = 'America/Indiana/Indianapolis';

const { db } = await import('../server/db.js');
const { createApp } = await import('../server/app.js');
const { issueCode } = await import('../server/lib/access-codes.js');
const { createLiveHub } = await import('../server/lib/live.js');
const { buildDayIndex, describeShift, parseClock, planMoves, shiftClock } = await import(
  '../server/lib/time-shift.js'
);

let server;
let base;
let admin;
let net;
const codes = {};

/* ------------------------------- fixture ------------------------------- */

/**
 * Three event days on purpose, and one of them not adjacent: Fri, Sat, then Mon.
 * A Saturday block pushed past midnight needs a Sunday the event does not have,
 * even though Monday is the next row in sort order — which is why the day index
 * is keyed on dates rather than on `sort_order`.
 */
const START = new Date('2026-08-01T12:00:00.000Z').toISOString();

const BLOCKS = [
  ['b_early', 'Sat', '09:00', '10:00', 'Alpha warm-up', 'team', 'team_a'],
  ['b_cutoff', 'Sat', '15:00', '15:30', 'Alpha tech', 'team', 'team_a'],
  ['b_late', 'Sat', '16:00', '16:20', 'Beta tech', 'team', 'team_b'],
  ['b_person', 'Sat', '17:00', '17:30', 'Alice photo call', 'person', 'p_alice'],
  ['b_night', 'Sat', '23:50', '00:20', 'Afterparty', 'team', 'team_a'],
  ['b_fri_late', 'Fri', '23:30', '03:45', 'Socials', 'team', 'team_a'],
  ['b_fri_edge', 'Fri', '23:50', '00:30', 'Load-out', 'team', 'team_b'],
];

function seedFixture() {
  db.exec(`
    INSERT INTO roles (id,label,selector,sort_order,active) VALUES ('dancer','Dancer','team',1,1);
    INSERT INTO event_days (key,label,date,sort_order) VALUES
      ('Fri','Friday','2026-08-07',1),
      ('Sat','Saturday','2026-08-08',2),
      ('Mon','Monday','2026-08-10',3);
    INSERT INTO teams (id,name) VALUES
      ('team_a','Alpha Crew'),('team_b','Beta Crew'),('team_c','Gamma Crew');
    INSERT INTO people (id,name,team_id) VALUES
      ('p_alice','Alice Alpha','team_a'),
      ('p_bianca','Bianca Beta','team_b'),
      ('p_gita','Gita Gamma','team_c');
    INSERT INTO person_roles (person_id,role_id) VALUES
      ('p_alice','dancer'),('p_bianca','dancer'),('p_gita','dancer');
  `);

  const insert = db.prepare(
    `INSERT INTO schedule_blocks
       (id,day,start_time,end_time,activity_label,applies_to_type,applies_to_id,
        source,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,'test',?,?)`
  );
  for (const b of BLOCKS) insert.run(...b, START, START);

  db.prepare(
    `INSERT INTO target_versions (target_type,target_id,updated_at) VALUES
       ('team','team_a',?),('team','team_b',?),('team','team_c',?),('person','p_alice',?)`
  ).run(START, START, START, START);

  codes.teamC = issueCode({ subjectType: 'team', subjectId: 'team_c' }).code;
}

/** Put every block back where it started, so each test starts from the fixture. */
function resetBlocks() {
  const reset = db.prepare(
    'UPDATE schedule_blocks SET day=?, start_time=?, end_time=?, updated_at=? WHERE id=?'
  );
  for (const [id, day, start, end] of BLOCKS) reset.run(day, start, end, START, id);
  db.prepare('UPDATE target_versions SET updated_at = ?').run(START);
  db.prepare('DELETE FROM edit_log').run();
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

const row = (id) => db.prepare('SELECT * FROM schedule_blocks WHERE id = ?').get(id);
const at = (id) => {
  const b = row(id);
  return `${b.day} ${b.start_time}–${b.end_time}`;
};
const versionOf = (type, id) =>
  db.prepare('SELECT updated_at FROM target_versions WHERE target_type = ? AND target_id = ?').get(
    type,
    id
  )?.updated_at;

/** A preview, and the apply payload it entitles you to send. */
async function preview(body) {
  const res = await asAdmin('POST', '/api/admin/blocks/shift/preview', body);
  assert.equal(res.status, 200, res.body?.error);
  return res.body;
}

const applyPayload = (plan, ids = null) => ({
  minutes: plan.minutes,
  blocks: plan.moves
    .filter((m) => !ids || ids.includes(m.id))
    .map((m) => ({ id: m.id, expectedUpdatedAt: m.updatedAt })),
});

/**
 * A stand-in Socket.IO server — rooms and fan-out for real, no network. Room
 * membership is decided by the hub under test, not by this fake.
 */
function fakeIo() {
  const sockets = new Map();
  let onConnection = () => {};
  let counter = 0;
  const io = {
    on(event, fn) {
      if (event === 'connection') onConnection = fn;
    },
    sockets: { sockets },
    to(rooms) {
      const set = new Set(Array.isArray(rooms) ? rooms : [rooms]);
      return {
        emit: (event, body) => {
          for (const s of sockets.values()) {
            if ([...s.rooms].some((r) => set.has(r))) s.inbox.push({ event, body });
          }
        },
      };
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
      join(r) {
        this.rooms.add(r);
      },
      leave(r) {
        this.rooms.delete(r);
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
  return { io, connect };
}

const changes = (socket) => socket.inbox.filter((m) => m.event === 'schedule:updated');

before(async () => {
  seedFixture();
  net = fakeIo();
  const hub = createLiveHub(net.io);
  server = createApp({ serveClient: false, broadcast: hub.broadcast }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  admin = await signInAdmin();
});

after(() => {
  server?.close();
  db.close();
  fs.rmSync(path.dirname(TMP_DB), { recursive: true, force: true });
});

beforeEach(() => resetBlocks());

/* ==================================================================== *
 * The arithmetic
 * ==================================================================== */

describe('shifting a clock reading', () => {
  test('moves within the day without touching the day key', () => {
    assert.deepEqual(shiftClock('15:00', 20), { time: '15:20', dayDelta: 0 });
    assert.deepEqual(shiftClock('15:00', -20), { time: '14:40', dayDelta: 0 });
  });

  test('reports the day it crossed, forwards and backwards', () => {
    assert.deepEqual(shiftClock('23:50', 20), { time: '00:10', dayDelta: 1 });
    assert.deepEqual(shiftClock('00:10', -20), { time: '23:50', dayDelta: -1 });
    assert.deepEqual(shiftClock('00:00', -1), { time: '23:59', dayDelta: -1 });
  });

  test('rejects anything that is not a clock reading', () => {
    for (const bad of ['', null, '25:00', '12:60', 'noon', '1200']) {
      assert.equal(shiftClock(bad, 10), null, `${bad} should not parse`);
      assert.equal(parseClock(bad), null);
    }
  });
});

describe('the day index', () => {
  const days = [
    { key: 'Fri', date: '2026-08-07' },
    { key: 'Sat', date: '2026-08-08' },
    { key: 'Mon', date: '2026-08-10' },
  ];

  test('steps by calendar date, not by the next row', () => {
    const index = buildDayIndex(days);
    assert.equal(index.shift('Fri', 1), 'Sat');
    assert.equal(index.shift('Sat', -1), 'Fri');
    // Monday is the next day in sort order but two calendar days away, so a
    // Saturday block crossing midnight has nowhere to land.
    assert.equal(index.shift('Sat', 1), null);
    assert.equal(index.shift('Fri', -1), null);
  });

  test('a day with no date cannot be crossed out of', () => {
    assert.equal(buildDayIndex([{ key: 'TBC', date: null }]).shift('TBC', 1), null);
  });
});

describe('planning a batch', () => {
  const days = [
    { key: 'Fri', date: '2026-08-07' },
    { key: 'Sat', date: '2026-08-08' },
  ];
  const block = (over = {}) => ({
    id: 'b1',
    day: 'Fri',
    startTime: '23:50',
    endTime: '00:30',
    activity: 'Load-out',
    appliesTo: { type: 'team', id: 'team_a' },
    updatedAt: START,
    ...over,
  });

  test('a start crossing midnight carries the block to the next event day', () => {
    const { moves, blocked } = planMoves([block()], 20, days);
    assert.equal(blocked.length, 0);
    assert.deepEqual(moves[0].to, { day: 'Sat', startTime: '00:10', endTime: '00:50' });
  });

  test('an end already past midnight is not moved a second time', () => {
    // 23:30–03:45 is Friday night into Saturday morning. Shifting it must give
    // 23:50–04:05 on Friday — if the end were rolled forward as well it would
    // land a day out, and `blockInstants` would read it as a 24-hour block.
    const { moves } = planMoves([block({ startTime: '23:30', endTime: '03:45' })], 20, days);
    assert.deepEqual(moves[0].to, { day: 'Fri', startTime: '23:50', endTime: '04:05' });
  });

  test('a block with nowhere to land is reported, not silently dropped', () => {
    const { moves, blocked } = planMoves([block({ day: 'Sat' })], 20, days);
    assert.equal(moves.length, 0);
    assert.equal(blocked[0].blocked, 'no-day');
    assert.equal(blocked[0].crosses, 1);
    // Enough to name the block on screen without a second lookup.
    assert.equal(blocked[0].activity, 'Load-out');
  });

  test('the summary says what moved, not what was asked for', () => {
    const { moves } = planMoves(
      [block({ id: 'b1', startTime: '16:00', endTime: '16:20' }), block({ id: 'b2' })],
      20,
      days
    );
    assert.equal(describeShift(moves, 20), 'Moved 2 block(s) on Fri from 16:00 by +20 min');
    assert.match(describeShift(moves, -15), /by -15 min/);
  });
});

/* ==================================================================== *
 * Preview
 * ==================================================================== */

describe('previewing a shift', () => {
  test('takes everything from the cutoff onwards, and nothing before it', async () => {
    const plan = await preview({ day: 'Sat', fromTime: '15:00', minutes: 20 });
    const touched = [...plan.moves, ...plan.blocked].map((m) => m.id);
    assert.ok(touched.includes('b_cutoff'), 'the cutoff itself is included');
    assert.ok(!touched.includes('b_early'), '09:00 is before the cutoff');
    assert.ok(!touched.includes('b_fri_late'), 'another day is not touched');
    assert.deepEqual(
      plan.moves.map((m) => m.id),
      ['b_cutoff', 'b_late', 'b_person']
    );
  });

  test('shows the new times without writing any of them', async () => {
    const plan = await preview({ day: 'Sat', fromTime: '15:00', minutes: 20 });
    const move = plan.moves.find((m) => m.id === 'b_cutoff');
    assert.deepEqual(move.from, { day: 'Sat', startTime: '15:00', endTime: '15:30' });
    assert.deepEqual(move.to, { day: 'Sat', startTime: '15:20', endTime: '15:50' });
    assert.equal(at('b_cutoff'), 'Sat 15:00–15:30', 'a preview must not move anything');
  });

  test('separates out what cannot move', async () => {
    const plan = await preview({ day: 'Sat', fromTime: '15:00', minutes: 20 });
    // 23:50 on the last day of the event: +20 needs a Sunday there isn't one of.
    assert.deepEqual(
      plan.blocked.map((b) => b.id),
      ['b_night']
    );
  });

  test('refuses a shift that is not a usable number of minutes', async () => {
    for (const minutes of [0, 'twenty', 1.5, 721, -721]) {
      const res = await asAdmin('POST', '/api/admin/blocks/shift/preview', {
        day: 'Sat',
        fromTime: '15:00',
        minutes,
      });
      assert.equal(res.status, 400, `minutes=${minutes} should be refused`);
    }
  });

  test('refuses a missing day or an unreadable cutoff', async () => {
    const noDay = await asAdmin('POST', '/api/admin/blocks/shift/preview', {
      fromTime: '15:00',
      minutes: 20,
    });
    assert.equal(noDay.status, 400);
    const badTime = await asAdmin('POST', '/api/admin/blocks/shift/preview', {
      day: 'Sat',
      fromTime: '3pm',
      minutes: 20,
    });
    assert.equal(badTime.status, 400);
  });

  test('is behind the admin password like everything else in the panel', async () => {
    const res = await call('POST', '/api/admin/blocks/shift/preview', {
      body: { day: 'Sat', fromTime: '15:00', minutes: 20 },
    });
    assert.equal(res.status, 401);
  });
});

/* ==================================================================== *
 * Apply
 * ==================================================================== */

describe('applying a shift', () => {
  test('moves the previewed blocks and leaves the rest alone', async () => {
    const plan = await preview({ day: 'Sat', fromTime: '15:00', minutes: 20 });
    const res = await asAdmin('POST', '/api/admin/blocks/shift', applyPayload(plan));
    assert.equal(res.status, 200, res.body?.error);
    assert.equal(res.body.moved, 3);

    assert.equal(at('b_cutoff'), 'Sat 15:20–15:50');
    assert.equal(at('b_late'), 'Sat 16:20–16:40');
    assert.equal(at('b_person'), 'Sat 17:20–17:50');
    assert.equal(at('b_early'), 'Sat 09:00–10:00', 'before the cutoff');
    assert.equal(at('b_night'), 'Sat 23:50–00:20', 'was blocked, so untouched');
    assert.equal(at('b_fri_late'), 'Fri 23:30–03:45', 'another day');
  });

  test('pulls a day earlier as readily as later', async () => {
    const plan = await preview({ day: 'Sat', fromTime: '16:00', minutes: -25 });
    const res = await asAdmin('POST', '/api/admin/blocks/shift', applyPayload(plan));
    assert.equal(res.status, 200);
    assert.equal(at('b_late'), 'Sat 15:35–15:55');
    assert.equal(at('b_cutoff'), 'Sat 15:00–15:30', 'before the cutoff');
  });

  test('carries a block across midnight onto the next event day', async () => {
    const plan = await preview({ day: 'Fri', fromTime: '23:00', minutes: 20 });
    const res = await asAdmin('POST', '/api/admin/blocks/shift', applyPayload(plan));
    assert.equal(res.status, 200);
    assert.equal(at('b_fri_edge'), 'Sat 00:10–00:50', 'the start crossed midnight');
    assert.equal(at('b_fri_late'), 'Fri 23:50–04:05', 'the start did not; the end had already');
  });

  test('a past-midnight block stays one block, twenty minutes later', async () => {
    const before = await asAdmin('GET', '/api/admin/blocks?day=Fri');
    const was = before.body.blocks.find((b) => b.id === 'b_fri_late');

    const plan = await preview({ day: 'Fri', fromTime: '23:00', minutes: 20 });
    await asAdmin('POST', '/api/admin/blocks/shift', applyPayload(plan, ['b_fri_late']));

    const after = await asAdmin('GET', '/api/admin/blocks?day=Fri');
    const now = after.body.blocks.find((b) => b.id === 'b_fri_late');
    const twentyMinutes = 20 * 60_000;
    assert.equal(
      new Date(now.startsAt) - new Date(was.startsAt),
      twentyMinutes,
      'the resolved start instant moved by exactly the shift'
    );
    assert.equal(
      new Date(now.endsAt) - new Date(was.endsAt),
      twentyMinutes,
      'and so did the end, still on the following morning'
    );
  });

  test('only what was previewed moves — not a block added since', async () => {
    const plan = await preview({ day: 'Sat', fromTime: '15:00', minutes: 20 });
    const added = await asAdmin('POST', '/api/admin/blocks', {
      day: 'Sat',
      startTime: '18:00',
      endTime: '18:30',
      activity: 'Squeezed in while you were previewing',
      appliesToType: 'team',
      appliesToId: 'team_c',
    });
    assert.equal(added.status, 200);

    const res = await asAdmin('POST', '/api/admin/blocks/shift', applyPayload(plan));
    assert.equal(res.status, 200);
    assert.equal(row(added.body.id).start_time, '18:00', 'nobody reviewed this one');

    db.prepare('DELETE FROM schedule_blocks WHERE id = ?').run(added.body.id);
  });

  test('every moved block gets its own log line, under one summary', async () => {
    const plan = await preview({ day: 'Sat', fromTime: '15:00', minutes: 20 });
    await asAdmin('POST', '/api/admin/blocks/shift', applyPayload(plan));

    const log = await asAdmin('GET', '/api/admin/log');
    const entries = log.body.entries;
    assert.equal(entries[0].summary, 'Moved 3 block(s) on Sat from 15:00 by +20 min');
    assert.equal(entries[0].editedBy, 'Marcus');

    const perBlock = entries.filter((e) => e.blockId);
    assert.equal(perBlock.length, 3);
    for (const entry of perBlock) {
      assert.match(entry.summary, /time \d\d:\d\d–\d\d:\d\d → \d\d:\d\d–\d\d:\d\d/);
      assert.ok(entry.audience, 'so "why did my 3pm move" stays answerable per person');
    }
  });

  test("moves the affected subjects' timestamps and nobody else's", async () => {
    const plan = await preview({ day: 'Sat', fromTime: '15:00', minutes: 20 });
    await asAdmin('POST', '/api/admin/blocks/shift', applyPayload(plan));

    assert.ok(versionOf('team', 'team_a') > START, 'Alpha had a block move');
    assert.ok(versionOf('team', 'team_b') > START, 'so did Beta');
    assert.ok(versionOf('person', 'p_alice') > START, 'and Alice personally');
    assert.equal(versionOf('team', 'team_c'), START, 'Gamma had nothing in this shift');
  });
});

/* ==================================================================== *
 * Refusals — the batch is all or nothing
 * ==================================================================== */

describe('a shift that cannot be applied cleanly', () => {
  test('is refused whole when someone else has moved one of the blocks', async () => {
    const plan = await preview({ day: 'Sat', fromTime: '15:00', minutes: 20 });
    const other = await asAdmin('PATCH', '/api/admin/blocks/b_late', { startTime: '16:05' });
    assert.equal(other.status, 200);

    const res = await asAdmin('POST', '/api/admin/blocks/shift', applyPayload(plan));
    assert.equal(res.status, 409);
    assert.equal(res.body.reason, 'conflict');
    assert.equal(res.body.conflicts[0].id, 'b_late');
    assert.equal(res.body.conflicts[0].startTime, '16:05', 'the panel can say what it found');

    assert.equal(at('b_cutoff'), 'Sat 15:00–15:30', 'nothing else moved either');
    assert.equal(at('b_person'), 'Sat 17:00–17:30');
    assert.equal(at('b_late'), 'Sat 16:05–16:20', "the other admin's edit survived");
  });

  test('is refused whole when one of the blocks has been deleted', async () => {
    const plan = await preview({ day: 'Sat', fromTime: '15:00', minutes: 20 });
    db.prepare('DELETE FROM schedule_blocks WHERE id = ?').run('b_late');

    const res = await asAdmin('POST', '/api/admin/blocks/shift', applyPayload(plan));
    assert.equal(res.status, 409);
    assert.equal(res.body.reason, 'missing');
    assert.deepEqual(res.body.missing, ['b_late']);
    assert.equal(at('b_cutoff'), 'Sat 15:00–15:30');

    db.prepare(
      `INSERT INTO schedule_blocks
         (id,day,start_time,end_time,activity_label,applies_to_type,applies_to_id,
          source,created_at,updated_at)
       VALUES ('b_late','Sat','16:00','16:20','Beta tech','team','team_b','test',?,?)`
    ).run(START, START);
  });

  test('is refused whole when a block would land on a day that does not exist', async () => {
    const night = row('b_night');
    const res = await asAdmin('POST', '/api/admin/blocks/shift', {
      minutes: 20,
      blocks: [
        { id: 'b_cutoff', expectedUpdatedAt: row('b_cutoff').updated_at },
        { id: 'b_night', expectedUpdatedAt: night.updated_at },
      ],
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.reason, 'blocked');
    assert.equal(res.body.blocked[0].id, 'b_night');
    assert.equal(at('b_cutoff'), 'Sat 15:00–15:30', 'the movable one did not move on its own');
  });

  test('will not apply a list with no version on it', async () => {
    const res = await asAdmin('POST', '/api/admin/blocks/shift', {
      minutes: 20,
      blocks: [{ id: 'b_cutoff' }],
    });
    assert.equal(res.status, 400);
    assert.equal(at('b_cutoff'), 'Sat 15:00–15:30');
  });

  test('refuses an empty selection rather than reporting a no-op success', async () => {
    const res = await asAdmin('POST', '/api/admin/blocks/shift', { minutes: 20, blocks: [] });
    assert.equal(res.status, 400);
  });
});

/* ==================================================================== *
 * The live channel
 * ==================================================================== */

describe('who hears about a bulk shift', () => {
  test('only the teams whose blocks moved, and the panel', async () => {
    const viewer = jar();
    const signIn = await call('POST', '/api/session', { body: { code: codes.teamC }, cookies: viewer });
    assert.equal(signIn.status, 200);
    const gamma = net.connect(viewer.header());
    const panel = net.connect(admin.header());
    gamma.inbox.length = 0;
    panel.inbox.length = 0;

    const plan = await preview({ day: 'Sat', fromTime: '15:00', minutes: 20 });
    const res = await asAdmin('POST', '/api/admin/blocks/shift', applyPayload(plan));
    assert.equal(res.status, 200);

    assert.equal(changes(gamma).length, 0, 'Gamma had nothing in this shift');
    assert.equal(changes(panel).length, 1, 'one announcement for the whole batch, not three');
    assert.equal(changes(panel)[0].body.changedBlockIds.length, 3);
    assert.ok(
      !JSON.stringify(changes(panel)[0].body).includes('p_alice'),
      'the payload still says nothing about who is affected'
    );
  });
});
