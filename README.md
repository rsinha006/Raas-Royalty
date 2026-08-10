# Royalty — live event schedules

One shared link. Everyone picks who they are, then sees only their own schedule —
where to be, when, and who to call — updating live as logistics changes things.

Built for phones on bad venue wifi: large tap targets, "now / next" above the
fold, and a cached copy that keeps working when the connection drops.

## Quick start

```bash
npm install
npm run seed        # placeholder roster: 166 people, 8 teams, 107 blocks
npm run build
npm start           # http://localhost:4000
```

For development with hot reload (client on :5173, API on :4000):

```bash
npm run dev
```

| Surface | URL | Access |
| --- | --- | --- |
| Participant viewer | `/` | A personal access code, usually opened as `/s/:code` |
| Logistics panel | `/admin` | Shared password (`ADMIN_PASSWORD`, default `royalty-admin`) |

Copy `.env.example` to `.env` and set `ADMIN_PASSWORD` before the real event.
Codes are managed in the panel's **Access codes** tab, or from the CLI:

```bash
npm run codes -- --list
```

### Event time

Every schedule time is resolved server-side against one IANA timezone
(`EVENT_TIMEZONE`, default `America/Indiana/Indianapolis`) and sent to clients
as an absolute instant. A phone on the wrong timezone — or with the wrong clock
— therefore cannot shift what it shows. Set the zone by region name; the server
refuses to start on an abbreviation or fixed offset, because those ignore
daylight saving and would put the whole event an hour out for half the year.

### Rehearsing the live view

The seeded event is Fri 7 / Sat 8 Aug 2026. To see the app as it behaves
mid-event, pass a time override — read as **venue** wall-clock, not yours:

```bash
open "http://localhost:4000/?now=2026-08-08T13:05"
```

The viewer shows a banner while a rehearsal time is pinned, so it can't be
mistaken for the live app.

## Stack

Express + Socket.IO + SQLite (better-sqlite3) serving a React/Vite bundle — one
process, one file database, real WebSockets. No external services.

## Data model

| Table | Notes |
| --- | --- |
| `roles` | Roles are **data**, not an enum. `selector` marks whether a role is reached individually or through a team. Admins can add roles without a deploy. |
| `teams` | `liaison_contact_id` is what that team's dancers see as their contact. `show_order` is the running order, 1–8, null until the draw. |
| `people` | `team_id` nullable (dancers only), `contact_id` optional. Roles live in `person_roles`, not here. |
| `person_roles` | Many-to-many. Almost everyone holds one role; captains hold `Dancer` + `Captain` so three captain-only blocks can be role-targeted. Display role = lowest `sort_order`. |
| `contact_cards` | Name, title, phone, email, note. |
| `locations` | `venue_name` + `sub_location` ("Main Venue → Green Room B"). |
| `event_days` | Fri/Sat as rows with real dates, so "now / next" knows what's past. |
| `schedule_blocks` | `applies_to_type` is `team`, `person`, or `role`. |
| `edit_log` | Every change, with `audience_json` naming who was affected. |
| `target_versions` | When each block target last changed, keyed on the same `type:id` that names a socket room. This is what a viewer's "Last updated" reads, so one team's edit doesn't tell everyone their schedule moved. |

### How a block reaches a person

A block targets a team, a single person, or a whole role.

- A **team session** — a team code, before the "which dancer are you?" step —
  sees its team's blocks plus the dancer role's blocks. Not Captain: there is no
  way yet to know whose phone it is.
- A **person session** sees their own blocks, the blocks of *every* role they
  hold, and their team's blocks if they have a team. This is what carries the
  captain-only blocks to a captain and to nobody else.

## "I don't see my warm-up"

The panel's **View as** tab renders any team, person, or role's schedule from
the same query their phone runs — not a reconstruction of it, so the two cannot
disagree. Alongside it are the two things that turn a complaint into a fix:

- **Why these blocks** — the targets this view ORs over. A block missing from
  someone's screen is a block whose target is not in that list, which is
  readable without opening the database.
- **How they sign in** — their own link, or their team's link plus the identity
  step, and whether a live code exists at all. A dancer left on no team (which
  is what deleting a team does to its members) shows as unreachable here; their
  schedule is fine and they have no way to open it.

Previewing a team also lists the people behind the identity step, because "she
can't see her warm-up" is most often "she is looking at the team view and hasn't
tapped her name yet" — the team view holds no person-targeted or captain blocks
at all.

## Running late

The Schedule tab's **Shift times** does what running late actually needs:
"everything from 3pm moves 20 minutes", across every team at once, instead of
forty individual edits.

Pick the day tab, set the cutoff and the offset, and you get the exact list of
blocks that would move with their before and after times. Untick anything that
isn't running late — the airport pickup, a judge's break — and apply. It is
all-or-nothing: if anyone else has touched one of those blocks since you
previewed, nothing moves and the panel says which one.

