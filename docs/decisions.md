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

**Implemented 2026-08-06 (item 13)**, with three choices a future session would
otherwise reopen:

**`people.role_id` was dropped rather than kept as a "primary role".** Keeping it
would have been the smaller diff, and it is the wrong shape: the same fact in two
places diverges the first time someone is edited through a path that only knows
about one of them, and the failure is a schedule query silently using the stale
half. A person's display role is instead *derived* — the role they hold with the
lowest `roles.sort_order`. `Captain` is given a high sort order so it never wins
that comparison, and a captain reads as a "Dancer" everywhere on screen.

**`Captain.selector` is `person`, and the personal-code rule became a negative.**
`selector` no longer means what it originally did — the role picker it named was
deleted in item 6 — and now effectively reads "reached individually". The rule
for issuing a personal code had to flip from *holds a person-selector role* to
*holds no team-selector role*, because under the positive form a captain's
`Captain` half would have earned them their own code. That is exactly the pile of
unmanaged dancer credentials the access-code decision exists to prevent. Worth
renaming `selector` one day; not worth a migration during event prep.

**A team session that has not identified anyone gets Dancer only, never
Captain.** Before the identity step the server cannot know whose phone it is, so
including Captain there would put the Captains' Meeting on all 25 dancers'
screens. This is the concrete reason changes 1 and 2 above only work together.

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

---

## Broadcast scoping is done with rooms, not with an audience in the payload
**Date:** 2026-08-06 · **Status:** decided · **Constrains:** 11, 20, and any
future push-notification work

**Question.** Item 11 as written says the audience (`personIds` / `teamIds`) is
already computed for the edit log, so put it in the broadcast and let clients
ignore changes that don't affect them. The same item warns that doing exactly
that turns the wide-open Socket.IO origin into a leak. Which half wins?

**Decision.** Neither: the audience never leaves the server. Sockets join a room
per block target — `team:t_alpha`, `person:p_alice`, `role:dancer` — and a
change is emitted only to the rooms its block targets. The payload is unchanged
from before item 11: `{ updatedAt, changedBlockIds, at }`, which says that
something changed and nothing about who it changed for.

**Why.** Client-side filtering means every connected socket receives every
audience list. That is a roster-shaped disclosure — who is on which team, who
has a personal block — delivered to anything holding a socket, and it would have
been the second time this project shipped an endpoint that hands out the roster
(the first was `/api/bootstrap`, closed in item 6). Rooms deliver the same
saving without the disclosure, and they save more: an unaffected client receives
no bytes at all rather than receiving and discarding them, which is what the
item was actually for.

**The property that makes it maintainable:** a room name *is* a block target,
and a socket joins one room per entry in `resolveSession(...).targets` — the
same list `blocksForTargets` ORs over to build that person's schedule. "Who
hears about this block" and "whose schedule contains this block" are therefore
one computation, not two that can drift. A fourth targeting mode would need no
change in `server/lib/live.js` at all.

**What this costs.** Room membership is derived from the handshake cookie, so a
session change has to re-handshake — `resyncSession()` on the client, called on
sign-in, identify, and sign-out. And a roster edit can move someone between
teams, so roster broadcasts re-derive every open socket's rooms server-side.
Both are covered by tests; the second is the one that would fail silently.

