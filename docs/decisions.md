# Decisions

Why things are the way they are. [PLAN.md](../PLAN.md) tracks *what* to do; this
tracks *why* it was decided. Add an entry whenever a choice gets made that a
future session would otherwise re-litigate.

Format: one entry per decision, newest at the bottom.

```
## <Short title>
**Date:** YYYY-MM-DD · **Status:** decided | superseded by <entry>

**Question.** What was actually being decided.

**Decision.** What we chose.

**Why.** The reasoning, including what we gave up.
```

---

## Stack: single Node server + SQLite
**Date:** 2026-08-04 · **Status:** decided

**Question.** Where should this run, and what should store the data?

**Decision.** Express + Socket.IO + SQLite (better-sqlite3) in one process,
serving a React/Vite bundle. Deployable to Railway, Fly, or Render.

**Why.** Live updates need real WebSockets, which serverless platforms can't
hold — Next.js on Vercel would have meant adding Pusher or Ably, a dependency
and a cost. One process and one file database is the most reliable shape for a
two-day event where uptime matters more than scale. Postgres was rejected as
setup and an external service to manage for no benefit at this size.

---

## Block targeting is three-way
**Date:** 2026-08-04 · **Status:** decided

**Question.** How do schedule blocks get matched to people?

**Decision.** A block targets a team, a single person, or an entire role. A team
session sees its team's blocks plus the dancer role's blocks; a person session
sees their own, their role's, and their team's if they have one.

**Why.** Team-and-person-only would force admins to duplicate "All Judges
Briefing" across every judge. A global "everyone" broadcast was considered and
deferred — see the open question about event-wide announcements in PLAN.md
item 18.

---

## Admin access is one shared password
**Date:** 2026-08-04 · **Status:** decided

**Question.** How is the logistics panel gated?

**Decision.** One shared password (`ADMIN_PASSWORD`) issuing a signed session
cookie, with admins typing their name so the edit log records who made each
change.

**Why.** A two-day event doesn't warrant accounts. A secret URL with no password
was rejected because anyone glancing over a shoulder would get full write access
to the live schedule.

---

<!-- Open decisions awaiting resolution are listed in PLAN.md. Move them here
     with reasoning once settled. -->
