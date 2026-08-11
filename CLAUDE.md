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
npm test             # 338 tests
npm run ci           # what CI runs: the client typecheck and build, then the tests
npm run codes -- --list   # every live access code and its subject
npm run load-test         # 600 virtual phones against an isolated fixture DB
```

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
- `server/sync/` — the import pipeline
- `client/sw.js` — the offline shell, emitted by `client/vite-plugin-sw.js`
- `client/src/viewer/` — the participant app
- `client/src/admin/` — the logistics panel

Eight things worth knowing before changing anything:

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
sync is meant to be an env-var change, not a rewrite. Two invariants inside it
are load-bearing and tested: a row's `sourceKey` **excludes time and location**,
so a block that moved is an update rather than a delete plus a create; and an
import owns exactly the rows carrying a `source_key`, so seed and hand-added
blocks stay invisible to the diff, `removeMissing` included.

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

Data model and spreadsheet templates are documented in [README.md](README.md).

## Current state

Phase A (1–4), Phase B (5–8), Phase D (15–18), and items 9, 10, 11, 13, 14, 19
and 20 are done — see
[PLAN.md](PLAN.md) for what each one settled. In short: the viewer is behind
access codes enforced server-side, event times are resolved against the venue's
timezone by the server, changes reach only the people they affect, each person's
"last updated" is their own, concurrent admin edits are refused rather than
silently merged, a whole afternoon can be pushed back in one previewed action,
a reload with no signal still shows the last known schedule, an admin can see
exactly what any one person sees, a change can be put back, "fire alarm,
evacuate" is one block rather than six, an upload of the wrong spreadsheet is
refused rather than half-applied, 600 concurrent phones have been measured
rather than assumed, and 338 tests run in CI.

Still not true: no deployment and no real data.

The design decisions that were blocking are settled in
[docs/decisions.md](docs/decisions.md) — read it before changing the data model,
the importer, or anything about access codes.
