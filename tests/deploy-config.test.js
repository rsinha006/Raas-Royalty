/**
 * Item 22 — the deploy gate, and the config files it is describing.
 *
 * Everything checked here fails *quietly* in production. A default password
 * serves a correct schedule; a database inside the image serves a correct
 * schedule until the next deploy empties it; a missing client build answers 200
 * with a plain-text page, so an uptime monitor stays green while every phone
 * shows nothing. None of it throws, so the only defence is a check that runs
 * before the server serves anything — and the check itself has to be exercised
 * without booting, or it is only ever tested by the deploy it is guarding.
 *
 * The second half asserts fly.toml and the Dockerfile against the same facts.
 * They are the kind of file nobody reads again, and a single edited line in
 * either ("scale it up for the event") silently forks the database.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * A throwaway database, set before anything is imported: `auth.js` and
 * `sources.js` both reach `db.js`, which opens the file and runs migrations as
 * a side effect of being imported. Without this the suite would run against
 * whatever database the developer has in `data/`.
 */
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'royalty-deploy-'));
const TMP_DB = path.join(TMP_DIR, 'test.db');
process.env.DB_PATH = TMP_DB;
process.env.NODE_ENV = 'test';

const { inspectDeployConfig, assertBootConfig, failing, DEFAULT_ADMIN_PASSWORD } = await import(
  '../server/lib/deploy-config.js'
);
const { adminPassword } = await import('../server/lib/auth.js');
const { dataDir } = await import('../server/db.js');
const { uploadSource } = await import('../server/sync/sources.js');

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

/** A production environment with nothing wrong with it. */
const GOOD_ENV = {
  NODE_ENV: 'production',
  ADMIN_PASSWORD: 'a-real-password-nobody-published',
  SESSION_SECRET: 'f3a91c0d5e7b2846af10c93de6b5028741cd9ea3b70f5c81',
  PUBLIC_BASE_URL: 'https://schedule.example.org',
  DB_PATH: '/data/royalty.db',
  TRUST_PROXY: '1',
  KEEP_ALIVE_TIMEOUT_MS: '65000',
};

/**
 * The client build is the one check that reads the working tree, and CI builds
 * before it tests. Point it at a directory that exists with an index.html in it
 * so the other assertions aren't hostage to build order.
 */
const BUILT = { clientDist: path.join(ROOT, 'tests', 'fixtures-deploy') };

function inspect(env, extra = {}) {
  return inspectDeployConfig({
    env,
    dbPath: env.DB_PATH ?? '/data/royalty.db',
    appRoot: '/app',
    clientDist: path.join(ROOT, 'client', 'dist'),
    nodeVersion: '22.11.0',
    ...extra,
  });
}

const byId = (checks, id) => checks.find((c) => c.id === id);

