/**
 * Item 19 — the import pipeline.
 *
 *   bytes → parseTabular → normalizeScheduleRows → computeScheduleDiff → apply
 *
 * This is the path every schedule change flows through, and the one part of the
 * app whose input is a spreadsheet a human filled in under time pressure. The
 * failure mode it has to avoid is the one the rest of the project keeps
 * avoiding: not a crash, but a plausible-looking schedule that is quietly wrong
 * — a 2:30 call time read as 02:30, a block assigned to the wrong Sam, a
 * re-sync that deletes a row it should have updated.
 *
 * So the weight here is on what the pipeline *refuses* and on identity across
 * syncs, not on the happy path. Three things it is worth knowing before
 * changing any of these:
 *
 *   - `sourceKey` deliberately excludes time and location, so a block that
 *     moved is an update rather than a delete and a create. Several tests exist
 *     only to hold that.
 *   - An import owns exactly the rows carrying a `source_key`. Manual and seed
 *     blocks have none and must stay invisible to the diff, `removeMissing`
 *     included.
 *   - Ambiguity is reported, never guessed. Two people share a name in the real
 *     roster; a team and a role can collide.
 */
import { test, before, after, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';

const TMP_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'royalty-import-')), 'test.db');
process.env.DB_PATH = TMP_DB;
process.env.NODE_ENV = 'test';
process.env.EVENT_TIMEZONE = 'America/Indiana/Indianapolis';

const { db } = await import('../server/db.js');
const { parseCsv, parseTabular, pick } = await import('../server/sync/parse.js');
const {
  buildIndex,
  isCaptainCell,
  normalizeDay,
  normalizeRosterRows,
  normalizeRosterSheets,
  normalizeScheduleRows,
  normalizeTime,
  parseContactCell,
  resolveAssignment,
  rosterIdentity,
} = await import('../server/sync/normalize.js');
const { computeScheduleDiff, computeRosterDiff, applyRosterDiff } = await import(
  '../server/sync/diff.js'
);
const { ingest } = await import('../server/sync/index.js');
const { listAllBlocks } = await import('../server/lib/queries.js');

/* ------------------------------- fixture ------------------------------- */

/**
 * Shaped after the real roster rather than after the template: two people
 * genuinely share a name, a team is called the same thing as a role, and a
 * person is called the same thing as both. All three are collisions the
 * assignment column has to report rather than resolve.
 */
function seedFixture() {
  db.exec(`
    INSERT INTO roles (id,label,selector,sort_order,active) VALUES
      ('dancer','Dancer','team',1,1),
      ('judge','Judge','person',2,1),
      ('videographer','Videographer','person',3,1),
      ('captain','Captain','team',9,1);
    INSERT INTO event_days (key,label,date,sort_order) VALUES
      ('Fri','Friday','2026-08-07',1),
      ('Sat','Saturday','2026-08-08',2);
    INSERT INTO teams (id,name) VALUES
      ('t_alpha','Alpha Crew'),
      ('t_beta','Beta Crew'),
      ('t_judge','Judge');
    INSERT INTO people (id,name,team_id) VALUES
      ('p_alice','Alice Alpha','t_alpha'),
      ('p_sam_a','Sam Shared','t_alpha'),
      ('p_sam_b','Sam Shared','t_beta'),
      ('p_judge','Judge',NULL);
    INSERT INTO person_roles (person_id,role_id) VALUES
      ('p_alice','dancer'),('p_sam_a','dancer'),('p_sam_b','dancer'),('p_judge','judge');
  `);
}

/* ------------------------------- helpers ------------------------------- */

const SCHEDULE_HEADER =
  'Day,Start,End,Location,Sub-location,Activity,Assigned Team/Person,Notes,ID';

/** A CSV buffer, exactly as an upload arrives. */
const csv = (...lines) => Buffer.from(lines.join('\n'), 'utf8');
const scheduleCsv = (...rows) => csv(SCHEDULE_HEADER, ...rows);

/** Every managed block, keyed by the source key that gives it its identity. */
function managedByKey() {
  const out = new Map();
  for (const b of listAllBlocks()) if (b.sourceKey) out.set(b.sourceKey, b);
  return out;
}

function clearBlocks() {
  db.exec('DELETE FROM schedule_blocks');
}

/** Normalizes one CSV file's worth of schedule rows, parse step included. */
async function normalizeCsv(buffer) {
  const parsed = await parseTabular(buffer, 'schedule.csv');
  return normalizeScheduleRows(parsed.rows);
}

before(() => {
  seedFixture();
});

after(() => {
  db.close();
  fs.rmSync(path.dirname(TMP_DB), { recursive: true, force: true });
});

/* ====================================================================== *
 * Parsing — bytes to rows, with no idea what the columns mean
 * ====================================================================== */

