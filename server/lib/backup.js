import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

import Database from 'better-sqlite3';

import { db, dataDir, dbPath } from '../db.js';

/**
 * Database snapshots — PLAN.md item 23.
 *
 * The event data exists in exactly one place: a SQLite file on a volume
 * attached to a single machine (docs/deploy.md explains why there is only one).
 * Everything else in this repo can be rebuilt from git; this cannot. Losing it
 * at 1pm on the Saturday means the schedule 280 people are looking at is gone,
 * and the paper fallback in item 28 becomes the product.
 *
 * Three properties, in the order they matter:
 *
 *   1. **Verified.** A snapshot nobody has opened is a guess. Every snapshot is
 *      re-opened, `PRAGMA integrity_check`ed and counted before it is kept, and
 *      a copy that fails is deleted rather than left to look like a backup.
 *   2. **Off-box.** A copy beside the database dies with the volume it sits on.
 *      The local snapshots are the fast restore path (a bad import, a mistaken
 *      delete); `BACKUP_TARGET_*` is the one that survives the machine.
 *   3. **Frequent.** Fly snapshots volumes daily by default. A two-day event
 *      whose entire point is that the schedule changes every few minutes needs
 *      minutes, not a day — the default here is every 5.
 *
 * ⚠️ The snapshot directory derives from `dataDir`, never from `__dirname`. A
 * path relative to the source tree is silently discarded by the next deploy and
 * has no local symptom at all, because in development the two are the same
 * folder. That is exactly the bug item 22 found in `sync/sources.js`.
 */

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_KEEP = 48;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const SHIP_TIMEOUT_MS = 60_000;
const STATE_FILE = '.state.json';

export const SNAPSHOT_RE = /^royalty-(\d{8}-\d{6})Z\.db$/;

/**
 * How the snapshotter is configured, resolved from the environment.
 *
 * Off outside production unless `BACKUP_INTERVAL_MS` says otherwise: a
 * developer running `npm start` is not running an event, and filling their
 * `data/` folder with copies of a seed database every five minutes is a way to
 * make the feature annoying enough to be turned off on the machine too.
 */
export function backupConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const rawInterval = env.BACKUP_INTERVAL_MS;
  const intervalMs =
    rawInterval === undefined || rawInterval === ''
      ? production
        ? DEFAULT_INTERVAL_MS
        : 0
      : Number(rawInterval);

  const dir = env.BACKUP_DIR ? path.resolve(env.BACKUP_DIR) : path.join(dataDir, 'snapshots');

  return {
    dir,
    intervalMs: Number.isFinite(intervalMs) && intervalMs > 0 ? Math.max(intervalMs, 10_000) : 0,
    keep: positive(env.BACKUP_KEEP, DEFAULT_KEEP),
    maxBytes: positive(env.BACKUP_MAX_BYTES, DEFAULT_MAX_BYTES),
    targetUrl: env.BACKUP_TARGET_URL || null,
    targetToken: env.BACKUP_TARGET_TOKEN || null,
    targetMethod: env.BACKUP_TARGET_METHOD || 'PUT',
    targetCmd: env.BACKUP_TARGET_CMD || null,
  };
}

