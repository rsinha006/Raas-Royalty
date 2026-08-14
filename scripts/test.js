#!/usr/bin/env node
/**
 * Run the test suite — recursively, on every Node in the matrix.
 *
 *   npm test
 *
 * This exists because there is **no single `node --test` argument that is both
 * recursive and correct on Node 20 and Node 24**, and the two fail in opposite
 * directions. Measured on 2026-08-13 against a fixture holding one flat and one
 * nested test file:
 *
 *   argument                  Node 20              Node 24
 *   ------------------------  -------------------  -------------------
 *   tests                     both (recurses)      nothing: resolves
 *                                                  `tests` as a module
 *   "tests/**\/*.test.js"      nothing: no glob     both (recurses)
 *                             support before 21
 *   tests/*.test.js           flat only            flat only
 *                             (shell-expanded)     (shell-expanded)
 *
 * `engines` is `>=20` and the CI matrix is 20 and 22, so picking either of the
 * first two forms means one leg of the matrix silently stops testing. The third
 * is what the repo shipped, and it is not recursive.
 *
 * ⚠️ **The guard below is the point of this file, not the recursion.** The
 * original bug (item 19, `ec195cd`) was not that a pattern was wrong — it was
 * that a pattern matching *nothing* is not an error: `node --test` with no
 * files reports `pass 0, fail 0` and **exits 0**, so the Node 20 leg reported
 * green while running zero tests until item 20 grew the suite enough to make it
 * fail for an unrelated reason. Finding no tests is therefore a failure here,
 * loudly, because every mitigation in PLAN.md's risk table is a number of tests.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIR = path.join(ROOT, 'tests');

/** Every `*.test.js` under `tests/`, at any depth. Sorted, so runs compare. */
function findTests(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findTests(full));
    else if (entry.name.endsWith('.test.js')) out.push(full);
  }
  return out.sort();
}

const files = fs.existsSync(TEST_DIR) ? findTests(TEST_DIR) : [];

if (!files.length) {
  console.error(
    `No test files found under ${path.relative(ROOT, TEST_DIR)}/.\n` +
      'Refusing to exit 0: a suite that does not run and a suite that passes ' +
      'are the same colour on CI, which is the failure this script exists to ' +
      'prevent. See PLAN.md item 19.'
  );
  process.exit(1);
}

const res = spawnSync(process.execPath, ['--test', ...files], {
  cwd: ROOT,
  stdio: 'inherit',
});

if (res.error) {
  console.error(`Could not start the test runner: ${res.error.message}`);
  process.exit(1);
}
// A signal death (a timeout kill, an OOM) has a null status and must not read
// as success — `process.exit(null)` would exit 0.
process.exit(res.status ?? 1);
