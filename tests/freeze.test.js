/**
 * The freeze — item 27.
 *
 * Two halves, and they are two halves because neither one alone can answer the
 * question the freeze exists to answer. `release.js` runs on the machine and
 * knows what was built into it; `freeze.js` runs on a laptop and knows what was
 * tagged. "Is the thing serving phones the thing we froze?" is a comparison
 * across that gap.
 *
 * Most of what follows is about the *comfortable* wrong answers, because every
 * failure in this area looks like success:
 *
 *   - a release identity that is always available and always the same
 *     (`package.json` says `1.0.0`, and has since the first commit), which would
 *     report a permanent match between the frozen release and whatever is
 *     actually deployed;
 *   - "the server does not know" quietly reading as agreement;
 *   - a tag cut over a dirty tree, naming contents that exist nowhere;
 *   - `release-2026-08-19.10` sorting before `.2`, so the newest freeze is not
 *     the one being compared against.
 *
 * None of those throw. All of them make a green freeze check meaningless.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'royalty-freeze-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.db');
process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'test-admin-password';

const {
  FREEZE_TAG_RE,
  currentRelease,
  hasGit,
  releaseInfo,
  releasePayload,
  resetReleaseCache,
} = await import('../server/lib/release.js');

const {
  BLOCKER,
  OK,
  WARN,
  askRunningRelease,
  createFreezeTag,
  deployCommand,
  freezeReport,
  freezeTagMessage,
  gitState,
  nextFreezeTag,
} = await import('../server/lib/freeze.js');

const { inspectDeployConfig, assertBootConfig, failing } = await import(
  '../server/lib/deploy-config.js'
);
const { healthReport } = await import('../server/lib/ops.js');

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NO_GIT = fs.mkdtempSync(path.join(os.tmpdir(), 'royalty-nogit-'));

after(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  fs.rmSync(NO_GIT, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * Release identity
 * ------------------------------------------------------------------ */

describe('what this process says it is', () => {
  beforeEach(() => resetReleaseCache());

  test('the build stamp wins, and carries the commit and the build time', () => {
    const info = releaseInfo({
      env: {
        RELEASE: 'release-2026-09-09',
        RELEASE_COMMIT: 'abcdef1234567890abcdef1234567890abcdef12',
        RELEASE_BUILT_AT: '2026-09-09T14:00:00Z',
      },
      cwd: NO_GIT,
    });

    assert.equal(info.source, 'env');
    assert.equal(info.release, 'release-2026-09-09');
    assert.equal(info.short, 'abcdef1');
    assert.equal(info.builtAt, '2026-09-09T14:00:00Z');
    assert.equal(info.known, true);
    assert.equal(info.frozen, true);
    assert.match(info.summary, /release-2026-09-09 \(abcdef1\)/);
  });

  test('a commit with no tag is a build, not a release', () => {
    const info = releaseInfo({
      env: { RELEASE_COMMIT: 'abcdef1234567890abcdef1234567890abcdef12' },
      cwd: NO_GIT,
    });
    assert.equal(info.release, 'abcdef1');
    assert.equal(info.known, true);
    assert.equal(info.frozen, false, 'only a release-YYYY-MM-DD tag is a freeze');
  });

  /**
   * ⚠️ The central one. There is a version string sitting in package.json and
   * it would resolve on every machine, in every image, forever — and it has
   * been `1.0.0` since the first commit. Falling back to it would make the
   * drift check in freeze.js permanently, silently green.
   */
  test('with nothing to go on it says unknown, and never invents a version', () => {
    const info = releaseInfo({ env: {}, cwd: NO_GIT });

    assert.equal(info.source, 'unknown');
    assert.equal(info.known, false);
    assert.equal(info.release, null);
    assert.equal(info.commit, null);
    assert.match(info.summary, /unknown/);

    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.notEqual(info.release, pkg.version);
    assert.ok(!String(info.summary).includes(pkg.version));
  });

  test('dirty is recorded from the build, never guessed', () => {
    const base = { RELEASE: 'release-2026-09-09' };
    assert.equal(releaseInfo({ env: { ...base, RELEASE_DIRTY: '1' }, cwd: NO_GIT }).dirty, true);
    assert.equal(releaseInfo({ env: { ...base, RELEASE_DIRTY: '0' }, cwd: NO_GIT }).dirty, false);
    assert.equal(
      releaseInfo({ env: base, cwd: NO_GIT }).dirty,
      null,
      'a build that did not say must not be reported as clean'
    );
    assert.match(releaseInfo({ env: { ...base, RELEASE_DIRTY: '1' }, cwd: NO_GIT }).summary, /\+dirty/);
  });

  test('the payload carries the identity and nothing about the machine', () => {
    const payload = releasePayload(
      releaseInfo({ env: { RELEASE: 'release-2026-09-09' }, cwd: NO_GIT })
    );
    assert.deepEqual(Object.keys(payload).sort(), [
      'builtAt',
      'commit',
      'dirty',
      'frozen',
      'known',
      'release',
      'source',
    ]);
  });

  /**
   * `/api/health` is the platform's check every 15 seconds and the load test's
   * latency probe. Item 20 pinned it at one indexed row; resolving the release
   * per request would fork a `git` process on any machine with a repo beside it.
   */
  test('the server-side lookup is resolved once', () => {
    const first = currentRelease();
    assert.equal(currentRelease(), first, 'same object — not recomputed per call');
    resetReleaseCache();
    assert.notEqual(currentRelease(), first, 'and the test seam actually clears it');
  });

  test('health reports the release, and reporting it never makes health fail', () => {
    const report = healthReport({ serveClient: false });
    assert.ok(report.release, 'monitors and `npm run freeze --url` read this field');
    assert.equal(typeof report.release.known, 'boolean');
    assert.equal(report.ok, true);
  });

  test('a freeze tag is release-YYYY-MM-DD, optionally sequenced', () => {
    assert.ok(FREEZE_TAG_RE.test('release-2026-09-09'));
    assert.ok(FREEZE_TAG_RE.test('release-2026-09-09.3'));
    assert.ok(!FREEZE_TAG_RE.test('v1.0.0'));
    assert.ok(!FREEZE_TAG_RE.test('release-2026-9-9'));
  });
});

