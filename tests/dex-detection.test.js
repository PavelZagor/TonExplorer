'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  makeDexDetection,
  poolToRow,
  pickPrimary,
} = require('../src/services/dex-detection');
const { toRaw } = require('../src/lib/address');

// USD₮ jetton master (https://tonviewer.com/EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs)
const USDT_FRIENDLY = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';
const USDT_RAW = toRaw(USDT_FRIENDLY);

// Synthetic pool in the shape /v2/pools returns.
function tonUsdtPool({ address, reserve_ton, reserve_usdt, tradeFee = '0.25' }) {
  return {
    address,
    lt: '0',
    totalSupply: '0',
    type: 'volatile',
    tradeFee,
    assets: [
      { type: 'native', metadata: { symbol: 'TON', decimals: 9 } },
      { type: 'jetton', address: USDT_FRIENDLY, metadata: { symbol: 'USDT', decimals: 6 } },
    ],
    lastPrice: null,
    reserves: [String(reserve_ton), String(reserve_usdt)],
    stats: { fees: ['0', '0'], volume: ['0', '0'] },
  };
}

// A pool that doesn't involve USDT — should be filtered out.
function unrelatedPool() {
  return {
    address: 'EQAAABGlCyy4Vd1Vly6ifo-7dsPq8TWRhyOEmw5b22nq5lY3',
    lt: '0', totalSupply: '0', type: 'volatile', tradeFee: '0.25',
    assets: [
      { type: 'native', metadata: { symbol: 'TON', decimals: 9 } },
      { type: 'jetton', address: 'EQCeukYgHmFOtvhfUdQXXyE3K2Conq2uX7zONaO-Rvk6QNxL', metadata: null },
    ],
    lastPrice: null, reserves: ['1', '1'], stats: { fees: ['0', '0'], volume: ['0', '0'] },
  };
}

test('poolToRow extracts TON-paired pool fields', () => {
  const p = tonUsdtPool({ address: 'EQA-X_yo3fzzbDbJ_0bzFWKqtRuZFIRa1sJsveZJ1YpViO3r', reserve_ton: '178893260060099', reserve_usdt: '452263886221', tradeFee: '0.10' });
  const row = poolToRow(p, USDT_RAW);
  assert.ok(row, 'returns a row');
  assert.equal(row.dex, 'dedust');
  assert.equal(row.jetton_master, USDT_RAW);
  assert.equal(row.paired_with, 'TON');
  assert.equal(row.pool_type, 'volatile');
  assert.equal(row.base_decimals, 6);     // USDT
  assert.equal(row.quote_decimals, 9);    // TON
  assert.equal(row.reserve_base, '452263886221');
  assert.equal(row.reserve_quote, '178893260060099');
  assert.equal(row.trade_fee_bps, 10);
});

test('poolToRow returns null when target jetton is not in the pool', () => {
  const row = poolToRow(unrelatedPool(), USDT_RAW);
  assert.equal(row, null);
});

test('poolToRow rejects pools with anything other than two sides', () => {
  const malformed = { ...tonUsdtPool({ address: 'EQAAABGlCyy4Vd1Vly6ifo-7dsPq8TWRhyOEmw5b22nq5lY3', reserve_ton: '1', reserve_usdt: '1' }), assets: [] };
  assert.equal(poolToRow(malformed, USDT_RAW), null);
});

test('pickPrimary prefers TON-paired with largest reserve_quote', () => {
  const a = poolToRow(tonUsdtPool({ address: 'EQA-X_yo3fzzbDbJ_0bzFWKqtRuZFIRa1sJsveZJ1YpViO3r', reserve_ton: '1000', reserve_usdt: '1' }), USDT_RAW);
  const b = poolToRow(tonUsdtPool({ address: 'EQABLFjyYTIO9F80MJ7LeCDs3X87e1JDnJzY0q7QtLaB46Ga', reserve_ton: '9000', reserve_usdt: '1' }), USDT_RAW);
  const c = poolToRow(tonUsdtPool({ address: 'EQAA-kQzmG37H231nWkJPVZ5pguKjfrIqQ7rDp1NhTir6vOm', reserve_ton: '50',   reserve_usdt: '1' }), USDT_RAW);
  const primary = pickPrimary([a, b, c]);
  assert.equal(primary.pool, b.pool_address);
  assert.equal(primary.paired_with, 'TON');
  assert.equal(primary.dex, 'dedust');
});

test('pickPrimary returns null for empty pool list', () => {
  assert.equal(pickPrimary([]), null);
});

test('detectDexes accepts friendly OR raw input, returns empty result for unlisted jetton', async () => {
  const dedust = { getPools: async () => [unrelatedPool()] };
  const det = makeDexDetection({ dedust });

  const friendly = await det.detectDexes(USDT_FRIENDLY);
  assert.deepEqual(friendly.dedust.pools, []);
  assert.equal(friendly.primary, null);
  assert.deepEqual(friendly.stonfi.pools, []);

  const raw = await det.detectDexes(USDT_RAW);
  assert.deepEqual(raw.dedust.pools, []);
});

test('detectDexes finds matching pools and picks primary', async () => {
  const pools = [
    unrelatedPool(),
    tonUsdtPool({ address: 'EQA-X_yo3fzzbDbJ_0bzFWKqtRuZFIRa1sJsveZJ1YpViO3r', reserve_ton: '178893260060099', reserve_usdt: '452263886221', tradeFee: '0.10' }),
    tonUsdtPool({ address: 'EQAA-kQzmG37H231nWkJPVZ5pguKjfrIqQ7rDp1NhTir6vOm', reserve_ton: '100',              reserve_usdt: '1' }),
  ];
  const dedust = { getPools: async () => pools };
  const det = makeDexDetection({ dedust });

  const result = await det.detectDexes(USDT_FRIENDLY);
  assert.equal(result.dedust.pools.length, 2);
  assert.equal(result.primary.paired_with, 'TON');
  // Largest reserve_quote of the two TON pools wins.
  assert.equal(result.primary.pool, toRaw('EQA-X_yo3fzzbDbJ_0bzFWKqtRuZFIRa1sJsveZJ1YpViO3r'));
});

test('detectDexes survives a failing upstream and returns empty result', async () => {
  const dedust = { getPools: async () => { throw new Error('boom'); } };
  const det = makeDexDetection({ dedust, logger: { warn() {}, info() {} } });
  const r = await det.detectDexes(USDT_FRIENDLY);
  assert.deepEqual(r.dedust.pools, []);
  assert.equal(r.primary, null);
});
