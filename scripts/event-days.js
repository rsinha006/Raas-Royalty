#!/usr/bin/env node
/**
 * Pin the event's dates — item 24's first sentence.
 *
 *   npm run days                        # what the days are set to now
 *   npm run days -- --friday 2027-02-12 # set them, anchored on the Friday
 *   npm run days -- --sat 2027-02-13    # or on any other day, same result
 *
 * Why this exists at all: the dates arrive in `event_days` from
 * `server/seed.js`, and the seed refuses to run against a populated database.
 * So before this, changing a date meant `npm run seed:reset` — which rebuilds
 * the placeholder roster over the real one and rotates every access code that
 * has already been mailed out. That is a trap with the roster on one side of it
 * and the dates on the other, and item 24 needs both.
 *
 * The arithmetic and every refusal live in `server/lib/event-days.js`; this is
 * the shell around them.
 */

import 'dotenv/config';

import { db, nowIso, touchScheduleVersion } from '../server/db.js';
import { planEventDates } from '../server/lib/event-days.js';

/** Accepts `--friday`, `--fri`, `--Fri` — the flag is the day, loosely spelled. */
function parseArgs(argv) {
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--([a-z]+)$/i);
    if (m) return { anchor: m[1].toLowerCase(), date: argv[i + 1] ?? null };
  }
  return { anchor: null, date: null };
}

const days = db
  .prepare('SELECT key, label, date, sort_order FROM event_days ORDER BY sort_order')
  .all();

if (!days.length) {
  console.error('\n  No event days in this database. Run `npm run seed` first.\n');
  process.exit(1);
}

const blocksOn = db.prepare('SELECT COUNT(*) AS n FROM schedule_blocks WHERE day = ?');

function show(rows, title) {
  console.log(`\n  ${title}\n`);
  for (const d of rows) {
    const n = blocksOn.get(d.key).n;
    console.log(
      `    ${d.key.padEnd(4)} ${String(d.label).padEnd(10)} ${d.date}   ${n} block${n === 1 ? '' : 's'}`
    );
  }
  console.log('');
}

const { anchor, date } = parseArgs(process.argv.slice(2));

if (!anchor) {
  show(days, 'Event days');
  console.log('  Set them from any one day:  npm run days -- --friday 2027-02-12\n');
  process.exit(0);
}

const result = planEventDates(days, anchor, date);
if (result.error) {
  console.error(`\n  ${result.error}\n`);
  process.exit(1);
}

if (!result.moving.length) {
  show(days, 'Event days — already that weekend, nothing to do');
  process.exit(0);
}

const update = db.prepare('UPDATE event_days SET date = ? WHERE key = ?');
db.transaction(() => {
  for (const d of result.plan) update.run(d.next, d.key);
})();

/**
 * Every block's absolute instant is resolved from its day's date, so all of
 * them just moved. Bumping the global version is what makes a phone that is
 * already open refetch, rather than holding times that no longer exist.
 */
touchScheduleVersion();

show(
  result.plan.map((d) => ({ ...d, date: d.next })),
  `Event days — ${result.moving.length} moved at ${nowIso()}`
);
console.log(
  '  Every block moved with its day. Restart the server if it is running, so\n' +
    '  connected phones pick the new dates up.\n'
);
