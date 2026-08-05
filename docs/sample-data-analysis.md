# Sample data analysis — RRXVI (2024–25)

Analysis of two unedited artifacts from the previous year's event, supplied
2026-08-05 and held (gitignored) in `samples/`:

| File | Shape |
| --- | --- |
| `Team Contact Information [FULL ROSTER].xlsx` | 10 sheets — 8 team rosters + 2 aggregate tabs |
| `24-25 OFFICIAL RRXVI WEEKEND TASK SHEET.xlsx` | 16 sheets — 4 day grids + 9 logistics tabs + 3 empty |

No code was changed. Everything below is observation from the files, with the
inferences marked as inferences.

---

## The one finding that matters

**The master schedule contains no dancers.**

The four day sheets have one row per person, and every one of those ~60 rows is
an IU exec-board member or a team liaison. The 186 dancers in the roster file —
the app's primary audience — appear nowhere in it. They surface only as *objects*
inside other people's cells ("check in teams", "regulate teams post mixer
practice") and as group labels in the logistics tabs.

Where a dancer's schedule does exist, it is scattered across the auxiliary
sheets, in a different shape each time:

| What a dancer needs to know | Where it lives | Granularity |
| --- | --- | --- |
| Airport pickup | `Airport Arrivals Friday` | per flight group |
| Mixer transport | `Mixer Driving Schedule` | per team, both directions |
| Post-mixer practice slot | `Friday Post Mixer Practice` | per team, 15 min |
| Saturday transport | `Saturday Drivers`, `Bussing Schedule` | per team, per bus round |
| Performance order | `Show Order` | per team, ordinal 1–8 |
| Departure | `Sunday Airport` | per flight group |

So the import pipeline cannot be pointed at the master sheet and be done. Two
separate problems are hiding in this project:

1. **Staff schedules** already exist in a machine-readable-ish form and can be
   imported, once the grid is decoded.
2. **Dancer schedules do not exist as data anywhere.** They must be assembled
   from six logistics tabs, or authored fresh in the app. This is a content
   problem before it is an engineering one, and nothing in PLAN.md currently
   budgets for it.

Recommend treating this as the finding that reshapes item 12 and item 24.

---

## Artifact 1 — the roster

### Real column format

One sheet per team, named by abbreviation: `UTD`, `UNC`, `GT`, `Illini`, `UMD`,
`UVA`, `MSU`, `UMich`. Identical five-column header on each:

```
First Name | Last Name | Dietary Restrictions | Phone Number | T-Shirt Size
```

