'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { concentrationFlags, isLpHolder } = require('../src/analyzers/holders');

const h = (share, opts = {}) => ({ address: opts.address || '0:abc', share, ...opts });

test('concentrationFlags: top1 majority on a non-LP holder fires high', () => {
  const flags = concentrationFlags({ top: [h(0.6), h(0.1), h(0.05)] });
  assert.equal(flags.length, 1);
  assert.equal(flags[0].id, 'top1_majority');
  assert.equal(flags[0].severity, 'high');
  assert.ok(/60\.0%/.test(flags[0].detail));
});

test('concentrationFlags: ignores top-1 when it is the auto-detected LP', () => {
  // LP holds 60%, but real top-1 trader holds 10% — should not fire.
  const flags = concentrationFlags({
    top: [
      h(0.60, { is_lp: true }),
      h(0.10),
      h(0.05),
    ],
  });
  assert.deepEqual(flags, []);
});

test('concentrationFlags: surfaces the (LP excluded) note in detail', () => {
  const flags = concentrationFlags({
    top: [
      h(0.40, { is_lp: true }),    // LP — skipped
      h(0.55),                      // real top-1, majority
      h(0.05),
    ],
  });
  assert.equal(flags.length, 1);
  assert.equal(flags[0].id, 'top1_majority');
  assert.match(flags[0].detail, /\(LP excluded: 1\)/);
});

test('concentrationFlags: manually-tagged lp via wallet.tags is honoured too', () => {
  const flags = concentrationFlags({
    top: [
      h(0.45, { wallet: { tags: ['lp'] } }),
      h(0.20),
    ],
  });
  // Real top-1 now is 0.20 → no flag.
  assert.deepEqual(flags, []);
});

test('concentrationFlags: top10 sums use the LP-adjusted list', () => {
  // Without LP exclusion, top-10 = 0.85 → fires top10_concentrated.
  // With LP at slot 1 (0.40) excluded, top-10 = 0.45 → no flag.
  const top = [h(0.40, { is_lp: true }), h(0.10), h(0.08), h(0.07), h(0.07), h(0.05), h(0.04), h(0.03), h(0.005), h(0.005)];
  const flags = concentrationFlags({ top });
  assert.deepEqual(flags, []);
});

test('concentrationFlags: returns [] when every holder is LP', () => {
  const flags = concentrationFlags({
    top: [h(0.50, { is_lp: true }), h(0.30, { is_lp: true })],
  });
  assert.deepEqual(flags, []);
});

test('isLpHolder recognises both is_lp flag and wallet tag', () => {
  assert.equal(isLpHolder({ is_lp: true }), true);
  assert.equal(isLpHolder({ wallet: { tags: ['lp'] } }), true);
  assert.equal(isLpHolder({ wallet: { tags: ['cex'] } }), false);
  assert.equal(isLpHolder({}), false);
  assert.equal(isLpHolder(null), false);
});
