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

---

## An announcement is a block targeting `everyone`
**Date:** 2026-08-10 · **Status:** decided · supersedes the deferral in
"Block targeting is three-way"

**Question.** "Fire alarm, evacuate" meant creating six near-identical blocks.
The 2026-08-04 targeting decision considered a global broadcast and deferred it
to item 18. Do we add it, and as what?

**Decision.** Yes. `applies_to_type` gains a fourth value, `everyone`, with the
id pinned to `all`. Every session's `targets` list contains it, so one block
reaches all ~280 people. There is no announcements table and no separate
concept: an announcement is a schedule block, and inherits the whole machine.

**Why.** The thing logistics already does under pressure is create blocks. The
fix is to let them create *one*, not to teach them a second mechanism at 1pm on
a Saturday. Making it a target rather than a new entity means it arrives with
everything already built: it appears in the right place in the day, it reaches
the right socket rooms, it moves the right "last updated", it shows up in "view
as", it can be bulk-shifted, and it can be undone — all of which would have been
separate work against a parallel announcements table, and several of which would
have been forgotten.

`live.js` already said "adding a fourth targeting mode would need no change
here", and that turned out to be true: rooms are derived from targets.

Three things this pins down:

**One audience, enforced twice.** The id is normalized in the mutations and
constrained in the schema (`applies_to_type <> 'everyone' OR applies_to_id =
'all'`). A second sentinel would mean a second socket room and a second
`target_versions` key that nobody's session reads — a block that looks posted
and reaches nobody. The DB constraint is the one that survives a hand-run SQL
fix at 2am.

**A target, never a subject.** `everyone` is not a session subject and not an
access-code subject: nobody signs in as everyone, and no credential exists for
it. Those tables' three-way CHECKs are unchanged on purpose, and there are tests
holding that line, because the natural drift is for a fourth target type to leak
into three-way lists that mean something else.

**It moves everyone's "last updated", and that is correct.** Item 14 made the
timestamp per-subject precisely so one team's edit did not tell 280 people their
day had changed. An announcement is the one change for which telling all 280 is
true.

**Cost, accepted:** SQLite cannot widen a CHECK constraint, so `schedule_blocks`
and `target_versions` are rebuilt in `migrate.js` — create, copy, drop, rename,
re-index. Verified against the real 110-block dev database: every row, version
and index survived. The alternative was dropping the constraints, which would
have traded a one-time migration for a permanently weaker invariant.

---

## The fan-out ceiling is per-request CPU, and it is spent up front
**Date:** 2026-08-10 · **Status:** decided

**Question.** Item 20 asked for a load test at 600 connections and for whatever
it surfaced to be fixed. It surfaced that the personalized schedule cost 388µs
of server CPU. What is the ceiling actually made of, and how much of that 388µs
is worth buying back?

**Decision.** Treat **per-request CPU on `/api/schedule` as the single number
that sets the ceiling**, and spend effort there rather than on concurrency.
Three caches — resolved instants, the zone-abbreviation formatter, and the
prepared statements whose SQL varies only by target count — took it to 105µs.
Nothing was made asynchronous, and no work was moved off the request path.

**Why.** better-sqlite3 is synchronous by design (see the stack decision), so
600 phones refetching after one announcement are served strictly one after
another. The fan-out is therefore *per-request cost × fleet size*, a queue with
no cliff in it: at 388µs the fleet settled in 288 ms, at 105µs in 139 ms, and
the shape stays linear out to 1000 clients. That makes microseconds on this one
path worth more than any amount of architecture, and it makes the ceiling
predictable — a number anyone can multiply, rather than a threshold to discover
at 1pm on Saturday.

What we gave up: three caches are three things that can serve a stale answer.
Two of them are keyed on values that cannot change during a run (a formatter per
zone, a statement per SQL shape). The third — resolved instants — is cleared
with the timezone cache and hands back a fresh `Date` on every call, so neither
a zone change nor a mutating caller can be answered from it, and there are tests
for both. `prepareCached` is deliberately restricted to SQL assembled from a
fixed vocabulary; keying it on anything a request supplies would make it grow
without bound.

**Also decided: the room sweep on roster edits stays synchronous.** A renamed
team broadcasts unscoped and re-derives all 600 sockets' room membership in the
request, costing ~60 ms of admin latency and pushing that fleet's refetches from
80 ms to 125 ms. Chunking it across ticks would recover ~60 ms on the rarest
write path in the panel, at the cost of complicating the one computation that
keeps "who hears about this block" and "whose schedule contains it" identical.
Measured, recorded in [load-test.md](load-test.md), and left alone.

**Also decided: keep-alive is 65 seconds, not Node's 5.** A phone uses its
connection in bursts — idle for minutes, then a refetch the instant something
changes — and the default closed the socket inside that gap often enough to
reset roughly one refetch per thousand. The viewer cannot tell that from being
offline, so the symptom was an "Offline · last known" banner on a phone with
full signal. The trade is visible at 1000 simultaneous reconnects, where ~6–8%
of websocket upgrades need socket.io's retry; that is invisible to the user and
self-healing, which is the better of the two failures. It is an env var
(`KEEP_ALIVE_TIMEOUT_MS`) because a proxy with a shorter idle timeout would need
it lower — set it at deploy, item 22.

## A "past" block is dimmed by its surface, never by opacity
**Date:** 2026-08-11 · **Status:** decided

**Question.** Finished blocks were `opacity: 0.45`, which put their end time at
1.7:1 and their location at 2.4:1 against the card behind them — well under AA.
Raise the opacity, pick better colours, or stop using opacity?

