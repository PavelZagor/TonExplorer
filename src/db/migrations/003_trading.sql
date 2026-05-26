-- 003 — trading pools, trades, sync state.
--
-- Why this exists separately from the screening tables (001/002):
--   * Trading data has a different scale: a single jetton can have thousands
--     of trades; we want them in their own indexed surface, not bolted onto
--     `lookups` or `analyses`.
--   * The DEX is multi-source (DeDust now, STON.fi later) but the trade row
--     is shape-stable across DEXes once normalised, so one `trades` table is
--     enough.
--
-- Deviations from the original trading spec (docs/plans/2026-05-25-trading-feature.md):
--   * trade primary key is (pool_address, lt) instead of tx_hash — DeDust's
--     /v2/pools/{addr}/trades response does NOT include tx_hash. `lt` is the
--     logical time and is unique within an account.
--   * `raw_trace_json` is omitted (anti-pattern §12) — re-fetch traces on
--     demand if a debug path ever needs them.
--   * No `tvl_usd` / `price_usd` columns — DeDust's REST surface does not give
--     USD; the UI computes native-quote prices and a quote-jetton→USD overlay
--     in JS if/when that is wired.

CREATE TABLE IF NOT EXISTS trading_pools (
  pool_address    TEXT PRIMARY KEY,           -- raw form: 0:<64 hex>
  dex             TEXT NOT NULL,              -- 'dedust' | 'stonfi'
  jetton_master   TEXT NOT NULL,              -- raw form of the non-TON jetton side
  paired_with     TEXT NOT NULL,              -- 'TON' or raw form of the other jetton master
  pool_type       TEXT,                       -- 'volatile' | 'stable' (DeDust)
  base_decimals   INTEGER,                    -- decimals of jetton_master side
  quote_decimals  INTEGER,                    -- decimals of paired_with (9 for TON)
  reserve_base    TEXT,                       -- bigint as string, reserves[jetton_master]
  reserve_quote   TEXT,                       -- bigint as string, reserves[paired_with]
  trade_fee_bps   INTEGER,                    -- tradeFee * 100 (e.g. "0.25" -> 25)
  last_synced     INTEGER,                    -- unix seconds of the most recent /v2/pools refresh
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_trading_pools_jetton ON trading_pools(jetton_master);
CREATE INDEX IF NOT EXISTS idx_trading_pools_dex    ON trading_pools(dex);

CREATE TABLE IF NOT EXISTS trades (
  pool_address    TEXT    NOT NULL,
  lt              TEXT    NOT NULL,           -- 64-bit logical time as decimal string
  ts              INTEGER NOT NULL,           -- unix seconds (epoch)
  side            TEXT    NOT NULL,           -- 'buy' | 'sell' relative to jetton_master of the pool
  trader          TEXT    NOT NULL,           -- raw form
  asset_in        TEXT    NOT NULL,           -- 'TON' or jetton master raw
  asset_out       TEXT    NOT NULL,
  amount_in       TEXT    NOT NULL,           -- bigint as string, in raw token units
  amount_out      TEXT    NOT NULL,
  price_native    REAL,                       -- jetton price denominated in `paired_with` units
  PRIMARY KEY (pool_address, lt),
  FOREIGN KEY (pool_address) REFERENCES trading_pools(pool_address)
);
CREATE INDEX IF NOT EXISTS idx_trades_pool_ts ON trades(pool_address, ts DESC);
CREATE INDEX IF NOT EXISTS idx_trades_trader  ON trades(trader);

CREATE TABLE IF NOT EXISTS trading_sync_state (
  pool_address     TEXT PRIMARY KEY,
  oldest_synced_ts INTEGER,
  newest_synced_ts INTEGER,
  fully_synced     INTEGER NOT NULL DEFAULT 0,   -- 0 | 1
  FOREIGN KEY (pool_address) REFERENCES trading_pools(pool_address)
);
