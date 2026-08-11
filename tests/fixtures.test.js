/**
 * Item 19 — the pipeline against the real spreadsheets.
 *
 * `fixtures/` holds anonymized copies of what logistics actually produced last
 * year: a merged Gantt wall chart, eight team rosters with the team name only
 * in the sheet tab, five phone formats, and a `Conflict` typed into a cell
 * where two commitments collided. None of them is the template the importer
 * reads — that is item 12's input and does not exist yet — so this file is not
 * about importing them successfully.
 *
 * It is about the thing that will actually happen on the day: somebody opens
 * the admin panel and uploads the wrong workbook. Last year's task sheet, the
 * roster, whatever was in the Downloads folder. The pipeline has one job then,
 * and it is to leave the schedule exactly where it was and say why.
 *
 * Everything here is driven off the directory rather than off a list, so a
 * fixture that is added, regenerated, or repaired is covered without an edit.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'royalty-fixtures-')), 'test.db');
process.env.DB_PATH = TMP_DB;
process.env.NODE_ENV = 'test';
process.env.EVENT_TIMEZONE = 'America/Indiana/Indianapolis';

const { db } = await import('../server/db.js');
const { parseTabular } = await import('../server/sync/parse.js');
const { normalizeRosterRows, normalizeScheduleRows } = await import('../server/sync/normalize.js');
const { ingest } = await import('../server/sync/index.js');
const { listAllBlocks } = await import('../server/lib/queries.js');

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

/** Every workbook in `fixtures/`, read once and shared by the tests below. */
const files = fs
  .readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.xlsx') && !f.startsWith('~$'))
  .sort();

/** `{ name, buffer, headers, rows }` per workbook, read through the app's own reader. */
const parsed = [];

const ROSTER = 'Team Contact Information [FULL ROSTER].xlsx';

/* ------------------------------- fixture ------------------------------- */

/**
 * A small real schedule, so "the wrong file was uploaded" has something to
 * damage. Every assertion about survival is against these three blocks.
 */
const BLOCKS = [
  ['b_alpha', 'Fri', '09:00', '10:00', 'Alpha load-in', 'team', 't_alpha', 'k_alpha'],
  ['b_beta', 'Fri', '11:00', '12:00', 'Beta warm-up', 'team', 't_beta', 'k_beta'],
  ['b_judges', 'Sat', '13:00', '14:00', 'Judges briefing', 'role', 'judge', 'k_judges'],
];

function seedFixture() {
  const now = new Date('2026-08-01T12:00:00.000Z').toISOString();
  db.exec(`
    INSERT INTO roles (id,label,selector,sort_order,active) VALUES
      ('dancer','Dancer','team',1,1),
      ('judge','Judge','person',2,1);
    INSERT INTO event_days (key,label,date,sort_order) VALUES
      ('Fri','Friday','2026-08-07',1),
      ('Sat','Saturday','2026-08-08',2);
    INSERT INTO teams (id,name) VALUES ('t_alpha','Alpha Crew'),('t_beta','Beta Crew');
    INSERT INTO people (id,name,team_id) VALUES ('p_alice','Alice Alpha','t_alpha');
    INSERT INTO person_roles (person_id,role_id) VALUES ('p_alice','dancer');
  `);
  const insert = db.prepare(
    `INSERT INTO schedule_blocks
       (id,day,start_time,end_time,activity_label,applies_to_type,applies_to_id,
        source,source_key,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,'import',?,?,?)`
  );
  for (const b of BLOCKS) insert.run(...b, now, now);
}

/** The managed schedule as it stands, in a form that is easy to compare. */
const snapshot = () =>
  listAllBlocks()
    .filter((b) => b.sourceKey)
    .map((b) => `${b.sourceKey} ${b.day} ${b.startTime}-${b.endTime} ${b.activity}`)
    .sort();

before(async () => {
  seedFixture();
  for (const name of files) {
    const buffer = fs.readFileSync(path.join(FIXTURES, name));
    try {
      parsed.push({ name, buffer, ...(await parseTabular(buffer, name)) });
    } catch (err) {
      // Caught rather than thrown, so the readability test below reports it as
      // one clear failure instead of taking the whole file down in a hook.
      parsed.push({ name, buffer, error: err, headers: [], rows: [] });
    }
  }
});

after(() => {
  db.close();
  fs.rmSync(path.dirname(TMP_DB), { recursive: true, force: true });
});

/* ====================================================================== */

