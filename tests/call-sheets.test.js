/**
 * Printed fallback call sheets — item 28.
 *
 * Paper is reached for at the moment there is nothing left to check it
 * against, so the tests here are weighted towards the two ways it can be
 * confidently wrong rather than towards how it looks:
 *
 *   it disagrees with the phones  — the blocks come from the viewer's own
 *                                   query, and a team sheet has to carry the
 *                                   person-targeted blocks the *team view*
 *                                   deliberately hides behind the identity step
 *   it quietly omits somebody     — a person on no sheet, or a block on no
 *                                   sheet, is silent everywhere else
 *
 * Plus the one thing paper can do that a screen cannot: get photographed. The
 * handout pack must carry no access code.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'royalty-call-sheets-')), 'test.db');
process.env.DB_PATH = TMP_DB;
process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'test-admin-password';
process.env.EVENT_TIMEZONE = 'America/Indiana/Indianapolis';
delete process.env.ON_CALL_NAME;
delete process.env.ON_CALL_PHONE;

const { db } = await import('../server/db.js');
const { createApp } = await import('../server/app.js');
const { issueCode } = await import('../server/lib/access-codes.js');
const { getPersonalizedSchedule } = await import('../server/lib/queries.js');
const { buildCallSheets, renderCallSheets, onCall } = await import('../server/lib/call-sheets.js');
const { inspectDeployConfig } = await import('../server/lib/deploy-config.js');

let server;
let base;
let admin;
const codes = {};

const START = new Date('2026-08-01T12:00:00.000Z').toISOString();

/**
 * The fixture is the shape that catches things: a team whose captain holds a
 * second role and whose dancer has an airport pickup, a staff role reached
 * individually, a dancer left on no team (item 14 unassigns rather than
 * deletes), a role nobody holds, and a person on nothing at all.
 */
const BLOCKS = [
  ['b_all', 'Sat', '08:00', '08:15', 'Doors open', 'everyone', 'all'],
  ['b_team_a', 'Sat', '09:00', '10:00', 'Alpha warm-up', 'team', 'team_a'],
  ['b_team_b', 'Sat', '10:00', '11:00', 'Beta warm-up', 'team', 'team_b'],
  ['b_dancers', 'Sat', '12:00', '12:30', 'All-dancer briefing', 'role', 'dancer'],
  ['b_captains', 'Fri', '18:00', '18:30', 'Captains meeting', 'role', 'captain'],
  ['b_judges', 'Sat', '09:30', '10:00', 'Judges check-in', 'role', 'judge'],
  ['b_maya', 'Thu', '14:00', '15:00', 'Maya airport pickup', 'person', 'p_maya'],
  ['b_nina', 'Thu', '15:00', '16:00', 'Nina airport pickup', 'person', 'p_nina'],
  ['b_jo', 'Sun', '07:00', '08:00', 'Jo departure run', 'person', 'p_judge'],
  // A role with no holders — the block reaches no phone and no sheet, and
  // nothing else in the app says so.
  ['b_ghost', 'Sat', '13:00', '13:30', 'Sponsor lounge', 'role', 'sponsor'],
];