**What would change it.** Per-block content in the payload (item 14's "your 2pm
moved" or a future push layer) does not change this decision — it strengthens
it. The rooms are already the audience, so the content goes to the same place;
it must never be broadcast alongside an audience list instead.

---

## The socket origin is same-origin plus an explicit allow-list
**Date:** 2026-08-06 · **Status:** decided · **Constrains:** 11, 22

**Question.** Socket.IO was configured `{ origin: true, credentials: true }`,
which reflects whatever origin asks — any page on the internet could open an
authenticated socket. What replaces it, given the deploy target isn't fixed yet
(item 22) and a wrong value means no live updates at the event?

**Decision.** The request's own `Host` is always allowed, plus `PUBLIC_BASE_URL`
and anything in `SOCKET_ORIGINS`, plus localhost/LAN origins when
`NODE_ENV !== 'production'`. Enforced in `allowRequest`, which is the one hook
that sees the request. A request with no `Origin` header is allowed.

**Why same-origin as the default.** It needs no configuration and cannot be got
wrong at deploy, which matters because the failure mode of a mis-set allow-list
is "nothing updates live during the event" and nobody would find it until
Saturday. A browser sends the page's `Origin` and the target's `Host`
separately: the real app, served from the host it connects to, always matches;
`evil.example` opening a socket against us never does.

**Why a missing `Origin` is allowed.** Browsers always send one cross-site, so
its absence means a non-browser client — which carries no cookie, joins no
rooms, and learns nothing. Refusing it would break same-origin polling, where
browsers omit the header, for no security gain.

**At deploy (item 22):** set `PUBLIC_BASE_URL`. It is already needed for the
access-link export, and it makes the socket policy explicit rather than
inferred from a proxy's host header.

---

## "Last updated" is per subject, keyed on block targets
**Date:** 2026-08-07 · **Status:** decided · **Constrains:** 14, 15, 24

**Question.** Every viewer was shown one global `schedule_updated_at`, so an
edit to any team told all ~280 phones "Last updated a moment ago". Mildly
alarming and, for 279 of them, false. What should a participant's timestamp
actually be?

**Decision.** A new `target_versions` table keyed on `(target_type, target_id)`
— the same `type:id` pair that names a socket room. A session's `updatedAt` is
the newest of its own `resolveSession(...).targets`, floored by a separate
`roster_updated_at` for changes that have no audience to derive.

**Why not derive it from `schedule_blocks.updated_at`.** A deletion leaves no
row behind, and "your 3pm was cancelled" is exactly the change a timestamp has
to move for. `MAX(updated_at)` over someone's blocks would go *backwards* when a
block was removed.

**Why the same key as the rooms.** Item 11 established that a room name is a
block target, so "who hears about this block" and "whose schedule contains it"
are one computation. This makes "whose last-updated moves" the third face of the
same thing rather than a fourth notion that drifts. The bumps live in
`createBlock` / `updateBlock` / `deleteBlock`, so every write path — manual,
import, background re-sync — is covered without each route remembering.

**⚠️ The fallback has to be a value that writes never move.** The first cut fell
back to the global `schedule_updated_at`, which every write bumps — so a target
with no row did not read as stale, it read as *freshly changed by somebody else's
edit*. That is the original bug, restored through the back door, and a missed
`touchTargets` would have reproduced it with no null, no error and nothing to
notice. The fallback is now `target_versions_epoch`, written once at first boot
and never again, so the same mistake surfaces as a timestamp stuck in the past —
wrong in a direction somebody reports. Pinned by a test that fails against the
old fallback.

**`backfillTargetVersions()`** gives every target with blocks a real baseline so
the epoch is only ever reached by a target that has never had one. It runs on
every boot and after the seed, and is deliberately not reported as a migration
because it is a data self-heal, not a schema change.

**What we gave up.** Roster edits still raise a floor under everyone, because a
renamed team or a reassigned contact card can change what an unrelated schedule
renders and there is no block to narrow it with. That is the same residual item
11 recorded for the `roster:updated` broadcast, and it is rare mid-event.

---

## Concurrent block edits are refused, not merged
**Date:** 2026-08-07 · **Status:** decided · **Constrains:** 14, 15, 17

**Question.** Two logistics people editing the same block was silently
last-write-wins: the second save overwrote the first with no sign either had
happened. What should happen instead?

**Decision.** Optimistic concurrency on the block editor. The panel sends the
`updatedAt` it loaded; a mismatch is a 409 carrying the block as it now stands,
and the panel shows what it would have overwritten with an explicit choice —
edit the current version, or discard. Nothing is merged and nothing is
auto-resolved.

**Why refuse rather than merge.** A field-level merge would produce a block
nobody typed — one admin's room with another's time — and it is exactly the
blocks people edit simultaneously that are the ones running late. A wrong time
on a call sheet is worse than a refusal, which is the whole premise of this
project.

**Why it is opt-in.** The importer omits the token deliberately: it reconciles
against a file rather than against a screen someone read, and `source_key`
already decides what it owns. Bolting the check onto imports would make a
re-sync fail whenever a manual edit had touched a managed row.

**The client half is the bigger fix.** Both editing panels were keyed on
`refreshKey`, so *any* live event from another admin remounted them and threw
away a half-typed block or roster row with no message at all — the concurrent-
edit problem itself, not a fix for it. `SchedulePanel` and `RosterPanel` now
take the key as a prop and reload in place. The read-only panels (Overview,
Codes, Log) stay keyed; they hold nothing anyone typed.

**The conflict banner is derived, not stored.** It is "the open draft's block,
when the freshly-loaded copy no longer matches the version the draft was opened
against" — so it appears the moment the block moves underneath rather than
waiting for Save to fail, and there is no second, staler copy of the block in
state to keep in sync.

---

## Deleting a subject takes its blocks, after asking
**Date:** 2026-08-07 · **Status:** decided · **Constrains:** 14, 24

**Question.** Deleting a person or team left their schedule blocks behind
pointing at an id nothing resolves. What happens to those blocks?

**Decision.** The delete is refused with a 409 naming the count until the caller
confirms, and then the blocks go in the same transaction — one `deleteBlock` per
block, so each gets its own edit-log line with an audience. Blocks are removed
*before* the roster row, so the log can still name the person. The roster
importer's `removeMissing` path does the same.

**Why refuse first.** Orphaned blocks are invisible to every participant — no
session has that target — so nothing surfaces them, and they still count in the
admin totals. But silently deleting schedule data on a roster edit is worse.
The count comes from the moment of deletion rather than from page load, which
matters when the panel has been open for an hour.

**A team takes only its own blocks.** Its dancers are unassigned rather than
deleted (`people.team_id` is `ON DELETE SET NULL`), so their person-targeted
blocks still resolve and still belong to them — an airport pickup does not stop
existing because a team was renamed through delete-and-recreate.

**Left alone:** a deleted subject's access code stays live-but-orphaned. Item 8
already surfaces those in the panel with a null label and allows revoking them,
and reissuing for a deleted subject would mint a credential with no schedule
behind it.

---

## A bulk time shift is previewed, then applied whole
**Date:** 2026-08-07 · **Status:** decided · **Constrains:** 15, 16, 17

**Question.** Running late is the most common live change at this event —
"everything from 3pm moves 20 minutes" — and doing it block by block across 8
teams is forty edits under pressure. What shape should the bulk version take,
and what happens when part of it can't be applied?

**Decision.** Two steps, like an import: preview what would move, then apply
the list that was on screen. The preview is the confirmation — there is no
second "are you sure", because a dialog that only repeats a number is a click
people learn to make without reading. Every row is unticked-able, so the
airport pickup that isn't running late stays put. The apply is **all or
nothing**: any block that has changed since the preview, been deleted, or can't
move refuses the entire batch, and nothing is written.

**Why all-or-nothing.** A partly applied shift is the worst outcome available
here. Half a day's schedule 20 minutes from the other half looks exactly like a
correct schedule — nothing on any screen says which half is which — and the
people it misleads are on stage. A refusal an admin can read and retry is
strictly better, and this is the same reasoning as refusing concurrent block
edits rather than merging them.

**Why the apply takes explicit block ids**, rather than re-deriving them from
the day and cutoff it was given. Between preview and apply someone else can add
a block after the cutoff. Re-deriving would sweep it into a change nobody
reviewed; the id list means the batch is exactly what was approved. Each id
carries the `updatedAt` it was previewed at, which is item 14's concurrency
token — required here rather than optional, because every caller of this route
is a screen someone read a list off.

**The day key moves, the end time doesn't.** A block is a day key plus two
`HH:MM` strings, and `blockInstants` already reads "end at or before start" as
"ran past midnight" — Friday 23:30 → Saturday 03:45 is a real call time here.
So a shift moves the start, carries the block to the adjacent event day if that
crosses midnight, and shifts the end as a plain clock reading. The past-midnight
relationship then re-derives itself. Rolling the end forward explicitly as well
would double-count exactly that case.

**A block with nowhere to land is refused, not guessed.** Crossing midnight into
a day the event doesn't have would mean writing a time against a day key whose
date is 24 hours out from what the block now means — which renders as a
perfectly normal block at the wrong time. It is named in the preview and left
for a human. The ±12 hour cap on a shift exists for the same reason: it
guarantees at most one midnight is crossed, so "which day is this now" is one
step to an adjacent date rather than a search.

**Adjacency is by date, not by `sort_order`.** The next row in the day list is
not necessarily the next calendar day — a Thursday arrivals day followed by a
Saturday finals day would otherwise silently move a midnight block a whole day.

**Each moved block still gets its own edit-log line**, with its audience, under
one summary line for the batch. The summary is what an admin scans for; the
per-block lines are what "why did my 3pm move" is answered from. The summary is
derived from what actually moved rather than from what was typed, so it cannot
describe a shift that didn't happen.

---

## The service worker caches the shell and nothing else
**Date:** 2026-08-10 · **Status:** decided

**Question.** How much should the offline service worker cache? The obvious
answer is "the app and its data", and there are well-worn recipes for caching
API responses with a stale-while-revalidate strategy.

**Decision.** The worker caches the app shell only — the HTML and the JS/CSS
pair the build emits, listed from the real bundle by `client/vite-plugin-sw.js`.
`/api/*` and `/socket.io/*` are not intercepted at all: no `respondWith`, no
code path in which a cached response reaches the app. `/s/:code` and `/admin`
are network-only with written offline pages. Navigations are network-first with
a 3.5s timeout; hashed assets are cache-first and nothing is stored at runtime
except the shell HTML.

**Why.** The app already has a schedule cache, in `localStorage`, and the thing
that makes it safe is that the viewer *knows* it is a cache: it renders behind
an "Offline · last known 5:13 AM" banner with the timestamp it was captured at.
A cached `/api/schedule` in the service worker would come back through
`api.get()` as an ordinary 200 and render as live. That is the same class of
bug as the timezone one item 9 removed — a plausible, confident, wrong answer —
and it would appear precisely when someone is checking whether their call time
moved. Caching only the shell means the worker cannot produce a wrong schedule,
because it never holds one.

Three consequences worth keeping:

**Nothing personal is ever written to the cache.** The shell is byte-identical
for all ~280 people. The Cache Storage API outlives the session cookie and is
shared by everyone who uses that phone, so a redeemed `/s/:code` response or a
schedule payload sitting in it would undo what item 6 closed. Runtime caching is
restricted to the shell HTML for this reason rather than as an optimization.

**Navigations are network-first, not cache-first.** Cache-first is the
conventional choice and it is wrong here: a phone that installed the worker on
Friday would serve Friday's HTML — and therefore Friday's asset hashes —
through every refresh, so an emergency fix during the event would reach nobody
who had already opened the app. The timeout exists for venue wifi that is
associated but not moving packets, where the request hangs rather than failing.

**`/s/:code` cannot fall back to the shell**, and the reason is mechanical
rather than a judgement call. `App.tsx` sends any `/s/` path back to the server
with `location.replace`, because the server handles redemption. Answering that
navigation from the cache is an infinite redirect on a phone with no signal.

**Rejected:** `vite-plugin-pwa` / Workbox. It is the standard answer and it
would have worked, but it brings a build-time dependency and a generated worker
whose behaviour lives in its configuration — and the whole decision above is
about what the worker refuses to do. Sixty lines of routing that can be read,
and tested against a fake `ServiceWorkerGlobalScope`, is the better trade at
this size.

---

## "View as" renders the viewer's payload, not a reconstruction of it
**Date:** 2026-08-10 · **Status:** decided

**Question.** How faithful does the admin preview have to be, and what does it
show beyond the schedule itself?

**Decision.** `/api/admin/view-as` calls `getPersonalizedSchedule` — the
viewer's own function, with the viewer's own argument shape — and returns that
payload unmodified under a `schedule` key. Diagnostics ride alongside it rather
than inside it: the resolved target list, and how a real holder reaches the
view. The panel renders it with the viewer's own components (`NowNext`,
`BlockCard`, `ContactCard`, `buildTimeline`).

