import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Deploy configuration — checked at boot, and again from `npm run preflight`.
 *
 * Every failure this module names is one that produces a server which *looks
 * healthy*. That is the whole reason it exists. A default admin password serves
 * a perfectly good schedule to 280 people and a write-access panel to anyone
 * who reads the README; a database on the container's own filesystem serves the
 * right schedule right up until the next deploy resets the event to seed data.
 * Neither shows up in a health check, and both are found by the person they
 * happen to, at the worst possible moment.
 *
 * Two levels, and the split is deliberate:
 *
 *   fail — refuses to boot. Reserved for things that are unsafe or that lose
 *          data. Better a deploy that stops with a message than one that comes
 *          up wrong, because "up" is what everyone will check.
 *   warn — logged loudly, boots anyway. Things that are wrong but recoverable,
 *          or that depend on a hostname nobody has yet.
 *
 * ⚠️ The asymmetry matters at 2am on the Saturday. A restart under pressure
 * must not be blocked by a cosmetic check, so the boot gate is narrow on
 * purpose — but `npm run preflight` treats warnings as failures too, so the
 * pre-event checklist still catches everything. Add new checks at `warn` unless
 * booting wrong is genuinely worse than not booting.
 *
 * See docs/deploy.md for what a host has to provide, and PLAN.md item 22.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.join(__dirname, '..', '..');

/**
 * Where the built client lives. Exported because three places need to agree on
 * it — the static middleware in `app.js`, the boot check below, and the health
 * check in `ops.js`, whose whole job is to notice that this directory is
 * missing. Two of the three computing it separately is how they drift.
 */
export const CLIENT_DIST = path.join(APP_ROOT, 'client', 'dist');

/** The password `adminPassword()` falls back to. Kept in sync by a test. */
export const DEFAULT_ADMIN_PASSWORD = 'royalty-admin';

const PLACEHOLDER = /^(changeme|change-me|change_me|placeholder|secret|password|xxx+|todo|royalty[-_]?admin)$/i;

/**
 * A secret that is long but not varied is a secret someone typed. 32 hex
 * characters carry ~16 distinct ones; `aaaa…` carries one and would otherwise
 * sail past a pure length check.
 */
function looksGenerated(value) {
  return value.length >= 32 && new Set(value).size >= 8 && !PLACEHOLDER.test(value.trim());
}

function check(id, level, ok, title, detail, fix) {
  return { id, level, ok, title, detail, fix };
}

/**
 * Every deploy check, evaluated against an environment.
 *
 * Pure apart from two `fs.existsSync` calls, and takes its inputs as arguments
 * so the tests can drive it without a live process — the point of a boot gate
 * is lost if the gate itself is only exercised by booting.
 */
