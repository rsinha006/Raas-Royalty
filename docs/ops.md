# Running it during the event

PLAN.md item 23 — backups, monitoring, alerting. Deploy itself is
[deploy.md](deploy.md).

Written to be read under pressure. The first section is what to do when
something is wrong; everything after it is how the pieces are set up, which is
work for before the event.

---

## The one thing to know

> ⚠️ **The event database is the only thing here that cannot be rebuilt.**
> Code is in git, the client is in the image, the roster came from a
> spreadsheet. The schedule as it stands *right now* — every live change made
> since the last import — exists in one SQLite file on one volume on one
> machine.

Snapshots are taken every 5 minutes, verified, and copied off the machine. The
restore procedure is below and it is meant to be **practised at the dress
rehearsal** (item 26), not read for the first time on the Saturday.

---

## Something is wrong

### Nobody can reach the app

```bash
fly status                                   # is the machine up?
curl -si https://<host>/api/health           # 200 = serving; 503 = up but not serving
fly logs                                     # last few minutes
```

A **503 from `/api/health`** means the process is alive and phones are *not*
being served — almost always a missing client build or an unreadable database.
The body names which. A **timeout or connection refused** is the machine, not
the app: `fly machine restart <id>`.

If the app is up but a phone shows nothing, check `/admin` → **Ops** for recent
errors before touching anything. The panel shows the last 20 server faults and
they are also in `errors.log` beside the database.

### The schedule is wrong and undo cannot fix it

Undo (item 17) covers one admin action. For anything larger — a bad import
applied, a table of blocks deleted, a database that looks corrupted — restore a
snapshot:

```bash
fly ssh console -C "npm run restore"                            # what is available
fly ssh console -C "npm run restore -- <name>"                  # inspect one, changes nothing
fly machine stop <id>                                           # ⚠️ required, see below
fly machine start <id> && fly ssh console -C "npm run restore -- <name> --yes"
```

> ⚠️ **The server must not be running when the file is replaced.** SQLite lets
> another process rename the database out from under an open connection, and the
> running server keeps writing to the descriptor it already holds — so the
> restore appears to work and is undone by the next checkpoint. On one machine
> the honest sequence is: stop, start, restore immediately, restart.
>
> The restore script sets the current database aside in `replaced/` rather than
> overwriting it. That copy is the only record of everything that happened
> between the snapshot and now, so do not delete it until the event is over.

After a restore:

```bash
fly ssh console -C "npm run codes -- --check"    # every subject still has a code
```

…then open one magic link and check a schedule renders. Migrations run on boot,
so an older snapshot is brought forward automatically.

### Restoring from the off-box copy instead

If the volume itself is gone, fetch a copy from wherever `BACKUP_TARGET_*`
points, put it on the new machine, and pass a path rather than a name:

```bash
fly ssh sftp shell                               # put the file into /data
fly ssh console -C "npm run restore -- /data/royalty-20260808-131500Z.db --yes"
```

### Alerts are firing repeatedly

Each condition alerts at most once every 5 minutes
(`ALERT_MIN_INTERVAL_MS`). If something is flapping and the noise is in the way,
unset `ALERT_WEBHOOK_URL` — the errors are still recorded in the panel and in
the file. **Do not unset `HEARTBEAT_URL` to quieten something**; that is the
alarm that notices the machine is gone.

---

## What runs, and where

| Piece | Where | Fails how |
| --- | --- | --- |
| Snapshot every 5 min | in-process timer, `server/lib/backup.js` | stops silently if the process wedges → heartbeat |
| Verify + prune | same run, before the copy is kept | a bad copy is deleted, and the run is reported failed |
| Ship off-box | same run, `BACKUP_TARGET_URL` / `_CMD` | logged; the local copy is already verified |
| `/api/health` | `server/lib/ops.js` | 503 when phones are not being served |
| Error capture | ring buffer + `errors.log` + webhook | never throws; the panel is the fallback view |
| Heartbeat | in-process timer | **its failure is the alarm** |

Everything persistent — snapshots, `errors.log` — lives beside the database, so
it survives a deploy. ⚠️ Never write it relative to the source tree; see
[deploy.md](deploy.md).

---

## Setting it up

### 1. Somewhere for snapshots to go

Either mechanism works; pick the one there is an account for.

```bash
# An HTTP endpoint that accepts PUT. {name} is appended unless the URL contains it.
fly secrets set BACKUP_TARGET_URL="https://<bucket-endpoint>/royalty"
fly secrets set BACKUP_TARGET_TOKEN="<token>"       # sent as Authorization: Bearer

# Or any command. {file} and {name} are substituted and shell-quoted.
fly secrets set BACKUP_TARGET_CMD="aws s3 cp {file} s3://royalty-backups/{name}"
```