**Decision.** Stop using opacity. `.block.is-past` now drops its raised fill
back to the page colour and dims its heading to `--text-dim`; nothing on the
card falls below 6:1.

**Why.** Better colours cannot fix it, and that is the whole point: element
opacity fades the text *and* the background it is measured against together, so
the ratio between them degrades no matter what either one is. A sweep confirmed
it — even at 0.8 the faintest text was still 4.29:1, and 0.8 does not read as
faded. The only way out is to not fade the element.

Which leaves whether it needs fixing at all, since WCAG exempts "inactive user
interface components". A past block is not inactive UI — it is content people
scroll back to all day ("what time was the tech run?", "where were team photos
again?"). The exemption does not cover it. Dropping the fill recedes the card
just as well, because the contrast that carries "this is done" is the card
against the *page*, not the text against the card.

Same reasoning, smaller: `.btn:disabled` went from 0.45 to 0.7. A disabled
control genuinely is exempt, but "Show my schedule" is the primary action on the
sign-in screen and spends most of its life disabled, with its own label at 2.9:1
against its own fill — a check-in desk in a dark venue squinting at the button
they are meant to press.

## Two border colours: decorative edges and control boundaries
**Date:** 2026-08-11 · **Status:** decided

**Question.** `--line` (1.4:1 against the page) was the border on card edges
*and* on every input, button and tappable row. WCAG 1.4.11 wants 3:1 for the
boundary of a control. Raise `--line`, or split it?

**Decision.** Split. `--line` and `--line-soft` stay exactly as they were and
keep their card edges; a new `--line-strong` (`#716789`, ≥3.2:1 on every
surface) carries anything tappable or typable.

**Why.** Raising `--line` would have lit up every card boundary in the app to
fix a rule that does not apply to them — 1.4.11 is about identifying
*components*, and a schedule card is not one. The failure was specific and
severe: `.input` paints `--bg`, the same colour as the page, with a 1.4:1
border, so the code-entry field was distinguishable from the background by
nothing at all. `.btn.ghost` was worse — transparent fill, invisible edge, a
button that exists only as floating text.

The split is worth the second variable because it encodes the distinction that
was missing. `tests/accessibility.test.js` asserts `--line-strong` clears 3:1
**and that `--line` does not**, so "these look the same, use one" fails loudly
rather than quietly undoing this.

## A half-implemented ARIA pattern is worse than none
**Date:** 2026-08-11 · **Status:** decided

**Question.** Four tab strips (viewer days, admin panel, roster sections,
schedule days) declared `role="tab"` — or, in two cases, `aria-selected` with no
role at all — and none implemented the keyboard behaviour those roles promise.
Fix all four, drop the roles for plain buttons, or leave it?

**Decision.** Fix all four, from one implementation:
[`client/src/tabstrip.ts`](../client/src/tabstrip.ts). One tab stop per strip,
arrow keys with wrap, Home/End, selection following focus.

**Why.** The roles are not decoration — they are a contract. A screen reader
announces "tab, 2 of 5", which tells the user that arrow keys move between the
tabs; pressing them did nothing, and Tab walked through all seven admin tabs
one at a time. Plain buttons would at least have described themselves honestly.
So the choice was to keep the promise or stop making it, and keeping it is what
the strips actually are.

Two of the four (`SchedulePanel`, `RosterPanel`) were putting `aria-selected` on
a plain button, which is not valid ARIA — the attribute means nothing on a role
with no selected state, so the CSS was styling off an attribute assistive
technology was entitled to ignore.

One implementation rather than four because four copies is how this got here.
`selection follows focus` is the right variant: every panel is rendered from
data already in hand, so there is nothing to load and no reason to make someone
press Enter as well.

## Item 21's hardware half is a checklist, not a claim
**Date:** 2026-08-11 · **Status:** decided

**Question.** How much of "device matrix" can be closed without devices?

**Decision.** The accessibility audit, the responsive checks and the palette are
done and tested. The physical checks are written up as a dated checklist in
[device-matrix.md](device-matrix.md) and left open.

**Why.** Two of them are not merely unverified but *untestable* where they were
fixed, and saying so is the point:

- **Safe-area insets.** `env(safe-area-inset-*)` resolves to `0px` in every
  desktop browser, so the landscape fix — the left/right insets were missing
  entirely, though `viewport-fit=cover` is set — is literally unexercised until
  it runs on a notched phone.
- **Pull to refresh.** `body` has `overscroll-behavior-y: contain`, which on
  Android Chrome disables the native pull-to-refresh. Item 10 built the service
  worker on the premise that refreshing is what people do when a screen looks
  stale, so the app may be disabling the gesture it was designed around, on half
  the fleet. The fix is one word, which is exactly why it was not guessed at:
  the checklist carries the change to make once someone has an Android phone in
  hand.

Battery over a 14-hour day and whether `tel:` reaches a dialler are the same
class — no amount of desktop verification substitutes, so they are named,
assigned and dated rather than assumed.

## Deploy target: Fly.io, one machine, one volume
**Date:** 2026-08-11 · **Status:** decided

**Question.** PLAN.md item 22. Where does this actually run, and what shape does
the deploy take?

**Decision.** Fly.io in `ord` (Chicago), a single machine with a single volume
mounted at `/data`, never idling. Config in `fly.toml` and `Dockerfile`; the
runbook is [deploy.md](deploy.md).

**Why.** The stack decision above already ruled out serverless — live updates
need held WebSockets. What remained was which of Railway / Fly / Render, and the
deciding constraint is SQLite: the app needs a persistent disk *and* exactly one
process writing to it. Fly gives both explicitly and cheaply, Render's
persistent disk requires a paid instance and its free tier idles after 15
minutes, which would drop every socket and cold-start whoever opened the app
next.

**What we gave up, and it is worth naming:** a single machine means a deploy is
a few seconds of downtime, and there is no failover. That was accepted rather
than worked around, because the alternative is not "two machines" — it is
Postgres. A Fly volume attaches to one machine, so a second machine gets a
second, empty database behind the same hostname, and which schedule a phone sees
depends on which machine the proxy picked. Both machines pass their health
checks, both edit logs are internally consistent, and an announcement reaches
half the venue. There is no configuration that makes two machines safe here, so
`--ha=false` and `min_machines_running = 1` are load-bearing, and a test asserts
the second one.

## Deploy config is checked at boot, in two severities
**Date:** 2026-08-11 · **Status:** decided

**Question.** Item 22 requires `ADMIN_PASSWORD` set and `SESSION_SECRET` pinned.
How are they enforced, given that nothing goes wrong visibly when they aren't?

**Decision.** `server/lib/deploy-config.js` checks the environment before the
server serves anything, and refuses to boot in production on four settings: the
default admin password, an unpinned or typed `SESSION_SECRET`, a database path
inside the application directory, and a missing client build. Six more are
warnings. `npm run preflight` runs the same checks and treats warnings as
failures too.

**Why.** Every one of these produces a server that *passes its own health
check*. The default password serves a correct schedule and a write-access panel
to anyone who read the README. A database inside the image serves a correct
schedule right up until the next deploy silently empties it. A missing client
build answers 200 with a plain-text page, so an uptime monitor stays green while
every phone shows nothing. This is the same argument as `EVENT_TIMEZONE`
refusing to fall back, and the same argument the whole project rests on: wrong
is worse than absent, because absent gets noticed.

**The two severities are the load-bearing part.** A restart at 2am on the
Saturday must not be blocked by a missing hostname, so the boot gate is narrow
and covers only what is unsafe or loses data; everything else warns and boots.
The pre-event checklist gets the strict version through `preflight`, where
stopping to fix something costs nothing. New checks go in at `warn` unless
booting wrong is genuinely worse than not booting.

`SESSION_SECRET` is required rather than left to the generated fallback for a
reason that only appears at deploy: the fallback is stored *in the database*,
which is the file item 23 copies off-box every few minutes. Pinning it in the
environment keeps a live signing key out of every backup, and means rebuilding
the volume doesn't sign all ~280 phones out.

## Backups are verified copies on a timer, and the alarm lives outside the box
**Date:** 2026-08-11 · **Status:** decided

**Question.** Item 23 asks for off-box snapshots every few minutes, an uptime
monitor on `/api/health` with SMS, and error tracking. What actually runs, given
one machine, one volume, and nobody reading logs during a competition?

**Decision.** Three separate mechanisms, deliberately not one:

1. **Snapshots** — `server/lib/backup.js`, on an in-process timer (5 minutes in
   production). Each one is taken with SQLite's online backup API, re-opened,
   `integrity_check`ed, counted against the live database, and only then kept.
   It is then shipped off-box via `BACKUP_TARGET_URL` (HTTP) or
   `BACKUP_TARGET_CMD` (any command). Local copies are pruned by count *and* by
   total bytes.
2. **Health** — `/api/health` now answers 503 when phones are not being served,
   and reports backup staleness without failing on it.
3. **Alerts** — errors go to a ring buffer, to a file beside the database, and
   (deduplicated per condition) to `ALERT_WEBHOOK_URL`. `HEARTBEAT_URL` is
   pinged on a timer.

**Why verification is not optional.** A backup nobody has opened is a guess, and
the specific way this fails is not a crash: an empty SQLite file is *structurally
valid*. It passes every check there is and restores to an event with nobody in
it. So the counts are the assertion, compared against the database the copy was
taken from, and a snapshot that fails is deleted rather than kept — a file in
that directory reads as a backup to everything downstream, so a bad one is worse
than none because it makes the count go up.

**Why the heartbeat is the answer to "SMS", and the webhook is not.** Nothing
running inside this process can report that this process has stopped. A machine
that has wedged its event loop, filled its disk, or been killed shares the fate
of every check that lives in it. So the only alarm that survives the failure it
watches for is an external dead-man's switch that pages when the pings *stop* —
which is why `HEARTBEAT_URL` is the setting the deploy check names, and the
in-process webhook is for the smaller class of problem the server is still
healthy enough to describe. For the same reason a failed alert delivery is
recorded and never re-alerted: announcing a broken alert channel through the
alert channel is a loop.

**Why staleness is measured from the last verified run, not the newest file.**
A run that finds the database unchanged discards the duplicate, so during quiet
hours the newest file keeps ageing while the backups are fine. Reading the
file's age there pages someone at 3am about nothing. (Found in the browser, not
in review — and worth knowing that during the event the dedupe will almost never
fire, because `markUsed` writes `access_codes.last_used_at` on every schedule
fetch and one phone refetching is enough to make the bytes differ.)

