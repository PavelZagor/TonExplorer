'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

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
    // eslint-disable-next-line no-console
    console.log(`[ton-explorer] migrated ${file}`);
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
  return db.prepare('SELECT * FROM developers WHERE address = ?').get(address);
}

function listJettonsByDeployer(db, address) {
  return db
    .prepare('SELECT * FROM jettons WHERE deployer = ? ORDER BY deployed_at DESC NULLS LAST')
    .all(address);
}

module.exports = {
  openDb,
  runMigrations,
  upsertDeveloper,
  upsertJetton,
  recordAnalysis,
  getDeveloper,
  listJettonsByDeployer,
};
