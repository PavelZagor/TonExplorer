'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const { logger } = require('../lib/logger');

function openDb(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function runMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at INTEGER NOT NULL
    );
  `);

  const dir = path.join(__dirname, 'migrations');
  if (!fs.existsSync(dir)) return;

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Set(db.prepare('SELECT name FROM _migrations').all().map((r) => r.name));

  const stmt = db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)');
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const tx = db.transaction(() => {
      db.exec(sql);
      stmt.run(file, Math.floor(Date.now() / 1000));
    });
    tx();
    logger.info('migrated', { file });
  }
}

// --- Query helpers (Phase 0 set; grow as features land) ---

function upsertDeveloper(db, address) {
  const now = Math.floor(Date.now() / 1000);
  const stmt = db.prepare(`
    INSERT INTO developers (address, first_seen_at, last_seen_at, jettons_count, rugs_count, alive_count)
    VALUES (?, ?, ?, 0, 0, 0)
    ON CONFLICT(address) DO UPDATE SET last_seen_at = excluded.last_seen_at
  `);
  stmt.run(address, now, now);
  return db.prepare('SELECT * FROM developers WHERE address = ?').get(address);
}

function upsertJetton(db, jetton) {
  const now = Math.floor(Date.now() / 1000);
  const stmt = db.prepare(`
    INSERT INTO jettons (address, deployer, admin, symbol, name, decimals, supply, deployed_at, first_seen_at, last_seen_at, fate)
    VALUES (@address, @deployer, @admin, @symbol, @name, @decimals, @supply, @deployed_at, @first_seen_at, @last_seen_at, @fate)
    ON CONFLICT(address) DO UPDATE SET
      deployer    = COALESCE(jettons.deployer, excluded.deployer),
      admin       = excluded.admin,
      symbol      = excluded.symbol,
      name        = excluded.name,
      decimals    = excluded.decimals,
      supply      = excluded.supply,
      deployed_at = COALESCE(jettons.deployed_at, excluded.deployed_at),
      last_seen_at = excluded.last_seen_at
  `);
  stmt.run({
    address: jetton.address,
    deployer: jetton.deployer || null,
    admin: jetton.admin || null,
    symbol: jetton.symbol || null,
    name: jetton.name || null,
    decimals: jetton.decimals ?? null,
    supply: jetton.supply != null ? String(jetton.supply) : null,
    deployed_at: jetton.deployed_at || null,
    first_seen_at: now,
    last_seen_at: now,
    fate: jetton.fate || 'unknown',
  });
  return db.prepare('SELECT * FROM jettons WHERE address = ?').get(jetton.address);
}

function recordAnalysis(db, { jetton, score, verdict }) {
  const stmt = db.prepare(`
    INSERT INTO analyses (jetton, created_at, score, verdict_json) VALUES (?, ?, ?, ?)
  `);
  const info = stmt.run(jetton, Math.floor(Date.now() / 1000), score ?? null, JSON.stringify(verdict || {}));
  return info.lastInsertRowid;
}

function getDeveloper(db, address) {
  const row = db.prepare('SELECT * FROM developers WHERE address = ?').get(address);
  if (!row) return null;
  // Counts are derived from the jettons table on every read so they cannot drift
  // out of sync with the underlying data. The denormalized columns on `developers`
  // are kept (zero-default) so the schema doesn't break; a later migration can drop them.
  const counts = db
    .prepare(`
      SELECT
        COUNT(*)                                              AS jettons_count,
        SUM(CASE WHEN fate = 'rugged' THEN 1 ELSE 0 END)      AS rugs_count,
        SUM(CASE WHEN fate = 'alive'  THEN 1 ELSE 0 END)      AS alive_count
      FROM jettons WHERE deployer = ?
    `)
    .get(address);
  return {
    ...row,
    jettons_count: counts.jettons_count || 0,
    rugs_count:    counts.rugs_count    || 0,
    alive_count:   counts.alive_count   || 0,
  };
}

function listJettonsByDeployer(db, address) {
  return db
    .prepare('SELECT * FROM jettons WHERE deployer = ? ORDER BY deployed_at DESC NULLS LAST')
    .all(address);
}

// Full-text-ish search over `jettons.symbol` and `jettons.name`. The local
// table only contains jettons we've previously analysed, so this is the
// fast-path / recall side of the search; the route layer adds a TonAPI
// fallback on miss.
function searchJettons(db, q, limit = 10) {
  if (typeof q !== 'string' || q.trim().length === 0) return [];
  const needle = `%${q.trim().replace(/[%_]/g, (c) => '\\' + c)}%`;
  return db
    .prepare(`
      SELECT address, symbol, name, decimals, deployed_at, last_seen_at
      FROM jettons
      WHERE symbol LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\'
      ORDER BY last_seen_at DESC
      LIMIT ?
    `)
    .all(needle, needle, Math.max(1, Math.min(50, Math.trunc(limit))));
}

// --- Lookups (append-only snapshot history) ---

function recordLookup(db, { jetton, holders_count, top1_share, top10_share, signals, source_ip }) {
  const stmt = db.prepare(`
    INSERT INTO lookups (jetton, created_at, holders_count, top1_share, top10_share, signals_json, source_ip)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    jetton,
    Math.floor(Date.now() / 1000),
    holders_count ?? null,
    top1_share ?? null,
    top10_share ?? null,
    JSON.stringify(signals || []),
    source_ip || null,
  );
  return info.lastInsertRowid;
}

