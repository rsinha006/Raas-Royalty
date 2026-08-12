import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import { runMigrations } from './migrate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, '..', 'data', 'royalty.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

/**
 * Schema first, then the changes a populated database needs. Both run on every
 * boot and both are idempotent, so upgrading is a restart.
 */
const migrated = runMigrations(db);
if (migrated.length) console.log(`[db] migrated: ${migrated.join(', ')}`);

export const dbPath = DB_PATH;

/**
 * The directory holding the database — and therefore the one directory in the
 * deploy that survives a restart.
 *
 * ⚠️ Anything else that has to persist belongs beside the database, derived
 * from here, never from `__dirname`. In development the two are the same
 * `data/` folder, which is exactly why getting this wrong is invisible until
 * it is deployed: on the machine the app directory is rebuilt by every deploy,
 * so a file written relative to the source tree is silently discarded on the
 * next push. See docs/deploy.md.
 */
export const dataDir = path.dirname(DB_PATH);

/**
 * `db.prepare` for SQL whose *shape* is fixed but whose text is built per call.
 *
 * The personalized schedule ORs over one clause per block target, so its SQL
 * text depends on how many targets a session has — which meant compiling the
 * statement afresh on every request. Compiling costs more than running it
 * (~30µs against ~3µs for the version lookup), and with better-sqlite3 being
 * synchronous, every microsecond on this path is queue time for the next of 600
 * phones refetching. Measured by the item 20 load test.
 *
 * ⚠️ Only for SQL assembled from a fixed vocabulary — here, a count of
 * placeholders. Never key this on anything a request supplies: values belong in
 * parameters, and a cache keyed on caller-controlled text would grow without
 * bound. Populated lazily after migrations have run, so no cached statement can
 * outlive a table rebuild.
 */
const statementCache = new Map();

export function prepareCached(sql) {
  let stmt = statementCache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    statementCache.set(sql, stmt);
  }
  return stmt;
}

/** Monotonic-ish id that stays readable in the edit log. */
export function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function getMeta(key, fallback = null) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setMeta(key, value) {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

/**
 * The event-wide timestamp: when anything last changed anywhere. Bumped by
 * every write path — manual edit, import, or live sheet sync.
 *
 * This is the admin panel's "last schedule change" and the socket's greeting.
 * It is deliberately *not* what a participant sees any more; see
 * `versionForTargets`.
 */
export function touchScheduleVersion() {
  const ts = nowIso();
  setMeta('schedule_updated_at', ts);
  return ts;
}

export function scheduleUpdatedAt() {
  return getMeta('schedule_updated_at', nowIso());
}

/**
 * Mark these block targets as having just changed.
 *
 * Called with the same target list that becomes socket rooms, so "who hears
 * about this block", "whose schedule contains it" and "whose last-updated moves"
 * stay one computation rather than three that drift.
 */
const bumpTarget = db.prepare(
  `INSERT INTO target_versions (target_type, target_id, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(target_type, target_id) DO UPDATE SET updated_at = excluded.updated_at`
);

export function touchTargets(targets, at = nowIso()) {
  for (const t of targets || []) {
    if (t && t.type && t.id) bumpTarget.run(t.type, t.id, at);
  }
  return at;
}

/**
 * Roster-wide changes — a renamed team, a reassigned contact card, a moved
 * event day — have no block to derive an audience from and can change what any
 * schedule renders. They raise a floor under everyone's timestamp instead.
 */
export function touchRosterVersion() {
  const ts = nowIso();
  setMeta('roster_updated_at', ts);
  return ts;
}

/**
 * The "Last updated" one session should see: the newest of its own targets, or
 * the roster-wide floor if that is later.
 *
 * ⚠️ **The last fallback must stay a value that writes do not move.** It used to
 * be `scheduleUpdatedAt()`, which every write bumps — so a target with no row
 * did not read as stale, it read as *freshly changed by somebody else's edit*,
 * which is exactly the ~280-phones bug this whole mechanism exists to kill. A
 * missed `touchTargets` would have restored the old behaviour for that subject
 * with no null, no error, and nothing to notice. The epoch is written once and
 * never again, so the same mistake now shows up as a timestamp stuck in the
 * past — wrong in a direction someone reports.
 */
export function versionForTargets(targets) {
  const list = (targets || []).filter((t) => t && t.type && t.id);
  let newest = getMeta('roster_updated_at');
  if (list.length) {
    const clause = list.map(() => '(target_type = ? AND target_id = ?)').join(' OR ');
    const row = prepareCached(
      `SELECT MAX(updated_at) AS at FROM target_versions WHERE ${clause}`
    ).get(...list.flatMap((t) => [t.type, t.id]));
    if (row?.at && (!newest || row.at > newest)) newest = row.at;
  }
  return newest || getMeta('target_versions_epoch') || scheduleUpdatedAt();
}
