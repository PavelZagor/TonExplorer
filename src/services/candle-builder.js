'use strict';

// Builds OHLCV candles from a flat list of normalised trade rows (trades table).
//
// Input row shape (subset of what /db returns):
//   {
//     ts:            <unix_seconds>,
//     side:          'buy' | 'sell',
//     amount_in:     '<bigint string>',
//     amount_out:    '<bigint string>',
//     price_native:  <number | null>          // paired_with per 1.0 base
//   }
//
// Output:
//   [{ time, open, high, low, close, volume }]
//   * `time` is the bucket-start unix-seconds (TradingView Lightweight Charts
//     accepts `time` as a Unix timestamp or YYYY-MM-DD string; we go numeric).
//   * `volume` is summed in `paired_with` units (e.g. TON for TON-paired pools).
//     For buys, that's `amount_in / 10^quote_decimals`. For sells, it's
//     `amount_out / 10^quote_decimals`. Pool decimals are passed in via opts.
//
// Trades with a null price_native are skipped — without a price they can't
// contribute O/H/L/C, and counting their volume in the wrong unit would lie.

const INTERVAL_PRESETS = {
  '1m':  60,
  '5m':  300,
  '15m': 900,
  '1h':  3600,
  '4h':  14400,
  '1d':  86400,
};

function intervalSeconds(name) {
  if (typeof name === 'number') return Math.max(1, Math.trunc(name));
  return INTERVAL_PRESETS[name] || null;
}

function bucketOf(ts, interval) {
  return Math.floor(ts / interval) * interval;
}

// quoteDecimals: paired_with decimals (9 for TON). When null, volume falls
// back to raw paired_with units (still useful for relative comparisons).
function buildCandles(trades, interval, { quoteDecimals = null } = {}) {
  const ivl = typeof interval === 'string' ? intervalSeconds(interval) : interval;
  if (!ivl || ivl < 1) throw new Error(`bad interval: ${interval}`);
  if (!Array.isArray(trades) || trades.length === 0) return [];

  const sorted = trades.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));

  const buckets = new Map(); // time -> { time, open, high, low, close, volume }
  const scale = quoteDecimals != null ? 10 ** quoteDecimals : 1;

  for (const t of sorted) {
    const price = Number(t.price_native);
    if (!Number.isFinite(price) || price <= 0) continue;
    if (!Number.isFinite(t.ts)) continue;

    const time = bucketOf(t.ts, ivl);
    let c = buckets.get(time);
    if (!c) {
      c = { time, open: price, high: price, low: price, close: price, volume: 0 };
      buckets.set(time, c);
    } else {
      if (price > c.high) c.high = price;
      if (price < c.low)  c.low  = price;
      c.close = price;
    }

    // Volume in paired_with units.
    const quoteAmountStr = t.side === 'buy' ? t.amount_in : t.amount_out;
    if (quoteAmountStr != null) {
      try {
        c.volume += Number(BigInt(quoteAmountStr)) / scale;
      } catch { /* ignore unparseable */ }
    }
  }

  return Array.from(buckets.values()).sort((a, b) => a.time - b.time);
}

module.exports = {
  buildCandles,
  intervalSeconds,
  INTERVAL_PRESETS,
  // exported for tests
  bucketOf,
};
