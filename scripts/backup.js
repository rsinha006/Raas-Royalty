#!/usr/bin/env node
/**
 * Take one verified snapshot now — PLAN.md item 23.
 *
 *   npm run backup                              # this machine's database
 *   fly ssh console -C "npm run backup"         # the one that matters
 *   npm run backup -- --list                    # what is already kept
 *   npm run backup -- --no-ship                 # local copy only
 *
 * The server takes these on a timer by itself; this is for the moments when
 * five minutes is too long to wait — immediately before an import, a bulk
 * shift, or anything else that is easier to undo from a file than from memory.
 *
 * Prints where the copy went and what is inside it, because "backup complete"
 * with no counts is exactly the reassurance that turns out to be false.
 */

import 'dotenv/config';

import {
  backupConfig,
  backupStatus,
  hasOffBoxTarget,
  listSnapshots,
  takeSnapshot,
} from '../server/lib/backup.js';

const args = process.argv.slice(2);
const config = backupConfig();

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

if (args.includes('--list')) {
  const status = backupStatus(config);
  const files = listSnapshots(config.dir);
  console.log(`\n  ${config.dir}`);
  console.log(
    `  ${files.length} snapshot${files.length === 1 ? '' : 's'}, ${mb(status.totalBytes)}` +
      `${status.offBox ? ` · off-box via ${status.offBox}` : ' · nothing off-box'}\n`
  );
  for (const f of files) console.log(`    ${f.name}  ${mb(f.bytes)}  ${f.modified}`);
  if (!files.length) console.log('    (none yet)');
  console.log('');
  process.exit(0);
}

const ship = !args.includes('--no-ship');
const record = await takeSnapshot({ config, ship });

if (!record.ok) {
  console.error(`\n  ✗ ${record.error}\n`);
  process.exit(1);
}

const { blocks, people, teams, codes } = record.counts;
console.log(`\n  ✓ ${record.unchanged ? 'Unchanged since the last snapshot' : record.path}`);
console.log(`      ${mb(record.bytes)} · ${blocks} blocks, ${people} people, ${teams} teams, ${codes} codes`);
console.log(`      verified with PRAGMA integrity_check in ${record.ms}ms`);

if (record.shipped) {
  console.log(
    record.shipped.ok
      ? `      shipped off-box via ${record.shipped.via}`
      : `  ! not shipped off-box: ${record.shipped.error}`
  );
} else if (!hasOffBoxTarget(config)) {
  console.log('  ! No off-box target configured, so this copy lives on the same volume as the');
  console.log('    database it copies. Set BACKUP_TARGET_URL or BACKUP_TARGET_CMD — docs/ops.md.');
}
console.log('');