export function inspectDeployConfig({
  env = process.env,
  dbPath,
  appRoot = APP_ROOT,
  clientDist = CLIENT_DIST,
  nodeVersion = process.versions.node,
} = {}) {
  const production = env.NODE_ENV === 'production';
  const checks = [];

  /* ---------------------------- admin password ---------------------------- */

  const adminPassword = env.ADMIN_PASSWORD;
  const adminOk =
    Boolean(adminPassword) && adminPassword !== DEFAULT_ADMIN_PASSWORD && adminPassword.length >= 8;
  checks.push(
    check(
      'admin-password',
      'fail',
      adminOk,
      'ADMIN_PASSWORD is set to something of your own',
      adminOk
        ? 'Set, and not the published default.'
        : !adminPassword
          ? 'Unset, so the panel is open to anyone who knows the documented default.'
          : adminPassword === DEFAULT_ADMIN_PASSWORD
            ? 'Still the default from the README, which is published in this repo.'
            : 'Set, but under 8 characters.',
      'fly secrets set ADMIN_PASSWORD="$(openssl rand -base64 18)"'
    )
  );

  /* ---------------------------- session secret ---------------------------- */

  /**
   * Unset is not insecure — `auth.js` generates one and stores it in the
   * database, which persists. It is *fragile*: the key that signs every admin
   * and every viewer session then lives inside the file item 23 copies off-box
   * every few minutes, so a mislaid backup is a signing key, and rebuilding the
   * volume silently logs all 280 phones out mid-event. Pinning it in the
   * environment separates the two.
   */
  const sessionSecret = env.SESSION_SECRET;
  const secretOk = Boolean(sessionSecret) && looksGenerated(sessionSecret);
  checks.push(
    check(
      'session-secret',
      'fail',
      secretOk,
      'SESSION_SECRET is pinned to a generated value',
      secretOk
        ? `Pinned in the environment (${sessionSecret.length} characters).`
        : !sessionSecret
          ? 'Unset. Sessions would be signed with a key generated into the database itself — ' +
            'which is the file that gets backed up off-box, and which a rebuilt volume discards.'
          : 'Set, but it looks typed rather than generated (needs 32+ varied characters).',
      'fly secrets set SESSION_SECRET="$(openssl rand -hex 32)"'
    )
  );

  /* ------------------------------- database ------------------------------- */

  /**
   * The container filesystem is rebuilt by every deploy. A database on it is
   * not "lost" in any way that announces itself — the server comes up, the
   * schema builds, the schedule is empty, and the first person to notice is
   * someone looking at their phone.
   */
  const resolvedDb = dbPath ? path.resolve(dbPath) : null;
  const insideImage = resolvedDb ? !path.relative(appRoot, resolvedDb).startsWith('..') : false;
  checks.push(
    check(
      'database-path',
      'fail',
      Boolean(resolvedDb) && !insideImage,
      'The database is on a persistent volume, not in the image',
      resolvedDb
        ? insideImage
          ? `${resolvedDb} is inside the application directory, which every deploy replaces. ` +
            'The event would reset to an empty schedule on the next push, silently.'
          : `${resolvedDb}`
        : 'No database path was resolved.',
      'Set DB_PATH=/data/royalty.db and mount the volume there (see fly.toml [[mounts]]).'
    )
  );

  /* ------------------------------ client build ---------------------------- */

  /**
   * Without it `app.js` falls back to a plain-text "API is running" page — a
   * 200, so a health check and an uptime monitor both stay green while every
   * phone gets a page with no schedule on it.
   */
  const built = fs.existsSync(path.join(clientDist, 'index.html'));
  checks.push(
    check(
      'client-build',
      'fail',
      built,
      'The client bundle is built',
      built
        ? `${clientDist}`
        : `No index.html under ${clientDist}. The server would answer every phone with the ` +
          '"API is running" placeholder, and still report healthy.',
      'npm run build (the Dockerfile does this in its build stage)'
    )
  );

  /* ------------------------------ public URL ------------------------------ */

  const baseUrl = env.PUBLIC_BASE_URL;
  let baseUrlDetail = 'Unset. Access links in the CSV export fall back to whatever Host the proxy passed.';
  let baseUrlOk = false;
  if (baseUrl) {
    try {
      const parsed = new URL(baseUrl);
      baseUrlOk = parsed.protocol === 'https:' && !baseUrl.endsWith('/');
      baseUrlDetail = baseUrlOk
        ? baseUrl
        : parsed.protocol === 'https:'
          ? `${baseUrl} has a trailing slash, which doubles up in the generated links.`
          : `${baseUrl} is not https.`;
    } catch {
      baseUrlDetail = `${baseUrl} is not a URL.`;
    }
  }
  checks.push(
    check(
      'public-base-url',
      'warn',
      baseUrlOk,
      'PUBLIC_BASE_URL names the real hostname',
      baseUrlDetail,
      'fly secrets set PUBLIC_BASE_URL=https://schedule.example.org   # no trailing slash'
    )
  );

  /* ---------------------------- cookie security --------------------------- */

  const secureCookies = env.INSECURE_COOKIES !== '1';
  checks.push(
    check(
      'cookie-security',
      'warn',
      secureCookies,
      'Session cookies are marked Secure',
      secureCookies
        ? 'INSECURE_COOKIES is not set.'
        : 'INSECURE_COOKIES=1 sends the admin and viewer session cookies over plain HTTP. ' +
          'With force_https at the proxy this is never needed.',
      'Remove INSECURE_COOKIES, or set it to 0.'
    )
  );

  /* ------------------------------ trust proxy ----------------------------- */

  /**
   * Only meaningful in one direction: trusting a hop that isn't there lets a
   * client forge `X-Forwarded-For` and look like a new IP to both rate
   * limiters. Trusting none while behind a proxy is the opposite failure —
   * every attendee shares the balancer's IP, so ten fumbled codes lock out the
   * roster. HTTPS in PUBLIC_BASE_URL is the signal that a proxy terminates TLS.
   */
  const trustProxy = Number(env.TRUST_PROXY ?? 1);
  const behindProxy = baseUrlOk;
  checks.push(
    check(
      'trust-proxy',
      'warn',
      behindProxy ? trustProxy >= 1 : true,
      'TRUST_PROXY matches the number of proxies in front',
      behindProxy && trustProxy < 1
        ? 'PUBLIC_BASE_URL is https, so something terminates TLS in front of this process — ' +
          'but TRUST_PROXY=0, so every request appears to come from the proxy and the rate ' +
          'limiters key all 280 people onto one bucket.'
        : `TRUST_PROXY=${trustProxy}`,
      'TRUST_PROXY=1 behind exactly one proxy (Fly is one). 0 only if the process is exposed directly.'
    )
  );

  /* ------------------------------- keep-alive ----------------------------- */

  /**
   * The proxy must be the side that closes an idle connection. If ours closes
   * first, a phone reusing the socket in that instant gets ECONNRESET, which
   * the viewer cannot distinguish from being offline — so it renders "Offline ·
   * last known" on full signal. Item 20 reproduced roughly one per thousand
   * refetches against Node's 5s default.
   */
  const keepAlive = Number(env.KEEP_ALIVE_TIMEOUT_MS ?? 65_000);
  checks.push(
    check(
      'keep-alive',
      'warn',
      Number.isFinite(keepAlive) && keepAlive >= 61_000,
      'Keep-alive outlives the proxy idle timeout',
      `KEEP_ALIVE_TIMEOUT_MS=${keepAlive}. Fly's proxy closes idle backend connections at 60s; ` +
        'ours has to be above that so the proxy always closes first.',
      'KEEP_ALIVE_TIMEOUT_MS=65000, and lower it only to stay above a shorter proxy timeout.'
    )
  );

  /* -------------------------------- backups ------------------------------- */

  /**
   * Item 23. Both are `warn` under the rule at the top of this file — a machine
   * with no backup target still serves 280 people correctly, and refusing to
   * boot at 2am over a missing env var would be the more expensive failure.
   * `npm run preflight` is where these have to be green, and the pre-event
   * checklist in docs/ops.md is where that gets run.
   *
   * The snapshot interval defaults to five minutes in production, so the first
   * check is about *where the copies go*: a snapshot on the same volume as the
   * database it copies is a restore path for a bad import, and no protection at
   * all against losing the volume.
   */
  const backupInterval = Number(env.BACKUP_INTERVAL_MS ?? (production ? 300_000 : 0));
  const offBox = Boolean(env.BACKUP_TARGET_URL || env.BACKUP_TARGET_CMD);
  checks.push(
    check(
      'backups-off-box',
      'warn',
      offBox && backupInterval > 0,
      'Database snapshots are taken and sent off this machine',
      !backupInterval
        ? 'BACKUP_INTERVAL_MS=0 — no snapshots are being taken at all. The only copy of the ' +
          'event is the live database.'
        : offBox
          ? `Every ${Math.round(backupInterval / 1000)}s, shipped via ` +
            `${env.BACKUP_TARGET_CMD ? 'BACKUP_TARGET_CMD' : 'BACKUP_TARGET_URL'}.`
          : `Every ${Math.round(backupInterval / 1000)}s, but only onto the same volume as the ` +
            'database. That survives a bad import; it does not survive losing the volume.',
      'fly secrets set BACKUP_TARGET_URL=…  (or BACKUP_TARGET_CMD="aws s3 cp {file} s3://…"). See docs/ops.md.'
    )
  );

  /* ------------------------------- alerting ------------------------------- */

  /**
   * The heartbeat is the one that matters, and it is worth being clear why:
   * nothing running inside this process can report that this process has
   * stopped. An external dead-man's switch that pages when the pings stop is
   * the only alarm that survives the failure it is watching for.
   */
  const heartbeat = Boolean(env.HEARTBEAT_URL);
  const webhook = Boolean(env.ALERT_WEBHOOK_URL);
  checks.push(
    check(
      'alerting',
      'warn',
      heartbeat,
      'Something outside this machine notices when it stops',
      heartbeat
        ? `HEARTBEAT_URL is set${webhook ? ', and ALERT_WEBHOOK_URL for in-process errors.' : '.'}`
        : 'HEARTBEAT_URL is unset. Nothing on this machine can report that this machine is down — ' +
          'a dead-man\'s switch that pages when the pings stop is the only alarm that survives it.',
      'HEARTBEAT_URL=https://hc-ping.com/<uuid> with SMS on that check. See docs/ops.md.'
    )
  );

  /* -------------------------------- on call ------------------------------- */

  /**
   * Item 28. The alarm above pages *somebody* — this is the somebody, and it is
   * a deploy property for the same reason the webhook is: the person on call
   * for the app changes with the weekend, not with the roster.
   *
   * It is also what the printed desk sheet fills its "On call for the app" line
   * from, and an unset one prints a ruled blank instead of quietly omitting the
   * section. `warn`, because a server with no on-call name serves every phone
   * perfectly well.
   */
  const oncall = Boolean((env.ON_CALL_NAME || '').trim() && (env.ON_CALL_PHONE || '').trim());
  checks.push(
    check(
      'on-call',
      'warn',
      oncall,
      'Somebody is named as on call for the app',
      oncall
        ? `${env.ON_CALL_NAME.trim()} — ${env.ON_CALL_PHONE.trim()}`
        : 'ON_CALL_NAME / ON_CALL_PHONE unset. The heartbeat pages an unnamed person, and the ' +
          'printed desk sheet has a blank where the number should be.',
      'ON_CALL_NAME="Priya Raman" ON_CALL_PHONE="+1 555 0147" — and not somebody also running a camera.'
    )
  );

  /* ------------------------------ node version ---------------------------- */

  const major = Number(String(nodeVersion).split('.')[0]);
  checks.push(
    check(
      'node-version',
      'warn',
      Number.isFinite(major) && major >= 20,
      'Node meets the floor in package.json engines',
      `Running Node ${nodeVersion}; engines says >=20.`,
      'Use the node:22 base image the Dockerfile pins.'
    )
  );

  return { production, checks };
}

