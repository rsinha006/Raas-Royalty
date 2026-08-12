/**
 * Item 23 — snapshots, and everything that decides whether one is worth having.
 *
 * The failure this file is written against is not "the backup crashed". It is
 * the quiet one: a snapshot directory filling up with files that are valid
 * SQLite databases with nothing in them, discovered on the Saturday by the
 * person restoring one. So the weight here is on refusal — an empty copy, a
 * corrupt copy, a copy nobody could send anywhere — and on the restore actually
 * round-tripping, because a backup that has never been restored is a guess.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

/**
 * A throwaway database, set before anything is imported: `db.js` opens the file
 * and runs migrations as a side effect of being imported, and `backup.js`
 * derives its snapshot directory from that file's directory.
 */
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'royalty-backup-'));
process.env.DB_PATH = path.join(TMP_DIR, 'royalty.db');
process.env.NODE_ENV = 'test';
delete process.env.BACKUP_TARGET_URL;
delete process.env.BACKUP_TARGET_CMD;

const {
  SNAPSHOT_RE,
  backupConfig,
  backupStatus,
  hasOffBoxTarget,
  latestSnapshot,
  listSnapshots,
  pruneSnapshots,
  resetBackupState,
  shipSnapshot,
  snapshotName,
  startBackups,
  takeSnapshot,
  verifySnapshot,
} = await import('../server/lib/backup.js');
const { db, dataDir } = await import('../server/db.js');
const Database = (await import('better-sqlite3')).default;

const SNAP_DIR = path.join(TMP_DIR, 'snapshots');
const config = () => ({ ...backupConfig(), dir: SNAP_DIR, intervalMs: 0 });

/** Enough of an event for the counts to mean something. */
function seedRows(target = db, n = 3) {
  target.exec(`
    INSERT OR IGNORE INTO teams (id, name) VALUES ${Array.from(
      { length: n },
      (_, i) => `('t_${i}', 'Team ${i}')`
    ).join(',')};
    INSERT OR IGNORE INTO people (id, name, team_id) VALUES ${Array.from(
      { length: n },
      (_, i) => `('p_${i}', 'Person ${i}', 't_${i}')`
    ).join(',')};
  `);
}

before(() => seedRows());
beforeEach(() => {
  resetBackupState();
  fs.rmSync(SNAP_DIR, { recursive: true, force: true });
});
after(() => fs.rmSync(TMP_DIR, { recursive: true, force: true }));

describe('taking one', () => {
  test('a snapshot is a complete, openable copy of the live database', async () => {
    const record = await takeSnapshot({ config: config() });

    assert.equal(record.ok, true);
    assert.equal(record.unchanged, false);
    assert.ok(fs.existsSync(record.path));
    assert.ok(record.bytes > 0);

    const copy = new Database(record.path, { readonly: true });
    assert.equal(
      copy.prepare('SELECT COUNT(*) AS n FROM people').get().n,
      db.prepare('SELECT COUNT(*) AS n FROM people').get().n
    );
    copy.close();
  });

  test('the snapshot directory sits beside the database, not in the source tree', () => {
    // ⚠️ Item 22's bug, and it has no local symptom: in development `dataDir`
    // and the repo are the same folder, so a path built from `__dirname` looks
    // right here and is discarded by the next deploy on the machine.
    delete process.env.BACKUP_DIR;
    assert.equal(backupConfig().dir, path.join(dataDir, 'snapshots'));
    assert.equal(dataDir, TMP_DIR);
  });

  test('names sort chronologically as strings, which is what "newest" relies on', () => {
    const early = snapshotName(new Date('2026-08-08T09:05:00Z'));
    const late = snapshotName(new Date('2026-08-08T13:05:00Z'));
    assert.match(early, /^royalty-\d{8}-\d{6}Z\.db$/);
    assert.ok(late > early);
  });

  test('an unchanged database does not produce a second copy', async () => {
    const first = await takeSnapshot({ config: config() });
    const second = await takeSnapshot({ config: config(), now: new Date(Date.now() + 60_000) });

    assert.equal(second.unchanged, true);
    assert.equal(second.name, first.name);
    assert.equal(listSnapshots(SNAP_DIR).length, 1);
  });

  test('a write since the last snapshot produces a new one', async () => {
    await takeSnapshot({ config: config() });
    db.prepare("INSERT INTO teams (id, name) VALUES ('t_new', 'Late Addition')").run();

    const record = await takeSnapshot({ config: config(), now: new Date(Date.now() + 60_000) });
    assert.equal(record.unchanged, false);
    assert.equal(listSnapshots(SNAP_DIR).length, 2);

    db.prepare("DELETE FROM teams WHERE id = 't_new'").run();
  });

  test('a snapshot stands alone — no .part, no -wal, no -shm', async () => {
    /**
     * Found by running it rather than by reading it. Opening the copy to verify
     * it leaves `-shm` (and possibly `-wal`) named after the *temporary* file,
     * so after the rename they are orphans that no longer match the snapshot
     * pattern — invisible to `listSnapshots`, and therefore never pruned. Three
     * runs, because the first one hid it: the dedupe path and the failure paths
     * each need their own cleanup.
     */
    await takeSnapshot({ config: config() });
    db.prepare("INSERT INTO teams (id, name) VALUES ('t_sidecar', 'Sidecar')").run();
    await takeSnapshot({ config: config(), now: new Date(Date.now() + 60_000) });
    await takeSnapshot({ config: config(), now: new Date(Date.now() + 120_000) }); // unchanged
    db.prepare("DELETE FROM teams WHERE id = 't_sidecar'").run();

    const stray = fs
      .readdirSync(SNAP_DIR)
      .filter((f) => f !== '.state.json' && !SNAPSHOT_RE.test(f));
    assert.deepEqual(stray, [], 'only snapshots and the state file');
  });
});