describe('deploy config — what refuses to boot', () => {
  test('a clean production environment passes every check', () => {
    const { production, checks } = inspect(GOOD_ENV);
    assert.equal(production, true);
    const bad = failing(checks, 'warn').filter((c) => c.id !== 'client-build');
    assert.deepEqual(bad.map((c) => c.id), [], 'unexpected failures');
  });

  test('the default admin password is a boot failure, not a warning', () => {
    const { checks } = inspect({ ...GOOD_ENV, ADMIN_PASSWORD: DEFAULT_ADMIN_PASSWORD });
    const c = byId(checks, 'admin-password');
    assert.equal(c.ok, false);
    assert.equal(c.level, 'fail');
  });

  test('an unset admin password fails too — the fallback is the published default', () => {
    const env = { ...GOOD_ENV };
    delete env.ADMIN_PASSWORD;
    assert.equal(byId(inspect(env).checks, 'admin-password').ok, false);
  });

  /**
   * The gate names a literal, `auth.js` falls back to a literal, and if they
   * drift the gate passes a deploy whose panel opens to the old default.
   */
  test("the default the gate rejects is the one auth.js actually falls back to", () => {
    const saved = process.env.ADMIN_PASSWORD;
    delete process.env.ADMIN_PASSWORD;
    try {
      assert.equal(adminPassword(), DEFAULT_ADMIN_PASSWORD);
    } finally {
      if (saved !== undefined) process.env.ADMIN_PASSWORD = saved;
    }
  });

  test('a typed SESSION_SECRET is rejected, a generated one is not', () => {
    assert.equal(byId(inspect({ ...GOOD_ENV, SESSION_SECRET: 'changeme' }).checks, 'session-secret').ok, false);
    // Long enough, but one distinct character — a length check alone passes it.
    assert.equal(
      byId(inspect({ ...GOOD_ENV, SESSION_SECRET: 'a'.repeat(64) }).checks, 'session-secret').ok,
      false
    );
    assert.equal(byId(inspect(GOOD_ENV).checks, 'session-secret').ok, true);
  });

  test('an unset SESSION_SECRET fails: the generated one lives in the backed-up database', () => {
    const env = { ...GOOD_ENV };
    delete env.SESSION_SECRET;
    const c = byId(inspect(env).checks, 'session-secret');
    assert.equal(c.ok, false);
    assert.equal(c.level, 'fail');
  });

  /**
   * The most expensive mistake available here: it looks completely fine until
   * the deploy *after* the data is loaded.
   */
  test('a database inside the image is a boot failure', () => {
    const c = byId(inspect({ ...GOOD_ENV, DB_PATH: '/app/data/royalty.db' }).checks, 'database-path');
    assert.equal(c.ok, false);
    assert.equal(c.level, 'fail');
    assert.match(c.detail, /every deploy replaces/);
  });

  test('the default path — no DB_PATH at all — is caught as the same failure', () => {
    const env = { ...GOOD_ENV };
    delete env.DB_PATH;
    const { checks } = inspectDeployConfig({
      env,
      dbPath: '/app/data/royalty.db',
      appRoot: '/app',
      ...BUILT,
    });
    assert.equal(byId(checks, 'database-path').ok, false);
  });

  test('a path on the volume passes', () => {
    assert.equal(byId(inspect(GOOD_ENV).checks, 'database-path').ok, true);
  });

  /** 200 with no schedule on it. Green monitor, useless app. */
  test('a missing client build is a boot failure', () => {
    const { checks } = inspectDeployConfig({
      env: GOOD_ENV,
      dbPath: '/data/royalty.db',
      appRoot: '/app',
      clientDist: '/nonexistent/dist',
    });
    const c = byId(checks, 'client-build');
    assert.equal(c.ok, false);
    assert.equal(c.level, 'fail');
  });
});

describe('deploy config — what warns but still boots', () => {
  /**
   * The split is the point. A restart at 2am must not be blocked by a hostname,
   * but the pre-event checklist has to catch one. Same checks, two thresholds.
   */
  test('a missing PUBLIC_BASE_URL warns rather than refusing', () => {
    const env = { ...GOOD_ENV };
    delete env.PUBLIC_BASE_URL;
    const { checks } = inspect(env);
    const c = byId(checks, 'public-base-url');
    assert.equal(c.ok, false);
    assert.equal(c.level, 'warn');
    assert.deepEqual(failing(checks, 'fail').map((x) => x.id), []);
  });

  test('a trailing slash and a non-https base URL are both caught', () => {
    assert.equal(
      byId(inspect({ ...GOOD_ENV, PUBLIC_BASE_URL: 'https://s.example.org/' }).checks, 'public-base-url').ok,
      false
    );
    assert.equal(
      byId(inspect({ ...GOOD_ENV, PUBLIC_BASE_URL: 'http://s.example.org' }).checks, 'public-base-url').ok,
      false
    );
  });

  test('TRUST_PROXY=0 warns only when something is terminating TLS in front', () => {
    const behind = { ...GOOD_ENV, TRUST_PROXY: '0' };
    assert.equal(byId(inspect(behind).checks, 'trust-proxy').ok, false);

    const direct = { ...behind };
    delete direct.PUBLIC_BASE_URL;
    assert.equal(byId(inspect(direct).checks, 'trust-proxy').ok, true);
  });

  test('a keep-alive under the proxy idle timeout warns', () => {
    assert.equal(byId(inspect({ ...GOOD_ENV, KEEP_ALIVE_TIMEOUT_MS: '5000' }).checks, 'keep-alive').ok, false);
    // Node's default, which item 20 showed resetting connections, must not pass.
    const env = { ...GOOD_ENV };
    delete env.KEEP_ALIVE_TIMEOUT_MS;
    assert.equal(byId(inspect(env).checks, 'keep-alive').ok, true, 'our own default should pass');
  });

  test('INSECURE_COOKIES=1 warns', () => {
    assert.equal(byId(inspect({ ...GOOD_ENV, INSECURE_COOKIES: '1' }).checks, 'cookie-security').ok, false);
  });
});