/* ------------------------------------------------------------------ *
 * Reading a real repository
 * ------------------------------------------------------------------ */

describe('against an actual repository', () => {
  let repo;
  const run = (...args) =>
    execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 't@example.com',
      },
    });

  before(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'royalty-repo-'));
    run('init', '-b', 'main');
    // ⚠️ In the repo's own config, not in `run`'s environment. `run` is the
    // test driving git; `createFreezeTag` is the *product* running git, through
    // `release.js`'s `git()`, which passes no environment of its own. With the
    // identity only in `run`'s env, tag creation works for every call the test
    // makes and fails for the one the product makes — and only on a machine
    // where git cannot guess an identity, which is a CI runner and not a
    // laptop. That is exactly how this passed here and went red on push.
    run('config', 'user.email', 'test@example.com');
    run('config', 'user.name', 'Royalty Test');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    run('add', '.');
    run('commit', '-m', 'first');
  });

  after(() => fs.rmSync(repo, { recursive: true, force: true }));

  test('a clean tree with no tags', () => {
    const state = gitState({ cwd: repo });
    assert.equal(state.repo, true);
    assert.equal(state.branch, 'main');
    assert.equal(state.dirty, false);
    assert.deepEqual(state.freezes, []);
    assert.equal(state.latestFreeze, null);
    assert.equal(state.hasRemote, false, 'no remote configured, so nothing to say about pushing');
  });

  test('an uncommitted file makes the tree dirty and names itself', () => {
    fs.writeFileSync(path.join(repo, 'b.txt'), 'two\n');
    const state = gitState({ cwd: repo });
    assert.equal(state.dirty, true);
    assert.ok(state.dirtyFiles.some((f) => f.includes('b.txt')));
    fs.rmSync(path.join(repo, 'b.txt'));
    assert.equal(gitState({ cwd: repo }).dirty, false);
  });

  test('git derivation prefers the tag on HEAD, and reports the commit otherwise', () => {
    const untagged = releaseInfo({ env: {}, cwd: repo });
    assert.equal(untagged.source, 'git');
    assert.equal(untagged.release, untagged.short);
    assert.equal(untagged.frozen, false);

    run('tag', '-a', 'release-2026-09-09', '-m', 'freeze');
    const tagged = releaseInfo({ env: {}, cwd: repo });
    assert.equal(tagged.release, 'release-2026-09-09');
    assert.equal(tagged.frozen, true);
  });

  /**
   * ⚠️ Sequence numbers are numbers. Sorted as strings, `release-…​.10` lands
   * before `release-…​.2`, so the "latest freeze" every comparison below is made
   * against would silently be an older one — the exact shape of bug this whole
   * file is written to catch.
   */
  test('freeze tags sort by date then by sequence, numerically', () => {
    run('tag', '-a', 'release-2026-09-09.2', '-m', 'second');
    run('tag', '-a', 'release-2026-09-09.10', '-m', 'tenth');
    run('tag', '-a', 'release-2026-09-08', '-m', 'earlier');

    const state = gitState({ cwd: repo });
    assert.deepEqual(
      state.freezes.map((f) => f.tag),
      ['release-2026-09-08', 'release-2026-09-09', 'release-2026-09-09.2', 'release-2026-09-09.10']
    );
    assert.equal(state.latestFreeze.tag, 'release-2026-09-09.10');
  });

  test('commits after the freeze are counted, and a tagged HEAD reads as frozen', () => {
    assert.equal(gitState({ cwd: repo }).freezeOnHead.tag, 'release-2026-09-09.10');

    fs.writeFileSync(path.join(repo, 'c.txt'), 'three\n');
    run('add', '.');
    run('commit', '-m', 'an emergency');

    const state = gitState({ cwd: repo });
    assert.equal(state.freezeOnHead, null);
    assert.equal(state.commitsSinceFreeze, 1);
  });

  test('the next tag takes the date, then steps around what is taken', () => {
    const at = new Date('2026-09-09T18:00:00Z'); // still the 9th in the venue's zone
    assert.equal(
      nextFreezeTag({ freezes: [] }, { at }),
      'release-2026-09-09',
      'the first freeze of the day is unsuffixed'
    );
    assert.equal(
      nextFreezeTag(gitState({ cwd: repo }), { at }),
      'release-2026-09-09.11',
      '.1 is free, and taking it would cut a release that sorts before ones already made'
    );
  });

  test('creating a tag is refused rather than moved when the name is taken', () => {
    const clash = createFreezeTag('release-2026-09-09', 'again', { cwd: repo });
    assert.equal(clash.ok, false);
    assert.match(clash.error, /already exists/);

    const fresh = createFreezeTag('release-2026-09-11', 'a real one', { cwd: repo });
    assert.equal(fresh.ok, true);
    assert.match(run('tag', '--list', 'release-2026-09-11'), /release-2026-09-11/);
    assert.match(run('tag', '-n99', '--list', 'release-2026-09-11'), /a real one/);
  });

  test('a refused tag carries git’s own words, not a guess at them', () => {
    // ⚠️ This used to answer every failure with "is anything configured to sign
    // tags?", which is a diagnosis rather than a report. A red CI run spent its
    // evidence on signing config while git had actually said "Committer
    // identity unknown" — and the freeze is cut at 2am on a laptop that may
    // never have run git, which is exactly when a wrong hint costs the most.
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'royalty-empty-'));
    try {
      execFileSync('git', ['init', '-b', 'main'], { cwd: empty, stdio: 'ignore' });
      // An unborn HEAD: there is no commit to tag, so git refuses and says why.
      const res = createFreezeTag('release-2026-09-12', 'nothing to tag', { cwd: empty });
      assert.equal(res.ok, false);
      assert.match(res.error, /^git tag failed: /);
      assert.match(res.error, /HEAD/, "git's own reason reaches the caller");
      assert.doesNotMatch(res.error, /sign/, 'and it is not replaced by a guess');
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  test('a directory that is not a repository is an ordinary answer, not a crash', () => {
    assert.equal(hasGit(NO_GIT), false);
    assert.equal(gitState({ cwd: NO_GIT }).repo, false);
    assert.equal(releaseInfo({ env: {}, cwd: NO_GIT }).source, 'unknown');
  });
});