describe('tabular parsing', () => {
  test('quoted fields keep their commas, newlines and doubled quotes', () => {
    const rows = parseCsv('a,b\n"x,1","say ""hi""\nagain"');
    assert.deepEqual(rows, [
      ['a', 'b'],
      ['x,1', 'say "hi"\nagain'],
    ]);
  });

  test('CRLF and a BOM survive the trip from Excel', async () => {
    const parsed = await parseTabular(
      Buffer.from('﻿Day,Activity\r\nFri,Load-in\r\n', 'utf8'),
      'x.csv'
    );
    assert.deepEqual(parsed.headers, ['Day', 'Activity']);
    assert.equal(parsed.rows.length, 1);
    assert.equal(parsed.rows[0].day, 'Fri');
  });

  test('blank rows are dropped — a spreadsheet is mostly empty space', () => {
    assert.deepEqual(parseCsv('a,b\n\n,,\nc,d\n'), [
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  test('__row is the line number in the sheet, so an error names a real row', async () => {
    const parsed = await parseTabular(csv('Day', 'Fri', 'Sat'), 'x.csv');
    // Header is row 1. An admin looking for row 3 must find the second data row.
    assert.deepEqual(
      parsed.rows.map((r) => r.__row),
      [2, 3]
    );
  });

  test('headers are matched loosely, and `pick` takes the first spelling present', async () => {
    const parsed = await parseTabular(csv('  START TIME , Sub_Location ', '09:00,Green Room'), 'x.csv');
    const row = parsed.rows[0];
    assert.equal(pick(row, ['Start', 'Start Time']), '09:00');
    assert.equal(pick(row, ['Sub-location', 'Sub location']), 'Green Room');
    assert.equal(pick(row, ['Nothing Here']), '');
  });

  test('a row keeps its raw cells, so a positional read is still possible', async () => {
    const parsed = await parseTabular(csv('Day,Activity', 'Fri,Load-in'), 'x.csv');
    assert.deepEqual(parsed.rows[0].__cells, ['Fri', 'Load-in']);
  });

  test('an empty file is reported, not treated as "delete everything"', async () => {
    const result = await ingest(csv(''), 'empty.csv', { dryRun: true });
    assert.equal(result.ok, false);
    assert.match(result.error, /No data rows/);
  });
});

describe('xlsx cells', () => {
  /** exceljs hands back objects for anything that isn't a plain scalar. */
  async function workbook(build) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Schedule');
    build(ws);
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  test('rich text, formula results and hyperlinks all flatten to their text', async () => {
    const buffer = await workbook((ws) => {
      ws.addRow(['Activity', 'Assigned Team/Person', 'Notes']);
      const row = ws.addRow([]);
      row.getCell(1).value = { richText: [{ text: 'Tech ' }, { text: 'rehearsal' }] };
      row.getCell(2).value = { formula: 'A1', result: 'Alpha Crew' };
      row.getCell(3).value = { text: 'the sheet', hyperlink: 'https://example.invalid' };
      row.commit();
    });
    const parsed = await parseTabular(buffer, 'schedule.xlsx');
    assert.deepEqual(parsed.rows[0].__cells, ['Tech rehearsal', 'Alpha Crew', 'the sheet']);
  });

  test('a time-only cell arrives as a Date and reads back as its wall clock', async () => {
    const buffer = await workbook((ws) => {
      ws.addRow(['Start']);
      ws.addRow([new Date(Date.UTC(1899, 11, 30, 14, 30))]);
    });
    const parsed = await parseTabular(buffer, 'schedule.xlsx');
    // The cell is a Date; the pipeline's job is to read 14:30 off it and not
    // to apply anybody's timezone to a value that has none.
    assert.ok(parsed.rows[0].start instanceof Date);
    assert.equal(normalizeTime(parsed.rows[0].start), '14:30');
  });

  test('a workbook the reader cannot open says what to do about it', async () => {
    // Not a workbook at all — the same failure an admin hits when they upload a
    // .xlsx another tool wrote in a part layout exceljs will not reconcile.
    await assert.rejects(() => parseTabular(Buffer.from('not a zip'), 'schedule.xlsx'), (err) => {
      assert.match(err.message, /re-save it as \.xlsx or \.csv/i);
      return true;
    });
  });
});

/* ====================================================================== *
 * Time parsing — the silent 12-hour error lives here
 * ====================================================================== */

describe('time parsing', () => {
  test('the formats the template accepts all land on the same 24-hour string', () => {
    for (const [input, expected] of [
      ['14:30', '14:30'],
      ['2:30 PM', '14:30'],
      ['2:30pm', '14:30'],
      ['2:30 p.m.', '14:30'],
      ['2:30:00 PM', '14:30'],
      ['1430', '14:30'],
      ['930', '09:30'],
      ['0930', '09:30'],
      ['9 AM', '09:00'],
      ['9AM', '09:00'],
    ]) {
      assert.equal(normalizeTime(input), expected, `${input} → ${expected}`);
    }
  });

  test('midnight and noon are the two the 12-hour clock gets wrong', () => {
    assert.equal(normalizeTime('12:00 AM'), '00:00');
    assert.equal(normalizeTime('12:15 AM'), '00:15');
    assert.equal(normalizeTime('12:00 PM'), '12:00');
    assert.equal(normalizeTime('12 PM'), '12:00');
    // Saturday's real call time last year was 03:45.
    assert.equal(normalizeTime('3:45 AM'), '03:45');
  });

  test('Excel time cells and 0–1 day fractions read the same as their text', () => {
    assert.equal(normalizeTime(new Date(Date.UTC(1899, 11, 30, 3, 45))), '03:45');
    assert.equal(normalizeTime(0.5), '12:00');
    assert.equal(normalizeTime(0.75), '18:00');
    assert.equal(normalizeTime(45000.5), '12:00'); // a full datetime serial
  });

  test('an unreadable time is null, never a guess', () => {
    for (const bad of ['', null, undefined, 'abc', '25:00', '9:99', 'noon', '2:30 xm']) {
      assert.equal(normalizeTime(bad), null, `${JSON.stringify(bad)} should not parse`);
    }
  });

  test('a meridiem-less time is taken literally, and the row is what carries context', () => {
    // The fixtures' day grids write the meridiem on the end time only, so "5:00
    // – 7:00 PM" means 17:00. `normalizeTime` sees one cell and cannot know
    // that; inheriting it is a row-level job (item 12). What matters here is
    // that this function never invents an afternoon.
    assert.equal(normalizeTime('5:00'), '05:00');
    assert.equal(normalizeTime('7:00 PM'), '19:00');
  });
});

describe('day matching', () => {
  const days = () => db.prepare('SELECT key, label FROM event_days ORDER BY sort_order').all();

  test('a day is matched by key, by label, or by an abbreviation', () => {
    for (const input of ['Fri', 'fri', 'Friday', 'FRIDAY', 'F', 'Frid']) {
      assert.equal(normalizeDay(input, days()), 'Fri', input);
    }
    assert.equal(normalizeDay('Saturday', days()), 'Sat');
  });

  test('a day the event does not have is refused', () => {
    for (const input of ['Sun', 'Thursday', '', null, 'tomorrow']) {
      assert.equal(normalizeDay(input, days()), null, JSON.stringify(input));
    }
  });
});

/* ====================================================================== *
 * Assignment resolution — who a row is for
 * ====================================================================== */

describe('assignment resolution', () => {
  let index;
  before(() => {
    index = buildIndex();
  });

  test('an unambiguous name resolves to its own kind of target', () => {
    assert.deepEqual(resolveAssignment('Alpha Crew', index), { type: 'team', id: 't_alpha' });
    assert.deepEqual(resolveAssignment('Alice Alpha', index), { type: 'person', id: 'p_alice' });
    assert.deepEqual(resolveAssignment('All Videographers', index), {
      type: 'role',
      id: 'videographer',
    });
  });

  test('spacing and case are not part of a name', () => {
    assert.deepEqual(resolveAssignment('  alpha   crew ', index), { type: 'team', id: 't_alpha' });
    assert.deepEqual(resolveAssignment('ALICE ALPHA', index), { type: 'person', id: 'p_alice' });
  });

  test('a role is reachable as "All Judges", "Judges", or its id', () => {
    for (const spelling of ['Role: All Judges', 'Role: Judges', 'Role: judge']) {
      assert.deepEqual(resolveAssignment(spelling, index), { type: 'role', id: 'judge' });
    }
  });

  test('everyone is matched first and by exact word, so a team cannot shadow it', () => {
    for (const spelling of ['Everyone', 'everyone', 'All', 'EVERYBODY']) {
      assert.deepEqual(resolveAssignment(spelling, index), { type: 'everyone', id: 'all' });
    }
    // "All Judges" is a role, not the announcement audience.
    assert.equal(resolveAssignment('All Judges', index).type, 'role');
  });

  test('two people with one name is reported, not resolved to whichever came first', () => {
    const result = resolveAssignment('Sam Shared', index);
    assert.ok(result.error, 'should not resolve');
    assert.match(result.error, /More than one person named "Sam Shared"/);
    assert.equal(result.type, undefined);
  });

  test('a prefix does not rescue an ambiguous person — the name is the problem', () => {
    const result = resolveAssignment('Person: Sam Shared', index);
    assert.match(result.error, /More than one person named/);
  });

  test('a name that is a team and a person and a role is refused with the choices', () => {
    const result = resolveAssignment('Judge', index);
    assert.ok(result.error);
    assert.match(result.error, /prefix with Team:, Person:, or Role:/);
  });

  test('and the prefix is what settles it', () => {
    assert.deepEqual(resolveAssignment('Team: Judge', index), { type: 'team', id: 't_judge' });
    assert.deepEqual(resolveAssignment('Person: Judge', index), { type: 'person', id: 'p_judge' });
    assert.deepEqual(resolveAssignment('Role: Judge', index), { type: 'role', id: 'judge' });
  });

  test('a prefix that names nothing fails as that kind, not as something else', () => {
    // "Alpha Crew" is a real team. Asked for as a person, it must not quietly
    // come back as the team.
    assert.match(resolveAssignment('Person: Alpha Crew', index).error, /No person named/);
    assert.match(resolveAssignment('Team: Nobody', index).error, /No team named/);
    assert.match(resolveAssignment('Role: Nobody', index).error, /No role named/);
  });

  test('a blank or unknown assignment is an error with the text that failed', () => {
    assert.match(resolveAssignment('', index).error, /blank/);
    assert.match(resolveAssignment('   ', index).error, /blank/);
    assert.match(
      resolveAssignment('Somebody Else', index).error,
      /"Somebody Else" is not a known team, person, or role/
    );
  });
});

/* ====================================================================== *
 * Schedule rows — validation and identity
 * ====================================================================== */

describe('schedule row validation', () => {
  test('a good row carries every field the block needs', async () => {
    const { rows, errors } = await normalizeCsv(
      scheduleCsv('Fri,2:30 PM,3:45 PM,Main Venue,Green Room B,Tech rehearsal,Alpha Crew,bring props,')
    );
    assert.deepEqual(errors, []);
    assert.equal(rows.length, 1);
    assert.deepEqual(
      { ...rows[0], sourceKey: undefined, __row: undefined },
      {
        sourceKey: undefined,
        day: 'Fri',
        startTime: '14:30',
        endTime: '15:45',
        venue: 'Main Venue',
        subLocation: 'Green Room B',
        activity: 'Tech rehearsal',
        appliesToType: 'team',
        appliesToId: 't_alpha',
        notes: 'bring props',
        __row: undefined,
      }
    );
  });

  test('every problem in a row is reported at once, against the sheet row number', async () => {
    const { rows, errors } = await normalizeCsv(
      scheduleCsv('Sun,nope,also nope,Main Venue,,,Nobody,,')
    );
    assert.equal(rows.length, 0);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].row, 2);
    // One trip through the sheet, not five.
    for (const expected of [/Day "Sun"/, /Start time "nope"/, /End time "also nope"/, /Activity is blank/, /not a known team/]) {
      assert.match(errors[0].message, expected);
    }
  });

  test('a bad row does not take the good rows down with it', async () => {
    const { rows, errors } = await normalizeCsv(
      scheduleCsv(
        'Fri,09:00,10:00,Main Venue,,Load-in,Alpha Crew,,',
        'Sun,09:00,10:00,Main Venue,,Nowhere,Alpha Crew,,',
        'Fri,11:00,12:00,Main Venue,,Warm-up,Beta Crew,,'
      )
    );
    assert.deepEqual(
      rows.map((r) => r.activity),
      ['Load-in', 'Warm-up']
    );
    assert.deepEqual(
      errors.map((e) => e.row),
      [3]
    );
  });

  test('an end before its start is refused rather than silently inverted', async () => {
    const { errors } = await normalizeCsv(
      scheduleCsv('Fri,15:00,14:00,Main Venue,,Backwards,Alpha Crew,,')
    );
    assert.match(errors[0].message, /End time 14:00 is before start time 15:00/);
  });

  test('a past-midnight row is written as two rows, one per day, not one backwards row', async () => {
    // "Friday 23:30 → Saturday 03:45" is a real call time here. The sheet says
    // it as an end-before-start pair, which the row-level check refuses — so
    // the template's answer is a Sat row, and this is what that looks like.
    const { rows, errors } = await normalizeCsv(
      scheduleCsv('Sat,23:30,03:45,Main Venue,,Overnight load-out,Alpha Crew,,')
    );
    assert.equal(rows.length, 0);
    assert.match(errors[0].message, /before start time/);
  });

  test('the source key ignores time and location, so a moved block is an update', async () => {
    const first = await normalizeCsv(
      scheduleCsv('Fri,09:00,10:00,Main Venue,,Load-in,Alpha Crew,,')
    );
    const moved = await normalizeCsv(
      scheduleCsv('Fri,09:30,10:30,Auditorium,Stage,Load-in,Alpha Crew,later,')
    );
    assert.equal(first.rows[0].sourceKey, moved.rows[0].sourceKey);
  });

  test('but the day, the target and the activity are its identity', async () => {
    const rows = (
      await normalizeCsv(
        scheduleCsv(
          'Fri,09:00,10:00,Main Venue,,Load-in,Alpha Crew,,',
          'Sat,09:00,10:00,Main Venue,,Load-in,Alpha Crew,,',
          'Fri,09:00,10:00,Main Venue,,Load-in,Beta Crew,,',
          'Fri,09:00,10:00,Main Venue,,Load-out,Alpha Crew,,'
        )
      )
    ).rows;
    assert.equal(new Set(rows.map((r) => r.sourceKey)).size, 4);
  });

  test('two identical rows get distinct keys instead of one overwriting the other', async () => {
    const { rows } = await normalizeCsv(
      scheduleCsv(
        'Fri,09:00,10:00,Main Venue,,Fitting,Alpha Crew,first,',
        'Fri,14:00,15:00,Main Venue,,Fitting,Alpha Crew,second,'
      )
    );
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0].sourceKey, rows[1].sourceKey);
    assert.match(rows[1].sourceKey, /#2$/);
  });

  test('an explicit ID column overrides the derived key', async () => {
    const { rows } = await normalizeCsv(
      scheduleCsv('Fri,09:00,10:00,Main Venue,,Load-in,Alpha Crew,,row-42')
    );
    assert.equal(rows[0].sourceKey, 'row-42');
  });

  test('an empty optional column is null rather than an empty string', async () => {
    const { rows } = await normalizeCsv(
      scheduleCsv('Fri,09:00,10:00,Main Venue,,Load-in,Alpha Crew,,')
    );
    assert.equal(rows[0].subLocation, null);
    assert.equal(rows[0].notes, null);
  });
});

/* ====================================================================== *
 * Roster rows
 * ====================================================================== */

describe('roster row validation', () => {
  const rosterRows = (...objects) => objects.map((o, i) => ({ __row: i + 2, ...o }));

  test('a role is matched by its label or its id', () => {
    const { rows, errors } = normalizeRosterRows(
      rosterRows(
        { name: 'New Dancer', role: 'Dancer', team: 'Alpha Crew' },
        { name: 'New Judge', role: 'judge' },
        { name: 'Shouty Judge', role: '  JUDGE  ' }
      )
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(
      rows.map((r) => r.roleId),
      ['dancer', 'judge', 'judge']
    );
  });

  test('a plural in the Role column is refused by name, not guessed at', () => {
    // Asymmetric with the assignment column, which does accept "All Judges" and
    // "Judges" — that one strips a trailing s from the value it is given, this
    // one strips it from the label it stores. Recorded rather than fixed here:
    // it fails loudly with the value that failed, which is the safe direction,
    // and the roster reader's messy-input handling belongs to item 12.
    const { errors } = normalizeRosterRows(rosterRows({ name: 'Second Judge', role: 'Judges' }));
    assert.match(errors[0].message, /Role "Judges" is not a known role/);
    assert.equal(resolveAssignment('Judges', buildIndex()).id, 'judge');
  });

  test('a team-selector role without a team is refused — they could never sign in', () => {
    const { rows, errors } = normalizeRosterRows(rosterRows({ name: 'Teamless', role: 'Dancer' }));
    assert.equal(rows.length, 0);
    assert.match(errors[0].message, /Dancer rows need a Team/);
    assert.equal(errors[0].row, 2);
  });

  test('an unknown role names the value that failed', () => {
    const { errors } = normalizeRosterRows(rosterRows({ name: 'Someone', role: 'Choreographer' }));
    assert.match(errors[0].message, /Role "Choreographer" is not a known role/);
  });

  test('a blank name is refused', () => {
    const { errors } = normalizeRosterRows(rosterRows({ name: '   ', role: 'Judge' }));
    assert.match(errors[0].message, /Name is blank/);
  });

  test('the Captain? column grants a second role and nothing else does', () => {
    const { rows } = normalizeRosterRows(
      rosterRows(
        { name: 'Cap One', role: 'Dancer', team: 'Alpha Crew', 'captain?': 'Y' },
        { name: 'Cap Two', role: 'Dancer', team: 'Alpha Crew', 'captain?': 'yes' },
        { name: 'Not A Cap', role: 'Dancer', team: 'Alpha Crew', 'captain?': '' },
        // The `*` on a roster name marks a food restriction. It is not a rank.
        { name: 'Marked *', role: 'Dancer', team: 'Alpha Crew', 'captain?': '*' }
      )
    );
    assert.deepEqual(rows.map((r) => r.isCaptain), [true, true, false, false]);
    assert.deepEqual(rows[0].roleIds, ['dancer', 'captain']);
    assert.deepEqual(rows[2].roleIds, ['dancer']);
  });

  test('the truthy set is closed, because inventing a captain fills a meeting', () => {
    for (const yes of ['y', 'Y', 'yes', 'YES', 'true', '1', 'x', 'captain']) {
      assert.equal(isCaptainCell(yes), true, yes);
    }
    for (const no of ['', ' ', 'n', 'no', 'false', '0', '*', '**', 'maybe', null, undefined]) {
      assert.equal(isCaptainCell(no), false, JSON.stringify(no));
    }
  });

  test('a contact cell splits into a name and a method', () => {
    assert.deepEqual(parseContactCell('Jamie Rivera / 555-0102'), {
      name: 'Jamie Rivera',
      phone: '555-0102',
      email: null,
    });
    assert.deepEqual(parseContactCell('Jamie Rivera | jamie@example.com'), {
      name: 'Jamie Rivera',
      phone: null,
      email: 'jamie@example.com',
    });
  });

  test('a bare method is the row owner’s own, so the card is titled after them', () => {
    assert.deepEqual(parseContactCell('jamie@example.com', 'Jamie Rivera'), {
      name: 'Jamie Rivera',
      phone: null,
      email: 'jamie@example.com',
    });
    assert.equal(parseContactCell('(812) 335-8000', 'Jamie Rivera').name, 'Jamie Rivera');
    assert.equal(parseContactCell('(812) 335-8000', 'Jamie Rivera').phone, '(812) 335-8000');
  });

  test('a bare name is a name, and a blank cell is no card at all', () => {
    assert.deepEqual(parseContactCell('Team Manager'), {
      name: 'Team Manager',
      phone: null,
      email: null,
    });
    assert.equal(parseContactCell(''), null);
    assert.equal(parseContactCell('   '), null);
    assert.equal(parseContactCell(null), null);
  });

  test('a person already on the roster under the same role is not a new person', () => {
    const { rows } = normalizeRosterRows(
      rosterRows({ name: 'Alice Alpha', role: 'Dancer', team: 'Alpha Crew' })
    );
    const diff = computeRosterDiff(rows);
    assert.equal(diff.createPeople.length, 0);
    assert.equal(diff.unchanged, 1);
    assert.equal(diff.hasChanges, false);
  });

  test('promoting someone to captain is an update, not a delete and a hire', () => {
    const { rows } = normalizeRosterRows(
      rosterRows({ name: 'Alice Alpha', role: 'Dancer', team: 'Alpha Crew', 'captain?': 'Y' })
    );
    const diff = computeRosterDiff(rows);
    assert.equal(diff.createPeople.length, 0);
    assert.equal(diff.updatePeople.length, 1);
    assert.match(diff.updatePeople[0].changes.join(' '), /roles dancer → captain\+dancer/);
  });

  test('a team named in a roster row is created, once, even across several rows', () => {
    const { rows } = normalizeRosterRows(
      rosterRows(
        { name: 'One', role: 'Dancer', team: 'Delta Crew' },
        { name: 'Two', role: 'Dancer', team: 'Delta Crew' }
      )
    );
    const diff = computeRosterDiff(rows);
    assert.deepEqual(diff.createTeams, [{ name: 'Delta Crew' }]);
    assert.equal(diff.createPeople.length, 2);
  });
});

/* ====================================================================== *
 * Name collisions — two rows the importer cannot tell apart
 *
 * A person is identified by name + display role, and on a ~200-dancer roster
 * that is not unique: the event director confirmed two people genuinely share
 * a name. The importer cannot resolve that and must not try, because the two
 * rows differ in exactly the fields that decide whose phone receives whose
 * access link.
 *
 * The failure this replaces was silent and only appeared on the *second*
 * import: the first created two people, and every re-sync after it wrote both
 * rows onto whichever one the lookup kept, leaving the other permanently
 * unreachable by the spreadsheet while still holding a live code.
 * ====================================================================== */

describe('roster name collisions', () => {
  const rosterRows = (...objects) => objects.map((o, i) => ({ __row: i + 2, ...o }));

  test('two rows naming the same person are both refused, not merged or picked', () => {
    const { rows, errors } = normalizeRosterRows(
      rosterRows(
        { name: 'Ashka Patel', role: 'Dancer', team: 'Alpha Crew', email: 'ashka.p@x.edu' },
        { name: 'Ashka Patel', role: 'Dancer', team: 'Alpha Crew', email: 'a.patel2@x.edu' }
      )
    );
    // Neither survives. Keeping the first would be a guess about which is real.
    assert.equal(rows.length, 0);
    assert.equal(errors.length, 2);
    assert.deepEqual(errors.map((e) => e.row), [2, 3]);
    for (const err of errors) {
      assert.match(err.message, /"Ashka Patel" appears 2 times as a Dancer/);
      assert.match(err.message, /row 2.*row 3/);
      assert.match(err.message, /distinguishable names/);
    }
  });

  test('an unrelated row in the same file is untouched by the refusal', () => {
    const { rows, errors } = normalizeRosterRows(
      rosterRows(
        { name: 'Ashka Patel', role: 'Dancer', team: 'Alpha Crew' },
        { name: 'Riya Shah', role: 'Dancer', team: 'Alpha Crew' },
        { name: 'Ashka Patel', role: 'Dancer', team: 'Alpha Crew' }
      )
    );
    assert.deepEqual(rows.map((r) => r.name), ['Riya Shah']);
    assert.deepEqual(errors.map((e) => e.row), [2, 4]);
  });

  test('one name and two roles is two people, and imports as two', () => {
    // The case the identity key exists to keep apart, from diff.js's own
    // comment: "Jordan Alvarez the dancer" vs "Jordan Alvarez the judge".
    const { rows, errors } = normalizeRosterRows(
      rosterRows(
        { name: 'Jordan Alvarez', role: 'Dancer', team: 'Alpha Crew' },
        { name: 'Jordan Alvarez', role: 'Judge' }
      )
    );
    assert.deepEqual(errors, []);
    assert.equal(rows.length, 2);
  });

  test('spacing and case are not what tells two people apart', () => {
    const { rows, errors } = normalizeRosterRows(
      rosterRows(
        { name: 'Ashka Patel', role: 'Dancer', team: 'Alpha Crew' },
        { name: '  ashka   PATEL ', role: 'Dancer', team: 'Alpha Crew' }
      )
    );
    assert.equal(rows.length, 0);
    assert.equal(errors.length, 2);
  });

  test('a food-restriction mark does not make someone a second person', () => {
    // The `*` comes off the name before anything else looks at it, so these are
    // one person entered twice — which is the other half of this refusal.
    const { rows, errors } = normalizeRosterRows(
      rosterRows(
        { name: 'Devin Osei', role: 'Dancer', team: 'Alpha Crew' },
        { name: 'Devin Osei**', role: 'Dancer', team: 'Alpha Crew' }
      )
    );
    assert.equal(rows.length, 0);
    assert.equal(errors.length, 2);
  });

  test('the same person on People and on Roster is caught across the two tabs', () => {
    // The per-sheet pass cannot see this one, and it is the likeliest duplicate
    // of all: a dancer who also holds a staff job gets typed onto both tabs.
    const { rows, errors } = normalizeRosterSheets([
      {
        sheetName: 'People',
        rows: [{ __row: 2, __sheet: 'People', 'full name': 'Ashka Patel', type: 'Dancer', team: 'Alpha Crew' }],
      },
      {
        sheetName: 'Roster',
        rows: [{ __row: 2, __sheet: 'Roster', 'first name': 'Ashka', 'last name': 'Patel', team: 'Alpha Crew' }],
      },
    ]);
    assert.equal(rows.length, 0);
    assert.equal(errors.length, 2);
    // Each error names its own tab — they both have a row 2.
    assert.deepEqual(errors.map((e) => e.sheet).sort(), ['People', 'Roster']);
    for (const err of errors) assert.match(err.message, /on People.*on Roster|on Roster.*on People/);
  });

  test('a clean two-tab upload is unaffected', () => {
    const { rows, errors } = normalizeRosterSheets([
      {
        sheetName: 'People',
        rows: [{ __row: 2, __sheet: 'People', 'full name': 'Lee Marchetti', type: 'Liaison', team: 'Alpha Crew' }],
      },
      {
        sheetName: 'Roster',
        rows: [{ __row: 2, __sheet: 'Roster', 'first name': 'Riya', 'last name': 'Shah', team: 'Alpha Crew' }],
      },
    ]);
    assert.deepEqual(errors, []);
    assert.equal(rows.length, 2);
  });

  /* ---- against people already in the database ---- */

  test('a row matching two existing people is refused rather than applied to one', () => {
    // The fixture holds two real people called "Sam Shared", both dancers —
    // the state a pre-fix import left behind, and one a hand-added roster row
    // can still reach. The sheet-level check cannot see this; the diff must.
    const { rows } = normalizeRosterRows(
      rosterRows({ name: 'Sam Shared', role: 'Dancer', team: 'Alpha Crew', email: 'sam@x.edu' })
    );
    assert.equal(rows.length, 1, 'one row is not a duplicate of itself');

    const diff = computeRosterDiff(rows);
    assert.equal(diff.createPeople.length, 0, 'must not create a third Sam');
    assert.equal(diff.updatePeople.length, 0, 'must not write onto a coin flip');
    assert.equal(diff.errors.length, 1);
    assert.equal(diff.errors[0].row, 2);
    assert.match(diff.errors[0].message, /2 people on the roster are already called "Sam Shared"/);
    assert.equal(diff.hasChanges, false);
  });

  test('an ambiguous name is not a missing one, so removeMissing leaves both alone', () => {
    // The trap: a refused row counts as *seen*. Treating it as absent would
    // turn "the importer declined to touch this" into two people deleted.
    const { rows } = normalizeRosterRows(
      rosterRows({ name: 'Sam Shared', role: 'Dancer', team: 'Alpha Crew' })
    );
    const diff = computeRosterDiff(rows, { removeMissing: true });
    const removed = diff.deletePeople.map((p) => p.label);
    assert.ok(!removed.some((l) => l.startsWith('Sam Shared')), `Sam Shared in ${removed}`);
  });

  test('a refused row contributes nothing — not its team, not its contact card', () => {
    // ⚠️ The team and contact pushes must stay *below* the refusal. Above it, a
    // row the importer declined to apply still created a team with no members
    // — which item 5's backfill then mints a live access code for — and a card
    // nothing points at, and made `hasChanges` true, which is what enables the
    // Apply button.
    const { rows } = normalizeRosterRows(
      rosterRows({
        name: 'Sam Shared',
        role: 'Dancer',
        team: 'Nova Crew',
        'contact person/method': 'Zed Quill / 555-0199',
      })
    );
    const diff = computeRosterDiff(rows);
    assert.equal(diff.errors.length, 1);
    assert.deepEqual(diff.createTeams, [], 'a refused row must not create its team');
    assert.deepEqual(diff.createContacts, [], 'nor its contact card');
    assert.equal(diff.hasChanges, false, 'nothing to apply means the Apply button stays off');
  });

  test('an all-refused file cannot drive removeMissing into pruning the roster', () => {
    // ⚠️ `hasChanges` counts deletePeople, so "nothing resolved" and "nothing to
    // do" are different questions. Asking the wrong one let a file naming only
    // ambiguous people delete everybody it did not name — with the refusal
    // reported alongside, so it read as a partial success.
    const { rows } = normalizeRosterRows(
      rosterRows({ name: 'Sam Shared', role: 'Dancer', team: 'Alpha Crew' })
    );
    const diff = computeRosterDiff(rows, { removeMissing: true });
    const resolved = diff.createPeople.length + diff.updatePeople.length + diff.unchanged;
    assert.equal(diff.errors.length, 1);
    assert.equal(resolved, 0, 'no row resolved to a person');
    assert.ok(diff.deletePeople.length > 0, 'the pruning the route must refuse to run');
    // The route's gate is `resolved`, never `hasChanges` — which is true here
    // precisely *because* of the deletions it would be authorising.
    assert.equal(diff.hasChanges, true);
  });

  test('the refusal does not spread to people whose name is unambiguous', () => {
    const { rows } = normalizeRosterRows(
      rosterRows(
        { name: 'Sam Shared', role: 'Dancer', team: 'Alpha Crew' },
        { name: 'Alice Alpha', role: 'Dancer', team: 'Alpha Crew' }
      )
    );
    const diff = computeRosterDiff(rows);
    assert.equal(diff.errors.length, 1);
    assert.equal(diff.unchanged, 1, 'Alice still resolves to herself');
  });

  test('the diff and the sheet reader agree on what one person is', () => {
    // Two definitions of identity would let through exactly the rows the check
    // exists to catch, so there is only one function and both sides call it.
    assert.equal(
      rosterIdentity({ name: '  Ashka   Patel ', roleId: 'dancer' }),
      rosterIdentity({ name: 'ashka patel', roleId: 'dancer' })
    );
    assert.notEqual(
      rosterIdentity({ name: 'Ashka Patel', roleId: 'dancer' }),
      rosterIdentity({ name: 'Ashka Patel', roleId: 'judge' })
    );
  });

  test('a re-sync cannot resurrect the bug by creating the pair first', async () => {
    // The regression, end to end and in the order it actually happened: import
    // the duplicate rows, then re-sync with one address corrected. Before the
    // refusal this created two people and then wrote both rows onto one of
    // them, leaving the other frozen at whatever the first import gave it.
    const sheet = (e1, e2) =>
      normalizeRosterRows(
        rosterRows(
          { name: 'Nia Okonkwo', role: 'Dancer', team: 'Alpha Crew', email: e1 },
          { name: 'Nia Okonkwo', role: 'Dancer', team: 'Alpha Crew', email: e2 }
        )
      ).rows;

    const first = computeRosterDiff(sheet('nia.o@x.edu', 'n.okonkwo@x.edu'));
    applyRosterDiff(first, { editedBy: 'test', source: 'import' });

    const count = () =>
      db.prepare("SELECT COUNT(*) AS n FROM people WHERE name = 'Nia Okonkwo'").get().n;
    assert.equal(count(), 0, 'the pair is never created, so the ambiguity never exists');

    const second = computeRosterDiff(sheet('nia.o@x.edu', 'nia.okonkwo@x.edu'));
    applyRosterDiff(second, { editedBy: 'test', source: 'import' });
    assert.equal(count(), 0);
  });
});

/* ====================================================================== *
 * The roster import route, for the refusal the diff alone cannot enforce
 * ====================================================================== */

describe('the roster import route refuses what the diff only reports', () => {
  let server;
  let base;
  let cookie;

  before(async () => {
    process.env.ADMIN_PASSWORD = 'test-admin-password';
    const { createApp } = await import('../server/app.js');
    server = createApp({ serveClient: false }).listen(0);
    base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${base}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'test-admin-password', name: 'Importer' }),
    });
    cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  });

  after(() => server?.close());

  /** Upload a roster CSV the way the panel does, as multipart. */
  async function upload(url, csvText, extra = {}) {
    const form = new FormData();
    form.append('file', new Blob([csvText], { type: 'text/csv' }), 'roster.csv');
    for (const [k, v] of Object.entries(extra)) form.append(k, v);
    const res = await fetch(base + url, { method: 'POST', headers: { cookie }, body: form });
    return { status: res.status, body: await res.json() };
  }

  const AMBIGUOUS = 'Name,Role,Team\nSam Shared,Dancer,Alpha Crew\n';

  test('a file whose every row was refused is not applied, even with prune on', async () => {
    // ⚠️ The regression this pins: the gate was `!diff.hasChanges`, and
    // `hasChanges` counts `deletePeople`. Under removeMissing an all-refused
    // file therefore read as "changes to apply" — and the changes were the
    // deletion of everybody the file did not name.
    const before = db.prepare('SELECT COUNT(*) AS n FROM people').get().n;

    const { status, body } = await upload('/api/admin/roster/import/preview', AMBIGUOUS, {
      removeMissing: 'true',
    });
    assert.equal(status, 200);
    assert.equal(body.validRows, 0, 'the only row was refused');
    assert.equal(body.errors.length, 1);
    assert.match(body.errors[0].message, /already called "Sam Shared"/);

    const commit = await fetch(`${base}/api/admin/roster/import/commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ token: body.token, removeMissing: true }),
    });
    assert.equal(commit.status, 400);
    assert.match((await commit.json()).error, /nothing was applied/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM people').get().n, before, 'nobody pruned');
  });

  test('the preview counts a diff-refused row as invalid, not as valid', async () => {
    const { body } = await upload(
      '/api/admin/roster/import/preview',
      `Name,Role,Team\nSam Shared,Dancer,Alpha Crew\nWholly New,Dancer,Alpha Crew\n`
    );
    assert.equal(body.parsedRows, 2);
    assert.equal(body.validRows, 1, 'the ambiguous row does not count as valid');
    assert.equal(body.errors.length, 1);
    assert.equal(body.diff.createPeople.length, 1);
  });
});

/* ====================================================================== *
 * Diff classification
 * ====================================================================== */

describe('diff classification', () => {
  const BASE = [
    'Fri,09:00,10:00,Main Venue,,Load-in,Alpha Crew,,a1',
    'Fri,11:00,12:00,Main Venue,,Warm-up,Beta Crew,,b1',
    'Sat,13:00,14:00,Main Venue,,Briefing,All Judges,,j1',
  ];

  beforeEach(async () => {
    clearBlocks();
    const result = await ingest(scheduleCsv(...BASE), 'schedule.csv', { dryRun: false });
    assert.equal(result.ok, true);
    assert.equal(managedByKey().size, 3);
  });

  test('a first import is all creates', async () => {
    clearBlocks();
    const result = await ingest(scheduleCsv(...BASE), 'schedule.csv', { dryRun: true });
    assert.equal(result.diff.create.length, 3);
    assert.equal(result.diff.update.length, 0);
    assert.equal(result.diff.delete.length, 0);
    assert.equal(result.diff.unchanged, 0);
  });

  test('re-importing the same file changes nothing — the common case during setup', async () => {
    const result = await ingest(scheduleCsv(...BASE), 'schedule.csv', { dryRun: true });
    assert.equal(result.diff.unchanged, 3);
    assert.equal(result.diff.hasChanges, false);
    assert.deepEqual(result.diff.create, []);
    assert.deepEqual(result.diff.update, []);
    assert.deepEqual(result.diff.delete, []);
  });

  test('a moved block is one update, naming both times', async () => {
    const result = await ingest(
      scheduleCsv('Fri,09:30,10:30,Main Venue,,Load-in,Alpha Crew,,a1', ...BASE.slice(1)),
      'schedule.csv',
      { dryRun: true }
    );
    assert.equal(result.diff.update.length, 1);
    assert.equal(result.diff.delete.length, 0);
    assert.deepEqual(result.diff.update[0].changes, ['time 09:00–10:00 → 09:30–10:30']);
  });

  test('each field that moved is named on its own', async () => {
    const result = await ingest(
      scheduleCsv(
        'Sat,09:30,10:30,Auditorium,Stage,Bump-in,Beta Crew,take the ramp,a1',
        ...BASE.slice(1)
      ),
      'schedule.csv',
      { dryRun: true }
    );
    const changes = result.diff.update[0].changes;
    assert.deepEqual(changes, [
      'day Fri → Sat',
      'time 09:00–10:00 → 09:30–10:30',
      'location Main Venue → Auditorium → Stage',
      'activity → "Bump-in"',
      'assigned Alpha Crew → Beta Crew',
      'notes updated',
    ]);
  });

  test('a row that vanished from the sheet is a delete', async () => {
    const result = await ingest(scheduleCsv(...BASE.slice(1)), 'schedule.csv', { dryRun: true });
    assert.equal(result.diff.delete.length, 1);
    assert.match(result.diff.delete[0].label, /Load-in · Alpha Crew/);
  });

  test('…unless removeMissing is off, which is what makes a partial sheet safe', async () => {
    const result = await ingest(scheduleCsv(...BASE.slice(1)), 'schedule.csv', {
      dryRun: true,
      removeMissing: false,
    });
    assert.deepEqual(result.diff.delete, []);
    assert.equal(result.diff.hasChanges, false);
  });

  test('renaming an activity under a stable ID is an update, not a delete and a create', async () => {
    const result = await ingest(
      scheduleCsv('Fri,09:00,10:00,Main Venue,,Load-in and set,Alpha Crew,,a1', ...BASE.slice(1)),
      'schedule.csv',
      { dryRun: true }
    );
    assert.equal(result.diff.update.length, 1);
    assert.equal(result.diff.create.length, 0);
    assert.equal(result.diff.delete.length, 0);
  });

  test('without an ID, renaming an activity is a delete and a create — the key is the name', async () => {
    clearBlocks();
    const noId = 'Fri,09:00,10:00,Main Venue,,Load-in,Alpha Crew,,';
    await ingest(scheduleCsv(noId), 'schedule.csv', { dryRun: false });
    const result = await ingest(
      scheduleCsv('Fri,09:00,10:00,Main Venue,,Load-in and set,Alpha Crew,,'),
      'schedule.csv',
      { dryRun: true }
    );
    assert.equal(result.diff.create.length, 1);
    assert.equal(result.diff.delete.length, 1);
    assert.equal(result.diff.update.length, 0);
  });

  test('blocks with no source key are invisible to the diff, deletes included', async () => {
    // Seed placeholders and anything an admin typed by hand. An import that
    // could reach these would be an import that can wipe manual work.
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO schedule_blocks
         (id,day,start_time,end_time,activity_label,applies_to_type,applies_to_id,
          source,source_key,created_at,updated_at)
       VALUES ('b_manual','Fri','20:00','21:00','Added by hand','team','t_alpha','manual',NULL,?,?)`
    ).run(now, now);

    const result = await ingest(scheduleCsv(), 'schedule.csv', { dryRun: true });
    assert.equal(result.ok, false, 'a header-only file has no rows');

    const emptying = await ingest(scheduleCsv(...BASE.slice(1)), 'schedule.csv', { dryRun: true });
    assert.equal(emptying.diff.delete.length, 1);
    assert.ok(
      !emptying.diff.delete.some((d) => /Added by hand/.test(d.label)),
      'the manual block must not be in the delete list'
    );
    assert.equal(computeScheduleDiff([]).delete.length, 3, 'only the three managed rows');
    assert.ok(db.prepare("SELECT 1 FROM schedule_blocks WHERE id = 'b_manual'").get());
  });

  test('an announcement round-trips as a block like any other', async () => {
    const result = await ingest(
      scheduleCsv(...BASE, 'Sat,08:00,08:05,Main Venue,,Fire drill,Everyone,,e1'),
      'schedule.csv',
      { dryRun: false }
    );
    assert.equal(result.ok, true);
    const block = managedByKey().get('e1');
    assert.deepEqual(block.appliesTo, { type: 'everyone', id: 'all' });
  });
});

