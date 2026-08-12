# Deploying

PLAN.md item 22. Target is **Fly.io**, one machine, one volume, in `ord`
(Chicago — the nearest region to Bloomington).

Config lives in [`fly.toml`](../fly.toml) and [`Dockerfile`](../Dockerfile);
the settings that must not be wrong are enforced at boot by
[`server/lib/deploy-config.js`](../server/lib/deploy-config.js) and checkable at
any time with `npm run preflight`.

---

## The one thing to get right

> ⚠️ **This app runs on exactly one machine, and that is not a performance
> compromise — it is a correctness requirement.**

A Fly volume attaches to a single machine. It is not shared storage. So a
second machine does not scale this app, it *forks* it: two SQLite files behind
one hostname, and which schedule you get depends on which machine the proxy
happened to route you to. Post an evacuation notice and half the phones get it.
Nothing in either database looks wrong, both machines pass their health checks,
and the edit log on each one is internally consistent.

There is no configuration that makes this safe. If this ever needs two
machines, it needs Postgres first — which the stack decision in
[decisions.md](decisions.md) deliberately declined.

In practice that means:

```bash
fly deploy --ha=false        # always. Without it, Fly creates a second machine.
fly status                   # after any deploy or scale command: expect one machine.
```

`fly scale count 2` is the command that breaks the event. `min_machines_running
= 1` in `fly.toml`, and a test asserts it is not higher.

---

## First deploy

Roughly fifteen minutes. Steps 3 and 4 are the ones that are annoying to undo.

**1. Create the app without deploying it.** The `fly.toml` in the repo is
already written, so let `launch` reuse it rather than generate one.

```bash
fly launch --no-deploy --copy-config --name royalty-schedule --region ord
```

**2. Create the volume.** 1GB is enormous for this — the event database is a
few megabytes — but it is the smallest size Fly offers and the price difference
is nil.

```bash
fly volumes create royalty_data --region ord --size 1
```

**3. Set the secrets.** Both are required: the server refuses to start in
production without them, which is the point.

```bash
fly secrets set ADMIN_PASSWORD="$(openssl rand -base64 18)"
fly secrets set SESSION_SECRET="$(openssl rand -hex 32)"
```

Put the admin password somewhere the logistics leads can reach it during the
event — a password manager, not a text message that scrolls away. Rotating it
mid-event signs every admin out, which is fine; rotating `SESSION_SECRET`
mid-event signs out **every phone at the venue**, which is not.

**4. Set the public URL** once the hostname is final. This is what the access
links in the CSV export are built from, so getting it wrong means 280 links to
a hostname that does not resolve — a mistake the recipients discover, not us.
No trailing slash.

```bash
fly secrets set PUBLIC_BASE_URL="https://royalty-schedule.fly.dev"
```

**5. Deploy.**

```bash
fly deploy --ha=false
```

**6. Seed the database.** The volume starts empty, and the schema and
migrations build themselves on first boot but the roster does not. This runs
**on the machine**, because that is where the volume is:

```bash
fly ssh console -C "npm run seed"
```

> ⚠️ Never put `npm run seed` in a `release_command`. Release commands run in a
> temporary machine with **no volume mounted**, so it would seed a filesystem
> that is discarded seconds later and report success. Migrations don't need one
> either — they run on every boot, from `server/db.js`.
>
> ⚠️ `npm run seed:reset` rebuilds from scratch and **destroys the live event
> data**. It has no place on a deployed machine after item 24.

**7. Verify.** See the checklist below.

---

## Verifying a deploy

Run through this after the first deploy and after any deploy during event week.
The first four are one command each; the rest need a browser.

```bash
fly status                                        # one machine, state "started"
fly ssh console -C "npm run preflight"            # every check passing
curl -si https://<host>/api/health                # 200 {"ok":true,...}; 503 = up, not serving
curl -si http://<host>/ | head -1                 # 301 to https
```

`npm run preflight` **on the machine** is the one that counts. Run locally it
reads your laptop's `.env`, which tells you nothing about what `fly secrets`
holds.

Then, in a browser:

- [ ] `/admin` rejects the old default password and accepts the new one.
- [ ] A magic link (`/s/<code>` from `npm run codes -- --list`) signs in and
      lands on a schedule.
- [ ] Editing a block in the panel updates an open viewer **without a reload** —
      this is the socket, and it is the thing most likely to be broken by a
      proxy. If the schedule is right but never updates on its own, check
      `PUBLIC_BASE_URL` against the actual hostname; the origin policy compares
      them.