/* ------------------------------------------------------------------ *
 * The gate
 * ------------------------------------------------------------------ */

const cleanGit = (over = {}) => ({
  repo: true,
  commit: 'abcdef1234567890abcdef1234567890abcdef12',
  short: 'abcdef1',
  branch: 'main',
  dirty: false,
  dirtyFiles: [],
  tagsOnHead: [],
  freezes: [],
  latestFreeze: null,
  commitsSinceFreeze: null,
  freezeOnHead: null,
  hasRemote: true,
  remoteBranches: ['origin/main'],
  ...over,
});

const readyReadiness = (over = {}) => ({
  checks: [
    { key: 'dates', level: OK, title: '4 event days, 2026-09-10 → 2026-09-13 — 30 days away.', items: [] },
    {
      key: 'roster',
      level: OK,
      title: '281 people on 8 teams, 402 blocks; 281 of 281 have an email or phone.',
      items: [],
      counts: { people: 281, teams: 8, blocks: 402, seeded: 0, withContact: 281 },
    },
  ],
  blockers: 0,
  warnings: 0,
  ready: true,
  ...over,
});

const green = { ran: true, ok: true, detail: 'npm run ci green — 585 tests (42s).' };
const find = (report, key) => report.checks.find((c) => c.key === key);

describe('can this be frozen', () => {
  test('a clean tree, green tests and ready data can be frozen', () => {
    const report = freezeReport({
      git: cleanGit(),
      readiness: readyReadiness(),
      verification: green,
    });

    assert.equal(report.canFreeze, true);
    assert.equal(report.blockers, 0);
    assert.equal(find(report, 'tree').level, OK);
    assert.equal(find(report, 'verified').level, OK);
    assert.equal(find(report, 'readiness').level, OK);
    assert.ok(report.nextTag.startsWith('release-'));
  });

  /**
   * ⚠️ The refusal with no override. `git tag` tags the commit; a dirty tree
   * means the code that was tested is in the working directory and the tag
   * names something that exists nowhere and cannot be rebuilt.
   */
  test('a dirty tree is fatal, and fatal means --force cannot reach it', () => {
    const report = freezeReport({
      git: cleanGit({ dirty: true, dirtyFiles: ['M server/app.js', '?? notes.txt'] }),
      readiness: readyReadiness(),
      verification: green,
    });

    assert.equal(report.canFreeze, false);
    assert.equal(report.fatal, true, 'the CLI keys --force off this');
    const tree = find(report, 'tree');
    assert.equal(tree.level, BLOCKER);
    assert.deepEqual(tree.items, ['M server/app.js', '?? notes.txt']);
  });

  test('everything else that blocks is not fatal, so an emergency can override it', () => {
    const report = freezeReport({
      git: cleanGit(),
      readiness: readyReadiness({
        checks: [{ key: 'dates', level: BLOCKER, title: 'The event dates are in the past.', items: [] }],
        blockers: 1,
      }),
      verification: green,
    });

    assert.equal(report.canFreeze, false);
    assert.equal(report.fatal, false);
    assert.equal(find(report, 'readiness').level, BLOCKER);
    assert.deepEqual(find(report, 'readiness').items, ['The event dates are in the past.']);
  });

  test('failing tests block; not running them warns', () => {
    const failed = freezeReport({
      git: cleanGit(),
      readiness: readyReadiness(),
      verification: { ran: true, ok: false, detail: 'npm run ci exited 1, 3 failing.' },
    });
    assert.equal(find(failed, 'verified').level, BLOCKER);
    assert.equal(failed.canFreeze, false);

    const skipped = freezeReport({ git: cleanGit(), readiness: readyReadiness(), verification: null });
    assert.equal(find(skipped, 'verified').level, WARN);
    assert.equal(skipped.canFreeze, true, 'a skipped suite is a judgement, not a refusal');
  });

  test('a commit that exists only on this laptop warns', () => {
    const local = freezeReport({
      git: cleanGit({ remoteBranches: [] }),
      readiness: readyReadiness(),
      verification: green,
    });
    assert.equal(find(local, 'pushed').level, WARN);

    const noRemote = freezeReport({
      git: cleanGit({ hasRemote: false, remoteBranches: [] }),
      readiness: readyReadiness(),
      verification: green,
    });
    assert.equal(find(noRemote, 'pushed'), undefined, 'nothing to say when there is no remote');
  });

  test('freezing off main is allowed and mentioned', () => {
    const report = freezeReport({
      git: cleanGit({ branch: 'hotfix/airport' }),
      readiness: readyReadiness(),
      verification: green,
    });
    assert.equal(find(report, 'branch').level, WARN);
    assert.equal(report.canFreeze, true);
  });
});