describe('verification', () => {
  test('a valid but empty database is refused, because that is what a bad copy looks like', () => {
    // The failure mode this exists for: an empty SQLite file passes every
    // structural check there is and restores to an event with nobody in it.
    const emptyPath = path.join(TMP_DIR, 'empty.db');
    const empty = new Database(emptyPath);
    empty.exec(
      'CREATE TABLE schedule_blocks (id TEXT); CREATE TABLE people (id TEXT);' +
        'CREATE TABLE teams (id TEXT); CREATE TABLE access_codes (id TEXT);'
    );
    empty.close();

    const bare = verifySnapshot(emptyPath);
    assert.equal(bare.ok, true, 'no expectation to compare against — structurally it is fine');

    const compared = verifySnapshot(emptyPath, { people: 3, teams: 3 });
    assert.equal(compared.ok, false);
    assert.match(compared.error, /no people/);
  });

  test('a truncated file is refused', () => {
    const brokenPath = path.join(TMP_DIR, 'broken.db');
    fs.writeFileSync(brokenPath, fs.readFileSync(process.env.DB_PATH).subarray(0, 900));
    const result = verifySnapshot(brokenPath);
    assert.equal(result.ok, false);
  });

  test('a snapshot that fails verification is deleted rather than kept', async () => {
    // A file in the directory reads as a backup to everything downstream. One
    // that failed verification is worse than none, because the count goes up.
    const source = {
      backup: async (dest) => fs.writeFileSync(dest, Buffer.from('not a database at all')),
      prepare: () => ({ get: () => ({ n: 3 }) }),
    };
    const record = await takeSnapshot({ config: config(), source });

    assert.equal(record.ok, false);
    assert.match(record.error, /verification/);
    assert.equal(listSnapshots(SNAP_DIR).length, 0);
    assert.equal(fs.readdirSync(SNAP_DIR).filter((f) => f.endsWith('.part')).length, 0);
  });

  test('a copy failure is reported, not thrown', async () => {
    const source = {
      backup: async () => {
        throw new Error('disk is full');
      },
      prepare: () => ({ get: () => ({ n: 3 }) }),
    };
    const record = await takeSnapshot({ config: config(), source });
    assert.equal(record.ok, false);
    assert.match(record.error, /disk is full/);
    assert.equal(backupStatus(config()).lastError, record.error);
  });
});

