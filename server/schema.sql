-- Royalty — live event schedule schema.
-- Deliberately source-agnostic: nothing here knows about Google Sheets, Excel, or
-- the upload endpoint. Importers normalize into these tables.

PRAGMA foreign_keys = ON;

-- Roles are data, not an enum in code. `selector` decides what the landing page
-- asks for after the role is picked: a team (dancers) or an individual name.
CREATE TABLE IF NOT EXISTS roles (
  id          TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  selector    TEXT NOT NULL CHECK (selector IN ('team', 'person')),
  blurb       TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS contact_cards (
  id     TEXT PRIMARY KEY,
  name   TEXT NOT NULL,
  title  TEXT,
  phone  TEXT,
  email  TEXT,
  note   TEXT
);

CREATE TABLE IF NOT EXISTS teams (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL UNIQUE,
  liaison_contact_id TEXT REFERENCES contact_cards(id) ON DELETE SET NULL,
  -- Running order, 1–8. Nullable until the draw happens, which is late.
  show_order         INTEGER
);

-- The unique index on show_order is created in migrate.js, not here: this file
-- runs first, and on a database that predates the column there is nothing to
-- index yet. Everything that depends on a migrated column belongs there.

CREATE TABLE IF NOT EXISTS people (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  team_id    TEXT REFERENCES teams(id) ON DELETE SET NULL,
  contact_id TEXT REFERENCES contact_cards(id) ON DELETE SET NULL
);

-- Roles are a many-to-many. There was a `people.role_id` column here; it is
-- gone rather than kept alongside, because two sources of truth for the same
-- fact diverge and then nobody knows which one the schedule query used.
--
-- Almost everyone holds exactly one role — the director confirmed the org chart
-- has no dual-hatting. The exception is captains, who hold `Dancer` + `Captain`
-- so that the three captain-only blocks can be role-targeted instead of
-- duplicated across 27 people. See docs/decisions.md.
CREATE TABLE IF NOT EXISTS person_roles (
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  role_id   TEXT NOT NULL REFERENCES roles(id),
  PRIMARY KEY (person_id, role_id)
);

CREATE INDEX IF NOT EXISTS idx_person_roles_role ON person_roles(role_id);
CREATE INDEX IF NOT EXISTS idx_people_team ON people(team_id);

CREATE TABLE IF NOT EXISTS locations (
  id           TEXT PRIMARY KEY,
  venue_name   TEXT NOT NULL,
  sub_location TEXT
);

-- Event days are rows, not a hardcoded Fri/Sat pair, so a third day can be added
-- without a migration. `date` anchors "now / next" to real wall-clock time.
CREATE TABLE IF NOT EXISTS event_days (
  key        TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  date       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS schedule_blocks (
  id              TEXT PRIMARY KEY,
  day             TEXT NOT NULL REFERENCES event_days(key),
  start_time      TEXT NOT NULL,   -- 'HH:MM', 24h
  end_time        TEXT NOT NULL,   -- 'HH:MM', 24h
  location_id     TEXT REFERENCES locations(id) ON DELETE SET NULL,
  activity_label  TEXT NOT NULL,
  applies_to_type TEXT NOT NULL CHECK (applies_to_type IN ('team', 'person', 'role')),
  applies_to_id   TEXT NOT NULL,
  notes           TEXT,
  source          TEXT NOT NULL DEFAULT 'manual',  -- 'manual' | 'import' | 'sheet'
  source_key      TEXT,            -- stable identity of the originating sheet row
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  last_change     TEXT             -- 'created' | 'updated' — drives the "changed" flag
);

CREATE INDEX IF NOT EXISTS idx_blocks_day ON schedule_blocks(day, start_time);
CREATE INDEX IF NOT EXISTS idx_blocks_target ON schedule_blocks(applies_to_type, applies_to_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_blocks_source_key
  ON schedule_blocks(source_key) WHERE source_key IS NOT NULL;

-- Every mutation lands here. `audience_json` records who was affected, which is
-- what a future push-notification layer needs to fan out per-user alerts.
CREATE TABLE IF NOT EXISTS edit_log (
  id                TEXT PRIMARY KEY,
  schedule_block_id TEXT,
  edited_by         TEXT NOT NULL,
  source            TEXT NOT NULL,
  timestamp         TEXT NOT NULL,
  change_type       TEXT NOT NULL,
  change_summary    TEXT NOT NULL,
  audience_json     TEXT
);

CREATE INDEX IF NOT EXISTS idx_editlog_time ON edit_log(timestamp DESC);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- When each block target last had something change under it.
--
-- "Last updated" used to be one global timestamp, so moving one team's warm-up
-- told all ~280 phones their schedule had just changed. It hadn't. The row key
-- is a block target — the same `type:id` pair that names a socket room and the
-- same list `blocksForTargets` ORs over — so a session's timestamp is the
-- newest of its own targets and nothing else.
--
-- Deliberately not derivable from `schedule_blocks.updated_at`: a deletion
-- leaves no row behind, and "your 3pm was cancelled" is exactly the change a
-- timestamp has to move for.
CREATE TABLE IF NOT EXISTS target_versions (
  target_type TEXT NOT NULL CHECK (target_type IN ('team', 'person', 'role')),
  target_id   TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (target_type, target_id)
);

-- Access codes are bearer tokens: holding one grants read access to that
-- subject's schedule and contact details. Stored in plaintext on purpose —
-- admins have to be able to read them back to distribute them, so hashing at
-- rest would break the product. The compensating controls are rate limiting on
-- attempts (item 6), one-click revoke, and an event-scoped lifetime.
--
-- `subject_id` deliberately has no foreign key: it points at teams, people or
-- roles depending on `subject_type`. Deleting a subject therefore leaves an
-- orphaned code — `listCodes()` surfaces those with a null label.
CREATE TABLE IF NOT EXISTS access_codes (
  code         TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('team', 'person', 'role')),
  subject_id   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT,
  note         TEXT
);

CREATE INDEX IF NOT EXISTS idx_access_codes_subject
  ON access_codes(subject_type, subject_id);

-- At most one live code per subject. Regenerating means revoking the old row and
-- inserting a new one, so revoked codes stay on the table as an audit trail:
-- "this leaked code was used at 14:02" is answerable after the fact.
CREATE UNIQUE INDEX IF NOT EXISTS idx_access_codes_one_active
  ON access_codes(subject_type, subject_id) WHERE revoked_at IS NULL;
