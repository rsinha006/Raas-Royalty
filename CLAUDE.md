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
npm test             # 93 tests
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
- `server/lib/viewer-auth.js` — code → session, re-checked on every request
- `server/lib/event-time.js` — the venue timezone; wall-clock → instant
- `server/sync/` — the import pipeline
- `client/src/viewer/` — the participant app
- `client/src/admin/` — the logistics panel

Four things worth knowing before changing anything:

**Roles are data, not an enum, and a person holds a set of them.** Roles live in
`person_roles`; captains hold `Dancer` + `Captain`. A role row's `selector`
marks whether it is reached individually or through a team code. New roles need
no deploy.

**Schema changes need a migration.** `schema.sql` only builds fresh databases —
anything an existing one needs goes in `server/migrate.js`, which runs on every
boot and must stay idempotent.

**One import pipeline.** `bytes → parseTabular → normalizeScheduleRows →
computeScheduleDiff → apply`. Manual upload, force re-sync, and background
polling all call `ingest()`. Keep it that way — swapping in live Google Sheets
sync is meant to be an env-var change, not a rewrite.

**The server owns time, the client owns its passing.** Blocks ship with
absolute `startsAt`/`endsAt` resolved against the venue's zone; the client only
compares instants and never parses a wall-clock string. Don't reintroduce
date-string parsing on the client.

Data model and spreadsheet templates are documented in [README.md](README.md).

## Current state

Phase A (1–4), Phase B (5–8), and items 9 and 13 are done — see
[PLAN.md](PLAN.md) for what each one settled. In short: the viewer is behind
access codes enforced server-side, event times are resolved against the venue's
timezone by the server, and 93 tests run under `npm test`.

Still not true: no deployment, no real data, no service worker, and every
change still wakes every client.

The design decisions that were blocking are settled in
[docs/decisions.md](docs/decisions.md) — read it before changing the data model,
the importer, or anything about access codes.
