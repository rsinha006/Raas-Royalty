/**
 * Is this event ready to be rehearsed against, and then run — PLAN.md item 26.
 *
 * The dress rehearsal is the one step in this plan that finds what the plan
 * missed, and it only does that if it runs against **the real weekend**. A
 * rehearsal against the seed proves the software works and proves nothing about
 * the event: every code resolves, every phone updates, every colour is right,
 * and not one of the 280 people who will actually be there is in the database.
 * That failure is completely silent — a green rehearsal is exactly what it looks
 * like.
 *
 * So this file asks the questions that have no other home. Most of what a
 * rehearsal needs is already checked somewhere:
 *
 *   deploy configuration   → `deploy-config.js`  (`npm run preflight`)
 *   codes and recipients   → `access-codes.js` + `distribution.js`  (`npm run codes -- --check`)
 *   the printed pack       → `call-sheets.js`  (`npm run callsheets -- --check`)
 *   snapshots              → `backup.js`
 *
 * ⚠️ **This file composes those rather than re-implementing them.** Four
 * readiness checks that agree with each other and disagree with the code they
 * describe is a worse outcome than no readiness check at all — the whole point
 * is to be believed on the morning of the rehearsal. What is genuinely new here
 * is the event *content*: the dates, whether the roster is real or still the
 * placeholder, and whether every day of the weekend has anything on it.
 *
 * Levels, and why there are three:
 *
 *   `blocker`  the rehearsal cannot answer its question. Run it and you learn
 *              something about the seed data.
 *   `warn`     it can run, but a known gap will be missing from what it covers.
 *   `ok`       nothing to say.
 *
 * `warn` exists because the rehearsal is scheduled at T-1 week and the roster
 * habitually lands later than that. A gate that refuses to distinguish "no real
 * dates" from "no off-box backup target" gets ignored wholesale, and then so
 * does the blocker.
 */
import path from 'node:path';

import { db, dbPath as liveDbPath } from '../db.js';
import { eventTimezone, wallClockAt } from './event-time.js';
import { parseIsoDate, weekdayOf } from './event-days.js';
import {
  codeForSubject,
  listCodes,
  orphanedCodes,
  subjectsNeedingCodes,
} from './access-codes.js';
import { distributionPlan } from './distribution.js';
import { buildCallSheets } from './call-sheets.js';
import { backupStatus, latestSnapshot, backupConfig, verifySnapshot } from './backup.js';
import { failing, inspectDeployConfig } from './deploy-config.js';

export const BLOCKER = 'blocker';
export const WARN = 'warn';
export const OK = 'ok';

const RANK = { [BLOCKER]: 0, [WARN]: 1, [OK]: 2 };

const check = (key, level, title, { detail = null, fix = null, items = [] } = {}) => ({
  key,
  level,
  title,
  detail,
  fix,
  items,
});

/* ------------------------------------------------------------------ *
 * The event's own content — the part nothing else checks
 * ------------------------------------------------------------------ */

/** Today's date in the venue's zone, not this laptop's. */
export function venueToday(at = new Date(), zone = eventTimezone()) {
  const w = wallClockAt(at, zone);
  return `${String(w.year).padStart(4, '0')}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')}`;
}

const DAY_MS = 86_400_000;

/**
 * The dates.
 *
 * Three separate ways this goes wrong, and they are reported as one check
 * because the fix is the same command:
 *
 *   - **The weekend is in the past.** The placeholder is 2026-08-07 and has
 *     been since it was written; every screen in the app renders it as a
 *     perfectly ordinary schedule with nothing "now" and nothing "next". This
 *     is the check the project has needed since item 9 and has never had.
 *   - **A date is not the weekday it claims to be.** `npm run days` refuses to
 *     *write* one, but a database re-dated by hand at 2am has no such guard, and
 *     a Saturday grid dated on a Friday is invisible on a phone.
 *   - **The days are not contiguous.** Teams land on the first day and fly out
 *     on the last; a gap means somebody's flight is on a day the app does not
 *     have.
 */
