/**
 * Authorization tests for the viewer API — item 6's done-when.
 *
 * The question these have to answer, in the plan's words: *can I reach another
 * subject's schedule without their code?* Most of what follows is therefore
 * negative cases. A suite that only proves the happy path would have passed
 * against the old code, which served any participant's schedule and phone
 * number to anyone who could edit a query string.
 *
 * Runs against a throwaway database and the real Express app, so middleware
 * order and cookie handling are the production ones.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'royalty-test-')), 'test.db');
process.env.DB_PATH = TMP_DB;
process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'test-admin-password';

// Imported after DB_PATH is set — db.js resolves the path at import time.
const { db } = await import('../server/db.js');
const { createApp } = await import('../server/app.js');
const { issueCode, revokeCode } = await import('../server/lib/access-codes.js');
const { resetRateLimiter } = await import('../server/lib/viewer-auth.js');

let server;
let base;
const ids = {};

/* ------------------------------- fixture ------------------------------- */

function seedFixture() {
  const now = new Date().toISOString();
  db.exec(`
    INSERT INTO roles (id,label,selector,sort_order,active) VALUES
      ('dancer','Dancer','team',1,1),
      ('judge','Judge','person',2,1);
    INSERT INTO event_days (key,label,date,sort_order) VALUES ('Sat','Saturday','2026-08-08',1);
    INSERT INTO teams (id,name) VALUES ('team_a','Alpha Crew'),('team_b','Beta Crew');
    INSERT INTO people (id,name,team_id) VALUES
      ('p_alice','Alice Alpha','team_a'),
      ('p_amir','Amir Alpha','team_a'),
      ('p_bianca','Bianca Beta','team_b'),
      ('p_judge','Jordan Judge',NULL);
    INSERT INTO person_roles (person_id,role_id) VALUES
      ('p_alice','dancer'),
      ('p_amir','dancer'),
      ('p_bianca','dancer'),
      ('p_judge','judge');
  `);

  const block = db.prepare(
    `INSERT INTO schedule_blocks
       (id,day,start_time,end_time,activity_label,applies_to_type,applies_to_id,
        source,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,'test',?,?)`
  );
  block.run('b_team_a', 'Sat', '09:00', '10:00', 'Alpha warm-up', 'team', 'team_a', now, now);
  block.run('b_team_b', 'Sat', '09:00', '10:00', 'Beta warm-up', 'team', 'team_b', now, now);
  block.run('b_alice', 'Sat', '07:00', '08:00', 'Alice airport pickup', 'person', 'p_alice', now, now);
  block.run('b_bianca', 'Sat', '07:00', '08:00', 'Bianca airport pickup', 'person', 'p_bianca', now, now);
  block.run('b_judge', 'Sat', '12:00', '17:00', 'Judging panel', 'person', 'p_judge', now, now);

  ids.teamA = issueCode({ subjectType: 'team', subjectId: 'team_a' }).code;
  ids.teamB = issueCode({ subjectType: 'team', subjectId: 'team_b' }).code;
  ids.judge = issueCode({ subjectType: 'person', subjectId: 'p_judge' }).code;
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
        if (value === '' ) delete cookies[name];
        else cookies[name] = value;
      }
    },
    set(name, value) {
      cookies[name] = value;
    },
    clear() {
      cookies = {};
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

const labels = (payload) => payload.blocks.map((b) => b.activity).sort();

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

describe('unauthenticated access', () => {
  test('GET /api/schedule without a session is refused', async () => {
    const res = await call('GET', '/api/schedule');
    assert.equal(res.status, 401);
    assert.equal(res.body.blocks, undefined);
  });

  test('the old query-string form does not work either', async () => {
    for (const url of [
      '/api/schedule?type=team&id=team_a',
      '/api/schedule?type=person&id=p_alice',
      '/api/schedule?type=role&id=dancer',
    ]) {
      const res = await call('GET', url);
      assert.equal(res.status, 401, `${url} should be refused`);
      assert.equal(res.body.blocks, undefined);
    }
  });

  test('/api/bootstrap no longer enumerates the roster', async () => {
    const res = await call('GET', '/api/bootstrap');
    assert.equal(res.status, 200);
    assert.equal(res.body.people, undefined);
    assert.equal(res.body.teams, undefined);
    assert.equal(res.body.roles, undefined);
    // And nothing identifying hides in the payload.
    for (const needle of ['Alice', 'Bianca', 'team_a', 'p_alice', 'Alpha']) {
      assert.ok(!res.text.includes(needle), `bootstrap leaked ${needle}`);
    }
  });

  test('the team roster endpoint needs a session', async () => {
    const res = await call('GET', '/api/session/roster');
    assert.equal(res.status, 401);
  });

  test('admin endpoints still require the admin password', async () => {
    for (const url of ['/api/admin/roster', '/api/admin/blocks', '/api/admin/log']) {
      assert.equal((await call('GET', url)).status, 401, `${url} should be refused`);
    }
  });
});

describe('redeeming a code', () => {
  test('a wrong code is refused and grants nothing', async () => {
    resetRateLimiter();
    const c = jar();
    const res = await call('POST', '/api/session', { body: { code: 'ZZZZZZZZ' }, cookies: c });
    assert.equal(res.status, 401);
    assert.equal(res.body.reason, 'invalid');
    assert.equal((await call('GET', '/api/schedule', { cookies: c })).status, 401);
  });

  test('malformed codes are rejected without touching the database', async () => {
    resetRateLimiter();
    for (const code of ['', 'short', null, 12345, 'AAAAOAAA', { $ne: null }, "' OR 1=1 --"]) {
      const res = await call('POST', '/api/session', { body: { code } });
      assert.equal(res.status, 401, `${JSON.stringify(code)} should be refused`);
    }
  });

  test('a revoked code stops working', async () => {
    resetRateLimiter();
    const doomed = issueCode({ subjectType: 'person', subjectId: 'p_alice' }).code;
    assert.equal((await call('POST', '/api/session', { body: { code: doomed } })).status, 200);
    revokeCode(doomed);
    const res = await call('POST', '/api/session', { body: { code: doomed } });
    assert.equal(res.status, 401);
    assert.equal(res.body.reason, 'revoked');
  });

  test('revoking kills sessions that are already signed in', async () => {
    resetRateLimiter();
    const code = issueCode({ subjectType: 'person', subjectId: 'p_alice', regenerate: true }).code;
    const c = await signIn(code);
    assert.equal((await call('GET', '/api/schedule', { cookies: c })).status, 200);

    revokeCode(code);

    // The cookie is still signed and unexpired — this only fails if the server
    // re-checks the code against the database on every request.
    assert.equal((await call('GET', '/api/schedule', { cookies: c })).status, 401);
  });

  test('repeated wrong codes get rate limited', async () => {
    resetRateLimiter();
    let sawLimit = false;
    for (let i = 0; i < 15; i++) {
      const res = await call('POST', '/api/session', { body: { code: 'ZZZZZZZZ' } });
      if (res.status === 429) {
        sawLimit = true;
        break;
      }
    }
    assert.ok(sawLimit, 'expected a 429 within 15 wrong codes');

    // A correct code is refused too while the limiter is engaged.
    assert.equal((await call('POST', '/api/session', { body: { code: ids.judge } })).status, 429);
    resetRateLimiter();
  });
});

describe('a staff code sees only that person', () => {
  test('schedule is their own, and ignores any id the client sends', async () => {
    resetRateLimiter();
    const c = await signIn(ids.judge);

    const mine = await call('GET', '/api/schedule', { cookies: c });
    assert.equal(mine.status, 200);
    assert.deepEqual(labels(mine.body), ['Judging panel']);

    // The parameters that used to control this are now inert.
    const tampered = await call('GET', '/api/schedule?type=team&id=team_a&id=p_alice', {
      cookies: c,
    });
    assert.equal(tampered.status, 200);
    assert.deepEqual(labels(tampered.body), ['Judging panel']);
    assert.ok(!tampered.text.includes('Alpha warm-up'));
    assert.ok(!tampered.text.includes('Bianca'));
  });

  test('a staff code cannot list a team', async () => {
    resetRateLimiter();
    const c = await signIn(ids.judge);
    const res = await call('GET', '/api/session/roster', { cookies: c });
    assert.equal(res.status, 403);
    assert.equal(res.body.people, undefined);
  });

  test('a staff code cannot identify as a dancer', async () => {
    resetRateLimiter();
    const c = await signIn(ids.judge);
    const res = await call('POST', '/api/session/identify', {
      body: { personId: 'p_alice' },
      cookies: c,
    });
    assert.equal(res.status, 403);
  });
});

describe('a team code is scoped to its own team', () => {
  test('before identifying, it sees the team schedule only', async () => {
    resetRateLimiter();
    const c = await signIn(ids.teamA);
    const res = await call('GET', '/api/schedule', { cookies: c });
    assert.equal(res.status, 200);
    assert.deepEqual(labels(res.body), ['Alpha warm-up']);
    assert.ok(!res.text.includes('Beta warm-up'));
  });

  test('the roster lists that team and no one else', async () => {
    resetRateLimiter();
    const c = await signIn(ids.teamA);
    const res = await call('GET', '/api/session/roster', { cookies: c });
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.people.map((p) => p.name).sort(),
      ['Alice Alpha', 'Amir Alpha']
    );
    assert.ok(!res.text.includes('Bianca'));
    assert.ok(!res.text.includes('Jordan'));
  });

  test('identifying as someone on another team is refused', async () => {
    resetRateLimiter();
    const c = await signIn(ids.teamA);
    for (const personId of ['p_bianca', 'p_judge', 'nonexistent', '']) {
      const res = await call('POST', '/api/session/identify', { body: { personId }, cookies: c });
      assert.equal(res.status, 403, `identifying as ${personId} should be refused`);
    }
    // And the session is unchanged by the attempts.
    assert.deepEqual(labels((await call('GET', '/api/schedule', { cookies: c })).body), [
      'Alpha warm-up',
    ]);
  });

  test('identifying as a teammate yields their own person blocks', async () => {
    resetRateLimiter();
    const c = await signIn(ids.teamA);
    const up = await call('POST', '/api/session/identify', {
      body: { personId: 'p_alice' },
      cookies: c,
    });
    assert.equal(up.status, 200);
    assert.equal(up.body.identified, true);

    const res = await call('GET', '/api/schedule', { cookies: c });
    assert.deepEqual(labels(res.body), ['Alice airport pickup', 'Alpha warm-up']);
    assert.ok(!res.text.includes('Bianca airport pickup'));
  });

  test('a team A session cannot reach team B by any route', async () => {
    resetRateLimiter();
    const c = await signIn(ids.teamA);
    await call('POST', '/api/session/identify', { body: { personId: 'p_alice' }, cookies: c });

    const attempts = [
      ['GET', '/api/schedule?type=team&id=team_b'],
      ['GET', '/api/schedule?type=person&id=p_bianca'],
      ['GET', '/api/schedule?subjectId=team_b'],
      ['GET', '/api/session/roster?teamId=team_b'],
    ];
    for (const [method, url] of attempts) {
      const res = await call(method, url, { cookies: c });
      assert.ok(res.status < 500, `${url} should not error`);
      assert.ok(!res.text.includes('Beta warm-up'), `${url} leaked team B's schedule`);
      assert.ok(!res.text.includes('Bianca'), `${url} leaked a team B member`);
    }
  });
});