function positive(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Is there anywhere off this machine for a snapshot to go? */
export function hasOffBoxTarget(config = backupConfig()) {
  return Boolean(config.targetUrl || config.targetCmd);
}

/* ------------------------------------------------------------------ *
 * Taking one
 * ------------------------------------------------------------------ */

export function snapshotName(at = new Date()) {
  const p = at.toISOString().replace(/[-:]/g, '').replace('T', '-');
  return `royalty-${p.slice(0, 15)}Z.db`;
}

/**
 * Open a snapshot and satisfy ourselves that it is a database with the event in
 * it.
 *
 * `integrity_check` alone is not enough. A zero-byte file, or one copied while
 * the WAL held every recent write, is a *perfectly valid* empty SQLite database
 * — it passes every structural check there is and restores to an event with
 * nobody in it. So the counts are the real assertion, and `expect` lets the
 * caller compare them against the live database the copy was taken from.
 */
export function verifySnapshot(file, expect = null) {
  let copy = null;
  try {
    const size = fs.statSync(file).size;
    copy = new Database(file, { readonly: true, fileMustExist: true });
    const integrity = copy.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') return { ok: false, error: `integrity_check: ${integrity}` };

    const counts = {
      blocks: copy.prepare('SELECT COUNT(*) AS n FROM schedule_blocks').get().n,
      people: copy.prepare('SELECT COUNT(*) AS n FROM people').get().n,
      teams: copy.prepare('SELECT COUNT(*) AS n FROM teams').get().n,
      codes: copy.prepare('SELECT COUNT(*) AS n FROM access_codes').get().n,
    };

    if (expect) {
      for (const [table, n] of Object.entries(expect)) {
        if (n > 0 && !(counts[table] > 0)) {
          return {
            ok: false,
            error: `the copy has no ${table} but the live database has ${n}`,
            counts,
          };
        }
      }
    }
    return { ok: true, size, counts };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    try {
      copy?.close();
    } catch {
      /* verification is read-only; a close failure tells us nothing useful */
    }
  }
}

/**
 * Leave one file, not three.
 *
 * Opening the copy to verify it creates `-shm` beside it, and a WAL-mode
 * database can carry a `-wal` as well. Both matter more than the clutter
 * suggests: they are named after the *temporary* file, so after the rename they
 * are orphans that no longer match the snapshot pattern — invisible to
 * `listSnapshots`, and therefore invisible to the pruning that keeps this
 * directory from filling the volume the database is on. And a snapshot that is
 * only complete when read alongside a sidecar is the "restored, then served a
 * mixture of both" failure that `scripts/restore.js` moves them aside to avoid.
 *
 * Anything still in the WAL is checkpointed into the main file first, so what
 * is left standing alone is the whole database.
 */
function sealSnapshot(file) {
  const wal = `${file}-wal`;
  try {
    // Guarded: opening a path that is no longer there would *create* an empty
    // database rather than checkpoint one.
    if (fs.existsSync(file) && fs.existsSync(wal) && fs.statSync(wal).size > 0) {
      const handle = new Database(file);
      handle.pragma('wal_checkpoint(TRUNCATE)');
      handle.close();
    }
  } catch {
    /* falls through to the removal below; verification has already passed */
  }
  for (const suffix of ['-wal', '-shm']) fs.rmSync(`${file}${suffix}`, { force: true });
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readState(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, STATE_FILE), 'utf8'));
  } catch {
    return {};
  }
}

function writeState(dir, patch) {
  const next = { ...readState(dir), ...patch };
  try {
    fs.writeFileSync(path.join(dir, STATE_FILE), JSON.stringify(next, null, 2));
  } catch {
    /* the state file is a convenience; losing it costs a duplicate snapshot */
  }
  return next;
}

/**
 * Take one snapshot: copy, verify, keep, prune, ship.
 *
 * Uses better-sqlite3's online backup rather than copying the file, because a
 * plain copy of a WAL database taken mid-write is the empty-but-valid file
 * described above. The backup API walks pages with the write lock respected and
 * yields to the event loop between chunks, which matters here: better-sqlite3
 * is synchronous, so anything that holds the thread is queue time for 600
 * phones (docs/load-test.md).
 */
