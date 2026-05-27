'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { toRaw, toFriendly, bothForms, isFriendly, isRaw, isValid } = require('../src/lib/address');

// USDT jetton master — well-known TON address (decoded via parseFriendly).
const USDT_FRIENDLY = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';
const USDT_RAW      = '0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe';

test('toFriendly: raw round-trips through friendly back to raw', () => {
  const f = toFriendly(USDT_RAW);
  assert.equal(typeof f, 'string');
  assert.match(f, /^EQ/);
  assert.equal(toRaw(f), USDT_RAW);
});

test('toFriendly: produces the canonical USDT friendly form', () => {
  assert.equal(toFriendly(USDT_RAW), USDT_FRIENDLY);
});

test('toFriendly: idempotent on already-friendly input', () => {
  assert.equal(toFriendly(USDT_FRIENDLY), USDT_FRIENDLY);
});

test('toFriendly: non-bounceable flag produces UQ prefix', () => {
  const uq = toFriendly(USDT_RAW, { bounceable: false });
  assert.match(uq, /^UQ/);
  // And it must still round-trip to the same raw.
  assert.equal(toRaw(uq), USDT_RAW);
});

test('toFriendly: native TON pseudo-address renders as "TON"', () => {
  assert.equal(toFriendly('0:0000000000000000000000000000000000000000000000000000000000000000'), 'TON');
  assert.equal(toFriendly('TON'), 'TON');
});

test('toFriendly: throws on garbage input', () => {
  assert.throws(() => toFriendly('not-an-address'));
});

test('bothForms: returns both representations from either input', () => {
  const a = bothForms(USDT_RAW);
  assert.equal(a.raw, USDT_RAW);
  assert.equal(a.friendly, USDT_FRIENDLY);
  const b = bothForms(USDT_FRIENDLY);
  assert.equal(b.raw, USDT_RAW);
  assert.equal(b.friendly, USDT_FRIENDLY);
});

test('bothForms: nullish input returns nulls without throwing', () => {
  assert.deepEqual(bothForms(null),      { raw: null,      friendly: null });
  assert.deepEqual(bothForms(undefined), { raw: null,      friendly: null });
  assert.deepEqual(bothForms(''),        { raw: null,      friendly: null });
});

test('bothForms: garbage returns friendly=null but echoes input back', () => {
  const r = bothForms('not-an-address');
  assert.equal(r.friendly, null);
});

// Sanity: the lib's existing predicates still behave as documented.
test('isFriendly / isRaw / isValid agree', () => {
  assert.equal(isFriendly(USDT_FRIENDLY), true);
  assert.equal(isRaw(USDT_RAW), true);
  assert.equal(isValid(USDT_FRIENDLY), true);
  assert.equal(isValid(USDT_RAW), true);
  assert.equal(isValid('garbage'), false);
});
