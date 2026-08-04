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
  liaison_contact_id TEXT REFERENCES contact_cards(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS people (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  role_id    TEXT NOT NULL REFERENCES roles(id),
  team_id    TEXT REFERENCES teams(id) ON DELETE SET NULL,
  contact_id TEXT REFERENCES contact_cards(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_people_role ON people(role_id);
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
