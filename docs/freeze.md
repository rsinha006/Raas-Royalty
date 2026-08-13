# The freeze

PLAN.md item 27. **Cut it on the Wednesday before the event.** After that,
nothing ships except a genuine emergency, and a genuine emergency gets its own
tag.

```bash
npm run freeze              # can this be frozen, and what is frozen now?
npm run freeze -- --tag     # run the gate, then cut the tag
```

The freeze is a promise about what will be running on the Saturday. A promise
nobody can check is a note in a calendar, so this item is really three things:
a tag, a machine that can say which tag it is holding, and a way to compare
them.

---

## Why the freeze is affordable

Because almost nothing that goes wrong at the event needs a deploy. The panel
already covers the live cases, and every one of them was built so that the
answer under pressure is a click rather than a push:

| What happens | What you do instead of deploying |
| --- | --- |
| Everything is running 20 minutes late | **Schedule → Shift times** (item 15) |
| One block moved, or a location changed | Edit it in the panel |
| Fire alarm, evacuate | An announcement block to everyone (item 18) |
| Somebody made a mess of a change | **Log → Undo** (item 17) |
| "I don't see my warm-up" | **View as** that person (item 16) |
| Somebody lost their link | The desk index (item 28) |
| The app is down entirely | The printed pack (item 28), then `docs/ops.md` |
| The schedule in the sheet changed | Re-import — it is the same pipeline (item 24) |

If the answer to a problem is in that table, it is not an emergency. **Check the
table before you open an editor.** The failure this project is built around is a
plausible wrong answer, and an unrehearsed change made under pressure at a
competition is the most reliable way to produce one.

---

## Wednesday: cutting the freeze

**1. Run the gate.** It takes a couple of minutes, most of it the test suite.

```bash
npm run freeze
```

It refuses on four things, and each one is a release you would not want to be
running:

| Check | Why it stops you |
| --- | --- |
| Uncommitted changes | A tag names a commit, not your desk. The code you tested would exist nowhere. |
| The build or tests failing | The one moment a green suite is worth the wait. |
| Event readiness blockers | Item 26's gate: freezing the placeholder dates or a seed roster freezes the demo. |
| The machine holding a different release | Only checked with `--url`; see below. |

It also *warns*, without stopping you, about a commit that exists only on this
laptop, a freeze cut from a branch other than `main`, and commits that have
landed since the last freeze.

**2. Cut the tag.**

```bash
npm run freeze -- --tag
```

This creates an annotated tag named `release-YYYY-MM-DD` — dated in **the
venue's** timezone, not this laptop's. The message is the record: the event
dates, the roster and block counts, the test result, and the deploy command.
On the Saturday, `git show release-2026-09-09` is how you find out what the
event looked like when somebody decided this was the version to run.

> ⚠️ **A dirty tree is the one refusal `--force` cannot buy its way past.**
> Everything else is a judgement somebody at the event may legitimately
> override, and the override is written into the tag message so the next person
> reads it rather than discovering it. A tag over uncommitted changes is not a
> judgement call — it points at contents that exist nowhere and cannot be
> rebuilt.

**3. Push it.** A release that exists on one laptop is one stolen bag away from
not existing.

```bash
git push && git push origin release-2026-09-09
```

**4. Deploy it.**

```bash
fly deploy --ha=false \
  --build-arg RELEASE=release-2026-09-09 \
  --build-arg RELEASE_COMMIT=<sha> \
  --build-arg RELEASE_BUILT_AT=<iso>
```

`npm run freeze -- --tag` prints this line filled in — copy it from there rather
than typing it.

> ⚠️ **A plain `fly deploy` builds a machine that cannot say what it is.**
> `.git/` is in `.dockerignore` on purpose — an image gets pushed to a registry
> — so there is no repository inside the container to interrogate and no honest
> way to work it out at runtime. These build args are the entire channel. Without
> them the server reports its release as `unknown`, `npm run preflight` warns,
> and the Ops panel says so on its first card.

**5. Confirm the machine is holding it.**

