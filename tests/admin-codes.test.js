/**
 * Admin code management — item 8's done-when: *you can produce the exact file
 * you'll mail-merge from.*
 *
 * Two things are being checked here beyond "the buttons work". First, that
 * these endpoints are admin-only — they hand out live bearer tokens for every
 * subject at the event, so an unauthenticated one would be a worse roster dump
 * than the `/api/bootstrap` that item 6 removed. Second, that regenerate and
 * revoke actually invalidate the old code against the viewer API, not just in
 * the codes table: an admin who presses Revoke on a lost phone has to be right.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'royalty-codes-test-')), 'test.db');
process.env.DB_PATH = TMP_DB;
process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'test-admin-password';
process.env.PUBLIC_BASE_URL = 'https://schedule.example.org';

const { db } = await import('../server/db.js');
const { createApp } = await import('../server/app.js');
const { issueCode, codeForSubject } = await import('../server/lib/access-codes.js');
const { resetRateLimiter } = await import('../server/lib/viewer-auth.js');

let server;
let base;
let admin;

/* ------------------------------- fixture ------------------------------- */

function seedFixture() {
  const now = new Date().toISOString();
  db.exec(`
    INSERT INTO roles (id,label,selector,sort_order,active) VALUES
      ('dancer','Dancer','team',1,1),
      ('judge','Judge','person',2,1),
      ('sponsor','Sponsor','person',3,1);
    INSERT INTO event_days (key,label,date,sort_order) VALUES ('Sat','Saturday','2026-08-08',1);
    INSERT INTO contact_cards (id,name,title,phone,email) VALUES
      ('c_liaison','Sam Okafor','Team Liaison','+1-555-0102','sam@example.org'),
      ('c_judge','Jordan Judge','Head Judge','+1-555-0199','jordan@example.org');
    INSERT INTO teams (id,name,liaison_contact_id) VALUES
      ('team_a','Alpha Crew','c_liaison'),
      ('team_b','Beta Crew',NULL);
    INSERT INTO people (id,name,team_id,contact_id) VALUES
      ('p_alice','Alice Alpha','team_a',NULL),
      ('p_bianca','Bianca Beta','team_b',NULL),
      ('p_judge','Jordan Judge',NULL,'c_judge'),
      ('p_sponsor','Sasha Sponsor',NULL,NULL);
    INSERT INTO person_roles (person_id,role_id) VALUES
      ('p_alice','dancer'),
      ('p_bianca','dancer'),
      ('p_judge','judge'),
      ('p_sponsor','sponsor');
  `);

  db.prepare(
    `INSERT INTO schedule_blocks
       (id,day,start_time,end_time,activity_label,applies_to_type,applies_to_id,
        source,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,'test',?,?)`
  ).run('b_team_a', 'Sat', '09:00', '10:00', 'Alpha warm-up', 'team', 'team_a', now, now);
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
    /* the CSV export is not JSON */
  }
  return { status: res.status, body: json, text, headers: res.headers };
}

async function signInAdmin() {
  const c = jar();
  const res = await call('POST', '/api/admin/login', {
    body: { password: 'test-admin-password', name: 'Marcus' },
    cookies: c,
  });
  assert.equal(res.status, 200);
  return c;
}

const asAdmin = (method, url, body) => call(method, url, { body, cookies: admin });

/** Can this code still be redeemed by a viewer? The question revoke has to answer. */
async function codeStillWorks(code) {
  resetRateLimiter();
  const res = await call('POST', '/api/session', { body: { code } });
  return res.status === 200;
}

/**
 * A real CSV reader rather than a split on commas — the point of these tests is
 * that the file opens correctly in whatever runs the mail merge, so the parser
 * here should be as literal-minded as Excel is.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (text[i + 1] === '"') (field += '"'), i++;
      else quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') (row.push(field), (field = ''));
    else if (ch === '\n') (row.push(field), rows.push(row), (row = []), (field = ''));
    else if (ch !== '\r') field += ch;
  }
  if (field || row.length) (row.push(field), rows.push(row));
  return rows;
}

before(async () => {
  seedFixture();
  server = createApp({ serveClient: false }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  admin = await signInAdmin();
});

after(() => {
  server?.close();
  db.close();
  fs.rmSync(path.dirname(TMP_DB), { recursive: true, force: true });
});

/* =========================== the actual tests =========================== */

