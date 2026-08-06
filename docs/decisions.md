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
**Date:** 2026-08-05 · **Status:** decided · **amended 2026-08-05** — see the
inline corrections below, which resolve two inferences the director overruled.

**Question.** PLAN.md open decision 2 — six questions about the shape of the
data, held open because getting them wrong means a late schema change.

**Decision.** Five answered from the RRXVI sample data, one from the director.
See [sample-data-analysis.md](sample-data-analysis.md) for the evidence.

| Question | Answer |
| --- | --- |
| Can a dancer compete with two teams? | **No.** `people.team_id` stays single-valued. |
| Does anyone hold two roles? | **No.** Exactly one role each — director-confirmed. |
| Divisions or brackets above teams? | **No.** But teams carry a show order. |
| Does a team perform more than once? | **No.** One performance, running order 1–8. |
| Do judges need the running order or a scoring block? | **Neither, exactly** — see the judges entry below. |
| Is anything scheduled per-person within a team? | **Yes.** Captains and airport travellers. |

Schema consequences, to be applied in item 13:

- **`teams.show_order`** — integer 1–8, nullable until the draw. Worth
  surfacing on a dancer's phone ("you are 3rd, after UTD").
- ~~**`people.is_captain`**~~ and ~~**No `person_roles` join table**~~ —
  **both reversed** by *Captains hold a second role*, below. Captains are
  modelled as a second role, so the join table is built after all and the
  boolean is dropped. The template's `Captain?` column is what the importer
  reads to assign it.
- **No change** to block targeting. Three-way team/person/role still covers
  everything; what has to change is that the *import path* must emit
  person-level blocks from team-shaped source rows.

**Why.** Two of these were inferences from the past-year sheet that the director
overruled on 2026-08-05, both in the direction of *less* work:

**One role per person.** The analysis found `Ashka Patel` appearing under both
Logistics and Judging on every day tab and inferred one person holding two roles.
It is two different people who share a name — the same within-team name-collision
pattern the roster shows elsewhere. Every participant holds exactly one role, so
the `person_roles` join table this entry originally called for is not built.
`role_id` stays a single column and personalization keeps matching `=`.

The mixer task layer (`MIXER TASK SHEET` assigning `DIRECTOR`, `LOGS`,
`CREATIVE`, `PR`) is not a second role either — those are activities, and they
reach people as ordinary person-targeted blocks.

**Captains are not marked by the asterisk.** The analysis inferred that the
`*` / `**` suffix on ~27 roster names meant captain, on a count match with the
per-team captain number. It marks **food restrictions** and is irrelevant to this
app. `people.is_captain` survives, but it is populated from the template's
explicit `Captain?` column, not derived from name suffixes. The importer's only
duty toward the asterisk is to **strip it from names** — `Aaryan *` is a person
called Aaryan.