describe('retention', () => {
  const fake = (name, bytes = 1000) => {
    fs.mkdirSync(SNAP_DIR, { recursive: true });
    fs.writeFileSync(path.join(SNAP_DIR, name), Buffer.alloc(bytes));
  };

  test('prunes by count, oldest first', () => {
    for (const n of ['01', '02', '03', '04', '05']) fake(`royalty-20260808-1${n}500Z.db`);
    const removed = pruneSnapshots({ ...config(), keep: 3, maxBytes: 1e9 });

    assert.equal(removed.length, 2);
    const left = listSnapshots(SNAP_DIR).map((s) => s.name);
    assert.equal(left.length, 3);
    assert.ok(left[0].includes('105500'), 'newest survives');
  });

  test('prunes by total bytes, because the volume also holds the database', () => {
    for (const n of ['01', '02', '03', '04']) fake(`royalty-20260808-1${n}500Z.db`, 4000);
    const removed = pruneSnapshots({ ...config(), keep: 100, maxBytes: 9000 });

    assert.equal(removed.length, 2);
    assert.equal(listSnapshots(SNAP_DIR).length, 2);
  });

  test('never prunes the newest, whatever the limits say', () => {
    fake('royalty-20260808-130500Z.db', 50_000);
    const removed = pruneSnapshots({ ...config(), keep: 0, maxBytes: 1 });

    assert.deepEqual(removed, []);
    assert.equal(latestSnapshot(SNAP_DIR).name, 'royalty-20260808-130500Z.db');
  });

  test('files that are not snapshots are left alone', () => {
    fake('royalty-20260808-130500Z.db');
    fs.writeFileSync(path.join(SNAP_DIR, 'notes.txt'), 'do not delete me');
    pruneSnapshots({ ...config(), keep: 0, maxBytes: 1 });
    assert.ok(fs.existsSync(path.join(SNAP_DIR, 'notes.txt')));
  });
});

describe('getting it off the machine', () => {
  test('an HTTP target receives the bytes, at a URL naming the snapshot', async () => {
    const received = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        received.push({
          method: req.method,
          url: req.url,
          auth: req.headers.authorization,
          bytes: Buffer.concat(chunks).length,
        });
        res.writeHead(200).end('ok');
      });
    });
    await new Promise((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${server.address().port}/backups`;

    const record = await takeSnapshot({
      config: { ...config(), targetUrl: base, targetToken: 'sekret', targetMethod: 'PUT' },
    });

    assert.equal(record.shipped.ok, true);
    assert.equal(received.length, 1);
    assert.equal(received[0].method, 'PUT');
    assert.equal(received[0].url, `/backups/${record.name}`);
    assert.equal(received[0].auth, 'Bearer sekret');
    assert.equal(received[0].bytes, record.bytes);
    assert.ok(backupStatus({ ...config(), targetUrl: base }).lastShippedName === record.name);

    server.close();
  });

  test('a rejected upload does not fail the snapshot — the local copy is already verified', async () => {
    const server = http.createServer((req, res) => res.writeHead(503).end('nope'));
    await new Promise((r) => server.listen(0, r));

    const record = await takeSnapshot({
      config: { ...config(), targetUrl: `http://127.0.0.1:${server.address().port}` },
    });

    assert.equal(record.ok, true, 'the snapshot itself succeeded');
    assert.equal(record.shipped.ok, false);
    assert.match(record.shipped.error, /503/);
    assert.ok(fs.existsSync(record.path));

    server.close();
  });

  test('a command target runs, with the file and name substituted', async () => {
    const landing = path.join(TMP_DIR, 'offbox');
    fs.mkdirSync(landing, { recursive: true });

    const record = await takeSnapshot({
      config: { ...config(), targetCmd: `cp {file} ${landing}/{name}` },
    });

    assert.equal(record.shipped.ok, true);
    assert.equal(record.shipped.via, 'command');
    assert.ok(fs.existsSync(path.join(landing, record.name)));
  });

  test('a failing command is reported with its output', async () => {
    const result = await shipSnapshot('/tmp/whatever', 'x.db', {
      ...config(),
      targetCmd: 'echo "no credentials" >&2; exit 3',
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /no credentials/);
  });

  test('with no target configured, nothing is shipped and the status says so', async () => {
    const c = config();
    assert.equal(hasOffBoxTarget(c), false);
    const record = await takeSnapshot({ config: c });
    assert.equal(record.shipped, undefined);
    assert.equal(backupStatus(c).offBox, null);
  });
});

