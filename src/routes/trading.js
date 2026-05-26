'use strict';

const { toRaw, isValid } = require('../lib/address');
const {
  upsertTradingPool,
  listTradingPoolsByJetton,
  insertTrades,
  getTradesRange,
  getTradingPool,
  getSyncState,
  setSyncState,
} = require('../db');
const { normalizeDedustTrade } = require('../services/trade-parser');

const POOL_PREVIEW_LIMIT = 10;

function sortPoolsForPreview(pools) {
  return pools.slice().sort((a, b) => {
    const tonA = a.paired_with === 'TON' ? 1 : 0;
    const tonB = b.paired_with === 'TON' ? 1 : 0;
    if (tonA !== tonB) return tonB - tonA;
    const ra = a.reserve_quote ? BigInt(a.reserve_quote) : 0n;
    const rb = b.reserve_quote ? BigInt(b.reserve_quote) : 0n;
    return ra > rb ? -1 : ra < rb ? 1 : 0;
  });
}

// GET /api/trading/:jetton/info
// Returns: { jetton_master, dexes: ['dedust', ...], primary, pools: [...] }
function infoHandler(ctx) {
  const { db, dexDetection, logger } = ctx;
  return async function info(req, res) {
    const input = req.params.jetton;
    if (!isValid(input)) {
      return res.status(400).json({ ok: false, error: { code: 'bad_address', message: 'invalid TON address' } });
    }
    const jettonRaw = toRaw(input);

    let detection;
    try {
      detection = await dexDetection.detectDexes(jettonRaw);
    } catch (err) {
      req.log?.warn('dex-detection failed', { jetton: jettonRaw, err: err.message });
      return res.status(502).json({ ok: false, error: { code: 'upstream_unavailable', message: 'dex registry unreachable' } });
    }

    const dexes = [];
    if (detection.dedust.pools.length > 0) dexes.push('dedust');
    if (detection.stonfi.pools.length > 0) dexes.push('stonfi');

    // Persist every detected pool so trades/candles can write against a known FK.
    // The /info response itself trims to the top POOL_PREVIEW_LIMIT pools by
    // reserve_quote (TON-paired preferred via pickPrimary order) — clients that
    // need the full list can ask /trades?pool=... for any persisted pool.
    let totalPools = 0;
    const persistedPools = [];
    for (const p of detection.dedust.pools) {
      try {
        const row = upsertTradingPool(db, p);
        persistedPools.push(row);
        totalPools++;
      } catch (err) {
        (req.log || logger)?.warn('upsertTradingPool failed', { pool: p.pool_address, err: err.message });
      }
    }

    const trimmed = sortPoolsForPreview(persistedPools).slice(0, POOL_PREVIEW_LIMIT);

    res.json({
      ok: true,
      data: {
        jetton_master: jettonRaw,
        dexes,
        primary: detection.primary,    // { dex, pool, paired_with } | null
        pools: trimmed.map(poolView),
        pool_count: totalPools,
        url: dexes.length ? `${ctx.config.basePath}/trading/${jettonRaw}` : null,
      },
    });
  };
}

// GET /api/trading/:jetton/trades?limit=100&before=<unix_seconds>&pool=<raw>
// Backfills from DeDust on cache-miss, persists with INSERT OR IGNORE, returns
// from local DB in newest-first order.
function tradesHandler(ctx) {
  const { db, dedust, dexDetection, config, logger } = ctx;
  return async function trades(req, res) {
    const input = req.params.jetton;
    if (!isValid(input)) {
      return res.status(400).json({ ok: false, error: { code: 'bad_address', message: 'invalid TON address' } });
    }
    const jettonRaw = toRaw(input);

    const limit  = clampInt(req.query.limit, 1, 500, 100);
    const before = req.query.before != null ? toInt(req.query.before) : null;

    // Resolve which pool to query. If the client passes ?pool=..., we honour
    // that (lets the UI surface non-primary pools). Otherwise primary wins.
    let poolRow = null;
    if (req.query.pool) {
      try { poolRow = getTradingPool(db, toRaw(req.query.pool)); } catch {}
      if (!poolRow) {
        return res.status(404).json({ ok: false, error: { code: 'pool_not_found', message: 'no such pool in registry — load /info first' } });
      }
    } else {
      // No pool param — derive primary via detection. Cached, fast on the second call.
      let detection;
      try {
        detection = await dexDetection.detectDexes(jettonRaw);
      } catch (err) {
        req.log?.warn('dex-detection failed', { jetton: jettonRaw, err: err.message });
        return res.status(502).json({ ok: false, error: { code: 'upstream_unavailable', message: 'dex registry unreachable' } });
      }
      if (!detection.primary) {
        return res.status(404).json({ ok: false, error: { code: 'not_listed', message: 'jetton is not on any tracked DEX' } });
      }
      // Persist pools if a previous /info didn't already.
      for (const p of detection.dedust.pools) {
        try { upsertTradingPool(db, p); } catch {}
      }
      poolRow = getTradingPool(db, detection.primary.pool);
    }

    // Refresh from DeDust. Only refresh on no-`before` (newest page) — when the
    // user is scrolling backwards we already have the older trades cached.
    let fetchedCount = 0;
    if (!before && poolRow.dex === 'dedust') {
      const pageSize = Math.min(limit, config.tradingBackfillLimit);
      try {
        const upstream = await dedust.getPoolTrades(poolRow.pool_address, { pageSize });
        const normalised = upstream
          .map((t) => normalizeDedustTrade(t, poolRow))
          .filter(Boolean);
        if (normalised.length) {
          insertTrades(db, poolRow.pool_address, normalised);
          fetchedCount = normalised.length;
          const newestTs = Math.max(...normalised.map((n) => n.ts));
          const oldestTs = Math.min(...normalised.map((n) => n.ts));
          setSyncState(db, poolRow.pool_address, { oldestTs, newestTs });
        }
      } catch (err) {
        // Surface upstream failures but still serve whatever is in the local DB.
        req.log?.warn('dedust.getPoolTrades failed', { pool: poolRow.pool_address, err: err.message });
      }
    }

    const localRows = getTradesRange(db, poolRow.pool_address, { limit, before });
    const sync = getSyncState(db, poolRow.pool_address);

    res.json({
      ok: true,
      data: {
        jetton_master: jettonRaw,
        pool: poolView(poolRow),
        sync,
        fetched: fetchedCount,
        trades: localRows.map(tradeView),
      },
    });
  };
}

// --- view helpers (DB row → API shape) ---

function poolView(row) {
  if (!row) return null;
  return {
    address: row.pool_address,
    dex: row.dex,
    paired_with: row.paired_with,
    pool_type: row.pool_type,
    base_decimals: row.base_decimals,
    quote_decimals: row.quote_decimals,
    reserve_base: row.reserve_base,
    reserve_quote: row.reserve_quote,
    trade_fee_bps: row.trade_fee_bps,
    last_synced: row.last_synced,
  };
}

function tradeView(row) {
  return {
    lt: row.lt,
    ts: row.ts,
    side: row.side,
    trader: row.trader,
    asset_in: row.asset_in,
    asset_out: row.asset_out,
    amount_in: row.amount_in,
    amount_out: row.amount_out,
    price_native: row.price_native,
  };
}

// --- input coercion ---

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function clampInt(v, min, max, dflt) {
  const n = toInt(v);
  if (n == null) return dflt;
  return Math.max(min, Math.min(max, n));
}

module.exports = { infoHandler, tradesHandler };
