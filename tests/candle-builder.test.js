'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildCandles, intervalSeconds, bucketOf } = require('../src/services/candle-builder');

test('intervalSeconds resolves named presets', () => {
  assert.equal(intervalSeconds('1m'),  60);
  assert.equal(intervalSeconds('5m'),  300);
  assert.equal(intervalSeconds('15m'), 900);
  assert.equal(intervalSeconds('1h'),  3600);
  assert.equal(intervalSeconds('4h'),  14400);
  assert.equal(intervalSeconds('1d'),  86400);
  assert.equal(intervalSeconds('99x'), null);
  assert.equal(intervalSeconds(45),    45);
});

test('bucketOf floors to bucket-start', () => {
  // ts=1716700063, interval=60 → bucket start at 1716700020
  assert.equal(bucketOf(1716700063, 60),  1716700020);
  assert.equal(bucketOf(1716700020, 60),  1716700020);
  assert.equal(bucketOf(1716700019, 60),  1716699960);
});

test('buildCandles groups by bucket, computes O/H/L/C', () => {
  // All three trades in the same 1m bucket (1716700020).
  const trades = [
    { ts: 1716700025, side: 'buy',  amount_in:  '1000000000', amount_out: '5000000', price_native: 0.500 },
    { ts: 1716700030, side: 'sell', amount_in:  '5000000',    amount_out: '1500000000', price_native: 0.600 },
    { ts: 1716700050, side: 'buy',  amount_in:  '2000000000', amount_out: '6000000', price_native: 0.450 },
  ];
  const out = buildCandles(trades, '1m', { quoteDecimals: 9 });
  assert.equal(out.length, 1);
  const c = out[0];
  assert.equal(c.time, 1716700020);
  assert.equal(c.open,  0.500);
  assert.equal(c.high,  0.600);
  assert.equal(c.low,   0.450);
  assert.equal(c.close, 0.450);
  // volume in TON units: buy uses amount_in (1.0 + 2.0), sell uses amount_out (1.5)
  // → 4.5 TON total.
  assert.equal(c.volume, 4.5);
});

test('buildCandles emits one candle per bucket, ascending', () => {
  const trades = [
    { ts: 1716700050, side: 'buy', amount_in: '1000000000', amount_out: '1', price_native: 1.0 },
    // 5 minutes later
    { ts: 1716700350, side: 'buy', amount_in: '1000000000', amount_out: '1', price_native: 2.0 },
    // 1 hour later
    { ts: 1716703650, side: 'buy', amount_in: '1000000000', amount_out: '1', price_native: 3.0 },
  ];
  const out1m = buildCandles(trades, '1m', { quoteDecimals: 9 });
  assert.equal(out1m.length, 3);
  assert.deepEqual(out1m.map((c) => c.time), [1716700020, 1716700320, 1716703620]);

  const out1h = buildCandles(trades, '1h', { quoteDecimals: 9 });
  assert.equal(out1h.length, 2);
  // First bucket has two trades → close = 2.0
  assert.equal(out1h[0].close, 2.0);
  // Second bucket has just the 3rd
  assert.equal(out1h[1].open, 3.0);
});

test('buildCandles skips trades without a finite price', () => {
  const trades = [
    { ts: 1716700050, side: 'buy', amount_in: '1', amount_out: '1', price_native: null },
    { ts: 1716700055, side: 'buy', amount_in: '1', amount_out: '1', price_native: NaN },
    { ts: 1716700060, side: 'buy', amount_in: '1', amount_out: '1', price_native: 0 },
    { ts: 1716700065, side: 'buy', amount_in: '1', amount_out: '1', price_native: 1.5 },
  ];
  const out = buildCandles(trades, '1m', { quoteDecimals: 9 });
  assert.equal(out.length, 1);
  assert.equal(out[0].open, 1.5);
  assert.equal(out[0].close, 1.5);
});

test('buildCandles handles unsorted input', () => {
  const trades = [
    { ts: 1716700300, side: 'buy', amount_in: '1', amount_out: '1', price_native: 3.0 },
    { ts: 1716700050, side: 'buy', amount_in: '1', amount_out: '1', price_native: 1.0 },
    { ts: 1716700150, side: 'buy', amount_in: '1', amount_out: '1', price_native: 2.0 },
  ];
  const out = buildCandles(trades, '1m', { quoteDecimals: 9 });
  // Three different 1m buckets, ascending.
  assert.deepEqual(out.map((c) => c.open),  [1.0, 2.0, 3.0]);
  assert.deepEqual(out.map((c) => c.close), [1.0, 2.0, 3.0]);
});

test('buildCandles returns [] on empty input', () => {
  assert.deepEqual(buildCandles([], '1m', { quoteDecimals: 9 }), []);
});

test('buildCandles throws on bad interval', () => {
  assert.throws(() => buildCandles([{ ts: 1, side: 'buy', amount_in: '1', amount_out: '1', price_native: 1 }], 'bogus'));
});