describe('the code endpoints are admin-only', () => {
  test('every one of them refuses an anonymous caller', async () => {
    const attempts = [
      ['GET', '/api/admin/codes'],
      ['GET', '/api/admin/codes/export.csv'],
      ['GET', '/api/admin/codes/for/team/team_a'],
      ['POST', '/api/admin/codes/backfill'],
      ['POST', '/api/admin/codes/regenerate-all'],
    ];
    for (const [method, url] of attempts) {
      const res = await call(method, url, {
        body: method === 'POST' ? { confirm: 'REGENERATE' } : undefined,
      });
      assert.equal(res.status, 401, `${url} should be refused`);
      assert.ok(!res.text.includes('Alpha Crew'), `${url} leaked a subject`);
    }
  });

  test('a viewer session is not an admin session', async () => {
    resetRateLimiter();
    const teamCode = issueCode({ subjectType: 'team', subjectId: 'team_a' }).code;
    const viewer = jar();
    assert.equal(
      (await call('POST', '/api/session', { body: { code: teamCode }, cookies: viewer })).status,
      200
    );
    const res = await call('GET', '/api/admin/codes', { cookies: viewer });
    assert.equal(res.status, 401);
  });
});

describe('coverage', () => {
  test('missing subjects are reported before anything is issued', async () => {
    const res = await asAdmin('GET', '/api/admin/codes');
    assert.equal(res.status, 200);

    // team_a got a code in the test above; everything else is still missing.
    const missing = res.body.missing.map((m) => m.subjectId).sort();
    assert.deepEqual(missing, ['p_judge', 'p_sponsor', 'team_b']);
    assert.equal(res.body.summary.missing, 3);

    // Dancers are deliberately not on that list — they use their team's code.
    assert.ok(!missing.includes('p_alice'));
  });

  test('backfill issues exactly the missing ones and keeps existing codes', async () => {
    const before = codeForSubject('team', 'team_a').code;

    const res = await asAdmin('POST', '/api/admin/codes/backfill');
    assert.equal(res.status, 200);
    assert.equal(res.body.created, 3);

    const after = await asAdmin('GET', '/api/admin/codes');
    assert.equal(after.body.summary.missing, 0);
    assert.equal(after.body.summary.live, 4);
    assert.equal(
      codeForSubject('team', 'team_a').code,
      before,
      'backfill must never rotate a code that has already gone out'
    );
  });

  test('never-used is counted, and opening a link clears it', async () => {
    const before = await asAdmin('GET', '/api/admin/codes');
    const judge = codeForSubject('person', 'p_judge').code;
    assert.equal(before.body.codes.find((c) => c.code === judge).lastUsedAt, null);

    resetRateLimiter();
    await call('GET', `/s/${judge}`);

    const after = await asAdmin('GET', '/api/admin/codes');
    assert.equal(after.body.summary.neverUsed, before.body.summary.neverUsed - 1);
    assert.ok(after.body.codes.find((c) => c.code === judge).lastUsedAt);
  });
});

describe('the CSV export', () => {
  test('is the mail-merge file: one row per live code, link already built', async () => {
    const res = await asAdmin('GET', '/api/admin/codes/export.csv');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/csv/);
    assert.match(res.headers.get('content-disposition'), /royalty-access-links-\d{4}-\d{2}-\d{2}\.csv/);

    const rows = parseCsv(res.text);
    assert.deepEqual(rows[0], [
      'Subject Type',
      'Subject',
      'Team',
      'Role',
      'Code',
      'Link',
      'Last Used',
    ]);
    assert.equal(rows.length, 5, 'header plus one row per live code');

    const alpha = rows.find((r) => r[1] === 'Alpha Crew');
    assert.equal(alpha[0], 'team');
    assert.equal(alpha[5], `https://schedule.example.org/s/${alpha[4]}`);

    const judge = rows.find((r) => r[1] === 'Jordan Judge');
    assert.equal(judge[3], 'Judge');
  });

  /**
   * `people.contact_id` is the coordinator a person should call, shared by a
   * whole role — so a "send to" column built from it would address every exec
   * board member's private link to the Event Director. The file must not carry
   * one until participants' own addresses exist in the model.
   */
  test('carries no contact details, because none of them belong to the subject', async () => {
    const text = (await asAdmin('GET', '/api/admin/codes/export.csv')).text;
    for (const leaked of ['sam@example.org', 'jordan@example.org', '+1-555-0102', 'Sam Okafor']) {
      assert.ok(!text.includes(leaked), `the export carried ${leaked}`);
    }
    const listed = await asAdmin('GET', '/api/admin/codes');
    assert.ok(!listed.text.includes('sam@example.org'));
  });

  test('the link uses PUBLIC_BASE_URL, not the host header a proxy passed along', async () => {
    const res = await call('GET', '/api/admin/codes/export.csv', { cookies: admin });
    assert.ok(!res.text.includes('127.0.0.1'), 'the request host leaked into the links');
  });

  test('every exported link actually signs someone in', async () => {
    const rows = parseCsv((await asAdmin('GET', '/api/admin/codes/export.csv')).text).slice(1);
    for (const row of rows) {
      resetRateLimiter();
      const c = jar();
      const res = await call('GET', `/s/${row[4]}`, { cookies: c });
      assert.equal(res.status, 302, `${row[1]}'s link should redirect`);
      assert.equal(
        (await call('GET', '/api/session', { cookies: c })).status,
        200,
        `${row[1]}'s link did not establish a session`
      );
    }
  });

  test('scoping to one subject type narrows the file', async () => {
    const teams = parseCsv((await asAdmin('GET', '/api/admin/codes/export.csv?type=team')).text);
    assert.equal(teams.length, 3);
    assert.ok(teams.slice(1).every((r) => r[0] === 'team'));
    assert.ok(!teams.some((r) => r[1] === 'Jordan Judge'));
  });
});