Against the current importer's expected roster template — `Name, Role, Team,
Contact Person/Method` — **not one column matches**:

- Name is split across two columns, not one.
- There is no `Role` column. Everyone in this file is a dancer.
- There is no `Team` column. Team is carried by the *sheet name*.
- There is no email, and no contact-person column.
- There are two columns we don't model at all (dietary, shirt size).

### Counts

| Team | Dancers | Starred |
| --- | --- | --- |
| UMD | 28 | 4 |
| UTD | 25 | 4 |
| GT | 25 | 3 |
| UMich | 24 | 3 |
| Illini | 23 | 3 |
| UVA | 23 | 3 |
| UNC | 19 | 3 |
| MSU | 19 | 4 |
| **Total** | **186** | **27** |

A stray cell in `UTD!K10` reads `Board Members / 65`. So last year's headcount
was roughly **186 dancers + 65 board + liaisons + judges + videographers ≈ 260**,
against the ~170 in CLAUDE.md. Either the event shrank or the estimate is low —
worth confirming, because it moves the load-test target in item 20 and the
access-link distribution in item 25.

### Mess worth designing for

- **Sheets are not rectangles.** Columns G–K of every team sheet hold unrelated
  side-tables (shirt-size counts, allergy tallies, snack-basket quantities). An
  importer that reads "all columns until empty" ingests garbage. It must stop at
  column E, or read by header name.
- **Phone numbers have four formats in one file:** numeric-typed
  (`4695253956.0`), hyphenated (`936-232-8316`), space-padded (`971-225-2037 `),
  and — in the UMich sheet — wrapped in invisible Unicode directional marks
  (`‭4698370391‬`). That last one will break naive `tel:` links and
  string comparison. Normalize to digits on import.
- **One dancer has no phone number at all** (MSU, Raj Patel). Contact display
  must degrade rather than render an empty `tel:` link.
- **Names are not unique.** Two `Nandini Patel` on MSU and two `Dev Patel` on
  UMich — same team, same spelling. A further three names collide across teams
  (`Keya Patel`, `Nandini Patel`, `Dev Patel`). Any name-based picker or
  name-based import matching is ambiguous *within a single team*, which is the
  narrowest scope the current design offers. Access codes make this moot for the
  viewer, but the importer still needs a tiebreak.
- **Trailing-space names are pervasive** (`Rishika `, `Aaryan *`, every UVA
  first name). Trim on ingest or matching silently fails.
- **The asterisk suffix is an undocumented marker.** 3–4 people per team carry
  `*` — except UNC and GT, which use `**` for the same apparent purpose. The
  count matches the number of captains per team, and the bussing sheet schedules
  `CAPTAINS` as a distinct group, so *captain* is the likely meaning. **Not
  confirmed by anything in the file** — ask the director rather than assuming.
- **Dietary text is free-form**, with `veg` / `Veg` / `vegetarian` / `Vegatarian`
  / `Vegetarian` all present, plus prose ("no meat besides chicken", "Jain diet -
  No eggs or root vegetables"). The aggregate tabs (`Total Food`,
  `Total Allergies`) are hand-tallied from it. We don't currently model this and
  probably shouldn't, but note that logistics clearly cares.

---

## Artifact 2 — the master schedule

### It is a wall chart, not a table

Each day sheet is a Gantt-style grid:

- **Row 1–2:** time-slot headers, one column per slot.
- **Column A:** role/group name, merged vertically over its members.
- **Column B:** person name — one row per person.
- **The grid:** an activity cell at (person, start slot), **horizontally merged**
  across the columns it spans. Merge width *is* the duration.

```
        │ 5:00A │ 5:30A │ 6:00A │  …  │ 5:00P │
────────┼───────┼───────┼───────┼─────┼───────┤
Directors│Niki  │WAKEUP │ Get   │ 6:00 AM - 5:00 PM / HOTEL (POC)  │
         │      │       │picked │ Check in teams, help HL…         │
