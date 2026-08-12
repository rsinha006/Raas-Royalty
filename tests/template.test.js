/**
 * Item 24 — reading the event's own workbook.
 *
 * Items 12 and 19 built the pipeline against a *shape*: nine columns, one
 * sheet, a CSV. The workbook logistics actually fills in has sixteen tabs, puts
 * the schedule on the last-but-two, splits a dancer's name across two columns,
 * and names each person's position in its own vocabulary rather than ours. None
 * of that was wrong to defer — but until it is read correctly, item 24 is not a
 * data task, because there is no way to get the data in.
 *
 * Two kinds of test live here, and they fail for different reasons on purpose:
 *
 *   - Against the shipped `templates/royalty-schedule-template.xlsx`. These
 *     fail when *the workbook* changes — a renamed tab, a reordered or retitled
 *     column. That is the point: the template is still being iterated, and the
 *     day it stops matching the reader should be a red build rather than a
 *     discovery at the dress rehearsal.
 *   - Against workbooks built here. These fail when *the reader* changes, and
 *     carry the values the template only has examples of.
 */
import { test, before, after, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import Database from 'better-sqlite3';

const TMP_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'royalty-template-')), 'test.db');
process.env.DB_PATH = TMP_DB;
process.env.NODE_ENV = 'test';
process.env.EVENT_TIMEZONE = 'America/Indiana/Indianapolis';

const { db } = await import('../server/db.js');
const { parseNamedSheets, parseTabular } = await import('../server/sync/parse.js');
const {
  ROSTER_SHEETS,
  SCHEDULE_SHEETS,
  SCHEDULE_TEMPLATE,
  normalizeName,
  normalizePhone,
  normalizeRosterRows,
  normalizeRosterSheets,
  normalizeScheduleRows,
} = await import('../server/sync/normalize.js');
const { ingest } = await import('../server/sync/index.js');
const { planEventDates } = await import('../server/lib/event-days.js');
const { ensureWeekendDays } = await import('../server/migrate.js');
const { listAllBlocks } = await import('../server/lib/queries.js');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = path.join(ROOT, 'templates', 'royalty-schedule-template.xlsx');

/* ------------------------------- fixture ------------------------------- */

/**
 * `liaison` and `ras-rep` are deliberately absent: `ensureEventRoles` runs from
 * the migrations at `db.js` import, so if they are not here the migration is
 * what put them there — which is the claim being tested by the People tab
 * cases below.
 */
function seedFixture() {
  db.exec(`
    INSERT INTO roles (id,label,selector,sort_order,active) VALUES
      ('dancer','Dancer','team',1,1),
      ('exec','Exec Board','person',2,1),
      ('judge','Judge','person',3,1),
      ('videographer','Videographer','person',4,1),
      ('captain','Captain','person',9,1);
    INSERT INTO event_days (key,label,date,sort_order) VALUES
      ('Thu','Thursday','2026-08-06',1),
      ('Fri','Friday','2026-08-07',2),
      ('Sat','Saturday','2026-08-08',3),
      ('Sun','Sunday','2026-08-09',4);
    INSERT INTO teams (id,name) VALUES ('t_unc','UNC Taar Heel Raas');
    INSERT INTO people (id,name,team_id) VALUES ('p_dir','Ada Director',NULL);
    INSERT INTO person_roles (person_id,role_id) VALUES ('p_dir','exec');
  `);
}

before(seedFixture);
after(() => {
  db.close();
  fs.rmSync(path.dirname(TMP_DB), { recursive: true, force: true });
});

/* ------------------------------- helpers ------------------------------- */

/** `{ 'Sheet Name': [[headerCells], [rowCells], …] }` → an .xlsx buffer. */
async function workbook(sheets) {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name);
    for (const row of rows) ws.addRow(row);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const SCHEDULE_HEADER = SCHEDULE_TEMPLATE.columns.map((c) => c.name);
const PEOPLE_HEADER = ['ID', 'Full Name', 'Group', 'Team', 'Phone', 'Email', 'Type', 'Key (auto)'];
const ROSTER_HEADER = [
  'First Name',
  'Last Name',
  'Team',
  'Phone',
  'Email',
  'Captain?',
  'Dietary Restrictions',
  'T-Shirt Size',
];

