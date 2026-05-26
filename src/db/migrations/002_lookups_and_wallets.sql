-- 002 — lookups history + user-managed wallet labels + wallet links.
--
-- Why three new tables instead of extending what we have:
--   * `analyses` (from 001) is a "verdict-per-call" record — small. `lookups` is
--     a richer snapshot we want to keep forever for time-series UI.
--   * `wallets` is a general address registry decoupled from `developers`
--     (which stays focused on jetton deployers). A holder, an LP, a CEX
--     hot wallet — they all live here with optional label/notes/tags.
--   * `wallet_links` lets us record "wallet A funded wallet B" / "cluster_with"
--     / "controls" so we can build farm / MEV-bot suspicion graphs.

CREATE TABLE IF NOT EXISTS lookups (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  jetton          TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  holders_count   INTEGER,
  top1_share      REAL,
  top10_share     REAL,
  signals_json    TEXT    NOT NULL DEFAULT '[]',
  source_ip       TEXT,
  FOREIGN KEY (jetton) REFERENCES jettons(address)
);
CREATE INDEX IF NOT EXISTS idx_lookups_jetton_time ON lookups(jetton, created_at DESC);

CREATE TABLE IF NOT EXISTS wallets (
  address       TEXT PRIMARY KEY,
  label         TEXT,
  notes         TEXT,
  tags          TEXT NOT NULL DEFAULT '[]',  -- JSON array of short strings, e.g. ["lp","mev"]
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wallet_links (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  from_addr     TEXT NOT NULL,
  to_addr       TEXT NOT NULL,
  kind          TEXT NOT NULL,   -- "funded_by" | "cluster_with" | "controls" | (free-form)
  notes         TEXT,
  created_at    INTEGER NOT NULL,
  UNIQUE(from_addr, to_addr, kind)
);
CREATE INDEX IF NOT EXISTS idx_wallet_links_from ON wallet_links(from_addr);
CREATE INDEX IF NOT EXISTS idx_wallet_links_to   ON wallet_links(to_addr);