function seedFixture() {
  db.exec(`
    INSERT INTO roles (id,label,selector,sort_order,active) VALUES
      ('dancer','Dancer','team',1,1),
      ('judge','Judge','person',3,1),
      ('sponsor','Sponsor','person',5,1),
      ('captain','Captain','person',9,1);
    INSERT INTO event_days (key,label,date,sort_order) VALUES
      ('Thu','Thursday','2026-08-06',1),
      ('Fri','Friday','2026-08-07',2),
      ('Sat','Saturday','2026-08-08',3),
      ('Sun','Sunday','2026-08-09',4);
    INSERT INTO contact_cards (id,name,title,phone) VALUES
      ('c_liaison','Lee Marchetti','Team Liaison','+1 555 0100');
    INSERT INTO teams (id,name,liaison_contact_id,show_order) VALUES
      ('team_a','Alpha Crew','c_liaison',1),
      ('team_b','<script>Beta</script>',NULL,2);
    INSERT INTO people (id,name,team_id) VALUES
      ('p_maya','Maya Captain','team_a'),
      ('p_nina','Nina Dancer','team_a'),
      ('p_judge','Jo Judge',NULL),
      ('p_loose','Ollie Unassigned',NULL),
      ('p_nothing','Sam Nobody',NULL);
    INSERT INTO person_roles (person_id,role_id) VALUES
      ('p_maya','dancer'),('p_maya','captain'),
      ('p_nina','dancer'),
      ('p_judge','judge'),
      ('p_loose','dancer');
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
  // p_loose deliberately gets none: reached through a team code, on no team.
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
    /* the call-sheet route answers HTML on purpose */
  }
  return { status: res.status, body: json, text, type: res.headers.get('content-type') };
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

/** What one real phone holds, through a real code. */
async function asViewer(code, personId = null) {
  const c = jar();
  const signIn = await call('POST', '/api/session', { body: { code }, cookies: c });
  assert.equal(signIn.status, 200, signIn.body?.error);
  if (personId) {
    const picked = await call('POST', '/api/session/identify', { body: { personId }, cookies: c });
    assert.equal(picked.status, 200, picked.body?.error);
  }
  const schedule = await call('GET', '/api/schedule', { cookies: c });
  assert.equal(schedule.status, 200, schedule.body?.error);
  return schedule.body;
}

const doc = () => buildCallSheets({ baseUrl: 'https://royalty.example' });
const sheetFor = (key) => doc().sheets.find((s) => s.key === key);
const sharedActivities = (sheet) => sheet.shared.flatMap((d) => d.blocks.map((b) => b.activity)).sort();
const personOn = (sheet, name) => sheet.people.find((p) => p.name === name);
const personActivities = (section) =>
  section.days.flatMap((d) => d.blocks.map((b) => b.activity)).sort();

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

/* ------------------------------ fidelity ------------------------------- */

describe('paper says what the phones say', () => {
  test('every block on a person’s phone is somewhere on their sheet', () => {
    const built = doc();
    for (const sheet of built.sheets) {
      const shared = new Set(sheet.shared.flatMap((d) => d.blocks.map((b) => b.id)));
      for (const person of sheet.people) {
        const own = getPersonalizedSchedule({ type: 'person', id: person.id }).blocks;
        const printed = new Set([...shared, ...person.blockIds]);
        for (const block of own) {
          assert.ok(
            printed.has(block.id),
            `${person.name}'s phone shows "${block.activity}" and their sheet does not`
          );
        }
      }
    }
  });

  test('the shared half is exactly what that team’s code shows, block for block', async () => {
    const phone = await asViewer(codes.teamA);
    const sheet = sheetFor('team:team_a');
    assert.deepEqual(
      sheet.shared.flatMap((d) => d.blocks.map((b) => b.id)).sort(),
      phone.blocks.map((b) => b.id).sort()
    );
  });

  test('a captain’s section is her own payload minus the shared part', async () => {
    const phone = await asViewer(codes.teamA, 'p_maya');
    const sheet = sheetFor('team:team_a');
    const shared = new Set(sheet.shared.flatMap((d) => d.blocks.map((b) => b.id)));
    assert.deepEqual(
      personActivities(personOn(sheet, 'Maya Captain')).sort(),
      phone.blocks
        .filter((b) => !shared.has(b.id))
        .map((b) => b.activity)
        .sort()
    );
  });
});

/* --------------------- what the identity step hides --------------------- */

describe('a team sheet is the team plus its members', () => {
  test('the shared half holds no person-targeted and no captain block', () => {
    // Same property `view-as` asserts about the pre-identity view. If this
    // starts failing, the team session has changed and the sheets follow it.
    assert.deepEqual(sharedActivities(sheetFor('team:team_a')), [
      'All-dancer briefing',
      'Alpha warm-up',
      'Doors open',
    ]);
  });

  test('but both airport pickups are on the sheet, under their own names', () => {
    // The trap this whole module exists for: printing the team view alone
    // produces a sheet with every airport run missing and no error anywhere.
    const sheet = sheetFor('team:team_a');
    assert.deepEqual(personActivities(personOn(sheet, 'Maya Captain')), [
      'Captains meeting',
      'Maya airport pickup',
    ]);
    assert.deepEqual(personActivities(personOn(sheet, 'Nina Dancer')), ['Nina airport pickup']);
  });

  test('the captains meeting is under the captain, not over the whole team', () => {
    const sheet = sheetFor('team:team_a');
    assert.ok(!sharedActivities(sheet).includes('Captains meeting'));
    assert.ok(!personActivities(personOn(sheet, 'Nina Dancer')).includes('Captains meeting'));
  });

  test('a staff role sheet carries the role’s blocks and each holder’s own', () => {
    const sheet = sheetFor('role:judge');
    assert.deepEqual(sharedActivities(sheet), ['Doors open', 'Judges check-in']);
    assert.deepEqual(personActivities(personOn(sheet, 'Jo Judge')), ['Jo departure run']);
  });
});

