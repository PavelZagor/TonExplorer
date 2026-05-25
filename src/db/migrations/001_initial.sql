-- Initial schema for TonExplorer.
-- See docs/03-developer-tracking.md for rationale and design notes.

CREATE TABLE IF NOT EXISTS developers (
  address       TEXT PRIMARY KEY,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  jettons_count INTEGER NOT NULL DEFAULT 0,
  rugs_count    INTEGER NOT NULL DEFAULT 0,
  alive_count   INTEGER NOT NULL DEFAULT 0,
  notes         TEXT,
  tag           TEXT
);

CREATE TABLE IF NOT EXISTS jettons (
  address       TEXT PRIMARY KEY,
  deployer      TEXT,
  admin         TEXT,
  symbol        TEXT,
  name          TEXT,
  decimals      INTEGER,
  supply        TEXT,
  deployed_at   INTEGER,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  fate          TEXT NOT NULL DEFAULT 'unknown',
  fate_reason   TEXT,
  FOREIGN KEY (deployer) REFERENCES developers(address)
);

CREATE INDEX IF NOT EXISTS idx_jettons_deployer ON jettons(deployer);
CREATE INDEX IF NOT EXISTS idx_jettons_fate     ON jettons(fate);

CREATE TABLE IF NOT EXISTS analyses (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  jetton       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  score        INTEGER,
  verdict_json TEXT NOT NULL,
  FOREIGN KEY (jetton) REFERENCES jettons(address)
);

CREATE INDEX IF NOT EXISTS idx_analyses_jetton  ON analyses(jetton);
CREATE INDEX IF NOT EXISTS idx_analyses_created ON analyses(created_at);
