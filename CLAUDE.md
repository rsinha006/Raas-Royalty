# Royalty

Live personalized event schedules for a dance competition (~280 participants
across dancers, exec board, judges, videographers, sponsors, and logistics —
last year was ~260; the ~170 previously recorded here was an underestimate).
Everyone opens the app, identifies themselves, and sees only their own schedule,
updating live as logistics changes things.

## Start here

**Read [PLAN.md](PLAN.md) at the start of every session.** It holds current
status, the open decisions, the access-code design that isn't built yet, and the
numbered task list. Update the status marker on an item in the same commit as
the work.

Record decisions in [docs/decisions.md](docs/decisions.md) as they're made —
otherwise the reasoning is lost between sessions and gets re-litigated.

## Running it

```bash
npm install && npm run seed && npm run build && npm start   # http://localhost:4000
npm run dev          # hot reload: client :5173, API :4000
npm run seed:reset   # rebuild placeholder data from scratch
```

Viewer at `/`, admin at `/admin` (password `royalty-admin` by default — set
`ADMIN_PASSWORD`). To see the app mid-event, pass a time override:
`/?now=2026-08-08T13:05`.

## Architecture

Express + Socket.IO + SQLite (better-sqlite3) in one process, serving a
React/Vite bundle from `client/dist`. No external services.

- `server/lib/queries.js` — reads, including the personalization logic
- `server/lib/mutations.js` — writes, all of which log to `edit_log`
- `server/sync/` — the import pipeline
- `client/src/viewer/` — the participant app
- `client/src/admin/` — the logistics panel

Two things worth knowing before changing anything:

**Roles are data, not an enum.** A role row's `selector` field decides whether
picking it asks for a team or a name. New roles need no deploy.

**One import pipeline.** `bytes → parseTabular → normalizeScheduleRows →
computeScheduleDiff → apply`. Manual upload, force re-sync, and background
polling all call `ingest()`. Keep it that way — swapping in live Google Sheets
sync is meant to be an env-var change, not a rewrite.

Data model and spreadsheet templates are documented in [README.md](README.md).

## Current state

Draft is complete and manually verified. No tests, no deployment, no real data,
and **no access control on the viewer** — anyone with the link can read any
participant's schedule and contact details. Fixing that is Phase B of the plan.

Phase A items 1–3 are done. The design decisions that were blocking are settled
in [docs/decisions.md](docs/decisions.md) — read it before changing the data
model, the importer, or anything about access codes.