/* ------------------------------------------------------------------ *
 * After the freeze
 * ------------------------------------------------------------------ */

describe('what has happened since the freeze', () => {
  test('nothing frozen yet is a warning during event week', () => {
    const report = freezeReport({ git: cleanGit(), readiness: readyReadiness(), verification: green });
    assert.equal(find(report, 'frozen').level, WARN);
    assert.match(find(report, 'frozen').title, /Nothing has been frozen/);
  });

  test('a tagged HEAD is the frozen state', () => {
    const tag = { tag: 'release-2026-09-09', date: '2026-09-09', seq: 0 };
    const report = freezeReport({
      git: cleanGit({ freezes: [tag], latestFreeze: tag, freezeOnHead: tag, commitsSinceFreeze: 0 }),
      readiness: readyReadiness(),
      verification: green,
    });
    assert.equal(find(report, 'frozen').level, OK);
    assert.equal(report.latestFreeze, 'release-2026-09-09');
  });

  /**
   * The state item 27 is really about. Commits after the freeze are permitted —
   * a genuine emergency on the Saturday is in the plan — but an untagged one
   * leaves a machine running something no tag describes.
   */
  test('commits after the freeze are counted and named as needing their own tag', () => {
    const tag = { tag: 'release-2026-09-09', date: '2026-09-09', seq: 0 };
    const report = freezeReport({
      git: cleanGit({ freezes: [tag], latestFreeze: tag, freezeOnHead: null, commitsSinceFreeze: 3 }),
      readiness: readyReadiness(),
      verification: green,
    });
    const frozen = find(report, 'frozen');
    assert.equal(frozen.level, WARN);
    assert.match(frozen.title, /3 commits since release-2026-09-09/);
    assert.match(frozen.fix, /release-2026-09-09\.\.HEAD/);
  });

  test('the next tag steps past the freeze already cut today', () => {
    const at = new Date('2026-09-09T18:00:00Z');
    const tag = { tag: 'release-2026-09-09', date: '2026-09-09', seq: 0 };
    assert.equal(nextFreezeTag({ freezes: [tag] }, { at }), 'release-2026-09-09.1');
  });
});

