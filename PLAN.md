# Royalty — development plan

Reference document for taking the working draft to production-ready for
competition weekend. **Read this at the start of every session.**

- Update the status marker on an item when you finish it, in the same commit as
  the work.
- Record anything you *decide* in [docs/decisions.md](docs/decisions.md), not
  just here. This file tracks what to do; that one tracks why.
- Markers: `[ ]` not started · `[~]` in progress · `[x]` done · `[-]` dropped

---

## Where things stand

**Done: Phase A (1–4), Phase B (5–8), Phase D (15–18), and items 9, 10, 11, 13,
14, 19, 20, 22, 23, 27 and 28. Items 12, 21, 24, 25 and 26 are half done** — item
12's name collisions are closed and its meridiem gap is the only messy-input
item left; item 21's
accessibility and responsive pass has landed and its hardware checks are open;
items 24 and 25 turned out to have real engineering in them, which is done, and
what remains of both is the roster itself; item 26's tooling and script are
built and the rehearsal itself needs a room full of people. Item 27's gate, tag
and drift check are built, and the freeze itself waits on a date and a machine.
Last updated 2026-08-13.

- The viewer is **behind access codes**, enforced server-side, with the roster
  no longer enumerable. Codes are managed and exported from the admin panel.
- Event times are **resolved server-side against the venue's timezone**, so a
  phone on the wrong zone or the wrong clock cannot shift what it shows.
- The data model carries **multi-role people** (captains hold Dancer + Captain)
  and a **running order** on teams.
- Changes are **broadcast only to the people they affect**, over a socket whose
  origin is now locked down.
- Each participant's **"Last updated" is their own**, keyed on the same block
  targets that name their socket rooms, and concurrent admin edits are refused
  rather than silently overwriting each other.
- **Running late is one action**: "everything from 3pm moves 20 minutes",
  previewed and applied whole rather than forty edits under pressure.
- **A reload with no signal still works** — a service worker holds the app
  shell, so the offline schedule cache survives the refresh people reach for
  when a screen looks stale.
- **"I don't see my warm-up" is answerable from the panel** — View as renders
  anyone's schedule from the query their own phone runs, next to why each block
  reaches them and how they sign in.
- **A change can be put back** — one admin action is one entry in the log, and
  undo reverts all of it or refuses and writes nothing.
- **"Fire alarm, evacuate" is one block**, targeting everyone, reaching every
  session and every socket.
- **The deploy is configured and guarded, not yet run.** One Fly machine on one
  volume, never idling, behind HTTPS; the server refuses to boot in production
  with the default admin password, an unpinned signing key, or a database on a
  filesystem the next deploy replaces — all three of which otherwise produce a
  server that passes its own health check.
- **The event data is copied off the machine every few minutes, verified**, and
  putting one back is a script rather than an improvisation; `/api/health` now
  fails when phones are not being served rather than whenever the process is
  alive; and the alarm that pages someone lives outside the machine, because
  nothing inside it can report that it stopped.
- **The event's own workbook loads.** Sixteen tabs, three of which the app
  reads; both roster tabs in one upload; four event days rather than two; and an
  import that yields nothing is refused rather than applied as an empty
  schedule. What is left of item 24 is the content and the dates.
- **Every link has somebody to send it to, or says why not.** A team's link is
  addressed to its captains and a staff member's to themselves, from their own
  address rather than from the coordinator card they share with a dozen other
  people — and a link that cannot be sent stays in the file naming the fix.
- **The weekend prints.** One sheet per team and per staff role, generated from
  the same query the phones run, so paper and screen cannot disagree — plus a
  desk index that answers "I lost my link" without a laptop. The handout pack
  carries no access codes and the desk index does, which is why they are two
  documents.
- **A rehearsal knows whether it means anything, and a change knows whether it
  landed.** `npm run rehearsal` refuses a run against dates that have already
  happened, a schedule made of seed rows, or a day with nothing on it — the
  placeholder passes every other test in this repo. And **Ops → Phones
  connected** answers "did everyone get that?" from the sockets rather than from
  asking the room, per subject rather than against the event's clock. The
  restore drill has been performed and timed.
- **The release that goes to the venue is tagged, and the machine can be asked
  whether it is holding it.** `npm run freeze` refuses a dirty tree, a red build
  and item 26's blockers, then cuts an annotated `release-YYYY-MM-DD` carrying
  the event dates and the roster counts. ⚠️ The running server can only name its
  own release if the *build* stamped it — there is no repository inside the image
  — so a plain `fly deploy` produces a machine indistinguishable from any other,
  which `preflight` and the Ops panel now say out loud.
- **619 tests run in CI**, covering authorization negatives, timezone and DST,
  code management, the schema migrations, broadcast scoping, the item 14
  correctness gaps, the bulk shift, the offline shell, preview fidelity,
  everything undo refuses, the announcement target, the measured colour
  contrast, the deploy gate, snapshot verification and restore, the printed
  pack's fidelity to the phones and the codes it must never carry, the import
  pipeline — including last year's real spreadsheets, which the importer has to
  refuse without moving the schedule — the event template's own tabs and
  columns, so a renamed one is a red build, the rule that no shared contact
  card can ever become a link recipient, the per-subject comparison
  behind "is this phone up to date", every way the readiness gate refuses, every
  way the freeze gate does, including a release identity that must
  never fall back to a version string that has never changed, and — new — every
  way the roster importer refuses two rows it cannot tell apart, including the
  re-sync that silently froze one of two people sharing a name.
- **The app is usable by someone who cannot see it.** Headings, landmarks and a
  real list where there were only `div`s; every colour measured against AA
  rather than eyeballed; one keyboard tab pattern instead of four broken ones;
  live changes announced. See [docs/device-matrix.md](docs/device-matrix.md).
- **600 phones have been measured, not assumed.** The worst change the product
  can make — an announcement to everyone — reaches all 600 in ~140 ms with no
  errors, and the personalized schedule is 3.7× cheaper than it was before the
  test profiled it.

The open decisions are all resolved (see below); item 12 was reshaped by them.

**Not yet true of this project:** nothing is deployed *yet* — item 22 built the
config, the guardrails and the runbook, but the `fly deploy` itself needs an
account and has not been run, so item 23's backup target, heartbeat and alert
webhook are configured-for rather than pointed at anything. And no real data —
which `npm run rehearsal` now says out loud, in the form of four blockers. **And
nothing is frozen**, because a freeze needs both of those first: item 27's gate
refuses this tree today on the dates and the roster, and its `--url` half has no
machine to ask.

**Next up: the rest of items 24 and 25, which are one people problem** — the
real dates, ~80 staff and ~200 dancers into the template with an address each,
and Thursday/Friday/Sunday onto Manual Blocks. Both engineering halves are built
and demonstrated; [docs/loading-data.md](docs/loading-data.md) and
[docs/distributing-links.md](docs/distributing-links.md) are the runbooks and
the gap list. **Item 26 now says the same thing in one command**: `npm run
rehearsal` lists exactly what is missing before a rehearsal would be worth
running, and today the answer is the dates, the roster and two empty days. Phase
F is built — what is left in it is running
`fly deploy` with an account, and pointing the three item 23 secrets at real
services ([docs/ops.md](docs/ops.md)). Item 21's remaining half needs phones in
hands, not code — run [docs/device-matrix.md](docs/device-matrix.md) before the
dress rehearsal. Item 28's code is done; what it leaves for people is naming the
on-call ([docs/admin-guide.md](docs/admin-guide.md) has the table to fill in)
and actually printing the pack, which is worth nothing until the roster is real.
Item 27 is the same shape: `npm run freeze` is built and it refuses this tree
today, correctly, for the reasons above — the freeze itself is a Wednesday, once
there is a weekend to be the Wednesday before.

### Build order

`templates/royalty-schedule-template.xlsx` is **now committed** (item 24), and
`tests/template.test.js` reads it — so the day logistics renames a tab, CI says
so. It is still being iterated, which no longer means it exists on one laptop.
Everything else proceeds now, in this order:

1. ~~**Item 4** — anonymized fixtures.~~ Done.
2. ~~**Phase B (5–8)** — access codes.~~ Done.
3. ~~**Items 9, 13, 11, 14, 10**~~ — timezone ✅, the two schema columns ✅,
   scoped broadcasts ✅, correctness gaps ✅, service worker ✅. Done.
4. ~~**Phase D (15–18)** — admin tooling.~~ Done.
5. **Item 12 last**, against a frozen template.

Item 12 splits: only the tab readers depend on the template's shape. Diff
classification, apply, the `ingest()` contract, and validation reporting can be
built now — and are now covered by tests, written against the pipeline as it
stands rather than against the template. Item 19 is done on that basis; what a
frozen template adds is the tab readers, not a second test suite.

⚠️ **The template is still on the critical path for the dress rehearsal
(item 26)** even though it is built last, because nothing can be demonstrated
end-to-end with real data until it lands. Track it as a dated dependency. If it
isn't final by T-2 weeks, the rehearsal is at risk no matter what else is done.

### Architecture in one paragraph

Express + Socket.IO + SQLite (better-sqlite3) in a single process, serving a
React/Vite bundle from `client/dist`. Viewer at `/`, admin at `/admin`. Roles
are rows in the database, not an enum, so new ones need no deploy. Every
schedule change flows through one pipeline — `bytes → parseTabular →
normalizeScheduleRows → computeScheduleDiff → apply` — which upload, force
re-sync, and background polling all call, so swapping in live Sheets sync is an
env-var change. See [README.md](README.md) for setup and the data model.

---

## Open decisions

**All resolved 2026-08-05** — reasoning in [docs/decisions.md](docs/decisions.md).
Summary, with the item each one now constrains:

| Decision | Resolution | Constrains |
| --- | --- | --- |
| Access-code granularity | Per-team for dancers, per-person for staff. A team code then asks "which dancer are you?" and yields a person session. | 5, 6, 7, 8, 25 |
| Data model | `teams.show_order` plus a `person_roles` join table. Captains hold `Dancer` + `Captain`. | 13 |
| Judges | Running order + a few role-targeted blocks. No authored per-judge schedule. | 13, 24 |
| Schedule source of truth | Logistics fills `templates/royalty-schedule-template.xlsx`; the app imports it. Admin panel is source of truth for live changes only. | 12, 24 |
| Event timezone | Server-authoritative. `America/Indiana/Indianapolis` (Bloomington, IN) — IANA name, never a fixed offset. | 9, 24 |
| Headcount | Size for 280, load test at 600. | 20, 25 |
| Event-wide announcements | **Yes** (2026-08-10) — a fourth block target, `everyone`, rather than a separate concept. | 18 |

One value is still pending, and item 24 is now waiting on it: the real **event
dates**. Not locked as of 2026-08-05 — the 2026-08-07 in the seed and in the
template is a placeholder, and as of 2026-08-11 it is in the past. There is now
a mechanism (`npm run days`, which moves the whole weekend from one date and
refuses a date that is not the weekday it was given as); what is missing is the
number. **The event runs Thursday to Sunday**, settled by the template's four
day grids and applied to `event_days` in item 24.

The three questions that needed the event director were answered 2026-08-05, all
in the direction of less work:

1. **`*` / `**` on the roster marks food restrictions, not captains.** Irrelevant
   to this app. The importer's only duty is to strip it from names.
2. **Every person holds exactly one role** in the org-chart sense — `Ashka Patel`
   is two people sharing a name. Captains are the one modelled exception: they
   hold `Dancer` + `Captain` so that three captain-only blocks can be
   role-targeted rather than duplicated 27 times.
3. **The template is ours to iterate**, not something logistics might reject.
   They will keep revising it until they have a copy they like.

---

## Access-code design (built — items 5–8)

Reverses the original "one shared link, no passwords" concept. Gains privacy,
costs lost-code support at check-in.

- **The code replaces the picker.** Enter a code — or open a personalized link —
  and land straight on your schedule. No role step, no name step.
- **Distribute links, not codes.** `…/s/K7M2QX` per team captain, one per staff
  member. Nobody types anything; localStorage keeps them signed in. A manual
  code box remains as the fallback for a new device.
- **The server must enforce it.** Today `/api/schedule?type=team&id=…` is open
  and `/api/bootstrap` returns every name and team. Codes are decorative until
  both are behind a validated session. This is the part that has to be right.
- **Codes are bearer tokens.** A team code will get shared within the team — that
  is intended. It also means a leaked code needs one-click revoke + regenerate.
- **Codes must be readable by admins** in order to be distributed, so they can't
  be hashed at rest. Compensate with rate limiting and event-scoped lifetime.
- Short, typeable, no ambiguous characters (no `0`/`O`, no `1`/`l`/`I`).

---

## Phase A — Ground truth

Blocks everything else. Do these first.

### 1. `[x]` Put the project under version control

Not a git repo yet, which makes every step below riskier and the code freeze in
item 27 unenforceable.

- **Claude Code:** "Initialize git, write a sensible .gitignore, make the initial
  commit." Then commit after every numbered item.
