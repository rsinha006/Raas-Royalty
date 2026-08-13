# Royalty

Live personalized event schedules for a dance competition (~280 participants
across dancers, exec board, judges, videographers, sponsors, and logistics —
last year was ~260; the ~170 previously recorded here was an underestimate).
Everyone opens their own access link and sees only their own schedule, updating
live as logistics changes things.

## Start here

**Read [PLAN.md](PLAN.md) at the start of every session.** It holds current
status, the settled decisions, and the numbered task list. Update the status
marker on an item in the same commit as the work.

Record decisions in [docs/decisions.md](docs/decisions.md) as they're made —
otherwise the reasoning is lost between sessions and gets re-litigated.

## Running it

```bash
npm install && npm run seed && npm run build && npm start   # http://localhost:4000
npm run dev          # hot reload: client :5173, API :4000
npm run seed:reset   # rebuild placeholder data from scratch
npm test             # 562 tests
npm run ci           # what CI runs: the client typecheck and build, then the tests
npm run codes -- --list   # every live access code and its subject
npm run days              # the four event days; --friday YYYY-MM-DD moves them all
npm run codes -- --check       # coverage AND reachability; exits 1 on either
npm run codes -- --send-list   # every access link and the address it goes to
npm run load-test         # 600 virtual phones against an isolated fixture DB
npm run preflight         # the production config checks, against this environment
npm run backup            # a verified snapshot now; --list shows what is kept
npm run restore           # what is available to restore; --yes replaces the database
npm run callsheets        # the printed fallback pack; --check reports who it misses
npm run rehearsal         # can a dress rehearsal answer its own question? --check exits 1
```

Deploying is Fly.io, one machine, one volume — [docs/deploy.md](docs/deploy.md).
Backups, monitoring and alerting during the event — [docs/ops.md](docs/ops.md).
The one page for whoever holds the panel — [docs/admin-guide.md](docs/admin-guide.md).

Admin at `/admin` (password `royalty-admin` by default — set
`ADMIN_PASSWORD`). The viewer needs an access code: open `/s/:code` from the
list above, or manage them in the panel's **Access codes** tab. To see the app
mid-event, pass a time override in **venue** time: `/?now=2026-08-08T13:05`.

## Architecture

Express + Socket.IO + SQLite (better-sqlite3) in one process, serving a
React/Vite bundle from `client/dist`. No external services.

- `server/lib/queries.js` — reads, including the personalization logic
- `server/lib/mutations.js` — writes, all of which log to `edit_log`
- `server/lib/time-shift.js` — the bulk "everything from 3pm moves 20 min"
- `server/lib/view-as.js` — the admin preview of one subject's own schedule
- `server/lib/undo.js` — reverting one admin action, or refusing to
- `server/lib/viewer-auth.js` — code → session, re-checked on every request
- `server/lib/live.js` — socket rooms, scoped broadcasts, the origin policy
- `server/lib/event-time.js` — the venue timezone; wall-clock → instant
- `server/db.js` — `target_versions`: per-subject "last updated"
- `server/lib/distribution.js` — who each access link is sent to, and why not
- `server/lib/event-days.js` — re-dating the weekend from one date
- `server/lib/backup.js` — verified snapshots, retention, the off-box copy
- `server/lib/ops.js` — error capture, alerts, the heartbeat, `/api/health`
- `server/lib/call-sheets.js` — the printed fallback pack, and what it leaves out
- `server/lib/presence.js` — which phones are connected, and what version each holds
- `server/lib/readiness.js` — whether a rehearsal against this data would mean anything
- `server/sync/` — the import pipeline
- `client/sw.js` — the offline shell, emitted by `client/vite-plugin-sw.js`
- `client/src/tabstrip.ts` — the one ARIA tabs implementation, used by all four
- `client/src/viewer/` — the participant app
- `client/src/admin/` — the logistics panel

Fifteen things worth knowing before changing anything:

**Block targets are four-way, and the fourth is not like the others.** A block
targets a team, a person, a role, or `everyone` — the announcement audience,
whose id is always `all` and which every session's targets contain. ⚠️ It is a
block target *only*: never a session subject, never an access-code subject. The
three-way CHECKs on `access_codes` and the view-as route are deliberately
unchanged, and tests hold that line.

**Roles are data, not an enum, and a person holds a set of them.** Roles live in
`person_roles`; captains hold `Dancer` + `Captain`. A role row's `selector`
marks whether it is reached individually or through a team code. New roles need
no deploy.