describe('magic links', () => {
  test('/s/:code signs in and redirects, leaving the code out of the landing URL', async () => {
    resetRateLimiter();
    const c = jar();
    const res = await call('GET', `/s/${ids.judge}`, { cookies: c });
    assert.equal(res.status, 302);
    assert.equal(res.body, null);

    const sched = await call('GET', '/api/schedule', { cookies: c });
    assert.equal(sched.status, 200, 'the redirect should have established a session');
    assert.deepEqual(labels(sched.body), ['Judging panel']);
  });

  test('a bad code redirects to the code screen with a reason, and grants nothing', async () => {
    resetRateLimiter();
    const cases = { ZZZZZZZZ: 'invalid', 'not-a-code': 'invalid' };
    for (const [code, reason] of Object.entries(cases)) {
      const c = jar();
      const res = await call('GET', `/s/${code}`, { cookies: c });
      assert.equal(res.status, 302);
      assert.match(res.text, new RegExp(`signin=${reason}`), `${code} -> ${reason}`);
      assert.equal((await call('GET', '/api/schedule', { cookies: c })).status, 401);
    }
  });

  test('a revoked code redirects with its own distinct reason', async () => {
    resetRateLimiter();
    const code = issueCode({ subjectType: 'person', subjectId: 'p_amir' }).code;
    revokeCode(code);
    const res = await call('GET', `/s/${code}`);
    assert.equal(res.status, 302);
    assert.match(res.text, /signin=revoked/);
  });

  test('magic links share the manual box rate limiter', async () => {
    resetRateLimiter();
    let limited = false;
    for (let i = 0; i < 15; i++) {
      const res = await call('GET', '/s/ZZZZZZZZ');
      if (/signin=rate/.test(res.text)) {
        limited = true;
        break;
      }
    }
    assert.ok(limited, 'expected the magic link to hit the same limiter');
    // And the manual box is limited too — one budget, not two.
    assert.equal((await call('POST', '/api/session', { body: { code: ids.judge } })).status, 429);
    resetRateLimiter();
  });

  test('a team magic link lands on the identity step, not a schedule', async () => {
    resetRateLimiter();
    const c = jar();
    await call('GET', `/s/${ids.teamA}`, { cookies: c });
    const session = await call('GET', '/api/session', { cookies: c });
    assert.equal(session.status, 200);
    assert.equal(session.body.needsIdentity, true);
    assert.equal(session.body.identified, false);
  });
});

