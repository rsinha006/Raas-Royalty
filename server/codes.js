/**
 * Access-code CLI. The admin panel (Access codes tab) does all of this with a
 * CSV export on top; this stays for the cases where there is no browser — a
 * deploy check, a cron, or an admin password nobody can find at 2am.
 *
 *   npm run codes              backfill, then summarize
 *   npm run codes -- --list    every live code with its subject
 *   npm run codes -- --list --revoked   include revoked ones
 *   npm run codes -- --check   coverage AND reachability, exit 1 on either
 *   npm run codes -- --send-list  every message that would go out, and to where
 *   npm run codes -- --regenerate <code>
 *   npm run codes -- --revoke <code>
 */
import {
  backfillAccessCodes,
  listCodes,
  lookupCode,
  issueCode,
  revokeCode,
  subjectsNeedingCodes,
  codeForSubject,
  orphanedCodes,
} from './lib/access-codes.js';
import { distributionPlan } from './lib/distribution.js';

/**
 * The same rule the panel and the CSV use. Configured wins, because a list of
 * 280 links to the wrong hostname is discovered by the recipients rather than
 * by us — and this script has no request to fall back to.
 */
const base = () => (process.env.PUBLIC_BASE_URL || 'http://localhost:4000').replace(/\/+$/, '');

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueFor = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
};

const ctx = { editedBy: 'cli', source: 'access-codes' };

function printTable(codes) {
  if (!codes.length) {
    console.log('No codes.');
    return;
  }
  const rows = codes.map((c) => ({
    code: c.code,
    type: c.subjectType,
    subject: c.subjectLabel ?? `<deleted ${c.subjectId}>`,
    detail: c.teamName || c.roleLabel || '',
    used: c.lastUsedAt ? c.lastUsedAt.slice(0, 16).replace('T', ' ') : 'never',
    state: c.revokedAt ? 'REVOKED' : 'live',
  }));
  const w = (k) => Math.max(k.length, ...rows.map((r) => String(r[k]).length));
  const widths = {
    code: w('code'), type: w('type'), subject: w('subject'),
    detail: w('detail'), used: w('used'), state: w('state'),
  };
  const line = (r) =>
    `  ${String(r.code).padEnd(widths.code)}  ${String(r.type).padEnd(widths.type)}  ` +
    `${String(r.subject).padEnd(widths.subject)}  ${String(r.detail).padEnd(widths.detail)}  ` +
    `${String(r.used).padEnd(widths.used)}  ${r.state}`;
  console.log(line({ code: 'CODE', type: 'TYPE', subject: 'SUBJECT', detail: 'DETAIL', used: 'LAST USED', state: 'STATE' }));
  rows.forEach((r) => console.log(line(r)));
}

if (has('--revoke')) {
  const raw = valueFor('--revoke');
  const found = lookupCode(raw);
  if (!found) {
    console.error(`No such code: ${raw}`);
    process.exit(1);
  }
  console.log(revokeCode(found.code, ctx) ? `Revoked ${found.code}.` : `${found.code} was already revoked.`);
  process.exit(0);
}

if (has('--regenerate')) {
  const raw = valueFor('--regenerate');
  const found = lookupCode(raw);
  if (!found) {
    console.error(`No such code: ${raw}`);
    process.exit(1);
  }
  const next = issueCode(
    { subjectType: found.subjectType, subjectId: found.subjectId, regenerate: true },
    ctx
  );
  console.log(`${found.code} -> ${next.code}. The old code no longer works.`);
  process.exit(0);
}

if (has('--list')) {
  printTable(listCodes({ includeRevoked: has('--revoked') }));
  process.exit(0);
}

if (has('--check')) {
  const missing = subjectsNeedingCodes().filter(
    (s) => !codeForSubject(s.subjectType, s.subjectId)
  );
  const orphans = orphanedCodes();
  const live = listCodes();

  console.log(`${live.length} live codes; ${missing.length} subjects missing one; ${orphans.length} orphaned.`);
  missing.forEach((s) => console.log(`  MISSING  ${s.subjectType}  ${s.label}`));
  orphans.forEach((c) => console.log(`  ORPHAN   ${c.code}  ${c.subjectType} ${c.subjectId}`));

  const dupes = live.length !== new Set(live.map((c) => `${c.subjectType}:${c.subjectId}`)).size;
  if (dupes) console.log('  DUPLICATE live codes for one subject');

  /**
   * Having a code and being reachable are different failures with different
   * fixes, so they are counted separately — but both stop somebody getting
   * their schedule, so both fail the check. This is the gate for item 25.
   */
  const plan = distributionPlan(live, (c) => `${base()}/s/${c.code}`);
  const stuck = plan.rows.filter((r) => r.blocked);
  console.log(
    `${plan.summary.sendable} of ${plan.summary.total} links have somewhere to go (${plan.summary.recipients} messages).`
  );
  stuck.forEach((r) => console.log(`  NO RECIPIENT  ${r.subjectType}  ${r.subjectLabel} — ${r.blocked}`));

  process.exit(missing.length || orphans.length || dupes || stuck.length ? 1 : 0);
}

if (has('--send-list')) {
  const plan = distributionPlan(listCodes(), (c) => `${base()}/s/${c.code}`);
  for (const row of plan.rows) {
    if (!row.recipients.length) {
      console.log(`  --  ${row.subjectLabel}  (${row.blocked})`);
      continue;
    }
    for (const p of row.recipients) {
      console.log(`  ${(p.email ?? p.phone).padEnd(32)}  ${row.subjectLabel}  ${row.link}`);
    }
  }
  console.log(
    `\n  ${plan.summary.recipients} messages for ${plan.summary.sendable} links; ${plan.summary.blocked} blocked.`
  );
  process.exit(0);
}

const result = backfillAccessCodes({}, ctx);
console.log(
  `${result.created} issued, ${result.kept} already present, ${result.total} subjects total.`
);