- [ ] `/?now=2026-08-08T13:05` shows the time-override banner (venue wall clock).
- [ ] Airplane mode, then reload: "Offline · last known" rather than a browser
      error.

---

## What the platform has to provide

Recorded because the target could change, and these are the requirements rather
than the Fly spelling of them.

| Requirement | Why | Fly |
| --- | --- | --- |
| Persistent disk | SQLite. A container filesystem is rebuilt every deploy. | `[[mounts]]` → `/data` |
| Exactly one instance | The volume is per-machine; two instances is two databases. | `--ha=false`, `min_machines_running = 1` |
| No idle sleeping | Scale-to-zero drops every held socket and cold-starts the next arrival. | `auto_stop_machines = false` |
| Real WebSockets | Live updates. Not available on serverless platforms. | Fly proxy, no config |
| HTTPS | Session cookies are `Secure` in production. | `force_https = true` |
| Process supervisor | Restart on crash without anyone watching. | Fly machines restart by default |
| Proxy idle timeout ≥ ours | See keep-alive below. | 60s, ours is 65s |

Memory: peak RSS was **210 MB** at 600 connections
([load-test.md](load-test.md)), so the 1GB machine has a wide margin. CPU is
the real ceiling — better-sqlite3 is synchronous, so a fan-out is ~105µs times
the fleet.

### Keep-alive

`KEEP_ALIVE_TIMEOUT_MS` must stay **above** the proxy's idle timeout, so the
proxy is always the side that closes an idle connection. If this process closes
first, a phone reusing the socket in that instant gets `ECONNRESET`, which the
viewer cannot distinguish from being offline — so it renders "Offline · last
known" on a phone with full signal. Item 20 measured roughly one per thousand
refetches at Node's 5-second default.

Fly's proxy closes idle backend connections at 60s and ours is set to 65s.
**Verify this against the platform's current figure at deploy** rather than
trusting the number written here — it is a platform default, not a contract,
and the failure it causes looks like bad wifi rather than like a
misconfiguration.

---

## Deploying during the event

Item 27 freezes on the Wednesday, so this should be for genuine emergencies
only.

A deploy **restarts the one machine**, so there are a few seconds of downtime.
That is as good as it gets with a single volume — there is no second machine to
roll to, which is why `strategy = "immediate"` is set rather than a rolling
strategy that would pretend otherwise. What happens on a phone:

- The app shell is already cached by the service worker, so a reload during the
  restart still renders, behind the "Offline · last known" banner.
- Sockets reconnect on their own. `server/index.js` closes them cleanly on
  SIGTERM rather than letting them hang until each phone's own timeout.
- The database is checkpointed on the way down, in the same handler.

To roll back:

```bash
fly releases                       # find the last good version
fly deploy --image <image-ref>     # from the `fly releases --image` output
```

⚠️ A rollback reverts **code, not data**. Migrations in `server/migrate.js` are
forward-only and several of item 18's rebuild tables; rolling back past one
leaves a database the old code may not understand. Rolling back a same-week
deploy is safe. Rolling back across a schema change is not, and the answer then
is a restore from the item 23 snapshot.

## Logs and getting in

```bash
fly logs                                   # live
fly ssh console                            # a shell on the machine
fly ssh console -C "npm run codes -- --list"
fly ssh console -C "npm run backup"        # a verified snapshot, shipped off-box
fly ssh console -C "npm run restore"       # what is available to restore (docs/ops.md)
```

---

## Still open

**Backups, monitoring and alerting are item 23 and are now built** — see
[ops.md](ops.md), which is the runbook to read during the event. Three secrets
belong in the first-deploy sequence above, between steps 4 and 5:

```bash
fly secrets set BACKUP_TARGET_URL="…"        # or BACKUP_TARGET_CMD
fly secrets set HEARTBEAT_URL="…"            # the dead-man's switch that pages someone
fly secrets set ALERT_WEBHOOK_URL="…"        # Slack or Discord, for in-process errors
```

Without them the app still runs and still snapshots — onto the same volume as
the database, which covers a bad import and not the loss of the machine. Fly's
own daily volume snapshots are the other backstop, and a day is far too coarse
for an event whose whole point is that the schedule changes every few minutes.

**No custom domain is configured.** The app answers on `*.fly.dev`. If a real
hostname is wanted, add it before item 25 distributes the links, not after —
`PUBLIC_BASE_URL` is baked into every access link that goes out.

**`fly.toml` names `royalty-schedule` as the app.** If the name is taken, change
it there and in `PUBLIC_BASE_URL` together.