describe('returning and leaving', () => {
  test('a returning visit needs no code', async () => {
    resetRateLimiter();
    const c = await signIn(ids.judge);
    // Same cookie, fresh page load.
    const again = await call('GET', '/api/session', { cookies: c });
    assert.equal(again.status, 200);
    assert.equal(again.body.needsIdentity, false);
    assert.equal(again.body.subject.name, 'Jordan Judge');
  });

  test('signing out ends the session', async () => {
    resetRateLimiter();
    const c = await signIn(ids.judge);
    assert.equal((await call('DELETE', '/api/session', { cookies: c })).status, 200);
    assert.equal((await call('GET', '/api/schedule', { cookies: c })).status, 401);
  });

  test('stepping back to the team list keeps the session but drops the person', async () => {
    resetRateLimiter();
    const c = await signIn(ids.teamA);
    await call('POST', '/api/session/identify', { body: { personId: 'p_alice' }, cookies: c });
    assert.deepEqual(labels((await call('GET', '/api/schedule', { cookies: c })).body), [
      'Alice airport pickup',
      'Alpha warm-up',
    ]);

    const back = await call('DELETE', '/api/session/identify', { cookies: c });
    assert.equal(back.status, 200);
    assert.equal(back.body.needsIdentity, true);
    assert.deepEqual(labels((await call('GET', '/api/schedule', { cookies: c })).body), [
      'Alpha warm-up',
    ]);
  });
});

