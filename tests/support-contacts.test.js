/**
 * Support contacts — the sexual assault support contacts shown under every
 * participant's liaison.
 *
 * The failures worth pinning here are all silent ones. A support contact that
 * reaches only dancers, or only the phones that happened to sign in through a
 * team code, is wrong in a way nobody reports: the person who needed it simply
 * does not see it and says nothing. So the tests assert the list is the *same*
 * one for every kind of session, that it survives a session with no liaison at
 * all, and that a deleted card takes its designation with it rather than
 * leaving a row that renders as a blank name with no number under it.
 *
 * The order is asserted too, because the panel expresses "who to reach first"
 * as the order of the list, and an ORDER BY that quietly stops sorting is
 * indistinguishable from one that never did on two rows.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'royalty-support-')), 'test.db');
process.env.DB_PATH = TMP_DB;
process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'test-admin-password';
process.env.EVENT_TIMEZONE = 'America/Indiana/Indianapolis';

const { db } = await import('../server/db.js');
const { createApp } = await import('../server/app.js');
const { issueCode } = await import('../server/lib/access-codes.js');
const { getPersonalizedSchedule, listSupportContacts } = await import('../server/lib/queries.js');
const { buildCallSheets, renderCallSheets } = await import('../server/lib/call-sheets.js');

let server;
let base;
let admin;
const codes = {};

const START = new Date('2026-08-01T12:00:00.000Z').toISOString();

/**
 * Two support contacts, plus a liaison and a judge who is reached individually
 * and has no liaison at all — the session that would lose the section if it
 * were ever derived from the liaison rather than listed on its own.
 */