describe('the boot gate itself', () => {
  test('throws in production, naming the failure and its fix', () => {
    assert.throws(
      () =>
        assertBootConfig({
          env: { ...GOOD_ENV, ADMIN_PASSWORD: DEFAULT_ADMIN_PASSWORD },
          dbPath: '/data/royalty.db',
          appRoot: '/app',
          ...BUILT,
        }),
      (err) => {
        assert.match(err.message, /Refusing to start/);
        assert.match(err.message, /ADMIN_PASSWORD/);
        assert.match(err.message, /fly secrets set/);
        return true;
      }
    );
  });

  /**
   * Development is not a deploy. Requiring six variables to run `npm start` on
   * a laptop would mean the gate gets disabled rather than fixed.
   */
  test('does nothing outside production, however broken the config is', () => {
    const result = assertBootConfig({
      env: { ADMIN_PASSWORD: DEFAULT_ADMIN_PASSWORD },
      dbPath: '/app/data/royalty.db',
      appRoot: '/app',
      clientDist: '/nonexistent',
    });
    assert.equal(result.production, false);
  });

  test('warnings are logged, not thrown', () => {
    const lines = [];
    const env = { ...GOOD_ENV };
    delete env.PUBLIC_BASE_URL;
    const result = assertBootConfig({
      env,
      dbPath: '/data/royalty.db',
      appRoot: '/app',
      log: { warn: (m) => lines.push(m) },
      ...BUILT,
    });
    assert.equal(result.warnings.length, 1);
    assert.match(lines[0], /PUBLIC_BASE_URL/);
  });
});

/**
 * The deploy-shaped bug that has no local symptom at all: in development the
 * source tree and the data directory are the same folder, so writing persistent
 * state relative to `__dirname` works perfectly — right up until the machine,
 * where the database is on a mounted volume and the application directory is
 * rebuilt by every deploy.
 */
describe('persistent state follows the database, not the source tree', () => {
  test('dataDir is the database\'s directory', () => {
    assert.equal(dataDir, TMP_DIR);
    assert.notEqual(path.resolve(dataDir), path.join(ROOT, 'data'));
  });

  /**
   * The re-sync cache was the one that had drifted. An admin uploads the
   * workbook, Force Re-sync works, and then the next deploy turns it into "No
   * spreadsheet has been uploaded yet" with the file gone.
   */
  test('the last-upload cache is written beside the database', () => {
    /**
     * Compared before and after rather than asserted absent: a developer's own
     * `data/` usually holds a real one from working on the importer, and the
     * claim being tested is that this call cannot reach it.
     */
    const inTree = path.join(ROOT, 'data', 'last-import.csv');
    const before = fs.existsSync(inTree) ? fs.statSync(inTree).mtimeMs : null;

    uploadSource.remember(Buffer.from('day,activity\nFri,Load in\n'), 'schedule.csv');

    assert.ok(
      fs.existsSync(path.join(TMP_DIR, 'last-import.csv')),
      'the re-sync cache did not land next to the database'
    );
    assert.equal(uploadSource.canPull(), true);
    assert.equal(uploadSource.lastUpload().filename, 'schedule.csv');

    const after = fs.existsSync(inTree) ? fs.statSync(inTree).mtimeMs : null;
    assert.equal(after, before, 'the upload cache reached the checked-out tree');
  });

  test('nothing under server/ writes relative to __dirname', () => {
    const writes = /(?:writeFileSync|createWriteStream|appendFileSync|mkdirSync)/;
    for (const rel of ['server/sync/sources.js', 'server/db.js']) {
      for (const line of read(rel).split('\n')) {
        if (writes.test(line) && !line.trim().startsWith('*')) {
          assert.doesNotMatch(line, /__dirname/, `${rel}: ${line.trim()}`);
        }
      }
    }
  });
});