**Why.** A preview that re-derives matching would be at its least reliable
exactly when it matters. This tool is opened because someone says the app is
showing them the wrong thing; if the preview shares the admin's assumptions
rather than the phone's code, it will agree with the admin and the dancer will
still be standing in the wrong room. Returning the untouched payload makes the
fidelity checkable, and the test suite checks it by signing a real viewer in
with a real access code and asserting the two payloads match.

Three things follow:

**The diagnostics are the feature, not the schedule.** "Here is her schedule"
does not answer "why can't she see her warm-up" — the four reasons that is ever
true need four different fixes (wrong block target, looking at the pre-identity
team view, no longer on that team, never signed in). So the panel shows the
target list the query ORs over, and the sign-in route. A dancer unassigned from
a team by item 14's delete has a perfectly correct schedule and no way to open
it, which no amount of staring at blocks would reveal.

**A team preview names the people behind the identity step.** The team view is
a real view — it is what a captain sees while deciding which name to tap — and
it deliberately holds no person-targeted or captain blocks. Making that visible,
with the members one click away, is the single most common answer.

**No access code string in the response.** Whether a live code exists is the
diagnostic; producing the link stays in the Access codes tab, so there is one
place that mints and displays credentials. Worth a tab switch.

**Rejected:** an impersonation mode that issues a real viewer session to the
admin. It would be maximally faithful, and it would mean the panel can mint a
session for any subject — a much larger thing to get right than a read-only
query, and it would put a second code-redemption path next to the one item 6
locked down. It would also write `last_used_at` on codes nobody used.