/** The tab the app reads, wrapped in the tabs it must not read. */
const templateShaped = (exportRows, extra = {}) =>
  workbook({
    Instructions: [['How to use this schedule file'], ['Read this page once before you type.']],
    People: [PEOPLE_HEADER],
    Roster: [ROSTER_HEADER],
    Saturday: [['CALL', '7:15 AM', '', '', '']],
    Export: [SCHEDULE_HEADER, ...exportRows],
    ...extra,
  });

const clearBlocks = () => db.exec('DELETE FROM schedule_blocks');
const managedCount = () => listAllBlocks().filter((b) => b.sourceKey).length;

/* ==================================================================== *
 * The workbook as it ships
 * ==================================================================== */

describe('templates/royalty-schedule-template.xlsx, as committed', () => {
  let buffer;
  let names;

  before(async () => {
    buffer = fs.readFileSync(TEMPLATE);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    names = wb.worksheets.map((ws) => ws.name);
  });

  test('it is readable by the same reader an upload goes through', async () => {
    // The anonymizer once produced workbooks Excel opened and this reader could
    // not (item 19). The template comes from a generator too, so it gets the
    // same guard.
    const parsed = await parseTabular(buffer, 'template.xlsx', { prefer: SCHEDULE_SHEETS });
    assert.ok(parsed.headers.length > 0);
  });

  test('every tab the importer names is present', () => {
    for (const want of [...SCHEDULE_SHEETS, ...ROSTER_SHEETS]) {
      assert.ok(names.includes(want), `the workbook has no "${want}" tab — tabs are ${names}`);
    }
  });

  test('⚠️ the schedule tab is not the first one, which is why `prefer` exists', async () => {
    // Reading `worksheets[0]` gives 158 rows of prose off the Instructions tab.
    // If this ever starts failing because Export moved to the front, the fix is
    // to delete this test — not to go back to reading the first sheet, which is
    // wrong for every other workbook the app is handed.
    assert.notEqual(names[0], 'Export');
    const first = await parseTabular(buffer, 'template.xlsx');
    const chosen = await parseTabular(buffer, 'template.xlsx', { prefer: SCHEDULE_SHEETS });
    assert.equal(first.sheetName, names[0]);
    assert.equal(chosen.sheetName, 'Export');
  });

  test('the Export tab carries exactly the nine columns the reader maps', async () => {
    const parsed = await parseTabular(buffer, 'template.xlsx', { prefer: SCHEDULE_SHEETS });
    assert.deepEqual(parsed.headers, SCHEDULE_HEADER);
  });

  test('the People and Roster tabs carry the columns the roster reader needs', async () => {
    const [people, roster] = await parseNamedSheets(buffer, 'template.xlsx', ROSTER_SHEETS);
    assert.equal(people.sheetName, 'People');
    assert.equal(roster.sheetName, 'Roster');
    for (const col of ['Full Name', 'Team', 'Phone', 'Email', 'Type']) {
      assert.ok(people.headers.includes(col), `People has no "${col}" column`);
    }
    for (const col of ['First Name', 'Last Name', 'Team', 'Captain?']) {
      assert.ok(roster.headers.includes(col), `Roster has no "${col}" column`);
    }
  });

  test('⚠️ it ships with no calculated values, so uploading the file itself is refused', async () => {
    // The workbook is written by a generator, which stores formulas and no
    // results. Google Sheets computes them; this file has never been opened by
    // anything that does. So the Export tab reads as its own footnotes and
    // nothing else — and the one outcome that must never follow is applying it.
    const before = managedCount();
    const result = await ingest(buffer, 'template.xlsx', { dryRun: false, removeMissing: true });
    assert.equal(result.ok, false);
    assert.match(result.error, /No importable rows on the Export tab/);
    assert.equal(managedCount(), before, 'the schedule moved');
  });
});

/* ==================================================================== *
 * Choosing a sheet
 * ==================================================================== */

