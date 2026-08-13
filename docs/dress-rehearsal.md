# The dress rehearsal

PLAN.md item 26. Run it **T-1 week**, with real data, on real phones, in the
venue if you can get in.

This is the only step in the plan that finds what the plan missed. Everything
else in this repo tests the app against itself; this tests it against a room
full of people, bad wifi, and somebody who has never seen the panel before.

> ⚠️ **A rehearsal against the placeholder data proves nothing and looks
> identical to one that proves everything.** Every code resolves, every phone
> updates, every colour is right, and not one of the ~280 people who will
> actually be there is in the database. Run the gate first.

```bash
npm run rehearsal          # can this rehearsal answer its own question?
```

The same report is in the panel under **Ops → Event readiness**.

---

## Before the day

| | Who | Done when |
| --- | --- | --- |
| `npm run rehearsal` reports no blockers | whoever loads the data | it exits 0 |
| The event dates are the real ones | event director | `npm run days` shows the actual weekend |
| Links have gone out to the people coming | whoever mails them | `npm run codes -- --send-list` matches the invite list |
| Somebody is named in `ON_CALL_NAME` / `ON_CALL_PHONE` | you | `npm run preflight` stops warning about it |
| The printed pack exists **on paper** | you | `npm run callsheets`, printed, in a folder |
| The panel holder has read [admin-guide.md](admin-guide.md) | them | they can find **View as** without being told |

**Who you need in the room:** 10–15 people with their own phones, covering at
least two teams, at least one captain, and at least two staff on personal codes.
One person drives the panel — ideally *not* you, because "can somebody else run
this" is one of the things being tested.

**What you need open:** the panel on **Ops**, so the *Phones connected* card is
visible while changes are made. That card is how you know whether a change
landed, instead of shouting across a room and being told "yes" by somebody
looking at a twenty-minute-old screen.

---

## Part 1 — Everyone gets in (20 minutes)

Hand out links exactly the way they will go out for real. Do not read codes
aloud from a laptop; the point is to test the path the recipients will use.

| Step | What to do | What should happen |
| --- | --- | --- |
| 1.1 | Everyone opens their own link | Straight onto a schedule. No code typed, no role picker. |
| 1.2 | Dancers pick their name | Their own schedule, including anything person-targeted. |
| 1.3 | Check **Ops → Phones connected** | One row per phone in the room, all reading *up to date*. |
| 1.4 | Count the rows against the people | A missing row is somebody who thinks they are signed in and is not. Find out which, and why, before moving on. |
| 1.5 | One person locks their phone and unlocks it | Still signed in; no code screen. |
| 1.6 | One person opens their link on a second device | Works. Codes are bearer tokens, and this is normal. |

**Write down** anyone whose link did not work, and which of the five failure
screens they saw (invalid / revoked / orphaned / rate-limited / expired). Those
five mean five different things — see [distributing-links.md](distributing-links.md).

---

## Part 2 — Live changes (30 minutes)

Everybody keeps their phone in their hand and **does not refresh it**. Refreshing
is what hides the bug: a schedule that only updates on a pull-to-refresh looks
fine to everyone who pulls to refresh.

| Step | Change to make | What should happen |
| --- | --- | --- |
| 2.1 | Move **one block for one team** | That team's phones show the new time within a second or two. Nobody else's screen moves at all. |
| 2.2 | Watch *Phones connected* while you do it | The changed team's rows tick over; the rest stay as they were. Anything left *behind* is the finding — name the person and chase it. |
| 2.3 | **Shift times** from a cutoff on the busiest day | Preview lists what moves; untick one; apply. Every affected phone follows, and the unticked block did not move. |
| 2.4 | Undo it from **Change log** | Everything comes back together, on every phone. |
| 2.5 | Post an **Everyone** announcement | Every phone in the room, including anyone still on a team view who has not tapped their name. |
| 2.6 | Change a **captain-only** block | The captains see it; their teammates do not. Check with an actual teammate, not with View as. |
| 2.7 | Move somebody's **airport pickup** | It reaches that one person. This is the block type most likely to be wrong, because it is the one nobody notices until Thursday. |

⚠️ **2.2 is the whole point of the room.** The failure this app exists to prevent
is a *plausible wrong answer* — a phone that shows a correct-looking time that
is twenty minutes old. Nobody in the room can spot that by looking, including
the person holding it. The panel can.

---

## Part 3 — Break things on purpose (30 minutes)

Announce that this part is deliberate, or somebody will start fixing it.

### 3.1 Kill the server

Stop the process (or `fly machine stop`). Then, on phones:

