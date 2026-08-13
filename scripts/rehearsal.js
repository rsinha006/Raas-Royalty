#!/usr/bin/env node
/**
 * "Can the dress rehearsal start?" — item 26's gate.
 *
 *   npm run rehearsal            the readiness report
 *   npm run rehearsal -- --check same thing, quiet, exits 1 on a blocker
 *   npm run rehearsal -- --strict  warnings count as blockers too
 *
 * Run this the morning of the rehearsal, and again on the Wednesday of the
 * freeze. It composes the checks that already exist — `preflight`, `codes
 * --check`, `callsheets --check`, the snapshot verifier — and adds the ones
 * about the event's own content, which nothing else asks: are the dates real
 * and still ahead of us, is this the roster or the placeholder, and does every
 * day of the weekend have anything on it.
 *
 * The point of the gate is narrow. It cannot tell you the rehearsal went well.
 * It tells you whether a green rehearsal would have *meant* anything — because
 * the seed data passes every test this project has, and a rehearsal against it
 * looks exactly like a rehearsal against the weekend.
 *
 * The runbook the rehearsal itself follows is docs/dress-rehearsal.md.
 */

import 'dotenv/config';

import { readinessReport, BLOCKER, WARN } from '../server/lib/readiness.js';

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const quiet = has('--check');
const strict = has('--strict');

const report = readinessReport();

const MARK = { [BLOCKER]: '✗', [WARN]: '!', ok: '✓' };

console.log(`\n  Royalty — dress rehearsal readiness`);
console.log(`  ${report.at.slice(0, 16).replace('T', ' ')}Z · links at ${report.baseUrl}\n`);

for (const c of report.checks) {
  if (quiet && c.level === 'ok') continue;
  console.log(`  ${MARK[c.level]} ${c.title}`);
  if (c.detail) console.log(`      ${c.detail}`);
  // Capped: a roster with 80 unreachable people should not push the summary
  // off the top of the terminal. The dedicated command prints all of them, and
  // it is named in `fix`.
  for (const item of c.items.slice(0, 8)) console.log(`      · ${item}`);
  if (c.items.length > 8) console.log(`      · …and ${c.items.length - 8} more.`);
  if (c.fix) console.log(`      Fix: ${c.fix}`);
  console.log('');
}

const { blockers, warnings } = report;
if (blockers) {
  console.log(
    `  ${blockers} blocker${blockers === 1 ? '' : 's'}` +
      (warnings ? ` and ${warnings} warning${warnings === 1 ? '' : 's'}` : '') +
      '. A rehearsal now would be a rehearsal of the placeholder.\n'
  );
} else if (warnings) {
  console.log(
    `  No blockers, ${warnings} warning${warnings === 1 ? '' : 's'}. ` +
      'The rehearsal can run; those gaps are what it will not cover.\n'
  );
} else {
  console.log('  Ready. Run docs/dress-rehearsal.md.\n');
}

process.exit(blockers || (strict && warnings) ? 1 : 0);