describe('choosing which sheet to read', () => {
  test('the schedule comes off Export, not off the first tab', async () => {
    const buffer = await templateShaped([
      ['Saturday', '7:15 AM', '7:20 AM', 'Courtyard Marriott', 'Lobby', 'Report to Lobby', 'Team: UNC Taar Heel Raas', '', 'PRAC-S1-01'],
    ]);
    const parsed = await parseTabular(buffer, 'w.xlsx', { prefer: SCHEDULE_SHEETS });
    assert.equal(parsed.sheetName, 'Export');
    assert.equal(parsed.rows.length, 1);
  });

  test('a one-tab export still reads, because the first sheet is the fallback', async () => {
    const buffer = await workbook({ 'Sheet1': [SCHEDULE_HEADER, ['Fri', '09:00', '09:30', 'X', '', 'Load-in', 'Team: UNC Taar Heel Raas', '', '']] });
    const parsed = await parseTabular(buffer, 'w.xlsx', { prefer: SCHEDULE_SHEETS });
    assert.equal(parsed.sheetName, 'Sheet1');
    assert.equal(parsed.rows.length, 1);
  });

  test('a CSV has no sheets and is unaffected', async () => {
    const csv = Buffer.from(`${SCHEDULE_HEADER.join(',')}\nFri,09:00,09:30,X,,Load-in,Team: UNC Taar Heel Raas,,\n`);
    const parsed = await parseTabular(csv, 'export.csv', { prefer: SCHEDULE_SHEETS });
    assert.equal(parsed.sheetName, null);
    assert.equal(parsed.rows.length, 1);
  });

  test('a renamed tab is matched case- and space-insensitively', async () => {
    const buffer = await workbook({ A: [['x']], ' export ': [SCHEDULE_HEADER] });
    const parsed = await parseTabular(buffer, 'w.xlsx', { prefer: SCHEDULE_SHEETS });
    assert.equal(parsed.sheetName.trim(), 'export');
  });

  test('both roster tabs come back, staff first', async () => {
    const buffer = await templateShaped([]);
    const sheets = await parseNamedSheets(buffer, 'w.xlsx', ROSTER_SHEETS);
    assert.deepEqual(sheets.map((s) => s.sheetName), ['People', 'Roster']);
  });

  test('a workbook with neither tab comes back empty rather than as its first sheet', async () => {
    // The route turns this into "that is not this workbook", which is a
    // different sentence from "every row failed" and points somewhere else.
    const buffer = await workbook({ 'UCLA': [['Name']], 'Purdue': [['Name']] });
    assert.deepEqual(await parseNamedSheets(buffer, 'w.xlsx', ROSTER_SHEETS), []);
  });
});

/* ==================================================================== *
 * The two roster tabs
 * ==================================================================== */

