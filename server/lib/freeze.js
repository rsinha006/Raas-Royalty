/**
 * The freeze — PLAN.md item 27. "Tag the release on the Wednesday before. No
 * changes after that except genuine emergencies."
 *
 * A freeze is a promise about what will be running on the Saturday, and a
 * promise is only worth as much as the ability to check it. Three things have
 * to be true, and none of them are true of `git tag` on its own:
 *
 *   1. **The tag names something that exists.** `git tag` tags the commit, not
 *      the desk it was typed at — so a tag made from a tree with uncommitted
 *      changes points at code that was never run and never will be. ⚠️ This is
 *      the one check with no override: the fix is always "commit it", never
 *      "tag it anyway", so `--force` cannot reach it.
 *   2. **The thing being frozen was worth freezing.** The tests, the build, and
 *      the item 26 readiness gate — because a tag around a placeholder event is
 *      a freeze of the demo. Composed from `readinessReport()` rather than
 *      re-asked here, for the reason that file gives at length: readiness
 *      checks that disagree with the code they describe are worse than none.
 *   3. **Drift after the freeze is visible.** The freeze is not "nothing
 *      changes" — it is "every change after this point is deliberate and
 *      recorded". So the report keeps counting: N commits since the tag, and
 *      whether the *running machine* is holding the release that was frozen.
 *
 * That last comparison needs both halves and neither can do it alone. This file
 * runs on a laptop and knows the tag; `release.js` runs on the machine and
 * knows what was built into it. Which is also why nothing here is imported by
 * the server: there is no repository inside the image (`.git/` is in
 * `.dockerignore`), so a freeze check running there could only ever guess.
 *
 * Runbook, including what counts as a genuine emergency: docs/freeze.md.
 */
import { BLOCKER, OK, WARN, readinessReport, venueToday } from './readiness.js';
import { FREEZE_TAG_RE, git, hasGit } from './release.js';

export { BLOCKER, OK, WARN };

const check = (key, level, title, { detail = null, fix = null, items = [] } = {}) => ({
  key,
  level,
  title,
  detail,
  fix,
  items,
});

/* ------------------------------------------------------------------ *
 * What git says about this tree
 * ------------------------------------------------------------------ */

/** One freeze tag, parsed so a re-freeze sorts after the freeze it replaces. */
function parseFreezeTag(tag) {
  const m = FREEZE_TAG_RE.exec(tag);
  if (!m) return null;
  return { tag, date: m[1], seq: m[2] ? Number(m[2]) : 0 };
}

/**
 * ⚠️ The sequence is a number, and git hands these back sorted as strings.
 * Lexically `release-2026-08-19.10` comes *before* `.2`, so "the newest freeze"
 * — which is what every drift check below compares the machine against — would
 * quietly be an older one. The date part is ISO and so sorts correctly as text;
 * only the suffix needs this.
 */
const byFreezeOrder = (a, b) => (a.date === b.date ? a.seq - b.seq : a.date < b.date ? -1 : 1);

/**
 * Everything the gate needs, in one read of the repository.
 *
 * Taken as a parameter everywhere below rather than called inline, so the
 * checks are testable without a repository in whatever state the test happens
 * to leave one — the gate itself has to be exercised by something other than
 * running it.
 */