describe('fly.toml matches what the app needs', () => {
  const fly = read('fly.toml');

  /**
   * ⚠️ The one that forks the database. A Fly volume belongs to a single
   * machine, so a second machine gets a second, empty one — two schedules
   * behind one hostname, and nothing in either looks wrong.
   */
  test('the app never idles and never scales past one machine', () => {
    assert.match(fly, /auto_stop_machines\s*=\s*false/);
    assert.match(fly, /min_machines_running\s*=\s*1/);
    assert.doesNotMatch(fly, /min_machines_running\s*=\s*[2-9]/);
  });

  test('the database is configured onto the mounted volume', () => {
    assert.match(fly, /DB_PATH\s*=\s*"\/data\/royalty\.db"/);
    assert.match(fly, /destination\s*=\s*"\/data"/);
  });

  test('HTTPS is forced and the health check points at a real route', () => {
    assert.match(fly, /force_https\s*=\s*true/);
    assert.match(fly, /path\s*=\s*"\/api\/health"/);
    assert.match(read('server/routes/public.js'), /router\.get\('\/health'/);
  });

  test('the timezone is an IANA name, which the server would refuse otherwise', () => {
    const zone = fly.match(/EVENT_TIMEZONE\s*=\s*"([^"]+)"/)?.[1];
    assert.ok(zone?.includes('/'), `EVENT_TIMEZONE=${zone} is not a region name`);
    assert.doesNotThrow(() => new Intl.DateTimeFormat('en-US', { timeZone: zone }));
  });

  test('keep-alive stays above the proxy idle timeout', () => {
    const ms = Number(fly.match(/KEEP_ALIVE_TIMEOUT_MS\s*=\s*"(\d+)"/)?.[1]);
    assert.ok(ms >= 61_000, `KEEP_ALIVE_TIMEOUT_MS=${ms} is at or below the 60s proxy timeout`);
  });

  /** Secrets in a committed file is the mistake this asserts against. */
  test('no secret values are committed in fly.toml', () => {
    assert.doesNotMatch(fly, /^\s*ADMIN_PASSWORD\s*=/m);
    assert.doesNotMatch(fly, /^\s*SESSION_SECRET\s*=/m);
  });

  test('the port fly routes to is the port the server listens on', () => {
    const internal = fly.match(/internal_port\s*=\s*(\d+)/)?.[1];
    const env = fly.match(/PORT\s*=\s*"(\d+)"/)?.[1];
    assert.equal(internal, env);
  });
});

describe('the image', () => {
  const dockerfile = read('Dockerfile');
  const dockerignore = read('.dockerignore');

  /**
   * Node installs no default SIGTERM handler at PID 1, so a shell-form CMD (or
   * any wrapper) puts /bin/sh there and the signal is ignored — every deploy
   * then waits out the kill timeout and the WAL is never checkpointed.
   */
  test('the server is PID 1, in exec form, and handles SIGTERM', () => {
    assert.match(dockerfile, /CMD \["node", "server\/index\.js"\]/);
    assert.match(read('server/index.js'), /process\.on\('SIGTERM'/);
  });

  test('the build and runtime stages share a base image', () => {
    const bases = [...dockerfile.matchAll(/^FROM (\S+) AS/gm)].map((m) => m[1]);
    assert.equal(bases.length, 2);
    assert.equal(bases[0], bases[1], 'better-sqlite3 is compiled in one stage and run in the other');
  });

  test('the runtime sets NODE_ENV=production, which is what arms the boot gate', () => {
    assert.match(dockerfile, /ENV NODE_ENV=production/);
  });

  test('participant data and local databases cannot enter the image', () => {
    for (const pattern of ['data/', 'samples/', '.env', '/*.xlsx']) {
      assert.ok(
        dockerignore.split('\n').some((l) => l.trim() === pattern),
        `.dockerignore is missing ${pattern}`
      );
    }
  });
});
