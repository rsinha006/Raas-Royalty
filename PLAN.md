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

**Not yet true of this project:** no version control, no tests, no deployment,
no real data, no access control on the viewer.

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

Blocking. Resolve in Phase A, record in `docs/decisions.md`.

1. **Role-level access codes.** "Every team, role, user gets a password" — teams
   and users map cleanly onto a schedule; roles don't. A single shared "Judge"
   code lets any judge read any other judge's schedule. Recommendation:
   per-person codes for staff, per-team codes for dancers, role-level codes only
   where you'd rather hand six sponsors one code than manage six.
2. **Data model questions** (answerable from past-year data plus a short call
   with the event director): Can a dancer compete with two teams? Does anyone
   hold two roles? Is there a level above teams — divisions, brackets? Does a
   team perform more than once? Do judges need the running order rather than one
   long scoring block? Is anything scheduled per-person *within* a team?
3. **Event timezone and dates.** Currently seeded as Aug 7–8 2026, rendered
   against the phone's local clock.

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

### 1. `[ ]` Put the project under version control

Not a git repo yet, which makes every step below riskier and the code freeze in
item 27 unenforceable.

- **Claude Code:** "Initialize git, write a sensible .gitignore, make the initial
  commit." Then commit after every numbered item.
- **Done when:** `git log` shows an initial commit and `data/` is ignored.

### 2. `[ ]` Analyze the sample rosters and past master schedules

Raw and unedited — the mess is the signal. Include before/after versions of a
past weekend if they survived; the diff shows what actually changes live.

- **Claude Code:** Put files in `samples/`, then: *"Analyze these — don't change
  any code. Report the real column format, what varies between years, and what
  the data implies about the model."*
- **Done when:** a written analysis exists and the item 2 questions above are
  answered or narrowed.

### 3. `[ ]` Resolve the open decisions

Data model from the analysis plus a short call with the event director; the
role-code question from the access-code design.

- **Claude Code:** Use plan mode. Finish with *"write these decisions to
  docs/decisions.md."*
- **Done when:** every open decision above has a recorded answer.

### 4. `[ ]` Anonymize the samples into committed fixtures

Same structure and edge cases, fake names and numbers. Past rosters carry real
contact details for ~150 people; those should not enter version control.

- **Claude Code:** *"Generate anonymized fixtures from samples/ preserving
  structure and edge cases; keep the originals gitignored."*
- **Done when:** fixtures are committed, originals are not.

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

- **Claude Code:** Ask it to verify in the browser preview at mobile size —
  valid code, bad code, revoked code, and a returning visit with no typing.
- **Done when:** all four paths are demonstrated working, not just implemented.

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

### 12. `[ ]` Rebuild the importer against the real format, add column mapping

Map their columns onto your fields at upload time and remember the mapping.
Turns "their sheet must match our template" into "our importer adapts."

### 13. `[ ]` Apply model changes from item 3

Two roles per person, divisions, teams performing twice — whatever the data said.
Late schema changes are the most expensive thing on this list; this is why
Phase A comes first.

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

400 connections, a burst of admin edits, a mass reconnect.

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

By now this should be a data task, not an engineering one.

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
| Real spreadsheet doesn't match the template | Analyze past years, add column mapping | 2, 12 |
| Late schema change forces rework | Answer model questions before building | 2, 3 |
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
