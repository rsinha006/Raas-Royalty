#!/usr/bin/env node
/**
 * Deploy preflight — run before pushing, and again against the live machine.
 *
 *   npm run preflight                          # this shell's environment
 *   fly ssh console -C "npm run preflight"     # the environment that matters
 *
 * The second form is the one worth running. Everything this checks is
 * environment, and the environment on the machine is the only one serving
 * anyone — a green run on a laptop with a `.env` file says nothing about what
 * `fly secrets` actually holds.
 *
 * Stricter than the boot gate on purpose: warnings exit non-zero here, so the
 * pre-event checklist catches a missing PUBLIC_BASE_URL that a 2am restart is
 * deliberately allowed to boot through. See server/lib/deploy-config.js.
 */

import 'dotenv/config';

import { inspectDeployConfig, formatCheck, failing } from '../server/lib/deploy-config.js';

/**
 * Resolve the database path the way `db.js` does, without importing it — that
 * module opens the file, builds the schema and runs migrations as a side
 * effect of being imported, and a preflight check should not be able to write
 * anything to a live database.
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const appRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(appRoot, 'data', 'royalty.db');

const { production, checks } = inspectDeployConfig({ dbPath, appRoot });

console.log(`\n  Royalty deploy preflight — NODE_ENV=${process.env.NODE_ENV || '(unset)'}\n`);
for (const c of checks) console.log(`${formatCheck(c)}\n`);

/* The volume is only checkable from the machine, so check it when we are on one. */
const mount = path.dirname(dbPath);
if (production) {
  let writable = false;
  try {
    fs.accessSync(mount, fs.constants.W_OK);
    writable = true;
  } catch {
    /* reported below */
  }
  console.log(
    writable
      ? `  ✓ ${mount} is writable\n`
      : `  ✗ ${mount} is not writable by this process — the volume is missing or mounted elsewhere.\n` +
        '      Fix: fly volumes list, and check [[mounts]] destination in fly.toml.\n'
  );
  if (!writable) process.exitCode = 1;
}

const problems = failing(checks, 'warn');
if (!production) {
  console.log(
    '  NODE_ENV is not "production", so none of the above is enforced at boot.\n' +
      '  Run this on the machine (fly ssh console -C "npm run preflight") for the real answer.\n'
  );
}
if (problems.length) {
  const fatal = problems.filter((p) => p.level === 'fail').length;
  console.log(
    `  ${problems.length} check${problems.length > 1 ? 's' : ''} not passing ` +
      `(${fatal} would refuse to boot in production).\n`
  );
  process.exitCode = 1;
} else if (!process.exitCode) {
  console.log('  All checks passing.\n');
}
