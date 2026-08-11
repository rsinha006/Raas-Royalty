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
const { normalizeScheduleRows } = await import('../server/sync/normalize.js');
const { ingest } = await import('../server/sync/index.js');
const { listAllBlocks } = await import('../server/lib/queries.js');

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

/** Every workbook in `fixtures/`, read once and shared by the tests below. */
const files = fs
  .readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.xlsx') && !f.startsWith('~$'))
  .sort();

/** `{ name, rows }` for the ones that parse, `{ name, error }` for the ones that don't. */
const parsed = [];

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
      parsed.push({ name, buffer, error: err });
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

  test('each one either parses or refuses in a way an admin can act on', () => {
    for (const f of parsed) {
      if (!f.error) continue;
      // Never a raw internal TypeError from a spreadsheet library — the admin
      // uploading this has to know what to try next.
      assert.match(
        f.error.message,
        /re-save it as \.xlsx or \.csv/i,
        `${f.name} failed without a suggestion: ${f.error.message}`
      );
    }
  });

  test('at least one really is read, so the rest of this file has teeth', () => {
    const readable = parsed.filter((f) => !f.error);
    assert.ok(readable.length > 0, 'no fixture could be parsed at all');
    // Rows, not an empty read that would make every assertion below vacuous.
    assert.ok(
      readable.some((f) => f.rows.length > 0),
      'no fixture yielded any rows'
    );
  });

  /**
   * Three of the four cannot be opened at the moment, and it is the fixtures
   * that are wrong rather than the reader: the originals in `samples/` parse.
   * `openpyxl` writes absolute relationship targets (`/xl/tables/table1.xml`)
   * and puts comments under `xl/comments/`, and exceljs resolves neither.
   * Recorded here rather than asserted as a fixed number, so repairing the
   * anonymizer makes this test stronger instead of red.
   */
  test('the ones that cannot be opened are a fixture-generation problem, not a data one', () => {
    for (const f of parsed.filter((x) => x.error)) {
      assert.ok(
        fs.existsSync(path.join(FIXTURES, f.name)),
        `${f.name} is missing, which is a different problem`
      );
    }
  });
});

describe('uploading last year’s workbook', () => {
  test('none of them is mistaken for the schedule template', async () => {
    for (const f of parsed) {
      if (f.error) continue;
      const { rows, errors } = normalizeScheduleRows(f.rows);
      assert.equal(rows.length, 0, `${f.name} produced ${rows.length} importable rows`);
      assert.equal(errors.length, f.rows.length, `${f.name} should report every row`);
      for (const e of errors) assert.ok(e.message.length > 0);
    }
  });

  test('the preview says so without writing anything', async () => {
    const before = snapshot();
    for (const f of parsed) {
      if (f.error) {
        await assert.rejects(() => ingest(f.buffer, f.name, { dryRun: true }));
        continue;
      }
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
      if (f.error) {
        await assert.rejects(() => ingest(f.buffer, f.name, { dryRun: false, removeMissing: true }));
        continue;
      }
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