- **A phone with the app open** keeps its schedule and shows **Offline · last
  known** with the time it was captured.
- **A phone that reloads** still gets the app — the service worker holds the
  shell — and the same offline banner. It must *not* show a browser error page.
- **A phone that has never opened the app** cannot get in. Expected.

Start the server again. Every phone reconnects on its own, without a reload.
Nobody should have to be told to do anything.

### 3.2 Kill the wifi

Not the same test, and this is the one that behaves worse in a real venue. Turn
the venue wifi off, or put a phone in airplane mode.

- Same offline banner.
- ⚠️ Watch for **associated but not passing packets** — wifi that is "connected"
  and dead. That is the venue failure mode, and it is why the service worker has
  a 3.5-second timeout rather than waiting for a request that never fails.
- Turn it back on: the phone refetches by itself.

**Also test the hotel/venue captive portal** if there is one, by joining the
network fresh on one phone. A captive portal answers every request with its own
sign-in page, and the app must not cache it as the shell.

### 3.3 Revoke a code

Pick a volunteer. **Access codes → Revoke** their link.

- Their phone goes to the code screen at the next request, and says the link was
  revoked rather than just failing.
- Their old link, opened again, is refused.
- Now do the desk script: give them the right replacement — a dancer gets their
  *team's* link, staff get their own reissued — and time how long it takes.
  That is your check-in desk service time.

### 3.4 Delete a team

On a team nobody in the room is on, ideally. **Roster → delete.**

- It refuses first, and says how many blocks go with it.
- Confirm: the team's blocks go too, and its dancers are unassigned rather than
  deleted.
- **Undo it.** Note whether it comes back or refuses — a batch containing a
  roster delete refuses on purpose, and if it refuses, you have just learned
  that this one is not undoable and the fix is a restore.

### 3.5 The restore drill

⚠️ **Do this one. A backup nobody has restored is a hypothesis.** It is the last
line under "total app failure" in the risks table, and the first time it is run
must not be the Saturday.

```bash
npm run backup                          # a verified snapshot, now
# ...then do something destructive: a bad import, or delete a day's blocks
npm run restore                         # what is available
npm run restore -- <name>               # dry run: what that snapshot holds
# stop the server
npm run restore -- <name> --yes
# start the server
npm run codes -- --check                # and open one magic link
```

**Timed on this repo's dev database (166 people, 110 blocks, 0.4 MB) on
2026-08-13:** snapshot 0.18s, verify 4ms, restore 0.11s. The clock that matters
is not any of those — it is *stopping the server, deciding which snapshot, and
starting it again*, which is minutes, and which is why the decision belongs to
one named person. Re-time it on the real machine once the deploy exists; a Fly
volume is not a laptop SSD.

Check afterwards: block count back, one magic link opens, and the phones in the
room reconnect on their own.

### 3.6 Two admins at once

Two people open the same block in **Schedule** and both save.

- The second save is refused with what it would have overwritten, not merged.
- The refused person's typing is still in the form.

---

## Part 4 — The paper (10 minutes)

The pack is only useful if it has been *printed*, and printing it is the step
that always slips.

- Hand a team's printed sheet to somebody on that team. Ask them to find their
  own name. If they cannot, the sheet is wrong, not them.
- Check that a captain's sheet has her captain-only blocks, and that a plain
  dancer's has her airport pickup. Both come from a set difference against the
  shared half — see item 28.
- ⚠️ **Check that no access code appears anywhere in the handout pack.** There is
  a test for this; look anyway, because the desk index does carry them and the
  two documents get printed together.
- Confirm the desk index is behind the desk and not on a wall.

---

## Part 5 — Hand the panel over (15 minutes)

Give the laptop to whoever is running logistics on the day and read them nothing.

- Ask them to answer "I don't see my warm-up" for a real person in the room.
- Ask them to move an afternoon back by 20 minutes.
- Ask them to undo it.

If they need to be told where anything is, that is a finding about
[admin-guide.md](admin-guide.md), not about them.

---

## Writing it down

The output of a rehearsal is a list, not a feeling. For each finding, record:

| | |
| --- | --- |
| What happened | in the words of the person it happened to |
| Whose phone | model and browser — item 21's [device matrix](device-matrix.md) |
| Reproducible? | tried twice |
| Fix before the freeze? | yes / no / paper covers it |

Anything answered "yes" has to land before the Wednesday freeze (item 27), which
is five days later. That is the real deadline this rehearsal is measured
against — a finding discovered here and fixed on the Friday is a change nobody
tested.

Add what you find to the risks table in [PLAN.md](../PLAN.md), and record any
decision that came out of it in [decisions.md](decisions.md).