**Why health stays narrow.** Non-200 means *phones are not being served* and
nothing else, because that is the endpoint that pages someone, and a monitor
that fires on a degraded-but-working condition gets ignored — taking the real
alarm with it. Stale backups are a real problem for the panel and the alert
channel to raise, not a reason to report a site down that is serving 280 people
correctly. The one thing health gained is the case item 22 found: a deploy with
no client bundle answers 200 with a plain-text placeholder, so "up" was not the
same question as "working".

**Rejected: shipping to a specific object store.** Two generic mechanisms
instead — an HTTP upload and an arbitrary command — because the honest answer to
"where do the backups go" depends on what the event has an account for, and that
should not be re-litigated at T-2 days. `BACKUP_TARGET_CMD` covers signed object
stores without a SigV4 implementation living in this repo.

**Rejected: an alert on every failed snapshot.** Three consecutive failures, or
nothing verified for three intervals. One failed upload during venue wifi is not
worth walking away from the check-in desk for, and an alert channel that cries
wolf is muted before the event starts.

## The app reads three named tabs, not the first sheet

**Date:** 2026-08-11 · **Status:** decided

**Question.** The importer read `worksheets[0]`. The event's own workbook has
sixteen tabs and the first one is Instructions. How does the reader find the
schedule?

**Decision.** `parseTabular` takes a `prefer` list of sheet names — `Export` for
the schedule, `People` and `Roster` for the roster — and falls back to the first
sheet when none of them is there. Matching is case- and space-insensitive. A
roster upload reads *both* tabs and concatenates them, and each row carries the
tab it came off so an error can name it.

