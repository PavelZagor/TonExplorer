'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { makeDexDetection, stonfiPoolToRow } = require('../src/services/dex-detection');
const { TON_PSEUDO_RAW } = require('../src/services/stonfi-client');
const { toRaw } = require('../src/lib/address');

const USDT = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';
const USDT_RAW = toRaw(USDT);
const TON_PSEUDO_FRIENDLY = 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c';

function stonfiPool({ address = 'EQCGScrZe1xbyWqWDvdI6mzP-GAcAWFv6ZXuaJOuSqemxku4', token0 = USDT, token1 = TON_PSEUDO_FRIENDLY, deprecated = false } = {}) {
  return {
    address,
    router_address: 'EQCS4UEa5UaJLzOyyKieqQOQ2P9M-7kXpkO5HnP3Bv250cN3',
    reserve0: '3419195175752',
    reserve1: '1786280346522621',
    token0_address: token0,
    token1_address: token1,
    lp_total_supply_usd: '6827684.27',
    volume_24h_usd: '5337292.09',
    deprecated,
  };
}

test('stonfiPoolToRow extracts a TON pair', () => {
  const row = stonfiPoolToRow(stonfiPool(), USDT_RAW);
  assert.ok(row);
  assert.equal(row.dex, 'stonfi');
  assert.equal(row.jetton_master, USDT_RAW);
  assert.equal(row.paired_with, 'TON');
  assert.equal(row.volume_24h_usd, 5337292.09);
});

test('stonfiPoolToRow skips deprecated pools', () => {
  const row = stonfiPoolToRow(stonfiPool({ deprecated: true }), USDT_RAW);
  assert.equal(row, null);
});

test('stonfiPoolToRow returns null when jetton not in pool', () => {
  const row = stonfiPoolToRow(stonfiPool({ token0: 'EQAARDfJOZ_vrcDVS3BGzaGMh3772H7n4KJiV3_o4gR9COO-', token1: 'EQAARDfJOZ_vrcDVS3BGzaGMh3772H7n4KJiV3_o4gR9COO-' }), USDT_RAW);
  assert.equal(row, null);
});

test('detectDexes merges DeDust + STON.fi results', async () => {
  const dedust = { getPools: async () => [] };
  const stonfi = { getPools: async () => [stonfiPool()] };
  const det = makeDexDetection({ dedust, stonfi });
  const r = await det.detectDexes(USDT);
  assert.deepEqual(r.dedust.pools, []);
  assert.equal(r.stonfi.pools.length, 1);
  // primary stays null since DeDust had no pools (stonfi is detection-only)
  assert.equal(r.primary, null);
});

test('detectDexes survives stonfi upstream failure', async () => {
  const dedust = { getPools: async () => [] };
  const stonfi = { getPools: async () => { throw new Error('boom'); } };
  const det = makeDexDetection({ dedust, stonfi, logger: { warn() {} } });
  const r = await det.detectDexes(USDT);
  assert.deepEqual(r.stonfi.pools, []);
});

test('TON_PSEUDO_RAW is the all-zeros raw form', () => {
  assert.equal(TON_PSEUDO_RAW, '0:0000000000000000000000000000000000000000000000000000000000000000');
  assert.equal(toRaw(TON_PSEUDO_FRIENDLY), TON_PSEUDO_RAW);
});