export async function takeSnapshot({
  config = backupConfig(),
  source = db,
  now = new Date(),
  ship = true,
} = {}) {
  const started = Date.now();
  fs.mkdirSync(config.dir, { recursive: true });

  const name = snapshotName(now);
  const finalPath = path.join(config.dir, name);
  const tmpPath = `${finalPath}.part`;

  const expect = liveCounts(source);

  try {
    await source.backup(tmpPath);
  } catch (err) {
    sealSnapshot(tmpPath);
    fs.rmSync(tmpPath, { force: true });
    return fail(config, `could not copy the database: ${err.message}`, started);
  }

  const verified = verifySnapshot(tmpPath, expect);
  if (!verified.ok) {
    /**
     * ⚠️ Deleted, not kept with a warning. A file in the snapshot directory is
     * read by everything downstream — the restore script, the panel's "last
     * backup" — as a backup. One that failed verification is worse than no file
     * at all, because it makes the count go up.
     */
    sealSnapshot(tmpPath);
    fs.rmSync(tmpPath, { force: true });
    return fail(config, `snapshot failed verification — ${verified.error}`, started);
  }

  /**
   * Identical bytes to the last one means nothing has been written since, and
   * dropping the duplicate keeps the retention window covering *changes* rather
   * than covering an idle Friday night.
   *
   * ⚠️ Expect this to fire before and after the event and almost never during
   * it: `markUsed` writes `access_codes.last_used_at` on every schedule fetch,
   * so a single phone refetching is enough to make the file differ. That is
   * measured, not assumed — two consecutive snapshots of an otherwise idle
   * development database differed by exactly those five bytes. Purely an
   * optimization either way: SQLite is not obliged to produce byte-identical
   * output for an unchanged database, and a missed match costs one file.
   */
  sealSnapshot(tmpPath);
  const hash = sha256(tmpPath);
  const state = readState(config.dir);
  const previous = latestSnapshot(config.dir);
  if (previous && state.lastHash === hash) {
    sealSnapshot(tmpPath);
    fs.rmSync(tmpPath, { force: true });
    const record = {
      ok: true,
      unchanged: true,
      name: previous.name,
      path: path.join(config.dir, previous.name),
      bytes: previous.bytes,
      counts: verified.counts,
      ms: Date.now() - started,
      at: new Date().toISOString(),
    };
    writeState(config.dir, { lastAttemptAt: record.at, lastSuccessAt: record.at, lastError: null });
    last = record;
    return record;
  }

  fs.renameSync(tmpPath, finalPath);
  const pruned = pruneSnapshots(config);
  writeState(config.dir, {
    lastHash: hash,
    lastAttemptAt: new Date().toISOString(),
    lastSuccessAt: new Date().toISOString(),
    lastError: null,
  });

  const record = {
    ok: true,
    unchanged: false,
    name,
    path: finalPath,
    bytes: verified.size,
    counts: verified.counts,
    pruned,
    ms: Date.now() - started,
    at: new Date().toISOString(),
  };

  if (ship && hasOffBoxTarget(config)) {
    const shipped = await shipSnapshot(finalPath, name, config);
    record.shipped = shipped;
    writeState(config.dir, shipped.ok ? { lastShippedAt: shipped.at, lastShippedName: name } : {});
  }

  last = record;
  return record;
}

function liveCounts(source) {
  try {
    return {
      blocks: source.prepare('SELECT COUNT(*) AS n FROM schedule_blocks').get().n,
      people: source.prepare('SELECT COUNT(*) AS n FROM people').get().n,
      teams: source.prepare('SELECT COUNT(*) AS n FROM teams').get().n,
    };
  } catch {
    return null;
  }
}

function fail(config, message, started) {
  const record = {
    ok: false,
    error: message,
    ms: Date.now() - started,
    at: new Date().toISOString(),
  };
  try {
    fs.mkdirSync(config.dir, { recursive: true });
    writeState(config.dir, { lastAttemptAt: record.at, lastError: message });
  } catch {
    /* if the directory itself is unwritable the error is already the record */
  }
  last = record;
  return record;
}

/* ------------------------------------------------------------------ *
 * Keeping the directory bounded
 * ------------------------------------------------------------------ */

export function listSnapshots(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => SNAPSHOT_RE.test(n))
    .map((name) => {
      const stat = fs.statSync(path.join(dir, name));
      return { name, bytes: stat.size, modified: stat.mtime.toISOString() };
    })
    .sort((a, b) => (a.name < b.name ? 1 : -1)); // newest first — the name sorts
}