describe('regenerate', () => {
  test('the old code stops working and the new one starts', async () => {
    const before = codeForSubject('team', 'team_b').code;
    assert.ok(await codeStillWorks(before));

    const res = await asAdmin('POST', `/api/admin/codes/${before}/regenerate`);
    assert.equal(res.status, 200);
    const after = res.body.code.code;
    assert.notEqual(after, before);
    assert.equal(res.body.previous, before);

    assert.equal(await codeStillWorks(before), false, 'the replaced code must be dead');
    assert.ok(await codeStillWorks(after));
  });

  test('the revoked code stays on the table as an audit trail', async () => {
    const listed = await asAdmin('GET', '/api/admin/codes?revoked=true');
    const revoked = listed.body.codes.filter((c) => c.revokedAt);
    assert.ok(revoked.length > 0);
    // ...and is hidden by default, so the panel does not offer dead links.
    const live = await asAdmin('GET', '/api/admin/codes');
    assert.ok(live.body.codes.every((c) => !c.revokedAt));
  });

  test('regenerating an unknown or already-revoked code is refused', async () => {
    assert.equal((await asAdmin('POST', '/api/admin/codes/ZZZZZZZZ/regenerate')).status, 404);

    const revoked = (await asAdmin('GET', '/api/admin/codes?revoked=true')).body.codes.find(
      (c) => c.revokedAt
    );
    assert.equal((await asAdmin('POST', `/api/admin/codes/${revoked.code}/regenerate`)).status, 409);
  });
});

describe('revoke', () => {
  test('locks out a session that is already signed in', async () => {
    const code = issueCode({ subjectType: 'person', subjectId: 'p_sponsor', regenerate: true }).code;
    resetRateLimiter();
    const viewer = jar();
    assert.equal(
      (await call('POST', '/api/session', { body: { code }, cookies: viewer })).status,
      200
    );
    assert.equal((await call('GET', '/api/schedule', { cookies: viewer })).status, 200);

    assert.equal((await asAdmin('POST', `/api/admin/codes/${code}/revoke`)).status, 200);

    assert.equal(
      (await call('GET', '/api/schedule', { cookies: viewer })).status,
      401,
      'the lost phone must stop working, not just new sign-ins'
    );
    assert.equal(await codeStillWorks(code), false);
  });

  test('revoking twice is a conflict, not a silent success', async () => {
    const code = issueCode({ subjectType: 'person', subjectId: 'p_sponsor', regenerate: true }).code;
    assert.equal((await asAdmin('POST', `/api/admin/codes/${code}/revoke`)).status, 200);
    assert.equal((await asAdmin('POST', `/api/admin/codes/${code}/revoke`)).status, 409);
  });

  test('a revoked subject shows up as missing again, and can be re-issued', async () => {
    const listed = await asAdmin('GET', '/api/admin/codes');
    assert.ok(listed.body.missing.some((m) => m.subjectId === 'p_sponsor'));

    const res = await asAdmin('POST', '/api/admin/codes/issue', {
      subjectType: 'person',
      subjectId: 'p_sponsor',
    });
    assert.equal(res.status, 200);
    assert.ok(await codeStillWorks(res.body.code.code));
  });

  test('issuing for a subject that does not exist is refused', async () => {
    const res = await asAdmin('POST', '/api/admin/codes/issue', {
      subjectType: 'person',
      subjectId: 'p_nobody',
    });
    assert.equal(res.status, 404);
    assert.equal((await asAdmin('POST', '/api/admin/codes/issue', { subjectType: 'ghost' })).status, 400);
  });
});