export function checkEventDates({ at = new Date(), zone = eventTimezone() } = {}) {
  const days = db
    .prepare('SELECT key, label, date, sort_order FROM event_days ORDER BY sort_order, date')
    .all();

  if (!days.length) {
    return check('dates', BLOCKER, 'This database has no event days.', {
      fix: 'Seed it, or import the workbook — see docs/loading-data.md.',
    });
  }

  const problems = [];
  for (const d of days) {
    const parsed = parseIsoDate(d.date);
    if (!parsed) {
      problems.push(`${d.key} has "${d.date}", which is not a real date.`);
      continue;
    }
    const actual = weekdayOf(parsed);
    if (actual.toLowerCase() !== String(d.label).toLowerCase()) {
      problems.push(`${d.key} is dated ${d.date}, which is a ${actual}, not a ${d.label}.`);
    }
  }

  const dated = days.map((d) => parseIsoDate(d.date)).filter(Boolean);
  for (let i = 1; i < dated.length; i += 1) {
    const gap = (dated[i] - dated[i - 1]) / DAY_MS;
    if (gap !== 1) {
      problems.push(
        `${days[i - 1].key} and ${days[i].key} are ${gap} days apart — the event days must be contiguous.`
      );
    }
  }

  const today = venueToday(at, zone);
  const first = days[0].date;
  const last = days[days.length - 1].date;
  const span = `${first} → ${last}`;

  if (problems.length) {
    return check('dates', BLOCKER, `The event dates do not describe a weekend (${span}).`, {
      items: problems,
      fix: 'npm run days -- --friday YYYY-MM-DD  (it re-derives all four and refuses a wrong weekday)',
    });
  }

  if (last < today) {
    return check('dates', BLOCKER, `The event dates are in the past (${span}, today is ${today}).`, {
      detail:
        'Every screen renders this as an ordinary schedule with nothing now and nothing next, ' +
        'so a rehearsal against it demonstrates an empty day rather than the event.',
      fix: 'npm run days -- --friday YYYY-MM-DD',
    });
  }

  const daysAway = Math.round((parseIsoDate(first) - parseIsoDate(today)) / DAY_MS);
  return check(
    'dates',
    OK,
    `${days.length} event days, ${span}` +
      (daysAway > 0 ? ` — ${daysAway} day${daysAway === 1 ? '' : 's'} away.` : ' — under way.'),
    { detail: `Venue zone ${zone}.` }
  );
}

/**
 * Is this the real roster, or still the placeholder?
 *
 * There is no honest headcount threshold to test against — the number moves
 * every year, and hard-coding one produces a check that fails on a legitimately
 * small event and passes on a half-loaded big one. What *is* honest is
 * provenance: seed rows are written with `source = 'seed'` and no `source_key`,
 * and an import writes neither. So "most of the schedule came from the seed" is
 * a fact about this database rather than a guess about the event, and it is the
 * one thing that distinguishes a demo from the weekend.
 *
 * Reported alongside the counts, because the counts are what somebody actually
 * compares against the roster in their other window.
 */
export function checkRoster({ expectedPeople = null } = {}) {
  const people = db.prepare('SELECT COUNT(*) AS n FROM people').get().n;
  const teams = db.prepare('SELECT COUNT(*) AS n FROM teams').get().n;
  const withContact = db
    .prepare("SELECT COUNT(*) AS n FROM people WHERE COALESCE(email,'') <> '' OR COALESCE(phone,'') <> ''")
    .get().n;
  const blocks = db.prepare('SELECT COUNT(*) AS n FROM schedule_blocks').get().n;
  const seeded = db.prepare("SELECT COUNT(*) AS n FROM schedule_blocks WHERE source = 'seed'").get().n;

  const counts = { people, teams, blocks, seeded, withContact };
  const summary =
    `${people} people on ${teams} teams, ${blocks} blocks; ` +
    `${withContact} of ${people} have an email or phone.`;

  if (!people || !blocks) {
    return {
      ...check('roster', BLOCKER, 'There is no roster or no schedule in this database.', {
        detail: summary,
        fix: 'npm run seed, or import the workbook — docs/loading-data.md.',
      }),
      counts,
    };
  }

  if (seeded && seeded === blocks) {
    return {
      ...check('roster', BLOCKER, 'Every schedule block in this database came from the seed.', {
        detail:
          `${summary} This is the placeholder event. A rehearsal against it exercises the ` +
          'software and none of the weekend — every code resolves and nobody real is in it.',
        fix: 'Import the event workbook — docs/loading-data.md.',
      }),
      counts,
    };
  }

  const items = [];
  let level = OK;
  if (seeded) {
    level = WARN;
    items.push(`${seeded} of ${blocks} blocks are still seed placeholders.`);
  }
  if (withContact < people) {
    level = WARN;
    items.push(
      `${people - withContact} people have neither an email nor a phone, so nothing can be sent to them.`
    );
  }
  if (expectedPeople && people < expectedPeople) {
    level = WARN;
    items.push(`${people} people loaded against an expected ${expectedPeople}.`);
  }

  return { ...check('roster', level, summary, { items }), counts };
}

/**
 * A day with nothing on it.
 *
 * Item 24 left this as the standing gap: `Export` builds Saturday from the
 * Sequences and Slot Times pipelines, and Thursday, Friday and Sunday are almost
 * entirely the Manual Blocks tab, which has one example row. A phone belonging
 * to somebody who lands on Thursday shows them an empty day, and no part of the
 * import reports it — every row that was there imported fine.
 */