```bash
npm run freeze -- --check --no-verify --url https://<host>
```

This is the comparison the whole item exists for, and it needs both halves: the
laptop knows the tag, the machine knows what was built into it. It has four
answers, and the third is the one to watch for —

- **holding the frozen release** — the only green one;
- **holding something else** — a blocker, named in both directions;
- **cannot say which release it is** — built without the args above. ⚠️ Not a
  match. A blank must never read as agreement;
- **unreachable** — a warning; that is `docs/ops.md`'s problem, not this one.

The same answer is in the panel under **Ops → Release**, for whoever is holding
a laptop rather than a terminal.

---

## After the freeze: what counts as an emergency

> A change qualifies if, **without it, somebody at the event is shown a wrong or
> missing schedule and there is no way to fix it from the panel.**

That is a high bar and it is meant to be. "Wrong" counts; "ugly" does not.
Re-read the table at the top first — if the fix is a click, take the click.

### The procedure

Assume you are in a loud room and somebody is waiting.

**1. Say what is broken, in one sentence, to somebody else.** Half of what feels
like an emergency stops being one when it is said out loud.

**2. Take a snapshot first.** Ops → *Take one now*, or:

```bash
npm run backup
```

**3. Branch from the tag that is running.** Not from `main` — `main` may have
things on it that were deliberately not frozen.

```bash
git switch -c hotfix/<what> release-2026-09-09
```

**4. Make the smallest change that fixes it.** Not the right change. The
smallest one. The right change is for the retro.

**5. Run the gate.** It is two minutes, and it is two minutes you will otherwise
spend finding out on the machine.

```bash
npm run freeze -- --tag
```

The new tag is `release-2026-09-09.1`, then `.2` — the sequence is what makes
the order of the day's releases legible afterwards. If a readiness check now
blocks for a reason that does not matter at 1pm on the Saturday, `--force`, and
the override is recorded in the tag.

**6. Deploy the line it prints, and confirm.**

```bash
npm run freeze -- --check --no-verify --url https://<host>
```

**7. Watch Ops → Phones connected.** A deploy restarts the process and every
socket reconnects; that card is how you know they did, rather than asking the
room.

**8. Write down what you did**, in `docs/decisions.md` or the commit message.
By Sunday nobody remembers which of three hotfixes is on the machine, and the
tag messages are the only record that is not somebody's memory.

### The cost of one deploy

`fly.toml` uses `strategy = "immediate"` because there is one machine holding
one volume and nothing to roll to. That means **a few seconds of downtime per
deploy**. Phones hold the app shell and their last known schedule (items 9 and
10), so they render "Offline · last known" and recover on their own — but a
deploy during the ten minutes a team is on stage is a self-inflicted incident.
Deploy between blocks.

### Going back instead of forward

Often the right move. The previous image is still there:

```bash
fly releases --image          # the image refs, newest first
fly deploy --image <ref>      # put an earlier one back
```

Rolling back the **code** never rolls back the **database** — migrations run
forward on every boot and are not reversed. Nothing in this repo has ever needed
a destructive migration, and event week is not the time for the first one.

---

## What not to do

- **Do not deploy from a dirty tree.** Whatever is on the machine then exists
  nowhere else, and cannot be rebuilt or rolled back to.
- **Do not `fly scale count 2`.** The volume attaches to one machine, so a
  second one is a second, empty database behind the same hostname. See
  `docs/deploy.md`.
- **Do not run `npm run seed:reset` on the machine.** It rebuilds the placeholder
  event over the real one.
- **Do not rotate `SESSION_SECRET` mid-event.** It signs out every phone at the
  venue. `ADMIN_PASSWORD` is fine to rotate; it only signs out the panel.
- **Do not skip the tag "just this once".** An untagged commit on the machine is
  the state this whole item exists to prevent: nobody can say what is running,
  including the person who pushed it.

---

## After the event

Run `npm run freeze` one last time and note the tag that finished the weekend —
that is the version the retro is about. Then export the edit log (PLAN.md's last
timeline row) to see what actually changed and how often, which is the input to
next year's version of this plan.
