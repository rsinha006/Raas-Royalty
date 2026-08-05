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

**Draft is complete and manually verified end to end.** Viewer, admin panel,
import pipeline, live updates, and offline caching all work. Nothing from the
task list below has been started.

Verified working in the browser: live push with per-user change highlighting,
offline fallback and auto-recovery, CSV import with preview/commit, force
re-sync, all three targeting modes (team / person / role), and graceful
recovery from a stale saved session.

**Not yet true of this project:** no tests, no deployment, no real data, no
access control on the viewer.

Phase A items 1–3 are done. The open decisions are resolved (see below); items 12
and 13 were reshaped by them.

### Build order

`templates/royalty-schedule-template.xlsx` is still being iterated by logistics.
It blocks **item 12 only**, plus the parts of 19 and 24 that depend on it.
Everything else proceeds now, in this order:

1. **Item 4** — anonymized fixtures. Derived from `samples/`, not the template.
2. **Phase B (5–8)** — access codes. Largest remaining chunk, security-critical,
   template-independent.
3. **Items 9, 13, 11, 14, 10** — timezone, the two schema columns, scoped
   broadcasts, correctness gaps, service worker.
4. **Phase D (15–18)** — admin tooling.
5. **Item 12 last**, against a frozen template.

Item 12 splits: only the tab readers depend on the template's shape. Diff
classification, apply, the `ingest()` contract, and validation reporting can be
built now. Same for item 19 — time parsing, midnight handling, diff
classification, and the authorization negatives are all testable today.

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

One value is still pending but not blocking, because it is data rather than
design: the real **event dates**. Not locked as of 2026-08-05 — the 2026-08-07 in
the seed and in the template is a placeholder. Settle before item 24.

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

## Access-code design (not yet built)

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

### 5. `[ ]` Add the access-code schema and generator

`access_codes` table: code, subject type, subject id, created, last used,
revoked. Migration backfills codes for the existing roster.

- **Done when:** every team and person has a code, and codes survive a re-seed.

### 6. `[ ]` Enforce codes server-side ⚠️ security-critical

Code → signed session cookie. `/api/schedule` restricted to the session's own
subject. `/api/bootstrap` removed or gutted so the roster isn't enumerable.
Rate-limit code attempts.

- **Claude Code:** Do this item alone. Then run `/security-review` on the diff
  and ask explicitly: *"Can I reach another subject's schedule without their
  code?"*
- **Done when:** a request without a valid session cannot retrieve any schedule
  or roster data, and that's covered by a test.

### 7. `[ ]` Rebuild the landing flow as code entry + magic links

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

### 8. `[ ]` Build code management in the admin panel

View, regenerate, and revoke per subject; bulk regenerate; CSV export of
subject → link for distribution.

- **Done when:** you can produce the exact file you'll mail-merge from.

---

## Phase C — Reliability core

### 9. `[ ]` Pin an explicit event timezone

Server-authoritative. Today "now / next" renders against the phone's clock, so a
traveller's mis-set device sees a silently shifted schedule. Wrong is worse than
absent here, because now/next is the whole product.

### 10. `[ ]` Add a service worker for the offline app shell

The cache only works if the page is *already loaded*. A pull-to-refresh with no
signal currently gives a browser error — and refreshing is exactly what people
do when something looks stale.

- **Claude Code:** Have it verify by killing the server and reloading, not by
  reading the code.

### 11. `[ ]` Scope broadcasts to the affected audience

Every change currently makes all ~170 clients refetch. The audience
(`personIds` / `teamIds`) is already computed for the edit log — put it in the
broadcast and let clients ignore changes that don't affect them.

### 12. `[ ]` Build the template importer

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

### 13. `[ ]` Apply model changes from item 3

- **`teams.show_order`** — 1–8, nullable until the draw.
- **`person_roles` join table** replacing single `people.role_id`.
  `resolveSession` pushes every role into `targets`; `blocksForTargets` already
  ORs an arbitrary list, so the query side is nearly free.
- Captains hold `Dancer` + `Captain`, assigned by the importer from the
  template's `Captain?` column. `Captain` is an ordinary `roles` row.

No divisions, no multi-team dancers, no second performance, no `is_captain`
boolean, and no fourth targeting mode.

### 14. `[ ]` Fix the known correctness gaps

- Concurrent admin edits are silently last-write-wins.
- Deleting a person or team orphans their schedule blocks.
- "Last updated" is global, so everyone sees a fresh timestamp when any team
  changes — mildly alarming and slightly dishonest.