**Why.** The alternative was a column-and-sheet mapping UI, which item 3 already
rejected for the columns and which is worse here: the tab names are ours to fix,
they are written down in the workbook's own Instructions, and a mapping screen
is one more thing to get wrong at 1am. The fallback is what keeps the CSV
template, a published single-tab export and last year's spreadsheets all reading
exactly as they did — the named sheet is an addition, not a replacement.

⚠️ Reading the first sheet was not a small bug. Against the real template it
produced 158 rows of prose, every one of which failed validation, which is
indistinguishable from "you uploaded the wrong file" — so the diagnosis on the
day would have been to go looking for a different workbook.

**Rejected: reading the day grids.** They are merged Gantt wall charts, which is
the decoder item 3 declined to build. The workbook computes `Export` from the
pipelines, the meal windows and Manual Blocks precisely so that nothing has to.
The cost is that anything typed only on a day grid never reaches a phone, which
is now written in three places including the workbook itself.

## An import that yields nothing is refused, even when nothing failed

**Date:** 2026-08-11 · **Status:** decided

**Question.** The guard against a malformed file emptying the schedule was
`errors.length && rows.length === 0`. Is "rows failed" the right condition?

**Decision.** No — the condition is `rows.length === 0`, whether or not anything
errored. It is computed once as a `refusal` and reported on the preview as well
as the commit, so Apply is disabled rather than being the thing that finds out.

**Why.** The two conditions differ by exactly one case, and it is a real one:
the template's `Export` tab is entirely formulas, so a copy saved by anything
that does not calculate them reads as a few note rows and **no errors at all**,
because there is nothing there to be wrong. Under the old guard that file was
applied — an empty row set against `removeMissing`, which is every managed block
deleted, silently, behind a green result. There is no file for which the correct
outcome is "delete the whole schedule"; clearing the placeholder blocks is a
separate action that names what it does.

The same reasoning covers note rows. The `Export` tab ends with three lines of
instructions to its own maintainer, sitting in the Day column with the other
eight cells blank. Read literally they are three unreadable blocks on every
import of a *correct* workbook — and an import that always shows errors is one
whose errors stop being read, which is the only thing standing between the wrong
spreadsheet and an empty Saturday. A row with one non-empty cell is therefore a
note and is counted, not reported. The rule is one cell, not "fewer than nine":
a half-filled row is a mistake someone made and has to hear about.

## Event dates move by script; the days themselves are four

**Date:** 2026-08-11 · **Status:** decided

**Question.** Item 24 says to pin the real dates. `event_days` is written by the
seed, and the seed refuses to run against a populated database. So how?

**Decision.** `npm run days` — list, or set the whole weekend from any one day.
Dates only: the keys never move, and days cannot be added or removed there. The
seed now creates four days rather than two, and a migration derives Thursday and
Sunday for databases that already exist.

**Why.** Before this, changing a date meant `npm run seed:reset`, which rebuilds
the placeholder roster over the real one and rotates every access code already
mailed out — a trap with the roster on one side of it and the dates on the
other, and item 24 needs both. Re-dating is safe because `schedule_blocks.day`
is a foreign key onto `event_days.key` and `Sat` means "the third day", not any
particular date, so every block moves with its day and nothing is orphaned.

**Four days, because the event is four days.** The template has a grid for each,
teams land on Thursday and fly out on Sunday, and those are person-targeted
blocks somebody reads standing in an airport. A block whose `Day` has no
`event_days` row is refused per row — so on a two-day database every arrival and
departure is dropped, and it is reported as a count of skipped rows that stops
being read once it stops going down.

⚠️ **Derived, never invented.** The migration adds Thursday and Sunday only when
the Friday and Saturday already in the database are genuinely adjacent, and the
script refuses a date that is not the weekday it was given as. Both refusals
exist for the same reason: all four days move together, so one wrong date shifts
the entire weekend, and the result still renders as a completely plausible
schedule. That is the failure mode item 9 exists to prevent, arriving through
the setup step instead of through the clock.

## Liaison and RAS Rep are roles the migration guarantees

**Date:** 2026-08-11 · **Status:** decided

**Question.** The People tab names positions in the event's vocabulary —
`board`, `liaison`, `judge`, `videographer`, `RAS Rep`. The seed's role list has
no Liaison and no RAS Rep. Map them, create them, or refuse them?