- **Done when:** `git log` shows an initial commit and `data/` is ignored.

### 2. `[x]` Analyze the sample rosters and past master schedules

Raw and unedited — the mess is the signal. Include before/after versions of a
past weekend if they survived; the diff shows what actually changes live.

- **Claude Code:** Put files in `samples/`, then: *"Analyze these — don't change
  any code. Report the real column format, what varies between years, and what
  the data implies about the model."*
- **Done when:** a written analysis exists and the item 2 questions above are
  answered or narrowed.

**Done 2026-08-05** — [docs/sample-data-analysis.md](docs/sample-data-analysis.md).
Only one year was supplied (RRXVI 24–25), no before/after pair, so year-over-year
drift is inferred from drift between the four day sheets. Headlines:

- **The master schedule contains no dancers.** All ~60 rows are exec board and
  liaisons. Dancer schedules exist only scattered across six logistics tabs —
  assembling them is content work nothing in this plan currently budgets for.
- **It is a merged Gantt wall chart, not a table** (651–751 merged ranges per
  day). Item 12's "column mapping" is the wrong shape; it needs a grid decoder.
- **Meridiem is written on the end time only** in 143 cells, absent in 49 —
  a naive parser produces a silent 12-hour error. Text and grid disagree in 8.6%
  of cells even parsed correctly.
- Past-midnight blocks are routine; Saturday's call time is 03:45.
- ~260 participants last year, against the ~170 assumed in CLAUDE.md.

Five of the six item-2 model questions are answered (see the analysis); the sixth
— judges — is narrowed. Five questions now need the event director, not the data.

### 3. `[x]` Resolve the open decisions

Data model from the analysis plus a short call with the event director; the
role-code question from the access-code design.

- **Claude Code:** Use plan mode. Finish with *"write these decisions to
  docs/decisions.md."*
- **Done when:** every open decision above has a recorded answer.

**Done 2026-08-05** — six entries in [docs/decisions.md](docs/decisions.md),
summarized in the table above. What changed downstream:

- **Item 12 shrank.** It is a template importer against a workbook we control,
  not a decoder for their wall chart. The messy-input lessons still apply to the
  Roster and People tabs, which are still pasted in from the same sources.
- **Item 13 is bounded** to one join table (`person_roles`) and two columns
  (`teams.show_order`, `people.is_captain`). The late-schema-change risk is
  effectively closed.
- **Items 8 and 28 became non-optional.** Per-person staff codes means ~80 codes
  to distribute and a real lost-link path at check-in.
- **Item 20's target moved** from 400 connections to 600.
- **Item 24 gained content work** — the dancer schedules that don't exist as data
  anywhere have to be authored into the template.

### 4. `[x]` Anonymize the samples into committed fixtures

Same structure and edge cases, fake names and numbers. Past rosters carry real
contact details for ~150 people; those should not enter version control.

- **Claude Code:** *"Generate anonymized fixtures from samples/ preserving
  structure and edge cases; keep the originals gitignored."*
- **Done when:** fixtures are committed, originals are not.

**Done 2026-08-05** — `fixtures/`, generated by `scripts/anonymize_samples.py`
and gated by `scripts/verify_fixtures.py`. See
[fixtures/README.md](fixtures/README.md) for the edge-case inventory.

```bash
python3 scripts/anonymize_samples.py && python3 scripts/verify_fixtures.py
```

284 first names, 223 surnames and 214 phone numbers remapped; merge geometry,
sheet names, formulas and non-empty cell counts identical to the originals.
Three things worth knowing:

- **Two of the four samples are from the previous year** (RRXIV — UCSD, VT,
  UCLA, Purdue, GW), which is the year-over-year drift sample the analysis said
  we lacked. Use them to check the importer doesn't hardcode this year's teams.
- **A sixth phone format exists** that the analysis missed: `(925)-430-8287`,
  parens *and* a hyphen. Item 12's parser needs it.
- **The verifier is the deliverable, not just the fixtures.** It caught two real
  leaks that eyeballing did not — people who appear only inside free text in the
  airport tabs, and a shouted name in the orphan cell. Run it after any change
  to the anonymizer.

---

## Phase B — Access codes

### 5. `[x]` Add the access-code schema and generator

`access_codes` table: code, subject type, subject id, created, last used,
revoked. Migration backfills codes for the existing roster.

- **Done when:** every team and person has a code, and codes survive a re-seed.

**Done 2026-08-05** — `access_codes` in `server/schema.sql`,
`server/lib/access-codes.js`, CLI at `server/codes.js`.

```bash
npm run codes -- --list     # every live code and its subject
npm run codes -- --check    # coverage; exits 1 if anything is missing
```

- **Dancers deliberately get no personal code**, which narrows the "every
  person" in the done-when above. They reach their schedule through their team's
  code plus the identity step; issuing ~190 individual dancer codes would mean
  that many live credentials nobody distributes and nobody revokes. Teams and
  staff get codes; roles are supported but never issued automatically.
- **8 characters** from a 30-character alphabet with no `0/O`, `1/I/L`, or `U`.
  Longer than the "short, typeable" sketch above because the code is normally a
  link and typed only when setting up a second device — so a bug in item 6's
  rate limiter isn't by itself enough to enumerate the roster.
- **One live code per subject is a database constraint**, not a convention:
  a partial unique index on `(subject_type, subject_id) WHERE revoked_at IS
  NULL`. Regenerating revokes and re-inserts, so revoked rows stay as an audit
  trail — "was this leaked code used before we killed it?" stays answerable.
- **Backfill is idempotent**, so `npm run seed` on a populated database is the
  migration and never rotates a code that has already gone out.

Codes are still decorative until item 6: `/api/schedule` remains open and
`/api/bootstrap` still returns the whole roster.

### 6. `[x]` Enforce codes server-side ⚠️ security-critical

Code → signed session cookie. `/api/schedule` restricted to the session's own
subject. `/api/bootstrap` removed or gutted so the roster isn't enumerable.
Rate-limit code attempts.

- **Claude Code:** Do this item alone. Then run `/security-review` on the diff
  and ask explicitly: *"Can I reach another subject's schedule without their
  code?"*
- **Done when:** a request without a valid session cannot retrieve any schedule
  or roster data, and that's covered by a test.

**Done 2026-08-05** — `server/lib/viewer-auth.js`, rewritten
`server/routes/public.js`, 21 tests in `tests/authorization.test.js`.

```bash
npm test
```

`/api/schedule` **reads no query parameters**. The subject comes from the
session and nothing else, so there is no id left to tamper with. Cross-subject
access is blocked at four independent layers, each re-checked per request:
cookie signature, the authorizing code still being live, the subject still
existing, and an identified person still belonging to the team that vouched for
them. The last two matter because a signed cookie is self-contained — without
them, "revoke" would only stop new sign-ins.

`/api/bootstrap` returns the event name and nothing else. It used to return
every role, team, and person, which was a one-request roster dump.

**Residual issues, deliberately not fixed here:**

- ⚠️ **Socket.IO CORS is `origin: true, credentials: true`** — any origin can
  open an authenticated socket. Harmless while broadcasts carry only
  `{updatedAt, reason, changedBlockIds}`; **becomes a leak in item 11**, which
  puts audience information into those payloads. Tighten it there.
- **Codes never expire.** Revocation is the only control; the access-code design
  called for an event-scoped lifetime too. Add a cutoff or bulk-revoke — item 22.
- **`trust proxy` defaults to 1**, so IP rate limiting is bypassable if the
  process is exposed without a proxy. Configurable via `TRUST_PROXY`; verify at
  deploy. The 8-character keyspace, not the limiter, is the primary defence.
- **The identity step is not a security boundary** — a team code can select any
  name on that team and read that person's blocks. Intended; see
  `docs/decisions.md`. Item 6's review should not re-flag it.

**The viewer landing screen is a placeholder** until item 7. It says schedules
are private and to open your link; there is no way to sign in from it yet. The
old role picker is gone (`Landing.tsx` deleted) because it depended on the
roster dump. Admin panel is unaffected.

### 7. `[x]` Rebuild the landing flow as code entry + magic links

`/s/:code` auto-signs-in. Manual entry box as fallback. Distinct states for
invalid, revoked, and expired codes.

**A team code lands on a team-scoped "which dancer are you?" step**, and the
result is a person session — the server verifying the chosen person belongs to
the authorized team. Staff codes skip the step entirely. Without this, no
person-targeted block (airport pickups) and no captain role block reaches a
dancer at all; see the captains decision.

- **Claude Code:** Ask it to verify in the browser preview at mobile size —
  valid code, bad code, revoked code, a returning visit with no typing, and a
  team code resolving to one dancer's own schedule.
- **Done when:** all five paths are demonstrated working, not just implemented.

**Done 2026-08-05** — all six paths demonstrated at 375×812, plus 8 new tests
(29 total). `CodeEntry.tsx`, `IdentityPicker.tsx`, rewritten `Viewer.tsx`,
`server/routes/magic-link.js`.

**`/s/:code` is handled server-side**, not in React: it redeems, sets the
cookie, and 302s to `/`. That means a magic link works before the bundle has
downloaded, and the code does not linger in the address bar or in browser
history where it would ride into screenshots. Both entry paths share one
`redeemCode()` and therefore one rate-limit budget — the magic link is the path
almost everyone uses, so it must not be the untested one.