export function gitState({ cwd } = {}) {
  const opts = cwd ? { cwd } : {};
  if (!hasGit(cwd)) return { repo: false, freezes: [], tagsOnHead: [], remoteBranches: [] };

  const commit = git(['rev-parse', 'HEAD'], opts);
  if (!commit) return { repo: false, freezes: [], tagsOnHead: [], remoteBranches: [] };

  const status = git(['status', '--porcelain'], opts) ?? '';
  const dirtyFiles = status ? status.split('\n').map((l) => l.trim()).filter(Boolean) : [];

  const tagsOnHead = (git(['tag', '--points-at', 'HEAD'], opts) ?? '')
    .split('\n')
    .map((t) => t.trim())
    .filter(Boolean);

  const freezes = (git(['tag', '--list', 'release-*'], opts) ?? '')
    .split('\n')
    .map((t) => t.trim())
    .filter(Boolean)
    .map(parseFreezeTag)
    .filter(Boolean)
    .sort(byFreezeOrder);

  const latest = freezes.length ? freezes[freezes.length - 1] : null;
  const since = latest ? Number(git(['rev-list', '--count', `${latest.tag}..HEAD`], opts) ?? NaN) : null;

  const remoteBranches = (git(['branch', '--remotes', '--contains', 'HEAD'], opts) ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  return {
    repo: true,
    commit,
    short: commit.slice(0, 7),
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD'], opts),
    dirty: dirtyFiles.length > 0,
    dirtyFiles,
    tagsOnHead,
    freezes,
    latestFreeze: latest,
    /** Commits made after the newest freeze — the "except genuine emergencies" count. */
    commitsSinceFreeze: Number.isFinite(since) ? since : null,
    // Same comparator, for the same reason: `git tag --points-at` is sorted as text.
    freezeOnHead: tagsOnHead.map(parseFreezeTag).filter(Boolean).sort(byFreezeOrder).at(-1) ?? null,
    hasRemote: (git(['remote'], opts) ?? '').length > 0,
    remoteBranches,
  };
}

/**
 * The next tag to cut, from the venue's today.
 *
 * The venue's, not the laptop's, for the same reason every other date in this
 * project is: whoever cuts the freeze may be in a different zone from the event,
 * and a tag dated the day before the freeze meeting is a small confusion at
 * exactly the wrong moment. A second freeze on the same day gets `.1`, `.2` —
 * which is also the shape an emergency change takes on the Saturday.
 */
export function nextFreezeTag(state = gitState(), { at = new Date() } = {}) {
  const date = venueToday(at);
  const today = (state.freezes ?? []).filter((f) => f.date === date);
  if (!today.length) return `release-${date}`;

  /**
   * ⚠️ One past the highest, never the first gap. Filling a hole — `.1` when
   * `.2` and `.10` exist — cuts a tag that sorts *before* releases that already
   * happened, so the freeze somebody just made would not be the latest freeze,
   * and the drift check would go on comparing the machine against an older one.
   */
  const highest = today.reduce((max, f) => Math.max(max, f.seq), 0);
  return `release-${date}.${highest + 1}`;
}

/* ------------------------------------------------------------------ *
 * The gate
 * ------------------------------------------------------------------ */

/**
 * Can this tree be frozen, and what is frozen right now?
 *
 * @param {object}  opts
 * @param {object}  opts.git          `gitState()`, injectable
 * @param {object}  opts.readiness    item 26's report, injectable
 * @param {object?} opts.verification `{ran, ok, detail}` from `npm run ci`
 * @param {object?} opts.running      what a live server reports, if one was asked
 */
export function freezeReport({
  at = new Date(),
  git: state = gitState(),
  readiness = readinessReport({ at }),
  verification = null,
  running = null,
} = {}) {
  const checks = [];

  /* ------------------------------- the tree ------------------------------ */

  if (!state.repo) {
    checks.push(
      check('tree', BLOCKER, 'This is not a git repository, so there is nothing to tag.', {
        fix: 'Run the freeze from a clone of the repo.',
      })
    );
  } else if (state.dirty) {
    checks.push(
      check('tree', BLOCKER, `${state.dirtyFiles.length} uncommitted change${state.dirtyFiles.length === 1 ? '' : 's'} in the working tree.`, {
        detail:
          'A tag names the commit, not the desk. Tagging now would produce a release whose ' +
          'contents exist nowhere — the code that was tested is sitting in these files.',
        // Not truncated here. The renderer caps the list and says how many it
        // held back, so a cap on both sides makes "…and 2 more" the tail of a
        // tail — a smaller number than the title, from the same report.
        items: state.dirtyFiles,
        fix: 'git status, then commit or stash. This is the one check --force cannot skip.',
      })
    );
  } else {
    checks.push(check('tree', OK, `Working tree clean at ${state.short}.`));
  }

  /* ------------------------------- branch -------------------------------- */

  if (state.repo && state.branch && state.branch !== 'main') {
    checks.push(
      check('branch', WARN, `Freezing from ${state.branch}, not main.`, {
        detail: 'Legitimate for an emergency fix branch; a surprise for a scheduled freeze.',
        fix: 'git switch main, unless this is the hotfix branch you mean to ship.',
      })
    );
  } else if (state.repo) {
    checks.push(check('branch', OK, `On ${state.branch}.`));
  }

  /* ------------------------------- pushed -------------------------------- */

  if (state.repo && state.hasRemote) {
    if (state.remoteBranches.length) {
      checks.push(check('pushed', OK, `HEAD is on ${state.remoteBranches.join(', ')}.`));
    } else {
      checks.push(
        check('pushed', WARN, 'This commit exists only on this machine.', {
          detail:
            'The tag would too. The event depends on being able to rebuild this exact release ' +
            'from somewhere other than the laptop it was cut on.',
          fix: 'git push, then git push --tags after the freeze.',
        })
      );
    }
  }

  /* -------------------------- build and tests ---------------------------- */

  if (!verification) {
    checks.push(
      check('verified', WARN, 'The build and tests were not run in this invocation.', {
        detail: 'A freeze is the one moment a green suite is worth the wait.',
        fix: 'npm run freeze  (it runs npm run ci; --no-verify skips it)',
      })
    );
  } else if (!verification.ok) {
    checks.push(
      check('verified', BLOCKER, 'The build or the tests are failing.', {
        detail: verification.detail ?? null,
        fix: 'npm run ci',
      })
    );
  } else {
    checks.push(check('verified', OK, verification.detail ?? 'npm run ci is green.'));
  }

  /* ---------------------------- event readiness -------------------------- */

  /**
   * Composed, never re-asked. ⚠️ Item 26's whole argument applies with more
   * force here: a freeze is the last moment anybody looks, and a gate that
   * disagrees with `npm run rehearsal` on the Wednesday is a gate that gets
   * argued with rather than obeyed.
   */
  const blocking = readiness.checks.filter((c) => c.level === BLOCKER);
  const warning = readiness.checks.filter((c) => c.level === WARN);
  if (blocking.length) {
    checks.push(
      check('readiness', BLOCKER, `${blocking.length} event readiness blocker${blocking.length === 1 ? '' : 's'}.`, {
        detail: 'Freezing now would freeze the placeholder — the dates, the roster, or an empty day.',
        items: blocking.map((c) => c.title),
        fix: 'npm run rehearsal',
      })
    );
  } else if (warning.length) {
    checks.push(
      check('readiness', WARN, `Event data ready, with ${warning.length} gap${warning.length === 1 ? '' : 's'}.`, {
        items: warning.map((c) => c.title),
        fix: 'npm run rehearsal',
      })
    );
  } else {
    checks.push(check('readiness', OK, 'Event readiness has nothing to report.'));
  }

  /* ----------------------------- freeze state ---------------------------- */

  if (state.repo) checks.push(freezeStateCheck(state));

  /* ------------------------- what is actually running -------------------- */

  if (running) checks.push(runningCheck(running, state));

  const blockers = checks.filter((c) => c.level === BLOCKER);
  const warnings = checks.filter((c) => c.level === WARN);

  return {
    at: new Date(at).toISOString(),
    checks,
    blockers: blockers.length,
    warnings: warnings.length,
    /** The tree check is the only one `--force` cannot buy its way past. */
    fatal: blockers.some((c) => c.key === 'tree'),
    canFreeze: blockers.length === 0,
    nextTag: nextFreezeTag(state, { at }),
    latestFreeze: state.latestFreeze?.tag ?? null,
    git: state,
    readiness,
  };
}

/**
 * Where this repository stands relative to its own freeze.
 *
 * Three states, and the middle one is the point of the whole item: commits
 * *after* a freeze are not an error — an emergency fix on the Saturday is
 * exactly what the plan allows — but an untagged one leaves a machine running
 * something no tag describes, which is the state the freeze exists to prevent.
 */
function freezeStateCheck(state) {
  if (!state.freezes.length) {
    return check('frozen', WARN, 'Nothing has been frozen yet.', {
      detail: 'The plan freezes on the Wednesday before the event.',
      fix: 'npm run freeze -- --tag',
    });
  }

  const latest = state.latestFreeze;
  if (state.freezeOnHead) {
    return check('frozen', OK, `HEAD is ${state.freezeOnHead.tag}.`, {
      detail: `${state.freezes.length} freeze tag${state.freezes.length === 1 ? '' : 's'} in this repository.`,
    });
  }

  const n = state.commitsSinceFreeze;
  if (n === null) {
    return check('frozen', WARN, `Frozen at ${latest.tag}, which is not an ancestor of HEAD.`, {
      detail: 'HEAD is on a different line of history from the freeze.',
      fix: 'git log --oneline ' + latest.tag + '..HEAD',
    });
  }

  return check('frozen', WARN, `${n} commit${n === 1 ? '' : 's'} since ${latest.tag}.`, {
    detail:
      'Every one of these is a change made after the freeze. That is allowed for a genuine ' +
      'emergency and requires a new tag — an untagged commit that reaches the machine leaves ' +
      'nobody able to say what is running.',
    fix: `npm run freeze -- --tag   (or git revert). Diff: git log --oneline ${latest.tag}..HEAD`,
  });
}

/**
 * Is the machine running what was frozen?
 *
 * ⚠️ "The server does not know" is its own answer and must not read as a match.
 * A build made without the release build-args reports `unknown`, and the
 * comfortable mistake would be to treat a blank as agreement — which is exactly
 * how `package.json`'s permanent `1.0.0` would have behaved (see release.js).
 */
function runningCheck(running, state) {
  const expected = state.latestFreeze?.tag ?? null;

  if (running.error) {
    return check('running', WARN, 'Could not ask the running server which release it holds.', {
      detail: running.error,
      fix: 'curl -s <host>/api/health',
    });
  }

  if (!running.known) {
    return check('running', WARN, 'The running server cannot say which release it is.', {
      detail:
        'It was built without the release build-args, so there is no way to tell the frozen ' +
        'release from a Friday-night push — the image has no repository in it to ask.',
      fix: 'Redeploy with the command npm run freeze prints. See docs/freeze.md.',
    });
  }

  if (!expected) {
    return check('running', WARN, `The server is running ${running.release}, and nothing is frozen.`, {
      fix: 'npm run freeze -- --tag',
    });
  }

  if (running.release !== expected) {
    return check('running', BLOCKER, `The machine is running ${running.release}, not ${expected}.`, {
      detail:
        (running.dirty ? 'It was also built from a dirty tree. ' : '') +
        'Whatever is serving phones right now is not the release that was frozen and rehearsed.',
      fix: `Redeploy ${expected}, or freeze what is actually running. docs/freeze.md.`,
    });
  }

  return check('running', OK, `The machine is running ${expected}.`, {
    detail: running.builtAt ? `Built ${running.builtAt}.` : null,
  });
}

/* ------------------------------------------------------------------ *
 * Cutting the tag
 * ------------------------------------------------------------------ */

/**
 * The tag's own message.
 *
 * An annotated tag because the message is the record: on the Saturday,
 * `git show release-2026-08-19` should say what the event looked like when
 * somebody decided this was the version to run. A lightweight tag carries a
 * commit and nothing about why it was chosen.
 */
export function freezeTagMessage({ tag, report, verification = null, overrides = [], at = new Date() }) {
  const dates = report.readiness.checks.find((c) => c.key === 'dates');
  const roster = report.readiness.checks.find((c) => c.key === 'roster');
  const counts = roster?.counts;

  const lines = [
    `Royalty freeze — ${tag}`,
    '',
    `Cut ${new Date(at).toISOString().slice(0, 16).replace('T', ' ')}Z from ${report.git.short} on ${report.git.branch}.`,
    `Event: ${dates?.title ?? 'unknown'}`,
  ];

  if (counts) {
    lines.push(
      `Data: ${counts.people} people on ${counts.teams} teams, ${counts.blocks} blocks ` +
        `(${counts.seeded} still seed), ${counts.withContact} reachable.`
    );
  }

  lines.push(
    `Checks: ${verification?.ok ? verification.detail ?? 'npm run ci green' : 'npm run ci NOT RUN'}; ` +
      `readiness ${report.readiness.blockers} blockers, ${report.readiness.warnings} warnings.`
  );

  if (overrides.length) {
    lines.push('', `Frozen with --force over: ${overrides.join(', ')}.`);
  }

  lines.push(
    '',
    'No changes after this except genuine emergencies, and an emergency change',
    'gets its own tag — see docs/freeze.md.',
    '',
    deployCommand(tag, report.git.commit)
  );

  return lines.join('\n');
}

/**
 * The deploy that stamps the release into the image.
 *
 * ⚠️ A plain `fly deploy` builds an image that cannot identify itself — there
 * is no `.git` in the build context, so these arguments are the only channel.
 * Printed everywhere a freeze is mentioned for that reason.
 */
export function deployCommand(release, commit, { builtAt = new Date().toISOString() } = {}) {
  return (
    'fly deploy --ha=false \\\n' +
    `  --build-arg RELEASE=${release} \\\n` +
    `  --build-arg RELEASE_COMMIT=${commit ?? ''} \\\n` +
    `  --build-arg RELEASE_BUILT_AT=${builtAt}`
  );
}

/** Create the annotated tag. Returns `{ok, error}` — never throws at a CLI. */
export function createFreezeTag(tag, message, { cwd } = {}) {
  const opts = cwd ? { cwd } : {};
  const existing = git(['tag', '--list', tag], opts);
  if (existing) return { ok: false, error: `${tag} already exists.` };
  const result = git(['tag', '-a', tag, '-m', message], opts);
  if (result === null) return { ok: false, error: 'git tag failed — is anything configured to sign tags?' };
  return { ok: true, tag };
}

/**
 * Ask a running server what it is. Separate from the checks so the report stays
 * synchronous and testable: the fetch is the only thing here that can hang.
 */
export async function askRunningRelease(baseUrl, { fetchImpl = fetch, timeoutMs = 5_000 } = {}) {
  const url = `${String(baseUrl).replace(/\/+$/, '')}/api/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    const body = await res.json();
    // A 503 is still an answer about *which* release is failing, so the release
    // is read either way — an unhealthy machine is exactly when this is asked.
    if (!body || typeof body !== 'object' || !body.release) {
      return { error: `${url} returned no release field (HTTP ${res.status}).` };
    }
    return { ...body.release, url, status: res.status };
  } catch (err) {
    return { error: `${url}: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}
