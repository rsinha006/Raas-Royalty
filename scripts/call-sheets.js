#!/usr/bin/env node
/**
 * Generate the printed fallback call sheets — item 28.
 *
 *   npm run callsheets                 # write the whole pack, print the summary
 *   npm run callsheets -- --check      # coverage only; exits 1 on a gap
 *   npm run callsheets -- --no-desk    # the pack that gets handed out (no codes)
 *   npm run callsheets -- --desk-only  # just the desk index (carries codes)
 *   npm run callsheets -- --out ~/royalty.html
 *
 * The panel has the same thing behind a button (Ops → Printed fallback), which
 * is the path to use on the day. This one exists for the laptop with no browser
 * session and for whoever is preparing the pack a week out.
 *
 * ⚠️ The default output goes under `dataDir`, not next to the source. On the
 * machine the application directory is rebuilt by every deploy, so a file
 * written relative to the source tree is silently discarded — and in
 * development the two are the same folder, so the bug has no local symptom.
 */

import 'dotenv/config';

import fs from 'node:fs';
import path from 'node:path';

import { dataDir } from '../server/db.js';
import { buildCallSheets, renderCallSheets } from '../server/lib/call-sheets.js';

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueFor = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
};

/** Same rule as the codes CLI: configured wins, because this script has no request. */
const baseUrl = (process.env.PUBLIC_BASE_URL || 'http://localhost:4000').replace(/\/+$/, '');

const doc = buildCallSheets({ baseUrl });
const { coverage } = doc;

console.log(`\n  ${doc.eventName} — call sheets`);
console.log(`  ${doc.time.wallClock.replace('T', ' ')} ${doc.time.abbreviation}\n`);

for (const sheet of doc.sheets) {
  const own = sheet.people.reduce((n, p) => n + p.count, 0);
  console.log(
    `    ${sheet.title.padEnd(28)} ${String(sheet.sharedCount).padStart(3)} shared  ` +
      `${String(sheet.people.length).padStart(3)} people  ${String(own).padStart(3)} personal`
  );
}

console.log(
  `\n  ${coverage.sheets} sheets, ${coverage.placed} of ${coverage.people} people placed.`
);

/**
 * The two ways paper loses somebody, reported separately because they have
 * different fixes: a person on no sheet is a roster problem, a block on no
 * sheet is a targeting problem. Both are silent on screen — every phone is
 * still correct — which is why they are checked here rather than eyeballed.
 */
for (const p of coverage.unplaced) console.log(`  UNPLACED  ${p.name} — ${p.why}`);
for (const b of coverage.unprinted) {
  console.log(`  UNPRINTED ${b.day} ${b.time}  ${b.activity} → ${b.target}`);
}
if (coverage.withoutCode) {
  console.log(
    `  ${coverage.withoutCode} ${coverage.withoutCode === 1 ? 'person has' : 'people have'} ` +
      'no live access code — the desk index names them. Issue in Admin → Access codes.'
  );
}

if (has('--check')) {
  const gaps = coverage.unplaced.length + coverage.unprinted.length;
  console.log(gaps ? `\n  ${gaps} gap${gaps === 1 ? '' : 's'}.\n` : '\n  No gaps.\n');
  process.exit(gaps ? 1 : 0);
}

const html = renderCallSheets(doc, {
  desk: !has('--no-desk'),
  sheets: !has('--desk-only'),
});

const stamp = doc.time.wallClock.slice(0, 10);
const out =
  valueFor('--out') ||
  path.join(dataDir, 'call-sheets', `royalty-call-sheets-${stamp}.html`);

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);

console.log(`\n  Written to ${out}`);
console.log('  Open it in a browser and print. One sheet per page.');
if (!has('--no-desk')) {
  console.log('  ⚠️  The last page lists live access codes — it stays behind the desk.\n');
} else {
  console.log('');
}