Five distinct failure states, each with its own copy: `invalid`, `revoked`,
`orphaned`, `rate`, and `expired`. Note that **codes never expire** — "expired"
is a *session* running out, distinguished from a first visit by a localStorage
marker. A genuine code expiry is still unbuilt (see item 6's residual list).

Signing out clears the cached schedules, and so does a 401 — the likeliest
reason a code is revoked mid-event is that the phone holding it went missing.
Being offline does not trigger that path, so the offline cache survives bad
wifi.

### 8. `[x]` Build code management in the admin panel

View, regenerate, and revoke per subject; bulk regenerate; CSV export of
subject → link for distribution.

- **Done when:** you can produce the exact file you'll mail-merge from.

**Done 2026-08-06** — an Access codes tab (`client/src/admin/CodesPanel.tsx`),
`server/routes/admin-codes.js`, and 23 new tests (52 total). Verified in the
browser against the seed data: regenerating a team code killed the old magic
link and the new one landed on the identity step; revoking a staff code locked
it out; the export downloaded 45 rows.

```bash
npm test
```

- **The export carries no email column**, and that is deliberate — see
  `docs/decisions.md`. Nobody's own address is stored anywhere in this app, so
  the merge joins on the subject name against whatever list logistics mails
  from. This is the one thing to re-read before "improving" the CSV.
- **Links come from `PUBLIC_BASE_URL`** when it is set, falling back to the
  request's host. Set it at deploy (item 22) — behind a proxy the host header is
  whatever the proxy passed along, and 280 links to the wrong hostname is a
  mistake the recipients discover, not us.
- **Bulk rotate is gated on typing `REGENERATE`**, server-side as well as in the
  UI. Its blast radius is everyone at the event locked out simultaneously, which
  is worse than anything else in the panel; a confirm dialog is not enough of a
  speed bump.
- **Orphans are shown but cannot be regenerated** — only revoked. Reissuing for
  a deleted subject would mint a live credential for something with no schedule.
- The panel makes coverage the headline (live / never used / missing), because
  the question an admin arrives with is "who still hasn't got a link", and a
  subject with no code cannot reach their schedule at all.

The CLI (`npm run codes`) stays for the no-browser cases and shares the same
library, so the two cannot drift.

**Residual, not fixed here:** opening a dead magic link while already signed in
silently keeps the existing session instead of explaining that the link is
revoked. Harmless — no cross-subject access, item 6's checks still hold — but
confusing at a check-in desk. It is item 7 behaviour, not new; fold it into
item 14's correctness pass.

---

## Phase C — Reliability core

### 9. `[x]` Pin an explicit event timezone

Server-authoritative. Today "now / next" renders against the phone's clock, so a
traveller's mis-set device sees a silently shifted schedule. Wrong is worse than
absent here, because now/next is the whole product.

**Done 2026-08-06** — `server/lib/event-time.js`, `client/src/clock.ts`, a
rewritten `client/src/time.ts`, and 21 new tests (73 total).

```bash
npm test
```

**The split that makes this work:** the server knows the zone and turns
`(date, HH:MM)` into an absolute instant; the client knows that time is passing
and only ever compares instants. Every block now leaves the server with
`startsAt` / `endsAt` alongside its wall-clock strings, and **nothing in the
client parses a date string or reads the device's timezone any more.** The old
`new Date(`${day.date}T00:00:00`)` was parsed in the *phone's* zone, which is
the entire bug.

- **Two different device faults, two different fixes.** A wrong *timezone* is
  handled by not asking the device. A wrong *clock* is handled by measuring it:
  every payload carries the server's `now`, and the client applies the
  difference. Demonstrated in the browser — a device pushed 3 hours fast showed
  "in 5h 8m", and after one refetch re-measured the drift, "in 8h 8m".
- **A bad `EVENT_TIMEZONE` stops the server**, and abbreviations and fixed
  offsets (`EST`, `-05:00`) are refused by name. There is deliberately no
  fallback: falling back to a default would be the exact silent failure this
  item exists to prevent, and the only way to hit it is a config change with
  someone watching. The boot banner prints the resolved zone and offset.
- **`?now=` is now venue wall-clock**, resolved by the server via `/api/time`,
  so a rehearsal stands where an attendee stands. The viewer shows a banner
  while it's pinned — otherwise a rehearsal is indistinguishable from the live
  app, and someone eventually acts on it.
- **`/api/schedule` still reads no query parameters.** The time override goes
  through `/api/time`, which carries no event data and needs no session, rather
  than qualifying the property item 6 left behind.
- **Past-midnight blocks are resolved server-side and tested** — Friday 23:30 →
  Saturday 03:45 is a real call time here. That closes part of item 14.
- The offline cache is now `royalty.schedule.v2.`; v1 payloads have no instants
  and are dropped rather than adapted. Zone comes from the cache, "now" never
  does — a cache's timestamp is however old the cache is.

Also fixed a stale README line claiming the viewer has no login (untrue since
item 6), and added `EVENT_TIMEZONE` and `PUBLIC_BASE_URL` to `.env.example`.

### 10. `[x]` Add a service worker for the offline app shell

The cache only works if the page is *already loaded*. A pull-to-refresh with no
signal currently gives a browser error — and refreshing is exactly what people
do when something looks stale.

**Done 2026-08-10** — `client/sw.js`, `client/vite-plugin-sw.js`,
`client/src/register-sw.ts`, and 26 new tests (`tests/service-worker.test.js`,
198 total). Verified by killing the server, not by reading the code: a full
reload with the process dead rendered the judge's three Saturday blocks behind
the "Offline · last known" banner.

```bash
npm test
```

- **The worker caches the shell and nothing else** — the HTML and the one
  JS/CSS pair the build emits. ⚠️ `/api/*` and `/socket.io/*` are not
  intercepted *at all*, and that is the whole point: the app already has a
  schedule cache that renders behind an offline banner with its capture time,
  whereas a cached `/api/schedule` would come back through `api.get()` as an
  ordinary 200 and render as live. Same class of bug as the timezone one item 9
  removed. There is a test per API path asserting `respondWith` is never called.
- **Navigations are network-first**, which is the opposite of the usual recipe
  and deliberate: cache-first would leave a phone that installed on Friday
  serving Friday's HTML and Friday's asset hashes through every refresh, so an
  emergency fix would reach nobody who had already opened the app. Demonstrated
  by rebuilding with a changed bundle and reloading — new cache, old one
  deleted, new bundle loaded. The 3.5s timeout is for venue wifi that is
  associated but not passing packets, where the request hangs rather than fails.
- **`/s/:code` offline gets a written page, not the shell.** Not politeness — a
  loop: `App.tsx` sends any `/s/` path back to the server with
  `location.replace`, so answering it from cache is an infinite redirect on a
  phone with no signal. The page links to the saved schedule instead.
- **`/admin` offline says so** rather than rendering a panel that cannot save.
- **A captive portal never becomes the app.** Venue and hotel wifi answer every
  request with 200 and their own sign-in page; caching that as the shell would
  hand every later offline reload a wifi login screen, and it would stay until
  the next successful load. `response.redirected` catches it, with a test.
- The manifest comes from the real bundle at build time, so the build id changes
  when and only when the shell's contents do — a byte-identical `sw.js` is
  ignored by the browser and nothing would update. `sw.js` is served with
  `Cache-Control: no-cache` for the same reason.

**Residual:** an open page is not told a new build exists; it picks one up on
the next reload. Fine under item 27's freeze, and an update prompt is a
notification nobody at a competition will read. Also no offline *write* queue —
the viewer is read-only, so there is nothing to queue.

### 11. `[x]` Scope broadcasts to the affected audience

Every change currently makes all ~280 clients refetch. The audience
(`personIds` / `teamIds`) is already computed for the edit log — put it in the
broadcast and let clients ignore changes that don't affect them.

⚠️ **Lock down the Socket.IO origin in the same change.** It is currently
`{ origin: true, credentials: true }` — any site can open an authenticated
socket. That is survivable only because broadcasts carry no personal data today.
Putting `personIds` into the payload without fixing the origin turns a shrug
into a leak.

**Done 2026-08-06** — `server/lib/live.js`, a scoped `broadcast` threaded
through every write path, and 30 new tests (123 total).

```bash
npm test
```

**The audience never leaves the server**, which is a deliberate departure from
the sketch above — see `docs/decisions.md`. Sockets join a room per block target
and a change is emitted only to that block's rooms, so the payload is still
`{ updatedAt, changedBlockIds, at }` and an unaffected client receives no bytes
rather than receiving and discarding them. Client-side filtering would have put
a who-is-affected list on every socket, which is the roster disclosure item 6
just closed.

- **A room name is a block target**, and a socket joins one room per entry in
  `resolveSession(...).targets` — the same list the schedule query ORs over. So
  "who hears about this block" and "whose schedule contains this block" are one
  computation. This is the part to preserve if anything here is rewritten.
- **The origin is same-origin plus an allow-list**, enforced in `allowRequest`
  because that is the one hook that sees `Host` alongside `Origin`. Comparing
  the two is what makes it correct with no configuration — important when the
  deploy target is still open, since a mis-set allow-list would mean "nothing
  updates live" discovered on Saturday. Verified against the running server: a
  foreign origin gets 403, same-origin and header-less clients get 200.
- **A session change re-handshakes the socket** (`resyncSession()` on the
  client). Room membership comes from the handshake cookie, so without it a
  dancer who has just picked their name keeps hearing only team-wide changes and
  misses their own airport pickup moving. Demonstrated in the browser.
- **Roster edits re-derive every open socket's rooms** server-side, because
  moving a dancer between teams has to move their socket. The failure mode
  without it is silent, so it is tested both ways: a personal-code holder
  follows their transfer, and a team-code session whose dancer left the team
  loses its rooms exactly as item 6 already invalidates its cookie.
- **Imports and re-syncs are scoped too**, from the targets the diff actually
  touched — so a no-op re-sync, which happens repeatedly during setup, now
  wakes nobody.

Demonstrated in the browser at 375×812: an edit to another team left the phone
untouched (0 refetches), its own team's edit updated the time live, and after
stepping back through "Not you?" and re-identifying, a newly created
person-targeted block arrived without a reload.

**Residual:** the `roster:updated` broadcast still goes to everyone. A renamed
team or a reassigned contact card can change what several unrelated schedules
render and there is no block to derive an audience from — cheap to leave, since
roster edits are rare mid-event compared with schedule edits.

### 12. `[~]` Build the template importer

Read the known tabs of `templates/royalty-schedule-template.xlsx` — People,
Teams, Roster, the four day grids, Team Blocks, Airport — validate against the
checks the workbook already computes, and reject with row-level errors rather
than partial imports.

Not a column-mapping UI and not a general grid decoder; see the source-of-truth
decision. But the messy-input handling from the analysis still applies, because
Roster and People are pasted in from the same sources as last year: normalize
phone numbers to digits (four formats, including invisible Unicode direction
marks), trim trailing spaces on names, strip the `*` / `**` food-restriction
suffix from names, inherit meridiem from end time to start, and tiebreak
within-team name collisions — which are real people, not duplicates.

**Build the format-independent half first** — diff classification, apply, the
`ingest()` contract, validation reporting. Only the tab readers need a frozen
template.

**The tab readers landed in item 24**, because loading the real data turned out
to require them: `Export`, `People` and `Roster` are read by name, the People
tab's `Type` vocabulary maps onto roles, `First Name` + `Last Name` join, the
food-restriction mark comes off, phones normalize and invisible characters are
stripped.

**Name collisions closed 2026-08-13** — `rosterIdentity()` in
`server/sync/normalize.js`, an ambiguity refusal in `computeRosterDiff`, and 16
new tests (`tests/import-pipeline.test.js`, 619 total). Demonstrated through the
real routes on the real dev database, both halves.

```bash
npm test
```

- ⚠️ **The bug was silent and only appeared on the *second* import.** A person
  is keyed on name + display role, which is not unique — item 3 settled that
  `Ashka Patel` is two people sharing a name, and ~200 dancers is where that
  lives. `computeRosterDiff` held a `Map` of identity → person, keeping whichever
  row SQLite returned last: the first import created both people and looked
  right, and every re-sync after it wrote *both* sheet rows onto that one
  person. The other was never updated by any import again — corrected email, new
  team, captain promotion, all reported as applied and none of them landing, on
  somebody still on the roster holding a live access code. No error, no wrong
  count.
- **Both rows are refused, never first-wins.** "Keep the first" guesses which
  row is the real person, and the two rows differ in exactly the fields —
  `email`, `phone` — that decide whose phone gets whose link. Item 25's safety
  property is that a link goes to `people.email` and nowhere else; a coin flip
  puts the right link on the wrong address and looks correct doing it.
- **Checked twice, because it has two sources.** Two rows in one upload are
  caught by the sheet reader — per tab, then again across the whole upload,
  since a dancer who also holds a staff job gets typed onto People *and* Roster
  and no per-sheet pass can see that. A row matching two people **already in the
  database** is caught in the diff, because a database can already be in that
  state: the first import that hit this is what created the pair. Both land in
  the same `errors` list the preview already renders, so neither is discovered
  after Apply.
- ⚠️ **A refused row still counts as *seen*.** `seenPeople.add` sits above the
  ambiguity check, because both people behind an ambiguous name are named in the
  sheet — treating the refusal as "absent" would have `removeMissing` delete the
  pair, turning a row the importer declined to touch into two people removed
  from the event. There is a test.
- ⚠️ **A refused row contributes nothing, and `/code-review` is what found that
  it did.** The team and contact-card creation sat *above* the new refusal, so
  an ambiguous row still created a team with no members — which item 5's
  backfill mints a live access code for — and a card nothing points at. Worse,
  those made `hasChanges` true, which is what enables the Apply button.
- ⚠️ **The commit gate is "how many rows resolved to a person", never
  `hasChanges`.** `hasChanges` counts `deletePeople`, so under `removeMissing` a
  file whose every row was refused read as "changes to apply" and the changes
  were deletions: an upload naming only ambiguous people, with "treat this as
  the complete roster" ticked, would have pruned everybody it did not name.
  Same shape as item 24's schedule refusal — the test is that nothing
  importable came out, never that some rows failed. Both are pinned by tests
  that fail against the version this paragraph describes.
- **The refusal is not a dead end, which is the part worth checking.** It names
  both rows and asks for distinguishable names; renaming one in the panel makes
  the same file import cleanly onto the right person. Demonstrated. An ID column
  and a `people.source_key` migration were rejected — see
  [docs/decisions.md](docs/decisions.md) — because they buy the ability to keep
  two identical names on a roster, which is a thing worth not having.

⚠️ **Still open: meridiem inherited from the end time to the start.** That one
*is* blocked on content — it is a property of the wall-chart day grids, and the
template's `Export` tab emits calculated times rather than `"5:00 – 7:00 PM"`
text, so it cannot be built honestly until a filled-in workbook says whether it
still happens. It has a test today saying it is a known gap.
See [docs/loading-data.md](docs/loading-data.md).

### 13. `[x]` Apply model changes from item 3

- **`teams.show_order`** — 1–8, nullable until the draw.
- **`person_roles` join table** replacing single `people.role_id`.
  `resolveSession` pushes every role into `targets`; `blocksForTargets` already
  ORs an arbitrary list, so the query side is nearly free.
- Captains hold `Dancer` + `Captain`, assigned by the importer from the
  template's `Captain?` column. `Captain` is an ordinary `roles` row.

No divisions, no multi-team dancers, no second performance, no `is_captain`
boolean, and no fourth targeting mode.

**Done 2026-08-06** — `server/migrate.js`, `person_roles` in the schema, and 20
new tests (93 total). Demonstrated in the browser: a captain sees the two Friday
captain blocks, a teammate on the same team sees neither, and the running order
is editable with a working clash guard.

```bash
npm test
```

- **`people.role_id` is dropped, not kept alongside.** Two homes for the same
  fact diverge, and then nobody knows which one the schedule query used. A
  person's *display* role is derived — the role they hold with the lowest
  `sort_order` — which is why `Captain` sorts last: a captain reads as a
  "Dancer", which is what they are.
- **Migrations now exist** (`server/migrate.js`), run on every boot, idempotent.
  `schema.sql` only ever built fresh databases. Verified against a copy of the
  real 166-person dev database: all 166 kept their role, none orphaned.
  ⚠️ Anything depending on a migrated column belongs in `migrate.js`, not
  `schema.sql` — that file runs first, and the column may not exist yet.
- **The personal-code rule flipped to a negative form**: a code goes to someone
  holding *no* team-selector role, rather than someone holding a person-selector
  one. Under the old positive form a captain's `Captain` role would have earned
  them a personal code, which is the ~190 unmanaged dancer credentials the
  access-code decision exists to avoid.
- **An unidentified team session deliberately gets no Captain blocks.** Before
  the identity step there is no way to know whose phone it is, and showing the
  Captains' Meeting to all 25 dancers would have them all turn up to it.
- The roster importer reads a `Captain?` column, strictly (`Y`/`yes`/`true`/`1`).
  It **never infers from a name suffix** — the `*` on a roster name is a food
  restriction. Removing the mark demotes, so the column is authoritative both
  ways.

**Not built here:** surfacing the running order to participants ("you are 3rd,
after UTD"). The column, the admin editing and the API are done; what a dancer
or judge *sees* is schedule content, so it belongs with item 24.

### 14. `[x]` Fix the known correctness gaps

- ~~Concurrent admin edits are silently last-write-wins.~~
- ~~A dead magic link opened while already signed in silently keeps the old
  session instead of saying the link is revoked (found during item 8).~~
- ~~Deleting a person or team orphans their schedule blocks.~~
- ~~"Last updated" is global, so everyone sees a fresh timestamp when any team
  changes — mildly alarming and slightly dishonest.~~
- ~~Past-midnight blocks are handled in code but never tested.~~ Closed by item
  9 — they are resolved server-side now, with tests.
- ~~Placeholder seed blocks aren't in any import's managed set (there's a "clear
  placeholder blocks" action for this — confirm it's still correct after item 12).~~

**Done 2026-08-07** — `target_versions` and the `db.js` helpers around it, an
optimistic-concurrency guard on block edits, and 20 new tests
(`tests/correctness.test.js`, 144 total). All five demonstrated in the browser.

```bash
npm test
```

- **"Last updated" is now keyed on block targets** — the same `type:id` that
  names a socket room — so a session's timestamp is the newest of its own
  targets, not the event's. Demonstrated: another team's block moved and a
  dancer's timestamp did not budge; his own team's did, live. ⚠️ The trap is the
  fallback — it must stay a value writes never move. Falling back to the global
  timestamp (the first cut) means a target with no row reads as *freshly
  changed*, which is the original bug through the back door. It now falls back to
  `target_versions_epoch`, written once, so a gap reads as stale instead. There
  is a test that fails against the old fallback; don't relax it.
- **Concurrent edits are refused, not merged.** The editor sends the `updatedAt`
  it loaded; a mismatch is a 409 carrying the current block. Opt-in, so imports
  are unaffected — they reconcile against a file, not a screen someone read.
- **The bigger half of that was client-side.** Both editing panels were keyed on
  `refreshKey`, so *any* live event from another admin remounted them and
  silently discarded a half-typed block or roster row. `SchedulePanel` and
  `RosterPanel` now reload in place and keep the draft; the schedule one raises
  the conflict banner the moment the block moves underneath, before Save rather
  than after. Not on the list above — found while verifying, and it was the part
  an admin would actually have hit.
- **Deleting a person or team is refused with the count** until confirmed, then
  takes the blocks in the same transaction, one `deleteBlock` each so every
  removal is logged with an audience. Blocks go before the roster row, so the log
  can still name the person. A team takes only its own blocks — its dancers are
  unassigned, not deleted, so their airport pickups survive.
- **A dead magic link opened while signed in now says so** instead of rendering
  a working schedule and dropping the reason. Verified at 375×812: a revoked
  link on a signed-in phone shows the notice and leaves the session alone.
- **Placeholder blocks are confirmed unmanaged, and the invariant is pinned by a
  test.** An import owns exactly the rows carrying a `source_key`; seed blocks
  have none, so `removeMissing` cannot reach them — and neither can it reach
  manually added blocks, which is the same property and the more important one.
  If item 12 ever starts writing keyed seed rows, that test is what will say so.
  The clear action now routes through `deleteBlock` rather than one bulk DELETE.

**Residual:** the concurrency guard covers schedule blocks only. Roster rows
(people, teams, contacts) have no `updated_at` column and are still
last-write-wins; adding one is a migration, and two admins editing the same
person mid-event is far rarer than two editing the same block.

---

## Phase D — Admin tooling

Not polish. These are the difference between logistics using the app and routing
around it.

### 15. `[x]` Bulk time shift

"Everything after 3pm moves 20 minutes." Running late is *the* most common live
change; doing it block-by-block across 8 teams is unusable under pressure.

**Done 2026-08-07** — `server/lib/time-shift.js`, two routes on
`/api/admin/blocks/shift`, a Shift times card in `SchedulePanel`, and 28 new
tests (`tests/time-shift.test.js`, 172 total). Demonstrated against the seed
data: 18 blocks previewed from 3pm, one unticked, 17 moved, and a dancer's phone
showed her performance at 3:25 instead of 3:05 without a reload.

```bash
npm test
```

- **Preview then apply, and the apply takes explicit block ids** — not the day
  and cutoff again. Someone adding a block after the cutoff while you preview
  must not have it swept into a change nobody reviewed. Each id carries the
  `updatedAt` it was previewed at, which item 14's guard then enforces —
  required here rather than optional, since every caller is a screen someone
  read a list off.
- **All or nothing.** A stale version, a deleted block, or one that cannot move
  refuses the whole batch and writes nothing. Half a day 20 minutes from the
  other half looks exactly like a correct schedule, which is the failure mode
  this project exists to avoid; a refusal is strictly better.
- **The day key moves, the end time doesn't.** The start is shifted and carries
  the block to the adjacent event day if it crosses midnight; the end is shifted
  as a plain clock reading. `blockInstants` already means "end ≤ start" = "ran
  past midnight", so that relationship re-derives itself. ⚠️ Rolling the end
  forward as well would double-count it — there is a test for 23:30–03:45.
- **Adjacent by date, never by `sort_order`**, and a block with nowhere to land
  is named in the preview rather than guessed at. The ±12h cap is what
  guarantees at most one midnight is crossed.
- Every moved block keeps its own edit-log line and audience, under one summary
  line derived from what actually moved.

**Not built here:** shifting more than one day at once, and filtering by
location rather than by ticking rows. Both are speculative until someone has run
a real day through this.

### 16. `[x]` "View as" preview

See exactly what a given team or person sees. Essential for "I don't see my
warm-up."

**Done 2026-08-10** — `server/lib/view-as.js`, `GET /api/admin/view-as`,
`client/src/admin/ViewAsPanel.tsx`, and 19 new tests (`tests/view-as.test.js`,
217 total). Verified in the browser against the seed data and confirmed live
against a real signed-in viewer: identical 13 blocks, same subject, same
`updatedAt`.

```bash
npm test
```

- ⚠️ **The preview is the viewer's payload, returned unmodified** — same
  function, same argument shape, under a `schedule` key with the diagnostics
  beside it rather than mixed in. A preview that re-derived matching would be
  least reliable exactly when it is opened, because it would share the admin's
  assumptions rather than the phone's code. The central test signs a real viewer
  in with a real access code and asserts the two payloads are equal; keep it.
- **The diagnostics are the feature.** "I don't see my warm-up" has four
  answers needing four different fixes, so the panel shows the targets the query
  ORs over and how the person signs in. Demonstrated: a captain's view holds the
  three captain blocks and lists `role:All Captain` among her targets; her
  teammate's holds neither, and the missing target is the visible reason.
- **A team preview names the people behind the identity step.** The team view is
  real — it is what a captain sees while deciding which name to tap — and it
  holds no person-targeted or captain blocks at all (verified: 10 blocks, zero
  of either). That is the most common answer, so the members are one click away.
- **An unreachable subject is called out.** A dancer unassigned from a team by
  item 14's delete has a correct schedule and no way to open it; so does anyone
  whose code was never issued. Both read as unreachable rather than as empty.
- **No access code string in the response** — "is there a live code" is the
  diagnostic, but minting and showing links stays in the Access codes tab.
  There is a test asserting the code never appears.
- **Rejected: an impersonation mode** that issues the admin a real viewer
  session. Maximally faithful, but it puts a second code-redemption path next to
  the one item 6 locked down, and writes `last_used_at` on codes nobody used.

**Not built here:** previewing at a *time* ("what will she see at 3pm?"). The
timeline already takes an instant, so it is a small addition, but nobody has run
a real day through this yet — same reasoning as item 15's deferred filters.

### 17. `[x]` Undo / revert last change

The edit log records everything and can reverse nothing.

**Done 2026-08-10** — four columns on `edit_log` (in `server/migrate.js`),
`server/lib/undo.js`, three routes on `/api/admin/undo`, a rebuilt
`LogPanel.tsx`, and 19 new tests (`tests/undo.test.js` plus two in
`person-roles.test.js`, 236 total). Demonstrated in the browser against the real
dev database: an 18-block shift undone from the panel, every block back where it
started, and the refusal path appearing on its own.

```bash
npm test
```

- **The log now stores state, not just prose.** `before_json` is the block as it
  stood; `after_version` is the `updated_at` it ended up with — deliberately the
  same token item 14's guard uses. ⚠️ Parsing `change_summary` back into fields
  was the obvious shortcut and would have failed silently the first time anyone
  reworded a summary.
- ⚠️ **Undo works on a batch, never on a row**, and the batch id is stamped by a
  middleware on the admin router so that *one request is one batch*. That is
  what makes it safe: every write a request makes shares the id, including the
  irreversible ones. Deleting a person puts block-delete rows and a roster row
  in the same batch, and the roster row is what makes undo refuse. Threading the
  id per route would eventually miss one, and the miss would be silent —
  restoring blocks for a person who no longer exists.
- **All or nothing, checked before anything is written.** A block someone else
  edited since refuses the whole batch and names it. Tested both ways: after a
  refusal every other block is still where the shift left it.
- **Imports are excluded on purpose.** An import owns its rows through
  `source_key`, which `updateBlock` does not carry — a reverted import would
  keep the file's ownership, show the old contents, and be re-applied by the
  next poll. An undo that silently re-does itself is worse than no undo. Fix the
  sheet and re-sync instead.
- **The reversal goes through the ordinary mutations**, so it logs, broadcasts
  to the right rooms, and bumps `target_versions` for free — and is itself a
  batch, which is where redo comes from without a second mechanism.
- **Pre-existing log rows are honest about it**: they carry no prior state, so
  they read "No earlier version was recorded" rather than offering a button that
  would guess.

**Not built here:** undoing roster edits. People, teams and contacts still have
no `updated_at` to check a restore against — item 14's residual, unchanged.

### 18. `[x]` Event-wide announcements

Only if item 3 says you want them. Today "fire alarm, evacuate" means creating
six near-identical blocks.

**Decided 2026-08-10 — yes**, reversing the deferral in item 3's targeting
decision. **Done the same day** — a fourth `applies_to_type`, the CHECK widened
in `server/migrate.js`, and 20 new tests (`tests/announcements.test.js` plus one
in `broadcast.test.js` and one in `person-roles.test.js`, 256 total).
Demonstrated end to end on the real dev database: a fire-alarm block posted from
the panel reached a team code, a dancer and a staff member, rendered with an
"Everyone" badge on a judge's phone, and was then undone.

```bash
npm test
```

- **An announcement is a schedule block, not a new concept.** Making it a target
  means it arrives with everything already built — the right place in the day,
  the right socket rooms, the right "last updated", view-as, bulk shift, undo.
  A parallel announcements table would have meant redoing all of that, and
  forgetting several. `live.js` already claimed a fourth targeting mode would
  need no change there; it didn't.
- ⚠️ **One audience, enforced twice** — normalized in the mutations *and*
  constrained in the schema. A second sentinel would be a second socket room and
  a second `target_versions` key nobody reads: a block that looks posted and
  reaches nobody. The constraint is what survives a hand-run SQL fix at 2am.
- ⚠️ **`everyone` is a block target, never a session subject and never a code
  subject.** The three-way CHECKs on `access_codes` and the view-as route are
  unchanged on purpose, with tests holding the line — the natural drift is for a
  fourth target type to leak into three-way lists that mean something else.
- **It moves everyone's "last updated", and that is the one time that's
  honest.** Item 14 made the timestamp per-subject so one team's edit didn't
  alarm 280 people; an announcement really does affect all of them.
- **SQLite cannot widen a CHECK**, so `schedule_blocks` and `target_versions`
  are rebuilt — create, copy, drop, rename, re-index, guarded on the stored DDL
  so it runs once. Verified against the real 110-block database: 110 blocks, 172
  versions and all three indexes came through.
- The importer accepts `Everyone` / `All` / `Everybody` as an assignment,
  matched by exact word before anything else so a team named "Everyone" could
  never quietly win and send an evacuation notice to 25 people.

**Not built here:** a push notification, and any "unread" state. An announcement
lands in the schedule and on the socket like every other change; making a phone
buzz is the notification layer the edit log's `audience_json` was always meant
to feed, and it is not in this plan.

---

## Phase E — Testing

The draft had zero automated tests and was verified manually, once. It now has
539, run in CI on every push.

### 19. `[x]` Build the automated test suite

Priority order: import pipeline (time parsing across all accepted formats,
assignment resolution including ambiguous and prefixed cases, diff
classification) → now/next including timezone and midnight → access-code
authorization, negative cases explicit.

- **Claude Code:** *"Write tests against the anonymized fixtures and add a CI
  script."*
- **Done when:** CI runs green and the authorization negatives are covered.

Most of it was already done as a side effect of items 6–18; the import pipeline,
the fixtures and CI are what this item added. 335 tests in `tests/`:

- ✅ Access-code authorization, negatives explicit (`authorization.test.js`,
  `admin-codes.test.js`) — the done-when above is met on that clause.
- ✅ Timezone and midnight, including DST and past-midnight blocks
  (`event-time.test.js`).
- ✅ Schema migration against a populated legacy database
  (`person-roles.test.js`).
- ✅ Broadcast scoping, the socket origin policy, and the import path's
  audience (`broadcast.test.js`).
- ✅ The item 14 correctness gaps — edit conflicts, orphaned blocks, per-subject
  timestamps, and the placeholder blocks' exclusion from the managed set
  (`correctness.test.js`).
- ✅ The bulk time shift, including the midnight arithmetic and every way the
  batch refuses (`time-shift.test.js`).
- ✅ The offline shell, run as the real generated worker inside a fake
  `ServiceWorkerGlobalScope` (`service-worker.test.js`).
- ✅ "View as" fidelity, asserted against a real code-authenticated viewer
  session rather than against expectations (`view-as.test.js`).
- ✅ Undo, weighted towards what it refuses — a batch edited since, a roster
  delete, an import, a legacy row (`undo.test.js`).
- ✅ The announcement target, including the two CHECK rebuilds against a
  pre-item-18 database (`announcements.test.js`, `person-roles.test.js`).
- ✅ **Import pipeline** — time parsing across the accepted formats, assignment
  resolution, diff classification (`import-pipeline.test.js`).
- ✅ **CI** — `.github/workflows/ci.yml`, and `npm run ci` locally. ⚠️ Green on
  the matrix only from 2026-08-10: the first push after this item was written
  failed the Node 20 leg, because `node --test` did not expand globs until Node
  21 and the script's pattern was quoted. Passing locally on a newer Node is not
  evidence about the floor in `engines`; only a run is.

  ⚠️ **The red run was the good outcome, and it took until item 20 to arrive.**
  A quoted `tests/**/*.test.js` that matches nothing is not an error on every
  Node — before there were enough tests for the difference to show, the Node 20
  leg found zero files, exited 0, and reported green while running nothing. A
  test suite that is not executed and a test suite that passes are the same
  colour on the matrix. If the row count on a leg ever drops rather than the
  colour changing, this is the shape to suspect first.

  ⚠️ **Made recursive 2026-08-13, by moving the floor to Node 22.** `ec195cd`'s
  `node --test tests/*.test.js` was shell-expanded and one level deep, so a
  `tests/sync/foo.test.js` would have been skipped in silence — the original bug
  with a smaller blast radius. It is now the quoted `"tests/**/*.test.js"`,
  `engines` is `>=22`, and the matrix is `['22']` — the version the Dockerfile
  deploys. The floor had to move because **no single `node --test` argument is
  both recursive and correct on 20 and 22+**, and the two ends fail in opposite
  directions. Measured against a fixture with one flat and one nested file:

  | argument | Node 20 | Node 22 / 24 |
  | --- | --- | --- |
  | `tests` | both — it recurses | nothing: resolves `tests` as a *module* |
  | `"tests/**/*.test.js"` | nothing: no glob support before 21 | both — it recurses |
  | `tests/*.test.js` | flat only | flat only |

  ⚠️ The quotes are load-bearing — they hand the pattern to Node rather than to
  the shell. Bash ships with `globstar` **off**, so an *unquoted*
  `tests/**/*.test.js` degrades to `tests/*/*.test.js` and matches nothing at
  all in a flat `tests/`. It looks like the obvious form and is the worst one.

  ⚠️ **Accepted cost: the empty-suite hole is open again, and silent.**
  `node --test` with a glob matching nothing reports `tests 0, pass 0, fail 0`
  and **exits 0** on 22 and 24 — Node 20 at least failed loudly there. That is
  precisely the original failure, so what stands in its place is weaker and
  worth naming: one flat test directory, a count printed by CI, and the habit of
  reading the count rather than the tick. **If the number falls toward zero
  rather than the colour changing, this is why.**
- ✅ The `fixtures/` from item 4 now run through the real pipeline
  (`fixtures.test.js`) — which needed the fixtures repaired first; see below.

**Done 2026-08-10** — 79 new tests (`import-pipeline.test.js`,
`fixtures.test.js`), a CI workflow, and two fixes the tests surfaced. 335 total.

```bash
npm run ci     # the client typecheck and build, then the tests
```

- **The weight is on what the pipeline refuses**, not on the happy path. The
  thing that will actually happen on the day is somebody uploading the wrong
  workbook, so the fixture tests upload last year's real spreadsheets and assert
  the schedule does not move: every row fails, `removeMissing` therefore sees
  every managed block as missing, and the "every row failed validation" refusal
  is the only thing between that and an empty schedule at 1pm Saturday.
- ⚠️ **`sourceKey` excludes time and location**, so a block that moved is an
  update and not a delete plus a create — which is what keeps the edit log
  readable and undo meaningful. It *includes* day, target and activity, so a
  renamed activity is a new block unless the sheet gives the row an `ID`. Both
  halves are pinned by a test; the second is the one that will surprise someone.
- **Blocks with no `source_key` stay invisible to the diff**, deletes included.
  Item 14 pinned that for seed rows; this adds the case that matters more, a
  block an admin typed by hand mid-event.
- **Ambiguity is asserted as a refusal.** Two people share a name in the real
  roster and a team can be called the same thing as a role, so `Sam Shared` and
  `Judge` are errors naming the prefixes that would settle them — never a guess
  at whichever row came first.
- **Time parsing covers all ten accepted spellings plus midnight and noon**,
  the two the 12-hour clock gets wrong, and 03:45 because that was a real call
  time. ⚠️ A meridiem-less cell is taken literally: the fixtures write the
  meridiem on the end time only, and inheriting it is a row-level job that
  belongs to item 12. There is a test saying so, so it is a known gap rather
  than a surprise.
- **Fixed while testing:** a workbook exceljs cannot open reached the admin as a
  raw `TypeError: Cannot read properties of undefined`. It is now a message
  saying to re-save the file. The routes already caught it, so this was never a
  500 — it was unactionable text on the one screen where the next step matters.

**Also fixed — three of the four fixtures could not be opened at all**, which
is what testing against them turned up first. The originals in `samples/` parse
and the anonymized copies did not, so it was `scripts/anonymize_samples.py` and
never the importer: **openpyxl saves a workbook Excel opens happily and exceljs
cannot open**, because it writes absolute relationship targets
(`/xl/tables/table1.xml` where Excel writes `../tables/table1.xml`) and puts
comments at `xl/comments/comment1.xml` where exceljs looks for
`xl/comments1.xml`. exceljs dereferences the part it looked for without
checking, so it surfaced as a `TypeError` from inside a spreadsheet library.

`repack()` now rewrites each saved workbook into the layout Excel writes —
same parts, same bytes inside them, same order, so the structure checks in
`verify_fixtures.py` still mean what they meant. All four now open, and the row
counts match the originals exactly (0 / 4 / 13 / 25). Two smaller defects in the
same script went with it: it `rmtree`d `fixtures/` before writing, taking the
committed `fixtures/README.md` every time anyone regenerated, and its output was
not byte-stable despite the fixed seed — openpyxl stamps every zip entry and
`dcterms:modified` with the wall clock as it saves. Regenerating twice now
produces identical bytes.

⚠️ **The Python gate cannot catch this class of bug**, and passed throughout.
It is the JS reader that objects, so `tests/fixtures.test.js` is where the
regression guard lives — it fails with "regenerate with
scripts/anonymize_samples.py" if a fixture stops opening. Run both gates after
touching the anonymizer; `fixtures/README.md` says so.

**Also not fixed:** the roster reader accepts a role by label or id but not by
plural (`Judges` in a Role column is refused), while the assignment column
accepts all three. Asymmetric, but it fails loudly with the value that failed,
and the roster reader's messy-input handling belongs to item 12.

### 20. `[x]` Load test at 2–3× real scale

600 connections, a burst of admin edits, a mass reconnect. (Raised from 400:
last year was ~260 people, not the ~170 originally assumed.)

- **Claude Code:** *"Write a load-test script and report the numbers."* Numbers,
  not reassurance.
- **Done when:** you know the response-time ceiling and have fixed whatever it
  surfaced.

**Done 2026-08-10** — `scripts/load-test.js`, `scripts/load-fixture.js`, and
three hot-path fixes. Full numbers in [docs/load-test.md](docs/load-test.md).

```bash
npm run load-test              # 600 clients, six scenarios, ~90s
```

600 virtual phones against a 280-person roster, each doing what a phone does:
redeem a code, pick a name at the identity step, hold a socket, refetch with no
debounce. **Zero errors in every scenario, twice.**

- **The ceiling is one number: ~105µs of server CPU per personalized schedule.**
  better-sqlite3 is synchronous, so a fan-out is that figure times the fleet — a
  queue, not a cliff, and linear out to 1000 clients. The worst case the product
  can produce is an announcement, which reaches every session by construction:
  **~140 ms** from the admin's save to the last of 600 phones holding fresh data.
  Peak RSS 210 MB; 3.3 CPU-seconds for the whole run.
- ⚠️ **The test paid for itself before it measured anything.** Profiling the path
  it exercised took `getPersonalizedSchedule` from **388µs to 105µs** — memoized
  instants (an `Intl` pass per block time, on every request), a cached
  zone-abbreviation formatter, and cached prepared statements for the two
  queries whose SQL varies only by target count. That is the difference between
  a 288 ms and a 139 ms fan-out. Three tests cover the instant cache's two
  silent failure modes.
- **Item 11's scoping holds under load, and is worth what it cost:** one team's
  edit woke **66 of 600** clients — exactly that team's — and settled in 26 ms.
  The other 534 received no bytes at all. Every row of that table would read
  like the announcement row without it.
- **Keep-alive was the one real defect.** Node's 5-second default closed idle
  connections in the gap between refetches, resetting roughly one per thousand —
  which the viewer cannot distinguish from being offline, so it showed
  "Offline · last known" on a phone with full signal. Now 65 s, tunable with
  `KEEP_ALIVE_TIMEOUT_MS`; set it below the proxy's idle timeout at deploy.
- **A roster edit is the slowest admin action at ~60 ms**, because it re-derives
  all 600 sockets' rooms inside the request. Measured, recorded, and left
  synchronous on purpose — see `docs/decisions.md`.

**Not covered:** real network, TLS, a proxy, or mobile radios — venue wifi will
dominate every number here, and that is items 21 and 26. Nor a day-long soak.

### 21. `[~]` Device matrix and accessibility pass

Real iOS Safari and Android hardware — the in-app browser is not a substitute.
Check safe-area insets, `tel:`/`sms:` actually dialling, socket survival across
lock/wake, and battery drain over a full day. Plus contrast, focus order, and
screen reader labels.

- Claude can do the accessibility audit and responsive checks; physical device
  and battery testing is yours.

**Accessibility and responsive half done 2026-08-11** — the palette, the
semantics and the ARIA, plus 15 tests (`tests/accessibility.test.js`, 353
total). **The hardware half is open**, as a dated checklist in
[docs/device-matrix.md](docs/device-matrix.md) with the full audit beside it.

```bash
npm test
```

- **The palette was measured, and three things were failing.** `--text-faint`
  is used at 11–13px and sat at 3.6–4.3:1 — under AA on every surface it lands
  on. Control boundaries were `--line` at **1.4:1**, so the code-entry field,
  which paints the page colour, was distinguishable from the page by nothing at
  all. And there was no app-wide focus ring: `.input` referenced
  `var(--accent)`, ⚠️ **a custom property that was never declared anywhere**, so
  it had been painting a violet outside the palette for as long as nobody
  looked. There is now a test that fails on any `var()` with no declaration and
  no fallback.
- ⚠️ **A finished block is no longer faded with `opacity`, and cannot go back
  to it** — there is a test. Element opacity fades the text and the card it is
  measured against *together*, so no colour choice rescues the ratio: a sweep
  put the end time at 1.7:1 at `.45` and still under AA at `.8`. A past block
  is content people scroll back to, not inactive chrome, so the WCAG exemption
  does not cover it. It recedes by dropping its raised fill instead.
- **The schedule screen had no headings at all** — every one was a `div`, so
  there was nothing to navigate by and no `<main>`. It now reads `banner → h1
  subject → main → h2 now/next → h2 full schedule → tabpanel → list of blocks →
  h2 contact`, and the blocks are a real list rather than an unbroken run of
  text with no boundaries in it.
- ⚠️ **Four tab strips promised a keyboard pattern none of them implemented**,
  which is worse than plain buttons: the role tells a screen reader that arrow
  keys move between tabs, and they did nothing. Two of the four put
  `aria-selected` on a plain button, which is not valid ARIA at all. All four
  now come from one implementation (`client/src/tabstrip.ts`) — don't add a
  fifth by hand.
- **Live changes are announced.** The offline and "your schedule just changed"
  banners are `role="status"`, so a change that arrives while nobody is looking
  reaches someone listening. And focus follows the screen: signing in, picking
  a name and stepping back all move it to the new heading, rather than dropping
  it on `<body>` where the next Tab restarts at the address bar.
- **`env(safe-area-inset-left/right)` was never used**, though
  `viewport-fit=cover` is set — which is precisely the pair that clips text
  under the notch in landscape. Now on all four gutters. ⚠️ Untestable here:
  the insets resolve to `0px` in every desktop browser, so this fix is
  unexercised until it runs on a notched phone. It is the first item on the
  hardware checklist.

**Still open — hardware only.** Safe-area insets on a real notch, `tel:`/`sms:`
reaching a dialler, socket survival across lock/wake at 5 minutes and 2 hours,
battery over a full day, VoiceOver and TalkBack, and one open question:
`overscroll-behavior-y: contain` on `body` **disables pull-to-refresh on
Android Chrome**, which contradicts item 10's premise that refreshing is what
people do when a screen looks stale. The one-word fix is written down; it was
not guessed at without a device.

**Deliberately not done:** converting the stylesheet from `px` to `rem`. Browser
zoom works, so this is not a 1.4.4 failure, but the OS text-size setting does
not scale the app on Android. A wide, risky change to make before a freeze —
after the retro, not now.

---

## Phase F — Deployment and operations

### 22. `[x]` Deploy properly

Persistent disk (SQLite needs one), HTTPS, process supervisor, no idle sleeping.
Set `ADMIN_PASSWORD` and pin `SESSION_SECRET`.

**Done 2026-08-11** — `Dockerfile`, `fly.toml`, `server/lib/deploy-config.js`,
`scripts/preflight.js`, graceful shutdown in `server/index.js`, and 32 new tests
(`tests/deploy-config.test.js`, 385 total). Runbook in
[docs/deploy.md](docs/deploy.md).

```bash
npm run preflight                          # check this environment
fly ssh console -C "npm run preflight"      # check the one that matters
```

⚠️ **Nothing is deployed yet.** Everything here is the configuration and the
guardrails; the `fly launch` / `fly deploy` sequence needs an account and is
six commands in the runbook. The item is done in the sense that deploying is
now a checklist rather than a design problem — see "still open" below.

- ⚠️ **One machine, and that is correctness, not cost.** A Fly volume attaches
  to a single machine, so a second machine is not more capacity — it is a
  second, empty database behind the same hostname. Half the venue would get the
  evacuation notice, both machines would pass their health checks, and both
  edit logs would be internally consistent. `fly scale count 2` is the command
  that breaks the event. There is no config that makes it safe; the fix would
  be Postgres, which `docs/decisions.md` declined for good reasons.
- **The boot gate refuses four things and warns about six.** Each of the four
  produces a server that passes its own health check: the default admin
  password, an unpinned `SESSION_SECRET`, a database inside the image, and a
  missing client build — that last one answers 200 with the "API is running"
  placeholder, so an uptime monitor stays green while every phone shows
  nothing. ⚠️ The severity split is deliberate: a 2am restart must not be
  blocked by a missing hostname, so `preflight` is the strict one and the boot
  gate is narrow. Add new checks at `warn`.
- ⚠️ **`SESSION_SECRET` is required because the fallback lives in the
  database** — the file item 23 copies off-box every few minutes. Pinning it in
  the environment keeps a live signing key out of every backup, and stops a
  rebuilt volume from signing all ~280 phones out. `auth.js` now writes nothing
  to the database when the env var is set.
- **Found and fixed: the re-sync cache was written to the source tree.**
  `sources.js` kept the last uploaded workbook at `__dirname/../../data`, which
  in development is the same folder as the database and on the machine is not —
  it is inside the directory every deploy replaces. Upload, re-sync, deploy,
  and Force Re-sync becomes "No spreadsheet has been uploaded yet" with the
  file gone. Persistent paths now derive from `dataDir` in `db.js`; there is a
  test, and it is the sort of bug that has no local symptom at all.
- **SIGTERM is handled**, which is what makes a deploy take seconds. Node
  installs no default handler at PID 1, so without one the signal is *ignored*,
  every deploy waits out the kill timeout, and the process is SIGKILLed with
  the WAL unflushed. It now closes sockets cleanly and checkpoints the
  database — which is also what makes an item 23 snapshot of a stopped machine
  coherent.
- **Keep-alive is set above the proxy's idle timeout** (65s against Fly's 60s)
  so the proxy is always the side that closes. Item 20 found the reverse
  showing "Offline · last known" on a phone with full signal. ⚠️ Verify against
  the platform's current figure at deploy — it is a default, not a contract,
  and the failure looks like bad wifi rather than like config.

**Still open:** no custom domain, and the deploy itself has not been run.
Backups, monitoring and alerting landed in item 23 the same day. Docker was not available
in this session, so the image is unbuilt and untested — expect the first
`fly deploy` to be where a Dockerfile problem surfaces, not a working tree
problem.

### 23. `[x]` Backups, monitoring, alerting

Automated off-box DB snapshots every few minutes during the event. Uptime
monitor on `/api/health` with SMS to whoever is on call. Error tracking — you
will not be reading server logs during a competition.

**Done 2026-08-11** — `server/lib/backup.js`, `server/lib/ops.js`,
`server/routes/admin-ops.js`, an Ops tab, `scripts/backup.js`,
`scripts/restore.js`, and 56 new tests (`tests/backup.test.js`,
`tests/ops.test.js`, plus five in `deploy-config.test.js`, 441 total). Runbook
in [docs/ops.md](docs/ops.md).

```bash
npm run backup                 # a verified snapshot now, shipped off-box
npm run restore                # what is available; --yes replaces the database
```

Verified against a running server with snapshots on a 15-second interval: 
copies appearing and landing at an off-box target, the heartbeat acknowledged 
every 15s, a test alert arriving at a webhook receiver from the panel's button, 
and a snapshot restored over a wounded database (43 blocks → 110) with the old 
file set aside.

- ⚠️ **A backup nobody has opened is a guess**, and the failure mode is not a
  crash: an empty SQLite file is *structurally valid*, passes `integrity_check`,
  and restores to an event with nobody in it. So every snapshot is re-opened and
  its row counts compared against the live database before it is kept, and one
  that fails is **deleted rather than kept** — a file in that directory reads as
  a backup to everything downstream, so a bad one is worse than none because it
  makes the count go up. There is a test that builds exactly that empty-but-valid
  file.
- ⚠️ **The SMS is the heartbeat, and it has to be.** Nothing running inside this
  process can report that this process has stopped — a wedged event loop, a full
  disk or a killed machine takes every check that lives in here with it. So
  `HEARTBEAT_URL` pings an external dead-man's switch and *that* service pages
  someone when the pings stop. The in-process webhook covers the smaller class of
  problem the server is still healthy enough to describe, and a failed alert
  delivery is recorded and never re-alerted: announcing a broken alert channel
  through the alert channel is a loop.
- **`/api/health` now answers 503 when phones are not being served**, which
  closes the gap item 22 found: a deploy with no client bundle answers 200 with
  the "API is running" placeholder, so the monitor and the platform health check
  both stayed green while the venue saw nothing. It stays narrow on purpose —
  stale backups are reported there and never fail it, because a monitor that
  pages for a degraded-but-working condition gets ignored, and takes the real
  page with it. Still one indexed row on the happy path; item 20 uses it as a
  latency probe.
- **Two off-box mechanisms, not one integration.** `BACKUP_TARGET_URL` (HTTP)
  and `BACKUP_TARGET_CMD` (`aws s3 cp {file} …`, rclone, scp). Where the backups
  go depends on what the event has an account for, and that should not be
  re-litigated at T-2 days. A shipping failure never fails the run: the local
  copy is already verified.
- **Retention is bounded by bytes as well as count**, because the volume also
  holds the database and filling it takes the event down in the most confusing
  way available — writes start failing while every health check still passes.
  Locally that is a few hours of history; the off-box target is what holds the
  whole event, since nothing here prunes it.
- **Two bugs the browser found that review had not.** Verifying a copy leaves
  `-shm`/`-wal` files named after the *temporary* file, so after the rename they
  were orphans that no longer matched the snapshot pattern — invisible to the
  listing and therefore never pruned. And staleness was measured from the newest
  file's mtime, so a run that found the database unchanged and discarded the
  duplicate made a perfectly backed-up idle event report "no verified snapshot
  recently" — a page at 3am about nothing. Both now have tests.
- **The restore script is the deliverable, not the snapshots.** It verifies
  before touching anything, sets the current database aside rather than
  overwriting it, and moves the WAL and SHM out of the way — a stale `-wal` next
  to a restored file is how a restore appears to work and then serves a mixture
  of both. ⚠️ It cannot detect a running server, so stopping first is stated in
  the runbook rather than enforced.

**Still open:** the restore drill itself belongs to item 26 — the round trip is
tested, the full stop-restore-start sequence on a real machine is not. Nothing
checks that shipped copies are readable at the far end (the panel reports the
request was accepted). And no metrics on the machine; `fly status` and item 20's
measurements are the substitute.

---

## Phase G — Event readiness

### 24. `[~]` Load the real roster and schedule

By now this should be a data task, not an engineering one — but a bigger one
than that sounds. Pin the real dates and confirm the venue timezone here. And
note the analysis finding: **dancer schedules do not exist as data anywhere**.
They were scattered across six logistics tabs last year and have to be authored
into the template. Budget that as content work, with a named owner.

**It was not a data task.** The template landed in `templates/` and the app
could not read a single row of it. Started 2026-08-11 — the path from the
workbook into the database is built, tested and demonstrated end to end; what
remains is content and the dates, both of which need people rather than code.
47 new tests (`tests/template.test.js`, 488 total). Runbook:
[docs/loading-data.md](docs/loading-data.md).

```bash
npm run days                          # the four event days
npm run days -- --friday 2027-02-12   # pin the whole weekend from one date
```

- ⚠️ **The importer read the first sheet, and the first sheet is Instructions.**
  Against the real workbook that is 158 rows of prose, every one of which fails
  validation — indistinguishable from having uploaded the wrong file, so the
  diagnosis on the day would have been to go looking for a different one. The
  reader now names the tabs it wants (`Export`, `People`, `Roster`) and falls
  back to the first sheet, so the CSV template and last year's spreadsheets read
  exactly as they did.
- ⚠️ **Found and fixed: an import that yielded nothing was applied.** The guard
  was `errors.length && rows.length === 0`, and the two conditions differ by one
  real case — `Export` is entirely formulas, so a copy saved by anything that
  does not calculate them reads as a few note rows and *no errors at all*. That
  file was then applied: an empty row set against `removeMissing` is every
  managed block deleted, silently, behind a green result. It is now refused on
  "nothing importable came out", and the refusal shows on the preview so Apply
  is not what discovers it.
- **The roster is two tabs, and they are shaped differently.** People carries
  `Full Name` and a `Type`; Roster splits the name in two and is dancers
  throughout. One upload reads both, and an error names its tab — they both have
  a row 2. A default role belongs to a *sheet*, never to a row: the Roster tab
  is dancers because the tab says so, and a People row with no `Type` is
  unfinished and stays an error.
- **Liaison and RAS Rep are now roles**, added idempotently on boot rather than
  by the seed, because liaisons are most of last year's master schedule and
  refusing all of them is a stop at the worst possible moment. Roles stay data:
  the alias table maps the event's spellings onto ids and defines nothing.
- **The event is four days, and was two.** Teams land Thursday and fly out
  Sunday, and a block whose day has no `event_days` row is refused per row — so
  every arrival and departure was being dropped and counted as a skipped row.
  Thursday and Sunday are derived for existing databases, and only when the
  Friday and Saturday there are genuinely adjacent.
- ⚠️ **The Airport tab reaches nothing.** `Export` pulls from Sequences, Slot
  Times, Windows and Manual Blocks and no fourth place, so flight numbers and
  pickup times typed on the Airport tab produce a tab that looks complete and
  schedules with no airport runs in them. Same for the four day grids. Written
  down in `docs/loading-data.md`, which is the file for whoever loads the data.
- **Also fixed:** `GOOGLE_SHEET_RANGE` defaulted to `Schedule!A:I`, a tab no
  version of this workbook has ever had.
- **The template is committed**, which closes "it exists on one laptop", and
  `tests/template.test.js` now reads it: the tabs and columns the importer looks
  for are a contract, so the day logistics renames one is a red build rather
  than a discovery at the dress rehearsal.

**Demonstrated, not just implemented.** A template-shaped workbook loaded
through the real routes on the real dev database: both roster tabs in one
upload, 9 of 11 rows with the two failures naming their tab; `board` → Exec
Board, `liaison` → Liaison, `RAS Rep` → RAS Rep; `Devin Osei**` imported as
`Devin Osei` and *not* as a captain; four phone spellings normalized to one.
Then the Export tab — 10 rows read, 2 note rows ignored, 2 genuine errors
reported, 6 blocks applied. A captain from the Roster tab then opened her team's
link at 375×812 and saw all four targeting modes at once: her team's Thursday
airport pickup, her team's Saturday rehearsal, the `Role: Dancer` lunch window
and the `everyone` doors-open announcement.

**Still open — content and dates, both of which need people:**

- **The real dates.** The workbook still says 2026-08-07, which is a placeholder
  and is now in the past. `npm run days` is the mechanism; the number is the
  event director's.
- **The roster itself.** 6 example rows on People against ~80 staff, 1 on Roster
  against ~200 dancers. The likeliest thing to slip past the rehearsal, and it
  is a people problem.
- **Thursday, Friday and Sunday are nearly empty.** They are almost entirely
  Manual Blocks, which has one example row. Saturday is built, because the
  pipelines build it.
- The gap list, with an owner column, is the second half of
  [docs/loading-data.md](docs/loading-data.md).

### 25. `[~]` Generate and distribute access links

Team links to captains, individual links to staff. Send early enough that
lost-link requests arrive before Friday rather than during.

**Done 2026-08-12, except the sending itself** — `server/lib/distribution.js`,
a `Send To` column on the export, a Ready to send card, `npm run codes --
--send-list`, and 19 new tests (`tests/distribution.test.js` plus five in
`admin-codes.test.js`, 507 total). Runbook:
[docs/distributing-links.md](docs/distributing-links.md).

```bash
npm run codes -- --check       # coverage AND reachability; exits 1 on either
npm run codes -- --send-list   # every message that would go out, and to where
```

- ⚠️ **Found and fixed first: item 24 had made every imported person their own
  coordinator.** The roster reader built a contact card out of the People tab's
  `Phone`/`Email` columns, so 280 cards duplicated the roster and every dancer
  was shown *their own phone number* under "Your contact". Nothing errored.
  Those columns are now `people.email` / `people.phone` — their own details —
  and `contact_id` still means the card they should call. Verified on a phone:
  a captain now sees "Lee Marchetti · Team Liaison" where she saw her own name.
- **A team's liaison card is derived, not typed twice.** The People tab already
  requires a `liaison` row to name its team, so each team's card comes from that
  person. Only fills a team whose card is unset — one chosen in the panel is a
  decision about who to put in front of 25 dancers, and a re-sync must not
  quietly overwrite it.
- ⚠️ **`Send To` is `people.email` and nothing else.** This is the whole safety
  property. `contact_id` is shared — every dancer on a team points at that
  team's liaison — so a send list built from it mails a dozen private bearer
  tokens to one inbox and looks entirely correct on the way past. It is why item
  8 shipped with no address column at all; `docs/decisions.md` named the
  condition for revisiting and item 24 met it. There is a test that mails
  nothing to a shared card.
- **A team link goes to its captains, and a team whose captains are unreachable
  is refused rather than redirected.** Every fallback — the liaison, the event
  director, any dancer with an address — is plausible and every one hands a
  team's credential to somebody who was not chosen to hold it. A named gap
  somebody fixes in the spreadsheet is strictly better.
- **Blocked rows stay in the export**, with the reason in its own column. A file
  with the unsendable rows removed looks finished, and the deadline here is
  "before Friday" — the list is meant to be worked through.
- **A phone with no email is sendable.** Some of the ~80 staff are a mobile
  number and nothing else; requiring email would drop exactly those people.
- `--check` now fails on reachability as well as coverage, so the pre-event gate
  is one command. A fresh seed reports 45 of 45 links sendable across 61
  messages; the seed gives everyone an address so the placeholder data exercises
  this rather than reporting every subject unreachable.

**Demonstrated:** the template-shaped workbook imported through the real routes
created **zero** contact cards where it previously created nine, put each
person's address on them, derived both teams' liaison cards, and produced a CSV
in which UNC's team link is addressed to Priya Raman (captain) and not to Devin
Osei (dancer) or Lee Marchetti (liaison) — while Illini Raas is a blocked row
naming the captain who has no address.

**Still open: the sending.** Nothing here mails anything, on purpose — an event
has a mailing tool and a half-built sender is one more thing to be on call for.
And the file is only as good as the roster in it, so this waits on item 24's
content half like everything else.

### 26. `[~]` Full dress rehearsal — T-1 week

Real data, 10–15 people on their own phones, in the venue if possible. Make live
changes and confirm every phone updates. Then deliberately break things: kill
the server, kill the wifi, revoke a code, delete a team. This is where you find
what this plan missed.

**The rehearsal itself needs people, phones and real data. What was missing was
everything that makes it runnable and its result believable** — built and
demonstrated 2026-08-13: `server/lib/readiness.js`, `server/lib/presence.js`,
`scripts/rehearsal.js`, two admin routes, two Ops cards, and 23 new tests
(`tests/rehearsal.test.js`, 562 total). The script is
[docs/dress-rehearsal.md](docs/dress-rehearsal.md).

```bash
npm run rehearsal              # can the rehearsal answer its own question?
npm run rehearsal -- --check   # quiet; exits 1 on a blocker
```

- ⚠️ **A green rehearsal against the placeholder is indistinguishable from a
  green one against the weekend**, and that is the failure this item was most
  likely to end in. Dates that have already happened, six example roster rows
  and two entirely empty days all render as a perfectly ordinary schedule, and
  every one of the other 539 tests passes against them. So the gate asks the
  three questions nothing else does — are the dates real and still ahead of us,
  did the schedule come from an import or from the seed, does every day of the
  weekend have anything on it — and refuses by name rather than passing quietly.
- **The dates check is the one this project has needed since item 9.** Nothing
  anywhere asked whether the event had already happened; the placeholder went
  into the past on 2026-08-11 and no screen, script or test said a word. It is
  compared against *the venue's* today, refuses a date that is not the weekday
  it claims to be, and refuses a non-contiguous weekend — the two `npm run days`
  will not write but a hand-run SQL fix at 2am would.
- ⚠️ **Everything else it reports it composes rather than re-implements** —
  `preflight`, `codes --check`, `callsheets --check`, the snapshot verifier.
  Four readiness checks that agree with each other and disagree with the code
  they describe is worse than having none, because the point is to be believed
  on the morning of the rehearsal.
- ⚠️ **"Did every phone get that?" is now a number.** With fifteen people in a
  room the only way to answer it was to ask them, and a phone quietly holding a
  twenty-minute-old time answers *yes* — its owner cannot tell either. Each
  viewer now reports the `updatedAt` it is rendering, compared server-side
  against `versionForTargets` for **that socket's own targets**. A comparison
  against the global timestamp would mark all fifteen behind the moment any one
  team changed; there is a test that fails against exactly that.
- **Three states, not two.** A phone that has never reported is *silent* —
  calling it up to date is the comfortable lie, calling it behind would flag
  every phone for the second between connecting and its first fetch.
- ⚠️ **The panel is a panel even when it resolves to a viewer.** Found by
  opening both, which is the only configuration this is ever used in: cookies
  are per browser, so the rehearsal driver's `/admin` socket carries their
  viewer cookie and was listed as a phone that never updates — a permanently
  red row belonging to somebody standing in the room.
- **The restore drill has been run, not just written.** Snapshot → destroy →
  dry run → restore → restart → magic link, timed: 0.18s, 0.11s, verify 4ms on
  the 166-person dev database. The clock that matters is none of those; it is
  deciding to do it and stopping the server, which is minutes and belongs to one
  named person. Re-time on the machine once there is one — `docs/ops.md`'s "no
  automated restore drill" is now "not yet run on the machine".

**Demonstrated, not just implemented.** Four phones on three teams plus a staff
member, against the real dev database through the real routes: an edit to
Momentum moved that phone to the new version and left the other three reading
*up to date* on the old one — which is the per-subject property, visible.
Freezing one phone's process and editing its team put exactly one row into
*behind* and moved nothing else; resuming it went green on its own.

**Still open — the rehearsal, which is people:** ten to fifteen of them, their
own phones, the venue, and real data in the database. Everything above only
makes it possible to run and to believe.

### 27. `[x]` Freeze on the Wednesday before

Tag the release. No changes after except genuine emergencies.

**Done 2026-08-13** — `server/lib/release.js`, `server/lib/freeze.js`,
`scripts/freeze.js`, a `release-identity` deploy check, a Release card on the
Ops tab, four build args in the Dockerfile, and 40 new tests
(`tests/freeze.test.js`, 602 total). The runbook, including what counts as an
emergency, is [docs/freeze.md](docs/freeze.md).

```bash
npm run freeze                 # can this be frozen, and what is frozen now?
npm run freeze -- --tag        # the gate, then the annotated tag
npm run freeze -- --check --no-verify --url https://<host>   # is the machine holding it?
```

- ⚠️ **A tag nobody can check is a note in a calendar.** The freeze is a promise
  about what will be running on the Saturday, and verifying it is a comparison
  across two sides that each hold half the answer: this repository knows the tag,
  and the machine knows what was built into it. Nothing in this project could
  answer the second half before — the server had no idea what it was, and neither
  did `/api/health`.
- ⚠️ **The identity has to be baked in at build time, and that is not a
  preference.** `.git/` is in `.dockerignore` on purpose, because an image gets
  pushed to a registry — so there is no repository inside the container and
  `git describe` on the machine cannot work *by construction*. This is the
  `__dirname`-versus-`dataDir` bug from item 22 in another costume: runtime
  derivation is flawless on the laptop, where the two are the same thing, and
  silent on the one machine the answer matters on. Four `--build-arg`s are the
  whole channel, `npm run freeze` prints them filled in, and a plain `fly deploy`
  is a `warn` rather than a failure — an unlabelled server still serves 280
  people correctly.
- ⚠️ **`package.json`'s version is not a release identity, and using it would
  have been worse than having none.** It says `1.0.0`, it is in every image ever
  built, and it has never changed. A drift check reading it compares `1.0.0`
  against `1.0.0` and reports a permanent, silent match between the frozen
  release and whatever is actually deployed. `unknown` is a worse-looking answer
  and a far better one; there is a test that the fallback never appears.
- ⚠️ **"The server cannot say" is its own answer, not agreement.** Three states
  again, as in item 26's presence check — holding the freeze, holding something
  else, and unable to name itself — because the two-state version is where the
  comfortable lie lives.
- ⚠️ **Found while writing the tests, in my own code: the sequence in
  `release-2026-08-19.10` is a number, and git returns tags sorted as text.**
  `.10` sorted before `.2`, so "the latest freeze" — the tag every drift check
  compares the machine against — would quietly have been an older one. The same
  bug twice: once in the tag listing, once in the tags on HEAD. And
  `nextFreezeTag` now takes one past the highest for that date rather than the
  first free gap, because filling `.1` while `.10` exists cuts a release that
  sorts *before* releases that already happened.
- **A dirty tree is the one refusal `--force` cannot reach.** Every other blocker
  is a judgement somebody at 1pm on the Saturday may legitimately override, and
  the override is written into the tag message so the next person reads it rather
  than discovering it. A tag over uncommitted changes is not a judgement call —
  it names contents that exist nowhere and cannot be rebuilt or rolled back to.
- **The gate composes item 26 rather than re-asking it**, same rule and the same
  reason: a freeze is the last moment anybody looks, and a gate that disagrees
  with `npm run rehearsal` on the Wednesday gets argued with instead of obeyed.
- **The tag message is the record.** `git show release-2026-08-19` gives the
  event dates, the roster and block counts, the test result and the deploy
  command — what the event looked like when somebody decided this was the version
  to run. A lightweight tag carries a commit and nothing about why.
- **The freeze is affordable because the panel covers the live cases**, and
  `docs/freeze.md` opens with the table saying so: running late, a moved block,
  an evacuation, a bad change, a lost link and a stale sheet all have an answer
  that is not a deploy. If the fix is in that table it is not an emergency.

**Demonstrated, not just implemented.** Run against this repository, the gate
refused on the two things actually true of it — an uncommitted working tree,
naming the files, and four readiness blockers including dates four days in the
past — and correctly warned that HEAD exists only on this laptop, which it does.
Then against a second server started with the build args a deploy would set: the
boot banner and `/api/health` both named `release-2026-09-09`, the Ops card read
*A frozen release, built Sep 9, 10:02 AM* with the stamp beating the repository
beside it, and `--url` produced all three answers in turn — nothing frozen, a
match, and, after a second tag, `✗ The machine is running release-2026-09-09,
not release-2026-09-10`. The demonstration tags were deleted afterwards; this
repository has no freeze in it yet, correctly. The sorting, the sequencing and
the gate's refusals are covered by tests against a real temporary repository
rather than a mocked one.

⚠️ **Found while demonstrating:** the dirty-file list was capped at ten inside
the report *and* at eight in the renderer, so twenty uncommitted files printed
eight of them and "…and 2 more". A truncation of a truncation, disagreeing with
the count in its own title. The report now carries the whole list and only the
renderer caps.

**Still open — the freeze itself, which is a date:** nothing can be tagged until
the event dates are real (item 24), and the `--url` check has only been run
against a locally stamped server, because there is no deployed machine to ask
(item 22). What exists now is that when there is one, "is it running what we
froze" is one command rather than a shrug.

### 28. `[x]` Prep the humans

One-page admin guide. Printed fallback call sheets per team and per role —
non-negotiable; if the app is down at 1pm Saturday you need paper, not a
rollback. Named on-call person who isn't also running a camera. A decided answer
for "I lost my link" at the check-in desk.

**Done 2026-08-12** — `server/lib/call-sheets.js`, `scripts/call-sheets.js`, two
admin routes, a Printed fallback card in the Ops tab, an `on-call` deploy check,
and 32 new tests (`tests/call-sheets.test.js`, 539 total). The guide is
[docs/admin-guide.md](docs/admin-guide.md).

```bash
npm run callsheets             # the pack, into data/call-sheets/
npm run callsheets -- --check  # who and what reaches no sheet; exits 1 on either
```

- ⚠️ **The paper is generated from `getPersonalizedSchedule`**, the viewer's own
  function called with the viewer's own argument shape — the same rule as item
  16, for a sharper version of the same reason. A preview that disagrees with a
  phone is embarrassing; paper that disagrees with a phone is two people
  standing in different rooms, and it is read at the one moment there is nothing
  left to check it against.
- ⚠️ **A team sheet is the team *plus its members*, because paper has no
  identity step.** A team session deliberately holds no person-targeted and no
  Captain blocks — before somebody taps their name the app cannot know whose
  phone it is. Printing that view alone produces a sheet with **every airport
  pickup missing and no error anywhere**. Each member gets a section of `their
  payload \ the shared payload`, a set difference on block ids rather than a
  second derivation of who sees what. Two tests hold it: the shared half must
  *not* contain the pickups, and the sheet must.
- ⚠️ **Two documents, and the split is the security property.** The handout pack
  carries schedules and no codes; the one-page desk index carries every code and
  stays behind the desk. A team sheet ends up taped to a green-room wall, and
  every photograph of that wall would otherwise be a live credential — one that
  cannot be revoked without reprinting, by somebody who does not know to. There
  is a test that no code string reaches the pack.
- **Coverage is reported, not assumed.** A person on no sheet (on no team and
  holding no role) and a block on no sheet (usually a role nobody holds) are the
  two ways a printed pack loses somebody, and both are silent everywhere else —
  every phone is still correct. `--check` exits 1 on either and the Ops card
  names them. A dancer whose team was deleted still prints, on the Dancer sheet.
- **"I lost my link" is decided rather than improvised**, and printed on the
  desk index: a dancer is given their *team's* link and picks their name, staff
  are re-sent their own, and regenerating is only for a lost or stolen phone.
  The sign-in route each person needs comes from `accessFor()` in `view-as.js`
  — the same rule the panel diagnoses with, not a second copy of it.
- **The on-call person is `ON_CALL_NAME` / `ON_CALL_PHONE`**, checked at `warn`
  and printed on the desk sheet, which prints a ruled "NOT SET" line rather than
  dropping the section. It belongs beside `HEARTBEAT_URL` because it is the
  other half of the same alarm: item 23 built the thing that pages somebody,
  this is the somebody.

**Verified in the browser** against the 166-person dev database: 13 sheets
covering all 166 people, a captain's sheet showing her team's shared schedule
with her own captain blocks underneath, and the handout pack containing none of
the 45 live codes.

**Still open — the parts that are people, not code:**

- **Nobody is named on call.** The table in
  [docs/admin-guide.md](docs/admin-guide.md) is blank, and `preflight` warns.
- **Nothing has been printed**, because the pack is only as useful as the roster
  in it — same dependency as items 24 and 25.
- **The guide has not been read by whoever will hold the panel.** That is what
  the dress rehearsal is for (item 26).

---

## Top risks

| Risk | Mitigation | Item |
| --- | --- | --- |
| ~~Access codes look enforced but aren't~~ | Closed — subject derives from the session only, 21 authorization tests | 6 |
| ~~Socket CORS reflects any origin, and item 11 adds data to broadcasts~~ | Closed — origin is same-origin plus an allow-list, and the audience stays server-side so broadcasts gained no data at all | 11 |
| ~~Reload while offline shows a browser error~~ | Closed — the shell is precached and served when the network fails, verified with the server killed | 10 |
| ~~Two admins overwrite each other under pressure~~ | Closed — stale saves are refused with what they would have overwritten, and an open draft survives another admin's edit | 14 |
| ~~Timezone silently shifts every time shown~~ | Closed — instants resolved server-side, device clock drift corrected, 21 tests | 9 |
| Real spreadsheet doesn't match the template | Logistics authors in our template; importer validates and rejects loudly | 12 |
| Template isn't final in time to rehearse against | Track it as a dated dependency, not a background task; T-2 weeks is the drop-dead | 12, 26 |
| Dancer schedules have no source and never get authored | Half closed — the pipelines on Sequences + Slot Times are the mechanism, and Saturday is built from them. The steps, the anchors, and all of Thu/Fri/Sun are still content with no named owner | 24 |
| ~~The app cannot read the workbook logistics actually fills in~~ | Closed — three tabs read by name, both roster tabs in one upload, four event days, and 47 tests including the template's own tabs and columns | 24 |
| An import silently empties the schedule | Closed — refused on "nothing importable came out" rather than on "rows failed", which is the case a formulas-only Export tab produced | 24 |
| ~~A mail merge sends a dozen people's private links to one inbox~~ | Closed — recipients come from `people.email` and never from a contact card, which is shared by a whole team; a test mails nothing to a shared card | 25 |
| Links go out and nobody opens them | Half closed — the panel counts never-used, and `--check` fails when a link has no recipient. Nothing confirms delivery, and nothing sends: the merge is somebody's mailing tool. The desk index means an unopened link is a 10-second fix at check-in rather than a search | 25, 28 |
| Airport runs and the day grids never reach a phone | Half closed — `Export` reads from neither, so both look complete and change nothing, and nothing in the workbook says so. But an event day with no blocks on it is now a blocker in `npm run rehearsal`, which is the shape this failure takes: Thu and Sun empty. Documented in `docs/loading-data.md` | 24, 26 |
| A rehearsal against placeholder data passes and proves nothing | Closed — the gate refuses on dates that have already happened, a schedule made of seed rows, and an empty event day, and names what to fix. It is the same report in the panel and on the command line | 26 |
| A phone silently stops updating and nobody can tell | Closed for anyone watching the panel — each viewer reports the version it is rendering and `Ops → Phones connected` compares it against that person's own targets. ⚠️ A phone with the app *closed* does not appear at all, which is normal and is why the count is read against the room rather than against the roster | 26 |
| ~~Late schema change forces rework~~ | Closed — model confirmed against past-year data, and applied in item 13 with a migration that runs on boot | 2, 3, 13 |
| Two people who share a name silently become one | Closed — the importer refuses both rows rather than picking one, and refuses a row matching two people already in the database. ⚠️ The failure only ever appeared on the *second* import: the first created the pair, and every re-sync after it wrote both rows onto whichever one the lookup kept, freezing the other permanently while it still held a live access code | 12 |
| Real roster still not in hand | A people problem, not an engineering one — it was due at T-6 and is the likeliest thing to slip past the rehearsal. The loading path is now built and demonstrated, so this is the only thing between here and a real schedule | 24 |
| The event dates are still a placeholder, and it is now in the past | `npm run days` moves the whole weekend from one date and refuses a wrong weekday. The mechanism exists; the number is the event director's | 24 |
| ~~Thundering herd on every change~~ | Closed — one team's edit wakes 66 of 600 phones, and even an announcement to all 600 settles in ~140ms with no errors | 11, 20 |
| A wrong change made under pressure and no way back | Closed — one admin action is one log entry and undo reverts all of it, refusing rather than half-applying | 17 |
| An emergency change ships and nobody can say what is running | Closed — the release is stamped into the image at build and reported by `/api/health`, the boot banner and the Ops panel, and `npm run freeze -- --url` compares it against the tag. ⚠️ A plain `fly deploy` reports `unknown`, which is a warning rather than a match: there is no repository inside the image to derive it from | 27 |
| Code changes during event week because nothing says not to | Half closed — `npm run freeze` cuts the tag behind the same gate the rehearsal uses, counts every commit made since it, and `docs/freeze.md` opens with the table of live problems the panel already solves. Nothing can *stop* a push; what has changed is that an untagged one is visible | 27 |
| ~~A deploy comes up with the default admin password, or on a disk the next deploy wipes~~ | Closed — the server refuses to boot in production on either, plus two more that would otherwise pass a health check | 22 |
| Scaling to a second machine silently forks the database | Half-closed — `--ha=false`, `min_machines_running = 1`, a test, and it is the first thing `docs/deploy.md` says. But nothing can *stop* `fly scale count 2`, so it stays a live risk during event week | 22 |
| Printed paper is acted on after it goes stale | Half closed — every page is stamped with the time it was printed and says the phone wins, and the sheets come from the same query the phones run so they never start out disagreeing. Nothing stops somebody reading Thursday's copy on Saturday; saying it out loud when the app is down is in the guide | 28 |
| A printed sheet leaks a code | Closed — the handout pack carries no access code at all and a test asserts it; the desk index is the only page that does, and it says on it not to be handed out | 28 |
| Total app failure during the event | Half closed — verified snapshots every 5 minutes with an off-box copy, a tested restore script, health that fails when phones are not being served, an external dead-man's switch that pages someone, and a printed pack built from the same query the phones run. The restore drill has now been *performed* end to end and timed, and is step 3.5 of the rehearsal script. The targets are unset until the deploy exists, the drill has not been run on a real machine, and nothing has actually been printed because the roster is not real | 23, 26, 28 |
| The event dates were never checked against today by anything | Closed — `npm run rehearsal` refuses a weekend that has already happened, a date that is not the weekday it claims to be, and a non-contiguous one, measured against the venue's today. Nothing in the app asked this before, which is why the placeholder sat four days in the past unremarked | 9, 24, 26 |
| A green CI leg that ran no tests | Half closed, and deliberately so. This happened: a quoted `tests/**/*.test.js` matched nothing on Node 20, which exited 0 and reported green until item 20 grew the suite enough to turn it red. Discovery is now that same quoted glob on a `>=22` floor, which *is* recursive — so the "test file in a subdirectory never runs" half is closed. ⚠️ The other half is open on purpose: a glob matching nothing still exits 0 on 22+, silently. Every mitigation in this table is a number of tests, so **read the count, not the tick** — if it falls toward zero rather than going red, this is the cause | 19 |
| Unreadable on a real phone in a dark venue | Half closed — every colour is measured against AA and pinned by tests, and the screen is navigable by heading and by keyboard. The notch, the radio and the battery still need hardware | 21 |

---

## Timeline

Relative, since the event date isn't recorded here yet. Compress from the front
if there's less runway — but protect the dress rehearsal and the freeze, they're
the two that actually catch problems.

| When | Focus |
| --- | --- |
| ~~T-6 weeks~~ | ~~Phase A.~~ Done — but **real rosters are still not in hand**, and that is a people problem, not an engineering one. Chase it now; it is usually the long pole. |
| ~~T-5~~ | ~~Phase B (access codes).~~ Done. |
| T-4 | Phase C (reliability core) — items 9 ✅, 10 ✅, 11 ✅, 13 ✅ and 14 ✅ done; only item 12 remains, and it waits on the template. |
| T-3 | Phase D + E (admin tooling, tests, load test) — Phase D ✅, item 19 ✅ and item 20 ✅ done early; item 21's audit ✅. |
| T-2 | Phase F (deploy, ops) — item 22 ✅ configured and item 23 ✅ built; both need the deploy actually run, and item 23's three secrets pointed at real services. Plus item 21's device checks on real phones. |
| T-1 | Items 24–26. Items 24 ✅, 25 ✅ and 26 ✅ engineering done early; the roster and the dates are the gate for all three. Dress rehearsal — script and readiness gate ready, needs the room. |
| Event week | Items 27–28. Both ✅ built early; what is left of 28 is naming the on-call and printing the pack, and of 27 the Wednesday itself — `npm run freeze` refuses today's tree on the dates and the roster, which is the correct answer. |
| After | Retro. Export the edit log to see what actually changed and how often. |

---

## Working conventions

- Commit after each numbered item — that's the rollback path during event week.
- Record decisions in `docs/decisions.md` as they're made. Otherwise the
  reasoning is lost between sessions and gets re-litigated.
- Ask for verification in the browser, not just implementation. Several items
  above say "demonstrated working" rather than "implemented" on purpose.
- Run `/code-review` on anything touching the import pipeline or authorization.