export function latestSnapshot(dir) {
  return listSnapshots(dir)[0] ?? null;
}

/**
 * Two ceilings, and the byte one is the one that matters: the volume is 1GB and
 * the database shares it. A snapshot directory that fills the disk takes the
 * event down in the most confusing way available — writes start failing while
 * every health check still passes, because the process is fine and it is the
 * filesystem that is not.
 *
 * The newest snapshot is never pruned, whatever the limits say.
 */
export function pruneSnapshots(config) {
  const files = listSnapshots(config.dir);
  const removed = [];
  let total = 0;

  files.forEach((file, i) => {
    total += file.bytes;
    const overCount = i + 1 > config.keep;
    const overBytes = i > 0 && total > config.maxBytes;
    if (i > 0 && (overCount || overBytes)) {
      try {
        fs.rmSync(path.join(config.dir, file.name), { force: true });
        removed.push(file.name);
        total -= file.bytes;
      } catch {
        /* a file we cannot delete is not worth failing the backup over */
      }
    }
  });

  return removed;
}

/* ------------------------------------------------------------------ *
 * Getting it off the machine
 * ------------------------------------------------------------------ */

/**
 * Two mechanisms, because the honest answer to "where do the backups go" is
 * that it depends on what the event has an account for, and this decision
 * should not be re-litigated at T-2 days:
 *
 *   BACKUP_TARGET_URL   an HTTP upload — the object store's own endpoint, a
 *                       Worker in front of R2, a WebDAV box. `{name}` is
 *                       appended to the URL unless the URL contains it.
 *   BACKUP_TARGET_CMD   any command — `aws s3 cp {file} s3://…`, rclone, scp.
 *                       Covers signed object stores without a SigV4
 *                       implementation living in this repo.
 *
 * Neither is required for the app to run, and a failure here never fails the
 * snapshot: the local copy is already verified and on disk, and losing the
 * upload is a smaller problem than losing the run.
 */
export async function shipSnapshot(file, name, config = backupConfig()) {
  const at = new Date().toISOString();
  try {
    if (config.targetCmd) return { ok: true, via: 'command', at, ...(await shipViaCommand(file, name, config)) };
    if (config.targetUrl) return { ok: true, via: 'http', at, ...(await shipViaHttp(file, name, config)) };
    return { ok: false, via: 'none', at, error: 'No off-box target configured.' };
  } catch (err) {
    return { ok: false, via: config.targetCmd ? 'command' : 'http', at, error: err.message };
  }
}

async function shipViaHttp(file, name, config) {
  const base = config.targetUrl.replace(/\/+$/, '');
  const url = config.targetUrl.includes('{name}')
    ? config.targetUrl.replaceAll('{name}', encodeURIComponent(name))
    : `${base}/${encodeURIComponent(name)}`;

  const body = fs.readFileSync(file);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SHIP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: config.targetMethod,
      body,
      signal: controller.signal,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(body.length),
        ...(config.targetToken ? { authorization: `Bearer ${config.targetToken}` } : {}),
      },
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} from the backup target`);
    return { url, bytes: body.length };
  } finally {
    clearTimeout(timer);
  }
}

function shipViaCommand(file, name, config) {
  const cmd = config.targetCmd
    .replaceAll('{file}', `'${file.replaceAll("'", "'\\''")}'`)
    .replaceAll('{name}', `'${name.replaceAll("'", "'\\''")}'`);
  return new Promise((resolve, reject) => {
    execFile('/bin/sh', ['-c', cmd], { timeout: SHIP_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${cmd.split(' ')[0]}: ${(stderr || err.message).trim().slice(0, 300)}`));
      resolve({ command: cmd, output: String(stdout).trim().slice(0, 300) });
    });
  });
}

/* ------------------------------------------------------------------ *
 * The schedule, and what it looks like from outside
 * ------------------------------------------------------------------ */