describe('orphaned codes', () => {
  test('deleting a subject leaves its code flagged, not silently live', async () => {
    db.prepare("INSERT INTO teams (id,name) VALUES ('team_gone','Departed Crew')").run();
    const code = issueCode({ subjectType: 'team', subjectId: 'team_gone' }).code;
    db.prepare("DELETE FROM teams WHERE id = 'team_gone'").run();

    const listed = await asAdmin('GET', '/api/admin/codes');
    const row = listed.body.codes.find((c) => c.code === code);
    assert.equal(row.orphaned, true);
    assert.equal(row.subjectLabel, null);
    assert.ok(listed.body.summary.orphaned >= 1);

    // Regenerating it would mint a credential for nothing; revoking is the fix.
    assert.equal((await asAdmin('POST', `/api/admin/codes/${code}/regenerate`)).status, 409);
    assert.equal((await asAdmin('POST', `/api/admin/codes/${code}/revoke`)).status, 200);
  });

  test('orphans are left out of the mail-merge file', async () => {
    db.prepare("INSERT INTO teams (id,name) VALUES ('team_gone2','Departed Again')").run();
    const code = issueCode({ subjectType: 'team', subjectId: 'team_gone2' }).code;
    db.prepare("DELETE FROM teams WHERE id = 'team_gone2'").run();

    const csv = (await asAdmin('GET', '/api/admin/codes/export.csv')).text;
    assert.ok(!csv.includes(code), 'a code with no subject must not be mailed to anyone');
  });
});

describe('bulk regenerate', () => {
  test('does nothing without the typed confirmation', async () => {
    const before = codeForSubject('team', 'team_a').code;
    for (const body of [{}, { confirm: 'yes' }, { confirm: 'regenerate' }]) {
      const res = await asAdmin('POST', '/api/admin/codes/regenerate-all', body);
      assert.equal(res.status, 400);
    }
    assert.equal(codeForSubject('team', 'team_a').code, before);
  });

  test('scoped to teams, it rotates team codes and leaves staff codes alone', async () => {
    const teamBefore = codeForSubject('team', 'team_a').code;
    const judgeBefore = codeForSubject('person', 'p_judge').code;

    const res = await asAdmin('POST', '/api/admin/codes/regenerate-all', {
      confirm: 'REGENERATE',
      subjectType: 'team',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.regenerated, 2);

    assert.notEqual(codeForSubject('team', 'team_a').code, teamBefore);
    assert.equal(codeForSubject('person', 'p_judge').code, judgeBefore);
    assert.equal(await codeStillWorks(teamBefore), false);
  });

  test('unscoped, it rotates everything live and skips orphans', async () => {
    const before = Object.fromEntries(
      (await asAdmin('GET', '/api/admin/codes')).body.codes
        .filter((c) => !c.orphaned)
        .map((c) => [`${c.subjectType}:${c.subjectId}`, c.code])
    );

    const res = await asAdmin('POST', '/api/admin/codes/regenerate-all', { confirm: 'REGENERATE' });
    assert.equal(res.status, 200);
    assert.equal(res.body.regenerated, Object.keys(before).length);

    for (const [subject, old] of Object.entries(before)) {
      const [type, id] = subject.split(':');
      assert.notEqual(codeForSubject(type, id).code, old, `${subject} was not rotated`);
      assert.equal(await codeStillWorks(old), false, `${subject}'s old code still works`);
    }

    // Every subject still holds exactly one live code afterwards.
    const after = await asAdmin('GET', '/api/admin/codes');
    const subjects = after.body.codes.map((c) => `${c.subjectType}:${c.subjectId}`);
    assert.equal(subjects.length, new Set(subjects).size);
    assert.equal(after.body.summary.missing, 0);
  });
});

describe('the change log records who did what', () => {
  test('regenerate and revoke are attributed to the signed-in admin', async () => {
    const code = codeForSubject('person', 'p_judge').code;
    await asAdmin('POST', `/api/admin/codes/${code}/regenerate`);

    const log = (await asAdmin('GET', '/api/admin/log')).body.entries;
    const entry = log.find((e) => e.changeType === 'code_regenerated');
    assert.ok(entry, 'regeneration should be in the edit log');
    assert.equal(entry.editedBy, 'Marcus');
    // The code itself is not written into the log — it outlives the code.
    assert.ok(!entry.summary.includes(code));
  });
});