```

Scale: 651 merged ranges on Friday, 751 on Saturday, 131 columns wide.

| Sheet | People rows | Activity cells |
| --- | --- | --- |
| Thursday Schedule | 35 | 72 |
| Friday Schedule | 61 | 706 |
| Saturday Schedule | 62 | 940 |
| Sunday Schedule | 61 | 120 |
| | | **1,838** |

Saturday is the load-bearing day: half of all blocks, and the finest time
resolution (5-minute columns around the 4 a.m. call and the show).

### Cell format

Free text, newline-delimited, loosely conventional:

```
line 1   time range         "6:00 AM - 5:00 PM"
line 2   location           "HOTEL (POC)"          (~60% of multi-line cells)
line 3+  detail             "Check in teams, help HL with room setups"
```

Distribution of lines per cell: 1 line (82), 2 (412), 3 (894), 4 (246), 5+ (204).

**87% of cells carry a leading time range; 13% do not.** The remainder are bare
imperatives that still encode a time — `BE AT HOTEL 6:45 AM`, `REPORT TO LOBBY
W/ TEAM @ 2:30`, `3:55 PM / AUD BALCONY` — or pure state: `WAKEUP`, `Wakey
Wakey`, `Rest Day`, `BREAK`, `Conflict`.

### Time parsing — the trap

**The meridiem is frequently written only on the end time.** 143 cells read like
`7:30 - 9:30 PM` or `1:00 - 2:00 pm`, and a further **49 carry no meridiem at
all** (`9:30- 10:30`). A parser that reads the start time independently turns
`7:30 - 9:30 PM` into 07:30 — a silent twelve-hour error on a schedule where
"now / next" is the entire product. I made exactly this mistake while analysing
the file; it produced plausible-looking output.

Rules the importer needs:
1. If the start has no meridiem, inherit it from the end.
2. If neither has one, fall back to the column position.
3. If the parsed start is more than an hour off the column header, flag it for
   human review rather than picking one.

Rule 3 matters because **the text and the grid genuinely disagree in 139 cells
(8.6%)** even after correct parsing. The merge span is an approximation the
humans drew; the text is what they meant. Where they conflict, trust the text
and surface the conflict.

Also present: **past-midnight blocks are real, not hypothetical.** Thursday's
columns run to 03:00, Friday's to 01:00, and Saturday's call time is 03:45.
PLAN.md item 14 lists past-midnight handling as "handled in code but never
tested" — the past-year data says it is load-bearing.

### Locations

A small, reusable vocabulary with inconsistent casing — `CONVENTION CENTER
(GREAT ROOM)` (217), `HOTEL` (153), `AUD BALCONY` (68), `AUDITORIUM` / `Auditorium`
(119 combined), `Reg ROOM` / `HOTEL (REG ROOM)` (84 combined), plus Bill Garrett,
Fieldhouse, NOVA, Deckard. Roughly a dozen real venues behind perhaps thirty
spellings. This maps cleanly onto the existing `locations` table
(`venue_name` + `sub_location`) — but needs an alias table at import, not exact
matching.

### What varies between years — or here, between *days*

We only have one year, so year-over-year drift can't be measured directly. What
we can measure is drift *between the four day sheets of a single year*, which is
a lower bound on it. It is substantial:

- **Group labels rename across days.** `Senior Advisors ` → `Senior Advisor` →
  `Senior Advisors`; `Fundraising + Philo` → `Fundraising` → `Funding`;
  `Campus` → `Campus Wellness` → `Wellness`; `Freshreps` → `FreshReps`;
  `Liasions` → `Liaisons`.
- **Person names are misspelled inconsistently.** Four confirmed pairs, each the
  same human: `Raj Raguwanshi`/`Raj Raghuwanshi`, `Rhea Mehta`/`Rhea Metha`,
  `Ritika Vijay`/`Ritika Vjay`, `Shreya Wunnava`/`Shreya Wunnuva`. 64 distinct
  name strings resolve to ~60 people.
- **Row order changes between days.** The two directors swap rows between
  Thursday and Saturday; Hospitality and FreshReps reorder. Row position is not
  a stable identity key.
- **Column granularity changes between days** — 30-minute slots Thursday,
  15-minute Friday, 5-minute Saturday around the show, and irregular one-off
  columns (`06:15`, `08:50`, `04:05`, `04:10`).
- **Sheet names carry trailing spaces** (`Saturday Schedule `, `Changes `).
- **An orphan cell floats below the grid** — `Saturday!Q67`, "ARIA DESAI - 7:30
  AM - 12:35 PM / Driver Car / On-Call" — a real assignment for a person with no
  row. An importer that reads only the people block silently drops it.
- **`Conflict` appears as literal cell text** in three places, where two
  commitments collided and nobody resolved it. The sheet is a working document,
  not a finished one.

The `Changes ` sheet — a single cell of running TODOs ("need to add
transportation to hotel from mixer") — confirms the same thing: this file was
edited live during the weekend.

### Implication for item 12 (column mapping)

Column mapping as described in PLAN.md — "map their columns onto your fields at
upload time" — assumes their sheet is a table with columns. It isn't. Getting
this file into the app needs a *grid decoder*: read the time header, walk the
merged ranges, treat column A/B as the assignment, parse the cell text. That is
a different and larger piece of work than a column-mapping UI, and it should be
scoped as one.

An alternative worth weighing: don't import the master sheet at all. Have
logistics maintain the schedule in the app's admin panel as the source of truth,
and keep the wall chart as their planning artifact. The past-year file suggests
they'd resist that — the grid is how they think — but it removes the single
largest piece of remaining engineering.

---

## The item-2 model questions, answered

**Can a dancer compete with two teams?**
No evidence of it. The eight team sheets are disjoint. The three cross-team name
collisions (`Keya Patel`, `Nandini Patel`, `Dev Patel`) are different people, not
one person listed twice — they have different phone numbers. *Answered: no.*
Keep `people.team_id` single-valued.

**Does anyone hold two roles?**
Yes. `Ashka Patel` appears twice on every day sheet — once under **Logistics**
in the board block, once under **Judging** in the liaison block — with different
activities in each row. *One caveat:* the name-collision problem above means
this could be two different people who share a name. Confirm with the director,
but design for two roles per person, because the sheet already does.
Separately, note that the current model has one `role_id` per person and the
Thursday sheet shows people carrying a board role *and* a mixer task assignment
(`MIXER TASK SHEET` assigns `DIRECTOR`, `LOGS`, `CREATIVE`, `PR`, `walk around`,
`cup stacking R` as a second, activity-scoped role layer).

**Is there a level above teams — divisions, brackets?**
No divisions and no brackets. There *is* a **performance order**: the `Show
Order` sheet numbers the teams 1–8, and Saturday's column A embeds it in the
group label (`UNC Taar Heel Raas\nTEAM 1` … `GT Ramblin Raas\nTEAM 8`). That's an
ordinal on a flat list, not a hierarchy. *Answered: no new level.* But teams need
an `order` field, and it is worth showing on a dancer's phone — "you are 3rd,
after UTD".

**Does a team perform more than once?**
Once. One show, one running order, 1–8. Teams do have *multiple scheduled
activities* (airport, mixer, post-mixer practice, prop build, Saturday practice,
show, departure), but a single performance. *Answered: no.*

**Do judges need the running order rather than one long scoring block?**
**Cannot be answered from this data** — and that absence is itself informative.
Judges have no rows in the master sheet at all. They appear only as a bussing
group, as a liaison assignment (`Judging` → Ashka Patel, Saahil Bartake), and
inside other people's cell text ("check the last 2 judges in"). Last year, judges
were evidently handed the `Show Order` sheet and nothing else. *Narrowed:* the
question for the director is not "running order or scoring block" but "do judges
get personalized schedules at all, or just the running order?" — and the cheap
answer is that the running order is already a first-class object we can render.

**Is anything scheduled per-person within a team?**
Yes, two kinds:
- **Captains** are scheduled separately from their teams — `Captain's Meeting`
  9:00–9:30 PM Friday, and a distinct `CAPTAINS` bussing group. This is what the
  roster's asterisk marks, pending confirmation.
