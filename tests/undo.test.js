/**
 * Undo — item 17.
 *
 * The edit log recorded everything and could reverse nothing. What makes this
 * safe to add mid-event is not that it puts blocks back — it is what it
 * refuses:
 *
 *   a batch someone else has edited since  → refused whole, nothing written
 *   a bulk shift                           → all of it or none of it, never half
 *   an action that also changed the roster → refused, because restoring blocks
 *                                            for a deleted person is worse than
 *                                            not undoing
 *   an import                              → refused, because `source_key`
 *                                            ownership would survive the undo
 *                                            and the next poll would re-apply it
 *
 * So most of what follows is about batches that do *not* get reverted.
 */
import { test, before, after, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'royalty-undo-')), 'test.db');
process.env.DB_PATH = TMP_DB;
process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'test-admin-password';
process.env.EVENT_TIMEZONE = 'America/Indiana/Indianapolis';

const { db } = await import('../server/db.js');
const { createApp } = await import('../server/app.js');
const { planUndo } = await import('../server/lib/undo.js');

let server;
let base;
let admin;

const START = new Date('2026-08-01T12:00:00.000Z').toISOString();

const BLOCKS = [
  ['b_a1', 'Sat', '09:00', '10:00', 'Alpha warm-up', 'team', 'team_a'],
  ['b_a2', 'Sat', '15:00', '15:30', 'Alpha tech', 'team', 'team_a'],
  ['b_a3', 'Sat', '16:00', '16:30', 'Alpha photos', 'team', 'team_a'],
  ['b_b1', 'Sat', '15:10', '15:40', 'Beta tech', 'team', 'team_b'],
  ['b_p1', 'Sat', '17:00', '17:30', 'Maya airport pickup', 'person', 'p_maya'],
];

function seedFixture() {
  db.exec(`
    INSERT INTO roles (id,label,selector,sort_order,active) VALUES ('dancer','Dancer','team',1,1);
    INSERT INTO event_days (key,label,date,sort_order) VALUES
      ('Fri','Friday','2026-08-07',1),
      ('Sat','Saturday','2026-08-08',2);
    INSERT INTO teams (id,name) VALUES ('team_a','Alpha Crew'),('team_b','Beta Crew');
    INSERT INTO people (id,name,team_id) VALUES
      ('p_maya','Maya Alpha','team_a'),
      ('p_nina','Nina Beta','team_b');
    INSERT INTO person_roles (person_id,role_id) VALUES ('p_maya','dancer'),('p_nina','dancer');
    INSERT INTO locations (id,venue_name,sub_location) VALUES ('loc_1','Main Venue','Studio A');
  `);
  writeBlocks();
}

function writeBlocks() {
  db.prepare('DELETE FROM schedule_blocks').run();
  const insert = db.prepare(
    `INSERT INTO schedule_blocks
       (id,day,start_time,end_time,activity_label,applies_to_type,applies_to_id,
        location_id,notes,source,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,'loc_1','Bring shoes','manual',?,?)`
  );
  for (const b of BLOCKS) insert.run(...b, START, START);
}

