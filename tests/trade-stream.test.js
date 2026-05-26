'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { openDb, runMigrations, upsertTradingPool } = require('../src/db');
const { TradeStream } = require('../src/services/trade-stream');

// USDT raw form (no need to import toRaw here; we just need any valid raw)
const POOL_RAW   = '0:3e5ffca8ddfcf36c36c9ff46f31562aab51b9914845ad6c26cbde649d58a5588';
const JETTON_RAW = '0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe';

function makeTmpDb() {
  const f = path.join('/tmp', `explorer-stream-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  const db = openDb(f);
  runMigrations(db);
  upsertTradingPool(db, {
    pool_address: POOL_RAW,
    dex: 'dedust',
    jetton_master: JETTON_RAW,
    paired_with: 'TON',
    pool_type: 'volatile',
    base_decimals: 6,
    quote_decimals: 9,
    reserve_base: '1', reserve_quote: '1', trade_fee_bps: 10,
  });
  return { db, file: f };
}

function fakeDedustTrade(lt, side = 'buy', tsMs = Date.now()) {
  // Match the DeDust REST shape.
  return {
    sender: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs',
    assetIn:  side === 'buy' ? { type: 'native' }     : { type: 'jetton', address: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs' },
    assetOut: side === 'buy' ? { type: 'jetton', address: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs' } : { type: 'native' },
    amountIn:  '1000000000',
    amountOut: '5000000',
    lt: String(lt),
    createdAt: new Date(tsMs).toISOString(),
  };
}

function fakeDedustClient(trades) {
  // returns trades passed in; tests will mutate the array between ticks.
  return {
    getPoolTrades: async () => trades.slice(),
    _resetCacheForTest() {},
  };
}

test('TradeStream: subscribe/unsubscribe manages refcount', () => {
  const { db } = makeTmpDb();
  const dedust = fakeDedustClient([]);
  const stream = new TradeStream({ dedust, db, intervalMs: 60_000 });

  const u1 = stream.subscribe(POOL_RAW);
  assert.equal(stream.refcountOf(POOL_RAW), 1);
  const u2 = stream.subscribe(POOL_RAW);
  assert.equal(stream.refcountOf(POOL_RAW), 2);
  u1();
  assert.equal(stream.refcountOf(POOL_RAW), 1);
  u1();   // second call to same unsubscribe should be a no-op
  assert.equal(stream.refcountOf(POOL_RAW), 1);
  u2();
  assert.equal(stream.refcountOf(POOL_RAW), 0);

  stream.shutdown();
});

test('TradeStream: emits a trade event for each fresh row, dedupes by lt', async (t) => {
  const { db } = makeTmpDb();
  // Two trades visible initially.
  const upstream = [fakeDedustTrade(100, 'buy'), fakeDedustTrade(101, 'sell')];
  const dedust = fakeDedustClient(upstream);
  const stream = new TradeStream({ dedust, db, intervalMs: 60_000 });

  const events = [];
  stream.on('trade', (ev) => events.push(ev.data.lt));

  const unsub = stream.subscribe(POOL_RAW);
  // The constructor fires an immediate _tick — await one event loop turn so the
  // promise it returned has a chance to resolve.
  await new Promise((r) => setTimeout(r, 50));

  assert.deepEqual(events.sort(), ['100', '101']);

  // Mutate upstream to add a third trade; manually invoke _tick (don't wait for the timer).
  upstream.push(fakeDedustTrade(102, 'buy'));
  await stream._tick(POOL_RAW);

  assert.deepEqual(events.sort(), ['100', '101', '102']);

  // Re-tick with no new data → no new emissions.
  await stream._tick(POOL_RAW);
  assert.equal(events.length, 3);

  unsub();
  stream.shutdown();
});

test('TradeStream: ignores trades with stale lt after restart, using DB seed', async () => {
  const { db } = makeTmpDb();
  // Seed an "already-seen" trade directly via insertTrades simulation: subscribe,
  // tick, unsubscribe, then re-subscribe — the second start should not re-emit
  // anything until upstream advances.
  const upstream = [fakeDedustTrade(200, 'buy', Date.now() - 60_000)];
  const dedust = fakeDedustClient(upstream);
  const stream = new TradeStream({ dedust, db, intervalMs: 60_000 });

  const firstEvents = [];
  stream.on('trade', (ev) => firstEvents.push(ev.data.lt));
  const u1 = stream.subscribe(POOL_RAW);
  await new Promise((r) => setTimeout(r, 30));
  u1();

  assert.deepEqual(firstEvents, ['200']);

  // Re-subscribe — the DB has lt=200 as the newest row, so a tick with the
  // identical upstream payload must emit nothing.
  const secondEvents = [];
  const stream2 = new TradeStream({ dedust, db, intervalMs: 60_000 });
  stream2.on('trade', (ev) => secondEvents.push(ev.data.lt));
  const u2 = stream2.subscribe(POOL_RAW);
  await new Promise((r) => setTimeout(r, 30));
  u2();

  assert.deepEqual(secondEvents, []);

  stream.shutdown();
  stream2.shutdown();
});