/* ====================================================================== *
 * Applying — what lands, and who hears about it
 * ====================================================================== */

describe('applying an import', () => {
  beforeEach(() => clearBlocks());

  test('a dry run reports the change and writes nothing', async () => {
    const result = await ingest(
      scheduleCsv('Fri,09:00,10:00,Main Venue,,Load-in,Alpha Crew,,a1'),
      'schedule.csv',
      { dryRun: true }
    );
    assert.equal(result.ok, true);
    assert.equal(result.dryRun, true);
    assert.equal(result.diff.create.length, 1);
    assert.equal(managedByKey().size, 0);
    assert.equal(result.updatedAt, undefined);
  });

  test('applying writes exactly what the preview described', async () => {
    const preview = await ingest(
      scheduleCsv('Fri,2:30 PM,3:45 PM,Main Venue,Green Room B,Tech rehearsal,Alpha Crew,props,a1'),
      'schedule.csv',
      { dryRun: true }
    );
    const applied = await ingest(
      scheduleCsv('Fri,2:30 PM,3:45 PM,Main Venue,Green Room B,Tech rehearsal,Alpha Crew,props,a1'),
      'schedule.csv',
      { dryRun: false }
    );
    assert.deepEqual(
      applied.diff.create.map((c) => c.label),
      preview.diff.create.map((c) => c.label)
    );
    const block = managedByKey().get('a1');
    assert.equal(block.startTime, '14:30');
    assert.equal(block.endTime, '15:45');
    assert.equal(block.location.display, 'Main Venue → Green Room B');
    assert.equal(block.notes, 'props');
    assert.deepEqual(block.appliesTo, { type: 'team', id: 't_alpha' });
  });

  test('the targets it reports are the blocks it touched, and nobody else', async () => {
    const result = await ingest(
      scheduleCsv('Fri,09:00,10:00,Main Venue,,Load-in,Alpha Crew,,a1'),
      'schedule.csv',
      { dryRun: false }
    );
    assert.deepEqual(result.targets, [{ type: 'team', id: 't_alpha' }]);
  });

  test('a re-sync that changed nothing wakes nobody', async () => {
    const file = scheduleCsv('Fri,09:00,10:00,Main Venue,,Load-in,Alpha Crew,,a1');
    await ingest(file, 'schedule.csv', { dryRun: false });
    const again = await ingest(file, 'schedule.csv', { dryRun: false });
    assert.deepEqual(again.targets, []);
  });

  test('a reassignment wakes both sides, so it leaves the old team’s phones too', async () => {
    await ingest(scheduleCsv('Fri,09:00,10:00,Main Venue,,Load-in,Alpha Crew,,a1'), 'schedule.csv', {
      dryRun: false,
    });
    const moved = await ingest(
      scheduleCsv('Fri,09:00,10:00,Main Venue,,Load-in,Beta Crew,,a1'),
      'schedule.csv',
      { dryRun: false }
    );
    const keys = moved.targets.map((t) => `${t.type}:${t.id}`).sort();
    assert.deepEqual(keys, ['team:t_alpha', 'team:t_beta']);
  });

  test('an import is one entry in the change log, not three hundred', async () => {
    const before = db.prepare("SELECT COUNT(*) n FROM edit_log WHERE change_type = 'sync'").get().n;
    await ingest(
      scheduleCsv(
        'Fri,09:00,10:00,Main Venue,,Load-in,Alpha Crew,,a1',
        'Fri,11:00,12:00,Main Venue,,Warm-up,Beta Crew,,b1'
      ),
      'schedule.csv',
      { dryRun: false }
    );
    const rows = db
      .prepare("SELECT * FROM edit_log WHERE change_type = 'sync' ORDER BY rowid DESC")
      .all();
    assert.equal(rows.length, before + 1);
    assert.match(rows[0].change_summary, /2 added, 0 changed, 0 removed, 0 unchanged/);
  });

  test('every write in one import shares a batch id', async () => {
    const mark = db.prepare('SELECT COALESCE(MAX(rowid), 0) n FROM edit_log').get().n;
    await ingest(
      scheduleCsv(
        'Fri,09:00,10:00,Main Venue,,Load-in,Alpha Crew,,a1',
        'Fri,11:00,12:00,Main Venue,,Warm-up,Beta Crew,,b1'
      ),
      'schedule.csv',
      { dryRun: false }
    );
    // Two block creates and the summary line — one batch, which is what makes
    // undo able to refuse or revert an import as a whole rather than per row.
    const written = db.prepare('SELECT batch_id FROM edit_log WHERE rowid > ?').all(mark);
    assert.equal(written.length, 3);
    assert.equal(new Set(written.map((r) => r.batch_id)).size, 1);
    assert.ok(written[0].batch_id);
  });
});

