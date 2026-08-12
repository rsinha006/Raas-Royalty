#!/usr/bin/env node
/**
 * Put a snapshot back — PLAN.md item 23.
 *
 *   npm run restore                                  # what is available
 *   npm run restore -- royalty-20260808-131500Z.db   # dry run: what it holds
 *   npm run restore -- <name> --yes                  # actually do it
 *   npm run restore -- /path/to/downloaded.db --yes  # a copy from off-box
 *
 * ⚠️ **This is the half of item 23 that is easy to skip and impossible to
 * improvise.** A backup nobody has restored is a hypothesis. The procedure is
 * in docs/ops.md and it is meant to be *practised* at the dress rehearsal
 * (item 26), not read for the first time while 280 people are waiting.
 *
 * Three things this does that a `cp` does not:
 *
 *   1. Verifies the snapshot *before* touching anything, so a corrupt file
 *      cannot replace a working database.
 *   2. Sets the live database aside rather than overwriting it — the current
 *      state is evidence, and it is the only copy of whatever happened between
 *      the snapshot and now.
 *   3. Moves the WAL and SHM files out of the way. Leaving a stale `-wal`
 *      beside a restored database is how a restore appears to succeed and then
 *      serves a mixture of both.
 */

import fs from 'node:fs';
import path from 'node:path';

import 'dotenv/config';

import { backupConfig, listSnapshots, verifySnapshot } from '../server/lib/backup.js';

const args = process.argv.slice(2);
const confirmed = args.includes('--yes');
const target = args.find((a) => !a.startsWith('--'));
const config = backupConfig();

/**
 * Resolve the database path the way `db.js` does, without importing it — that
 * module opens the file and runs migrations as a side effect of being imported,
 * and a restore must not have written to the database it is about to replace.
 */
const dbPath = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.resolve(new URL('../data/royalty.db', import.meta.url).pathname);

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

if (!target) {
  const files = listSnapshots(config.dir);
  console.log(`\n  Restore into: ${dbPath}`);
  console.log(`  Snapshots in ${config.dir}:\n`);
  for (const f of files) console.log(`    ${f.name}  ${mb(f.bytes)}  ${f.modified}`);
  if (!files.length) {
    console.log('    (none — check BACKUP_DIR, or fetch a copy from the off-box target)');
  }
  console.log('\n  npm run restore -- <name>          # inspect it');
  console.log('  npm run restore -- <name> --yes    # replace the live database\n');
  process.exit(files.length ? 0 : 1);
}

const source = fs.existsSync(target) ? path.resolve(target) : path.join(config.dir, target);
if (!fs.existsSync(source)) {
  console.error(`\n  ✗ No such snapshot: ${target}\n`);
  process.exit(1);
}

const verified = verifySnapshot(source);
if (!verified.ok) {
  console.error(`\n  ✗ ${source}\n    is not a usable snapshot — ${verified.error}\n`);
  process.exit(1);
}

const { blocks, people, teams, codes } = verified.counts;
console.log(`\n  ${source}`);
console.log(`    ${mb(verified.size)} · ${blocks} blocks, ${people} people, ${teams} teams, ${codes} codes`);
console.log('    integrity_check: ok');

if (!confirmed) {
  console.log('\n  Dry run. Nothing has been changed.');
  console.log('  Stop the server first, then re-run with --yes:\n');
  console.log(`    npm run restore -- ${path.basename(source)} --yes\n`);
  process.exit(0);
}

/**
 * ⚠️ The server has to be stopped. SQLite will happily let a second process
 * rename the file out from under an open connection, and the running server
 * keeps writing to the descriptor it already holds — so the restore appears to
 * work and is undone by the next checkpoint. There is no reliable way to detect
 * the running process from here, so it is stated rather than checked; on Fly
 * the sequence is `fly machine stop` before this and `fly machine start` after.
 */
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z').replace('T', '-');
const asideDir = path.join(path.dirname(dbPath), 'replaced');
fs.mkdirSync(asideDir, { recursive: true });

let setAside = null;
if (fs.existsSync(dbPath)) {
  setAside = path.join(asideDir, `royalty-replaced-${stamp}.db`);
  fs.renameSync(dbPath, setAside);
}
for (const suffix of ['-wal', '-shm']) {
  const extra = `${dbPath}${suffix}`;
  if (fs.existsSync(extra)) fs.renameSync(extra, path.join(asideDir, `royalty-replaced-${stamp}.db${suffix}`));
}

fs.copyFileSync(source, dbPath);

const after = verifySnapshot(dbPath);
if (!after.ok) {
  console.error(`\n  ✗ The restored file does not verify in place — ${after.error}`);
  console.error(`    The previous database is at ${setAside}\n`);
  process.exit(1);
}

console.log(`\n  ✓ Restored into ${dbPath}`);
if (setAside) console.log(`    The database that was there is at ${setAside}`);
console.log('    Start the server. Migrations run on boot, so an older snapshot is brought forward.');
console.log('    Then check: npm run codes -- --check, and open one magic link.\n');