---

## Undo reverts a batch, and refuses more than it accepts
**Date:** 2026-08-10 · **Status:** decided

**Question.** The edit log recorded every change and could reverse none of them.
What does undo operate on, and what should it decline to touch?

**Decision.** `edit_log` gains four columns — `before_json`, `after_version`,
`batch_id`, `undone_at` — and undo replays a *batch* backwards through the
ordinary mutations. One request is one batch, stamped by a middleware on the
admin router. A batch is undoable only if every row in it is a reversible block
change (or a summary line over rows that are), and only from the `manual` and
`admin` sources. Every precondition is checked before anything is written; one
failure refuses the whole batch.

**Why.** Three things were load-bearing.

**State, not prose.** `change_summary` reads `Changed "Team warm-up": time
15:00–15:30 → 15:20–15:50`. Parsing that back into fields would work until
someone reworded a summary and then fail quietly, which is the failure mode this
project keeps designing against. `after_version` is the block's `updated_at` —
deliberately the same token item 14's concurrency guard uses, so "has anyone
touched this since" is one comparison and not a second concept.

**A batch, never a row.** Item 15 goes out of its way to never leave half a day
20 minutes from the other half, because that looks exactly like a correct
schedule. Undo offered per log row would reintroduce it with one click. Stamping
the batch id in middleware rather than per route is what makes this safe by
construction: every write a request makes shares it, *including the ones that
are not reversible*. Deleting a person writes block-delete rows and a roster row
into the same batch, and the roster row is what makes undo refuse — restoring
blocks that point at a person who no longer exists would be worse than not
undoing. Threading the id by hand would eventually miss one, and the miss would
be silent.

**Imports are excluded, and not for lack of mechanism.** An import owns its rows
through `source_key`, which `updateBlock` does not carry. A reverted import would
keep the file's ownership while showing the old contents, and the next
background poll would put it straight back — an undo that silently re-does
itself a minute later. Reversing an import means fixing the sheet and
re-syncing, which is what the one-pipeline design exists for. Roster imports go
further: they delete people, which nothing logs.

**The reversal goes through `createBlock` / `updateBlock` / `deleteBlock`** rather
than writing SQL. So an undo logs, broadcasts to the right rooms, bumps
`target_versions`, and honours the concurrency guard exactly as a hand edit does
— and is itself a batch, which is where redo comes from without a second
mechanism.

**Rejected: undoing roster edits.** People, teams and contacts have no
`updated_at`, so there is no version to check a restore against — item 14's
residual, unchanged. A roster edit shows in the log with the reason it cannot be
reversed rather than with a button that would race.