export function checkDayCoverage() {
  const rows = db
    .prepare(
      `SELECT d.key, d.label, d.date, COUNT(b.id) AS blocks
         FROM event_days d
         LEFT JOIN schedule_blocks b ON b.day = d.key
        GROUP BY d.key
        ORDER BY d.sort_order, d.date`
    )
    .all();

  const empty = rows.filter((r) => !r.blocks);
  const summary = rows.map((r) => `${r.key} ${r.blocks}`).join(', ');

  if (!rows.length) return check('days', BLOCKER, 'No event days to cover.');
  if (empty.length) {
    return check('days', BLOCKER, `${empty.length} event day${empty.length === 1 ? ' has' : 's have'} no blocks at all.`, {
      detail: `Blocks per day: ${summary}.`,
      items: empty.map((r) => `${r.label} (${r.date}) is empty — anyone whose day this is sees nothing.`),
      fix: 'Fill the Manual Blocks tab for the days the pipelines do not build — docs/loading-data.md.',
    });
  }
  return check('days', OK, `Every day has blocks (${summary}).`);
}

/* ------------------------------------------------------------------ *
 * The checks that already exist elsewhere, asked here
 * ------------------------------------------------------------------ */

/** Coverage and reachability, exactly as `npm run codes -- --check` computes them. */
export function checkAccess({ baseUrl = '' } = {}) {
  const missing = subjectsNeedingCodes().filter((s) => !codeForSubject(s.subjectType, s.subjectId));
  const orphans = orphanedCodes();
  const live = listCodes();
  const plan = distributionPlan(live, (c) => `${baseUrl}/s/${c.code}`);
  const stuck = plan.rows.filter((r) => r.blocked);

  const items = [
    ...missing.map((s) => `No code for ${s.subjectType} ${s.label}.`),
    ...orphans.map((c) => `${c.code} points at a ${c.subjectType} that no longer exists.`),
    ...stuck.map((r) => `${r.subjectLabel}: ${r.blocked}`),
  ];

  const summary =
    `${live.length} live codes; ${plan.summary.sendable} of ${plan.summary.total} have somewhere to go ` +
    `(${plan.summary.recipients} messages).`;

  if (missing.length || orphans.length) {
    return check('access', BLOCKER, `${missing.length + orphans.length} subjects cannot sign in.`, {
      detail: summary,
      items,
      fix: 'npm run codes -- --check',
    });
  }
  if (stuck.length) {
    // Not a blocker: the rehearsal hands out links in the room. It is a blocker
    // for the event, which is what the deadline in item 25 is about.
    return check('access', WARN, `${stuck.length} links have nobody to send them to.`, {
      detail: summary,
      items,
      fix: 'npm run codes -- --send-list, then fix the addresses in the workbook.',
    });
  }
  return check('access', OK, summary);
}

/** The printed pack's own coverage, from `buildCallSheets` rather than re-derived. */
export function checkPaper({ baseUrl = '' } = {}) {
  let doc;
  try {
    doc = buildCallSheets({ baseUrl });
  } catch (err) {
    return check('paper', BLOCKER, 'The printed pack could not be built.', { detail: err.message });
  }
  const { coverage } = doc;
  const items = [
    ...coverage.unplaced.map((p) => `${p.name} is on no sheet — ${p.why}`),
    ...coverage.unprinted.map((b) => `${b.day} ${b.time} ${b.activity} → ${b.target} prints nowhere.`),
  ];
  const summary = `${coverage.sheets} sheets, ${coverage.placed} of ${coverage.people} people placed.`;
  if (items.length) {
    return check('paper', WARN, `${items.length} gap${items.length === 1 ? '' : 's'} in the printed pack.`, {
      detail: summary,
      items,
      fix: 'npm run callsheets -- --check',
    });
  }
  return check('paper', OK, summary);
}

/**
 * Snapshots.
 *
 * ⚠️ Asked of the *directory*, and the newest file is re-verified here rather
 * than trusted. `backup.js` verifies on the way out and refuses to keep a bad
 * one, so this should never fail — which is exactly why it is worth asking
 * before the one afternoon the answer matters. An empty SQLite file is
 * structurally valid and restores to an event with nobody in it.
 */