/* ------------------------------ coverage ------------------------------- */

describe('nobody and nothing goes missing', () => {
  test('every person is on exactly one sheet', () => {
    const seen = new Map();
    for (const sheet of doc().sheets) {
      for (const p of sheet.people) {
        assert.ok(!seen.has(p.id), `${p.name} is on two sheets: ${seen.get(p.id)} and ${sheet.key}`);
        seen.set(p.id, sheet.key);
      }
    }
    // Everybody except the one who is on nothing, who is reported instead.
    assert.equal(seen.size, 4);
  });

  test('a dancer on no team is printed on the role sheet rather than nowhere', () => {
    // Item 14 unassigns a deleted team's dancers. They keep a schedule and lose
    // the ability to sign in — on paper they still have to appear.
    const sheet = sheetFor('role:dancer');
    assert.ok(personOn(sheet, 'Ollie Unassigned'));
  });

  test('somebody on no team and no role is reported, not silently dropped', () => {
    const { coverage } = doc();
    assert.deepEqual(
      coverage.unplaced.map((p) => p.name),
      ['Sam Nobody']
    );
    assert.equal(coverage.placed, 4);
    assert.equal(coverage.people, 5);
  });

  test('a block that reaches no sheet is named, with what it targets', () => {
    // A role nobody holds. It reaches no phone either, which is the actual
    // fault — the pack is just where it becomes visible.
    const { coverage } = doc();
    assert.deepEqual(
      coverage.unprinted.map((b) => [b.activity, b.target]),
      [['Sponsor lounge', 'All Sponsor']]
    );
  });

  test('the announcement is on every sheet', () => {
    for (const sheet of doc().sheets) {
      assert.ok(
        sharedActivities(sheet).includes('Doors open'),
        `${sheet.title} is missing the event-wide block`
      );
    }
  });
});

/* -------------------------------- desk --------------------------------- */

describe('the desk index answers "I lost my link"', () => {
  const deskFor = (name) => doc().desk.find((d) => d.name === name);

  test('a dancer is sent to her team’s code, never a personal one', () => {
    const row = deskFor('Nina Dancer');
    assert.equal(row.code, codes.teamA);
    assert.match(row.how, /Team link/);
    assert.match(row.how, /tap their name/);
  });

  test('a captain is on her team’s code too, despite holding a second role', () => {
    // The negative rule in `view-as.js`: reached through a team unless they
    // hold *no* team-selector role. Asking the positive question would send
    // the desk looking for a personal code captains are never issued.
    assert.equal(deskFor('Maya Captain').code, codes.teamA);
  });

  test('a staff member gets their own link', () => {
    const row = deskFor('Jo Judge');
    assert.equal(row.code, codes.judge);
    assert.equal(row.link, `https://royalty.example/s/${codes.judge}`);
  });

  test('somebody who cannot sign in at all says so rather than showing a blank', () => {
    const row = deskFor('Ollie Unassigned');
    assert.equal(row.code, null);
    assert.match(row.blocked, /no team/i);
  });

  test('everyone on the roster is listed, alphabetically', () => {
    const names = doc().desk.map((d) => d.name);
    assert.deepEqual(names, [...names].sort());
    assert.equal(names.length, 5);
  });
});

/* ------------------------------ the paper ------------------------------ */