/** The checks that are not passing, at or above a level. */
export function failing(checks, level = 'fail') {
  return checks.filter((c) => !c.ok && (level === 'warn' || c.level === 'fail'));
}

/** One check as a line of console output. */
export function formatCheck(c) {
  const mark = c.ok ? '✓' : c.level === 'fail' ? '✗' : '!';
  const head = `  ${mark} ${c.title}`;
  if (c.ok) return `${head}\n      ${c.detail}`;
  return `${head}\n      ${c.detail}\n      Fix: ${c.fix}`;
}

/**
 * The boot gate. Throws on a failing `fail` check in production, logs warnings,
 * and does nothing at all anywhere else — a developer running `npm start`
 * locally is not deploying, and should not have to set six variables to see
 * their own machine.
 */
export function assertBootConfig(options = {}) {
  const { production, checks } = inspectDeployConfig(options);
  if (!production) return { production, checks };

  const log = options.log ?? console;
  const fatal = failing(checks, 'fail');
  if (fatal.length) {
    throw new Error(
      `Refusing to start — ${fatal.length} deploy check${fatal.length > 1 ? 's' : ''} failed ` +
        'in production:\n\n' +
        fatal.map(formatCheck).join('\n\n') +
        '\n\nRun `npm run preflight` for the full list. See docs/deploy.md.'
    );
  }

  const warnings = failing(checks, 'warn');
  for (const w of warnings) log.warn?.(`[config] ${w.title} — ${w.detail}\n           Fix: ${w.fix}`);
  return { production, checks, warnings };
}
