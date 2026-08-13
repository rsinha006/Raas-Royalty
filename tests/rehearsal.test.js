/**
 * The dress rehearsal's two instruments — item 26.
 *
 * **Presence** answers "did every phone get that?" without asking fifteen
 * people, so most of what follows is about the answers it must *not* give: a
 * phone marked behind because a different team changed, a phone marked up to
 * date because nobody ever heard from it, and the panel's own laptop sitting in
 * the list as a phone that never reports. Each of those is a plausible-looking
 * reading that would send somebody to debug a phone that is fine, which is the
 * failure mode this project exists to avoid.
 *
 * **Readiness** answers "would a rehearsal now mean anything?" — and the thing
 * it is really guarding against is that the placeholder event passes every other
 * test in this repo. Dates that have already happened, a roster of nobody real,
 * and two entirely empty days all render as a perfectly ordinary schedule.
 */
import { test, before, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'royalty-rehearsal-test-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.db');
process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'test-admin-password';

const { db, nowIso } = await import('../server/db.js');
const { issueCode } = await import('../server/lib/access-codes.js');
const { createLiveHub } = await import('../server/lib/live.js');
const { presenceReport, resetPresence } = await import('../server/lib/presence.js');
const { signPayload } = await import('../server/lib/auth.js');
const {
  BLOCKER,
  OK,
  WARN,
  checkDayCoverage,
  checkDeploy,
  checkEventDates,
  checkRoster,
  readinessReport,
} = await import('../server/lib/readiness.js');

/* ------------------------------- fixture ------------------------------- */

const codes = {};