function getLookupHistory(db, jetton, limit = 50) {
  const rows = db
    .prepare('SELECT id, created_at, holders_count, top1_share, top10_share, signals_json FROM lookups WHERE jetton = ? ORDER BY created_at DESC LIMIT ?')
    .all(jetton, limit);
  return rows.map((r) => ({
    id: r.id,
    created_at: r.created_at,
    holders_count: r.holders_count,
    top1_share: r.top1_share,
    top10_share: r.top10_share,
    signals: safeParseJson(r.signals_json, []),
  }));
}

// --- Wallets (user-managed registry) ---

function getWallet(db, address) {
  const row = db.prepare('SELECT * FROM wallets WHERE address = ?').get(address);
  if (!row) return null;
  return { ...row, tags: safeParseJson(row.tags, []) };
}

// Bulk variant — returns Map<address, walletRow>. Missing addresses are absent from the map.
function getWallets(db, addresses) {
  const list = Array.from(new Set((addresses || []).filter((a) => typeof a === 'string' && a)));
  if (list.length === 0) return new Map();
  const placeholders = list.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM wallets WHERE address IN (${placeholders})`).all(...list);
  const out = new Map();
  for (const r of rows) out.set(r.address, { ...r, tags: safeParseJson(r.tags, []) });
  return out;
}

function upsertWallet(db, { address, label, notes, tags }) {
  const now = Math.floor(Date.now() / 1000);
  const tagsJson = JSON.stringify(Array.isArray(tags) ? tags : []);
  const stmt = db.prepare(`
    INSERT INTO wallets (address, label, notes, tags, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(address) DO UPDATE SET
      label      = excluded.label,
      notes      = excluded.notes,
      tags       = excluded.tags,
      updated_at = excluded.updated_at
  `);
  stmt.run(address, label ?? null, notes ?? null, tagsJson, now, now);
  return getWallet(db, address);
}

// --- Wallet links (relationships between addresses) ---

function listWalletLinks(db, address) {
  const out = db
    .prepare('SELECT id, from_addr, to_addr, kind, notes, created_at FROM wallet_links WHERE from_addr = ? ORDER BY created_at DESC')
    .all(address);
  const inc = db
    .prepare('SELECT id, from_addr, to_addr, kind, notes, created_at FROM wallet_links WHERE to_addr = ? ORDER BY created_at DESC')
    .all(address);
  return { outgoing: out, incoming: inc };
}

function upsertWalletLink(db, { from_addr, to_addr, kind, notes }) {
  const now = Math.floor(Date.now() / 1000);
  const stmt = db.prepare(`
    INSERT INTO wallet_links (from_addr, to_addr, kind, notes, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(from_addr, to_addr, kind) DO UPDATE SET
      notes = excluded.notes
  `);
  stmt.run(from_addr, to_addr, kind, notes ?? null, now);
  return db
    .prepare('SELECT id, from_addr, to_addr, kind, notes, created_at FROM wallet_links WHERE from_addr = ? AND to_addr = ? AND kind = ?')
    .get(from_addr, to_addr, kind);
}

function deleteWalletLink(db, id) {
  const info = db.prepare('DELETE FROM wallet_links WHERE id = ?').run(Number(id));
  return info.changes > 0;
}

// --- Trading: pools, trades, sync state ---

function upsertTradingPool(db, pool) {
  const now = Math.floor(Date.now() / 1000);
  const stmt = db.prepare(`
    INSERT INTO trading_pools (
      pool_address, dex, jetton_master, paired_with, pool_type,
      base_decimals, quote_decimals, reserve_base, reserve_quote,
      trade_fee_bps, last_synced
    )
    VALUES (
      @pool_address, @dex, @jetton_master, @paired_with, @pool_type,
      @base_decimals, @quote_decimals, @reserve_base, @reserve_quote,
      @trade_fee_bps, @last_synced
    )
    ON CONFLICT(pool_address) DO UPDATE SET
      dex            = excluded.dex,
      jetton_master  = excluded.jetton_master,
      paired_with    = excluded.paired_with,
      pool_type      = excluded.pool_type,
      base_decimals  = excluded.base_decimals,
      quote_decimals = excluded.quote_decimals,
      reserve_base   = excluded.reserve_base,
      reserve_quote  = excluded.reserve_quote,
      trade_fee_bps  = excluded.trade_fee_bps,
      last_synced    = excluded.last_synced
  `);
  stmt.run({
    pool_address:   pool.pool_address,
    dex:            pool.dex,
    jetton_master:  pool.jetton_master,
    paired_with:    pool.paired_with,
    pool_type:      pool.pool_type ?? null,
    base_decimals:  pool.base_decimals ?? null,
    quote_decimals: pool.quote_decimals ?? null,
    reserve_base:   pool.reserve_base != null ? String(pool.reserve_base) : null,
    reserve_quote:  pool.reserve_quote != null ? String(pool.reserve_quote) : null,
    trade_fee_bps:  pool.trade_fee_bps ?? null,
    last_synced:    pool.last_synced ?? now,
  });
  return db.prepare('SELECT * FROM trading_pools WHERE pool_address = ?').get(pool.pool_address);
}

function getTradingPool(db, poolAddress) {
  return db.prepare('SELECT * FROM trading_pools WHERE pool_address = ?').get(poolAddress) || null;
}

function listTradingPoolsByJetton(db, jettonMaster) {
  return db
    .prepare('SELECT * FROM trading_pools WHERE jetton_master = ? ORDER BY (CAST(reserve_quote AS REAL)) DESC')
    .all(jettonMaster);
}

// Insert-or-ignore by (pool_address, lt). Returns the number of rows actually inserted.
function insertTrades(db, poolAddress, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO trades (
      pool_address, lt, ts, side, trader,
      asset_in, asset_out, amount_in, amount_out, price_native
    ) VALUES (
      @pool_address, @lt, @ts, @side, @trader,
      @asset_in, @asset_out, @amount_in, @amount_out, @price_native
    )
  `);
  let inserted = 0;
  const tx = db.transaction((batch) => {
    for (const r of batch) {
      const info = stmt.run({
        pool_address: poolAddress,
        lt:           String(r.lt),
        ts:           Number(r.ts),
        side:         r.side,
        trader:       r.trader,
        asset_in:     r.asset_in,
        asset_out:    r.asset_out,
        amount_in:    String(r.amount_in),
        amount_out:   String(r.amount_out),
        price_native: r.price_native != null ? Number(r.price_native) : null,
      });
      inserted += info.changes;
    }
  });
  tx(rows);
  return inserted;
}

function getTradesRange(db, poolAddress, { before, limit = 100 } = {}) {
  if (before != null) {
    return db
      .prepare('SELECT * FROM trades WHERE pool_address = ? AND ts < ? ORDER BY ts DESC LIMIT ?')
      .all(poolAddress, Number(before), Math.max(1, Math.min(1000, limit)));
  }
  return db
    .prepare('SELECT * FROM trades WHERE pool_address = ? ORDER BY ts DESC LIMIT ?')
    .all(poolAddress, Math.max(1, Math.min(1000, limit)));
}

function getTradesBetween(db, poolAddress, fromTs, toTs) {
  return db
    .prepare('SELECT * FROM trades WHERE pool_address = ? AND ts >= ? AND ts < ? ORDER BY ts ASC')
    .all(poolAddress, Number(fromTs), Number(toTs));
}

function getSyncState(db, poolAddress) {
  return db.prepare('SELECT * FROM trading_sync_state WHERE pool_address = ?').get(poolAddress) || null;
}

function setSyncState(db, poolAddress, { oldestTs, newestTs, fullySynced }) {
  const prev = getSyncState(db, poolAddress);
  const oldest = oldestTs != null ? Number(oldestTs) : prev?.oldest_synced_ts ?? null;
  const newest = newestTs != null ? Number(newestTs) : prev?.newest_synced_ts ?? null;
  const fully  = fullySynced != null ? (fullySynced ? 1 : 0) : prev?.fully_synced ?? 0;
  const stmt = db.prepare(`
    INSERT INTO trading_sync_state (pool_address, oldest_synced_ts, newest_synced_ts, fully_synced)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(pool_address) DO UPDATE SET
      oldest_synced_ts = COALESCE(excluded.oldest_synced_ts, trading_sync_state.oldest_synced_ts),
      newest_synced_ts = COALESCE(excluded.newest_synced_ts, trading_sync_state.newest_synced_ts),
      fully_synced     = excluded.fully_synced
  `);
  stmt.run(poolAddress, oldest, newest, fully);
  return getSyncState(db, poolAddress);
}

// --- internals ---

function safeParseJson(s, fallback) {
  if (s == null) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

module.exports = {
  openDb,
  runMigrations,
  upsertDeveloper,
  upsertJetton,
  recordAnalysis,
  getDeveloper,
  listJettonsByDeployer,
  searchJettons,
  recordLookup,
  getLookupHistory,
  getWallet,
  getWallets,
  upsertWallet,
  listWalletLinks,
  upsertWalletLink,
  deleteWalletLink,
  // trading
  upsertTradingPool,
  getTradingPool,
  listTradingPoolsByJetton,
  insertTrades,
  getTradesRange,
  getTradesBetween,
  getSyncState,
  setSyncState,
};