describe('the committed fixtures', () => {
  test('are there at all', () => {
    // `scripts/anonymize_samples.py` clears this directory before it writes.
    // If a regeneration went wrong, this is the test that says so first.
    assert.ok(files.length >= 4, `expected the four sample workbooks, found ${files.length}`);
    assert.ok(fs.existsSync(path.join(FIXTURES, 'README.md')), 'the edge-case inventory is gone');
  });

  /**
   * This is the regression guard for the repack pass in
   * `scripts/anonymize_samples.py`. openpyxl writes a workbook Excel opens
   * happily and exceljs cannot open at all — absolute relationship targets, and
   * comments under `xl/comments/` rather than `xl/comments1.xml` — so for a
   * while every one of these was unreadable by the app that has to read them.
   * `verify_fixtures.py` cannot catch that: it is the reader that objects, and
   * the reader is here.
   */
  test('every one of them opens in the reader the app actually uses', () => {
    const broken = parsed.filter((f) => f.error);
    assert.deepEqual(
      broken.map((f) => `${f.name}: ${f.error.message}`),
      [],
      'regenerate with scripts/anonymize_samples.py — its repack pass is what makes these readable'
    );
  });

  test('and they carry rows, not an empty read that would make this file vacuous', () => {
    const withRows = parsed.filter((f) => f.rows.length > 0);
    assert.ok(withRows.length >= 3, `only ${withRows.length} fixtures yielded rows`);
  });

  /**
   * `fixtures/README.md` lists what each workbook exists to preserve, and
   * `verify_fixtures.py` gates it in Python against `samples/`. These two check
   * the same edge cases are still reachable *through the app's own reader*,
   * which is the path item 12's parser will take — and they hold whether or not
   * anyone has a copy of `samples/`.
   */
  test('the messy roster the importer has to survive is still in there', () => {
    const roster = parsed.find((f) => f.name === ROSTER);
    assert.ok(roster, `${ROSTER} is missing`);
    const cells = roster.rows.flatMap((r) => r.__cells);

    // The `*` marks a food restriction, not a captain. Item 12 strips it.
    assert.ok(
      cells.some((c) => typeof c === 'string' && /\*$/.test(c.trim())),
      'no asterisk-suffixed name survived'
    );
    // A phone stored as a number, which is how the parser gets 5558086135.
    assert.ok(
      cells.some((c) => typeof c === 'number' && c >= 1e9 && c < 1e10),
      'no numeric-typed phone survived'
    );
    // Side tables past the last header column. A reader that takes "all columns
    // until empty" eats these; a header-driven one does not.
    assert.ok(
      roster.rows.some((r) => r.__cells.length > roster.headers.length),
      'no row runs past the headers'
    );
  });
});

describe('uploading last year’s workbook', () => {
  test('none of them is mistaken for the schedule template', async () => {
    for (const f of parsed) {
      const { rows, errors } = normalizeScheduleRows(f.rows);
      assert.equal(rows.length, 0, `${f.name} produced ${rows.length} importable rows`);
      assert.equal(errors.length, f.rows.length, `${f.name} should report every row`);
      for (const e of errors) assert.ok(e.message.length > 0);
    }
  });

  test('nor for the roster template — a real roster is not a filled-in one', async () => {
    // The roster fixture has First Name and Last Name in two columns, no Role
    // column at all, and the team only in the sheet tab. It reads as 25 rows
    // and none of them is importable, which is the point: assembling a roster
    // out of this is content work, not a mapping.
    const roster = parsed.find((f) => f.name === ROSTER);
    const { rows, errors } = normalizeRosterRows(roster.rows);
    assert.equal(rows.length, 0);
    assert.equal(errors.length, roster.rows.length);
    assert.match(errors[0].message, /Name is blank|is not a known role/);
  });

  test('the preview says so without writing anything', async () => {
    const before = snapshot();
    for (const f of parsed) {
      const result = await ingest(f.buffer, f.name, { dryRun: true });
      // Either "no data rows" or a diff of nothing but errors; never a diff
      // that offers to apply something.
      if (result.ok) {
        assert.equal(result.validRows, 0, f.name);
        assert.equal(result.diff.create.length, 0, f.name);
        assert.equal(result.diff.update.length, 0, f.name);
      } else {
        assert.match(result.error, /No data rows/, f.name);
      }
    }
    assert.deepEqual(snapshot(), before);
  });

  test('committing one cannot empty the schedule', async () => {
    const before = snapshot();
    assert.equal(before.length, 3);

    for (const f of parsed) {
      // removeMissing is the default, and a file that parses to zero valid rows
      // would otherwise mean "every managed block is missing — delete them".
      const result = await ingest(f.buffer, f.name, { dryRun: false, removeMissing: true });
      assert.equal(result.ok, false, `${f.name} was accepted`);
      assert.match(
        result.error,
        /Every row failed validation|No data rows/,
        `${f.name}: ${result.error}`
      );
    }

    assert.deepEqual(snapshot(), before, 'the schedule moved');
  });

  test('and nothing about it reached the change log', () => {
    const rows = db.prepare('SELECT COUNT(*) n FROM edit_log').get().n;
    assert.equal(rows, 0, 'a refused import wrote to the log');
  });
});