**Decision.** Both: an alias table maps the event's spellings onto role ids, and
`ensureEventRoles` inserts `liaison` and `ras-rep` idempotently on every boot.
An alias only resolves if it lands on a role that exists, and a `Type` with no
alias still resolves against a role's own label or id.

**Why.** Roles are data (item 3), so the alias table maps spellings and does not
define the set — a role added in the panel needs no code change, which is the
property that decision bought. But liaisons are most of last year's master
schedule, five rows per team plus five judge liaisons, and refusing all of them
on `Role "liaison" is not a known role` is a stop at exactly the wrong moment:
the roster arrives late by construction, and the person loading it is not the
person who can decide what a role should be called.

Both are `person` selectors, so they are reached by name and carry their own
access code like every other staff position — which is what puts them in the
personal-code list and keeps dancers out of it, unchanged.

## A person's own address is a column; the card they call is not

**Date:** 2026-08-12 · **Status:** decided · supersedes part of *The access-link
export carries no contact details* (2026-08-06)

**Question.** That entry ended: "Adding real per-person contact details — an
owner column on the roster, or a `people.email` — is the prerequisite for a
self-sufficient export. If item 24 introduces one, revisit this." Item 24
imported the event template, whose People and Roster tabs both carry `Phone` and
`Email`. So: revisit.

**Decision.** `people.email` and `people.phone` exist and hold that person's own
details. `people.contact_id` is unchanged and still means the card they should
*call*. The roster import writes the first pair from the sheet's own columns and
creates a contact card only for a `Contact Person/Method` cell that names
somebody else. The access-link export gains `Send To`, built from `people.email`
and from nothing else.

**Why.** The 2026-08-06 reasoning was never that addresses are unsafe — it was
that the only contact details in the app belonged to *coordinators*, shared
across a whole team or role, so any "Send To" built from them would mail a dozen
private bearer tokens to one inbox while looking perfectly plausible. That
hazard has not gone away; the fix is a second column, not a cleverer join. The
two are now separated at the point they are read, in `rosterContacts`, rather
than downstream where every consumer would have to know the difference.

⚠️ **Item 24's first cut got this wrong, and the symptom was mild.** It built a
contact card out of the `Phone`/`Email` columns, which made every imported
person their own coordinator: 280 contact cards duplicating the roster, and
every dancer shown *their own phone number* under "Your contact". Nothing
errored. A test now asserts that no shared card's address reaches a recipient.

**What it costs.** ~280 participants' email addresses and phone numbers now live
in the database — which means they are in every off-box backup item 23 ships.
That is a real widening of what a lost snapshot exposes, accepted because the
alternative is distributing links by hand against a spreadsheet nobody
reconciles. `SESSION_SECRET` is already pinned out of the database for the same
class of reason; the backup target should be somewhere private.

**Rejected: sending the mail from this app.** An event already has a mailing
tool, and a half-built sender is one more thing to be on call for during the
weekend. The export is a mail-merge file and stops there.

## A team's link goes to its captains, and a blocked row stays in the file

**Date:** 2026-08-12 · **Status:** decided

**Question.** A team code has no single owner. Who receives it — every dancer on
the team, the captains, the team's liaison?

**Decision.** The captains, and only reachable ones. A team whose captains have
no address is *blocked* rather than redirected to anybody else, and the blocked
row stays in the export with the reason in its own column.

**Why.** "Team links to captains" is the item as written, and it matches how the
code is meant to travel: shared within the team by design, forwarded by the
person who already runs that group chat. Sending it to all 25 dancers instead
would work and would make the captain's role in it invisible, so nobody would
notice when a team had no captain marked at all.

The refusal is the more important half. The tempting fallbacks — the team's
liaison, the event director, any dancer with an address — are all *plausible*,
and every one of them hands a team's credential to somebody who was not chosen
to hold it. A named gap that somebody fixes in the spreadsheet is strictly
better than a link that went somewhere reasonable-looking.

⚠️ **Blocked rows are not filtered out of the export.** A file with the
unsendable rows removed looks finished, and the deadline on this item is "before
Friday" — the list is meant to be worked through, not admired. Same reasoning as
the import's error list.

**Also decided: a phone with no email is sendable.** Some of the ~80 staff will
be a mobile number and nothing else. Treating email as required would silently
drop exactly those people, so `Send To Phone` is a column and the readiness
count reports how many are text-only.

---

## Paper is generated from the viewer's own query, and a team sheet is the team plus its members

**Date:** 2026-08-12 · **Status:** decided

**Question.** Item 28 calls for printed fallback call sheets. Where does the
content come from, and what is on one sheet?

**Decision.** `server/lib/call-sheets.js` builds them from
`getPersonalizedSchedule` — the viewer's own function, the viewer's own argument
shape — and a sheet is a *group plus each of its members*: the shared schedule
that group's own code shows, then a section per person of what their phone holds
and the shared part does not, computed as a set difference on block ids. One
sheet per team, one per staff role, plus a desk index.

**Why.** Paper is reached for at the exact moment there is nothing left to check
it against. A second query assembling "what a team is doing" would agree with
the phones on everything anybody thought to compare, and disagree on whatever
nobody did — and the disagreement would surface as two people standing in
different rooms. Same rule, and the same reasoning, as "View as" (see that
entry): the tool that exists to be trusted must not re-derive what it displays.

⚠️ **The members half is not a nicety.** A team session deliberately holds no
person-targeted and no Captain blocks, because before somebody taps their name
the app cannot know whose phone it is. Printing that view alone yields a team
sheet with **every airport pickup missing** and no error anywhere — the sheet
looks complete. Paper has no identity step, so the sheet has to carry what the
identity step would have revealed. There is a test asserting both pickups appear
under their own names.

