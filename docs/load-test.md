# Load test — item 20

Run on 2026-08-10 against 600 concurrent viewers, on a roster sized for the
event's 280 participants. This file is the numbers and what they mean; the
harness is [`scripts/load-test.js`](../scripts/load-test.js) and the fixture it
builds is [`scripts/load-fixture.js`](../scripts/load-fixture.js).

```bash
npm run load-test                  # the full run: 600 clients, six scenarios
npm run load-test -- --clients 280 # at real scale
npm run load-test -- --clients 1000 --workers 5
npm run load-test -- --url https://… --skip-fixture   # against a deploy
```

## Headline

**Nothing broke, and the ceiling is set by one number: ~105µs of server CPU per
personalized schedule.** better-sqlite3 is synchronous, so 600 phones refetching
at once are served strictly one after another — the fan-out cost is that
per-request figure multiplied by the fleet, and it is a queue, not a cliff.

At 600 clients, the worst case in the product — an announcement, which by
construction reaches every session — settles in **~140 ms** (139–157 ms across
three runs), with no errors and no measurable server strain (peak RSS 210 MB,
3.3 CPU-seconds for the whole six-scenario run). The same at 1000 clients
settles in ~215 ms. The system is not close to a limit at the scale this event
will ever reach.

**The load test paid for itself before it measured anything.** Profiling the
hot path it exercised cut the personalized schedule from **388µs to 105µs**
(3.7×), which is the difference between a 288 ms and a 139 ms announcement
fan-out. See [Fixes](#fixes-this-surfaced).

## What the harness does

Not a benchmark of one endpoint. Each of the 600 virtual clients does what a
phone does:

- redeems an access code (`POST /api/session`), and if it is a team code, picks
  a name at the identity step — the path ~85% of the roster takes;
- holds one Socket.IO connection with the same options as `client/src/live.ts`;
- refetches `/api/schedule` the instant a change reaches its rooms, with no
  debounce, exactly as `ScheduleScreen.tsx` does;
- refetches on disconnect too, because `live.ts` treats a dropped socket as a
  hint rather than a verdict.

Clients run in 4 forked workers so one Node event loop is not simultaneously the
bottleneck and the instrument, and each client gets its own keep-alive agent
capped at one socket — pooling 150 clients onto a shared dispatcher would report
the harness's own queueing as server latency.

Two independent instruments run throughout:

- **`GET /api/health` every 250 ms** from the parent process. It touches one
  indexed row, so anything above the ~2 ms idle baseline is the event loop being
  held by something else. This is the honest answer to "was the server blocked?"
- **`ps` every 500 ms** on the server pid, for CPU-seconds and peak RSS.

⚠️ **Client and server share one 8-core machine.** That biases everything
*pessimistic* — a real deploy has the server to itself — so these are ceilings,
not predictions.

## The numbers at 600 clients

Three runs; the first is shown, and the others sit within ~10% of it — the
figures below are good to about that, not to the millisecond. Roster: 280
people, 8 teams, 350 blocks, 45 live codes. ~10 blocks per personalized
schedule, ~66 clients per team.

### Sign-in and connect

600 codes redeemed and 600 sockets opened over 10 s, **0 failures**.

| | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- |
| `POST /api/session` (redeem) | 9 ms | 11 ms | 16 ms | 19 ms |
| `POST /api/session/identify` | 1 ms | 2 ms | 3 ms | 7 ms |
| Socket handshake | 2 ms | 5 ms | 8 ms | 9 ms |

The whole fleet arriving over ten minutes at check-in is nothing; this ramp
compresses it into ten seconds and still does not move the health probe off its
2 ms baseline.

### The six scenarios

"Settle" is the number the event actually cares about: from the admin's save to
the **last** of the 600 phones holding fresh data.

| Scenario | Woken | Refetch p50 / p95 / max | Settle | Health p95 | Errors |
| --- | --- | --- | --- | --- | --- |
| One team edit | **66 of 600** | 15 / 24 / 25 ms | 26 ms | 4 ms | 0 |
| Burst — 20 edits back to back | 459 | 23 / 31 / 35 ms | 323 ms | 22 ms | 0 |
| Bulk shift — 89 blocks move 20 min | 580 | 72 / 123 / 127 ms | 130 ms | 3 ms | 0 |
| Announcement to everyone | 600 | 80 / 133 / 138 ms | 139 ms | 2 ms | 0 |
| Roster edit — a team renamed | 600 | 125 / 180 / 185 ms | 140 ms | 2 ms | 0 |
| Mass reconnect — every socket dropped | — | 102 / 165 / 171 ms | 192 ms | 50 ms | 0 |

Socket delivery itself is below the resolution of the measurement everywhere:
p95 of 1–3 ms from the admin's request completing to the event landing on 600
phones. **The fan-out is never the socket; it is the 600 refetches behind it.**

Admin-side latency, which is what the person under pressure actually feels:
single block edit 9 ms, each edit in the burst 6 ms (p95 15 ms), the bulk shift
4 ms to preview and 25 ms to move 89 blocks. A roster edit is the outlier at
~60 ms, for the reason below.

### Scoping holds under load

**66 of 600 clients woken by one team's edit** — and 66 is exactly the number of
virtual clients holding that team's code. The other 534 received no bytes at
all, not a filtered message. The edit log recorded the audience as 29 people,
which is the same set counted in people rather than devices (the fleet averages
2.1 devices per person at 600 clients).

That is item 11's room scheme working at scale: a change to one team costs 66
refetches, not 600. Without it every one of these rows would read like the
announcement row.

### Where the two slow rows come from

**The burst settles in 323 ms**, longer than the announcement, despite each
individual refetch being *faster* (p95 31 ms). That is not a queue — it is 20
edits dispatched over ~200 ms, each waking its own team. The settle number
measures from the *first* edit, so it mostly reports the burst's own duration.
Per-edit delivery p95 is 9 ms.

**A roster edit costs ~60 ms of admin latency and the slowest refetches** (p50
125 ms against the announcement's 80 ms), because `roster:updated` is broadcast
unscoped *and* passes `refreshRooms: true`, which re-derives every one of 600
open sockets' room membership synchronously — one signature check and several
indexed lookups each. The broadcast goes out first, so 600 phones start
refetching while the event loop is still busy with the room sweep, and their
requests queue behind it.

Left as it is, deliberately. ~60 ms on the rarest write path in the panel, with
everyone settled in 140 ms, is not worth making room membership asynchronous —
that computation is the thing keeping "who hears about this block" and "whose
schedule contains it" identical (see CLAUDE.md), and chunking it across ticks
would buy ~60 ms on an action that happens a handful of times a weekend. It is
recorded here so that if it ever *does* matter, the mechanism is already known.

## At 1000 clients

Beyond the plan's target, to see the shape of the curve rather than to certify a
number. It is linear, as a serialized queue should be:

| | 600 | 1000 |
| --- | --- | --- |
| Announcement refetch p95 | 133 ms | 206 ms |
| Announcement settle | 139 ms | 215 ms |
| Mass reconnect refetch p95 | 165 ms | 240 ms |
| Peak RSS | 210 MB | 219 MB |
| Health probe p99 (whole run) | 50 ms | 91 ms |

At 1000 simultaneous reconnects, ~6–8% of websocket upgrades are refused on the
first attempt and succeed on socket.io's own backoff, adding ~2.5 s to the time
the fleet takes to fully re-establish. Every client recovered; nothing was lost,
because the schedule refetch goes over HTTP and had already completed. This
appears only with the longer keep-alive below and only at 1000 — 600 is clean
across every run — and the mechanism is not pinned down, so it is worth
re-checking on the real deploy (item 22) rather than treated as settled.

## Fixes this surfaced

**The personalized schedule was 3.7× more expensive than it needed to be.**
`getPersonalizedSchedule` measured 388µs; profiling its parts found nearly half
the time in timezone work and statement compilation, neither of which changes
between requests:

| | before | after |
| --- | --- | --- |
| `blockInstants` (per block, ×~15) | 10.6µs | 0.6µs |
| `eventTimeState` (per payload) | 47.8µs | 8.1µs |
| `blocksForTargets` | 239µs | 45µs |
| `versionForTargets` | 21µs | 8µs |
| **`getPersonalizedSchedule`** | **388µs** | **105µs** |

Three changes, all in code the load test exercised:

1. **Resolved instants are memoized** (`server/lib/event-time.js`). Turning
   `(date, HH:MM)` into an instant costs two `Intl` format passes, and the
   schedule holds a few hundred distinct times that 600 phones all ask about at
   once. Keyed on the arguments, cleared with the zone, and it hands back a
   fresh `Date` each call so one caller can never mutate another's. Three tests
   cover exactly those two risks, both of which would otherwise be silent.
2. **The zone-abbreviation formatter is cached** rather than constructed per
   call — an `Intl.DateTimeFormat` costs ~40µs to build, and it sat inside
   `eventTimeState`, which is on every schedule payload.
3. **Prepared statements are cached** for the two queries whose SQL text varies
   only by how many targets a session has (`prepareCached` in `server/db.js`).
   Compiling the schedule query cost more than running it.

**Keep-alive was closing sockets in the gap between refetches**
(`server/index.js`). At 1000 clients, one refetch per thousand died with
`ECONNRESET`: a phone uses its connection in bursts — nothing for minutes, then
a request the moment something changes — and Node's 5-second default closes it
in that gap. `ScheduleScreen` cannot tell that from being offline, so it would
render "Offline · last known" on a phone with full signal. Now 65 s, with
`headersTimeout` above it, and an env var (`KEEP_ALIVE_TIMEOUT_MS`) because a
proxy with a shorter idle timeout at deploy would want it lower.

## What this does not cover

- **One machine, localhost.** No real network latency, no TLS, no proxy, no
  mobile radios. Venue wifi will dominate every number here; that is item 21 and
  item 26, not this.
- **The import pipeline under load.** A large upload is a single admin action
  that already holds the process for the length of the parse; the load test
  measures the steady state around it, not the upload itself.
- **A sustained soak.** The longest run here is about a minute. Battery drain
  and socket survival across a full day of lock/wake are item 21, on real
  hardware.
- **Anything about correctness.** Zero errors here means zero HTTP failures, not
  that the right people got the right blocks — that is what the 338 tests are
  for.
