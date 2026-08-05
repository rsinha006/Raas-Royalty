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

## Data model: what the past-year data settled
**Date:** 2026-08-05 · **Status:** decided

**Question.** PLAN.md open decision 2 — six questions about the shape of the
data, held open because getting them wrong means a late schema change.

**Decision.** Five answered from the RRXVI sample data, one from the director.
See [sample-data-analysis.md](sample-data-analysis.md) for the evidence.

| Question | Answer |
| --- | --- |
| Can a dancer compete with two teams? | **No.** `people.team_id` stays single-valued. |
| Does anyone hold two roles? | **Yes.** Needs a schema change — see below. |
| Divisions or brackets above teams? | **No.** But teams carry a show order. |
| Does a team perform more than once? | **No.** One performance, running order 1–8. |
| Do judges need the running order or a scoring block? | **Neither, exactly** — see the judges entry below. |
| Is anything scheduled per-person within a team? | **Yes.** Captains and airport travellers. |

Schema consequences, to be applied in item 13:

- **`person_roles` join table** replacing the single `people.role_id`.
  Personalization in `queries.js` matches `role_id IN (…)` instead of `=`.
- **`teams.show_order`** — integer 1–8, nullable until the draw. Worth
  surfacing on a dancer's phone ("you are 3rd, after UTD").
- **`people.is_captain`** — captains are a real scheduling unit (Captain's
  Meeting, a distinct `CAPTAINS` bussing group), and the new import template
  already carries a `Captain?` column.
- **No change** to block targeting. Three-way team/person/role already covers
  captains (a role) and airport travellers (person-blocks); what has to change
  is that the *import path* must emit person-level blocks from team-shaped
  source rows.

**Why.** Two roles per person is the only one of these that costs anything, and
the past-year sheet shows it plainly — one name appearing under both Logistics
and Judging on every day tab, with different activities in each row. There is a
residual chance it's two people who share a name (the roster has several genuine
within-team name collisions), but a join table is cheap now and a migration
during event week is not, so we design for it either way rather than waiting for
the director to confirm.

Everything else was a relief: the model already fits. The expensive risk in
PLAN.md's risk table — "late schema change forces rework" — is now bounded to
one join table and two columns.

---

## Access codes: per-person for staff, per-team for dancers
**Date:** 2026-08-05 · **Status:** decided

**Question.** PLAN.md open decision 1 — teams and individuals map cleanly onto a
schedule, but roles don't. A single shared "Judge" code lets any judge read any
other judge's schedule and contact details.

**Decision.** One code per **team**, shared within the team by design. One code
per **staff member** — board, liaison, judge, videographer — not per staff role.
Role-level codes exist in the schema and may be issued as a deliberate admin
choice for a group whose schedule contains nothing personal (sponsors are the
likely case), but they are the exception and never the default.

**Why.** The team code leaking to the whole team is the intended behaviour: a
team's schedule is the same for everyone on it, and the captain forwarding the
link is how distribution actually happens. A role code leaking is different —
it exposes N individual schedules and N phone numbers to anyone holding it, and
the person who leaks it isn't the person harmed.

What we give up: roughly 70–80 staff codes to generate and distribute instead of
half a dozen, and a correspondingly larger "I lost my link" load at check-in.
Item 8 (admin code management with CSV export for mail-merge) and item 28's
decided answer for the check-in desk are what make that affordable — they are no
longer optional.

Judges are per-person under this rule, but because a judge's schedule turns out
to hold nothing personal (see the judges entry), falling back to one shared
judge code is a safe retreat if per-judge management proves more trouble than
it's worth. That is the only such retreat available; do not extend it to
liaisons or board.

---

## Judges get the running order plus a few role blocks
**Date:** 2026-08-05 · **Status:** decided

**Question.** Do judges get personalized schedules, or something smaller?

**Decision.** Judges see the running order — already a first-class object once
`teams.show_order` exists — plus arrival, meals, and briefing as role-targeted
blocks. No per-judge authored schedule.