describe('the People tab', () => {
  const peopleRows = async (...rows) => {
    const buffer = await workbook({ People: [PEOPLE_HEADER, ...rows] });
    const [sheet] = await parseNamedSheets(buffer, 'w.xlsx', ROSTER_SHEETS);
    return normalizeRosterSheets([sheet]);
  };

  test('Type is read as the role, in the event\'s vocabulary', async () => {
    const { rows, errors } = await peopleRows(
      ['BRD-01', 'Ada Director', 'Directors', '', '555-0100', 'a@x.edu', 'board', ''],
      ['JDG-01', 'Jo Judge', 'Judging', '', '555-0104', 'j@x.com', 'judge', '']
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(rows.map((r) => r.roleId), ['exec', 'judge']);
  });

  test('liaison and RAS rep resolve, because the migration adds those roles', async () => {
    // The seed's role list has neither, and most of last year's master schedule
    // is liaisons. Without `ensureEventRoles` every one of those rows fails on
    // `Role "liaison" is not a known role`, at the moment the roster lands.
    const { rows, errors } = await peopleRows(
      ['LIA-01', 'Lee Liaison', 'Liaisons', 'UNC Taar Heel Raas', '555-0101', 'l@x.edu', 'liaison', ''],
      ['RAS-01', 'Ray Rep', 'RAS', '', '555-0107', 'r@x.com', 'RAS Rep', '']
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(rows.map((r) => r.roleId), ['liaison', 'ras-rep']);
  });

  test('a row with no Type is an error, never a guess', async () => {
    // People is the tab where a blank means unfinished. Roster is the tab where
    // a blank means dancer, and only because the tab says so.
    const { rows, errors } = await peopleRows(
      ['BRD-02', 'Unfinished Person', 'Directors', '', '', '', '', '']
    );
    assert.equal(rows.length, 0);
    assert.match(errors[0].message, /Role is blank/);
    assert.equal(errors[0].sheet, 'People');
  });

  test('the contact card is built from the Phone and Email columns', async () => {
    const { rows } = await peopleRows(
      ['BRD-01', 'Ada Director', 'Directors', '', '(925)-430-8287', 'ada@x.edu', 'board', '']
    );
    assert.deepEqual(rows[0].contact, {
      name: 'Ada Director',
      phone: '925-430-8287',
      email: 'ada@x.edu',
    });
  });

  test('a row with neither gets no card rather than an empty one', async () => {
    const { rows } = await peopleRows(['BRD-01', 'Ada Director', 'Directors', '', '', '', 'board', '']);
    assert.equal(rows[0].contact, null);
  });
});

describe('the Roster tab', () => {
  const rosterRows = async (...rows) => {
    const buffer = await workbook({ Roster: [ROSTER_HEADER, ...rows] });
    const [sheet] = await parseNamedSheets(buffer, 'w.xlsx', ROSTER_SHEETS);
    return normalizeRosterSheets([sheet]);
  };

  test('First Name and Last Name become one name, and the row is a dancer', async () => {
    const { rows, errors } = await rosterRows(
      ['Priya', 'Raman', 'UNC Taar Heel Raas', '555-0110', 'p@x.edu', 'No', 'Vegetarian', 'M']
    );
    assert.deepEqual(errors, []);
    assert.equal(rows[0].name, 'Priya Raman');
    assert.equal(rows[0].roleId, 'dancer');
    assert.equal(rows[0].teamName, 'UNC Taar Heel Raas');
  });

  test('Captain? adds the Captain role on top of Dancer', async () => {
    const { rows } = await rosterRows(
      ['Sam', 'Okafor', 'UNC Taar Heel Raas', '', '', 'Yes', '', 'L']
    );
    assert.deepEqual(rows[0].roleIds.sort(), ['captain', 'dancer']);
    assert.equal(rows[0].isCaptain, true);
  });

  test('⚠️ the food-restriction mark comes off the name and grants nothing', async () => {
    // `*` on last year's roster marks a dietary restriction. Reading it as a
    // captain would put a dancer in the captains' meeting; leaving it on splits
    // one person into two on the next import.
    const { rows } = await rosterRows(['Devin', 'Osei**', 'UNC Taar Heel Raas', '', '', '', 'Nut allergy', 'S']);
    assert.equal(rows[0].name, 'Devin Osei');
    assert.equal(rows[0].isCaptain, false);
  });

  test('a dancer with no team is refused, because a team code is how they sign in', async () => {
    const { rows, errors } = await rosterRows(['Teamless', 'Dancer', '', '', '', '', '', '']);
    assert.equal(rows.length, 0);
    assert.match(errors[0].message, /need a Team/);
    assert.equal(errors[0].sheet, 'Roster');
  });

  test('the default role is the sheet\'s, not the reader\'s', async () => {
    // Same columns, a tab not called Roster: no default, so it refuses. The
    // default belongs to "this tab is the dancer list", which only the tab name
    // says.
    const buffer = await workbook({ People: [ROSTER_HEADER, ['Priya', 'Raman', 'UNC Taar Heel Raas', '', '', '', '', '']] });
    const sheets = await parseNamedSheets(buffer, 'w.xlsx', ROSTER_SHEETS);
    const { rows, errors } = normalizeRosterSheets(sheets);
    assert.equal(rows.length, 0);
    assert.match(errors[0].message, /Role is blank/);
  });
});

describe('both tabs at once', () => {
  test('one upload carries the staff and the dancers', async () => {
    const buffer = await workbook({
      Instructions: [['prose']],
      People: [PEOPLE_HEADER, ['BRD-01', 'Ada Director', 'Directors', '', '555-0100', 'a@x.edu', 'board', '']],
      Roster: [ROSTER_HEADER, ['Priya', 'Raman', 'UNC Taar Heel Raas', '', '', 'Y', '', '']],
    });
    const sheets = await parseNamedSheets(buffer, 'w.xlsx', ROSTER_SHEETS);
    const { rows, errors } = normalizeRosterSheets(sheets);
    assert.deepEqual(errors, []);
    assert.deepEqual(
      rows.map((r) => [r.name, r.roleId, r.__sheet]),
      [
        ['Ada Director', 'exec', 'People'],
        ['Priya Raman', 'dancer', 'Roster'],
      ]
    );
  });

  test('an error names the tab it came off, since both have a row 2', async () => {
    const buffer = await workbook({
      People: [PEOPLE_HEADER, ['BRD-01', 'No Type', 'Directors', '', '', '', '', '']],
      Roster: [ROSTER_HEADER, ['No', 'Team', '', '', '', '', '', '']],
    });
    const sheets = await parseNamedSheets(buffer, 'w.xlsx', ROSTER_SHEETS);
    const { errors } = normalizeRosterSheets(sheets);
    assert.deepEqual(errors.map((e) => [e.sheet, e.row]), [['People', 2], ['Roster', 2]]);
  });
});

/* ==================================================================== *
 * Messy input
 * ==================================================================== */

describe('names and phone numbers as they are actually pasted in', () => {
  test('the five phone spellings in the samples land on one form', () => {
    assert.equal(normalizePhone('(925) 430-8287'), '925-430-8287');
    assert.equal(normalizePhone('(925)-430-8287'), '925-430-8287');
    assert.equal(normalizePhone('925.430.8287'), '925-430-8287');
    assert.equal(normalizePhone('9254308287'), '925-430-8287');
    assert.equal(normalizePhone('+1 (925) 430-8287'), '+1-925-430-8287');
  });

  test('anything that is not a whole number is handed back rather than mangled', () => {
    // An extension, a second number, or a note. Cleaned, never reformatted —
    // a `tel:` link to a truncated number is worse than one to a messy string.
    assert.equal(normalizePhone('555-0100 x2'), '555-0100 x2');
    assert.equal(normalizePhone('ask Ada'), 'ask Ada');
    assert.equal(normalizePhone('   '), null);
  });

  test('⚠️ invisible characters are stripped, or one person imports as two', () => {
    // A zero-width space or a direction mark survives a copy-paste out of a
    // browser and is invisible in every spreadsheet. Two names that differ only
    // by one are two different people to every lookup in this app.
    assert.equal(normalizeName('Priya​Raman'), 'PriyaRaman');
    assert.equal(normalizeName('‪Priya Raman‬'), 'Priya Raman');
    assert.equal(normalizeName('Priya Raman'), 'Priya Raman');
    assert.equal(normalizeName('  Priya   Raman  '), 'Priya Raman');
  });

  test('the mark comes off the end of a name and nowhere else', () => {
    assert.equal(normalizeName('Devin Osei*'), 'Devin Osei');
    assert.equal(normalizeName('Devin Osei **'), 'Devin Osei');
    assert.equal(normalizeName('D*Angelo Reyes'), 'D*Angelo Reyes');
  });
});

/* ==================================================================== *
 * What the Export tab's own footnotes must not do
 * ==================================================================== */

describe('note rows on the Export tab', () => {
  beforeEach(clearBlocks);

  test('a one-cell row is a note, not three errors', async () => {
    const buffer = await templateShaped([
      ['Saturday', '7:15 AM', '7:20 AM', 'Courtyard Marriott', 'Lobby', 'Report to Lobby', 'Team: UNC Taar Heel Raas', '', 'PRAC-S1-01'],
      ['THIS IS THE TAB THE APP READS. Publish only this one.'],
      ['Blank rows are spare capacity and are ignored on import.'],
    ]);
    const result = await ingest(buffer, 'w.xlsx', { dryRun: true });
    assert.equal(result.validRows, 1);
    assert.equal(result.noteRows, 2);
    assert.deepEqual(result.errors, []);
  });

  test('a row that is short but real still reports what is wrong with it', async () => {
    // The rule is one non-empty cell, not "fewer than nine". A half-filled row
    // is a mistake someone made and has to hear about.
    const { errors, notes } = normalizeScheduleRows([
      { __row: 2, __cells: ['Saturday', '7:15 AM'] },
    ]);
    assert.equal(notes, 0);
    assert.equal(errors.length, 1);
  });

  test('⚠️ a file of nothing but notes is refused, not applied as an empty schedule', async () => {
    // Zero valid rows and zero errors. `removeMissing` reads that as "every
    // managed block is missing", and before item 24 the guard only covered the
    // case where rows had *failed* — so this file deleted the schedule and
    // reported success.
    const seeded = await ingest(
      await templateShaped([
        ['Saturday', '7:15 AM', '7:20 AM', 'Courtyard Marriott', 'Lobby', 'Report to Lobby', 'Team: UNC Taar Heel Raas', '', 'PRAC-S1-01'],
      ]),
      'good.xlsx',
      { dryRun: false, removeMissing: true }
    );
    assert.equal(seeded.ok, true);
    assert.equal(managedCount(), 1);

    const result = await ingest(await templateShaped([['A note and nothing else.']]), 'notes.xlsx', {
      dryRun: false,
      removeMissing: true,
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /No importable rows/);
    assert.equal(managedCount(), 1, 'the schedule was emptied');
  });

  test('the preview says so too, so Apply is never the thing that finds out', async () => {
    const result = await ingest(await templateShaped([['A note and nothing else.']]), 'notes.xlsx', {
      dryRun: true,
    });
    assert.match(result.refusal, /No importable rows/);
  });
});

/* ==================================================================== *
 * The four days
 * ==================================================================== */

describe('the four event days', () => {
  beforeEach(clearBlocks);

  test('Thursday and Sunday import, which is where the airport runs are', async () => {
    // Teams land on Thursday and fly out on Sunday, and both are person-
    // targeted blocks someone reads at an airport. A day with no `event_days`
    // row is refused per row, so a two-day event silently drops all of them.
    const buffer = await templateShaped([
      ['Thursday', '9:10 AM', '10:10 AM', 'Indianapolis Intl', '', 'Airport pickup', 'Team: UNC Taar Heel Raas', 'AA4352', 'AIR-001'],
      ['Sunday', '11:00 AM', '12:00 PM', 'Courtyard Marriott', 'Lobby', 'Checkout', 'Team: UNC Taar Heel Raas', '', 'MAN-200'],
    ]);
    const result = await ingest(buffer, 'w.xlsx', { dryRun: false, removeMissing: true });
    assert.equal(result.ok, true);
    assert.deepEqual(
      listAllBlocks().filter((b) => b.sourceKey).map((b) => b.day).sort(),
      ['Sun', 'Thu']
    );
  });
});

/* ==================================================================== *
 * Pinning the dates
 * ==================================================================== */

describe('re-dating the weekend', () => {
  const DAYS = [
    { key: 'Thu', label: 'Thursday', date: '2026-08-06', sort_order: 1 },
    { key: 'Fri', label: 'Friday', date: '2026-08-07', sort_order: 2 },
    { key: 'Sat', label: 'Saturday', date: '2026-08-08', sort_order: 3 },
    { key: 'Sun', label: 'Sunday', date: '2026-08-09', sort_order: 4 },
  ];

  test('one date moves all four, keeping them contiguous', () => {
    const { plan } = planEventDates(DAYS, 'friday', '2027-02-12');
    assert.deepEqual(
      plan.map((d) => [d.key, d.next]),
      [['Thu', '2027-02-11'], ['Fri', '2027-02-12'], ['Sat', '2027-02-13'], ['Sun', '2027-02-14']]
    );
  });

  test('anchoring on any other day gives the same weekend', () => {
    const fromFri = planEventDates(DAYS, 'fri', '2027-02-12').plan.map((d) => d.next);
    const fromSun = planEventDates(DAYS, 'sun', '2027-02-14').plan.map((d) => d.next);
    assert.deepEqual(fromFri, fromSun);
  });

  test('it crosses a month and a year boundary', () => {
    const { plan } = planEventDates(DAYS, 'sat', '2027-01-02');
    assert.deepEqual(plan.map((d) => d.next), [
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
      '2027-01-03',
    ]);
  });

  test('⚠️ a date that is not the day it was given as is refused', () => {
    // The whole weekend derives from this one date, so a day out under the
    // wrong flag moves everything — and every screen in the app still looks
    // right afterwards. It is exactly the class of silent wrongness item 9
    // exists to prevent, arriving through the setup step instead.
    const { error, plan } = planEventDates(DAYS, 'friday', '2027-02-13');
    assert.equal(plan, undefined);
    assert.match(error, /is a Saturday, but you gave it as Friday/);
  });

  test('a date that does not exist is refused rather than rolled over', () => {
    // `new Date('2027-02-30')` is March 2nd and says nothing about it.
    assert.match(planEventDates(DAYS, 'fri', '2027-02-30').error, /not a real date/);
    assert.match(planEventDates(DAYS, 'fri', '12/02/2027').error, /not a real date/);
    assert.match(planEventDates(DAYS, 'fri', '').error, /not a real date/);
  });

  test('a day this event does not have is refused, and says which it has', () => {
    const { error } = planEventDates(DAYS, 'monday', '2027-02-15');
    assert.match(error, /not one of this event's days \(Thu, Fri, Sat, Sun\)/);
  });

  test('setting the dates it already has moves nothing', () => {
    const { moving } = planEventDates(DAYS, 'fri', '2026-08-07');
    assert.deepEqual(moving, []);
  });

  test('a two-day event re-dates as a two-day event', () => {
    // The dev database predates the four-day seed. Re-dating must not invent
    // the days it is missing.
    const two = DAYS.slice(1, 3);
    const { plan } = planEventDates(two, 'fri', '2027-02-12');
    assert.deepEqual(plan.map((d) => [d.key, d.next]), [['Fri', '2027-02-12'], ['Sat', '2027-02-13']]);
  });
});

describe('adding the two days a pre-item-24 database is missing', () => {
  /** A standalone database, so the migration runs against a two-day event. */
  const withDays = (rows) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'royalty-days-'));
    const d = new Database(path.join(dir, 'x.db'));
    d.exec(
      'CREATE TABLE event_days (key TEXT PRIMARY KEY, label TEXT NOT NULL, date TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0)'
    );
    const ins = d.prepare('INSERT INTO event_days VALUES (?,?,?,?)');
    for (const r of rows) ins.run(...r);
    return { d, dir };
  };
  const read = (d) =>
    d.prepare('SELECT key, date FROM event_days ORDER BY sort_order').all().map((r) => [r.key, r.date]);

  test('Thursday and Sunday are derived from the Friday and Saturday already there', () => {
    const { d } = withDays([
      ['Fri', 'Friday', '2026-08-07', 1],
      ['Sat', 'Saturday', '2026-08-08', 2],
    ]);
    assert.equal(ensureWeekendDays(d), true);
    assert.deepEqual(read(d), [
      ['Thu', '2026-08-06'],
      ['Fri', '2026-08-07'],
      ['Sat', '2026-08-08'],
      ['Sun', '2026-08-09'],
    ]);
    d.close();
  });

  test('it is idempotent, because it runs on every boot', () => {
    const { d } = withDays([
      ['Fri', 'Friday', '2026-08-07', 1],
      ['Sat', 'Saturday', '2026-08-08', 2],
    ]);
    ensureWeekendDays(d);
    assert.equal(ensureWeekendDays(d), false);
    assert.equal(read(d).length, 4);
    d.close();
  });

  test('⚠️ a weekend that is not contiguous is left alone rather than guessed at', () => {
    // Deriving Thursday from a Friday that is not the day before Saturday would
    // put arrivals on a date nobody chose — and it would look like a schedule.
    const { d } = withDays([
      ['Fri', 'Friday', '2026-08-07', 1],
      ['Sat', 'Saturday', '2026-09-12', 2],
    ]);
    assert.equal(ensureWeekendDays(d), false);
    assert.equal(read(d).length, 2);
    d.close();
  });

  test('an empty database is the seed’s business, not the migration’s', () => {
    const { d } = withDays([]);
    assert.equal(ensureWeekendDays(d), false);
    d.close();
  });

  test('it crosses a month boundary in both directions', () => {
    const { d } = withDays([
      ['Fri', 'Friday', '2027-01-01', 1],
      ['Sat', 'Saturday', '2027-01-02', 2],
    ]);
    ensureWeekendDays(d);
    assert.deepEqual(read(d), [
      ['Thu', '2026-12-31'],
      ['Fri', '2027-01-01'],
      ['Sat', '2027-01-02'],
      ['Sun', '2027-01-03'],
    ]);
    d.close();
  });
});