/* ------------------------------------------------------------------ *
 * Is the machine running what we froze?
 * ------------------------------------------------------------------ */

describe('the machine against the tag', () => {
  const frozenAt = { tag: 'release-2026-09-09', date: '2026-09-09', seq: 0 };
  const withFreeze = (running) =>
    freezeReport({
      git: cleanGit({ freezes: [frozenAt], latestFreeze: frozenAt, commitsSinceFreeze: 2 }),
      readiness: readyReadiness(),
      verification: green,
      running,
    });

  test('holding the frozen release is the only green answer', () => {
    const report = withFreeze({ known: true, release: 'release-2026-09-09', builtAt: '2026-09-09T14:00:00Z' });
    assert.equal(find(report, 'running').level, OK);
  });

  test('holding something else blocks, and says so in those words', () => {
    const report = withFreeze({ known: true, release: 'release-2026-09-11', dirty: false });
    const running = find(report, 'running');
    assert.equal(running.level, BLOCKER);
    assert.match(running.title, /running release-2026-09-11, not release-2026-09-09/);
  });

  /**
   * ⚠️ "It cannot say" is its own answer. Reading a blank as agreement is
   * precisely what a package.json fallback would have done, permanently.
   */
  test('a machine that cannot name its release is not a match', () => {
    const report = withFreeze({ known: false, release: null });
    const running = find(report, 'running');
    assert.equal(running.level, WARN);
    assert.notEqual(running.level, OK);
    assert.match(running.detail, /build-args/);
  });

  test('an unreachable server warns rather than claiming drift', () => {
    const report = withFreeze({ error: 'https://host/api/health: fetch failed' });
    assert.equal(find(report, 'running').level, WARN);
  });

  test('nothing frozen at all is a different sentence again', () => {
    const report = freezeReport({
      git: cleanGit(),
      readiness: readyReadiness(),
      verification: green,
      running: { known: true, release: 'abcdef1' },
    });
    assert.equal(find(report, 'running').level, WARN);
    assert.match(find(report, 'running').title, /nothing is frozen/);
  });

  test('the health check is read for the release even when it is failing', async () => {
    const fetchImpl = async () => ({
      status: 503,
      json: async () => ({ ok: false, release: { known: true, release: 'release-2026-09-09' } }),
    });
    const result = await askRunningRelease('https://host/', { fetchImpl });
    assert.equal(result.release, 'release-2026-09-09');
    assert.equal(result.status, 503);
    assert.equal(result.url, 'https://host/api/health');
  });

  test('a response with no release field is an error, not an unknown release', () => {
    return askRunningRelease('https://host', {
      fetchImpl: async () => ({ status: 200, json: async () => ({ ok: true }) }),
    }).then((result) => {
      assert.ok(result.error, 'an older build answering without the field must not read as a match');
      assert.equal(result.known, undefined);
    });
  });
});