**Why.** Judges had no rows at all in last year's master sheet; they were
evidently handed the Show Order tab and nothing else. Authoring individual judge
schedules would mean inventing data that has never existed, for the audience
that needs it least. The running order is what a judge actually consumes during
the show, and we get it for free.

Side effect worth noting: this is what makes a shared judge code a defensible
fallback under the access-code decision, since nothing a judge sees is personal
to them.

---

## The schedule's source of truth is a structured template we import
**Date:** 2026-08-05 · **Status:** decided

**Question.** Last year's master schedule is a merged Gantt wall chart, not a
table — 651–751 merged ranges per day, meridiem written on end times only, text
and grid disagreeing in 8.6% of cells. Do we build a decoder for that, ask
logistics to work in the admin panel instead, or something else?

**Decision.** Neither extreme. Logistics fills in
`templates/royalty-schedule-template.xlsx` — still a day-by-day grid, because
that is how they think, but with the structure the app needs baked in: an
explicit event date, ID'd People and Teams tabs, dropdown-constrained team
assignment, sequences and slot times that compute team blocks, and a Timeline
tab that tells them whether the day still fits. The app imports that file.

**Why.** The wall chart is a working document edited live during the weekend —
its `Changes` tab is a running TODO list and `Conflict` appears as literal cell
text. A decoder for it would be a large, permanently fragile piece of work
whose failure mode is a silent twelve-hour error on the one thing the product
exists to show. Moving logistics wholesale into the admin panel removes that
work but asks them to abandon the grid mid-planning, which the past-year
artifact suggests they'd route around.

The template keeps the grid and moves the ambiguity to authoring time, where a
human is present to resolve it, instead of import time, where nobody is.

This reshapes item 12: it is a **template importer** — read known tabs, validate
against the checks the workbook already computes, reject with row-level errors —
not the column-mapping UI PLAN.md described, and not a general grid decoder. The
messy-input lessons from the analysis (phone normalization, name trimming,
meridiem inheritance, within-team name collisions) still apply, because the
Roster and People tabs are pasted in from the same sources as before.

The admin panel remains the source of truth for **live changes during the
weekend**. The template is how the weekend is loaded; the panel is how it is
flown.

---

## Event timezone is server-authoritative and configured, not inferred
**Date:** 2026-08-05 · **Status:** decided

**Question.** PLAN.md open decision 3 — "now / next" currently renders against
the phone's local clock, so a traveller with a mis-set device sees a silently
shifted schedule.

**Decision.** One IANA timezone for the whole event, held server-side and set by
config (`EVENT_TIMEZONE`). The server resolves now/next and sends resolved state;
the client never derives event time from its own clock. Event dates likewise come
from config and from the template's event-date cell — nothing is hardcoded to
2026-08-07.

**Why.** Wrong is worse than absent here, because now/next is the whole product,
and the failure is silent — a shifted schedule looks exactly like a correct one.
Making it a single server-side value also means a venue change is a config edit,
not a hunt through date handling.

**Pending, not blocking:** the actual values. Dates are not locked as of
2026-08-05. The timezone default is `America/Indiana/Indianapolis` on the
evidence that this is an IU-run event in Bloomington; **confirm this against the
venue before item 24** — Indiana has two zones and the Bloomington/Evansville
split is a real trap. The seeded 2026-08-07 in `data/` and in the template's
event-date cell are placeholders and should be treated as such.

---

## Plan for ~280 participants, load test at 600
**Date:** 2026-08-05 · **Status:** decided

**Question.** CLAUDE.md assumes ~170 participants; the past-year roster counts
186 dancers plus a stray note reading "Board Members / 65", implying ~260.

**Decision.** Size everything for **280**. Item 20's load test targets **600**
concurrent connections rather than the 400 originally written.

**Why.** 170 was an estimate; 260 is a count off the previous year's own files,
and headcount only ever drifts up as liaisons, judges, videographers and sponsors
get added late. The cost of over-provisioning a single-process Node server is
approximately zero; the cost of discovering the ceiling at 1pm on Saturday is the
event. It also moves item 25 — 280 access links to generate and distribute, not
170.

**Pending:** this year's actual headcount, once the rosters land. It changes the
number, not the decision.