describe('status and the scheduler', () => {
  test('status reads the directory, so a restart is not "no backups yet"', async () => {
    const record = await takeSnapshot({ config: config() });
    resetBackupState(); // as if the process had just started

    const status = backupStatus(config());
    assert.equal(status.count, 1);
    assert.equal(status.newest.name, record.name);
    assert.ok(status.ageSeconds !== null && status.ageSeconds < 60);
    assert.equal(status.lastRun, null, 'in-memory record is gone; the directory is not');
  });

  test('staleness is off when snapshots are disabled, and true when nothing has been taken', () => {
    assert.equal(backupStatus({ ...config(), intervalMs: 0 }).stale, false);
    assert.equal(backupStatus({ ...config(), intervalMs: 60_000 }).stale, true);
  });

  test('a fresh snapshot is not stale', async () => {
    await takeSnapshot({ config: config() });
    assert.equal(backupStatus({ ...config(), intervalMs: 60_000 }).stale, false);
  });

  test('an idle event is not stale just because the last run found nothing to copy', async () => {
    /**
     * ⚠️ Found in the browser, not here. Staleness read off the newest file's
     * mtime, and a run that finds the database unchanged writes no file — so a
     * perfectly backed-up idle event started reporting "no verified snapshot
     * recently", which during the event is a page at 3am about nothing.
     */
    const c = { ...config(), intervalMs: 60_000 };
    const first = await takeSnapshot({ config: c });

    // Age the file well past the staleness window; the run below still verifies.
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(first.path, old, old);

    const second = await takeSnapshot({ config: c });
    assert.equal(second.unchanged, true);

    const status = backupStatus(c);
    assert.ok(status.ageSeconds > 300, 'the file itself really is old');
    assert.ok(status.verifiedAgeSeconds < 60, 'but it was verified just now');
    assert.equal(status.stale, false);
  });

  test('the scheduler does not start when the interval is zero', () => {
    const handle = startBackups({ config: config() });
    assert.equal(handle.started, false);
  });

  test('the scheduler takes one immediately rather than after the first interval', async () => {
    // A deploy is followed by a known-good copy, not by a five-minute window
    // with nothing in it.
    const events = [];
    const handle = startBackups({
      config: { ...config(), intervalMs: 10_000 },
      onEvent: (e) => events.push(e),
    });
    assert.equal(handle.started, true);

    await new Promise((r) => setTimeout(r, 2_500));
    handle.stop();

    assert.equal(events.length, 1);
    assert.equal(events[0].ok, true);
  });
});

describe('restoring', () => {
  test('a snapshot round-trips: restore it and the rows are back', async () => {
    // The assertion the whole item rests on. Take a copy, destroy the live
    // data, put the copy back, and read the rows out of it.
    const record = await takeSnapshot({ config: config() });
    const before = db.prepare('SELECT COUNT(*) AS n FROM people').get().n;

    /**
     * The working copy is made from the snapshot rather than by copying the
     * live file — copying a WAL database is exactly the mistake `takeSnapshot`
     * exists to avoid, and here it produces a file with no tables in it at all.
     */
    const live = path.join(TMP_DIR, 'restore-target.db');
    fs.copyFileSync(record.path, live);
    const wounded = new Database(live);
    wounded.exec('DELETE FROM people');
    assert.equal(wounded.prepare('SELECT COUNT(*) AS n FROM people').get().n, 0);
    wounded.close();

    fs.copyFileSync(record.path, live);
    const restored = new Database(live, { readonly: true });
    assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM people').get().n, before);
    restored.close();
  });

  test('the restore script refuses a corrupt file before touching anything', async () => {
    const { execFile } = await import('node:child_process');
    const junk = path.join(TMP_DIR, 'junk.db');
    fs.writeFileSync(junk, 'this is not a database');
    const liveBefore = fs.readFileSync(process.env.DB_PATH).length;

    const code = await new Promise((resolve) => {
      execFile(
        process.execPath,
        [path.join(process.cwd(), 'scripts', 'restore.js'), junk, '--yes'],
        { env: { ...process.env } },
        (err) => resolve(err?.code ?? 0)
      );
    });

    assert.equal(code, 1);
    assert.equal(fs.readFileSync(process.env.DB_PATH).length, liveBefore, 'live database untouched');
  });
});
