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
14, 19 and 20.** Last updated 2026-08-10.

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
- **338 tests run in CI**, covering authorization negatives, timezone and DST,
  code management, the schema migrations, broadcast scoping, the item 14
  correctness gaps, the bulk shift, the offline shell, preview fidelity,
  everything undo refuses, the announcement target, and the import pipeline —
  including last year's real spreadsheets, which the importer has to refuse
  without moving the schedule.
- **600 phones have been measured, not assumed.** The worst change the product
  can make — an announcement to everyone — reaches all 600 in ~140 ms with no
  errors, and the personalized schedule is 3.7× cheaper than it was before the
  test profiled it.

The open decisions are all resolved (see below); item 12 was reshaped by them.

**Not yet true of this project:** no deployment and no real data.

**Next up: item 21 (devices and accessibility), then Phase F (deploy and ops).**

### Build order

`templates/royalty-schedule-template.xlsx` is still being iterated by logistics
— and is **still untracked**, so it exists on one laptop. It blocks **item 12
only**, plus the parts of 24 that depend on it. Everything else proceeds now, in
this order:

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
338, run in CI on every push.

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
- ✅ **CI** — `.github/workflows/ci.yml`, and `npm run ci` locally.
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
| ~~Access codes look enforced but aren't~~ | Closed — subject derives from the session only, 21 authorization tests | 6 |
| ~~Socket CORS reflects any origin, and item 11 adds data to broadcasts~~ | Closed — origin is same-origin plus an allow-list, and the audience stays server-side so broadcasts gained no data at all | 11 |
| ~~Reload while offline shows a browser error~~ | Closed — the shell is precached and served when the network fails, verified with the server killed | 10 |
| ~~Two admins overwrite each other under pressure~~ | Closed — stale saves are refused with what they would have overwritten, and an open draft survives another admin's edit | 14 |
| ~~Timezone silently shifts every time shown~~ | Closed — instants resolved server-side, device clock drift corrected, 21 tests | 9 |
| Real spreadsheet doesn't match the template | Logistics authors in our template; importer validates and rejects loudly | 12 |
| Template isn't final in time to rehearse against | Track it as a dated dependency, not a background task; T-2 weeks is the drop-dead | 12, 26 |
| Dancer schedules have no source and never get authored | Named owner for the content work at item 24 | 24 |
| ~~Late schema change forces rework~~ | Closed — model confirmed against past-year data, and applied in item 13 with a migration that runs on boot | 2, 3, 13 |
| Real roster still not in hand | A people problem, not an engineering one — it was due at T-6 and is the likeliest thing to slip past the rehearsal | 24 |
| ~~Thundering herd on every change~~ | Closed — one team's edit wakes 66 of 600 phones, and even an announcement to all 600 settles in ~140ms with no errors | 11, 20 |
| A wrong change made under pressure and no way back | Closed — one admin action is one log entry and undo reverts all of it, refusing rather than half-applying | 17 |
| Total app failure during the event | Backups, monitoring, printed fallback | 23, 28 |

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
| T-3 | Phase D + E (admin tooling, tests, load test) — Phase D ✅, item 19 ✅ and item 20 ✅ done early; item 21 remains. |
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