The command form needs its binary in the image — add it to the `Dockerfile` if
you go that way, and check it works *before* the event:

```bash
fly ssh console -C "npm run backup"        # prints where the copy went and what is in it
fly ssh console -C "npm run backup -- --list"
```

**Retention.** Locally: 48 snapshots or 256MB, whichever binds first, and the
byte cap is the one that matters — the volume also holds the database, and
filling it takes the event down in the most confusing way available (writes
start failing while every health check still passes). At a realistic database
size that is a few hours of history on the machine. **The off-box target is what
holds the whole event**, because nothing here prunes it.

### 2. Something that notices the machine is gone

This is the item's "SMS to whoever is on call", and it has to be an outside
service — nothing running on the machine can report that the machine has
stopped.

1. Create a check on any dead-man's-switch service (healthchecks.io, Better
   Stack, Cronitor, or an uptime monitor's push URL). Period 1 minute, grace 5.
2. Turn on **SMS** to the on-call person from item 28. Email is not enough in a
   gym.
3. `fly secrets set HEARTBEAT_URL="https://hc-ping.com/<uuid>"`
4. Name that person to the app as well, so the printed desk sheet has a number
   on it and `preflight` stops warning:
   `fly secrets set ON_CALL_NAME="…" ON_CALL_PHONE="…"`. It has to be a name
   rather than a rota, and not somebody also running a camera — see
   [admin-guide.md](admin-guide.md).

Then, as a second signal that watches from the other direction, point an
ordinary uptime monitor at `https://<host>/api/health` — every 1–5 minutes,
alerting on non-200. The two catch different things: the heartbeat catches a
machine that stopped, the monitor catches a machine that is up and serving
nothing.

**Test both before the event, by breaking them on purpose.** `fly machine stop`
and wait for the SMS. An alarm nobody has heard ring is a guess.

### 3. Somewhere for errors to arrive

```bash
fly secrets set ALERT_WEBHOOK_URL="https://hooks.slack.com/services/…"
```

A Slack or Discord incoming webhook works unmodified — the payload carries
`text` and `content` alongside the structured fields. Then press **Send a test**
in the panel's Ops tab and confirm it arrives; that button bypasses the
deduplication window, because being told the test was suppressed is not a test.

What alerts: three consecutive failed snapshots, nothing verified for three
intervals, an unhandled rejection, and a crash (which also restarts the
machine).

### 4. Check it from the panel

`/admin` → **Ops** answers the three questions someone actually arrives with:
is there a recent verified copy, has anything been failing, and does the alert
path work. It also offers **Take one now** — worth pressing immediately before
an import or anything else irreversible — and a download link per snapshot.

⚠️ A downloaded snapshot is the entire event including every access code. Treat
it like the codes export: it is the same material, and it is admin-only for the
same reason.

---

## Before the event

- [ ] `fly ssh console -C "npm run preflight"` — every check green, including
      `backups-off-box` and `alerting`.
- [ ] `npm run backup` on the machine puts a copy at the off-box target, and
      the copy is visible from wherever that is.
- [ ] A restore has been *performed*, not read: at the dress rehearsal, on the
      rehearsal data.
- [ ] `fly machine stop` produced an SMS to the on-call person's phone.
- [ ] **Send a test** in the Ops tab arrived where someone will see it.
- [ ] The on-call person from item 28 knows the restore sequence above and has
      the admin password — and is named in `ON_CALL_NAME` / `ON_CALL_PHONE`.
- [ ] **The paper is printed.** `npm run callsheets`, or Ops → Printed fallback.
      Everything on this page assumes the app comes back; the pack is what the
      venue runs on while it does not. See [admin-guide.md](admin-guide.md).

## Still open

- **No automated restore drill.** The round trip is covered by tests
  (`tests/backup.test.js`), but nothing rehearses the full stop-restore-start
  sequence on a real machine. That is item 26's job.
- **Off-box retention is whatever the target does.** Nothing here prunes it, and
  nothing here checks the copies are arriving — the shipped-at timestamp in the
  panel says the request was accepted, not that a file is readable at the other
  end. Look at the bucket once before the event.
- **No metrics.** Response times, connection counts and memory are measured in
  the load test (item 20) and not on the machine. `fly status` and the platform
  dashboard are the substitute for a two-day event.