- **Airport travellers.** Arrivals and departures are grouped by *flight*, not by
  team: "UTD & Aryan P", "UVA, & UMD (3) & UNC (2)", "Anaga Srikumar and Nihar
  Soman". Individual dancers are named, with their own pickup times, hours apart
  from their teammates. A dancer whose flight lands at 8 p.m. has a materially
  different Friday from one who landed at 8 a.m.

*Answered: yes.* The current three-way targeting (team / person / role) covers
both — captains as a role, travellers as person-blocks — so **no schema change
is required**, but the import path must be able to emit person-level blocks from
team-shaped source rows.

---

## Summary of consequences

| Finding | Affects |
| --- | --- |
| Dancers have no source schedule; must be assembled from 6 tabs | 12, 24 — and needs scoping as content work |
| Master sheet is a merged Gantt grid, not a table | 12 — "column mapping" is the wrong shape |
| Meridiem on end-time only; 49 cells with none | 12, 19 — 12-hour silent error |
| Text vs. grid disagree in 8.6% of cells | 12 — needs a review queue, not a winner |
| Past-midnight blocks are routine, Saturday call is 03:45 | 9, 14, 19 |
| Names collide within a team; 4 misspelling pairs | 12 — name matching needs a tiebreak |
| Roster has none of the expected columns; team is the sheet name | 12 |
| Phone numbers in 4 formats, incl. Unicode direction marks | 12, 14 |
| ~260 people last year vs. ~170 assumed | 20, 25 |
| One person holds two roles (pending name-collision check) | 3, 13 |
| Teams need a performance-order field | 13 |
| Captains are a real scheduling unit | 3 — bears on role-level access codes |

## Still needs the director, not the data

1. Does `*` / `**` on the roster mean captain?
2. Is `Ashka Patel` one person in two roles, or two people?
3. Do judges get personalized schedules, or is the running order enough?
4. Is ~170 or ~260 the right headcount for this year?
5. Will logistics maintain the schedule in the app, or keep the wall chart as
   source of truth and expect an import?

Question 5 is the expensive one — it decides whether item 12 is a grid decoder
or a delete.
