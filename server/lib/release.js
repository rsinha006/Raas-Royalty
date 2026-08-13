/**
 * Which release is this process running? — PLAN.md item 27.
 *
 * The freeze is a tag, and a tag on its own is a fact about a laptop. The
 * question that actually gets asked — at 1pm on the Saturday, by somebody who
 * has been told a phone is showing the wrong time — is *"is the machine running
 * the thing we froze, or something somebody pushed on Friday night?"* Nothing
 * in this repo could answer that before this file: the server had no idea what
 * it was, and neither did `/api/health`.
 *
 * Three traps, and the first two are why this is a file rather than one line.
 *
 * ⚠️ **The identity has to be baked in at build time.** `.git/` is in
 * `.dockerignore` on purpose — an image gets pushed to a registry — so there is
 * no repository inside the container to interrogate, and `git describe` on the
 * machine cannot work *by construction*. Deriving a version at runtime is the
 * `__dirname`-vs-`dataDir` bug in another costume: it works perfectly on the
 * laptop, where the two are the same thing, and reports nothing on the one
 * machine the answer matters on. So the build passes `RELEASE` /
 * `RELEASE_COMMIT` in, git is consulted only in development, and everywhere
 * else the honest answer is `unknown`.
 *
 * ⚠️ **`package.json`'s version is not a release identity, and using it is
 * worse than having none.** It says `1.0.0`, it is present in every image ever
 * built, and it has never changed. A drift check reading it would compare
 * `1.0.0` against `1.0.0` and report a match between the frozen release and
 * whatever is actually deployed, permanently and silently. An `unknown` that
 * shows up as a warning is strictly better than a version string that is always
 * available and always wrong.
 *
 * ⚠️ **Dirty is recorded, never inferred.** A build made from a tree with
 * uncommitted changes carries a commit that does not describe what is running.
 * `npm run freeze` refuses to tag such a tree at all; if one is built anyway,
 * the flag rides along so the panel can say so.
 *
 * The lookup itself is memoized (`currentRelease`) because `/api/health` is on
 * the platform's 15-second check and the load test's latency probe — item 20
 * pinned that endpoint at one indexed row, and spawning `git` per request would
 * be the same class of regression as putting an `Intl` construction back on the
 * schedule path, several orders of magnitude worse.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = path.join(__dirname, '..', '..');

/**
 * Short, because every call is on a path where blocking is worse than not
 * knowing — the boot banner, `npm run preflight`, a CLI. A hung `git` on a
 * network filesystem must not become a hung deploy.
 */
const GIT_TIMEOUT_MS = 2_000;

/** A freeze tag: `release-2026-08-19`, and `release-2026-08-19.1` for a re-freeze. */
export const FREEZE_TAG_RE = /^release-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?$/;

/**
 * Run one git command, or return null.
 *
 * Never throws and never inherits stderr: "not a git repository" is an ordinary
 * answer here (it is what the container says), not a failure worth printing
 * above a boot banner.
 */
export function git(args, { cwd = APP_ROOT } = {}) {
  try {
    const out = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim();
  } catch {
    return null;
  }
}

/** `.git` is a directory in a clone and a file in a worktree; both count. */
export function hasGit(cwd = APP_ROOT) {
  return fs.existsSync(path.join(cwd, '.git'));
}

/**
 * The release as git sees it — development only, by construction (see the
 * header). Prefers an exact tag on HEAD, because that is what a freeze is;
 * falls back to the short commit, which reads as "a build, not a release".
 */
export function gitRelease({ cwd = APP_ROOT } = {}) {
  if (!hasGit(cwd)) return null;
  const commit = git(['rev-parse', 'HEAD'], { cwd });
  if (!commit) return null;

  const tag = git(['describe', '--tags', '--exact-match'], { cwd });
  const status = git(['status', '--porcelain'], { cwd });

  return {
    release: tag || commit.slice(0, 7),
    commit,
    tag: tag || null,
    builtAt: null,
    dirty: status === null ? null : status.length > 0,
    source: 'git',
  };
}

/** `RELEASE_DIRTY=1` / `0` — anything else means the build did not say. */
function parseDirty(value) {
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  return null;
}

function describeRelease(info) {
  const known = info.source !== 'unknown' && Boolean(info.release);
  const short = info.commit ? info.commit.slice(0, 7) : null;
  const frozen = known && FREEZE_TAG_RE.test(info.release);

  let summary;
  if (!known) {
    summary = 'unknown — this build was not stamped with a release';
  } else {
    const parts = [info.release];
    if (short && info.release !== short) parts.push(`(${short})`);
    if (info.dirty) parts.push('+dirty');
    summary = parts.join(' ');
  }

  return { ...info, short, known, frozen, summary };
}

/**
 * What this process is, resolved from the environment first and git second.
 *
 * @returns {{release: string|null, commit: string|null, short: string|null,
 *            tag: string|null, builtAt: string|null, dirty: boolean|null,
 *            source: 'env'|'git'|'unknown', known: boolean, frozen: boolean,
 *            summary: string}}
 */
export function releaseInfo({ env = process.env, cwd = APP_ROOT } = {}) {
  const release = (env.RELEASE || '').trim();
  const commit = (env.RELEASE_COMMIT || '').trim();

  if (release || commit) {
    const name = release || commit.slice(0, 7);
    return describeRelease({
      release: name,
      commit: commit || null,
      tag: FREEZE_TAG_RE.test(name) ? name : null,
      builtAt: (env.RELEASE_BUILT_AT || '').trim() || null,
      dirty: parseDirty((env.RELEASE_DIRTY || '').trim()),
      source: 'env',
    });
  }

  const fromGit = gitRelease({ cwd });
  if (fromGit) return describeRelease(fromGit);

  return describeRelease({
    release: null,
    commit: null,
    tag: null,
    builtAt: null,
    dirty: null,
    source: 'unknown',
  });
}

/* ------------------------------------------------------------------ *
 * The memoized one, for the server
 * ------------------------------------------------------------------ */

let cached = null;

/**
 * The release this process is running, computed once.
 *
 * ⚠️ Memoized deliberately and permanently: `/api/health` is polled every 15
 * seconds by the platform and once per probe by the load test, and the answer
 * cannot change without a restart. Calling `releaseInfo()` on that path would
 * fork a `git` process per health check on any machine that happens to have a
 * repository beside it.
 */
export function currentRelease() {
  if (!cached) cached = releaseInfo();
  return cached;
}

/** Test seam. */
export function resetReleaseCache() {
  cached = null;
}

/**
 * What `/api/health` and the panel carry. Deliberately small: the name, the
 * commit, when it was built, and whether it can say. No paths, no environment.
 */
export function releasePayload(info = currentRelease()) {
  return {
    release: info.release,
    commit: info.short,
    builtAt: info.builtAt,
    dirty: info.dirty,
    source: info.source,
    known: info.known,
    frozen: info.frozen,
  };
}
