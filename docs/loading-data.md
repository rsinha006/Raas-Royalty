# Loading the real roster and schedule

Item 24. The engineering half is done — the app reads the event's own workbook,
tabs and all. What is left is content, and it is a bigger job than "a data
task" sounds. This is the order to do it in, what each step needs, and the
three traps that are easy to walk into.

Read [PLAN.md](../PLAN.md) item 24 first for why this exists. The workbook
itself is `templates/royalty-schedule-template.xlsx`, and its own Instructions
tab is the guide for whoever fills it in — this file is for whoever loads it.

---

## What the app reads

Sixteen tabs, three of which the app has any opinion about:

| Tab | Read? | What it is |
| --- | --- | --- |
| **Export** | **yes** | The schedule. Calculated from Sequences + Slot Times, Windows, and Manual Blocks. Nobody types on it. |
| **People** | **yes** | Board, liaisons, judges, videographers, RAS reps. One row each. |
| **Roster** | **yes** | Dancers. One row each. |
| Instructions, Teams, the four day grids, Sequences, Slot Times, Vehicles, Windows, Manual Blocks, Checks, Airport | no | How logistics *builds* the weekend. Export is the answer they compute. |

⚠️ **The four day grids do not reach the app.** They are for planning and for
reading off a wall. If something has to appear on a phone it goes on Manual
Blocks or comes out of a pipeline — the workbook's own Instructions say so, and
it is the single most likely misunderstanding.

⚠️ **Neither does the Airport tab.** It has flight numbers, pickup times and
drivers, and it feeds *nothing*: `Export` pulls from Sequences, Slot Times,
Windows and Manual Blocks, and no fourth place. Airport runs reach phones only
when someone copies them onto Manual Blocks as ordinary blocks. Filling in the
Airport tab and stopping there produces a tab that looks complete and a set of
schedules with no airport runs in them — and the people affected are the ones
standing in an airport.

---

## The order

### 1. Pin the dates

```bash
npm run days                          # what they are now
npm run days -- --friday 2027-02-12   # set the whole weekend from the Friday
```

Four days — Thursday to Sunday — derived from whichever one you give. It
refuses a date that is not the weekday you called it, because every day moves
together and the wrong one still renders as a perfectly good schedule.

Set the same Friday in the workbook's **Instructions** tab, in the yellow box.
The two are independent: the workbook uses it to date its own day tabs, the
database uses it to resolve every block to an instant.

Confirm the timezone at the same time. It is `America/Indiana/Indianapolis`
(Bloomington), pinned in `EVENT_TIMEZONE`, and the server refuses to boot on an
abbreviation or a fixed offset. See [decisions.md](decisions.md).

### 2. Load the roster

The People and Roster tabs, in one upload — **Admin → Import → Roster**, or the
same file through both. Leave *"Remove people who aren't in this file"*
unchecked for the first pass; tick it only once the workbook is genuinely the
whole roster, because it deletes everyone it does not find.

What the reader does with each tab:

- **People.** `Full Name` is the name; `Type` is the position, in the event's
  own words — `board`, `liaison`, `judge`, `videographer`, `RAS Rep` — mapped
  onto roles. A blank `Type` is an error, never a guess: it means the row is
  unfinished. `Phone` and `Email` become that person's contact card.
- **Roster.** `First Name` + `Last Name` become one name, and every row is a
  dancer because that is what the tab is. `Team` is required — a dancer reaches
  their schedule through their team's code, so one without a team cannot sign in
  at all. `Captain?` adds the Captain role on top of Dancer.

Two things it cleans up on the way in, both because these tabs get pasted in
from the same places they did last year:

- **The trailing `*` / `**` comes off a name.** It marks a food restriction, not
  a captain. `Captain?` is the only thing that makes a captain, in both
  directions.
- **Phone numbers land on one form**, and zero-width and direction marks are
  stripped. Two names differing only by an invisible character are two different
  people to every lookup in this app, and the next import creates the second one.

Then check nobody is unreachable:

```bash
npm run codes -- --check   # exits 1 if any subject has no live code
npm run codes -- --list
```

New teams and new staff arrive without codes — issuing them is item 25. Dancers
deliberately never get one.

### 3. Load the schedule

**Admin → Import → Schedule**, same workbook. The reader takes the **Export**
tab, whatever position it is in.

