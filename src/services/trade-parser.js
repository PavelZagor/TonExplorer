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

// TonAPI account-events shape (from /v2/accounts/{pool}/events). Each event
// can contain multiple actions; we only care about ones with type === 'JettonSwap'.
// The JettonSwap object looks like:
//   {
//     dex: 'dedust' | 'stonfi',
//     amount_in:  '<bigint string>' | '',     // in jetton_master_in units (when not TON)
//     amount_out: '<bigint string>' | '',     // in jetton_master_out units (when not TON)
//     ton_in:  <number, nanotons> | 0,
//     ton_out: <number, nanotons> | 0,
//     user_wallet: { address: '0:...' | 'EQ...' },
//     router:      { address: '0:...' | 'EQ...' },
//     jetton_master_in?:  { address, decimals, ... },
//     jetton_master_out?: { address, decimals, ... },
//   }
//
// Used as the recency fallback when DeDust's /v2/pools/{addr}/trades feed lags
// (as it does for many low-volume pools — e.g. SCAT had its last DeDust trade
// 17 days before a JettonSwap event was visible on TonAPI).
function normalizeTonapiSwap(event, action, poolRow) {
  if (!event || !action || !poolRow) return null;
  const sw = action.JettonSwap;
  if (!sw) return null;

  // Resolve asset_in / amount_in.
  let assetIn, amountIn;
  if (sw.ton_in && Number(sw.ton_in) > 0) {
    assetIn = 'TON';
    amountIn = String(sw.ton_in);
  } else if (sw.jetton_master_in?.address && sw.amount_in) {
    try { assetIn = toRaw(sw.jetton_master_in.address); } catch { return null; }
    amountIn = String(sw.amount_in);
  } else {
    return null;
  }

  // Resolve asset_out / amount_out.
  let assetOut, amountOut;
  if (sw.ton_out && Number(sw.ton_out) > 0) {
    assetOut = 'TON';
    amountOut = String(sw.ton_out);
  } else if (sw.jetton_master_out?.address && sw.amount_out) {
    try { assetOut = toRaw(sw.jetton_master_out.address); } catch { return null; }
    amountOut = String(sw.amount_out);
  } else {
    return null;
  }

  // Drop swaps that don't involve this pool's base jetton.
  if (assetIn !== poolRow.jetton_master && assetOut !== poolRow.jetton_master) return null;
  const side = assetOut === poolRow.jetton_master ? 'buy' : 'sell';

  // Use pool row's decimals (already enriched via TonAPI by ensurePoolDecimals).
  // Fall back to the action's own jetton_master_*.decimals when present.
  const baseDec = poolRow.base_decimals
    ?? (assetIn === poolRow.jetton_master ? sw.jetton_master_in?.decimals : sw.jetton_master_out?.decimals)
    ?? null;
  const quoteDec = poolRow.quote_decimals ?? (poolRow.paired_with === 'TON' ? 9 : null);
  let priceNative = null;
  if (baseDec != null && quoteDec != null) {
    try {
      const aIn = BigInt(amountIn);
      const aOut = BigInt(amountOut);
      if (aIn > 0n && aOut > 0n) {
        const quoteUnits = side === 'buy' ? aIn  : aOut;
        const baseUnits  = side === 'buy' ? aOut : aIn;
        const scale = 10 ** (baseDec - quoteDec);
        priceNative = (Number(quoteUnits) / Number(baseUnits)) * scale;
        if (!Number.isFinite(priceNative)) priceNative = null;
      }
    } catch { priceNative = null; }
  }

  let trader = null;
  try { trader = toRaw(sw.user_wallet?.address || ''); } catch { trader = String(sw.user_wallet?.address || ''); }

  return {
    lt:           String(event.lt),
    ts:           Number(event.timestamp),
    side,
    trader,
    asset_in:     assetIn,
    asset_out:    assetOut,
    amount_in:    amountIn,
    amount_out:   amountOut,
    price_native: priceNative,
  };
}

module.exports = {
  normalizeDedustTrade,
  normalizeTonapiSwap,
  // exported for testing
  assetToTag,
  tsFromIso,
};