describe('cookie tampering', () => {
  test('a forged or edited session cookie is rejected', async () => {
    resetRateLimiter();
    const c = await signIn(ids.teamA);
    const real = c.header().split('royalty_session=')[1];

    const forgeries = {
      'unsigned payload': Buffer.from(
        JSON.stringify({ c: ids.teamB, t: 'team', i: 'team_b', exp: Date.now() + 1e6 })
      ).toString('base64url'),
      'payload swapped, signature kept': `${Buffer.from(
        JSON.stringify({ c: ids.teamA, t: 'team', i: 'team_b', exp: Date.now() + 1e6 })
      ).toString('base64url')}.${real.split('.')[1]}`,
      'signature mangled': `${real.split('.')[0]}.${'A'.repeat(real.split('.')[1].length)}`,
      'empty': '',
      'junk': 'not-a-token',
    };

    for (const [name, token] of Object.entries(forgeries)) {
      const forged = jar();
      forged.set('royalty_session', token);
      const res = await call('GET', '/api/schedule', { cookies: forged });
      assert.equal(res.status, 401, `${name} should be refused`);
      assert.ok(!res.text.includes('warm-up'), `${name} leaked a schedule`);
    }
  });

  test('an expired session is rejected', async () => {
    resetRateLimiter();
    const { signPayload } = await import('../server/lib/auth.js');
    const expired = jar();
    expired.set(
      'royalty_session',
      signPayload({ c: ids.teamA, t: 'team', i: 'team_a', p: null, exp: Date.now() - 1000 })
    );
    assert.equal((await call('GET', '/api/schedule', { cookies: expired })).status, 401);
  });

  test('a validly signed cookie naming a person on another team is rejected', async () => {
    resetRateLimiter();
    const { signPayload } = await import('../server/lib/auth.js');
    // Signed by the server's own secret — this passes signature verification
    // and must still be refused by the team-membership re-check.
    const crossed = jar();
    crossed.set(
      'royalty_session',
      signPayload({ c: ids.teamA, t: 'team', i: 'team_a', p: 'p_bianca', exp: Date.now() + 1e6 })
    );
    const res = await call('GET', '/api/schedule', { cookies: crossed });
    assert.equal(res.status, 401);
    assert.ok(!res.text.includes('Bianca'));
  });
});
