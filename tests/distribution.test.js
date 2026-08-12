/**
 * Item 25 — who each access link gets sent to.
 *
 * The whole of this item rests on one distinction, and getting it wrong is
 * silent: a person's **own** address is not the same thing as the contact card
 * they should **call**. `people.contact_id` is shared — every dancer on a team
 * points at that team's liaison, a dozen exec board members at the Event
 * Director — so a "Send To" built from it mails a dozen private bearer tokens
 * to one inbox, and the file looks entirely correct on the way past. Item 8
 * shipped without an address column rather than risk it.
 *
 * So the weight here is on what is *not* sent, and to whom: a link addressed to
 * a shared card, a team link addressed to its dancers, a link for somebody who
 * has left. A row that cannot be sent has to stay in the file saying why —
 * dropping it makes the file look finished, and the deadline on this item is
 * "before Friday", not "before the event".
 */
import { test, before, after, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'royalty-dist-')), 'test.db');
process.env.DB_PATH = TMP_DB;
process.env.NODE_ENV = 'test';

const { db } = await import('../server/db.js');
const { distributionPlan, recipientsFor } = await import('../server/lib/distribution.js');
const { issueCode, listCodes, revokeCode } = await import('../server/lib/access-codes.js');

/* ------------------------------- fixture ------------------------------- */

/**
 * Shaped after what the roster import actually produces: dancers with their own
 * addresses and no `contact_id`, staff likewise, and contact cards that belong
 * to coordinators rather than to the people who point at them.
 */
function seedFixture() {
  db.exec(`
    INSERT INTO roles (id,label,selector,sort_order,active) VALUES
      ('dancer','Dancer','team',1,1),
      ('exec','Exec Board','person',2,1),
      ('judge','Judge','person',3,1),
      ('sponsor','Sponsor','person',4,1),
      -- No liaison row here: the item 24 migration inserts it on boot, and
      -- re-inserting it is a primary-key conflict.
      ('captain','Captain','person',9,1);
    INSERT INTO contact_cards (id,name,title,phone,email) VALUES
      ('c_director','Ada Director','Event Director','555-0100','director@shared.example'),
      ('c_liaison','Lee Liaison','Team Liaison','555-0101','liaison@shared.example');
    INSERT INTO teams (id,name,liaison_contact_id) VALUES
      ('t_unc','UNC Taar Heel Raas','c_liaison'),
      ('t_ill','Illini Raas',NULL),
      ('t_new','Brand New Crew',NULL);
    INSERT INTO people (id,name,team_id,contact_id,email,phone) VALUES
      ('p_cap1','Priya Raman','t_unc','c_liaison','priya@example.edu','812-555-0110'),
      ('p_cap2','Maya Lindqvist','t_unc','c_liaison','maya@example.edu',NULL),
      ('p_dancer','Devin Osei','t_unc','c_liaison','devin@example.edu',NULL),
      ('p_capnomail','Silent Captain','t_ill','c_liaison',NULL,NULL),
      ('p_illdancer','Illini Dancer','t_ill','c_liaison','illini@example.edu',NULL),
      ('p_judge','Jo Sandoval',NULL,'c_director','jo@example.com',NULL),
      ('p_smsonly','Ravi Boateng',NULL,'c_director',NULL,'812-555-0107'),
      ('p_nothing','Unreachable Person',NULL,'c_director',NULL,NULL);
    INSERT INTO person_roles (person_id,role_id) VALUES
      ('p_cap1','dancer'),('p_cap1','captain'),
      ('p_cap2','dancer'),('p_cap2','captain'),
      ('p_dancer','dancer'),
      ('p_capnomail','dancer'),('p_capnomail','captain'),
      ('p_illdancer','dancer'),
      ('p_judge','judge'),
      ('p_smsonly','exec'),
      ('p_nothing','exec');
  `);
}

const codeFor = (subjectType, subjectId) =>
  listCodes().find((c) => c.subjectType === subjectType && c.subjectId === subjectId);

before(() => {
  seedFixture();
  for (const id of ['t_unc', 't_ill', 't_new']) {
    issueCode({ subjectType: 'team', subjectId: id });
  }
  for (const id of ['p_judge', 'p_smsonly', 'p_nothing']) {
    issueCode({ subjectType: 'person', subjectId: id });
  }
});

after(() => {
  db.close();
  fs.rmSync(path.dirname(TMP_DB), { recursive: true, force: true });
});

const link = (c) => `https://schedule.example.org/s/${c.code}`;
const plan = () => distributionPlan(listCodes(), link);
const rowFor = (label) => plan().rows.find((r) => r.subjectLabel === label);

/* ==================================================================== *
 * The safety property
 * ==================================================================== */