The preview names the tab it read and how many rows were importable. Read the
error list before applying: a row that fails is a row that silently does not
exist on anyone's phone.

⚠️ **Publish or download the Export tab from Google Sheets — do not send the
file the formulas were written in.** Export is entirely formulas. A workbook
saved by something that does not calculate them has an Export tab full of empty
cells, which is not an error, it is an *empty schedule*. The import refuses that
outright rather than applying it (a file with no importable rows would otherwise
mean "every block is missing, delete them all"), and the message says what to do.

The intended steady state is the published CSV, which makes changes flow on
their own:

> File → Share → Publish to web → Export → Comma-separated values → Publish

Give that URL to whoever runs the app, who sets `SCHEDULE_SOURCE=url` and
`SCHEDULE_SOURCE_URL` to it, plus `SYNC_POLL_SECONDS` to poll. Upload, Force
Re-sync and polling are the same pipeline, so switching sources changes nothing
about how a change is applied — see `.env.example`.

### 4. Fill in the show order

After the draw, type 1–8 into `Show Order` on the **Teams** tab. Saturday's
grid is built against slots rather than teams, so all of it can be built before
the draw and resolves itself afterwards. Every row must read `OK` — `DUPLICATE`
means two teams share a slot.

Then re-sync. The running order is also editable in **Admin → Roster**.

---

## What still has to be authored

This is the part item 24 warns is bigger than it sounds, and it needs a **named
owner** rather than a background task.

| What | State in the template today | Who |
| --- | --- | --- |
| **People tab** | 6 example rows | logistics |
| **Roster tab** | 1 example row — ~200 dancers to come, per team | team captains, collated by logistics |
| **Manual Blocks** | 1 example row. Thursday, Friday and Sunday are almost entirely this tab: board duties, registration, airport runs, checkout | logistics |
| **Airport runs** | The Airport tab has two example rows and reaches nothing — see above | logistics |
| **Windows** | 5 meal windows, plausible, unconfirmed | logistics |
| **Sequences / Slot Times** | Saturday's practice, photos and backstage flow are built and look real; the anchors are guesses | logistics |
| **Show order** | Empty until the draw | event director |
| **Event dates** | The workbook says 2026-08-07, which is a placeholder | event director |

⚠️ **Dancer schedules did not exist as data anywhere last year** — they were
scattered across six logistics tabs, and the master schedule contained only
exec board and liaisons. The pipelines on Sequences and Slot Times are the
answer to that: the ten steps of practice, typed once and spaced by arithmetic
rather than by hand, per team. That is the mechanism, not the content. Somebody
still has to decide what the steps and the anchors actually are.

---

## Checks before you call it loaded

1. `npm run codes -- --check` exits 0.
2. The import preview shows zero errors, on both tabs.
3. **Admin → View as** on one dancer, one captain, one liaison and one judge —
   each sees what they should, and the captain sees the captain blocks their
   teammate does not.
4. The **Checks** tab in the workbook shows no `OVERLAP`, no `OVERLOAD`, no
   `CLASH`, and nowhere says `(not drawn)` or `?? CHECK NAME`.
5. Nothing on any day tab has a time missing its AM or PM. This went wrong 192
   times in last year's file, and a 7:30 PM read as 7:30 AM is twelve hours of
   someone missing the thing they were supposed to be at.

Then item 25 — generate and distribute the links — and item 26, the dress
rehearsal, against exactly this data.

---

## If it will not load

| What you see | What it means |
| --- | --- |
| `No importable rows on the Export tab` | The tab is formulas with nothing calculated. Publish or export it from Google Sheets. |
| `Every row failed validation` | Wrong workbook, or the header row is not the first row. Nothing was applied either way. |
| `That workbook has no People or Roster tab` | Also the wrong workbook — last year's files have team names for tabs. |
| `this workbook is not in a layout the reader can open` | Valid file, unusual internals. Open it in Excel or Sheets, re-save, upload that. |
| `Day "Thursday" is not one of …` | The database has fewer days than the workbook. `npm run days` lists them. |
| `Role "…" is not a known role` | A `Type` the alias table does not know. Add the role in **Admin → Roster**, or fix the spelling — roles are data, so this needs no deploy. |
| `"…" matches a team and a person` | Genuine ambiguity. Prefix the assignment cell with `Team:`, `Person:` or `Role:`. |