before(() => {
  const now = nowIso();
  db.exec(`
    INSERT INTO roles (id,label,selector,sort_order,active) VALUES
      ('dancer','Dancer','team',1,1),
      ('judge','Judge','person',2,1),
      ('captain','Captain','person',9,1);
    INSERT INTO event_days (key,label,date,sort_order) VALUES
      ('Thu','Thursday','2026-09-10',1),
      ('Fri','Friday','2026-09-11',2),
      ('Sat','Saturday','2026-09-12',3),
      ('Sun','Sunday','2026-09-13',4);
    INSERT INTO teams (id,name) VALUES ('team_a','Alpha Crew'),('team_b','Beta Crew');
    INSERT INTO people (id,name,team_id,email) VALUES
      ('p_alice','Alice Alpha','team_a','alice@example.com'),
      ('p_bianca','Bianca Beta','team_b','bianca@example.com'),
      ('p_judge','Jordan Judge',NULL,'judge@example.com');
    INSERT INTO person_roles (person_id,role_id) VALUES
      ('p_alice','dancer'),('p_alice','captain'),
      ('p_bianca','dancer'),
      ('p_judge','judge');
  `);

  const block = db.prepare(
    `INSERT INTO schedule_blocks
       (id,day,start_time,end_time,activity_label,applies_to_type,applies_to_id,
        source,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  );
  block.run('b_a', 'Sat', '09:00', '10:00', 'Alpha warm-up', 'team', 'team_a', 'import', now, now);
  block.run('b_b', 'Sat', '10:00', '11:00', 'Beta warm-up', 'team', 'team_b', 'import', now, now);
  block.run('b_thu', 'Thu', '18:00', '19:00', 'Airport pickup', 'person', 'p_alice', 'import', now, now);
  block.run('b_fri', 'Fri', '12:00', '13:00', 'Lunch', 'role', 'dancer', 'import', now, now);
  block.run('b_sun', 'Sun', '08:00', '09:00', 'Departures', 'everyone', 'all', 'import', now, now);

  codes.teamA = issueCode({ subjectType: 'team', subjectId: 'team_a' }).code;
  codes.teamB = issueCode({ subjectType: 'team', subjectId: 'team_b' }).code;
  codes.judge = issueCode({ subjectType: 'person', subjectId: 'p_judge' }).code;
});

/* ------------------------------- helpers ------------------------------- */

/** A signed viewer cookie, the same shape `issueViewerSession` writes. */
function viewerCookie({ code, subjectType, subjectId, personId = null }) {
  const token = signPayload({
    c: code,
    t: subjectType,
    i: subjectId,
    p: personId,
    exp: Date.now() + 60_000,
  });
  return `royalty_session=${encodeURIComponent(token)}`;
}

function adminCookie() {
  const token = signPayload({ name: 'Tester', exp: Date.now() + 60_000 });
  return `royalty_admin=${encodeURIComponent(token)}`;
}

/**
 * A stand-in Socket.IO server. Unlike the one in `broadcast.test.js` this one
 * carries `on`/`disconnect`, because presence is maintained through them.
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
    to: () => ({ emit() {} }),
    emit() {},
  };

  function connect(cookieHeader = '') {
    const handlers = new Map();
    const socket = {
      id: `sock_${++counter}`,
      handshake: { headers: { cookie: cookieHeader } },
      rooms: new Set(),
      join(room) {
        this.rooms.add(room);
      },
      leave(room) {
        this.rooms.delete(room);
      },
      emit() {},
      on(event, fn) {
        handlers.set(event, fn);
      },
      send(event, payload) {
        handlers.get(event)?.(payload);
      },
      close() {
        sockets.delete(socket.id);
        handlers.get('disconnect')?.();
      },
    };
    socket.rooms.add(socket.id);
    sockets.set(socket.id, socket);
    onConnection(socket);
    return socket;
  }

  return { io, connect, sockets };
}

/** The `updatedAt` a real viewer would be holding for a subject right now. */
async function currentVersionFor(session) {
  const { getPersonalizedSchedule } = await import('../server/lib/queries.js');
  return getPersonalizedSchedule(session).updatedAt;
}

const touchBlock = (id) =>
  db.prepare('UPDATE schedule_blocks SET updated_at = ? WHERE id = ?').run(new Date(Date.now() + 1000).toISOString(), id);

/* ================================================================== *
 * Presence
 * ================================================================== */

describe('who is connected, and what their screen holds', () => {
  let hub;
  let net;

  beforeEach(() => {
    resetPresence();
    net = fakeIo();
    hub = createLiveHub(net.io);
  });

  afterEach(() => resetPresence());

  test('a phone reporting the version it was served reads as up to date', async () => {
    const socket = net.connect(viewerCookie({ code: codes.teamA, subjectType: 'team', subjectId: 'team_a' }));
    socket.send('viewer:held', { updatedAt: await currentVersionFor({ type: 'team', id: 'team_a' }) });

    const report = presenceReport();
    assert.equal(report.counts.phones, 1);
    assert.equal(report.phones[0].label, 'Alpha Crew');
    assert.equal(report.phones[0].state, 'current');
  });

  test('a phone holding an older version reads as behind', () => {
    const socket = net.connect(viewerCookie({ code: codes.teamA, subjectType: 'team', subjectId: 'team_a' }));
    socket.send('viewer:held', { updatedAt: '2020-01-01T00:00:00.000Z' });

    const report = presenceReport();
    assert.equal(report.phones[0].state, 'stale');
    assert.equal(report.counts.stale, 1);
  });

  /**
   * ⚠️ The one that matters. `updatedAt` has been per-subject since item 14, so
   * a comparison against the event's global timestamp would mark every phone in
   * the room behind the instant any one team changed — an alarm that is always
   * ringing, which is the same as no alarm. This test fails against that
   * implementation and passes against `versionForTargets`.
   */
  test("another team's change does not make this phone read as behind", async () => {
    const a = net.connect(viewerCookie({ code: codes.teamA, subjectType: 'team', subjectId: 'team_a' }));
    const b = net.connect(viewerCookie({ code: codes.teamB, subjectType: 'team', subjectId: 'team_b' }));
    a.send('viewer:held', { updatedAt: await currentVersionFor({ type: 'team', id: 'team_a' }) });
    b.send('viewer:held', { updatedAt: await currentVersionFor({ type: 'team', id: 'team_b' }) });

    const { touchTargets } = await import('../server/db.js');
    touchTargets([{ type: 'team', id: 'team_b' }], new Date(Date.now() + 5000).toISOString());

    const report = presenceReport();
    const byLabel = Object.fromEntries(report.phones.map((p) => [p.label, p.state]));
    assert.equal(byLabel['Alpha Crew'], 'current', 'Alpha did not change and must not be flagged');
    assert.equal(byLabel['Beta Crew'], 'stale');
    assert.equal(report.counts.stale, 1);
  });

  /**
   * Three states, not two. "Has never said anything" is neither up to date nor
   * behind, and calling it either one is a lie in a different direction.
   */
  test('a phone that has never reported is silent, not up to date', () => {
    net.connect(viewerCookie({ code: codes.teamA, subjectType: 'team', subjectId: 'team_a' }));
    const report = presenceReport();
    assert.equal(report.phones[0].state, 'silent');
    assert.equal(report.counts.current, 0);
    assert.equal(report.counts.stale, 0);
  });

  /**
   * ⚠️ Cookies are per browser, not per tab: the person running the rehearsal
   * has the panel and a viewer link open in the same browser, so their `/admin`
   * socket resolves to a real viewer subject. Counting it as a phone puts a
   * permanently silent row in the list belonging to somebody standing in the
   * room. Found by opening both, which is the only way this is ever used.
   */
  test('the panel is a panel even when the same browser holds a viewer cookie', () => {
    const cookie = `${adminCookie()}; ${viewerCookie({
      code: codes.teamA,
      subjectType: 'team',
      subjectId: 'team_a',
    })}`;
    net.connect(cookie);

    const report = presenceReport();
    assert.equal(report.counts.panels, 1);
    assert.equal(report.counts.phones, 0);
    assert.deepEqual(report.teamsPresent, [], 'the driver’s own laptop is not a team in the room');
  });

  /**
   * Read off the rooms, not off the labels. A dancer who has tapped her name is
   * a *person* session, so "has UNC opened their link" cannot be answered from
   * the list of subjects — but her targets contain her team, so the rooms can.
   */
  test('an identified dancer counts as her team being present', () => {
    net.connect(
      viewerCookie({ code: codes.teamA, subjectType: 'team', subjectId: 'team_a', personId: 'p_alice' })
    );
    const report = presenceReport();
    assert.equal(report.phones[0].label, 'Alice Alpha');
    assert.deepEqual(report.teamsPresent, ['team_a']);
  });

  test('a disconnected socket is forgotten', () => {
    const socket = net.connect(viewerCookie({ code: codes.teamA, subjectType: 'team', subjectId: 'team_a' }));
    assert.equal(presenceReport().counts.phones, 1);
    socket.close();
    assert.equal(presenceReport().counts.phones, 0);
  });

  /**
   * The backstop for a disconnect that never arrived. Presence is read at the
   * moment somebody is deciding whether a phone in the room is broken, and a
   * closed socket reported as connected sends them to fix a phone that is fine.
   */
  test('a socket the server no longer has is dropped from the report', () => {
    const socket = net.connect(viewerCookie({ code: codes.teamA, subjectType: 'team', subjectId: 'team_a' }));
    net.sockets.delete(socket.id); // vanished without a disconnect event
    assert.equal(presenceReport().counts.phones, 0);
  });

  test('a held value that is not a string is ignored rather than stored', () => {
    const socket = net.connect(viewerCookie({ code: codes.teamA, subjectType: 'team', subjectId: 'team_a' }));
    socket.send('viewer:held', { updatedAt: { nested: 'object' } });
    socket.send('viewer:held', { updatedAt: 'x'.repeat(500) });
    assert.equal(presenceReport().phones[0].state, 'silent');
  });

  /**
   * Same line the printed handout pack draws. This view names who is in the
   * room; it must not also be a way to read their schedule or their credential.
   */
  test('the report carries no access code and no schedule content', () => {
    net.connect(viewerCookie({ code: codes.teamA, subjectType: 'team', subjectId: 'team_a' }));
    const serialized = JSON.stringify(presenceReport());
    assert.ok(!serialized.includes(codes.teamA), 'an access code reached the presence view');
    assert.ok(!serialized.includes('Alpha warm-up'), 'schedule content reached the presence view');
  });

  test('a signed-out socket is counted but not listed as anybody', () => {
    net.connect('');
    const report = presenceReport();
    assert.equal(report.counts.phones, 0);
    assert.equal(report.counts.anonymous, 1);
  });

  /**
   * A roster edit re-derives every open socket's rooms (item 11). Dropping the
   * held version there would report a phone that has been correct all afternoon
   * as never having reported — which reads identically to one that has gone
   * quiet, and is the reading that sends somebody to fix a phone that is fine.
   */
  test('a re-derived socket keeps the version it had already reported', () => {
    const socket = net.connect(viewerCookie({ code: codes.teamA, subjectType: 'team', subjectId: 'team_a' }));
    socket.send('viewer:held', { updatedAt: '2026-01-01T00:00:00.000Z' });
    hub.refreshRooms(); // what a roster edit triggers
    const entry = presenceReport().phones.find((p) => p.id === socket.id);
    assert.equal(entry.held, '2026-01-01T00:00:00.000Z');
  });
});

/* ================================================================== *
 * Readiness
 * ================================================================== */

describe('whether a rehearsal would mean anything', () => {
  const setDates = (dates) => {
    const stmt = db.prepare('UPDATE event_days SET date = ? WHERE key = ?');
    for (const [key, date] of Object.entries(dates)) stmt.run(date, key);
  };
  const futureDates = { Thu: '2026-09-10', Fri: '2026-09-11', Sat: '2026-09-12', Sun: '2026-09-13' };

  afterEach(() => setDates(futureDates));

  test('dates still ahead of the venue’s today pass', () => {
    const result = checkEventDates({ at: new Date('2026-09-01T12:00:00Z') });
    assert.equal(result.level, OK);
    assert.match(result.title, /2026-09-10 → 2026-09-13/);
  });

  /**
   * The check this project has needed since item 9 and never had. The
   * placeholder date has been in the past since 2026-08-11 and every screen
   * renders it as an ordinary schedule with nothing now and nothing next.
   */
  test('a weekend that has already happened is a blocker', () => {
    const result = checkEventDates({ at: new Date('2027-01-01T12:00:00Z') });
    assert.equal(result.level, BLOCKER);
    assert.match(result.title, /in the past/);
  });

  /**
   * `npm run days` refuses to *write* one of these, but a database re-dated by
   * hand at 2am has no such guard — and a Saturday grid dated on a Friday is
   * invisible on every phone rather than wrong on any of them.
   */
  test('a date that is not the weekday it claims to be is a blocker', () => {
    setDates({ Sat: '2026-09-14' }); // a Monday
    const result = checkEventDates({ at: new Date('2026-09-01T12:00:00Z') });
    assert.equal(result.level, BLOCKER);
    assert.ok(result.items.some((i) => /Monday/.test(i)));
  });

  test('a non-contiguous weekend is a blocker', () => {
    setDates({ Sun: '2026-09-20' });
    const result = checkEventDates({ at: new Date('2026-09-01T12:00:00Z') });
    assert.equal(result.level, BLOCKER);
    assert.ok(result.items.some((i) => /contiguous/.test(i)));
  });

  /**
   * Item 24's standing gap: `Export` builds Saturday from the pipelines, and
   * Thursday, Friday and Sunday are the Manual Blocks tab. Somebody landing on
   * an empty Thursday sees a blank day and no part of the import says so —
   * every row that was there imported perfectly.
   */
  test('an event day with nothing on it is a blocker', () => {
    assert.equal(checkDayCoverage().level, OK);
    db.prepare('DELETE FROM schedule_blocks WHERE day = ?').run('Thu');
    const result = checkDayCoverage();
    assert.equal(result.level, BLOCKER);
    assert.ok(result.items.some((i) => /Thursday/.test(i)));

    const now = nowIso();
    db.prepare(
      `INSERT INTO schedule_blocks
         (id,day,start_time,end_time,activity_label,applies_to_type,applies_to_id,source,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run('b_thu', 'Thu', '18:00', '19:00', 'Airport pickup', 'person', 'p_alice', 'import', now, now);
  });

  /**
   * There is no honest headcount to test against, so provenance is the test: a
   * schedule made entirely of seed rows is the placeholder event, and that is a
   * fact about this database rather than a guess about the weekend.
   */
  test('a schedule made entirely of seed rows is a blocker', () => {
    assert.equal(checkRoster().level, OK);
    db.prepare("UPDATE schedule_blocks SET source = 'seed'").run();
    const result = checkRoster();
    assert.equal(result.level, BLOCKER);
    assert.match(result.title, /came from the seed/);
    db.prepare("UPDATE schedule_blocks SET source = 'import'").run();
  });

  test('some seed rows among real ones is a warning, not a blocker', () => {
    db.prepare("UPDATE schedule_blocks SET source = 'seed' WHERE id = 'b_a'").run();
    assert.equal(checkRoster().level, WARN);
    db.prepare("UPDATE schedule_blocks SET source = 'import' WHERE id = 'b_a'").run();
  });

  test('the roster check reports counts alongside its verdict', () => {
    const result = checkRoster();
    assert.equal(result.counts.people, 3);
    assert.equal(result.counts.teams, 2);
    assert.equal(result.counts.withContact, 3);
  });

  /**
   * ⚠️ In `deploy-config.js` a check's `level` is the severity it carries *if*
   * it fails, and `ok` is the result. Reading `level === 'fail'` as "failed"
   * reports every passing fatal check as a blocker, which is a readiness gate
   * that can never be green — and the first cut of this file did exactly that.
   */
  test('passing deploy checks are not reported as blockers', () => {
    const env = {
      NODE_ENV: 'test',
      ADMIN_PASSWORD: 'a-long-enough-password',
      SESSION_SECRET: 'K7m2QxZ9r4TvB8nW6yLpJ3sHdF5gC1aE',
    };
    const before = process.env;
    try {
      process.env = { ...before, ...env };
      const result = checkDeploy();
      const fatalWord = /would refuse to boot/;
      assert.ok(
        !(result.level === BLOCKER && !fatalWord.test(result.title)) ,
        'a blocker must name why it is one'
      );
      // Whatever else is unset here, the two above must not be among the items.
      assert.ok(!result.items.some((i) => /ADMIN_PASSWORD/.test(i)));
      assert.ok(!result.items.some((i) => /SESSION_SECRET/.test(i)));
    } finally {
      process.env = before;
    }
  });

  test('the report is ready exactly when it has no blockers', () => {
    const report = readinessReport({ at: new Date('2026-09-01T12:00:00Z') });
    assert.equal(report.ready, report.blockers === 0);
    // Worst first, so the terminal and the panel agree on what to read.
    const levels = report.checks.map((c) => c.level);
    const rank = { [BLOCKER]: 0, [WARN]: 1, [OK]: 2 };
    for (let i = 1; i < levels.length; i += 1) {
      assert.ok(rank[levels[i - 1]] <= rank[levels[i]], 'checks are not sorted worst-first');
    }
  });

  test('every check names a fix when it is not passing', () => {
    const report = readinessReport({ at: new Date('2027-01-01T12:00:00Z') });
    for (const c of report.checks) {
      if (c.level === OK) continue;
      assert.ok(c.fix, `${c.key} is not passing and offers no fix`);
    }
  });
});
