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
| `roles` | Roles are **data**, not an enum. `selector` decides whether picking that role then asks for a team or a name. Admins can add roles without a deploy. |
| `teams` | `liaison_contact_id` is what that team's dancers see as their contact. |
| `people` | `team_id` nullable (dancers only), `contact_id` optional. |
| `contact_cards` | Name, title, phone, email, note. |
| `locations` | `venue_name` + `sub_location` ("Main Venue → Green Room B"). |
| `event_days` | Fri/Sat as rows with real dates, so "now / next" knows what's past. |
| `schedule_blocks` | `applies_to_type` is `team`, `person`, or `role`. |
| `edit_log` | Every change, with `audience_json` naming who was affected. |

### How a block reaches a person

A block targets a team, a single person, or a whole role.

- A **team session** sees its team's blocks plus the dancer role's blocks.
- A **person session** sees their own blocks, their role's blocks, and their
  team's blocks if they have a team.

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

## Offline

The last successful schedule is cached in `localStorage`. If a fetch fails, the
viewer shows that cached copy behind an "offline — showing last known schedule as
of [time]" banner rather than an error, and recovers on its own when the
connection returns. A dropped socket triggers a real fetch before anything is
declared offline, so a brief blip doesn't flash the banner.

## Notifications (not in v1)

The groundwork is in place: every `edit_log` row carries `audience_json` with the
`personIds` and `teamIds` affected by that change — including both the old and
new audience when a block is reassigned. A push layer can read the log and fan
out without re-deriving who cared.