function seedFixture() {
  db.exec(`
    INSERT INTO roles (id,label,selector,sort_order,active) VALUES
      ('dancer','Dancer','team',1,1),
      ('judge','Judge','person',3,1);
    INSERT INTO event_days (key,label,date,sort_order) VALUES
      ('Sat','Saturday','2026-08-08',2);
    INSERT INTO contact_cards (id,name,title,phone,email) VALUES
      ('con_liaison','Devi Liaison','Team Liaison','555-0100','devi@example.test'),
      ('con_zara','Zara Support','Social Chair','555-0111','zara@example.test'),
      ('con_amit','Amit Support','Social Chair','555-0122',NULL),
      ('con_plain','Plain Card','Merch',NULL,NULL);
    INSERT INTO support_contacts (contact_id,sort_order) VALUES
      ('con_zara',0),('con_amit',1);
    INSERT INTO teams (id,name,liaison_contact_id) VALUES ('team_a','Alpha Crew','con_liaison');
    INSERT INTO people (id,name,team_id) VALUES
      ('p_nina','Nina Dancer','team_a'),
      ('p_judge','Jo Judge',NULL);
    INSERT INTO person_roles (person_id,role_id) VALUES
      ('p_nina','dancer'),('p_judge','judge');
    INSERT INTO schedule_blocks
      (id,day,start_time,end_time,activity_label,applies_to_type,applies_to_id,
       source,created_at,updated_at)
    VALUES
      ('b_team','Sat','09:00','10:00','Alpha warm-up','team','team_a','test','${START}','${START}'),
      ('b_judge','Sat','09:30','10:00','Judges check-in','role','judge','test','${START}','${START}');
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

const names = (list) => list.map((c) => c.name);

/** Put the fixture's two back, whatever a test left behind. */
async function restoreDefaults() {
  const res = await asAdmin('PUT', '/api/admin/support-contacts', {
    contactIds: ['con_zara', 'con_amit'],
  });
  assert.equal(res.status, 200, res.body?.error);
}

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

/* ------------------------------ the payload ------------------------------ */

describe('every session carries the same support contacts', () => {
  test('a team code, before anyone has picked a name', async () => {
    const phone = await asViewer(codes.teamA);
    assert.deepEqual(names(phone.supportContacts), ['Zara Support', 'Amit Support']);
  });

  test('a dancer who has picked her name', async () => {
    const phone = await asViewer(codes.teamA, 'p_nina');
    assert.deepEqual(names(phone.supportContacts), ['Zara Support', 'Amit Support']);
  });

  /**
   * The session with no liaison. If the section were ever hung off the contact
   * card the viewer already shows, this is the phone it would vanish from —
   * and the person holding it is the one furthest from anybody they know.
   */
  test('a judge with no liaison at all still gets them', async () => {
    const phone = await asViewer(codes.judge);
    assert.equal(phone.contact, null);
    assert.deepEqual(names(phone.supportContacts), ['Zara Support', 'Amit Support']);
  });

  test('the phone number is on the payload, because the point is to call it', async () => {
    const phone = await asViewer(codes.teamA);
    assert.deepEqual(
      phone.supportContacts.map((c) => [c.name, c.title, c.phone]),
      [
        ['Zara Support', 'Social Chair', '555-0111'],
        ['Amit Support', 'Social Chair', '555-0122'],
      ]
    );
  });

  test('the order is the designated order, not alphabetical or insertion order', async () => {
    await restoreDefaults();
    const before = names(listSupportContacts());
    const res = await asAdmin('PUT', '/api/admin/support-contacts', {
      contactIds: ['con_amit', 'con_zara'],
    });
    assert.equal(res.status, 200);
    assert.deepEqual(before, ['Zara Support', 'Amit Support']);
    assert.deepEqual(names(listSupportContacts()), ['Amit Support', 'Zara Support']);
    await restoreDefaults();
  });
});

/* ------------------------------ assignment ------------------------------ */

describe('assigning them', () => {
  test('the whole list is replaced in one write', async () => {
    const res = await asAdmin('PUT', '/api/admin/support-contacts', {
      contactIds: ['con_liaison'],
    });
    assert.equal(res.status, 200);
    assert.deepEqual(names(listSupportContacts()), ['Devi Liaison']);
    await restoreDefaults();
  });

  test('an empty list removes the section rather than erroring', async () => {
    const res = await asAdmin('PUT', '/api/admin/support-contacts', { contactIds: [] });
    assert.equal(res.status, 200);
    assert.deepEqual(listSupportContacts(), []);
    const phone = await asViewer(codes.teamA);
    assert.deepEqual(phone.supportContacts, []);
    await restoreDefaults();
  });

  /** A designation that silently did not take is a contact nobody can reach. */
  test('an unknown card is refused, and nothing is written', async () => {
    const res = await asAdmin('PUT', '/api/admin/support-contacts', {
      contactIds: ['con_zara', 'con_nobody'],
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /con_nobody/);
    assert.deepEqual(names(listSupportContacts()), ['Zara Support', 'Amit Support']);
  });

  test('the same card twice is refused', async () => {
    const res = await asAdmin('PUT', '/api/admin/support-contacts', {
      contactIds: ['con_zara', 'con_zara'],
    });
    assert.equal(res.status, 400);
    assert.deepEqual(names(listSupportContacts()), ['Zara Support', 'Amit Support']);
  });

  test('a non-array body is refused', async () => {
    const res = await asAdmin('PUT', '/api/admin/support-contacts', { contactIds: 'con_zara' });
    assert.equal(res.status, 400);
  });

  test('it is not reachable without an admin session', async () => {
    const res = await call('PUT', '/api/admin/support-contacts', {
      body: { contactIds: [] },
    });
    assert.equal(res.status, 401);
    assert.deepEqual(names(listSupportContacts()), ['Zara Support', 'Amit Support']);
  });

  test('the panel is told who currently holds it', async () => {
    const res = await asAdmin('GET', '/api/admin/roster');
    assert.deepEqual(res.body.supportContactIds, ['con_zara', 'con_amit']);
  });

  /**
   * ⚠️ The one that has to cascade. A designation pointing at a deleted card
   * would render as a support contact with no name and no number — an answer
   * that looks like an answer.
   */
  test('deleting the card takes the designation with it', async () => {
    const added = await asAdmin('POST', '/api/admin/contacts', {
      name: 'Temporary Chair',
      phone: '555-0199',
    });
    assert.equal(added.status, 200);
    await asAdmin('PUT', '/api/admin/support-contacts', {
      contactIds: ['con_zara', 'con_amit', added.body.id],
    });
    assert.equal(listSupportContacts().length, 3);

    const removed = await asAdmin('DELETE', `/api/admin/contacts/${added.body.id}`);
    assert.equal(removed.status, 200);
    assert.deepEqual(names(listSupportContacts()), ['Zara Support', 'Amit Support']);
    const phone = await asViewer(codes.teamA);
    assert.equal(phone.supportContacts.length, 2);
    assert.ok(phone.supportContacts.every((c) => c.name && c.id));
  });
});

/* -------------------------------- on paper -------------------------------- */

describe('the printed pack carries them too', () => {
  test('every handout sheet names them with a number', async () => {
    await restoreDefaults();
    const doc = buildCallSheets({ at: new Date(START), baseUrl: 'https://example.test' });
    assert.deepEqual(names(doc.supportContacts), ['Zara Support', 'Amit Support']);

    // The handout pack — the half with no access codes on it, which is the
    // half a dancer actually ends up holding.
    const handout = renderCallSheets(doc, { desk: false });
    const sections = handout.split('<section class="sheet">').slice(1);
    assert.equal(sections.length, doc.sheets.length);
    for (const section of sections) {
      assert.ok(section.includes('Sexual assault support'), 'a sheet prints without them');
      assert.ok(section.includes('Zara Support — 555-0111'));
      assert.ok(section.includes('Amit Support — 555-0122'));
    }
    for (const code of Object.values(codes)) {
      assert.ok(!handout.includes(code), 'the handout pack must never carry a code');
    }
  });

  test('the paper agrees with the phone, because it is the same list', async () => {
    const phone = getPersonalizedSchedule({ type: 'team', id: 'team_a' });
    const doc = buildCallSheets({ at: new Date(START), baseUrl: 'https://example.test' });
    assert.deepEqual(doc.supportContacts, phone.supportContacts);
  });
});