let last = null;
let timer = null;
let running = false;
let consecutiveFailures = 0;

/**
 * Run the snapshotter on an interval for as long as the process lives.
 *
 * In-process rather than cron because there is no cron in the container and
 * exactly one machine to run it on; the tradeoff is that a wedged process stops
 * backing up silently, which is what `staleAfterMs` and the heartbeat in
 * `ops.js` are for.
 *
 * `onEvent` receives every run — the caller decides what is worth alerting on,
 * because "one upload failed" and "nothing has been backed up for an hour" are
 * different conversations.
 */
export function startBackups({ config = backupConfig(), onEvent = () => {} } = {}) {
  if (!config.intervalMs) return { started: false, config, stop() {} };

  const tick = async () => {
    if (running) return; // a snapshot that overran its interval is not a reason to start a second
    running = true;
    try {
      const record = await takeSnapshot({ config });
      consecutiveFailures = record.ok ? 0 : consecutiveFailures + 1;
      onEvent({ ...record, consecutiveFailures });
    } catch (err) {
      consecutiveFailures += 1;
      onEvent({ ok: false, error: err.message, at: new Date().toISOString(), consecutiveFailures });
    } finally {
      running = false;
    }
  };

  timer = setInterval(tick, config.intervalMs);
  timer.unref?.();
  // One immediately, so a deploy is followed by a known-good copy rather than
  // by a five-minute window with nothing in it.
  setTimeout(tick, 2_000).unref?.();

  return {
    started: true,
    config,
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}

/**
 * What the panel and `/api/health` report. Reads the directory rather than
 * trusting memory, so a restart does not present itself as "no backups yet".
 */
export function backupStatus(config = backupConfig()) {
  const snapshots = listSnapshots(config.dir);
  const state = readState(config.dir);
  const newest = snapshots[0] ?? null;
  const at = newest ? Date.parse(newest.modified) : null;

  /**
   * ⚠️ Staleness is measured from the last *verified run*, not from the newest
   * file. The two differ every time a run finds the database unchanged and
   * discards the duplicate — and reading the file's age there would report an
   * idle, perfectly backed-up event as stale, which is an alert at 3am about
   * nothing. Persisted in the state file, so it survives a restart; it falls
   * back to the file when there is no state to read.
   */
  const verifiedAt = state.lastSuccessAt ? Date.parse(state.lastSuccessAt) : at;
  const age = (t) => (t ? Math.max(0, Math.round((Date.now() - t) / 1000)) : null);

  return {
    enabled: config.intervalMs > 0,
    intervalMs: config.intervalMs,
    dir: config.dir,
    offBox: hasOffBoxTarget(config) ? (config.targetCmd ? 'command' : 'http') : null,
    count: snapshots.length,
    totalBytes: snapshots.reduce((n, s) => n + s.bytes, 0),
    newest,
    ageSeconds: age(at),
    verifiedAgeSeconds: age(verifiedAt),
    lastVerifiedAt: state.lastSuccessAt ?? newest?.modified ?? null,
    stale: config.intervalMs > 0 && (!verifiedAt || Date.now() - verifiedAt > staleAfterMs(config)),
    lastRun: last,
    lastError: state.lastError ?? null,
    lastShippedAt: state.lastShippedAt ?? null,
    lastShippedName: state.lastShippedName ?? null,
    consecutiveFailures,
    source: dbPath,
  };
}

/**
 * Three intervals, so one slow run or one transient upload failure is not an
 * alarm. Anything that pages during an event has to be worth walking away from
 * the check-in desk for.
 */
export function staleAfterMs(config = backupConfig()) {
  return Math.max(config.intervalMs * 3, 60_000);
}

/** Test seam: forget the in-process record of the last run. */
export function resetBackupState() {
  last = null;
  consecutiveFailures = 0;
  running = false;
  if (timer) clearInterval(timer);
  timer = null;
}
