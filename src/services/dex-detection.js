'use strict';

// Detect which DEXes a jetton master appears on.
//
// Source of truth is the cached DeDust bulk pool list (filtered locally by
// jetton master in raw form). STON.fi detection is a placeholder until step 9.
//
// Output shape:
//   {
//     dedust: { pools: [{ pool_address, jetton_master, paired_with, pool_type,
//                          base_decimals, quote_decimals,
//                          reserve_base, reserve_quote, trade_fee_bps }, ...] },
//     stonfi: { pools: [] },                 // wired in step 9
//     primary: { dex, pool, paired_with } | null
//   }
//
// "primary" is the pool with the largest reserve_quote (TON-side preferred),
// since DeDust does not return USD/TVL.

const { toRaw } = require('../lib/address');

const TON_NATIVE = 'TON';

function normalizeAssetForCompare(asset) {
  if (!asset) return null;
  if (asset.type === 'native') return { kind: 'native' };
  if (asset.type === 'jetton' && asset.address) {
    try { return { kind: 'jetton', raw: toRaw(asset.address) }; } catch { return null; }
  }
  return null;
}

function decimalsOf(asset) {
  if (!asset) return null;
  if (asset.type === 'native') return 9; // TON
  return asset.metadata?.decimals ?? null;
}

// Parse a single DeDust pool object into a row that mirrors our `trading_pools` schema.
// Returns null when the pool doesn't include the target jetton master.
function poolToRow(pool, targetRaw) {
  if (!pool || !Array.isArray(pool.assets) || pool.assets.length !== 2) return null;

  const aSides = pool.assets.map(normalizeAssetForCompare);
  if (aSides.some((s) => s == null)) return null;

  const matchIdx = aSides.findIndex((s) => s.kind === 'jetton' && s.raw === targetRaw);
  if (matchIdx === -1) return null;

  const otherIdx = matchIdx === 0 ? 1 : 0;
  const other = aSides[otherIdx];
  const pairedWith = other.kind === 'native' ? TON_NATIVE : other.raw;

  let poolAddrRaw;
  try { poolAddrRaw = toRaw(pool.address); } catch { return null; }

  const feeBps = pool.tradeFee != null ? Math.round(Number(pool.tradeFee) * 100) : null;

  return {
    pool_address:   poolAddrRaw,
    dex:            'dedust',
    jetton_master:  targetRaw,
    paired_with:    pairedWith,
    pool_type:      pool.type || null,
    base_decimals:  decimalsOf(pool.assets[matchIdx]),
    quote_decimals: decimalsOf(pool.assets[otherIdx]),
    reserve_base:   pool.reserves?.[matchIdx] ?? null,
    reserve_quote:  pool.reserves?.[otherIdx] ?? null,
    trade_fee_bps:  feeBps,
  };
}

function pickPrimary(pools) {
  if (!pools.length) return null;
  // Prefer TON-paired pools, then highest reserve_quote. Reserves are bigint strings.
  const tonPaired = pools.filter((p) => p.paired_with === TON_NATIVE);
  const pool = (tonPaired.length ? tonPaired : pools)
    .slice()
    .sort((a, b) => {
      const ra = a.reserve_quote ? BigInt(a.reserve_quote) : 0n;
      const rb = b.reserve_quote ? BigInt(b.reserve_quote) : 0n;
      return ra > rb ? -1 : ra < rb ? 1 : 0;
    })[0];
  if (!pool) return null;
  return { dex: pool.dex, pool: pool.pool_address, paired_with: pool.paired_with };
}

function makeDexDetection({ dedust, logger = null }) {
  async function detectDexes(jettonMasterRaw) {
    const targetRaw = toRaw(jettonMasterRaw);
    let allPools = [];
    try {
      allPools = await dedust.getPools();
    } catch (err) {
      if (logger) logger.warn('dex-detection: dedust.getPools failed', { err: err.message });
    }

    const dedustPools = [];
    for (const p of allPools) {
      const row = poolToRow(p, targetRaw);
      if (row) dedustPools.push(row);
    }

    const result = {
      dedust: { pools: dedustPools },
      stonfi: { pools: [] },
      primary: null,
    };
    result.primary = pickPrimary(dedustPools);
    return result;
  }

  return { detectDexes };
}

module.exports = {
  makeDexDetection,
  // exported for tests
  poolToRow,
  pickPrimary,
};