**Rejected: one sheet per person.** ~280 pages, most of them four lines, and a
check-in desk cannot find a page in a stack of 280 while somebody waits. Grouped
sheets are also how the paper is actually used — a captain holds their team's,
a stage manager holds the roles.

**Coverage is reported rather than assumed.** A person on no sheet and a block
on no sheet are the two ways a printed pack loses somebody, and both are silent
in every other screen: the phones are all still correct.
`npm run callsheets -- --check` exits non-zero on either, and the Ops tab shows
them.

---

## Access codes are on the desk index and on nothing that gets handed out

**Date:** 2026-08-12 · **Status:** decided

**Question.** The printed pack would be far more useful at a check-in desk with
each team's link on its sheet. Should it carry codes?

**Decision.** No. The pack (`scope=handout`) carries schedules only; the codes
live on a separate desk index (`scope=desk`) which is printed separately and
stays behind the desk. There is a test asserting no code string reaches the
handout pack.

**Why.** A code is a bearer token — that is the accepted trade in the
access-code decision, and it is accepted *because* links travel in direct
messages. A team sheet is handed to 25 dancers and taped to a green-room wall,
and every photograph of that wall is then a live credential for that team's
schedule. Unlike a leaked link, paper cannot be revoked without reprinting, and
nobody would know to.

The desk index is different in kind: it is one page, held by somebody who
already has the panel password, and its whole purpose is answering "I lost my
link" without a laptop. It says on it not to hand it out.

---

## The lost-link answer is decided in advance, and it is never "regenerate"

**Date:** 2026-08-12 · **Status:** decided

**Question.** Somebody arrives at the check-in desk without their link. What
does the person at the desk do?

**Decision.** A dancer is given **their team's** link and picks their own name;
staff are given **their own** link again. Regeneration is only for a lost or
stolen *phone*. Printed on the desk index and written in
[admin-guide.md](admin-guide.md) rather than decided in the moment.

**Why.** Losing a link is not the link being compromised — the old one still
works, so re-sending costs nothing and breaks nothing. Regenerating in its place
looks tidier and locks out whoever else is holding that code: for a team link
that is the entire team, mid-event, from a desk that will not learn it happened.
The distinction only holds up if it is decided before there is a queue.

The dancer half is the part that gets improvised wrong. Dancers have no personal
code at all (see the access-code decision), so the instinct to "issue them one"
mints exactly the unmanaged credential that decision exists to avoid. The desk
index therefore prints *how each person signs in*, from `accessFor()` in
`view-as.js` — the same rule the panel diagnoses with, rather than a second copy
that would drift.

---

## The on-call person is deploy configuration, and has to be a name

**Date:** 2026-08-12 · **Status:** decided

**Question.** Item 23 built an alarm that pages somebody. Item 28 asks who. Is
that a roster row, a contact card, or configuration?

**Decision.** `ON_CALL_NAME` / `ON_CALL_PHONE` in the environment, checked at
`warn` by `deploy-config.js` and printed on the desk sheet. Unset prints a ruled
blank line saying so.

**Why.** It is a property of the weekend and of the deploy, not of the
spreadsheet: the same human is on the roster in some other capacity, and the
question here is who answers a 3am SMS about this process. Keeping it beside
`HEARTBEAT_URL` and `ALERT_WEBHOOK_URL` means the three parts of one alarm are
configured together, and `npm run preflight` reports the whole chain.

`warn`, not `fail`, under the rule at the top of `deploy-config.js` — a server
with nobody named still serves 280 people perfectly.

Two constraints go with the name, and they are in the guide because they are the
ones that get violated: it must be **a person, not a rota** ("whoever notices"
is nobody), and not somebody also running a camera or a stage, because answering
this means stopping for twenty minutes.

⚠️ **The blank is deliberate.** A desk sheet that omits the section when nobody
is set reads as finished; a ruled line with "NOT SET" on it gets filled in.

---

## Readiness is a gate that composes other checks, and refuses on the event's content

**Date:** 2026-08-13 · **Status:** decided

**Question.** Item 26 says "real data, 10–15 people, break things". How do you
know, on the morning, that the rehearsal is worth running?

**Decision.** One command — `npm run rehearsal`, mirrored at **Ops → Event
readiness**. It *composes* `deploy-config.js`, `access-codes.js` +
`distribution.js`, `call-sheets.js` and `backup.js` rather than re-implementing
any of them, and adds exactly three checks of its own: the dates, the roster's
provenance, and whether every event day has anything on it. Three levels —
`blocker`, `warn`, `ok` — and only a blocker exits non-zero.

**Why.** The thing this exists to prevent is specific: **a green rehearsal
against the placeholder is indistinguishable from a green one against the
weekend.** Every code resolves, every phone updates, every colour is right, and
nobody who will actually be there is in the database. All 539 tests passed
against a database whose event had finished four days earlier.

The three new checks are the ones with no other home:

- **The dates**, compared against the *venue's* today. Nothing in this app had
  ever asked whether the event had already happened — item 9 made the timezone
  authoritative, item 24 made the dates movable, and neither could notice a
  weekend in the past. It also refuses a date that is not the weekday it claims
  to be and a non-contiguous weekend, which `npm run days` will not write but a
  hand-run SQL fix at 2am would.
- **The roster, by provenance rather than by headcount.** There is no honest
  number to test against — hard-coding one fails a legitimately small event and
  passes a half-loaded big one. Seed rows carry `source = 'seed'` and an import
  does not, so "every block came from the seed" is a fact about this database.