describe('recipients never come from a contact card', () => {
  test('⚠️ no shared coordinator address appears anywhere in the plan', () => {
    // Every person in the fixture points at one of two shared cards. If either
    // address reaches a recipient, a dozen private links go to one inbox.
    const serialized = JSON.stringify(plan());
    for (const shared of ['director@shared.example', 'liaison@shared.example', 'Ada Director', 'Lee Liaison']) {
      assert.ok(!serialized.includes(shared), `the plan carried the shared card ${shared}`);
    }
  });

  test('a person with a contact card but no address of their own is blocked, not redirected', () => {
    // `Unreachable Person` points at the Event Director's card. The tempting
    // failure is to fall back to it — which is exactly the bug.
    const row = rowFor('Unreachable Person');
    assert.deepEqual(row.recipients, []);
    assert.match(row.blocked, /no email or phone on the roster/);
  });
});

/* ==================================================================== *
 * Routing
 * ==================================================================== */

describe('a person code goes to that person', () => {
  test('one recipient, their own address', () => {
    const row = rowFor('Jo Sandoval');
    assert.equal(row.recipients.length, 1);
    assert.equal(row.recipients[0].email, 'jo@example.com');
    assert.equal(row.blocked, null);
  });

  test('a phone with no email is still sendable, by text', () => {
    // ~80 staff links go out; some of them are a mobile number and nothing
    // else. Treating email as required would silently drop those people.
    const row = rowFor('Ravi Boateng');
    assert.equal(row.recipients.length, 1);
    assert.equal(row.recipients[0].email, null);
    assert.equal(row.recipients[0].phone, '812-555-0107');
    assert.equal(row.blocked, null);
  });
});

describe('a team code goes to its captains', () => {
  test('every reachable captain, and nobody else on the team', () => {
    const row = rowFor('UNC Taar Heel Raas');
    assert.deepEqual(row.recipients.map((r) => r.name).sort(), ['Maya Lindqvist', 'Priya Raman']);
    assert.ok(
      !row.recipients.some((r) => r.name === 'Devin Osei'),
      'an ordinary dancer must not be sent the team link to distribute'
    );
  });

  test('the reason is on the row, because a captain will ask why they got it', () => {
    assert.match(rowFor('UNC Taar Heel Raas').recipients[0].why, /captain/);
  });

  test('a team whose only captain has no address is blocked, and names them', () => {
    const row = rowFor('Illini Raas');
    assert.deepEqual(row.recipients, [], 'and not quietly sent to a dancer instead');
    assert.match(row.blocked, /Silent Captain/);
  });

  test('a team with nobody on it says that, rather than "no captain"', () => {
    // Different fix: one needs a Captain? mark, the other needs a roster.
    assert.match(rowFor('Brand New Crew').blocked, /nobody on it yet/);
  });
});

describe('a role code has no automatic recipient', () => {
  test('it is reported as a decision, not as a failure', () => {
    // A role code exposes every holder's schedule to whoever holds it, so who
    // receives it is an explicit choice — the same reason none is ever issued
    // automatically.
    issueCode({ subjectType: 'role', subjectId: 'sponsor' });
    const row = rowFor('Sponsor');
    assert.deepEqual(row.recipients, []);
    assert.match(row.blocked, /issued by hand/);
  });
});

/* ==================================================================== *
 * The file as a whole
 * ==================================================================== */

describe('the plan as a readiness list', () => {
  test('a blocked row stays in it', () => {
    // Filtering them out would make the file look finished. This list is worked
    // through at T-2 weeks precisely so the gaps are visible.
    const rows = plan().rows;
    assert.ok(rows.some((r) => r.blocked));
    assert.ok(rows.every((r) => r.link.startsWith('https://schedule.example.org/s/')));
  });

  test('the summary separates links from recipients', () => {
    // One team link addressed to two captains is one link and two sends, and
    // "how many emails am I about to fire" is the number that matters.
    const { summary } = plan();
    assert.ok(summary.recipients > summary.sendable);
    assert.equal(summary.total, summary.sendable + summary.blocked);
  });

  test('a revoked code is not in the plan at all', () => {
    const code = codeFor('person', 'p_judge').code;
    revokeCode(code, { editedBy: 'test', source: 'test' });
    assert.equal(rowFor('Jo Sandoval'), undefined);
    // Put it back for anything that runs after this.
    issueCode({ subjectType: 'person', subjectId: 'p_judge' });
  });

  test('recipientsFor refuses a revoked code directly, too', () => {
    assert.match(recipientsFor({ subjectType: 'person', subjectId: 'p_judge', revokedAt: 'now' }).blocked, /revoked/);
  });

  test('a code pointing at someone who has left says so', () => {
    const { blocked, recipients } = recipientsFor({ subjectType: 'person', subjectId: 'p_gone' });
    assert.deepEqual(recipients, []);
    assert.match(blocked, /no longer on the roster/);
  });
});