export function checkBackups() {
  const status = backupStatus();
  if (!status.enabled) {
    return check('backups', WARN, 'Snapshots are off in this environment.', {
      detail: 'BACKUP_INTERVAL_MS is unset, so nothing is being copied anywhere.',
      fix: 'See docs/ops.md. The rehearsal should include a restore drill either way.',
    });
  }

  const config = backupConfig();
  const newest = latestSnapshot(config.dir);
  if (!newest) {
    return check('backups', BLOCKER, 'Snapshots are enabled and there are none.', {
      detail: status.lastError ? `Last error: ${status.lastError}` : null,
      fix: 'npm run backup',
    });
  }

  /**
   * Verified *against the live counts*, not on its own. `integrity_check` alone
   * passes a zero-byte file, which is a structurally perfect SQLite database
   * containing no event — the one failure that looks identical to success right
   * up to the moment somebody restores it.
   */
  const live = {
    blocks: db.prepare('SELECT COUNT(*) AS n FROM schedule_blocks').get().n,
    people: db.prepare('SELECT COUNT(*) AS n FROM people').get().n,
    teams: db.prepare('SELECT COUNT(*) AS n FROM teams').get().n,
    codes: db.prepare('SELECT COUNT(*) AS n FROM access_codes').get().n,
  };
  const verified = verifySnapshot(path.join(config.dir, newest.name), live);
  if (!verified.ok) {
    return check('backups', BLOCKER, `The newest snapshot does not verify: ${verified.error}`, {
      detail: newest.name,
      fix: 'npm run backup, and read docs/ops.md before restoring anything.',
    });
  }

  const level = status.stale ? BLOCKER : OK;
  const detail =
    `Newest ${newest.name}, ${status.ageSeconds}s old` +
    (status.offBox ? ', with an off-box copy.' : ', on this volume only.');
  return check(
    'backups',
    level,
    status.stale ? 'No verified snapshot recently.' : 'Snapshots are current and the newest one verifies.',
    { detail, fix: status.stale ? 'npm run backup, then read docs/ops.md.' : null }
  );
}

/**
 * The deploy configuration, at the level the deploy gate itself uses.
 *
 * `inspectDeployConfig` returns its own `fail`/`warn`/`ok` per check; those are
 * mapped straight across rather than re-judged, because that file is the
 * authority on what stops a boot. Outside production none of it is enforced,
 * which is worth saying out loud on a laptop — a green run here says nothing
 * about `fly secrets`.
 */
export function checkDeploy({ dbPath = liveDbPath } = {}) {
  const { production, checks } = inspectDeployConfig({ dbPath });
  // ⚠️ `level` is the severity a check carries *if it fails*, not its result —
  // `ok` is the result. Reading `level === 'fail'` as "failed" reports every
  // passing fatal check as a blocker, which is a readiness gate that is never
  // green. `failing()` is the accessor that gets this right.
  const failed = failing(checks, 'fail');
  const warned = failing(checks, 'warn').filter((c) => !failed.includes(c));
  const items = [...failed, ...warned].map((c) => `${c.title}: ${c.detail ?? ''}`.trim());
  const where = production ? 'this machine' : 'this shell (NODE_ENV is not production, so none of it is enforced)';

  if (failed.length) {
    const also = warned.length ? `, and ${warned.length} more not passing` : '';
    return check(
      'deploy',
      BLOCKER,
      `${failed.length} deploy check${failed.length === 1 ? '' : 's'} would refuse to boot in production${also}.`,
      {
        detail: `Checked against ${where}.`,
        items,
        fix: 'npm run preflight  — and run it on the machine: fly ssh console -C "npm run preflight"',
      }
    );
  }
  if (warned.length) {
    return check('deploy', WARN, `${warned.length} deploy checks not passing.`, {
      detail: `Checked against ${where}.`,
      items,
      fix: 'npm run preflight',
    });
  }
  return check('deploy', OK, `Deploy configuration passing against ${where}.`);
}

/* ------------------------------------------------------------------ *
 * The report
 * ------------------------------------------------------------------ */

/**
 * Everything, worst first.
 *
 * @param {object} opts
 * @param {string} opts.baseUrl   the links' hostname, for the paper and code checks
 * @param {number} opts.expectedPeople  headcount to compare the roster against
 */
export function readinessReport({
  at = new Date(),
  baseUrl = (process.env.PUBLIC_BASE_URL || 'http://localhost:4000').replace(/\/+$/, ''),
  expectedPeople = Number(process.env.EXPECTED_HEADCOUNT || 0) || null,
} = {}) {
  const checks = [
    checkEventDates({ at }),
    checkRoster({ expectedPeople }),
    checkDayCoverage(),
    checkAccess({ baseUrl }),
    checkPaper({ baseUrl }),
    checkBackups(),
    checkDeploy(),
  ];

  const blockers = checks.filter((c) => c.level === BLOCKER);
  const warnings = checks.filter((c) => c.level === WARN);

  return {
    at: new Date(at).toISOString(),
    baseUrl,
    checks: [...checks].sort((a, b) => RANK[a.level] - RANK[b.level]),
    blockers: blockers.length,
    warnings: warnings.length,
    /**
     * The one sentence the whole file exists to produce. "Ready" here means the
     * rehearsal can answer its own question — not that the event is ready, which
     * is a judgement no script gets to make.
     */
    ready: blockers.length === 0,
  };
}