/* ------------------------------------------------------------------ *
 * The tag's own message, and the deploy that stamps it
 * ------------------------------------------------------------------ */

describe('the record left behind', () => {
  const report = () =>
    freezeReport({ git: cleanGit(), readiness: readyReadiness(), verification: green });

  test('the message says what the event looked like when it was frozen', () => {
    const message = freezeTagMessage({ tag: 'release-2026-09-09', report: report(), verification: green });
    assert.match(message, /Royalty freeze — release-2026-09-09/);
    assert.match(message, /2026-09-10 → 2026-09-13/);
    assert.match(message, /281 people on 8 teams, 402 blocks/);
    assert.match(message, /585 tests/);
    assert.match(message, /docs\/freeze\.md/);
  });

  test('an override is written into the tag rather than left for the next person', () => {
    const message = freezeTagMessage({
      tag: 'release-2026-09-09',
      report: report(),
      verification: green,
      overrides: ['readiness'],
    });
    assert.match(message, /--force over: readiness/);
  });

  /**
   * The build args are the whole channel — the image has no repository in it.
   * Renaming one on either side would leave every deploy stamping nothing while
   * looking entirely correct, so the command and the Dockerfile are pinned to
   * each other here.
   */
  test('the printed deploy command matches what the Dockerfile accepts', () => {
    const command = deployCommand('release-2026-09-09', 'abcdef1234567890');
    assert.match(command, /--ha=false/);

    const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
    for (const arg of ['RELEASE', 'RELEASE_COMMIT', 'RELEASE_BUILT_AT']) {
      assert.match(command, new RegExp(`--build-arg ${arg}=`), `${arg} is passed`);
      assert.match(dockerfile, new RegExp(`^ARG ${arg}=`, 'm'), `${arg} is declared`);
      assert.match(dockerfile, new RegExp(`${arg}=\\$${arg}`), `${arg} reaches the runtime env`);
    }
  });
});

/* ------------------------------------------------------------------ *
 * The deploy gate's half
 * ------------------------------------------------------------------ */

describe('the deploy check for it', () => {
  const productionEnv = {
    NODE_ENV: 'production',
    ADMIN_PASSWORD: 'a-real-password',
    SESSION_SECRET: 'f'.repeat(16) + '0123456789abcdef0123456789abcdef',
    PUBLIC_BASE_URL: 'https://royalty-schedule.fly.dev',
  };
  const opts = {
    dbPath: '/data/royalty.db',
    clientDist: path.join(ROOT, 'tests', 'fixtures-deploy'),
  };
  const releaseCheck = (release) =>
    inspectDeployConfig({ env: productionEnv, ...opts, release }).checks.find(
      (c) => c.id === 'release-identity'
    );

  test('a stamped, clean build passes', () => {
    const c = releaseCheck({ known: true, dirty: false, source: 'env', summary: 'release-2026-09-09 (abcdef1)' });
    assert.equal(c.ok, true);
    assert.equal(c.level, 'warn');
  });

  test('an unstamped build does not, and explains that there is nothing to ask', () => {
    const c = releaseCheck({ known: false, dirty: null, source: 'unknown', summary: 'unknown' });
    assert.equal(c.ok, false);
    assert.match(c.detail, /no repository in it to ask/);
    assert.match(c.fix, /npm run freeze/);
  });

  test('a build from a dirty tree does not either', () => {
    const c = releaseCheck({ known: true, dirty: true, source: 'env', summary: 'release-2026-09-09 +dirty' });
    assert.equal(c.ok, false);
    assert.match(c.detail, /does not describe what is running/);
  });

  /**
   * New checks go in at `warn` — a 2am restart must not be blocked by a
   * labelling problem, and this one is a label. `npm run preflight` is where it
   * has to be green.
   */
  test('it never stops a boot, and preflight still counts it', () => {
    const args = {
      env: productionEnv,
      ...opts,
      release: { known: false, dirty: null, source: 'unknown', summary: 'unknown' },
    };
    assert.doesNotThrow(() => assertBootConfig({ ...args, log: { warn() {} } }));

    const { checks } = inspectDeployConfig(args);
    assert.ok(!failing(checks, 'fail').some((c) => c.id === 'release-identity'));
    assert.ok(failing(checks, 'warn').some((c) => c.id === 'release-identity'));
  });
});