/* ====================================================================== *
 * What the pipeline refuses
 * ====================================================================== */

describe('what an import refuses to do', () => {
  beforeEach(() => clearBlocks());

  test('a file where every row fails is refused, and the board is left alone', async () => {
    await ingest(scheduleCsv('Fri,09:00,10:00,Main Venue,,Load-in,Alpha Crew,,a1'), 'schedule.csv', {
      dryRun: false,
    });
    assert.equal(managedByKey().size, 1);

    const result = await ingest(
      scheduleCsv(
        'Sun,nope,nope,Main Venue,,Nowhere,Nobody,,x1',
        'Sun,nope,nope,Main Venue,,Nowhere else,Nobody,,x2'
      ),
      'schedule.csv',
      { dryRun: false, removeMissing: true }
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /Every row failed validation — nothing was applied/);
    assert.equal(result.errors.length, 2);
    // The point of the refusal: removeMissing would otherwise have emptied the
    // schedule because a malformed file parsed to zero rows.
    assert.equal(managedByKey().size, 1);
  });

  test('a partly bad file applies its good rows and reports the rest by row number', async () => {
    const result = await ingest(
      scheduleCsv(
        'Fri,09:00,10:00,Main Venue,,Load-in,Alpha Crew,,a1',
        'Fri,09:00,10:00,Main Venue,,Mystery,Sam Shared,,x1'
      ),
      'schedule.csv',
      { dryRun: false }
    );
    assert.equal(result.ok, true);
    assert.equal(result.validRows, 1);
    assert.equal(result.parsedRows, 2);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].row, 3);
    assert.match(result.errors[0].message, /More than one person named/);
    assert.deepEqual([...managedByKey().keys()], ['a1']);
  });

  test('a workbook that is not the template is all errors and lands nothing', async () => {
    // The realistic version of this is an admin uploading last year's task
    // sheet. Every row fails, so the refusal above is what protects the day.
    const result = await ingest(
      csv('Name,Phone,Dietary', 'Alice Alpha,555-0100,none', 'Sam Shared,555-0101,vegetarian'),
      'roster.csv',
      { dryRun: false }
    );
    assert.equal(result.ok, false);
    assert.equal(result.validRows, 0);
    assert.equal(result.errors.length, 2);
    assert.equal(managedByKey().size, 0);
  });
});
