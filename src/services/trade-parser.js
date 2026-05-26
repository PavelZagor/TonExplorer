'use strict';

// Converts DEX-specific trade shapes to the normalised `trades` row shape used
// by the database and by the trading API.
//
// DeDust REST trade shape (from /v2/pools/{addr}/trades):
//   {
//     sender:    "EQ...",                        // trader friendly address
//     assetIn:   { type: 'native' | 'jetton', address?: 'EQ...' },
//     assetOut:  { type: 'native' | 'jetton', address?: 'EQ...' },
//     amountIn:  "34800000000",                  // string bigint, raw token units
//     amountOut: "87907744",
//     lt:        "75849656000005",               // 64-bit decimal string
//     createdAt: "2026-05-09T12:33:16.000Z"
//   }
//
// Our row shape (matches src/db/migrations/003_trading.sql):
//   {
//     lt, ts, side, trader,
//     asset_in, asset_out, amount_in, amount_out, price_native
//   }
// `side` is buy/sell relative to the pool's jetton_master ("buy" = jetton_master flows TO trader).
// `asset_in`/`asset_out` are 'TON' for native, otherwise the raw jetton master address.
// `price_native` is `paired_with` units per 1.0 unit of jetton_master (NaN safeguarded → null).
//
// This module will get a second parser in step 6 for TonAPI trace events; the
// output shape stays identical so downstream code (DB, route, frontend) needn't
// branch on data source.

const { toRaw } = require('../lib/address');

const TON = 'TON';

function assetToTag(asset) {
  if (!asset) return null;
  if (asset.type === 'native') return TON;
  if (asset.type === 'jetton' && asset.address) {
    try { return toRaw(asset.address); } catch { return null; }
  }
  return null;
}

function tsFromIso(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

// pool: a row from trading_pools with jetton_master / paired_with / *_decimals.
// Returns null when the trade can't be normalised (missing fields, asset mismatch, etc.).
function normalizeDedustTrade(t, pool) {
  if (!t || !pool) return null;
  if (t.amountIn == null || t.amountOut == null) return null;

  const inTag  = assetToTag(t.assetIn);
  const outTag = assetToTag(t.assetOut);
  if (!inTag || !outTag) return null;

  const ts = tsFromIso(t.createdAt);
  if (ts == null) return null;

  // Determine side relative to the pool's jetton_master. Trades not involving
  // this pair are skipped so a busy multi-asset pool can't leak unrelated swaps.
  const involvesMaster = inTag === pool.jetton_master || outTag === pool.jetton_master;
  if (!involvesMaster) return null;

  const side = outTag === pool.jetton_master ? 'buy' : 'sell';

  // price_native = quote-per-base. Both sides of a buy reverse those roles, so
  // assemble the numerator/denominator from the correct end.
  const baseDec  = pool.base_decimals  ?? null;
  const quoteDec = pool.quote_decimals ?? null;
  let priceNative = null;
  if (baseDec != null && quoteDec != null) {
    try {
      const aIn  = BigInt(t.amountIn);
      const aOut = BigInt(t.amountOut);
      if (aIn > 0n && aOut > 0n) {
        // (quote_units / 10^quoteDec) / (base_units / 10^baseDec)
        const quoteUnits = side === 'buy' ? aIn  : aOut;
        const baseUnits  = side === 'buy' ? aOut : aIn;
        const scale = 10 ** (baseDec - quoteDec);
        priceNative = (Number(quoteUnits) / Number(baseUnits)) * scale;
        if (!Number.isFinite(priceNative)) priceNative = null;
      }
    } catch { priceNative = null; }
  }

  let trader = null;
  try { trader = toRaw(t.sender); } catch { trader = String(t.sender || ''); }

  return {
    lt:           String(t.lt),
    ts,
    side,
    trader,
    asset_in:     inTag,
    asset_out:    outTag,
    amount_in:    String(t.amountIn),
    amount_out:   String(t.amountOut),
    price_native: priceNative,
  };
}

module.exports = {
  normalizeDedustTrade,
  // exported for testing
  assetToTag,
  tsFromIso,
};