**Schema changes need a migration.** Both files run on every boot, and the split
is by *what* is changing, not by how new the database is. A brand-new table is
fine in `schema.sql` — `CREATE TABLE IF NOT EXISTS` reaches an existing database
too (`target_versions` arrived that way). **Anything that touches an existing
table — a new column, a new index over one, a backfill — goes in
`server/migrate.js`**, because `schema.sql` runs first and the column may not
exist yet. Everything in either file must stay idempotent.

**One import pipeline.** `bytes → parseTabular → normalizeScheduleRows →
computeScheduleDiff → apply`. Manual upload, force re-sync, and background
polling all call `ingest()`. Keep it that way — swapping in live Google Sheets
sync is meant to be an env-var change, not a rewrite. Four invariants inside it
are load-bearing and tested. A row's `sourceKey` **excludes time and location**,
so a block that moved is an update rather than a delete plus a create; and an
import owns exactly the rows carrying a `source_key`, so seed and hand-added
blocks stay invisible to the diff, `removeMissing` included. ⚠️ **The reader
takes named tabs, not `worksheets[0]`** — `Export` for the schedule, `People` and
`Roster` for the roster, falling back to the first sheet so a CSV still works;
the event's workbook has sixteen tabs and the first is Instructions, which reads
as 158 rows of prose. ⚠️ **An import that yields zero rows is refused even when
nothing errored**, because `Export` is entirely formulas: a copy saved by
anything that does not calculate them reads as a few note rows and no errors at
all, and applying that against `removeMissing` deletes every managed block
behind a green result. A row with one non-empty cell is a note (the Export tab
ends with three), not five errors on every correct import.

**A person's own address and the card they call are different columns.**
`people.email` / `people.phone` are theirs, and are how item 25 sends them their
access link. `people.contact_id` is the card they should *call* — a dancer's
team liaison — and it is **shared**: every dancer on a team points at the same
one. ⚠️ Building a send list out of `contact_id` mails a dozen private bearer
tokens to one inbox and looks entirely correct doing it, which is why
`server/lib/distribution.js` reads `people.email` and nothing else and a test
mails nothing to a shared card. The roster reader splits the two in
`rosterContacts`, at the point they are read, rather than leaving every consumer
to know the difference — item 24's first cut did not, and made 280 people their
own coordinator with every dancer shown their own phone number.

**The roster is two tabs, and a default role belongs to a sheet.** `People`
carries `Full Name` and a `Type` in the event's vocabulary; `Roster` splits the
name across two columns and is dancers throughout. One upload reads both and
every error names its tab — they both have a row 2. ⚠️ The Roster tab defaults
to Dancer because *the tab* says so; a `People` row with a blank `Type` is
unfinished and must stay an error, never a guess. The trailing `*` on a name is
a food restriction and comes off; `Captain?` is the only thing that makes a
captain, in both directions.

**The event is four days, and `event_days` is data.** Thursday to Sunday: teams
land on the first and fly out on the last, and those are person-targeted blocks
read at an airport. A block whose `Day` has no row is refused per row, so a
missing day is a silent hole rather than an error. Dates move with `npm run
days`, which never touches the keys — `schedule_blocks.day` is a foreign key
onto them and `Sat` means "the third day". ⚠️ Both the script and the migration
that backfills Thursday and Sunday **derive rather than invent**: a date that is
not the weekday it was given as is refused, and a non-contiguous weekend is left
alone, because all four days move together and one wrong date still renders as a
perfectly plausible schedule.

**The server owns time, the client owns its passing.** Blocks ship with
absolute `startsAt`/`endsAt` resolved against the venue's zone; the client only
compares instants and never parses a wall-clock string. Don't reintroduce
date-string parsing on the client.

**A socket room is a block target.** `team:t_alpha`, `person:p_alice`,
`role:dancer` — and a socket joins one room per entry in
`resolveSession(...).targets`, the same list the schedule query ORs over. That
symmetry is what keeps "who hears about this block" and "whose schedule contains
this block" from drifting apart, so keep it. Broadcast payloads carry no
audience: who is affected is a room, never a field on the wire.

**The same key carries "last updated".** `target_versions` is keyed on that
identical `type:id` pair, bumped inside `createBlock`/`updateBlock`/`deleteBlock`
so every write path is covered, and a viewer's `updatedAt` is the newest of their
own targets — not the event's. A target with no row falls back to the global
timestamp, which every write bumps, so `backfillTargetVersions()` runs on every
boot to make sure every target has one. Removing it silently restores the global
behaviour.

**The service worker caches the shell, never data.** `/api/*` and `/socket.io/*`
are not intercepted at all — no `respondWith`, so there is no path by which a
cached schedule reaches the app. The offline story is the `localStorage` cache in
`session.ts`, which the viewer renders behind an "Offline · last known" banner;
a service-worker copy would come back as an ordinary 200 and render as live.
Navigations are network-first so a redeploy reaches phones that already
installed; `/s/:code` is network-only because serving it the shell is an
infinite redirect. Tests cover each of these — don't relax them.

