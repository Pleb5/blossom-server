-- Community-derived access whitelist.
-- The whitelist is refreshed from a configured community kind:10222 definition
-- and the exact kind:30000 profile lists referenced by that definition.
CREATE TABLE IF NOT EXISTS community_whitelist (
  community  TEXT(64) NOT NULL,
  pubkey     TEXT(64) NOT NULL,
  refreshed  INTEGER  NOT NULL,
  PRIMARY KEY (community, pubkey)
);

CREATE INDEX IF NOT EXISTS community_whitelist_pubkey ON community_whitelist (pubkey);

CREATE TABLE IF NOT EXISTS community_whitelist_state (
  community           TEXT(64) PRIMARY KEY,
  definition_id       TEXT(64),
  definition_created  INTEGER,
  refreshed           INTEGER NOT NULL DEFAULT 0,
  pubkey_count        INTEGER NOT NULL DEFAULT 0,
  last_error          TEXT
);
