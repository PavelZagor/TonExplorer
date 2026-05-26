'use strict';

const { toRaw, isValid } = require('../lib/address');
const {
  upsertTradingPool,
  listTradingPoolsByJetton,
  insertTrades,
  getTradesRange,
  getTradesBetween,
  getTradingPool,
  getSyncState,
  setSyncState,
  backfillTradePrices,
} = require('../db');
const { normalizeDedustTrade } = require('../services/trade-parser');
const { buildCandles, intervalSeconds, INTERVAL_PRESETS } = require('../services/candle-builder');

// If the pool row is missing decimals (DeDust's bulk /v2/pools returns null
// metadata for many jettons), fetch them from TonAPI and persist. Once we have
// them, retroactively recompute price_native for any trades that landed in
// the table with NULL while decimals were missing — otherwise the candle
// builder skips every trade and the chart stays empty.
async function ensurePoolDecimals(ctx, poolRow, log) {
  if (!poolRow || (poolRow.base_decimals != null && poolRow.quote_decimals != null)) return poolRow;
  const { db, tonapi } = ctx;
  let baseDec = poolRow.base_decimals;
  let quoteDec = poolRow.quote_decimals;

  if (baseDec == null && poolRow.jetton_master) {
    try {
      const j = await tonapi.getJetton(poolRow.jetton_master);
      if (j?.metadata?.decimals != null) baseDec = Number(j.metadata.decimals);
    } catch (err) {
      log?.warn?.('ensurePoolDecimals: tonapi.getJetton failed (base)', { jetton: poolRow.jetton_master, err: err.message });
    }
  }
  if (quoteDec == null) {
    if (poolRow.paired_with === 'TON') quoteDec = 9;
    else {
      try {
        const j = await tonapi.getJetton(poolRow.paired_with);
        if (j?.metadata?.decimals != null) quoteDec = Number(j.metadata.decimals);
      } catch (err) {
        log?.warn?.('ensurePoolDecimals: tonapi.getJetton failed (quote)', { jetton: poolRow.paired_with, err: err.message });
      }
    }
  }

  if (baseDec === poolRow.base_decimals && quoteDec === poolRow.quote_decimals) return poolRow;

  const updated = upsertTradingPool(db, {
    ...poolRow,
    base_decimals: baseDec,
    quote_decimals: quoteDec,
  });
  const backfilled = backfillTradePrices(db, updated);
  if (backfilled > 0 && log) log.info?.('pool decimals enriched + prices backfilled', { pool: updated.pool_address, backfilled, base_decimals: baseDec, quote_decimals: quoteDec });
  return updated;
}

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

    // Enrich the primary pool's decimals via TonAPI when DeDust left them
    // null. This is best-effort and only runs for the primary pool — that's
    // the one the trading page will hit for trades/candles. Non-primary pools
    // will be enriched on demand when they're addressed via ?pool=.
    if (detection.primary && persistedPools.length > 0) {
      const primaryRow = persistedPools.find((p) => p.pool_address === detection.primary.pool);
      if (primaryRow) {
        try {
          const enriched = await ensurePoolDecimals(ctx, primaryRow, req.log || logger);
          const idx = persistedPools.indexOf(primaryRow);
          if (idx >= 0) persistedPools[idx] = enriched;
        } catch (err) {
          (req.log || logger)?.warn('ensurePoolDecimals failed', { err: err.message });
        }
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

    // Make sure decimals are present before we normalise + persist trades —
    // otherwise price_native lands as NULL and the chart stays empty forever.
    try { poolRow = await ensurePoolDecimals(ctx, poolRow, req.log); }
    catch (err) { req.log?.warn('ensurePoolDecimals failed', { err: err.message }); }

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

// GET /api/trading/:jetton/candles?interval=1m|5m|15m|1h|4h|1d&from=&to=&pool=
// Builds OHLCV candles in memory from rows currently in `trades`. Does NOT
// refresh from DeDust — clients are expected to hit /trades first (or rely on
// the WS stream) to keep the local table warm. Default window: last 24h.
function candlesHandler(ctx) {
  const { db, dexDetection } = ctx;
  return async function candles(req, res) {
    const input = req.params.jetton;
    if (!isValid(input)) {
      return res.status(400).json({ ok: false, error: { code: 'bad_address', message: 'invalid TON address' } });
    }
    const jettonRaw = toRaw(input);

    const intervalName = String(req.query.interval || '1h');
    const ivl = intervalSeconds(intervalName);
    if (!ivl) {
      return res.status(400).json({
        ok: false,
        error: { code: 'bad_interval', message: `interval must be one of: ${Object.keys(INTERVAL_PRESETS).join(', ')}` },
      });
    }

    const now = Math.floor(Date.now() / 1000);
    const toTs   = toInt(req.query.to)   ?? now;
    const fromTs = toInt(req.query.from) ?? (toTs - 24 * 3600);
    if (fromTs >= toTs) {
      return res.status(400).json({ ok: false, error: { code: 'bad_range', message: 'from must be < to' } });
    }

    let poolRow = null;
    if (req.query.pool) {
      try { poolRow = getTradingPool(db, toRaw(req.query.pool)); } catch {}
      if (!poolRow) {
        return res.status(404).json({ ok: false, error: { code: 'pool_not_found', message: 'no such pool in registry — load /info first' } });
      }
    } else {
      // Find primary via detection (cached).
      let detection;
      try { detection = await dexDetection.detectDexes(jettonRaw); }
      catch (err) {
        req.log?.warn('dex-detection failed', { jetton: jettonRaw, err: err.message });
        return res.status(502).json({ ok: false, error: { code: 'upstream_unavailable', message: 'dex registry unreachable' } });
      }
      if (!detection.primary) {
        return res.status(404).json({ ok: false, error: { code: 'not_listed', message: 'jetton is not on any tracked DEX' } });
      }
      poolRow = getTradingPool(db, detection.primary.pool);
    }

    // Ensure decimals — also retroactively backfills price_native on any
    // existing trades for this pool that landed with NULL.
    try { poolRow = await ensurePoolDecimals(ctx, poolRow, req.log); }
    catch (err) { req.log?.warn('ensurePoolDecimals failed', { err: err.message }); }

    const rows = getTradesBetween(db, poolRow.pool_address, fromTs, toTs);
    const series = buildCandles(rows, ivl, { quoteDecimals: poolRow.quote_decimals ?? null });

    res.json({
      ok: true,
      data: {
        jetton_master: jettonRaw,
        pool: poolView(poolRow),
        interval: intervalName,
        interval_seconds: ivl,
        from: fromTs,
        to: toTs,
        candles: series,
      },
    });
  };
}

module.exports = { infoHandler, tradesHandler, candlesHandler };