**One request is one batch, and undo works on batches.** The admin router stamps
`req.batchId` in middleware, and every `logEdit` and mutation `ctx` in that
request carries it. That is deliberate: a request's *irreversible* writes land in
the same batch as its reversible ones, so undo refuses a person-delete rather
than restoring blocks for someone no longer on the roster. Don't thread batch ids
per route, and don't offer undo per log row — item 15 exists to stop half a day
sitting 20 minutes from the other half.

**Per-request CPU on `/api/schedule` is the fan-out ceiling.** better-sqlite3 is
synchronous, so 600 phones refetching after one change are served one at a time:
the settle time is the per-request cost times the fleet. That makes three caches
on this path load-bearing rather than premature — memoized instants in
`event-time.js`, the zone-abbreviation formatter beside them, and `prepareCached`
in `db.js` for the two queries whose SQL varies only by target count. Together
they took `getPersonalizedSchedule` from 388µs to 105µs; measured numbers are in
[docs/load-test.md](docs/load-test.md). ⚠️ Adding an `Intl` construction, or a
`db.prepare` of assembled SQL, back into this path costs every phone at once.

**The palette is measured, and the measurements are tests.** Every text colour
clears WCAG AA against every surface it is painted on, and every *control*
boundary clears 3:1 — which is why there are two border variables: `--line` and
`--line-soft` are decorative card edges, `--line-strong` is the boundary of
anything tappable or typable. `tests/accessibility.test.js` parses the shipped
stylesheet and fails on the ratio, so a colour tweak that drops below the floor
is caught with the number it landed on. ⚠️ Two traps it guards, both of which
were real: `.block.is-past` must not fade itself with `opacity` — element
opacity fades text and the card it is measured against together, so no colour
choice can rescue it — and a `var(--x)` with no declaration and no fallback is
a silent wrong colour, which is what `var(--accent)` was. The full audit and
the open hardware checks are in [docs/device-matrix.md](docs/device-matrix.md).

**The deploy is one machine, and persistent state lives beside the database.**
A Fly volume attaches to a single machine, so a second machine is a second,
empty database behind the same hostname — not more capacity. `--ha=false` and
`min_machines_running = 1` are load-bearing, and a test asserts the second.
⚠️ **Anything that has to survive a restart derives its path from `dataDir` in
`db.js`, never from `__dirname`.** In development the two are the same `data/`
folder, so this class of bug has no local symptom at all: on the machine the
application directory is rebuilt by every deploy, and a file written relative to
the source tree is silently discarded. That is exactly what had happened to the
re-sync cache in `sync/sources.js`. `server/lib/deploy-config.js` refuses to
boot in production on four settings that would each otherwise produce a server
passing its own health check; `npm run preflight` runs the same checks strictly.
New checks go in at `warn`, because a 2am restart must not be blocked by a
missing hostname. Runbook: [docs/deploy.md](docs/deploy.md).

**A backup is only a backup once something has opened it.** Every snapshot is
re-opened, `integrity_check`ed and counted against the live database before it
is kept, and one that fails is deleted rather than left in the directory —
⚠️ an empty SQLite file is *structurally valid*, so it passes every check there
is and restores to an event with nobody in it. Two more traps, both of which
were real: a snapshot must be sealed (`-wal`/`-shm` removed) before the rename,
or the orphans are invisible to the listing and therefore never pruned; and
staleness is measured from the last verified *run*, never from the newest file's
mtime, because a run that finds the database unchanged writes no file and would
otherwise report an idle, perfectly backed-up event as stale. ⚠️ The alarm that
matters lives outside the machine: `HEARTBEAT_URL` is a dead-man's switch,
because nothing running in this process can report that this process stopped.
`/api/health` fails only when phones are not being served — keep it that narrow,
and keep it at one indexed row. Runbook: [docs/ops.md](docs/ops.md).

**The printed pack comes from the viewer's own query, and a sheet is a group
plus its members.** `call-sheets.js` calls `getPersonalizedSchedule` and prints
what it returns — same rule as `view-as.js`, because paper is read at the moment
nothing is left to check it against. ⚠️ A team session holds no person-targeted
and no Captain blocks (the identity step has not happened), so printing that
view alone yields a sheet with **every airport pickup missing and no error
anywhere**. Each member therefore gets a section of `their payload \ the shared
payload`, a set difference on block ids and never a second derivation of who
sees what. ⚠️ **Codes are on the desk index and on nothing that gets handed
out** — a team sheet ends up on a green-room wall, and a photograph of it is a
live credential; there is a test that no code reaches the handout pack. Coverage
(a person on no sheet, a block on no sheet) is reported rather than assumed,
because both are silent everywhere else. Guide:
[docs/admin-guide.md](docs/admin-guide.md).

