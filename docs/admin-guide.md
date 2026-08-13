# Admin guide — the one page

PLAN.md item 28. For whoever is holding the logistics panel this weekend. Print
it, or keep it open on the laptop that is running the panel.

The runbooks it sits on top of: [ops.md](ops.md) when the app itself is wrong,
[deploy.md](deploy.md) for the machine, [loading-data.md](loading-data.md) for
the spreadsheet, [distributing-links.md](distributing-links.md) for the links.

**Read this before the dress rehearsal** — [dress-rehearsal.md](dress-rehearsal.md)
ends by handing you the laptop and asking you to answer "I don't see my warm-up"
with no help. That is the point at which this page is either good enough or is
not, and there is a week left to fix it.

---

## The three facts

1. **Everyone sees only their own schedule.** There is no "the schedule" screen
   on a phone. When somebody says a time is wrong, the question is *whose*
   phone — use **View as** to see exactly what they see.
2. **Every change is live.** Saving a block reaches the affected phones in about
   a second, and nobody else's. There is no publish step, so there is no draft:
   what you type is what 25 people are reading.
3. **Every change is reversible for as long as nobody has edited over it.**
   **Change log → Undo** puts one action back whole, or refuses and changes
   nothing. It never half-applies.

---

## The five things you will actually do

| Situation | Do this |
| --- | --- |
| **Running late** | **Schedule → Shift times.** "Everything from 3pm moves 20 minutes", previewed as a list you can untick, applied as one action. Do not move blocks one at a time — half a day 20 minutes from the other half looks exactly like a correct schedule. |
| **One block moved** | Edit it in **Schedule**. If someone else edited it while your form was open, you get a conflict banner rather than a silent overwrite — reload the block and redo your change. |
| **"Fire alarm, evacuate"** | **Schedule → new block → target Everyone.** One block, every phone, including people who have not tapped their name yet. |
| **"I don't see my warm-up"** | **View as** their name. It shows their schedule *and* why: the targets their query matches, and how they sign in. Four different answers, four different fixes — the panel names which. |
| **"Did everyone get that?"** | **Ops → Phones connected.** One row per screen that is open, and whether it is showing the current version *of that person's own schedule*. Do not ask the room — a phone holding a twenty-minute-old time looks exactly like one that is right, to its owner as much as to you. |
| **"I lost my link"** | See the desk script below. |

**Undo is per action, not per block.** A shift of 18 blocks is one entry and
comes back as 18. An action that deleted somebody from the roster refuses to
undo, on purpose — restoring blocks for a person who is gone is worse.

---

## The check-in desk script

Decided in advance so it is not improvised with a queue waiting. The printed
**desk index** (below) has this on it, along with every name and their code.

- **A dancer:** give them **their team's link**. They tap their own name when it
  opens. Nothing is invalidated and no teammate is affected.
- **Staff:** give them **their own link**, from the desk index or from
  **Access codes**.
- **Do not regenerate to solve a lost link.** The old link still works — losing
  it is not the same as it being compromised — and rotating breaks whoever else
  is holding it. Regenerate only for a **lost or stolen phone**, and then send
  the new link to that person.
- **Nobody has a code at all:** issue one in **Access codes**, then reprint the
  desk index.

⚠️ **A link is a password.** Anyone holding it sees that subject's schedule.
Send it directly to the person; don't post it in a group document.

---

## Printed fallback — do this before the doors open

> If the app is down at 1pm Saturday, you need paper, not a rollback.

```bash
npm run callsheets              # writes the pack; --check just reports gaps
```

Or, with no terminal: **Admin → Ops → Printed fallback → Print the pack**.

The pack is **one sheet per team and per staff role**, and every sheet is built
from the same query the phones run — so paper and screen cannot disagree about
who is where. Each sheet has the shared schedule at the top and then anyone with
blocks of their own underneath, because **paper has no identity step**: a dancer
cannot tap their name on a printout, so their airport pickup has to already be
on it.

Every page is stamped with the time it was printed and says the phone wins.

⚠️ **Two documents, printed separately.**

| | Contains | Who holds it |
| --- | --- | --- |
| **The pack** (`scope=handout`) | schedules only, no codes | captains, stage manager, green rooms — hand it out |
| **The desk index** (`scope=desk`) | every name, how they sign in, and their **live access code** | the check-in desk, and nowhere else |

A code on a sheet taped to a wall is a live credential in every photograph of
that wall. That is why they are two files.

**Print both on the Thursday**, and reprint the desk index if you rotate
anybody's code. `npm run callsheets -- --check` exits non-zero if anyone on the
roster reaches no sheet, or if a block reaches nobody at all — both are silent
everywhere else in the app.

---

## Who is on call

The app pages one named person. Set before the deploy, and it prints on the desk
sheet:

```bash
fly secrets set ON_CALL_NAME="…" ON_CALL_PHONE="…"
```

- **It has to be a name, not a rota.** "Whoever notices" is nobody.
- **Not somebody also running a camera**, a stage, or a check-in desk. When this
  phone rings, that person stops what they are doing for twenty minutes.
- They need: the admin password, [ops.md](ops.md)'s restore sequence, and
  `fly` access on a laptop that is at the venue.

`npm run preflight` warns when nobody is named; the Ops tab says so too.

**Fill in before the event** — this is a gap until somebody's name is here:

| | Name | Phone |
| --- | --- | --- |
| On call for the app | | |
| Backup (knows the restore) | | |
| Event director (decides, doesn't fix) | | |

---

## Two things not to do

- **`fly scale count 2`.** A second machine is a second, empty database behind
  the same hostname. Both pass their health checks; half the venue gets the
  evacuation notice. See [deploy.md](deploy.md).
- **Bulk regenerate** in Access codes, unless every link at the event has
  genuinely leaked. Its blast radius is ~280 people locked out at once, which is
  why it makes you type `REGENERATE`.

---

## When the app itself is the problem

[ops.md](ops.md), in this order: is it up (`/api/health`), is there a recent
verified snapshot, what does the error list say. Restoring is
`npm run restore` **with the server stopped**.

While it is down, the paper above is the schedule. Say so out loud — the failure
mode that costs a performance is people quietly trusting a screenshot from
yesterday morning.