Captains still need blocks (the Friday Captain's Meeting) despite holding the
Dancer role like everyone else. The importer expands a captain-targeted source
row into person-level blocks using `is_captain`, rather than adding a fourth
targeting mode or making Captain a role — the latter would break "exactly one
role" and cut captains off from dancer-role blocks.

Everything else was a relief: the model already fits. The expensive risk in
PLAN.md's risk table — "late schema change forces rework" — is closed, and the
remaining change is two nullable columns.

---

## Access codes: per-person for staff, per-team for dancers
**Date:** 2026-08-05 · **Status:** decided

**Question.** PLAN.md open decision 1 — teams and individuals map cleanly onto a
schedule, but roles don't. A single shared "Judge" code lets any judge read any
other judge's schedule and contact details.

**Amended 2026-08-05** by *Captains hold a second role*, below: a team code now
lands on a team-scoped "which dancer are you?" step and yields a person session.
The code count is unchanged; what changes is that a dancer ends up individually
identified inside their team, which is what makes person-targeted blocks
(airport pickups) and role-targeted blocks (captains) reach them at all.

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

**Timezone confirmed 2026-08-05:** the venue is Bloomington, Indiana (Monroe
County), so `EVENT_TIMEZONE=America/Indiana/Indianapolis`.

Store the **IANA zone name, never a fixed offset.** Monroe County observes
daylight saving — it is EST (UTC−5) in winter and EDT (UTC−4) from March to
November. A config value of `EST` or `-05:00` would render every block an hour
early for any event held between spring and autumn, which is the silent
whole-schedule failure this decision exists to prevent. Indiana is also split
across two zones (the Gary and Evansville corners are Central), so a future venue
change must re-derive the zone rather than assume Indiana means one thing.

**Still pending:** the dates. Not locked as of 2026-08-05. The 2026-08-07 in
`data/` and in the template's event-date cell are placeholders.

**Implemented 2026-08-06 (item 9)**, with one split worth not re-litigating:
the server resolves every `(date, HH:MM)` pair into an absolute instant and
sends **both** — `startTime` for display, `startsAt` for comparison. Blocks
therefore carry each time twice, which looks redundant and is not.

The wall-clock string is what people read off a call sheet and must survive
verbatim; the instant is the only thing safe to compare, because comparing
wall-clock times requires knowing the zone, which is exactly what a phone gets
wrong. Splitting them this way is what lets the client hold zero timezone logic
while still ticking a live countdown: it knows *that* time passes, the server
knows *what* the times mean.

The same reasoning makes a bad `EVENT_TIMEZONE` fatal at startup rather than a
fallback to the default. A fallback would boot a healthy-looking server serving
~280 shifted schedules — the precise failure this decision exists to prevent —
and the only way to reach it is a config change at deploy time.

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

---

## Captains hold a second role, reached through a team-scoped identity step
**Date:** 2026-08-05 · **Status:** decided

**Question.** Three blocks apply to captains and nobody else — Captains Meeting,
lighting cues check, judges' meeting. The rest of a captain's weekend is
identical to any dancer's. How do those three reach them?

**Decision.** Two changes, which only work together:

1. **A team session gains an identity step.** Entering a team code lands on
   "which dancer are you?", scoped to that team, and the result is a **person
   session**. The server verifies the chosen person belongs to the team the code
   authorized.
2. **Captains hold `Dancer` + `Captain`.** This restores the `person_roles` join
   table that the data-model entry above deleted. `Captain` is an ordinary row in
   `roles`, so it needs no deploy. The three captain blocks target
   `role = Captain`.

`people.is_captain` is **dropped** — membership in the Captain role replaces it.
The template's `Captain?` column stays; it is what the importer reads to assign
the second role.

**Why.** `resolveSession` in `server/lib/queries.js` gives a team session the
targets `[team, dancerRole]` — no person target, and no way to know which of a
team's 25 dancers is holding the phone. So under per-team codes alone, **no
captain-specific block of any kind can reach a captain**, role-targeted or not.
Change 2 without change 1 does nothing.

The same gap silently breaks something we had already committed to: airport
arrivals and departures are grouped by *flight*, not by team ("UTD & Aryan P",
"Anaga Srikumar and Nihar Soman"), so individual dancers need person-level
blocks with pickup times hours apart from their teammates. Those were
unreachable too. The identity step is not a captain feature; it is what makes
person-targeting work for dancers at all.

The step is deliberately **not** a security boundary. Anyone holding a team code
can select any name on that team and read that person's schedule. That is
already true of a shared team code by design — the code is a bearer token for
the whole team's data — and teammates knowing each other's flight times is not
a leak worth engineering against. The boundary that matters is between teams,
and between dancers and staff; both are unaffected.

**Why a role rather than a flag.** The alternative was `people.is_captain` plus
an importer that expands one captain-targeted source row into 27 person-blocks.
Three captain events × 27 captains is 81 rows to bulk-shift when the day runs
late (item 15), to reverse as a unit (item 17), and to re-create by hand if
logistics adds a fourth captain block mid-event. That last case is precisely the
pressure that makes people abandon the app for a group chat. Role targeting is
one row for all of it.

This does not contradict the director's "everyone holds exactly one role" — that
is true of the org chart, where nobody is both Logistics and Judging. Captain is
an overlay on Dancer, not a second seat, and modelling it as a role is an
internal choice rather than a claim about the roster.

**What it costs.** The `person_roles` join table, a migration, multi-role
handling in the admin person editor, and an importer that emits two roles for
anyone marked `Captain?`. Personalization itself is nearly free —
`blocksForTargets` already ORs an arbitrary target list, so a second role is one
more entry in `targets`.

---

## The template iterates on its own track; the app does not wait for it
**Date:** 2026-08-05 · **Status:** decided

**Question.** `templates/royalty-schedule-template.xlsx` is not final — logistics
will keep revising it until they have a copy they like. Does engineering wait for
that, or build around it?

**Decision.** Build around it. The template blocks exactly **one** item — 12, the
importer — plus the parts of 19 and 24 that depend on it. Everything else
proceeds now, in this order:

1. **Item 4**, anonymized fixtures. Derived from `samples/`, not the template.
2. **Phase B** (5–8), access codes. The largest remaining chunk, the one flagged
   security-critical, and entirely template-independent.
3. **Items 9, 13, 11, 14, 10** — timezone, the two schema columns, scoped
   broadcasts, correctness gaps, service worker. All independent.
4. **Phase D** (15–18), admin tooling.
5. **Item 12 last**, against a frozen template.

Within item 12, only the tab readers depend on the template's shape. The existing
pipeline — `bytes → parseTabular → normalizeScheduleRows → computeScheduleDiff →
apply` — is format-dependent only in its first two stages. Diff classification,
apply, the `ingest()` contract, and the validation-reporting surface can all be
built and tested now. The same split applies to item 19: time parsing, midnight
handling, diff classification, and the access-code authorization negatives are
all testable against fixtures today; only the tab-reading tests wait.

**Why.** The alternative is idle time on a fixed event date, which is the one
resource this project cannot buy more of. The risk being accepted is rework in
item 12 if the template churns late — bounded, because it is confined to the
readers, and because we control the file rather than reverse-engineering someone
else's.

---

## The access-link export carries no contact details
**Date:** 2026-08-06 · **Status:** decided

**Question.** Item 8's done-when is "the exact file you'll mail-merge from". A
mail merge needs an address. Should the CSV join in each subject's contact card
so the file is self-sufficient?

**Decision.** No. The export is subject type, subject, team, role, code, link,
last used — and nothing else. Recipient addresses come from whatever list
logistics actually mails from, joined on the subject name.

**Why.** `people.contact_id` is not a person's own contact card. It is the card
they should *call* — their coordinator — and it is shared across a whole role:
in the seed, all twelve exec board members point at the Event Director's card,
and every dancer on a team points at that team's liaison. A "Send To" column
built from it would have produced a file that mails a dozen people's private
access links to one inbox, and the failure is silent because the column looks
plausible on inspection. This was caught by reading the seeded data, not the
schema, which is the general lesson.

Nothing in the data model holds a participant's own email or phone — not the
roster template either, whose contact column is the same coordinator field. So
the honest export is one that does not pretend to know, and the panel says so
where an admin will read it before running the merge.

**What this costs.** One join step in whatever runs the merge. Cheap, and
visible: an unmatched name shows up as a row nobody sent, which is exactly the
failure you want rather than a link delivered to the wrong person.

**What would change it.** Adding real per-person contact details — an owner
column on the roster, or a `people.email` — is the prerequisite for a
self-sufficient export. If item 24 introduces one, revisit this and add the
column then, not before.

The cost is that the app cannot be demonstrated end-to-end with real data until
the template lands, so **the template is on the critical path for the dress
rehearsal (item 26) even though it is last in the build order.** Track its
progress as a dependency with a date, not as a background task. If it is not
final by T-2 weeks, the rehearsal is at risk regardless of how much else is
finished.