**A green rehearsal against the placeholder is indistinguishable from a real
one.** Dates that have already happened, six example roster rows and two
entirely empty days all render as a perfectly ordinary schedule, and every test
in this repo passes against them — so item 26's gate asks the questions nothing
else does: are the dates real and still ahead of us (checked against the *venue's*
today), did the schedule come from an import or from the seed (`source = 'seed'`
is provenance, not a headcount guess), and does every event day have anything on
it. ⚠️ Everything else it reports it **composes** — `deploy-config.js`,
`access-codes.js` + `distribution.js`, `call-sheets.js`, `backup.js` — because
four readiness checks that agree with each other and disagree with the code they
describe is worse than none. Note the trap in `deploy-config.js`'s shape: a
check's `level` is the severity it carries *if* it fails and `ok` is the result,
so `failing(checks, …)` is the accessor and `level === 'fail'` is a gate that can
never be green. The other half of item 26 is `presence.js`: each viewer reports
the `updatedAt` it is rendering, ⚠️ compared against `versionForTargets` for that
socket's *own* targets — a comparison against `scheduleUpdatedAt()` would mark
all fifteen phones in a room behind the moment any one team changed. Three
states, not two: a phone that has never reported is *silent*, and calling that
"up to date" is the comfortable lie. ⚠️ Admin sockets are panels even when they
resolve to a viewer subject — cookies are per browser, so the rehearsal driver's
own laptop otherwise sits in the list as a phone that never updates. Script:
[docs/dress-rehearsal.md](docs/dress-rehearsal.md).

Data model and spreadsheet templates are documented in [README.md](README.md).
Loading the real roster and schedule — the order, the tabs, and the two that
reach nothing — is [docs/loading-data.md](docs/loading-data.md). Getting the
links to people is [docs/distributing-links.md](docs/distributing-links.md).

## Current state

Phase A (1–4), Phase B (5–8), Phase D (15–18), and items 9, 10, 11, 13, 14, 19,
20, 22, 23 and 28 are done. Item 21's accessibility half is done and its hardware
half is a checklist in [docs/device-matrix.md](docs/device-matrix.md); items 24
and 25 have their engineering done and their content half is a gap list in
[docs/loading-data.md](docs/loading-data.md); item 26's tooling and script are
built and the rehearsal itself needs people and real data — see
[PLAN.md](PLAN.md) for what each one settled. In short: the viewer is behind
access codes enforced server-side, event times are resolved against the venue's
timezone by the server, changes reach only the people they affect, each person's
"last updated" is their own, concurrent admin edits are refused rather than
silently merged, a whole afternoon can be pushed back in one previewed action,
a reload with no signal still shows the last known schedule, an admin can see
exactly what any one person sees, a change can be put back, "fire alarm,
evacuate" is one block rather than six, an upload of the wrong spreadsheet is
refused rather than half-applied, 600 concurrent phones have been measured
rather than assumed, the screen is navigable by heading, by keyboard and by
screen reader with every colour measured against AA, a production deploy cannot
come up with the default password or on a disk the next push wipes, the event
data is copied off the machine every few minutes and verified on the way out,
the event's own sixteen-tab workbook loads through the same pipeline as
everything else, every access link knows who it is addressed to and refuses to
guess when it does not, the weekend prints onto paper that cannot disagree with
the phones, "did every phone get that?" is a number on the panel rather than
fifteen people being asked, a rehearsal against placeholder data is refused by
name rather than passing quietly, and 562 tests run in CI.

Still not true: **nothing is actually deployed** — item 22 built the config, the
guardrails and the runbook, but `fly deploy` needs an account and has not been
run, and the image has never been built. Item 23's snapshots, health check and
alerting are built and exercised locally, but the backup target, the heartbeat
and the alert webhook have nothing real to point at until there is a deploy —
and nobody is named in `ON_CALL_NAME` / `ON_CALL_PHONE`, so item 28's desk sheet
prints a blank where the number goes.

**And still no real data** — which is now the only thing in the way. Item 24
built and demonstrated the path from the workbook into the database; what is
missing is what goes in it: the real dates (the placeholder is 2026-08-07, which
has passed), ~80 staff against 6 example rows, ~200 dancers against 1, an email
or phone for each of them so item 25 has somewhere to send their link, and
Thursday, Friday and Sunday, which are almost entirely the Manual Blocks tab and
have one example row between them.

The design decisions that were blocking are settled in
[docs/decisions.md](docs/decisions.md) — read it before changing the data model,
the importer, or anything about access codes.
