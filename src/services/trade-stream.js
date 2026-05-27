'use strict';

// Real-time-ish trade stream — a singleton EventEmitter keyed by pool address.
//
// Design choice: poll DeDust /v2/pools/{addr}/trades on a short interval
// rather than subscribing to TonAPI's WebSocket. The trade-off is latency
// (~poll interval, default 8s) versus complexity. DeDust's REST endpoint
// already returns fully-parsed swap objects in the shape we want, so polling
// reuses the same normaliseDedustTrade pipeline as the REST `/trades` route.
// A push-based design via TonAPI would need a trace fetch + parse on every
// notification — significantly more upstream traffic + a separate parser.
//
// Lifecycle:
//   - `subscribe(poolAddress)` increments a refcount and returns an
//     `unsubscribe()` thunk. When refcount goes 0→1, the pool's poll timer
//     starts. When refcount drops 1→0, the timer is cleared.
//   - Each tick fetches the newest 50 trades, filters by `lt > lastSeenLt`,
//     persists new rows to the local `trades` table (INSERT OR IGNORE),
//     emits a `trade` event for each newly-seen row (newest-first within
//     the tick), and updates lastSeenLt + sync state.
//
// Events:
//   - `trade`  ({ pool: <raw>, data: <normalised trade row> })
//   - `error`  ({ pool, err })

const { EventEmitter } = require('events');
const { normalizeDedustTrade, normalizeTonapiSwap } = require('./trade-parser');
const { getTradingPool, insertTrades, setSyncState, getTradesRange } = require('../db');

const DEFAULT_INTERVAL_MS = 8_000;
const PAGE_SIZE_PER_TICK = 50;

class TradeStream extends EventEmitter {
  constructor({ dedust, db, tonapi = null, intervalMs = DEFAULT_INTERVAL_MS, logger = null } = {}) {
    super();
    if (!dedust) throw new Error('TradeStream requires a dedust client');
    if (!db)     throw new Error('TradeStream requires a db handle');
    this._dedust   = dedust;
    this._tonapi   = tonapi;
    this._db       = db;
    this._logger   = logger;
    this._interval = Math.max(1000, intervalMs);
    this._refcount = new Map();      // pool -> int
    this._timers   = new Map();      // pool -> Timeout
    this._lastLt   = new Map();      // pool -> BigInt (lt of newest seen)
    this._polling  = new Set();      // pools currently mid-tick (re-entrancy guard)
    this.setMaxListeners(0);
  }

  subscribe(poolAddress) {
    if (!poolAddress) throw new Error('poolAddress required');
    const count = (this._refcount.get(poolAddress) || 0) + 1;
    this._refcount.set(poolAddress, count);
    if (count === 1) this._start(poolAddress);
    let used = false;
    return () => {
      if (used) return;
      used = true;
      const next = (this._refcount.get(poolAddress) || 1) - 1;
      if (next <= 0) {
        this._refcount.delete(poolAddress);
        this._stop(poolAddress);
      } else {
        this._refcount.set(poolAddress, next);
      }
    };
  }

  refcountOf(poolAddress) { return this._refcount.get(poolAddress) || 0; }

  _start(poolAddress) {
    if (this._timers.has(poolAddress)) return;
    // Seed lastLt from the local DB so the first tick doesn't replay history.
    const recent = getTradesRange(this._db, poolAddress, { limit: 1 });
    if (recent.length > 0) {
      try { this._lastLt.set(poolAddress, BigInt(recent[0].lt)); } catch {}
    }
    if (this._logger) this._logger.info('trade-stream start', { pool: poolAddress, interval_ms: this._interval });
    // Fire one immediate tick, then schedule.
    this._tick(poolAddress).catch(() => {});
    const t = setInterval(() => this._tick(poolAddress).catch(() => {}), this._interval);
    if (t.unref) t.unref();  // don't keep the process alive on shutdown
    this._timers.set(poolAddress, t);
  }

  _stop(poolAddress) {
    const t = this._timers.get(poolAddress);
    if (t) clearInterval(t);
    this._timers.delete(poolAddress);
    this._lastLt.delete(poolAddress);
    if (this._logger) this._logger.info('trade-stream stop', { pool: poolAddress });
  }

  async _tick(poolAddress) {
    if (this._polling.has(poolAddress)) return;       // skip overlap
    if (this.refcountOf(poolAddress) === 0) return;   // raced with last unsubscribe
    this._polling.add(poolAddress);
    try {
      const poolRow = getTradingPool(this._db, poolAddress);
      if (!poolRow) return;

      // Two upstream sources merged per tick: DeDust REST (cheap, but lags on
      // low-volume pools) and TonAPI events (real-time, covers DeDust's gap).
      const lastLt = this._lastLt.get(poolAddress) || 0n;
      const fresh = [];

      try {
        const raw = await this._dedust.getPoolTrades(poolAddress, { pageSize: PAGE_SIZE_PER_TICK });
        for (const t of raw) {
          let ltb; try { ltb = BigInt(t.lt); } catch { continue; }
          if (ltb <= lastLt) continue;
          const row = normalizeDedustTrade(t, poolRow);
          if (row) fresh.push({ row, ltb });
        }
      } catch (err) {
        if (this._logger) this._logger.warn('trade-stream dedust poll failed', { pool: poolAddress, err: err.message });
      }

      if (this._tonapi) {
        try {
          const evResp = await this._tonapi.getAccountEvents(poolAddress, { limit: PAGE_SIZE_PER_TICK });
          for (const ev of (evResp?.events || [])) {
            if (ev.in_progress) continue;
            let ltb; try { ltb = BigInt(ev.lt); } catch { continue; }
            if (ltb <= lastLt) continue;
            for (const action of (ev.actions || [])) {
              if (action.type !== 'JettonSwap') continue;
              const row = normalizeTonapiSwap(ev, action, poolRow);
              if (row) fresh.push({ row, ltb });
            }
          }
        } catch (err) {
          if (this._logger) this._logger.warn('trade-stream tonapi poll failed', { pool: poolAddress, err: err.message });
        }
      }
      // Always bump last_checked_at — UI uses it to prove the stream is alive
      // even when the pool itself is quiet for hours.
      if (fresh.length === 0) {
        setSyncState(this._db, poolAddress, {});
        return;
      }

      // Persist in one transaction.
      const inserted = insertTrades(this._db, poolAddress, fresh.map((f) => f.row));

      // Update lastSeenLt + sync state.
      const newestLt = fresh.reduce((m, f) => (f.ltb > m ? f.ltb : m), lastLt);
      this._lastLt.set(poolAddress, newestLt);
      const newestTs = Math.max(...fresh.map((f) => f.row.ts));
      setSyncState(this._db, poolAddress, { newestTs });

      // Emit newest-first.
      fresh.sort((a, b) => (b.ltb > a.ltb ? 1 : b.ltb < a.ltb ? -1 : 0));
      for (const f of fresh) this.emit('trade', { pool: poolAddress, data: f.row });

      if (this._logger && inserted > 0) {
        this._logger.info('trade-stream tick', { pool: poolAddress, fresh: fresh.length, inserted });
      }
    } finally {
      this._polling.delete(poolAddress);
    }
  }

  // Tear down all timers — used during process shutdown / tests.
  shutdown() {
    for (const [pool] of this._timers) this._stop(pool);
    this._refcount.clear();
  }
}

function makeTradeStream(opts) { return new TradeStream(opts); }

module.exports = { TradeStream, makeTradeStream };