Only blocks that **start** at or after the cutoff move; anything already under
way keeps its time. A block whose start crosses midnight moves to the next
event day, and one that would cross into a day the event doesn't have is left
out and named, because guessing there would write a plausible-looking time
exactly 24 hours wrong.

## Import and sync

Everything flows through one pipeline:

```
bytes → parseTabular → normalizeScheduleRows → computeScheduleDiff → apply
```

Manual upload, Force Re-sync, and background polling all call the same
`ingest()`. Nothing downstream knows where the bytes came from.

**Today (interim):** upload a `.csv`/`.xlsx` in the admin panel. You get a
preview of exactly what will be added, changed, and removed before anything goes
live. Force Re-sync re-applies the last uploaded file.

**Later (live sheet):** set env vars and restart — no code changes.

| Setting | Effect |
| --- | --- |
| `SCHEDULE_SOURCE=url` + `SCHEDULE_SOURCE_URL` | Pull a Google Sheet published as CSV. No credentials. |
| `SCHEDULE_SOURCE=google_sheets` + `GOOGLE_SHEET_ID` + `GOOGLE_API_KEY` | Sheets API v4. |
| `SYNC_POLL_SECONDS=60` | Poll that source and push changes to every open phone. |

### Spreadsheet templates

Schedule: `Day, Start, End, Location, Sub-location, Activity, Assigned
Team/Person, Notes, ID`

Roster: `Name, Role, Team, Contact Person/Method`

Downloadable from the admin Overview tab. Times accept `14:30`, `2:30 PM`, or
`1430`. The assignment column matches a team name, a person's name, or
`All <Role>`; prefix with `Team:`, `Person:`, or `Role:` to force one.

Rows are matched across syncs by `day + assignment + activity`, so a block that
moves is recorded as an **update**, not a delete plus a create — which keeps the
change log readable.

**Manual blocks are never touched by a sync.** Blocks created by an import are;
placeholder seed blocks are neither, so clear them (Import & Sync tab) once your
real schedule lands, or both will show up on people's phones.

## Live updates

Any admin change broadcasts over Socket.IO. The server only announces *that*
something changed — each client refetches its own slice, so no one ever receives
another person's schedule. Clients diff old against new and briefly highlight
what moved for them specifically.

**A change only reaches the people it affects.** Sockets join a room per block
target (`team:…`, `person:…`, `role:…`), matching the targets that build that
person's schedule, and a change is emitted to that block's rooms alone — so
moving one team's warm-up wakes that team, not all 280 phones. The payload says
nothing about who is affected; the audience is the room, never a field.

Room membership comes from the session cookie sent with the handshake, so the
client re-handshakes whenever the session changes (sign-in, identity step,
sign-out), and a roster edit re-derives every open socket's rooms server-side.

Only same-origin connections are accepted, plus `PUBLIC_BASE_URL` and anything
in `SOCKET_ORIGINS`; localhost and LAN origins are also allowed outside
production, which is what lets the Vite dev server and a phone on the same wifi
connect. The boot banner prints the resolved policy.

## Offline

The last successful schedule is cached in `localStorage`. If a fetch fails, the
viewer shows that cached copy behind an "offline — showing last known schedule as
of [time]" banner rather than an error, and recovers on its own when the
connection returns. A dropped socket triggers a real fetch before anything is
declared offline, so a brief blip doesn't flash the banner.

A service worker (`client/sw.js`, emitted to the build root by
`client/vite-plugin-sw.js`) keeps that cache reachable across a reload, which is
otherwise the one gesture that throws it away. It caches the app shell — the
HTML and the JS/CSS pair the build emits, listed from the real bundle — and
nothing else:

| Request | Behaviour |
| --- | --- |
| `/api/*`, `/socket.io/*` | Never intercepted. The schedule cache above is the offline story, and it renders behind its own banner. |
| `/s/:code` | Network only. Offline it explains that signing in needs a connection and links to the saved schedule. |
| `/admin` | Network only. Offline it says so rather than rendering a panel that cannot save. |
| Navigations | Network first, cached shell after 3.5s or on failure — so a reload with signal always gets the current build. |
| Hashed assets | Cache first, and only ever what the build declared. |

Registration is production-only and skipped on `/admin`; a dev build unregisters
any worker it finds, so a stale bundle cannot outlive an edit. The server sends
`sw.js` with `Cache-Control: no-cache` so a redeploy is picked up on the next
load rather than up to an hour later.

## Notifications (not in v1)

The groundwork is in place: every `edit_log` row carries `audience_json` with the
`personIds` and `teamIds` affected by that change — including both the old and
new audience when a block is reassigned. A push layer can read the log and fan
out without re-deriving who cared.
