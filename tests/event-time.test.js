/**
 * Event timezone — item 9.
 *
 * The failure being tested for is a silent one: a schedule shifted by an hour
 * (or five) looks exactly like a correct schedule, so every assertion here is
 * against an absolute UTC instant that was worked out by hand. Nothing checks
 * "the code agrees with itself".
 *
 * This file deliberately runs with `TZ` set to a zone that is neither the
 * venue's nor UTC. Every expected value below is independent of the host
 * machine, so any code path that quietly falls back to the *system* zone —
 * which is what the client used to do with the phone's zone — fails here.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.TZ = 'Asia/Tokyo'; // UTC+9, no DST: wrong in both directions.

const TMP_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'royalty-tz-test-')), 'test.db');
process.env.DB_PATH = TMP_DB;
process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'test-admin-password';
delete process.env.EVENT_TIMEZONE; // exercise the default: the venue's zone

const { db } = await import('../server/db.js');
const { createApp } = await import('../server/app.js');
const { issueCode } = await import('../server/lib/access-codes.js');
const { resetRateLimiter } = await import('../server/lib/viewer-auth.js');
const {
  blockInstants,
  dayInstants,
  eventTimeState,
  eventTimezone,
  instantFor,
  instantFromWallClockString,
  resetTimezoneCache,
} = await import('../server/lib/event-time.js');

let server;
let base;
let judgeCode;

/* ------------------------------- fixture ------------------------------- */

function seedFixture() {
  const now = new Date().toISOString();
  db.exec(`
    INSERT INTO roles (id,label,selector,sort_order,active) VALUES ('judge','Judge','person',1,1);
    INSERT INTO event_days (key,label,date,sort_order) VALUES
      ('Fri','Friday','2026-08-07',1),
      ('Sat','Saturday','2026-08-08',2),
      ('Undated','Floating','not-a-date',3);
    INSERT INTO people (id,name) VALUES ('p_judge','Jordan Judge');
    INSERT INTO person_roles (person_id,role_id) VALUES ('p_judge','judge');
  `);

  const block = db.prepare(
    `INSERT INTO schedule_blocks
       (id,day,start_time,end_time,activity_label,applies_to_type,applies_to_id,
        source,created_at,updated_at)
     VALUES (?,?,?,?,?,'person','p_judge','test',?,?)`
  );
  block.run('b_morning', 'Sat', '09:00', '10:00', 'Judges briefing', now, now);
  block.run('b_overnight', 'Fri', '23:30', '03:45', 'Social into call time', now, now);
  block.run('b_undated', 'Undated', '09:00', '10:00', 'Floating block', now, now);

  judgeCode = issueCode({ subjectType: 'person', subjectId: 'p_judge' }).code;
}

async function call(method, url, { cookies } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(cookies ? { cookie: cookies } : {}) },
    redirect: 'manual',
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, body: json, text, headers: res.headers };
}