- **A day with no blocks.** Item 24's standing gap: `Export` builds Saturday
  from the pipelines and the other three days come from Manual Blocks. Somebody
  landing on an empty Thursday sees a blank day, and nothing in the import says
  so, because every row that was there imported perfectly.

**Composing rather than duplicating is the load-bearing part.** Four readiness
checks that agree with each other and disagree with the code they describe is
strictly worse than no gate at all, because the whole value is being believed at
7am on the day. ⚠️ Note the shape of a `deploy-config.js` check while doing it:
`level` is the severity it carries *if* it fails and `ok` is the result, so
`failing(checks, …)` is the accessor — the first cut read `level === 'fail'` as
"failed" and produced a gate that could never be green.

**Three levels, not two,** because the rehearsal is scheduled at T-1 week and
the roster habitually lands later. A gate that cannot tell "no real dates" from
"no off-box backup target" gets ignored wholesale, and then so does the blocker.

**Rejected:** having it fix anything. It is read-only on purpose — the fixes are
`npm run days`, an import, and a spreadsheet, all of which are somebody's
decision.

---

## A phone reports the version it is showing, and it is compared against its own targets

**Date:** 2026-08-13 · **Status:** decided

**Question.** The dress rehearsal's central sentence is "make live changes and
confirm every phone updates". With fifteen phones in a room, how?

**Decision.** Each viewer emits `viewer:held` with the `updatedAt` it is
rendering, after every successful fetch and on every reconnect. The server keeps
that in memory per socket (`presence.js`) and compares it against
`versionForTargets` for **that socket's own targets**. Admin-only, at
`Ops → Phones connected`.

**Why.** The alternative is asking the room, and a phone quietly holding a
twenty-minute-old time answers *yes* — its owner cannot tell either, because a
stale schedule looks exactly like a correct one. That is this project's defining
failure mode, and it was the one thing the rehearsal had no instrument for. Item
20 measured 600 simulated phones; nothing had ever measured a real one.

⚠️ **Against its own targets, never against the event's.** `updatedAt` has been
per-subject since item 14 — a viewer's is the newest of the targets they hold —
so comparing every phone against `scheduleUpdatedAt()` would mark all fifteen
behind the instant any one team changed. An alarm that is always ringing is the
same as no alarm. There is a test that fails against that implementation.

**A phone reports its own state, because nothing else can.** A server-side
inference ("we emitted to that room, so they have it") is exactly the false
confidence this removes: the emit is the thing that might not have arrived.

**Three states, not two.** `silent` — never reported — is neither up to date nor
behind. Calling it current is the comfortable lie; calling it stale would flag
every phone for the second between connecting and its first fetch.

⚠️ **An admin socket is a panel even when it resolves to a viewer subject.**
Cookies are per browser, not per tab, so the person driving the rehearsal has
the panel and a viewer link open in the same browser and their `/admin` socket
identifies as a real participant. Classifying by subject first put a
permanently silent phone in the list belonging to somebody standing in the room.
Found by opening both, which is the only configuration this is ever used in.

**Nothing is persisted, and nothing touches `/api/schedule`.** The registry is
memory and starts empty on a restart — "was Priya connected on Friday" is not a
question this answers. Reporting rides the socket that is already open, and the
report is computed only when an admin asks, so the fan-out ceiling in
`queries.js` is untouched.

**Rejected: inferring presence from request logs.** It would survive restarts
and need no client change, but it answers "did this phone ask recently", not
"what is on its screen" — and those differ in exactly the case that matters, a
socket that dropped and a client that has stopped refetching.

---

## The release is stamped into the image, and the freeze is checked against it

**Date:** 2026-08-13 · **Status:** decided

**Question.** Item 27 says "tag the release, no changes after except genuine
emergencies". A tag is one command — what else does a freeze need to be worth
anything?

**Decision.** Three pieces. `npm run freeze` gates and cuts an annotated
`release-YYYY-MM-DD` tag; the Docker build stamps that release into the image as
environment variables; and `npm run freeze -- --url <host>` compares the tag on
this side against what the machine reports on the other, through `/api/health`.
The Ops panel and the boot banner report the same thing for whoever has no
terminal.

**Why.** A freeze is a promise about what will be running on the Saturday, and
before this nothing could check it. The server had no idea what it was. "Is the
machine running what we froze, or something somebody pushed on Friday night?"
is a comparison across two sides that each hold half the answer, so it needs
both halves to exist.

⚠️ **The identity has to be baked in at build time.** `.git/` is in
`.dockerignore` deliberately — an image gets pushed to a registry — so there is
no repository inside the container and `git describe` on the machine cannot work
by construction. Deriving it at runtime is the `__dirname`-versus-`dataDir` bug
from the deploy decision in another costume: flawless on a laptop, where the
source tree is right there, and silently absent on the one machine it matters
on. Four `--build-arg`s are the entire channel, which is why the freeze script
prints the deploy line filled in rather than leaving it to be typed.

⚠️ **Rejected: falling back to `package.json`'s version.** It is always
available, which is exactly the problem — it says `1.0.0`, it is in every image
ever built, and it has never changed. A drift check reading it would compare
`1.0.0` against `1.0.0` and report a permanent, silent match between the frozen
release and whatever is actually deployed. `unknown` looks worse and is much
better: it shows up as a warning in `preflight` and a banner on the panel. There
is a test that the fallback never appears.

