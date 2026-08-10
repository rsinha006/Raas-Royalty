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
npm test             # 217 tests
npm run codes -- --list   # every live access code and its subject
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
- `server/lib/viewer-auth.js` — code → session, re-checked on every request
- `server/lib/live.js` — socket rooms, scoped broadcasts, the origin policy
- `server/lib/event-time.js` — the venue timezone; wall-clock → instant
- `server/db.js` — `target_versions`: per-subject "last updated"
- `server/sync/` — the import pipeline
- `client/sw.js` — the offline shell, emitted by `client/vite-plugin-sw.js`
- `client/src/viewer/` — the participant app
- `client/src/admin/` — the logistics panel

Six things worth knowing before changing anything:

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
sync is meant to be an env-var change, not a rewrite.

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

Data model and spreadsheet templates are documented in [README.md](README.md).

## Current state

Phase A (1–4), Phase B (5–8), and items 9, 10, 11, 13, 14, 15 and 16 are done — see
[PLAN.md](PLAN.md) for what each one settled. In short: the viewer is behind
access codes enforced server-side, event times are resolved against the venue's
timezone by the server, changes reach only the people they affect, each person's
"last updated" is their own, concurrent admin edits are refused rather than
silently merged, a whole afternoon can be pushed back in one previewed action,
a reload with no signal still shows the last known schedule, an admin can see
exactly what any one person sees, and 217 tests run under `npm test`.

Still not true: no deployment and no real data.

The design decisions that were blocking are settled in
[docs/decisions.md](docs/decisions.md) — read it before changing the data model,
the importer, or anything about access codes.