/** Each test starts from the fixture with an empty log. */
function reset() {
  writeBlocks();
  db.prepare('DELETE FROM edit_log').run();
  db.prepare('UPDATE target_versions SET updated_at = ?').run(START);
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

const row = (id) => db.prepare('SELECT * FROM schedule_blocks WHERE id = ?').get(id);
const at = (id) => {
  const b = row(id);
  return b ? `${b.day} ${b.start_time}–${b.end_time}` : null;
};

/** The newest batch, which is whatever the last request wrote. */
async function lastBatch() {
  const { body } = await asAdmin('GET', '/api/admin/undo');
  return body.batches[0];
}

const undo = (batchId) => asAdmin('POST', '/api/admin/undo', { batchId });

/** Move everything from 15:00 on Saturday 20 minutes later, via the real routes. */
async function runShift(minutes = 20) {
  const preview = await asAdmin('POST', '/api/admin/blocks/shift/preview', {
    day: 'Sat',
    fromTime: '15:00',
    minutes,
  });
  assert.equal(preview.status, 200, preview.body?.error);
  const applied = await asAdmin('POST', '/api/admin/blocks/shift', {
    minutes,
    blocks: preview.body.moves.map((m) => ({ id: m.id, expectedUpdatedAt: m.updatedAt })),
  });
  assert.equal(applied.status, 200, applied.body?.error);
  return applied.body;
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

beforeEach(reset);

/* ------------------------------ the three shapes ------------------------------ */

describe('putting one change back', () => {
  test('an edited block returns to every field it had', async () => {
    const before = row('b_a2');
    const edit = await asAdmin('PATCH', '/api/admin/blocks/b_a2', {
      startTime: '11:00',
      endTime: '11:45',
      activity: 'Alpha tech (moved)',
      notes: null,
    });
    assert.equal(edit.status, 200, edit.body?.error);
    assert.equal(at('b_a2'), 'Sat 11:00–11:45');

    const undone = await undo((await lastBatch()).batchId);
    assert.equal(undone.status, 200, undone.body?.error);

    const restored = row('b_a2');
    assert.equal(at('b_a2'), 'Sat 15:00–15:30');
    assert.equal(restored.activity_label, before.activity_label);
    assert.equal(restored.notes, before.notes);
    assert.equal(restored.location_id, before.location_id);
    // A new version, not the old one: the row really was written again, so
    // anyone else's stale editor conflicts rather than silently agreeing.
    assert.notEqual(restored.updated_at, before.updated_at);
  });

  test('a created block is removed', async () => {
    const created = await asAdmin('POST', '/api/admin/blocks', {
      day: 'Sat',
      startTime: '08:00',
      endTime: '08:30',
      activity: 'Extra rehearsal',
      appliesToType: 'team',
      appliesToId: 'team_a',
    });
    assert.equal(created.status, 200, created.body?.error);
    const id = created.body.id ?? created.body.block?.id;
    assert.ok(row(id));

    const undone = await undo((await lastBatch()).batchId);
    assert.equal(undone.status, 200, undone.body?.error);
    assert.equal(row(id), undefined);
  });

  test('a deleted block comes back with its id and its contents', async () => {
    const before = row('b_p1');
    const removed = await asAdmin('DELETE', '/api/admin/blocks/b_p1');
    assert.equal(removed.status, 200, removed.body?.error);
    assert.equal(row('b_p1'), undefined);

    const undone = await undo((await lastBatch()).batchId);
    assert.equal(undone.status, 200, undone.body?.error);

    const back = row('b_p1');
    assert.ok(back, 'the same id is restored, so anything referring to it still does');
    assert.equal(back.activity_label, before.activity_label);
    assert.equal(back.applies_to_id, 'p_maya');
    assert.equal(back.notes, before.notes);
    assert.equal(back.location_id, before.location_id);
  });

  test('a reassignment puts the block back on the team that lost it', async () => {
    await asAdmin('PATCH', '/api/admin/blocks/b_a1', {
      appliesToType: 'team',
      appliesToId: 'team_b',
    });
    assert.equal(row('b_a1').applies_to_id, 'team_b');

    const undone = await undo((await lastBatch()).batchId);
    assert.equal(undone.status, 200, undone.body?.error);
    assert.equal(row('b_a1').applies_to_id, 'team_a');
  });
});

/* --------------------------------- batches --------------------------------- */

describe('a bulk shift is one thing', () => {
  test('it is listed as a single entry, not as one per block', async () => {
    const shift = await runShift();
    const batch = await lastBatch();

    assert.equal(shift.moved, 4);
    assert.match(batch.summary, /20 min/);
    // Four block rows plus the summary line, under one batch id.
    assert.equal(batch.entries.length, 5);
    assert.equal(batch.steps, 4);
    assert.equal(batch.canUndo, true);
  });

  test('undoing it moves every block back', async () => {
    await runShift();
    assert.equal(at('b_a2'), 'Sat 15:20–15:50');

    const undone = await undo((await lastBatch()).batchId);
    assert.equal(undone.status, 200, undone.body?.error);
    assert.equal(undone.body.undone, 4);

    assert.equal(at('b_a2'), 'Sat 15:00–15:30');
    assert.equal(at('b_a3'), 'Sat 16:00–16:30');
    assert.equal(at('b_b1'), 'Sat 15:10–15:40');
    assert.equal(at('b_p1'), 'Sat 17:00–17:30');
    // Untouched by the shift, so untouched by the undo.
    assert.equal(at('b_a1'), 'Sat 09:00–10:00');
  });

  test('one block changed since refuses the whole shift', async () => {
    await runShift();
    const batchId = (await lastBatch()).batchId;

    // Another admin nudges one of the shifted blocks.
    const meddle = await asAdmin('PATCH', '/api/admin/blocks/b_b1', { endTime: '15:55' });
    assert.equal(meddle.status, 200, meddle.body?.error);

    const undone = await undo(batchId);
    assert.equal(undone.status, 409);
    assert.equal(undone.body.reason, 'changed');
    assert.match(undone.body.error, /Beta tech/);

    // Nothing was put back — half a day 20 minutes from the other half looks
    // exactly like a correct schedule, which is the failure to avoid.
    assert.equal(at('b_a2'), 'Sat 15:20–15:50');
    assert.equal(at('b_a3'), 'Sat 16:20–16:50');
    assert.equal(at('b_b1'), 'Sat 15:30–15:55');
  });

  test('a block deleted since refuses it too', async () => {
    await runShift();
    const batchId = (await lastBatch()).batchId;
    await asAdmin('DELETE', '/api/admin/blocks/b_a3');

    const undone = await undo(batchId);
    assert.equal(undone.status, 409);
    assert.equal(undone.body.reason, 'missing');
    assert.equal(at('b_a2'), 'Sat 15:20–15:50');
  });
});

/* ------------------------------- what it refuses ------------------------------- */

describe('what cannot be undone', () => {
  test('deleting a person, because their blocks would come back and they would not', async () => {
    const removed = await asAdmin('DELETE', '/api/admin/people/p_maya?removeBlocks=1');
    assert.equal(removed.status, 200, removed.body?.error);
    assert.equal(row('b_p1'), undefined);

    const batch = await lastBatch();
    assert.equal(batch.canUndo, false);
    assert.equal(batch.blockers[0].reason, 'irreversible');
    // The headline is the roster line, which is the part an admin needs to read
    // precisely because it is the part that cannot be reversed.
    assert.match(batch.summary, /Maya Alpha/);

    const undone = await undo(batch.batchId);
    assert.equal(undone.status, 409);
    assert.equal(row('b_p1'), undefined, 'still gone — a refusal writes nothing');
  });

  test('a roster edit, which has no prior version recorded', async () => {
    const renamed = await asAdmin('PATCH', '/api/admin/teams/team_b', { name: 'Beta Reborn' });
    assert.equal(renamed.status, 200, renamed.body?.error);

    const batch = await lastBatch();
    assert.equal(batch.canUndo, false);
    assert.equal(batch.blockers[0].reason, 'irreversible');

    await asAdmin('PATCH', '/api/admin/teams/team_b', { name: 'Beta Crew' });
  });

  test('an import, because its ownership would survive and re-apply itself', async () => {
    // Written straight to the log: what matters is the source, not the route
    // that produced it, and standing up a whole spreadsheet here would test the
    // importer rather than this rule.
    db.prepare(
      `INSERT INTO edit_log (id, schedule_block_id, edited_by, source, timestamp,
                             change_type, change_summary, before_json, after_version, batch_id)
       VALUES ('log_imp','b_a1','Marcus','import',?,'updated','Import moved it',?,?,'batch_imp')`
    ).run(new Date().toISOString(), JSON.stringify({ ...blockShape('b_a1') }), row('b_a1').updated_at);

    const plan = planUndo('batch_imp');
    assert.equal(plan.blockers[0].reason, 'source');
    assert.match(plan.blockers[0].label, /re-sync/);

    const undone = await undo('batch_imp');
    assert.equal(undone.status, 409);
  });

  test('a log row written before the log stored state', async () => {
    // What every existing row looks like after the migration: no before_json.
    db.prepare(
      `INSERT INTO edit_log (id, schedule_block_id, edited_by, source, timestamp,
                             change_type, change_summary, batch_id)
       VALUES ('log_old','b_a1','Marcus','manual',?,'updated','Changed something','batch_old')`
    ).run(new Date().toISOString());

    const plan = planUndo('batch_old');
    assert.equal(plan.blockers[0].reason, 'no-state');
    assert.equal(plan.steps.length, 0);
    // Honest rather than clever: nothing recorded what that row overwrote, so
    // there is no state to guess at from the prose in `change_summary`.
    assert.match(plan.blockers[0].label, /No earlier version was recorded/);

    const listed = (await asAdmin('GET', '/api/admin/undo')).body.batches;
    assert.equal(listed.find((b) => b.batchId === 'batch_old').canUndo, false);
  });

  test('the same change twice', async () => {
    await asAdmin('PATCH', '/api/admin/blocks/b_a2', { startTime: '11:00', endTime: '11:30' });
    const batchId = (await lastBatch()).batchId;

    assert.equal((await undo(batchId)).status, 200);
    assert.equal(at('b_a2'), 'Sat 15:00–15:30');

    const again = await undo(batchId);
    assert.equal(again.status, 409);
    assert.equal(again.body.reason, 'undone');
    assert.equal(at('b_a2'), 'Sat 15:00–15:30', 'and it did not double-apply');
  });

  test('a batch that does not exist', async () => {
    const res = await undo('batch_nope');
    assert.equal(res.status, 404);
  });

  test('none of it without an admin session', async () => {
    assert.equal((await call('GET', '/api/admin/undo')).status, 401);
    assert.equal(
      (await call('POST', '/api/admin/undo', { body: { batchId: 'anything' } })).status,
      401
    );
  });
});

/* --------------------------------- redo --------------------------------- */

describe('the undo is itself a change', () => {
  test('so it can be undone in turn', async () => {
    await asAdmin('PATCH', '/api/admin/blocks/b_a2', { startTime: '11:00', endTime: '11:30' });
    const edit = (await lastBatch()).batchId;

    assert.equal((await undo(edit)).status, 200);
    assert.equal(at('b_a2'), 'Sat 15:00–15:30');

    // The undo wrote its own batch, through the ordinary mutations — which is
    // what makes redo fall out rather than being a second mechanism.
    const undoBatch = await lastBatch();
    assert.notEqual(undoBatch.batchId, edit);
    assert.equal(undoBatch.canUndo, true);
    // With a headline of its own, so the log reads as one action and the thing
    // an admin is about to undo again is recognisable.
    assert.match(undoBatch.summary, /^Put back: Changed "Alpha tech"/);

    assert.equal((await undo(undoBatch.batchId)).status, 200);
    assert.equal(at('b_a2'), 'Sat 11:00–11:30');
  });

  test('and it moves the affected targets’ timestamps', async () => {
    const versionOf = (type, id) =>
      db
        .prepare('SELECT updated_at FROM target_versions WHERE target_type = ? AND target_id = ?')
        .get(type, id)?.updated_at;

    await asAdmin('PATCH', '/api/admin/blocks/b_a2', { startTime: '11:00', endTime: '11:30' });
    await undo((await lastBatch()).batchId);

    // Alpha's schedule moved twice and their "last updated" says so; Beta's
    // never did, so an undo must not tell 25 people their day changed.
    assert.notEqual(versionOf('team', 'team_a'), START);
    assert.equal(versionOf('team', 'team_b'), START);
  });
});

/** The `before_json` shape the mutations record — used by the import test above. */
function blockShape(id) {
  const b = row(id);
  return {
    id: b.id,
    day: b.day,
    startTime: b.start_time,
    endTime: b.end_time,
    activity: b.activity_label,
    notes: b.notes,
    location: b.location_id ? { id: b.location_id } : null,
    appliesTo: { type: b.applies_to_type, id: b.applies_to_id },
    sourceKey: b.source_key || null,
  };
}