before(() => {
  seedFixture();
  server = createApp({ serveClient: false }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  db.close();
  fs.rmSync(path.dirname(TMP_DB), { recursive: true, force: true });
});

/* =========================== the actual tests =========================== */

describe('resolving venue wall-clock to an instant', () => {
  test('the default zone is the venue, not the host machine', () => {
    assert.equal(eventTimezone(), 'America/Indiana/Indianapolis');
    assert.notEqual(eventTimezone(), process.env.TZ);
  });

  test('a summer time is EDT (UTC-4), not the standard offset', () => {
    // 09:00 on 2026-08-08 in Bloomington is 13:00 UTC — daylight saving is on.
    assert.equal(instantFor('2026-08-08', '09:00').toISOString(), '2026-08-08T13:00:00.000Z');
  });

  test('a winter time is EST (UTC-5) — the same code, a different offset', () => {
    // The event is in August, but a config that hardcoded -04:00 would pass the
    // test above and fail here. This is the assertion that rules out an offset.
    assert.equal(instantFor('2026-01-15', '09:00').toISOString(), '2026-01-15T14:00:00.000Z');
  });

  test('the host timezone does not leak into the answer', () => {
    // 09:00 read as Tokyo time would be 00:00Z; as UTC it would be 09:00Z.
    const iso = instantFor('2026-08-08', '09:00').toISOString();
    assert.notEqual(iso, '2026-08-08T00:00:00.000Z');
    assert.notEqual(iso, '2026-08-08T09:00:00.000Z');
  });

  test('midnight anchors the day, and the day is 24 hours long in August', () => {
    const { startsAt, endsAt } = dayInstants('2026-08-08');
    assert.equal(startsAt.toISOString(), '2026-08-08T04:00:00.000Z');
    assert.equal(endsAt.getTime() - startsAt.getTime(), 24 * 60 * 60 * 1000);
  });

  test('a day that loses an hour to a DST change is 23 hours long', () => {
    // 2026-03-08 is the US spring-forward. A fixed-offset implementation would
    // report 24 hours here and be an hour out for the rest of the year.
    const { startsAt, endsAt } = dayInstants('2026-03-08');
    assert.equal(endsAt.getTime() - startsAt.getTime(), 23 * 60 * 60 * 1000);
  });

  test('the offset is whole minutes even for an instant carrying milliseconds', () => {
    // Regression: the offset was measured against a timestamp that still had
    // its milliseconds, so a live clock produced "-04:0.011" instead of "-04:00".
    const state = eventTimeState(new Date('2026-08-08T13:00:00.137Z'));
    assert.equal(state.utcOffset, '-04:00');
    assert.equal(state.wallClock, '2026-08-08T09:00');
    assert.equal(state.abbreviation, 'EDT');
  });

  test('malformed dates and times resolve to null rather than to a plausible instant', () => {
    for (const [date, time] of [
      ['not-a-date', '09:00'],
      ['2026-08-08', '9am'],
      ['2026-08-08', '25:00'],
      ['2026-08-08', '09:75'],
      [null, null],
      [undefined, '09:00'],
    ]) {
      assert.equal(instantFor(date, time), null, `${date} ${time} should not resolve`);
    }
  });
});

describe('block start and end instants', () => {
  test('an ordinary block spans its own day', () => {
    const { startsAt, endsAt } = blockInstants('2026-08-08', '09:00', '10:00');
    assert.equal(startsAt.toISOString(), '2026-08-08T13:00:00.000Z');
    assert.equal(endsAt.toISOString(), '2026-08-08T14:00:00.000Z');
  });

  test('an end time before the start rolls into the next day', () => {
    // Friday 23:30 → Saturday 03:45, which is a real call time here.
    const { startsAt, endsAt } = blockInstants('2026-08-07', '23:30', '03:45');
    assert.equal(startsAt.toISOString(), '2026-08-08T03:30:00.000Z');
    assert.equal(endsAt.toISOString(), '2026-08-08T07:45:00.000Z');
    assert.ok(endsAt > startsAt);
    assert.equal(endsAt.getTime() - startsAt.getTime(), (4 * 60 + 15) * 60 * 1000);
  });

  test('an end time equal to the start is a full day, not a zero-length block', () => {
    const { startsAt, endsAt } = blockInstants('2026-08-08', '09:00', '09:00');
    assert.equal(endsAt.getTime() - startsAt.getTime(), 24 * 60 * 60 * 1000);
  });
});

/**
 * Resolved instants are memoized (item 20 — it was ~40% of the personalized
 * schedule's cost, and 600 phones refetch the same handful of times at once).
 * Both risks a cache introduces are checked here, because both would be silent:
 * one caller mutating another's Date, and an answer surviving a zone change.
 */
describe('the instant cache', () => {
  test('each call gets its own Date, so a caller cannot corrupt the cache', () => {
    const first = instantFor('2026-08-08', '09:00');
    const second = instantFor('2026-08-08', '09:00');
    assert.equal(first.getTime(), second.getTime());
    assert.notEqual(first, second);

    first.setFullYear(1999);
    assert.equal(instantFor('2026-08-08', '09:00').toISOString(), '2026-08-08T13:00:00.000Z');
  });

  test('a malformed reading stays null rather than being resolved once and cached wrong', () => {
    assert.equal(instantFor('2026-08-08', '25:00'), null);
    assert.equal(instantFor('2026-08-08', '25:00'), null);
    assert.equal(instantFor('not-a-date', '09:00'), null);
  });

  test('a zone change is not answered from the old zone', () => {
    assert.equal(instantFor('2026-08-08', '09:00').toISOString(), '2026-08-08T13:00:00.000Z');
    process.env.EVENT_TIMEZONE = 'Europe/London';
    resetTimezoneCache();
    assert.equal(instantFor('2026-08-08', '09:00').toISOString(), '2026-08-08T08:00:00.000Z');
    delete process.env.EVENT_TIMEZONE;
    resetTimezoneCache();
    assert.equal(instantFor('2026-08-08', '09:00').toISOString(), '2026-08-08T13:00:00.000Z');
  });
});

describe('the rehearsal override', () => {
  test('is read as venue wall-clock, not as the reader\'s local time', () => {
    assert.equal(
      instantFromWallClockString('2026-08-08T13:05').toISOString(),
      '2026-08-08T17:05:00.000Z'
    );
  });

  test('accepts a bare date and rejects nonsense', () => {
    assert.equal(
      instantFromWallClockString('2026-08-08').toISOString(),
      '2026-08-08T04:00:00.000Z'
    );
    for (const bad of ['', 'tomorrow', '2026-08-08T13', 'now', null]) {
      assert.equal(instantFromWallClockString(bad), null, `${bad} should not resolve`);
    }
  });
});

describe('configuration', () => {
  test('a fixed offset or an abbreviation is refused, by name', () => {
    for (const bad of ['EST', 'EDT', '-05:00', '+05:00', 'EST5EDT', 'GMT-5']) {
      process.env.EVENT_TIMEZONE = bad;
      resetTimezoneCache();
      assert.throws(() => eventTimezone(), /IANA/, `${bad} should be refused`);
    }
  });

  test('an unknown region name is refused', () => {
    process.env.EVENT_TIMEZONE = 'America/Bloomington';
    resetTimezoneCache();
    assert.throws(() => eventTimezone(), /not a timezone this system recognises/);
  });

  test('a real region name is accepted and actually changes the answer', () => {
    process.env.EVENT_TIMEZONE = 'America/Los_Angeles';
    resetTimezoneCache();
    assert.equal(eventTimezone(), 'America/Los_Angeles');
    assert.equal(instantFor('2026-08-08', '09:00').toISOString(), '2026-08-08T16:00:00.000Z');
  });

  test('there is no silent fallback: a bad zone throws rather than defaulting', () => {
    process.env.EVENT_TIMEZONE = 'Nonsense';
    resetTimezoneCache();
    assert.throws(() => eventTimeState());
  });

  after(() => {
    delete process.env.EVENT_TIMEZONE;
    resetTimezoneCache();
  });
});

describe('what the client is given', () => {
  test('/api/time reports the zone and the server clock without a session', async () => {
    const res = await call('GET', '/api/time');
    assert.equal(res.status, 200);
    assert.equal(res.body.timezone, 'America/Indiana/Indianapolis');
    assert.match(res.body.abbreviation, /^E[DS]T$/);
    assert.match(res.body.utcOffset, /^-0[45]:00$/);
    assert.ok(Math.abs(Date.parse(res.body.now) - Date.now()) < 5000);
    // It carries no event data, which is why it needs no code.
    assert.equal(res.body.eventName, undefined);
  });

  test('/api/time?at= resolves a rehearsal wall-clock in the event zone', async () => {
    const res = await call('GET', '/api/time?at=2026-08-08T13:05');
    assert.equal(res.status, 200);
    assert.equal(res.body.resolvedAt, '2026-08-08T17:05:00.000Z');

    const bad = await call('GET', '/api/time?at=lunchtime');
    assert.equal(bad.status, 400);
  });

  test('the schedule payload carries instants, not just wall-clock strings', async () => {
    resetRateLimiter();
    const signIn = await fetch(`${base}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: judgeCode }),
    });
    assert.equal(signIn.status, 200);
    const cookie = signIn.headers.getSetCookie()[0].split(';')[0];

    const res = await call('GET', '/api/schedule', { cookies: cookie });
    assert.equal(res.status, 200);

    const morning = res.body.blocks.find((b) => b.id === 'b_morning');
    assert.equal(morning.startTime, '09:00', 'the wall-clock string stays, for display');
    assert.equal(morning.startsAt, '2026-08-08T13:00:00.000Z');
    assert.equal(morning.endsAt, '2026-08-08T14:00:00.000Z');

    const overnight = res.body.blocks.find((b) => b.id === 'b_overnight');
    assert.equal(overnight.endsAt, '2026-08-08T07:45:00.000Z', 'past-midnight block rolls over');

    const saturday = res.body.days.find((d) => d.key === 'Sat');
    assert.equal(saturday.startsAt, '2026-08-08T04:00:00.000Z');

    assert.equal(res.body.eventTime.timezone, 'America/Indiana/Indianapolis');
    assert.ok(Math.abs(Date.parse(res.body.eventTime.now) - Date.now()) < 5000);
  });

  test('a block on a day with no usable date gets null instants, not a guess', async () => {
    resetRateLimiter();
    const signIn = await fetch(`${base}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: judgeCode }),
    });
    const cookie = signIn.headers.getSetCookie()[0].split(';')[0];
    const res = await call('GET', '/api/schedule', { cookies: cookie });

    const floating = res.body.blocks.find((b) => b.id === 'b_undated');
    assert.equal(floating.startsAt, null);
    assert.equal(floating.endsAt, null);
    // It is still listed — the client shows it without a now/next status.
    assert.equal(floating.activity, 'Floating block');
  });
});