- Past-midnight blocks are handled in code but never tested.
- Placeholder seed blocks aren't in any import's managed set (there's a "clear
  placeholder blocks" action for this — confirm it's still correct after item 12).

- **Claude Code:** Small and independent — batch into one request, then
  `/code-review`.

---

## Phase D — Admin tooling

Not polish. These are the difference between logistics using the app and routing
around it.

### 15. `[ ]` Bulk time shift

"Everything after 3pm moves 20 minutes." Running late is *the* most common live
change; doing it block-by-block across 8 teams is unusable under pressure.

### 16. `[ ]` "View as" preview

See exactly what a given team or person sees. Essential for "I don't see my
warm-up."

### 17. `[ ]` Undo / revert last change

The edit log records everything and can reverse nothing.

### 18. `[ ]` Event-wide announcements

Only if item 3 says you want them. Today "fire alarm, evacuate" means creating
six near-identical blocks.

---

## Phase E — Testing

The draft has zero automated tests and was verified manually, once.

### 19. `[ ]` Build the automated test suite

Priority order: import pipeline (time parsing across all accepted formats,
assignment resolution including ambiguous and prefixed cases, diff
classification) → now/next including timezone and midnight → access-code
authorization, negative cases explicit.

- **Claude Code:** *"Write tests against the anonymized fixtures and add a CI
  script."*
- **Done when:** CI runs green and the authorization negatives are covered.

### 20. `[ ]` Load test at 2–3× real scale

600 connections, a burst of admin edits, a mass reconnect. (Raised from 400:
last year was ~260 people, not the ~170 originally assumed.)

- **Claude Code:** *"Write a load-test script and report the numbers."* Numbers,
  not reassurance.
- **Done when:** you know the response-time ceiling and have fixed whatever it
  surfaced.

### 21. `[ ]` Device matrix and accessibility pass

Real iOS Safari and Android hardware — the in-app browser is not a substitute.
Check safe-area insets, `tel:`/`sms:` actually dialling, socket survival across
lock/wake, and battery drain over a full day. Plus contrast, focus order, and
screen reader labels.

- Claude can do the accessibility audit and responsive checks; physical device
  and battery testing is yours.

---

## Phase F — Deployment and operations

### 22. `[ ]` Deploy properly

Persistent disk (SQLite needs one), HTTPS, process supervisor, no idle sleeping.
Set `ADMIN_PASSWORD` and pin `SESSION_SECRET`.

### 23. `[ ]` Backups, monitoring, alerting

Automated off-box DB snapshots every few minutes during the event. Uptime
monitor on `/api/health` with SMS to whoever is on call. Error tracking — you
will not be reading server logs during a competition.

---

## Phase G — Event readiness

### 24. `[ ]` Load the real roster and schedule

By now this should be a data task, not an engineering one — but a bigger one
than that sounds. Pin the real dates and confirm the venue timezone here. And
note the analysis finding: **dancer schedules do not exist as data anywhere**.
They were scattered across six logistics tabs last year and have to be authored
into the template. Budget that as content work, with a named owner.

### 25. `[ ]` Generate and distribute access links

Team links to captains, individual links to staff. Send early enough that
lost-link requests arrive before Friday rather than during.

### 26. `[ ]` Full dress rehearsal — T-1 week

Real data, 10–15 people on their own phones, in the venue if possible. Make live
changes and confirm every phone updates. Then deliberately break things: kill
the server, kill the wifi, revoke a code, delete a team. This is where you find
what this plan missed.

### 27. `[ ]` Freeze on the Wednesday before

Tag the release. No changes after except genuine emergencies.

### 28. `[ ]` Prep the humans

One-page admin guide. Printed fallback call sheets per team and per role —
non-negotiable; if the app is down at 1pm Saturday you need paper, not a
rollback. Named on-call person who isn't also running a camera. A decided answer
for "I lost my link" at the check-in desk.

---

## Top risks

| Risk | Mitigation | Item |
| --- | --- | --- |
| Access codes look enforced but aren't | Server-side session check + security review + tests | 6 |
| Reload while offline shows a browser error | Service worker | 10 |
| Timezone silently shifts every time shown | Server-authoritative timezone | 9 |
| Real spreadsheet doesn't match the template | Logistics authors in our template; importer validates and rejects loudly | 12 |
| Template isn't final in time to rehearse against | Track it as a dated dependency, not a background task; T-2 weeks is the drop-dead | 12, 26 |
| Dancer schedules have no source and never get authored | Named owner for the content work at item 24 | 24 |
| ~~Late schema change forces rework~~ | Closed — model confirmed against past-year data | 2, 3 |
| Thundering herd on every change | Audience-scoped broadcasts + load test | 11, 20 |
| Total app failure during the event | Backups, monitoring, printed fallback | 23, 28 |

---

## Timeline

Relative, since the event date isn't recorded here yet. Compress from the front
if there's less runway — but protect the dress rehearsal and the freeze, they're
the two that actually catch problems.

| When | Focus |
| --- | --- |
| T-6 weeks | Phase A. Start chasing real rosters now — it's a people problem and usually the long pole. |
| T-5 | Phase B (access codes). |
| T-4 | Phase C (reliability core). |
| T-3 | Phase D + E (admin tooling, tests, load test). |
| T-2 | Phase F + item 21 (deploy, ops, devices). |
| T-1 | Items 24–26. Dress rehearsal. |
| Event week | Items 27–28. Freeze Wednesday. |
| After | Retro. Export the edit log to see what actually changed and how often. |

---

## Working conventions

- Commit after each numbered item — that's the rollback path during event week.
- Record decisions in `docs/decisions.md` as they're made. Otherwise the
  reasoning is lost between sessions and gets re-litigated.
- Ask for verification in the browser, not just implementation. Several items
  above say "demonstrated working" rather than "implemented" on purpose.
- Run `/code-review` on anything touching the import pipeline or authorization.
