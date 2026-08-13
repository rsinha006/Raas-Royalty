#!/usr/bin/env node
/**
 * "Freeze on the Wednesday before" — item 27's gate, and the tag itself.
 *
 *   npm run freeze                    the report: can this be frozen, what is frozen now
 *   npm run freeze -- --tag           run the gate, then cut the annotated tag
 *   npm run freeze -- --check         quiet; exits 1 on a blocker
 *   npm run freeze -- --url https://… also ask a running server which release it holds
 *   npm run freeze -- --no-verify     skip the build and tests (they are the slow part)
 *   npm run freeze -- --tag --force   tag despite a non-fatal blocker, recorded in the tag
 *
 * The report is deliberately not only a pre-freeze question. Run it again on
 * the Saturday and it answers the one that matters then: *how many commits have
 * landed since the tag, and is the machine running the release we froze?* A
 * freeze that cannot be checked afterwards is a note in a calendar.
 *
 * ⚠️ `--force` cannot reach the working-tree check. Tagging a dirty tree
 * produces a release whose contents exist nowhere, and the fix for that is
 * always "commit it".
 *
 * Runbook, and what counts as a genuine emergency: docs/freeze.md.
 */

import 'dotenv/config';
import { spawnSync } from 'node:child_process';

import {
  BLOCKER,
  WARN,
  askRunningRelease,
  createFreezeTag,
  deployCommand,
  freezeReport,
  freezeTagMessage,
} from '../server/lib/freeze.js';

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  if (i === -1) return null;
  const inline = argv[i].includes('=') ? argv[i].split('=').slice(1).join('=') : null;
  return inline ?? argv[i + 1] ?? null;
};

const quiet = has('--check');
const wantsTag = has('--tag');
const force = has('--force');
const verify = !has('--no-verify');
const url = valueOf('--url') ?? process.env.PUBLIC_BASE_URL ?? null;

/* ----------------------------- the slow half ----------------------------- */

/**
 * `npm run ci` — the client typecheck, the client build, then the tests.
 *
 * Captured rather than inherited so a green run is one line. A red one prints
 * its tail, because the freeze is exactly the moment somebody needs to see
 * which test broke without running it again.
 */
function runCi() {
  process.stdout.write('  Running npm run ci (build + tests)… ');
  const started = Date.now();
  const res = spawnSync('npm', ['run', 'ci'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const seconds = Math.round((Date.now() - started) / 1000);
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  const pass = /^# pass (\d+)$/m.exec(output)?.[1];
  const fail = /^# fail (\d+)$/m.exec(output)?.[1];
  const ok = res.status === 0;

  console.log(ok ? `green in ${seconds}s` : `FAILED in ${seconds}s`);
  if (!ok) {
    console.log('');
    for (const line of output.trimEnd().split('\n').slice(-40)) console.log(`      ${line}`);
    console.log('');
  }

  return {
    ran: true,
    ok,
    detail: ok
      ? `npm run ci green${pass ? ` — ${pass} tests` : ''} (${seconds}s).`
      : `npm run ci exited ${res.status}${fail && fail !== '0' ? `, ${fail} failing` : ''}.`,
  };
}

/* -------------------------------- report --------------------------------- */

console.log('\n  Royalty — release freeze\n');

const verification = verify ? runCi() : null;
const running = url ? await askRunningRelease(url) : null;

const report = freezeReport({ verification, running });
const MARK = { [BLOCKER]: '✗', [WARN]: '!', ok: '✓' };

console.log('');
for (const c of report.checks) {
  if (quiet && c.level === 'ok') continue;
  console.log(`  ${MARK[c.level]} ${c.title}`);
  if (c.detail) console.log(`      ${c.detail}`);
  for (const item of c.items.slice(0, 8)) console.log(`      · ${item}`);
  if (c.items.length > 8) console.log(`      · …and ${c.items.length - 8} more.`);
  if (c.fix) console.log(`      Fix: ${c.fix}`);
  console.log('');
}

/* --------------------------------- tag ----------------------------------- */

if (!wantsTag) {
  if (report.canFreeze) {
    console.log(`  Ready to freeze as ${report.nextTag}.\n`);
    console.log('  npm run freeze -- --tag\n');
  } else {
    console.log(
      `  ${report.blockers} blocker${report.blockers === 1 ? '' : 's'}. ` +
        'Freezing now would tag something nobody should be running.\n'
    );
  }
  if (report.latestFreeze) {
    console.log(`  Currently frozen at ${report.latestFreeze}. Deploy it with:\n`);
    console.log(
      `${deployCommand(report.latestFreeze, report.git.commit)
        .split('\n')
        .map((l) => `  ${l}`)
        .join('\n')}\n`
    );
  }
  process.exit(report.blockers ? 1 : 0);
}

/**
 * ⚠️ Two different refusals, and the difference is the point. A dirty tree is
 * refused outright — `--force` is not offered, because the tag would name
 * contents that exist nowhere. Everything else is a judgement somebody at the
 * event may legitimately override, and the override is written into the tag so
 * that the next person reads it rather than discovering it.
 */
if (report.fatal) {
  console.log('  Refusing to tag: the working tree is not clean.\n');
  console.log('  Commit or stash first. --force does not apply here — a tag over a dirty');
  console.log('  tree points at code that was never run.\n');
  process.exit(1);
}

const overrides = report.checks.filter((c) => c.level === BLOCKER).map((c) => c.key);

if (overrides.length && !force) {
  console.log(
    `  Refusing to tag: ${overrides.length} blocker${overrides.length === 1 ? '' : 's'} ` +
      `(${overrides.join(', ')}).\n`
  );
  console.log('  Fix them, or --force if this is a genuine emergency — the override is');
  console.log('  recorded in the tag message.\n');
  process.exit(1);
}

const tag = report.nextTag;
const message = freezeTagMessage({ tag, report, verification, overrides });
const result = createFreezeTag(tag, message);

if (!result.ok) {
  console.log(`  Could not create the tag: ${result.error}\n`);
  process.exit(1);
}

console.log(`  Frozen as ${tag}.\n`);
console.log('  Push it, so the release exists somewhere other than this laptop:\n');
console.log(`    git push origin ${tag}\n`);
console.log('  Then deploy it. ⚠️ The build args are the only way the image can say');
console.log('  what it is — a plain `fly deploy` produces a machine that cannot:\n');
console.log(
  `${deployCommand(tag, report.git.commit)
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n')}\n`
);
console.log('  Afterwards, confirm the machine is holding it:\n');
console.log(`    npm run freeze -- --check --no-verify --url ${url ?? 'https://<host>'}\n`);
console.log('  From here on, docs/freeze.md.\n');