describe('what gets printed', () => {
  test('no access code appears anywhere in the handout pack', () => {
    // A team sheet gets taped to a wall and photographed. A code in the photo
    // is a live credential for that team's whole schedule.
    const html = renderCallSheets(doc(), { desk: false });
    for (const code of Object.values(codes)) {
      assert.ok(!html.includes(code), `handout pack leaks the code ${code}`);
    }
    assert.ok(!html.includes('Check-in desk'));
  });

  test('the desk page carries them, and says not to hand it out', () => {
    const html = renderCallSheets(doc(), { sheets: false });
    assert.ok(html.includes(codes.teamA));
    assert.match(html, /Do not hand this page out/);
  });

  test('every sheet is stamped with the time it was printed', () => {
    // Undated paper is indistinguishable from live, which is the failure this
    // whole item is a mitigation for.
    const built = buildCallSheets({ at: new Date('2026-08-08T17:05:00.000Z') });
    const html = renderCallSheets(built);
    const stamps = html.match(/Printed 2026-08-08 13:05/g) ?? [];
    assert.equal(stamps.length, built.sheets.length + 1);
    assert.match(html, /the phone is right|<strong>the phone/);
  });

  test('times read like the phone does, not as 24-hour strings', () => {
    const html = renderCallSheets(doc(), { desk: false });
    assert.ok(html.includes('9 AM – 10 AM'));
    assert.ok(html.includes('6 PM – 6:30 PM'));
  });

  test('a team name that looks like markup is escaped', () => {
    const html = renderCallSheets(doc());
    assert.ok(!html.includes('<script>Beta</script>'));
    assert.ok(html.includes('&lt;script&gt;Beta&lt;/script&gt;'));
  });

  test('an unset on-call prints a blank to fill in rather than nothing', () => {
    const html = renderCallSheets(buildCallSheets({ env: {} }), { sheets: false });
    assert.match(html, /On call for the app/);
    assert.match(html, /NOT SET/);
  });

  test('a set one prints the name and the number', () => {
    const built = buildCallSheets({ env: { ON_CALL_NAME: 'Priya', ON_CALL_PHONE: '+1 555 0147' } });
    assert.deepEqual(built.onCall, { name: 'Priya', phone: '+1 555 0147', set: true });
    const html = renderCallSheets(built, { sheets: false });
    assert.ok(html.includes('Priya'));
    assert.ok(html.includes('+1 555 0147'));
  });

  test('a name with no number is not a named on-call', () => {
    assert.equal(onCall({ ON_CALL_NAME: 'Priya' }).set, false);
    assert.equal(onCall({ ON_CALL_NAME: '  ', ON_CALL_PHONE: '555' }).set, false);
  });
});

/* ------------------------------- the route ------------------------------ */

describe('the admin route', () => {
  test('needs an admin session', async () => {
    const res = await call('GET', '/api/admin/call-sheets');
    assert.equal(res.status, 401);
  });

  test('answers HTML, and the handout scope drops the desk page', async () => {
    const res = await call('GET', '/api/admin/call-sheets?scope=handout', { cookies: admin });
    assert.equal(res.status, 200);
    assert.match(res.type, /text\/html/);
    assert.ok(res.text.includes('Alpha Crew'));
    assert.ok(!res.text.includes('Check-in desk'));
    for (const code of Object.values(codes)) assert.ok(!res.text.includes(code));
  });

  test('the desk scope is the desk page alone', async () => {
    const res = await call('GET', '/api/admin/call-sheets?scope=desk', { cookies: admin });
    assert.ok(res.text.includes('Check-in desk'));
    assert.ok(!res.text.includes('Alpha warm-up'));
    assert.ok(res.text.includes(codes.teamA));
  });

  test('links use PUBLIC_BASE_URL rules, not whatever the request came in on', async () => {
    process.env.PUBLIC_BASE_URL = 'https://royalty.example';
    const res = await call('GET', '/api/admin/call-sheets?scope=desk', { cookies: admin });
    delete process.env.PUBLIC_BASE_URL;
    assert.ok(res.text.includes(codes.judge));
  });

  test('the summary reports the same coverage the pack has', async () => {
    const res = await call('GET', '/api/admin/call-sheets/summary', { cookies: admin });
    assert.equal(res.status, 200);
    assert.equal(res.body.coverage.people, 5);
    assert.equal(res.body.coverage.unplaced.length, 1);
    assert.equal(res.body.coverage.unprinted.length, 1);
    // No credentials on the JSON path either — the panel renders this one.
    assert.ok(!JSON.stringify(res.body).includes(codes.teamA));
  });
});

/* --------------------------- the deploy check --------------------------- */

describe('somebody is named as on call', () => {
  const checkFor = (env) =>
    inspectDeployConfig({ env: { NODE_ENV: 'production', ...env }, dbPath: TMP_DB }).checks.find(
      (c) => c.id === 'on-call'
    );

  test('warns rather than fails — a nameless deploy still serves every phone', () => {
    const check = checkFor({});
    assert.equal(check.level, 'warn');
    assert.equal(check.ok, false);
  });

  test('passes once both are set', () => {
    assert.equal(checkFor({ ON_CALL_NAME: 'Priya', ON_CALL_PHONE: '+1 555 0147' }).ok, true);
  });
});