**"The server cannot say" is a third answer, not agreement.** Same shape as the
three presence states in the entry above, for the same reason — the two-state
version is where the comfortable lie lives.

**A dirty working tree is the one refusal `--force` cannot reach.** Every other
blocker (readiness, a red suite, freezing off `main`) is a judgement somebody at
1pm on the Saturday may legitimately override, and an override is written into
the tag message so the next person reads it rather than discovering it. A tag
over uncommitted changes is not a judgement call — it names contents that exist
nowhere and cannot be rebuilt or rolled back to.

**The gate composes the readiness report rather than re-asking it**, exactly as
that entry argued: a freeze is the last moment anybody looks, and a gate that
disagrees with `npm run rehearsal` on the Wednesday gets argued with instead of
obeyed.

**Tags are sequenced `.1`, `.2` within a day, and the sequence is a number.**
Git returns tags sorted as text, so `.10` sorts before `.2` and "the latest
freeze" — the tag every drift check compares against — silently becomes an older
one. `nextFreezeTag` takes one past the highest for that date rather than the
first free gap, because filling `.1` while `.10` exists cuts a release that sorts
before releases that already happened.

**Rejected: a freeze check that runs on the server.** It has no repository to
read, so it could only ever report the value it was handed — which is the half
it already reports through `/api/health`. Putting the comparison there would
have looked like more coverage and been strictly less.

**What this does not do.** Nothing prevents a push, a deploy, or an edit during
event week; there is no branch protection and no lockout. The freeze is a
recorded intent plus the ability to notice it has been departed from — which is
the honest limit for a project one person deploys.

---

## Two roster rows the importer cannot tell apart are refused, not resolved

**Decided 2026-08-13** (item 12).

A person is identified across imports by their **name plus their display role**
— `rosterIdentity()` in `server/sync/normalize.js`, and the only definition of
it. Team is deliberately not part of the key: a dancer moving between teams has
to read as an update, and keying on team would make a transfer a delete plus a
create, which under `removeMissing` takes their access code and their airport
pickup with it.

That key is not unique on a real roster. The event director confirmed in item 3
that `Ashka Patel` is two people sharing a name, and ~200 dancers is where that
lives. **The importer now refuses both rows rather than picking one.**

**The failure it replaces was silent and appeared only on the second import.**
`computeRosterDiff` built a `Map` of identity → person, which keeps whichever
row SQLite returned last. The first import created two people correctly and
looked fine. Every re-sync after it resolved *both* sheet rows to that one
person and applied their updates one over the other, so the second person was
never written to again by any import — their corrected email, their new team,
their captain promotion all reported as applied and none of them landed, on
somebody still on the roster and still holding a live access code. Nothing
errored, and no count was wrong.

**Both rows are refused, never the first-wins.** "Keep the first" is a guess
about which row is the real person, and the two rows differ in exactly the
fields — `email`, `phone` — that decide whose phone receives whose access link.
Item 25's whole safety property is that a link goes to `people.email` and
nowhere else; resolving this by coin flip puts the right link on the wrong
address and looks entirely correct doing it.

**The fix is in the spreadsheet, and it is the right fix.** The refusal names
both rows and their tabs and asks for distinguishable names. Twenty-five
teammates reading a call sheet cannot tell two identical `Ashka Patel` rows
apart either, and neither can whoever is holding the desk index when one of them
loses their link — so the disambiguation belongs in the roster, not in a
synthetic key. Same reasoning as item 25's blocked rows: a named gap somebody
fixes in the sheet is strictly better than a plausible guess.

**Rejected: an ID column on the roster tabs**, mirroring the schedule's
`ID`/`Block ID`. It would work, but it needs a `people.source_key` column and a
migration to survive a re-sync, and it buys the ability to keep two identical
names on the roster — which is a thing worth *not* having. Revisit only if
logistics comes back with two people who genuinely cannot be distinguished by
name.

**Rejected: the schedule pipeline's `#2` suffix.** `normalizeScheduleRows`
disambiguates repeated source keys by occurrence order. For blocks that is
fine. For people it means reordering the sheet swaps two people's identities,
and with them their access links — order-dependent identity is exactly what a
bearer token must not have.

**The ambiguity is checked twice, because it has two sources.** Two rows in one
upload are caught by the sheet reader (per tab, then again across the whole
upload — a dancer who also holds a staff job gets typed onto both People and
Roster, which no per-sheet pass can see). A sheet row matching two people
*already in the database* is caught in `computeRosterDiff`, because a database
can already be in that state: the first import that hit this bug is what created
the pair. Both refusals surface in the same `errors` list the preview already
renders, so neither is discovered after Apply.

⚠️ **A refused row still counts as seen.** `seenPeople.add` sits above the
ambiguity check in `computeRosterDiff` on purpose: both people behind an
ambiguous name are named in the sheet, and treating the refusal as "absent"
would have `removeMissing` delete the pair — turning a row the importer declined
to touch into two people removed from the event. There is a test.

**A refused row contributes nothing, and the commit gate counts people.** Both
found by `/code-review` on the change itself, and both were the failure this
feature exists to prevent — an import that reports a refusal and writes anyway.
The team and contact-card creation sat above the ambiguity check, so a refused
row still created a team with no members (item 5's backfill then mints it a live
access code) and an orphan contact card. And the commit route gated on
`diff.hasChanges`, which counts `deletePeople` — so under `removeMissing` a file
whose every row was refused read as "changes to apply" and those changes were
the deletion of everybody the file did not name. The gate is now the number of
rows that resolved to a person, which is item 24's rule again: the test is that
nothing importable came out, never that some rows failed.
